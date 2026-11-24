// accept.mjs — приёмка волн, влитых в staging (модуль `accept`).
//
// Путь волны: влита в staging → выкачена на стенд → диспетчерская просит у агента её слота чек-лист в строгом формате
// (accept-rules.mjs) → человек отмечает пункты ✓/✗, а команда приёмки проекта (accept.run) ставит «авто ✓/✗» по меткам
// [iN] в именах тестов → человек выносит вердикт → итоги уходят агентам и оркестратору. Вердикт ставит только человек.
//
// Команда приёмки идёт в основной папке проекта с окружением:
//   DISPATCHER_STAND_URL    — адрес стенда (accept.standUrl, иначе release.stand.url);
//   DISPATCHER_ACCEPT_SPEC  — файлы спек приёмки волн прогона через пробел (если задан accept.specGlob);
//   DISPATCHER_ACCEPT_WAVES — волны прогона (WV-NNNN через пробел);
//   DISPATCHER_ACCEPT_ITEMS — при перепрогоне части пунктов: регулярка меток «\[i1\]|\[i3\]» (для --grep, -t, -k).
// Изменяемое состояние — S.acc (записи приёмки), S.checklists (свободные чек-листы станции «На стенде»), S.reminders
// (напоминания «ПОСЛЕ ВЫКАТА»); пишет их только этот модуль.
import fs from "node:fs";
import path from "node:path";
import { MAIN, PROJECT } from "../slots.mjs";
import { enabled } from "./modules.mjs";
import { S } from "./state.mjs";
import { readJson, saveJson } from "./store.mjs";
import { DATA, FINAL, logEvent } from "./config.mjs";
import { bumpVer } from "./events.mjs";
import { snapNow } from "./snapshot.mjs";
import { jobList } from "./jobs.mjs";
import { epicById, epicOfKey, orchKey, treeByKey } from "./trees.mjs";
import { git } from "./git.mjs";
import { late, lateObject } from "./late.mjs";
import { isProduct } from "./fingerprint.mjs";
import { TASKS, globRe, stepOfTask } from "./tasks.mjs";
import { normWave, wavesOfMerge } from "./train-rules.mjs";
import { AUTO_CLOSE_TEXT, STAND_ASK as STAND_ASK_TEXT, accAdvance, accAutoCloseDue, accBaseKey, accFresh, accRestray, acceptAskText, acceptSpecAskText, applyResults, checklistForWave, itemsGrep, parseAcceptOutput, parseChecklist, remCmdRe, reminderLines, specsForWave, summaryText, verdictText } from "./accept-rules.mjs";

// runner.mjs и agents.mjs сами зовут этот модуль — с ними поздняя привязка (late.mjs, wiring.mjs)
const { enqueue, spawnStep } = late("runner.mjs", ["enqueue", "spawnStep"]);
const { agentCwd, deliver, ensureAgent, sendWhenFree } = late("agents.mjs", ["agentCwd", "deliver", "ensureAgent", "sendWhenFree"]);
const agents = lateObject("agents.mjs", "agents");

/** Модуль `accept` включён у этой установки (ключ `modules` конфига и наличие accept.run). */
export const acceptEnabled = () => enabled("accept");
export const STAND_URL = PROJECT.accept.standUrl || PROJECT.release.stand.url || "";
export const STAND_ASK = STAND_ASK_TEXT;
const STAGING_TREE = "orchestrator-staging";
const waveNum = (t) => (normWave(t.wave || t.branch || t.key) || "").slice(3);

// ───────────────────────────── свободный чек-лист станции «На стенде» ─────────────────────────────
export const CHK_FILE = path.join(DATA, "checklists.json");
export const saveChecklists = () => saveJson(CHK_FILE, S.checklists, 1);
export const chkKey = (treeKey, branch) => treeKey + "|" + (branch || "");
export const checklistOf = (key) => S.checklists[key];

/** Конец хода агента (agents.mjs): если ход был ответом на просьбу о чек-листе — забрать итоговый текст. */
export function captureReply(a) {
    const cap = a.capture;
    if (!cap)
        return;
    a.capture = null;
    // только итоговый ответ: текст после последнего вызова инструмента
    const since = a.items.filter((it) => it.rev > cap.startRev), lastTool = since.map((it) => it.t).lastIndexOf("tool");
    const tail = since.slice(lastTool + 1).filter((it) => it.t === "assistant");
    const txt = (tail.length ? tail : since.filter((it) => it.t === "assistant")).map((it) => it.text).join("\n\n").trim();
    if (!txt)
        return;
    if (cap.kind === "stand-checklist") {
        S.checklists[chkKey(cap.tree, cap.branch)] = { text: txt, at: Date.now() };
        saveChecklists();
    }
    if (cap.kind === "accept")
        acceptGot(cap, txt);
}

