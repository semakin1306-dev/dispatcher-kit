// accept-view.test.mjs — колонка «Приёмка»: счётчики волны, «ждут меня», красные, вердикт из строки, фильтр, поиск,
// группы по поезду и эпику, сортировка; несколько эпиков с одинаковыми метками слотов «П1» не смешиваются.
//   node --test scripts/dev/dashboard/accept-view.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptTotals, acceptView, itemShown, quickVerdict, tagCmp, waveCounts, waveFilter, waveInScope, waveMatches, waveNeedsMe, waveNo, waveRank, waveRed } from "./ui/accept-view.js";

const A = (st, state = "todo") => ({ id: "a", how: "auto", state, ...(st ? { auto: { st } } : {}) });
const M = (state = "todo", o = {}) => ({ id: "m", how: "manual", state, todo: "проверить руками", ...o });
const W = (tag, items, o = {}) => ({ key: "tr-x#WV-" + tag, tag, title: "волна " + tag, epic: "e1", epicTitle: "Эпик 1", items, ...o });

test("счётчики: авто ✓ / ✗ / не проверено, ручных и отмеченных; ручная отметка авто-пункта считается", () => {
    const c = waveCounts(W("1", [A("ok"), A("flaky"), A("fail"), A(null), A("skip"), A(null, "ok"), M(), M("ok"), M("bad")]));
    assert.deepEqual(c, { items: 9, auto: 6, autoOk: 3, autoBad: 1, autoNone: 2, manual: 3, manualDone: 2, marksBad: 1 });
    assert.deepEqual(waveCounts({}), { items: 0, auto: 0, autoOk: 0, autoBad: 0, autoNone: 0, manual: 0, manualDone: 0, marksBad: 0 });
    assert.equal(waveCounts(W("2", [{ id: "x", state: "todo" }])).manual, 1, "пункт без how — ручной");
});

test("ждут меня, красные, вердикт из строки, порядок «сначала требующие действия»", () => {
    const wait = W("1", [A("ok"), M()]), red = W("2", [A("fail"), M()]), ok = W("3", [A("ok")], { verdict: "accepted" }), self = W("4", [M()], { autoClosed: "без кода продукта" });
    const rej = W("5", [A("ok")], { verdict: "rejected" }), plain = W("6", [A(null)], { verdict: "" });
    assert.equal(waveNeedsMe(wait), true);
    assert.equal(waveNeedsMe(ok), false);
    assert.equal(waveNeedsMe(self), false, "закрытая сама не ждёт");
    assert.equal(waveRed(red), true);
    assert.equal(waveRed(rej), true);
    assert.equal(waveRed(wait), false);
    assert.equal(waveRed(W("7", [M("bad")])), true, "отметка «не работает» — красная");
    assert.equal(quickVerdict(wait), true, "авто зелёные — вердикт из строки");
    assert.equal(quickVerdict(red), false);
    assert.equal(quickVerdict(plain), false, "авто не проверены — раскрыть");
    assert.equal(quickVerdict(W("8", [])), false, "без пунктов — нечего принимать");
    assert.deepEqual([ok, wait, red, plain].map((w) => waveRank(w)), [3, 1, 0, 1]);
});

test("фильтр волн и пунктов: ждут меня / красные / только ручные / только авто / принятые", () => {
    const ws = [W("1", [A("ok"), M()]), W("2", [A("fail")]), W("3", [M("ok")], { verdict: "accepted" }), W("4", [A("ok")])];
    const pick = (m) => ws.filter((w) => waveFilter(w, m)).map((w) => w.tag).join(",");
    assert.equal(pick("all"), "1,2,3,4");
    assert.equal(pick("me"), "1,2,4");
    assert.equal(pick("red"), "2");
    assert.equal(pick("manual"), "1,3");
    assert.equal(pick("auto"), "1,2,4");
    assert.equal(pick("accepted"), "3");
    assert.equal(itemShown(M(), "manual"), true);
    assert.equal(itemShown(A("ok"), "manual"), false);
    assert.equal(itemShown(A("ok"), "auto"), true);
    assert.equal(itemShown(M(), "auto"), false);
    assert.equal(itemShown(M(), "red"), true);
});

