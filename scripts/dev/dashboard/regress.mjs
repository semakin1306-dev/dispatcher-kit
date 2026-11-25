// regress.mjs — регресс по тронутым путям: какие спеки задеты правкой, история спек и карантин нестабильных, автоповтор
// упавших, красное самого staging (чужое красное слотом не считается). Работает на именах спек из разбора вывода; при
// разборе только по коду возврата выключается сам.
//
// «Семья» спеки — задача, которая её прогоняет (id задачи конфига). Задача участвует, если её разбор знает имена спек
// (parsers.mjs specAware). Узкие прогоны «только эти спеки» строятся, если задача умеет ввод из имён спек
// (parsers.mjs specInput); иначе регресс области — задачей целиком, а автоповтор и сужение для неё не делаются.
import { MAIN, PROJECT } from "../slots.mjs";
import { retrySpecs } from "./loops.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import { readJson, saveJson } from "./store.mjs";
import path from "node:path";
import { S } from "./state.mjs";
import { jobList } from "./jobs.mjs";
import { DATA, FINAL, logPath, readLog } from "./config.mjs";
import { FP_SKIP, SPEC_RE, TASK_AREA, isProduct, snapCache } from "./fingerprint.mjs";
import { git, stagingTreeSha, untrackedShim } from "./git.mjs";
import { addCard, ibId, saveInbox } from "./inbox.mjs";
import { late, lateObject } from "./late.mjs";
import { orchKey, viewEpic } from "./trees.mjs";
import { TASKS, matchAny, stepOfTask } from "./tasks.mjs";
import { parseTaskLog, specAware, specInput } from "./parsers.mjs";
import { prompt } from "../prompts.mjs";

const { runTask } = late("autochain.mjs", ["runTask"]);
const { enqueue } = late("runner.mjs", ["enqueue"]);
// агенты — поздней привязкой: правила регресса грузятся и без сервера (тесты, сухая проверка)
const agents = lateObject("agents.mjs", "agents");
const { push } = late("agents.mjs", ["push"]);

export const sbase = (p) => String(p || "").replace(/\\/g, "/").split("/").pop();
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Задачи с именами спек: id → id (семья спеки — сама задача). Поезд отчитывается так же. */
export const SUITE_FAM = Object.fromEntries(Object.keys(PROJECT.tasks).filter(specAware).map((id) => [id, id]));
export const TEST_LOG_TASKS = new Set([...Object.keys(SUITE_FAM), "train"]);
/** Задачи, красное которых сверяется с красным самого staging. */
export const BASE_TASKS = new Set(Object.keys(SUITE_FAM));

const AREAS = Object.values(PROJECT.areas);
/** Задачи-тесты областей, которых касаются файлы. */
const touchedAreaTasks = (files) => {
    const out = new Map();
    for (const a of AREAS) {
        const hit = files.filter((f) => matchAny(f, a.paths));
        if (!hit.length)
            continue;
        for (const id of a.tasks)
            if (SUITE_FAM[id])
                out.set(id, { area: a, files: [...((out.get(id) || {}).files || []), ...hit] });
    }
    return out;
};

export async function touchedFiles(dir) {
    const base = (await git(dir, ["merge-base", "staging", "HEAD"])).out || "HEAD";
    const [d, u] = await Promise.all([git(dir, ["diff", "--name-only", base], 60000), untrackedShim(dir)]);
    return [...new Set((d.out + "\n" + u.out).split("\n").map((x) => x.trim()).filter((x) => x && !FP_SKIP.test(x)))];
}

// ───────────────────────────── какие спеки задеты правкой ─────────────────────────────
// Без графа импортов конкретного раннера: спека задета, если её саму правили или в её тексте упомянуто имя тронутого
// файла (без расширения). Слишком общие имена (index, utils…) и имена, которые встречаются в десятках спек, не берутся.

export const GENERIC_KEYS = new Set([
    "route",
    "index",
    "types",
    "type",
    "utils",
    "util",
    "helpers",
    "constants",
    "middlewares",
    "service",
    "models",
    "model",
    "config",
    "schema",
    "main",
    "init",
    "__init__",
    "mod",
    "lib",
    "app",
]);
export const specTextCache = new Map();
const SPEC_SKIP = new Set(["node_modules", "dist", ".git", ".nuxt", ".output", ".next", "build", "coverage", "playwright-report", "test-results", ".turbo", "__pycache__", ".venv", "venv"]);

