// core.js — основа страницы: утилиты, запросы к серверу с токеном, разметка без скачков, markdown, значки состояния
// агента, заставка. Модуль-лист: импортирует только state.js, поэтому исполняется раньше всех, кто его зовёт.
import { BTN_BUSY, PENDING, S, TOKEN, VIEW_EPIC } from "./state.js";

export const commitBusy = (key) => PENDING.has("commit|" + key) || !!((typeof S !== "undefined" && S && S.agents && S.agents[key]) || {}).committing;
export const $ = (id) => document.getElementById(id);

// Модули установки приходят в /api/state полем modules: [{ id, on, … }]. Сервер без этого поля — умолчания каталога.
const MOD_DEFAULT = ["review", "backlog"];
export function modOn(id) {
    const list = S && Array.isArray(S.modules) ? S.modules : null;
    if (!list)
        return MOD_DEFAULT.includes(id);
    const m = list.find((x) => x.id === id);
    return !!(m && m.on);
}

// Задачи проекта: гейты (гарды) и тесты. Наборы станций — S.stations, иначе по признаку gate у задачи.
export function gateTasks() {
    const st = S && S.stations, tasks = (S && S.tasks) || {};
    return (st && Array.isArray(st.guards) ? st.guards : Object.keys(tasks).filter((k) => tasks[k].gate)).filter((k) => tasks[k]);
}
export function testTasks() {
    const st = S && S.stations, tasks = (S && S.tasks) || {};
    return (st && Array.isArray(st.tests) ? st.tests : Object.keys(tasks).filter((k) => !tasks[k].gate)).filter((k) => tasks[k]);
}

// Подпись ветки-роли с веткой проекта за ней: «staging (origin/develop)». Прод-ветки может не быть (pipeline.noMain).
export function branchLabel(role) {
    const P = (S && S.pipeline) || {}, up = role === "main" ? P.upMain : P.upStaging;
    return up ? role + " (" + up + ")" : role;
}
export const hasMain = () => !((S && S.pipeline) || {}).noMain;

// Название на экране: «Диспетчерская · <проект>».
export const projectName = () => (S && S.project && S.project.name) || "";
export const appTitle = () => "Диспетчерская" + (projectName() ? " · " + projectName() : "");
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const ls = (k, v) => {
    try {
        localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
    }
    catch { }
};

export const ICON = { ok: "✓", fail: "✗", running: "⏳", queued: "…", waiting: "⏸", cancelled: "—", interrupted: "!", skipped: "∅" };
export const durText = (j) => (j.startedAt ? Math.round(((j.endedAt || Date.now()) - j.startedAt) / 1000) + " с" : "");
export const dur = (j) => (j.status === "running" && j.startedAt ? '<span data-t0="' + j.startedAt + '"></span>' : durText(j));

export function tickTimers(root) {
    const now = Date.now(), r = root || document;
    r.querySelectorAll("[data-t0]").forEach((e) => {
        e.textContent = Math.max(0, Math.round((now - Number(e.dataset.t0)) / 1000)) + " с";
    });
    r.querySelectorAll("[data-pb]").forEach((e) => {
        const [t0, eta] = e.dataset.pb.split(",").map(Number);
        if (eta)
            e.style.width = Math.min(97, Math.round((100 * (now - t0)) / eta)) + "%";
    });
    r.querySelectorAll("[data-ago]").forEach((e) => {
        e.textContent = Math.max(0, Math.round((now - Number(e.dataset.ago)) / 1000)) + " с";
    });
}

const IH = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");

export function setHTML(el, html) {
    if (el.__h === html)
        return false;
    el.__h = html;
    const wx = window.scrollX, wy = window.scrollY, own = [el.scrollTop, el.scrollLeft], saved = [];
    const anc = [];
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement)
        if (p.scrollTop || p.scrollLeft)
            anc.push([p, p.scrollTop, p.scrollLeft]);
    el.querySelectorAll("*").forEach((n, i) => {
        if ((n.scrollTop || n.scrollLeft) && !n.closest(".chat"))
            saved.push([i, n.tagName, n.scrollTop, n.scrollLeft]);
    });
    IH.set.call(el, html);
    el.scrollTop = own[0];
    el.scrollLeft = own[1];
    for (const [p, st, sl] of anc) {
        if (Math.abs(p.scrollTop - st) > 1)
            p.scrollTop = st;
        if (Math.abs(p.scrollLeft - sl) > 1)
            p.scrollLeft = sl;
    }
    if (saved.length) {
        const all = el.querySelectorAll("*");
        for (const [i, tag, st, sl] of saved) {
            const n = all[i];
            if (n && n.tagName === tag) {
                n.scrollTop = st;
                n.scrollLeft = sl;
            }
        }
    }
    if (Math.abs(window.scrollY - wy) > 1 || Math.abs(window.scrollX - wx) > 1)
        window.scrollTo(wx, wy);
    tickTimers(el);
    return true;
}

