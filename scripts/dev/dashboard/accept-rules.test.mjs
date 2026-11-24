// Правила приёмки (accept-rules.mjs): разбор чек-листа, метки [iN] в выводе прогона, запись волны через повторные
// вливы, напоминания «ПОСЛЕ ВЫКАТА».
//   node --test scripts/dev/dashboard/accept-rules.test.mjs
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as R from "./accept-rules.mjs";

const CHK = "WV-0001\n```checklist\n- i1 | /orders | открыть список заказов | видна таблица из 3 строк | авто\n- i2 | /orders/new | отправить пустую форму | ошибка «Заполните имя» | руками\n- i2b | /orders/new | имя из 300 знаков | ошибка длины | auto\n```\nПрочее — руками.";

describe("чек-лист: строгий формат", () => {
    test("пять полей, id, «авто»/«руками»; текст вне блока не берётся", () => {
        const { items, errors } = R.parseChecklist(CHK);
        assert.deepEqual(errors, []);
        assert.deepEqual(items.map((x) => [x.id, x.how]), [["i1", "auto"], ["i2", "manual"], ["i2b", "auto"]]);
        assert.deepEqual(items[0], { id: "i1", where: "/orders", todo: "открыть список заказов", expect: "видна таблица из 3 строк", how: "auto", state: "todo", comment: "" });
    });
    test("без блока checklist — ничего, с причиной", () => {
        const r = R.parseChecklist("- i1 | / | x | y | авто");
        assert.deepEqual(r.items, []);
        assert.match(r.errors[0], /нет блока/);
    });
    test("кривые строки — в ошибки, годные — в пункты; повтор id не берётся; «|» внутри ожидаемого сохраняется", () => {
        const r = R.parseChecklist("```checklist\n- i1 | / | x | y | авто\n- шаг без id | a | b | c | авто\n- i2 | / | x | авто\n- i3 | / | x | y | может быть\n- i1 | / | снова | z | руками\n- i4 | / | x | a | b | руками\n```");
        assert.deepEqual(r.items.map((x) => x.id), ["i1", "i4"]);
        assert.equal(r.items[1].expect, "a | b");
        assert.equal(r.errors.length, 4);
        assert.match(r.errors.join("\n"), /без id/);
        assert.match(r.errors.join("\n"), /i2: нужно пять полей/);
        assert.match(r.errors.join("\n"), /i3: последнее поле/);
        assert.match(r.errors.join("\n"), /i1: такой пункт уже есть/);
    });
    test("просьба к агенту описывает формат и метки; без команды приёмки — всё «руками»", () => {
        const w = { tag: "П1", key: "wv0001-a", wave: "WV-0001" };
        const t = R.acceptAskText(w, { specs: ["e2e/wv-0001.accept.spec.ts"], standUrl: "https://stand.example.com", runnable: true });
        assert.match(t, /```checklist/);
        assert.match(t, /\[iN\]/);
        assert.match(t, /stand\.example\.com/);
        assert.match(t, /wv-0001\.accept\.spec\.ts/);
        assert.match(R.acceptAskText(w, {}), /все пункты — «руками»/);
        assert.doesNotMatch(t, /по вагону/, "у обычной волны шапки вагона нет");
    });
    test("вагон поезда: просьба называет вагон, ответ про другой вагон не принимается", () => {
        const h = R.wagonAskHead({ wave: "WV-0007", title: "WV-0007 Поиск", merge: { sha: "abcdef1234567" } });
        assert.match(h, /по вагону WV-0007 \(«Поиск»\)/);
        assert.match(h, /коммитом abcdef1234/);
        assert.equal(R.checklistForWave("WV-0007\n" + CHK, "WV-0007").ok, true);
        assert.match(R.checklistForWave("WV-0008: чек-лист", "WV-0007").why, /начинается с WV-0008, а спрашивали WV-0007/);
        assert.equal(R.checklistForWave("без номера", "WV-0007").ok, false);
        assert.equal(R.checklistForWave("любой", "").ok, true);
    });
});

describe("вывод прогона: метки [iN] → пункты", () => {
    test("строки разных раннеров: ✓/✘/×/✕, PASSED/FAILED, пропуск", () => {
        const cases = [
            ["  ✓  1 [chromium] › e2e/wv-0001.accept.spec.ts:5:3 › [i1] список заказов (1.2s)", "ok"],
            ["  ✘  2 [chromium] › e2e/wv-0001.accept.spec.ts:9:3 › [i2] пустая форма (3.4s)", "bad"],
            ["    ✓ [i1] список заказов (5 ms)", "ok"],
            ["    ✕ [i2] пустая форма (12 ms)", "bad"],
            [" × e2e/wv-0001.spec.ts > [i3] длина имени", "bad"],
            ["tests/test_orders.py::test_list[i1] PASSED   [ 50%]", "ok"],
            ["tests/test_orders.py::test_form[i2] FAILED   [100%]", "bad"],
            ["  -  3 [chromium] › e2e/a.spec.ts:12:3 › [i4] позже", "skip"],
            ["    ○ skipped [i5] позже", "skip"],
            ["  ● [i2] пустая форма", "bad"],
            ["ошибка в шаге [i2]: ожидалось «Заполните имя»", ""],
            ["  ✓ без метки", ""],
        ];
        for (const [l, st] of cases)
            assert.equal(R.lineStatus(l), st, l);
    });
    test("волна строки — по номеру в имени файла, при одной волне — она; итог по пункту — худший; повтор после ✗ — «flaky»", () => {
        const out = [
            "  ✓  1 › e2e/wv-0001.accept.spec.ts:5:3 › [i1] список",
            "  ✘  2 › e2e/wv-0002.accept.spec.ts:5:3 › [i1] поиск",
            "  ✓  3 › e2e/wv-0002.accept.spec.ts:5:3 › [i1] поиск (retry #1)",
            "  ✓  4 › e2e/wv-0001.accept.spec.ts:9:3 › [i2] форма",
            "  ✘  5 › e2e/wv-0001.accept.spec.ts:9:3 › [i2] форма, мобильный вид",
            "  ✓  6 › e2e/wv-0003.accept.spec.ts:1:1 › [i1] чужая волна",
        ].join("\n");
        const r = R.parseAcceptOutput(out, ["WV-0001", "WV-0002"]);
        const by = Object.fromEntries(r.map((x) => [x.wave + " " + x.id, x.st]));
        assert.deepEqual(by, { "WV-0001 i1": "ok", "WV-0002 i1": "flaky", "WV-0001 i2": "bad", "WV-0003 i1": "ok" });
        const one = R.parseAcceptOutput("    ✓ [i1] список (5 ms)\n    ✕ [i2] форма", ["wv-0009"]);
        assert.deepEqual(one.map((x) => [x.wave, x.id, x.st, x.title]), [["WV-0009", "i1", "ok", "[i1] список"], ["WV-0009", "i2", "bad", "[i2] форма"]]);
    });
    test("итоги на пункты: худший остаётся, тест без пункта — «без пункта», перепрогон одного пункта не трогает другие", () => {
        const e = { items: R.parseChecklist(CHK).items };
        const s = R.applyResults(e, [{ id: "i1", st: "ok", title: "[i1] a" }, { id: "i2", st: "bad", title: "[i2] b" }, { id: "i9", st: "ok", title: "[i9] лишний" }], { job: "j1", at: 1 });
        assert.deepEqual(s, { ok: 2, bad: 1, skip: 0, stray: 1 });
        assert.equal(e.items[0].auto.st, "ok");
        assert.equal(e.items[1].auto.st, "bad");
        assert.equal(e.items[2].auto, undefined);
        assert.deepEqual(e.autoStray.map((a) => a.title), ["[i9] лишний"]);
        R.applyResults(e, [{ id: "i2", st: "ok", title: "[i2] b" }], { job: "j2", at: 2, only: ["i2"] });
        assert.equal(e.items[1].auto.st, "ok");
        assert.equal(e.items[0].auto.job, "j1", "i1 не гонялся — прежний итог");
        assert.deepEqual(e.autoRun, { job: "j2", at: 2 });
    });
    test("итоги, пришедшие раньше чек-листа, ложатся на пункты по меткам (и подпункт i2b)", () => {
        const e = { items: R.parseChecklist(CHK).items, autoStray: [{ st: "bad", title: "[i2b] длина", job: "j1", at: 2 }, { st: "ok", title: "служебный тест", job: "j1", at: 3 }] };
        assert.equal(R.accRestray(e), true);
        assert.equal(e.items[2].auto.st, "bad");
        assert.equal(e.autoStray.length, 1);
    });
    test("метки для перепрогона части пунктов и спеки волны по номеру в пути", () => {
        assert.equal(R.itemsGrep(["i1", "i3", "i1"]), "\\[i1\\]|\\[i3\\]");
        assert.ok(new RegExp(R.itemsGrep(["i1", "i3"])).test("[i3] форма"));
        assert.deepEqual(R.specsForWave(["e2e/wv-0001.accept.spec.ts", "e2e/wv0001-extra.accept.spec.ts", "e2e/wv-0010.accept.spec.ts", "e2e/common.accept.spec.ts"], "WV-0001"), ["e2e/wv-0001.accept.spec.ts", "e2e/wv0001-extra.accept.spec.ts"]);
        assert.deepEqual(R.specsForWave(["a"], ""), []);
    });
});

describe("запись приёмки волны через повторные вливы", () => {
    const items = (st = {}) => R.parseChecklist(CHK).items.map((x) => ({ ...x, state: st[x.id] || "todo" }));
    const pfOf = (m) => (s) => m[s];
    test("ключ — по самому раннему вливу; уже заведённая запись находится и по учтённым ею вливам", () => {
        assert.equal(R.accBaseKey({}, "w", ["c", "b", "a"]), "w|a");
        assert.equal(R.accBaseKey({ "w|old": { merges: ["old", "a"] } }, "w", ["b", "a"]), "w|old");
        assert.equal(R.accBaseKey({ "w-x|a": { merges: ["a"] } }, "w", ["a"]), "w|a", "чужая волна с похожим ключом не берётся");
        assert.equal(R.accBaseKey({}, "w", []), "w|");
    });
    test("новый влив с кодом продукта снимает вердикт «на разбор», отметки остаются с пометкой", () => {
        const acc = { "w|a": { ...R.accFresh("w", ["a"]), items: items({ i1: "ok", i2: "bad" }), verdict: "rejected", sentAt: 5 } };
        const r = R.accAdvance(acc, "w", ["b", "a"], pfOf({ b: ["src/orders.ts"] }), 1000);
        const e = acc[r.key];
        assert.equal(r.changed, true);
        assert.equal(e.verdict, null);
        assert.equal(e.sentAt, null);
        assert.deepEqual({ sha: e.reopened.sha, prev: e.reopened.prev, n: e.reopened.n, marked: e.reopened.marked }, { sha: "b", prev: "rejected", n: 1, marked: 2 });
        assert.equal(e.items[0].before, "b");
        assert.equal(e.items[2].before, undefined);
        assert.equal(R.accAdvance(acc, "w", ["b", "a"], pfOf({ b: ["src/orders.ts"] })).changed, false, "идемпотентно");
    });
    test("влив только тестов после «принято» приёмку не трогает; git не ответил — обход ждёт", () => {
        const acc = { "w|a": { ...R.accFresh("w", ["a"]), items: items({ i1: "ok" }), verdict: "accepted", sentAt: 9 } };
        R.accAdvance(acc, "w", ["c", "b", "a"], pfOf({ b: [] }));
        assert.equal(acc["w|a"].verdict, "accepted");
        assert.deepEqual(acc["w|a"].merges, ["a", "b"], "c ещё не посчитан");
    });
    test("автозакрытие — только если ни один влив не трогал код продукта и вердикта не было", () => {
        assert.equal(R.accAutoCloseDue(undefined, ["x", "y"], pfOf({ x: [], y: [] })), true);
        assert.equal(R.accAutoCloseDue({}, ["x", "y"], pfOf({ x: [], y: ["src/a.ts"] })), false);
        assert.equal(R.accAutoCloseDue({}, ["x", "y"], pfOf({ x: [] })), false, "не всё известно");
        assert.equal(R.accAutoCloseDue({ verdict: "rejected" }, ["x"], pfOf({ x: [] })), false);
        assert.equal(R.accAutoCloseDue({ prod: true }, ["x"], pfOf({ x: [] })), false);
    });
});

describe("итоги и напоминания", () => {
    test("письмо агенту: «не принято» — его плохие пункты и комментарий; «принято» — подтверждение", () => {
        const e = { verdict: "rejected", comment: "форма", items: items2() };
        const t = R.verdictText({ tag: "П1", merge: { sha: "abcdef12345" } }, e);
        assert.match(t, /НЕ ПРИНЯТО \(П1, влив abcdef1234\)/);
        assert.match(t, /\[i2\] \/orders\/new/);
        assert.match(R.verdictText({ tag: "П1" }, { verdict: "accepted", items: [] }), /ПРИНЯТО \(П1\)/);
        assert.match(R.summaryText([{ tag: "П1", title: "заказы" }], [{ tag: "П2", comment: "" }]), /Принято: П1 заказы[\s\S]*П2 — см\. пункты/);
    });
    test("строки «ПОСЛЕ ВЫКАТА»: что :: задача; «делать нечего» без команды — не напоминание", () => {
        const r = R.reminderLines("Готово.\nПОСЛЕ ВЫКАТА: засеять демо-данные :: seed-stand\n> ПОСЛЕ ВЫКАТА СТЕНДА: проверить письма\nПОСЛЕ ВЫКАТА: ничего не нужно\nПОСЛЕ ВЫКАТА: ok");
        assert.deepEqual(r, [{ what: "засеять демо-данные", cmd: "seed-stand" }, { what: "проверить письма", cmd: "" }]);
    });
    test("с кнопки — только задача проекта без ввода", () => {
        const re = R.remCmdRe({ seed: { id: "seed", input: null }, "api-test": { id: "api-test", input: { label: "x" } } });
        assert.ok(re.test("seed"));
        assert.equal(re.test("api-test"), false);
        assert.equal(re.test("seed; rm -rf /"), false);
        assert.equal(R.remCmdRe({}).test(""), false);
    });
});

function items2() {
    return R.parseChecklist(CHK).items.map((x) => ({ ...x, state: x.id === "i2" ? "bad" : "ok" }));
}

test("правила подтягивания staging живут в sync-rules.mjs, а не в модуле приёмки (ядро не зависит от приёмки)", () => {
    for (const k of ["conflictNext", "dirtyBlockers", "inEpic", "isSyncAsk", "parseSync", "syncConflictText", "syncDirtyText"])
        assert.equal(R[k], undefined, k);
});
