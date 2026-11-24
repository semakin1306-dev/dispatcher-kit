// ssh-gate.mjs — ворота на открытие ssh-подключений к одной машине: не больше нескольких одновременно и с паузой между
// ними. Пачка одновременных входов перегружает sshd, и он начинает отбрасывать подключения.
export function createSshGate({ max = 3, minGapMs = 150, holdMaxMs = 15000, now = Date.now, timer = setTimeout, untimer = clearTimeout, onSlow = null, slowMs = 3000 } = {}) {
    const queue = [];
    let active = 0, lastStart = -Infinity, pumpT = null;
    const stats = { started: 0, waited: 0, maxQueue: 0, worstWaitMs: 0, autoReleased: 0, cancelled: 0 };
    function release(e) {
        if (!e.started || e.released)
            return;
        e.released = true;
        active--;
        if (e.holdT) {
            untimer(e.holdT);
            e.holdT = null;
        }
        pump();
    }
    function pump() {
        if (pumpT) {
            untimer(pumpT);
            pumpT = null;
        }
        while (queue.length && active < max) {
            const wait = lastStart + minGapMs - now();
            if (wait > 0) {
                pumpT = timer(() => {
                    pumpT = null;
                    pump();
                }, wait);
                if (pumpT && pumpT.unref)
                    pumpT.unref();
                return;
            }
            const e = queue.shift(), t = now(), w = t - e.at;
            e.started = true;
            active++;
            lastStart = t;
            stats.started++;
            if (w > 1000)
                stats.waited++;
            if (w > stats.worstWaitMs)
                stats.worstWaitMs = w;
            if (w >= slowMs && onSlow) {
                try {
                    onSlow({ waitMs: w, queued: queue.length, active, tag: e.tag });
                }
                catch { }
            }
            e.holdT = timer(() => {
                if (!e.released) {
                    stats.autoReleased++;
                    release(e);
                }
            }, holdMaxMs);
            if (e.holdT && e.holdT.unref)
                e.holdT.unref();
            try {
                e.start();
            }
            catch {
                release(e);
            }
        }
    }
    return {
        enter(start, tag = "") {
            const e = { start, tag, at: now(), started: false, released: false, holdT: null };
            queue.push(e);
            if (queue.length > stats.maxQueue)
                stats.maxQueue = queue.length;
            pump();
            return {
                release: () => release(e),
                cancel: () => {
                    if (e.started)
                        return false;
                    const i = queue.indexOf(e);
                    if (i >= 0) {
                        queue.splice(i, 1);
                        stats.cancelled++;
                    }
                    return i >= 0;
                },
            };
        },
        snapshot: () => ({ active, queued: queue.length, max, minGapMs, ...stats }),
    };
}