export function smart(el) {
    if (!el || el.__smart)
        return el;
    el.__smart = true;
    Object.defineProperty(el, "innerHTML", { configurable: true, get() {
            return IH.get.call(el);
        }, set(v) {
            setHTML(el, v);
        } });
    return el;
}

export const SPIN = '<span class="spin"></span>';

export function applyTheme(t) {
    if (t === "light" || t === "dark")
        document.documentElement.dataset.theme = t;
    else
        delete document.documentElement.dataset.theme;
    ls("dash.theme", t);
    document.querySelectorAll("#theme button").forEach((b) => b.classList.toggle("on", b.dataset.theme === t));
}

let inflight = 0;

const net = (d) => {
    inflight += d;
    $("net").classList.toggle("on", inflight > 0);
};

export const toast = (m, good) => {
    const t = $("toast");
    t.className = good ? "good" : "";
    t.style.display = "block";
    t.textContent = "";
    const msg = document.createElement("span");
    msg.className = "tmsg";
    msg.textContent = m;
    const cp = document.createElement("button");
    cp.className = "tcopy";
    cp.type = "button";
    cp.textContent = "копировать";
    cp.title = "Скопировать текст уведомления";
    cp.onclick = async (e) => {
        e.stopPropagation();
        try {
            await navigator.clipboard.writeText(m);
        }
        catch {
            const a = document.createElement("textarea");
            a.value = m;
            document.body.appendChild(a);
            a.select();
            try {
                document.execCommand("copy");
            }
            catch { }
            a.remove();
        }
        cp.textContent = "скопировано ✓";
    };
    t.append(msg, cp);
    const arm = () => {
        clearTimeout(toast.k);
        toast.k = setTimeout(() => (t.style.display = "none"), good ? 4000 : 14000);
    };
    t.onmouseenter = () => clearTimeout(toast.k);
    t.onmouseleave = arm;
    arm();
};

