// dialogs.js — окна страницы: станция, изменения и дифф ветки, влив и выкат, лог прогона, экран выката стенда, клавиши.
import { drawer, logAt, logFinal, logPos, PENDING, S, setState, SFX_HIDE, SFX_OPEN } from "./state.js";
import { $, call, dur, durText, esc, ls, md, mdDoc, SPIN, toast } from "./core.js";
import { render } from "./render.js";
import { refresh, treeOf } from "./data.js";
import { chipOf, expandTrainWagons, nextStep, stagesOf } from "./lines.js";
import { cargoHtml, paintFx, railHtml } from "./trainfx.js";

// Этапы выката стенда присылает прогон (stagesDef — [[id, подпись]] из команды выката); без них — один этап «Выкат».
const STAND_DEF = [["run", "Выкат"], ["done", "Стенд"]];
let SFX_SEEN = null;

export function standJob() {
    return [...S.jobs].reverse().find((j) => j.task === "deploy-staging");
}

function standStages(j) {
    const def = j.stagesDef || STAND_DEF, pr = j.prog || {}, st = { ...(pr.stages || {}) };
    let cur = pr.cur;
    const fin = ["ok", "fail", "cancelled", "interrupted"].includes(j.status);
    if (j.status === "ok")
        for (const [id] of def)
            st[id] = st[id] === "skip" ? "skip" : "ok";
    else if (fin) {
        const c = cur && cur !== "done" ? cur : def[0][0];
        st[c] = "bad";
        cur = c;
    }
    else if (!cur && j.status !== "running")
        cur = null;
    return { def, st, cur, at: pr.at || {} };
}

function standWagons(j) {
    if (j.wagons && j.wagons.length)
        return expandTrainWagons(j.wagons);
    return expandTrainWagons(S.trees.filter((t) => t.exists && t.kind === "slot" && nextStep(t).stand).map((t) => ({ key: t.key, tag: t.tag, color: t.color, title: t.title })));
}

export function renderStandFx() {
    const el = $("standfx");
    if (!el)
        return;
    const j = standJob(), live = j && ["queued", "waiting", "running"].includes(j.status);
    if (j && live && SFX_SEEN !== j.id) {
        SFX_SEEN = j.id;
        setState("SFX_OPEN", j.id);
    }
    const show = j && SFX_HIDE !== j.id && SFX_OPEN === j.id;
    el.classList.toggle("on", !!show);
    if (!show) {
        el.dataset.job = "";
        return;
    }
    const { def, st, cur, at } = standStages(j), W = standWagons(j), n = def.length;
    const curI = j.status === "ok" ? n - 1 : Math.max(0, cur ? def.findIndex((x) => x[0] === cur) : 0);
    const passed = j.status === "ok" ? n - 1 : Math.max(0, def.filter((x) => st[x[0]] === "ok" || st[x[0]] === "skip").length - (st.done === "ok" ? 1 : 0));
    const going = j.status === "running", ok = j.status === "ok", bad = !live && !ok;
    const tm = (id, i) => {
        const a = at[id];
        if (!a)
            return "";
        const nx = def.slice(i + 1).map((x) => at[x[0]]).find(Boolean);
        return nx ? Math.max(1, Math.round((nx - a) / 1000)) + " с" : st[id] === "run" && going ? '<span data-t0="' + a + '"></span>' : "";
    };
    const head = going ? `<span class="chip running">${SPIN} идёт · ${dur(j)}</span>` : ok ? `<span class="chip ok">✓ стенд выкачен · ${durText(j)}</span>` : j.status === "queued" || j.status === "waiting" ? `<span class="chip queued">в очереди</span>` : `<span class="chip fail">✗ ${j.status === "cancelled" ? "остановлен" : "упал"} на «${esc((def.find((x) => x[0] === cur) || def[0])[1])}» · ${durText(j)}</span>`;
    const foot = bad ? `<div class="why">${esc(j.summary || "выкат остановился, подробности в логе")}${/Connection timed out|Connection refused|port 22/.test(j.summary || "") ? "\n\nSSH до машины стенда не прошёл: проверьте доступ по ssh и не заблокирован ли адрес этой машины." : ""}</div>`
        : ok ? `<div class="okbox">Все этапы пройдены — стенд на коммите staging. Дальше приёмка: чек-листы волн в панели «Приёмка».</div>` : "";
    const acts = `${ok ? `<button class="sm primary" data-act="rail" data-m="accept">✅ Приёмка</button>` : ""}${bad ? `<button class="sm primary" data-act="pl" data-action="deploy-staging">↻ Выкатить ещё раз…</button>` : ""}<button class="sm" data-act="log" data-id="${j.id}">весь лог ▸</button>${going ? `<button class="sm ghost" data-act="cancel" data-id="${j.id}">стоп</button>` : ""}<button class="sm ghost" data-act="sfxclose" title="Свернуть (вернуть — кнопка «🚂 Экран выката» на линии staging)">✕</button>`;
    const body = `<div class="sfx"><div class="sfh"><b>🚂 Выкат staging на стенд</b>${head}<span class="mono mute">${esc(j.id)}</span><span class="sp"></span>${acts}</div>
    <div class="sfsub">${bad ? "Остановился на этапе " + (curI + 1) + " из " + n : ok ? "Все " + n + " этапов пройдены" : "Этап " + Math.min(passed + 1, n) + " из " + n}${going && j.prog && j.prog.phase ? " · " + esc(j.prog.phase) : ""}</div>
    ${railHtml({ def, st, curI, going, ok, bad, wagons: W, tm, key: "standfx" })}${cargoHtml(W, { ok, bad, dest: "на стенд" })}${foot}</div>`;
    paintFx(el, body);
}

