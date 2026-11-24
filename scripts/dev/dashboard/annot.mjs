// annot.mjs — разметка документов и правок человеком: замечания к плану волны, к диффу слота и к карточке бэклога уходят
// агенту одним сообщением; одобрение плана ставит отметку станции; ответ на вопрос агента (со страницы или из бота) идёт
// в его сессию.
import { fwd } from "../slots.mjs";
import fs from "node:fs";
import path from "node:path";
import { readJson, saveJson } from "./store.mjs";
import { DATA, DRY, logEvent } from "./config.mjs";
import { agentSession, agents, ensureAgent, push, rotateOrchIfDue, sendUserText, sendWhenFree } from "./agents.mjs";
import { accEntryOfTree } from "./accept.mjs";
import { branchChanges } from "./changes.mjs";
import { epicOfKey, isOrch, orchOfKey, treeByKey } from "./trees.mjs";
import { exists, git } from "./git.mjs";
import { inboxCards, keepCards, saveInbox } from "./inbox.mjs";
import { sendToAgent } from "./relay.mjs";
import { markStage, planFileOf } from "./stations.mjs";
import { snapNow } from "./snapshot.mjs";
import { answerRoute, answerText, approveMessage, diffHunks, diffMessage, diffStat, docMessage, lineDiff, mdBlocks, normNote, textHash } from "./annot-rules.mjs";
import { viaNote } from "./owner-word.mjs";
import { backlogDoc } from "./backlog.mjs";

export const ANNOT_FILE = path.join(DATA, "annot.json"), OUTBOX = path.join(DATA, "annot-outbox.jsonl");
export const SINK = DRY || process.env.DASH_ANNOT_SINK === "log" ? "log" : "agent";
const A = Object.assign({ notes: {}, seen: {}, review: {}, approved: {}, sent: [] }, readJson(ANNOT_FILE, {}));

const saveA = () => {
    if (A.sent.length > 200)
        A.sent = A.sent.slice(-200);
    saveJson(ANNOT_FILE, A);
};

const treeOf = (k) => (snapNow() && snapNow().trees.find((x) => x.key === k)) || treeByKey(k) || null;
const nid = () => "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

const epOf = (k) => {
    try {
        return epicOfKey(k);
    }
    catch {
        return null;
    }
};

const waveOf = (t) => String((t && t.wave) || "").toUpperCase();

const read = (f) => {
    try {
        const s = fs.readFileSync(f, "utf8");
        return s.length > 400000 ? s.slice(0, 400000) : s;
    }
    catch {
        return null;
    }
};

function orchDocFile(key, which) {
    const o = treeByKey(isOrch(key) ? key : orchOfKey(key));
    if (!o || !o.path)
        return null;
    const re = which === "epic" ? /^_EPIC.*\.md$/i : /^MASTER.*\.md$/i;
    for (const d of [path.join(o.path, ".claude", "plans", "waves"), path.join(o.path, ".claude", "plans")]) {
        try {
            const f = fs.readdirSync(d).filter((x) => re.test(x)).sort()[0];
            if (f)
                return path.join(d, f);
        }
        catch { }
    }
    return null;
}

const accEntryOf = accEntryOfTree;

export function checklistText(t, e) {
    const st = { ok: "✓ работает", bad: "✗ не работает", todo: "не отмечен" };
    return ["# Чек-лист приёмки " + (t.tag || t.key) + " · " + waveOf(t), "", ...(e.items || []).map((x) => "- **" + x.id + "** · где: `" + (x.where || "—") + "` · сделать: " + (x.todo || "—") + " · ожидается: " + (x.expect || "—") + " · проверка: " + (x.how || "—") + " · " + (st[x.state] || x.state) + (x.comment ? " · комментарий: " + x.comment : ""))].join("\n");
}

