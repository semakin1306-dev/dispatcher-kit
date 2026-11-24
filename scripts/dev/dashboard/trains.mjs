// trains.mjs — слоты-поезда на сервере диспетчерской: состояние поездов (файл trains.json, владелец поля S.trains — этот
// модуль), очередь вагонов дерева по git для снимка (applyTrain), выдача следующего вагона агенту той же сессии после
// влива и подпись влива с номерами вагонов. Правила — train-rules.mjs.
import path from "node:path";
import { readJson, saveJson } from "./store.mjs";
import { S } from "./state.mjs";
import { DATA, DRY, logEvent } from "./config.mjs";
import { agents, agentSession, deliver, genSlotPrompt, push, sendWhenFree, startAgent } from "./agents.mjs";
import { syncSlot } from "./epics.mjs";
import { git, stagingTreeSha } from "./git.mjs";
import { snapNow } from "./snapshot.mjs";
import { setTrainPresets, treeByKey } from "./trees.mjs";
import { slotDoneOf, waveFinalOf } from "./slot-done.mjs";
import { jobList } from "./jobs.mjs";
import { late } from "./late.mjs";
import { MERGE_LOG_FORMAT, WAVE_LOG_FORMAT, parseWaveLog, queueState, stagedMarks, trainMergeMessage, wagonOfTree } from "./train-rules.mjs";

const { wagonPlanFile } = late("stations.mjs", ["wagonPlanFile"]);
export const TRAINS_FILE = path.join(DATA, "trains.json");

export function normTrainRec(v) {
    const r = v && typeof v === "object" ? v : {}, out = {};
    if (r.issued) {
        out.issued = String(r.issued);
        if (r.issuedAt)
            out.issuedAt = r.issuedAt;
    }
    if (r.times && typeof r.times === "object")
        out.times = r.times;
    if (r.landed && typeof r.landed === "object")
        out.landed = r.landed;
    return out;
}

export function loadTrains() {
    const raw = readJson(TRAINS_FILE, {}) || {}, norm = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, normTrainRec(v)]));
    S.trains = norm;
    if (!DRY && JSON.stringify(raw) !== JSON.stringify(norm))
        saveJson(TRAINS_FILE, S.trains, 1);
}

const save = () => saveJson(TRAINS_FILE, S.trains, 1);
const rec = (key) => (S.trains || {})[key] || {};
export const trainOf = (key) => ({ ...rec(key) });
export const trainsAll = () => ({ ...(S.trains || {}) });

function patch(key, p) {
    if (!S.trains)
        S.trains = {};
    S.trains[key] = { ...(S.trains[key] || {}), ...p };
    save();
    return S.trains[key];
}

function patchTimes(key, wave, p) {
    const r = rec(key), times = { ...(r.times || {}) };
    times[wave] = { ...(times[wave] || {}), ...p };
    return patch(key, { times });
}

export function markIssued(key, wave, at = Date.now()) {
    if (rec(key).issued === wave)
        return;
    patch(key, { issued: wave, issuedAt: at });
    patchTimes(key, wave, { issuedAt: at });
    logEvent("train.wagon", { tree: key, wave });
}

export function markLanded(key, wave, sha, at = Date.now()) {
    const landed = { ...(rec(key).landed || {}), [wave]: { sha, at } };
    patch(key, { landed });
    logEvent("train.wagon.landed", { tree: key, wave, sha });
}

const landedAll = () => Object.values(S.trains || {}).reduce((m, r) => Object.assign(m, r.landed || {}), {});
let stagedCache = { tree: "", set: new Set(), marks: new Map(), at: 0 };

export async function stagedInfo(cwd) {
    const tree = stagingTreeSha();
    if (stagedCache.tree && stagedCache.tree === tree && Date.now() - stagedCache.at < 10 * 60e3)
        return stagedCache;
    const [r, m] = await Promise.all([git(cwd, ["log", "staging", "-E", "--grep=^Wave: WV-", "-400", "--format=" + WAVE_LOG_FORMAT], 60000, true),
        git(cwd, ["log", "staging", "--merges", "--grep=поезд", "-200", "--format=" + MERGE_LOG_FORMAT], 60000, true)]);
    const marks = stagedMarks(parseWaveLog(r.out), m.out), v = { tree, set: new Set(marks.keys()), marks, at: Date.now() };
    if (r.ok && m.ok)
        stagedCache = v;
    return v;
}

