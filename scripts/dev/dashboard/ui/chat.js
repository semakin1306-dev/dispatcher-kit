// chat.js — чаты агентов: лента событий агента, кнопки ответа на запросы разрешений, передачи между агентами, форма
// вопросов владельцу.
import { OPEN, OPENCHAT, S } from "./state.js";
import { $, call, cpBtn, agentIcon, agentStateOf, esc, ls, mdFull, RAW, SPIN, toast } from "./core.js";
import { ownerQuestions } from "./owner-options.js";
import { oqFormHTML } from "./oqform.js";
import { render } from "./render.js";
import { treeOf } from "./data.js";
import { renderRail, renderSide } from "./side.js";

const PLANE_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14.2 1.8L7.2 8.8M14.2 1.8l-4.6 12.4-2.4-5.4-5.4-2.4z"/></svg>';

function hasTag(t, tag) {
    let i = t.indexOf(tag);
    while (i >= 0) {
        const nx = t[i + tag.length];
        if (!nx || !(nx >= "0" && nx <= "9"))
            return true;
        i = t.indexOf(tag, i + 1);
    }
    return false;
}

function slotKeyOfText(txt) {
    const t = String(txt || ""), sl = (S.trees || []).filter((x) => x.kind === "slot");
    const k = sl.find((x) => t.toLowerCase().includes(x.key.toLowerCase()) || hasTag(t, x.tag)) || sl.find((x) => t.includes(x.emoji));
    return k ? k.key : "";
}

