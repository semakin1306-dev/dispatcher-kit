// tg.mjs — бот вопросов в Telegram (модуль `tg`): вопросы агентов («Вопросы владельцу») приходят человеку сообщением с
// кнопками вариантов, ответ уходит в ту же сессию агента тем же путём, что ответ со страницы; ветка, готовая к вливу в
// staging, приходит сообщением с кнопкой «Влить в staging». Связь — опрос getUpdates с этой машины, входящих портов нет.
// Токен — из secrets.mjs и живёт только в памяти модуля. Включается модулем `tg` и переключателем settings.tgBot.
// Файлы в папке данных: tg.meta.json — закреплённые chat_id и user id (не секрет), tg.json — что отправлено, кнопки, offset.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import tls from "node:tls";
import { S } from "./state.mjs";
import { readJson, saveJson } from "./store.mjs";
import { DATA, DRY, logEvent, settings } from "./config.mjs";
import { bumpVer } from "./events.mjs";
import { execFile } from "./spawner.mjs";
import { getSecret, secretStamp } from "./secrets.mjs";
import { wordGrants } from "./owner-word.mjs";
import {
    BOT_ABOUT,
    CB_RE,
    TG_MAX_AGE_MS,
    TG_TEXT_WAIT_MS,
    allPicked,
    answeredMessage,
    backoffMs,
    buttonCheck,
    buttonId,
    cardQuestions,
    composeTgAnswer,
    failKind,
    goneMessage,
    mergeDoneMessage,
    mergeMessage,
    needsDashboard,
    questionMessage,
    redact,
    senderOk,
    statusText,
    textPrompt,
} from "./tg-rules.mjs";

/** Имя секрета с токеном бота (secrets.mjs): переменная DISPATCHER_SECRET_TG_TOKEN, файл или DPAPI. */
export const TG_SECRET = "tg-token";
export const TG_META = path.join(DATA, "tg.meta.json"), TG_FILE = path.join(DATA, "tg.json");
const HOST = "api.telegram.org";
const DEDUP_MS = 6 * 3600e3, KEEP_MS = 3 * 86400e3;
const sha = (s) => crypto.createHash("sha1").update(String(s || "")).digest("hex").slice(0, 16);
const tgError = (msg, extra = {}) => Object.assign(new Error(msg), extra);

function connectVia(proxy, timeoutMs) {
    return new Promise((res, rej) => {
        let p;
        try {
            p = new URL(proxy);
        }
        catch {
            return rej(tgError("неверный адрес прокси DASH_TG_PROXY"));
        }
        const auth = p.username ? { "proxy-authorization": "Basic " + Buffer.from(decodeURIComponent(p.username) + ":" + decodeURIComponent(p.password)).toString("base64") } : {};
        const req = http.request({ host: p.hostname, port: Number(p.port) || 80, method: "CONNECT", path: HOST + ":443", headers: { host: HOST + ":443", ...auth } });
        const t = setTimeout(() => {
            req.destroy();
            rej(tgError("прокси " + p.host + ": нет ответа"));
        }, Math.min(timeoutMs, 15000));
        req.once("connect", (r, socket) => {
            clearTimeout(t);
            if (r.statusCode !== 200) {
                socket.destroy();
                rej(tgError("прокси " + p.host + " ответил " + r.statusCode));
            }
            else
                res(socket);
        });
        req.once("error", (e) => {
            clearTimeout(t);
            rej(tgError("прокси " + p.host + ": " + e.message));
        });
        req.end();
    });
}

