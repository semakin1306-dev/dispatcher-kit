// main.js — вход страницы: обработчики кнопок и клавиш (делегирование по data-act), таймеры и цикл данных.
import { BTN_BUSY, CUR_BTN, drawer, FILTER, FOCUS, GGOPEN, IN, logAt, logFinal, OPEN, OPENCHAT, REM_ADD_OPEN, S, SEL, SELK, setState, SFX_HIDE, SFX_OPEN, VIEW, VIEW_EPIC } from "./state.js";
import { $, applyBusy, applyTheme, btnKey, call, CK_ICON, copyText, CP_ICON, ls, gateTasks, pageScrollToEl, RAW, smart, SPIN, tickTimers, toast } from "./core.js";
import { applyView, press, render } from "./render.js";
import { manyMsg, runAsk, runMany, runPayload, started } from "./run.js";
import { refresh, startData, treeOf } from "./data.js";
import { GFOLD, linesList, renderKanban, runRegress, slotGroup, stgTasks } from "./lines.js";
import { agentCommit, DISM, failedUnresolved, openNewEpic, renderTasks, runGuards } from "./tasks.js";
import { ACC_FOLD, accJump, actBtn, applyPm, bnavBadges, ICONS, openKeyHelp, PM_Q, RAILM, railList, renderSide, setPv, setRail } from "./side.js";
import { chatAction, CHATS, collapseAll, fitAll, fitInput, focusChat, pickSlot, pollChats, RELAY_SEEN, relayScene, relaySentMark, setSidebar, setSideChat, sideChatTrees, stepSideChat, SIDEBAR } from "./chat.js";
import { MONOPEN, renderMon } from "./monitor.js";
import { oqCollect, oqPick } from "./oqform.js";
import { bindOrderDnd, toggleOrderFold } from "./ordermap.js";
import { setGanttScale, setOrderMode } from "./gantt.js";
import { openEpicProgress } from "./progress.js";
import { closeEpic, openRetro } from "./retro.js";
import { applyGgOpen } from "./graph.js";
import { openAnnot } from "./review.js";
import { installBacklog } from "./backlog.js";
import { CG, CHKSTATE, openWagonPlan, closeChanges, closeStation, copyForAgent, loadDiff, NOTES, notesOf, openChanges, openLog, openPipeline, openStation, pollLog, reloadChanges, renderChanges, renderStandFx, renderStation, saveNotes, standJob, STN, toggleStage } from "./dialogs.js";

setInterval(tickTimers, 1000);
["att", "plat", "pipe", "filters", "jobs", "mon", "tasks"].forEach((id) => smart(document.getElementById(id)));

applyTheme((() => {
    try {
        return localStorage.getItem("dash.theme") || "auto";
    }
    catch {
        return "auto";
    }
})());

$("theme").onclick = (e) => {
    const b = e.target.closest("button");
    if (b)
        applyTheme(b.dataset.theme);
};

$("viewSeg").onclick = (e) => {
    const b = e.target.closest("button");
    if (b)
        applyView(b.dataset.view);
};

$("burger").onclick = () => {
    const h = document.querySelector("header");
    h.classList.toggle("open");
    $("burger").textContent = h.classList.contains("open") ? "✕" : "☰";
};

document.querySelector("header").addEventListener("click", (e) => {
    const h = e.currentTarget, b = e.target.closest("button");
    if (h.classList.contains("open") && b && b.id !== "burger")
        setTimeout(() => {
            h.classList.remove("open");
            $("burger").textContent = "☰";
        }, 150);
});

applyView(VIEW);

new MutationObserver(() => {
    if (BTN_BUSY.size)
        requestAnimationFrame(applyBusy);
}).observe(document.documentElement, { childList: true, subtree: true });

ICONS.accept = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12.75 11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.75 3.75 0 0 1-1.043 3.296 3.75 3.75 0 0 1-3.296 1.043A3.74 3.74 0 0 1 12 21c-1.268 0-2.39-.63-3.068-1.593a3.75 3.75 0 0 1-3.296-1.043 3.75 3.75 0 0 1-1.043-3.296A3.75 3.75 0 0 1 3 12c0-1.268.63-2.39 1.593-3.068a3.75 3.75 0 0 1 1.043-3.296 3.75 3.75 0 0 1 3.296-1.043A3.75 3.75 0 0 1 12 3c1.268 0 2.39.63 3.068 1.593a3.75 3.75 0 0 1 3.296 1.043 3.75 3.75 0 0 1 1.043 3.296A3.75 3.75 0 0 1 21 12Z"/></svg>';

document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !S)
        return;
    const tg = e.target;
    if (tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA" || tg.tagName === "SELECT" || tg.isContentEditable))
        return;
    if ($("modal").classList.contains("on") || $("chg").classList.contains("on"))
        return;
    if (($("annot") || { classList: { contains: () => false } }).classList.contains("on"))
        return;
    const k = e.key, list = linesList().filter((x) => x.key && !String(x.key).startsWith("__")), keys = list.map((x) => x.key), t = SELK && S.trees.find((x) => x.key === SELK);
    const go = (key) => {
        setState("SELK", key);
        render();
        const w = [...document.querySelectorAll("#lines .lnw")].find((x) => x.dataset.k === key);
        if (w)
            w.scrollIntoView({ block: "center", behavior: "smooth" });
    };
    if (k === "?") {
        e.preventDefault();
        openKeyHelp();
        return;
    }
    if (k === "Escape") {
        if (FOCUS) {
            setState("FOCUS", null);
            render();
        }
        return;
    }
    if (/^[1-9]$/.test(k)) {
        const r = railList()[Number(k) - 1];
        if (r)
            setRail(r[0]);
        return;
    }
    if (k === "n") {
        const need = list.filter((x) => slotGroup(x) === "need").map((x) => x.key);
        if (!need.length) {
            toast("Сейчас от тебя ничего не ждут", true);
            return;
        }
        const nk = need[(need.indexOf(SELK) + 1) % need.length];
        OPEN.add(nk);
        go(nk);
        return;
    }
    if (k === "j" || k === "k") {
        if (!keys.length)
            return;
        const i = keys.indexOf(SELK);
        go(keys[k === "j" ? (i + 1) % keys.length : i <= 0 ? keys.length - 1 : i - 1]);
        return;
    }
    if (!t)
        return;
    if (k === "o" || k === "Enter") {
        OPEN.has(t.key) ? OPEN.delete(t.key) : OPEN.add(t.key);
        ls("dash.open", [...OPEN]);
        render();
    }
    else if (k === "f") {
        setState("FOCUS", FOCUS === t.key ? null : t.key);
        render();
    }
    else if (k === "c") {
        OPENCHAT.has(t.key) ? OPENCHAT.delete(t.key) : OPENCHAT.add(t.key);
        ls("dash.chats", [...OPENCHAT]);
        render();
        pollChats();
    }
    else if (k === "d")
        openChanges(t.key);
    else if (k === "t")
        actBtn("runall", t.key);
    else if (k === "g")
        actBtn("rungards", t.key);
    else if (k === "r")
        actBtn("runregress", t.key);
    else if (k === "v")
        actBtn("runreview", t.key);
    else if (k === "m")
        openPipeline("merge", t.key);
    else if (k === "a" && t.verdict && t.verdict.merged)
        actBtn("archive", t.key);
});

