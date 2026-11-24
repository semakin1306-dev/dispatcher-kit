import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { bootSeen, drainRetry, markBootInterrupted, pageToken, sentryVerdict, startReason } from "./restart-rules.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESTART = resolve(HERE, "../../../tools/restart-dashboard.mjs");

describe("drainRetry — неответ /api/drain не значит «тихо»", () => {
    test("три неудачи подряд — ok:false, все ошибки, пауза между попытками", async () => {
        const pauses = [];
        let n = 0;
        const r = await drainRetry(async () => {
            n++;
            throw new Error("timeout " + n);
        }, { tries: 3, pauseMs: 7, sleep: async (ms) => {
                pauses.push(ms);
            } });
        assert.equal(r.ok, false);
        assert.equal(n, 3);
        assert.deepEqual(r.errors, ["timeout 1", "timeout 2", "timeout 3"]);
        assert.deepEqual(pauses, [7, 7]);
    });
    test("ответил со второй попытки — ok:true и его ответ", async () => {
        let n = 0;
        const r = await drainRetry(async () => {
            if (++n === 1)
                throw new Error("занят");
            return { idle: true };
        }, { tries: 3, pauseMs: 0, sleep: async () => { } });
        assert.equal(r.ok, true);
        assert.deepEqual(r.st, { idle: true });
        assert.equal(n, 2);
    });
});

describe("pageToken — токен запуска со страницы", () => {
    test("настоящая index.html с подставленным токеном — токен находится", () => {
        const html = readFileSync(join(HERE, "index.html"), "utf8").replace("__TOKEN__", "0f9e8d7c6b5a");
        assert.equal(pageToken(html), "0f9e8d7c6b5a");
    });
    test("старый вид страницы — тоже; токена нет — null", () => {
        assert.equal(pageToken('const TOKEN = "abc123"'), "abc123");
        assert.equal(pageToken("<html></html>"), null);
    });
});

describe("markBootInterrupted — итог «оборвано при перезапуске»", () => {
    test("идущие, ждущие и стоящие в очереди — interrupted с пометкой; список для события", () => {
        const runs = [{ id: "j1", task: "api-test", tree: "wv1", status: "ok" }, { id: "j2", task: "slot-up", tree: "wv2", status: "running" }, { id: "j3", task: "slot-up", tree: "wv2", status: "queued" }, { id: "j4", task: "lint", tree: "wv3", status: "waiting", endedAt: 5 }];
        const { runs: out, cut } = markBootInterrupted(runs, 1000);
        assert.deepEqual(out.map((j) => j.status), ["ok", "interrupted", "interrupted", "interrupted"]);
        assert.ok(out.slice(1).every((j) => j.bootInterrupted));
        assert.equal(out[1].endedAt, 1000);
        assert.equal(out[3].endedAt, 5);
        assert.deepEqual(cut, [{ id: "j2", task: "slot-up", tree: "wv2", was: "running" }, { id: "j3", task: "slot-up", tree: "wv2", was: "queued" }, { id: "j4", task: "lint", tree: "wv3", was: "waiting" }]);
        assert.equal(runs[1].status, "running");
    });
});

describe("bootSeen — что после старта не нужно дописывать в runs.jsonl", () => {
    test("изменённое миграцией и оборванное перезапуском — не «уже записано», нетронутое — записано", () => {
        const jobs = [{ id: "j1", status: "ok" }, { id: "j2", status: "fail", summary: "✗ ssh: Connection timed out" }, { id: "j3", status: "interrupted", bootInterrupted: true }];
        const loaded = new Map(jobs.map((j) => [j.id, JSON.stringify(j)]));
        Object.assign(jobs[1], { status: "interrupted", infra: "ssh", requeued: true });
        const seen = bootSeen(jobs, loaded);
        assert.deepEqual(seen.map(([id]) => id), ["j1"]);
        assert.equal(seen[0][1], JSON.stringify(jobs[0]));
    });
    test("прогона нет в снимке загрузки — дописывается", () => assert.deepEqual(bootSeen([{ id: "j9", status: "ok" }], new Map()), []));
});

describe("sentryVerdict — когда сторож перезапускает", () => {
    const now = 1000000000, fresh = { pid: 42, at: now - 30e3, sha: "abc" }, stale = { pid: 42, at: now - 4 * 60e3, sha: "abc" };
    test("порт никто не держит — не трогаем: сервер остановили намеренно (окно закрыто, stop-dispatcher)", () => {
        const v = sentryVerdict({ now, listenerPid: null, pulse: stale });
        assert.equal(v.act, "none");
        assert.match(v.why, /не запущен/);
    });
    test("пульс свежий — всё хорошо", () => assert.equal(sentryVerdict({ now, listenerPid: 42, pulse: fresh }).act, "none"));
    test("пульса нет 4 мин у того же процесса — перезапуск, причина с временем последнего пульса", () => {
        const v = sentryVerdict({ now, listenerPid: 42, pulse: stale });
        assert.equal(v.act, "restart");
        assert.match(v.why, /нет пульса 4 мин/);
        assert.match(v.why, /pid 42/);
    });
    test("файла пульса нет или он от другого процесса — не трогаем (сервер старой версии, без пульса)", () => {
        assert.equal(sentryVerdict({ now, listenerPid: 42, pulse: null }).act, "none");
        assert.equal(sentryVerdict({ now, listenerPid: 43, pulse: stale }).act, "none");
    });
    test("недавно уже перезапускал — ждём, а не перезапускаем по кругу", () => {
        const v = sentryVerdict({ now, listenerPid: 42, pulse: stale, lastRestartAt: now - 5 * 60e3 });
        assert.equal(v.act, "none");
        assert.match(v.why, /недавно/);
        assert.equal(sentryVerdict({ now, listenerPid: 42, pulse: stale, lastRestartAt: now - 11 * 60e3 }).act, "restart");
    });
});

