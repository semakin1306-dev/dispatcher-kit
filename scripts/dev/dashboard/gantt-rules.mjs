// gantt-rules.mjs — раскладка Ганта эпика: чистая функция над деревьями слотов и журналом событий → строки, полосы
// «работа» и «ожидание влива», вливы, вопросы человеку, связи и прогноз. Страница только переводит время в координаты и
// рисует.
import { MERGE_LABEL } from "./loops.mjs";

export const STAGING_KEY = "__staging";
export const FORECAST_MIN_TRAIN = 2;
export const FORECAST_MIN_EPIC = 3;
const PAD = 20 * 60e3;
const TAG_RE = /(?:^|[^\wА-Яа-яЁё])([ПТ]\d{1,2})(?!\d)/g;
const WV_RE = /WV-\d{4}/g;

export const median = (xs) => {
    const s = xs.filter((x) => x > 0).sort((a, b) => a - b);
    if (!s.length)
        return 0;
    const k = s.length >> 1;
    return s.length % 2 ? s[k] : Math.round((s[k - 1] + s[k]) / 2);
};

const keyOf = (e) => e.tree || e.key || "";
const needLabels = (need) => (Array.isArray(need) ? need : String(need || "").split(",")).map((x) => String(x).trim()).filter(Boolean).map((id) => MERGE_LABEL[id] || id);

export function mergeShaOf(e, branch) {
    if (!branch || e.type !== "job.end" || e.task !== "merge" || e.status !== "ok")
        return "";
    if (e.mergeSha && e.mergeSha[branch])
        return String(e.mergeSha[branch]);
    const re = new RegExp("merge-коммит\\s+" + branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:-c\\d+)?:\\s*([0-9a-f]{7,40})");
    const m = re.exec(String(e.summary || ""));
    return m ? m[1] : "";
}

export const GANTT_TYPES = new Set(["agent.start", "slot.done", "slot.sync", "train.wagon", "train.issue", "owner.question", "owner.answer",
    "merge.wait", "merge.wait.queue", "merge.wait.red", "merge.wait.resume", "merge.wait.done", "merge.wait.off", "job.end"]);

export function ganttPick(events, { epic, keys, branches }) {
    const ks = new Set(keys), bs = branches.filter(Boolean);
    return events.filter((e) => {
        if (!e || !GANTT_TYPES.has(e.type))
            return false;
        if (e.type === "job.end")
            return e.task === "merge" && e.status === "ok" && bs.some((b) => String(e.summary || "").includes(b) || (e.mergeSha && e.mergeSha[b]));
        return e.epic === epic || ks.has(e.tree || e.key || "");
    });
}

function barsOf(t, evs, now) {
    const mine = evs.filter((e) => keyOf(e) === t.key);
    const merges = evs.map((e) => ({ at: e.at, sha: mergeShaOf(e, t.branch) })).filter((x) => x.sha);
    const starts = mine.filter((e) => e.type === "agent.start").map((e) => e.at);
    const dones = mine.filter((e) => e.type === "slot.done").map((e) => e.at);
    if (!t.train) {
        const start = starts[0] || t.firstCommitAt || 0;
        const landed = t.merge && t.merge.ct && !t.reopened ? { at: t.merge.ct, sha: t.merge.sha } : (merges.find((x) => x.at >= start) || null);
        const doneAt = (start && dones.find((d) => d >= start && (!landed || d <= landed.at))) || 0;
        return [
            {
                wave: (t.wave || "").toUpperCase() || t.tag,
                title: t.title || "",
                ci: -1,
                start,
                doneAt,
                mergedAt: landed ? landed.at : 0,
                mergeSha: landed ? landed.sha : "",
                after: [],
                slot: true,
            },
        ];
    }
    const wv = t.wagonsView || t.wagons || [], issued = new Map();
    for (const e of mine)
        if ((e.type === "train.wagon" || e.type === "train.issue") && e.wave && !issued.has(e.wave))
            issued.set(e.wave, e.at);
    const bars = wv.map((w, i) => {
        const tm = w.times || {};
        return { wave: w.wave, title: w.title || "", ci: i, state: w.state || "", tone: w.tone || "", start: tm.issuedAt || issued.get(w.wave) || tm.firstCommitAt || 0,
            doneAt: tm.doneAt || 0, mergedAt: tm.mergedAt || 0, mergeSha: tm.mergeSha || "", after: w.after || [] };
    });
    const started = bars.filter((b) => b.start).sort((a, b) => a.start - b.start);
    if (started[0] && starts[0] && starts[0] < started[0].start)
        started[0].start = starts[0];
    started.forEach((b, k) => {
        const next = (started[k + 1] && started[k + 1].start) || Infinity;
        if (!b.mergedAt) {
            const m = merges.find((x) => x.at >= b.start && x.at <= next + 6 * 3600e3 && !bars.some((o) => o !== b && o.mergeSha === x.sha));
            if (m && (b.state === "staging" || b.tone === "done" || !b.state)) {
                b.mergedAt = m.at;
                b.mergeSha = m.sha;
            }
        }
        if (!b.doneAt) {
            const d = dones.find((x) => x >= b.start && x < next && (!b.mergedAt || x <= b.mergedAt));
            if (d)
                b.doneAt = d;
        }
    });
    return bars;
}

