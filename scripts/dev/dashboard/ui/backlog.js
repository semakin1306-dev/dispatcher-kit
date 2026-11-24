// backlog.js — раздел рейла «Бэклог»: быстрый ввод заметки, список с отбором по статусу, области и эпику, карточка
// элемента с кнопками «Исследовать», «В эпик…», «Разметить», чат агента бэклога. Подключается одной строкой из main.js:
// строка рейла, иконка, панель, стили.
import { PENDING, S } from "./state.js";
import { $, call, esc, ls, mdFull, setHTML, SPIN, toast } from "./core.js";
import { ICONS, RAIL, RAIL_PANELS, RAILM, renderRail, setRail } from "./side.js";
import { focusChat, mountChats, pollChats } from "./chat.js";

const KEY = "backlog", MODE = "backlog";

const BL = { data: null, err: "", busy: false, sel: (() => {
        try {
            return localStorage.getItem("dash.blsel") || "";
        }
        catch {
            return "";
        }
    })(), f: (() => {
        try {
            return JSON.parse(localStorage.getItem("dash.blf") || "{}");
        }
        catch {
            return {};
        }
    })(), epicOpen: "", at: 0 };

const ST_CLS = { new: "queued", researching: "running", researched: "ok", planned: "", "in-wave": "", done: "ok", rejected: "fail", dropped: "fail" };
const CLOSED = ["done", "rejected", "dropped"], TRIAGE_OPEN = ["new", "researching", "researched"];
const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7.5 7.5h-.75A2.25 2.25 0 0 0 4.5 9.75v7.5a2.25 2.25 0 0 0 2.25 2.25h7.5a2.25 2.25 0 0 0 2.25-2.25v-7.5a2.25 2.25 0 0 0-2.25-2.25h-.75m-6 3.75 3 3m0 0 3-3m-3 3V1.5m6 9h.75a2.25 2.25 0 0 1 2.25 2.25v7.5a2.25 2.25 0 0 1-2.25 2.25h-7.5a2.25 2.25 0 0 1-2.25-2.25v-.75"/></svg>';
const word = (s) => (BL.data && BL.data.words && BL.data.words[s]) || s;
const chip = (s) => `<span class="chip ${ST_CLS[s] || ""}" title="статус: ${esc(s)}">${esc(word(s))}</span>`;
const items = () => (BL.data && BL.data.items) || [];
const itemById = (id) => items().find((x) => x.id === id) || null;

async function load(quiet) {
    if (BL.busy)
        return;
    BL.busy = true;
    try {
        BL.data = await call("/api/backlog");
        BL.err = "";
        BL.at = Date.now();
    }
    catch (e) {
        BL.err = e.message;
        if (!quiet)
            toast(e.message);
    }
    finally {
        BL.busy = false;
    }
    if (BL.sel && !itemById(BL.sel))
        selItem("");
    repaint();
}

function repaint() {
    if (RAILM === MODE) {
        const p = $("sidepanel");
        if (p)
            renderPanel(p);
    }
    renderRail();
}

const save = () => {
    ls("dash.blf", BL.f);
    ls("dash.blsel", BL.sel);
};

function selItem(id) {
    BL.sel = id;
    BL.epicOpen = "";
    save();
}

async function op(body, okMsg) {
    const k = "bl|" + body.op + "|" + (body.id || "");
    if (PENDING.has(k))
        return;
    PENDING.add(k);
    repaint();
    try {
        const r = await call("/api/backlog", body);
        toast(r.message || okMsg || "Готово", true);
        await load(true);
        return r;
    }
    catch (e) {
        toast(e.message);
    }
    finally {
        PENDING.delete(k);
        repaint();
    }
}

const SKELETON = `<div class="bl-root"><form class="bl-quick" autocomplete="off"><textarea data-bl-draft rows="3" placeholder="Заметка из головы: что увидели, где, чего хотите. Текст уйдёт как есть, заголовок — первой строкой. Ctrl+Enter — добавить"></textarea>
  <div class="chips"><button type="button" class="sm primary" data-bl="add" title="Записать элемент BL со статусом «новый»">＋ Добавить</button><button type="button" class="sm" data-bl="addres" title="Записать и сразу отдать агенту бэклога на исследование">＋ и исследовать</button><span class="sp"></span><span class="sub" data-bl-r="dir"></span></div></form>
  <div class="bl-main"></div>
  <details class="bl-agent"><summary><b>Агент бэклога</b> <span class="sub" data-bl-r="agent"></span></summary><div class="chatslot" data-key="${KEY}"></div></details></div>`;