export function docOf(key, doc) {
    if (doc === "backlog")
        return backlogDoc(key);
    const t = treeOf(key);
    if (!t)
        return null;
    const orch = isOrch(key) ? key : orchOfKey(key), base = { tree: key, tag: t.tag || (isOrch(key) ? "ОРК" : key), title: t.title || "", wave: waveOf(t), epic: t.epic || epOf(key) || null, orch };
    if (doc === "checklist") {
        const e = accEntryOf(key);
        if (!e || !(e.items || []).length)
            return null;
        return { ...base, kind: "checklist", key: "checklist|" + key, file: null, text: checklistText(t, e), to: key };
    }
    if (doc === "epic" || doc === "master") {
        const f = orchDocFile(key, doc);
        const text = f && read(f);
        return text == null ? null : { ...base, kind: doc, key: doc + "|" + orch, file: fwd(f), text, to: orch };
    }
    if (doc === "diff")
        return { ...base, kind: "diff", key: "diff|" + key + "|" + (t.branch || ""), branch: t.branch || "", to: key };
    const f = isOrch(key) ? orchDocFile(key, "epic") : planFileOf(t), text = f && read(f);
    return text == null ? null : { ...base, kind: "plan", key: "plan|" + key, file: fwd(f), text, to: isOrch(key) ? orch : key };
}

const markSeen = (d, why) => {
    if (d.text != null)
        A.seen[d.key] = { hash: textHash(d.text), text: d.text, at: Date.now(), why };
};

const reviewKey = (d) => d.tree + "|" + (d.branch || "");

export async function annotGet(key, doc) {
    const d = docOf(key, doc);
    if (!d)
        return { code: 404, body: { error: doc === "checklist" ? "у волны нет чек-листа приёмки" : "документа нет (плана волны не нашла)" } };
    const notes = A.notes[d.key] || [], out = { key: d.key, kind: d.kind, tree: d.tree, tag: d.tag, title: d.title, wave: d.wave, epic: d.epic, file: d.file || null, to: d.to, orch: d.orch, agent: d.agent || null, notes, sink: SINK, approved: A.approved[d.key] || null };
    if (d.kind === "diff") {
        const t = treeOf(key);
        out.branch = d.branch;
        out.review = A.review[reviewKey(d)] || null;
        out.files = t && exists(t.path) ? await branchChanges(t.path) : [];
        return { code: 200, body: out };
    }
    out.blocks = mdBlocks(d.text);
    const seen = A.seen[d.key], h = textHash(d.text);
    if (!seen) {
        markSeen(d, "первое открытие");
        saveA();
    }
    else if (seen.hash !== h) {
        const ops = lineDiff(seen.text, d.text);
        out.changed = { at: seen.at, why: seen.why || "", ...diffStat(ops), hunks: diffHunks(ops).slice(0, 3000), added: ops.filter((o) => o.t === "+").map((o) => o.b) };
    }
    return { code: 200, body: out };
}

async function deliverTo(key, text, kind) {
    if (SINK === "log") {
        fs.appendFileSync(OUTBOX, JSON.stringify({ at: Date.now(), to: key, kind, text }) + "\n");
        logEvent("annot.logged", { to: key, kind, chars: text.length });
        return { ok: true, logged: true };
    }
    const r = await sendToAgent(key, text);
    if (r.code === 409) {
        sendWhenFree(key, text);
        return { ok: true, queued: true };
    }
    if (r.code !== 200)
        throw Object.assign(new Error((r.body && r.body.error) || "не отправлено"), { code: r.code });
    logEvent("annot.sent", { to: key, kind, chars: text.length });
    return { ok: true };
}

const sentWord = (r, who) => r.logged ? "собрано (отладка: в журнал annot-outbox.jsonl, агенту не ушло)" : r.queued ? who + " сейчас отвечает — уйдёт в конце ответа" : "отправлено " + who;
const whoOf = (key) => isOrch(key) ? "оркестратору" : key === "backlog" ? "агенту бэклога" : "агенту " + ((treeOf(key) || {}).tag || key);

