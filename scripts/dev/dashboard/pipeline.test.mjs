import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DASH_DRY = "1";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-pipeline-"));
process.env.DASH_DATA = TMP;
let P, T, R, L, M, PROJECT;

before(async () => {
    await import("./wiring.mjs");
    P = await import("./pipeline.mjs");
    T = await import("./tasks.mjs");
    R = await import("./runner.mjs");
    L = await import("./loopwatch.mjs");
    M = await import("./modules.mjs");
    ({ PROJECT } = await import("../slots.mjs"));
});
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe("mergedTreeChecks — проверка влива на дереве staging + ветка", () => {
    let saved;
    before(() => {
        saved = { ...P.sh };
    });
    after(() => {
        Object.assign(P.sh, saved);
    });
    const fake = (mt, gitOut = {}) => {
        P.sh.run = async () => mt;
        P.sh.git = async (cwd, args) => ({ ok: true, out: gitOut[args[0]] ?? "" });
        P.sh.archiveTo = async () => {
            throw new Error("не должен звать archive");
        };
    };
    test("конфликт (код 1) — отказ с перечнем файлов, сообщения merge-tree в перечень не попадают", async () => {
        fake({ code: 1, out: "abc123\npackage.json\n.gitignore\n\nAuto-merging package.json\nCONFLICT (content): Merge conflict in package.json\n", err: "" });
        const c = (await P.mergedTreeChecks({ key: "k1", branch: "dev/wv-1" })).find((x) => x.id === "conflict");
        assert.equal(c.ok, false);
        assert.match(c.detail, /конфликтуют со staging \(2\): package\.json, \.gitignore/);
        assert.doesNotMatch(c.detail, /Auto-merging|CONFLICT/);
    });
    test("merge-tree не отработал (код 128) — тоже отказ, но с причиной, а не пустым «конфликтуют»", async () => {
        fake({ code: 128, out: "", err: "fatal: not a valid object name dev/x" });
        const c = (await P.mergedTreeChecks({ key: "k2", branch: "dev/x" })).find((x) => x.id === "conflict");
        assert.equal(c.ok, false);
        assert.match(c.detail, /не отработал \(код 128\): fatal/);
    });
    test("чисто (код 0) — одна зелёная проверка конфликта, дерево не выкладывается", async () => {
        fake({ code: 0, out: "abc123\n", err: "" }, { "merge-base": "mb1", diff: "apps/api/src/x.ts" });
        const out = await P.mergedTreeChecks({ key: "k3", branch: "dev/wv-3" });
        assert.deepEqual(out.map((x) => [x.id, x.ok]), [["conflict", true]]);
    });
    test("пока идёт merge-tree, цикл событий свободен (раньше — spawnSync на всё время)", async () => {
        P.sh.run = () => new Promise((r) => setTimeout(() => r({ code: 0, out: "t\n", err: "" }), 300));
        P.sh.git = async () => ({ ok: true, out: "" });
        let ticks = 0;
        const iv = setInterval(() => ticks++, 20);
        const t0 = Date.now();
        await P.mergedTreeChecks({ key: "k4", branch: "dev/wv-4" });
        clearInterval(iv);
        assert.ok(Date.now() - t0 >= 290);
        assert.ok(ticks >= 3, "таймер сработал " + ticks + " раз за 300 мс");
    });
    test("два нажатия на один слот — одна проверка", async () => {
        let n = 0;
        P.sh.run = () => {
            n++;
            return new Promise((r) => setTimeout(() => r({ code: 0, out: "t\n", err: "" }), 50));
        };
        P.sh.git = async () => ({ ok: true, out: "" });
        const [a, b] = await Promise.all([P.mergedTreeChecks({ key: "k5", branch: "dev/b" }), P.mergedTreeChecks({ key: "k5", branch: "dev/b" })]);
        assert.equal(n, 1);
        assert.equal(a, b);
    });
    test("mergeTreeFiles: имена до пустой строки", () => {
        assert.deepEqual(P.mergeTreeFiles("t\r\na\r\nb\r\n\r\nAuto-merging a"), ["a", "b"]);
        assert.deepEqual(P.mergeTreeFiles("t\n"), []);
    });
});

