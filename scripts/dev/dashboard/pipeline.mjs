// pipeline.mjs — конвейер веток: влив слота в staging (ядро) и, под модулем release, влив staging → main с выкатом
// стенда и прода командами из конфига проекта. Здесь же поезд staging → стенд → прод и порядок вливов.
import { MAIN, PROJECT, REMOTE, UP_MAIN, UP_STAGING, WT, fwd, loadEpics, saveEpics } from "../slots.mjs";
import { execFile, spawn } from "./spawner.mjs";
import fs from "node:fs";
import { readJson, saveJson } from "./store.mjs";
import path from "node:path";
import { S } from "./state.mjs";
import { shardApi } from "./shard.mjs";
import { snapNow } from "./snapshot.mjs";
import { jobList } from "./jobs.mjs";
import { accEntry, accKey, accWaves } from "./accept.mjs";
import { epicOfSlot, slotOf } from "./agents.mjs";
import { DATA, MAIN_WT, logEvent } from "./config.mjs";
import { TREES, epicOfKey, openEpics, treeByKey } from "./trees.mjs";
import { codeFp, jobFresh } from "./fingerprint.mjs";
import { git, pipelineState, stagingTreeSha, treeState, withGitPriority } from "./git.mjs";
import { late, lateObject } from "./late.mjs";
import { SAFE_GIT, failingSpecs, knownRed } from "./regress.mjs";
import { TASKS, stepOfTask } from "./tasks.mjs";
import { trainMergeNote } from "./trains.mjs";
import { waveFinalOf } from "./slot-done.mjs";
import { wagonUnfinished } from "./auto-merge-rules.mjs";
import { enabled } from "./modules.mjs";
import { inEpic } from "./sync-rules.mjs";

const { enqueue, remoteCmdFor, remoteOn, spawnStep } = late("runner.mjs", ["enqueue", "remoteCmdFor", "remoteOn", "spawnStep"]);

/** Гарды проекта — задачи станции «Гарды» (stations.guards). */
const guardIds = () => PROJECT.stations.guards.filter((id) => TASKS[id]);
const upName = (up) => String(up || "").slice(REMOTE.length + 1);
const { noteConflict } = late("stations.mjs", ["noteConflict"]);
const procs = lateObject("runner.mjs", "procs");
export const lastOk = (treeKey, taskId, treeSha) => jobList().some((j) => j.tree === treeKey && j.task === taskId && j.status === "ok" && j.cleanAtStart && j.treeSha === treeSha);
export const chk = (id, ok, text, detail = "") => ({ id, ok, text, detail });

export function depWave(branch) {
    const m = /wv-?0*(\d{1,4})/i.exec(String(branch || ""));
    if (!m)
        return "";
    return { wave: "WV-" + m[1].padStart(4, "0"), re: "WV-?0*" + m[1] + "([^0-9]|$)" };
}

export const cherryMerged = (r) => !!r && r.ok && !String(r.out || "").split("\n").some((l) => l.trim().startsWith("+"));

export async function depsOf(key) {
    const x = slotOf(key), EPIC = epicOfSlot(key);
    if (!x || !EPIC || !(x.after || []).length)
        return [];
    return Promise.all(x.after.map(async (k) => {
        const d = EPIC.slots.find((z) => z.slot === k), tr = treeByKey(k), br = (d && d.branch) || (tr && tr.branch) || "";
        const own = (x && x.branch) || ((treeByKey(key) || {}).branch) || "";
        const mb = br && own ? await git(MAIN, ["merge-base", own, br]) : { ok: false };
        const ref = mb.ok && mb.out ? mb.out.trim() : br;
        let merged = !!br && (await git(MAIN, ["merge-base", "--is-ancestor", ref, "staging"])).ok;
        const wave = depWave(br);
        if (merged && wave && own) {
            const stands = await git(MAIN, ["log", "-1", "--format=%h", "-i", "-E", "--grep=" + wave.re, own]);
            if (stands.ok && !stands.out.trim())
                merged = cherryMerged(await git(MAIN, ["cherry", "staging", br]));
        }
        return { key: k, tag: (d && d.tag) || (tr && tr.tag) || k, branch: br, merged };
    }));
}

export const sh = {
    run: (cmd, args, { cwd, timeout = 60000, env } = {}) => new Promise((res) => execFile(cmd, args, { cwd, timeout, ...(env ? { env } : {}), windowsHide: true, maxBuffer: 64e6, encoding: "utf8" }, (e, so, se) => {
        const code = !e ? 0 : typeof e.code === "number" ? e.code : e.killed ? 124 : 127;
        res({ code, out: String(so || ""), err: String(se || "") + (code === 124 ? `\n(снята по времени: ${Math.round(timeout / 1000)} с)` : code === 127 ? "\n" + e.message : "") });
    })),
    archiveTo: (cwd, tree, paths, dir, timeout = 60000, pre = []) => new Promise((res) => {
        let err = "", code = 0, left = 2;
        const ar = spawn("git", [...pre, "archive", tree, "--", ...paths], { cwd, windowsHide: true }), tx = spawn("tar", ["-x"], { cwd: dir, windowsHide: true });
        const timer = setTimeout(() => {
            err += "снято по времени: " + Math.round(timeout / 1000) + " с\n";
            code = code || 124;
            ar.kill();
            tx.kill();
        }, timeout);
        const fin = (c) => {
            code = code || c;
            if (--left === 0) {
                clearTimeout(timer);
                res({ code, err });
            }
        };
        for (const [p, name] of [[ar, "git archive"], [tx, "tar"]]) {
            let done = false;
            const end = (c) => {
                if (!done) {
                    done = true;
                    fin(c);
                }
            };
            p.stderr.on("data", (d) => {
                err += String(d);
            });
            p.on("error", (e) => {
                err += name + ": " + e.message + "\n";
                end(127);
            });
            p.on("close", (c) => end(c === null ? 124 : c));
        }
        tx.stdin.on("error", () => { });
        ar.stdout.pipe(tx.stdin);
    }),
    git: (cwd, args, timeout) => git(cwd, args, timeout),
};

