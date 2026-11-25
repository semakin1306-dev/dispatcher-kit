import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOrderMap, mayMergeNow } from "./ui/order-rules.js";

const MERGED = { ahead: 0, stages: [{ id: "commit", done: true }, { id: "staging", done: true }] };
const T = (tag, deps = [], o = {}) => ({
    key: "w-" + tag,
    tag,
    title: "волна " + tag,
    color: "#" + tag.slice(1).padStart(6, "0"),
    kind: "slot",
    ahead: 1,
    deps: deps.map(([t, merged]) => ({ key: "w-" + t, tag: t, merged: !!merged })),
    stages: [],
    ...o,
});
const tags = (ns) => ns.map((n) => n.tag).join(",");

test("серые — без зависимостей (любой порядок); цветные — в цепочках; волна = 1 + самая поздняя зависимость", () => {
    const m = buildOrderMap([T("П1"), T("П2"), T("П7"), T("П6", [["П7"]]), T("П9", [["П7"], ["П6"]]), T("П5", [["П9"]])]);
    assert.equal(tags(m.free), "П1,П2");
    assert.deepEqual(m.waves.map((w) => w.n + ":" + tags(w.nodes)), ["1:П7", "2:П6", "3:П9", "4:П5"]);
    assert.equal(m.counts.chained, 4);
    assert.equal(m.counts.free, 2);
});

test("узлы одной волны — параллельно, внутри — по номеру слота; у узла названы открытые зависимости и кто его ждёт", () => {
    const m = buildOrderMap([T("П7"), T("П9", [["П7"]]), T("П6", [["П7"]]), T("П8", [["П6"], ["П9"]])]);
    assert.equal(tags(m.waves[1].nodes), "П6,П9");
    const p8 = m.waves[2].nodes[0];
    assert.deepEqual(p8.after, ["П6", "П9"]);
    assert.deepEqual(m.waves[0].nodes[0].before.sort(), ["w-П6", "w-П9"]);
});

test("влитые зависимости не держат: слот освобождается и становится серым, если связей больше нет; влитые — отдельно", () => {
    const m = buildOrderMap([T("П6", [], MERGED), T("П5", [["П6", true]]), T("П4")]);
    assert.equal(tags(m.merged), "П6");
    assert.equal(tags(m.free), "П4,П5", "П5 ждала только влитую П6 — теперь без зависимостей");
    assert.equal(m.waves.length, 0);
});

test("зависимость от слота другого эпика не рисуется ребром, но называется; слот остаётся свободным", () => {
    const m = buildOrderMap([T("П3", [["Х9"]])]);
    const n = m.free[0];
    assert.deepEqual(n.external, ["Х9"]);
    assert.equal(m.waves.length, 0);
});

test("состояния: готов к вливу (закоммичено, все проверки пройдены) и в работе; mayMergeNow — только готовые в первой волне и серые", () => {
    const ready = { stages: [{ id: "commit", done: true }], dirtyTracked: 0 };
    const m = buildOrderMap([T("П7", [], ready), T("П6", [["П7"]], ready), T("П1", [], ready), T("П2")]);
    assert.equal(m.free.find((n) => n.tag === "П1").state, "ready");
    assert.equal(m.free.find((n) => n.tag === "П2").state, "work");
    assert.equal(tags(mayMergeNow(m)), "П1,П7", "П6 готова, но ждёт П7");
});

test("оркестратор и слоты разведки не попадают на схему; цикл не вешает расчёт", () => {
    const m = buildOrderMap([{ key: "orchestrator", kind: "orch", tag: "ОРК" }, T("П1", [], { readOnly: true, ahead: 0 }), T("П2", [["П3"]]), T("П3", [["П2"]])]);
    assert.equal(m.counts.all, 2);
    assert.equal(m.cycle, true);
});

test("слот без коммитов (ветка — предок staging) не «влит», даже если зависимые видят у него merged:true; Go-слот (readOnly из build:false) с кодом — на схеме", () => {
    const fresh = T("П17", [], { ahead: 0, dirtyTracked: 10, stages: [{ id: "staging", done: false }] }), dep = T("П19", [["П17", true]]);
    const m = buildOrderMap([fresh, dep]);
    assert.equal(m.merged.length, 0, "П17 ещё в работе");
    assert.equal(tags(m.waves[0].nodes), "П17");
    assert.equal(tags(m.waves[1].nodes), "П19");
    const go = T("П14", [], { readOnly: true, hasCode: true, ahead: 3 }), recon = T("П1", [], { readOnly: true, ahead: 0, hasCode: false });
    assert.equal(buildOrderMap([go, recon]).counts.all, 1, "разведка (кода нет) — не на схеме");
});

test("зависимость уже влита (слот), но у зависимого флаг merged из git ещё старый — не «можно сразу», а «обновляю»", () => {
    const m = buildOrderMap([T("П7", [], MERGED), T("П8", [["П7", false]], { stages: [{ id: "commit", done: true }] })]);
    const p8 = m.free.find((n) => n.tag === "П8");
    assert.deepEqual(p8.syncing, ["П7"]);
    assert.equal(mayMergeNow(m).length, 0, "диспетчерская П8 пока не пустит");
    const ok = buildOrderMap([T("П7", [], MERGED), T("П8", [["П7", true]], { stages: [{ id: "commit", done: true }] })]);
    assert.equal(mayMergeNow(ok).map((n) => n.tag).join(), "П8", "флаг обновился — можно");
});

test("закоммичен, но конфликт со staging — не «готов», в «можно сейчас» не попадает", () => {
    const m = buildOrderMap([T("П10", [], { stages: [{ id: "commit", done: true }], conflict: ["a/route.ts"] })]);
    assert.equal(m.free[0].state, "work");
    assert.equal(mayMergeNow(m).length, 0);
});

test("слот-поезд — слот с очередью: вагон ветки закоммичен — «готов», как у слота; влит вагон, а очередь не пуста — поезд не влит", () => {
    const st = (ids) => ["commit", "staging"].map((id) => ({ id, done: ids.includes(id) }));
    const wv = (wave, tone, label) => ({ wave, tone, label });
    const tr = { key: "tr", tag: "Т1", train: true, ahead: 2, dirtyTracked: 0, stages: st(["commit"]), wagonsView: [wv("WV-0001", "check", "ждёт влива"), wv("WV-0002", "depot", "в очереди")] };
    const m = buildOrderMap([tr]);
    assert.equal(m.free[0].state, "ready");
    assert.equal(mayMergeNow(m).map((n) => n.tag).join(), "Т1");
    assert.deepEqual(m.free[0].wagons, ["WV-0001 — ждёт влива", "WV-0002 — в очереди"]);
    assert.equal(buildOrderMap([{ ...tr, stages: [], ahead: 0, dirtyTracked: 3 }]).free[0].state, "work", "вагон в работе");
    const between = { ...tr, ahead: 0, stages: st(["commit", "staging"]), wagonsView: [wv("WV-0001", "done", "В staging"), wv("WV-0002", "depot", "следующий")] };
    assert.equal(buildOrderMap([between]).merged.length, 0, "вагон влит, следующий в очереди — поезд ещё едет");
    assert.equal(buildOrderMap([{ ...between, wagonsView: [wv("WV-0001", "done", "В staging"), wv("WV-0002", "done", "В staging")] }]).merged.length, 1, "вся очередь в staging — поезд влит");
});
