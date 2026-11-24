import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { NOT_DONE_WHY, askDoneAct, askDoneText, autoMergeAct, autoSyncAct, wagonDone, wagonUnfinished, mergePin } from "./auto-merge-rules.mjs";

const st = (over = {}) => ["build", "tests", "guards", "review", "regress", "staging"].map((id) => ({ id, label: id, done: id === "staging" ? false : over[id] !== false }));
const ready = (o = {}) => ({ kind: "slot", exists: true, ahead: 3, behind: 0, dirtyTracked: 0, conflict: [], stages: st(), deps: [], verdict: {}, ...o });

describe("20.11 автовлив: autoMergeAct", () => {
    test("всё зелёное, ГОТОВО, конфликта нет — вливать", () => {
        assert.equal(autoMergeAct({ t: ready(), final: true }).act, "merge");
    });
    test("выключен, перезапуск, влив уже идёт — не вливать", () => {
        assert.equal(autoMergeAct({ on: false, t: ready(), final: true }).act, "");
        assert.equal(autoMergeAct({ drain: true, t: ready(), final: true }).act, "");
        assert.match(autoMergeAct({ t: ready(), final: true, mergeLive: true }).why, /другой влив/);
    });
    test("Т2/Т4 20.11: конфликт package.json — не вливать, конфликт ещё считается — тоже", () => {
        assert.match(autoMergeAct({ t: ready({ conflict: ["package.json"] }), final: true }).why, /конфликт со staging: package\.json/);
        assert.match(autoMergeAct({ t: ready({ conflict: null }), final: true }).why, /считается/);
    });
    test("непройденная станция, правки в папке, невлитая зависимость, нечего вливать — не вливать", () => {
        assert.match(autoMergeAct({ t: ready({ stages: st({ review: false }) }), final: true }).why, /не пройдены: review/);
        assert.equal(autoMergeAct({ t: ready({ dirtyTracked: 2 }), final: true }).act, "");
        assert.match(autoMergeAct({ t: ready({ deps: [{ tag: "Т3", merged: false }] }), final: true }).why, /сначала влить Т3/);
        assert.equal(autoMergeAct({ t: ready({ ahead: 0 }), final: true }).act, "");
        assert.equal(autoMergeAct({ t: ready({ verdict: { merged: true } }), final: true }).act, "");
    });
    test("оркестратор и разведка не вливаются", () => {
        assert.equal(autoMergeAct({ t: ready({ kind: "orch" }), final: true }).act, "");
        assert.equal(autoMergeAct({ t: ready({ readOnly: true }), final: true }).act, "");
    });
    test("без «ГОТОВО» не вливать; у вагона поезда «ГОТОВО» переживает подтягивание staging", () => {
        assert.match(autoMergeAct({ t: ready(), final: false }).why, /ГОТОВО/);
        const tr = ready({ train: true, wagon: "WV-1113", wagons: [{ wave: "WV-1113", times: { doneAt: 1 } }, { wave: "WV-1114", times: {} }] });
        assert.equal(wagonDone(tr), true);
        assert.equal(autoMergeAct({ t: tr, final: false }).act, "merge");
        assert.equal(wagonDone({ ...tr, wagon: "WV-1114" }), false);
    });
});

describe("20.11 автоподтягивание: autoSyncAct", () => {
    const c = (o = {}) => ready({ behind: 2, conflict: ["package.json"], ...o });
    test("конфликт, агент свободен — подтянуть", () => {
        assert.equal(autoSyncAct({ t: c() }).act, "sync");
    });
    test("без конфликта не подтягивать: ветка вливается и так, проверки не сбрасываются", () => {
        assert.equal(autoSyncAct({ t: c({ conflict: [] }) }).act, "");
        assert.equal(autoSyncAct({ t: c({ conflict: null }) }).act, "");
    });
    test("22.11 (Т4 5 ч на «Гардах»): красная станция на этом коде и staging впереди — подтянуть без конфликта, один раз", () => {
        const d = autoSyncAct({ t: c({ conflict: [] }), red: true });
        assert.equal(d.act, "sync");
        assert.match(d.why, /станция красная.*на 2/);
        assert.equal(autoSyncAct({ t: c({ conflict: [] }), red: true, tried: true }).act, "", "на этом staging и коде уже подтягивали");
        assert.equal(autoSyncAct({ t: c({ conflict: [] }), red: true, busy: true }).act, "", "агент в ходе");
        assert.equal(autoSyncAct({ t: c({ conflict: null }), red: true }).act, "", "конфликт ещё считается — ждать");
        assert.equal(autoSyncAct({ t: c({ conflict: [], behind: 0 }), red: true }).act, "", "staging не ушёл — подтягивать нечего");
    });
    test("агент занят, уже подтягивали на этом staging, правки в папке, выключено — не подтягивать", () => {
        assert.equal(autoSyncAct({ t: c(), busy: true }).act, "");
        assert.equal(autoSyncAct({ t: c(), tried: true }).act, "");
        assert.equal(autoSyncAct({ t: c({ dirtyTracked: 1 }) }).act, "");
        assert.equal(autoSyncAct({ on: false, t: c() }).act, "");
    });
    test("влитая ветка и ветка без своих коммитов — не наше дело (перемотка — autoSyncSlots)", () => {
        assert.equal(autoSyncAct({ t: c({ verdict: { merged: true } }) }).act, "");
        assert.equal(autoSyncAct({ t: c({ ahead: 0 }) }).act, "");
    });
});

