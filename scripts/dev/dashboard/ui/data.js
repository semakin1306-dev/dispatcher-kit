// data.js — данные страницы: поток событий сервера (SSE), чтение состояния только при новой версии, монитор и чек-листы
// приёмки отдельными запросами. Без потока событий — опрос раз в несколько секунд.
import { IN, S, setState, VIEW_EPIC } from "./state.js";
import { $, appTitle, bootHide, bootShow, call, modOn, UI_STALE, uiFresh } from "./core.js";
import { render } from "./render.js";
import { renderEpics, renderTasks } from "./tasks.js";
import { RAILM, renderSide } from "./side.js";
import { CHATS, pollChat, pollChats, SIDEBAR, watchRelays } from "./chat.js";
import { renderMon } from "./monitor.js";
import { applyGgOpen, loadGraph } from "./graph.js";

let VER = 0, MON = null, ES = null, esUp = false, stateBusy = false, stateAgain = false, lastStateAt = 0;

export async function refresh(force) {
    if (stateBusy) {
        stateAgain = stateAgain || !!force;
        return;
    }
    stateBusy = true;
    try {
        let r0;
        try {
            r0 = await call("/api/state?ver=" + (force ? 0 : VER));
        }
        catch (e) {
            if (e && e.data) {
                $("upd").textContent = "ошибка сервера: " + e.message;
                $("upd").className = "pill bad";
                return;
            }
            $("upd").textContent = "нет связи с сервером";
            $("upd").className = "pill bad";
            bootShow(true);
            return;
        }
        try {
            if (r0.booting) {
                bootShow();
                return;
            }
            if (r0.unchanged) {
                lastStateAt = Date.now();
                bootHide();
                if (S)
                    headerPills();
                return;
            }
            VER = r0.ver || 0;
            lastStateAt = Date.now();
            const accFull = S && S.accept && !S.accept.brief ? S.accept : null;
            setState("S", Object.assign(r0, MON || {}));
            if (accFull && r0.accept)
                S.accept = { ...accFull, tiles: r0.accept.tiles, run: r0.accept.run, waiting: r0.accept.waiting };
            isoEpic();
            applyTitle();
            bootHide();
            uiFresh(r0.uiVer);
            headerPills();
            render();
            renderTasks();
            watchRelays();
            renderEpics();
            applyGgOpen();
            if (MON)
                renderMon();
            pageErr(null);
            if (RAILM === "accept" && SIDEBAR && modOn("accept"))
                loadAccept();
            {
                const head = ((r0.pipeline || {}).staging || "") + "|" + ((r0.pipeline || {}).main || "");
                if (head !== loadGraph.head || Date.now() - (loadGraph.at || 0) > 30000) {
                    loadGraph.head = head;
                    loadGraph.at = Date.now();
                    loadGraph();
                }
            }
        }
        catch (e) {
            pageErr(e);
        }
    }
    finally {
        stateBusy = false;
        if (stateAgain) {
            const f = stateAgain;
            stateAgain = false;
            refresh(f === true);
        }
    }
}

// Заголовок окна и шапки: «Диспетчерская · <проект>» (state.project.name), без имени — просто «Диспетчерская»;
// заодно — видимость кнопок шапки по модулям.
function applyTitle() {
    const t = appTitle();
    if (document.title !== t)
        document.title = t;
    const l = document.getElementById("logoText");
    if (l && l.textContent !== t)
        l.textContent = t;
    // Элементы разметки с data-mod видны, только когда их модуль включён.
    for (const el of document.querySelectorAll("[data-mod]"))
        el.hidden = !modOn(el.dataset.mod);
}

function pageErr(e) {
    let p = document.getElementById("pageErr");
    if (!e) {
        if (p)
            p.style.display = "none";
        return;
    }
    console.error("[диспетчерская] ошибка отрисовки:", e);
    if (!p) {
        p = document.createElement("span");
        p.id = "pageErr";
        p.className = "pill bad";
        const u = $("upd");
        u.parentNode.insertBefore(p, u.nextSibling);
    }
    p.textContent = "ошибка страницы: " + String((e && e.message) || e).slice(0, 120) + " (F12 — консоль)";
    p.title = String((e && e.stack) || e);
    p.style.display = "";
}

function headerPills() {
    const m = S.mem, pm = $("mem");
    if (m) {
        pm.innerHTML = `память: свободно <b>${m.freeCommitGB.toFixed(1)}</b> из ${m.totalCommitGB.toFixed(0)} ГБ`;
        pm.className = "pill " + (m.freeCommitGB < 3 ? "bad" : m.freeCommitGB < 8 ? "warn" : "good");
    }
    else
        pm.textContent = "память: не измерена";
    document.documentElement.style.setProperty("--hh", document.querySelector("header").offsetHeight + "px");
    const act = S.jobs.filter((j) => j.status === "running").length, wait = Object.values(S.queue || {}).reduce((a, v) => a + (Number(v) || 0), 0);
    const off = S.serverOnline === false && wait ? " · удалённая машина не на связи" : "";
    $("queue").innerHTML = `идёт: <b>${act}</b> · ждут: <b>${wait}</b>${off}`;
    $("queue").className = "pill" + (off ? " bad" : act ? " warn" : "");
    if (UI_STALE) {
        $("upd").textContent = "↻ код страницы обновился — нажмите F5";
        $("upd").className = "pill warn";
    }
    else {
        $("upd").textContent = "обновлено " + new Date().toLocaleTimeString("ru-RU") + (esUp ? "" : " · опрос");
        $("upd").className = "pill";
    }
    corruptPill();
}