export const mergeTreeFiles = (stdout) => {
    const files = [];
    for (const l of String(stdout || "").split(/\r?\n/).slice(1)) {
        if (!l.trim())
            break;
        files.push(l.trim());
    }
    return files;
};

const mtcBusy = new Map();

export function mergedTreeChecks(t) {
    const k = t.key + "|" + t.branch;
    if (!mtcBusy.has(k))
        mtcBusy.set(k, mergedTreeChecksRun(t).finally(() => mtcBusy.delete(k)));
    return mtcBusy.get(k);
}

async function mergedTreeChecksRun(t) {
    const out = [], mt = await sh.run("git", ["merge-tree", "--write-tree", "--name-only", "staging", t.branch], { cwd: MAIN, timeout: 60000 });
    const tree = mt.out.split(/\r?\n/)[0].trim();
    if (mt.code === 0)
        out.push(chk("conflict", true, "ветка вливается в staging без конфликтов"));
    else if (mt.code === 1) {
        const files = mergeTreeFiles(mt.out);
        noteConflict(t.key, files);
        out.push(chk("conflict", false, "ветка вливается в staging без конфликтов", "конфликтуют со staging" + (files.length ? " (" + files.length + "): " + files.slice(0, 8).join(", ") + (files.length > 8 ? " …" : "") : "") + " — влейте staging в ветку и разрешите в слоте («⤓ Подтянуть staging»)"));
    }
    else
        out.push(chk("conflict", false, "ветка вливается в staging без конфликтов", "git merge-tree не отработал (код " + mt.code + "): " + mt.err.trim().slice(0, 200)));
    return out;
}

/** Действия конвейера: влив в staging — ядро; выкат стенда и прода — модуль release. */
export const PIPELINE_ACTIONS = ["merge", "deploy-staging", "release"];
export const releaseAction = (action) => action === "deploy-staging" || action === "release";

export const preflight = (action, slotKey, opt = {}) => withGitPriority(() => preflightRun(action, slotKey, opt));

/** Гарды зелёные на коде с отпечатком fp: каждый гард проекта прошёл на этом коде (или на дереве поезда). */
function guardsGreen(t, fp, { noProd, trainOk }) {
    const ids = guardIds();
    if (!ids.length || noProd || trainOk)
        return true;
    const sn = snapNow() && snapNow().trees.find((x) => x.key === t.key);
    return ids.every((g) => {
        const last = [...jobList()].reverse().find((j) => j.tree === t.key && j.task === g && j.status === "ok");
        return (!!last && !!sn && sn.fp === fp && jobFresh(last, sn) === "ok") || lastOk(t.key, g, t.tree) || jobList().some((j) => j.tree === t.key && j.task === g && j.status === "ok" && j.fpStart && j.fpStart === j.fpEnd && j.fpEnd === fp);
    });
}

