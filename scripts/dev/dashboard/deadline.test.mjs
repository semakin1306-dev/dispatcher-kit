import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DASH_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dash-deadline-"));
process.env.DASH_DRY = "1";
process.env.DASH_HANG_GRACE_MS = "40";
const D = await import("./deadline.mjs");
const G = await import("./git.mjs");
const { S } = await import("./state.mjs");

describe("settleBy и withDeadline", () => {
    test("итог пришёл вовремя — он и есть ответ; поздний итог после срока ничего не меняет", async () => {
        assert.equal(await D.settleBy((done) => {
            setTimeout(() => done("да"), 5);
        }, 200, () => "поздно"), "да");
        let late = null;
        const v = await D.settleBy((done) => {
            late = done;
            return { pid: 1 };
        }, 20, (h) => "срок вышел, pid " + h.pid);
        assert.equal(v, "срок вышел, pid 1");
        late("после срока");
    });
    test("withDeadline: не уложился — ошибка EDEADLINE с понятным текстом, в журнале сроков запись", async () => {
        const t0 = Date.now();
        await assert.rejects(D.withDeadline(new Promise(() => { }), 30, "проверка влива П3"), (e) => e.code === "EDEADLINE" && /проверка влива П3: нет ответа за/.test(e.message));
        assert.ok(D.hangsSince(t0 - 1).some((h) => h.what === "проверка влива П3"));
        assert.equal(await D.withDeadline(Promise.resolve(7), 1000, "x"), 7);
    });
});

describe("снимок: зависшая сборка не держит следующие вечно", () => {
    test("сборка дольше срока отпускается: следующая начинается, поздний итог старой не затирает новый снимок", async () => {
        const SN = await import("./snapshot.mjs");
        let release = null;
        const slow = () => new Promise((r) => {
            release = r;
        });
        const ref = { n: 0 };
        const build = (t0) => {
            ref.n++;
            const mine = ref.n;
            return (mine === 1 ? slow() : Promise.resolve()).then(() => ({ trees: [], at: Date.now(), t0, mark: mine }));
        };
        const p1 = SN._rebuildWith(build, 30);
        await p1;
        assert.equal(SN.rebuildingNow(), null, "сборка отпущена по сроку");
        await SN._rebuildWith(build, 1000);
        assert.equal(SN.snapNow().mark, 2, "вторая сборка легла");
        release();
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(SN.snapNow().mark, 2, "поздний итог первой сборки не затёр вторую");
    });
});

describe("git: обратный вызов процесса не пришёл — отказ по сроку, место в очереди освобождено", () => {
    test("четыре зависших git подряд не запирают пятый", async () => {
        const real = G._gitExec();
        let n = 0;
        G._setGitExec((file, args, opts, cb) => {
            n++;
            if (args[0] === "status") {
                setTimeout(() => cb(null, "ok", ""), 1);
                return {};
            }
            return {};
        });
        try {
            const hung = await Promise.all([1, 2, 3, 4].map(() => G.git(process.cwd(), ["rev-parse", "HEAD"], 30)));
            for (const r of hung) {
                assert.equal(r.ok, false);
                assert.equal(r.hung, true);
                assert.match(r.err, /не вернул ответ/);
            }
            assert.equal(S.gitActive, 0, "места очереди git освобождены");
            const r = await G.git(process.cwd(), ["status"], 30);
            assert.equal(r.ok, true);
            assert.equal(n, 5);
        }
        finally {
            G._setGitExec(real);
        }
    });
});
