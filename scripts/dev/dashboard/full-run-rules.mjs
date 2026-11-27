// full-run-rules.mjs — чистые правила полного прогона по частям (страница /shard, кнопка «Полный прогон» на линии staging).
// Полный прогон — это пачка обычных прогонов диспетчерской: по одному на часть каталога проекта (задача `fullRun.task`,
// ввод — id части). Места выдают машины прогонов (machines.mjs, slot-places.mjs) как любой другой задаче, поэтому
// клетки, доставка кода по sha, подготовка машины и приоритет этой машины работают сами. Здесь — только решения:
// какие части гонять и в каком порядке, что показать, какую часть повторить. Ничего не пишет и никого не зовёт.

export const RUNNING = ["queued", "waiting", "running"];
export const FINAL_PART = ["ok", "fail", "skipped", "cancelled", "interrupted"];

/**
 * Каталог частей из вывода команды проекта: строки, совпавшие с `re` (группа 1 — id части), по порядку, без повторов.
 * `exclude` — id, которые в полный прогон не идут.
 */
export function parseCatalog(text, re, exclude = []) {
    const rx = re instanceof RegExp ? re : new RegExp(String(re), "m");
    const flags = rx.flags.includes("g") ? rx.flags : rx.flags + "g";
    const g = new RegExp(rx.source, flags.includes("m") ? flags : flags + "m");
    const clean = String(text || "").replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
    const out = [], seen = new Set(), skip = new Set(exclude || []);
    for (const m of clean.matchAll(g)) {
        const id = m[1];
        if (id && !seen.has(id) && !skip.has(id)) {
            seen.add(id);
            out.push(id);
        }
    }
    return out;
}

/**
 * Порядок частей: сначала самые долгие по прошлым прогонам (так очередь лучше раскладывается по местам и хвост короче),
 * части без истории — в порядке каталога после тех, что с историей.
 */
export function orderParts(ids, lastSec = {}) {
    const idx = new Map(ids.map((id, i) => [id, i]));
    return [...ids].sort((a, b) => {
        const sa = lastSec[a], sb = lastSec[b];
        if (sa != null && sb != null && sa !== sb)
            return sb - sa;
        if ((sa != null) !== (sb != null))
            return sa != null ? -1 : 1;
        return idx.get(a) - idx.get(b);
    });
}

/** Длительности частей последнего законченного прогона (для порядка следующего): { id: сек }. */
export function lastDurations(run, jobsById) {
    const out = {};
    for (const p of Object.values((run && run.parts) || {})) {
        const j = jobsById.get(p.jobs[p.jobs.length - 1]);
        if (j && j.startedAt && j.endedAt && ["ok", "fail"].includes(j.status))
            out[p.id] = Math.round((j.endedAt - j.startedAt) / 1000);
    }
    return out;
}

/** Последний прогон части и её итог. Пропущенная (неприменимо) — не провал. */
export function partState(p, jobsById) {
    const id = p.jobs[p.jobs.length - 1], j = id ? jobsById.get(id) : null;
    if (!j)
        return { status: id ? "lost" : "queued", job: null };
    const status = j.status === "skipped" && j.na ? "skipped" : j.status;
    return { status, job: j };
}

/**
 * Решение по части после её прогона: окружное падение на удалённой машине повторяется один раз на этой машине
 * (на удалённой нет ключей/службы — повтор там ничего не изменит). `envFail(job)` — признак окружения из regress.mjs.
 */
export function retryPlan(p, jobsById, envFail, { maxTries = 2 } = {}) {
    const { status, job } = partState(p, jobsById);
    if (status !== "fail" || !job || p.jobs.length >= maxTries)
        return null;
    if (job.runOn && job.runOn !== "local" && envFail(job))
        return { only: ["local"], why: "окружение на " + job.runOn + " — повтор на этой машине" };
    return null;
}

/** Сводка прогона для линии staging и страницы: { id, sha, status, ok, fail, skipped, notrun, running, total, ... }. */
export function summarize(run, jobsById) {
    if (!run)
        return null;
    const st = Object.values(run.parts || {}).map((p) => partState(p, jobsById).status);
    const n = (xs) => st.filter((s) => xs.includes(s)).length;
    const running = n(RUNNING), ok = n(["ok"]), fail = n(["fail"]), skipped = n(["skipped"]);
    const notrun = st.length - running - ok - fail - skipped;
    const status = run.status === "cancelled" ? "cancelled" : running ? "running" : "done";
    return {
        id: run.id, sha: run.sha, subject: run.subject || "", status, prepOnly: false,
        ok, fail, skipped, notrun, running, total: st.length, startedAt: run.startedAt, endedAt: run.endedAt || null, by: run.by || "",
        rerunOf: run.rerunOf || null,
    };
}

/** Части для перепрогона красных: провал, оборванные и снятые (последний итог не зелёный и не «неприменимо»). */
export function redParts(run, jobsById) {
    return Object.values((run && run.parts) || {})
        .filter((p) => ["fail", "cancelled", "interrupted", "lost"].includes(partState(p, jobsById).status))
        .map((p) => p.id);
}

/** Подробный вид для страницы /shard и экрана машины: части с машиной, временем и итогом; разрез по машинам. */
export function runView(run, jobsById, { label = (x) => x, now = Date.now() } = {}) {
    if (!run)
        return null;
    const parts = run.order.map((id) => {
        const p = run.parts[id], { status, job } = partState(p, jobsById);
        const end = job && (job.endedAt || (job.status === "running" ? now : null));
        return {
            id, status, tries: p.jobs.length, jobId: job ? job.id : null, machine: job ? job.runOn || null : null,
            mLabel: job && job.runOn ? label(job.runOn) : "",
            sec: job && job.startedAt && end ? Math.round((end - job.startedAt) / 1000) : null,
            summary: job && FINAL_PART.includes(job.status) ? String(job.summary || "").slice(0, 300) : "",
            tail: job && job.status === "running" ? (job.tailLines || []).slice(-3) : [],
            only: p.only || null, note: p.note || "",
        };
    });
    const machines = {};
    for (const x of parts) {
        if (!x.machine)
            continue;
        const m = machines[x.machine] || (machines[x.machine] = { label: x.mLabel, done: 0, fail: 0, running: 0, current: "" });
        if (x.status === "running") {
            m.running++;
            m.current = m.current || x.id;
        }
        else if (["ok", "fail", "skipped"].includes(x.status)) {
            m.done++;
            if (x.status === "fail")
                m.fail++;
        }
    }
    return { ...summarize(run, jobsById), parts, machines };
}