async function preflightRun(action, slotKey, opt = {}) {
    if (releaseAction(action) && !enabled("release"))
        return { checks: [chk("module", false, "выкат выключен: модуль release не включён в конфиге проекта")], ok: false, trees: [], pl: null };
    const tk = action === "merge" && slotKey ? TREES.find((x) => x.key === slotKey) : null;
    const trees = tk ? [await treeState(tk)] : [];
    const pl = await pipelineState();
    const sf = pl.stagingFolder, mf = pl.mainFolder;
    const c = [];
    if (action === "merge") {
        const t = trees.find((x) => x.key === slotKey);
        c.push(chk("slot", !!t && t.exists, "слот существует"));
        if (t && t.exists) {
            c.push(chk("branch", t.branch && t.branch !== "staging" && t.branch !== "main" && t.branch !== "HEAD", `ветка слота — ${t.branch}`, "вливать можно только ветку волны"));
            c.push(chk("clean", t.dirtyTracked === 0, "в слоте нет незакоммиченных изменений", t.dirtyTracked ? `изменённых файлов: ${t.dirtyTracked} — сначала коммит` : ""));
            c.push(chk("ahead", t.ahead > 0, `в ветке есть что вливать (впереди staging: ${t.ahead})`));
            const fp = await codeFp(t.path, true), sn = snapNow() && snapNow().trees.find((x) => x.key === t.key);
            const noProd = !!sn && sn.fp === fp && sn.prodTouched === 0, trainOk = !!(S.train && S.train.status === "green" && (S.train.runs.find((r) => r.id === S.train.green) || { fps: {} }).fps[t.key] === fp);
            const gids = guardIds();
            if (gids.length) {
                const secOk = guardsGreen(t, fp, { noProd, trainOk }), names = gids.map((g) => TASKS[g].label).join(", ");
                c.push(chk("sec", secOk, noProd ? "гарды не нужны: продуктовый код не тронут" : trainOk ? "гарды зелёные на дереве поезда с этим кодом" : "гарды (" + names + ") зелёные на этом коде", "код менялся после последнего зелёного прогона гардов (или его не было): запустите гарды в слоте или проверьте поездом"));
            }
            if (sn && sn.train && sn.wagon) {
                const un = wagonUnfinished(sn, waveFinalOf({ ...sn, fp }));
                c.push(chk("done", !un, "агент доложил «ГОТОВО» по вагону " + sn.wagon, un ? "вагон не закончен: доклада «ГОТОВО» на этом коде нет (диспетчерская спросит агента сама; влить без доклада — «Влить всё равно»)" : ""));
            }
        }
        {
            const st = snapNow() && snapNow().trees.find((x) => x.key === slotKey), rg = st && (st.stages || []).find((x) => x.id === "regress");
            c.push(chk("regress", !!rg && rg.done, "регресс по тронутым путям пройден (или снят вручную)", rg && !rg.done ? rg.hint : ""));
            const rw = st && (st.stages || []).find((x) => x.id === "review");
            if (enabled("review"))
                c.push(chk("review", !!rw && rw.done,"независимое ревью «ЗА» на нынешнем коде (или принято вручную)", rw && !rw.done ? ((st.review && st.review.verdict) ? "ревьюер: " + st.review.verdict + (st.review.fresh ? "" : ", код с тех пор менялся") : "ревью ещё не было: «▶ Ревью» на линии слота") : ""));
        }
        if (t && t.exists && t.branch) {
            for (const d of await depsOf(slotKey))
                c.push(chk("dep", d.merged, `сначала влита ${d.tag} (${d.branch}): эта волна стоит на её коде`, d.merged ? "" : `ветка ${d.tag} ещё не в staging — вливайте по порядку`));
            for (const x of await mergedTreeChecks(t))
                c.push(x);
        }
        c.push(chk("stg", sf.branch === "staging", `основная папка стоит на staging (сейчас ${sf.branch})`));
        c.push(chk("stgclean", sf.dirtyTracked === 0, "в основной папке нет изменений отслеживаемых файлов", sf.dirtyTracked ? `изменённых: ${sf.dirtyTracked}` : ""));
    }
    else if (action === "deploy-staging") {
        c.push(chk("stg", sf.branch === "staging", `основная папка стоит на staging (сейчас ${sf.branch})`, "скрипт отказывается на main и detached HEAD"));
        c.push(chk("stgclean", sf.dirtyTracked === 0, "в основной папке нет изменений отслеживаемых файлов"));
        const run = PROJECT.release.stand.run;
        c.push(chk("cmd", !!run, run ? "команда выката стенда: " + run : "команда выката стенда не задана", run ? "" : "ключ `release.stand.run` в dispatcher.project.json"));
        const gids = guardIds();
        if (gids.length)
            c.push(chk("sec", gids.every((g) => lastOk("orchestrator-staging", g, pl.stagingTree)) ? true : null, "гарды зелёные на дереве staging", "рекомендуется до выката: «Гарды на staging» на линии staging"));
        if (enabled("machines") && typeof shardApi().summary === "function") {
            const sm = shardApi().summary(), head = (await git(MAIN, ["rev-parse", "staging"])).out, same = sm && sm.sha === head;
            const green = same && sm.status === "done" && !sm.fail && !sm.notrun && sm.ok >= sm.total;
            c.push(chk("shard", green ? true : null, green ? "полный прогон по машинам зелёный на этом коммите" : "полный прогон по машинам на этом коммите: " + (!sm ? "не запускали" : !same ? "был на другом коммите" : sm.status === "done" ? `красных частей ${sm.fail}` : "ещё не закончен")));
        }
        c.push(chk("info", null, "сначала staging пушится в " + UP_STAGING + ", затем идёт команда выката стенда"));
    }
    else if (action === "release") {
        c.push(chk("upmain", !!UP_MAIN, UP_MAIN ? "прод-ветка проекта: " + UP_MAIN : "у проекта нет отдельной прод-ветки (`repo.upstream.main`)"));
        c.push(chk("mf", mf.exists, "папка выката " + fwd(MAIN_WT) + " существует", "её создаёт подготовка выката: git worktree add " + fwd(MAIN_WT) + " main"));
        c.push(chk("mfb", mf.branch === "main", `она стоит на main (сейчас ${mf.branch || "—"})`));
        c.push(chk("mfclean", mf.dirtyTracked === 0, "в ней нет изменений отслеживаемых файлов"));
        c.push(chk("inv", pl.invariantOk, "main — предок staging", "иначе в прод-ветку попало что-то мимо staging: сначала влейте main в staging"));
        c.push(chk("unrel", pl.unreleased > 0, `в staging есть что выкатывать (коммитов впереди main: ${pl.unreleased})`));
        const gids = guardIds();
        if (gids.length)
            c.push(chk("sec", gids.every((g) => lastOk("orchestrator-staging", g, pl.stagingTree)), "гарды зелёные на дереве staging", "запустите «Гарды на staging» на линии staging"));
        c.push(chk("fresh", pl.mainVsOrigin[0] === 0, UP_MAIN + " не ушла вперёд локального main", pl.mainVsOrigin[0] ? `${UP_MAIN} впереди на ${pl.mainVsOrigin[0]} — нажмите «git fetch» и разберитесь` : "проверено по последнему fetch; в начале выката fetch повторяется"));
        if (enabled("accept")) {
            const ws = accWaves(), okN = ws.filter((t) => (accEntry(accKey(t)) || {}).verdict === "accepted").length, bad = ws.filter((t) => (accEntry(accKey(t)) || {}).verdict === "rejected").map((t) => t.tag);
            c.push(chk("accept", ws.length && okN === ws.length ? true : null, ws.length ? `приёмка на стенде: принято ${okN} из ${ws.length} волн` + (bad.length ? `; НЕ приняты: ${bad.join(", ")}` : "") + (okN < ws.length ? " — выкат без полной приёмки на ваше решение" : "") : "волн, ждущих приёмки, нет"));
        }
        const p = PROJECT.release.prod;
        c.push(chk("info", null, p.pushDeploys ? "пуш main в " + UP_MAIN + " САМ запускает выкат прода (так сказано в конфиге: release.prod.pushDeploys)" : p.run ? "после пуша main в " + UP_MAIN + " — команда выката прода: " + p.run : "после пуша main в " + UP_MAIN + " команды выката нет — только пуш"));
    }
    return { checks: c, ok: c.every((x) => x.ok !== false), trees, pl };
}

