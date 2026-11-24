// backlog.mjs — бэклог задач: элементы-заметки, которые не входят в текущий эпик. Добавить, исследовать агентом бэклога,
// включить в эпик или волну, отказать с причиной, закрыть; вопросы агента бэклога — карточками человеку. Модуль можно
// выключить в конфиге проекта.
import { PROJECT, fwd } from "../slots.mjs";
import { moduleStates } from "../modules-catalog.mjs";
import { enabled } from "./modules.mjs";
import fs from "node:fs";
import path from "node:path";
import { S } from "./state.mjs";
import { DATA, DRY, logEvent } from "./config.mjs";
import { agentPublic, agents, deliver, ensureAgent, sendWhenFree } from "./agents.mjs";
import { BACKLOG_DIR, BACKLOG_KEY, BACKLOG_WT, BL_CLI, prepareBacklogTree } from "./backlog-agent.mjs";
import { createItem, listItems, readItem, updateItem } from "./backlog-store.mjs";
import { STATUSES, STATUS_WORD, epicMessage, researchMessage, retroTriage, WAVE_RE } from "./backlog-rules.mjs";
import { epicById, epicsReg, openEpics, orchKey } from "./trees.mjs";
import { addCard, ibId, keepCards, saveInbox } from "./inbox.mjs";
import { ownerQuestions } from "./stations.mjs";
import { bumpVer } from "./events.mjs";

export const OUTBOX = path.join(DATA, "backlog-outbox.jsonl");
export const SINK = DRY || process.env.DASH_BACKLOG_SINK === "log" ? "log" : "agent";
const B = () => S.backlog || (S.backlog = { items: [], at: 0, sig: "" });

/** Включён ли модуль бэклога в этой установке. Выключен — его маршруты не отвечают, агент бэклога не запускается. */
export function backlogEnabled(project = PROJECT) {
    if (project !== PROJECT) {
        const st = moduleStates(project).find((m) => m.id === "backlog");
        return !!(st && st.on);
    }
    return enabled("backlog");
}

/** Элементы бэклога с кешем на 2 с. Изменение набора (правка файла снаружи) — сигнал странице. */
export function backlogItems(force = false) {
    const b = B();
    if (!force && Date.now() - b.at < 2000)
        return b.items;
    b.items = listItems(BACKLOG_DIR);
    b.at = Date.now();
    const sig = b.items.map((it) => [it.id, it.status, it.epic, it.wave, String(it.title || "").length, String(it.researchText || "").length, String(it.planText || "").length].join(":")).join("|");
    if (sig !== b.sig) {
        b.sig = sig;
        bumpVer("backlog");
    }
    return b.items;
}

export function retroTriageBrief() {
    try {
        const tr = retroTriage(backlogItems(), epicsReg().epics);
        return tr && tr.open.length ? { epic: tr.epic, title: tr.title, total: tr.total, open: tr.open.map((x) => x.id) } : null;
    }
    catch {
        return null;
    }
}

export const backlogBrief = () => {
    const n = {};
    for (const it of backlogItems())
        n[it.status] = (n[it.status] || 0) + 1;
    return n;
};

const waveOfBranch = (br) => {
    const m = /wv-?0*(\d{1,4})/i.exec(br || "");
    return m ? "WV-" + m[1].padStart(4, "0") : "";
};

const epicsPub = () => openEpics().map((e) => ({ id: e.id, title: e.title || e.id, waves: (e.slots || []).filter((x) => !x.archived).map((x) => ({ wv: waveOfBranch(x.branch), tag: x.tag, title: x.title })).filter((x) => x.wv) }));

function outbox(kind, to, text) {
    fs.appendFileSync(OUTBOX, JSON.stringify({ at: Date.now(), kind, to, text }) + "\n");
    logEvent("backlog.logged", { kind, to, chars: text.length });
}

async function tell(key, text, kind) {
    if (SINK === "log") {
        outbox(kind, key, text);
        return "собрано (отладка: в журнал backlog-outbox.jsonl, агенту не ушло)";
    }
    const a = agents.get(key);
    if (a && !a.dead && a.busy && !a.pinging) {
        sendWhenFree(key, text);
        return "агент сейчас отвечает — уйдёт в конце ответа";
    }
    deliver(await ensureAgent(key), text);
    logEvent("backlog.sent", { kind, to: key, chars: text.length });
    return "отправлено";
}

const publicItem = (it) => ({ ...it, path: fwd(path.join(BACKLOG_DIR, it.file)), meta: undefined });

