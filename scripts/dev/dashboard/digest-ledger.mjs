// digest-ledger.mjs — выжимки в деле: контрольная группа (часть сообщений уходит полным текстом), учёт размеров и
// запросов полного лога в digest.jsonl, сводка для страницы.
import fs from "node:fs";
import path from "node:path";
import { jobList } from "./jobs.mjs";
import { DATA, DRY, HERE, logPath, readLog } from "./config.mjs";
import { DIGEST_BUDGET, digestDiff, digestLog, digestReview, estTok, handleLine } from "./digest.mjs";

export const DIGEST_JSONL = path.join(DATA, "digest.jsonl");
const fwd = (p) => String(p).replace(/\\/g, "/");
export const DASH_LOG_CLI = fwd(path.join(HERE, "..", "dash-log.mjs"));

const num = (...v) => {
    for (const x of v) {
        const n = Number(x);
        if (x !== undefined && x !== null && x !== "" && Number.isFinite(n))
            return n;
    }
    return undefined;
};

export function digestConf(settings = {}) {
    const holdout = num(settings.digestHoldout, process.env.DASH_DIGEST_HOLDOUT, 0.1);
    return {
        on: settings.digest !== false && process.env.DASH_DIGEST !== "0",
        budget: num(settings.digestBudget, process.env.DASH_DIGEST_BUDGET, DIGEST_BUDGET),
        reviewBudget: num(settings.digestReviewBudget, 3000), diffBudget: num(settings.digestDiffBudget, 4000),
        holdout: Math.min(1, Math.max(0, holdout)),
    };
}

export function holdoutGroup(seed, share) {
    let h = 0x811c9dc5;
    const s = String(seed);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return ((h >>> 0) % 1000) / 1000 < share ? "control" : "digest";
}

export const logHandle = (id) => (kind, lines) => handleLine({ id, lines, kind, logFile: fwd(logPath(id)), cli: DASH_LOG_CLI });

export function appendLedger(rec) {
    if (DRY)
        return;
    try {
        fs.appendFileSync(DIGEST_JSONL, JSON.stringify({ at: Date.now(), ...rec }) + "\n");
    }
    catch { }
}

export function digestSession({ to, kind, seed, settings, record = true }) {
    const conf = digestConf(settings), group = !conf.on ? "off" : holdoutGroup(to + "|" + kind + "|" + seed, conf.holdout);
    const parts = [], ids = new Set(), useDigest = group === "digest";
    const note = (p, legacy, dig, sent) => {
        parts.push({ ...p, legacy: legacy.length, digest: dig.length, sent: sent.length, tokLegacy: estTok(legacy), tokSent: estTok(sent) });
        return sent;
    };
    return {
        group, conf,
        log(id, legacy, budget = conf.budget) {
            const raw = readLog(id), old = typeof legacy === "function" ? legacy(raw) : String(legacy || ""), d = digestLog(raw, { budget, handle: logHandle(id) });
            ids.add(id);
            return note({ id, part: "log", kind: d.kind, raw: raw.length, fails: d.fails.length }, old, d.text, useDigest ? d.text : old);
        },
        review(id, text, legacy) {
            const old = String(legacy || text || ""), d = digestReview(text, { budget: conf.reviewBudget, handle: logHandle(id)("review", String(readLog(id)).split("\n").length) });
            ids.add(id);
            return note({ id, part: "review", raw: String(text || "").length }, old, d.text, useDigest ? d.text : old);
        },
        diff(patch, legacy, more = "") {
            const old = String(legacy || ""), d = digestDiff(patch, { budget: conf.diffBudget, more });
            return note({ part: "diff", raw: String(patch || "").length }, old, d, useDigest ? d : old);
        },
        close(message = "") {
            if (!record || !parts.length)
                return;
            appendLedger({ type: "sent", to, kind, group, ids: [...ids], chars: String(message).length, tok: estTok(message), parts });
        },
    };
}