test("номер волны: поле wave, название, ветка слота", () => {
    assert.equal(waveNo({ wave: "WV-9001" }), "WV-9001");
    assert.equal(waveNo({ title: "WV-9002 Поиск пользователей" }), "WV-9002");
    assert.equal(waveNo({ title: "", branch: "dev/wv-9003-beta" }), "WV-9003");
    assert.equal(waveNo({ tag: "П1" }), "");
});

test("поиск: номер волны (и «WV-9001»), название, поезд, эпик, текст пункта; все слова сразу", () => {
    const w = W("9001", [M("todo", { todo: "Посчитать строки federation_user_membership", expect: "цифра в докладе", id: "i4" })], { title: "Оракул users/upsert" });
    for (const q of ["9001", "WV-9001", "wv9001", "оракул", "membership", "i4", "Т1", "оракул докладе", "эпик 1", ""]) assert.equal(waveMatches(w, q, "Т1"), true, q);
    assert.equal(waveMatches(w, "1154"), false);
    assert.equal(waveMatches(w, "оракул вебхук"), false, "второе слово не нашлось");
    const slot = { key: "wv9002-alpha", tag: "П1", title: "WV-9002 Поиск", epic: "a", items: [] };
    assert.equal(waveMatches(slot, "9002"), true, "номер волны слота — из названия");
});

test("вид колонки: группы по поезду (Т2 < Т10, П1 после), внутри — сначала красные и ждущие; без чек-листа — отдельно", () => {
    const trains = {
        a: { key: "a", tag: "Т10", title: "десятый", color: "#111" },
        b: { key: "b", tag: "Т2", title: "второй", color: "#222" },
        c: { key: "c", tag: "П1", title: "полировка", color: "#333" },
    };
    const w = (k, tag, items, o) => ({ ...W(tag, items, o), key: k + "#WV-" + tag });
    const ws = [
        w("a", "1101", [A("ok")], { verdict: "accepted" }),
        w("a", "1102", [A("fail")]),
        w("b", "1103", [M()]),
        w("b", "1104", []),
        w("c", "1105", [A("ok")], { verdict: "accepted" }),
        w("b", "1106", [], { verdict: "accepted" }),
    ];
    const tr = (x) => trains[x.key.split("#")[0]];
    const v = acceptView(ws, { trainOf: tr });
    assert.deepEqual(v.groups.map((g) => g.tag), ["Т10", "Т2", "П1"], "группа с красной волной — первой; дальше по номеру поезда");
    assert.deepEqual(v.groups[0].waves.map((x) => x.w.tag), ["1102", "1101"], "красная выше принятой");
    assert.equal(v.groups[0].need, 1);
    assert.equal(v.groups[0].label, "Т10 · десятый");
    assert.deepEqual(v.empty.map((x) => x.w.tag), ["1104"], "без пунктов и без вердикта — «без чек-листа»; принятая без пунктов остаётся в поезде");
    assert.equal(v.shown, 5);
    assert.equal(v.total, 6);
    const vm = acceptView(ws, { mode: "red", trainOf: tr });
    assert.deepEqual(vm.groups.map((g) => g.waves.map((x) => x.w.tag).join()), ["1102"]);
    const ve = acceptView([...ws, { ...W("9006", [M()]), key: "z#WV-9006", epic: "e0", epicTitle: "Альфа" }], { group: "epic", trainOf: tr });
    assert.deepEqual(ve.groups.map((g) => g.label), ["Эпик 1", "Альфа"], "по эпику: группа с красной первой");
    assert.deepEqual(acceptView(ws, { q: "1104", trainOf: () => null }).empty.length, 1, "поиск ищет и среди волн без чек-листа");
});

