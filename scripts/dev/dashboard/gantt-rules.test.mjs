import test from "node:test";
import assert from "node:assert/strict";
import { ganttLayout, ganttPick, median, mergeShaOf, STAGING_KEY } from "./gantt-rules.mjs";
import { MERGE_LABEL } from "./loops.mjs";

const H = 3600e3, T0 = Date.UTC(2026, 10, 18, 6, 0, 0), at = (h) => T0 + h * H;
const NOW = at(30);
const train = (key, tag, wagons, extra = {}) => ({ key, tag, kind: "slot", train: true, title: "поезд " + tag, color: "#16a34a", branch: "dev/" + key, wagonsView: wagons, ...extra });
const wag = (wave, state, times = {}, after = []) => ({ wave, title: "вагон " + wave, state, tone: state === "staging" ? "done" : state === "work" ? "work" : "depot", after, times });
const row = (g, key) => g.rows.find((r) => r.key === key);

test("слот: выдача — agent.start, ГОТОВО — slot.done, влив — t.merge; ромб на строке staging", () => {
    const t = { key: "wv1103-a", tag: "П1", kind: "slot", wave: "wv-1103", title: "таблица", branch: "dev/wv-1103-a", merge: { sha: "abc1234", ct: at(5) }, firstCommitAt: at(1.5) };
    const events = [{ at: at(1), type: "agent.start", key: "wv1103-a" }, { at: at(3), type: "slot.done", tree: "wv1103-a" }, { at: at(4), type: "slot.done", tree: "wv1103-a" }];
    const g = ganttLayout({ trees: [t], events, now: NOW });
    const b = row(g, "wv1103-a").bars[0];
    assert.equal(b.wave, "WV-1103");
    assert.equal(b.start, at(1));
    assert.equal(b.doneAt, at(3), "первое ГОТОВО — повторное уходит в ожидание");
    assert.equal(b.mergedAt, at(5));
    assert.equal(b.phase, "done");
    assert.equal(g.rows[0].key, STAGING_KEY);
    assert.deepEqual(g.rows[0].marks.map((m) => [m.wave, m.sha]), [["WV-1103", "abc1234"]]);
    const g2 = ganttLayout({ trees: [{ ...t, reopened: { ahead: 1 } }], events: [], now: NOW });
    const b2 = g2.rows[1].bars[0];
    assert.equal(b2.start, at(1.5));
    assert.equal(b2.mergedAt, 0);
    assert.equal(b2.end, NOW);
    assert.equal(b2.phase, "work");
});

test("поезд: полосы вагонов по times, ожидание ВЛИТЬ с подписью проверок, вопрос оркестратора по метке и его длительность", () => {
    const t = train("tr-a", "Т1", [
        wag("WV-1001", "staging", { issuedAt: at(0), doneAt: at(2), mergedAt: at(4), mergeSha: "m1" }),
        wag("WV-1002", "work", { issuedAt: at(4.5), doneAt: at(6) }),
        wag("WV-1003", "depot"),
    ]);
    const events = [
        { at: at(6.5), type: "merge.wait", tree: "tr-a", need: "sec,regress" }, { at: at(7), type: "merge.wait.red", tree: "tr-a" },
        { at: at(7), type: "owner.question", tree: "orchestrator@e", brief: "1. Влить Т1 сейчас? (а) да" }, { at: at(9), type: "owner.answer", key: "orchestrator@e", via: "tg" },
        { at: at(8), type: "owner.question", tree: "orchestrator@e", brief: "1. Выкатить стенд?" },
    ];
    const g = ganttLayout({ trees: [t], events, now: NOW }), r = row(g, "tr-a");
    assert.deepEqual(r.bars.map((b) => b.phase), ["done", "wait", "queue"]);
    const w2 = r.bars[1];
    assert.equal(w2.end, NOW);
    assert.equal(w2.waits.length, 1);
    assert.deepEqual(w2.waits[0].need, [MERGE_LABEL.sec, MERGE_LABEL.regress]);
    assert.equal(w2.waits[0].red, true);
    assert.equal(w2.waits[0].open, true);
    assert.equal(w2.questions.length, 1);
    assert.equal(w2.questions[0].answeredAt, at(9));
    assert.equal(w2.questions[0].via, "tg");
    assert.equal(w2.questions[0].from, "оркестратор");
    assert.equal(g.rows[0].questions.length, 1, "вопрос без волны — на строке staging");
    assert.equal(g.rows[0].questions[0].answeredAt, at(9), "ответ закрывает все открытые вопросы агента");
    assert.deepEqual(r.queue.map((q) => q.wave), ["WV-1003"]);
    assert.equal(g.forecast.ok, false, "один влитой вагон — прогноза нет");
    assert.match(g.forecast.note, /очередь показана порядком/);
});