let logBusy = false, logGen = 0;

export function openLog(id) {
    setState("drawer", id);
    setState("logPos", 0);
    setState("logFinal", false);
    logGen++;
    $("log").textContent = "";
    $("drawer").classList.add("on");
    pollLog();
}

export async function pollLog() {
    if (!drawer || logBusy)
        return;
    logBusy = true;
    const gen = logGen, from = logPos;
    try {
        const r = await call(`/api/log/${drawer}?from=${from}`), el = $("log"), atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
        if (gen !== logGen || from !== logPos || !drawer)
            return;
        if (r.text) {
            setState("logPos", r.next);
            el.textContent += r.text;
            if (atEnd)
                el.scrollTop = el.scrollHeight;
        }
        const j = r.job;
        setState("logFinal", ["ok", "fail", "skipped", "cancelled", "interrupted"].includes(j.status));
        setState("logAt", Date.now());
        $("dh").innerHTML = `<b>${esc(j.label)}</b>${j.input ? ` <span class="mono">${esc(j.input)}</span>` : ""} ${chipOf(j)} <span class="sub mono dhcmd" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(j.cmd || "")}</span>${j.status === "waiting" ? `<button class="sm" data-act="force" data-id="${j.id}">всё равно</button>` : ""}${["running", "queued", "waiting"].includes(j.status) ? `<button class="sm" data-act="cancel" data-id="${j.id}">стоп</button>` : ""}${["fail", "interrupted"].includes(j.status) ? `<button class="sm primary" data-act="report" data-id="${j.id}">→ Агенту ветки</button>` : ""}<button class="sm" data-act="copy" data-id="${j.id}">📋 Копировать</button><button class="sm ghost" data-act="close">закрыть ✕</button>`;
    }
    catch { }
    finally {
        logBusy = false;
    }
}

export async function copyForAgent(id) {
    const r = await call(`/api/log/${id}?from=0`), j = r.job, t = treeOf(j.tree);
    const lines = r.text.split(/\r?\n/).filter((l) => l.trim() !== "");
    const word = { ok: "ЗЕЛЁНЫЙ", fail: "УПАЛ", running: "ИДЁТ", cancelled: "ОТМЕНЁН", interrupted: "ПРЕРВАН" }[j.status] || j.status;
    const text = [`Прогон от владельца: ${j.label}${j.input ? " — " + j.input : ""}`, `Слот: ${t ? t.tag + " " + t.key + " · ветка " + t.branch : j.tree}`, `Итог: ${word}${j.code != null ? " (код " + j.code + ")" : ""}, ${durText(j)}${j.peakMB ? ", пик памяти " + j.peakMB + " МБ" : ""}`, `Команда: ${j.cmd}`, j.summary ? `Выжимка: ${j.summary}` : "", "--- последние строки лога ---", ...lines.slice(-80)].filter(Boolean).join("\n");
    try {
        await navigator.clipboard.writeText(text);
    }
    catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
    }
    return lines.length;
}

export const STN = { tree: null, id: null, data: null };
const STN_JOB_CHIP = { skipped: '<span class="chip">∅ нет тестов</span>', ok: '<span class="chip ok">✓ зелёный</span>', fail: '<span class="chip fail">✗ упал</span>', interrupted: '<span class="chip fail">! прерван</span>', running: '<span class="chip running">⏳ идёт</span>', none: '<span class="chip">не запускали</span>', cancelled: '<span class="chip">отменён</span>' };