export async function call(path, body) {
    net(1);
    try {
        const hd = { "content-type": "application/json", "x-dash-token": TOKEN };
        if (VIEW_EPIC)
            hd["x-dash-epic"] = VIEW_EPIC;
        const r = await fetch(path, body === undefined ? { headers: VIEW_EPIC ? { "x-dash-epic": VIEW_EPIC } : {} } : { method: "POST", headers: hd, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
            const e = new Error(j.error || r.statusText);
            e.data = j;
            throw e;
        }
        return j;
    }
    finally {
        net(-1);
    }
}

export const btnKey = (el) => [el.dataset.act, el.dataset.id, el.dataset.tree, el.dataset.task, el.dataset.input, el.dataset.action, el.dataset.slot, el.dataset.persona, el.dataset.where, el.dataset.p, el.dataset.key].map((x) => x || "").join("|");

export function applyBusy() {
    for (const el of document.querySelectorAll("button[data-busyins]"))
        if (!BTN_BUSY.has(btnKey(el))) {
            el.classList.remove("busy");
            el.disabled = false;
            el.removeAttribute("data-busyins");
            const sp = el.querySelector(":scope > .spin");
            if (sp) {
                if (sp.nextSibling && sp.nextSibling.nodeType === 3)
                    sp.nextSibling.textContent = sp.nextSibling.textContent.replace(/^ /, "");
                sp.remove();
            }
        }
    if (!BTN_BUSY.size)
        return;
    for (const el of document.querySelectorAll("button[data-act]"))
        if (!el.classList.contains("busy") && BTN_BUSY.has(btnKey(el))) {
            el.classList.add("busy");
            el.disabled = true;
            el.dataset.busyins = "1";
            el.insertAdjacentHTML("afterbegin", SPIN + " ");
        }
}

const BOOT_T0 = Date.now();

export function bootShow(offline) {
    const b = document.getElementById("boot");
    if (!b)
        return;
    b.style.display = "grid";
    if (offline) {
        clearInterval(bootTick);
        bootTick = null;
        const st = document.getElementById("bootstep");
        if (st)
            st.textContent = "Нет связи с сервером";
    }
    else
        bootSteps();
    const t = Math.round((Date.now() - BOOT_T0) / 1000);
    document.getElementById("bootsub").textContent = offline ? "Сервер не отвечает. Запустите диспетчерскую снова: node scripts/dev/dashboard/server.mjs." : "Сервер собирает снимок git по всем папкам: прошло " + t + " с (обычно до минуты после запуска).";
}

export let UI_VER = null, UI_STALE = false;

export function uiFresh(v) {
    if (!v)
        return;
    if (UI_VER == null) {
        UI_VER = v;
        return;
    }
    if (v === UI_VER)
        return;
    const typing = [...document.querySelectorAll("textarea, input[type=text]")].some((x) => x.value && x.value.trim()) || $("modal").classList.contains("on");
    if (!typing) {
        location.reload();
        return;
    }
    UI_STALE = true;
}

const BOOT_STEPS = ["Поднимаю пульт…", "Опрашиваю git по папкам слотов…", "Сверяю очереди прогонов…", "Бужу агентов и их чаты…", "Проверяю staging…", "Собираю мнемосхему…"];
let bootTick = null;

function bootSteps() {
    if (bootTick)
        return;
    let i = 0;
    const el = document.getElementById("bootstep");
    if (!el)
        return;
    bootTick = setInterval(() => {
        el.classList.add("fade");
        setTimeout(() => {
            i = (i + 1) % BOOT_STEPS.length;
            el.textContent = BOOT_STEPS[i];
            el.classList.remove("fade");
        }, 260);
    }, 2200);
}

export function bootHide() {
    const b = document.getElementById("boot");
    if (b)
        b.style.display = "none";
    if (bootTick) {
        clearInterval(bootTick);
        bootTick = null;
    }
}

export function anchorSave() {
    const y = window.innerHeight / 3;
    for (const w of document.querySelectorAll("#lines .lnw")) {
        const r = w.getBoundingClientRect();
        if (r.top <= y && r.bottom >= y)
            return { k: w.dataset.k, top: r.top };
    }
    return null;
}

export function pageScroller() {
    const m = document.querySelector("main");
    return m && !document.body.classList.contains("pm") && getComputedStyle(m).overflowY === "auto" ? m : null;
}

export function pageScrollBy(d) {
    const m = pageScroller();
    if (m)
        m.scrollTop += d;
    else
        window.scrollBy(0, d);
}

export function pageScrollToEl(el, gap = 80) {
    const m = pageScroller();
    if (m)
        m.scrollTop += el.getBoundingClientRect().top - m.getBoundingClientRect().top - 20;
    else
        window.scrollTo(0, el.getBoundingClientRect().top + scrollY - gap);
}

export function pageScrollTop() {
    const m = pageScroller();
    if (m)
        m.scrollTop = 0;
    window.scrollTo(0, 0);
}

export function anchorRestore(a) {
    if (!a)
        return;
    const w = [...document.querySelectorAll("#lines .lnw")].find((x) => x.dataset.k === a.k);
    if (!w)
        return;
    const d = w.getBoundingClientRect().top - a.top;
    if (Math.abs(d) >= 1)
        pageScrollBy(d);
}

export const CP_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5.2" y="5.2" width="8.6" height="8.6" rx="1.6"/><path d="M10.8 3.4V3a1.6 1.6 0 0 0-1.6-1.6H3A1.6 1.6 0 0 0 1.4 3v6.2A1.6 1.6 0 0 0 3 10.8h.4"/></svg>';
export const CK_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 8.6l3.1 3.1 6.5-7"/></svg>';
export const RAW = new Map();

export function cpBtn(kind, mid) {
    return '<button class="cpbtn" data-copy="' + kind + '"' + (mid ? ' data-mid="' + esc(mid) + '"' : "") + ' title="Копировать" aria-label="Копировать">' + CP_ICON + "</button>";
}

export async function copyText(t) {
    try {
        await navigator.clipboard.writeText(t);
        return true;
    }
    catch { }
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
        ok = document.execCommand("copy");
    }
    catch {
        ok = false;
    }
    ta.remove();
    return ok;
}