test("вопрос без записанного ответа: висит только последний вопрос агента с открытой карточкой, прочие — «ответ не записан»", () => {
    const t = { key: "s1", tag: "П1", kind: "slot", wave: "wv-1", firstCommitAt: at(0) };
    const events = [
        { at: at(1), type: "owner.question", tree: "s1", brief: "а?" }, { at: at(2), type: "owner.message", key: "s1", brief: "да" },
        { at: at(3), type: "owner.question", tree: "s1", brief: "б?" }, { at: at(4), type: "owner.question", tree: "s1", brief: "в?" },
    ];
    const q = (openAsk) => ganttLayout({ trees: [t], events, now: NOW, openAsk }).rows[1].bars[0].questions.map((x) => [x.brief, x.answeredAt, x.open, x.lost]);
    assert.deepEqual(q(["s1"]), [["а?", at(2), false, false], ["б?", 0, false, true], ["в?", 0, true, false]]);
    assert.deepEqual(q([]).map((x) => x[3]), [false, true, true], "карточки нет — ответили мимо журнала");
});

test("живое ожидание ВЛИТЬ (t.mergeWait) и закрытое по журналу", () => {
    const t = train("tr-a", "Т1", [wag("WV-1001", "work", { issuedAt: at(0), doneAt: at(2) })], { mergeWait: { at: at(3), need: ["ревью"], state: "wait" } });
    const events = [{ at: at(2.2), type: "merge.wait", tree: "tr-a", need: "sec" }, { at: at(2.5), type: "merge.wait.off", tree: "tr-a" }];
    const w = ganttLayout({ trees: [t], events, now: NOW }).rows[1].bars[0].waits;
    assert.deepEqual(w.map((x) => [x.from, x.to, x.need.join(","), !!x.open]), [[at(2.2), at(2.5), MERGE_LABEL.sec, false], [at(3), NOW, MERGE_LABEL.review, true]]);
});

test("подтягивания staging: журнал + syncMark без двойной отметки; засечка «отстаёт и пересекается»", () => {
    const t = { key: "s1", tag: "П1", kind: "slot", wave: "wv-1", branch: "dev/s1", firstCommitAt: at(1), syncMark: { at: at(3) + 2000, how: "merge" }, behind: 4, staleRisk: ["a.ts", "b.ts"] };
    const events = [
        { at: at(2), type: "slot.sync", key: "s1", result: "ok", detail: "перемотано на staging" },
        { at: at(3), type: "slot.sync", key: "s1", result: "ok", detail: "слияние" },
        { at: at(3.5), type: "slot.sync", key: "s1", result: "fail" },
    ];
    const r = ganttLayout({ trees: [t], events, now: NOW }).rows[1];
    assert.deepEqual(r.syncs.map((s) => [s.at, s.how]), [[at(2), "ff"], [at(3), "merge"]]);
    assert.deepEqual(r.stale, { at: NOW, behind: 4, n: 2, files: ["a.ts", "b.ts"] });
    assert.equal(ganttLayout({ trees: [{ ...t, behind: 0 }], events, now: NOW }).rows[1].stale, null, "staging не ушёл — засечки нет");
});