/** Неподвижная часть шаблона пути (до первой звёздочки) — откуда искать спеки области. */
const globRoot = (g) => String(g).replace(/\\/g, "/").split("/").filter((x, i, a) => !a.slice(0, i + 1).some((y) => /[*?]/.test(y))).join("/");

/** Спеки области в рабочей копии: относительные пути. */
export function areaSpecs(dir, area, depthMax = 14) {
    const out = [];
    const walk = (abs, rel, depth) => {
        let es;
        try {
            es = fs.readdirSync(abs, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of es) {
            if (SPEC_SKIP.has(e.name))
                continue;
            const r = rel ? rel + "/" + e.name : e.name;
            if (e.isDirectory()) {
                if (depth < depthMax)
                    walk(path.join(abs, e.name), r, depth + 1);
            }
            else if (SPEC_RE.test(r) && matchAny(r, area.paths))
                out.push(r);
        }
    };
    for (const root of [...new Set(area.paths.map(globRoot))])
        walk(path.join(dir, root), root, 0);
    return [...new Set(out)];
}

const specText = (abs) => {
    let st;
    try {
        st = fs.statSync(abs);
    }
    catch {
        return null;
    }
    const c = specTextCache.get(abs);
    if (c && c.m === st.mtimeMs)
        return c.t;
    let t;
    try {
        t = fs.readFileSync(abs, "utf8");
    }
    catch {
        return null;
    }
    specTextCache.set(abs, { m: st.mtimeMs, t });
    if (specTextCache.size > 3000)
        specTextCache.delete(specTextCache.keys().next().value);
    return t;
};

/** Спеки области, задетые правкой: { specs, keys, dropped }. */
export function relatedSpecs(dir, area, files, cap = 40) {
    const all = areaSpecs(dir, area);
    const touchedSpecs = files.filter((f) => SPEC_RE.test(f) && all.includes(f));
    const keys = new Set();
    for (const f of files) {
        if (!isProduct(f))
            continue;
        const b = sbase(f).replace(/\.[^.]+$/, "");
        if (b.length >= 4 && !GENERIC_KEYS.has(b))
            keys.add(b);
    }
    if (!keys.size)
        return { specs: touchedSpecs, keys: [], dropped: [] };
    const texts = all.map((p) => [p, specText(path.join(dir, p))]).filter(([, t]) => t != null);
    const per = {};
    for (const k of keys)
        per[k] = texts.filter(([, t]) => t.includes(k)).length;
    const good = [...keys].filter((k) => per[k] > 0 && per[k] <= cap), dropped = [...keys].filter((k) => per[k] > cap);
    const specs = [...new Set([...touchedSpecs, ...texts.filter(([, t]) => good.some((k) => t.includes(k))).map(([p]) => p)])];
    return { specs, keys: good, dropped };
}

export const REGRESS_CHUNK = Number(process.env.DASH_REGRESS_CHUNK) || 25;
/** Больше стольких задетых спек — правка широкая: задача целиком. */
export const REGRESS_WIDE = 120;

/**
 * План регресса по тронутым файлам: [{ task, input, why }]. На каждую задачу-тест тронутой области:
 * задача умеет ввод из имён спек — задетые спеки частями по REGRESS_CHUNK; не умеет или правка широкая — задача целиком
 * (если её можно запустить без ввода). Задетых спек нет — область не прогоняется.
 */
export function regressPlan(files, dir) {
    const out = [];
    for (const [id, { area, files: hit }] of touchedAreaTasks(files)) {
        const task = TASKS[id], si = specInput(id);
        if (!task)
            continue;
        if (!task.input) {
            out.push({ task: id, input: "", why: "тронута область «" + area.title + "»" });
            continue;
        }
        if (!si || !dir)
            continue;
        const rel = relatedSpecs(dir, area, hit);
        if (!rel.specs.length)
            continue;
        const why =
            "спеки области «" +
            area.title +
            "», где упомянуты тронутые файлы или которые правились — всего " +
            rel.specs.length +
            (rel.keys.length ? "; ключи: " + rel.keys.join(", ") : "") +
            (rel.dropped.length ? "; слишком общие, не взяты: " + rel.dropped.join(", ") : "");
        if (rel.specs.length > REGRESS_WIDE)
            continue;
        const names = [...new Set(rel.specs.map(sbase))].sort(), n = Math.ceil(names.length / REGRESS_CHUNK), size = Math.ceil(names.length / n);
        for (let i = 0; i < n; i++)
            out.push({ task: id, input: si.make(names.slice(i * size, (i + 1) * size)), why: (n > 1 ? "часть " + (i + 1) + " из " + n + ": " : "") + why });
    }
    return out;
}

// ───────────────────────────── разбор прогона ─────────────────────────────

export const failCache = new Map();
const passCache = new Map();
const jobById = (id) => jobList().find((x) => x.id === id);
const parsed = (id) => parseTaskLog(readLog(id), (jobById(id) || {}).task);

export function failingSpecs(id) {
    if (failCache.has(id))
        return failCache.get(id);
    const j = jobById(id);
    const v = j && j.task !== "train" && !specAware(j.task) ? [] : parsed(id).failed.map((p) => p.replace(/\\/g, "/"));
    if (j && FINAL.includes(j.status))
        failCache.set(id, v);
    return v;
}

export function passingSpecs(id) {
    const j = jobById(id);
    if (j && j.task !== "train" && !specAware(j.task))
        return [];
    return parsed(id).passed.map((p) => p.replace(/\\/g, "/"));
}

export function passingCached(id) {
    if (passCache.has(id))
        return passCache.get(id);
    const v = passingSpecs(id), j = jobById(id);
    if (j && FINAL.includes(j.status))
        passCache.set(id, v);
    return v;
}

export const baseAsked = new Set();
/** git без хуков и побочных настроек — для служебных операций диспетчерской в рабочих копиях. */
export const SAFE_HOOKS = path.join(DATA, "empty-hooks");
export const SAFE_GIT = [
    "-c",
    "core.hooksPath=" + SAFE_HOOKS.replace(/\\/g, "/"),
    "-c",
    "rerere.enabled=false",
    "-c",
    "gc.auto=0",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "rebase.updateRefs=false",
    "-c",
    "core.quotePath=false",
];

/** Имена спек на верхушке staging по задачам: { tree, <задача>: Set(имя файла) }. */
export async function stagingSpecSets() {
    if (S.stgSpecCache && S.stgSpecCache.tree && S.stgSpecCache.tree === stagingTreeSha())
        return S.stgSpecCache;
    const r = await git(MAIN, ["ls-tree", "-r", "--name-only", "staging"], 60000);
    if (!r.ok)
        return null;
    const sets = { tree: stagingTreeSha() };
    for (const id of Object.keys(SUITE_FAM))
        sets[id] = new Set();
    for (const f of r.out.split("\n")) {
        if (!SPEC_RE.test(f))
            continue;
        for (const a of AREAS)
            if (matchAny(f, a.paths))
                for (const id of a.tasks)
                    if (sets[id])
                        sets[id].add(sbase(f));
    }
    S.stgSpecCache = sets;
    return sets;
}

/** Сверочные прогоны на самом staging выключены: чьё красное — разбирает оркестратор по логу и диффу ветки. */
export const STAGING_BASELINE_RUNS = false;

/** Прогон того же набора на самом staging (для сверки «чьё красное») или вердикт без прогона. */
export function stagingBase(it0, mine = [], stg = null) {
    let it = it0;
    const si = specInput(it0.task);
    if (SUITE_FAM[it0.task] && mine.length && stg && stg[it0.task]) {
        const names = [...new Set(mine.map(sbase))], have = names.filter((n) => stg[it0.task].has(n));
        if (!have.length)
            return {
                status: "ok",
                virtual: true,
                why:
                    "упавших спек на staging нет — они новые в ветке (" +
                    names.slice(0, 4).join(", ") +
                    (names.length > 4 ? " …" : "") +
                    "): красное принесла ветка",
            };
        if (si)
            it = { task: it0.task, input: si.make(have.sort()) };
    }
    const b = [...jobList()]
        .reverse()
        .find(
            (k) =>
                k.tree === "orchestrator-staging" &&
                jobCovers(k, it) &&
                k.treeSha === stagingTreeSha() &&
                ["ok", "fail", "running", "queued", "waiting"].includes(k.status) &&
                !(k.status === "fail" && !failingSpecs(k.id).length),
        );
    if (b || !stagingTreeSha())
        return b || null;
    if (!STAGING_BASELINE_RUNS)
        return { status: "none", virtual: true, why: "на staging не прогоняю: чьё красное — разбирает оркестратор по логу прогона и диффу ветки" };
    const key = stagingTreeSha() + "|" + it.task + "|" + it.input;
    if (baseAsked.has(key))
        return null;
    baseAsked.add(key);
    const task = TASKS[it.task];
    if (task)
        enqueue({ treeKey: "orchestrator-staging", cwd: MAIN, label: task.label + " на staging (сверка регресса)", taskId: it.task, input: task.input ? it.input : "", lane: task.lane,
            steps: [stepOfTask(task, MAIN, it.input || "")], extra: { auto: true, baseline: true, treeSha: stagingTreeSha(), by: "сверка со staging" } })
            .catch((e) => console.error("сверка со staging:", e.message));
    return null;
}

/** Регулярка `wide` находит каждую альтернативу `narrow` (ввод-регулярка шире по составу). */
export function regexCovers(wide, narrow) {
    if (!wide)
        return false;
    let re;
    try {
        re = new RegExp(wide, "i");
    }
    catch {
        return false;
    }
    const alts = String(narrow || "").split("|").map((x) => x.trim().replace(/\\(.)/g, "$1")).filter(Boolean);
    return alts.length > 0 && alts.every((x) => re.test(x));
}

/** Прогон j покрывает набор it: та же задача и тот же ввод — или ввод j шире по составу. */
export function jobCovers(j, it) {
    if (j.task !== it.task)
        return false;
    const a = String(j.input || ""), b = String(it.input || "");
    if (a === b)
        return true;
    if (!a || !b)
        return false;
    const parts = (s) => s.split(/[,|]/).map((x) => x.trim().replace(/\\(.)/g, "$1")).filter(Boolean);
    const have = new Set(parts(a));
    if (parts(b).every((n) => have.has(n)))
        return true;
    const t = PROJECT.tasks[it.task];
    return !!(t && t.parser === "jest" && regexCovers(a, b));
}

// ───────────────────────────── красное staging и карантин ─────────────────────────────

export const STG_RED_FILE = path.join(DATA, "staging-red.json");
export const onStagingRed = (f) => !!S.stgRed[f];
export const knownRed = (f) => onStagingRed(f) || isFlaky(f);
export const touchedBases = (j) => new Set(Object.keys((j && j.snap) || {}).map(sbase));
export const inheritedRed = (j, f) => knownRed(f) && !touchedBases(j).has(sbase(f));

export function onlyStagingRed(jobId) {
    const s = failingSpecs(jobId), j = jobById(jobId);
    return s.length > 0 && s.every((f) => inheritedRed(j, f));
}

export function foreignRedBaseline(job) {
    if (!STAGING_BASELINE_RUNS || job.status !== "fail" || job.baseline || job.train || !SUITE_FAM[job.task] || /^orchestrator/.test(job.tree))
        return;
    const touched = touchedBases(job);
    const foreign = failingSpecs(job.id).filter((f) => !knownRed(f) && !touched.has(sbase(f)));
    if (!foreign.length)
        return;
    stagingSpecSets().then((stg) => {
        if (stg)
            stagingBase({ task: job.task, input: "" }, foreign, stg);
    }).catch((e) => console.error("сверка чужого красного:", e.message));
}

/** Красное от окружения, а не от кода: обрыв связи, снятие по времени, отказ запуска. */
export const ENV_FAIL_RE =
    /Connection timed out|снимок не отправился|УПЁРЛОСЬ В ПОТОЛОК|СНЯТ ПО ВРЕМЕНИ|spawn UNKNOWN|ECONNRESET|banner exchange|kex_exchange_identification|Timeout, server [\w.:-]+ not responding|Read from remote host [\w.:-]+: Connection reset by peer|client_loop: send disconnect: Connection reset/i;

export function realFail(j) {
    if (ENV_FAIL_RE.test(j.summary || ""))
        return false;
    return TEST_LOG_TASKS.has(j.task) ? failingSpecs(j.id).length > 0 : true;
}

export const SPEC_HIST_FILE = path.join(DATA, "spec-history.json");
export const stgRedMap = () => S.stgRed;
export const specHistMap = () => S.specHist;

export function loadStgRed() {
    S.stgRed = readJson(STG_RED_FILE, {}) || {};
}

export function loadSpecHist() {
    S.specHist = readJson(SPEC_HIST_FILE, {}) || {};
}

export function recordSpecs(job) {
    if (!TEST_LOG_TASKS.has(job.task) || !["ok", "fail"].includes(job.status))
        return;
    const code = job.baseline ? "stg:" + (job.treeSha || "") : job.train ? "train:" + job.id : job.tree + ":" + (job.fpEnd || job.treeSha || "");
    const add = (f, ok) => {
        const h = S.specHist[f] || (S.specHist[f] = []);
        h.push({ at: job.endedAt || Date.now(), ok, job: job.id, code });
        if (h.length > 20)
            h.splice(0, h.length - 20);
    };
    const fails = failingSpecs(job.id);
    fails.forEach((f) => add(f, false));
    passingSpecs(job.id).filter((f) => !fails.includes(f)).forEach((f) => add(f, true));
    clearTimeout(S.specHistTimer);
    S.specHistTimer = setTimeout(() => saveJson(SPEC_HIST_FILE, S.specHist), 2000);
}

/** Нестабильная спека: на одном и том же коде бывала и зелёной, и красной; восемь зелёных подряд — снова стабильна. */
export function isFlaky(f) {
    const h = (S.specHist[f] || []).slice(-15);
    if (h.length < 2)
        return false;
    if (h.length >= 8 && h.slice(-8).every((x) => x.ok))
        return false;
    const by = new Map();
    for (const x of h) {
        const s = by.get(x.code) || new Set();
        s.add(x.ok);
        by.set(x.code, s);
    }
    return [...by.values()].some((s) => s.size === 2);
}

export function releaseQuarantine(passed, at, why) {
    const names = new Set(passed), out = [];
    for (const f of Object.keys(S.specHist)) {
        if (!names.has(sbase(f)) || !isFlaky(f))
            continue;
        const lastFail = Math.max(0, ...S.specHist[f].filter((x) => !x.ok).map((x) => x.at));
        if (at <= lastFail)
            continue;
        S.specHist[f] = [{ at, ok: true, job: why, code: why }];
        out.push(f);
    }
    if (out.length) {
        saveJson(SPEC_HIST_FILE, S.specHist);
        console.log("из карантина (" + why + "):", out.join(", "));
    }
    return out;
}

export function flakyList() {
    return Object.keys(S.specHist).filter(isFlaky).map((f) => {
        const h = S.specHist[f];
        return { spec: f, fails: h.filter((x) => !x.ok).length, runs: h.length, last: h[h.length - 1].at };
    });
}

/** Автоповтор упавших чужих спек один раз — только для задачи, которая умеет ввод из имён спек. */
export function autoRetry(job) {
    if (job.status !== "fail" || job.baseline || job.retryOf || job.train || job.hung || !SUITE_FAM[job.task] || /^orchestrator/.test(job.tree))
        return;
    const si = specInput(job.task);
    if (!si)
        return;
    const mine0 = failingSpecs(job.id).filter((f) => !inheritedRed(job, f));
    if (!mine0.length || mine0.length > 8)
        return;
    const day = Date.now() - 24 * 3600e3,
        retriedToday = (f) =>
            jobList().filter(
                (k) =>
                    k.tree === job.tree &&
                    k.retryOf &&
                    (k.queuedAt || 0) > day &&
                    String(k.input || "")
                        .replace(/\\/g, "")
                        .includes(sbase(f).replace(/\.[^.]+$/, "")),
            ).length;
    const mine = retrySpecs({
        failing: mine0,
        touched: Object.keys(job.snap || {}),
        history: S.specHist,
        code: job.tree + ":" + (job.fpEnd || job.treeSha || ""),
        jobId: job.id,
    }).filter((f) => retriedToday(f) < 2);
    if (!mine.length) {
        const a = agents.get(job.tree);
        if (a)
            push(a, {
                id: "nrt-" + a.rev,
                t: "status",
                text:
                    "Автоповтор не ставлю: упали свои спеки волны или спеки, уже падавшие на этом же коде (" +
                    mine0.map(sbase).join(", ") +
                    ") — повтор дал бы то же.",
            });
        return;
    }
    runTask(job.tree, job.task, si.make(mine), "автоповтор упавших спек", { retryOf: job.id }).catch((e) => console.error("автоповтор:", e.message));
}

// ───────────────────────────── учёт по спекам ─────────────────────────────

export async function fileSnap(dir) {
    const m = {};
    for (const f of await touchedFiles(dir)) {
        try {
            m[f] = crypto.createHash("sha1").update(fs.readFileSync(path.join(dir, f))).digest("hex").slice(0, 12);
        }
        catch {
            m[f] = "deleted";
        }
    }
    return m;
}

export async function curSnapOf(t) {
    const c = snapCache.get(t.path);
    if (c && c.fp === t.fp)
        return c.snap;
    const s = await fileSnap(t.path).catch(() => null);
    snapCache.set(t.path, { fp: t.fp, snap: s });
    return s;
}

export function changedBetween(a, b) {
    const out = [];
    for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})]))
        if ((a || {})[k] !== (b || {})[k] && !FP_SKIP.test(k))
            out.push(k);
    return out;
}

