// Поезд при включённом модуле машин: место для проверок состава берёт та же очередь, что задачи проекта
// (runner.pumpRemote → slotReserve → slotMachineOf → slotRun на этой машине → slotRelease). «Удалённая» машина — папка во
// временном каталоге за поддельным ssh (fixtures/fake-ssh.mjs), сеть и настоящий ssh не нужны. Очередь здесь живая
// (без DASH_DRY): проект, основная папка, слоты и данные — во временной папке.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FAKE_BASH, fakeSsh } from "./fixtures/fake-ssh.mjs";

const fwd = (p) => p.split("\\").join("/");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dk-train-machines-"));
const DATA = path.join(TMP, "data"), MAIN = path.join(TMP, "main"), WT = path.join(TMP, "wt"), REMOTE = fwd(path.join(TMP, "remote", "repo"));
fs.mkdirSync(path.join(DATA, "logs"), { recursive: true });
delete process.env.DASH_DRY;
process.env.DASH_DATA = DATA;
process.env.DISPATCHER_MAIN = MAIN;
process.env.DISPATCHER_WT = WT;

// проект: демо + удалённая машина `box` и службы этой машины; команды проверок только пишут файлы-следы
const NODE_JS = (code) => 'node -e "' + code + '"';
const mark = (f) => NODE_JS("require('fs').appendFileSync('" + f + "','x')");
{
    const demo = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "test", "fixtures", "project.demo.json"), "utf8"));
    const tasks = Object.fromEntries(Object.entries(demo.tasks).map(([id, t]) => [id, id === "lint" ? { ...t, run: mark("lint.txt") } : id === "typecheck" ? { ...t, run: mark("type.txt") } : t]));
    const svc = { name: "db", up: "node -e 'require(\"fs\").writeFileSync(\"svc.up\", \"\")'", check: "test -e svc.up", down: "rm -f svc.up; echo d >> svc.down" };
    const file = path.join(TMP, "project.json");
    fs.writeFileSync(file, JSON.stringify({ ...demo, tasks, slotPrepare: [{ run: mark("prep.txt") }],
        machines: { local: { workers: 2, services: [svc] }, box: { label: "Коробка", ssh: "box", dir: REMOTE, workers: 1 } }, modules: { ...(demo.modules || {}), machines: true } }));
    process.env.DISPATCHER_PROJECT = file;
}

// основная папка со staging и слот с веткой волны
const g = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
fs.mkdirSync(MAIN, { recursive: true });
g(MAIN, "init", "-q", "-b", "staging");
g(MAIN, "config", "user.email", "t@example.invalid");
g(MAIN, "config", "user.name", "t");
g(MAIN, "config", "core.autocrlf", "false");
fs.writeFileSync(path.join(MAIN, "base.txt"), "base\n");
g(MAIN, "add", "base.txt");
g(MAIN, "commit", "-qm", "base");
const SLOT = path.join(WT, "s1");
g(MAIN, "worktree", "add", "-q", "-b", "dev/wv-0001-a", SLOT, "staging");
fs.writeFileSync(path.join(SLOT, "wave.txt"), "wave\n");
g(SLOT, "add", "wave.txt");
g(SLOT, "commit", "-qm", "wave 1");

const FAKE = fakeSsh(TMP);
await import("./wiring.mjs");
const { startTrainRun, REG_TRAIN_DIR } = await import("./pipeline.mjs");
const { pumpAll, queues } = await import("./runner.mjs");
const { TREES } = await import("./trees.mjs");
const { S } = await import("./state.mjs");
const { FINAL, logPath } = await import("./config.mjs");
const { createMachinesApi } = await import("./machines.mjs");
const { setShardApi } = await import("./shard.mjs");
const { SPILL_MS } = await import("./slot-places.mjs");
const { PROJECT } = await import("../slots.mjs");
const { loadJobs } = await import("./jobs.mjs");
loadJobs([]);

TREES.push({ key: "s1", kind: "slot", epic: null, tag: "П1", path: SLOT, branch: "dev/wv-0001-a" });

// живая очередь дописывает журнал прогонов и историю спек по таймеру — уборка после них
after(async () => {
    setShardApi(null);
    await new Promise((r) => setTimeout(r, 1500));
    try {
        fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    }
    catch { }
});

const SKIP = !FAKE_BASH && "нет bash (на Windows — Git for Windows)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(ok, what, ms = 120000) {
    const t0 = Date.now();
    while (!ok()) {
        if (Date.now() - t0 > ms)
            throw new Error("не дождался: " + what);
        await sleep(50);
    }
}
const logOf = (job) => (fs.existsSync(logPath(job.id)) ? fs.readFileSync(logPath(job.id), "utf8") : "");
const freshTrain = () => {
    S.train = { id: "t" + Date.now().toString(36), keys: ["s1"], status: "run", culprits: {}, runs: [], at: Date.now(), epic: null };
};

/** Машины из конфига проекта, поддельный ssh; эта машина — с запасом памяти. Слежка за прогонами и снятием брони. */
function machines() {
    const api = createMachinesApi({ machines: PROJECT.machines, project: PROJECT.name, ssh: FAKE.ssh, emit: () => { }, watch: false,
        localLoad: () => ({ at: Date.now(), cpu: 5, cores: [5, 5], memTotalGB: 64, memUsedGB: 4, loadAvg: null }) });
    const calls = { run: [], release: [] }, run = api.slotRun, rel = api.slotRelease;
    api.slotRun = (a, w, oc, mk) => {
        calls.run.push({ key: a.key, mk });
        return run(a, w, oc, mk);
    };
    api.slotRelease = (id) => {
        calls.release.push(id);
        rel(id);
    };
    api.boxOnline = () => api._noteLoad("box", { at: Date.now(), cpu: 5, cores: [5, 5, 5, 5], memTotalGB: 16, memUsedGB: 2, loadAvg: [0.1, 0.1, 0.1] });
    setShardApi(api);
    return { api, calls };
}