export const mergeShaStep = (branch, cwd = MAIN) => ({ show: "merge-коммит " + branch, cwd, js: async (w, job) => {
        const r = await git(cwd, ["rev-parse", "HEAD"]), sha = r.ok ? String(r.out || "").trim() : "";
        if (/^[0-9a-f]{40}$/.test(sha)) {
            (job.mergeSha ||= {})[branch] = sha;
            w("merge-коммит " + branch + ": " + sha + "\n");
        }
    } });

export const mergeAbortStep = (cwd) => ({ cmd: "git", args: ["merge", "--abort"], show: "git merge --abort", cwd });
export const mergeTarget = (branch, sha = "") => (/^[0-9a-f]{40}$/.test(String(sha)) ? String(sha) : branch);

export function recipe(action, { slotKey, branch, sha = "" }) {
    if (releaseAction(action) && !enabled("release"))
        return null;
    if (action === "merge") {
        const msg = trainMergeNote(slotKey, branch) || `merge: ${branch}`;
        const what = mergeTarget(branch, sha);
        return { cwd: MAIN, label: `Влить ${branch} в staging`, lane: "ops", treeKey: "orchestrator-staging", steps: [
                { cmd: "git", args: ["merge", "--no-ff", what, "-m", msg], branch, show: `git merge --no-ff ${what === branch ? branch : branch + "@" + what.slice(0, 10)} -m "${msg}"`, cwd: MAIN, env: { GIT_TRACE2_PERF: path.join(DATA, "logs", "git-merge-perf-" + Date.now() + ".txt") }, onFail: mergeAbortStep(MAIN) },
                mergeShaStep(branch),
            ] };
    }
    if (action === "deploy-staging") {
        const run = PROJECT.release.stand.run;
        if (!run)
            return null;
        return { cwd: MAIN, label: "Выкат staging на стенд", lane: "ops", treeKey: "orchestrator-staging", steps: [
                { cmd: "git", args: ["push", REMOTE, "staging:" + upName(UP_STAGING)], show: "git push " + REMOTE + " staging:" + upName(UP_STAGING), cwd: MAIN },
                { text: run, show: run, cwd: MAIN },
            ] };
    }
    if (action === "release") {
        const mustBe = async (cwd, args, ok, msg) => {
            const r = await git(cwd, args);
            if (!ok(r))
                throw new Error(msg + (r.err ? `\n${r.err}` : ""));
            return r;
        };
        if (!UP_MAIN)
            return null;
        const upMain = upName(UP_MAIN), prod = PROJECT.release.prod;
        const after = [];
        if (prod.run)
            after.push({ text: prod.run, show: prod.run + "   ← выкат прода", cwd: MAIN_WT });
        if (prod.verify)
            after.push({ text: prod.verify, show: prod.verify + "   ← проверка после выката", cwd: MAIN_WT });
        return { cwd: MAIN_WT, label: "Выкат в прод: staging → main", lane: "ops", treeKey: "orchestrator-main", steps: [
                { cmd: "git", args: ["fetch", REMOTE], show: "git fetch " + REMOTE, cwd: MAIN_WT },
                { show: "проверка: " + UP_MAIN + " — предок staging", cwd: MAIN_WT, js: async (w) => {
                        await mustBe(MAIN_WT, ["merge-base", "--is-ancestor", UP_MAIN, "staging"], (r) => r.ok, UP_MAIN + " ушла вперёд staging (правка мимо staging?). Сначала влейте main в staging и заново проверка.");
                        w("ok\n");
                    } },
                { show: "проверка: main — предок staging", cwd: MAIN_WT, js: async (w) => {
                        await mustBe(MAIN_WT, ["merge-base", "--is-ancestor", "main", "staging"], (r) => r.ok, "main не предок staging.");
                        w("ok\n");
                    } },
                { cmd: "git", args: ["merge", "--no-ff", "staging", "-m", "release: staging -> main"], show: 'git merge --no-ff staging -m "release: staging -> main"', cwd: MAIN_WT },
                { show: "проверка: дерево main = дерево staging", cwd: MAIN_WT, js: async (w) => {
                        const [a, b] = await Promise.all([git(MAIN_WT, ["rev-parse", "HEAD^{tree}"]), git(MAIN_WT, ["rev-parse", "staging^{tree}"])]);
                        if (!a.ok || a.out !== b.out)
                            throw new Error(`деревья РАЗНЫЕ (${a.out.slice(0, 8)} ≠ ${b.out.slice(0, 8)}). Пуш НЕ сделан. Локальный main в ${fwd(MAIN_WT)} теперь впереди ${UP_MAIN} — разберитесь руками до следующего выката.`);
                        w(`дерево ${a.out.slice(0, 10)} совпало\n`);
                    } },
                { show: "git push " + REMOTE + " main:" + upMain + (prod.pushDeploys ? "   ← ЗАПУСКАЕТ ВЫКАТ ПРОДА" : "") + " (обрыв связи — до " + PUSH_TRIES + " попыток, затем сверка ls-remote)", cwd: MAIN_WT, js: (w, job) => pushMainRetry(w, {
                        push: async () => {
                            let out = "";
                            const code = await spawnStep(job, { cmd: "git", args: ["push", REMOTE, "main:" + upMain], cwd: MAIN_WT }, (s) => {
                                out += s;
                                w(s);
                            });
                            return { code, out };
                        },
                        localSha: async () => (await git(MAIN_WT, ["rev-parse", "main"])).out,
                        remoteSha: async () => {
                            const r = await git(MAIN_WT, ["ls-remote", REMOTE, "refs/heads/" + upMain], 60000);
                            return r.ok ? r.out.split(/\s+/)[0] || "" : null;
                        },
                        cancelled: () => !!job.cancelled,
                    }).then(async (r) => {
                        job.mainSha = (await git(MAIN_WT, ["rev-parse", "main"])).out.trim() || null;
                        return r;
                    }) },
                ...after,
            ] };
    }
    return null;
}

