// retro.mjs — ретро эпика: после закрытия эпика разовый агент разбирает журнал событий, прогоны и провалы проверок и
// предлагает правки процесса (гард, навык, правило диспетчерской) — они заводятся карточками бэклога. Модуль включается
// в конфиге проекта и требует бэклога.
import fs from "node:fs";
import path from "node:path";
import { MAIN, PROJECT, WT, fwd } from "../slots.mjs";
import { moduleStates } from "../modules-catalog.mjs";
import { enabled } from "./modules.mjs";
import { runOnce } from "../runtimes/index.mjs";
import { S } from "./state.mjs";
import { DATA, DRY, EVENTS_JSONL, LOGS, RUNS_JSONL, logEvent, settings } from "./config.mjs";
import { readJson, saveJson, writeAtomicSync } from "./store.mjs";
import { epicsReg } from "./trees.mjs";
import { JOURNAL_BYTES, epicAny, readEventsSince } from "./epic-progress.mjs";
import { epicProgress } from "./epic-progress-rules.mjs";
import { journalCounts, journalLine, journalOf } from "./epic-journal.mjs";
import { NOT_CODE_TASKS, failSignatures, groupFailures } from "./retro-failures.mjs";
import { BACKLOG_DIR } from "./backlog-agent.mjs";
import { listItems } from "./backlog-store.mjs";
import { backlogOp } from "./backlog.mjs";
import { RETRO_JOURNAL_SKIP, epicWindow, ownedBy, failuresBrief, freshProposals, parseProposals, progressBrief, proposalItem, retroDoc, retroDue, retroPrompt } from "./retro-rules.mjs";

/** Модель ретро-агента: настройка страницы, иначе роль `review` конфига проекта; пусто — модель рантайма по умолчанию. */
export const RETRO_MODEL = () => settings.modelRetro || PROJECT.agent.models.review || "";

/** Включён ли модуль ретро в этой установке (он требует и бэклога: предложения ретро — карточки бэклога). */
export function retroEnabled(project = PROJECT) {
    if (project !== PROJECT) {
        const st = moduleStates(project).find((m) => m.id === "retro");
        return !!(st && st.on);
    }
    return enabled("retro");
}
export const RETRO_FILE = path.join(DATA, "retro.json");
export const RETRO_IN = path.join(DATA, "retro");
/** Куда пишутся документы ретро: в папку данных диспетчерской, не в репозиторий проекта. */
export const RETRO_DIR = path.resolve(process.env.DASH_RETRO_DIR || path.join(RETRO_IN, "docs"));
export const SINK = DRY || process.env.DASH_RETRO_SINK === "log" ? "log" : "agent";
export const RETRO_LIMIT_MS = 30 * 60e3;
export const RETRO_AUTO_MS = 10 * 60e3;

export function loadRetro() {
    const v = readJson(RETRO_FILE, null);
    S.retro = v && typeof v === "object" && v.epics ? v : { since: Date.now(), epics: {} };
    for (const r of Object.values(S.retro.epics))
        if (r.status === "running")
            Object.assign(r, { status: "fail", error: "прервано перезапуском диспетчерской", at: Date.now() });
    if (!DRY)
        saveJson(RETRO_FILE, S.retro);
}

const R = () => S.retro || (S.retro = { since: Date.now(), epics: {} });

const save = () => {
    if (!DRY)
        saveJson(RETRO_FILE, R());
};

const set = (id, patch) => {
    const r = R();
    r.epics[id] = { ...(r.epics[id] || {}), ...patch };
    save();
    return r.epics[id];
};

export const retroOf = (id) => R().epics[id] || null;
const running = new Set();

const readJsonl = async (file) => {
    try {
        return (await fs.promises.readFile(file, "utf8")).split("\n").filter((l) => l && l[0] === "{").map((l) => {
            try {
                return JSON.parse(l);
            }
            catch {
                return null;
            }
        }).filter(Boolean);
    }
    catch {
        return [];
    }
};

export async function allRuns(file = RUNS_JSONL) {
    const m = new Map();
    for (const r of await readJsonl(file))
        if (r.id)
            m.set(r.id, { ...(m.get(r.id) || {}), ...r });
    return [...m.values()];
}

const waveOf = (br) => {
    const m = /wv-?0*(\d{1,4})/i.exec(br || "");
    return m ? "WV-" + m[1].padStart(4, "0") : "";
};