function stnJobHead(j) {
    if (!j)
        return "";
    return `<div class="chips" style="margin-bottom:6px"><b>${esc(j.label)}${j.input ? ` <span class="mono mute">${esc(j.input)}</span>` : ""}</b>${STN_JOB_CHIP[j.status] || ""}${j.sec != null ? `<span class="sub">${j.sec} с</span>` : ""}${j.at ? `<span class="sub">${new Date(j.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span>` : ""}${j.peakMB ? `<span class="sub">пик ${j.peakMB} МБ</span>` : ""}${j.id ? `<button class="sm ghost" data-stn="log" data-id="${esc(j.id)}">весь лог ▸</button>` : ""}${["fail", "interrupted"].includes(j.status) ? `<button class="sm primary" data-stn="report" data-id="${esc(j.id)}">→ Агенту</button>` : ""}</div>`;
}

function stnBlock(b) {
    if (b.kind === "empty")
        return `<div class="sub" style="padding:6px 0">${esc(b.text)}</div>`;
    if (b.kind === "doc")
        return `<details class="stb stdoc" ${b.open ? "open" : ""}><summary class="stt" style="cursor:pointer;list-style:none">${esc(b.title)}<span class="mono mute">${esc(b.path || "")}</span></summary><div class="doc mdv" ${b.highlight ? `data-hl="${esc(b.highlight)}"` : ""}>${mdDoc(b.text)}</div></details>`;
    if (b.kind === "pre")
        return `<div class="stb">${b.title ? `<div class="stt">${esc(b.title)}</div>` : ""}<pre class="stpre">${esc(b.text)}</pre></div>`;
    if (b.kind === "kv")
        return `<div class="stb">${b.items.map(([k, v]) => `<div class="kv" style="align-items:flex-start"><span style="flex:0 0 38%">${esc(k)}</span><b style="text-align:right;font-weight:500">${esc(v)}</b></div>`).join("")}</div>`;
    if (b.kind === "files") {
        return `<div class="stb"><div class="stt">${esc(b.title)} · ${b.files.length}</div>${b.files.map((f) => `<div class="stf"><span class="c ${fcls(f.code)}" style="width:16px;text-align:center;font-weight:700">${esc(f.code)}</span><span class="mono" title="${esc(f.path)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.path)}</span><span>${f.add != null || f.del != null ? (f.untracked ? `<span class="mute">новый</span> <span style="color:var(--good)">+${f.add ?? "?"}</span>` : `<span style="color:var(--good)">+${f.add ?? "?"}</span> <span style="color:var(--bad)">−${f.del ?? "?"}</span>`) : f.untracked ? '<span class="mute">новый</span>' : ""}</span></div>`).join("")}</div>`;
    }
    if (b.kind === "commits")
        return `<div class="stb"><div class="stt">${esc(b.title)}</div>${b.commits.map((c) => `<div class="stf"><span class="mono">${esc(c[0])}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c[1])}</span><span></span></div>`).join("")}</div>`;
    if (b.kind === "job")
        return `<div class="stb">${stnJobHead(b.job)}${b.text ? `<pre class="stpre">${esc(b.text)}</pre>` : ""}</div>`;
    if (b.kind === "tests") {
        const j = b.job, bad = ["fail", "interrupted"].includes(j.status);
        return `<div class="stb">${stnJobHead(j)}${b.totals && b.totals.length ? `<div class="sub mono">${b.totals.map(esc).join("<br>")}</div>` : ""}
      ${b.failed && b.failed.length ? `<div class="stt" style="color:var(--bad)">Упали · ${b.failed.length}</div>${b.failed.map((x) => `<div class="stf"><span style="color:var(--bad)">✗</span><span class="mono">${esc(x)}</span><span></span></div>`).join("")}` : ""}
      ${b.names && b.names.length ? `<details><summary class="sub" style="cursor:pointer">Падающие проверки · ${b.names.length}</summary><pre class="stpre">${esc(b.names.join("\n"))}</pre></details>` : ""}
      ${b.passed && b.passed.length ? `<details><summary class="sub" style="cursor:pointer;color:var(--good)">Прошли · ${b.passed.length}</summary>${b.passed.map((x) => `<div class="stf"><span style="color:var(--good)">✓</span><span class="mono">${esc(x)}</span><span></span></div>`).join("")}</details>` : ""}
      ${bad && b.text ? `<div class="stt" style="color:var(--bad)">Причина падения (из лога)</div><pre class="stpre">${esc(b.text)}</pre>` : ""}</div>`;
    }
    if (b.kind === "checklist")
        return stnChecklist(b);
    if (b.kind === "note")
        return `<div class="stb"><div class="stt">Ваша заметка: что проверили на сайте</div><textarea id="stnNote" class="stnote" placeholder="Например: открыл кабинет, ключ создался, мобильный вид ок. Страница X красная — отдал агенту.">${esc(b.text || "")}</textarea><button class="sm primary" data-stn="note">Сохранить заметку</button></div>`;
    return "";
}