test("два эпика с одинаковыми метками слотов «П1»/«П2»: не смешиваются, вкладка эпика показывает только свои волны", () => {
    const slot = (key, epic, epicTitle, tag, title, items, o = {}) => ({ key, epic, epicTitle, tag, title, branch: "dev/" + key, items, ...o });
    const ws = [
        slot("wv9002-alpha", "epic-alpha", "Эпик Альфа", "П1", "WV-9002 Поиск", [A("ok"), M()]),
        slot("wv9003-beta", "epic-alpha", "Эпик Альфа", "П2", "WV-9003 Превью", [A("ok")]),
        slot("wv9004-gamma", "epic-beta", "Эпик Бета", "П1", "WV-9004 Конверсии", [A("fail")]),
        slot("wv9005-delta", "epic-beta", "Эпик Бета", "П2", "WV-9005 Постбэки", [M()]),
    ];
    // все эпики: две группы, каждая — свой эпик; одинаковые П1 в разных группах
    const all = acceptView(ws, { scope: "all", epic: "epic-alpha", trainOf: () => null });
    assert.equal(all.groups.length, 2);
    assert.deepEqual(all.groups.map((g) => g.label), ["Эпик Альфа", "Эпик Бета"], "эпик вкладки — первым, даже если в другом есть красное");
    assert.deepEqual(all.groups.map((g) => g.waves.map((x) => x.w.key)), [["wv9002-alpha", "wv9003-beta"], ["wv9004-gamma", "wv9005-delta"]]);
    const keys = all.groups.flatMap((g) => g.waves.map((x) => x.w.key));
    assert.equal(new Set(keys).size, keys.length, "ключи волн уникальны (ключ дерева, а не метка П1)");
    assert.equal(new Set(all.groups.map((g) => g.key)).size, 2, "ключи групп разные: эпик в ключе");
    assert.equal(all.epics, 2);
    // вкладка эпика: только его волны
    const one = acceptView(ws, { scope: "epic", epic: "epic-beta", trainOf: () => null });
    assert.deepEqual(one.groups.flatMap((g) => g.waves.map((x) => x.w.key)), ["wv9004-gamma", "wv9005-delta"]);
    assert.equal(one.total, 2);
    assert.equal(waveInScope(ws[0], "epic", "epic-beta"), false);
    assert.equal(waveInScope(ws[0], "all", "epic-beta"), true);
    // итог шапки — по видимому эпику
    assert.deepEqual(acceptTotals(ws, { scope: "epic", epic: "epic-alpha" }), { waves: 2, accepted: 0, rejected: 0, need: 2, red: 0, empty: 0 });
    // поезда двух эпиков с одинаковой меткой Т1 — тоже разные группы
    const tr = { t1a: { key: "t1a", tag: "Т1", title: "", color: "#1" }, t1b: { key: "t1b", tag: "Т1", title: "", color: "#2" } };
    const tws = [{ ...W("2001", [A("ok")]), key: "t1a#WV-2001", epic: "e1", epicTitle: "Эпик 1" }, { ...W("2002", [A("ok")]), key: "t1b#WV-2002", epic: "e2", epicTitle: "Эпик 2" }];
    const tv = acceptView(tws, { trainOf: (x) => tr[x.key.split("#")[0]] });
    assert.equal(tv.groups.length, 2, "Т1 эпика 1 и Т1 эпика 2 — разные группы");
    assert.deepEqual(tv.groups.map((g) => g.label), ["Эпик 1 · Т1", "Эпик 2 · Т1"], "при нескольких эпиках в названии поезда есть эпик");
});

test("порядок поездов и итог шапки", () => {
    assert.deepEqual(["П1", "Т10", "Т2", "", "Т1"].sort(tagCmp), ["Т1", "Т2", "Т10", "П1", ""]);
    const t = acceptTotals([W("1", [A("ok"), M()]), W("2", [A("fail")], { verdict: "rejected" }), W("3", [], {}), W("4", [M()], { verdict: "accepted" })]);
    assert.deepEqual(t, { waves: 4, accepted: 1, rejected: 1, need: 1, red: 1, empty: 1 });
});
