// Бот в Telegram (tg.mjs): поток «карточка вопроса → сообщение с кнопками → ответ в сессию агента», дедуп, чужой
// отправитель, повторное нажатие, ответ текстом, ответ со страницы, вопрос только для дашборда, «Влить в staging».
// Сеть подменная: настоящий Telegram не нужен, единственный сервер — поддельный прокси на 127.0.0.1.
//   node --test scripts/dev/dashboard/tg.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-tg-"));
process.env.DASH_DATA = TMP;
process.env.DASH_DRY = "1";
const T = await import("./tg.mjs");
const { failKind } = await import("./tg-rules.mjs");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const META = { chatId: 100, userId: 7 };

function harness({ cards = [], ready = [] } = {}) {
    const calls = [], answers = [], merges = [], logs = [];
    let mid = 500, t = 1e12, seq = 0;
    const h = { cards, ready, calls, answers, merges, logs, answerCode: 200 };
    h.bot = T.createTgBot({
        api: async (method, params) => {
            calls.push({ method, params });
            return method === "sendMessage" ? { message_id: ++mid } : method === "getUpdates" ? (h.updates || []).splice(0) : true;
        },
        now: () => t, store: {}, save: () => { }, meta: () => META, rnd: (n) => Array.from({ length: n }, () => (seq += 13) % 251),
        cards: () => h.cards, who: (k) => "Оркестратор · эпик " + k, readyMerges: () => h.ready,
        ownerAnswer: async (tree, text, id) => {
            answers.push({ tree, text, id });
            if (h.answerCode === 200)
                h.cards = h.cards.filter((c) => c.id !== id);
            return h.answerCode === 200 ? { code: 200, body: { ok: true } } : { code: 404, body: { error: "вопроса уже нет" } };
        },
        merge: async (slot) => {
            merges.push(slot);
            return { code: 200, body: { id: "j901" } };
        },
        log: (type, data) => logs.push({ type, ...data }),
    });
    h.tick = (ms) => {
        t += ms;
    };
    h.sent = () => calls.filter((c) => c.method === "sendMessage");
    h.edits = () => calls.filter((c) => c.method === "editMessageText");
    h.acks = () => calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.params.text);
    h.press = (data, from = 7, chat = 100) => h.bot.handle({ update_id: 1, callback_query: { id: "cq" + calls.length, data, from: { id: from }, message: { chat: { id: chat }, message_id: 1 } } });
    h.say = (text, extra = {}) => h.bot.handle({ update_id: 2, message: { message_id: 900 + calls.length, chat: { id: 100 }, from: { id: 7 }, text, ...extra } });
    h.btn = (i, j = 0) => h.sent()[i].params.reply_markup.inline_keyboard[j][0].callback_data;
    return h;
}

const card = (id, text, tree = "orchestrator@e1", at = 1e12) => ({ id, kind: "ownerq", tree, text, at });
const Q1 = "1. Влить П2 в staging сейчас?\n(а) Да, влей\n(б) Подождать П3 — рекомендую";

test("новый вопрос → сообщение с кнопками (рекомендованный первым); повторная сверка и тот же вопрос заново — без второго сообщения", async () => {
    const h = harness({ cards: [card("ib1", Q1)] });
    await h.bot.sync();
    assert.equal(h.sent().length, 1);
    const m = h.sent()[0].params;
    assert.equal(m.chat_id, 100);
    assert.match(m.text, /★ \(б\) Подождать П3 — рекомендую/);
    assert.match(m.reply_markup.inline_keyboard[0][0].text, /^★ \(б\)/);
    assert.match(m.reply_markup.inline_keyboard[0][0].callback_data, /^t[0-9a-z]{10}$/);
    await h.bot.sync();
    assert.equal(h.sent().length, 1, "дедуп по карточке");
    h.cards = [card("ib2", Q1)];
    await h.bot.sync();
    assert.equal(h.sent().length, 1, "агент задал тот же вопрос новым ходом — то же сообщение");
    assert.equal(h.edits().length, 0);
    h.cards = [card("ib3", "1. Другой вопрос?\n(а) да\n(б) нет")];
    await h.bot.sync();
    assert.equal(h.sent().length, 2, "новый вопрос — новое сообщение");
    assert.match(h.edits()[0].params.text, /снят без ответа/, "прежний снят");
    assert.ok(h.logs.some((l) => l.type === "tg.sent" && l.tree === "orchestrator@e1"));
});