// ───────────────────────────── записи приёмки ─────────────────────────────
export const ACC_FILE = path.join(DATA, "acceptance.json");
export const saveAcc = () => saveJson(ACC_FILE, S.acc, 1);
/** Вливы ветки в staging, новые первыми. */
export const mergeShas = (t) => (t.merge ? t.merge.all || [t.merge.sha] : []);
export const accKey = (t) => accBaseKey(S.acc, t.key, mergeShas(t));
export const accEntry = (key) => S.acc[key];
export const accEnsure = (t) => {
    const k = accKey(t);
    return S.acc[k] || (S.acc[k] = accFresh(t.key, mergeShas(t)));
};
export const dropAccEntry = (key) => { delete S.acc[key]; };
export function loadAcceptance() {
    S.checklists = readJson(CHK_FILE, {}) || {};
    S.acc = readJson(ACC_FILE, {}) || {};
}

/** Принять ответ агента с чек-листом. */
export function acceptGot(cap, txt) {
    const k = cap.accKey, e = S.acc[k] || (S.acc[k] = { key: cap.tree });
    const w = checklistForWave(txt, cap.wave);
    const p = w.ok ? parseChecklist(txt) : { items: [], errors: [w.why] };
    if (!p.items.length) {
        e.raw = "Ответ не принят: " + p.errors.join("; ") + ". Спросите чек-лист повторно.\n\n" + txt;
        e.asking = false;
        logEvent("accept.checklist.rejected", { tree: cap.tree, wave: cap.wave || "", why: p.errors.join("; ").slice(0, 200) });
        saveAcc();
        return;
    }
    e.raw = (p.errors.length ? "Строки, которые не разобрались: " + p.errors.join("; ") + "\n\n" : "") + txt;
    e.items = p.items;
    e.gotAt = Date.now();
    e.asking = false;
    accRestray(e);
    saveAcc();
}

// Файлы продукта, которые принёс влив (влив не меняется — кеш вечный).
export const prodFilesCache = new Map();
const prodFilesTried = new Set();
export async function mergeProductFiles(sha) {
    if (!sha)
        return null;
    if (prodFilesCache.has(sha))
        return prodFilesCache.get(sha);
    const r = await git(MAIN, ["diff", "--name-only", sha + "~1", sha]);
    prodFilesTried.add(sha);
    if (!r.ok)
        return null;
    const v = r.out.split("\n").filter(Boolean).filter(isProduct);
    prodFilesCache.set(sha, v);
    return v;
}

// Вагоны поезда: у поезда приёмка по вагонам. Влив вагона — тот, в подписи которого он есть (wavesOfMerge).
const mergeWavesCache = new Map();
async function syncMergeWaves() {
    const shas = new Set();
    for (const t of (snapNow() ? snapNow().trees : []).filter((x) => x.train))
        for (const s of t.trainMerges || [])
            if (!mergeWavesCache.has(s))
                shas.add(s);
    await Promise.all([...shas].map(async (s) => {
        const r = await git(MAIN, ["log", "-1", "--format=%s", s]).catch(() => null);
        if (r && r.ok)
            mergeWavesCache.set(s, wavesOfMerge(r.out));
    }));
}
function trainAccWaves(t) {
    const all = t.trainMerges || [];
    return (t.wagons || []).filter((w) => w.state === "staging").map((w) => {
        const own = all.filter((s) => (mergeWavesCache.get(s) || []).includes(w.wave)), shas = own.length ? own : all;
        return { ...t, key: t.key + "#" + w.wave, wagonOf: t.key, train: false, wave: w.wave, tag: w.wave.replace(/^WV-/, ""), title: w.wave + (w.title ? " " + w.title : "") + " (" + t.tag + ")", branch: "train/" + w.wave.toLowerCase(), merge: { ...(t.merge || {}), sha: shas[0], all: shas } };
    });
}

/** Волны, которые ждут приёмки: в staging, но ещё не в прод-ветке. */
export function accWaves() {
    const out = [];
    for (const t of (snapNow() ? snapNow().trees : []).filter((x) => x.kind === "slot" && (x.train ? (x.trainMerges || []).length : x.merge) && !(x.stages || []).find((s) => s.id === "prod" && s.done)))
        out.push(...(t.train ? trainAccWaves(t) : [t]));
    return out;
}
/** Вагон поезда принят: запись <поезд>#WV-…|влив с вердиктом «принято». */
export const wagonAccepted = (treeKey, wave) => Object.entries(S.acc || {}).some(([k, e]) => k.startsWith(treeKey + "#" + wave + "|") && e.verdict === "accepted");