export async function backlogOp(b) {
    const op = String(b.op || ""), id = String(b.id || "");
    if (op === "add") {
        const text = String(b.text || "").slice(0, 20000);
        if (!text.trim())
            return { code: 400, body: { error: "пустой текст" } };
        const r = createItem(BACKLOG_DIR, { text, source: String(b.source || "").slice(0, 200), area: String(b.area || "").slice(0, 200), retro: String(b.retro || "").slice(0, 60) });
        logEvent("backlog.add", { id: r.item.id, chars: text.length });
        backlogItems(true);
        if (b.research) {
            const rr = await backlogOp({ op: "research", id: r.item.id });
            return { code: rr.code, body: { ...rr.body, item: publicItem(backlogItems(true).find((x) => x.id === r.item.id) || r.item), message: r.item.id + " добавлен; " + (rr.body.message || rr.body.error || "") } };
        }
        return { code: 200, body: { ok: true, item: publicItem(r.item), message: r.item.id + " добавлен в бэклог" } };
    }
    if (!id)
        return { code: 400, body: { error: "нужен id элемента" } };
    let cur;
    try {
        cur = readItem(BACKLOG_DIR, id);
    }
    catch (e) {
        return { code: 404, body: { error: e.message } };
    }
    const upd = (set, extra = {}) => {
        let r;
        try {
            r = updateItem(BACKLOG_DIR, id, { set });
        }
        catch (e) {
            return { code: 400, body: { error: e.message } };
        }
        logEvent("backlog.set", { id, ...set });
        backlogItems(true);
        bumpVer("backlog");
        return { code: 200, body: { ok: true, item: publicItem(r.item), ...extra } };
    };
    if (op === "set") {
        const set = {};
        for (const [k, v] of Object.entries(b.set || {}))
            set[k] = String(v ?? "").slice(0, 300);
        return upd(set, { message: id + ": сохранено" });
    }
    if (op === "drop")
        return upd({ status: "rejected", reason: String(b.reason || "").slice(0, 300) }, { message: id + ": отказ" });
    if (op === "done")
        return upd({ status: "done" }, { message: id + ": готово" });
    if (op === "status") {
        if (!STATUSES.includes(b.status))
            return { code: 400, body: { error: "статус: " + STATUSES.join(" | ") } };
        return upd({ status: b.status }, { message: id + ": " + STATUS_WORD[b.status] });
    }
    if (op === "research") {
        let tree = { sha: "" };
        try {
            tree = await prepareBacklogTree();
        }
        catch (e) {
            return { code: 409, body: { error: e.message } };
        }
        const text = researchMessage({ id, file: fwd(cur.path), sha: tree.sha, notes: String(b.notes || "").slice(0, 3000) });
        if (b.preview)
            return { code: 200, body: { ok: true, text, to: BACKLOG_KEY } };
        let how;
        try {
            how = await tell(BACKLOG_KEY, text, "backlog.research");
        }
        catch (e) {
            return { code: 409, body: { error: "агент бэклога не запустился: " + e.message } };
        }
        const r = upd({ status: "researching", research: "running" });
        r.body.text = text;
        r.body.message = id + ": исследование — " + how;
        return r;
    }
    if (op === "epic") {
        const ep = epicById(String(b.epic || ""));
        if (!ep)
            return { code: 400, body: { error: "нет такого открытого эпика" } };
        const wave = String(b.wave || "").trim().toUpperCase();
        if (wave && !WAVE_RE.test(wave))
            return { code: 400, body: { error: "волна — WV-NNNN" } };
        const status = wave ? "in-wave" : "planned";
        const r = upd({ epic: ep.id, wave, status });
        const text = epicMessage({ id, title: r.body.item.title, file: fwd(cur.path), epic: ep.id, wave, status, cli: BL_CLI });
        let how;
        try {
            how = await tell(orchKey(ep.id), text, "backlog.epic");
        }
        catch (e) {
            how = "оркестратору не ушло: " + e.message;
        }
        r.body.text = text;
        r.body.message = id + " → эпик «" + (ep.title || ep.id) + "»" + (wave ? ", волна " + wave : "") + ": оркестратору " + how;
        return r;
    }
    return { code: 400, body: { error: "op: add, set, status, research, epic, drop, done" } };
}

export function backlogAfterTurn(a, text) {
    const q = ownerQuestions(text);
    keepCards((x) => !(x.kind === "ownerq" && x.tree === BACKLOG_KEY));
    if (q)
        addCard({ id: ibId(), kind: "ownerq", tree: BACKLOG_KEY, text: q, at: Date.now(), sid: a.sessionId || null });
    saveInbox();
    backlogItems(true);
    bumpVer("backlog");
}

export function backlogDoc(id) {
    let cur;
    try {
        cur = readItem(BACKLOG_DIR, id);
    }
    catch {
        return null;
    }
    const it = cur.item;
    return { tree: id, tag: id, title: it.title, wave: it.wave || "", epic: it.epic || null, orch: it.epic && epicById(it.epic) ? orchKey(it.epic) : null, kind: "backlog", key: "backlog|" + id, file: fwd(cur.path), text: cur.text, to: BACKLOG_KEY, agent: BACKLOG_KEY };
}

let refreshTimer = null;

export async function backlogHttp(req, res, h) {
    if (!backlogEnabled())
        return h.send(res, 404, { error: "модуль бэклога выключен в конфиге проекта (modules.backlog)" });
    if (!refreshTimer && !DRY) {
        refreshTimer = setInterval(() => {
            try {
                backlogItems(true);
            }
            catch (e) {
                console.error("бэклог:", e.message);
            }
        }, 60000);
        refreshTimer.unref();
    }
    if (req.method === "GET") {
        return h.send(res, 200, { dir: fwd(BACKLOG_DIR), tree: fwd(BACKLOG_WT), cli: BL_CLI, items: backlogItems().map(publicItem), statuses: STATUSES, words: STATUS_WORD, retro: retroTriageBrief(), epics: epicsPub(), agent: agentPublic(BACKLOG_KEY), dry: DRY, sink: SINK, now: Date.now() });
    }
    if (req.method !== "POST")
        return h.send(res, 404, { error: "нет такого адреса" });
    if (req.headers["x-dash-token"] !== h.token)
        return h.send(res, 403, { error: "нет токена запуска: обновите страницу" });
    const b = await h.readBody(req);
    const g = h.gate(b);
    if (g)
        return h.send(res, 403, g);
    if (DRY && !process.env.DASH_DATA)
        return h.send(res, 403, { error: "сухой режим без своей папки данных: бэклог только для чтения" });
    try {
        const r = await backlogOp(b);
        bumpVer("post:backlog");
        return h.send(res, r.code, r.body);
    }
    catch (e) {
        return h.send(res, e.code === 404 ? 404 : 500, { error: e.message });
    }
}