function renderPanel(panel) {
    if (!panel.querySelector(":scope > .bl-root")) {
        setHTML(panel, SKELETON);
        const d = panel.querySelector(".bl-agent");
        try {
            d.open = localStorage.getItem("dash.blchat") === "1";
        }
        catch { }
        d.addEventListener("toggle", () => {
            ls("dash.blchat", d.open ? "1" : "0");
            if (d.open) {
                mountChats();
                pollChats();
            }
        });
    }
    if (!BL.data && !BL.busy && !BL.err)
        load(true);
    const main = panel.querySelector(".bl-main"), ae = document.activeElement;
    if (!(ae && main.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)))
        setHTML(main, mainHtml());
    const D = BL.data || {}, dir = panel.querySelector('[data-bl-r="dir"]'), ag = panel.querySelector('[data-bl-r="agent"]'), a = D.agent || {};
    const dt = D.dir ? (D.dry ? "сухой экземпляр · " : "") + D.dir : "";
    if (dir.textContent !== dt) {
        dir.textContent = dt;
        dir.title = "Папка бэклога" + (D.cli ? "; из командной строки: node " + D.cli + " list" : "");
    }
    const at = a.pending ? "ждёт разрешения" : a.busy ? (a.activity || "думает…") : a.running ? "запущен" + (a.model ? " · " + a.model : "") : a.hasLast ? "спит, сессия сохранена" : "ещё не запускался";
    if (ag.textContent !== at)
        ag.textContent = at;
    if (panel.querySelector(".bl-agent").open)
        mountChats();
}

function filtered() {
    const f = BL.f;
    return items().filter((it) => (!f.status || (f.status === "open" ? !CLOSED.includes(it.status) : f.status === "triage" ? !!it.retro && TRIAGE_OPEN.includes(it.status) : it.status === f.status)) && (!f.area || (it.area || []).includes(f.area)) && (!f.epic || (f.epic === "-" ? !it.epic : it.epic === f.epic)));
}

function filtersHtml() {
    const D = BL.data, all = items(), cnt = (s) => all.filter((x) => x.status === s).length, f = BL.f;
    const areas = [...new Set(all.flatMap((x) => x.area || []))].sort(), eps = [...new Set([...(D.epics || []).map((e) => e.id), ...all.map((x) => x.epic).filter(Boolean)])].sort();
    const opt = (v, t, cur) => `<option value="${esc(v)}" ${cur === v ? "selected" : ""}>${esc(t)}</option>`;
    return `<div class="bl-f"><select data-blf="status" title="Статус">${opt("", "все статусы (" + all.length + ")", f.status || "")}${opt("open", "открытые", f.status || "")}${opt("triage", "ретро: ждут решения (" + all.filter((x) => x.retro && TRIAGE_OPEN.includes(x.status)).length + ")", f.status || "")}${(D.statuses || []).map((s) => opt(s, word(s) + " (" + cnt(s) + ")", f.status || "")).join("")}</select>
    <select data-blf="area" title="Область">${opt("", "все области", f.area || "")}${areas.map((a) => opt(a, a, f.area || "")).join("")}</select>
    <select data-blf="epic" title="Эпик">${opt("", "все эпики", f.epic || "")}${opt("-", "без эпика", f.epic || "")}${eps.map((e) => opt(e, e, f.epic || "")).join("")}</select>
    <button type="button" class="sm ghost" data-bl="reload" title="Перечитать папку бэклога">⟳</button></div>`;
}