function epicPlans(epic) {
    const dirs = [path.join(MAIN, ".claude", "plans", "waves"), epic.orch && epic.orch.path ? path.join(epic.orch.path, ".claude", "plans", "waves") : ""].filter(Boolean), out = [];
    for (const d of dirs) {
        let fs_ = [];
        try {
            fs_ = fs.readdirSync(d).filter((f) => /^_EPIC-.*\.md$/i.test(f));
        }
        catch {
            continue;
        }
        for (const f of fs_) {
            const p = path.join(d, f);
            try {
                if (f.includes(epic.id) || fs.readFileSync(p, "utf8").slice(0, 6000).includes(epic.id))
                    out.push(fwd(p));
            }
            catch { }
        }
        if (out.length)
            break;
    }
    return out;
}

export async function retroInput(epic, { now = Date.now(), events = null, runs = null } = {}) {
    events = events || await readEventsSince(EVENTS_JSONL, 0, JOURNAL_BYTES);
    runs = runs || await allRuns();
    const { from, to } = epicWindow(epic, events, runs, now);
    const keys = new Set([...(epic.slots || []).map((x) => x.slot), "orchestrator@" + epic.id]);
    const progress = epicProgress({ epic, events, runs, now: to, windowMs: Math.max(to - from + 60e3, 3600e3) });
    const entries = [];
    for (const j of runs) {
        if (j.status !== "fail" || !ownedBy(j, epic.id, keys))
            continue;
        const at = j.endedAt || j.startedAt || j.queuedAt || 0;
        if (at < from || at > to)
            continue;
        let text = "";
        try {
            text = await fs.promises.readFile(path.join(LOGS, j.id + ".log"), "utf8");
        }
        catch {
            continue;
        }
        const sigs = failSignatures(j, text, { roots: [MAIN, WT] }).filter((s) => !NOT_CODE_TASKS.has(j.task) || s.cat === "infra" || s.cat === "env");
        if (sigs.length)
            entries.push({ job: j, sigs });
    }
    const groups = groupFailures(entries);
    const journal = journalOf(events, { epic: epic.id, keys: [...keys], from, to });
    const dir = path.join(RETRO_IN, epic.id);
    fs.mkdirSync(dir, { recursive: true });
    const files = { progress: fwd(path.join(dir, "progress.json")), failures: fwd(path.join(dir, "failures.md")), journal: fwd(path.join(dir, "journal.txt")), logs: fwd(LOGS), plans: epicPlans(epic), plansDir: fwd(path.join(MAIN, ".claude", "plans", "waves")) };
    writeAtomicSync(files.progress, JSON.stringify(progress, null, 1));
    writeAtomicSync(files.failures, "# Группы провалов эпика " + epic.id + "\n\nКрасных прогонов с логом: " + entries.length + ", групп: " + groups.length + ".\n\n" + failuresBrief(groups) + "\n");
    writeAtomicSync(files.journal, journal.filter((e) => !RETRO_JOURNAL_SKIP.has(e.type)).map(journalLine).join("\n") + "\n");
    const waves = (epic.slots || []).map((x) => ({ tag: x.tag, wave: waveOf(x.branch), title: x.title || "", archived: !!x.archived }));
    let made = [];
    try {
        made = listItems(BACKLOG_DIR).filter((it) => it.retro === epic.id).map((it) => ({ id: it.id, title: String(it.title || "").slice(0, 200) }));
    }
    catch { }
    const prompt = retroPrompt({ epic, from, to, waves, brief: progressBrief(progress), counts: journalCounts(journal), files, made });
    writeAtomicSync(path.join(dir, "prompt.txt"), prompt);
    return { dir, prompt, from, to, groups, progress, journalN: journal.length };
}

/**
 * Ретро-агент — разовый запуск рантайма: только чтение (без оболочки), видит папку входа, логи прогонов и папки планов.
 * Ответ — текст ретро; его разбирает retroFinish.
 */
export async function runAgent(id, { prompt, dir, plans }) {
    const model = RETRO_MODEL(), logf = path.join(dir, "agent.log");
    const addDirs = [fwd(dir), fwd(LOGS), ...new Set(plans.map((p) => fwd(path.dirname(p))))];
    running.add(id);
    let r;
    try {
        r = await runOnce({ prompt, cwd: MAIN, model, readOnly: true, allowBash: false, addDirs, maxTurns: 80, timeoutMs: RETRO_LIMIT_MS });
    }
    finally {
        running.delete(id);
    }
    const text = String((r && r.text) || "");
    try {
        writeAtomicSync(logf, "── ответ ретро-агента" + (model ? " (" + model + ")" : "") + " ──\n" + text + "\n── код " + (r ? r.code : "?") + " ──\n");
    }
    catch { }
    if (r && r.ok && text.trim())
        return { text, model };
    throw new Error("ретро-агент завершился с кодом " + (r ? r.code : "?") + (text.trim() ? ": " + text.trim().split("\n").slice(-2).join(" ").slice(0, 300) : ""));
}

