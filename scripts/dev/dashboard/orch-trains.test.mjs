import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-orch-trains-"));
process.env.DASH_DATA = path.join(TMP, "data");
process.env.DASH_DRY = "1";
process.env.DISPATCHER_WT = path.join(TMP, "wt");
process.env.DASH_EPIC_FILE = path.join(TMP, "epics.json");
process.env.DASH_ORCH_STEP_MS = "200";
fs.mkdirSync(process.env.DASH_DATA, { recursive: true });
fs.mkdirSync(path.join(TMP, "orch", ".git"), { recursive: true });
fs.mkdirSync(path.join(TMP, "wt", "tr-orgs-e1", ".git"), { recursive: true });
const TR = { slot: "tr-orgs-e1", tag: "Т1", kind: "train", trainArea: "api", branch: "dev/tr-orgs-e1", title: "API: организации", wagons: [{ wave: "WV-0901", title: "а" }, { wave: "WV-0902", title: "б" }] };
fs.writeFileSync(process.env.DASH_EPIC_FILE, JSON.stringify({ active: "e1", epics: [{ id: "e1", title: "т", status: "open", orch: { path: path.join(TMP, "orch"), branch: "orch/e1" }, slots: [TR] }] }));
await import("./wiring.mjs");
const { S } = await import("./state.mjs");
const { applyEpics } = await import("./trees.mjs");
const { loadInbox } = await import("./inbox.mjs");
const R = await import("./relay.mjs");
const { loadSessions } = await import("./agents.mjs");
const { loadJobs } = await import("./jobs.mjs");
const { loadTrains, trainOf } = await import("./trains.mjs");
const { recipe } = await import("./pipeline.mjs");
const { turnAct } = await import("./epic-progress-rules.mjs");
after(async () => { const st = await import("./store.mjs"); await st.settled(); st.flushSync(); await st.settled(); fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
applyEpics();
loadInbox();
loadSessions();
loadJobs([]);
R.loadRelaySent();
R.loadTestReqs();
loadTrains();
const ORCH = "orchestrator@e1";
const orchAgent = (ownerText) => ({ key: ORCH, items: [{ id: "u1", t: "user", owner: true, text: ownerText, at: Date.now() }], rev: 1 });

const snapTree = (over = {}) => ({ key: TR.slot, tag: "Т1", train: true, exists: true, path: path.join(TMP, "wt", TR.slot), head: "WV-0901", current: "WV-0901", issued: "WV-0901", wagon: "WV-0901", ahead: 2, dirtyTracked: 0, dirtyUntracked: 0,
    wagons: [{ wave: "WV-0901", state: "work", commits: 2, waitFor: [] }, { wave: "WV-0902", state: "depot", commits: 0, waitFor: [] }], ...over });

let sends = [], real = null;

beforeEach(() => {
    sends = [];
    R.orchFailSeen.clear();
    real = real || { ...R._orchSteps };
    Object.assign(R._orchSteps, real, { send: (key, text) => sends.push({ key, text }) });
});

test("строки «ОТПРАВИТЬ ТN» нет — составов нет, строка ничего не делает и ходом не считается", async () => {
    S.snap = { trees: [snapTree()] };
    const a = orchAgent("как там дела?"), n0 = a.items.length;
    await R.orchGitCommands(a, "Готово.\nОТПРАВИТЬ Т1", "msg_d1");
    assert.equal(a.items.length, n0, "ни ответа, ни отказа");
    assert.equal(sends.length, 0);
    assert.equal("ORCH_DEPART_RE" in R, false);
    assert.equal(turnAct("ОТПРАВИТЬ Т1"), false);
    assert.equal(turnAct("ВЛИТЬ Т1"), true);
});

test("ВЛИТЬ Т1 — как у слота: только по слову владельца", async () => {
    let pre = 0;
    R._orchSteps.preflight = async () => {
        pre++;
        return { checks: [{ id: "regress", ok: false, text: "регресс по тронутым путям пройден" }], trees: [] };
    };
    const a = orchAgent("как там?");
    await R.orchGitCommands(a, "ВЛИТЬ Т1", "msg_m1");
    assert.equal(pre, 0);
    assert.match(a.items.at(-1).text, /нет слова «влей»/);
    await R.orchGitCommands(orchAgent("влей поезд"), "ВЛИТЬ Т1", "msg_m2");
    assert.equal(pre, 1, "по слову — проверка влива поезда, как у слота");
});

test("подпись влива поезда: ветка, место вагона в очереди и его номер; следующий вагон — следующий номер; слот без поезда — как раньше", async () => {
    S.snap = { trees: [snapTree()] };
    const r = recipe("merge", { slotKey: TR.slot, branch: TR.branch });
    assert.deepEqual(r.steps[0].args, ["merge", "--no-ff", TR.branch, "-m", "merge: dev/tr-orgs-e1 — поезд Т1#1: WV-0901"]);
    S.snap = { trees: [snapTree({ head: "WV-0902", current: "WV-0902", issued: "WV-0902", wagon: "WV-0902", ahead: 1, wagons: [{ wave: "WV-0901", state: "staging", commits: 0, waitFor: [] }, { wave: "WV-0902", state: "work", commits: 1, waitFor: [] }] })] };
    assert.deepEqual(recipe("merge", { slotKey: TR.slot, branch: TR.branch }).steps[0].args, ["merge", "--no-ff", TR.branch, "-m", "merge: dev/tr-orgs-e1 — поезд Т1#2: WV-0902"]);
    assert.deepEqual(recipe("merge", { slotKey: "wv-нет", branch: "dev/wv-0001-x" }).steps[0].args, ["merge", "--no-ff", "dev/wv-0001-x", "-m", "merge: dev/wv-0001-x"]);
    assert.deepEqual(trainOf(TR.slot), {}, "в записи поезда составов нет");
    S.snap = null;
});
