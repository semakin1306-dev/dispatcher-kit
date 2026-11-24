// Места прогонов: что задача просит от машины (placeOpts), выбор места по машинам (slot-places.pickPlace), очередь
// для страницы машин (queueView), причина ожидания (serverWait), перегрузка машины (strain). Демо-проект: удалённых
// машин нет, дорожки api-test — db, остальных — main.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-places-"));
process.env.DASH_DATA = TMP;
process.env.DASH_DRY = "1";
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
const { placeOpts, queueView, REMOTE_TASKS, serverWait, remoteOn } = await import("./runner.mjs");
const { addJob, loadJobs } = await import("./jobs.mjs");
const { setShardApi } = await import("./shard.mjs");
const { pickPlace, profilesOf, strain, SPILL_MS } = await import("./slot-places.mjs");

test("задачи конфига — задачи мест; тяжёлые — задачи областей со сборкой", () => {
    assert.deepEqual(Object.keys(REMOTE_TASKS).sort(), ["api-test", "lint", "typecheck", "web-test"]);
    assert.equal(REMOTE_TASKS["api-test"].kind, "db", "дорожка задачи из конфига");
    assert.equal(REMOTE_TASKS["web-test"].kind, "main", "дорожка по умолчанию");
    const q = Date.now() - 90000;
    const api = placeOpts({ task: "api-test", queuedAt: q }), web = placeOpts({ task: "web-test", queuedAt: q });
    assert.equal(api.heavy, true, "область api со сборкой");
    assert.equal(web.heavy, false);
    assert.ok(web.ageMs >= 90000 && web.ageMs < 95000);
    assert.equal(web.only, null);
    assert.deepEqual(web.needs, []);
});

const NOW = Date.now(), ld = (o = {}) => ({ at: NOW - 2000, cpu: 15, memTotalGB: 15, memUsedGB: 4, ...o });
const M = (o = {}) => ({ online: true, off: false, ld: ld(), reserved: [], caps: {}, ...o });
const P = profilesOf({ build: { ssh: "build", dir: "~/w", workers: 2, lanes: ["db"] }, local: { workers: 2 } });

test("профили мест из конфига: удалённые машины первыми, эта — последней и только после ожидания", () => {
    assert.deepEqual(P.tiers, ["build", "local"]);
    assert.deepEqual(P.profiles.build.places, [0, 1]);
    assert.equal(P.profiles.local.spillMs, SPILL_MS);
    assert.equal(profilesOf({ local: { workers: 1 } }).profiles.local.spillMs, 0, "удалённых нет — эта машина не ждёт");
});

test("выбор места: удалённая машина, если на связи и обслуживает дорожку; иначе эта — после ожидания", () => {
    const ctx = (kind, machines, ageMs = 0) => ({ now: NOW, jobAgeMs: ageMs, heavy: false, machines, ...P });
    assert.deepEqual(pickPlace("db", ctx("db", { build: M(), local: M() })), { mk: "build", idx: 0 });
    assert.equal(pickPlace("main", ctx("main", { build: M(), local: M() })), null, "дорожку main удалённая не берёт, а эта ещё ждёт");
    assert.equal(pickPlace("main", ctx("main", { build: M(), local: M() }, SPILL_MS + 1000)).mk, "local");
    assert.equal(pickPlace("db", ctx("db", { build: M({ online: false }), local: M() }, SPILL_MS + 1000)).mk, "local", "удалённая не на связи");
    assert.equal(pickPlace("db", ctx("db", { build: M({ ld: ld({ at: NOW - 60000 }) }), local: M() })), null, "проба удалённой устарела, эта ещё ждёт");
    assert.equal(pickPlace("db", { ...ctx("db", { build: M({ reserved: [{ idx: 0, at: NOW - 60000 }] }), local: M() }) }).idx, 1, "место 0 занято — берётся 1");
});

test("тяжёлая задача: машина с caps.heavy=false её не берёт; первой брони нужно свободной памяти с запасом", () => {
    const ctx = (machines) => ({ now: NOW, jobAgeMs: SPILL_MS + 1000, heavy: true, machines, ...P });
    assert.equal(pickPlace("db", ctx({ build: M({ caps: { heavy: false } }), local: M({ ld: ld({ memTotalGB: 32, memUsedGB: 4 }) }) })).mk, "local");
    assert.equal(pickPlace("db", ctx({ build: M({ caps: { heavy: false } }), local: M({ ld: ld({ memTotalGB: 8, memUsedGB: 3 }) }) })), null, "на этой свободно 5 ГБ < 4 + 2 для тяжёлой");
});

