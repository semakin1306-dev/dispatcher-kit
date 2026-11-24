// slot-done.mjs — отметка «агент слота доложил ГОТОВО на этом коде»: агент может коммитить сам после каждой станции,
// поэтому коммит больше не значит «волна закончена». Ворота заморозки и поезда спрашивают waveFinalOf. Владелец поля
// S.slotDone — этот модуль.
import path from "node:path";
import { S } from "./state.mjs";
import { DATA, DRY, logEvent, settings } from "./config.mjs";
import { readJson, saveJson } from "./store.mjs";
import { jobList } from "./jobs.mjs";
import { selfCommitMode, waveFinal } from "./commit-rules.mjs";

export const SLOT_DONE_FILE = path.join(DATA, "slot-done.json");

export function loadSlotDone() {
    const v = readJson(SLOT_DONE_FILE, null);
    S.slotDone = v && typeof v === "object" && v.slots ? v : { since: Date.now(), slots: {} };
    if (!v && !DRY)
        saveJson(SLOT_DONE_FILE, S.slotDone);
}

const rec = () => S.slotDone || (S.slotDone = { since: 0, slots: {} });
export const slotDoneOf = (key) => rec().slots[key] || null;

export function markSlotDone(key, fp) {
    if (!key || !fp)
        return;
    const r = rec(), prev = r.slots[key];
    if (prev && prev.fp === fp)
        return;
    r.slots[key] = { fp, at: Date.now() };
    if (!DRY)
        saveJson(SLOT_DONE_FILE, r);
    logEvent("slot.done", { tree: key, fp });
}

export function waveFinalOf(t) {
    if (!t)
        return false;
    const fp = t.fp || "", r = rec();
    const commitOk = !!fp && (jobList() || []).some((j) => j.tree === t.key && j.task === "commit" && j.status === "ok" && j.fpStart === fp);
    const legacy = !!(r.since && t.last && t.last.ct && t.last.ct < r.since);
    return waveFinal({ mode: selfCommitMode(settings), fp, done: r.slots[t.key], commitOk, legacy });
}