function mainHtml() {
    if (!BL.data)
        return BL.err ? `<div class="sub">Бэклог не загрузился: ${esc(BL.err)} <button class="sm" data-bl="reload">ещё раз</button></div>` : `<div class="sub">${SPIN} Загружаю бэклог…</div>`;
    const it = BL.sel && itemById(BL.sel);
    if (it)
        return cardHtml(it);
    const list = filtered();
    return filtersHtml() + (list.length ? `<div class="bl-list">${list.map((x) => `<div class="bl-row" data-bl="sel" data-id="${esc(x.id)}" title="Открыть карточку ${esc(x.id)}"><div class="bl-rh"><span class="mono">${esc(x.id)}</span>${chip(x.status)}${x.epic ? `<span class="chip" title="эпик">📁 ${esc(x.epic)}${x.wave ? " · " + esc(x.wave) : ""}</span>` : ""}<span class="sp"></span><span class="mute">${esc(x.created || "")}</span></div><div class="bl-rt">${esc(x.title)}</div>${(x.area || []).length ? `<div class="bl-ar">${x.area.map((a) => `<span class="bl-tag">${esc(a)}</span>`).join("")}</div>` : ""}${x.error ? `<div class="err">${esc(x.error)}</div>` : ""}</div>`).join("")}</div>`
        : `<div class="calm">${items().length ? "Под отбор ничего не попало." : "Бэклог пуст. Запишите первую заметку полем выше — агент бэклога исследует её, когда скажете."}</div>`);
}

function refsHtml(it) {
    const r = it.refs || {}, n = (r.modules || []).length + (r.notes || []).length + (r.decisions || []).length + (r.backlog || []).length + (it.epic ? 1 : 0) + (it.wave ? 1 : 0);
    if (!n)
        return "";
    const ch = (t, title) => `<span class="bl-tag" title="${esc(title)}">${esc(t)}</span>`;
    return `<div class="bl-sec"><div class="bl-sh">Связи в графе <span class="sp"></span></div><div class="bl-ar">
    ${it.epic ? ch("Epic:" + it.epic, "PART_OF") : ""}${it.wave ? ch("Wave:" + it.wave, "IN_WAVE") : ""}${(r.modules || []).map((m) => ch(m, "TOUCHES → Module (граф кода)")).join("")}${(r.notes || []).map((m) => ch("Note:" + m, "REFERS")).join("")}${(r.decisions || []).map((m) => ch("Decision:" + m, "REFERS")).join("")}${(r.backlog || []).map((b) => `<button class="bl-tag lnk" data-bl="sel" data-id="${esc(b)}" title="RELATED: открыть ${esc(b)}">${esc(b)}</button>`).join("")}</div></div>`;
}

function epicForm(it) {
    const eps = (BL.data.epics || []), cur = eps.find((e) => e.id === (BL.f.epicPick || it.epic || (S && S.activeEpic))) || eps[0];
    if (!eps.length)
        return `<div class="bl-ep sub">Открытых эпиков нет — заведите эпик (/new-epic в окне оркестратора).</div>`;
    return `<div class="bl-ep"><div class="sub">Элемент получит эпик (и волну, если выбрана) и статус «${esc(word("planned"))}» / «${esc(word("in-wave"))}»; оркестратору эпика уйдёт сообщение со ссылкой на файл.</div>
    <div class="chips"><select data-bl-ep="epic">${eps.map((e) => `<option value="${esc(e.id)}" ${cur && cur.id === e.id ? "selected" : ""}>${esc(e.title || e.id)}</option>`).join("")}</select>
    <select data-bl-ep="wave"><option value="">без волны (planned)</option>${((cur && cur.waves) || []).map((w) => `<option value="${esc(w.wv)}" ${it.wave === w.wv ? "selected" : ""}>${esc(w.wv + " · " + w.tag + " · " + w.title)}</option>`).join("")}</select>
    <input data-bl-ep="wv" placeholder="или WV-NNNN" size="10" value=""></div>
    <div class="chips"><button class="sm primary ${PENDING.has("bl|epic|" + it.id) ? "busy" : ""}" data-bl="epicgo" data-id="${esc(it.id)}">${PENDING.has("bl|epic|" + it.id) ? SPIN : "📁"} Включить</button><button class="sm ghost" data-bl="epicx">отмена</button></div></div>`;
}

