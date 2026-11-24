// host-health.mjs — здоровье удалённых машин: разбор отказа ssh по тексту (ограничение входов, таймаут, отказ,
// недоступность, ключ), отличие отказа инфраструктуры от красного кода и переходы «на связи ⇄ не на связи» с причиной.
// Чистые правила.
const PATTERNS = [
    { kind: "throttle", infra: true, re: /(timed out|closed|reset)[^\n]{0,40}(during )?banner exchange|banner exchange|kex_exchange_identification|MaxStartups|Connection (?:reset|closed) by [\d.:a-f]+ port 22/i,
        label: "sshd не принял подключение (ограничение MaxStartups или машина не успевает ответить)" },
    { kind: "timeout", infra: true, re: /ssh: connect to host [^\n]*(?:timed out|Operation timed out)|Connection to [\d.:a-f]+ port 22 timed out|ConnectTimeout/i,
        label: "машина не ответила на подключение (таймаут)" },
    { kind: "dropped", infra: true, re: /Timeout, server [\w.:-]+ not responding|Read from remote host [\w.:-]+: Connection reset by peer|client_loop: send disconnect: Connection reset/i, label: "связь с машиной оборвалась посреди прогона (ssh не дождался ответа)" },
    { kind: "refused", infra: true, re: /ssh: connect to host [^\n]*Connection refused/i, label: "ssh на машине не принимает подключения (отказ)" },
    { kind: "unreachable", infra: true, re: /ssh: connect to host [^\n]*(?:No route to host|Network is unreachable)|ssh: Could not resolve hostname|Name or service not known/i,
        label: "машина недоступна по сети" },
    { kind: "auth", infra: false, re: /Permission denied \(publickey|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i,
        label: "ssh отказал по ключу (это настройка, а не нагрузка)" },
];

export function classifySshFailure(text) {
    const s = String(text || "");
    for (const p of PATTERNS) {
        const m = p.re.exec(s);
        if (m) {
            const ln = s.split(/\r?\n/).find((l) => p.re.test(l)) || m[0];
            return { kind: p.kind, label: p.label, infra: p.infra, line: ln.trim().slice(0, 200) };
        }
    }
    return null;
}

export function infraFailure(tail, { runOn = "", code = null } = {}) {
    if (!runOn || runOn === "local")
        return null;
    const t = String(tail || "").slice(-3000), c = classifySshFailure(t);
    if (!c || !c.infra)
        return null;
    return c;
}

export const INFRA_TRIES = 3, INFRA_BACK_MS = 45000;
export const infraRequeueDue = (j, { hostUp, now = Date.now() }) => !!(j && j.infra && !j.requeued && (j.infraTry || 0) < INFRA_TRIES && hostUp && now - (j.endedAt || 0) >= INFRA_BACK_MS);
const fmtS = (ms) => Math.round(ms / 1000);

export function createHostTracker({ emit = () => { }, now = Date.now, failsToOffline = 2, flapWindowMs = 10 * 60000 } = {}) {
    const hosts = new Map();
    const st = (h) => {
        if (!hosts.has(h))
            hosts.set(h, { state: "online", fails: 0, firstFailAt: 0, lastOkAt: 0, kind: "", transitions: [] });
        return hosts.get(h);
    };
    const flaps = (x, t) => {
        x.transitions = x.transitions.filter((a) => t - a < flapWindowMs);
        return x.transitions.length;
    };
    return {
        fail(host, text, ctx = {}) {
            const x = st(host), t = now(), c = classifySshFailure(text) || { kind: "other", label: "поток оборван без признаков в выводе ssh", infra: true, line: String(text || "").trim().split(/\r?\n/).pop().slice(0, 200) };
            if (!x.fails)
                x.firstFailAt = t;
            x.fails++;
            const base = { host, kind: c.kind, why: c.label, detail: c.line, fails: x.fails, lastOkAgoS: x.lastOkAt ? fmtS(t - x.lastOkAt) : null, ...ctx };
            if (x.state === "online" && x.fails >= failsToOffline) {
                x.state = "offline";
                x.kind = c.kind;
                x.transitions.push(t);
                emit("host.state", { ...base, state: "offline", flaps: flaps(x, t), firstFailAt: x.firstFailAt });
            }
            else if (x.state === "offline" && c.kind !== x.kind) {
                x.kind = c.kind;
                emit("host.reason", { ...base, state: "offline" });
            }
            return x.state;
        },
        ok(host, ctx = {}) {
            const x = st(host), t = now(), was = x.state;
            if (was === "offline") {
                x.transitions.push(t);
                emit("host.state", { host, state: "online", downS: fmtS(t - x.firstFailAt), fails: x.fails, kind: x.kind, flaps: flaps(x, t), ...ctx });
            }
            else if (x.fails)
                emit("host.blip", { host, fails: x.fails, downS: fmtS(t - x.firstFailAt), ...ctx });
            x.state = "online";
            x.fails = 0;
            x.firstFailAt = 0;
            x.kind = "";
            x.lastOkAt = t;
        },
        state: (host) => st(host).state,
        snapshot: () => Object.fromEntries([...hosts].map(([h, x]) => [h, { state: x.state, fails: x.fails, kind: x.kind, firstFailAt: x.firstFailAt || null, lastOkAt: x.lastOkAt || null }])),
    };
}
