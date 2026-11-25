import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-deadlock-"));
process.env.DASH_DATA = path.join(TMP, "data");
process.env.DASH_DRY = "1";
process.env.DISPATCHER_WT = path.join(TMP, "wt");
process.env.DASH_EPIC_FILE = path.join(TMP, "epics.json");
process.env.DASH_ORCH_STEP_MS = "200";
fs.mkdirSync(process.env.DASH_DATA, { recursive: true });
fs.mkdirSync(path.join(TMP, "orch", ".git"), { recursive: true });
fs.mkdirSync(path.join(TMP, "wt", "wv9004-a", ".git"), { recursive: true });
fs.writeFileSync(
    process.env.DASH_EPIC_FILE,
    JSON.stringify({
        active: "e1",
        epics: [
            {
                id: "e1",
                title: "т",
                status: "open",
                orch: { path: path.join(TMP, "orch"), branch: "orch/e1" },
                slots: [{ slot: "wv9004-a", tag: "П4", branch: "dev/wv-9004", title: "а" }],
            },
        ],
    }),
);
await import("./wiring.mjs");
const D = await import("./deadlock.mjs");
const { applyEpics } = await import("./trees.mjs");
const { loadInbox, inboxCards } = await import("./inbox.mjs");
const R = await import("./relay.mjs");
const A = await import("./agents.mjs");
const L = await import("./orchlog.mjs");
const { loadJobs } = await import("./jobs.mjs");
after(async () => {
    const st = await import("./store.mjs");
    await st.settled();
    st.flushSync();
    await st.settled();
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
applyEpics();
loadInbox();
A.loadSessions();
loadJobs([]);
R.loadRelaySent();
R.loadTestReqs();
L.loadOrchLog();
const ORCH = "orchestrator@e1";
let sends = [], real = null;

beforeEach(() => {
    sends = [];
    R.orchFailSeen.clear();
    real = real || { ...R._orchSteps };
    Object.assign(R._orchSteps, real, { send: (key, text) => sends.push({ key, text }) });
});

test("А5: счёт — та же причина подряд; другая причина или код — с нуля; тревога один раз", () => {
    const m = new Map();
    assert.deepEqual([1, 2].map(() => D.streakNote(m, "s", "fp1|x").fire), [false, false]);
    assert.equal(D.streakNote(m, "s", "fp1|x").fire, true, "третий подряд — тревога");
    assert.equal(D.streakNote(m, "s", "fp1|x").fire, false, "дальше молчим");
    assert.equal(D.streakNote(m, "s", "fp2|x").n, 1, "код сменился — с нуля");
    D.streakNote(m, "s", "fp2|x");
    D.streakClear(m, "s");
    assert.equal(D.streakNote(m, "s", "fp2|x").n, 1, "исполнилось — с нуля");
    assert.equal(D.normWhy("зелёный на этом же коде (j2380)"), D.normWhy("зелёный на этом же коде (j2391)"), "номер запуска не делает причину новой");
});

test("А5: ворота трижды не пустили ПРОГНАТЬ оркестратора — оркестратору «правила противоречат», карточка, на третий раз", () => {
    const ask = {
        tree: "wv9004-a",
        task: "api-test",
        input: "wv-0999",
        by: "просьба оркестратора",
        fp: "fp1",
        why: "волна закоммичена, код с коммита не менялся — проверять дальше будет поезд влива (j1)",
    };
    R.gateFeedback(ask);
    R.gateFeedback({ ...ask, why: ask.why.replace("j1", "j2") });
    assert.ok(!sends.some((s) => /Правила противоречат/.test(s.text)), "два раза — ещё не тупик");
    R.gateFeedback({ ...ask, why: ask.why.replace("j1", "j3") });
    const alarm = sends.filter((s) => /Правила противоречат/.test(s.text));
    assert.equal(alarm.length, 1);
    assert.equal(alarm[0].key, ORCH);
    assert.match(alarm[0].text, /прогон api-test=wv-0999 у П4/);
    assert.match(alarm[0].text, /3 раза подряд/);
    assert.match(alarm[0].text, /поезд влива/);
    const cards = inboxCards().filter((c) => c.kind === "deadlock");
    assert.equal(cards.length, 1);
    assert.equal(cards[0].tree, "wv9004-a");
    assert.equal(cards[0].to, ORCH);
    R.gateFeedback(ask);
    assert.equal(sends.filter((s) => /Правила противоречат/.test(s.text)).length, 1, "четвёртый — без повтора тревоги");
    R.deadlockClear(R.gateScope("wv9004-a", "api-test", "wv-0999"));
    assert.equal(inboxCards().filter((c) => c.kind === "deadlock").length, 0, "прогон встал — карточка снята");
});

test("А5: автопоезд и «уже в очереди» — не тупик", () => {
    const ask = { tree: "wv9004-a", task: "web-test", input: "wv-1", fp: "f", why: "зелёный на этом же коде" };
    for (let i = 0; i < 4; i++)
        R.gateFeedback({ ...ask, by: "автопоезд" });
    for (let i = 0; i < 4; i++)
        R.gateFeedback({ ...ask, by: "просьба оркестратора", why: "уже в очереди (j4)" });
    assert.ok(!sends.some((s) => /Правила противоречат/.test(s.text)));
});

test("А5: ВЛИТЬ трижды с той же причиной — тупик; исполнилось — счёт с нуля", async () => {
    R._orchSteps.preflight = async () => ({ checks: [{ id: "conflict", ok: false, text: "ветка вливается в staging без конфликтов", detail: "конфликтуют со staging (1): a.ts" }], trees: [] });
    const orch = (t) => ({ key: ORCH, items: [{ id: "u", t: "user", owner: true, text: t, at: Date.now() }], rev: 1 });
    for (let i = 1; i <= 3; i++)
        await R.orchGitCommands(orch("влей П4"), "ВЛИТЬ П4", "msg_d" + i);
    const alarm = sends.filter((s) => /Правила противоречат/.test(s.text));
    assert.equal(alarm.length, 1);
    assert.match(alarm[0].text, /«ВЛИТЬ П4» отклонено 3 раза/);
    assert.match(alarm[0].text, /конфликт/);
    R.cmdDeadlock(ORCH, "ВЛИТЬ П4", "вливаю", true);
    assert.ok(!inboxCards().some((c) => c.kind === "deadlock" && c.scope === "cmd|" + ORCH + "|ВЛИТЬ П4"));
});