const timesOf = (r, w, x, mk) => ({ issuedAt: ((r.times || {})[w] || {}).issuedAt || 0, firstCommitAt: x.firstAt || (mk && mk.firstAt) || 0,
    doneAt: ((r.times || {})[w] || {}).doneAt || 0, doneSha: ((r.times || {})[w] || {}).doneSha || "", mergedAt: x.state === "staging" && mk ? mk.mergedAt || 0 : 0, mergeSha: x.state === "staging" && mk ? mk.mergeSha || "" : "" });

const stagedBySubject = new Map();

async function stagedCommitsOf(cwd, wave) {
    const k = stagingTreeSha() + "|" + wave;
    if (stagedBySubject.has(k))
        return stagedBySubject.get(k);
    const r = await git(cwd, ["log", "staging", "--no-merges", "-F", "--grep=" + wave, "-200", "--format=%h"], 60000, true);
    const n = r.ok ? String(r.out || "").split(/\r?\n/).filter(Boolean).length : 0;
    if (r.ok) {
        if (stagedBySubject.size > 200)
            stagedBySubject.clear();
        stagedBySubject.set(k, n);
    }
    return n;
}

export async function applyTrain(t) {
    if (!t || !t.train || !t.exists)
        return t;
    const [own, st] = await Promise.all([
        git(t.path, ["log", "--no-merges", "staging..HEAD", "--format=" + WAVE_LOG_FORMAT], 60000, true).then((r) => parseWaveLog(r.out, { bySubject: true })),
        stagedInfo(t.path)
    ]);
    const landed = landedAll(), staged = new Set([...st.set, ...Object.keys(landed)]);
    const markOf = (w) => st.marks.get(w) || (landed[w] ? { firstAt: 0, lastAt: 0, mergedAt: landed[w].at, mergeSha: landed[w].sha } : undefined);
    const qs = queueState({ wagons: t.wagons || [], own, staged, depOk: (d) => staged.has(d.split("@")[0]) });
    const head = qs.list.find((x) => x.wave === qs.head);
    if (head && head.commits > 0 && rec(t.key).issued !== head.wave)
        markIssued(t.key, head.wave, head.firstAt || Date.now());
    const r0 = rec(t.key), wave = wagonOfTree(qs, r0.issued || "");
    if (head && wave === head.wave && head.commits > 0 && !((r0.times || {})[wave] || {}).doneAt && waveFinalOf(t)) {
        const sd = slotDoneOf(t.key);
        patchTimes(t.key, wave, { doneAt: (sd && sd.fp === t.fp && sd.at) || Date.now(), doneSha: (t.last && t.last.sha) || "" });
    }
    const r = rec(t.key), reg = (w) => (t.wagons || []).find((z) => z.wave === w) || {};
    Object.assign(t, { wagons: qs.list.map((x) => ({ ...x, after: reg(x.wave).after || [], times: timesOf(r, x.wave, x, markOf(x.wave)) })),
        wagon: wave, wave: wave ? wave.toLowerCase() : "", head: qs.head, current: qs.current, issued: r.issued || "" });
    {
        const hw = head && wave === head.wave && !head.commits ? wave : "";
        t.wagonStaged = hw ? await stagedCommitsOf(t.path, hw).catch(() => 0) : 0;
    }
    setTrainPresets(t.key, reg(wave).presets || [], wave);
    return t;
}

export function nextWagonText({ tag, prev = "", wave, title = "", plan = "", presets = [] }) {
    return ["[Диспетчерская, поезд " + tag + "] " + (prev ? "Вагон " + prev + " влит в staging, ветка поезда подтянула staging. " : "") + "Следующий вагон очереди — " + wave + (title ? " «" + title + "»" : "") + ".",
        plan ? "План вагона: " + plan + " — прочитай его целиком и работай по станциям плана так же, как с прошлым вагоном (разведка, красный тест, код, спека приёмки, доклад)." : "Плана вагона в папке оркестратора не нашлось — спроси оркестратора, прежде чем писать код.",
        "Код прошлых вагонов уже в staging — его не переделывай. Коммиты этого вагона — тема «тип(область): " + wave + " — суть» и строка «Wave: " + wave + "» в последнем абзаце (навык slot-commit)." + (presets.length ? " Тесты вагона: " + presets.map((p) => p.task + (p.input ? " " + p.input : "")).join(", ") + " — их запустит диспетчерская." : "")].join("\n\n");
}

