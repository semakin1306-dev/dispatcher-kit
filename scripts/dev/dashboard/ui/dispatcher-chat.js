// dispatcher-chat.js — агент-диспетчер в списке чатов: строка со состоянием и панель с лентой обходов,
// полем «входящих» и кнопкой «Обойти сейчас». Данные — GET /api/dispatcher-agent (поллинг), действия — POST туда же.
import { S } from "./state.js";
import { call, esc, mdFull, SPIN, toast } from "./core.js";

export const DISP_KEY = "__dispatcher";
const POLL_MS = 20e3;
let D = null, timer = null, onUpdate = null, pane = null, lastFirst = "";

export const dispEnabled = () => !!(D && D.enabled);

const hm = (t) => (t ? new Date(t).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "—");
const ago = (t) => {
    if (!t)
        return "";
    const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    return m < 1 ? "сейчас" : m < 60 ? m + " мин" : m < 1440 ? Math.round(m / 60) + " ч" : Math.round(m / 1440) + " д";
};
const nightUntil = () => {
    const u = S && S.settings && S.settings.autoOwnerUntil;
    return u && u > Date.now() ? u : 0;
};

export async function pollDispatcher() {
    try {
        D = await call("/api/dispatcher-agent");
    }
    catch {
        return;
    }
    if (onUpdate)
        onUpdate();
    if (pane && pane.isConnected)
        fillPane();
}

/** Запуск поллинга; cb — перерисовать список чатов, когда пришли новые данные. */
export function startDispatcherPoll(cb) {
    onUpdate = cb;
    if (timer)
        return;
    pollDispatcher();
    timer = setInterval(() => !document.hidden && pollDispatcher(), POLL_MS);
}

function stateOf() {
    if (!D || !D.enabled)
        return { st: "off", word: "нет агента" };
    if (D.running)
        return { st: "work", word: "обходит…" };
    const nu = nightUntil();
    if (!D.timer)
        return { st: "off", word: "таймер выключен" };
    if (!nu)
        return { st: "sleep", word: "спит · ночной режим выключен" };
    return { st: "warm", word: "дежурит до " + hm(nu) + (D.next ? " · следующий " + hm(D.next) : "") };
}

/** Строка «Диспетчер» в списке чатов (над группами агентов). */
export function dispRow(cur) {
    if (!dispEnabled())
        return "";
    const { st, word } = stateOf(), j = (D.journals || [])[0], un = (D.inbox || []).length;
    const sub = st === "work" ? word : word + (j ? " · прошлый " + hm(j.at) + (j.significant ? " ⚑" : "") : "");
    return `<div class="clg disp">Диспетчер</div><button type="button" class="cli disp ${cur === DISP_KEY ? "on" : ""} ${st}" data-act="sidechat" data-tree="${DISP_KEY}" title="Агент-диспетчер: обходит эпики по таймеру, пока включён «Ночной режим»" style="--c:#7c5cff"><span class="clc"><span class="dspi">🛰</span></span><span class="clt"><b>Диспетчер</b><span class="cls">${st === "work" ? SPIN + " " : ""}${esc(sub)}</span></span><span class="cla">${un ? `<i class="clun" title="Ваших сообщений ждут обхода: ${un}">${un}</i>` : st === "work" ? '<i class="cldot run"></i>' : esc(j ? ago(j.at) : "")}</span></button>`;
}

export const dispHeader = () => `<span class="dotc" style="background:#7c5cff"></span>🛰 Диспетчер<span class="sub" style="font-weight:400">обходы по таймеру при «Ночном режиме» · журнал — ${esc((D && D.unit) || "")}</span>`;

function journalHTML(j) {
    const flag = j.significant ? '<span class="chip warn" title="Обход отметил значимое">значимое</span>' : j.significant === false ? '<span class="chip">тихо</span>' : "";
    const bad = (j.code && j.code !== 0 ? `<span class="chip bad" title="Сессия обхода завершилась с кодом ${j.code}">код ${j.code}</span>` : "")
        + (j.limit ? '<span class="chip bad" title="Сессия упёрлась в лимит модели — обход не выполнен">лимит</span>' : "")
        + (j.running ? `<span class="chip">${SPIN} идёт</span>` : "");
    return `<div class="dsp-j${j.dry ? " dry" : ""}"><div class="dsp-jh"><b>🛰 ${esc(j.title)}</b> <span class="mute">${new Date(j.at).toLocaleDateString("ru-RU")}</span> ${flag}${bad}</div><div class="dsp-md md">${mdFull(j.md || "")}</div></div>`;
}