function cardHtml(it) {
    const busy = (o) => PENDING.has("bl|" + o + "|" + it.id), b = (o, ic, t, cls = "", tip = "") => `<button class="sm ${cls} ${busy(o) ? "busy" : ""}" data-bl="${o}" data-id="${esc(it.id)}" title="${esc(tip)}">${busy(o) ? SPIN : ic} ${t}</button>`;
    const closed = CLOSED.includes(it.status), D = BL.data;
    const sec = (t, body, empty) => `<div class="bl-sec"><div class="bl-sh">${t}</div>${body ? `<div class="mdv bl-md">${mdFull(body)}</div>` : `<div class="sub">${empty}</div>`}</div>`;
    return `<div class="bl-card"><div class="bl-ch"><button class="sm ghost" data-bl="back" title="К списку">← список</button><b class="mono">${esc(it.id)}</b>${chip(it.status)}<span class="sp"></span><span class="mute">${esc(it.created || "")}</span></div>
    <div class="bl-title">${esc(it.title)}</div>
    <div class="bl-meta"><span>${(it.area || []).length ? it.area.map((a) => `<span class="bl-tag">${esc(a)}</span>`).join("") : '<span class="mute">область — заполнит агент</span>'}</span>${it.epic ? `<span class="chip">📁 ${esc(it.epic)}${it.wave ? " · " + esc(it.wave) : ""}</span>` : ""}<span class="mute" title="откуда">${esc(it.source || "")}</span>${it.reason ? `<span class="chip fail" title="причина отказа">✗ ${esc(it.reason)}</span>` : ""}</div>
    <div class="mono mute bl-path" title="Файл элемента (правки — кнопками или node ${esc(D.cli || "backlog.mjs")} set)">${esc(it.path || it.file)}</div>
    <div class="chips bl-acts">${b("research", "🔎", it.researchText ? "Исследовать заново" : "Исследовать", it.status === "new" ? "primary" : "", "Отдать агенту бэклога: дерево кода перемотается на staging, агент допишет «Исследование» и «Предзаготовку плана»" + (D.sink === "log" ? " (сухой режим: сообщение — в журнал, агенту не уходит)" : ""))}${b("epicopen", "📁", it.epic ? "Эпик/волна…" : "В эпик…", it.status === "researched" ? "primary" : "", "Включить в эпик (и волну): статус planned / in-wave и сообщение оркестратору эпика")}<button class="sm" data-annot="backlog" data-tree="${esc(it.id)}" title="Разметить элемент по блокам: замечания агенту бэклога (или оркестратору эпика) одним сообщением">✎ Разметить</button>${closed ? b("reopen", "↺", "Вернуть", "", "Вернуть в работу: статус «исследован», если исследование есть, иначе «новый»") : b("done", "✓", "Готово", "", "Сделано (влито)") + b("drop", "✗", "Отказ…", "ghost", "Не делаем: статус «отказ» с причиной одной строкой")}</div>
    ${BL.epicOpen === it.id ? epicForm(it) : ""}
    ${sec("Текст владельца", it.owner, "—")}
    ${sec("Исследование", it.researchText, it.status === "researching" ? SPIN + " агент бэклога исследует…" : "Ещё не исследовано — «Исследовать».")}
    ${sec("Предзаготовка плана", it.planText, "Появится вместе с исследованием: затронутые узлы, тесты, гарды, варианты, риски, оценка, куда в эпик.")}
    ${refsHtml(it)}</div>`;
}

async function addDraft(research) {
    const ta = document.querySelector("[data-bl-draft]"), text = ta ? ta.value.trim() : "";
    if (!text) {
        toast("Напишите заметку");
        if (ta)
            ta.focus();
        return;
    }
    const r = await op({ op: "add", text, research: !!research });
    if (r && r.item) {
        ta.value = "";
        selItem(r.item.id);
        repaint();
    }
}