const issuing = new Set();

export async function issueWagon(t, wave, { by = "автопоезд" } = {}) {
    if (!t || !t.train || !wave)
        return { ok: false, why: "не поезд или нет вагона" };
    if (issuing.has(t.key))
        return { ok: false, why: "вагон уже выдаётся" };
    issuing.add(t.key);
    try {
        const a = agents.get(t.key);
        if (a && !a.dead && ((a.busy && !a.pinging) || (a.pending && a.pending.size)))
            return { ok: false, why: "агент поезда сейчас отвечает — вагон выдам после его хода" };
        const live = (jobList() || []).filter((j) => j.tree === t.key && ["running", "queued", "waiting"].includes(j.status));
        if (live.length) {
            const why = "по поезду идут прогоны (" + live.map((j) => j.task).join(", ") + ") — вагон " + wave + " выйдет после их итога";
            logEvent("train.issue.held", { tree: t.key, wave, by, why });
            return { ok: false, why };
        }
        if (t.ahead > 0 || (t.dirtyTracked || 0) + (t.dirtyUntracked || 0) > 0)
            return { ok: false, why: "в ветке поезда невлитый код — следующий вагон после влива в staging" };
        const x = treeByKey(t.key), w = (t.wagons || []).find((z) => z.wave === wave) || {}, prev = rec(t.key).issued || "";
        if (t.behind > 0 && x && !DRY) {
            const s = await syncSlot(x, { ffOnly: true, why: "поезд: следующий вагон" }).catch((e) => ({ fail: e.message }));
            if (!s.ok)
                return { ok: false, why: "ветка поезда не подтянула staging: " + (s.skip || s.fail || "конфликт") };
        }
        markIssued(t.key, wave);
        const reg = ((x && x.wagons) || []).find((z) => z.wave === wave) || {};
        if (x)
            setTrainPresets(t.key, reg.presets || [], wave);
        logEvent("train.issue", { tree: t.key, wave, by });
        if (DRY)
            return { ok: true, why: "сухой режим: вагон отмечен выданным, агент не запускается" };
        if (agentSession(t.key)) {
            let plan = "";
            try {
                plan = (wagonPlanFile(t, wave) || "").replace(/\\/g, "/");
            }
            catch { }
            sendWhenFree(t.key, nextWagonText({ tag: t.tag, prev, wave, title: w.title || reg.title || "", plan, presets: reg.presets || [] }));
            return { ok: true, why: "вагон " + wave + " отдан агенту поезда в его сессию" };
        }
        const prompt = genSlotPrompt(t.key);
        if (!prompt)
            return { ok: false, why: "стартовый промпт не собран (нет папки оркестратора эпика)" };
        const b = await startAgent(t.key, { resume: false });
        push(b, { id: "wagon-" + b.rev, t: "status", text: "Поезд " + t.tag + ": вагон " + wave + " (" + by + ")." });
        deliver(b, prompt, "wagon");
        return { ok: true, why: "вагон " + wave + " выдан агенту поезда стартовым промптом" };
    }
    finally {
        issuing.delete(t.key);
    }
}

export function trainMergeNote(key, branch) {
    const t = treeByKey(key);
    if (!t || !t.train)
        return null;
    const snap = ((snapNow() || {}).trees || []).find((x) => x.key === key), ws = (snap && snap.wagons) || [];
    const waves = ws.filter((w) => w.commits > 0).map((w) => w.wave), list = waves.length ? waves : snap && snap.wagon ? [snap.wagon] : [];
    if (!list.length)
        return null;
    const n = Math.max(0, ws.findIndex((w) => w.wave === list[0])) + 1;
    return trainMergeMessage(branch, t.tag, n, list);
}