test("ПОРЯДОК: связь от влива предшественника (в том числе @другого поезда) к началу ожидания последующего; live — пока он не влит", () => {
    const t1 = train("tr-a", "Т1", [wag("WV-1001", "staging", { issuedAt: at(0), doneAt: at(1), mergedAt: at(2) }), wag("WV-1002", "work", { issuedAt: at(3), doneAt: at(5) })]);
    const t2 = train("tr-b", "Т2", [wag("WV-2001", "work", { issuedAt: at(1), doneAt: at(4) }, ["WV-1001@Т1"]), wag("WV-2002", "depot", {}, ["WV-2001", "WV-1002@Т1"])]);
    const slot = { key: "s9", tag: "П9", kind: "slot", wave: "wv-9", firstCommitAt: at(2), deps: [{ key: "tr-a", tag: "Т1", merged: false }] };
    const g = ganttLayout({ trees: [slot, t1, t2], events: [], now: NOW });
    assert.deepEqual(g.rows.map((r) => r.tag), ["staging", "Т1", "Т2", "П9"], "поезда, потом слоты — как схема");
    const l = (w) => g.links.filter((x) => x.to.wave === w).map((x) => [x.from.wave, x.from.at, x.to.at, x.live]);
    assert.deepEqual(l("WV-2001"), [["WV-1001", at(2), at(4), false]]);
    assert.deepEqual(l("WV-2002"), [["WV-2001", 0, 0, true], ["WV-1002", 0, 0, true]], "в очереди без прогноза — время 0");
    assert.equal(g.links.filter((x) => x.to.key === "s9").length, 1);
});

test("прогноз: медиана своего поезда (от 2 вагонов), очередь после вагона в работе и после влива «после» другого поезда", () => {
    const t1 = train("tr-a", "Т1", [
        wag("WV-1001", "staging", { issuedAt: at(0), mergedAt: at(2) }), wag("WV-1002", "staging", { issuedAt: at(2), mergedAt: at(6) }),
        wag("WV-1003", "work", { issuedAt: at(29) }), wag("WV-1004", "depot")
    ]);
    const t2 = train("tr-b", "Т2", [wag("WV-2001", "depot", {}, ["WV-1004@Т1"])]);
    const g = ganttLayout({ trees: [t1, t2], events: [], now: NOW });
    assert.equal(g.forecast.ok, true);
    const b = (k, w) => row(g, k).bars.find((x) => x.wave === w);
    assert.deepEqual([b("tr-a", "WV-1004").start, b("tr-a", "WV-1004").end, b("tr-a", "WV-1004").phase], [at(32), at(35), "forecast"]);
    assert.equal(b("tr-b", "WV-2001").phase, "queue");
    assert.deepEqual(row(g, "tr-b").queue.map((q) => q.wave), ["WV-2001"]);
    const t3 = train("tr-c", "Т3", [wag("WV-3001", "staging", { issuedAt: at(0), mergedAt: at(1) })]);
    const g2 = ganttLayout({ trees: [t1, t2, t3], events: [], now: NOW }), x = row(g2, "tr-b").bars[0];
    assert.equal(x.phase, "forecast");
    assert.equal(x.start, at(35), "после прогнозного влива WV-1004");
    assert.equal(x.end - x.start, 2 * H, "медиана эпика 1, 2, 4 ч = 2 ч");
    const lk = g2.links.find((l) => l.to.wave === "WV-2001");
    assert.equal(lk.from.at, at(35));
    assert.equal(lk.to.at, at(35));
    assert.ok(g2.to >= at(37));
});

