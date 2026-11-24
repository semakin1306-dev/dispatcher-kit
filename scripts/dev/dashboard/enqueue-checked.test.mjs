import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-gate-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
process.env.DASH_DATA = TMP;
process.env.DASH_DRY = "1";
const { enqueueChecked, holdOk, queues } = await import("./runner.mjs");
const { loadJobs } = await import("./jobs.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = () => ({ treeKey: "orchestrator-staging", cwd: process.cwd(), label: "Влить X в staging", taskId: "merge", lane: "ops", steps: [{ show: "git merge", cmd: "git", args: ["--version"], cwd: process.cwd() }], extra: { pipeline: true } });

test("задача в очереди сразу и держится «проверяю условия»; проверка прошла — удержание снято, метка и добавки применены", async () => {
    loadJobs([]);
    let release;
    const gate = new Promise((r) => (release = r));
    const job = await enqueueChecked(args(), () => gate);
    assert.equal(job.status, "queued");
    assert.ok(queues.ops.includes(job));
    assert.equal(holdOk(job), false);
    assert.match(job.waitReason, /проверяю условия/);
    release({ ok: true, label: "Влить X в staging (всё равно: снято — review)", extra: { forced: ["ревью"] } });
    await sleep(20);
    assert.equal(job.gate, "ok");
    assert.equal(holdOk(job), true);
    assert.equal(job.label, "Влить X в staging (всё равно: снято — review)");
    assert.deepEqual(job.forced, ["ревью"]);
});

test("проверка не прошла — задача сходит с очереди и падает с причиной", async () => {
    loadJobs([]);
    queues.ops.length = 0;
    const job = await enqueueChecked(args(), async () => ({ ok: false, why: "сначала влита П7" }));
    await sleep(20);
    assert.equal(job.status, "fail");
    assert.equal(job.gateFailed, true);
    assert.match(job.summary, /Не запущено: сначала влита П7/);
    assert.ok(!queues.ops.includes(job));
});

test("сбой самой проверки (исключение) — тоже падение с причиной, а не вечное ожидание", async () => {
    loadJobs([]);
    queues.ops.length = 0;
    const job = await enqueueChecked(args(), async () => {
        throw new Error("git не ответил");
    });
    await sleep(20);
    assert.equal(job.status, "fail");
    assert.match(job.summary, /git не ответил/);
});