/** Запись приёмки волны — ждущей, иначе последняя с чек-листом (разметка человека, annot.mjs). */
export function accEntryOfTree(key) {
    const w = accWaves().find((x) => x.key === key);
    if (w && S.acc[accKey(w)])
        return S.acc[accKey(w)];
    return Object.entries(S.acc || {}).filter(([k, v]) => k.startsWith(key + "|") && v && (v.items || []).length).map(([, v]) => v).sort((a, b) => (b.gotAt || 0) - (a.gotAt || 0))[0] || null;
}

/** Довести записи ждущих волн до их последнего влива (по уже посчитанным файлам вливов, без git). */
export function accSyncAll() {
    let n = 0;
    for (const t of accWaves())
        if (accAdvance(S.acc, t.key, mergeShas(t), (s) => prodFilesCache.get(s)).changed)
            n++;
    if (n)
        saveAcc();
    return n;
}

// После запуска сервера, пока git не посчитал файлы вливов, записи не сведены: отметки не принимаются (409).
export const accSyncing = () => !S.accSyncedAt;
export const ACC_SYNCING_TEXT = "сводятся записи приёмки… (после запуска сервера git считает файлы вливов волн)";

/** Свести записи и закрыть «принято» волны, ни один влив которых не трогал код продукта. */
export async function acceptAutoClose() {
    let n = 0;
    await syncMergeWaves().catch(() => { });
    await Promise.all([...new Set(accWaves().flatMap(mergeShas))].filter((s) => !prodFilesCache.has(s)).map(mergeProductFiles));
    accSyncAll();
    if (!S.accSyncedAt && snapNow() && accWaves().every((t) => mergeShas(t).every((s) => prodFilesCache.has(s) || prodFilesTried.has(s)))) {
        S.accSyncedAt = Date.now();
        logEvent("accept.synced", { waves: accWaves().length });
        bumpVer("accept.synced");
    }
    for (const t of accWaves()) {
        const shas = mergeShas(t), e = S.acc[accKey(t)];
        if (!accAutoCloseDue(e, shas, (s) => prodFilesCache.get(s)))
            continue;
        const x = e || accEnsure(t);
        Object.assign(x, { verdict: "accepted", autoClosed: AUTO_CLOSE_TEXT, sentAt: Date.now(), sendNote: "закрыто автоматически, агенту не отправлялось" });
        n++;
    }
    if (n)
        saveAcc();
    return n;
}
const autoCloseTick = () => {
    if (snapNow() && Date.now() - (S.autoCloseAt || 0) > 60000) {
        S.autoCloseAt = Date.now();
        acceptAutoClose().catch((e) => console.error("приёмка: автозакрытие:", e.message));
    }
    accSyncAll();
};