export async function annotPost(b) {
    const op = String(b.op || ""), d = docOf(String(b.tree || ""), String(b.doc || "plan"));
    if (!d)
        return { code: 404, body: { error: "документа нет" } };
    const list = A.notes[d.key] || (A.notes[d.key] = []), blocks = d.text != null ? mdBlocks(d.text) : null;
    const reply = (extra = {}) => ({ code: 200, body: { ok: true, notes: A.notes[d.key] || [], ...extra } });
    if (op === "add") {
        const n = normNote(b.note, blocks);
        if (!n)
            return { code: 400, body: { error: "пустое замечание или неверное место" } };
        if (d.kind === "checklist") {
            const bl = blocks.find((x) => x.i === n.block), m = bl && /\*\*([^*]+)\*\*/.exec(bl.text);
            if (m)
                n.item = m[1];
        }
        if (list.length >= 200)
            return { code: 409, body: { error: "замечаний уже 200 — отправьте их агенту" } };
        list.push({ id: nid(), ...n });
        saveA();
        return reply();
    }
    if (op === "edit") {
        const i = list.findIndex((x) => x.id === b.id);
        if (i < 0)
            return { code: 404, body: { error: "нет такого замечания" } };
        const n = normNote({ ...list[i], ...(b.note || {}), at: list[i].at, ...(list[i].path === undefined ? { block: list[i].block, blockEnd: list[i].blockEnd, sel: list[i].sel } : {}) }, blocks);
        if (!n)
            return { code: 400, body: { error: "пустое замечание" } };
        list[i] = { ...list[i], ...n };
        saveA();
        return reply();
    }
    if (op === "del") {
        A.notes[d.key] = list.filter((x) => x.id !== b.id);
        saveA();
        return reply();
    }
    if (op === "clear") {
        A.notes[d.key] = [];
        saveA();
        return reply();
    }
    if (op === "seen") {
        markSeen(d, "отмечено просмотренным");
        saveA();
        return reply({ message: "Версия отмечена просмотренной" });
    }
    const general = String(b.general || "").trim().slice(0, 3000);
    const to = b.to && (b.to === d.orch || b.to === (d.agent || d.tree)) ? b.to : d.to;
    if (op === "preview" || op === "send") {
        if (!list.length && !general)
            return { code: 409, body: { error: "замечаний нет" } };
        const text = d.kind === "diff" ? diffMessage(d, list, general) : docMessage(d, list, general);
        if (op === "preview")
            return reply({ text, to });
        const r = await deliverTo(to, text, "annot." + d.kind);
        A.sent.push({ key: d.key, to, at: Date.now(), n: list.length, logged: !!r.logged });
        A.notes[d.key] = [];
        if (d.kind === "diff")
            A.review[reviewKey(d)] = { state: "sent", at: Date.now(), n: list.length };
        else
            markSeen(d, "замечания отправлены (" + list.length + ")");
        saveA();
        return reply({ text, to, ...r, message: "Замечания (" + list.length + "): " + sentWord(r, whoOf(to)) });
    }
    if (op === "review-ok" && d.kind === "diff") {
        A.review[reviewKey(d)] = { state: "ok", at: Date.now(), n: 0 };
        saveA();
        logEvent("annot.review-ok", { tree: d.tree, branch: d.branch });
        return reply({ review: A.review[reviewKey(d)], message: "Ревью владельца: ОК" });
    }
    if (op === "approve" && d.kind !== "diff" && d.kind !== "backlog") {
        const text = approveMessage(d, general), r = await deliverTo(to, text, "annot.approve");
        A.approved[d.key] = { at: Date.now(), hash: textHash(d.text) };
        markSeen(d, "одобрено");
        saveA();
        let mark = "";
        if (d.kind === "plan" && !isOrch(d.tree)) {
            const t = treeOf(d.tree);
            if (t && exists(t.path)) {
                const br = (await git(t.path, ["rev-parse", "--abbrev-ref", "HEAD"])).out, k = d.tree + "|" + br;
                markStage(k, "plan", true);
                logEvent("stage.mark", { tree: d.tree, stage: "plan", value: true, by: "одобрение плана" });
                mark = "; станция «План» отмечена";
            }
        }
        logEvent("plan.approved", { tree: d.tree, wave: d.wave || null, epic: d.epic || null });
        return reply({ ...r, message: "План одобрен: " + sentWord(r, whoOf(to)) + mark });
    }
    return { code: 400, body: { error: "op: add, edit, del, clear, seen, preview, send, approve, review-ok" } };
}