;

(function pinBnav() {
    const vv = window.visualViewport, b = document.getElementById("bnav");
    if (!vv || !b)
        return;
    let raf = 0;
    const place = () => {
        raf = 0;
        if (!document.body.classList.contains("pm")) {
            b.style.transform = "";
            return;
        }
        b.style.transform = "translate3d(0," + Math.round(vv.offsetTop + vv.height - b.offsetHeight) + "px,0)";
    };
    const ask = () => {
        if (!raf)
            raf = requestAnimationFrame(place);
    };
    vv.addEventListener("resize", ask);
    vv.addEventListener("scroll", ask);
    window.addEventListener("scroll", ask, { passive: true });
    window.addEventListener("resize", ask);
    setInterval(ask, 1000);
    ask();
})();

document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-annot]");
    if (!b || b.closest("#annot"))
        return;
    e.preventDefault();
    e.stopPropagation();
    openAnnot(b.dataset.annot, b.dataset.tree);
}, true);

document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy]");
    if (!b)
        return;
    e.preventDefault();
    e.stopPropagation();
    let text = "";
    if (b.dataset.copy === "code") {
        const code = b.parentElement.querySelector("pre code");
        text = code ? code.textContent : "";
    }
    else {
        const m = b.closest(".msg");
        text = RAW.get(b.dataset.mid) ?? (m ? m.innerText : "");
    }
    const ok = await copyText(text);
    b.innerHTML = ok ? CK_ICON : "!";
    b.classList.add(ok ? "done" : "bad");
    b.title = ok ? "Скопировано" : "Не удалось скопировать";
    setTimeout(() => {
        b.innerHTML = CP_ICON;
        b.classList.remove("done", "bad");
        b.title = "Копировать";
    }, 1300);
}, true);

document.addEventListener("click", async (e) => {
    const c = e.target.closest("[data-stn]");
    if (!c || !STN.tree)
        return;
    const a = c.dataset.stn, tree = STN.tree, askRedText = (STN.data && STN.data.askText) || "";
    try {
        if (a === "close")
            closeStation();
        else if (a === "mark" || a === "auto") {
            const v = a === "auto" ? null : c.dataset.v === "1";
            if (v === true && STN.data && STN.data.running && !confirm("Сейчас идёт «" + STN.data.running.label + "». Всё равно отметить станцию «" + STN.data.label + "» пройденной? Автопоезд сразу пойдёт дальше."))
                return;
            c.disabled = true;
            c.innerHTML = SPIN + " сохраняю…";
            await toggleStage(tree, STN.id, v);
            toast(v === null ? "Вернул автоматическую отметку" : v ? "Станция отмечена пройденной" : "Отметка снята", true);
            closeStation();
        }
        else if (a === "log")
            openLog(c.dataset.id);
        else if (a === "report") {
            const r = await call("/api/agent-report", { id: c.dataset.id });
            OPENCHAT.add(r.key);
            ls("dash.chats", [...OPENCHAT]);
            closeStation();
            render();
            setTimeout(() => focusChat(r.key), 600);
            toast("Причина падения отправлена агенту " + (treeOf(r.key) ? treeOf(r.key).tag : r.key), true);
        }
        else if (a === "chk") {
            CHKSTATE[c.dataset.id] = c.checked;
            try {
                localStorage.setItem("dash.chk", JSON.stringify(CHKSTATE));
            }
            catch { }
            ;
            renderStation();
        }
        else if (a === "copychk") {
            const b = (STN.data.blocks || []).find((x) => x.kind === "checklist");
            try {
                await navigator.clipboard.writeText(b.text);
                toast("Чек-лист скопирован", true);
            }
            catch {
                toast("Не удалось скопировать");
            }
        }
        else if (a === "note") {
            await call("/api/stage", { tree, stage: STN.id, note: $("stnNote").value });
            toast("Заметка сохранена", true);
        }
        else if (a === "act") {
            const id = c.dataset.a;
            closeStation();
            if (id === "diff")
                openChanges(tree);
            else if (id.startsWith("annot-"))
                openAnnot(id.slice(6), tree);
            else if (id === "ask-red") {
                const key = tree;
                press("askred|" + key, async () => {
                    const r = await call("/api/agent/send", { key, text: askRedText });
                    OPENCHAT.add(key);
                    ls("dash.chats", [...OPENCHAT]);
                    return r;
                }, () => {
                    setTimeout(() => focusChat(key), 600);
                    return "Вопрос про красный тест отправлен агенту.";
                });
            }
            else if (id === "ask-checklist") {
                press("askchk|" + tree, async () => {
                    const r = await call("/api/stand-checklist", { tree });
                    OPENCHAT.add(tree);
                    ls("dash.chats", [...OPENCHAT]);
                    return r;
                }, () => {
                    setTimeout(() => focusChat(tree), 600);
                    return "Агент составляет чек-лист: ответ сохранится в станции приёмки.";
                });
            }
            else if (id === "run-guards")
                runGuards(tree);
            else if (id === "agent-commit")
                agentCommit(tree);
            else if (id === "run-build")
                press("run|" + tree + "|build", () => call("/api/run", { tree, task: "build" }), started);
            else if (id === "run-tests") {
                const t = treeOf(tree), list = t.presets.length ? t.presets.map((p) => runPayload(tree, p.task, p)) : gateTasks().map((task) => ({ tree, task, input: "" }));
                press("runall|" + tree, () => runMany(list), manyMsg("тесты волны"));
            }
            else
                openPipeline(id, id === "merge" ? tree : undefined);
        }
    }
    catch (err) {
        toast(err.message);
    }
}, true);

$("stn").addEventListener("click", (e) => {
    if (e.target.id === "stn")
        closeStation();
});

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && STN.tree)
        closeStation();
});