/** Последний итог каждой спеки слота: имя файла → { ok, job, spec, fam }. */
export function suiteLedger(t) {
    const L = new Map();
    for (const j of jobList()) {
        if (j.tree !== t.key || !SUITE_FAM[j.task] || !["ok", "fail"].includes(j.status))
            continue;
        const fails = new Set(failingSpecs(j.id).map(sbase)), fam = SUITE_FAM[j.task];
        for (const f of passingCached(j.id)) {
            const b = sbase(f);
            if (!fails.has(b))
                L.set(b, { ok: true, job: j, spec: f, fam });
        }
        for (const f of failingSpecs(j.id))
            L.set(sbase(f), { ok: false, job: j, spec: f, fam });
    }
    return L;
}

export const CARRY_MAX_AGE_MS = 24 * 3600e3;

/** Красные спеки слота с прошлых прогонов, которые узкий перепрогон должен нести с собой. */
export function redCarryOf(key, fp = "", { now = Date.now(), exceptJob = "" } = {}) {
    const out = [];
    for (const e of suiteLedger({ key }).values()) {
        if (e.ok || !e.job || e.job.id === exceptJob || !specInput(e.fam))
            continue;
        if (fp && e.job.fpEnd === fp)
            continue;
        if (now - (e.job.endedAt || 0) > CARRY_MAX_AGE_MS || inheritedRed(e.job, e.spec))
            continue;
        out.push({ spec: sbase(e.spec), fam: e.fam, job: e.job.id });
    }
    return out;
}

