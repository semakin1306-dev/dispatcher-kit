// tg-rules.mjs — чистые правила бота в Telegram: какие вопросы бот не берёт (выкат, прод, «принудительно» — только на
// странице), текст сообщений и кнопки, сборка ответа из выбранного, проверка нажатия и отправителя, отступ при сбое
// сети, строка состояния, вычистка токена. Полномочия слова по источнику — owner-word.mjs.
import { composeAnswers, optPrefix, ownerQuestions, answerText as optAnswerText } from "./owner-options.mjs";

// Вопрос про выкат, прод или «принудительно» боту не отдаётся: приходит уведомление «нужно решение на дашборде» без
// кнопок. \b в JS кириллицу не видит — границы слова через просмотр вокруг.
const W = "[а-яёa-z0-9_]";
export const DASH_ONLY_RE = new RegExp("(?<!" + W + ")(?:прод(?:а|е|у|ом)?|продакшн[а-яё]*|production|prod|main|релиз[а-яё]*|release|выкат[а-яё]*|выкаты[а-яё]*|раскат[а-яё]*|деплой[а-яё]*|deploy[a-z]*|принудительн[а-яё]*|force|пуш[а-яё]*|push|сброс[а-яё]*|reset)(?!" + W + ")", "i");
export const needsDashboard = (text) => DASH_ONLY_RE.test(String(text || ""));
/** Срок жизни кнопки; DASH_TG_BUTTON_HOURS перекрывает. */
export const TG_BUTTON_TTL_MS = (Number(process.env.DASH_TG_BUTTON_HOURS) || 24) * 3600e3;
/** «Ответить текстом»: сколько ждать следующего сообщения. */
export const TG_TEXT_WAIT_MS = 15 * 60e3;
/** Вопросы старше суток при включении бота не рассылаются. */
export const TG_MAX_AGE_MS = 24 * 3600e3;
const MAX_OPTS = 8, MAX_BUTTONS = 90, MAX_TEXT = 3800;

/** Вопросы карточки «ownerq» — тот же разбор, что у формы страницы; рекомендованный вариант первым. */
export function cardQuestions(text) {
    const raw = String(text || "").trim();
    if (!raw)
        return [];
    let qs = ownerQuestions("Вопросы владельцу:\n" + raw);
    if (!qs.length)
        qs = ownerQuestions("Вопросы владельцу:\n1. " + raw);
    if (!qs.length)
        qs = [{ n: "1", text: raw, head: raw.split(/\r?\n/)[0], options: [] }];
    return qs.map((q) => ({ n: String(q.n), head: q.head || q.text, text: q.text, options: [...q.options.filter((o) => o.rec), ...q.options.filter((o) => !o.rec)].slice(0, MAX_OPTS) }));
}