function mdInline(src) {
    const codes = [];
    let s = String(src ?? "").replace(/`([^`\n]+)`/g, (m, c) => {
        codes.push(c);
        return "\u0000" + (codes.length - 1) + "\u0000";
    });
    s = esc(s);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/__([^_\n]+)__/g, "<b>$1</b>");
    s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\*)/g, "$1<i>$2</i>").replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => "<code>" + esc(codes[Number(i)]) + "</code>");
}

function mdSplitRow(line) {
    let t = line.trim();
    if (t.startsWith("|"))
        t = t.slice(1);
    if (t.endsWith("|") && !t.endsWith("\\|"))
        t = t.slice(0, -1);
    const cells = [];
    let cur = "", tick = false;
    for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        if (ch === "`")
            tick = !tick;
        if (ch === "|" && !tick && t[i - 1] !== "\\") {
            cells.push(cur.trim());
            cur = "";
        }
        else
            cur += ch;
    }
    cells.push(cur.trim());
    return cells.map((c) => c.replace(/\\\|/g, "|"));
}

export function mdFull(src) {
    const L = String(src ?? "").replace(/\r/g, "").split("\n"), out = [];
    const isSep = (x) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(x || "") && String(x).includes("-");
    const isBlock = (x) => /^\s*```/.test(x) || /^(#{1,6})\s+/.test(x) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(x) || /^\s*>/.test(x) || /^\s*([-*+]|\d+[.)])\s+/.test(x);
    let i = 0;
    while (i < L.length) {
        const l = L[i];
        if (!l.trim()) {
            i++;
            continue;
        }
        if (/^\s*```/.test(l)) {
            const lang = l.replace(/^\s*```/, "").trim();
            const buf = [];
            i++;
            while (i < L.length && !/^\s*```/.test(L[i])) {
                buf.push(L[i]);
                i++;
            }
            i++;
            out.push('<div class="mdcw" data-lang="' + esc(lang) + '"><button class="cpbtn" data-copy="code" title="Копировать" aria-label="Копировать">' + CP_ICON + '</button><pre class="mdcode"><code>' + esc(buf.join("\n")) + "</code></pre></div>");
            continue;
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
            out.push("<hr>");
            i++;
            continue;
        }
        const h = /^(#{1,6})\s+(.*)$/.exec(l);
        if (h) {
            out.push("<h" + h[1].length + ">" + mdInline(h[2]) + "</h" + h[1].length + ">");
            i++;
            continue;
        }
        if (l.includes("|") && isSep(L[i + 1])) {
            const head = mdSplitRow(l);
            i += 2;
            const rows = [];
            while (i < L.length && L[i].trim() && L[i].includes("|")) {
                rows.push(mdSplitRow(L[i]));
                i++;
            }
            out.push('<div class="mdt"><table><thead><tr>' + head.map((c) => "<th>" + mdInline(c) + "</th>").join("") + "</tr></thead><tbody>" + rows.map((r) => "<tr>" + head.map((_, k) => "<td>" + mdInline(r[k] ?? "") + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>");
            continue;
        }
        if (/^\s*>/.test(l)) {
            const buf = [];
            while (i < L.length && /^\s*>/.test(L[i])) {
                buf.push(L[i].replace(/^\s*>\s?/, ""));
                i++;
            }
            out.push("<blockquote>" + mdFull(buf.join("\n")) + "</blockquote>");
            continue;
        }
        const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
        if (li) {
            const items = [];
            while (i < L.length) {
                const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(L[i]);
                if (m) {
                    items.push({ ind: Math.min(6, Math.floor(m[1].replace(/\t/g, "    ").length / 2)), ord: /\d/.test(m[2]), text: m[3] });
                    i++;
                }
                else if (L[i].trim() && /^\s{2,}\S/.test(L[i]) && items.length && !isBlock(L[i])) {
                    items[items.length - 1].text += " " + L[i].trim();
                    i++;
                }
                else
                    break;
            }
            const tag = items[0].ord ? "ol" : "ul";
            out.push("<" + tag + ' class="mdl">' + items.map((it) => {
                const cb = /^\[( |x|X)\]\s+(.*)$/.exec(it.text);
                return '<li style="margin-left:' + it.ind * 18 + 'px">' + (cb ? '<span class="mdcb">' + (cb[1] === " " ? "☐" : "☑") + "</span> " + mdInline(cb[2]) : mdInline(it.text)) + "</li>";
            }).join("") + "</" + tag + ">");
            continue;
        }
        const buf = [];
        while (i < L.length && L[i].trim() && !isBlock(L[i]) && !(L[i].includes("|") && isSep(L[i + 1]))) {
            buf.push(L[i]);
            i++;
        }
        if (!buf.length) {
            buf.push(L[i]);
            i++;
        }
        out.push("<p>" + mdInline(buf.join("\n")).replace(/\n/g, "<br>") + "</p>");
    }
    return out.join("");
}

export function mdDoc(s) {
    return mdFull(s);
}

// Значок агента: пиксельный робот цвета слота. Состояние — классом: работает (руки и строки кода в движении), ждёт
// разрешения (!), на связи (лампа на антенне), давно без сообщений (лампа тусклая, z), спит (Zz), нет сессии (серый).
export function agentIcon(color, state, size) {
    const px = (x, y, w, h, fill, cls) => '<rect' + (cls ? ' class="' + cls + '"' : "") + ' x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + fill + '"/>';
    const c = "var(--c)", dark = "color-mix(in srgb,var(--c) 62%,#000)", eye = "#15171c", paper = "color-mix(in srgb,var(--c) 55%,#fff)";
    const body = px(7, 1, 1, 1, dark) + px(3, 2, 9, 6, c) + px(4, 3, 7, 1, paper);
    const eyes = state === "sleep" ? px(5, 5, 2, 1, eye) + px(8, 5, 2, 1, eye) : state === "drowsy" ? px(5, 5, 2, 1, eye) + px(8, 5, 2, 1, eye) + px(5, 4, 2, 1, dark) + px(8, 4, 2, 1, dark) : px(5, 4, 2, 2, eye) + px(8, 4, 2, 2, eye);
    const armL = '<g class="cl cll">' + px(1, 4, 2, 1, dark) + px(0, 3, 1, 2, c) + "</g>";
    const pen = '<g class="pen">' + px(14, 3, 1, 1, "#15171c") + px(15, 2, 1, 1, "#f2c14e") + px(16, 1, 1, 1, "#ffe08a") + "</g>";
    const armR = '<g class="cl clr">' + px(12, 4, 2, 1, dark) + px(14, 3, 1, 2, c) + pen + "</g>";
    const legs = '<g class="lgs">' + px(4, 8, 2, 2, dark) + px(9, 8, 2, 2, dark) + "</g>";
    const code = '<g class="code">' + px(17, 3, 6, 1, paper, "ln1") + px(17, 5, 4, 1, paper, "ln2") + px(17, 7, 5, 1, paper, "ln3") + "</g>";
    const lamp = '<g class="fl">' + px(7, 0, 1, 1, "#ff8a1f") + px(7, -1, 1, 1, "#ffd23f", "tip") + "</g>";
    const zz = '<g class="zz"><text class="z1" x="12.2" y="2" font-size="3.6" fill="var(--text-2)" font-weight="700">z</text><text class="z2" x="14.6" y="0.2" font-size="4.6" fill="var(--text-2)" font-weight="700">Z</text></g>';
    const mark = state === "wait" ? '<text x="7.5" y="1.6" font-size="4" text-anchor="middle" fill="var(--warn)" font-weight="700">!</text>' : "";
    const TITLE = { work: "работает: пишет код", wait: "ждёт вашего разрешения", warm: "на связи: процесс агента жив, ждёт сообщения", drowsy: "давно без сообщений, процесс агента жив", sleep: "спит: процесс остановлен, сессию можно продолжить", off: "нет сессии" };
    return '<svg class="agi ' + (state || "warm") + '" style="--c:' + color + ";--cs:" + (size || 22) + 'px" viewBox="0 -2 24 12" shape-rendering="crispEdges" role="img"><title>' + (TITLE[state] || "") + "</title>" + armL + body + eyes + code + armR + legs + lamp + zz + mark + "</svg>";
}

export function agentStateOf(a) {
    if (!a)
        return "off";
    if (a.pending)
        return "wait";
    if (a.busy)
        return "work";
    if (a.running)
        return a.idleSec != null && a.idleSec >= (a.cacheTtl || 3600) ? "drowsy" : "warm";
    return a.hasLast ? "sleep" : "off";
}

export const agentState = (key) => agentStateOf((S && S.agents && S.agents[key]) || null);

export function md(s) {
    const parts = String(s ?? "").split(/```(?:[\w-]*)\n?([\s\S]*?)```/);
    return parts.map((p, i) => i % 2 ? `<pre><code>${esc(p.replace(/\n$/, ""))}</code></pre>` : esc(p).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")).join("");
}

export function runWhen(j) {
    const ms = (j && (j.startedAt || j.queuedAt)) || 0;
    if (!ms)
        return "";
    const d = new Date(ms), now = new Date(), hm = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }) + " " + hm;
}