const relayNorm = (s) => String(s || "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd()).join("\n").trim();

function relayHash(from, to, text) {
    let h = 0x811c9dc5;
    const s = from + ">" + to + "\n" + relayNorm(text);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

export function relaySentMark(b) {
    const t = b.dataset.to ? treeOf(b.dataset.to) : null;
    b.removeAttribute("data-relay");
    b.className = "rlbtn sent";
    b.disabled = true;
    b.title = "Этот блок уже передан — второй раз не отправляется";
    b.innerHTML = "<span>✓ передано " + esc(b.dataset.to === "orchestrator" ? "ОРК" : t ? t.tag : "") + "</span>";
}

function decorateRelay(c) {
    if (!S)
        return;
    const sent = new Set(S.relaySent || []);
    c.el.querySelectorAll(".mdcw").forEach((w) => {
        const ob = w.querySelector(".rlbtn[data-relay]");
        if (ob) {
            const code = w.querySelector("pre code");
            if (ob.dataset.to && code && sent.has(relayHash(ob.dataset.from, ob.dataset.to, code.textContent)))
                relaySentMark(ob);
            return;
        }
        if (w.querySelector(".rlbtn"))
            return;
        const from = c.key;
        let to = "";
        if (from === "orchestrator") {
            const lang = w.dataset.lang || "";
            to = slotKeyOfText(lang.startsWith("slot:") ? lang.slice(5) : "");
            if (!to) {
                const prev = w.previousElementSibling;
                to = slotKeyOfText(prev ? prev.textContent.slice(-200) : "");
            }
        }
        else
            to = "orchestrator";
        const t = to ? treeOf(to) : null;
        const label = from === "orchestrator" ? (t ? "→ " + t.emoji + " " + t.tag : "→ слоту ▾") : "→ ОРК";
        const b = document.createElement("button");
        b.className = "rlbtn" + (to ? "" : " pick");
        b.dataset.relay = "1";
        b.dataset.from = from;
        b.dataset.to = to;
        b.title = from === "orchestrator" ? (t ? "Отправить этот блок слоту " + t.tag + ": он сам получит текст и начнёт работу" : "Выбрать слот и отправить этот блок: он сам получит текст и начнёт работу") : "Передать этот ответ оркестратору: он получит его сам, без копирования";
        b.innerHTML = PLANE_ICON + "<span>" + esc(label) + "</span>";
        w.insertBefore(b, w.firstChild);
        const code = w.querySelector("pre code");
        if (to && code && sent.has(relayHash(from, to, code.textContent)))
            relaySentMark(b);
    });
}

export function pickSlot(anchor) {
    return new Promise((resolve) => {
        document.getElementById("rlmenu") && document.getElementById("rlmenu").remove();
        const m = document.createElement("div");
        m.id = "rlmenu";
        const r = anchor.getBoundingClientRect();
        m.style.left = Math.max(8, Math.min(innerWidth - 230, r.left)) + "px";
        m.style.top = Math.min(innerHeight - 190, r.bottom + 4) + "px";
        m.innerHTML = S.trees.filter((x) => x.kind === "slot").map((x) => '<button data-k="' + esc(x.key) + '">' + x.emoji + " <b>" + esc(x.tag) + "</b> " + esc(x.title) + "</button>").join("");
        document.body.appendChild(m);
        const close = (v) => {
            m.remove();
            document.removeEventListener("mousedown", off, true);
            resolve(v);
        };
        const off = (e) => {
            if (!m.contains(e.target))
                close("");
        };
        m.addEventListener("click", (e) => {
            const b = e.target.closest("button[data-k]");
            if (b)
                close(b.dataset.k);
        });
        setTimeout(() => document.addEventListener("mousedown", off, true), 0);
    });
}

const ENV_SVG = '<svg viewBox="0 0 12 8" width="30" height="20" shape-rendering="crispEdges"><rect width="12" height="8" fill="#f6efe0"/><rect width="12" height="1" fill="#c3b79a"/><rect y="7" width="12" height="1" fill="#c3b79a"/><rect width="1" height="8" fill="#c3b79a"/><rect x="11" width="1" height="8" fill="#c3b79a"/><rect x="1" y="1" width="1" height="1" fill="#c3b79a"/><rect x="2" y="2" width="1" height="1" fill="#c3b79a"/><rect x="3" y="3" width="1" height="1" fill="#c3b79a"/><rect x="4" y="4" width="1" height="1" fill="#c3b79a"/><rect x="10" y="1" width="1" height="1" fill="#c3b79a"/><rect x="9" y="2" width="1" height="1" fill="#c3b79a"/><rect x="8" y="3" width="1" height="1" fill="#c3b79a"/><rect x="7" y="4" width="1" height="1" fill="#c3b79a"/><rect x="5" y="4" width="2" height="1" fill="#c3b79a"/></svg>';
const GIT_SVG = '<svg viewBox="0 0 24 24" width="42" height="42"><path d="M12 1.6 22.4 12 12 22.4 1.6 12Z" fill="#f05033"/><circle cx="9" cy="8.2" r="1.7" fill="#fff"/><circle cx="9" cy="15.8" r="1.7" fill="#fff"/><circle cx="15.2" cy="12" r="1.7" fill="#fff"/><path d="M9 9.9v4.2M9 10c0 2.2 6.2.4 6.2 2" stroke="#fff" stroke-width="1.3" fill="none"/></svg>';

function judgeIcon(state, size) {
    const r = (x, y, w, h, f) => '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + f + '"/>', W = "#f4f3ee", S2 = "#d3d1c8";
    const wig = '<g class="wig">' + r(3, 1, 8, 1, W) + r(2, 2, 10, 1, "#e9e7df") + r(4, 1, 1, 1, S2) + r(7, 1, 1, 1, S2) + r(10, 1, 1, 1, S2) +
        r(1, 3, 2, 1, W) + r(1, 4, 1, 1, S2) + r(1, 5, 2, 1, W) + r(1, 6, 1, 1, S2) + r(1, 7, 2, 1, W) +
        r(11, 3, 2, 1, W) + r(12, 4, 1, 1, S2) + r(11, 5, 2, 1, W) + r(12, 6, 1, 1, S2) + r(11, 7, 2, 1, W) + "</g>";
    return agentIcon("#7c5cff", state, size).replace("</svg>", wig + "</svg>");
}

export function relayScene(from, to, kind, verdict) {
    if (from === "reviewer") {
        const t = treeOf(to), el = document.getElementById("relayfx");
        if (!t || !el)
            return;
        const v = verdict === "ЗА" ? "«ЗА»" : verdict ? "«" + verdict + "» — замечания" : "вердикт";
        el.innerHTML = '<div class="rl"><div class="rlcap"><b>Ревьюер</b> → <b>' + esc(t.tag) + "</b> · " + esc(v) + (verdict === "ЗА" ? ", дальше коммит" : ", " + esc(t.tag) + " разбирает") + '</div><div class="rlstage">' +
            '<div class="rls from"><span class="stk a">' + judgeIcon("work", 44) + '</span><span class="stk b">' + judgeIcon("warm", 44) + "</span></div>" +
            '<div class="env">' + ENV_SVG + "</div>" +
            '<div class="rls to"><span class="stk c">' + agentIcon(t.color, "warm", 44) + '</span><span class="stk d">' + agentIcon(t.color, "work", 44) + "</span></div></div></div>";
        el.classList.add("on");
        clearTimeout(relayScene.k);
        relayScene.k = setTimeout(() => el.classList.remove("on"), 5200);
        return;
    }
    const f = treeOf(from), t = to === "git" ? { tag: "git", color: "#f05033", git: true } : treeOf(to), el = document.getElementById("relayfx");
    if (!f || !t || !el)
        return;
    if (t.git) {
        el.innerHTML = '<div class="rl"><div class="rlcap"><b>' + esc(f.tag) + '</b> пишет подпись и отправляет коммит в <b>git</b> своей ветки</div><div class="rlstage">' +
            '<div class="rls from"><span class="stk a">' + agentIcon(f.color, "work", 44) + '</span><span class="stk b">' + agentIcon(f.color, "warm", 44) + "</span></div>" +
            '<div class="env">' + ENV_SVG + "</div>" +
            '<div class="rls to"><span class="stk gitpop">' + GIT_SVG + "</span></div></div></div>";
        el.classList.add("on");
        clearTimeout(relayScene.k);
        relayScene.k = setTimeout(() => el.classList.remove("on"), 5200);
        return;
    }
    el.innerHTML = '<div class="rl"><div class="rlcap"><b>' + esc(f.tag) + "</b> → <b>" + esc(t.tag) + '</b> · письмо передано, ' + esc(t.tag) + ' принимается за работу</div><div class="rlstage">' +
        '<div class="rls from"><span class="stk a">' + agentIcon(f.color, "work", 44) + '</span><span class="stk b">' + agentIcon(f.color, "warm", 44) + "</span></div>" +
        '<div class="env">' + ENV_SVG + "</div>" +
        '<div class="rls to"><span class="stk c">' + agentIcon(t.color, "warm", 44) + '</span><span class="stk d">' + agentIcon(t.color, "work", 44) + "</span></div></div></div>";
    el.classList.add("on");
    clearTimeout(relayScene.k);
    relayScene.k = setTimeout(() => el.classList.remove("on"), 5200);
}

export const RELAY_SEEN = new Set();
let relayInit = false;

export function watchRelays() {
    if (!S || !S.relays)
        return;
    for (const r of S.relays) {
        if (RELAY_SEEN.has(r.id))
            continue;
        RELAY_SEEN.add(r.id);
        if (relayInit && Date.now() - r.at < 4000)
            relayScene(r.from, r.to, r.kind, r.verdict);
    }
    relayInit = true;
}

export const CHATS = new Map();

export function focusChat(key) {
    const c = CHATS.get(key);
    if (!c || !c.el.isConnected)
        return;
    c.el.scrollIntoView({ block: "center", behavior: "smooth" });
    c.el.classList.add("flash");
    setTimeout(() => c.el.classList.remove("flash"), 2200);
    const lg = c.el.querySelector(".ch-log");
    if (lg)
        lg.scrollTop = lg.scrollHeight;
}

export function collapseAll() {
    const n = OPENCHAT.size + OPEN.size;
    OPENCHAT.clear();
    OPEN.clear();
    ls("dash.chats", []);
    ls("dash.open", []);
    render();
    toast(n ? "Свёрнуто: " + n : "Уже всё свёрнуто", true);
}

export let SIDEBAR = (() => {
    if (innerWidth < 1100)
        return false;
    try {
        return localStorage.getItem("dash.side") !== "0";
    }
    catch {
        return true;
    }
})();

const TOOLICON = { bash: "⌨", read: "📄", write: "📝", edit: "✏️", search: "🔎", todo: "☑", other: "⚙" };

function toolIO(it) {
    const inp = it.kind === "edit" ? `<span class="dl">${esc((it.old || "").split("\n").map((l) => "- " + l).join("\n"))}</span>\n<span class="ad">${esc((it.neu || "").split("\n").map((l) => "+ " + l).join("\n"))}</span>` : it.kind === "write" ? esc((it.line || "") + "\n\n" + (it.body || "")) : esc(it.line || "");
    return `<div class="tio"><div class="tio-r"><span class="tio-k">IN</span><pre>${inp}</pre></div>${it.result ? `<div class="tio-r"><span class="tio-k">OUT</span><pre>${esc(it.result)}</pre></div>` : ""}</div>`;
}

function toolBody(it) {
    let b = "";
    if (it.kind === "edit")
        b = `<span class="dl">${esc((it.old || "").split("\n").map((l) => "- " + l).join("\n"))}</span>\n<span class="ad">${esc((it.neu || "").split("\n").map((l) => "+ " + l).join("\n"))}</span>`;
    else if (it.kind === "bash")
        b = esc("$ " + (it.line || ""));
    else if (it.kind === "write")
        b = esc((it.line || "") + "\n\n" + (it.body || ""));
    else
        b = esc(it.line || "");
    if (it.result)
        b += `<span class="rs">${esc(it.result)}</span>`;
    return b;
}

function forkHTML(it) {
    const qs = ownerQuestions(it.text);
    if (!qs.length || it.live)
        return "";
    return `<div class="oqfork" style="margin-top:8px;border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:var(--card)"><div class="sub" style="margin-bottom:6px">❓ Вопросы владельцу — ответ уходит этому агенту</div>${oqFormHTML(qs, { mode: "chat", target: "", scope: "chat:" + it.id })}</div>`;
}

function itemHTML(it, hist) {
    const h = hist ? " hist" : "";
    if (it.t === "user") {
        RAW.set(it.id, it.text);
        return `<div class="msg user${h}" data-id="${esc(it.id)}">${cpBtn("msg", it.id)}${esc(it.text)}</div>`;
    }
    if (it.t === "assistant") {
        RAW.set(it.id, it.text);
        return `<div class="msg assistant mdv${h}${!it.live && !String(it.text || "").trim() ? " empty" : ""}" data-id="${esc(it.id)}">${it.text.trimStart().startsWith("\x60\x60\x60") ? "" : cpBtn("msg", it.id)}${mdFull(it.text)}${it.live ? '<span class="cursor"></span>' : ""}${hist ? "" : forkHTML(it)}</div>`;
    }
    if (it.t === "review") {
        RAW.set(it.id, it.text);
        return `<div class="msg assistant mdv${h}" data-id="${esc(it.id)}" style="border-left:3px solid var(${it.verdict === "ЗА" ? "--good, #1e8e3e" : it.verdict === "ПРОТИВ" ? "--bad, #c5221f" : "--accent"})">${cpBtn("msg", it.id)}<div style="margin-bottom:6px"><b>🔎 Ревью · ${esc(it.verdict || "без вердикта")}</b> <span class="sub">независимый ревьюер, ${new Date(it.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })} · агенту не отправлялось</span></div>${mdFull(it.text || "")}</div>`;
    }
    if (it.t === "tool")
        return `<details class="tool ${it.status}${h}" data-id="${esc(it.id)}"><summary><b>${esc(it.name)}</b><span class="tl ${it.desc ? "dsc" : ""}">${esc(it.desc || String(it.line || "").split("\n")[0].slice(0, 160))}</span>${it.status === "run" ? SPIN : ""}</summary>${toolIO(it)}</details>`;
    if (it.t === "perm") {
        const wait = it.status === "wait";
        return `<div class="perm ${wait ? "" : "done"}" data-id="${esc(it.id)}"><div><b>${wait ? "🔐 Агент просит разрешение" : it.status === "allowed" ? "✅ Разрешено" : "⛔ Запрещено"}:</b> ${esc(it.name)}</div><pre>${toolBody(it)}</pre>${wait ? `<div class="chips"><button class="sm primary" data-chat="allow" data-req="${esc(it.reqId)}">Разрешить</button><button class="sm" data-chat="deny" data-req="${esc(it.reqId)}">Запретить</button></div>` : ""}</div>`;
    }
    if (it.t === "result")
        return `<div class="resline" data-id="${esc(it.id)}">${it.ok ? "✓" : "✗ " + esc(it.text)} · ${it.sec} с${it.cost != null ? ` · <span title="Условная цена хода по тарифам API.">≈ $${Number(it.cost).toFixed(2)} по API, не списание</span>` : ""}</div>`;
    return `<div class="stline ${it.bad ? "bad" : ""}" data-id="${esc(it.id)}">${esc(it.text)}</div>`;
}

const svg = (d, extra = "") => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;

const ICO = {
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    slash: svg('<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M14 8.5l-4 7"/>', ' stroke-width="1.6"'),
    resume: svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v3.8h3.8"/>'),
    halt: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/></svg>',
    power: svg('<path d="M12 3.5v8M6.6 7a7.5 7.5 0 1 0 10.8 0"/>'),
    send: svg('<path d="M12 19V5M6 11l6-6 6 6"/>', ' stroke-width="2.2"'),
};

// Модели агента приходят от рантайма: S.runtime.models — [{ id, label }] или строки. Нет списка — выбора нет.
const runtimeModels = () => ((S && S.runtime && S.runtime.models) || []).map((m) => (typeof m === "string" ? { id: m, label: m } : { id: m.id, label: m.label || m.id }));
const modelLabel = (id) => (runtimeModels().find((m) => m.id === id) || { label: id }).label;

function modelSelect() {
    const ms = runtimeModels();
    if (!ms.length)
        return "";
    return `<select class="cmodel" data-r="model" title="Модель агента. Работающему агенту меняется со следующего сообщения, если рантайм это умеет; остановленному — при запуске"><option value="">Модель</option>${ms.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join("")}</select>`;
}

function makeChat(key, inline) {
    const el = document.createElement("div");
    el.className = "chat" + (inline ? " inline" : "");
    el.dataset.key = key;
    const slot = key !== "orchestrator";
    const ic = (k, title, inner, extra = "") => `<button type="button" class="cib" data-chat="${k}" title="${title}" ${extra}>${inner}</button>`;
    el.innerHTML = `<div class="ch-head"><span data-r="agi" style="display:inline-flex"></span><span class="chip" data-r="state">…</span><span class="sp"></span></div>
    <div class="ch-log"></div><button class="ch-down" type="button" data-chat="down" title="Вниз, к последним сообщениям">↓</button>
    <div class="ch-live" data-r="live" hidden><span data-r="liveagi" style="display:inline-flex"></span><span data-r="livetext"></span></div>
    <form class="ch-in"><div class="ch-box">
      <div class="ch-ta"><textarea rows="2" placeholder="Напишите агенту…  Enter — отправить, Shift+Enter — новая строка"></textarea></div>
      <div class="ch-bar">
        ${ic("new", "Новая сессия", ICO.plus)}${slot ? ic("prompt", "Вставить стартовый промпт слота", ICO.slash) : ""}${ic("resume", "Продолжить прошлую сессию этой папки (закройте её в других окнах агента)", ICO.resume)}
        ${modelSelect()}
        <span class="sp"></span>
        ${ic("interrupt", "Прервать текущий ответ", ICO.halt, 'data-r="int"')}${ic("stop", "Остановить процесс агента (вернёт ~0,5 ГБ памяти; сессия сохранится)", ICO.power)}
        <button class="csend" type="submit" title="Отправить (Enter)">${ICO.send}</button>
      </div></div></form>`;
    const c = { key, el, rev: 0, histShown: false, st: null };
    {
        const log = el.querySelector(".ch-log"), dn = el.querySelector(".ch-down"), fm = el.querySelector(".ch-in");
        log.addEventListener("scroll", () => {
            el.classList.toggle("notbottom", log.scrollTop + log.clientHeight < log.scrollHeight - 120);
            dn.style.bottom = (fm.offsetHeight + 10) + "px";
        }, { passive: true });
    }
    CHATS.set(key, c);
    return c;
}

const getChat = (key, inline) => CHATS.get(key) || makeChat(key, inline);

function chatState(c, d) {
    c.st = d;
    const chip = c.el.querySelector('[data-r="state"]');
    chip.className = "chip " + (d.pending ? "waiting" : d.busy ? "running" : d.running ? (d.idleSec != null && d.idleSec >= (d.cacheTtl || 3600) ? "queued" : "ok") : "");
    const idle = d.running && d.idleSec != null && d.idleSec >= (d.cacheTtl || 3600);
    const temp = d.running ? (idle ? ["🌤 давно без сообщений · процесс жив", "queued", "Агент давно не получал сообщений; процесс жив и ответит на следующее."] : ["● на связи", "ok", "Процесс агента жив и ждёт сообщения."]) : d.hasLast ? ["💤 спит", "", "Процесс остановлен; «Продолжить прошлую» поднимет сессию с полной историей."] : ["нет сессии", "", "Сессии ещё не было: «Новая сессия» запустит агента."];
    chip.title = temp[2];
    chip.innerHTML = d.pending ? "🔐 ждёт разрешения" : d.busy ? SPIN + " думает" : `${temp[0]}${d.running && d.model ? " · " + esc(modelLabel(d.model)) : ""}`;
    {
        const cs = c.el.querySelector('[data-r="agi"]'), tr = treeOf(c.key);
        if (cs && tr) {
            const st = agentStateOf(d), h = agentIcon(tr.color, st, 24);
            if (cs.__h !== h) {
                cs.__h = h;
                cs.innerHTML = h;
            }
        }
    }
    {
        const lv = c.el.querySelector('[data-r="live"]'), on = !!(d.busy || d.pending);
        lv.hidden = !on;
        lv.classList.toggle("wait", !!d.pending);
        if (on) {
            const lc = lv.querySelector('[data-r="liveagi"]'), tr = treeOf(c.key), h = tr ? agentIcon(tr.color, agentStateOf(d), 20) : "";
            if (lc.__h !== h) {
                lc.__h = h;
                lc.innerHTML = h;
            }
            const t = d.pending ? "🔐 ждёт вашего разрешения — карточка выше" : (d.activity || "думает…") + (d.turnAt ? " · " + Math.max(0, Math.round((Date.now() - d.turnAt) / 1000)) + " с" : "");
            const lt = lv.querySelector('[data-r="livetext"]');
            if (lt.textContent !== t)
                lt.innerHTML = (d.pending ? "" : SPIN + " ") + esc(t);
        }
    }
    c.el.querySelector('[data-r="int"]').disabled = !d.busy;
    c.el.querySelector('[data-chat="stop"]').disabled = !d.running;
    c.el.querySelector('[data-chat="resume"]').disabled = !d.hasLast || d.running;
    {
        const m = c.el.querySelector('[data-r="model"]');
        if (m && d.running && d.model && document.activeElement !== m && [...m.options].some((o) => o.value === d.model))
            m.value = d.model;
    }
}

function applyEvents(c, d) {
    const log = c.el.querySelector(".ch-log"), near = log.scrollTop + log.clientHeight >= log.scrollHeight - 60;
    if (d.history && d.history.length && !c.histShown) {
        c.histShown = true;
        log.insertAdjacentHTML("afterbegin", d.history.map((x) => itemHTML(x, true)).join("") + '<div class="histmark">— конец прошлой сессии —</div>');
    }
    for (const it of d.items) {
        const old = log.querySelector(`[data-id="${CSS.escape(it.id)}"]`), html = itemHTML(it);
        if (old) {
            const wasOpen = old.tagName === "DETAILS" && old.open;
            const t = document.createElement("div");
            t.innerHTML = html;
            const n = t.firstElementChild;
            if (wasOpen)
                n.open = true;
            old.replaceWith(n);
        }
        else
            log.insertAdjacentHTML("beforeend", html);
        if (it.t === "tool" && it.status === "run") {
            const n = log.querySelector(`[data-id="${CSS.escape(it.id)}"]`);
            if (n && !n.dataset.seen) {
                n.dataset.seen = "1";
            }
        }
    }
    c.rev = Math.max(c.rev, d.rev || 0);
    chatState(c, d);
    decorateRelay(c);
    if (near && (d.items.length || d.history.length))
        log.scrollTop = log.scrollHeight;
}

export async function pollChat(c) {
    try {
        applyEvents(c, await call(`/api/agent/${encodeURIComponent(c.key)}/events?since=${c.rev}`));
    }
    catch { }
}

let chatPolling = false;

export async function pollChats() {
    if (chatPolling)
        return;
    chatPolling = true;
    try {
        for (const c of CHATS.values()) {
            if (!c.el.isConnected)
                continue;
            try {
                applyEvents(c, await call(`/api/agent/${encodeURIComponent(c.key)}/events?since=${c.rev}`));
            }
            catch { }
        }
    }
    finally {
        chatPolling = false;
    }
}

export let SIDECHAT = (() => {
    try {
        return localStorage.getItem("dash.sidechat") || "orchestrator";
    }
    catch {
        return "orchestrator";
    }
})();

export const sideChatTrees = () => (S ? S.trees.filter((t) => (t.kind === "orch" || t.kind === "slot") && !t.archived && t.exists !== false) : []);
export const sideChatKey = () => (sideChatTrees().some((t) => t.key === SIDECHAT) ? SIDECHAT : "orchestrator");

export function setSideChat(k) {
    SIDECHAT = k;
    ls("dash.sidechat", k);
    mountChats();
    pollChats();
    if (S)
        renderSide();
    const c = CHATS.get(k), lg = c && c.el.querySelector(".ch-log");
    if (lg)
        setTimeout(() => {
            lg.scrollTop = lg.scrollHeight;
            const ta = c.el.querySelector("textarea");
            if (ta)
                ta.focus({ preventScroll: true });
        }, 60);
}

const CL_WORD = { work: "работает", wait: "ждёт разрешения", warm: "на связи", drowsy: "давно без сообщений", sleep: "спит", off: "нет сессии" };

const clAgo = (at) => {
    if (!at)
        return "";
    const m = Math.max(0, Math.round((Date.now() - at) / 60000));
    return m < 1 ? "сейчас" : m < 60 ? m + " мин" : m < 1440 ? Math.round(m / 60) + " ч" : Math.round(m / 1440) + " д";
};

const UNREAD = (() => {
    try {
        return JSON.parse(localStorage.getItem("dash.unread") || "{}");
    }
    catch {
        return {};
    }
})();

function unreadTick(list, cur) {
    let ch = false;
    const seeing = SIDEBAR && !document.hidden && !$("side").classList.contains("mode-panel");
    for (const t of list) {
        const a = S.agents[t.key] || {}, at = (a.last && a.last.at) || 0, r = UNREAD[t.key] || (UNREAD[t.key] = { at, n: 0 });
        if (at > r.at) {
            r.at = at;
            r.n++;
            ch = true;
        }
        if (seeing && t.key === cur && r.n) {
            r.n = 0;
            ch = true;
        }
    }
    if (ch)
        ls("dash.unread", UNREAD);
}

const CL_GROUPS = [["need", "Ждут вас"], ["work", "Работают"], ["rest", "Спят"]];

export function renderChatList() {
    const el = $("chatlist");
    if (!el || !S)
        return;
    const cur = sideChatKey(), list = sideChatTrees();
    unreadTick(list, cur);
    const groupOf = (t) => {
        const a = S.agents[t.key] || {};
        return a.pending || (UNREAD[t.key] || {}).n ? "need" : a.busy ? "work" : "rest";
    };
    const row = (t) => {
        const a = S.agents[t.key] || {}, st = agentStateOf(S.agents[t.key] || null), orch = t.kind === "orch", un = (UNREAD[t.key] || {}).n || 0;
        const sub = a.pending ? "🔐 ждёт вашего разрешения" : a.busy ? (a.activity || "думает…") : (t.wagon && !orch ? t.wagon + " · " : "") + (un ? "ответил" : CL_WORD[st] || "");
        return `<button type="button" class="cli ${t.key === cur ? "on" : ""} ${st}${a.pending ? " need" : ""}" data-act="sidechat" data-tree="${esc(t.key)}" title="${esc(t.tag + " · " + t.title)}" style="--c:${esc(t.color || "var(--accent)")}"><span class="clc">${agentIcon(t.color, st === "off" ? "sleep" : st, 20)}</span><span class="clt"><b>${esc(orch ? "Оркестратор" : t.tag + " · " + t.title)}</b><span class="cls">${a.busy && !a.pending ? SPIN + " " : ""}${esc(sub)}</span></span><span class="cla">${un ? `<i class="clun" title="Непрочитанных ответов: ${un}">${un > 9 ? "9+" : un}</i>` : a.pending ? "<i class=\"cldot need\"></i>" : a.busy ? "<i class=\"cldot run\"></i>" : esc(clAgo(a.lastAt))}</span></button>`;
    };
    const html = `<div class="clh">Чаты<span class="sp"></span><button type="button" class="clfold" data-act="clfold" title="Свернуть или развернуть список чатов. Alt+↑ / Alt+↓ — соседний чат">⇤</button></div>`
        + CL_GROUPS.map(([g, name]) => {
            const ts = list.filter((t) => groupOf(t) === g);
            return ts.length ? `<div class="clg ${g}">${name}<span>${ts.length}</span></div>` + ts.map(row).join("") : "";
        }).join("");
    if (el.__h !== html) {
        el.__h = html;
        el.innerHTML = html;
    }
}

export function stepSideChat(d) {
    const ks = [...document.querySelectorAll("#chatlist .cli")].map((b) => b.dataset.tree);
    if (!ks.length)
        return;
    const i = ks.indexOf(sideChatKey());
    setSideChat(ks[(Math.max(0, i) + d + ks.length) % ks.length]);
}

export function mountChats() {
    const first = (c) => {
        if (!c.loaded) {
            c.loaded = true;
            pollChat(c);
        }
    };
    const side = $("sidebody"), sk = sideChatKey(), inSide = SIDEBAR && side && !$("side").classList.contains("mode-panel");
    if (SIDEBAR && side) {
        let list = $("chatlist"), host = $("sidechat");
        if (!list) {
            list = document.createElement("nav");
            list.id = "chatlist";
            host = document.createElement("div");
            host.id = "sidechat";
            side.replaceChildren(list, host);
            side.classList.toggle("clmin", (() => {
                try {
                    return localStorage.getItem("dash.clmin") === "1";
                }
                catch {
                    return false;
                }
            })());
        }
        renderChatList();
        const c = getChat(sk, false);
        c.el.classList.remove("inline");
        if (c.el.parentNode !== host)
            host.replaceChildren(c.el);
        first(c);
    }
    document.querySelectorAll(".chatslot").forEach((ph) => {
        const here = inSide && ph.dataset.key === sk;
        ph.classList.toggle("inside", here);
        if (here)
            return;
        const c = getChat(ph.dataset.key, true);
        c.el.classList.add("inline");
        if (c.el.parentNode !== ph)
            ph.appendChild(c.el);
        first(c);
    });
}

export function snapshotChats() {
    const snap = { logs: new Map(), focus: null };
    for (const c of CHATS.values()) {
        const l = c.el.querySelector(".ch-log");
        snap.logs.set(c.key, { top: l.scrollTop, bottom: l.scrollTop + l.clientHeight >= l.scrollHeight - 4 });
    }
    const ae = document.activeElement;
    if (ae && ae.tagName === "TEXTAREA" && ae.closest(".chat"))
        snap.focus = { key: ae.closest(".chat").dataset.key, a: ae.selectionStart, b: ae.selectionEnd };
    return snap;
}

export function restoreChats(snap) {
    for (const c of CHATS.values()) {
        const s = snap.logs.get(c.key), l = c.el.querySelector(".ch-log");
        if (s && c.el.isConnected)
            l.scrollTop = s.bottom ? l.scrollHeight : s.top;
    }
    if (snap.focus) {
        const c = CHATS.get(snap.focus.key);
        const ta = c && c.el.querySelector("textarea");
        if (ta && c.el.isConnected) {
            ta.focus();
            try {
                ta.setSelectionRange(snap.focus.a, snap.focus.b);
            }
            catch { }
        }
    }
}

export async function chatAction(c, act, el) {
    if (act === "more") {
        el.closest(".ch-head").classList.toggle("more");
        return;
    }
    if (act === "down") {
        const l = c.el.querySelector(".ch-log");
        l.scrollTo({ top: l.scrollHeight, behavior: "smooth" });
        return;
    }
    const key = c.key, model = (c.el.querySelector('[data-r="model"]') || {}).value || "";
    if (act === "allow" || act === "deny")
        return call("/api/agent/perm", { key, reqId: el.dataset.req, allow: act === "allow" });
    if (act === "interrupt")
        return call("/api/agent/interrupt", { key });
    if (act === "stop")
        return call("/api/agent/stop", { key });
    if (act === "prompt") {
        const r = await call("/api/agent/prompt", { key });
        const ta = c.el.querySelector("textarea");
        ta.value = r.text;
        fitInput(ta);
        ta.scrollTop = 0;
        ta.focus();
        ta.setSelectionRange(0, 0);
        return toast("Стартовый промпт вставлен в поле — проверьте и отправьте", true);
    }
    if (act === "resume") {
        if (!confirm("Продолжить прошлую сессию этой папки?\nЕсли она ещё открыта в другом окне агента — закройте её, иначе две копии будут писать в одну сессию."))
            return;
        return call("/api/agent/start", { key, resume: true, model });
    }
    if (act === "new") {
        if (c.st && c.st.running) {
            await call("/api/agent/stop", { key });
            await new Promise((r) => setTimeout(r, 900));
        }
        c.el.querySelector(".ch-log").innerHTML = "";
        c.rev = 0;
        c.histShown = true;
        return call("/api/agent/start", { key, resume: false, model });
    }
}

export function setSidebar(on) {
    SIDEBAR = on;
    ls("dash.side", on ? "1" : "0");
    $("app").classList.toggle("nosb", !on);
    if (on)
        mountChats();
    pollChats();
    if (S) {
        renderRail();
        renderSide();
    }
}

export function fitInput(ta) {
    const chat = ta && ta.closest(".chat");
    if (!chat)
        return;
    const log = chat.querySelector(".ch-log"), empty = !log || !log.textContent.trim();
    const max = Math.max(150, Math.round(chat.clientHeight * (empty ? 0.75 : 0.4)));
    ta.style.maxHeight = max + "px";
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight + 2, max) + "px";
}

export const fitAll = () => document.querySelectorAll(".ch-in textarea").forEach(fitInput);