function mergeWaitsOf(t, evs, now) {
    const out = [];
    let cur = null;
    const close = (at) => {
        if (cur) {
            cur.to = at;
            out.push(cur);
            cur = null;
        }
    };
    for (const e of evs) {
        if (keyOf(e) !== t.key)
            continue;
        if (e.type === "merge.wait") {
            if (!cur)
                cur = { from: e.at, to: 0, need: needLabels(e.need), red: false };
        }
        else if (e.type === "merge.wait.queue" && cur && e.need)
            cur.need = needLabels(e.need);
        else if (e.type === "merge.wait.red" && cur)
            cur.red = true;
        else if (e.type === "merge.wait.resume" && cur)
            cur.red = false;
        else if (["merge.wait.done", "merge.wait.off"].includes(e.type))
            close(e.at);
    }
    const live = t.mergeWait;
    if (cur || live)
        out.push({ from: cur ? cur.from : live.at || now, to: 0, need: live ? (live.need || []) : cur.need, red: live ? live.state === "red" : cur.red, open: true });
    return out;
}

function questionsOf(evs, openAsk) {
    const qs = [];
    for (const e of evs) {
        if (e.type === "owner.question")
            qs.push({ at: e.at, tree: e.tree || "", brief: e.brief || "", n: e.n || 1, answeredAt: 0, via: "" });
        else if (e.type === "owner.answer" || e.type === "owner.message")
            for (const q of qs)
                if (!q.answeredAt && q.tree === e.key && q.at <= e.at) {
                    q.answeredAt = e.at;
                    q.via = e.type === "owner.message" ? "слово" : e.via || "";
                }
    }
    const lastOpen = new Map();
    for (const q of qs)
        if (!q.answeredAt)
            lastOpen.set(q.tree, q);
    for (const q of qs)
        if (!q.answeredAt) {
            q.open = openAsk.has(q.tree) && lastOpen.get(q.tree) === q;
            q.lost = !q.open;
        }
    return qs;
}