/** Вызов метода Bot API: POST JSON → result. proxy — "" (напрямую) или http://хост:порт. Ошибка: tgCode, retryAfter; без токена в тексте. */
export async function tgRequest({ token, method, params = {}, proxy = "", timeoutMs = 20000 }) {
    if (!token)
        throw tgError("нет токена");
    const body = Buffer.from(JSON.stringify(params), "utf8");
    const socket = proxy ? await connectVia(proxy, timeoutMs) : null;
    const raw = await new Promise((res, rej) => {
        const req = https.request({ host: HOST, port: 443, method: "POST", path: "/bot" + token + "/" + method, agent: false, servername: HOST,
            headers: { "content-type": "application/json", "content-length": body.length },
            ...(socket ? { createConnection: () => tls.connect({ socket, servername: HOST }) } : {}) }, (r) => {
            const chunks = [];
            r.on("data", (c) => chunks.push(c));
            r.on("end", () => res({ status: r.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
            r.on("error", rej);
        });
        req.setTimeout(timeoutMs, () => req.destroy(tgError("нет ответа за " + Math.round(timeoutMs / 1000) + " с")));
        req.on("error", (e) => rej(tgError(redact(e.message, token))));
        req.end(body);
    }).finally(() => {
        if (socket)
            socket.destroy();
    });
    let j = null;
    try {
        j = JSON.parse(raw.text);
    }
    catch {
        throw tgError("ответ не JSON (HTTP " + raw.status + ")");
    }
    if (!j.ok)
        throw tgError(redact(String(j.description || "отказ " + raw.status), token), { tgCode: j.error_code || raw.status, retryAfter: j.parameters && j.parameters.retry_after });
    return j.result;
}

/** Прокси до api.telegram.org: DASH_TG_PROXY = http://хост:порт; пусто или off — напрямую. */
export function tgProxy(env = process.env) {
    const m = String(env.DASH_TG_PROXY || "").trim();
    return m === "off" ? "" : m;
}

/**
 * Бот над подменяемыми зависимостями (сеть, время, хранилище — снаружи; тесты дают поддельные).
 * deps: api(method, params, { timeoutMs }) → result; now(); store; save(); meta() → { chatId, userId } | null;
 * cards() → карточки «ждут вас»; who(tree) → подпись; readyMerges() → [{ mkey, slot, who }];
 * ownerAnswer(tree, text, cardId) → { code, body }; merge(slot) → { code, body }; log(type, data); rnd(n) → байты.
 */
export function createTgBot(deps) {
    const st = deps.store;
    for (const k of ["cards", "merges", "btns", "prompts"])
        st[k] ||= {};
    const now = () => deps.now();
    let chain = Promise.resolve();
    const serial = (fn) => {
        const p = chain.then(fn, fn);
        chain = p.catch(() => { });
        return p;
    };
    const chat = () => (deps.meta() || {}).chatId;
    const open = () => deps.cards().filter((c) => c.kind === "ownerq");
    const cardOpen = (id) => !!st.cards[id] && st.cards[id].state === "open" && open().some((c) => c.id === id);
    const mergeOpen = (mkey) => !!st.merges[mkey] && st.merges[mkey].state === "open" && deps.readyMerges().some((m) => m.mkey === mkey);
    function keyboard(buttons, owner) {
        if (!buttons.length)
            return undefined;
        owner.btnIds ||= {};
        return { inline_keyboard: buttons.map((row) => row.map((b) => {
                const sig = b.act.kind + ":" + (b.act.n || "") + ":" + (b.act.k || "");
                let id = owner.btnIds[sig];
                if (!id || !st.btns[id]) {
                    do
                        id = buttonId(deps.rnd);
                    while (st.btns[id]);
                    owner.btnIds[sig] = id;
                    st.btns[id] = { ...b.act, ...(owner.cardId ? { cardId: owner.cardId } : { mkey: owner.mkey }), at: now() };
                }
                return { text: b.text, callback_data: id };
            })) };
    }
    const closeButtons = (owner) => {
        for (const id of Object.values(owner.btnIds || {}))
            if (st.btns[id])
                st.btns[id].used = true;
    };
    async function edit(mid, text, markup) {
        if (!mid)
            return;
        try {
            await deps.api("editMessageText", { chat_id: chat(), message_id: mid, text, ...(markup ? { reply_markup: markup } : {}) });
        }
        catch (e) {
            if (!/not modified|not found|can't be edited/i.test(e.message))
                deps.log("tg.error", { op: "edit", error: e.message.slice(0, 200) });
        }
    }
    const send = (text, extra = {}) => deps.api("sendMessage", { chat_id: chat(), text, disable_web_page_preview: true, ...extra });
    const render = (rec, cardId) => {
        rec.cardId = cardId;
        const m = questionMessage({ who: rec.who, qs: rec.qs, picks: rec.picks, dashOnly: rec.dashOnly });
        const kb = keyboard(m.buttons, rec);
        delete rec.cardId;
        return { text: m.text, kb };
    };
    async function syncCards() {
        const cards = open(), ids = new Set(cards.map((c) => c.id)), t = now();
        for (const c of cards) {
            if (st.cards[c.id])
                continue;
            const hash = sha(c.text);
            const prev = Object.keys(st.cards).find(
                (id) =>
                    !ids.has(id) &&
                    st.cards[id].tree === c.tree &&
                    st.cards[id].hash === hash &&
                    ["open", "gone"].includes(st.cards[id].state) &&
                    t - (st.cards[id].sentAt || 0) < DEDUP_MS,
            );
            if (prev) {
                const rec = st.cards[prev];
                delete st.cards[prev];
                st.cards[c.id] = rec;
                for (const id of Object.values(rec.btnIds || {}))
                    if (st.btns[id]) {
                        st.btns[id].cardId = c.id;
                        st.btns[id].used = false;
                    }
                if (rec.state === "gone") {
                    rec.state = "open";
                    const m = render(rec, c.id);
                    await edit(rec.mid, m.text, m.kb);
                }
                continue;
            }
            if (t - (c.at || t) > TG_MAX_AGE_MS) {
                st.cards[c.id] = { tree: c.tree, state: "old", at: t };
                continue;
            }
            const qs = cardQuestions(c.text), rec = { tree: c.tree, at: c.at || t, sentAt: t, hash, qs, picks: {}, state: "open", who: deps.who(c.tree), dashOnly: needsDashboard(c.text) };
            const m = render(rec, c.id);
            try {
                const r = await send(m.text, m.kb ? { reply_markup: m.kb } : {});
                rec.mid = r.message_id;
                st.cards[c.id] = rec;
                deps.log("tg.sent", { tree: c.tree, card: c.id, n: qs.length, dashOnly: rec.dashOnly });
            }
            catch (e) {
                for (const id of Object.values(rec.btnIds || {}))
                    delete st.btns[id];
                if (failKind(e) !== "api")
                    throw e;
                st.cards[c.id] = { tree: c.tree, state: "failed", at: t };
                deps.log("tg.error", { tree: c.tree, op: "send", error: e.message.slice(0, 200) });
            }
        }
        for (const [id, rec] of Object.entries(st.cards))
            if (rec.state === "open" && !ids.has(id)) {
                rec.state = "gone";
                rec.closedAt = t;
                closeButtons(rec);
                await edit(rec.mid, goneMessage(rec.who));
            }
    }
    async function syncMerges() {
        const ready = deps.readyMerges(), keys = new Set(ready.map((m) => m.mkey)), t = now();
        for (const m of ready) {
            if (st.merges[m.mkey])
                continue;
            const rec = { slot: m.slot, who: m.who, at: t, state: "open", mkey: m.mkey }, msg = mergeMessage(m.who), kb = keyboard(msg.buttons, rec);
            delete rec.mkey;
            try {
                const r = await send(msg.text, { reply_markup: kb });
                rec.mid = r.message_id;
                st.merges[m.mkey] = rec;
                deps.log("tg.sent", { tree: m.slot, merge: true });
            }
            catch (e) {
                for (const id of Object.values(rec.btnIds || {}))
                    delete st.btns[id];
                if (failKind(e) !== "api")
                    throw e;
                st.merges[m.mkey] = { slot: m.slot, state: "failed", at: t };
                deps.log("tg.error", { tree: m.slot, op: "send", error: e.message.slice(0, 200) });
            }
        }
        for (const [k, rec] of Object.entries(st.merges))
            if (rec.state === "open" && !keys.has(k)) {
                rec.state = "gone";
                rec.closedAt = t;
                closeButtons(rec);
                await edit(rec.mid, mergeDoneMessage(rec.who, "Уже не ждёт влива: влита или код изменился."));
            }
    }
    function prune() {
        const t = now();
        for (const [id, r] of Object.entries(st.cards))
            if (r.state !== "open" && t - (r.closedAt || r.at || 0) > KEEP_MS)
                delete st.cards[id];
        for (const [id, r] of Object.entries(st.merges))
            if (r.state !== "open" && t - (r.closedAt || r.at || 0) > KEEP_MS)
                delete st.merges[id];
        for (const [id, b] of Object.entries(st.btns))
            if (t - (b.at || 0) > KEEP_MS)
                delete st.btns[id];
        for (const [mid, p] of Object.entries(st.prompts))
            if (t - (p.at || 0) > KEEP_MS)
                delete st.prompts[mid];
        if (st.wait && t > st.wait.until)
            st.wait = null;
    }
    const sync = () => serial(async () => {
        try {
            await syncCards();
            await syncMerges();
        }
        finally {
            prune();
            deps.save();
        }
    });
    async function submit(cardId, free) {
        const rec = st.cards[cardId], comp = composeTgAnswer(rec.qs, rec.picks, free);
        if (!comp.text)
            return { ok: false, text: "Ответа нет: выберите вариант или напишите текст." };
        if (!wordGrants("tg", "answer"))
            return { ok: false, text: "ответ из Telegram сейчас не принимается — ответьте на дашборде" };
        const r = await deps.ownerAnswer(rec.tree, comp.text, cardId).catch((e) => ({ code: 500, body: { error: e.message } }));
        if (r.code !== 200)
            return { ok: false, text: (r.body && r.body.error) || "не отправлено" };
        deps.log("tg.answer", { tree: rec.tree, card: cardId, chars: comp.text.length, picked: Object.keys(rec.picks).length, free: !!free });
        await answered({ id: cardId, text: comp.text, via: "tg" });
        return { ok: true, text: "Ответ ушёл: " + rec.who };
    }
    async function answered({ id, text, via }) {
        const rec = st.cards[id];
        if (!rec || rec.state === "answered")
            return;
        Object.assign(rec, { state: "answered", answer: String(text || "").slice(0, 1500), via: via || "dashboard", closedAt: now() });
        closeButtons(rec);
        await edit(rec.mid, answeredMessage(rec.who, text, via));
        deps.save();
    }
    async function doMerge(btn) {
        const rec = st.merges[btn.mkey];
        btn.used = true;
        // порог слова — одна таблица на всю диспетчерскую (owner-word.mjs); сервер проверит его ещё раз
        const r = wordGrants("tg", "merge")
            ? await deps.merge(rec.slot).catch((e) => ({ code: 500, body: { error: e.message } }))
            : { code: 403, body: { error: "влив из Telegram не разрешён — на дашборде" } };
        rec.state = r.code === 200 ? "merging" : "failed";
        rec.closedAt = now();
        closeButtons(rec);
        deps.log("tg.merge", { tree: rec.slot, ok: r.code === 200, job: (r.body && r.body.id) || null, error: r.code === 200 ? undefined : String((r.body && r.body.error) || "").slice(0, 200) });
        await edit(
            rec.mid,
            mergeDoneMessage(
                rec.who,
                r.code === 200
                    ? "⏳ Влив поставлен в очередь (" + r.body.id + "): условия проверит сервер, итог — на дашборде."
                    : "✗ Не поставлен: " + ((r.body && r.body.error) || "отказ"),
            ),
        );
    }
    let rejLogged = 0;
    async function onCallback(cq) {
        const ack = (text) => deps.api("answerCallbackQuery", { callback_query_id: cq.id, text: String(text).slice(0, 190) }).catch(() => { });
        const id = String(cq.data || ""), btn = CB_RE.test(id) ? st.btns[id] : null;
        const isOpen = btn ? (btn.kind === "merge" ? mergeOpen(btn.mkey) : cardOpen(btn.cardId)) : false;
        const chk = buttonCheck(btn, { now: now(), open: isOpen });
        if (!chk.ok)
            return ack(chk.text);
        if (btn.kind === "merge") {
            await ack("Ставлю влив в staging…");
            return doMerge(btn);
        }
        const rec = st.cards[btn.cardId];
        if (rec.dashOnly)
            return ack("Этот вопрос — только на дашборде.");
        if (btn.kind === "text") {
            st.wait = { cardId: btn.cardId, until: now() + TG_TEXT_WAIT_MS };
            await ack("Жду ответ текстом");
            const r = await send(textPrompt(rec.who), { reply_markup: { force_reply: true, input_field_placeholder: "Ваш ответ" } });
            st.prompts[r.message_id] = { cardId: btn.cardId, at: now() };
            return;
        }
        if (btn.kind === "opt") {
            if (rec.qs.length > 1 && rec.picks[btn.n] === btn.k)
                return ack("Уже выбрано");
            rec.picks[btn.n] = btn.k;
            if (rec.qs.length > 1 && !allPicked(rec.qs, rec.picks)) {
                const left = rec.qs.filter((q) => !rec.picks[q.n]).map((q) => q.n);
                const m = render(rec, btn.cardId);
                await edit(rec.mid, m.text, m.kb);
                deps.save();
                return ack("Выбрано (" + btn.k + "). Осталось: " + left.join(", "));
            }
        }
        await ack("Отправляю ответ…");
        const r = await submit(btn.cardId, "");
        if (!r.ok)
            await send("✗ " + rec.who + ": " + r.text);
    }
    async function onMessage(m) {
        const text = String(m.text || "").trim();
        if (!text)
            return;
        const reply = (s) => send(s, { reply_to_message_id: m.message_id }).catch(() => { });
        if (/^\/start\b/.test(text))
            return reply("Бот диспетчерской на связи. " + BOT_ABOUT);
        if (/^\/(status|help)\b/.test(text)) {
            const q = Object.values(st.cards).filter((r) => r.state === "open").length, mg = Object.values(st.merges).filter((r) => r.state === "open").length;
            return reply("Открытых вопросов: " + q + "; готово к вливу: " + mg + ". Ответ текстом — reply на сообщение вопроса или кнопка «✍ Ответить текстом». " + BOT_ABOUT);
        }
        const rt = m.reply_to_message && m.reply_to_message.message_id;
        let cardId = null;
        if (rt)
            cardId = (st.prompts[rt] && st.prompts[rt].cardId) || Object.keys(st.cards).find((id) => st.cards[id].mid === rt) || null;
        if (!cardId && st.wait && now() <= st.wait.until)
            cardId = st.wait.cardId;
        if (!cardId)
            return reply(
                rt && Object.values(st.merges).some((r) => r.mid === rt)
                    ? "Влив — только кнопкой «Влить в staging»."
                    : "Не понял, к какому вопросу ответ: ответьте reply на сообщение вопроса или нажмите «✍ Ответить текстом».",
            );
        const rec = st.cards[cardId];
        if (!rec || !cardOpen(cardId))
            return reply("На этот вопрос уже ответили (или его сняли) — повторно не отправляю.");
        if (rec.dashOnly)
            return reply("Этот вопрос — только на дашборде: ответ из Telegram не разрешает выкат, прод, сброс ветки и «принудительно».");
        st.wait = null;
        const r = await submit(cardId, text);
        return reply(r.ok ? "✅ " + r.text : "✗ " + r.text);
    }
    function handle(u) {
        return serial(async () => {
            const chk = senderOk(u, deps.meta());
            if (!chk.ok) {
                if (now() - rejLogged > 60000) {
                    rejLogged = now();
                    deps.log("tg.reject", { chat: chk.chatId, user: chk.userId, kind: u.callback_query ? "callback" : u.message ? "message" : "other" });
                }
                if (u.callback_query)
                    await deps.api("answerCallbackQuery", { callback_query_id: u.callback_query.id, text: "Нет доступа." }).catch(() => { });
                return;
            }
            try {
                if (u.callback_query)
                    await onCallback(u.callback_query);
                else if (u.message)
                    await onMessage(u.message);
            }
            finally {
                deps.save();
            }
        });
    }
    async function poll(quick = false) {
        const ups = await deps.api(
            "getUpdates",
            {
                ...(st.offset ? { offset: st.offset } : {}),
                timeout: quick ? 0 : 50,
                allowed_updates: ["message", "callback_query"],
            },
            { timeoutMs: quick ? 20000 : 65000 },
        );
        for (const u of ups || []) {
            st.offset = Math.max(st.offset || 0, u.update_id + 1);
            try {
                await handle(u);
            }
            catch (e) {
                deps.log("tg.error", { op: "update", error: String(e.message).slice(0, 200) });
            }
        }
        if ((ups || []).length)
            deps.save();
        return (ups || []).length;
    }
    return { sync, poll, handle, answered: (x) => serial(() => answered(x)), store: st };
}

// ───── живой экземпляр ─────
let token = null, bot = null, filesAt = "", wake = null;

const persist = () => {
    if (!DRY || process.env.DASH_DATA)
        saveJson(TG_FILE, S.tg.store);
};

function setStatus(code, detail = "") {
    const s = S.tg.status;
    if (s.code === code && s.detail === detail)
        return;
    S.tg.status = { code, detail: redact(detail, token), at: Date.now() };
    if (s.code !== code)
        logEvent("tg.status", { code, detail: S.tg.status.detail.slice(0, 200) });
    bumpVer("tg");
}

const mtime = (f) => {
    try {
        return String(fs.statSync(f).mtimeMs);
    }
    catch {
        return "-";
    }
};

const filesStamp = () => secretStamp(TG_SECRET) + "|" + mtime(TG_META);

/** Токен и закреплённые chat_id/user id перечитываются, когда меняются (после tg-setup перезапуск не нужен). */
async function reloadFiles() {
    const stamp = filesStamp();
    if (stamp === filesAt)
        return;
    filesAt = stamp;
    S.tg.meta = readJson(TG_META, null);
    token = null;
    try {
        token = (await getSecret(TG_SECRET, { execFile })) || null;
    }
    catch (e) {
        token = null;
        setStatus("no-token", "токен не прочитан: " + e.message);
    }
}

export function loadTg() {
    S.tg = { status: { code: "off", detail: "", at: Date.now() }, meta: readJson(TG_META, null), store: readJson(TG_FILE, null) || {} };
}

/** Запуск бота (boot.mjs, только при включённом модуле `tg`): deps — cards, who, readyMerges, ownerAnswer, merge (см. createTgBot). */
export function startTg(deps) {
    if (!S.tg)
        loadTg();
    const api = async (method, params, o = {}) => tgRequest({ token, method, params, proxy: tgProxy(), timeoutMs: o.timeoutMs || 20000 });
    bot = createTgBot({ api, now: Date.now, store: S.tg.store, save: persist, meta: () => S.tg.meta, rnd: (n) => crypto.randomBytes(n), log: logEvent, ...deps });
    let fails = 0;
    const syncFail = (e) => {
        const k = failKind(e);
        if (k === "api")
            logEvent("tg.error", { op: "sync", error: redact(e.message, token).slice(0, 200) });
        else
            setStatus(k, e.message);
    };
    const nap = (ms) => new Promise((r) => {
        const t = setTimeout(r, ms);
        wake = () => {
            clearTimeout(t);
            r();
        };
    });
    (async () => {
        for (;;) {
            wake = null;
            if (!settings.tgBot) {
                setStatus("off");
                await nap(5000);
                continue;
            }
            if (DRY) {
                setStatus("dry");
                await nap(30000);
                continue;
            }
            await reloadFiles();
            if (!token || !S.tg.meta || S.tg.meta.chatId == null) {
                if (S.tg.status.code !== "no-token" || !S.tg.status.detail)
                    setStatus("no-token");
                await nap(15000);
                continue;
            }
            try {
                const quick = S.tg.status.code !== "ok";
                if (["off", "dry", "no-token"].includes(S.tg.status.code))
                    setStatus("starting");
                await bot.poll(quick);
                fails = 0;
                if (quick) {
                    setStatus("ok");
                    bot.sync().catch(syncFail);
                }
            }
            catch (e) {
                const kind = failKind(e);
                fails++;
                setStatus(kind, e.message);
                await nap(backoffMs(kind, fails, e.retryAfter));
            }
        }
    })().catch((e) => console.error("бот Telegram:", redact(e.message, token)));
    setInterval(() => {
        if (!settings.tgBot || DRY)
            return;
        if (wake && filesStamp() !== filesAt)
            wake();
        if (S.tg.status.code === "ok")
            bot.sync().catch(syncFail);
    }, 5000).unref();
}

/** Ответ со страницы (подписка на ответ владельца): сообщение вопроса правится «✅ отвечено на дашборде». */
export const tgAnswered = (x) => {
    if (bot && token && settings.tgBot && !DRY)
        bot.answered(x).catch(() => { });
};

/** Переключатель settings.tgBot сменили: не ждать конца паузы цикла. */
export const tgSettingsChanged = () => {
    if (wake)
        wake();
};

/** Строка состояния для страницы (S.tg в /api/state). */
export function tgPublic() {
    if (!S.tg)
        return { on: false, ...statusText("off") };
    const st = S.tg.store || {};
    return {
        on: !!settings.tgBot,
        ...statusText(S.tg.status.code, S.tg.status.detail),
        linked: !!(S.tg.meta && S.tg.meta.chatId != null),
        open: Object.values(st.cards || {}).filter((r) => r.state === "open").length,
        at: S.tg.status.at,
    };
}