export const PUSH_TRIES = 4, PUSH_PAUSE_MS = 15000;
export const PUSH_DROP_RE = /Connection (closed|reset|timed out)|port 22|kex_exchange_identification|Broken pipe|early EOF|remote end hung up unexpectedly|Could not resolve hostname|Operation timed out/i;

export async function pushMainRetry(w, { push, localSha, remoteSha, cancelled = () => false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tries = PUSH_TRIES, pauseMs = PUSH_PAUSE_MS }) {
    const local = await localSha();
    if (!local)
        throw new Error("не прочитан локальный main — пуш не делаю");
    let last = null;
    for (let i = 1; i <= tries; i++) {
        if (cancelled())
            throw new Error("выкат отменён до пуша (попытка " + i + ")");
        last = await push();
        if (last.code === 0)
            break;
        if (cancelled())
            throw new Error("выкат отменён во время пуша — дошёл ли он, покажет git ls-remote " + REMOTE);
        if (!PUSH_DROP_RE.test(last.out))
            throw new Error("git push отказал (код " + last.code + ") — это не обрыв связи, повтор не поможет");
        if (i < tries) {
            w(`\n⟳ обрыв связи с ${REMOTE} (попытка ${i} из ${tries}) — повтор через ${Math.round(pauseMs / 1000)} с\n`);
            await sleep(pauseMs);
        }
    }
    let remote = null;
    for (let i = 1; i <= tries && remote === null; i++) {
        remote = await remoteSha();
        if (remote === null && i < tries) {
            w(`\n⟳ git ls-remote не ответил (попытка ${i} из ${tries}) — повтор через ${Math.round(pauseMs / 1000)} с\n`);
            await sleep(pauseMs);
        }
    }
    if (remote === local) {
        w(`\nсверка: ${UP_MAIN || REMOTE} = локальный main (${local.slice(0, 10)})` + (last && last.code !== 0 ? " — пуш дошёл, оборвался только ответ" : "") + "\n");
        return { ok: true, sha: local };
    }
    throw new Error(remote === null ? `${REMOTE} не ответил на ls-remote после ${tries} попыток: дошёл ли пуш — неизвестно. Локальный main ${local.slice(0, 10)}; проверьте git ls-remote ${REMOTE} и повторите пуш main из ${fwd(MAIN_WT)} руками.`
        : `после ${tries} попыток ${UP_MAIN || REMOTE} = ${remote.slice(0, 10) || "(нет)"}, локальный main = ${local.slice(0, 10)}: пуш не дошёл. Влив staging → main уже сделан локально — повторите пуш main из ${fwd(MAIN_WT)}, когда связь вернётся.`);
}

export const ORDER_DISMISS_FILE = path.join(DATA, "order-dismissed.json");
export const pairConflict = new Map();

/**
 * Зона файла для подсказок порядка: папка третьего уровня (`apps/api/orders`). Две ветки, правящие одну зону, скорее
 * всего зависят друг от друга, даже если файлы разные. Файл мельче трёх уровней зоны не даёт.
 */
export function zoneOf(f) {
    const parts = String(f || "").split("/").filter((x) => x && !/^\[/.test(x));
    return parts.length >= 4 ? "папка " + parts.slice(0, 3).join("/") : null;
}
/** Общие файлы, совпадение которых о зависимости не говорит: замки пакетов и снимки. */
export const ORDER_NOISE_RE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|go\.sum|Cargo\.lock|poetry\.lock|uv\.lock)$|\.snap$|__snapshots__\//;