export function ganttLayout({ trees = [], events = [], now = Date.now(), openAsk = [] } = {}) {
    const slots = trees.filter((t) => t && t.kind === "slot" && !t.archived);
    if (!slots.length)
        return null;
    const evs = events.filter((e) => e && e.at > 0).sort((a, b) => a.at - b.at);
    const ordered = [...slots.filter((t) => t.train), ...slots.filter((t) => !t.train)];
    const qs = questionsOf(evs, new Set(openAsk));
    const rows = ordered.map((t) => {
        const bars = barsOf(t, evs, now);
        for (const b of bars) {
            b.forecast = false;
            b.questions = [];
            b.waits = [];
            if (b.mergedAt && !b.start) {
                b.start = b.doneAt || b.mergedAt;
                b.noStart = true;
            }
            b.end = b.mergedAt || (b.start ? now : 0);
            b.phase = b.mergedAt ? "done" : !b.start ? "queue" : b.doneAt ? "wait" : "work";
        }
        const syncs = [];
        for (const e of evs)
            if (e.type === "slot.sync" && keyOf(e) === t.key && e.result === "ok")
                syncs.push({ at: e.at, how: /перемот|ff/i.test(String(e.detail || "")) ? "ff" : "merge" });
        if (t.syncMark && t.syncMark.at && !syncs.some((s) => Math.abs(s.at - t.syncMark.at) < 10e3))
            syncs.push({ at: t.syncMark.at, how: t.syncMark.how || "" });
        const risk = Array.isArray(t.staleRisk) ? t.staleRisk : [];
        const stale = t.behind > 0 && risk.length ? { at: now, behind: t.behind, n: risk.length, files: risk.slice(0, 12) } : null;
        for (const w of mergeWaitsOf(t, evs, now)) {
            const b = barAt(bars, w.from) || bars.find((x) => x.phase === "wait" || x.phase === "work");
            if (b)
                b.waits.push({ ...w, to: w.to || b.end || now });
        }
        return {
            key: t.key,
            tag: t.tag || t.key,
            title: t.title || "",
            color: t.color || "#8b929c",
            train: !!t.train,
            branch: t.branch || "",
            deps: t.deps || [],
            bars,
            syncs: syncs.sort((a, b) => a.at - b.at),
            stale,
        };
    });
    const byTag = new Map(rows.map((r) => [String(r.tag), r])), byWave = new Map();
    for (const r of rows)
        for (const b of r.bars)
            byWave.set(b.wave, { r, b });
    const general = [];
    for (const q of qs) {
        const own = rows.find((r) => r.key === q.tree);
        let r = own, b = null;
        if (!r) {
            const wv = (q.brief.match(WV_RE) || []).find((w) => byWave.has(w));
            if (wv) {
                r = byWave.get(wv).r;
                b = byWave.get(wv).b;
            }
        }
        if (!r) {
            TAG_RE.lastIndex = 0;
            let m;
            while ((m = TAG_RE.exec(q.brief))) {
                if (byTag.has(m[1])) {
                    r = byTag.get(m[1]);
                    break;
                }
            }
        }
        if (r && !b)
            b = barAt(r.bars, q.at);
        const item = { at: q.at, answeredAt: q.answeredAt, open: !!q.open, lost: !!q.lost, brief: q.brief, n: q.n, via: q.via, from: own ? "слот" : "оркестратор" };
        if (b)
            b.questions.push(item);
        else
            general.push(item);
    }
    const marks = [];
    for (const r of rows)
        for (const b of r.bars)
            if (b.mergedAt)
                marks.push({ at: b.mergedAt, key: r.key, tag: r.tag, wave: b.wave, ci: b.ci, sha: b.mergeSha, color: r.color });
    const fc = forecastOf(rows, now);
    const links = [];
    const endAt = (b) => b.mergedAt || (b.forecast ? b.end : 0);
    const startAt = (b) => b.doneAt || b.start || 0;
    for (const r of rows)
        for (const b of r.bars) {
            const preds = r.train ? b.after.map((d) => {
                const [wv, tg] = String(d).split("@");
                const pr = tg ? byTag.get(tg) : r;
                const pb = pr && pr.bars.find((x) => x.wave === wv);
                return pb ? { r: pr, b: pb } : null;
            })
                : (r.deps || []).map((d) => {
                    const pr = rows.find((x) => x.key === d.key);
                    return pr && pr.bars[0] ? { r: pr, b: pr.bars[0] } : null;
                });
            for (const p of preds)
                if (p)
                    links.push({ from: { key: p.r.key, wave: p.b.wave, at: endAt(p.b) }, to: { key: r.key, wave: b.wave, at: startAt(b) }, live: !p.b.mergedAt });
        }
    for (const r of rows)
        r.queue = r.bars.filter((b) => b.phase === "queue").map((b) => ({ wave: b.wave, title: b.title, ci: b.ci, after: b.after }));
    const times = rows.flatMap((r) => [...r.bars.flatMap((b) => [b.start, b.end]), ...r.syncs.map((s) => s.at)]).concat(general.map((q) => q.at)).filter((x) => x > 0);
    const from = times.length ? Math.min(...times) - PAD : now - 6 * 3600e3;
    const to = Math.max(now, ...times) + PAD;
    for (const r of rows)
        delete r.deps;
    return {
        now,
        from,
        to,
        rows: [
            {
                key: STAGING_KEY,
                tag: "staging",
                title: "вливы",
                color: "#e0663a",
                staging: true,
                marks: marks.sort((a, b) => a.at - b.at),
                questions: general,
            },
            ...rows,
        ],
        links,
        forecast: fc,
    };
}