// ───────────────────────────── спеки приёмки ─────────────────────────────
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", ".nuxt", ".output", "test-results", "playwright-report", "__pycache__", ".venv", "target"]);
let specCache = { at: 0, files: [] };
/** Файлы под accept.specGlob в основной папке проекта (кеш на 30 с). Шаблона нет — спек нет. */
export function acceptSpecFiles(root = MAIN, glob = PROJECT.accept.specGlob, now = Date.now()) {
    if (!glob)
        return [];
    if (root === MAIN && glob === PROJECT.accept.specGlob && now - specCache.at < 30000)
        return specCache.files;
    const re = globRe(glob), base = glob.replace(/\\/g, "/").split("/");
    const fixed = [];
    for (const p of base) {
        if (/[*?[{]/.test(p))
            break;
        fixed.push(p);
    }
    const out = [];
    const walk = (rel, depth) => {
        let es;
        try { es = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
        for (const e of es) {
            const r = rel ? rel + "/" + e.name : e.name;
            if (e.isDirectory()) {
                if (!SKIP_DIRS.has(e.name) && depth < 12)
                    walk(r, depth + 1);
            }
            else if (re.test(r))
                out.push(r);
        }
    };
    const start = fixed.length === base.length ? fixed.slice(0, -1).join("/") : fixed.join("/");
    walk(start, 0);
    out.sort();
    if (root === MAIN && glob === PROJECT.accept.specGlob)
        specCache = { at: now, files: out };
    return out;
}
export const specsOf = (t) => specsForWave(acceptSpecFiles(), t.wave || t.branch || t.key);

// ───────────────────────────── чек-лист у агента ─────────────────────────────
const askLive = (t) => jobList().some((j) => (j.accFor || j.tree) === t.key && j.task === "accept-ask" && !FINAL.includes(j.status));

/** Попросить чек-листы: keys — волны (null — все, у кого его ещё нет). Задача в очереди ждёт конца ответа агента. */
export async function acceptAsk(keys) {
    if (!acceptEnabled())
        return [];
    await acceptAutoClose().catch((e) => console.error("приёмка: автозакрытие:", e.message));
    const list = accWaves().filter((t) => (!keys || keys.includes(t.key)) && (keys || !((S.acc[accKey(t)] || {}).items || []).length) && !(S.acc[accKey(t)] || {}).verdict);
    const out = [];
    for (const t of list) {
        if (askLive(t))
            continue;
        const ak = t.wagonOf || t.key; // вагон поезда — чек-лист у агента поезда
        if (!agentCwd(ak)) {
            accEnsure(t).raw = "Папки слота нет (слот в архиве): чек-лист у агента не спросить. Поднимите слот или проверьте по плану волны.";
            saveAcc();
            continue;
        }
        const k = accKey(t), text = acceptAskText(t, { specs: specsOf(t), standUrl: STAND_URL, runnable: !!PROJECT.accept.run });
        out.push(await enqueue({ treeKey: ak, cwd: t.path, label: "Чек-лист приёмки" + (t.wagonOf ? " " + t.wave : ""), taskId: "accept-ask", lane: "commit", profile: "eco", extra: { pipeline: true, accFor: t.key },
            steps: [{ show: "чек-лист приёмки: спрашиваю агента " + t.tag, cwd: t.path, js: async (write) => {
                        let a = agents.get(ak);
                        if (!a || a.dead)
                            a = await ensureAgent(ak);
                        for (let i = 0; a.busy && i < 900; i++)
                            await new Promise((r) => setTimeout(r, 2000));
                        const e = S.acc[k] || (S.acc[k] = accFresh(t.key, mergeShas(t)));
                        e.asking = true;
                        saveAcc();
                        const gotBefore = e.gotAt || 0;
                        a.capture = { kind: "accept", tree: t.key, accKey: k, startRev: a.rev, wave: t.wagonOf ? t.wave : "" };
                        deliver(a, text);
                        await new Promise((r) => setTimeout(r, 3000));
                        const t0 = Date.now();
                        while (!a.dead && a.busy && Date.now() - t0 < 20 * 60000)
                            await new Promise((r) => setTimeout(r, 2000));
                        e.asking = false;
                        saveAcc();
                        const cur = S.acc[k] || {};
                        if ((cur.gotAt || 0) === gotBefore)
                            throw new Error(/^Ответ не принят/.test(cur.raw || "") ? String(cur.raw).split("\n")[0] : "новый чек-лист не пришёл — ответ агента в панели «Приёмка»");
                        write("✓ пунктов в чек-листе: " + (cur.items || []).length + "\n");
                    } }] }));
    }
    return out;
}

/** Попросить агента волны дописать тесты приёмки по пунктам чек-листа. → { code, body } */
export function acceptSpecAsk(t, e) {
    const ak = t.wagonOf || t.key;
    if (!agentCwd(ak))
        return { code: 409, body: { error: "агента этой волны сейчас не достать: откройте вкладку её эпика или поднимите слот" } };
    if (!(e.items || []).length)
        return { code: 409, body: { error: "у волны ещё нет чек-листа — сначала «Спросить чек-лист»" } };
    sendWhenFree(ak, acceptSpecAskText(t, e.items, { specGlob: PROJECT.accept.specGlob }));
    e.specAskedAt = Date.now();
    saveAcc();
    return { code: 200, body: { ok: true, message: "Агенту " + t.tag + " отправлено: дописать тесты приёмки по " + e.items.length + " пунктам" } };
}

// ───────────────────────────── прогон приёмки ─────────────────────────────

/** Окружение команды приёмки для волн ws. items — регулярка меток при перепрогоне части пунктов. */
export function acceptEnv(ws, { items = "", standUrl = STAND_URL, specs = (t) => specsOf(t) } = {}) {
    const env = { DISPATCHER_STAND_URL: standUrl, DISPATCHER_ACCEPT_WAVES: ws.map((t) => normWave(t.wave || t.branch || t.key)).filter(Boolean).join(" ") };
    if (PROJECT.accept.specGlob)
        env.DISPATCHER_ACCEPT_SPEC = [...new Set(ws.flatMap(specs))].join(" ");
    if (items)
        env.DISPATCHER_ACCEPT_ITEMS = items;
    return env;
}

const MAX_OUT = 4 * 1024 * 1024;
/**
 * Запустить команду приёмки и разобрать вывод. run(step, write) → код возврата (в сервере — spawnStep раннера: процесс
 * снимается отменой прогона). → { code, results } — results как у parseAcceptOutput.
 */
export async function runAcceptCommand({ cmd = PROJECT.accept.run, cwd = MAIN, env, waves, write, run }) {
    let out = "";
    const w = (s) => {
        out += s;
        if (out.length > MAX_OUT)
            out = out.slice(-MAX_OUT);
        write(s);
    };
    const code = await run({ text: cmd, show: cmd, cwd, env }, w);
    return { code, results: parseAcceptOutput(out, waves) };
}

/** Итоги прогона → на пункты записей волн. keys — { "<номер волны>": ключ записи }, снятые при постановке прогона. */
export function applyAcceptRun(job, results, keys, onlyMap = null) {
    const sum = { ok: 0, bad: 0, skip: 0, stray: 0, lost: 0 };
    const byWave = new Map();
    for (const r of results) {
        const n = (r.wave || "").slice(3);
        if (!keys[n]) {
            sum.lost++;
            continue;
        }
        if (!byWave.has(n))
            byWave.set(n, []);
        byWave.get(n).push(r);
    }
    for (const [n, k] of Object.entries(keys)) {
        const e = S.acc[k] || (S.acc[k] = { key: k.split("|")[0] });
        const s = applyResults(e, byWave.get(n) || [], { job: job.id, only: job.accItem ? [job.accItem] : onlyMap ? onlyMap[n] || [] : null });
        for (const x of Object.keys(s))
            sum[x] += s[x];
    }
    saveAcc();
    return sum;
}

/**
 * Поставить прогон приёмки. keys — волны (null — все ждущие); item — один пункт («i3»); only — { "<номер>": ["i1"] } или
 * true (красные пункты прошлых прогонов). headed — из прежнего интерфейса, не используется.
 */
export async function acceptRunJob(keys, headed, item, only) {
    if (!PROJECT.accept.run)
        throw new Error("команда приёмки не задана (accept.run в dispatcher.project.json)");
    if (item && !/^i\d{1,3}[a-z]?$/.test(item))
        throw new Error("пункт: i0…i999 (и подпункт вида i1b)");
    if (only === true) {
        only = {};
        for (const t of accWaves()) {
            const e = S.acc[accKey(t)] || {}, n = waveNum(t), ids = (e.items || []).filter((x) => x.auto && x.auto.st === "bad").map((x) => x.id);
            if (n && ids.length && (!keys || keys.includes(t.key)))
                only[n] = ids;
        }
    }
    if (only && !Object.keys(only).length)
        throw new Error("красных пунктов автоприёмки нет — перепрогонять нечего");
    if (only)
        keys = accWaves().filter((t) => only[waveNum(t)]).map((t) => t.key);
    let ws = accWaves().filter((t) => (!keys || keys.includes(t.key)) && waveNum(t));
    if (PROJECT.accept.specGlob)
        ws = ws.filter((t) => specsOf(t).length);
    if (!ws.length)
        throw new Error(PROJECT.accept.specGlob ? (keys ? "у этой волны нет спеки приёмки (" + PROJECT.accept.specGlob + ")" : "спек приёмки нет ни у одной ждущей волны") : "волн, которые ждут приёмки, нет");
    const ids = item ? [item] : only ? Object.values(only).flat() : [];
    const env = acceptEnv(ws, { items: ids.length ? itemsGrep(ids) : "" });
    const accKeys = Object.fromEntries(ws.map((t) => [waveNum(t), accKey(t)]));
    for (const t of ws)
        accEnsure(t);
    saveAcc();
    return enqueue({ treeKey: STAGING_TREE, cwd: MAIN, label: "Приёмка: " + ws.map((t) => t.tag).join(", ") + (item ? " · только " + item : "") + (only ? " · только красные пункты (" + ids.length + ")" : ""), taskId: "accept-run", lane: "ops", profile: "eco",
        extra: { pipeline: true, accWaves: ws.map((t) => t.key), accKeys, ...(item ? { accItem: item } : {}), ...(only ? { accOnly: only } : {}) },
        steps: [{ show: PROJECT.accept.run + (STAND_URL ? "  (стенд " + STAND_URL + ")" : ""), cwd: MAIN, js: async (write, job) => {
                    const r = await runAcceptCommand({ env, waves: ws.map((t) => t.wave || t.branch || t.key), write, run: (step, w) => spawnStep(job, step, w) });
                    const sum = applyAcceptRun(job, r.results, accKeys, only || null);
                    write("\nпункты: ✓ " + sum.ok + " · ✗ " + sum.bad + " · пропущено " + sum.skip + (sum.stray ? " · без пункта в чек-листе " + sum.stray : "") + (sum.lost ? " · волна не определена " + sum.lost : "") + "\n");
                    if (r.code !== 0)
                        throw new Error("команда приёмки завершилась с кодом " + r.code);
                } }] });
}

// ───────────────────────────── состояние для страницы ─────────────────────────────
const lastStand = () => [...jobList()].reverse().find((j) => j.task === "deploy-staging" && j.status === "ok");
const lastRun = () => [...jobList()].reverse().find((j) => j.task === "accept-run");
const common = () => ({ syncing: accSyncing(), runnable: !!PROJECT.accept.run, specGlob: PROJECT.accept.specGlob, standUrl: STAND_URL });

/** Краткая приёмка для /api/state: счётчики (полная картина — acceptPublic, /api/accept-state). */
export function acceptBrief() {
    autoCloseTick();
    const ws = accWaves().map((t) => {
        const e = S.acc[accKey(t)] || {};
        return { key: t.key, tag: t.tag, epic: t.epic || null, verdict: e.verdict || null, itemsN: (e.items || []).length, autoClosed: !!e.autoClosed };
    });
    const run = lastRun();
    return { brief: true, ...common(), waves: ws, waiting: ws.filter((w) => !w.verdict && w.itemsN).length, tiles: [], run: run && !FINAL.includes(run.status) ? { id: run.id, status: run.status, waves: run.accWaves || [] } : null };
}

/** Полная приёмка для панели «Приёмка». */
export function acceptPublic() {
    autoCloseTick();
    const dep = lastStand();
    const waves = accWaves().map((t) => {
        const e = S.acc[accKey(t)] || {};
        return { key: t.key, epic: t.epic || null, epicTitle: (epicById(t.epic) || {}).title || "", tag: t.tag, title: t.title, emoji: t.emoji, color: t.color, branch: t.branch, mergeSha: String((t.merge || {}).sha || "").slice(0, 10),
            onStand: !!(t.stages || []).find((s) => s.id === "stand" && s.done), archived: !t.exists, asking: !!e.asking || askLive(t), merges: mergeShas(t).length, reopened: e.reopened || null,
            items: e.items || [], gotAt: e.gotAt || null, raw: e.items && e.items.length ? "" : String(e.raw || "").slice(0, 3000), verdict: e.verdict || null, comment: e.comment || "", sentAt: e.sentAt || null, sendNote: e.sendNote || "",
            autoClosed: e.autoClosed || "", specs: specsOf(t).map((f) => f.split("/").pop()), specsLocal: false, specAskedAt: e.specAskedAt || null, autoRun: e.autoRun || null, autoStray: e.autoStray || [] };
    });
    const run = lastRun();
    return { ...common(), waves, stand: dep ? { job: dep.id, at: dep.endedAt } : null, shard: null, tiles: [],
        run: run ? { id: run.id, status: run.status, at: run.endedAt || run.startedAt || run.queuedAt, summary: run.summary || "", waves: run.accWaves || [] } : null };
}

// ───────────────────────────── итоги агентам ─────────────────────────────
/** Отправить вердикты: агенту — его пункты, оркестратору эпика — сводка. */
export function acceptSend() {
    const done = [], back = [], skipped = [];
    for (const t of accWaves()) {
        const e = S.acc[accKey(t)];
        if (!e || !e.verdict || e.sentAt)
            continue;
        const ak = t.wagonOf || t.key;
        if (!agentCwd(ak)) {
            e.sendNote = "слот в архиве: агенту не отправлено, поднимите слот";
            skipped.push(t);
            continue;
        }
        sendWhenFree(ak, verdictText(t, e));
        e.sentAt = Date.now();
        e.sendNote = "";
        (e.verdict === "accepted" ? done : back).push(t);
    }
    saveAcc();
    const epOf = (t) => t.epic || epicOfKey(t.key);
    for (const ep of new Set([...done, ...back].map(epOf)))
        if (ep)
            sendWhenFree(orchKey(ep), summaryText(done.filter((t) => epOf(t) === ep), back.filter((t) => epOf(t) === ep).map((t) => ({ tag: t.tag, comment: (S.acc[accKey(t)] || {}).comment || "" }))));
    return { sent: done.length + back.length, accepted: done.length, rejected: back.length, skipped: skipped.length };
}

/**
 * Действия панели «Приёмка» (POST /api/accept): ask, item, verdict, comment, reset, run, send, askspec, askspecall.
 * → { code, body }. Вердикт ставит только человек: этот вход зовёт только страница.
 */
export async function acceptOp(b) {
    if (!acceptEnabled())
        return { code: 404, body: { error: "модуль приёмки выключен" } };
    const op = String(b.op || ""), keysOf = () => (Array.isArray(b.keys) && b.keys.length ? b.keys.map(String) : null);
    if (["item", "verdict", "comment", "reset", "send"].includes(op) && accSyncing())
        return { code: 409, body: { error: ACC_SYNCING_TEXT + ": отметки — после сведения" } };
    if (op === "ask") {
        const js = await acceptAsk(keysOf());
        return { code: 200, body: { ok: true, queued: js.length, message: js.length ? "Чек-листы спрошены у " + js.length + " агентов: задачи в очереди" : "Спрашивать некого: у всех волн чек-лист уже есть (повторно — по кнопке у волны)" } };
    }
    if (op === "send") {
        const r = acceptSend();
        return { code: 200, body: { ok: true, ...r, message: r.sent ? "Итоги отправлены: принято " + r.accepted + ", на доделку " + r.rejected + (r.skipped ? ", в архиве (не отправлено) " + r.skipped : "") + "; оркестратору — сводка" : "Отправлять нечего: нет волн с вердиктом" } };
    }
    if (op === "run") {
        const only = b.onlyRed ? true : b.only && typeof b.only === "object" ? Object.fromEntries(Object.entries(b.only).filter(([k, v]) => /^\d{4}$/.test(k) && Array.isArray(v)).map(([k, v]) => [k, v.map(String).filter((x) => /^i\d{1,3}[a-z]?$/.test(x))]).filter(([, v]) => v.length)) : null;
        try {
            const j = await acceptRunJob(keysOf(), false, b.item ? String(b.item) : null, only);
            return { code: 200, body: { ok: true, id: j.id, message: "Приёмка в очереди" } };
        }
        catch (e) {
            return { code: 400, body: { error: e.message } };
        }
    }
    if (op === "askspecall") {
        const done = [], skip = [];
        for (const x of accWaves()) {
            const ex = S.acc[accKey(x)] || {};
            if (ex.verdict || ex.autoClosed || !(ex.items || []).length)
                continue;
            const r = acceptSpecAsk(x, ex);
            (r.code === 200 ? done : skip).push(x.tag + (r.code === 200 ? "" : ": " + r.body.error));
        }
        return { code: 200, body: { ok: true, message: (done.length ? "Тесты заказаны: " + done.join(", ") : "Заказывать некому") + (skip.length ? ". Не заказано: " + skip.join("; ") : "") } };
    }
    const t = accWaves().find((x) => x.key === String(b.key || ""));
    if (!t)
        return { code: 404, body: { error: "волны нет среди ждущих приёмки" } };
    const e = accEnsure(t);
    if (op === "item") {
        const it = (e.items || []).find((x) => x.id === b.id);
        if (!it)
            return { code: 404, body: { error: "нет такого пункта" } };
        if (["todo", "ok", "bad"].includes(b.state)) {
            it.state = b.state;
            delete it.before;
        }
        if (typeof b.comment === "string")
            it.comment = b.comment.slice(0, 2000);
        e.sentAt = null;
        saveAcc();
        return { code: 200, body: { ok: true } };
    }
    if (op === "verdict") {
        e.verdict = ["accepted", "rejected"].includes(b.verdict) ? b.verdict : null;
        if (e.verdict)
            delete e.reopened;
        delete e.autoClosed;
        if (typeof b.comment === "string")
            e.comment = b.comment.slice(0, 4000);
        e.sentAt = null;
        saveAcc();
        logEvent("accept.verdict", { tree: t.key, verdict: e.verdict });
        return { code: 200, body: { ok: true } };
    }
    if (op === "comment") {
        e.comment = String(b.comment || "").slice(0, 4000);
        saveAcc();
        return { code: 200, body: { ok: true } };
    }
    if (op === "reset") {
        dropAccEntry(accKey(t));
        saveAcc();
        return { code: 200, body: { ok: true } };
    }
    if (op === "askspec")
        return acceptSpecAsk(t, e);
    return { code: 400, body: { error: "op: ask, item, verdict, comment, reset, run, send, askspec, askspecall" } };
}

// ───────────────────────────── напоминания «ПОСЛЕ ВЫКАТА» ─────────────────────────────
export const REM_FILE = path.join(DATA, "reminders.json");
export const saveRem = () => saveJson(REM_FILE, S.reminders, 1);
export const remindersList = () => S.reminders;
export const addReminder = (r) => { S.reminders.push(r); };
/** С кнопки запускается только задача проекта без ввода — по её id. */
export const REM_CMD = remCmdRe(PROJECT.tasks);
export function loadReminders() {
    S.reminders = readJson(REM_FILE, []) || [];
}

/** Строки «ПОСЛЕ ВЫКАТА: что :: задача» из ответа агента — в напоминания (без повторов). */
export function remAddFromText(from, text) {
    let n = 0;
    for (const { what, cmd } of reminderLines(text)) {
        if (S.reminders.some((r) => r.status !== "done" && r.text === what && (r.cmd || r.cmdRaw) === cmd))
            continue;
        const ok = REM_CMD.test(cmd);
        S.reminders.push({ id: "r" + Date.now().toString(36) + S.reminders.length, text: what, cmd: ok ? cmd : "", cmdRaw: ok ? "" : cmd, from, at: Date.now(), status: "wait" });
        n++;
    }
    if (n)
        saveRem();
    return n;
}

export function remindersPublic() {
    const dep = lastStand();
    const slotTree = (k) => snapNow() && snapNow().trees.find((x) => x.key === k && x.kind === "slot");
    // напоминание волны появляется после её влива: до того это черновая заметка агента
    return S.reminders.filter((r) => r.status !== "dismissed").filter((r) => {
        const t = slotTree(r.from);
        return !t || r.status === "done" || !!t.merge;
    }).slice(-40).map((r) => {
        const j = r.jobId && jobList().find((x) => x.id === r.jobId), t = slotTree(r.from);
        const onStand = t ? !!(t.merge && (t.stages || []).find((x) => x.id === "stand" && x.done)) : !!(dep && dep.endedAt > r.at);
        const st = r.status === "done" ? "done" : j && !FINAL.includes(j.status) ? "run" : j && j.status === "fail" ? "fail" : onStand ? "ready" : "wait";
        return { ...r, st, fromTag: (treeByKey(r.from) || {}).tag || r.from, jobId: r.jobId || null };
    });
}

/** Выполнить задачу напоминания в основной папке проекта (с адресом стенда в окружении). */
export async function remRun(r) {
    if (!r.cmd || !REM_CMD.test(r.cmd) || !TASKS[r.cmd])
        throw new Error("с кнопки запускается только задача проекта без ввода (id из tasks в dispatcher.project.json)");
    const step = { ...stepOfTask(TASKS[r.cmd], MAIN), env: { DISPATCHER_STAND_URL: STAND_URL } };
    const job = await enqueue({ treeKey: STAGING_TREE, cwd: MAIN, label: "После выката: " + r.text.slice(0, 60), taskId: r.cmd, lane: "ops", profile: "eco", extra: { pipeline: true, reminder: r.id }, steps: [step] });
    r.jobId = job.id;
    saveRem();
    return job;
}

/** Действия с напоминаниями (POST /api/reminders): add, run, done, dismiss. → { code, body } */
export async function remindersOp(b) {
    const op = String(b.op || ""), r = S.reminders.find((x) => x.id === b.id);
    if (op === "add") {
        const text = String(b.text || "").trim(), cmd = String(b.cmd || "").trim();
        if (text.length < 4)
            return { code: 400, body: { error: "что сделать — хотя бы пару слов" } };
        if (cmd && !REM_CMD.test(cmd))
            return { code: 400, body: { error: "команда — только id задачи проекта без ввода" } };
        addReminder({ id: "r" + Date.now().toString(36), text: text.slice(0, 500), cmd, cmdRaw: "", from: "человек", at: Date.now(), status: "wait" });
        saveRem();
        return { code: 200, body: { ok: true } };
    }
    if (!r)
        return { code: 404, body: { error: "нет такого напоминания" } };
    if (op === "run") {
        try {
            const j = await remRun(r);
            return { code: 200, body: { ok: true, id: j.id, message: "Задача поставлена в очередь: " + j.id } };
        }
        catch (e) {
            return { code: 400, body: { error: e.message } };
        }
    }
    if (op === "done") {
        r.status = "done";
        r.doneAt = Date.now();
        saveRem();
        return { code: 200, body: { ok: true } };
    }
    if (op === "dismiss") {
        r.status = "dismissed";
        saveRem();
        return { code: 200, body: { ok: true } };
    }
    return { code: 400, body: { error: "op: add, run, done, dismiss" } };
}
