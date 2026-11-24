import { test } from "node:test";
import assert from "node:assert/strict";
import { createSshGate } from "./ssh-gate.mjs";

function clock() {
    let t = 0, seq = 0;
    const timers = new Map();
    return {
        now: () => t,
        timer: (fn, ms) => {
            const id = ++seq;
            timers.set(id, { at: t + ms, fn });
            return id;
        },
        untimer: (id) => {
            timers.delete(id);
        },
        advance(ms) {
            const end = t + ms;
            for (;;) {
                const due = [...timers].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due)
                    break;
                t = due[1].at;
                timers.delete(due[0]);
                due[1].fn();
            }
            t = end;
        },
    };
}

test("не больше max рукопожатий одновременно; остальные ждут, пока кто-то ответит", () => {
    const c = clock(), g = createSshGate({ max: 2, minGapMs: 0, ...c }), started = [], h = [];
    for (let i = 0; i < 5; i++)
        h.push(g.enter(() => started.push(i), "j" + i));
    assert.deepEqual(started, [0, 1]);
    assert.equal(g.snapshot().queued, 3);
    h[0].release();
    assert.deepEqual(started, [0, 1, 2]);
    h[1].release();
    h[2].release();
    assert.deepEqual(started, [0, 1, 2, 3, 4]);
    assert.equal(g.snapshot().queued, 0);
});

test("пауза между стартами: пачка из десяти не открывается одним залпом", () => {
    const c = clock(), g = createSshGate({ max: 10, minGapMs: 200, ...c }), at = [];
    for (let i = 0; i < 4; i++)
        g.enter(() => at.push(c.now()));
    assert.deepEqual(at, [0]);
    c.advance(200);
    c.advance(200);
    c.advance(200);
    assert.deepEqual(at, [0, 200, 400, 600]);
});

test("слот, который не освободили, снимается сам через holdMaxMs — очередь не встаёт навсегда", () => {
    const c = clock(), g = createSshGate({ max: 1, minGapMs: 0, holdMaxMs: 15000, ...c }), started = [];
    g.enter(() => started.push("a"));
    g.enter(() => started.push("b"));
    assert.deepEqual(started, ["a"]);
    c.advance(14999);
    assert.deepEqual(started, ["a"]);
    c.advance(2);
    assert.deepEqual(started, ["a", "b"]);
    assert.equal(g.snapshot().autoReleased, 1);
});

test("cancel убирает из очереди; уже стартовавшее не отменяется; release идемпотентен", () => {
    const c = clock(), g = createSshGate({ max: 1, minGapMs: 0, ...c }), started = [];
    const a = g.enter(() => started.push("a")), b = g.enter(() => started.push("b")), d = g.enter(() => started.push("d"));
    assert.equal(b.cancel(), true);
    assert.equal(a.cancel(), false);
    a.release();
    a.release();
    assert.deepEqual(started, ["a", "d"], "лишний release не пускает чужого");
    d.release();
    assert.equal(g.snapshot().active, 0);
});

test("долгое ожидание сообщается (onSlow) — по нему пишется событие ssh.gate", () => {
    const c = clock(), slow = [], g = createSshGate({ max: 1, minGapMs: 0, slowMs: 3000, onSlow: (x) => slow.push(x), ...c });
    const a = g.enter(() => { });
    g.enter(() => { }, "ждущий");
    c.advance(5000);
    a.release();
    assert.equal(slow.length, 1);
    assert.equal(slow[0].waitMs, 5000);
    assert.equal(slow[0].tag, "ждущий");
    assert.equal(g.snapshot().worstWaitMs, 5000);
});

test("падение внутри start() не держит слот", () => {
    const c = clock(), g = createSshGate({ max: 1, minGapMs: 0, ...c }), started = [];
    g.enter(() => {
        throw new Error("spawn упал");
    });
    g.enter(() => started.push("b"));
    assert.deepEqual(started, ["b"]);
});