describe("pushMainRetry — пуш прод-ветки при обрыве связи с remote", () => {
    const DROP = { code: 128, out: "Connection closed by git.example.com port 22\nfatal: Could not read from remote repository.\n" };
    const run = (pushes, remote, local = "aaa111") => {
        const calls = { push: 0, sleep: [], ls: 0 }, log = [];
        const p = P.pushMainRetry((s) => log.push(s), { push: async () => pushes[Math.min(calls.push++, pushes.length - 1)], localSha: async () => local, remoteSha: async () => {
                calls.ls++;
                return typeof remote === "function" ? remote(calls.ls) : remote;
            }, sleep: async (ms) => {
                calls.sleep.push(ms);
            }, pauseMs: 7 });
        return { p, calls, log };
    };
    test("два обрыва, третья попытка прошла — сверка совпала", async () => {
        const { p, calls, log } = run([DROP, DROP, { code: 0, out: "" }], "aaa111");
        assert.deepEqual(await p, { ok: true, sha: "aaa111" });
        assert.equal(calls.push, 3);
        assert.deepEqual(calls.sleep, [7, 7]);
        assert.match(log.join(""), /попытка 2 из 4/);
    });
    test("«Connection reset» тоже обрыв", async () => {
        const { p, calls } = run([{ code: 128, out: "kex_exchange_identification: read: Connection reset by peer" }, { code: 0, out: "" }], "aaa111");
        await p;
        assert.equal(calls.push, 2);
    });
    test("отказ по существу (rejected) — без повторов", async () => {
        const { p, calls } = run([{ code: 1, out: " ! [rejected] main -> main (fetch first)" }], "aaa111");
        await assert.rejects(p, /не обрыв связи/);
        assert.equal(calls.push, 1);
        assert.equal(calls.ls, 0);
    });
    test("все 4 попытки оборвались, но пуш дошёл — origin = локальный, выкат зелёный", async () => {
        const { p, calls, log } = run([DROP], "aaa111");
        assert.equal((await p).ok, true);
        assert.equal(calls.push, 4);
        assert.equal(calls.sleep.length, 3);
        assert.match(log.join(""), /пуш дошёл/);
    });
    test("все 4 оборвались и origin другой — отказ с подсказкой повторить руками", async () => {
        const { p, calls } = run([DROP], "bbb222");
        await assert.rejects(p, /после 4 попыток origin\/main = bbb222.*локальный main = aaa111/);
        assert.equal(calls.push, 4);
    });
    test("ls-remote не ответил дважды, потом ответил", async () => {
        const { p, calls } = run([{ code: 0, out: "" }], (i) => (i < 3 ? null : "aaa111"));
        assert.equal((await p).ok, true);
        assert.equal(calls.ls, 3);
    });
    test("рецепт release: шаг пуша — с повтором, а не голая команда; пушится main в прод-ветку проекта", () => {
        M.setModuleStates({ release: true });
        try {
            const r = P.recipe("release", {}), last = r.steps[r.steps.length - 1];
            assert.equal(typeof last.js, "function");
            assert.match(last.show, /git push origin main:main.*до 4 попыток/);
        }
        finally {
            M.setModuleStates();
        }
    });
});