document.addEventListener("click", async (e) => {
    const ln = e.target.closest(".cg-d [data-ln]"), nb = e.target.closest("[data-cgn]");
    if (!CG.key || (!ln && !nb))
        return;
    e.stopPropagation();
    if (ln) {
        const note = prompt("Замечание агенту к " + CG.sel + ":" + ln.dataset.ln + "\n" + ln.dataset.code);
        if (!note || !note.trim())
            return;
        notesOf(CG.key).push({ path: CG.sel, line: ln.dataset.ln, code: ln.dataset.code, note: note.trim(), at: Date.now() });
        saveNotes();
        renderChanges();
        loadDiff();
        return;
    }
    const op = nb.dataset.cgn, key = CG.key;
    if (op === "del") {
        notesOf(key).splice(Number(nb.dataset.i), 1);
        saveNotes();
        renderChanges();
        loadDiff();
    }
    else if (op === "clear") {
        if (confirm("Убрать все замечания к этой ветке?")) {
            NOTES[key] = [];
            saveNotes();
            renderChanges();
            loadDiff();
        }
    }
    else if (op === "send") {
        const n = notesOf(key);
        if (!n.length)
            return;
        const text = "Замечания владельца к диффу ветки (ревью в диспетчерской). Разбери каждое: согласен — поправь; не согласен — коротко почему.\n\n" +
            n.map((x) => "- " + x.path + ":" + x.line + " — " + x.note + "\n    строка: " + x.code).join("\n") +
            "\n\nВ конце, как обычно: строка СВОДКА и строка ДАЛЬШЕ (после правок — «ДАЛЬШЕ: ПЕРЕПРОГОН»).";
        press("notes|" + key, async () => {
            await call("/api/agent/send", { key, text });
            NOTES[key] = [];
            saveNotes();
            renderChanges();
            loadDiff();
            OPENCHAT.add(key);
            ls("dash.chats", [...OPENCHAT]);
        }, "Замечания отправлены агенту одним сообщением");
    }
}, true);

document.addEventListener("click", async (e) => {
    const c = e.target.closest("[data-cg]");
    if (!c || !CG.key)
        return;
    const a = c.dataset.cg;
    if (a === "pick") {
        c.checked ? CG.picked.add(c.dataset.p) : CG.picked.delete(c.dataset.p);
        const ta = $("cgmsg");
        if (ta)
            CG.msg = ta.value;
        renderChanges();
        const x = document.getElementById("cgmsg");
        if (x)
            x.value = CG.msg;
        if (CG.sel)
            loadDiff();
        return;
    }
    const ta = $("cgmsg");
    if (ta)
        CG.msg = ta.value;
    if (a === "file") {
        CG.sel = c.dataset.p;
        renderChanges();
        loadDiff();
    }
    else if (a === "scope") {
        CG.scope = c.dataset.s;
        const fs = CG.scope === "work" ? CG.data.work : CG.data.branch_files;
        CG.sel = (fs[0] || {}).path || null;
        renderChanges();
        if (CG.sel)
            loadDiff();
    }
    else if (a === "all") {
        CG.data.work.forEach((f) => !f.sensitive && CG.picked.add(f.path));
        renderChanges();
        if (CG.sel)
            loadDiff();
    }
    else if (a === "none") {
        CG.picked.clear();
        renderChanges();
        if (CG.sel)
            loadDiff();
    }
    else if (a === "refresh")
        await reloadChanges(false);
    else if (a === "close")
        closeChanges();
    else if (a === "commit") {
        const msg = ($("cgmsg") || {}).value || "";
        c.disabled = true;
        c.innerHTML = SPIN + " коммичу…";
        try {
            const j = await call("/api/commit", { tree: CG.key, message: msg, paths: [...CG.picked] });
            closeChanges();
            await refresh(true);
            openLog(j.id);
            toast("Коммит запущен: " + j.id, true);
        }
        catch (err) {
            toast(err.message);
            c.disabled = false;
            c.textContent = "Закоммитить";
        }
    }
}, true);

$("chg").addEventListener("click", (e) => {
    if (e.target.id === "chg")
        closeChanges();
});

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && CG.key)
        closeChanges();
});

document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-relay]");
    if (!b)
        return;
    e.preventDefault();
    e.stopPropagation();
    const w = b.closest(".mdcw"), from = b.dataset.from;
    let to = b.dataset.to;
    const code = w && w.querySelector("pre code"), text = code ? code.textContent : "";
    if (!to) {
        to = await pickSlot(b);
        if (!to)
            return;
    }
    if (b.classList.contains("busy"))
        return;
    b.classList.add("busy");
    try {
        const r = await call("/api/relay", { from, to, text });
        if (r.queued) {
            toast("В очереди к " + r.toTag + " (" + r.pos + "-я): уйдёт сама, когда он допишет ответ");
            await refresh(true);
            return;
        }
        RELAY_SEEN.add(r.relay.id);
        relayScene(from, to);
        if (to === "orchestrator")
            setSidebar(true);
        else {
            OPENCHAT.add(to);
            ls("dash.chats", [...OPENCHAT]);
        }
        b.dataset.to = to;
        relaySentMark(b);
        await refresh(true);
        pollChats();
    }
    catch (err) {
        if (/уже передан/.test(err.message)) {
            b.dataset.to = to;
            relaySentMark(b);
        }
        toast(err.message);
    }
    finally {
        b.classList.remove("busy");
    }
}, true);

document.addEventListener("toggle", (e) => {
    if (e.target.classList && e.target.classList.contains("remadd"))
        setState("REM_ADD_OPEN", e.target.open);
}, true);

$("tasksBtn").onclick = () => {
    const a = $("app"), hidden = $("tasks").offsetWidth === 0;
    if (hidden) {
        a.classList.remove("notasks");
        a.classList.add("tasksforce");
    }
    else {
        a.classList.remove("tasksforce");
        a.classList.add("notasks");
    }
    try {
        localStorage.setItem("dash.tasks", hidden ? "1" : "0");
    }
    catch { }
};

try {
    if (localStorage.getItem("dash.tasks") === "0")
        $("app").classList.add("notasks");
}
catch { }

$("monBtn").onclick = () => {
    const a = $("app"), hidden = $("mon").offsetWidth === 0;
    if (hidden) {
        a.classList.remove("nomon");
        a.classList.add("monforce");
    }
    else {
        a.classList.remove("monforce");
        a.classList.add("nomon");
    }
    try {
        localStorage.setItem("dash.mon", hidden ? "1" : "0");
    }
    catch { }
};

try {
    if (localStorage.getItem("dash.mon") === "0")
        $("app").classList.add("nomon");
}
catch { }

$("sideBtn").onclick = () => setSidebar(!SIDEBAR);
PM_Q.addEventListener("change", applyPm);
applyPm();

$("bnav").onclick = (e) => {
    const b = e.target.closest("button[data-pv]");
    if (b)
        setPv(b.dataset.pv);
};

setInterval(bnavBadges, 2000);

setInterval(() => {
    if (innerWidth > 600)
        return;
    for (const tr of document.querySelectorAll(".track")) {
        if (tr.scrollWidth <= tr.clientWidth + 2 || tr.scrollLeft > 0 || tr.__auto)
            continue;
        const c = tr.querySelector(".st.cur");
        tr.__auto = 1;
        if (c)
            tr.scrollLeft = Math.max(0, c.offsetLeft - tr.clientWidth / 2 + c.offsetWidth / 2);
    }
}, 1000);

