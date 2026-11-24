// review.js — разметка владельца: план волны, эпик или чек-лист по блокам и дифф ветки по строкам → замечания
// («замечание», «вопрос», «удалить», «заменить на …») → агенту одним сообщением; «Одобрить» план; изменения новой версии
// плана против просмотренной. Черновики хранятся на сервере и переживают перезагрузку.
import { call, esc, toast } from "./core.js";
import { refresh } from "./data.js";

const say = (m, good) => toast(m, good);
const api = (p, body) => call(p, body);
const inl = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>").replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
const KINDS = [["note", "💬", "Замечание", "c"], ["question", "❓", "Вопрос", "q"], ["delete", "🗑", "Удалить", "d"], ["replace", "✎", "Заменить на…", "r"]];
const KW = Object.fromEntries(KINDS.map(([k, , w]) => [k, w]));
const DOCS = [["plan", "План волны"], ["epic", "Эпик"], ["master", "Сводка эпика"], ["checklist", "Чек-лист"]];
const R = { doc: null, tree: null, d: null, sel: null, comp: null, file: null, diff: null, preview: null, showChanges: false, busy: false, general: "" };

function root() {
    let el = document.getElementById("annot");
    if (!el) {
        el = document.createElement("div");
        el.id = "annot";
        document.body.appendChild(el);
        el.addEventListener("click", onClick);
        el.addEventListener("mouseup", onMouseUp);
        el.addEventListener("mousedown", (e) => {
            if (e.shiftKey && e.target.closest("[data-blk],[data-dl]"))
                e.preventDefault();
        });
        el.addEventListener("input", onInput);
    }
    return el;
}

export async function openAnnot(doc, tree) {
    R.doc = doc || "plan";
    R.tree = tree;
    R.d = null;
    R.sel = null;
    R.comp = null;
    R.file = null;
    R.diff = null;
    R.preview = null;
    R.showChanges = false;
    R.general = "";
    const el = root();
    el.classList.add("on");
    el.innerHTML = `<div class="an-box"><div class="an-h"><b>Разметка</b><span class="an-mute">загружаю…</span><span class="an-sp"></span><button class="an-btn ghost" data-an="close">закрыть ✕</button></div></div>`;
    await load();
}

export function closeAnnot() {
    const el = document.getElementById("annot");
    if (el)
        el.classList.remove("on");
    R.tree = null;
}

async function load() {
    try {
        R.d = await api("/api/annot?tree=" + encodeURIComponent(R.tree) + "&doc=" + encodeURIComponent(R.doc));
    }
    catch (e) {
        R.d = { error: e.message };
    }
    if (R.d && R.d.kind === "diff" && !R.file && (R.d.files || []).length) {
        R.file = R.d.files[0].path;
        loadFile();
    }
    render();
}

async function loadFile() {
    const f = R.file;
    R.diff = null;
    render();
    try {
        const r = await api(`/api/filediff?tree=${encodeURIComponent(R.tree)}&scope=branch&path=${encodeURIComponent(f)}`);
        if (R.file === f) {
            R.diff = parseDiff(r.text);
            render();
        }
    }
    catch (e) {
        R.diff = { error: e.message };
        render();
    }
}

const notes = () => (R.d && R.d.notes) || [];

