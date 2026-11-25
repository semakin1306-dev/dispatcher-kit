// Вид поезда (view.mjs wagonsView): вагоны, станция вагона на линии поезда, «Дальше» между вагонами.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-view-tr-"));
process.env.DASH_DATA = TMP;
process.env.DASH_DRY = "1";
const { S } = await import("./state.mjs");
const { settings } = await import("./config.mjs");
// «ГОТОВО» по вагону ждётся в режиме самокоммита по станциям (при коммитах по слову конец волны — сам коммит)
settings.selfCommit = "station";
// весь конвейер станций: модули ревью, выката и приёмки включены (в демо-конфиге выкат и приёмка выключены)
(await import("./modules.mjs")).setModuleStates({ review: true, release: true, accept: true });
const { stagesOf } = await import("./stations.mjs");
const { farOf, nextStep, slotGroup, stagesView, wagonsView } = await import("./view.mjs");
after(async () => {
    const st = await import("./store.mjs");
    await st.settled(); st.flushSync(); await st.settled();
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(() => {
    S.jobs = [];
    S.snap = { trees: [], orderHints: [] };
    S.train = null;
    S.specHist = {};
    S.agentSessions = {};
});

const TIMES = { issuedAt: 1, firstCommitAt: 2, doneAt: 0, doneSha: "", mergedAt: 0, mergeSha: "" };

const W = [{ wave: "WV-0001", title: "а", state: "staging", times: { ...TIMES, mergedAt: 3, mergeSha: "m1" } }, { wave: "WV-0002", title: "б", state: "work", commits: 2, times: TIMES },
    { wave: "WV-0003", title: "в", state: "depot" }, { wave: "WV-0004", title: "г", state: "depot" }];

const tree = (o = {}) => ({
    key: "tr-orgs-e",
    kind: "slot",
    tag: "Т1",
    train: true,
    branch: "dev/tr-orgs-e",
    exists: true,
    ahead: 2,
    behind: 0,
    dirtyTracked: 0,
    dirtyUntracked: 0,
    hasCode: true,
    fp: "f",
    deps: [],
    conflict: [],
    regress: [],
    verdict: { tests: "green", build: "notneeded", guards: "none", regress: "none" },
    review: null,
    wagons: W,
    head: "WV-0002",
    current: "WV-0002",
    issued: "WV-0002",
    wagon: "WV-0002",
    ...o,
});

const AUTO = { plan: "план", impl: "коммитов 2", build: "не нужна", tests: "зелёные" };

const view = (t, auto) => {
    t.stages = stagesOf(t, auto, {});
    const st = stagesView(t, null), far = farOf(st, t, null);
    return { st, far, next: nextStep(t, st, null, far), wagons: wagonsView(t, st, far) };
};

test("вагон в работе: его станция — текущая станция линии поезда, тон «в работе»; за ним — очередь; влитый — «В staging»", () => {
    const v = view(tree({ dirtyTracked: 3 }), AUTO);
    const cur = v.st[v.far + 1];
    assert.equal(cur.id, "guards");
    assert.deepEqual(v.wagons.map((w) => w.wave + ":" + w.tone + ":" + w.label), ["WV-0001:done:В staging", "WV-0002:work:" + cur.label, "WV-0003:depot:в очереди", "WV-0004:depot:в очереди"]);
    assert.equal(v.next.act, "guards");
});

test("вагон закоммичен и проверен: тон «на проверках / ждёт влива», «Дальше» — влив, как у слота; группа «нужен ты»", () => {
    const CHECKED = { ...AUTO, guards: "зелёные", review: "ЗА", regress: "зелёный", commit: "коммитов впереди staging: 2, дерево чистое" };
    const done = [W[0], { ...W[1], times: { ...TIMES, doneAt: 5 } }, W[2], W[3]];
    const t = tree({ wagons: done });
    const v = view(t, CHECKED);
    assert.deepEqual([v.wagons[1].tone, v.wagons[1].label], ["check", "ждёт влива"]);
    assert.equal(v.next.act, "merge");
    assert.equal(slotGroup(t, null, v.next, { inbox: [], reqs: [] }), "need");
    const u = view(tree(), CHECKED);
    assert.equal(u.next.act, undefined);
    assert.match(u.next.text, /не доложил «ГОТОВО» по вагону WV-0002/);
    const r = view(tree(), { ...AUTO, guards: "зелёные" });
    assert.deepEqual([r.wagons[1].tone, r.wagons[1].label], ["check", "Ревью"], "закоммичен, идут проверки");
});

test("между вагонами: вагон влит, следующий — голова очереди, ещё не выдан: «Дальше» — «Запустить вагон», поезд не «влит»", () => {
    const ws = [W[0], { ...W[1], state: "staging", commits: 0 }, { ...W[2], state: "work" }, W[3]];
    const t = tree({
        ahead: 0,
        hasCode: false,
        wagons: ws,
        head: "WV-0003",
        current: "WV-0003",
        issued: "WV-0002",
        wagon: "WV-0002",
        verdict: { tests: "green", build: "notneeded", guards: "green", regress: "green", merged: true },
    });
    const v = view(t, { ...AUTO, guards: "g", review: "r", regress: "r", commit: "c", staging: "влито: abc" });
    assert.equal(v.next.act, "train-wagon");
    assert.match(v.next.text, /Следующий вагон WV-0003/);
    assert.deepEqual(v.wagons.map((w) => w.tone), ["done", "done", "depot", "depot"]);
    assert.equal(v.wagons[1].label, "В staging → стенд", "вагон дерева после влива — по станциям дерева");
    assert.match(v.wagons[2].label, /следующий/);
    assert.notEqual(slotGroup(t, null, v.next, { inbox: [], reqs: [] }), "merged", "в очереди есть вагоны — поезд не влит");
    const all = view(
        { ...t, wagons: ws.map((w) => ({ ...w, state: "staging", commits: 0 })), head: "", current: "" },
        { ...AUTO, guards: "g", review: "r", regress: "r", commit: "c", staging: "влито: abc" },
    );
    assert.notEqual(all.next.act, "train-wagon");
    assert.equal(slotGroup({ ...t, wagons: all.wagons.map((w) => ({ ...w, state: "staging" })) }, null, all.next, { inbox: [], reqs: [] }), "merged");
});

test("голова очереди ждёт вагон другого поезда — «ждёт …», выдачи нет", () => {
    const ws = [W[0], { ...W[1], state: "staging", commits: 0 }, { ...W[2], state: "wait", waitFor: ["WV-0099@Т2"] }, W[3]];
    const t = tree({
        ahead: 0,
        hasCode: false,
        wagons: ws,
        head: "WV-0003",
        current: "",
        issued: "WV-0002",
        wagon: "WV-0002",
        verdict: { tests: "green", build: "notneeded", guards: "green", regress: "green", merged: true },
    });
    const v = view(t, { ...AUTO, guards: "g", review: "r", regress: "r", commit: "c", staging: "влито: abc" });
    assert.deepEqual([v.wagons[2].tone, v.wagons[2].label], ["wait", "ждёт WV-0099@Т2"]);
    assert.notEqual(v.next.act, "train-wagon");
});

test("отметки времени вагонов — в виде (диаграмма вагонов поверх схемы «Порядок влива»)", () => {
    const v = view(tree(), AUTO);
    assert.deepEqual(v.wagons[0].times, { ...TIMES, mergedAt: 3, mergeSha: "m1" });
    assert.deepEqual(v.wagons[2].times, {});
});

test("слот без поезда — вагонов нет", () => {
    assert.equal(wagonsView({ key: "x", kind: "slot" }, [], 0), null);
});