export async function retroFinish(epic, { text, model = "", from, to, dir }, { now = Date.now(), addItem = (b) => backlogOp({ op: "add", ...b }), items = () => listItems(BACKLOG_DIR) } = {}) {
    fs.mkdirSync(RETRO_DIR, { recursive: true });
    const file = path.join(RETRO_DIR, epic.id + ".md");
    const props = freshProposals(parseProposals(text), items(), epic.id), made = [];
    for (const p of props) {
        try {
            const r = await addItem(proposalItem(p, { epic: epic.id, doc: fwd(file) }));
            if (r && r.body && r.body.item)
                made.push({ id: r.body.item.id, kind: p.kind, title: p.title });
        }
        catch (e) {
            console.error("ретро → бэклог:", e.message);
        }
    }
    writeAtomicSync(file, retroDoc({ epic, from, to, at: now, text, items: made, model, input: dir ? fwd(dir) : "" }));
    return { file: fwd(file), items: made };
}

export async function retroStart(id, { by = "кнопка", force = false } = {}) {
    const epic = epicAny(String(id || ""));
    if (!epic)
        return { code: 404, body: { error: "нет такого эпика" } };
    const cur = retroOf(epic.id);
    if (cur && cur.status === "running")
        return { code: 409, body: { error: "ретро эпика уже идёт (с " + new Date(cur.startedAt).toLocaleTimeString("ru-RU") + ")" } };
    if (cur && cur.status === "ok" && !force)
        return { code: 409, body: { error: "ретро уже есть: " + cur.file + " — повтор с force", retro: cur } };
    if (!retroEnabled())
        return { code: 409, body: { error: "модуль ретро выключен в конфиге проекта (modules.retro; ему нужен и modules.backlog)" } };
    set(epic.id, { status: "running", startedAt: Date.now(), at: Date.now(), by, error: "", tries: ((cur && cur.status === "fail" && cur.tries) || 0) + 1 });
    logEvent("retro.start", { epic: epic.id, by, sink: SINK });
    let input;
    try {
        input = await retroInput(epic);
    }
    catch (e) {
        set(epic.id, { status: "fail", at: Date.now(), error: "вход не собран: " + e.message });
        logEvent("retro.fail", { epic: epic.id, why: e.message.slice(0, 200) });
        return { code: 500, body: { error: "вход ретро не собран: " + e.message } };
    }
    const base = { input: fwd(input.dir), from: input.from, to: input.to, groups: input.groups.length, journal: input.journalN };
    if (SINK === "log") {
        const r = set(epic.id, { ...base, status: "collected", at: Date.now() });
        return { code: 200, body: { ok: true, retro: r, message: "вход ретро собран в " + fwd(input.dir) + " (сухой режим: агент не запускался)" } };
    }
    set(epic.id, base);
    runAgent(epic.id, { prompt: input.prompt, dir: input.dir, plans: epicPlans(epic) })
        .then((a) => retroFinish(epic, { ...a, from: input.from, to: input.to, dir: input.dir }))
        .then((f) => {
        set(epic.id, { status: "ok", at: Date.now(), file: f.file, items: f.items.map((x) => x.id) });
        logEvent("retro.done", { epic: epic.id, file: f.file, items: f.items.length });
    })
        .catch((e) => {
        set(epic.id, { status: "fail", at: Date.now(), error: String(e.message).slice(0, 400) });
        logEvent("retro.fail", { epic: epic.id, why: String(e.message).slice(0, 200) });
        console.error("ретро " + epic.id + ":", e.message);
    });
    return { code: 202, body: { ok: true, retro: retroOf(epic.id), message: "ретро-агент запущен: эпик " + epic.id + ", вход — " + fwd(input.dir) } };
}

export async function retroAuto() {
    if (DRY || settings.retroAuto === false || !retroEnabled())
        return null;
    if (Object.values(R().epics).some((r) => r.status === "running"))
        return null;
    const due = retroDue(epicsReg(), R().epics, R().since || 0);
    if (!due.length)
        return null;
    const r = await retroStart(due[0], { by: "автоматически при закрытии эпика", force: true });
    if (r.code >= 400) {
        set(due[0], { status: "fail", at: Date.now(), error: r.body.error || "", tries: ((retroOf(due[0]) || {}).tries || 0) + 1 });
        console.error("ретро " + due[0] + ":", r.body.error);
    }
    return r;
}

export function retroGet(id) {
    const r = retroOf(id), e = epicAny(id);
    let text = "";
    if (r && r.file) {
        try {
            text = fs.readFileSync(r.file, "utf8").slice(0, 300000);
        }
        catch { }
    }
    return { code: 200, body: { epic: id, title: (e && e.title) || id, closedAt: (e && e.closedAt) || null, retro: r, text, auto: settings.retroAuto !== false, sink: SINK, dir: fwd(RETRO_DIR), running: running.has(id), enabled: retroEnabled() } };
}
