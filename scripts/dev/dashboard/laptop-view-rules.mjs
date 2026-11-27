// laptop-view-rules.mjs — чистая выборка для экрана прогонов на удалённой машине (laptop-view.mjs): что машина делает сейчас,
// её доля в полном прогоне по частям, очередь прогонов диспетчерской, загрузка и последние прогоны на ней.
// На вход — готовые данные: записи прогонов (jobList: runOn, status, label, tree, input, startedAt, endedAt, tailLines, summary)
// и shardApi().pub() (machines — загрузка и здоровье, run — полный прогон, full-run-rules.mjs runView). Ничего не пишет
// и никого не зовёт: экран только смотрит. Вывод — тот же, что ждёт laptop-view.html.
import { FINAL } from "./config.mjs";
import { strain } from "./slot-places.mjs";

export const RECENT_N = 8;
const DAY_MS = 24 * 3600e3;
const sec = (ms) => (Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : null);
const r1 = (x) => Math.round(x * 10) / 10;

// подпись без хвоста « · <машина>» (раннер дописывает машину к label при выдаче места)
export function cleanLabel(s, labels = []) {
    const t = String(s || "");
    for (const l of labels)
        if (l && t.endsWith(" · " + l))
            return t.slice(0, -(" · " + l).length);
    return t;
}

export function resultOf(j) {
    if (j.status === "ok")
        return { tone: "ok", text: "зелёный" };
    if (j.status === "fail")
        return j.timedOut ? { tone: "fail", text: "снят по времени" } : { tone: "fail", text: "красный" };
    if (j.status === "cancelled")
        return { tone: "muted", text: "отменён" };
    if (j.status === "interrupted")
        return { tone: "muted", text: "оборван" };
    if (j.status === "skipped")
        return { tone: "muted", text: j.na ? "неприменимо" : "пропущен" };
    return { tone: "run", text: j.status === "running" ? "идёт" : "ждёт" };
}

export function jobRow(j, now, tagOf, labels = []) {
    const tag = (tagOf && tagOf(j.tree)) || (j.tree === "orchestrator-staging" ? "staging" : String(j.tree || "").slice(0, 14));
    const run = j.status === "running", end = run ? now : j.endedAt || now;
    const p = j.prog || null;
    return {
        id: j.id, tag, task: j.task, stage: String(j.task || ""), label: cleanLabel(j.label || j.task, labels), input: String(j.input || "").slice(0, 160),
        status: j.status, startedAt: j.startedAt || null, endedAt: j.endedAt || null, elapsedS: j.startedAt ? sec(end - j.startedAt) : null,
        leftS: null, overdue: false, quietS: run && j.lastOutAt ? sec(now - j.lastOutAt) : null,
        prog: p ? { done: p.done || 0, total: p.total ?? null, unit: p.unit || "", phase: p.phase || "", approx: !!p.approx } : null,
        okN: 0, failN: 0, tail: run ? (j.tailLines || []).slice(-4) : [], summary: run ? "" : String(j.summary || "").slice(0, 260), result: resultOf(j),
    };
}

// загрузка машины из pub().machines (ld — последний свежий замер, health — счётчик связи)
export function machineOf(m) {
    const ld = m && m.ld;
    if (!m || !m.online || !ld)
        return { online: false, health: (m && m.health) || null };
    const free = (ld.memTotalGB || 0) - (ld.memUsedGB || 0), h = strain(ld);
    return {
        online: true, label: m.label || ld.label || "", cpu: Math.round(ld.cpu || 0), cores: (ld.cores || []).map((x) => Math.round(x)),
        memTotalGB: r1(ld.memTotalGB || 0), memUsedGB: r1(ld.memUsedGB || 0), memFreeGB: r1(free), swapUsedGB: r1(ld.swapUsedGB || 0),
        tempC: typeof ld.tempC === "number" ? ld.tempC : null, thermMode: ld.thermMode || null, heat: h,
        heatWhy: h === "hard" ? "машина перегружена: прогоны ей сейчас не выдаются" : h === "soft" ? "машина под нагрузкой" : "",
        loadAvg: ld.loadAvg || null, upS: ld.upSec ? Math.round(ld.upSec) : null, sampleAt: ld.at || null,
        hist: { cpu: ((ld.hist && ld.hist.cpu) || []).slice(-60), temp: ((ld.hist && ld.hist.temp) || []).slice(-60) },
        top: (ld.top || []).slice(0, 5), alarm: ld.alarm || "", swapNote: ld.swapNote || "", health: m.health || null,
    };
}