function render() {
    const el = root(), d = R.d;
    if (!d || !R.tree)
        return;
    const keep = el.querySelector(".an-doc"), top = keep ? keep.scrollTop : 0;
    const tabs = d.kind === "diff" || d.kind === "backlog" ? "" : `<span class="an-seg">${DOCS.map(([k, w]) => `<button class="${R.doc === k ? "on" : ""}" data-an="doc" data-doc="${k}">${w}</button>`).join("")}</span>`;
    if (d.error) {
        el.innerHTML = `<div class="an-box"><div class="an-h"><b>Разметка</b>${tabs}<span class="an-sp"></span><button class="an-btn ghost" data-an="close">закрыть ✕</button></div><div class="an-empty">${esc(d.error)}</div></div>`;
        return;
    }
    const who = (d.tag || d.tree) + (d.title ? " · " + d.title : "");
    const head = `<div class="an-h"><b>${esc(who)}</b>${tabs}${d.kind === "diff" ? `<span class="an-mono an-mute">${esc(d.branch)} ← staging</span>${reviewChip(d.review)}` : `<span class="an-mono an-mute" title="${esc(d.file || "")}">${esc(d.file ? d.file.split("/").slice(-1)[0] : "чек-лист из панели «Приёмка»")}</span>`}${d.approved ? `<span class="an-chip ok">одобрен ${esc(new Date(d.approved.at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }))}</span>` : ""}${d.changed ? `<button class="an-chip warn" data-an="changes" title="Что поменялось с версии, которую вы смотрели ${esc(new Date(d.changed.at).toLocaleString("ru-RU"))} (${esc(d.changed.why)})">изменён после ${esc(d.changed.why || "просмотра")}: +${d.changed.add} −${d.changed.del} ${R.showChanges ? "▾" : "▸"}</button>` : ""}${d.sink === "log" ? '<span class="an-chip warn" title="DASH_ANNOT_SINK=log или сухой режим: сообщения пишутся в annot-outbox.jsonl, агентам не уходят">отладка: агенту не уходит</span>' : ""}<span class="an-sp"></span><button class="an-btn ghost" data-an="close">закрыть ✕</button></div>`;
    const main = d.kind === "diff" ? diffPane(d) : docPane(d);
    el.innerHTML = `<div class="an-box">${head}<div class="an-b">${main}${side(d)}</div></div>`;
    const nd = el.querySelector(".an-doc");
    if (nd)
        nd.scrollTop = top;
    const ta = el.querySelector(".an-comp textarea");
    if (ta && R.comp && R.comp.focus) {
        ta.focus();
        R.comp.focus = false;
    }
}

const reviewChip = (rv) => (!rv ? '<span class="an-chip">ревью владельца: не было</span>' : rv.state === "ok" ? `<span class="an-chip ok">ревью владельца: ОК</span>` : `<span class="an-chip warn">ревью владельца: замечания отправлены (${rv.n})</span>`);

function blockHTML(b, d, added) {
    const ns = notes().filter((n) => n.block != null && n.block <= b.i && (n.blockEnd ?? n.block) >= b.i);
    const sel = R.sel && R.sel.block != null && b.i >= R.sel.block && b.i <= (R.sel.blockEnd ?? R.sel.block);
    const chg = added && [...Array(b.end - b.line + 1).keys()].some((k) => added.has(b.line + k));
    let inner;
    if (b.kind === "h")
        inner = `<div class="an-h${b.level}">${inl(b.text.replace(/^#+\s*/, ""))}</div>`;
    else if (b.kind === "li")
        inner = `<div class="an-li" style="margin-left:${(b.depth || 0) * 18}px"><span class="an-mk">${b.checked === true ? "☑" : b.checked === false ? "☐" : b.ordered ? esc(b.marker) : "•"}</span><span>${b.text.split("\n").map((l, k) => inl(k ? l.trim() : l.replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, ""))).join("<br>")}</span></div>`;
    else if (b.kind === "tr")
        inner = `<div class="an-tr ${b.head ? "head" : ""}">${(b.cells || []).map((c) => `<span>${inl(c)}</span>`).join("")}</div>`;
    else if (b.kind === "code")
        inner = `<pre class="an-code">${esc(b.text.split("\n").slice(1, -1).join("\n"))}</pre>`;
    else if (b.kind === "quote")
        inner = `<blockquote>${b.text.split("\n").map((l) => inl(l.replace(/^\s*>\s?/, ""))).join("<br>")}</blockquote>`;
    else if (b.kind === "fm")
        inner = `<pre class="an-fm">${esc(b.text)}</pre>`;
    else if (b.kind === "hr")
        inner = "<hr>";
    else
        inner = `<p>${b.text.split("\n").map(inl).join("<br>")}</p>`;
    return `<div class="an-blk k-${b.kind}${sel ? " sel" : ""}${ns.length ? " has" : ""}${chg ? " chg" : ""}" data-blk="${b.i}"><span class="an-ln" title="строки файла">${b.line}${b.end > b.line ? "–" + b.end : ""}</span><div class="an-in">${inner}</div>${ns.length ? `<span class="an-cnt" title="замечаний к блоку">${ns.length}</span>` : ""}</div>` +
        (sel && R.sel && (R.sel.blockEnd ?? R.sel.block) === b.i ? toolbar() : "") + (R.comp && R.comp.block != null && (R.comp.blockEnd ?? R.comp.block) === b.i ? composer() : "");
}

