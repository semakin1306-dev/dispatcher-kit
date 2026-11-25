import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-prov-"));
process.env.DASH_DATA = path.join(TMP, "data");
process.env.DASH_DRY = "1";
process.env.DISPATCHER_WT = path.join(TMP, "wt");
fs.mkdirSync(process.env.DASH_DATA, { recursive: true });
fs.mkdirSync(path.join(TMP, "wt", "wvhave", ".git"), { recursive: true });
const { provide } = await import("./late.mjs");
const { S } = await import("./state.mjs");
const { addJob, jobList, loadJobs } = await import("./jobs.mjs");
const E = await import("./epics.mjs");
after(async () => {
    const st = await import("./store.mjs");
    await st.settled();
    st.flushSync();
    await st.settled();
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
let calls = [];

provide({ "runner.mjs": { enqueue: async (o) => {
            calls.push(o);
            await new Promise((r) => setTimeout(r, 30));
            const j = { id: "j" + (900 + calls.length), tree: o.treeKey, task: o.taskId, status: "queued", steps: o.steps };
            addJob(j);
            return j;
        } } });

const slot = (s) => ({ slot: s, tag: "П" + s.length, branch: "dev/" + s });

describe("enqueueProvision — замок на слот", () => {
    test("два одновременных вызова — одна постановка, один и тот же прогон", async () => {
        loadJobs([]);
        calls = [];
        const x = slot("wvnew"), [a, b] = await Promise.all([E.enqueueProvision(x), E.enqueueProvision(x)]);
        assert.equal(calls.length, 1);
        assert.equal(a, b);
    });
    test("подготовка уже в очереди — новый вызов отдаёт её, а не ставит вторую", async () => {
        calls = [];
        const r = await E.enqueueProvision(slot("wvnew"));
        assert.equal(calls.length, 0);
        assert.equal(r.id, jobList()[0].id);
    });
    test("разные слоты не ждут друг друга", async () => {
        loadJobs([]);
        calls = [];
        await Promise.all([E.enqueueProvision(slot("wva")), E.enqueueProvision(slot("wvb"))]);
        assert.equal(calls.length, 2);
    });
});

describe("provisionPlan — что поднимет provisionMissing", () => {
    const setEpic = (slots) => {
        S.EPICS = [{ id: "e1", slots }];
    };
    test("папка есть, подготовку оборвал перезапуск — повтор с --reuse", async () => {
        setEpic([slot("wvhave")]);
        loadJobs([{ id: "j1", task: "slot-up", tree: "wvhave", status: "interrupted", bootInterrupted: true, endedAt: Date.now() }]);
        const plan = E.provisionPlan();
        assert.equal(plan.length, 1);
        assert.equal(plan[0].x.slot, "wvhave");
        assert.equal(plan[0].d.reuse, true);
        calls = [];
        await E.enqueueProvision(plan[0].x);
        assert.ok(calls[0].steps[0].args.includes("--reuse"));
    });
    test("готовится перезапуск — план пуст", () => {
        setEpic([slot("wvnone")]);
        loadJobs([]);
        E.setDrain({ since: Date.now(), by: "test" });
        try {
            assert.deepEqual(E.provisionPlan(), []);
        }
        finally {
            E.setDrain(null);
        }
        assert.equal(E.provisionPlan().length, 1);
    });
    test("папка есть и подготовок не было — не трогаем", () => {
        setEpic([slot("wvhave")]);
        loadJobs([]);
        assert.deepEqual(E.provisionPlan(), []);
    });
});
