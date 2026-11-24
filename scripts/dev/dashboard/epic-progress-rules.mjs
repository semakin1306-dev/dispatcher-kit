// epic-progress-rules.mjs — панель «Ход эпика»: чистые функции над журналом событий, прогонами и реестром эпика —
// сколько волн готово и не влито и сколько ждут, простои без работы, ходы агентов без действия, причины задержек.
import { PROJECT } from "../slots.mjs";

export const DAY_MS = 24 * 3600e3;
export const IDLE_GAP_MS = 15 * 60e3;
export const READY_ALARM_MS = 30 * 60e3;

const ACT_RES = [
    /```\s*slot:\s*\S+/i,
    /^[\s>*_`-]*(ВЛИТЬ|КОММИТ)\s+[ПТ]\d+/im,
    /^[\s>*_-]*ПРОГНАТЬ\s+[ПТ]\d+\s*:/im,
    /^[\s>*_`-]*ПОРЯДОК\s+[ПТ]\d+/im,
    /^[\s>*_`-]*ПРИНЯТЬ\s+РЕВЬЮ\s+[ПТ]\d+/im,
    /^[\s>*_`-]*ОТМЕНИТЬ\s+ВЛИТЬ\s+[ПТ]\d+/im,
    /Вопросы\s+владельцу\s*:/i,
];

export const turnAct = (text) => ACT_RES.some((re) => re.test(String(text || "")));

const isOrchKey = (k) => typeof k === "string" && k.startsWith("orchestrator@");
const tagRe = (tag) => new RegExp("^" + String(tag).replace(/[^\wА-Яа-яЁё]/g, "") + "$", "i");
export const normReason = (s) => String(s || "").replace(/\s*\([^)]*\)/g, "").replace(/\bj\d+\b/g, "j").replace(/\b[0-9a-f]{7,40}\b/g, "#").replace(/\d+/g, "N").replace(/\s+/g, " ").trim().slice(0, 160);

const mergedBranches = (r) => {
    const out = new Set(Object.keys(r.mergeSha || {}));
    const m = /Влить\s+(\S+)\s+в\s+staging/i.exec(String(r.label || ""));
    if (m)
        out.add(m[1]);
    return out;
};

const isTrainSlot = (x) => Array.isArray(x.wagons) && x.wagons.length > 0;
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const epicTreeKeys = (epic) => new Set((epic.slots || []).flatMap((x) => (isTrainSlot(x) ? [x.slot, x.slot + "-c"] : [x.slot])));

export function branchOfSlot(x, b) {
    if (!x || !b)
        return false;
    if (x.branch && b === x.branch)
        return true;
    return isTrainSlot(x) && [x.branch, "dev/" + x.slot].filter(Boolean).some((p) => new RegExp("^" + escRe(p) + "-c\\d+$").test(b));
}

export const STAND_TREE = /^orchestrator-(staging|main)$/;
export const GATE_NOT_BLOCK = /зел[её]н|проверять дальше будет поезд/i;
export const FRESH_CAUSE_MS = 30 * 60e3;
const clip = (a, b, from, to) => Math.max(0, Math.min(b, to) - Math.max(a, from));

export function unionSpans(spans) {
    const s = spans.filter((x) => x[1] >= x[0]).sort((x, y) => x[0] - y[0]), out = [];
    for (const x of s) {
        const l = out[out.length - 1];
        if (l && x[0] <= l[1])
            l[1] = Math.max(l[1], x[1]);
        else
            out.push([x[0], x[1]]);
    }
    return out;
}

export function holdReason({ slot, tag, orch }, events, readyAt) {
    const re = tagRe(tag);
    let last = null;
    for (const e of events) {
        if (e.at < readyAt)
            continue;
        if (e.type === "deadlock" && (e.tree === slot || (e.orch === orch && re.test(String(e.what || "").split(/\s+/).pop()))))
            last = { at: e.at, kind: "тупик", text: e.why || "" };
        else if (e.type === "orch.command" && e.tree === orch && /^ВЛИТЬ/.test(e.cmd || "") && re.test(e.target || ""))
            last = e.ok ? { at: e.at, kind: "влив в очереди", text: e.detail || "" } : { at: e.at, kind: reasonKind(e.detail), text: e.detail || "" };
        else if (e.type === "gate.blocked" && e.tree === slot)
            last = { at: e.at, kind: "ворота", text: (e.task ? e.task + ": " : "") + (e.why || "") };
    }
    return last || { at: readyAt, kind: "нет команды ВЛИТЬ", text: "оркестратор не просил влить" };
}

export function reasonKind(detail) {
    const d = String(detail || "");
    if (/слов[оа]\s+владельца|«влей»|без слова/i.test(d))
        return "слово владельца";
    if (/порядок|раньше|после\s+П\d|зависит/i.test(d))
        return "порядок";
    if (/регресс|гард|security|не\s+зел[её]н|красн|ревью|тест/i.test(d))
        return "красное";
    if (/конфликт/i.test(d))
        return "конфликт";
    if (/перезапуск/i.test(d))
        return "перезапуск";
    return "отказ";
}

export function waveTimeline(epic, events, runs) {
    const out = [];
    for (const x of epic.slots || []) {
        const marks = [];
        for (const r of runs) {
            if (r.status !== "ok")
                continue;
            const at = r.endedAt || r.startedAt || r.queuedAt;
            if (!at)
                continue;
            if (r.task === "commit" && r.tree === x.slot)
                marks.push({ at, k: "c" });
            else if (r.task === "merge" && [...mergedBranches(r)].some((b) => branchOfSlot(x, b)))
                marks.push({ at, k: "m" });
        }
        let firstAct = Infinity, lastAct = 0;
        for (const e of events) {
            if (e.type === "stage.mark" && e.tree === x.slot && e.stage === "commit" && e.value === true)
                marks.push({ at: e.at, k: "c" });
            if ((e.type === "slot.provision" && e.key === x.slot) || (e.type === "agent.start" && e.key === x.slot))
                firstAct = Math.min(firstAct, e.at);
            if ((e.key === x.slot || e.tree === x.slot || e.from === x.slot) && WORK_EV.has(e.type))
                lastAct = Math.max(lastAct, e.at);
        }
        for (const r of runs)
            if (r.tree === x.slot || (isTrainSlot(x) && r.tree === x.slot + "-c")) {
                const a = r.startedAt || r.queuedAt;
                if (a) {
                    firstAct = Math.min(firstAct, a);
                    lastAct = Math.max(lastAct, r.endedAt || a);
                }
            }
        marks.sort((a, b) => a.at - b.at);
        const spans = [], merges = [];
        let readyAt = null;
        for (const mk of marks) {
            if (mk.k === "c")
                readyAt = mk.at;
            else if (mk.k === "m") {
                merges.push(mk.at);
                if (readyAt !== null) {
                    spans.push({ readyAt, mergedAt: mk.at });
                    readyAt = null;
                }
            }
        }
        if (readyAt !== null)
            spans.push({ readyAt, mergedAt: null });
        const lastMerge = merges.length ? merges[merges.length - 1] : 0;
        const archivedAt = x.archived ? Date.parse(x.archived) || null : null;
        let openTo = Infinity;
        if (lastMerge && readyAt === null && lastAct <= lastMerge + 60e3)
            openTo = lastMerge;
        if (archivedAt)
            openTo = Math.min(openTo, lastMerge && lastMerge <= archivedAt ? lastMerge : archivedAt);
        const openFrom = Math.min(firstAct, marks.length ? marks[0].at : Infinity);
        out.push({ slot: x.slot, tag: x.tag, title: x.title || "", branch: x.branch || "", spans, merges, openFrom: Number.isFinite(openFrom) ? openFrom : null, openTo });
    }
    return out;
}

export const WORK_EV = new Set(["relay.sent", "slot.decision", "agent.asks", "orch.command", "results.sent", "review.verdict", "stage.mark", "owner.message", "owner.answer"]);

export function workPoints(keys, orch, events) {
    const pts = [];
    for (const e of events) {
        if (e.type === "agent.turn") {
            if (keys.has(e.key) && (e.key !== orch || e.act !== false))
                pts.push(e.at);
            continue;
        }
        if (!WORK_EV.has(e.type))
            continue;
        if (keys.has(e.key) || keys.has(e.tree) || keys.has(e.from) || keys.has(e.to))
            pts.push(e.at);
    }
    return pts;
}

export function idleSpans({ open, work, from, to, gapMs = IDLE_GAP_MS, explain = () => "" }) {
    const busy = unionSpans(work.map((w) => Array.isArray(w) ? w : [w, w]));
    const out = [];
    for (const [oa, ob] of unionSpans(open)) {
        const a0 = Math.max(oa, from), b0 = Math.min(ob, to);
        if (b0 <= a0)
            continue;
        let cur = a0;
        const flush = (end) => {
            if (end - cur >= gapMs)
                out.push({ from: cur, to: end, min: Math.round((end - cur) / 60000), why: explain(cur, end) });
        };
        for (const [ba, bb] of busy) {
            if (bb < cur)
                continue;
            if (ba > b0)
                break;
            flush(Math.min(ba, b0));
            cur = Math.max(cur, bb);
        }
        if (cur < b0)
            flush(b0);
    }
    return out;
}

const LOST = new Set(["interrupted", "cancelled"]);
const runMin = (r) => (r.startedAt && r.endedAt && r.endedAt > r.startedAt ? (r.endedAt - r.startedAt) / 60000 : 0);

export function wavePresetKeys(epic) {
    const m = new Map();
    for (const x of epic.slots || []) {
        const s = new Set(), add = (l) => {
            for (const p of l || [])
                s.add(p.task + "|" + (p.input || ""));
        };
        add(x.presets);
        for (const w of x.wagons || [])
            add(w.presets);
        m.set(x.slot, s);
    }
    return m;
}

/**
 * Прогон регресса: тестовая задача (станция «Тесты» конфига), которой нет среди тестов волны этого дерева — проверка соседей,
 * а не своей волны. tests — id тестовых задач проекта.
 */
export const isRegressRun = (r, presetKeys, tests = PROJECT.stations.tests) => tests.includes(r.task) && !((presetKeys.get(r.tree) || new Set()).has(r.task + "|" + (r.input || "")));

export const QUESTION_TURN_MS = 60e3;
const CLOSES_Q = new Set(["owner.answer", "owner.message"]);

export function questionWaits(keys, events, upTo = Infinity) {
    const open = new Map(), out = [];
    const close = (k, at) => {
        const q = open.get(k);
        if (q == null || at < q)
            return;
        out.push({ key: k, from: q, to: at });
        open.delete(k);
    };
    for (const e of [...events].sort((a, b) => a.at - b.at)) {
        if (e.at > upTo)
            break;
        if (e.type === "owner.question" && keys.has(e.tree)) {
            if (!open.has(e.tree))
                open.set(e.tree, e.at);
            continue;
        }
        if (CLOSES_Q.has(e.type) && keys.has(e.key))
            close(e.key, e.at);
        else if (e.type === "auto.owner" && keys.has(e.tree))
            close(e.tree, e.at);
        else if (e.type === "agent.turn" && keys.has(e.key) && !isOrchKey(e.key) && open.has(e.key) && e.at - open.get(e.key) >= QUESTION_TURN_MS)
            close(e.key, e.at);
    }
    for (const [k, q] of open)
        out.push({ key: k, from: q, to: null });
    return out.sort((a, b) => a.from - b.from);
}

export function sameCodeRepeats(runs) {
    const by = new Map();
    for (const r of runs) {
        if (LOST.has(r.status) || !r.fpStart || ["commit", "merge"].includes(r.task))
            continue;
        const k = r.tree + "|" + r.task + "|" + (r.input || "") + "|" + r.fpStart;
        (by.get(k) || by.set(k, []).get(k)).push(r);
    }
    return [...by.values()].filter((l) => l.length > 1).map((l) => {
        l.sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0));
        return { tree: l[0].tree, task: l[0].task, input: l[0].input || "", fp: l[0].fpStart, n: l.length, extra: l.slice(1) };
    });
}

export function epicCounters({ epic, events, runs, from, to }) {
    const slotKeys = epicTreeKeys(epic), pk = wavePresetKeys(epic);
    const mine = runs.filter((r) => (slotKeys.has(r.tree) || (r.epic === epic.id && !STAND_TREE.test(r.tree || ""))) && (r.queuedAt || r.startedAt || 0) >= from && (r.queuedAt || r.startedAt || 0) <= to);
    const fin = mine.filter((r) => ["ok", "fail", "skipped", "interrupted", "cancelled"].includes(r.status));
    const sum = (rs) => Math.round(rs.reduce((s, r) => s + runMin(r), 0));
    const reg = fin.filter((r) => isRegressRun(r, pk)), regDone = reg.filter((r) => !LOST.has(r.status)), regLost = reg.filter((r) => LOST.has(r.status));
    const rev = fin.filter((r) => r.task === "review" && !LOST.has(r.status)), sec = fin.filter((r) => PROJECT.stations.guards.includes(r.task));
    const hours = new Map();
    for (const e of events)
        if (e.type === "agent.turn" && slotKeys.has(e.key) && e.at >= from && e.at <= to) {
            const h = Math.floor(e.at / 3600e3);
            (hours.get(h) || hours.set(h, new Set()).get(h)).add(e.key);
        }
    const per = [...hours.values()].map((s) => s.size).sort((a, b) => a - b);
    const rep = sameCodeRepeats(fin), repRuns = rep.flatMap((g) => g.extra), lost = fin.filter((r) => LOST.has(r.status));
    const qKeys = new Set([...slotKeys, "orchestrator@" + epic.id]), waits = questionWaits(qKeys, events, to);
    const qIn = waits.filter((w) => w.from <= to && (w.to === null || w.to >= from));
    return {
        runs: fin.length, runMin: sum(fin),
        repeats: { runs: repRuns.length, min: sum(repRuns), top: rep.sort((a, b) => b.n - a.n).slice(0, 5).map((g) => ({ tree: g.tree, task: g.task, input: g.input.slice(0, 80), n: g.n, ids: g.extra.map((r) => r.id) })) },
        lost: { runs: lost.length, min: sum(lost) },
        questions: { n: events.filter((e) => e.type === "owner.question" && qKeys.has(e.tree) && e.at >= from && e.at <= to).length, waits: waits.filter((w) => w.from >= from && w.from <= to).length, waitMin: Math.round(qIn.reduce((s, w) => s + clip(w.from, w.to === null ? to : w.to, from, to), 0) / 60000), open: qIn.filter((w) => w.to === null).length,
            longest: qIn.map((w) => ({ key: w.key, from: w.from, min: Math.round(((w.to === null ? to : w.to) - w.from) / 60000) })).sort((a, b) => b.min - a.min).slice(0, 5) },
        regress: { runs: reg.length, min: sum(reg), done: regDone.length, doneMin: sum(regDone), lost: regLost.length, lostMin: sum(regLost) },
        review: { runs: rev.length, questions: rev.filter((r) => r.status === "fail" || (r.review && r.review.verdict && r.review.verdict !== "ЗА")).length },
        // прогоны гардов (задачи станции «Гарды» конфига); имя поля прежнее — его читают страница и ретро
        security: { runs: sec.length, min: sum(sec) },
        agents: { peak: per.length ? per[per.length - 1] : 0, p50: per.length ? per[Math.floor((per.length - 1) / 2)] : 0, hours: per.length },
    };
}

export function epicProgress({ epic, events, runs, now = Date.now(), windowMs = DAY_MS, gapMs = IDLE_GAP_MS, live = {} }) {
    const from = now - windowMs, to = now, orch = "orchestrator@" + epic.id;
    const evs = events.filter((e) => e && e.at && e.at <= now).sort((a, b) => a.at - b.at);
    runs = runs.filter((r) => (r.queuedAt || r.startedAt || 0) <= now).map((r) => r.endedAt > now ? { ...r, endedAt: undefined, status: "running" } : r);
    const slotKeys = epicTreeKeys(epic), keys = new Set([...slotKeys, orch]);
    const myRuns = runs.filter((r) => r.epic === epic.id || slotKeys.has(r.tree) || (r.task === "merge" && [...mergedBranches(r)].some((b) => (epic.slots || []).some((x) => branchOfSlot(x, b)))));
    const inWin = (at) => at >= from && at <= to;
    const tl = waveTimeline(epic, evs, myRuns);
    const ready = [];
    let readyMs = 0;
    for (const w of tl)
        for (const s of w.spans) {
            const end = s.mergedAt || to;
            const ms = clip(s.readyAt, end, from, to);
            if (!ms && !(s.mergedAt === null))
                continue;
            readyMs += ms;
            const row = { tag: w.tag, slot: w.slot, title: w.title, readyAt: s.readyAt, mergedAt: s.mergedAt, waitMin: Math.round((end - s.readyAt) / 60000) };
            if (s.mergedAt === null) {
                row.hold = holdReason({ slot: w.slot, tag: w.tag, orch }, evs, s.readyAt);
                row.alarm = end - s.readyAt > READY_ALARM_MS;
            }
            ready.push(row);
        }
    ready.sort((a, b) => (a.mergedAt === null) - (b.mergedAt === null) || b.waitMin - a.waitMin);
    const releases = runs.filter((r) => r.task === "release" && r.status === "ok" && r.endedAt).map((r) => r.endedAt).sort((a, b) => a - b);
    for (const w of tl) {
        const lastM = w.merges[w.merges.length - 1], pending = w.spans.some((s) => s.mergedAt === null);
        if (!lastM || pending)
            continue;
        const rel = releases.find((t) => t > lastM);
        if (rel)
            w.openTo = Math.min(w.openTo, rel);
    }
    const open = tl.filter((w) => w.openFrom !== null).map((w) => [w.openFrom, w.openTo]);
    const firstMerge = Math.min(...tl.flatMap((w) => w.merges), Infinity);
    const standRuns = runs.filter((r) => STAND_TREE.test(r.tree || "") && r.startedAt && r.startedAt >= firstMerge && !myRuns.includes(r));
    const runSpan = (r) => [r.startedAt, r.endedAt || (["running"].includes(r.status) ? to : r.startedAt)];
    const work = [...myRuns.filter((r) => r.startedAt).map(runSpan), ...standRuns.map(runSpan), ...workPoints(keys, orch, evs)];
    const waitingAt = (t) => tl.flatMap((w) => w.spans.filter((s) => s.readyAt <= t && (s.mergedAt === null || s.mergedAt > t)).map(() => w.tag));
    const qWaits = questionWaits(keys, evs, to), tagOf = (k) => (k === orch ? "ОРК" : ((epic.slots || []).find((x) => x.slot === k || x.slot + "-c" === k) || {}).tag || k);
    const explain = (a, b) => {
        const parts = [];
        const q = [...new Set(qWaits.filter((w) => w.from < b && (w.to === null || w.to > a)).map((w) => tagOf(w.key)))];
        if (q.length)
            parts.push("ждём ответа владельца: " + q.join(", "));
        const wt = waitingAt(a);
        if (wt.length)
            parts.push("готово, не влито: " + wt.join(", "));
        const isCmdFail = (e) => e.type === "orch.command" && e.tree === orch && !e.ok;
        const word = [...evs].reverse().find((e) => e.at <= a && a - e.at <= 6 * 3600e3 && isCmdFail(e) && reasonKind(e.detail) === "слово владельца");
        if (word)
            parts.push("ждём слова владельца: " + word.cmd + " " + (word.target || ""));
        const before = [...evs].reverse().find((e) => e.at <= a && a - e.at <= FRESH_CAUSE_MS && ((isCmdFail(e) && reasonKind(e.detail) !== "слово владельца") || (e.type === "gate.blocked" && slotKeys.has(e.tree) && !GATE_NOT_BLOCK.test(e.why || "")) || (e.type === "deadlock" && (e.orch === orch || slotKeys.has(e.tree)))));
        if (before)
            parts.push(before.type === "orch.command" ? "отказ " + before.cmd + " " + (before.target || "") + ": " + reasonKind(before.detail) : before.type === "gate.blocked" ? "ворота: " + (before.task || "") : "тупик");
        const starts = evs.filter((e) => e.type === "server.start" && e.at >= a && e.at <= b), down = starts.find((e) => e.prev && e.prev.silentS >= 120);
        if (down)
            parts.push("диспетчерская стояла " + Math.round(down.prev.silentS / 60) + " мин" + (down.stop && /^pc-/.test(down.stop.kind || "") ? " (" + (down.stop.kind === "pc-off" ? "ПК выключен" : "сбой ПК") + ")" : ""));
        else if (starts.length)
            parts.push("перезапуск диспетчерской");
        return parts.join(" · ") || "нет хода";
    };
    const idle = idleSpans({ open, work, from, to, gapMs, explain });
    const openMs = unionSpans(open).reduce((s, [a, b]) => s + clip(a, b, from, to), 0);
    const idleMin = idle.reduce((s, x) => s + x.min, 0);
    const cmds = evs.filter((e) => e.type === "orch.command" && e.tree === orch && inWin(e.at));
    const byCmd = {}, reasons = new Map();
    for (const c of cmds) {
        const k = String(c.cmd || "?").replace(/\s+ПРИНУДИТЕЛЬНО$/, ""), b = byCmd[k] || (byCmd[k] = { n: 0, fail: 0, partial: 0 });
        b.n++;
        if (!c.ok) {
            b.fail++;
            const r = k + ": " + normReason(c.detail);
            reasons.set(r, (reasons.get(r) || 0) + 1);
        }
        else if (/не понял/i.test(c.detail || ""))
            b.partial++;
    }
    const commands = { total: cmds.length, failed: cmds.filter((c) => !c.ok).length, byCmd,
        topReasons: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([why, n]) => ({ why, n })),
        deadlocks: evs.filter((e) => e.type === "deadlock" && inWin(e.at) && (e.orch === orch || slotKeys.has(e.tree))).length,
        gateBlocked: evs.filter((e) => e.type === "gate.blocked" && inWin(e.at) && slotKeys.has(e.tree) && !GATE_NOT_BLOCK.test(e.why || "")).length,
        gateSaved: evs.filter((e) => e.type === "gate.blocked" && inWin(e.at) && slotKeys.has(e.tree) && GATE_NOT_BLOCK.test(e.why || "")).length };
    const starts = evs.filter((e) => e.type === "server.start" && inWin(e.at) && !e.dry).map((e) => ({ at: e.at, sha: e.sha || "", reason: e.reason || "", silentS: (e.prev && e.prev.silentS) || null }));
    const restarts = { starts, interrupted: myRuns.filter((r) => r.bootInterrupted && inWin(r.endedAt || r.queuedAt || 0)).length,
        cutCommands: cmds.filter((c) => /прервано перезапуском/i.test(c.detail || "")).length };
    const turns = evs.filter((e) => e.type === "agent.turn" && inWin(e.at) && keys.has(e.key));
    const orchTurns = turns.filter((t) => t.key === orch), empty = orchTurns.filter((t) => t.act === false);
    const owner = {
        messages: evs.filter((e) => e.type === "owner.message" && inWin(e.at) && keys.has(e.key)).length,
        answers: evs.filter((e) => e.type === "owner.answer" && inWin(e.at) && keys.has(e.key)).length,
        questions: live.questions != null ? live.questions : null,
        nudges: evs.filter((e) => e.type === "idle.nudge" && inWin(e.at) && e.key === orch).length,
        orchTurns: orchTurns.length, emptyTurns: empty.length,
        emptyTok: empty.reduce((s, t) => s + (t.in || 0) + (t.cr || 0) + (t.cw || 0) + (t.out || 0), 0),
    };
    const tok = new Map();
    for (const t of turns) {
        const r = tok.get(t.key) || { key: t.key, tag: t.key === orch ? "ОРК" : ((epic.slots || []).find((x) => x.slot === t.key) || {}).tag || t.key, turns: 0, in: 0, out: 0, cr: 0, cw: 0, cost: 0 };
        r.turns++;
        r.in += t.in || 0;
        r.out += t.out || 0;
        r.cr += t.cr || 0;
        r.cw += t.cw || 0;
        r.cost += t.cost || 0;
        tok.set(t.key, r);
    }
    const tokens = [...tok.values()].map((r) => ({ ...r, cost: Math.round(r.cost * 100) / 100 })).sort((a, b) => (b.in + b.cr + b.cw + b.out) - (a.in + a.cr + a.cw + a.out));
    return {
        epic: epic.id, from, to, windowH: Math.round(windowMs / 3600e3),
        ready, readyWaveH: Math.round(readyMs / 3600e3 * 10) / 10, readyNow: ready.filter((r) => r.mergedAt === null).length,
        idle: { min: idleMin, openMin: Math.round(openMs / 60000), share: openMs ? Math.round(idleMin * 60000 / openMs * 100) : 0, spans: idle.slice(-12) },
        commands, restarts, owner, tokens,
        counters: epicCounters({ epic, events: evs, runs, from, to }),
        turnsTracked: turns.length > 0,
    };
}