test("нажатие варианта → ответ в сессию агента (тот же путь, что страница); повтор — вежливый отказ; чужой — нет доступа", async () => {
    const h = harness({ cards: [card("ib1", Q1)] });
    await h.bot.sync();
    const b = h.btn(0);
    await h.press(b, 8);
    assert.equal(h.answers.length, 0, "чужой user id — не принимаем");
    assert.deepEqual(h.acks(), ["Нет доступа."]);
    assert.ok(h.logs.some((l) => l.type === "tg.reject"));
    await h.press(b, 7, 555);
    assert.equal(h.answers.length, 0, "свой, но из чужого чата — не принимаем");
    await h.press(b);
    assert.deepEqual(h.answers, [{ tree: "orchestrator@e1", text: "Вопрос 1: (б) Подождать П3", id: "ib1" }]);
    assert.match(h.edits().at(-1).params.text, /✅[\s\S]*Отвечено из Telegram:\nВопрос 1: \(б\) Подождать П3/);
    assert.equal(h.edits().at(-1).params.reply_markup, undefined, "кнопки сняты");
    await h.press(b);
    assert.equal(h.answers.length, 1);
    assert.match(h.acks().at(-1), /Уже принято/);
    await h.press("t0000000000");
    assert.match(h.acks().at(-1), /не найдена/);
    await h.press("../../evil");
    assert.match(h.acks().at(-1), /не найдена/);
});

test("несколько вопросов: выбор копится, ответ уходит одним сообщением, когда выбраны все", async () => {
    const h = harness({ cards: [card("ib1", Q1 + "\n2. Порт сервера?\n(а) 8791\n(б) 8792")] });
    await h.bot.sync();
    await h.press(h.btn(0, 0));
    assert.equal(h.answers.length, 0);
    assert.match(h.acks().at(-1), /Осталось: 2/);
    assert.match(h.edits().at(-1).params.text, /✔ ★ \(б\)/);
    await h.press(h.btn(0, 0));
    assert.match(h.acks().at(-1), /Уже выбрано/);
    await h.press(h.btn(0, 3));
    assert.equal(h.answers.length, 1);
    assert.equal(h.answers[0].text, "Вопрос 1: (б) Подождать П3\nВопрос 2: (б) 8792");
});

test("ответ текстом: кнопка → следующее сообщение; reply на сообщение вопроса; без привязки — подсказка", async () => {
    const h = harness({ cards: [card("ib1", Q1, "orchestrator@e1"), card("ib2", "Как назвать модуль?", "wv1-a")] });
    await h.bot.sync();
    await h.say("просто текст");
    assert.match(h.sent().at(-1).params.text, /Не понял, к какому вопросу/);
    assert.equal(h.answers.length, 0);
    const textBtn = h.sent()[0].params.reply_markup.inline_keyboard.at(-1)[0].callback_data;
    await h.press(textBtn);
    assert.match(h.sent().at(-1).params.text, /напишите его следующим сообщением/);
    assert.ok(h.sent().at(-1).params.reply_markup.force_reply);
    await h.say("влей П2, но после П3");
    assert.deepEqual(h.answers[0], { tree: "orchestrator@e1", text: "влей П2, но после П3", id: "ib1" });
    await h.say("reply-ответ", { reply_to_message: { message_id: 502 } });
    assert.deepEqual(h.answers[1], { tree: "wv1-a", text: "reply-ответ", id: "ib2" });
    await h.say("ещё раз", { reply_to_message: { message_id: 502 } });
    assert.equal(h.answers.length, 2);
    assert.match(h.sent().at(-1).params.text, /уже ответили/);
});

test("ответ со страницы — сообщение правится «на дашборде», кнопка после этого — отказ; снятый вопрос — «снят»", async () => {
    const h = harness({ cards: [card("ib1", Q1), card("ib2", "1. Ещё?\n(а) да", "wv1-a")] });
    await h.bot.sync();
    h.cards = h.cards.filter((c) => c.id !== "ib1");
    await h.bot.answered({ id: "ib1", tree: "orchestrator@e1", text: "Вопрос 1: (а) Да, влей", via: "dashboard" });
    assert.match(h.edits().at(-1).params.text, /Отвечено на дашборде:\nВопрос 1: \(а\) Да, влей/);
    await h.press(h.btn(0));
    assert.equal(h.answers.length, 0);
    assert.match(h.acks().at(-1), /Уже принято|уже ответили/);
    h.cards = [];
    await h.bot.sync();
    assert.match(h.edits().at(-1).params.text, /снят без ответа/);
    await h.press(h.btn(1));
    assert.equal(h.answers.length, 0);
});

