// events.mjs — поток событий для страницы (SSE): сервер сам сообщает «состояние изменилось» с номером версии и «у агента
// новые события» с номером ревизии; страница читает только изменившееся.
import { S } from "./state.mjs";

export const sseClients = new Set();
let verTimer = null, agentQ = new Map(), agentTimer = null;
export const stateVerNow = () => S.stateVer;

export const resetVer = () => {
    S.stateVer = 0;
};

export function bumpVer(why = "") {
    S.stateVer = (S.stateVer || 0) + 1;
    S.stateWhy = why;
    if (verTimer || !sseClients.size)
        return;
    verTimer = setTimeout(() => {
        verTimer = null;
        broadcast("ver", () => ({ ver: S.stateVer, why: S.stateWhy }));
    }, 250);
}

export function agentChanged(key, rev) {
    agentQ.set(key, rev);
    if (agentTimer || !sseClients.size)
        return;
    agentTimer = setTimeout(() => {
        agentTimer = null;
        const q = agentQ;
        agentQ = new Map();
        for (const [k, r] of q)
            broadcast("agent", (c) => ({ key: k === c.vk ? "orchestrator" : k, rev: r }));
    }, 150);
}

function broadcast(type, mk) {
    for (const c of sseClients) {
        try {
            c.res.write(`event: ${type}\ndata: ${JSON.stringify(mk(c))}\n\n`);
        }
        catch {
            sseClients.delete(c);
        }
    }
}

export function sseOpen(req, res, vk) {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ ver: S.stateVer || 0, now: Date.now() })}\n\n`);
    const c = { res, vk };
    sseClients.add(c);
    req.on("close", () => sseClients.delete(c));
    res.on("error", () => sseClients.delete(c));
}

export function startHeartbeat() {
    setInterval(() => {
        for (const c of sseClients) {
            try {
                c.res.write(": ping\n\n");
            }
            catch {
                sseClients.delete(c);
            }
        }
    }, 25000);
}