describe("22.11 «ГОТОВО» не доложен: спросить агента (askDoneAct) и не вливать вагон кнопкой (wagonUnfinished)", () => {
    const t2 = (o = {}) => ready({ key: "tr-infra2-x", fp: "fp1", train: true, wagon: "WV-1114", wagons: [{ wave: "WV-1114", times: {} }], ...o });
    test("Т2 20.11: станции зелёные, доклада нет — спросить агента один раз на этом коде", () => {
        const d = autoMergeAct({ t: t2(), final: false });
        assert.equal(d.why, NOT_DONE_WHY);
        assert.equal(askDoneAct({ d, t: t2() }).act, "ask");
        assert.equal(askDoneAct({ d, t: t2(), asked: "fp1" }).act, "", "на том же коде второй раз не спрашиваем");
        assert.equal(askDoneAct({ d, t: t2({ fp: "fp2" }), asked: "fp1" }).act, "ask", "код поменялся — спросить снова");
        assert.equal(askDoneAct({ d, t: t2(), busy: true }).act, "", "агент в ходе или идут прогоны — после");
    });
    test("любой другой отказ автовлива агента не будит: станция, конфликт, «ещё считается», перезапуск, уже вливаем", () => {
        for (const d of [
            autoMergeAct({ t: t2({ stages: st({ tests: false }) }), final: false }),
            autoMergeAct({ t: t2({ conflict: ["package.json"] }), final: false }),
            autoMergeAct({ t: t2({ conflict: null }), final: false }),
            autoMergeAct({ drain: true, t: t2(), final: false }),
            autoMergeAct({ t: t2(), final: true }),
        ])
            assert.equal(askDoneAct({ d, t: t2() }).act, "", d.why);
        assert.equal(askDoneAct({ d: { act: "", why: NOT_DONE_WHY }, t: t2({ fp: "" }) }).act, "", "без отпечатка кода не спрашиваем");
    });
    test("вопрос зовёт ответ в формате доклада, который ловит диспетчерская", () => {
        const s = askDoneText(t2());
        assert.match(s, /\(слот tr-infra2-x\): ГОТОВО/);
        assert.match(s, /вагона WV-1114/);
        assert.match(s, /продолжай со следующего шага/);
    });
    test("Т2 21.11 09:39: вагон после первого шага (только спеки) не вливается кнопкой; доклад или «ГОТОВО» вагона — вливается", () => {
        assert.equal(wagonUnfinished(t2({ wagon: "WV-1117", wagons: [{ wave: "WV-1117", times: { issuedAt: 1 } }] }), false), true);
        assert.equal(wagonUnfinished(t2(), true), false, "доклад «ГОТОВО» на этом коде");
        assert.equal(wagonUnfinished(t2({ wagons: [{ wave: "WV-1114", times: { doneAt: 1 } }] }), false), false, "«ГОТОВО» вагона переживает подтягивание staging");
        assert.equal(wagonUnfinished(ready(), false), false, "обычный слот (не поезд) кнопкой вливается как раньше");
    });
});

describe("mergePin — влив ровно проверенного коммита", () => {
    const H = "5a9f7e5e6a" + "0".repeat(30);
    test("ветка на коммите снимка — вливается её полный sha", () => {
        assert.deepEqual(mergePin({ head: H, snapSha: "5a9f7e5e6a" }), { ok: true, sha: H, why: "" });
    });
    test("ветка ушла вперёд после снимка — не вливаем, причина с обоими коммитами", () => {
        const r = mergePin({ head: "cd1a34f90e" + "1".repeat(30), snapSha: "44abf22c5a" });
        assert.equal(r.ok, false);
        assert.match(r.why, /ушла вперёд после снимка \(44abf22c5a → cd1a34f90e\)/);
    });
    test("нет коммита ветки или снимка — не вливаем", () => {
        assert.equal(mergePin({ head: "", snapSha: "abc" }).ok, false);
        assert.equal(mergePin({ head: H, snapSha: "" }).ok, false);
    });
});