export const CHKSTATE = (() => {
    try {
        return JSON.parse(localStorage.getItem("dash.chk") || "{}");
    }
    catch {
        return {};
    }
})();

function chkId(tree, text) {
    let h = 0;
    for (const ch of tree + "|" + text.slice(0, 80))
        h = (h * 31 + ch.charCodeAt(0)) | 0;
    return "c" + (h >>> 0).toString(36);
}

function stnChecklist(b) {
    if (b.pending)
        return '<div class="stb"><div class="stt">Чек-лист приёмки на стенде</div><div class="sub">' + SPIN + ' Агент составляет чек-лист… ответ появится здесь сам, когда он закончит.</div></div>';
    if (!b.text)
        return '<div class="stb"><div class="stt">Чек-лист приёмки на стенде</div><div class="sub">Пока нет. Нажмите «Запросить чек-лист у агента»: он напишет, что открыть, что нажать, что должно произойти и что не должно сломаться. Ответ сохранится здесь.</div></div>';
    const lines = b.text.split("\n"), items = [];
    const html = lines.map((l) => {
        const m = /^\s*(?:\d+[.)]|[-*])\s+(.*)$/.exec(l);
        if (m) {
            const id = chkId(b.tree, m[1]);
            items.push(id);
            return '<label class="chki"><input type="checkbox" data-stn="chk" data-id="' + id + '" ' + (CHKSTATE[id] ? "checked" : "") + '><span>' + esc(m[1]) + "</span></label>";
        }
        return l.trim() ? '<div class="chkt">' + md(l) + "</div>" : "";
    }).join("");
    const done = items.filter((id) => CHKSTATE[id]).length;
    return '<div class="stb"><div class="stt">Чек-лист приёмки на стенде · ответ агента<span>' + (items.length ? done + " из " + items.length + " пройдено · " : "") + new Date(b.at).toLocaleString("ru-RU") + '</span></div><div class="chklist">' + html + '</div><div class="chips"><button class="sm" data-stn="copychk">Скопировать</button></div></div>';
}

function applyDocHighlights() {
    document.querySelectorAll("#stn .doc[data-hl]").forEach((box) => {
        const word = box.dataset.hl, re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT), nodes = [];
        while (walker.nextNode()) {
            if (re.test(walker.currentNode.nodeValue))
                nodes.push(walker.currentNode);
            re.lastIndex = 0;
        }
        nodes.forEach((n) => {
            const frag = document.createDocumentFragment();
            let last = 0, m;
            const txt = n.nodeValue;
            re.lastIndex = 0;
            while ((m = re.exec(txt))) {
                frag.append(txt.slice(last, m.index));
                const mk = document.createElement("mark");
                mk.className = "hl";
                mk.textContent = m[0];
                frag.append(mk);
                last = m.index + m[0].length;
            }
            frag.append(txt.slice(last));
            n.replaceWith(frag);
        });
        box.querySelectorAll("mark.hl").forEach((mk) => {
            const tr = mk.closest("tr");
            if (tr)
                tr.classList.add("hlrow");
            const li = mk.closest("li");
            if (li)
                li.classList.add("hlrow");
        });
        const first = box.querySelector("mark.hl");
        if (first && box.closest("details").open) {
            const top = first.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 60;
            box.scrollTop = Math.max(0, top);
        }
    });
}

