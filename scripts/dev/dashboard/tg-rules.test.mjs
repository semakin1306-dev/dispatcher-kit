// Правила бота в Telegram (tg-rules.mjs): вопросы только для дашборда, сообщения и кнопки, проверка нажатия и
// отправителя, отступ при сбое сети, строка состояния. Полномочия слова — tg-word.test.mjs.
//   node --test scripts/dev/dashboard/tg-rules.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as R from "./tg-rules.mjs";

test("вопросы про выкат, прод, сброс и «принудительно» — только на дашборде; обычные — в бот", () => {
    for (const s of ["Выкатить staging на стенд?", "Выкатываем в прод сегодня?", "(а) влить ПРИНУДИТЕЛЬНО", "Релиз 2.8.0 — сейчас?", "push в main", "сделать --force", "Деплой сервиса отчётов?", "на проде упало — откатить?", "Сбросить ветку слота?"])
        assert.ok(R.needsDashboard(s), s);
    for (const s of ["Влить П2 в staging?", "Продолжить работу по плану?", "Заводить четвёртую волну?", "продукт или продавец?", "domain mainframe", "Принять на стенде чек-лист?"])
        assert.equal(R.needsDashboard(s), false, s);
});

test("тексты бота не обещают из Telegram того, чего слово из бота не даёт", () => {
    assert.match(R.BOT_ABOUT, /только на дашборде/);
    assert.match(R.statusText("no-token").text, /node scripts\/dev\/tg-setup\.mjs/);
});

const CARD = "1. Влить П2 в staging сейчас?\n(а) Да, вливать\n(б) Подождать П3 — рекомендую\n2. Порт сервера?\n(а) 8791\n(б) 8792";

test("вопросы карточки: разбор как у страницы, рекомендованный первым", () => {
    const qs = R.cardQuestions(CARD);
    assert.equal(qs.length, 2);
    assert.equal(qs[0].head, "Влить П2 в staging сейчас?");
    assert.deepEqual(qs[0].options.map((o) => o.k), ["б", "а"], "рекомендованный — первым");
    assert.ok(qs[0].options[0].rec);
    const one = R.cardQuestions("Как назвать модуль?");
    assert.equal(one.length, 1);
    assert.deepEqual(one[0].options, []);
});

test("сообщение вопроса: текст с пометкой «рекомендую», кнопка на вариант, «ответить текстом»; выбор отмечается", () => {
    const qs = R.cardQuestions(CARD), m = R.questionMessage({ who: "Оркестратор · эпик e1", qs });
    assert.match(m.text, /^❓ Оркестратор · эпик e1/);
    assert.match(m.text, /★ \(б\) Подождать П3 — рекомендую/);
    assert.equal(m.buttons.length, 5, "4 варианта + строка «текстом»");
    assert.deepEqual(m.buttons[0][0].act, { kind: "opt", n: "1", k: "б" });
    assert.match(m.buttons[0][0].text, /^1 · ★ \(б\)/);
    assert.deepEqual(m.buttons[4].map((b) => b.act.kind), ["text"], "«отправить выбранное» — только когда что-то выбрано");
    const p = R.questionMessage({ who: "x", qs, picks: { 1: "а" } });
    assert.match(p.text, /✔ \(а\) Да, вливать/);
    assert.deepEqual(p.buttons[4].map((b) => b.act.kind), ["text", "send"]);
    const d = R.questionMessage({ who: "x", qs: R.cardQuestions("Выкатить в прод?\n(а) да\n(б) нет"), dashOnly: true });
    assert.deepEqual(d.buttons, [], "только для дашборда — без кнопок действия");
    assert.match(d.text, /^⚠️ Нужно решение на дашборде/);
    const long = R.questionMessage({ who: "x", qs: R.cardQuestions("1. " + "очень длинный вопрос ".repeat(400)) });
    assert.ok(long.text.length <= 3800);
});

