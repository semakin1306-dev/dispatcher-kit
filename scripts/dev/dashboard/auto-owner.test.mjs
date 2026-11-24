import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_OWNER_HOURS, autoAnswer, autoOwnerToggle } from "./auto-owner.mjs";

test("включение и выключение фразой владельца", () => {
    const now = 1e12;
    assert.equal(autoOwnerToggle("Ночной режим: доведи всё до стенда", now), now + AUTO_OWNER_HOURS * 3600e3);
    assert.equal(autoOwnerToggle("я спать, отвечай за меня", now), now + AUTO_OWNER_HOURS * 3600e3);
    assert.equal(autoOwnerToggle("я тут, стоп автоответ", now), 0);
    assert.equal(autoOwnerToggle("влей П3", now), null);
});

test("рекомендованный вариант берётся — строчная форма и варианты строками; без вариантов агента — не отвечаем (10.11: заготовки «да, влей» нет)", () => {
    const a = autoAnswer("1. Вливаем П3 → П9? Все закоммичены. Рекомендую (а). Варианты: (а) влить все четыре; (б) только П3 и П9; (в) пока не вливать.");
    assert.match(a.text, /Вопрос 1: \(а\) влить все четыре/);
    const b = autoAnswer("1. Заводить ли четвёртую волну после влива П1, П2 и П3?\n   (а) Одна волна через /new-slot — рекомендую\n   (б) Сейчас только гард\n   (в) Не заводить");
    assert.match(b.text, /Вопрос 1: \(а\) Одна волна через \/new-slot\./);
    assert.doesNotMatch(b.text, /влей/);
    assert.equal(autoAnswer("1. Можно вливать П11 в staging?"), null, "агент не дал вариантов — ждём владельца, а не отвечаем заготовкой");
});

test("деньги, оферта, права, прод — не трогаем; без рекомендации — тоже", () => {
    assert.equal(autoAnswer("1. Как показывать откат комиссии в «Моих финансах»? Рекомендую (а). Варианты: (а) со знаком минус; (б) отдельной строкой."), null);
    assert.equal(autoAnswer("1. Выкатываем в прод? Рекомендую (а). (а) да; (б) нет."), null);
    assert.equal(autoAnswer("1. Оставляем подпись кнопки как есть?"), null);
    const mixed = autoAnswer("1. Влить П5? Рекомендую (а). (а) влить; (б) подождать.\n2. Ставка партнёра 10% или 12%? Рекомендую (а). (а) 10%; (б) 12%.");
    assert.match(mixed.text, /Вопрос 1: \(а\) влить/);
    assert.deepEqual(mixed.skipped, ["2"]);
    assert.match(mixed.text, /Вопросы 2 ждут владельца/);
});