function docPane(d) {
    const added = d.changed && d.changed.added ? new Set(d.changed.added) : null;
    const chg = R.showChanges && d.changed ? `<div class="an-chg"><div class="an-stt">Что поменялось после ${esc(d.changed.why || "просмотра")} (${esc(new Date(d.changed.at).toLocaleString("ru-RU"))}) · +${d.changed.add} −${d.changed.del}<span class="an-sp"></span><button class="an-btn" data-an="seen">Отметить просмотренным</button></div><pre>${d.changed.hunks.map((o) => o.t === "…" ? '<span class="gap">⋯</span>' : `<span class="${o.t === "+" ? "a" : o.t === "-" ? "d" : "c"}"><span class="n">${o.t === "-" ? "−" + o.a : o.b}</span>${esc(o.t === "=" ? " " : o.t)} ${esc(o.s)}</span>`).join("")}</pre></div>` : "";
    return `<div class="an-doc" tabindex="0">${chg}<div class="an-hint">Клик по блоку — выбрать (Shift+клик — до этого блока), выделите текст — замечание к фрагменту. Клавиши: j/k — соседний блок, c — замечание, q — вопрос, d — удалить, r — заменить.</div>${(d.blocks || []).map((b) => blockHTML(b, d, added)).join("")}</div>`;
}

function toolbar() {
    const s = R.sel, what = s.path ? s.path.split("/").pop() + ":" + s.line + (s.lineEnd > s.line ? "–" + s.lineEnd : "") : s.sel ? "«" + s.sel.slice(0, 50) + (s.sel.length > 50 ? "…" : "") + "»" : "блок" + (s.blockEnd != null && s.blockEnd !== s.block ? "и" : "");
    return `<div class="an-tb"><span class="an-mute">${esc(what)}:</span>${KINDS.map(([k, ic, w, key]) => `<button class="an-btn" data-an="kind" data-k="${k}" title="клавиша ${key}">${ic} ${w}</button>`).join("")}<button class="an-btn ghost" data-an="unsel">✕</button></div>`;
}

function composer() {
    const c = R.comp;
    return `<div class="an-comp"><div class="an-stt">${esc(KW[c.kind])}${c.id ? " · правка" : ""}</div>${c.kind === "replace" ? `<textarea data-anf="replace" rows="4" placeholder="Чем заменить">${esc(c.replace || "")}</textarea>` : ""}<textarea data-anf="text" rows="3" placeholder="${c.kind === "question" ? "Ваш вопрос агенту" : c.kind === "delete" ? "Почему удалить (необязательно)" : c.kind === "replace" ? "Почему (необязательно)" : "Что не так / что сделать"}">${esc(c.text || "")}</textarea><div class="an-row"><button class="an-btn primary" data-an="save">Сохранить</button><button class="an-btn ghost" data-an="cancel">Отмена</button><span class="an-mute">Ctrl+Enter — сохранить</span></div></div>`;
}

