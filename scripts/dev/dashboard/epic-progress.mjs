// epic-progress.mjs — чтение для панели «Ход эпика» и журнала эпика: хвост журнала событий, прогоны и реестр → сводка
// (epic-progress-rules.mjs). Только по запросу страницы и с кешем.
import fs from "node:fs";
import { EVENTS_JSONL } from "./config.mjs";
import { jobList } from "./jobs.mjs";
import { epicById, epicsReg } from "./trees.mjs";
import { journalCounts, journalLine, journalOf } from "./epic-journal.mjs";
import { inboxCards } from "./inbox.mjs";
import { epicProgress, DAY_MS } from "./epic-progress-rules.mjs";

export const TAIL_BYTES = 12e6;
const cache = new Map();

export async function readEventsSince(file, since, bytes = TAIL_BYTES) {
    let fh;
    try {
        fh = await fs.promises.open(file, "r");
        const { size } = await fh.stat(), n = Math.min(size, bytes), b = Buffer.alloc(n);
        await fh.read(b, 0, n, size - n);
        const out = [];
        for (const l of b.toString("utf8").split("\n")) {
            if (!l || l[0] !== "{")
                continue;
            try {
                const e = JSON.parse(l);
                if (e.at >= since)
                    out.push(e);
            }
            catch { }
        }
        return out;
    }
    catch {
        return [];
    }
    finally {
        if (fh)
            await fh.close().catch(() => { });
    }
}

export async function epicProgressOp(id, hours = 24, { now = Date.now(), file = EVENTS_JSONL } = {}) {
    const epic = epicById(String(id || ""));
    if (!epic)
        return { code: 404, body: { error: "нет такого эпика" } };
    const h = Math.min(Math.max(Number(hours) || 24, 1), 96), k = epic.id + "|" + h, hit = cache.get(k);
    if (hit && now - hit.at < 30e3)
        return { code: 200, body: hit.body };
    const events = await readEventsSince(file, now - Math.max(h * 3600e3, 4 * DAY_MS));
    const keys = new Set([...epic.slots.map((x) => x.slot), "orchestrator@" + epic.id]);
    const questions = inboxCards().filter((c) => c.kind === "ownerq" && keys.has(c.tree)).length;
    const body = epicProgress({ epic, events, runs: jobList(), now, windowMs: h * 3600e3, live: { questions } });
    cache.set(k, { at: now, body });
    return { code: 200, body };
}

export const JOURNAL_BYTES = 64e6;
export const epicAny = (id) => epicById(id) || (epicsReg().epics || []).find((e) => e.id === id) || null;

export async function epicJournalOp(id, { from = 0, to = Infinity, types = "", limit = 2000, format = "json" } = {}, { file = EVENTS_JSONL } = {}) {
    const epic = epicAny(String(id || ""));
    if (!epic)
        return { code: 404, body: { error: "нет такого эпика" } };
    const events = await readEventsSince(file, Number(from) || 0, JOURNAL_BYTES);
    const evs = journalOf(events, { epic: epic.id, keys: (epic.slots || []).map((x) => x.slot), from: Number(from) || 0, to: Number(to) || Infinity, types: types ? String(types).split(",").filter(Boolean) : null, limit: Math.min(Math.max(Number(limit) || 2000, 1), 20000) });
    if (format === "text")
        return { code: 200, body: { epic: epic.id, n: evs.length, text: evs.map(journalLine).join("\n") } };
    return { code: 200, body: { epic: epic.id, n: evs.length, counts: journalCounts(evs), events: evs } };
}
