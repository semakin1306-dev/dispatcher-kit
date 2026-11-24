// persona-protocol.test.mjs — образцовый ответ из персоны инженера слота разбирается регулярками диспетчерской:
// статус в заголовке (loops.mjs), просьбы к оркестратору (loops.mjs), «Вопросы владельцу» с вариантами-кнопками
// (owner-options.mjs), раздел прогонов, «СВОДКА:» и «ДАЛЬШЕ: …» (protocol.mjs — их же берёт relay.mjs).
// Правка персоны, которая ломает разбор, краснеет здесь.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SLOT_ASKS_RE, slotAsks, slotStatus } from "./loops.mjs";
import { ownerQuestions } from "./owner-options.mjs";
import { DECISION_RE, TESTS_HEAD_RE, decisionOf, summaryOf, waitsHead } from "./protocol.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERSONA = fs.readFileSync(path.join(HERE, "..", "..", "..", "agent-briefs", "SLOT-ENGINEER-persona.md"), "utf8");
const FENCE = "`".repeat(3);

/** Блок «ПРИМЕР ФОРМЫ» из персоны с подставленными значениями вместо <заглушек>. */
function sample() {
    const at = PERSONA.indexOf("ПРИМЕР ФОРМЫ");
    assert.ok(at > 0, "в персоне есть раздел «ПРИМЕР ФОРМЫ»");
    const m = new RegExp(FENCE + "text\\n([\\s\\S]*?)" + FENCE).exec(PERSONA.slice(at));
    assert.ok(m, "пример — блоком text");
    return m[1]
        .replace("<ВОЛНА>", "WV-0042").replace("<слот>", "П2")
        .replace("<вопрос о продукте одной строкой>", "Показывать цену со скидкой?")
        .replace("<вариант> — рекомендую", "да, зачёркнутая старая цена — рекомендую")
        .replace("<вариант>", "нет, только новая цена")
        .replace(/<[^>\n]+>/g, "текст");
}

test("персона: статусы, разделы и строка «Дальше:» названы словами, которые знает разбор", () => {
    for (const s of ["ГОТОВО", "ЧАСТИЧНО", "ЖДУ", "СТОП", "ВОПРОС"])
        assert.ok(PERSONA.includes(s), s);
    for (const h of ["Изменено:", "Не проверено:", "Тесты для запуска владельцем:", "Нужно от оркестратора:", "Вопросы:", "Вопросы владельцу:", "Дальше:"])
        assert.ok(PERSONA.includes("«" + h) || PERSONA.includes(h), h);
    for (const w of ["ПЕРЕПРОГОН", "ОРКЕСТРАТОРУ", "СЛОТУ", "ПРИНЯЛ", "ЖДУ"]) {
        assert.ok(PERSONA.includes(w), "персона называет решение " + w);
        assert.ok(DECISION_RE.source.includes(w), "разбор знает решение " + w);
    }
    assert.ok(PERSONA.includes("СВОДКА:"));
    assert.doesNotMatch(PERSONA, /Skill tool|VS Code|security:check|pnpm|apps\//, "в персоне нет стека и инструментов исходного проекта");
});

test("образец из персоны: статус, просьбы к оркестратору, вопрос владельцу с кнопками, раздел прогонов", () => {
    const body = sample();
    const head = body.split("\n")[0];
    assert.equal(head, "WV-0042 (слот П2): ГОТОВО.");
    assert.equal(slotStatus(body), "ГОТОВО");
    assert.ok(SLOT_ASKS_RE.test(body), "просьбы к оркестратору видны");
    const asks = slotAsks(body);
    assert.match(asks, /Нужно от оркестратора:/);
    assert.doesNotMatch(asks, /Дальше:/, "строка «Дальше:» в просьбы не попадает");
    const qs = ownerQuestions(body);
    assert.equal(qs.length, 1);
    assert.equal(qs[0].options.length, 2);
    assert.deepEqual(qs[0].options.map((o) => o.k), ["а", "б"]);
    assert.equal(qs[0].options.find((o) => o.rec).k, "а", "рекомендованный вариант помечен");
    assert.ok(TESTS_HEAD_RE.test(body), "раздел прогонов найден");
    assert.equal(waitsHead(body), false);
});

test("каждый статус заголовка разбирается; «ЖДУ» — отдельно от слова, которое с него начинается", () => {
    for (const s of ["ГОТОВО", "ЧАСТИЧНО", "ЖДУ", "СТОП", "ВОПРОС"])
        assert.equal(slotStatus("WV-0042 (слот П2): " + s + ".\n\nФакты."), s);
    assert.equal(waitsHead("WV-0042 (слот П2): ЖДУ.\n"), true);
    assert.equal(waitsHead("WV-0042 (слот П2): ЖДУЩИЙ"), false);
});

test("после итога прогонов: «СВОДКА:» и «ДАЛЬШЕ: …» в конце ответа", () => {
    const body = sample() + "\nСВОДКА: экран цены готов, осталась приёмка.\nДАЛЬШЕ: ПРИНЯЛ";
    assert.equal(summaryOf(body), "экран цены готов, осталась приёмка.");
    assert.deepEqual(decisionOf(body), { word: "ПРИНЯЛ", to: "" });
    assert.deepEqual(decisionOf("...\nДАЛЬШЕ: **СЛОТУ П3**"), { word: "СЛОТУ", to: "П3" });
    assert.deepEqual(decisionOf("ДАЛЬШЕ: перепрогон"), { word: "ПЕРЕПРОГОН", to: "" });
    assert.equal(decisionOf("ДАЛЬШЕ: ПРИНЯЛ\n1\n2\n3\n4\n5\n6"), null, "решение ищется только в последних строках");
    assert.equal(decisionOf(sample()), null, "строка «Дальше: …» доклада — не решение");
});
