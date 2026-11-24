// Службы для тестов на этой машине (services.mjs): тот же скрипт, что и на удалённой, выполняется здесь через bash.
// Команды служб — безопасные `node -e …`, следы — файлы во временной папке: поднята — `up` не зовётся; не поднята —
// зовётся; `up` не помог — ошибка; `down` — после последнего прогона. И сквозь раннер: служба не поднялась — команды
// прогона не запускались.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dk-services-"));
process.env.DASH_DATA = path.join(TMP, "data");
process.env.DASH_DRY = "1";
process.env.DISPATCHER_MAIN = path.join(TMP, "main");
fs.mkdirSync(path.join(process.env.DASH_DATA, "logs"), { recursive: true });
fs.mkdirSync(process.env.DISPATCHER_MAIN, { recursive: true });
// на Windows Git Bash отпускает папку прогона не сразу после выхода: уборка временной папки — с повторами и без падения
after(() => {
    try {
        fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    }
    catch { }
});

const { createLocalServices, downLines, localBash, NO_BASH, setLocalServices, upLines, usesServices } = await import("./services.mjs");

const BASH = localBash();
const NODE = '"' + process.execPath.split("\\").join("/") + '"';
const js = (code) => NODE + " -e " + "'" + code + "'";
const CHECK = js('process.exit(require("fs").existsSync("up.flag") ? 0 : 1)');
const UP = js('const f = require("fs"); f.appendFileSync("up.log", "u"); f.writeFileSync("up.flag", "")');
const DOWN = js('const f = require("fs"); f.appendFileSync("down.log", "d"); f.rmSync("up.flag", { force: true })');
const NOOP = js("0");

let n = 0;
const box = () => {
    const d = path.join(TMP, "run-" + ++n);
    fs.mkdirSync(d);
    return d;
};
const read = (d, f) => (fs.existsSync(path.join(d, f)) ? fs.readFileSync(path.join(d, f), "utf8") : "");
const svc = (o = {}) => ({ name: "db", up: UP, check: CHECK, down: DOWN, ...o });
const SKIP = !BASH && "нет bash (на Windows — Git for Windows или DISPATCHER_BASH)";

test("скрипт: сначала check, потом up и ожидание; без check — up всегда; down — только у служб с down", () => {
    const L = upLines([svc(), { name: "cache", up: "redis-server --daemonize yes", check: "", down: "" }], { tries: 3, pauseS: 0 }).join("\n");
    assert.ok(L.indexOf("bash -ec '" + CHECK.split("'").join("'\\''")) < L.indexOf("bash -ec '" + UP.split("'").join("'\\''")), "работающую службу не перезапускаем");
    assert.match(L, /\[ "\$n" -ge 3 \]/);
    assert.match(L, /== служба cache[\s\S]*bash -ec 'redis-server --daemonize yes' <\/dev\/null \|\| fail/);
    assert.deepEqual(downLines([svc({ down: "" }), svc({ name: "q", down: "stop-q" })]).length, 2, "остановка только у службы с down");
    assert.equal(usesServices({ task: "lint" }, { lint: {} }), true, "задача проекта");
    assert.equal(usesServices({ task: "train", services: true }, {}), true, "поезд без машин");
    assert.equal(usesServices({ task: "review" }, { lint: {} }), false, "служебная задача");
});

test("служба уже поднята — up не зовётся", { skip: SKIP }, async () => {
    const d = box();
    fs.writeFileSync(path.join(d, "up.flag"), "");
    const ls = createLocalServices({ services: [svc()], pauseS: 0 });
    let out = "";
    assert.equal(await ls.up({ jobId: "j1", key: "s1", cwd: d }, (s) => { out += s; }), 0, out);
    assert.match(out, /уже работает/);
    assert.equal(read(d, "up.log"), "", "up не звали");
});