export async function orderHints(trees) {
    if (!openEpics().length)
        return [];
    const live = trees.filter((t) => t.exists && t.kind === "slot" && !t.readOnly && t.touched && (t.ahead > 0 || t.dirtyTracked) && !(t.verdict && t.verdict.merged));
    const out = [];
    for (let i = 0; i < live.length; i++)
        for (let k = i + 1; k < live.length; k++) {
            const a = live[i], b = live[k];
            if (a.epic !== b.epic)
                continue;
            const sa = slotOf(a.key) || {}, sb = slotOf(b.key) || {};
            if ((sa.after || []).includes(b.key) || (sb.after || []).includes(a.key))
                continue;
            const pk = [a.key, b.key].sort().join("|");
            if (S.orderDismissed[pk])
                continue;
            const fb = new Set(b.touched), files = a.touched.filter((f) => fb.has(f) && !ORDER_NOISE_RE.test(f));
            const zb = new Set(b.touched.map(zoneOf).filter(Boolean)), zones = [...new Set(a.touched.map(zoneOf).filter((z) => z && zb.has(z)))];
            if (!files.length && !zones.length)
                continue;
            const ck = a.key + "|" + b.key + "|" + (a.fp || a.tree) + "|" + (b.fp || b.tree);
            if (!pairInfo.has(ck)) {
                pairInfo.set(ck, null);
                pairAnalyze(a, b).then((r) => pairInfo.set(ck, r), () => pairInfo.delete(ck));
            }
            const info = pairInfo.get(ck);
            if (!info)
                continue;
            if (!info.conflict && !info.dep)
                continue;
            out.push({ a: a.key, b: b.key, at: a.tag, bt: b.tag, files: (info.conflictFiles || files).slice(0, 6), nfiles: (info.conflictFiles || files).length, zones, conflict: info.conflict, dep: info.dep });
        }
    return out;
}

export const pairInfo = new Map();