const FETCH_RE = /\b(j\d{1,7})\.log\b|dash-log\.mjs["']?\s+(j\d{1,7})\b|\/api\/log\/(j\d{1,7})\b/g;

export function fetchIds(name, input) {
    const i = input || {}, s = name === "Bash" ? i.command : name === "Read" ? i.file_path : name === "Grep" ? i.path : "";
    return [...new Set([...String(s || "").matchAll(FETCH_RE)].map((m) => m[1] || m[2] || m[3]))];
}

export function noteFetch(key, name, input) {
    const ids = fetchIds(name, input);
    if (!ids.length)
        return;
    const i = input || {}, whole = (name === "Read" && !i.offset && !i.limit) || (name === "Bash" && /\b(cat|type)\s/.test(String(i.command || "")) && !/\|\s*(head|tail|grep|sed)/.test(String(i.command || "")));
    appendLedger({ type: "fetch", key, ids, tool: name, whole });
}

let rowsCache = { sig: "", rows: null }, briefCache = { at: 0, v: null };

export function readLedger() {
    let st;
    try {
        st = fs.statSync(DIGEST_JSONL);
    }
    catch {
        return [];
    }
    const sig = st.size + ":" + st.mtimeMs;
    if (rowsCache.sig === sig && rowsCache.rows)
        return rowsCache.rows;
    const rows = [];
    for (const l of fs.readFileSync(DIGEST_JSONL, "utf8").split("\n")) {
        if (!l)
            continue;
        try {
            rows.push(JSON.parse(l));
        }
        catch { }
    }
    rowsCache = { sig, rows };
    return rows;
}

export function summarize(rows, jobs = [], settings = {}) {
    const g = () => ({ messages: 0, parts: 0, raw: 0, legacy: 0, digest: 0, sent: 0, tokLegacy: 0, tokSent: 0, fixed: 0, notFixed: 0, pending: 0 });
    const by = { digest: g(), control: g(), off: g() }, sentIds = new Map(), byId = new Map(jobs.map((j) => [j.id, j]));
    for (const r of rows) {
        if (r.type !== "sent")
            continue;
        const b = by[r.group] || by.off;
        b.messages++;
        for (const p of r.parts || []) {
            b.parts++;
            b.raw += p.raw || 0;
            b.legacy += p.legacy || 0;
            b.digest += p.digest || 0;
            b.sent += p.sent || 0;
            b.tokLegacy += p.tokLegacy || 0;
            b.tokSent += p.tokSent || 0;
            if (p.id && r.group === "digest")
                sentIds.set(r.to + "|" + p.id, r.at);
            const j = p.id && byId.get(p.id);
            if (j && j.status === "fail" && p.part === "log") {
                const next = jobs.find((k) => k.tree === j.tree && k.task === j.task && (k.input || "") === (j.input || "") && (k.queuedAt || 0) > r.at && ["ok", "fail"].includes(k.status));
                if (!next)
                    b.pending++;
                else if (next.status === "ok")
                    b.fixed++;
                else
                    b.notFixed++;
            }
        }
    }
    const fetches = rows.filter((r) => r.type === "fetch"), hit = new Set();
    for (const f of fetches)
        for (const id of f.ids || [])
            if (sentIds.has(f.key + "|" + id) && sentIds.get(f.key + "|" + id) <= f.at)
                hit.add(f.key + "|" + id);
    const d = by.digest, rate = (x) => (x.fixed + x.notFixed ? Math.round((100 * x.fixed) / (x.fixed + x.notFixed)) : null);
    const conf = digestConf(settings);
    return {
        conf, since: rows.length ? rows[0].at : null,
        groups: by,
        saved: { chars: d.legacy - d.sent, tok: d.tokLegacy - d.tokSent, pct: d.legacy ? Math.round((100 * (d.legacy - d.sent)) / d.legacy) : 0, vsRawPct: d.raw ? Math.round((100 * (d.raw - d.sent)) / d.raw) : 0 },
        fetch: { calls: fetches.length, whole: fetches.filter((f) => f.whole).length, digestedFetched: hit.size, digestedParts: sentIds.size, ratePct: sentIds.size ? Math.round((100 * hit.size) / sentIds.size) : 0 },
        outcome: { digestFixedPct: rate(d), controlFixedPct: rate(by.control), note: "доля «следующий такой же прогон — зелёный» после красного в сообщении; сравнима, когда в контрольной группе наберётся хотя бы 20 исходов" },
    };
}

export function digestStats(settings = {}) {
    return summarize(readLedger(), jobList() || [], settings);
}

export function digestBrief(settings = {}) {
    if (briefCache.v && Date.now() - briefCache.at < 30000)
        return briefCache.v;
    const s = digestStats(settings), v = { on: s.conf.on, holdout: s.conf.holdout, messages: s.groups.digest.messages + s.groups.control.messages, savedTok: s.saved.tok, savedPct: s.saved.pct, fetchRatePct: s.fetch.ratePct };
    briefCache = { at: Date.now(), v };
    return v;
}