test("ответ из выбранного и текста — вид формы страницы; все ли выбраны", () => {
    const qs = R.cardQuestions(CARD);
    assert.equal(R.composeTgAnswer(qs, { 1: "б", 2: "а" }).text, "Вопрос 1: (б) Подождать П3\nВопрос 2: (а) 8791");
    assert.equal(R.composeTgAnswer(qs, { 1: "б" }, "порт любой").text, "Вопрос 1: (б) Подождать П3\n\nпорт любой");
    assert.equal(R.composeTgAnswer(qs, {}, "").text, "");
    assert.ok(R.allPicked(qs, { 1: "б", 2: "а" }));
    assert.equal(R.allPicked(qs, { 1: "б" }), false);
    assert.equal(R.allPicked(qs, { 1: "б", 2: "я" }), false);
    assert.match(R.answeredMessage("П2", "Вопрос 1: (а) да", "tg"), /Отвечено из Telegram/);
    assert.match(R.answeredMessage("П2", "x", "dashboard"), /на дашборде/);
});

test("кнопка: короткий id ≤ 64 байт; повтор, устаревшая, уже отвеченный — вежливый отказ", () => {
    let i = 0;
    const id = R.buttonId((n) => Array.from({ length: n }, () => i++ * 7));
    assert.match(id, R.CB_RE);
    assert.ok(Buffer.byteLength(id) <= 64);
    const now = 1e12, btn = { kind: "opt", at: now - 1000 };
    assert.deepEqual(R.buttonCheck(btn, { now, open: true }), { ok: true });
    assert.match(R.buttonCheck(null, { now }).text, /не найдена/);
    assert.match(R.buttonCheck({ ...btn, used: true }, { now }).text, /Уже принято/);
    assert.match(R.buttonCheck({ ...btn, at: now - R.TG_BUTTON_TTL_MS - 1 }, { now }).text, /устарела/);
    assert.match(R.buttonCheck(btn, { now, open: false }).text, /уже ответили/);
    assert.match(R.buttonCheck({ kind: "merge", at: now }, { now, open: false }).text, /не готова к вливу/);
});

test("отправитель: только закреплённые chat_id и user id", () => {
    const meta = { chatId: 100, userId: 7 };
    const msg = (chat, from) => ({ message: { chat: { id: chat }, from: { id: from }, text: "x" } });
    assert.ok(R.senderOk(msg(100, 7), meta).ok);
    assert.equal(R.senderOk(msg(100, 8), meta).ok, false, "чужой в том же чате (группа)");
    assert.equal(R.senderOk(msg(101, 7), meta).ok, false, "свой, но из другого чата");
    assert.ok(R.senderOk({ callback_query: { from: { id: 7 }, message: { chat: { id: 100 } } } }, meta).ok);
    assert.equal(R.senderOk({ callback_query: { from: { id: 7 } } }, meta).ok, false, "нажатие без сообщения — не принимаем");
    assert.equal(R.senderOk(msg(100, 7), null).ok, false, "не закреплено — не принимаем ничего");
    assert.ok(R.senderOk(msg("100", "7"), meta).ok, "строка и число — одно и то же");
});

test("сбои: 409 — 5 мин, токен — 30 мин, 429 — по retry_after, сеть — с отступом до 5 мин", () => {
    assert.equal(R.failKind({ tgCode: 409 }), "conflict");
    assert.equal(R.failKind({ tgCode: 401 }), "auth");
    assert.equal(R.failKind({ tgCode: 404 }), "auth");
    assert.equal(R.failKind({ tgCode: 429 }), "rate");
    assert.equal(R.failKind({ tgCode: 400 }), "api");
    assert.equal(R.failKind(new Error("ECONNRESET")), "net");
    assert.equal(R.backoffMs("conflict"), 300000);
    assert.equal(R.backoffMs("auth"), 1800000);
    assert.equal(R.backoffMs("rate", 1, 7), 7000);
    assert.deepEqual([1, 2, 3, 4].map((n) => R.backoffMs("net", n)), [5000, 10000, 20000, 40000]);
    assert.equal(R.backoffMs("net", 30), 300000);
});

test("строка состояния и вычистка токена", () => {
    assert.equal(R.statusText("ok").text, "подключён");
    assert.equal(R.statusText("conflict").warn, true);
    assert.match(R.statusText("net", "ECONNREFUSED").text, /нет сети.*ECONNREFUSED/);
    assert.equal(R.redact("POST /bot123:ABC/getUpdates упал", "123:ABC"), "POST /bot<токен>/getUpdates упал");
    assert.equal(R.redact("x", null), "x");
});