/** Свеж ли итог спеки на нынешнем коде: тот же отпечаток, или после прогона менялось только вне зоны её задачи. */
export function suiteFresh(t, e, cur) {
    const j = e.job;
    if (j.fpEnd && j.fpEnd === t.fp && j.fpStart === j.fpEnd)
        return "fresh";
    if (!j.snap || !cur)
        return "stale";
    const ch = changedBetween(j.snap, cur);
    if (!ch.length)
        return "fresh";
    if (ch.some((f) => sbase(f) === sbase(e.spec)))
        return "stale";
    const zone = TASK_AREA[e.fam];
    if (!zone)
        return "stale";
    return ch.some((f) => zone.test(f)) ? "stale" : "fresh";
}

/** Имена спек, если ввод задачи — список файлов спек; иначе null. */
export function namesOfInput(task, input) {
    const si = specInput(task);
    if (!input || !si)
        return null;
    const parts = si.names(input);
    return parts.length && parts.every((x) => SPEC_RE.test(x)) ? [...new Set(parts.map(sbase))] : null;
}

export function entrySuites(t, it, L, cur) {
    let names = namesOfInput(it.task, it.input);
    if (!names) {
        const j = [...jobList()].reverse().find((k) => k.tree === t.key && ["ok", "fail"].includes(k.status) && jobCovers(k, { task: it.task, input: it.input || "" }) && SUITE_FAM[k.task]);
        if (!j)
            return null;
        names = [...new Set([...passingCached(j.id), ...failingSpecs(j.id)].map(sbase))];
    }
    if (!names.length)
        return null;
    const list = names.map((b) => {
        const e = L.get(b);
        if (!e)
            return { spec: b, st: "unknown" };
        const fr = suiteFresh(t, e, cur);
        return { spec: b, path: e.spec, fam: e.fam, job: e.job.id, st: e.ok ? (fr === "fresh" ? "ok" : "stale") : inheritedRed(e.job, e.spec) ? "inherited" : fr === "fresh" ? "fail" : "stale" };
    });
    const state = list.some((x) => x.st === "fail") ? "fail" : list.every((x) => ["ok", "inherited"].includes(x.st)) ? "ok" : "stale";
    return { state, list, fam: SUITE_FAM[it.task] || (list.find((x) => x.fam) || {}).fam };
}