export function renderStation() {
    const d = STN.data, t = treeOf(STN.tree);
    if (!d || !t)
        return;
    const mark = d.info ? "" : d.source === "manual" ? `<button class="sm" data-stn="auto" title="Вернуть автоматическую отметку">Вернуть авто («${esc(d.label)}» отмечена вручную)</button>` : d.done ? `<button class="sm" data-stn="mark" data-v="0">Снять отметку «${esc(d.label)}»</button>` : `<button class="sm primary" data-stn="mark" data-v="1">Отметить «${esc(d.label)}» пройденной</button>`;
    const runNote = d.running ? `<div class="sub" style="color:var(--warn,#d97706)">${SPIN} Сейчас идёт: ${esc(d.running.label)} (${esc(d.running.id)})</div>` : "";
    const acts = (d.actions || []).map((a) => `<button class="sm" data-stn="act" data-a="${esc(a.id)}">${esc(a.label)}</button>`).join("");
    const links = (d.links || []).map((l) => `<a class="sm" style="text-decoration:none;display:inline-block;padding:3px 10px;border:1px solid var(--line);border-radius:99px" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join("");
    $("stn").innerHTML = `<div class="cg">
    <div class="cg-h"><b>${t.emoji} ${esc(t.tag)} · ${esc(t.title)}</b><span class="chip ${d.done ? "ok" : ""}">${esc(d.label)} · ${d.info ? (d.done ? "оформлена" : "не оформлена") : d.done ? "пройдена" : "не пройдена"}</span><span class="sub">${esc(d.hint || "")}</span>${runNote}<span class="sp"></span>${mark}<button class="sm ghost" data-stn="close">закрыть ✕</button></div>
    <div class="stbody" style="overflow:auto;padding:14px 18px;display:grid;gap:12px;align-content:start;min-height:0">${(d.blocks || []).map(stnBlock).join("") || '<div class="sub">Нечего показать.</div>'}</div>
    <div class="cg-f"><div class="chips">${acts}${links}${!acts && !links ? '<span class="sub">Действий для этой станции нет.</span>' : ""}</div></div></div>`;
    applyDocHighlights();
}

export async function openStation(tree, id) {
    STN.tree = tree;
    STN.id = id;
    STN.data = null;
    const t = treeOf(tree);
    $("stn").classList.add("on");
    $("stn").innerHTML = `<div class="cg"><div class="cg-h"><b>${t.emoji} ${esc(t.tag)}</b><span class="sub">загружаю…</span></div><div></div><div></div></div>`;
    await reloadStation();
}

async function reloadStation() {
    try {
        STN.data = await call(`/api/station?tree=${encodeURIComponent(STN.tree)}&id=${encodeURIComponent(STN.id)}`);
        renderStation();
    }
    catch (e) {
        toast(e.message);
        closeStation();
    }
}

export function closeStation() {
    STN.tree = null;
    $("stn").classList.remove("on");
}

export async function toggleStage(tree, stage, value) {
    const t = treeOf(tree), s = t && stagesOf(t).find((x) => x.id === stage);
    if (s) {
        if (value !== null)
            s.done = value;
        s.source = value === null ? "auto" : "manual";
        render();
    }
    await call("/api/stage", { tree, stage, value });
    await refresh(true);
    await reloadStation();
}

export const CG = { key: null, data: null, scope: "work", sel: null, picked: new Set(), msg: "" };
const fcls = (c) => (c === "?" ? "\\?" : c);

export const NOTES = (() => {
    try {
        return JSON.parse(localStorage.getItem("dash.notes") || "{}");
    }
    catch {
        return {};
    }
})();

export const saveNotes = () => ls("dash.notes", NOTES);
export const notesOf = (key) => NOTES[key] || (NOTES[key] = []);

function diffHTML(text) {
    let nl = null, ol = null;
    const all = CG.key ? notesOf(CG.key) : [], notes = all.filter((n) => n.path === CG.sel);
    return `<pre>${String(text).split("\n").map((l) => {
        const k = l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ") ? "m" : l.startsWith("@@") ? "h" : l.startsWith("+") ? "a" : l.startsWith("-") ? "d" : "";
        let num = "";
        const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
        if (h) {
            ol = Number(h[1]);
            nl = Number(h[2]);
        }
        else if (k === "a" && nl != null)
            num = String(nl++);
        else if (k === "d" && ol != null)
            num = "-" + ol++;
        else if (k === "" && nl != null && l.startsWith(" ")) {
            num = String(nl++);
            ol++;
        }
        const mine = num ? notes.filter((n) => String(n.line) === num) : [];
        const attrs = num ? ` data-ln="${num}" data-code="${esc(l.slice(1, 240))}" title="Клик — замечание агенту к строке ${num}"` : "";
        return `<span class="l ${k}${mine.length ? " cm" : ""}"${attrs}>${num ? `<span class="ln2">${num}</span>` : ""}${esc(l) || " "}</span>` + mine.map((n) => `<span class="note">💬 ${esc(n.note)} <a data-cgn="del" data-i="${all.indexOf(n)}" style="cursor:pointer" title="Убрать замечание">✕</a></span>`).join("");
    }).join("")}</pre>`;
}

function notesBar() {
    if (!CG.key)
        return "";
    const n = notesOf(CG.key);
    if (!n.length)
        return '<div class="notesbar sub">Клик по строке диффа — замечание агенту. Замечания копятся и уходят одним сообщением.</div>';
    return `<div class="notesbar"><b>Замечаний: ${n.length}</b><span class="sub">${esc([...new Set(n.map((x) => x.path.split("/").pop()))].join(", "))}</span><button class="sm primary ${PENDING.has("notes|" + CG.key) ? "busy" : ""}" data-cgn="send">→ Агенту одним сообщением</button><button class="sm ghost" data-cgn="clear">очистить</button></div>`;
}

export async function openChanges(key) {
    const t = treeOf(key);
    CG.key = key;
    CG.data = null;
    CG.sel = null;
    CG.picked = new Set();
    CG.scope = "work";
    CG.msg = "";
    $("chg").classList.add("on");
    $("cg").innerHTML = `<div class="cg-h"><b>${t.emoji} ${esc(t.tag)} · ${esc(t.title)}</b><span class="sub">загружаю список…</span></div><div></div><div></div>`;
    await reloadChanges(true);
}

export async function reloadChanges(first) {
    try {
        const d = await call("/api/changes?tree=" + encodeURIComponent(CG.key));
        CG.data = d;
        const live = new Set(d.work.map((f) => f.path));
        CG.picked = new Set([...CG.picked].filter((p) => live.has(p)));
        if (first)
            for (const f of d.work)
                if (!f.sensitive)
                    CG.picked.add(f.path);
        if (!d.work.length && d.branch_files.length)
            CG.scope = "branch";
        if (!CG.sel || !(CG.scope === "work" ? d.work : d.branch_files).some((f) => f.path === CG.sel))
            CG.sel = ((CG.scope === "work" ? d.work : d.branch_files)[0] || {}).path || null;
        const t = treeOf(CG.key);
        if (first && !CG.msg)
            CG.msg = t && t.wave ? `${t.wave.toUpperCase()}: ` : "";
        renderChanges();
        if (CG.sel)
            loadDiff();
    }
    catch (e) {
        toast(e.message);
        closeChanges();
    }
}

function frow(f, work) {
    const chk = work ? `<input type="checkbox" data-cg="pick" data-p="${esc(f.path)}" ${CG.picked.has(f.path) ? "checked" : ""} ${f.sensitive ? 'disabled title="похоже на секреты — не коммитится"' : ""}>` : `<span class="c ${fcls(f.code)}">${esc(f.code)}</span>`;
    const name = f.path.split("/").pop(), dir = f.path.slice(0, f.path.length - name.length);
    const cnt = f.add != null || f.del != null ? `<span><span class="ad">+${f.add ?? "?"}</span> <span class="de">−${f.del ?? "?"}</span></span>` : `<span class="mute">${f.untracked ? "новый" : ""}</span>`;
    return `<div class="fr ${CG.sel === f.path ? "sel" : ""}" data-cg="file" data-p="${esc(f.path)}" title="${esc(f.path)} · ${esc(f.status)}">${work ? `<span class="c ${fcls(f.code)}">${esc(f.code)}</span>` : chk}<span class="p"><span class="pn">${f.sensitive ? '<span class="sens">⚠ </span>' : ""}<span class="mute">${esc(dir)}</span>${esc(name)}</span></span>${cnt}</div>`;
}

export function renderChanges() {
    const d = CG.data, t = treeOf(CG.key), work = d.work, br = d.branch_files;
    const files = CG.scope === "work" ? work : br;
    const picked = work.filter((f) => CG.picked.has(f.path)).length;
    const list = CG.scope === "work"
        ? `<div class="grp"><span>Не закоммичено · ${work.length}</span><span><button class="sm ghost" data-cg="all">все</button><button class="sm ghost" data-cg="none">снять</button></span></div>${work.map((f) => frow(f, true)).join("") || '<div class="sub" style="padding:14px">Всё закоммичено.</div>'}`
        : `<div class="grp"><span>Ветка против staging · ${br.length}</span></div>${br.map((f) => frow(f, false)).join("") || '<div class="sub" style="padding:14px">Своих изменений относительно staging нет.</div>'}`;
    const canCommit = CG.scope === "work" && picked > 0 && !["staging", "main", "HEAD"].includes(d.branch);
    $("cg").innerHTML = `<div class="cg-h"><b>${t.emoji} ${esc(t.tag)} · ${esc(t.title)}</b><span class="mono mute">${esc(d.branch)}</span>
      <span class="seg"><button class="${CG.scope === "work" ? "on" : ""}" data-cg="scope" data-s="work">Не закоммичено <span class="chip">${work.length}</span></button><button class="${CG.scope === "branch" ? "on" : ""}" data-cg="scope" data-s="branch">Ветка против staging <span class="chip">${br.length}</span></button></span>
      <span class="sp"></span><button class="sm" data-annot="diff" data-tree="${esc(CG.key)}" title="Ревью владельца: дифф ветки против staging, замечания к строкам и диапазонам → агенту слота пачкой">✎ Ревью по строкам</button><button class="sm" data-cg="refresh">⟳ обновить</button><button class="sm ghost" data-cg="close">закрыть ✕</button></div>
    <div class="cg-b"><div class="cg-l">${list}</div><div class="cg-d" id="cgd"><div class="sub" style="padding:16px">${files.length ? "Выберите файл слева." : ""}</div></div></div>
    <div class="cg-f">${CG.scope === "work" ? `
      <div class="sub">Коммитятся только отмеченные файлы (${picked} из ${work.length}), каждый поимённо. Автор и время — как у вас в git; в конец сообщения добавится строка Co-Authored-By.${["staging", "main"].includes(d.branch) ? ' <span class="sens">Ветка ' + esc(d.branch) + ': коммитить отсюда нельзя.</span>' : ""}</div>
      <textarea id="cgmsg" placeholder="Сообщение коммита: что и зачем (от 5 знаков)">${esc(CG.msg)}</textarea>
      ${notesBar()}<div class="chips"><button class="primary" data-cg="commit" ${canCommit ? "" : "disabled"}>Закоммитить ${picked} файл(ов)</button><span class="sub mute">последние коммиты: ${d.recent.slice(0, 3).map((r) => esc(r[1]).slice(0, 48)).join(" · ")}</span></div>` : notesBar() + `<div class="sub">Это то, что уйдёт в staging при вливании: коммиты ветки относительно общей базы (${t.ahead} впереди). Клик по строке диффа — замечание агенту.</div>`}</div>`;
}

export async function loadDiff() {
    const el = $("cgd");
    if (!el || !CG.sel)
        return;
    const key = CG.key, sel = CG.sel, scope = CG.scope;
    el.innerHTML = '<div class="sub" style="padding:16px">загружаю дифф…</div>';
    try {
        const r = await call(`/api/filediff?tree=${encodeURIComponent(key)}&scope=${scope}&path=${encodeURIComponent(sel)}`);
        if (CG.key === key && CG.sel === sel && CG.scope === scope)
            el.innerHTML = diffHTML(r.text);
    }
    catch (e) {
        el.innerHTML = `<div class="sub" style="padding:16px">${esc(e.message)}</div>`;
    }
}

export function closeChanges() {
    CG.key = null;
    $("chg").classList.remove("on");
}

// Что сделает действие — текстом для окна подтверждения. Сервер может прислать точную команду (preflight.cmd).
const CMDS = {
    merge: (t) => `(основная папка проекта, ветка staging)\ngit merge --no-ff ${t ? t.branch : "<ветка>"} -m "merge: ${t ? t.branch : ""}"`,
    "deploy-staging": () => `команда выката стенда из конфига проекта (release.stand.run)`,
    release: () => {
        const P = (S && S.pipeline) || {}, upM = P.upMain || "<remote>/<прод-ветка>", rem = upM.split("/")[0], br = upM.split("/").slice(1).join("/");
        return `(отдельная папка на ветке main)\ngit fetch ${rem}\n(проверки: ${upM} и main — предки staging)\ngit merge --no-ff staging -m "release: staging -> main"\n(проверка: дерево main = дерево staging)\ngit push ${rem} main:${br}` + (P.pushDeploys ? "     ← ЗАПУСКАЕТ ВЫКАТ ПРОДА" : "\nзатем команда выката прода из конфига (release.prod.run)");
    },
};

const TITLES = { merge: "Влить ветку слота в staging", "deploy-staging": "Выкатить staging на стенд", release: "Выкат в прод" };

export async function openPipeline(action, slot, service) {
    const t = slot ? treeOf(slot) : null;
    let pf;
    try {
        pf = await call("/api/preflight", { action, slot, service });
    }
    catch (e) {
        return toast(e.message);
    }
    const checks = pf.checks.map((c) => `<span>${c.ok === true ? "✅" : c.ok === false ? "❌" : "ℹ️"}</span><span>${esc(c.text)}${c.detail && c.ok !== true ? `<div class="d">${esc(c.detail)}</div>` : ""}</span>`).join("");
    const prod = action === "release", soft = action === "merge" && !pf.ok && pf.checks.every((c) => c.ok !== false || ["regress", "review", "sec"].includes(c.id));
    $("mb").innerHTML = `<h3>${t ? t.emoji + " " : ""}${TITLES[action] || action}</h3>
    ${prod ? '<div class="warnbox"><b>Это живой прод.</b> Выкат подействует сразу.</div>' : ""}
    <div class="ck">${checks}</div><div class="cmd">${esc(pf.cmd || (CMDS[action] ? CMDS[action](t) : action))}</div>
    ${prod ? '<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="acc"> Принято на стенде, дерево main будет совпадать с проверенным staging</label><input type="text" id="word" placeholder="введите слово: ВЫКАТ" autocomplete="off">' : ""}
    ${soft ? '<div class="warnbox">Не выполнены только проверки (регресс, ревью, гарды). Их можно снять своим решением: «Влить всё равно». Конфликт, незакоммиченное и порядок волн так не снимаются.</div>' : ""}
    <div style="display:flex;gap:8px;justify-content:flex-end"><button class="ghost" data-act="mclose">Отмена</button>${action === "merge" && pf.checks.some((c) => c.id === "conflict" && c.ok === false) ? `<button class="primary" data-act="slotsync" data-tree="${esc(slot)}" title="Влить staging в ветку волны: конфликт — откат и список файлов агенту слота">⤓ Подтянуть staging</button>` : ""}${soft ? '<button id="force" class="danger">Влить всё равно</button>' : ""}<button id="ok" class="${prod ? "danger" : "primary"}" ${pf.ok ? "" : "disabled"}>${pf.ok ? "Выполнить" : "Условия не выполнены"}</button></div>`;
    $("modal").classList.add("on");
    {
        const sb = $("mb").querySelector('[data-act="slotsync"]');
        if (sb)
            sb.addEventListener("click", () => $("modal").classList.remove("on"));
    }
    const ok = $("ok"), sync = () => {
        if (prod)
            ok.disabled = !(pf.ok && $("acc").checked && $("word").value === "ВЫКАТ");
    };
    if (prod) {
        $("acc").onchange = sync;
        $("word").oninput = sync;
        sync();
    }
    ok.onclick = async () => {
        ok.disabled = true;
        ok.innerHTML = SPIN + " выполняю…";
        try {
            const j = await call("/api/pipeline", { action, slot, service, confirm: prod ? $("word").value : undefined, accepted: prod ? $("acc").checked : undefined });
            $("modal").classList.remove("on");
            await refresh(true);
            openLog(j.id);
        }
        catch (e) {
            toast(e.message);
            ok.disabled = false;
            ok.textContent = "Выполнить";
        }
    };
    if (soft)
        $("force").onclick = async () => {
            const f = $("force");
            f.disabled = true;
            f.innerHTML = SPIN + " вливаю…";
            try {
                const j = await call("/api/pipeline", { action, slot, force: true });
                $("modal").classList.remove("on");
                await refresh(true);
                openLog(j.id);
            }
            catch (e) {
                toast(e.message);
                f.disabled = false;
                f.textContent = "Влить всё равно";
            }
        };
}

function forceBar(tree, wave) {
    const t = treeOf(tree), w = ((t && t.wagonsView) || []).find((x) => x.wave === wave) || {};
    if (!t || !t.train || t.head !== wave || w.tone !== "wait")
        return "";
    const why = "Вагон ждёт " + ((w.waitFor || w.after || []).join(", ") || "другой поезд") + ". ";
    return `<div class="wphold"><button class="sm primary" data-act="trainwagonforce" data-tree="${esc(tree)}" data-wave="${esc(wave)}" title="${esc(why + "Вагон уйдёт агенту поезда сейчас, не дожидаясь зависимости. Зависимость при этом не снимается в реестре — решение разовое")}">▶ Запустить сейчас, не дожидаясь ${esc((w.waitFor || []).map((x) => {
        const [a, b] = String(x).split("@");
        return b ? b + " · " + a : a;
    }).join(", "))}</button></div>`;
}

export async function openWagonPlan(tree, wave) {
    const box = $("mb");
    if (!box)
        return;
    box.className = "mb wplan";
    box.innerHTML = `<div class="wph"><h3>${esc(wave)}</h3><button class="ghost" data-act="mclose">Закрыть ✕</button></div><div class="sub">${SPIN} читаю план…</div>`;
    $("modal").classList.add("on");
    try {
        const r = await call("/api/wagon-plan?tree=" + encodeURIComponent(tree) + "&wave=" + encodeURIComponent(wave));
        const body = String(r.text || "").replace(/^---\n[\s\S]*?\n---\n/, "");
        const head = (/^---\n([\s\S]*?)\n---\n/.exec(String(r.text || "")) || [])[1] || "";
        const meta = Object.fromEntries(head.split("\n").map((l) => /^(\w[\w-]*):\s*(.+)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
        const chips = [meta.train && "поезд " + meta.train, meta.backlog && "бэклог " + meta.backlog.replace(/[[\]]/g, ""), (meta.after || (r.after || []).join(", ")) && "после " + (meta.after || (r.after || []).join(", ")), meta.status && "статус: " + meta.status].filter(Boolean);
        box.innerHTML = `<div class="wph"><h3>${esc(wave)} · ${esc(r.title || "")}</h3><button class="ghost" data-act="mclose">Закрыть ✕</button></div>
      ${chips.length ? `<div class="wpchips">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join("")}</div>` : ""}
      ${forceBar(tree, wave)}<div class="mdv wpmd">${mdDoc(body)}</div><div class="sub wpfile">${esc(r.file || "")}</div>`;
    }
    catch (e) {
        box.innerHTML = `<div class="wph"><h3>${esc(wave)}</h3><button class="ghost" data-act="mclose">Закрыть ✕</button></div><div class="warnbox">${esc(e.message || String(e))}</div>`;
    }
}