function side(d) {
    const ns = [...notes()].sort((a, b) => (a.path || "").localeCompare(b.path || "") || (a.line || 0) - (b.line || 0));
    const to = d.kind === "diff" ? "" : `<label class="an-mute">Кому: <select data-anf="to"><option value="${esc(d.agent || d.tree)}" ${d.to === (d.agent || d.tree) ? "selected" : ""}>${d.agent ? "агент бэклога" : "агент " + esc(d.tag || d.tree)}</option>${d.orch && d.orch !== d.tree ? `<option value="${esc(d.orch)}" ${d.to === d.orch ? "selected" : ""}>оркестратор</option>` : ""}</select></label>`;
    const list = ns.map((n) => `<div class="an-note k-${n.kind}" data-an="goto" data-id="${n.id}"><div class="an-nh"><b>${esc(KW[n.kind])}</b><span class="an-mono">${esc(n.path ? n.path.split("/").pop() + ":" + n.line + (n.lineEnd > n.line ? "–" + n.lineEnd : "") : (n.item ? n.item + " · " : "") + "стр. " + n.line + (n.lineEnd > n.line ? "–" + n.lineEnd : ""))}</span><span class="an-sp"></span><button class="an-x" data-an="edit" data-id="${n.id}" title="Править">✎</button><button class="an-x" data-an="del" data-id="${n.id}" title="Убрать">✕</button></div><div class="an-q">${esc((n.code || n.quote || "").slice(0, 160))}</div>${n.kind === "replace" ? `<div class="an-t">→ ${esc(n.replace)}</div>` : ""}${n.text ? `<div class="an-t">${esc(n.text)}</div>` : ""}</div>`).join("");
    const pv = R.preview ? `<div class="an-pv"><div class="an-stt">Сообщение ${esc(R.preview.toLabel)}<span class="an-sp"></span><button class="an-x" data-an="pvclose">✕</button></div><pre>${esc(R.preview.text)}</pre></div>` : "";
    return `<div class="an-side"><div class="an-stt">Замечания · ${ns.length}${ns.length ? '<span class="an-sp"></span><button class="an-x" data-an="clear" title="Убрать все">очистить</button>' : ""}</div><div class="an-notes">${list || '<div class="an-mute">Пока нет. Выберите блок или строку слева.</div>'}</div>
    <textarea data-anf="general" rows="2" placeholder="Общий комментарий (необязательно)">${esc(R.general)}</textarea>${to}${pv}
    <div class="an-row"><button class="an-btn" data-an="preview" ${ns.length || R.general ? "" : "disabled"}>Показать сообщение</button><button class="an-btn primary ${R.busy ? "busy" : ""}" data-an="send" ${ns.length || R.general ? "" : "disabled"}>→ Отправить ${d.kind === "diff" ? "агенту слота" : "агенту"}</button></div>
    <div class="an-row">${d.kind === "diff" ? `<button class="an-btn ok" data-an="reviewok" title="Ревью владельца: замечаний нет">✓ Ревью: ОК</button>` : d.kind === "backlog" ? `<button class="an-btn ghost" data-an="seen" title="Запомнить эту версию: следующая покажет, что дописал агент бэклога">Просмотрено</button>` : d.kind !== "checklist" ? `<button class="an-btn ok" data-an="approve" title="Агенту — «план одобрен»${d.kind === "plan" ? ", станция «План» — отметка вручную" : ""}; решение — в Obsidian и граф">✓ Одобрить</button><button class="an-btn ghost" data-an="seen" title="Запомнить эту версию: следующая покажет изменения против неё">Просмотрено</button>` : ""}</div></div>`;
}

function parseDiff(text) {
    const out = [];
    let nl = null, ol = null;
    for (const l of String(text || "").split("\n")) {
        const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
        if (l.startsWith("diff ") || l.startsWith("index ") || l.startsWith("+++") || l.startsWith("---"))
            continue;
        if (h) {
            ol = Number(h[1]);
            nl = Number(h[2]);
            out.push({ t: "h", s: l });
            continue;
        }
        if (nl == null) {
            if (l.trim())
                out.push({ t: "m", s: l });
            continue;
        }
        if (l.startsWith("+"))
            out.push({ t: "a", n: nl++, side: "new", s: l.slice(1) });
        else if (l.startsWith("-"))
            out.push({ t: "d", n: ol++, side: "old", s: l.slice(1) });
        else if (l.startsWith(" ") || l === "") {
            out.push({ t: "c", n: nl++, o: ol++, side: "new", s: l.slice(1) });
        }
        else
            out.push({ t: "m", s: l });
    }
    return { lines: out };
}

