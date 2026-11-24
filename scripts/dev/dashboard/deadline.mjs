// deadline.mjs — сроки ожиданий: git, ssh и шаги команд оркестратора не ждут ответа вечно (procBy, withDeadline).
// Сработавшие сроки попадают в пульс сервера.
export const HANG_GRACE_MS = 15000;
export const graceMs = () => Number(process.env.DASH_HANG_GRACE_MS) || HANG_GRACE_MS;
const hangLog = [];
export const hangsSince = (t) => hangLog.filter((h) => h.at > t);

export function noteHang(what, ms) {
    hangLog.push({ what: String(what).slice(0, 120), at: Date.now(), ms });
    if (hangLog.length > 50)
        hangLog.shift();
    console.error("‼ срок ожидания вышел: " + what + " (" + Math.round(ms / 1000) + " с)");
}

export function settleBy(run, ms, onLate) {
    return new Promise((resolve) => {
        let over = false, h;
        const t = setTimeout(() => {
            if (over)
                return;
            over = true;
            let v;
            try {
                v = onLate(h);
            }
            catch (e) {
                v = undefined;
            }
            resolve(v);
        }, ms);
        const done = (v) => {
            if (over)
                return;
            over = true;
            clearTimeout(t);
            resolve(v);
        };
        try {
            h = run(done);
        }
        catch (e) {
            over = true;
            clearTimeout(t);
            throw e;
        }
    });
}

export function withDeadline(p, ms, what) {
    let t;
    const late = new Promise((_, reject) => {
        t = setTimeout(() => {
            noteHang(what, ms);
            reject(Object.assign(new Error(what + ": нет ответа за " + human(ms)), { code: "EDEADLINE" }));
        }, ms);
    });
    return Promise.race([Promise.resolve(p), late]).finally(() => clearTimeout(t));
}

export function procBy(run, ms, what, late, kill) {
    const cap = ms + graceMs();
    return settleBy(run, cap, (c) => {
        try {
            if (c && kill)
                kill(c);
        }
        catch { }
        noteHang(what, cap);
        return typeof late === "function" ? late(cap) : late;
    });
}

export const human = (ms) => ms >= 60000 && ms % 60000 === 0 ? ms / 60000 + " мин" : Math.round(ms / 1000) + " с";
