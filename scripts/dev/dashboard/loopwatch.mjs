// loopwatch.mjs — сторож цикла событий сервера: событие slow.loop, когда цикл стоит дольше порога, вместе с отметками,
// чем сервер был занят. Повторы подавляются и засчитываются в следующее событие.
import { logEvent } from "./config.mjs";

export const LOOP_SLOW_MS = Number(process.env.DASH_SLOW_LOOP_MS) || 500;
export const LOOP_QUIET_MS = 60000;
const ACT = [], ACT_MAX = 64;

export function activity(label) {
    ACT.push({ at: Date.now(), label: String(label).slice(0, 120) });
    if (ACT.length > ACT_MAX)
        ACT.shift();
}

export const activitiesSince = (t) => ACT.filter((a) => a.at >= t).map((a) => a.label);

export function loopGate(st, lagMs, now, { threshold = LOOP_SLOW_MS, quietMs = LOOP_QUIET_MS } = {}) {
    if (!(lagMs > threshold))
        return { st, ev: null };
    if (st.lastAt && now - st.lastAt < quietMs)
        return { st: { ...st, held: st.held + 1, worst: Math.max(st.worst, lagMs) }, ev: null };
    const ev = { ms: Math.round(lagMs), ...(st.held ? { suppressed: st.held, worstSuppressedMs: Math.round(st.worst) } : {}) };
    return { st: { lastAt: now, held: 0, worst: 0 }, ev };
}

export function startLoopWatch({ tickMs = 100, log = logEvent } = {}) {
    let st = { lastAt: 0, held: 0, worst: 0 }, expect = Date.now() + tickMs;
    const t = setInterval(() => {
        const now = Date.now(), lag = now - expect;
        expect = now + tickMs;
        const r = loopGate(st, lag, now);
        st = r.st;
        if (r.ev && lag >= 3000) {
            const during = activitiesSince(now - lag - tickMs);
            r.ev.during = during.slice(-8);
            r.ev.last = ACT.length ? ACT[ACT.length - 1].label : null;
        }
        if (r.ev) {
            log("slow.loop", r.ev);
            console.warn("[slow.loop] цикл событий стоял " + r.ev.ms + " мс" + (r.ev.suppressed ? " (до этого подавлено " + r.ev.suppressed + ", худшее " + r.ev.worstSuppressedMs + " мс)" : "") + (r.ev.last ? "; в окне: " + (r.ev.during || []).join(" → ") + " (последнее: " + r.ev.last + ")" : ""));
        }
    }, tickMs);
    t.unref();
    return () => clearInterval(t);
}
