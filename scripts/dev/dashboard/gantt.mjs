// gantt.mjs — выборка журнала событий для Ганта эпика: журнал читается в фоне не чаще раза в минуту на эпик, в памяти
// держатся только нужные раскладке события. Владелец поля S.ganttEvents.
import { S } from "./state.mjs";
import { EVENTS_JSONL } from "./config.mjs";
import { JOURNAL_BYTES, readEventsSince } from "./epic-progress.mjs";
import { bumpVer } from "./events.mjs";
import { ganttPick } from "./gantt-rules.mjs";

export const GANTT_EVENTS_MS = 60e3;
export const GANTT_DAYS = 30;

export function ganttEventsOf(epic, trees, { now = Date.now(), file = EVENTS_JSONL } = {}) {
    if (!epic)
        return [];
    if (!S.ganttEvents)
        S.ganttEvents = {};
    const c = S.ganttEvents[epic];
    if ((!c || now - c.at > GANTT_EVENTS_MS) && !(c && c.loading)) {
        const old = (c && c.events) || [];
        S.ganttEvents[epic] = { at: (c && c.at) || 0, events: old, loading: true };
        const keys = [...trees.map((t) => t.key), "orchestrator@" + epic], branches = trees.map((t) => t.branch);
        readEventsSince(file, now - GANTT_DAYS * 86400e3, JOURNAL_BYTES)
            .then((evs) => {
            const picked = ganttPick(evs, { epic, keys, branches });
            S.ganttEvents[epic] = { at: Date.now(), events: picked };
            if (picked.length !== old.length)
                bumpVer("gantt");
        })
            .catch(() => {
            S.ganttEvents[epic] = { at: Date.now(), events: old };
        });
    }
    return c ? c.events : [];
}
