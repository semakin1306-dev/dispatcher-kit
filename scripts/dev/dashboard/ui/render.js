// render.js — сборка экрана: перерисовка всех областей, нажатие кнопки (press) с защитой от повторного нажатия, режим
// «дашборд / канбан».
import { BTN_BUSY, CUR_BTN, PENDING, S, setState, VIEW } from "./state.js";
import { $, anchorRestore, anchorSave, applyBusy, ls, toast } from "./core.js";
import { refresh } from "./data.js";
import { attention, renderKanban, renderLines } from "./lines.js";
import { renderTasks } from "./tasks.js";
import { renderRail, renderSide } from "./side.js";
import { mountChats, restoreChats, snapshotChats } from "./chat.js";
import { renderStandFx } from "./dialogs.js";

export function applyView(v) {
    setState("VIEW", v === "kanban" ? "kanban" : "dash");
    ls("dash.view", VIEW);
    document.querySelector("main").classList.toggle("kbmode", VIEW === "kanban");
    document.body.classList.toggle("kbview", VIEW === "kanban");
    document.querySelectorAll("#viewSeg button").forEach((b) => b.classList.toggle("on", b.dataset.view === VIEW));
    try {
        if (S)
            render();
    }
    catch { }
}

export async function press(key, fn, okMsg) {
    if (PENDING.has(key))
        return;
    const bk = CUR_BTN;
    setState("CUR_BTN", null);
    if (bk)
        BTN_BUSY.add(bk);
    PENDING.add(key);
    if (S) {
        render();
        renderTasks();
    }
    ;
    applyBusy();
    try {
        const r = await fn();
        if (okMsg)
            toast(typeof okMsg === "function" ? okMsg(r) : okMsg, true);
        await refresh(true);
    }
    catch (err) {
        toast(err.message);
    }
    finally {
        PENDING.delete(key);
        if (bk)
            BTN_BUSY.delete(bk);
        if (S) {
            render();
            renderTasks();
        }
        ;
        applyBusy();
    }
}

export function render() {
    const anc = anchorSave();
    try {
        renderNow();
    }
    finally {
        anchorRestore(anc);
    }
}

function renderNow() {
    const snap = snapshotChats();
    const ae = document.activeElement, fk = ae && ae.dataset && (ae.dataset.ik || ae.dataset.sel), pos = ae && ae.selectionStart;
    $("att").innerHTML = attention();
    if (VIEW === "kanban")
        renderKanban();
    renderLines();
    if (fk) {
        const el = document.querySelector(`[data-ik="${CSS.escape(fk)}"],[data-sel="${CSS.escape(fk)}"]`);
        if (el) {
            el.focus();
            try {
                el.setSelectionRange(pos, pos);
            }
            catch { }
        }
    }
    mountChats();
    restoreChats(snap);
    renderRail();
    renderSide();
    renderStandFx();
    if (fk && document.activeElement !== ae) {
        const el = document.querySelector(`[data-ik="${CSS.escape(fk)}"]`);
        if (el) {
            el.focus();
            try {
                el.setSelectionRange(pos, pos);
            }
            catch { }
        }
    }
}