function diffPane(d) {
    const files = d.files || [];
    const fl = files.map((f) => {
        const n = notes().filter((x) => x.path === f.path).length;
        return `<div class="an-f ${R.file === f.path ? "on" : ""}" data-an="file" data-p="${esc(f.path)}" title="${esc(f.path)}"><span class="an-c">${esc(f.code)}</span><span class="an-fp">${esc(f.path)}</span>${n ? `<span class="an-cnt">${n}</span>` : ""}<span class="an-mute">+${f.add ?? "?"} −${f.del ?? "?"}</span></div>`;
    }).join("");
    let body = '<div class="an-empty">Выберите файл.</div>';
    if (!files.length)
        body = '<div class="an-empty">В ветке нет изменений против staging.</div>';
    else if (R.file && !R.diff)
        body = '<div class="an-empty">загружаю дифф…</div>';
    else if (R.diff && R.diff.error)
        body = `<div class="an-empty">${esc(R.diff.error)}</div>`;
    else if (R.diff) {
        const mine = notes().filter((n) => n.path === R.file), s = R.sel && R.sel.path === R.file ? R.sel : null;
        body = `<pre class="an-dl">${R.diff.lines.map((x, k) => {
            if (x.t === "h" || x.t === "m")
                return `<span class="dl ${x.t}">${esc(x.s)}</span>`;
            const inSel = s && s.side === x.side && x.n >= s.line && x.n <= s.lineEnd;
            const ns = mine.filter((n) => n.side === x.side && n.lineEnd === x.n);
            const tail = (s && s.side === x.side && s.lineEnd === x.n ? toolbar() : "") + (R.comp && R.comp.path === R.file && R.comp.side === x.side && R.comp.lineEnd === x.n ? composer() : "");
            return `<span class="dl ${x.t}${inSel ? " sel" : ""}${mine.some((n) => n.side === x.side && x.n >= n.line && x.n <= n.lineEnd) ? " has" : ""}" data-dl="${k}"><span class="n">${x.t === "d" ? "−" + x.n : x.n}</span>${esc(x.t === "a" ? "+" : x.t === "d" ? "-" : " ")}${esc(x.s) || " "}</span>${ns.map((n) => `<span class="an-inote k-${n.kind}">${esc(KW[n.kind])}: ${esc(n.kind === "replace" ? "→ " + n.replace + (n.text ? " · " + n.text : "") : n.text)}</span>`).join("")}${tail}`;
        }).join("")}</pre>`;
    }
    return `<div class="an-dwrap"><div class="an-files">${fl}</div><div class="an-doc" tabindex="0"><div class="an-hint">Клик по строке — выбрать, Shift+клик — диапазон (на той же стороне: новые или удалённые строки). Замечания уходят агенту слота пачкой: файл:строка + фрагмент + текст.</div>${body}</div></div>`;
}

function diffCode(s) {
    const ls = R.diff.lines.filter((x) => x.side === s.side && x.n >= s.line && x.n <= s.lineEnd && x.t !== "h");
    return ls.map((x) => x.s).join("\n").slice(0, 1500);
}

async function post(op, extra = {}) {
    return api("/api/annot", { op, tree: R.tree, doc: R.doc, ...extra });
}

function pickBlock(i, shift) {
    if (shift && R.sel && R.sel.block != null && !R.sel.sel) {
        const a = Math.min(R.sel.block, i), b = Math.max(R.sel.block, i);
        R.sel = { block: a, blockEnd: b };
    }
    else
        R.sel = { block: i };
    R.comp = null;
    render();
}

function startKind(kind) {
    if (!R.sel)
        return;
    const s = R.sel, base = s.path ? { path: s.path, line: s.line, lineEnd: s.lineEnd, side: s.side, code: diffCode(s) } : { block: s.block, blockEnd: s.blockEnd ?? s.block, sel: s.sel || "" };
    let replace = "";
    if (kind === "replace")
        replace = s.path ? base.code : s.sel || (R.d.blocks || []).filter((b) => b.i >= s.block && b.i <= (s.blockEnd ?? s.block)).map((b) => b.text).join("\n");
    R.comp = { ...base, kind, text: "", replace, focus: true };
    render();
}