test("очередь для страницы машин: только задачи проекта, идущие — первыми, у идущих машина, у ждущих причина", () => {
    loadJobs([]);
    setShardApi({ machineLabel: (m) => ({ build: "машина сборки" })[m] || m });
    const t = Date.now();
    addJob({ id: "j1", tree: "wvA", task: "api-test", label: "API: тесты · машина сборки", input: "wv-0001", status: "running", runOn: "build", startedAt: t - 60000, queuedAt: t - 90000 });
    addJob({ id: "j2", tree: "wvB", task: "web-test", label: "Витрина: тесты", status: "queued", queuedAt: t - 30000, waitReason: "ждёт место: удалённые машины → эта" });
    addJob({ id: "j3", tree: "wvC", task: "lint", label: "Линтер", status: "running", runOn: "local", startedAt: t - 10000 });
    addJob({ id: "j4", tree: "wvD", task: "merge", label: "Влив", status: "running", startedAt: t });
    addJob({ id: "j5", tree: "wvE", task: "web-test", label: "Старый", status: "ok", runOn: "build", startedAt: t - 9e6 });
    const q = queueView();
    assert.deepEqual(q.map((x) => x.id), ["j1", "j3", "j2"], "влив и законченное не показываются; идущие раньше ждущих");
    assert.equal(q[0].mLabel, "машина сборки");
    assert.equal(q[0].machine, "build");
    assert.equal(q[0].label, "API: тесты", "суффикс машины снят — она отдельным значком");
    assert.equal(q[1].machine, "local");
    assert.equal(q[1].mLabel, "Эта машина");
    assert.equal(q[2].status, "queued");
    assert.match(q[2].wait, /удалённые машины → эта/);
    assert.equal(q[2].machine, null);
    setShardApi();
});

test("без удалённых машин причины ожидания места нет: задачи идут здесь", () => {
    assert.equal(remoteOn(), false, "в демо-проекте машин с ssh нет");
    assert.equal(serverWait({ task: "api-test", lane: "db", tree: "orchestrator-staging" }), "");
    assert.equal(serverWait({ task: "merge", lane: "ops", tree: "orchestrator-staging" }), "");
});

test("перегрузка машины — своп и средняя нагрузка: мягкая — без мест сверх базовых, жёсткая — никаких", () => {
    const cores = Array(12).fill(5);
    assert.equal(strain({ swapTotalGB: 4, swapUsedGB: 3.25, cores, loadAvg: [45] }), "hard", "своп 81 %, нагрузка 45 на 12 ядер");
    assert.equal(strain({ swapTotalGB: 4, swapUsedGB: 2.6, cores, loadAvg: [4], swapIOps: 300 }), "soft", "идёт обмен");
    assert.equal(strain({ swapTotalGB: 4, swapUsedGB: 2.6, cores, loadAvg: [4], swapIOps: 1500 }), "hard", "сильный обмен");
    assert.equal(strain({ swapTotalGB: 4, swapUsedGB: 3.1, cores, loadAvg: [0.4], memTotalGB: 15.5, memUsedGB: 3.5, swapIOps: 0 }), "", "своп занят старыми страницами, памяти много, обмена нет — не перегрузка");
    assert.equal(strain({ swapTotalGB: 4, swapUsedGB: 3.1, cores, loadAvg: [2], memTotalGB: 15.5, memUsedGB: 13 }), "soft", "своп занят и свободно 2,5 ГБ");
    assert.equal(strain({ swapTotalGB: 4, swapUsedGB: 3.1, cores, loadAvg: [2], memTotalGB: 15.5, memUsedGB: 14.5 }), "hard", "своп занят и свободно 1 ГБ");
    assert.equal(strain({ swapTotalGB: 4, swapUsedGB: 0.2, cores, loadAvg: [20] }), "soft");
    assert.equal(strain({ swapTotalGB: 4, swapUsedGB: 0.2, cores, loadAvg: [3] }), "");
    assert.equal(strain(null), "");
});