const cut = (s, n) => {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

const optLine = (o) => (o.rec ? "★ " : "") + optPrefix(o) + o.v + (o.rec ? " — рекомендую" : "");

/**
 * Сообщение вопроса: { text, buttons: [[{ text, act }]] }, act — { kind: "opt", n, k } | { kind: "text" } | { kind: "send" }.
 * Сами id кнопок назначает tg.mjs. dashOnly — без кнопок. picks — уже выбранное: { n: k }.
 */
export function questionMessage({ who, qs, picks = {}, dashOnly = false }) {
    const head = (dashOnly ? "⚠️ Нужно решение на дашборде · " : "❓ ") + who;
    const body = qs.map((q) => [q.n + ". " + q.head, ...q.options.map((o) => "   " + (picks[q.n] === o.k ? "✔ " : "") + optLine(o))].join("\n"));
    let text = head + "\n\n" + body.join("\n\n");
    if (dashOnly)
        text += "\n\nВопрос касается выката, прода, сброса ветки или «принудительно»: ответ из Telegram такое не разрешает. Ответьте на дашборде.";
    else if (qs.length > 1)
        text += "\n\nВыберите вариант у каждого вопроса — ответ уйдёт, когда выбраны все, или «Отправить выбранное». Можно ответить текстом.";
    if (text.length > MAX_TEXT)
        text = text.slice(0, MAX_TEXT - 1) + "…";
    if (dashOnly)
        return { text, buttons: [] };
    const buttons = [];
    let n = 0;
    for (const q of qs)
        for (const o of q.options) {
            if (++n > MAX_BUTTONS)
                break;
            buttons.push([{ text: cut((qs.length > 1 ? q.n + " · " : "") + (picks[q.n] === o.k ? "✔ " : o.rec ? "★ " : "") + optPrefix(o) + o.v, 60), act: { kind: "opt", n: q.n, k: o.k } }]);
        }
    const tail = [{ text: "✍ Ответить текстом", act: { kind: "text" } }];
    if (qs.length > 1 && Object.keys(picks).length)
        tail.push({ text: "📨 Отправить выбранное", act: { kind: "send" } });
    buttons.push(tail);
    return { text, buttons };
}

/** Текст ответа агенту из выбранного и свободного текста — тот же вид, что у формы страницы («Вопрос N: (б) …»). */
export function composeTgAnswer(qs, picks = {}, free = "") {
    const rows = qs.map((q) => {
        const o = q.options.find((x) => x.k === picks[q.n]);
        return { n: q.n, picked: o ? optAnswerText(q, o) : "", custom: "" };
    });
    return composeAnswers(rows, free);
}

export const allPicked = (qs, picks = {}) => qs.length > 0 && qs.every((q) => picks[q.n] && q.options.some((o) => o.k === picks[q.n]));
const VIA_TEXT = { tg: "из Telegram", dashboard: "на дашборде" };
export const viaText = (via) => VIA_TEXT[via] || VIA_TEXT.dashboard;
export const answeredMessage = (who, answer, via) => "✅ " + who + "\nОтвечено " + viaText(via) + ":\n" + cut(answer, 1200);
export const goneMessage = (who, why = "") => "☑️ " + who + "\nВопрос снят без ответа из бота" + (why ? ": " + why : " (агент продолжил или ответ дан в его чате)") + ".";
export const textPrompt = (who) => "✍ Ответ на вопросы " + who + ": напишите его следующим сообщением (или ответьте на это сообщение). Жду " + Math.round(TG_TEXT_WAIT_MS / 60e3) + " мин.";
/** Ключ «готово к вливу»: слот, ветка и sha — новый код даёт новое сообщение. */
export const mergeKey = (t) => [t.key, t.branch || "", (t.last && t.last.sha) || t.sha || ""].join("|");
export const mergeMessage = (who) => ({ text: "🟢 " + who + "\nГотово к вливу в staging: проверки пройдены на нынешнем коде.", buttons: [[{ text: "Влить в staging", act: { kind: "merge" } }]] });
export const mergeDoneMessage = (who, what) => "🟢 " + who + "\n" + what;
/** Что бот умеет и чего не делает — для /start, /help и проверочного сообщения настройки. */
export const BOT_ABOUT = "Сюда приходят вопросы агентов с кнопками и ветки, готовые к вливу в staging. Выкат стенда и прода, сброс ветки и «принудительно» — только на дашборде.";

/** Короткий id кнопки (callback_data ≤ 64 байт): «t» + 10 знаков base36. rnd(n) — источник случайных байтов. */
export function buttonId(rnd) {
    const b = rnd(8);
    let s = "";
    for (const x of b)
        s += (x % 36).toString(36);
    return "t" + s.slice(0, 10).padEnd(10, "0");
}

export const CB_RE = /^t[0-9a-z]{10}$/;

/** Нажатие кнопки → { ok: true } или { ok: false, text } (вежливый отказ). open — вопрос или влив ещё ждут. */
export function buttonCheck(btn, { now = Date.now(), open = true } = {}) {
    if (!btn)
        return { ok: false, text: "Кнопка не найдена: сообщение устарело. Ответьте на дашборде." };
    if (btn.used)
        return { ok: false, text: "Уже принято — повторно не отправляю." };
    if (now - (btn.at || 0) > TG_BUTTON_TTL_MS)
        return { ok: false, text: "Кнопка устарела (" + Math.round(TG_BUTTON_TTL_MS / 3600e3) + " ч). Ответьте на дашборде." };
    if (!open)
        return { ok: false, text: btn.kind === "merge" ? "Ветка уже не готова к вливу (влита или код изменился)." : "На этот вопрос уже ответили." };
    return { ok: true };
}

/** Принимаются только закреплённые при настройке chat_id и user id. → { ok, chatId, userId } */
export function senderOk(update, meta) {
    const m = update && (update.callback_query ? update.callback_query.message : update.message);
    const from = update && (update.callback_query ? update.callback_query.from : update.message && update.message.from);
    const chatId = m && m.chat ? m.chat.id : null, userId = from ? from.id : null;
    const ok = !!(meta && meta.chatId != null && meta.userId != null && chatId != null && userId != null && String(chatId) === String(meta.chatId) && String(userId) === String(meta.userId));
    return { ok, chatId, userId };
}

/** Вид сбоя: conflict (409 — getUpdates читает кто-то ещё), auth (токен отвергнут), rate (429), api, net. */
export function failKind(e) {
    const c = e && e.tgCode;
    if (c === 409)
        return "conflict";
    if (c === 401 || c === 404)
        return "auth";
    if (c === 429)
        return "rate";
    if (c)
        return "api";
    return "net";
}

/** Пауза после сбоя: сеть — 5 с, 10, 20 … до 5 мин; 409 — 5 мин (не мешать чужому опросу); токен — 30 мин. */
export function backoffMs(kind, fails = 1, retryAfter = 0) {
    if (kind === "conflict")
        return 5 * 60e3;
    if (kind === "auth")
        return 30 * 60e3;
    if (kind === "rate")
        return Math.max(1, Number(retryAfter) || 5) * 1000;
    return Math.min(5 * 60e3, 5000 * 2 ** Math.max(0, Math.min(10, fails - 1)));
}

const SETUP_CMD = "node scripts/dev/tg-setup.mjs";
const STATUS = { off: "выключен", dry: "сухой экземпляр — не опрашивает", "no-token": "нет токена — запустите " + SETUP_CMD, starting: "подключаюсь…", ok: "подключён", conflict: "409: getUpdates читает кто-то ещё", auth: "токен отвергнут — заново " + SETUP_CMD, net: "нет сети до api.telegram.org", api: "Telegram отказал", rate: "Telegram просит паузу (429)" };
/** Строка состояния для страницы: { code, text, warn }. */
export const statusText = (code, detail = "") => ({ code, text: (STATUS[code] || code) + (detail && code !== "ok" ? " (" + cut(detail, 120) + ")" : ""), warn: ["conflict", "auth", "net", "api", "no-token"].includes(code) });

/** Токен — вон из любой строки, которая может попасть в журнал или на страницу. */
export const redact = (s, token) => {
    s = String(s == null ? "" : s);
    return token ? s.split(token).join("<токен>") : s;
};
