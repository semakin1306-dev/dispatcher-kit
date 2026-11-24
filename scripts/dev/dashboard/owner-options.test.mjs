import { test } from "node:test";
import assert from "node:assert/strict";
import { answerText, composeAnswers, optPrefix, ownerQuestions, questionsKey, quickOptions, recommended } from "./owner-options.mjs";

test("10.11: форма — все ответы одним сообщением; свой текст сильнее пилюли; неотвеченные названы; комментарий в конце", () => {
    const r = composeAnswers([
        { n: "1", picked: "Вопрос 1: (а) Влить П1", custom: "" },
        { n: "2", picked: "Вопрос 2: (б) Только гард", custom: "  заводи, но автоприёмку в бэклог " },
        { n: "3", picked: "", custom: "" },
    ], "и проверь security:check");
    assert.equal(r.text, "Вопрос 1: (а) Влить П1\nВопрос 2: заводи, но автоприёмку в бэклог\n\nи проверь security:check");
    assert.deepEqual(r.answered, ["1", "2"]);
    assert.deepEqual(r.missing, ["3"]);
    assert.equal(composeAnswers([{ n: "1" }]).text, "");
    const a = ownerQuestions("Вопросы владельцу:\n1. Влить?\n   (а) да"), b = ownerQuestions("Вопросы владельцу:\n1. Заводить волну?\n   (а) да");
    assert.notEqual(questionsKey(a), questionsKey(b));
    assert.equal(questionsKey(a), questionsKey(ownerQuestions("Вопросы владельцу:\n1. Влить?\n   (б) нет")));
});

const turn = (body) => "Сделал то-то.\n\nВопросы владельцу:\n" + body + "\n\nДальше: жду ответа.";

test("варианты строками — сколько угодно, рекомендованный по «— рекомендую», голова вопроса без вариантов", () => {
    const [q] = ownerQuestions(turn("1. Заводить ли четвёртую волну после влива П1, П2 и П3?\n   (а) Одна волна через /new-slot: гард, parts.mjs, автоприёмка — рекомендую\n   (б) Сейчас только гард и parts.mjs, автоприёмку — в бэклог\n   (в) Не заводить\n   (г) Отложить до закрытия эпика\n   (д) Разбить на две волны"));
    assert.equal(q.head, "Заводить ли четвёртую волну после влива П1, П2 и П3?");
    assert.deepEqual(q.options.map((o) => o.k), ["а", "б", "в", "г", "д"]);
    assert.equal(q.options[0].v, "Одна волна через /new-slot: гард, parts.mjs, автоприёмка");
    assert.equal(recommended(q).k, "а");
    assert.equal(q.options.filter((o) => o.rec).length, 1);
});

test("тире-маркеры списка, «(рекомендую)» и ★, латинские буквы; пустая строка между вопросами не обрывает раздел", () => {
    const qs = ownerQuestions(turn("1. Как назвать кнопку?\n- (a) «Подключить» (рекомендую)\n- (b) «Включить»\n\n2. Порядок влива?\n   (а) П4, затем П5\n   (б) ★ П5, затем П4"));
    assert.equal(qs.length, 2);
    assert.deepEqual(qs[0].options.map((o) => [o.k, o.v, o.rec]), [["a", "«Подключить»", true], ["b", "«Включить»", false]]);
    assert.equal(recommended(qs[1]).v, "П5, затем П4");
});

test("старая строчная форма «(а) …; (б) …» и «Рекомендую (б)» в тексте понимаются по-прежнему", () => {
    const [q] = ownerQuestions(turn("1. Вливаем П3 → П9? Рекомендую (б). Варианты: (а) влить все четыре; (б) только П3 и П9; (в) пока не вливать."));
    assert.deepEqual(q.options.map((o) => o.k), ["а", "б", "в"]);
    assert.equal(recommended(q).k, "б");
    assert.equal(q.head, "Вливаем П3 → П9?");
});

test("нет вариантов у агента — пилюль нет (никаких «да, влей» по словам вопроса)", () => {
    const [q] = ownerQuestions(turn("1. Заводить ли четвёртую волну после влива П1, П2 и П3?"));
    assert.deepEqual(quickOptions(q), []);
    assert.equal(recommended(q), null);
    assert.deepEqual(quickOptions({ n: "1", text: "Можно вливать П11?" }), []);
});

test("ответ по пилюле и метка: «Вопрос 1: (б) …»; без раздела — пусто", () => {
    const [q] = ownerQuestions(turn("1. Цвет?\n   (а) синий\n   (б) зелёный"));
    assert.equal(answerText(q, q.options[1]), "Вопрос 1: (б) зелёный");
    assert.equal(optPrefix({ k: "да" }), "");
    assert.deepEqual(ownerQuestions("просто текст без раздела"), []);
});