document.addEventListener("submit", async (e) => {
    const form = e.target.closest(".ch-in");
    if (!form)
        return;
    e.preventDefault();
    const c = CHATS.get(form.closest(".chat").dataset.key), ta = form.querySelector("textarea"), text = ta.value.trim();
    if (!text)
        return;
    ta.value = "";
    fitInput(ta);
    try {
        await call("/api/agent/send", { key: c.key, text, model: c.el.querySelector('[data-r="model"]').value });
        pollChats();
    }
    catch (err) {
        ta.value = text;
        fitInput(ta);
        toast(err.message);
    }
});

window.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest('button.done[data-act]:not([data-act="stage"])');
    if (!b || e.shiftKey)
        return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toast("Уже зелёный на этом коде — повторять незачем. Перепрогнать всё равно: Shift+клик.", true);
}, true);

document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.target.tagName === "TEXTAREA" && e.target.closest(".ch-in")) {
        e.preventDefault();
        e.target.closest("form").requestSubmit();
    }
});

document.addEventListener("input", (e) => {
    if (e.target.tagName === "TEXTAREA" && e.target.closest(".ch-in"))
        fitInput(e.target);
});

window.addEventListener("resize", fitAll);

document.addEventListener("click", async (e) => {
    const ch = e.target.closest("[data-chat]");
    if (ch) {
        const c = CHATS.get(ch.closest(".chat").dataset.key);
        try {
            await chatAction(c, ch.dataset.chat, ch);
            pollChats();
        }
        catch (err) {
            toast(err.message);
        }
        return;
    }
    const el = e.target.closest("[data-act]");
    if (!el)
        return;
    const a = el.dataset.act;
    if (el.tagName === "BUTTON") {
        setState("CUR_BTN", btnKey(el));
        setTimeout(() => {
            setState("CUR_BTN", null);
        }, 3000);
    }
    try {
        if (a === "run") {
            const p = runPayload(el.dataset.tree, el.dataset.task, treeOf(el.dataset.tree).presets.find((x) => x.task === el.dataset.task));
            press(`run|${p.tree}|${p.task}`, () => runAsk(p), started);
        }
        else if (a === "runall") {
            const t = treeOf(el.dataset.tree), list = t.presets.length ? t.presets.map((p) => runPayload(t.key, p.task, p)) : gateTasks().map((task) => ({ tree: t.key, task, input: "" }));
            press("runall|" + t.key, () => runMany(list), manyMsg("волна " + t.tag));
        }
        else if (a === "free") {
            const tree = el.dataset.tree, task = document.querySelector(`[data-sel="${CSS.escape(tree)}"]`).value, def = S.tasks[task], input = IN[tree + "|__free"] || "";
            if (def.input && !input.trim())
                return toast("Нужен ввод: " + def.input.label);
            press("free|" + tree, () => runAsk({ tree, task, input: def.input ? input : "" }), started);
        }
        else if (a === "stg-sec")
            press("stg-sec", () => call("/api/run-staging-guards", {}), started);
        else if (a === "force") {
            e.stopPropagation();
            press("force|" + el.dataset.id, () => call("/api/force", { id: el.dataset.id }), "Запускаю, не дожидаясь");
        }
        else if (a === "cancel") {
            e.stopPropagation();
            el.innerHTML = SPIN;
            el.classList.add("busy");
            press("cancel|" + el.dataset.id, () => call("/api/cancel", { id: el.dataset.id }), "Останавливаю");
        }
        else if (a === "report") {
            e.stopPropagation();
            press("report|" + el.dataset.id, async () => {
                const r = await call("/api/agent-report", { id: el.dataset.id, to: el.dataset.to || undefined });
                OPENCHAT.add(r.key);
                ls("dash.chats", [...OPENCHAT]);
                if (r.key === "orchestrator")
                    setSidebar(true);
                return r;
            }, (r) => {
                setTimeout(() => focusChat(r.key), 600);
                return "Причина падения отправлена агенту " + (treeOf(r.key) ? treeOf(r.key).tag : r.key) + ": сообщение в его чате, окно прокручено к нему.";
            });
        }
        else if (a === "copy") {
            e.stopPropagation();
            const n = await copyForAgent(el.dataset.id);
            toast(`Скопировано для агента: итог и хвост лога (${Math.min(n, 80)} строк). Вставьте в окно слота.`, true);
        }
        else if (a === "log") {
            openLog(el.dataset.id);
        }
        else if (a === "standfx") {
            const j = standJob();
            setState("SFX_OPEN", SFX_OPEN === (j && j.id) && SFX_HIDE !== j.id ? null : j && j.id);
            setState("SFX_HIDE", null);
            renderStandFx();
        }
        else if (a === "sfxclose") {
            const j = standJob();
            setState("SFX_HIDE", j && j.id);
            renderStandFx();
        }
        else if (a === "close") {
            setState("drawer", null);
            $("drawer").classList.remove("on");
        }
        else if (a === "changes")
            openChanges(el.dataset.tree);
        else if (a === "unlock") {
            press("unlock|" + el.dataset.key, () => call("/api/ssh-unlock", { id: el.dataset.key }), (r) => r.message);
        }
        else if (a === "dismiss") {
            e.stopPropagation();
            DISM.add(el.dataset.id);
            ls("dash.dismissed", [...DISM].slice(-300));
            renderTasks();
        }
        else if (a === "dismissall") {
            failedUnresolved().forEach((j) => DISM.add(j.id));
            ls("dash.dismissed", [...DISM].slice(-300));
            renderTasks();
        }
        else if (a === "rerun") {
            e.stopPropagation();
            const j = S.jobs.find((x) => x.id === el.dataset.id);
            if (!j)
                return;
            if (j.tree.startsWith("orchestrator-") && gateTasks().includes(j.task))
                press("stg-sec", () => call("/api/run-staging-guards", {}), started);
            else
                press("run|" + j.tree + "|" + j.task, () => runAsk({ tree: j.tree, task: j.task, input: j.input || "" }), started);
        }
        else if (a === "ggtoggle") {
            setState("GGOPEN", !GGOPEN);
            try {
                localStorage.setItem("dash.ggopen", GGOPEN ? "1" : "0");
            }
            catch { }
            applyGgOpen();
        }
        else if (a === "epicgo") {
            const id = el.dataset.id;
            if (id === S.activeEpic)
                return;
            setState("VIEW_EPIC", id);
            try {
                localStorage.setItem("dash.epic", id);
            }
            catch { }
            call("/api/epic", { op: "activate", id }).catch(() => { });
            CHATS.forEach((c, k) => {
                if (k === "orchestrator")
                    CHATS.delete(k);
            });
            location.reload();
        }
        else if (a === "epicnew")
            openNewEpic();
        else if (a === "epicarchive") {
            if (confirm("Убрать вкладку эпика в архив? Папки слотов и ветки не трогаются, вернуть можно из архива."))
                press("epicarch", async () => {
                    await call("/api/epic", { op: "archive", id: el.dataset.id });
                    location.reload();
                }, "Эпик в архиве");
        }
        else if (a === "epicrestore")
            press("epicrest", async () => {
                await call("/api/epic", { op: "restore", id: el.dataset.id });
                location.reload();
            }, "Эпик возвращён");
        else if (a === "agentcommit")
            agentCommit(el.dataset.tree);
        else if (a === "specrun") {
            const tree = el.dataset.tree, fam = el.dataset.fam, specs = String(el.dataset.specs || "").split(",").filter(Boolean);
            press("run|" + tree + "|" + fam + "|" + specs.join(","), () => runAsk({ tree, fam, specs }), started);
        }
        else if (a === "inbox-send") {
            e.stopPropagation();
            const id = el.dataset.id, ib = (S.inbox || []).find((x) => x.id === id);
            press("ib|" + id, async () => {
                const r = await call("/api/inbox", { id, op: "send" });
                if (r.queued) {
                    toast("В очереди к " + r.toTag + " (" + r.pos + "-я): уйдёт сама");
                    return r;
                }
                if (r.relay) {
                    RELAY_SEEN.add(r.relay.id);
                    relayScene(ib.tree, ib.to);
                    if (ib.to === "orchestrator")
                        setSidebar(true);
                    else {
                        OPENCHAT.add(ib.to);
                        ls("dash.chats", [...OPENCHAT]);
                    }
                }
                else if (r.key) {
                    OPENCHAT.add(r.key);
                    ls("dash.chats", [...OPENCHAT]);
                }
                return r;
            }, "Отправлено");
        }
        else if (a === "inbox-dismiss") {
            e.stopPropagation();
            press("ibx|" + el.dataset.id, () => call("/api/inbox", { id: el.dataset.id, op: "dismiss" }), "Убрано");
        }
        else if (a === "autocommit")
            press("autocommit", () => call("/api/settings", { autoCommit: !(S.settings && !!S.settings.autoCommit) }), (r) => "Автокоммит: " + (r.settings.autoCommit !== false ? "включён" : "выключен"));
        else if (a === "automerge")
            press("automerge", () => call("/api/settings", { autoMerge: !(S.settings && !!S.settings.autoMerge) }), (r) => "Автовлив в staging: " + (r.settings.autoMerge !== false ? "включён" : "выключен"));
        else if (a === "autosync")
            press("autosync", () => call("/api/settings", { autoSyncConflict: !(S.settings && !!S.settings.autoSyncConflict) }), (r) => "Автоподтягивание staging при конфликте: " + (r.settings.autoSyncConflict !== false ? "включено" : "выключено"));
        else if (a === "autotrain")
            press("autotrain", () => call("/api/settings", { autoTrain: !(S.settings && S.settings.autoTrain) }), (r) => "Автопоезд: " + (r.settings.autoTrain ? "включён" : "выключен"));
        else if (a === "epicprogress")
            openEpicProgress(el.dataset.id);
        else if (a === "epicclose")
            closeEpic(el.dataset.id, el.dataset.title);
        else if (a === "epicretro")
            openRetro(el.dataset.id);
        else if (a === "hygiene") {
            if (confirm("Убрать лишние папки слотов (" + ((S.hygiene || {}).extra || 0) + ")? Незакоммиченное — в git stash, невлитые ветки останутся."))
                press("hygiene", () => call("/api/hygiene", { op: "run" }), (r) => r.message);
        }
        else if (a === "tgbot")
            press("tgbot", () => call("/api/settings", { tgBot: !(S.settings && S.settings.tgBot) }), (r) => "Бот в Telegram: " + (r.settings.tgBot ? "включён" : "выключен"));
        else if (a === "nightmode") {
            const on = ((S.settings && S.settings.autoOwnerUntil) || 0) > Date.now();
            // Включение ночного режима тянет за собой автопоезд и автоотчёт слоту: без них ночью поезда стоят.
            press("nightmode", () => call("/api/settings", on ? { autoOwner: false } : { autoOwner: true, autoTrain: true, autoResults: true }),
                (r) => "Ночной режим: " + (((r.settings || {}).autoOwnerUntil || 0) > Date.now() ? "включён до " + new Date(r.settings.autoOwnerUntil).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "выключен"));
        }
        else if (a === "fullperm")
            press("fullperm", () => call("/api/settings", { fullPermissions: !(S.settings && S.settings.fullPermissions) }), (r) => "Полные разрешения агентам: " + (r.settings.fullPermissions ? "включены" : "выключены"));
        else if (a === "provision")
            press("prov|" + el.dataset.tree, () => call("/api/provision", { tree: el.dataset.tree }), "Подготовка слота запущена");
        else if (a === "rungards")
            runGuards(el.dataset.tree);
        else if (a === "runregress")
            runRegress(el.dataset.tree);
        else if (a === "slotstop") {
            const k = el.dataset.tree, t = treeOf(k), run = (S.allJobs || S.jobs || []).filter((j) => j.tree === k && ["running", "queued", "waiting"].includes(j.status)).length;
            if (!confirm("Остановить слот " + ((t && t.tag) || k) + "?\nАгент заснёт (сессия сохранится), хвосты из папки слота будут сняты." + (run ? "\n\nПрогонов слота идёт или ждёт: " + run + " — их тоже отменить? (ОК — да)" : "")))
                return;
            press("slotstop|" + k, () => call("/api/slot-stop", { tree: k, cancelJobs: run > 0 }), (r) => (r && r.message) || "остановлено");
        }
        else if (a === "slotstart") {
            const k = el.dataset.tree;
            press("slotstart|" + k, () => call("/api/slot-start", { tree: k }), (r) => (r && r.message) || "открывается");
        }
        else if (a === "train") {
            const op = el.dataset.op;
            if (op === "merge" && !confirm("Влить поездом в staging: " + ((S.train.cur.runs.find((r) => r.id === S.train.cur.green) || {}).tags || []).join(" + ") + "?\nВетки вольются по порядку зависимостей, каждая отдельным merge-коммитом. Пуш и выкат стенда — отдельно."))
                return;
            press("train|" + op, () => call("/api/train", { op }), (r) => (r && r.message) || (op === "merge" ? "Влив поездом поставлен" : op === "stop" ? "Поезд остановлен" : "Готово"));
        }
        else if (a === "order")
            press("order|" + el.dataset.a + "|" + el.dataset.b, () => call("/api/order", { a: el.dataset.a, b: el.dataset.b, op: el.dataset.op || "after" }), el.dataset.op === "none" ? "Отмечено: не связаны" : "Порядок записан в реестр эпика");
        else if (a === "trainwagon")
            press("trainwagon|" + el.dataset.tree, () => call("/api/train-wagon", { tree: el.dataset.tree, wave: el.dataset.wave }), (r) => (r && r.message) || "Вагон выдан агенту");
        else if (a === "autochain")
            press("autochain|" + el.dataset.tree, () => call("/api/autochain", { tree: el.dataset.tree, on: el.dataset.on === "1" }), (r) => (r && r.message) || "Автопоезд пошёл");
        else if (a === "agentsleep")
            press("agentsleep|" + el.dataset.tree, () => call("/api/agent/stop", { key: el.dataset.tree }), "Агент усыплён: сессия сохранена");
        else if (a === "rail") {
            setRail(el.dataset.m);
            if (el.dataset.acc)
                accJump(el.dataset.acc);
        }
        else if (a === "keyhelp")
            openKeyHelp();
        else if (a === "collapseall")
            collapseAll();
        else if (a === "shardopen")
            window.open("/shard", "_blank");
        else if (a === "kbopen") {
            applyView("dash");
            setState("FOCUS", el.dataset.tree);
            setState("SELK", FOCUS);
            OPEN.add(FOCUS);
            render();
            const l = $("lines");
            if (l)
                pageScrollToEl(l, 80);
        }
        else if (a === "focus") {
            setState("FOCUS", el.dataset.tree);
            setState("SELK", FOCUS);
            OPEN.add(FOCUS);
            render();
            const l = $("lines");
            if (l)
                pageScrollToEl(l, 80);
        }
        else if (a === "focusexit") {
            setState("FOCUS", null);
            render();
        }
        else if (a === "slotgo") {
            setState("SELK", el.dataset.tree);
            setState("FOCUS", el.dataset.tree);
            OPEN.add(FOCUS);
            render();
            const l = $("lines");
            if (l)
                pageScrollToEl(l, 80);
        }
        else if (a === "runreview") {
            const force = !!el.dataset.force;
            if (force && !confirm("Код не менялся после прошлого ревью: повтор, скорее всего, даст тот же вердикт и потратит лимит. Всё равно повторить?"))
                return;
            press("run|" + el.dataset.tree + "|review", () => call("/api/run", { tree: el.dataset.tree, task: "review", force }), started);
        }
        else if (a === "archive") {
            const t = treeOf(el.dataset.tree);
            if (!t || !confirm("Убрать в архив " + t.tag + "?\nПапка слота (node_modules, сборка) удалится, окно и агент закроются. Ветка и запись в реестре останутся."))
                return;
            press("archive|" + t.key, () => call("/api/slot-archive", { tree: t.key }), (r) => (r && r.message) || "В архиве");
        }
        else if (a === "slotreset") {
            const t = treeOf(el.dataset.tree);
            if (!t)
                return;
            press("reset|" + t.key, async () => {
                const p = await call("/api/slot-reset", { tree: t.key, to: "staging", dry: true });
                if (p.noop)
                    return p;
                if (!confirm(p.message.split("\n(сухой прогон")[0] + "\n\nСбросить? Коммиты снимутся из ветки (останутся под тегом-страховкой)."))
                    return { message: "сброс отменён" };
                return call("/api/slot-reset", { tree: t.key, to: "staging" });
            }, (r) => (r && r.message) || "сброшено");
        }
        else if (a === "syncstg")
            press("syncstg", () => call("/api/sync-staging", {}), (r) => (r && r.message) || "поставлено");
        else if (a === "reqrun") {
            const tree = el.dataset.tree, task = el.dataset.task, input = el.dataset.input || "";
            press("run|" + tree + "|" + task + "|" + input, () => runAsk({ tree, task, input }), started);
        }
        else if (a === "reqall") {
            const tree = el.dataset.tree, g = (S.testReqs || []).find((x) => x.tree === tree);
            if (g)
                press("reqall|" + tree, () => runMany(g.items.filter((x) => x.status !== "ok" && x.status !== "run").map((x) => ({ tree, task: x.task, input: x.input || "" }))), manyMsg("по просьбе агента"));
        }
        else if (a === "autoresults")
            press("autoresults", () => call("/api/settings", { autoResults: !(S.settings && S.settings.autoResults) }), (r) => "Автоотчёт слоту: " + (r.settings.autoResults ? "включён" : "выключен"));
        else if (a === "oqsel") {
            oqPick(el);
            ls("dash.inputs", IN);
        }
        else if (a === "oqsubmit") {
            const form = el.closest(".oqform");
            if (!form)
                return;
            const r0 = oqCollect(form);
            if (!r0.text) {
                toast("Выберите вариант или впишите свой ответ");
                return;
            }
            const chat = form.closest(".chat"), key = r0.mode === "chat" ? chat && chat.dataset.key : r0.target;
            if (!key) {
                toast("Не нашла агента для ответа");
                return;
            }
            const done = () => {
                for (const k of r0.keys)
                    IN[k] = "";
                ls("dash.inputs", IN);
            };
            const note = r0.missing.length ? " · без ответа: " + r0.missing.join(", ") : "";
            if (r0.mode === "chat")
                press("oqsubmit|" + r0.scope, async () => {
                    await call("/api/agent/send", { key, text: r0.text });
                    done();
                    pollChats();
                }, "Ответ отправлен" + note);
            else
                press("oqsubmit|" + r0.scope, async () => {
                    const r = await call("/api/ownerq-answer", { tree: key, text: r0.text });
                    done();
                    if (key !== "orchestrator") {
                        OPENCHAT.add(key);
                        ls("dash.chats", [...OPENCHAT]);
                    }
                    return r;
                }, (r) => ((r && r.message) || "Ответ отправлен: агент продолжит") + note);
        }
        else if (a === "sidechat" || (a === "focuschat" && sideChatTrees().some((t) => t.key === el.dataset.tree))) {
            if (RAILM !== "orch")
                setRail("orch");
            else if (!SIDEBAR)
                setSidebar(true);
            setSideChat(el.dataset.tree);
            if (a === "focuschat")
                setTimeout(() => focusChat(el.dataset.tree), 300);
        }
        else if (a === "clfold") {
            const sb = $("sidebody"), on = !sb.classList.contains("clmin");
            sb.classList.toggle("clmin", on);
            ls("dash.clmin", on ? "1" : "0");
        }
        else if (a === "focuschat") {
            const k = el.dataset.tree;
            if (k === "orchestrator") {
                if (RAILM !== "orch")
                    setRail("orch");
                else
                    setSidebar(true);
            }
            else {
                OPENCHAT.add(k);
                ls("dash.chats", [...OPENCHAT]);
                render();
            }
            pollChats();
            setTimeout(() => focusChat(k), 300);
        }
        else if (a === "agentstop") {
            e.stopPropagation();
            press("agentstop|" + el.dataset.tree, () => call("/api/agent/interrupt", { key: el.dataset.tree }), "Ответ прерван");
        }
        else if (a === "kill") {
            e.stopPropagation();
            const role = el.dataset.role;
            if (/агент/i.test(role) && !confirm("Это процесс агента. Его чат оборвётся. Убить?"))
                return;
            press("kill|" + el.dataset.pid, () => call("/api/kill", { pid: Number(el.dataset.pid) }), (r) => "Остановлено: " + r.killed);
        }
        else if (a === "chat") {
            const k = el.dataset.tree;
            if (k === "orchestrator")
                setSidebar(el.dataset.open ? true : !SIDEBAR);
            else {
                if (el.dataset.open)
                    OPENCHAT.add(k);
                else
                    OPENCHAT.has(k) ? OPENCHAT.delete(k) : OPENCHAT.add(k);
                ls("dash.chats", [...OPENCHAT]);
                render();
                pollChats();
            }
        }
        else if (a === "anchor") {
            const to = el.dataset.to, app = $("app");
            if (to === "tasks") {
                app.classList.remove("notasks");
                app.classList.add("tasksforce");
                try {
                    localStorage.setItem("dash.tasks", "1");
                }
                catch { }
                ;
                const tk = $("tasks");
                if (tk) {
                    tk.scrollIntoView({ behavior: "smooth", block: "start" });
                    tk.classList.add("flash");
                    setTimeout(() => tk.classList.remove("flash"), 900);
                }
            }
            else {
                app.classList.remove("nomon");
                app.classList.add("monforce");
                try {
                    localStorage.setItem("dash.mon", "1");
                }
                catch { }
                ;
                renderMon();
                setTimeout(() => {
                    const c = document.getElementById(to);
                    if (c) {
                        c.scrollIntoView({ behavior: "smooth", block: "start" });
                        c.classList.add("flash");
                        setTimeout(() => c.classList.remove("flash"), 900);
                    }
                }, 60);
            }
        }
        else if (a === "remrun") {
            const r = (S.reminders || []).find((x) => x.id === el.dataset.id);
            if (r && confirm("Выполнить задачу проекта?\n\n" + r.cmd))
                press("remrun|" + r.id, () => call("/api/reminders", { op: "run", id: r.id }), (x) => x.message);
        }
        else if (a === "remdone")
            press("remdone|" + el.dataset.id, () => call("/api/reminders", { op: "done", id: el.dataset.id }), "Отмечено: сделано");
        else if (a === "remdismiss")
            press("remdis|" + el.dataset.id, () => call("/api/reminders", { op: "dismiss", id: el.dataset.id }));
        else if (a === "remadd")
            press("remadd", () => call("/api/reminders", { op: "add", text: $("remText").value, cmd: $("remCmd").value }), "Напоминание добавлено");
        else if (a === "accask")
            press("accask", () => call("/api/accept", { op: "ask" }), (r) => r.message);
        else if (a === "accrun")
            press("accrun|" + (el.dataset.key || ""), () => call("/api/accept", { op: "run", keys: el.dataset.key ? [el.dataset.key] : null }), (r) => r.message);
        else if (a === "mwcancel") {
            const k = el.dataset.tree;
            if (confirm("Снять ожидание ВЛИТЬ у " + ((treeOf(k) || {}).tag || k) + "? Диспетчерская не вольёт сама, слово владельца по этому слоту погаснет."))
                press("mwcancel|" + k, () => call("/api/merge-wait", { slot: k, op: "cancel" }), (r) => r.message);
        }
        else if (a === "slotsync") {
            const k = el.dataset.tree;
            if (confirm("Подтянуть staging в ветку " + ((treeOf(k) || {}).tag || k) + "? Своих коммитов нет — перемотка; есть — влив staging в ветку волны (только ветка слота).")) {
                toast("Подтягиваю staging в " + ((treeOf(k) || {}).tag || k) + "… влив идёт до пары минут, итог придёт сюда", true);
                press("sync|" + k, () => call("/api/slot-sync", { tree: k }), (r) => r.message);
            }
        }
        else if (a === "accaskspec")
            press("accaskspec|" + el.dataset.key, () => call("/api/accept", { op: "askspec", key: el.dataset.key }), (r) => r.message);
        else if (a === "accrun1")
            press("accrun1|" + el.dataset.key + el.dataset.id, () => call("/api/accept", { op: "run", keys: [el.dataset.key], item: el.dataset.id }), (r) => r.message);
        else if (a === "accaskone") {
            const key = el.dataset.key;
            press("accask1|" + key, async () => {
                await call("/api/accept", { op: "reset", key });
                return call("/api/accept", { op: "ask", keys: [key] });
            }, (r) => r.message);
        }
        else if (a === "accspecall") {
            if (confirm("Заказать спеки приёмки заново всем волнам, которые ждут вердикта? Каждому агенту уйдёт задача дописать спеку, когда он освободится."))
                press("accspecall", () => call("/api/accept", { op: "askspecall" }), (r) => r.message);
        }
        else if (a === "accsend") {
            if (confirm("Отправить итоги приёмки агентам и оркестратору?"))
                press("accsend", () => call("/api/accept", { op: "send" }), (r) => r.message);
        }
        else if (a === "accitem")
            press("accitem|" + el.dataset.key + el.dataset.id, () => call("/api/accept", { op: "item", key: el.dataset.key, id: el.dataset.id, state: el.dataset.st }));
        else if (a === "accverdict") {
            const key = el.dataset.key, ta = document.querySelector(`[data-accvc="${CSS.escape(key)}"]`), cur = ((S.accept && S.accept.waves) || []).find((w) => w.key === key);
            press("accv|" + key, () => call("/api/accept", { op: "verdict", key, verdict: cur && cur.verdict === el.dataset.v ? "" : el.dataset.v, comment: ta ? ta.value : undefined }));
        }
        else if (a === "accfold") {
            const k = el.dataset.key;
            ACC_FOLD.has(k) ? ACC_FOLD.delete(k) : ACC_FOLD.add(k);
            ls("dash.accfold", [...ACC_FOLD]);
            renderSide();
        }
        else if (a === "monfold") {
            const f = el.dataset.f;
            MONOPEN.has(f) ? MONOPEN.delete(f) : MONOPEN.add(f);
            ls("dash.monopen", [...MONOPEN]);
            renderMon();
        }
        else if (a === "stgrun") {
            const task = SEL.__staging || stgTasks()[0], input = (IN["__staging|__free"] || "").trim();
            press("stgrun", () => call("/api/run-staging", { task, input, profile: "auto" }), (r) => "На staging: " + r.label + (input ? " · " + input : "") + " (" + r.id + ")");
        }
        else if (a === "orderfold") {
            toggleOrderFold();
            const o = $("ordermap");
            if (o)
                delete o.dataset.sig;
            renderKanban();
        }
        else if (a === "ordermode") {
            setOrderMode(el.dataset.m);
            const o = $("ordermap");
            if (o)
                delete o.dataset.sig;
            renderKanban();
        }
        else if (a === "gscale") {
            setGanttScale(el.dataset.s);
            const o = $("ordermap");
            if (o)
                delete o.dataset.sig;
            renderKanban();
        }
        else if (a === "grpfold") {
            const g = el.dataset.g;
            GFOLD.has(g) ? GFOLD.delete(g) : GFOLD.add(g);
            ls("dash.gfold", [...GFOLD]);
            render();
        }
        else if (a === "toggle") {
            const k = el.dataset.tree, wasOpen = OPEN.has(k) || OPENCHAT.has(k);
            if (wasOpen) {
                OPEN.delete(k);
                OPENCHAT.delete(k);
                ls("dash.chats", [...OPENCHAT]);
            }
            else
                OPEN.add(k);
            ls("dash.open", [...OPEN]);
            render();
        }
        else if (a === "filter") {
            setState("FILTER", el.dataset.k);
            render();
        }
        else if (a === "pl")
            press("pl|" + el.dataset.action + "|" + (el.dataset.slot || el.dataset.service || ""), () => openPipeline(el.dataset.action, el.dataset.slot, el.dataset.service));
        else if (a === "trainwagonforce") {
            if (confirm("Запустить вагон " + el.dataset.wave + " сейчас, не дожидаясь его зависимости? Агент поезда получит его в своей сессии."))
                press("trainwagon|" + el.dataset.tree, () => call("/api/train-wagon", { tree: el.dataset.tree, wave: el.dataset.wave, force: true }), (r) => {
                    $("modal").classList.remove("on");
                    setTimeout(() => refresh(true), 400);
                    return (r && r.message) || "Вагон выдан агенту";
                });
        }
        else if (a === "wagonplan")
            openWagonPlan(el.dataset.tree, el.dataset.wave);
        else if (a === "mclose") {
            $("modal").classList.remove("on");
            $("mb").className = "mb";
        }
        else if (a === "stage")
            openStation(el.dataset.tree, el.dataset.stage);
    }
    catch (err) {
        toast(err.message);
    }
});