function barAt(bars, at) {
    const live = bars.filter((b) => b.start && b.start <= at);
    return live.find((b) => !b.mergedAt || b.mergedAt >= at) || live[live.length - 1] || null;
}

function forecastOf(rows, now) {
    const dur = (b) => (b.start && b.mergedAt ? b.mergedAt - b.start : 0);
    const epicMed = median(rows.flatMap((r) => r.bars.map(dur)));
    const epicN = rows.flatMap((r) => r.bars.map(dur)).filter((x) => x > 0).length;
    const per = new Map();
    for (const r of rows) {
        const own = r.bars.map(dur).filter((x) => x > 0);
        if (own.length >= FORECAST_MIN_TRAIN)
            per.set(r.key, { med: median(own), basis: "поезд", n: own.length });
        else if (epicN >= FORECAST_MIN_EPIC)
            per.set(r.key, { med: epicMed, basis: "эпик", n: epicN });
    }
    if (!per.size)
        return {
            ok: false,
            note:
                "прогноза нет: влитых волн в эпике " +
                epicN +
                " (нужно от " +
                FORECAST_MIN_EPIC +
                ", у поезда — от " +
                FORECAST_MIN_TRAIN +
                " своих) — очередь показана порядком, без времени",
        };
    const byTag = new Map(rows.map((r) => [String(r.tag), r]));
    const predEnd = (r, b) => Math.max(0, ...b.after.map((d) => {
        const [wv, tg] = String(d).split("@");
        const pr = tg ? byTag.get(tg) : r;
        const pb = pr && pr.bars.find((x) => x.wave === wv);
        return pb ? pb.mergedAt || pb.fEnd || 0 : 0;
    }));
    for (const r of rows) {
        const p = per.get(r.key);
        for (const b of r.bars)
            if (b.start && !b.mergedAt)
                b.fEnd = Math.max(now, b.start + (p ? p.med : 0));
    }
    for (let pass = 0; pass < 12; pass++) {
        let changed = false;
        for (const r of rows) {
            const p = per.get(r.key);
            if (!p)
                continue;
            let cur = Math.max(now, ...r.bars.filter((b) => b.start && !b.mergedAt).map((b) => b.fEnd || now));
            for (const b of r.bars) {
                if (b.start || b.mergedAt)
                    continue;
                const s = Math.max(cur, predEnd(r, b)), e = s + p.med;
                if (b.fStart !== s || b.fEnd !== e) {
                    b.fStart = s;
                    b.fEnd = e;
                    changed = true;
                }
                cur = e;
            }
        }
        if (!changed)
            break;
    }
    for (const r of rows)
        for (const b of r.bars) {
            if (b.fStart && !b.start) {
                b.forecast = true;
                b.phase = "forecast";
                b.start = b.fStart;
                b.end = b.fEnd;
            }
            delete b.fStart;
            delete b.fEnd;
        }
    const used = [...per.values()];
    return {
        ok: true,
        basis: [...new Set(used.map((p) => p.basis))].join(", "),
        medianMs: median(used.map((p) => p.med)),
        note:
            "прогноз по медиане «выдача → влив»: " +
            used
                .map((p) => p.basis)
                .filter((x, i, a) => a.indexOf(x) === i)
                .join(" / ") +
            ", волн " +
            Math.max(...used.map((p) => p.n)),
    };
}
