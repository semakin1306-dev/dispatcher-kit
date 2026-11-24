// Защита от дублей прогонов (runner.liveTwin): тот же прогон в другой записи ввода, набор шире идущего, параллельные
// постановки одного прогона — одна задача в очереди.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-dedup-"));
process.env.DASH_DATA = TMP;
process.env.DASH_DRY = "1";
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
const { liveTwin } = await import("./runner.mjs");
const { loadJobs } = await import("./jobs.mjs");
const SLOT = "wv0001-a";
const J = (id, task, input, status = "queued", o = {}) => ({ id, tree: SLOT, task, input, status, ...o });

test("тот же набор спек в другой записи (порядок, «|» вместо «,») — живой близнец; набор шире — тоже; законченный — нет", () => {
    loadJobs([J("j1", "api-test", "wv-0001|wv-0002|wv-0003")]);
    assert.equal(liveTwin(SLOT, "api-test", "wv-0003,wv-0001").id, "j1", "уже покрыт идущим набором");
    assert.equal(liveTwin(SLOT, "api-test", "wv-0002,wv-0003,wv-0001").id, "j1");
    assert.equal(liveTwin(SLOT, "api-test", "wv-0099"), null);
    loadJobs([J("j2", "api-test", "wv-0003", "fail")]);
    assert.equal(liveTwin(SLOT, "api-test", "wv-0003"), null);
});

test("другой слот, другая задача, конвейер, коммит — не близнецы", () => {
    loadJobs([J("j3", "lint", "", "running"), J("j4", "commit", "", "queued")]);
    assert.equal(liveTwin(SLOT, "lint", "").id, "j3");
    assert.equal(liveTwin("wv0002-b", "lint", ""), null);
    assert.equal(liveTwin(SLOT, "typecheck", ""), null);
    assert.equal(liveTwin(SLOT, "lint", "", { pipeline: true }), null);
    assert.equal(liveTwin(SLOT, "commit", ""), null, "коммиты не сводятся: каждый — своё сообщение");
});

test("два одновременных enqueue одного прогона (повторы после обрыва) — одна задача в очереди", async () => {
    const { enqueue, queues } = await import("./runner.mjs");
    loadJobs([]);
    for (const q of Object.values(queues))
        q.length = 0;
    const a = { treeKey: "orchestrator-staging", cwd: process.cwd(), label: "x", taskId: "api-test", input: "wv-0001", lane: "db", steps: [{ show: "x", cmd: "node", args: ["-v"], cwd: process.cwd() }], extra: { requeuedFrom: "j1" } };
    const [j1, j2] = await Promise.all([enqueue(a), enqueue({ ...a, extra: { requeuedFrom: "j2" } })]);
    assert.equal(j1.id, j2.id);
});