export async function pairAnalyze(a, b) {
    const res = { conflict: false, conflictFiles: null, dep: null };
    if (a.branch && b.branch) {
        const r = await git(MAIN, ["merge-tree", "--write-tree", "--name-only", a.branch, b.branch], 60000);
        if (!r.ok) {
            res.conflict = true;
            res.conflictFiles = r.out.split("\n").slice(1).filter((l) => l && !/^(Auto-merging|CONFLICT)/.test(l));
        }
    }
    const GENERIC = /^(index|types?|utils?|route|helpers?|constants?|config)$/;
    const side = async (t) => {
        const mb = (await git(t.path, ["merge-base", "staging", "HEAD"])).out;
        if (!mb)
            return { added: [], plus: "" };
        const [ad, df] = await Promise.all([git(t.path, ["diff", "--name-only", "--diff-filter=A", mb], 60000), git(t.path, ["diff", "-U0", mb], 90000, true)]);
        const added = ad.out.split("\n").filter((f) => /\.(ts|tsx|js|mjs|cjs|vue)$/.test(f) && !/(__tests__|\.spec\.|\.test\.)/.test(f));
        const plus = df.out.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
        return { added, plus };
    };
    const [sa, sb] = await Promise.all([side(a), side(b)]);
    const uses = (added, text) => added.find((f) => {
        const parts = f.replace(/\.(ts|tsx|js|mjs|cjs|vue)$/, "").split("/"), base = parts[parts.length - 1];
        if (GENERIC.test(base)) {
            const tail = parts.slice(-2).join("/");
            return text.includes("/" + tail + "'") || text.includes("/" + tail + '"');
        }
        return new RegExp("[/'\"]" + base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\.(ts|js|vue))?['\"]").test(text);
    });
    const ba = uses(sa.added, sb.plus), ab = uses(sb.added, sa.plus);
    if (ba && !ab)
        res.dep = { first: a.key, then: b.key, file: ba };
    else if (ab && !ba)
        res.dep = { first: b.key, then: a.key, file: ab };
    else if (ab && ba)
        res.dep = { both: true, file: ba };
    return res;
}

export function setOrder(a, b, op) {
    const pk = [a, b].sort().join("|");
    if (op === "none") {
        S.orderDismissed[pk] = Date.now();
        saveJson(ORDER_DISMISS_FILE, S.orderDismissed);
        return;
    }
    const eid = epicOfKey(a), reg = loadEpics(), e = reg.epics.find((x) => x.id === eid);
    if (!e)
        throw new Error("нет эпика слота " + a);
    const s = e.slots.find((z) => z.slot === a);
    if (!s || !e.slots.find((z) => z.slot === b))
        throw new Error("нет такого слота");
    const o = e.slots.find((z) => z.slot === b);
    if ((o.after || []).includes(a))
        throw new Error("обратный порядок уже записан: получится цикл");
    s.after = [...new Set([...(s.after || []), b])];
    saveEpics(reg);
    const live = slotOf(a);
    if (live)
        live.after = s.after;
}

export const TRAIN_FILE = path.join(DATA, "train.json");
export const saveTrain = () => saveJson(TRAIN_FILE, S.train, 1);
export const trainNow = () => S.train;

export const markTrain = (patch) => {
    Object.assign(S.train, patch);
};

export const clearTrain = () => {
    S.train = null;
};

export function loadTrain() {
    S.train = readJson(TRAIN_FILE, null);
}

export function loadOrderDismissed() {
    S.orderDismissed = readJson(ORDER_DISMISS_FILE, {}) || {};
}

export const REG_TRAIN_DIR = path.join(WT, "regress-train"), REG_TRAIN_BRANCH = "dev/regress-train";

export function conflictCost(k, keys) {
    const t = snapNow() && snapNow().trees.find((x) => x.key === k);
    let c = t && t.conflict && t.conflict.length ? 100 + t.conflict.length : 0;
    for (const h of (snapNow() && snapNow().orderHints) || [])
        if (h.conflict && (h.a === k || h.b === k) && keys.includes(h.a === k ? h.b : h.a))
            c += 10 + (h.nfiles || 0);
    return c;
}

export function trainOrder(keys) {
    const num = (k) => Number((/\d+/.exec((treeByKey(k) || {}).tag || "") || [99])[0]), left = [...keys].sort((a, b) => conflictCost(a, keys) - conflictCost(b, keys) || num(a) - num(b)), out = [];
    while (left.length) {
        const i = left.findIndex((k) => ((slotOf(k) || {}).after || []).every((d) => !left.includes(d)));
        out.push(...left.splice(i < 0 ? 0 : i, 1));
    }
    return out;
}

export function trainCandidates(epic) {
    if (!snapNow())
        return [];
    const ok = (t) => inEpic(t, epic) && t.exists && t.kind === "slot" && !t.readOnly && t.ahead > 0 && !t.dirtyTracked && !(t.verdict && t.verdict.merged) && !(Array.isArray(t.conflict) && t.conflict.length) && (t.stages || []).filter((s) => ["build", "tests", "guards", "regress", "review"].includes(s.id)).every((s) => s.done);
    let c = snapNow().trees.filter(ok).map((t) => t.key);
    for (let changed = true; changed;) {
        changed = false;
        for (const k of [...c]) {
            const t = snapNow().trees.find((x) => x.key === k);
            if ((t.deps || []).some((d) => !d.merged && !c.includes(d.key))) {
                c = c.filter((x) => x !== k);
                changed = true;
            }
        }
    }
    return trainOrder(c);
}

export function trainTasks(keys) {
    const acc = new Map();
    for (const k of keys)
        for (const it of ((snapNow() && snapNow().trees.find((x) => x.key === k)) || {}).regress || []) {
            const sep = TASKS[it.task] && TASKS[it.task].parser === "jest" ? "|" : ",";
            const cur = acc.get(it.task);
            acc.set(it.task, cur == null ? it.input || "" : [...new Set([...cur.split(sep), ...(it.input || "").split(sep)])].filter(Boolean).join(sep));
        }
    return [...acc.entries()].map(([task, input]) => ({ task, input }));
}

/** Проверки состава поезда: гарды проекта, затем регресс тронутых спек. */
export const trainChecks = (keys) => [...guardIds().map((task) => ({ task, input: "" })), ...trainTasks(keys).filter((x) => TASKS[x.task])];

/** Команда проверок состава для удалённой машины: все проверки подряд, итог — красный, если упала хоть одна. */
export function trainRemoteCmd(keys) {
    const L = ["rc=0"];
    for (const x of trainChecks(keys))
        L.push("( " + remoteCmdFor(x.task, x.input) + " ) || rc=1");
    L.push("exit $rc");
    return L.join("\n");
}

export async function startTrainRun(keys, why) {
    const t0 = keys.map((k) => treeByKey(k)), fps = {};
    for (const t of t0)
        fps[t.key] = await codeFp(t.path, true);
    const steps = [];
    if (!fs.existsSync(path.join(REG_TRAIN_DIR, ".git")))
        steps.push({ cmd: "git", args: ["worktree", "add", "--detach", REG_TRAIN_DIR, "staging"], show: "git worktree add regress-train (папка поезда)", cwd: MAIN });
    steps.push({ cmd: "git", args: [...SAFE_GIT, "merge", "--abort"], show: "git merge --abort (если прошлая проба оборвалась посреди слияния)", cwd: REG_TRAIN_DIR, ignore: true });
    steps.push({ cmd: "git", args: [...SAFE_GIT, "checkout", "-q", "--detach", "-f", "staging"], show: "git checkout --detach staging (папка поезда = нынешний staging)", cwd: REG_TRAIN_DIR });
    steps.push({ cmd: "git", args: [...SAFE_GIT, "clean", "-fdq"], show: "git clean -fdq (следы прошлого состава)", cwd: REG_TRAIN_DIR, ignore: true });
    for (const t of t0)
        steps.push({ cmd: "git", args: [...SAFE_GIT, "merge", "--no-ff", "--no-edit", "-m", "train: " + t.branch, "--end-of-options", t.branch], show: "git merge --no-ff " + t.branch + " (" + t.tag + "; хуки и rerere выключены)", cwd: REG_TRAIN_DIR });
    const checks = trainChecks(keys), what = checks.map((x) => x.task + (x.input ? " " + x.input.slice(0, 40) : "")).join("; ") || "проверок нет";
    // Есть удалённые машины — поезд встаёт в дорожку своей первой проверки и берёт место той же очередью, что задачи
    // проекта (runner.pumpRemote): ждёт место, бронирует, снимает бронь в любом исходе. Какое место дали, видно только
    // при запуске, поэтому проверки состава описаны на оба случая: шаг `on: "remote"` идёт на удалённой машине, шаги
    // `on: "here"` — на этой (runner.stepsFor). Без удалённых машин — дорожка ops и только здешние шаги, как раньше.
    const placed = remoteOn() && checks.length > 0;
    if (placed)
        steps.push({ on: "remote", show: "на удалённой машине: гарды и регресс состава (" + what + ")", cwd: REG_TRAIN_DIR,
            js: async (write, job) => {
                const code = await shardApi().slotRun({ jobId: job.id, key: "regress-train", cwd: REG_TRAIN_DIR, cmd: trainRemoteCmd(keys), lane: job.lane, heavy: true }, write, (c) => procs.set(job.id, c), job.runOn);
                procs.delete(job.id);
                if (code)
                    throw new Error("на дереве поезда красное (код " + code + "): падения выше");
            } });
    // здесь: папке поезда нужна та же подготовка, что слоту (зависимости), затем проверки состава; службы этой машины
    // раннер поднимает сам (`services: true`) — только когда прогон идёт здесь
    for (const s of PROJECT.slotPrepare.filter((x) => x.when === "always"))
        steps.push({ on: "here", text: s.run, show: s.run + " (подготовка папки поезда)", cwd: REG_TRAIN_DIR });
    for (const x of checks) {
        const st = stepOfTask(TASKS[x.task], REG_TRAIN_DIR, x.input);
        steps.push({ ...st, on: "here", show: st.show + " (" + TASKS[x.task].label + ")" });
    }
    const job = await enqueue({ treeKey: "orchestrator-staging", cwd: MAIN, label: "Поезд: " + t0.map((t) => t.tag).join(" + ") + " на staging", taskId: "train", input: keys.join(","), lane: placed ? TASKS[checks[0].task].lane : "ops", steps, extra: { train: true, auto: true, by: "поезд влива", services: true } });
    S.train.runs.push({ id: job.id, keys, why, fps, staging: stagingTreeSha(), at: Date.now() });
    S.train.status = "run";
    saveTrain();
    logEvent("train.run", { id: job.id, keys, why });
    return job;
}

export async function trainStart(epic) {
    const keys = trainCandidates(epic);
    if (keys.length < 1)
        throw new Error("нет готовых веток: поезд собирается из тех, у кого пройдены сборка, тесты, гарды и регресс");
    S.train = { id: "t" + Date.now().toString(36), keys, status: "run", culprits: {}, runs: [], at: Date.now(), epic: epic || null };
    return startTrainRun(keys, "весь состав");
}

export function trainFinished(job) {
    if (!S.train)
        return;
    const run = S.train.runs.find((r) => r.id === job.id);
    if (!run)
        return;
    const fails = failingSpecs(job.id).filter((f) => !knownRed(f)), mergeFail = job.status === "fail" && !failingSpecs(job.id).length;
    run.status = job.status === "ok" || (job.status === "fail" && !mergeFail && !fails.length) ? "ok" : job.cancelled ? "cancelled" : "fail";
    run.fails = fails;
    if (run.status === "cancelled") {
        S.train.status = "stopped";
        return saveTrain();
    }
    const pending = S.train.runs.filter((r) => !r.status);
    if (run.status === "fail") {
        if (run.keys.length === 1)
            S.train.culprits[run.keys[0]] = fails.length ? "красное вместе со staging: " + fails.slice(0, 4).join(", ") : "не вливается или не собирается на staging (см. лог " + job.id + ")";
        else {
            const ord = trainOrder(run.keys), h = Math.ceil(ord.length / 2), A = ord.slice(0, h), B = ord.slice(h);
            const withDeps = (part) => trainOrder([...new Set([...part.flatMap((k) => ((slotOf(k) || {}).after || []).filter((d) => run.keys.includes(d))), ...part])]);
            const hA = withDeps(A), hB = withDeps(B);
            if (hA.length === run.keys.length || hB.length === run.keys.length) {
                S.train.status = "fail";
                S.train.note = "состав не делится: вагоны связаны зависимостями (" + run.keys.map((k) => treeByKey(k).tag).join(" + ") + "); смотрите лог " + job.id;
                return saveTrain();
            }
            startTrainRun(withDeps(A), "половина " + A.map((k) => treeByKey(k).tag).join("+")).catch(() => { });
            startTrainRun(withDeps(B), "половина " + B.map((k) => treeByKey(k).tag).join("+")).catch(() => { });
            return saveTrain();
        }
    }
    if (pending.length)
        return saveTrain();
    const survivors = S.train.keys.filter((k) => !S.train.culprits[k]);
    const greenFull = S.train.runs.find((r) => r.status === "ok" && survivors.length && r.keys.length === survivors.length && survivors.every((k) => r.keys.includes(k)));
    if (greenFull) {
        S.train.status = "green";
        S.train.green = greenFull.id;
    }
    else if (!survivors.length)
        S.train.status = "fail";
    else if (S.train.runs.some((r) => r.status === "fail" && r.keys.length === survivors.length && survivors.every((k) => r.keys.includes(k)))) {
        S.train.status = "fail";
        S.train.note = "порознь зелёные, вместе красные: " + survivors.map((k) => treeByKey(k).tag).join(" + ") + " — ветки ломают друг друга; нужен порядок (одна после другой) и правка в младшей";
    }
    else {
        startTrainRun(trainOrder(survivors), "состав без виновников").catch(() => { });
        return saveTrain();
    }
    saveTrain();
}

export async function trainValid() {
    if (!S.train || S.train.status !== "green")
        return { ok: false, why: "поезд не зелёный" };
    const r = S.train.runs.find((x) => x.id === S.train.green);
    if (r.staging !== stagingTreeSha())
        return { ok: false, why: "staging сдвинулся после проверки поезда — проверьте заново" };
    for (const k of r.keys) {
        const t = treeByKey(k);
        if (await codeFp(t.path, true) !== r.fps[k])
            return { ok: false, why: t.tag + ": код менялся после проверки поезда" };
    }
    return { ok: true, keys: r.keys };
}

export function trainPublic(epic) {
    const cand = trainCandidates(epic);
    return { candidates: cand.map((k) => ({ key: k, tag: (treeByKey(k) || {}).tag })), cur: S.train && { ...S.train, runs: S.train.runs.map((r) => {
                const j = jobList().find((x) => x.id === r.id);
                return { ...r, jobStatus: j && j.status, tags: r.keys.map((k) => (treeByKey(k) || {}).tag) };
            }), culpritTags: Object.fromEntries(Object.entries(S.train.culprits || {}).map(([k, v]) => [(treeByKey(k) || {}).tag || k, v])) } };
}