test("вопрос про выкат/прод/«принудительно» — уведомление без кнопок, текстовый ответ из бота не принимается", async () => {
    const h = harness({ cards: [card("ib1", "1. Выкатить staging на стенд и в прод?\n(а) да — рекомендую\n(б) нет")] });
    await h.bot.sync();
    const m = h.sent()[0].params;
    assert.equal(m.reply_markup, undefined, "без кнопок действия");
    assert.match(m.text, /Нужно решение на дашборде/);
    await h.say("да, выкатывай", { reply_to_message: { message_id: 501 } });
    assert.equal(h.answers.length, 0);
    assert.match(h.sent().at(-1).params.text, /только на дашборде/);
});

test("«Влить в staging»: сообщение по готовой ветке один раз; нажатие — влив тем же путём; не готова — отказ", async () => {
    const h = harness({ ready: [{ mkey: "wv1-a|dev/wv-1|abc", slot: "wv1-a", who: "П2 · эпик e1" }] });
    await h.bot.sync();
    await h.bot.sync();
    assert.equal(h.sent().length, 1);
    assert.match(h.sent()[0].params.text, /Готово к вливу в staging/);
    const b = h.btn(0);
    await h.press(b);
    assert.deepEqual(h.merges, ["wv1-a"]);
    assert.match(h.edits().at(-1).params.text, /Влив поставлен в очередь \(j901\)/);
    await h.press(b);
    assert.deepEqual(h.merges, ["wv1-a"], "повтор не вливает второй раз");
    const g = harness({ ready: [{ mkey: "k2", slot: "wv2-b", who: "П3" }] });
    await g.bot.sync();
    g.ready = [];
    await g.press(g.btn(0));
    assert.deepEqual(g.merges, []);
    assert.match(g.acks().at(-1), /не готова к вливу/);
});

test("опрос: offset двигается, обновления разбираются по одному", async () => {
    const h = harness({ cards: [card("ib1", Q1)] });
    await h.bot.sync();
    h.updates = [{ update_id: 41, message: { message_id: 1, chat: { id: 100 }, from: { id: 7 }, text: "/status" } }];
    assert.equal(await h.bot.poll(true), 1);
    assert.equal(h.bot.store.offset, 42);
    assert.match(h.sent().at(-1).params.text, /Открытых вопросов: 1/);
    await h.bot.poll();
    assert.equal(h.calls.filter((c) => c.method === "getUpdates").at(-1).params.offset, 42);
});

test("сеть: прокси не отвечает или отказывает — сетевой сбой, в тексте ошибки нет токена; наружу не ходим", async () => {
    const token = "123456:SECRET-token";
    const e = await T.tgRequest({ token, method: "getUpdates", proxy: "http://127.0.0.1:1", timeoutMs: 3000 }).catch((x) => x);
    assert.ok(e instanceof Error);
    assert.equal(failKind(e), "net");
    assert.ok(!e.message.includes("SECRET"), e.message);
    // поддельный прокси на 127.0.0.1: на CONNECT отвечает 403 — запрос до Telegram не уходит
    const seen = [];
    const px = http.createServer();
    px.on("connect", (req, sock) => { seen.push(req.url); sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); });
    await new Promise((r) => px.listen(0, "127.0.0.1", r));
    try {
        const e2 = await T.tgRequest({ token, method: "getUpdates", proxy: "http://127.0.0.1:" + px.address().port, timeoutMs: 3000 }).catch((x) => x);
        assert.match(e2.message, /ответил 403/);
        assert.equal(failKind(e2), "net");
        assert.ok(!e2.message.includes("SECRET"));
        assert.deepEqual(seen, ["api.telegram.org:443"], "через прокси — только туннель до Bot API, токен в нём не виден");
    }
    finally {
        px.close();
    }
});

test("прокси: по умолчанию напрямую, без туннелей; off — напрямую; адрес — как задан", () => {
    assert.equal(T.tgProxy({}), "");
    assert.equal(T.tgProxy({ DASH_TG_PROXY: "off" }), "");
    assert.equal(T.tgProxy({ DASH_TG_PROXY: " http://192.0.2.10:8080 " }), "http://192.0.2.10:8080");
});

test("токен — секрет tg-token (secrets.mjs), а не свой файл модуля", async () => {
    const { getSecret, envName } = await import("./secrets.mjs");
    assert.equal(T.TG_SECRET, "tg-token");
    assert.equal(envName(T.TG_SECRET), "DISPATCHER_SECRET_TG_TOKEN");
    assert.equal(await getSecret(T.TG_SECRET, { env: { DISPATCHER_SECRET_TG_TOKEN: "1:x" }, dir: path.join(TMP, "нет") }), "1:x");
    assert.equal("TG_VAULT" in T, false);
});

test("строка состояния: выключен, пока settings.tgBot не включён", () => {
    T.loadTg();
    const p = T.tgPublic();
    assert.equal(p.on, false);
    assert.equal(p.code, "off");
    assert.equal(p.linked, false);
});