document.addEventListener("input", (e) => {
    const k = e.target.dataset && e.target.dataset.ik;
    if (k) {
        IN[k] = e.target.value;
        ls("dash.inputs", IN);
    }
});

document.addEventListener("change", (e) => {
    const k = e.target.dataset && e.target.dataset.sel;
    if (k)
        SEL[k] = e.target.value;
});

document.addEventListener("change", (e) => {
    const d = e.target.dataset || {};
    if (d.acccm) {
        const i = d.acccm.lastIndexOf("|");
        call("/api/accept", { op: "item", key: d.acccm.slice(0, i), id: d.acccm.slice(i + 1), comment: e.target.value }).catch((err) => toast(err.message));
    }
    if (d.accvc)
        call("/api/accept", { op: "comment", key: d.accvc, comment: e.target.value }).catch((err) => toast(err.message));
});

document.addEventListener("change", async (e) => {
    const m = e.target;
    if (!m.matches || !m.matches('.chat [data-r="model"]'))
        return;
    const key = m.closest(".chat").dataset.key;
    try {
        const r = await call("/api/agent/model", { key, model: m.value });
        toast(r.message || "Модель выбрана", true);
        pollChats();
    }
    catch (err) {
        toast(err.message);
    }
});

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        $("modal").classList.remove("on");
        if (drawer) {
            setState("drawer", null);
            $("drawer").classList.remove("on");
        }
    }
});