async function saveComp() {
    const el = root(), c = R.comp;
    if (!c)
        return;
    const text = (el.querySelector('.an-comp [data-anf="text"]') || {}).value || "", replace = (el.querySelector('.an-comp [data-anf="replace"]') || {}).value || "";
    const note = { ...c, text, replace };
    delete note.focus;
    delete note.id;
    const s0 = R.sel;
    try {
        const r = c.id ? await post("edit", { id: c.id, note: { kind: c.kind, text, replace } }) : await post("add", { note });
        R.d.notes = r.notes;
        if (R.comp === c)
            R.comp = null;
        if (R.sel === s0)
            R.sel = null;
        R.preview = null;
        render();
    }
    catch (e) {
        say(e.message);
    }
}

async function onClick(e) {
    const t = e.target.closest("[data-an],[data-blk],[data-dl]");
    if (!t)
        return;
    if (t.dataset.blk != null && !t.dataset.an) {
        if (!e.shiftKey && String(window.getSelection() || "").trim())
            return;
        pickBlock(Number(t.dataset.blk), e.shiftKey);
        return;
    }
    if (t.dataset.dl != null && !t.dataset.an) {
        const x = R.diff.lines[Number(t.dataset.dl)];
        if (!x || x.n == null)
            return;
        if (e.shiftKey && R.sel && R.sel.path === R.file && R.sel.side === x.side)
            R.sel = { ...R.sel, line: Math.min(R.sel.anchor, x.n), lineEnd: Math.max(R.sel.anchor, x.n) };
        else
            R.sel = { path: R.file, side: x.side, line: x.n, lineEnd: x.n, anchor: x.n };
        R.comp = null;
        render();
        return;
    }
    const a = t.dataset.an;
    try {
        if (a === "close")
            closeAnnot();
        else if (a === "doc") {
            R.doc = t.dataset.doc;
            R.d = null;
            R.sel = null;
            R.comp = null;
            R.preview = null;
            R.showChanges = false;
            await load();
        }
        else if (a === "changes") {
            R.showChanges = !R.showChanges;
            render();
        }
        else if (a === "unsel") {
            R.sel = null;
            R.comp = null;
            render();
        }
        else if (a === "kind")
            startKind(t.dataset.k);
        else if (a === "save")
            await saveComp();
        else if (a === "cancel") {
            R.comp = null;
            render();
        }
        else if (a === "file") {
            R.file = t.dataset.p;
            R.sel = null;
            R.comp = null;
            await loadFile();
        }
        else if (a === "del") {
            e.stopPropagation();
            const r = await post("del", { id: t.dataset.id });
            R.d.notes = r.notes;
            R.preview = null;
            render();
        }
        else if (a === "edit") {
            e.stopPropagation();
            const n = notes().find((x) => x.id === t.dataset.id);
            if (!n)
                return;
            if (n.path && n.path !== R.file) {
                R.file = n.path;
                await loadFile();
            }
            R.sel = n.path ? { path: n.path, side: n.side, line: n.line, lineEnd: n.lineEnd, anchor: n.line } : { block: n.block, blockEnd: n.blockEnd, sel: n.sel };
            R.comp = { ...n, focus: true };
            render();
        }
        else if (a === "goto") {
            const n = notes().find((x) => x.id === t.dataset.id);
            if (!n)
                return;
            if (n.path) {
                if (n.path !== R.file) {
                    R.file = n.path;
                    await loadFile();
                }
            }
            else {
                const el = root().querySelector(`[data-blk="${n.block}"]`);
                if (el)
                    el.scrollIntoView({ block: "center", behavior: "smooth" });
            }
        }
        else if (a === "clear") {
            if (confirm("Убрать все замечания к этому документу?")) {
                const r = await post("clear");
                R.d.notes = r.notes;
                R.preview = null;
                render();
            }
        }
        else if (a === "pvclose") {
            R.preview = null;
            render();
        }
        else if (a === "preview") {
            const r = await post("preview", { general: R.general, to: toSel() });
            R.preview = { text: r.text, toLabel: toLabel(r.to) };
            render();
        }
        else if (a === "send") {
            if (R.busy)
                return;
            R.busy = true;
            render();
            try {
                const r = await post("send", { general: R.general, to: toSel() });
                R.preview = { text: r.text, toLabel: toLabel(r.to) + (r.logged ? " (в журнал, агенту не ушло)" : " — отправлено") };
                R.general = "";
                say(r.message, true);
                await load();
                refresh(true).catch(() => { });
            }
            finally {
                R.busy = false;
                render();
            }
        }
        else if (a === "approve") {
            if (notes().length && !confirm("Есть неотправленные замечания (" + notes().length + "). Одобрить план всё равно? Замечания останутся черновиком."))
                return;
            const r = await post("approve", { general: R.general, to: toSel() });
            say(r.message, true);
            await load();
            refresh(true).catch(() => { });
        }
        else if (a === "seen") {
            const r = await post("seen");
            say(r.message, true);
            R.showChanges = false;
            await load();
        }
        else if (a === "reviewok") {
            if (notes().length && !confirm("Есть неотправленные замечания. Поставить «ОК» всё равно?"))
                return;
            const r = await post("review-ok");
            R.d.review = r.review;
            say(r.message, true);
            render();
        }
    }
    catch (err) {
        say(err.message);
    }
}

