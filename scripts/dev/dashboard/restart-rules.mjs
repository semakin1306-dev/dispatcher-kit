// restart-rules.mjs — чистые правила безопасного перезапуска сервера: опрос готовности с повторами (неответ — не
// «тихо»), токен страницы, итог «оборвано при перезапуске». Без импортов и побочных действий — скрипт перезапуска грузит
// этот файл, не поднимая модулей сервера.
export const DRAIN_TRIES = 3;
export const DRAIN_PAUSE_MS = 10000;

export async function drainRetry(call, { tries = DRAIN_TRIES, pauseMs = DRAIN_PAUSE_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const errors = [];
    for (let i = 0; i < tries; i++) {
        try {
            return { ok: true, st: await call(), errors };
        }
        catch (e) {
            errors.push(String((e && e.message) || e));
        }
        if (i < tries - 1)
            await sleep(pauseMs);
    }
    return { ok: false, errors };
}

const LIVE = ["running", "queued", "waiting"];

export function markBootInterrupted(runs, now = Date.now()) {
    const cut = [];
    const out = runs.map((j) => {
        if (!LIVE.includes(j.status))
            return j;
        cut.push({ id: j.id, task: j.task, tree: j.tree, was: j.status });
        return { ...j, status: "interrupted", endedAt: j.endedAt || now, bootInterrupted: true };
    });
    return { runs: out, cut };
}

export function bootSeen(jobs, loaded) {
    const out = [];
    for (const j of jobs) {
        const cur = JSON.stringify(j);
        if (!j.bootInterrupted && loaded.get(j.id) === cur)
            out.push([j.id, cur]);
    }
    return out;
}

export const PULSE_MS = 60000;
export const SENTRY_SILENT_MS = 3 * 60000;
export const SENTRY_COOLDOWN_MS = 10 * 60000;
const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8);

export function sentryVerdict({ now, listenerPid, pulse, lastRestartAt = 0 }) {
    if (!listenerPid)
        return { act: "none", why: "сервер не запущен (порт свободен) — не трогаю: его останавливают намеренно" };
    if (!pulse || !pulse.at)
        return { act: "none", why: "нет файла пульса — сервер без пульса (старая версия?) или ещё не писал" };
    if (pulse.pid !== listenerPid)
        return { act: "none", why: "пульс от процесса " + pulse.pid + ", а порт держит " + listenerPid + " — сервер без пульса (старая версия?)" };
    const age = now - pulse.at;
    if (age < SENTRY_SILENT_MS)
        return { act: "none", why: "пульс " + Math.round(age / 1000) + " с назад" };
    if (lastRestartAt && now - lastRestartAt < SENTRY_COOLDOWN_MS)
        return { act: "none", why: "нет пульса, но недавно уже перезапускал (" + hhmmss(lastRestartAt) + ") — жду" };
    return { act: "restart", why: "сторож: нет пульса " + Math.floor(age / 60000) + " мин (последний " + hhmmss(pulse.at) + ", pid " + pulse.pid + (pulse.sha ? ", " + pulse.sha : "") + ")" };
}

export const startReason = (env) => String((env && env.DASH_START_REASON) || "").trim() || "запуск не через restart-dashboard (ярлык, консоль)";

export function pageToken(html) {
    const m = /<meta\s+name="dash-token"\s+content="([0-9a-f]+)"/.exec(String(html || "")) || /const TOKEN = "([0-9a-f]+)"/.exec(String(html || ""));
    return m ? m[1] : null;
}