export function suitesPublic(es) {
    const counts = {};
    for (const x of es.list)
        counts[x.st] = (counts[x.st] || 0) + 1;
    const rank = { fail: 0, stale: 1, unknown: 2, inherited: 3, ok: 4 };
    return { counts, total: es.list.length, list: es.list.slice().sort((a, b) => (rank[a.st] ?? 5) - (rank[b.st] ?? 5)).slice(0, 400) };
}

/** Прогон «только эти спеки» задачи fam: { task, input } или null, если ввод из спек задача не умеет. */
export function suiteRunArgs(fam, names) {
    const si = specInput(fam);
    if (si)
        return { task: fam, input: si.make(names) };
    const t = TASKS[fam];
    return t && !t.input ? { task: fam, input: "" } : null;
}

export function stagingRedClear(job) {
    if (job.status === "fail" && !failingSpecs(job.id).length)
        return;
    const now = new Set(failingSpecs(job.id));
    let n = 0;
    for (const [f, e] of Object.entries(S.stgRed)) {
        const src = jobById(e.jobId);
        if (!src || now.has(f))
            continue;
        if (jobCovers(job, { task: src.task, input: src.input || "" })) {
            delete S.stgRed[f];
            n++;
        }
    }
    if (n)
        saveJson(STG_RED_FILE, S.stgRed, 1);
}