const toSel = () => {
    const s = root().querySelector('[data-anf="to"]');
    return s ? s.value : undefined;
};

const toLabel = (k) => (R.d && k === R.d.orch && k !== R.d.tree ? "оркестратору" : R.d && R.d.agent && k === R.d.agent ? "агенту бэклога" : "агенту " + ((R.d && R.d.tag) || k));

function onInput(e) {
    if (e.target.dataset.anf === "general")
        R.general = e.target.value;
    if (R.comp && e.target.closest(".an-comp"))
        R.comp[e.target.dataset.anf] = e.target.value;
}

function onMouseUp(e) {
    if (!R.d || R.d.kind === "diff" || e.shiftKey || e.target.closest(".an-tb,.an-comp,.an-side"))
        return;
    const s = window.getSelection(), txt = String(s || "").trim();
    if (!txt)
        return;
    const a = s.anchorNode && s.anchorNode.parentElement && s.anchorNode.parentElement.closest("[data-blk]"), b = s.focusNode && s.focusNode.parentElement && s.focusNode.parentElement.closest("[data-blk]");
    if (!a || !b)
        return;
    const i = Number(a.dataset.blk), j = Number(b.dataset.blk);
    R.sel = i === j ? { block: i, sel: txt.slice(0, 1500) } : { block: Math.min(i, j), blockEnd: Math.max(i, j) };
    R.comp = null;
    setTimeout(render, 0);
}

document.addEventListener("keydown", (e) => {
    const el = document.getElementById("annot");
    if (!el || !el.classList.contains("on"))
        return;
    if (e.key === "Escape") {
        if (R.comp) {
            R.comp = null;
            render();
        }
        else if (R.sel) {
            R.sel = null;
            render();
        }
        else
            closeAnnot();
        return;
    }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || "")) {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && R.comp) {
            e.preventDefault();
            saveComp();
        }
        return;
    }
    const k = e.key.toLowerCase(), hit = KINDS.find((x) => x[3] === k);
    if (hit && R.sel) {
        e.preventDefault();
        startKind(hit[0]);
        return;
    }
    if ((k === "j" || k === "k") && R.d && R.d.blocks) {
        e.preventDefault();
        const cur = R.sel && R.sel.block != null ? R.sel.block : -1, n = R.d.blocks.length;
        const i = Math.max(0, Math.min(n - 1, cur + (k === "j" ? 1 : -1)));
        pickBlock(i, false);
        const b = root().querySelector(`[data-blk="${i}"]`);
        if (b)
            b.scrollIntoView({ block: "nearest" });
    }
});