$("modal").addEventListener("click", (e) => {
    if (e.target.id === "modal")
        $("modal").classList.remove("on");
});

$("reloadBtn").onclick = async () => {
    const b = $("reloadBtn");
    b.classList.add("spinning");
    try {
        await call("/api/rebuild", {});
    }
    catch { }
    location.reload();
};

$("fetchBtn").onclick = async () => {
    const b = $("fetchBtn");
    b.disabled = true;
    b.innerHTML = SPIN + " fetch";
    try {
        const r = await call("/api/fetch", {});
        toast(r.message, true);
    }
    catch (e) {
        toast(e.message);
    }
    b.disabled = false;
    b.innerHTML = '⟳<span class="lbl"> git fetch</span>';
    refresh(true);
};

$("app").classList.toggle("nosb", !SIDEBAR);
installBacklog();
startData();
setInterval(() => drawer && (!logFinal || Date.now() - logAt > 10000) && pollLog(), 1000);
bindOrderDnd({ press, call, refresh });

{
    let drag = null;
    const D = '.tcar[data-dnd="depot"]';
    const box = (el) => el && el.closest && el.closest(".trains2");
    const orderOf = (tr) => {
        const rail = tr.querySelector(".tqrail[data-dnd-tree]");
        return rail ? [...rail.querySelectorAll(D)].map((x) => x.dataset.wave) : [];
    };
    document.addEventListener("dragstart", (e) => {
        const c = e.target.closest && e.target.closest(D);
        if (!c)
            return;
        drag = c;
        c.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", c.dataset.wave);
    });
    document.addEventListener("dragend", () => {
        if (drag)
            drag.classList.remove("dragging");
        drag = null;
        for (const x of document.querySelectorAll(".tcar.dropto"))
            x.classList.remove("dropto");
    });
    document.addEventListener("dragover", (e) => {
        if (!drag)
            return;
        const c = e.target.closest && e.target.closest(D);
        if (!c || c === drag || box(c) !== box(drag))
            return;
        e.preventDefault();
        for (const x of document.querySelectorAll(".tcar.dropto"))
            x.classList.remove("dropto");
        c.classList.add("dropto");
    });
    document.addEventListener("drop", (e) => {
        if (!drag)
            return;
        const c = e.target.closest && e.target.closest(D), tr = box(drag);
        if (!c || c === drag || box(c) !== tr)
            return;
        e.preventDefault();
        let waves = orderOf(tr).filter((w) => w !== drag.dataset.wave), i = waves.indexOf(c.dataset.wave);
        const box2 = c.getBoundingClientRect(), after = e.clientX > box2.left + box2.width / 2;
        waves.splice(i + (after ? 1 : 0), 0, drag.dataset.wave);
        const rail = tr.querySelector(".tqrail[data-dnd-tree]"), tree = (rail && rail.dataset.dndTree) || c.dataset.tree;
        press("orderwagons|" + tree, () => call("/api/order-wagons", { tree, waves }), (r) => {
            setTimeout(() => refresh(true), 400);
            return (r && r.message) || "Порядок вагонов обновлён";
        });
    });
}

document.addEventListener("keydown", (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && SIDEBAR && RAILM === "orch") {
        e.preventDefault();
        stepSideChat(e.key === "ArrowUp" ? -1 : 1);
    }
}, true);