export function liveIds(key, a) {
    const s = agentSession(key);
    return a && a.sessionId ? [a.sessionId, ...(s && s.id === a.sessionId ? s.prev || [] : [])] : [];
}

const answerHooks = [];

export const onOwnerAnswer = (fn) => {
    answerHooks.push(fn);
};

export async function ownerAnswer(tree, answer, id, { via = "" } = {}) {
    const ans = String(answer || "").trim();
    if (!ans)
        return { code: 400, body: { error: "пустой ответ" } };
    const it = inboxCards().find((x) => x.kind === "ownerq" && x.tree === tree && (!id || x.id === id));
    if (!it)
        return { code: 404, body: { error: "вопроса уже нет — ответьте в чате агента" } };
    const t = treeOf(tree) || {}, plan = !isOrch(tree) && t.wave ? planFileOf(t) : null;
    const ctx = { orch: isOrch(tree), tag: t.tag, wave: waveOf(t), branch: t.branch, plan: plan ? fwd(plan) : "" };
    let route, a = null;
    if (SINK === "log") {
        a = agents.get(tree);
        route = a && !a.dead && liveIds(tree, a).includes(it.sid) ? "same" : "other";
        ctx.why = route === "same" ? "" : a && !a.dead ? "сейчас другая сессия" : "агент не запущен";
    }
    else {
        a = agents.get(tree);
        if (!a || a.dead)
            a = await ensureAgent(tree);
        a = await rotateOrchIfDue(a);
        route = it.sid && liveIds(tree, a).includes(it.sid) ? "same" : answerRoute(it.sid, a.sessionId);
        ctx.why = !it.sid ? "вопрос записан без id сессии" : a.sessionId ? "сейчас сессия " + String(a.sessionId).slice(0, 8) : "начата новая сессия";
    }
    const text = answerText(it, ans, route, ctx) + viaNote(via);
    if (SINK === "log")
        fs.appendFileSync(OUTBOX, JSON.stringify({ at: Date.now(), to: tree, kind: "ownerq.answer", route, sid: it.sid || null, text }) + "\n");
    else {
        // ответ владельца — с пометкой источника: по ней owner-word.mjs решает, на что слово годится
        await sendUserText(tree, text, { by: via || "", owner: true });
    }
    logEvent("owner.answer", { key: tree, route, sid: it.sid || null, live: a && a.sessionId ? a.sessionId : null, chars: ans.length, logged: SINK === "log", ...(via ? { via } : {}) });
    keepCards((x) => !(x.tree === tree && (x.kind === "ownerq" || x.kind === "slotstart")));
    saveInbox();
    for (const fn of answerHooks) {
        try {
            fn({ id: it.id, tree, text: ans, via: via || "dashboard" });
        }
        catch (e) {
            console.error("подписчик ответа владельца:", e.message);
        }
    }
    return { code: 200, body: { ok: true, route, logged: SINK === "log", message: (SINK === "log" ? "Ответ собран (отладка: в журнал, агенту не ушёл)" : route === "same" ? "Ответ отправлен в ту же сессию" : "Сессия сменилась — ответ ушёл с цитатой вопроса") } };
}