function corruptPill() {
    const p = $("corruptPill"), list = (S && S.stateCorrupt) || [];
    if (!p)
        return;
    if (!list.length) {
        p.style.display = "none";
        return;
    }
    p.style.display = "";
    p.textContent = "‼ битый файл состояния: " + list.map((x) => x.file).join(", ") + " — начат с нуля";
    p.title = list.map((x) => x.file + " (" + x.bytes + " байт, " + new Date(x.at).toLocaleString("ru-RU") + "): " + x.error + "\n" + (x.held ? "  файл оставлен как есть, запись в него отключена (пробный экземпляр)" : "  исходник сохранён: " + x.movedTo)).join("\n") + "\nПодробности — событие state.corrupt в events.jsonl";
}

async function loadMonitor() {
    if (document.visibilityState === "hidden")
        return;
    try {
        MON = await call("/api/monitor");
        if (S) {
            Object.assign(S, MON);
            headerPills();
            renderMon();
        }
    }
    catch { }
}

export async function loadAccept() {
    try {
        const a = await call("/api/accept-state");
        if (S) {
            S.accept = a;
            if (RAILM === "accept")
                renderSide();
        }
    }
    catch { }
}

let esWait = 3000, esTimer = null;

function connectEvents() {
    if (!window.EventSource)
        return;
    clearTimeout(esTimer);
    esTimer = null;
    if (ES) {
        try {
            ES.close();
        }
        catch { }
        ES = null;
    }
    let es;
    try {
        es = ES = new EventSource("/api/events" + (VIEW_EPIC ? "?epic=" + encodeURIComponent(VIEW_EPIC) : ""));
    }
    catch {
        esRetry();
        return;
    }
    es.addEventListener("hello", (e) => {
        if (es !== ES)
            return;
        esUp = true;
        esWait = 3000;
        let d = {};
        try {
            d = JSON.parse(e.data);
        }
        catch { }
        if (d.ver !== VER)
            refresh();
        pollChats();
    });
    es.addEventListener("ver", () => {
        if (es === ES)
            refresh();
    });
    es.addEventListener("agent", (e) => {
        if (es !== ES)
            return;
        let d = {};
        try {
            d = JSON.parse(e.data);
        }
        catch {
            return;
        }
        const c = CHATS.get(d.key);
        if (c && c.el.isConnected && (d.rev || 0) > c.rev)
            pollChat(c);
    });
    es.onerror = () => {
        if (es !== ES)
            return;
        esUp = false;
        try {
            es.close();
        }
        catch { }
        ES = null;
        esRetry();
    };
}

function esRetry() {
    if (esTimer)
        return;
    const w = esWait;
    esWait = Math.min(esWait * 2, 30000);
    esTimer = setTimeout(connectEvents, w);
}

export function startData() {
    connectEvents();
    refresh(true);
    loadMonitor();
    setInterval(() => {
        if (!esUp || Date.now() - lastStateAt > 30000)
            refresh();
    }, 5000);
    setInterval(loadMonitor, 15000);
    setInterval(() => {
        if (!esUp)
            pollChats();
    }, 5000);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            refresh();
            loadMonitor();
        }
    });
}

export const lastJob = (tree, task) => [...S.jobs].reverse().find((j) => j.tree === tree && j.task === task);
/** Последний прогон любой из задач списка. */
export const lastJobOf = (tree, tasks) => [...S.jobs].reverse().find((j) => j.tree === tree && tasks.includes(j.task));
// Набор спек через «|»: прогон надмножества тоже засчитывается.
export const lastJobIn = (tree, task, input) => [...S.jobs].reverse().find((j) => j.tree === tree && j.task === task && ((j.input || "") === (input || "") || (!!input && input.includes("|") && input.split("|").every((n) => String(j.input || "").split("|").includes(n)))));
export const treeOf = (key) => S.trees.find((t) => t.key === key);
export const inKey = (tree, task) => tree + "|" + task;

export function inVal(t, task, preset) {
    const k = inKey(t.key, task);
    if (k in IN)
        return IN[k];
    if (preset && preset.input != null)
        return preset.input;
    const def = S.tasks[task];
    return def.input && def.parser && def.parser !== "exit-code" ? t.defaultWave || "" : "";
}

function isoEpic() {
    const ep = S.activeEpic, mine = (x) => !x.epic || x.epic === ep;
    S.allJobs = S.jobs || [];
    S.otherEpicRunning = S.allJobs.filter((j) => !mine(j) && ["running", "queued", "waiting"].includes(j.status)).length;
    S.jobs = S.allJobs.filter(mine);
    S.inbox = (S.inbox || []).filter(mine);
    S.testReqs = (S.testReqs || []).filter(mine);
}