test("служба не поднята — зовётся up, затем check проходит", { skip: SKIP }, async () => {
    const d = box();
    const ls = createLocalServices({ services: [svc()], pauseS: 0 });
    let out = "";
    assert.equal(await ls.up({ jobId: "j1", key: "s1", cwd: d }, (s) => { out += s; }), 0, out);
    assert.equal(read(d, "up.log"), "u");
    assert.match(out, /== служба db[\s\S]*запущена/);
    assert.equal((await ls.check(svc(), d)).ok, true, "проверка для монитора — тем же запуском");
});

test("up не помог — прогон получает ненулевой код и понятную строку; упавший up — его код", { skip: SKIP }, async () => {
    const d = box();
    let out = "";
    const ls = createLocalServices({ services: [svc({ up: NOOP })], tries: 2, pauseS: 0 });
    assert.equal(await ls.up({ jobId: "j1", key: "s1", cwd: d }, (s) => { out += s; }), 1);
    assert.match(out, /✗ служба db не отвечает после запуска: проверка/);
    out = "";
    const bad = createLocalServices({ services: [svc({ up: js("process.exit(3)") })], pauseS: 0 });
    assert.equal(await bad.up({ jobId: "j2", key: "s1", cwd: d }, (s) => { out += s; }), 3);
    assert.match(out, /✗ служба db: запуск не прошёл/);
});

test("down — когда на машине не осталось прогонов, которым нужны службы", { skip: SKIP }, async () => {
    const d = box();
    const ls = createLocalServices({ services: [svc()], pauseS: 0 });
    const a = { jobId: "j1", key: "s1", cwd: d }, b = { jobId: "j2", key: "s2", cwd: d };
    assert.equal(await ls.up(a), 0);
    assert.equal(await ls.up(b), 0);
    assert.equal(read(d, "up.log"), "u", "второй прогон увидел службу первого");
    assert.equal(await ls.release(a), null, "второй ещё идёт — службы не трогаем");
    assert.equal(read(d, "down.log"), "");
    let out = "";
    assert.equal(await ls.release(b, (s) => { out += s; }), 0, out);
    assert.equal(read(d, "down.log"), "d");
    assert.equal(fs.existsSync(path.join(d, "up.flag")), false);
    assert.match(out, /служба db: остановка/);
    assert.equal(await ls.release(b), null, "повторное снятие брони — ничего");
    assert.deepEqual(ls.active(), []);
});

test("bash не найден — понятная ошибка, а не запуск через другую оболочку", async () => {
    const ls = createLocalServices({ services: [svc()], bash: () => "" });
    let out = "";
    assert.equal(await ls.up({ jobId: "j1", key: "s1", cwd: TMP }, (s) => { out += s; }), 127);
    assert.ok(out.includes(NO_BASH));
    assert.equal((await ls.check(svc(), TMP)).why, NO_BASH);
});

test("раннер: перед задачей проекта — службы этой машины; не поднялись — команды прогона не запускались, прогон красный, бронь снята", { skip: SKIP }, async () => {
    await import("./wiring.mjs");
    const { runJob } = await import("./runner.mjs");
    const { addJob, loadJobs } = await import("./jobs.mjs");
    loadJobs([]);
    const d = process.env.DISPATCHER_MAIN;
    const ls = createLocalServices({ services: [svc({ up: NOOP })], tries: 1, pauseS: 0 });
    setLocalServices(ls);
    try {
        const job = { id: "jsvc1", tree: "nowhere", task: "lint", label: "lint", input: "", lane: "main", status: "queued", queuedAt: Date.now(),
            steps: [{ text: js('require("fs").writeFileSync("ran.txt", "")'), show: "lint", cwd: d }] };
        addJob(job);
        await runJob(job);
        assert.equal(job.status, "fail");
        assert.equal(fs.existsSync(path.join(d, "ran.txt")), false, "команда прогона не запускалась");
        assert.match(job.summary, /службы этой машины не готовы|не отвечает после запуска/);
        assert.deepEqual(ls.active(), [], "бронь снята");
        assert.ok(fs.existsSync(path.join(d, "down.log")), "последний прогон — down");
    }
    finally {
        setLocalServices(null);
    }
});