function fillPane() {
    if (!pane)
        return;
    const { st, word } = stateOf();
    pane.querySelector('[data-r="dstate"]').innerHTML = `${st === "work" ? SPIN + " " : ""}${esc(word)}`;
    const run = pane.querySelector('[data-r="drun"]');
    run.disabled = !!(D && D.running);
    const inb = (D && D.inbox) || [];
    pane.querySelector('[data-r="dinbox"]').innerHTML = inb.length
        ? `<div class="dsp-inbox">Ждут ближайшего обхода (${inb.length}):${inb.map((m) => `<div class="dsp-msg">✉ ${esc(m.text)} <span class="mute">${hm(m.at)}</span></div>`).join("")}</div>`
        : "";
    const js = (D && D.journals) || [];
    const first = js.length ? js[0].file + ":" + js.length : "";
    if (first === lastFirst)
        return;
    lastFirst = first;
    const log = pane.querySelector(".ch-log"), bottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.innerHTML = js.length ? js.slice().reverse().map(journalHTML).join("") : '<div class="mute" style="padding:12px">Обходов ещё не было.</div>';
    if (bottom || !log.dataset.seen) {
        log.scrollTop = log.scrollHeight;
        log.dataset.seen = "1";
    }
}

/** Панель диспетчера в боковом чате: лента обходов (старые сверху, свежие внизу — как у агентов), входящие, кнопки. */
export function mountDispPane(host) {
    if (!pane) {
        pane = document.createElement("div");
        pane.className = "chat dsp";
        pane.dataset.key = DISP_KEY;
        pane.innerHTML = `<div class="ch-head"><span class="dspi">🛰</span><span class="chip" data-r="dstate">…</span><span class="sp"></span>
        <button type="button" class="sm" data-r="drun" title="Запустить обход сейчас, не дожидаясь таймера">▶ Обойти сейчас</button></div>
        <div class="ch-log"></div>
        <form class="ch-in"><div data-r="dinbox"></div><div class="ch-box"><div class="ch-ta"><textarea rows="2" placeholder="Сообщение диспетчеру — прочитает первым пунктом на ближайшем обходе. Enter — отправить"></textarea></div>
        <div class="ch-bar"><span class="mute" style="font-size:11px">ответ — в журнале обхода</span><span class="sp"></span><button class="csend" type="submit" title="Отправить (Enter)">➤</button></div></div></form>`;
        const ta = pane.querySelector("textarea"), fm = pane.querySelector("form");
        const sendIt = async () => {
            const text = ta.value.trim();
            if (!text)
                return;
            try {
                await call("/api/dispatcher-agent", { op: "send", text });
                ta.value = "";
                toast("Отправлено диспетчеру: прочитает на ближайшем обходе", true);
                pollDispatcher();
            }
            catch (e) {
                toast("Не отправилось: " + e.message);
            }
        };
        fm.addEventListener("submit", (e) => {
            e.preventDefault();
            sendIt();
        });
        ta.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                sendIt();
            }
        });
        pane.querySelector('[data-r="drun"]').addEventListener("click", async () => {
            const force = !nightUntil();
            if (force && !confirm("«Ночной режим» выключен. Запустить обход всё равно?\nДиспетчер будет действовать так же, как ночью: выкат стенда, приёмка, ответы на вопросы по рекомендациям (кроме прода, релиза, ролей, денег, удаления и секретов)."))
                return;
            try {
                const r = await call("/api/dispatcher-agent", { op: "run", force });
                toast(r.message || "Обход запущен", true);
                pollDispatcher();
            }
            catch (e) {
                toast("Обход не запустился: " + e.message);
            }
        });
    }
    if (pane.parentNode !== host)
        host.replaceChildren(pane);
    lastFirst = "";
    fillPane();
}