test("удалённое место: поезд бронирует машину очередью, проверки идут на ней (slotRun с её id), бронь снята", { skip: SKIP }, async () => {
    const { api, calls } = machines();
    api.boxOnline();
    freshTrain();
    const job = await startTrainRun(["s1"], "весь состав");
    await until(() => FINAL.includes(job.status), "конец поезда");
    assert.equal(job.status, "ok", logOf(job));
    assert.equal(job.runOn, "box");
    assert.deepEqual(calls.run, [{ key: "regress-train", mk: "box" }]);
    await until(() => calls.release.includes(job.id), "снятие брони", 5000);
    assert.equal(api.slotMachineOf(job.id), null);
    const runDir = REMOTE + "-wt/regress-train-p0";
    assert.ok(fs.existsSync(path.join(runDir, "lint.txt")) && fs.existsSync(path.join(runDir, "type.txt")), "гарды прошли на удалённой машине");
    assert.ok(fs.existsSync(path.join(runDir, "wave.txt")), "на машину доставлено дерево поезда: staging + ветка волны");
    assert.equal(fs.existsSync(path.join(REG_TRAIN_DIR, "lint.txt")), false, "здесь проверки не шли");
    assert.equal(fs.existsSync(path.join(REG_TRAIN_DIR, "prep.txt")), false, "здешняя подготовка не шла");
    assert.doesNotMatch(logOf(job), /службы этой машины/, "службы этой машины не нужны удалённому прогону");
    assert.equal(S.train.status, "green");
});

test("места нет — поезд ждёт с причиной и ничего не запускает; снятый из очереди места не берёт", { skip: SKIP }, async () => {
    const { api, calls } = machines();
    freshTrain();
    const job = await startTrainRun(["s1"], "весь состав");
    await sleep(300);
    assert.equal(job.status, "queued", logOf(job));
    assert.match(job.waitReason, /удалённые машины не на связи|ждёт место/);
    assert.equal(api.slotMachineOf(job.id), null, "брони нет");
    assert.deepEqual(calls.run, []);
    // снятие из очереди — как кнопка «Стоп»: из очереди дорожки вон, статус «снят»
    for (const q of Object.values(queues)) {
        const i = q.indexOf(job);
        if (i >= 0)
            q.splice(i, 1);
    }
    job.status = "cancelled";
    api.boxOnline();
    pumpAll();
    await sleep(300);
    assert.equal(job.status, "cancelled");
    assert.equal(api.slotMachineOf(job.id), null);
    assert.deepEqual(calls.run, []);
});

test("место — эта машина: после ожидания проверки идут здесь теми же шагами (подготовка, гарды, службы), slotRun не зовётся", { skip: SKIP }, async () => {
    const { api, calls } = machines();
    freshTrain();
    const job = await startTrainRun(["s1"], "весь состав");
    await sleep(300);
    assert.equal(job.status, "queued", "удалённая не на связи, эта машина ещё ждёт");
    job.queuedAt = Date.now() - SPILL_MS - 1000;
    pumpAll();
    await until(() => FINAL.includes(job.status), "конец поезда");
    assert.equal(job.status, "ok", logOf(job));
    assert.equal(job.runOn, "local");
    assert.deepEqual(calls.run, [], "удалённой доставки нет");
    await until(() => calls.release.includes(job.id), "снятие брони", 5000);
    assert.equal(api.slotMachineOf(job.id), null);
    for (const f of ["prep.txt", "lint.txt", "type.txt"])
        assert.ok(fs.existsSync(path.join(REG_TRAIN_DIR, f)), "здесь: " + f);
    const log = logOf(job);
    assert.match(log, /службы этой машины/);
    assert.ok(log.indexOf("службы этой машины") < log.indexOf("(подготовка папки поезда)"), "службы — до шагов");
    assert.equal(fs.readFileSync(path.join(MAIN, "svc.down"), "utf8").trim(), "d", "после прогона службы остановлены");
    assert.doesNotMatch(log, /на удалённой машине: гарды/);
    assert.equal(S.train.status, "green");
});

test("исключение — бронь снята: упал прогон на машине; упал сам прогон очереди — красный с причиной, а не необработанный отказ", { skip: SKIP }, async () => {
    const { api, calls } = machines();
    api.slotRun = async (a, w, oc, mk) => {
        calls.run.push({ key: a.key, mk });
        throw new Error("ssh оборвался");
    };
    api.boxOnline();
    freshTrain();
    const job = await startTrainRun(["s1"], "весь состав");
    await until(() => FINAL.includes(job.status) && calls.release.includes(job.id), "конец поезда и снятие брони");
    assert.equal(job.status, "fail");
    assert.match(logOf(job), /ssh оборвался/);
    assert.deepEqual(calls.run, [{ key: "regress-train", mk: "box" }]);
    assert.equal(api.slotMachineOf(job.id), null);

    const m2 = machines();
    freshTrain();
    const job2 = await startTrainRun(["s1"], "весь состав");
    await sleep(300);
    assert.equal(job2.status, "queued");
    job2.steps = { filter() {
            throw new Error("шаги испорчены");
        } };
    m2.api.boxOnline();
    pumpAll();
    await until(() => FINAL.includes(job2.status) && m2.calls.release.includes(job2.id), "конец прогона и снятие брони", 10000);
    assert.equal(job2.status, "fail");
    assert.match(job2.summary, /шаги испорчены/);
    assert.equal(m2.api.slotMachineOf(job2.id), null);
});
