// Экран прогонов на удалённой машине (laptop-view-rules.mjs): состояние, заголовок, доля в полном прогоне, очередь.
//   node --test scripts/dev/dashboard/laptop-view-rules.test.mjs
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cleanLabel, fullRunOf, laptopView, machineOf, queueOf } from "./laptop-view-rules.mjs";

const NOW = 1_000_000;
const LD = { at: NOW - 1000, cpu: 37.4, cores: [30, 40], memTotalGB: 14, memUsedGB: 3.26, swapTotalGB: 4, swapUsedGB: 0, loadAvg: [0.5, 0.4, 0.3] };
const SHARD = (extra = {}) => ({ machines: [{ id: "lap", label: "Ноутбук", online: true, ld: LD, health: null }, { id: "local", label: "Эта машина", online: true, ld: LD }], run: null, ...extra });

describe("cleanLabel", () => {
    test("срезает только хвост с подписью машины", () => {
        assert.equal(cleanLabel("Бэкенд: jest · Ноутбук", ["Ноутбук"]), "Бэкенд: jest");
        assert.equal(cleanLabel("Тесты · полный прогон", ["Ноутбук"]), "Тесты · полный прогон");
    });
});

describe("machineOf", () => {
    test("онлайн с замером — цифры и нагрузка; без замера — не на связи", () => {
        const m = machineOf(SHARD().machines[0]);
        assert.deepEqual([m.online, m.cpu, m.memUsedGB, m.memFreeGB, m.heat], [true, 37, 3.3, 10.7, ""]);
        assert.equal(machineOf({ id: "lap", online: false }).online, false);
        assert.equal(machineOf(null).online, false);
    });
});

describe("fullRunOf / queueOf", () => {
    test("доля машины в полном прогоне: свои части, текущая, провалы; не идёт — null", () => {
        const parts = [
            { id: "a", status: "ok", machine: "lap" }, { id: "b", status: "running", machine: "lap", tail: ["x"] },
            { id: "c", status: "fail", machine: "lap" }, { id: "d", status: "queued", machine: null },
        ];
        const run = { status: "running", sha: "abcdef123456789", subject: "s", startedAt: NOW - 60000, ok: 1, fail: 1, running: 1, total: 4, parts };
        const f = fullRunOf(run, "lap", NOW);
        assert.deepEqual([f.sha, f.current, f.partsDone, f.partsFail, f.partsTotal, f.elapsedS], ["abcdef1234", "b", 2, 1, 3, 60]);
        assert.equal(fullRunOf({ ...run, status: "done" }, "lap", NOW), null);
    });
    test("очередь: ждущие и идущие на других машинах", () => {
        const jobs = [
            { id: "j1", status: "queued", tree: "orchestrator-staging", label: "A", queuedAt: NOW - 5000 },
            { id: "j2", status: "running", runOn: "local", tree: "t", label: "B" }, { id: "j3", status: "running", runOn: "lap", tree: "t", label: "C" },
        ];
        const q = queueOf(jobs, "lap", NOW, (id) => (id === "local" ? "Эта машина" : id));
        assert.deepEqual(q.waiting.map((x) => [x.id, x.tag, x.ageS]), [["j1", "staging", 5]]);
        assert.deepEqual(q.elsewhere.map((x) => [x.id, x.machine]), [["j2", "Эта машина"]]);
    });
});

describe("laptopView", () => {
    test("занята своим прогоном — busy и заголовок; последние — свои законченные", () => {
        const jobs = [{ id: "j1", status: "running", runOn: "lap", tree: "wv1", task: "parts", label: "Тесты · Ноутбук", input: "be-int-x", startedAt: NOW - 10000 },
            { id: "j0", status: "ok", runOn: "lap", tree: "wv1", task: "parts", label: "Тесты", startedAt: NOW - 90000, endedAt: NOW - 30000, summary: "ок" },
            { id: "j5", status: "ok", runOn: "local", tree: "wv1", task: "parts", label: "чужой", endedAt: NOW - 1000 }];
        const v = laptopView({ machine: "lap", jobs, shard: SHARD(), now: NOW });
        assert.equal(v.state, "busy");
        assert.match(v.headline, /wv1 · Тесты · be-int-x/);
        assert.deepEqual(v.recent.map((r) => r.id), ["j0"]);
        assert.deepEqual([v.day.ok, v.day.busyS], [1, 60]);
    });
    test("без замеров — offline; свободна — idle с подсказкой про очередь", () => {
        assert.equal(laptopView({ machine: "lap", jobs: [], shard: { machines: [{ id: "lap", online: false }] }, now: NOW }).state, "offline");
        const v = laptopView({ machine: "lap", jobs: [{ id: "q", status: "queued", tree: "t", label: "x" }], shard: SHARD(), now: NOW });
        assert.equal(v.state, "idle");
        assert.match(v.headline, /в очереди 1/);
    });
});