describe("startReason — причина запуска для события server.start", () => {
    test("restart-dashboard передаёт причину окружением; без неё — запуск не через скрипт", () => {
        assert.equal(startReason({ DASH_START_REASON: "сторож: нет пульса 4 мин" }), "сторож: нет пульса 4 мин");
        assert.match(startReason({}), /не через restart-dashboard/);
    });
});

const FAKE = `const http=require("http");const s=http.createServer((q,r)=>{if(q.url==="/"){r.end('<meta name="dash-token" content="abc123">');return}let b="";q.on("data",d=>b+=d);q.on("end",()=>{if(q.url==="/api/drain"){if(q.headers["x-dash-token"]!=="abc123"){r.writeHead(403,{"content-type":"application/json"});r.end(JSON.stringify({error:"нет токена запуска"}));return}process.stdout.write("drain "+b+"\\n");r.writeHead(503,{"content-type":"application/json"});r.end(JSON.stringify({error:"занят"}));return}r.writeHead(404);r.end("{}")})});s.listen(0,"127.0.0.1",()=>process.stdout.write("PORT "+s.address().port+"\\n"))`;

test("dash-sentry.mjs --dry-run: тот же процесс держит порт и молчит 4 мин — «перезапуск»; пульс свежий — «ничего»", { timeout: 60000 }, async () => {
    const SENTRY = resolve(HERE, "../../../tools/dash-sentry.mjs");
    const fake = spawn(process.execPath, ["-e", `const s=require("http").createServer((q,r)=>r.end("{}"));s.listen(0,"127.0.0.1",()=>process.stdout.write("PORT "+s.address().port+"\\n"))`], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    fake.stdout.on("data", (d) => {
        out += d;
    });
    const port = await new Promise((ok, no) => {
        const t = setInterval(() => {
            const m = /PORT (\d+)/.exec(out);
            if (m) {
                clearInterval(t);
                ok(m[1]);
            }
        }, 20);
        setTimeout(() => no(new Error("подставной сервер не поднялся")), 10000);
    });
    const data = mkdtempSync(join(tmpdir(), "sentry-test-"));
    const run = () => new Promise((ok) => {
        const r = spawn(process.execPath, [SENTRY, "--dry-run"], { env: { ...process.env, DASH_PORT: port, DASH_DATA: data }, stdio: ["ignore", "pipe", "inherit"] });
        let s = "";
        r.stdout.on("data", (d) => {
            s += d;
        });
        r.on("exit", () => ok(JSON.parse(s)));
    });
    try {
        writeFileSync(join(data, "pulse.json"), JSON.stringify({ pid: fake.pid, at: Date.now() - 4 * 60e3, sha: "abc1234" }));
        const v1 = await run();
        assert.equal(v1.act, "restart", JSON.stringify(v1));
        assert.match(v1.why, /нет пульса 4 мин/);
        writeFileSync(join(data, "pulse.json"), JSON.stringify({ pid: fake.pid, at: Date.now(), sha: "abc1234" }));
        const v2 = await run();
        assert.equal(v2.act, "none", JSON.stringify(v2));
    }
    finally {
        fake.kill();
        rmSync(data, { recursive: true, force: true });
    }
});

test("restart-dashboard.mjs: сервер не ответил на /api/drain 3 раза — выход 2, сервер не тронут", { timeout: 90000 }, async () => {
    const fake = spawn(process.execPath, ["-e", FAKE], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    fake.stdout.on("data", (d) => {
        out += d;
    });
    const port = await new Promise((ok, no) => {
        const t = setInterval(() => {
            const m = /PORT (\d+)/.exec(out);
            if (m) {
                clearInterval(t);
                ok(m[1]);
            }
        }, 20);
        setTimeout(() => no(new Error("подставной сервер не поднялся")), 10000);
    });
    const dir = mkdtempSync(join(tmpdir(), "restart-test-"));
    let alive = true;
    fake.on("exit", () => {
        alive = false;
    });
    try {
        const r = spawn(process.execPath, [RESTART, "--skip-checks"], { env: { ...process.env, DASH_PORT: port, DASH_DIR: dir, DASH_DATA: dir, DASH_DRAIN_PAUSE_MS: "50" }, stdio: ["ignore", "pipe", "pipe"] });
        let log = "";
        r.stdout.on("data", (d) => {
            log += d;
        });
        r.stderr.on("data", (d) => {
            log += d;
        });
        const code = await new Promise((ok) => r.on("exit", ok));
        assert.equal(code, 2, log);
        assert.equal(alive, true, "подставной сервер убит:\n" + log);
        assert.match(log, /--force/);
        assert.equal((out.match(/^drain \{"on":true/gm) || []).length, 3, out);
    }
    finally {
        fake.kill();
        rmSync(dir, { recursive: true, force: true });
    }
});