async function onClick(e) {
    const t = e.target.closest("[data-bl]");
    if (!t)
        return;
    const a = t.dataset.bl, id = t.dataset.id;
    e.preventDefault();
    if (a === "add" || a === "addres")
        return addDraft(a === "addres");
    if (a === "reload")
        return load();
    if (a === "sel") {
        selItem(id);
        repaint();
        const sp = $("sidepanel");
        if (sp)
            sp.scrollTop = 0;
        return;
    }
    if (a === "back") {
        selItem("");
        return repaint();
    }
    if (a === "epicopen") {
        BL.epicOpen = BL.epicOpen === id ? "" : id;
        BL.f.epicPick = "";
        return repaint();
    }
    if (a === "epicx") {
        BL.epicOpen = "";
        return repaint();
    }
    if (a === "epicgo") {
        const p = (k) => (document.querySelector(`[data-bl-ep="${k}"]`) || {}).value || "", wave = p("wv").trim() || p("wave");
        const r = await op({ op: "epic", id, epic: p("epic"), wave });
        if (r)
            BL.epicOpen = "";
        return repaint();
    }
    if (a === "research") {
        const it = itemById(id);
        if (it && it.researchText && !confirm("Исследовать " + id + " заново? Разделы «Исследование» и «Предзаготовка плана» агент перепишет целиком."))
            return;
        const r = await op({ op: "research", id });
        if (r && !(BL.data && BL.data.sink === "log")) {
            const d = document.querySelector(".bl-agent");
            if (d && !d.open)
                d.open = true;
            setTimeout(() => focusChat(KEY), 500);
        }
        return;
    }
    if (a === "done")
        return op({ op: "done", id });
    if (a === "drop") {
        const why = (prompt("Отказ " + id + ": причина одной строкой (элемент останется в папке со статусом «отказ»)") || "").trim();
        if (why)
            return op({ op: "drop", id, reason: why });
        return;
    }
    if (a === "reopen") {
        const it = itemById(id);
        return op({ op: "status", id, status: it && it.researchText ? "researched" : "new" });
    }
}

function onChange(e) {
    const f = e.target.dataset && e.target.dataset.blf;
    if (f) {
        BL.f[f] = e.target.value;
        save();
        e.target.blur();
        return repaint();
    }
    if (e.target.dataset && e.target.dataset.blEp === "epic") {
        BL.f.epicPick = e.target.value;
        const it = itemById(BL.epicOpen);
        if (it) {
            e.target.blur();
            repaint();
        }
    }
}

const badge = () => items().filter((x) => x.status === "new").length + ((S && S.inbox) || []).filter((x) => x.tree === KEY && x.kind === "ownerq").length;

export function installBacklog() {
    ICONS[MODE] = ICON;
    if (!RAIL.some((x) => x[0] === MODE))
        RAIL.push([MODE, "📥", "Бэклог", "задачи и замечания между волнами: быстрый ввод, исследование агентом, в эпик", "backlog"]);
    RAIL_PANELS[MODE] = { render: renderPanel, badge };
    if (!document.getElementById("bl-css")) {
        const l = document.createElement("link");
        l.id = "bl-css";
        l.rel = "stylesheet";
        l.href = import.meta.url.replace(/backlog\.js(\?.*)?$/, "backlog.css");
        document.head.appendChild(l);
    }
    document.addEventListener("click", (e) => {
        const t = e.target.closest && e.target.closest("#sidepanel [data-bl]");
        if (t)
            onClick(e).catch((err) => toast(err.message));
    });
    document.addEventListener("click", (e) => {
        const t = e.target.closest && e.target.closest('[data-act="focuschat"][data-tree="backlog"],[data-act="chat"][data-tree="backlog"]');
        if (!t)
            return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (RAILM !== MODE)
            setRail(MODE);
        const d = document.querySelector(".bl-agent");
        if (d)
            d.open = true;
        mountChats();
        pollChats();
        setTimeout(() => focusChat(KEY), 300);
    }, true);
    document.addEventListener("click", (e) => {
        const t = e.target.closest && e.target.closest('[data-act="bltriage"]');
        if (!t)
            return;
        e.preventDefault();
        const m = $("modal");
        if (m)
            m.classList.remove("on");
        BL.f.status = "triage";
        selItem("");
        save();
        if (RAILM !== MODE)
            setRail(MODE);
        else
            repaint();
    });
    document.addEventListener("change", (e) => {
        if (e.target.closest && e.target.closest("#sidepanel .bl-root"))
            onChange(e);
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target.matches && e.target.matches("[data-bl-draft]")) {
            e.preventDefault();
            addDraft(false).catch((err) => toast(err.message));
        }
    });
    setInterval(() => {
        if (RAILM === MODE || Date.now() - BL.at > 120000)
            load(true);
    }, 30000);
    load(true);
    try {
        if (localStorage.getItem("dash.rail") === MODE)
            setRail(MODE);
    }
    catch { }
}