describe("выкат — модуль release: команды из конфига проекта", () => {
    const withRelease = (rel, fn) => {
        const was = JSON.parse(JSON.stringify(PROJECT.release));
        Object.assign(PROJECT.release.stand, rel.stand || {});
        Object.assign(PROJECT.release.prod, rel.prod || {});
        M.setModuleStates({ release: true });
        try {
            return fn();
        }
        finally {
            PROJECT.release.stand = was.stand;
            PROJECT.release.prod = was.prod;
            M.setModuleStates();
        }
    };
    test("модуль выключен — рецептов выката нет; влив в staging — ядро, есть всегда", () => {
        assert.equal(P.recipe("deploy-staging", {}), null);
        assert.equal(P.recipe("release", {}), null);
        assert.ok(P.recipe("merge", { branch: "dev/wv-0001-a" }));
    });
    test("стенд: сначала пуш staging в интеграционную ветку проекта, затем команда release.stand.run", () => {
        withRelease({}, () => assert.equal(P.recipe("deploy-staging", {}), null, "команды стенда нет — рецепта нет"));
        withRelease({ stand: { run: "npm run deploy:stand" } }, () => {
            const r = P.recipe("deploy-staging", {});
            assert.deepEqual(r.steps.map((x) => x.show), ["git push origin staging:develop", "npm run deploy:stand"]);
            assert.deepEqual(r.steps[0].args, ["push", "origin", "staging:develop"]);
            assert.equal(r.steps[1].text, "npm run deploy:stand", "команда проекта — строкой в оболочку");
        });
    });
    test("прод: после пуша — release.prod.run и release.prod.verify; без них последний шаг — пуш", () => {
        withRelease({ prod: { run: "npm run deploy:prod", verify: "npm run smoke" } }, () => {
            const r = P.recipe("release", {}), shows = r.steps.map((x) => x.show);
            assert.match(shows[shows.length - 3], /^git push origin main:main/);
            assert.equal(r.steps[r.steps.length - 2].text, "npm run deploy:prod");
            assert.equal(r.steps[r.steps.length - 1].text, "npm run smoke");
        });
        withRelease({ prod: { pushDeploys: true } }, () => {
            const last = P.recipe("release", {}).steps.pop();
            assert.match(last.show, /ЗАПУСКАЕТ ВЫКАТ ПРОДА/, "пуш сам выкатывает — так и написано на шаге");
        });
    });
    test("проверка перед выкатом при выключенном модуле — отказ, без git", async () => {
        const p = await P.preflight("deploy-staging", null);
        assert.equal(p.ok, false);
        assert.match(p.checks[0].text, /модуль release не включён/);
    });
});

describe("stepOfTask — шаг из задачи конфига", () => {
    test("каждая задача каталога даёт шаг; для удалённой машины — команду", () => {
        for (const [id, task] of Object.entries(T.TASKS)) {
            assert.doesNotThrow(() => T.stepOfTask(task, "C:/x", "a"), id);
            if (R.REMOTE_TASKS[id])
                assert.ok(R.remoteCmdFor(id, "a"), id);
        }
    });
    test("задача с вводом — команда и ввод одним аргументом; без ввода — строка в оболочку", () => {
        const a = T.stepOfTask(T.TASKS["api-test"], "C:/x", "wv-0001|wv-0002");
        assert.equal(a.cmd, "npx");
        assert.deepEqual(a.args, ["jest", "wv-0001|wv-0002"]);
        const l = T.stepOfTask(T.TASKS.lint, "C:/x");
        assert.equal(l.text, "npm run lint");
    });
    test("задача без своей команды — шаг, который падает с причиной, а не «args is not a function»", async () => {
        const st = T.stepOfTask({ label: "x" }, "C:/x");
        assert.equal(st.show, "x");
        await assert.rejects(st.js(), /нет своей команды/);
    });
});