test("закрытый эпик по журналу: выдача — train.wagon, ГОТОВО — slot.done, влив — job.end merge с веткой в итоге", () => {
    const t = train("tr-x", "Т1", [wag("WV-1099", "", {}), wag("WV-1095", "", {})].map((w) => ({ ...w, state: undefined, tone: undefined })));
    const events = [
        { at: at(0), type: "train.wagon", tree: "tr-x", wave: "WV-1099" }, { at: at(1), type: "slot.done", tree: "tr-x" },
        { at: at(2), type: "job.end", task: "merge", status: "ok", tree: "orchestrator-staging", summary: "(в основной папке)  ·  merge-коммит dev/tr-x: 252a8c43fb67" },
        { at: at(3), type: "train.wagon", tree: "tr-x", wave: "WV-1095" }, { at: at(4), type: "slot.done", tree: "tr-x" },
        { at: at(5), type: "job.end", task: "merge", status: "ok", tree: "orchestrator-staging", summary: "merge-коммит dev/tr-x: 99999999aaaa" },
    ];
    const r = ganttLayout({ trees: [t], events, now: NOW }).rows[1];
    assert.deepEqual(r.bars.map((b) => [b.wave, b.start, b.doneAt, b.mergedAt, b.mergeSha]), [["WV-1099", at(0), at(1), at(2), "252a8c43fb67"], ["WV-1095", at(3), at(4), at(5), "99999999aaaa"]]);
    const t2 = train("tr-y", "Т2", [wag("WV-2001", "work", { issuedAt: at(2), firstCommitAt: at(2) }), wag("WV-2002", "depot")]);
    const b2 = ganttLayout({ trees: [t2], events: [{ at: at(1), type: "agent.start", key: "tr-y" }, { at: at(6), type: "agent.start", key: "tr-y" }], now: NOW }).rows[1].bars;
    assert.deepEqual([b2[0].start, b2[1].start], [at(1), 0]);
});

test("служебное: медиана, sha влива из итога прогона, пусто без слотов", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 4]), 3);
    assert.equal(median([]), 0);
    assert.equal(mergeShaOf({ type: "job.end", task: "merge", status: "ok", summary: "merge-коммит dev/a-b: abcdef12" }, "dev/a-b"), "abcdef12");
    assert.equal(mergeShaOf({ type: "job.end", task: "merge", status: "ok", summary: "merge-коммит dev/a-bc: abcdef12" }, "dev/a-b"), "", "чужая ветка с тем же началом");
    assert.equal(mergeShaOf({ type: "job.end", task: "merge", status: "ok", summary: "merge-коммит dev/a-b-c3: 1234567f" }, "dev/a-b"), "1234567f", "ветка старого состава поезда");
    assert.equal(mergeShaOf({ type: "job.end", task: "merge", status: "fail", summary: "merge-коммит dev/a-b: abcdef12" }, "dev/a-b"), "");
    assert.equal(ganttLayout({ trees: [{ key: "o", kind: "orch" }], events: [] }), null);
});

test("ganttPick: события эпика по полю и ключам, вливы — по ветке, лишние типы отброшены", () => {
    const evs = [
        { at: 1, type: "slot.done", epic: "e", tree: "x" }, { at: 2, type: "slot.done", tree: "s1" }, { at: 3, type: "slot.done", epic: "other", tree: "zz" },
        { at: 4, type: "owner.question", tree: "orchestrator@e" }, { at: 5, type: "server.pulse", epic: "e" },
        { at: 6, type: "job.end", task: "merge", status: "ok", summary: "merge-коммит dev/s1: aaa1111" }, { at: 7, type: "job.end", task: "merge", status: "ok", summary: "merge-коммит dev/zz: bbb" },
        { at: 8, type: "job.end", task: "tests", status: "ok", summary: "dev/s1" },
    ];
    assert.deepEqual(ganttPick(evs, { epic: "e", keys: ["s1", "orchestrator@e"], branches: ["dev/s1"] }).map((e) => e.at), [1, 2, 4, 6]);
});