// доля машины в полном прогоне по частям (runView: parts[].machine)
export function fullRunOf(run, machine, now) {
    if (!run || run.status !== "running")
        return null;
    const parts = (run.parts || []).filter((p) => p.machine === machine);
    const cur = parts.find((p) => p.status === "running");
    return {
        sha: String(run.sha || "").slice(0, 10), subject: String(run.subject || "").slice(0, 120), status: run.status, phase: cur ? "часть" : "ждёт части",
        current: cur ? cur.id : "", partsDone: parts.filter((p) => ["ok", "fail", "skipped"].includes(p.status)).length,
        partsFail: parts.filter((p) => p.status === "fail").length, partsTotal: parts.length,
        elapsedS: run.startedAt ? sec(now - run.startedAt) : null, tail: cur ? (cur.tail || []).slice(-3) : [],
        all: { ok: run.ok, fail: run.fail, running: run.running, total: run.total },
    };
}

// очередь прогонов диспетчерской: что ждёт места и что идёт на других машинах
export function queueOf(jobs, machine, now, labelOf = (x) => x, tagOf = null, labels = []) {
    const tag = (j) => (tagOf && tagOf(j.tree)) || (j.tree === "orchestrator-staging" ? "staging" : String(j.tree || "").slice(0, 14));
    const row = (j) => ({ id: j.id, tag: tag(j), label: cleanLabel(j.label, labels), input: String(j.input || "").slice(0, 120), ageS: j.queuedAt ? sec(now - j.queuedAt) : null });
    return {
        waiting: jobs.filter((j) => j.status === "queued" || j.status === "waiting").map((j) => ({ ...row(j), wait: j.wait || "" })),
        elsewhere: jobs.filter((j) => j.status === "running" && j.runOn !== machine).map((j) => ({ ...row(j), machine: j.runOn ? labelOf(j.runOn) : labelOf("local") })),
    };
}

// весь экран: { now, state, headline, machine, current, fullRun, queue, recent, day }
export function laptopView({ machine, jobs = [], shard = {}, tagOf = null, now = Date.now(), recentN = RECENT_N } = {}) {
    const ms = (shard.machines || []).find((m) => m.id === machine) || null;
    const labelOf = (id) => ((shard.machines || []).find((m) => m.id === id) || {}).label || id;
    const labels = (shard.machines || []).map((m) => m.label).filter(Boolean);
    const mine = jobs.filter((j) => j && j.runOn === machine);
    const current = mine.filter((j) => j.status === "running").sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0)).map((j) => jobRow(j, now, tagOf, labels));
    const done = mine.filter((j) => FINAL.includes(j.status) && j.endedAt).sort((a, b) => b.endedAt - a.endedAt);
    const dayJobs = done.filter((j) => now - j.endedAt <= DAY_MS);
    const mach = machineOf(ms), fullRun = fullRunOf(shard.run, machine, now), queue = queueOf(jobs, machine, now, labelOf, tagOf, labels);
    const state = current.length || (fullRun && fullRun.current) ? "busy" : !mach.online ? "offline" : mach.heat === "hard" ? "hot" : "idle";
    const c = current[0];
    const headline = c
        ? [c.tag, c.label, c.input.length > 70 ? c.input.slice(0, 69) + "…" : c.input].filter(Boolean).join(" · ") + (current.length > 1 ? " и ещё " + (current.length - 1) : "")
        : fullRun ? "полный прогон staging " + fullRun.sha + (fullRun.current ? " · " + fullRun.current : "")
            : state === "offline" ? "замеров нет: машина не на связи с ПК"
                : state === "hot" ? mach.heatWhy
                    : queue.waiting.length ? "свободна — в очереди " + queue.waiting.length + ", место выдаёт диспетчерская" : "свободна, очередь пуста";
    return {
        now, state, headline, machine: mach, current, fullRun, queue, recent: done.slice(0, recentN).map((j) => jobRow(j, now, tagOf, labels)),
        day: {
            ok: dayJobs.filter((j) => j.status === "ok").length, fail: dayJobs.filter((j) => j.status === "fail").length,
            other: dayJobs.filter((j) => !["ok", "fail"].includes(j.status)).length,
            busyS: dayJobs.reduce((s, j) => s + (j.startedAt ? sec(j.endedAt - j.startedAt) : 0), 0),
        },
    };
}