export function stagingRedCard(job) {
    const specs = failingSpecs(job.id).filter((f) => !isFlaky(f));
    if (!specs.length)
        return;
    const fresh = specs.filter((f) => !S.stgRed[f]);
    if (!fresh.length)
        return;
    for (const f of fresh)
        S.stgRed[f] = { at: Date.now(), jobId: job.id };
    saveJson(STG_RED_FILE, S.stgRed, 1);
    addCard({
        id: ibId(),
        kind: "stgred",
        epic: null,
        tree: "orchestrator-staging",
        to: viewEpic() ? orchKey(viewEpic().id) : "orchestrator",
        toTag: "ОРК",
        specs: fresh,
        task: job.task,
        input: job.input || "",
        jobId: job.id,
        at: Date.now(),
    });
    saveInbox();
}

export function stgRedText(it) {
    const label = ((TASKS[it.task] || {}).label || it.task) + (it.input ? " " + it.input : "");
    const head = "Диспетчерская: на САМОМ staging красное вне волн эпика. Нашла его сверка регресса (прогон " + it.jobId + ": " + label +
        "), лог " + String(logPath(it.jobId)).replace(/\\/g, "/") + ".";
    return [head, "Упавшие спеки:", ...it.specs.map((f) => "- " + f), prompt("staging-red-task")].join("\n");
}

/** Все спеки прошли после момента `at` на этом коде слота. */
export function specsPassedSince(specs, tree, fp, at, hist = S.specHist) {
    if (!specs.length || !fp)
        return false;
    const code = tree + ":" + fp;
    return specs.every((f) => (hist[f] || []).some((x) => x.ok && x.at > at && x.code === code));
}

/**
 * Сужение красного набора до упавших спек: последний прогон задачи у слота (покрывающий `input`, если он задан) красный
 * по коду, а не по окружению — перепрогон «только упавшие» той же задачи, если она умеет ввод из спек. → { task, input, specs, from } или null.
 */
export function narrowRedRun(tree, taskId, { input, jobs = jobList(), fails = failingSpecs } = {}) {
    const si = specInput(taskId);
    if (!si)
        return null;
    const j = [...jobs].reverse().find((k) => k.tree === tree && k.task === taskId && ["ok", "fail"].includes(k.status) && (input === undefined || jobCovers(k, { task: taskId, input })));
    if (!j || j.status !== "fail" || ENV_FAIL_RE.test(j.summary || ""))
        return null;
    const specs = [...new Set(fails(j.id))].sort();
    return specs.length ? { task: taskId, input: si.make(specs), specs, from: j.id } : null;
}