describe("loopGate — событие slow.loop", () => {
    const S0 = { lastAt: 0, held: 0, worst: 0 };
    test("ниже порога — тихо", () => {
        assert.equal(L.loopGate(S0, 400, 1000, { threshold: 500 }).ev, null);
    });
    test("выше порога — событие; повторы в течение минуты подавлены и засчитаны в следующее", () => {
        let r = L.loopGate(S0, 800, 1000, { threshold: 500, quietMs: 60000 });
        assert.deepEqual(r.ev, { ms: 800 });
        r = L.loopGate(r.st, 2000, 5000, { threshold: 500, quietMs: 60000 });
        assert.equal(r.ev, null);
        r = L.loopGate(r.st, 700, 9000, { threshold: 500, quietMs: 60000 });
        assert.equal(r.ev, null);
        r = L.loopGate(r.st, 600, 62000, { threshold: 500, quietMs: 60000 });
        assert.deepEqual(r.ev, { ms: 600, suppressed: 2, worstSuppressedMs: 2000 });
        assert.deepEqual(r.st, { lastAt: 62000, held: 0, worst: 0 });
    });
});

test("у шага влива есть откат git merge --abort (упавший влив не оставляет основную папку посреди слияния)", async () => {
    const { recipe } = await import("./pipeline.mjs");
    const r = recipe("merge", { slotKey: null, branch: "dev/wv-0017-x" }), st = r.steps.find((s) => s.cmd === "git" && s.args[0] === "merge");
    assert.deepEqual(st.onFail.args, ["merge", "--abort"]);
    assert.equal(st.onFail.cwd, st.cwd);
});

test("автовлив с проверенным sha вливает sha, а не имя ветки; без sha — ветку, как раньше", async () => {
    const { recipe, mergeTarget } = await import("./pipeline.mjs");
    const sha = "5a9f7e5e6a" + "0".repeat(30);
    const st = recipe("merge", { slotKey: null, branch: "dev/x", sha }).steps.find((s) => s.cmd === "git" && s.args[0] === "merge");
    assert.equal(st.args[2], sha);
    assert.match(st.show, /dev\/x@5a9f7e5e6a/);
    const { mergedBranches } = await import("./idle.mjs");
    assert.equal(st.branch, "dev/x");
    assert.deepEqual(mergedBranches({ steps: recipe("merge", { slotKey: null, branch: "dev/x", sha }).steps }), ["dev/x"]);
    assert.equal(recipe("merge", { slotKey: null, branch: "dev/x" }).steps.find((s) => s.cmd === "git" && s.args[0] === "merge").args[2], "dev/x");
    assert.equal(mergeTarget("dev/x", "abc"), "dev/x", "не полный sha — ветка");
});

test("depWave — шаблон коммитов волны-зависимости по ветке", async () => {
    assert.equal(P.depWave("dev/epic-x"), "");
    const w = P.depWave("dev/wv-0104-login-page");
    assert.equal(w.wave, "WV-0104");
    const { execFileSync } = await import("node:child_process"), fs = await import("node:fs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "depwave-")), g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
    g("init", "-q");
    g("config", "user.email", "t@t");
    g("config", "user.name", "t");
    const has = (msg) => {
        g("commit", "-q", "--allow-empty", "-m", msg);
        const r = g("log", "-1", "--format=%h", "-i", "-E", "--grep=" + w.re, "HEAD").trim();
        g("reset", "-q", "--hard", "HEAD~1");
        return !!r;
    };
    g("commit", "-q", "--allow-empty", "-m", "init");
    assert.equal(has("fix(auth): WV-0104: лок"), true);
    assert.equal(has("feat: x\n\nWave: wv-0104"), true);
    assert.equal(has("feat: WV-01040: чужая волна"), false);
    assert.equal(has("feat: WV-0105: соседняя волна"), false);
    fs.rmSync(dir, { recursive: true, force: true });
});

test("cherryMerged — вся ветка зависимости в staging по содержимому: git cherry без «+» — да, с «+» или ошибкой — нет", () => {
    assert.equal(P.cherryMerged({ ok: true, out: "- 87c1b5c301\n- 0061ec36af" }), true);
    assert.equal(P.cherryMerged({ ok: true, out: "- 87c1b5c301\n+ 0061ec36af" }), false);
    assert.equal(P.cherryMerged({ ok: false, out: "" }), false);
    assert.equal(P.cherryMerged(null), false);
});
