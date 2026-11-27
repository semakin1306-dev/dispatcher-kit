// runner.mjs — очередь и запуск прогонов: дорожки и их пределы, выбор места (эта машина или удалённая через модуль
// машин), службы этой машины перед прогоном (services.mjs), запуск шагов, разбор вывода, итог прогона, защита от дублей,
// возврат прерванных после перезапуска, журнал runs.jsonl.
//
// Дорожки. Служебные — ops (влив, выкат, git по кнопке), prep (подготовка папок слотов), review (ревьюер), commit
// (коммиты силами агентов) — со своими пределами. Дорожки задач проекта (`lane` задачи в конфиге) делят воркеры этой
// машины (PROJECT.machines.local.workers) и идут здесь, если машина их обслуживает (`lanes`, null — любые).
// Удалённые машины — модуль машин (shardApi()): когда он включён и в конфиге есть удалённые машины, задачи проекта
// получают место через него (slot-places.mjs: сначала удалённые, эта машина — последней). Как запускать задачу на
// удалённой машине, может сказать хук проекта remoteCmd (dispatcher.project.mjs) — его зовёт remoteCmdFor.
//
// Кто зовёт: autochain.mjs и http.mjs ставят прогоны (enqueue, enqueueChecked), boot.mjs при старте читает журнал
// (loadRuns) и возвращает прерванные (requeueInterrupted), страница получает прогоны через publicJob и queueView.
//
// Состояние: записи прогонов — jobs.mjs (jobList); очереди дорожек (queues) и счётчики идущих (running) — здесь;
// живые процессы шагов (procs: id прогона → процесс) — для отмены и снятия по времени. Файлы: журнал runs.jsonl
// (дописывается только изменившимися записями, уплотняется при чтении) и лог прогона logs/jNNN.log.
//
// Жизнь прогона: queued → (место и проверки удержания) → running → ok | fail | cancelled | skipped | interrupted.
// interrupted — прогон оборван не кодом (недоступна удалённая машина, перезапуск сервера): он возвращается в очередь сам.
// Инварианты: защита от дублей на входе (liveTwin, enqInflight); прогон слота не стартует, пока его агент пишет ответ
// (agentHold); тяжёлые служебные прогоны (поезд) идут по одному (conflicted); при подготовке к перезапуску (drainState)
// новые прогоны не стартуют, кроме дорожек ops и commit.
import { MAIN, PROJECT, fwd } from "../slots.mjs";
import { canonInput, runGate } from "./loops.mjs";
import { killTree as killTreeW, lowerPriority, spawn } from "./spawner.mjs";
import fs from "node:fs";
import { rewriteJsonl } from "./store.mjs";
import path from "node:path";
import { S } from "./state.mjs";
import { shardApi } from "./shard.mjs";
import { localServices, usesServices } from "./services.mjs";
import { inboxCards } from "./inbox.mjs";
import { addJob, jobList, keepLastJobs, nextSeq } from "./jobs.mjs";
import { acceptAsk, remindersList, saveRem } from "./accept.mjs";
import { agents, push, recordRelay, slotOf } from "./agents.mjs";
import { autoChain, autoTrain, runTask } from "./autochain.mjs";
import { ANSI, DATA, DRY, FINAL, KEEP_JOBS, RUNS, RUNS_JSONL, jobNum, logEvent, logPath, settings } from "./config.mjs";
import { infraFailure, infraRequeueDue } from "./host-health.mjs";
import { NEED_PKGS, drainState, orchFollow } from "./epics.mjs";
import { TREES, epicOfKey, isOrch, treeByKey } from "./trees.mjs";
import { DIST_TASKS, TASK_AREA, buildStampOf, codeFp, setBuildStamp } from "./fingerprint.mjs";
import { exists, git, withGitPriority } from "./git.mjs";
import { markTrain, saveTrain, trainFinished, trainNow } from "./pipeline.mjs";
import {
    STAGING_BASELINE_RUNS,
    SUITE_FAM,
    autoRetry,
    failingSpecs,
    fileSnap,
    foreignRedBaseline,
    jobCovers,
    onlyStagingRed,
    realFail,
    recordSpecs,
    regexCovers,
    sbase,
    stagingRedCard,
    stagingRedClear,
} from "./regress.mjs";
import { afterBuild, queueResult } from "./relay.mjs";
import { autoSendReview, parseReview, reviewToChat } from "./review.mjs";
import { kick, markMergedNow, rebuildFresh, rebuildMerged, rebuildOne, snapNow } from "./snapshot.mjs";
import { bumpVer } from "./events.mjs";
import { PROJECT_HOOKS, TASKS, findBash as findBashW, launchOf, stepOfTask, timeLimitMin } from "./tasks.mjs";
import { naOfLog, naSummary } from "./na-rules.mjs";
/** Лог прогона для «неприменимо»: начало и хвост (признак печатают до длинного каталога). */
function naLogText(id) {
    try {
        const st = fs.statSync(logPath(id));
        const fd = fs.openSync(logPath(id), "r");
        try {
            const head = Buffer.alloc(Math.min(st.size, 64000));
            fs.readSync(fd, head, 0, head.length, 0);
            let tailBuf = Buffer.alloc(0);
            if (st.size > head.length) {
                tailBuf = Buffer.alloc(Math.min(st.size - head.length, 64000));
                fs.readSync(fd, tailBuf, 0, tailBuf.length, st.size - tailBuf.length);
            }
            return head.toString("utf8") + "\n" + tailBuf.toString("utf8");
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch {
        return "";
    }
}
import { areaRefusal, prepCap } from "./slot-rules.mjs";
import { availMem } from "./free-mem.mjs";
import { hangDue, hangLogLines, hangSummary, hungSpecs } from "./hang-rules.mjs";
import { lineVerdict, parseTaskLog, specAware, specInput } from "./parsers.mjs";
import { standLine, standStepStart } from "./deploy-stages.mjs";

const kickTrainLate = (key) => autoChain(key, "после влива в staging: следующий вагон").catch((e) => console.error("поезд после влива:", e.message));

/**
 * Прочитать журнал прогонов: последняя запись по id побеждает (журнал дописывается при каждом изменении прогона).
 * Записей в файле больше чем вдвое против прогонов — переписать файл уплотнённым, чтобы он не рос без предела.
 * Журнала ещё нет — прочитать прежние файлы runs-all.json и runs.json.
 */
export function loadRuns() {
    const byId = new Map(), take = (j) => {
        if (j && typeof j.id === "string")
            byId.set(j.id, j);
    };
    let lines = 0;
    if (fs.existsSync(RUNS_JSONL)) {
        for (const l of fs.readFileSync(RUNS_JSONL, "utf8").split("\n")) {
            if (!l.trim())
                continue;
            lines++;
            try {
                take(JSON.parse(l));
            }
            catch { }
        }
    }
    else {
        for (const f of [path.join(DATA, "runs-all.json"), RUNS]) {
            try {
                for (const j of JSON.parse(fs.readFileSync(f, "utf8")))
                    take(j);
            }
            catch { }
        }
        lines = byId.size * 3;
    }
    const all = [...byId.values()].sort((a, b) => jobNum(a) - jobNum(b));
    if (!DRY && lines > byId.size * 2 + 200 && all.length) {
        try {
            rewriteJsonl(RUNS_JSONL, all);
            console.log("журнал прогонов уплотнён:", all.length, "записей");
        }
        catch (e) {
            console.error("журнал прогонов:", e.message);
        }
    }
    return all;
}

// id прогона → последняя записанная в журнал строка: в журнал уходят только изменившиеся записи.
export const runsSeen = new Map();
export const procs = new Map();

// ───────────────────────────── дорожки ─────────────────────────────

/** Служебные дорожки диспетчерской и их пределы. */
export const LANE_MAX = { ops: 1, prep: 1, review: 2, commit: 4 };
const LOCAL = PROJECT.machines.local;
/** Дорожки задач проекта. */
export const PROJECT_LANES = [...new Set(Object.values(TASKS).map((t) => t.lane))];
export const isProjectLane = (lane) => !(lane in LANE_MAX);
export const queues = Object.fromEntries([...Object.keys(LANE_MAX), ...PROJECT_LANES].map((l) => [l, []]));
export const running = Object.fromEntries(Object.keys(queues).map((l) => [l, 0]));
/** Очередь дорожки; дорожку, которой не было при запуске (служебная задача другого модуля), заводит на лету. */
const laneQ = (lane) => {
    if (!queues[lane]) {
        queues[lane] = [];
        running[lane] = running[lane] || 0;
    }
    return queues[lane];
};
/** Эта машина обслуживает дорожку задачи проекта. */
export const localServes = (lane) => !LOCAL.lanes || LOCAL.lanes.includes(lane);
/** Занято воркеров этой машины задачами проекта. */
const localBusy = () => Object.entries(running).filter(([l]) => isProjectLane(l)).reduce((n, [, v]) => n + v, 0);
export const laneMax = (lane) => (lane === "prep" ? prepCap(availMem() / 2 ** 30) : LANE_MAX[lane] ?? LOCAL.workers);
const laneFree = (lane) => (isProjectLane(lane) ? localServes(lane) && localBusy() < LOCAL.workers : running[lane] < laneMax(lane));

/**
 * Дописать в runs.jsonl изменившиеся прогоны и обрезать память до KEEP_JOBS последних. sync — при остановке сервера:
 * асинхронная запись могла бы не успеть до выхода процесса.
 */
export function flushRuns(sync = false) {
    if (DRY)
        return;
    const out = [];
    for (const j of jobList()) {
        const s = JSON.stringify(j);
        if (runsSeen.get(j.id) !== s) {
            runsSeen.set(j.id, s);
            out.push(s);
        }
    }
    if (jobList().length > KEEP_JOBS) {
        for (const j of jobList().slice(0, jobList().length - KEEP_JOBS))
            runsSeen.delete(j.id);
        keepLastJobs(KEEP_JOBS);
    }
    if (!out.length)
        return;
    if (sync) {
        try {
            fs.appendFileSync(RUNS_JSONL, out.join("\n") + "\n");
        }
        catch (e) {
            console.error("журнал прогонов:", e.message);
        }
    }
    else
        fs.appendFile(RUNS_JSONL, out.join("\n") + "\n", (e) => {
            if (e)
                console.error("журнал прогонов:", e.message);
        });
}

// Отметить изменение прогонов: страница узнаёт сразу (версия «jobs»), запись в журнал — пачкой через 200 мс.
export const save = () => {
    bumpVer("jobs");
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(flushRuns, 200);
};

export const findBash = () => findBashW();
export const killTree = (child) => killTreeW(child);

/** Запуск шага: строка — в оболочку; команда с аргументами — без оболочки (на Windows пускатель .cmd — через bash, tasks.mjs launchOf). */
export function spawnStep(job, step, write) {
    return new Promise((resolve) => {
        const opts = { cwd: step.cwd, windowsHide: true, env: { ...process.env, FORCE_COLOR: "0", ...(step.env || {}) } };
        let child;
        try {
            if (step.text)
                child = spawn(step.text, { ...opts, shell: true });
            else {
                const l = launchOf(step);
                child = spawn(l.file, l.args, { ...opts, shell: false });
            }
        }
        catch (e) {
            write(`✗ не удалось запустить: ${e.message}\n`);
            resolve(127);
            return;
        }
        // прогоны тестов и сборок не должны отнимать процессор у сервера и агентов
        lowerPriority(child);
        procs.set(job.id, child);
        child.stdout.on("data", (d) => write(String(d)));
        child.stderr.on("data", (d) => write(String(d)));
        child.on("error", (e) => {
            write(`✗ не удалось запустить: ${e.message}\n`);
            resolve(127);
        });
        child.on("close", (code) => {
            procs.delete(job.id);
            // процесс снят сигналом (отмена, предел времени) — код 130, как у оболочки после Ctrl+C
            resolve(code === null ? 130 : code);
        });
    });
}

// ───────────────────────────── прогресс ─────────────────────────────
// Этапы подготовки слота (slot-up), шаги «[i/N]» служебных скриптов, сьюты задач с именами спек.

export const SLOT_STAGES = [["worktree", "Папка и ветка"], ["prepare", "Подготовка"], ["дерево", "Проверка чистоты"]];
export const progKind = (task) => (task === "slot-up" ? "slotup" : task === "deploy-staging" || task === "release" ? "marks" : specAware(task) ? "suites" : null);
export const progBuf = new Map();
export const SPEC_SKIP = new Set(["node_modules", "dist", ".git", ".nuxt", ".output", ".next", "build", "coverage", "playwright-report", "test-results", ".turbo", "__pycache__", ".venv"]);
const SPEC_FILE = /\.(spec|test)\.[cm]?[jt]sx?$|_test\.go$|(^|\/)test_[^/]*\.py$|_test\.py$/;

export function listSpecs(dir, out = [], depth = 0) {
    let es;
    try {
        es = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const e of es) {
        if (SPEC_SKIP.has(e.name))
            continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (depth < 14)
                listSpecs(p, out, depth + 1);
        }
        else if (SPEC_FILE.test(e.name))
            out.push(p.replace(/\\/g, "/"));
    }
    return out;
}

/** Сколько спек, примерно, пройдёт прогон: спеки папки задачи, отобранные вводом (регулярка или имена). */
export function suiteTotal(job, p) {
    const task = TASKS[job.task];
    if (!task || !specAware(job.task))
        return null;
    const files = listSpecs(task.sub ? path.join(p, task.sub) : p);
    if (!job.input)
        return files.length || null;
    const names = suiteExpected(job);
    if (names.length)
        return names.length;
    let re;
    try {
        re = new RegExp(job.input, "i");
    }
    catch {
        return null;
    }
    return files.filter((f) => re.test(f)).length || null;
}

/** Прогресс по мере вывода: незаконченная строка куска ждёт следующего куска в progBuf. */
export function progFeed(job, chunk) {
    const lines = ((progBuf.get(job.id) || "") + chunk).split("\n");
    progBuf.set(job.id, lines.pop());
    for (const raw of lines) {
        const l = raw.replace(ANSI, "").trim();
        if (job.prog.kind === "slotup") {
            const mm = /^(✔|✓|✖|✗|–)\s+(.+?)(?:\s+—.*)?$/.exec(l);
            if (mm) {
                const i = SLOT_STAGES.findIndex((x) => mm[2].startsWith(x[0]));
                if (i >= 0) {
                    job.prog.stages[SLOT_STAGES[i][0]] = mm[1] === "✔" || mm[1] === "✓" ? "ok" : mm[1] === "✖" || mm[1] === "✗" ? "fail" : "skip";
                    job.prog.done = Object.keys(job.prog.stages).length;
                    const nx = SLOT_STAGES.find((x) => !job.prog.stages[x[0]]);
                    job.prog.phase = nx ? nx[1] : "готово";
                }
            }
            continue;
        }
        if (job.prog.kind === "marks") {
            if (job.stagesDef)
                standLine(job, l);
            const mm = /^\[(\d+)(?:\.\d+)?\/(\d+)\]\s*(.*)/.exec(l);
            if (mm) {
                job.prog.done = Math.max(job.prog.done, Number(mm[1]) - 1);
                job.prog.total = Number(mm[2]);
                job.prog.phase = mm[3].slice(0, 60);
            }
            continue;
        }
        if (lineVerdict(job.task, l))
            job.prog.done++;
    }
}

export const suiteBuf = new Map();
/** Итог спеки из строки поезда: поезд гоняет разные задачи — подходит разбор любой из них. */
const anyVerdict = (line) => {
    for (const id of Object.keys(SUITE_FAM)) {
        const v = lineVerdict(id, line);
        if (v)
            return v;
    }
    return null;
};

/** Итоги сьютов по мере вывода (а не перечитыванием большого лога на каждом опросе). */
export function suiteFeed(job, chunk) {
    let buf = (suiteBuf.get(job.id) || "") + chunk, i;
    while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(ANSI, "");
        buf = buf.slice(i + 1);
        const v = job.task === "train" ? anyVerdict(line) : lineVerdict(job.task, line);
        if (!v)
            continue;
        const b = sbase(v.spec);
        // красный итог спеки не перекрывается зелёным повтором той же спеки внутри прогона
        if (!job.suiteDone[b] || job.suiteDone[b] === "ok")
            job.suiteDone[b] = v.ok ? "ok" : "fail";
    }
    // хвост без перевода строки ограничен: вывод без переводов строк не раздует память
    suiteBuf.set(job.id, buf.slice(-4000));
}

/** Что прогон собирается пройти: имена спек из ввода, если ввод — список файлов спек. */
export function suiteExpected(job) {
    const si = specInput(job.task);
    if (!si || !job.input)
        return [];
    return si.names(job.input).filter((x) => SPEC_FILE.test(x));
}

/** Предел времени, минуты: служебные задачи — свои; задачи проекта — timeoutMin из конфига. */
export const TIME_LIMIT_MIN = { review: 25, train: 180, "slot-up": 40, merge: 10, "accept-run": 100 };
// Переменная окружения DASH_LIMIT_<ЗАДАЧА> перекрывает предел (тестам нужны короткие пределы).
const limitOf = (task) => Number(process.env["DASH_LIMIT_" + String(task).toUpperCase().replace(/-/g, "_")]) || TIME_LIMIT_MIN[task] || timeLimitMin(task) || 0;

// ───────────────────────────── где идут проверки ─────────────────────────────

const REMOTE_IDS = Object.keys(PROJECT.machines).filter((id) => id !== "local");
/** Модуль машин подключён и в конфиге есть удалённые машины. */
export function remoteOn() {
    if (!REMOTE_IDS.length)
        return false;
    try {
        return !!shardApi().on;
    }
    catch {
        return false;
    }
}
/** Задачи проекта, которые можно ставить на машины: { <id>: { kind: дорожка, heavy } }. */
export const REMOTE_TASKS = Object.fromEntries(Object.values(TASKS).map((t) => [t.id, { kind: t.lane, heavy: DIST_TASKS.has(t.id) || t.id === "build" }]));
/** Тяжёлые служебные прогоны: идут по одному (conflicted). Поезд гоняет проверки состава. */
export const HEAVY = new Set(["train"]);
/**
 * Поезд при удалённых машинах стоит в дорожке задач проекта (pipeline.startTrainRun) и берёт место тем же порядком,
 * что задачи: какие шаги пойдут, решает место (stepsFor).
 */
const placedTrain = (j) => HEAVY.has(j.task) && PROJECT_LANES.includes(j.lane);
/** Прогон берёт место через модуль машин: задача проекта или поезд в дорожке задач. */
const PROJECT_LOCAL_PREFER = !!(((PROJECT || {}).machines || {}).local || {}).prefer;
const takesPlace = (j) => !!REMOTE_TASKS[j.task] || placedTrain(j);
/** Прогон берёт место через модуль машин: машины включены, задача проекта (или поезд в её дорожке), у слота есть папка. */
export const remoteEligible = (j) => remoteOn() && takesPlace(j) && (j.tree === "orchestrator-staging" || !!(treeByKey(j.tree) || {}).path);
// Требования к месту: сколько прогон ждёт (правило мест со временем пускает его на эту машину) и тяжёлый ли он.
// only — закрепление прогона за машинами (полный прогон: окружное падение на удалённой повторяется на этой, fullRun.pin).
export const placeOpts = (j) => ({
    ageMs: Date.now() - (j.queuedAt || Date.now()), heavy: HEAVY.has(j.task) || !!(REMOTE_TASKS[j.task] || {}).heavy,
    only: Array.isArray(j.only) && j.only.length ? j.only : null, needs: [],
});
/** Прогон занял место удалённой машины (а не этой). */
const onRemote = (job) => !!(job.runOn && job.runOn !== "local");
/**
 * Шаги прогона на его месте: шаг с `on: "here"` идёт только на этой машине, с `on: "remote"` — только на удалённой,
 * без `on` — всегда (у поезда при машинах так описаны оба варианта проверок состава).
 */
export const stepsFor = (job) => {
    const where = onRemote(job) ? "remote" : "here";
    return (job.steps || []).filter((s) => !s.on || s.on === where);
};

// Кавычки sh: удалённая машина — всегда POSIX-оболочка, даже если сервер на Windows.
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
/** Команда для оболочки удалённой машины: хук проекта remoteCmd, иначе та же команда задачи (ввод в кавычках sh). */
export function remoteCmdFor(taskId, input) {
    const task = TASKS[taskId];
    if (!task)
        throw new Error("нет задачи «" + taskId + "»");
    if (PROJECT_HOOKS.remoteCmd) {
        const c = PROJECT_HOOKS.remoteCmd(taskId, input || "", task);
        if (typeof c === "string" && c.trim())
            return c;
    }
    const st = stepOfTask(task, ".", input || "");
    if (!st.text && !st.cmd)
        throw new Error("«" + task.label + "»: нет команды для удалённой машины");
    const cmd = st.text ? st.text : [st.cmd, ...st.args].map(q).join(" ");
    return task.sub ? `cd ${q(task.sub)} && ${cmd}` : cmd;
}

const fullRunNote = () => {
    try {
        const a = shardApi();
        if (!a.fullRunOn || !a.fullRunOn())
            return "";
        const n = a.fullRunLeft ? a.fullRunLeft() : 0;
        return "машины заняты полным прогоном staging" + (n ? " (частей осталось " + n + ")" : "") + " — проверки слотов идут после него; ";
    }
    catch {
        return "";
    }
};

/** Почему прогон ждёт места (строка для карточки); пусто — ждёт только свободного воркера. */
export const serverWait = (j) => {
    if (remoteEligible(j))
        return !shardApi().slotAnyOnline()
            ? (fullRunNote() || "удалённые машины не на связи: жду их; ") +
                  "эта машина возьмёт проверку после ожидания, если на ней свободно"
            : PROJECT_LOCAL_PREFER
              ? "ждёт свободное место: эта машина → удалённые (по свободной памяти и ЦП)"
              : "ждёт место: удалённые машины → эта (после ожидания и при свободной памяти)";
    if (isProjectLane(j.lane) && !localServes(j.lane))
        return "дорожку «" + j.lane + "» эта машина не обслуживает (machines.local.lanes) — нужна удалённая машина";
    return "";
};

/** Тяжёлый служебный прогон ждёт, пока идёт другой такой же: два поезда сразу перегрузили бы машину. */
export const conflicted = (j) => HEAVY.has(j.task) && jobList().some((x) => x !== j && x.picked && HEAVY.has(x.task) && !FINAL.includes(x.status));

// Прогон слота не стартует, пока агент этого слота пишет ответ или ему в пути указание: иначе он идёт на коде, который
// сейчас поменяется. Держится только этот слот; «всё равно» (force) снимает.
export const HOLD_FREE = new Set(["slot-up"]);
export function agentHold(j) {
    if (j.force || HOLD_FREE.has(j.task) || /^orchestrator/.test(j.tree))
        return "";
    const a = agents.get(j.tree), tag = (treeByKey(j.tree) || {}).tag || j.tree;
    if (a && !a.dead && a.busy && !a.pinging)
        return "ждёт, пока агент " + tag + " допишет ответ: он может менять код";
    if (settings.autoTrain && inboxCards().some((x) => x.kind === "relay" && x.to === j.tree && !x.note && !x.stale && !x.parked && Date.now() - x.at < 600e3))
        return "ждёт, пока агенту " + tag + " дойдёт указание оркестратора";
    return "";
}

/**
 * Прогон можно брать из очереди: проверка кнопки конвейера (gate pending) закончилась и агент слота не держит код.
 * Заодно пишет причину ожидания в карточку.
 */
export const holdOk = (j) => {
    if (j.gate === "pending") {
        j.waitReason = "проверяю условия перед запуском…";
        return false;
    }
    const h = agentHold(j);
    j.waitReason = h;
    return !h;
};

/** Пересчитать причины ожидания всех очередей и запустить всё, что можно. */
export const pumpAll = () => {
    for (const l of Object.keys(queues)) {
        for (const j of queues[l])
            j.waitReason = agentHold(j) || serverWait(j);
        pump(l);
    }
};

/** Очередь проверок по машинам для страницы: идут и ждут, на какой машине. Только чтение. */
export function queueView() {
    const rows = [];
    for (const j of jobList()) {
        if (!["running", "queued", "waiting"].includes(j.status) || !takesPlace(j))
            continue;
        const t = treeByKey(j.tree), run = j.status === "running";
        let mLabel = "";
        if (run && j.runOn)
            try {
                mLabel = j.runOn === "local" ? LOCAL.label : shardApi().machineLabel(j.runOn);
            }
            catch {
                mLabel = j.runOn;
            }
        rows.push({
            id: j.id,
            tag: t ? t.tag : j.tree === "orchestrator-staging" ? "staging" : String(j.tree).slice(0, 12),
            label: String(j.label || j.task)
                .replace(/ · [^·]+$/, "")
                .slice(0, 70),
            input: j.input ? String(j.input).slice(0, 50) : "",
            status: run ? "running" : "queued",
            machine: run ? j.runOn || "local" : null,
            mLabel,
            at: run ? j.startedAt : j.queuedAt,
            wait: run ? "" : String(j.waitReason || "").slice(0, 140),
        });
    }
    return rows.sort((a, b) => (a.status === b.status ? (a.at || 0) - (b.at || 0) : a.status === "running" ? -1 : 1)).slice(0, 60);
}

// Дорожки, которые идут и при подготовке к перезапуску: влив, выкат и коммит, начатые владельцем, не должны зависнуть.
export const DRAIN_PASS = new Set(["ops", "commit"]);

/** Места через модуль машин: короткие прогоны (меньше спек во вводе) — раньше; поезд — после всех. */
export function pumpRemote() {
    if (DRY || drainState() || !remoteOn())
        return;
    // Короткие прогоны раньше длинных: место освобождается быстрее, очередь у слотов движется.
    const cost = (j) => (j.task === "train" ? 5000 : 1000 + String(j.input || "").split(/[,|]/).length * 50);
    for (;;) {
        let pick = null;
        for (const lane of PROJECT_LANES)
            laneQ(lane).forEach((j, k) => {
                if (remoteEligible(j) && shardApi().slotFree(lane, placeOpts(j)) && holdOk(j) && !conflicted(j) && (!pick || cost(j) < cost(pick.j)))
                    pick = { lane, k, j };
            });
        if (!pick)
            return;
        // picked — прогон взят из очереди: более широкий новый прогон уже не снимет его как покрытого (enqueueRun)
        const next = queues[pick.lane].splice(pick.k, 1)[0];
        next.picked = true;
        // Место было свободно при выборе, но бронь не удалась (его занял другой прогон между вызовами) — вернуть на то же место
        // в очереди и ждать следующего освобождения.
        if (shardApi().slotReserve(next.id, pick.lane, placeOpts(next)) < 0) {
            queues[pick.lane].splice(pick.k, 0, next);
            next.picked = false;
            return;
        }
        next.runOn = shardApi().slotMachineOf(next.id) || REMOTE_IDS[0];
        const ml = next.runOn === "local" ? LOCAL.label : shardApi().machineLabel(next.runOn);
        next.label = next.label.replace(/ · [^·]+$/, "") + " · " + ml;
        runPicked(next).finally(() => {
            shardApi().slotRelease(next.id);
            pumpAll();
        });
    }
}

/**
 * Прогон, взятый из очереди. Сбой самой диспетчерской внутри прогона — красный прогон с причиной, а не необработанный
 * отказ (он остановил бы сервер); бронь места и счётчик дорожки снимает .finally того, кто взял прогон.
 */
function runPicked(job) {
    return runJob(job).catch((e) => {
        console.error("прогон " + job.id + ":", e && e.stack ? e.stack : e);
        if (!FINAL.includes(job.status)) {
            job.status = "fail";
            job.endedAt = Date.now();
            job.summary = "сбой диспетчерской во время прогона: " + (e && e.message ? e.message : String(e));
            logEvent("job.end", { id: job.id, tree: job.tree, task: job.task, status: "fail", crashed: true, summary: job.summary.slice(0, 300) });
            save();
        }
    });
}

/**
 * Запустить из очереди дорожки всё, что помещается в её предел. Задачи проекта сначала пробуют удалённые машины
 * (pumpRemote), сюда — те, что идут на этой машине.
 */
export function pump(lane) {
    if (DRY || (drainState() && !DRAIN_PASS.has(lane)))
        return;
    pumpRemote();
    const qq = laneQ(lane);
    while (qq.length && laneFree(lane)) {
        const i = qq.findIndex((j) => !remoteEligible(j) && holdOk(j) && !conflicted(j));
        if (i < 0)
            return;
        const next = qq.splice(i, 1)[0];
        next.picked = true;
        running[lane]++;
        runPicked(next).finally(() => {
            running[lane]--;
            // дорожки задач проекта делят воркеры этой машины: освободился воркер — шанс у всех дорожек
            if (isProjectLane(lane))
                for (const l of PROJECT_LANES)
                    if (l !== lane)
                        pump(l);
            pump(lane);
        });
    }
}

// ───────────────────────────── прогон ─────────────────────────────

/**
 * Выполнить прогон, взятый из очереди: службы → шаги (или одна команда на удалённой машине) → итог, сводка, журнал
 * и последствия (снимок, автопоезд, ревью, поезд, сверка со staging). Отпечаток кода до и после — чтобы итог относился
 * к определённому коду: страница и автопоезд отличают «зелёный на нынешнем коде» от «зелёный на прежнем».
 */
export async function runJob(job) {
    if (job.cancelled) {
        job.status = "cancelled";
        job.endedAt = Date.now();
        save();
        return;
    }
    // место уже известно: шаги этого места (до таймеров и лога — сбой здесь ничего не оставляет висеть)
    const steps = stepsFor(job);
    job.status = "running";
    job.startedAt = Date.now();
    job.waitReason = "";
    save();
    kick();
    logEvent("job.start", { id: job.id, tree: job.tree, task: job.task, input: job.input || "", runOn: job.runOn || "local", by: job.by || "" });
    const trJob = treeByKey(job.tree), trPath = trJob && exists(trJob.path) ? trJob.path : job.tree === "orchestrator-staging" ? MAIN : null;
    if (trPath) {
        job.fpStart = await codeFp(trPath, true);
        if (DIST_TASKS.has(job.task)) {
            const bs = buildStampOf(job.tree) || {};
            job.buildFp = bs.fp || null;
            job.buildJob = bs.job || null;
        }
    }
    {
        // сколько обычно идёт такой прогон: медиана последних зелёных (сначала этого слота) — по ней страница рисует шкалу
        const dur = (j) => j.endedAt - j.startedAt, done = jobList().filter((j) => j !== job && j.task === job.task && j.status === "ok" && j.startedAt && j.endedAt);
        const own = done.filter((j) => j.tree === job.tree), pool = (own.length ? own : done).slice(-5).map(dur).sort((a, b) => a - b);
        job.etaMs = pool.length ? pool[Math.floor(pool.length / 2)] : null;
    }
    const pk = progKind(job.task);
    if (pk) {
        let total = null;
        try {
            if (trPath && pk === "suites")
                total = suiteTotal(job, trPath);
        }
        catch { }
        const su = pk === "slotup", mk = pk === "marks";
        job.prog = {
            kind: pk,
            done: 0,
            total: su ? SLOT_STAGES.length : mk ? 5 : total,
            approx: !mk && !su,
            unit: su ? "этап" : mk ? "шаг" : "сьютов",
            phase: su ? SLOT_STAGES[0][1] : "",
            stages: su ? {} : undefined,
        };
        // экран выката стенда: этапы из stagesDef запуска (пуш диспетчерской + этапы release.stand.stages)
        if (mk && Array.isArray(job.stagesDef)) {
            job.prog.stages = {};
            job.prog.at = {};
            job.prog.total = job.stagesDef.length;
        }
    }
    const out = fs.createWriteStream(logPath(job.id), { flags: "a" });
    let tail = "";
    const suites = !!SUITE_FAM[job.task] || job.task === "train";
    const write = (s) => {
        out.write(s);
        job.size = (job.size || 0) + Buffer.byteLength(s);
        tail = (tail + s).slice(-6000);
        job.lastOutAt = Date.now();
        liveTail.set(job.id, tail);
        if (job.prog)
            progFeed(job, s);
        if (suites)
            suiteFeed(job, s);
    };
    if (suites) {
        job.suiteDone = {};
        job.suiteExp = suiteExpected(job);
        // прогон со списком спек знает, чего ждать: спеки без итога при долгой тишине — висящие
        if (job.suiteExp.length)
            job.hangList = job.suiteExp;
    }
    // Висящие спеки: прогон знает список спек, часть из них без итога, а вывод давно молчит — снять и назвать эти спеки
    // (иначе прогон простоял бы до общего предела времени, и причина была бы не видна).
    const markHung = (quietMin) => {
        if (job.hung || !job.hangList)
            return false;
        const miss = hungSpecs(job.hangList, job.suiteDone);
        if (!miss.length)
            return false;
        job.hung = { specs: miss, quietMin };
        job.cancelled = true;
        write("\n" + hangLogLines(miss, quietMin));
        logEvent("job.hung", { id: job.id, tree: job.tree, task: job.task, specs: miss, quietMin });
        if (job.runOn && job.runOn !== "local")
            shardApi().slotCancel(job.id, job.runOn).catch(() => { });
        try {
            killTree(procs.get(job.id));
        }
        catch { }
        return true;
    };
    const hangTimer = job.hangList ? setInterval(() => {
        if (hangDue({ listed: job.hangList, done: job.suiteDone, lastOutAt: job.lastOutAt }))
            markHung(Math.round((Date.now() - job.lastOutAt) / 60000));
    }, 30e3) : null;
    // away — прогон на месте удалённой машины; remoteRun — вся задача проекта идёт там одной командой (у поезда там идут
    // только проверки состава — его шагом `on: "remote"`)
    const away = onRemote(job), remoteRun = away && !!REMOTE_TASKS[job.task];
    const limMin = limitOf(job.task);
    const limTimer = limMin ? setTimeout(() => {
        if (markHung(Math.round((Date.now() - (job.lastOutAt || job.startedAt)) / 60000)))
            return;
        job.timedOut = limMin;
        job.cancelled = true;
        write("\n⏱ СНЯТ ПО ВРЕМЕНИ: прошло " + limMin + " мин — предел для «" + job.task + "». Процесс остановлен.\n");
        if (away)
            shardApi().slotCancel(job.id, job.runOn).catch(() => { });
        try {
            killTree(procs.get(job.id));
        }
        catch { }
    }, limMin * 60000) : null;
    let code = 0, softFail = 0, si = 0;
    // службы этой машины (machines.local.services) — перед прогоном, которому они нужны; удалённая машина поднимает свои сама
    const svcRun = !away && usesServices(job, TASKS) ? { jobId: job.id, key: job.tree, cwd: trPath || MAIN } : null;
    if (svcRun) {
        code = await localServices().up(svcRun, write, (c) => procs.set(job.id, c));
        procs.delete(job.id);
        if (job.cancelled)
            code = 130;
        else if (code)
            write(`\n✗ службы этой машины не готовы (код ${code}) — команды прогона не запускались\n`);
    }
    if (remoteRun) {
        // прогон на удалённой машине: снимок кода слота → машина → проверка; вывод идёт в тот же лог и разбор
        job.step = 1;
        job.stepsTotal = 1;
        try {
            code = await shardApi().slotRun(
                {
                    jobId: job.id,
                    key: job.tree,
                    cwd: trPath,
                    cmd: remoteCmdFor(job.task, job.input),
                    lane: job.lane,
                    heavy: !!REMOTE_TASKS[job.task].heavy,
                },
                write,
                (c) => procs.set(job.id, c),
                job.runOn,
            );
        }
        catch (e) {
            write(`\n✗ ${e.message}\n`);
            code = 1;
        }
        procs.delete(job.id);
        if (job.cancelled && code === 0)
            code = 130;
    }
    for (const step of remoteRun || code ? [] : steps) {
        job.step = ++si;
        job.stepsTotal = steps.length;
        if (job.stagesDef && job.prog)
            standStepStart(job, si);
        if (job.cancelled) {
            code = 130;
            break;
        }
        write(`\n$ ${step.show}\n  (в ${fwd(step.cwd)})\n`);
        if (step.js) {
            try {
                await step.js(write, job);
            }
            catch (e) {
                write(`\n✗ ${e.message}\n`);
                code = 1;
                break;
            }
            continue;
        }
        code = await spawnStep(job, step, write);
        if (code !== 0 && step.ignore && !job.cancelled) {
            write("\n(код " + code + " — для этого шага не важен)\n");
            code = 0;
            continue;
        }
        // мягкий шаг: красный не останавливает прогон, чтобы в одном логе были все падения (итог прогона — красный)
        if (code !== 0 && step.soft && !job.cancelled) {
            write(`\n✗ шаг красный (код ${code}), идём дальше: нужны все падения\n`);
            softFail = code;
            code = 0;
            continue;
        }
        // шаг с уборкой после падения (у влива — git merge --abort): рабочая папка возвращается к последнему коммиту
        if (code !== 0 && step.onFail && !job.cancelled) {
            write("\n$ " + step.onFail.show + "   (откат упавшего шага)\n");
            const c2 = await spawnStep(job, step.onFail, write);
            write(c2 === 0 ? "откат сделан: папка как до шага\n" : "✗ откат не прошёл (код " + c2 + ") — проверьте git status в " + fwd(step.onFail.cwd) + "\n");
        }
        if (code !== 0)
            break;
    }
    if (code === 0 && softFail)
        code = softFail;
    if (svcRun)
        await localServices().release(svcRun, write).catch((e) => write(`\n✗ остановка служб: ${e.message}\n`));
    if (limTimer)
        clearTimeout(limTimer);
    if (hangTimer)
        clearInterval(hangTimer);
    job.endedAt = Date.now();
    job.code = code;
    // отпечаток конца — до статуса: иначе страница на миг увидит «зелёный» без отпечатка
    if (trPath)
        job.fpEnd = await codeFp(trPath, true);
    if (trPath && (suites || job.task === "build" || job.task === "review" || TASK_AREA[job.task]))
        job.snap = await fileSnap(trPath).catch(() => null);
    job.status = job.timedOut || job.hung ? "fail" : job.cancelled ? "cancelled" : code === 0 ? "ok" : "fail";
    // подключение к удалённой машине не состоялось — не красный код: прогон вернётся в очередь, когда она снова на связи
    if (job.status === "fail" && !job.cancelled && !job.timedOut) {
        const f = infraFailure(tail, { runOn: remoteRun ? job.runOn : "", code });
        if (f) {
            job.status = "interrupted";
            job.infra = f.kind;
            job.infraWhy = f.label;
            job.infraLine = f.line;
            logEvent("job.infra", { id: job.id, tree: job.tree, task: job.task, kind: f.kind, line: f.line, try: job.infraTry || 0 });
        }
    }
    // фильтр не совпал ни с одной спекой: тестов по волне ещё нет — не поломка кода (skipped не просит починки)
    if (job.status === "fail" && /0 matches|No tests found|No test files found|no tests ran|не совпал[аои]?\s+ни с одним/i.test(tail))
        job.status = "skipped";
    // задаче дали несуществующее имя (часть, пакет, набор) — «неприменимо»: тестов не было, код ни при чём (na-rules.mjs)
    if (job.status === "fail" && !job.timedOut && !job.hung && TASKS[job.task] && TASKS[job.task].naLog) {
        // признак обычно в НАЧАЛЕ вывода (до каталога имён), а tail — последние 6000 знаков: читаем лог прогона
        const na = naOfLog(naLogText(job.id) || tail, TASKS[job.task]);
        if (na) {
            job.status = "skipped";
            job.na = na.line;
            job.naList = na.list;
        }
    }
    // отметка сборки — только если код за время сборки не менялся: иначе собран не тот код, что сейчас в папке
    if (trPath && job.task === "build" && job.status === "ok" && job.fpStart && job.fpStart === job.fpEnd)
        setBuildStamp(job.tree, { fp: job.fpEnd, at: Date.now(), job: job.id });
    setTimeout(() => withGitPriority(() => rebuildOne(job.tree)).catch(() => { }), 50);
    const lines = tail.replace(ANSI, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const totals = specAware(job.task) ? parseTaskLog(tail, job.task).totals : [];
    const key = totals.length ? totals : lines.filter((l) => /(Tests?:|Test Suites:|Test Files|passed|failed|FAIL|✗|OK —)/.test(l));
    job.summary = (key.length ? key.slice(-2) : lines.slice(-2)).join("  ·  ").slice(0, 260);
    if (job.infra)
        job.summary = "удалённая машина недоступна: " + job.infraWhy + " — не поломка кода, прогон вернётся в очередь сам" + ((job.infraTry || 0) >= 3 ? " (повторов исчерпано)" : "");
    if (job.na)
        job.summary = naSummary({ line: job.na });
    if (job.timedOut)
        job.summary = "⏱ СНЯТ ПО ВРЕМЕНИ (предел " + job.timedOut + " мин): " + job.summary;
    if (job.hung)
        job.summary = hangSummary(job.hung.specs, job.hangList, job.hung.quietMin);
    if (job.baseline && job.status === "fail" && !failingSpecs(job.id).length) {
        const msg =
            "Сверка со staging (" +
            job.id +
            ") не дошла до тестов: " +
            (job.summary || "см. лог") +
            ". Пока она не пройдёт, чужое красное в слотах не опознаётся как красное staging; повторы такого красного на том же коде диспетчерская сама не ставит.";
        console.error("сверка со staging:", msg);
        for (const a of agents.values())
            if (isOrch(a.key) && !a.dead)
                push(a, { id: "bsf-" + a.rev, t: "status", text: msg, bad: true });
    }
    liveTail.delete(job.id);
    progBuf.delete(job.id);
    suiteBuf.delete(job.id);
    logEvent("job.end", {
        id: job.id,
        tree: job.tree,
        task: job.task,
        input: job.input || "",
        status: job.status,
        code,
        sec: Math.round((job.endedAt - job.startedAt) / 1000),
        runOn: job.runOn || "local",
        fpStart: job.fpStart || null,
        fpEnd: job.fpEnd || null,
        summary: (job.summary || "").slice(0, 160),
    });
    if (job.task === "review" && job.status === "ok" && settings.autoTrain)
        setTimeout(() => autoChain(job.tree, "ревью «ЗА»").catch((e) => console.error("автопоезд после ревью:", e.message)), 3000);
    if (job.task === "merge" && job.status === "ok") {
        setTimeout(() => orchFollow("влив " + job.id).catch((e) => console.error("папка оркестратора:", e.message)), 1000);
        try {
            markMergedNow(job);
        }
        catch (e) {
            console.error("отметка влива:", e.message);
        }
        rebuildMerged(job).catch((e) => console.error("снимок после влива:", e.message));
        // после влива пересчитать все поезда: у влитого — следующий вагон, у зависимых вагонов других поездов — готова зависимость
        setTimeout(() => {
            for (const t of TREES.filter((x) => x.train))
                rebuildOne(t.key).then(() => kickTrainLate(t.key)).catch((e) => console.error("поезд после влива:", t.key, e.message));
        }, 3000);
    }
    if (job.reminder && job.status === "ok") {
        const r = remindersList().find((x) => x.id === job.reminder);
        if (r) {
            r.status = "done";
            r.doneAt = Date.now();
            saveRem();
        }
    }
    if (job.task === "deploy-staging" && job.status === "ok")
        setTimeout(() => {
            rebuildFresh().then(() => acceptAsk(null)).catch((e) => console.error("приёмка: опрос после выката:", e.message));
        }, 5000);
    try {
        if (job.task === "review") {
            parseReview(job);
            reviewToChat(job);
            if (job.review && job.review.verdict) {
                const rr = recordRelay("reviewer", job.tree, String(job.review.text || "").length, "review");
                rr.verdict = job.review.verdict;
            }
        }
    }
    catch (e) {
        console.error("ревью:", e.message);
    }
    try {
        recordSpecs(job);
    }
    catch (e) {
        console.error("история спек:", e.message);
    }
    try {
        autoRetry(job);
    }
    catch (e) {
        console.error("автоповтор:", e.message);
    }
    try {
        foreignRedBaseline(job);
    }
    catch (e) {
        console.error("сверка чужого красного:", e.message);
    }
    try {
        if (job.train)
            trainFinished(job);
        if (job.trainMerge && trainNow() && trainNow().id === job.trainMerge) {
            markTrain({ status: job.status === "ok" ? "merged" : "mergefail" });
            saveTrain();
        }
    }
    catch (e) {
        console.error("поезд:", e.message);
    }
    try {
        queueResult(job);
    }
    catch { }
    if (job.pipeline && job.status === "ok")
        rebuildFresh().catch((e) => console.error("снимок после git-операции:", e.message));
    if (job.task === "review")
        setTimeout(() => autoSendReview(job), 3000);
    try {
        if (job.baseline && ["ok", "fail"].includes(job.status))
            stagingRedClear(job);
        if (job.baseline && job.status === "fail")
            stagingRedCard(job);
    }
    catch (e) {
        console.error("красное staging:", e.message);
    }
    if (job.prog && job.status === "ok" && job.prog.total)
        job.prog.done = job.prog.total;
    if (job.task === "build" && afterBuild.has(job.tree)) {
        const list = afterBuild.get(job.tree);
        afterBuild.delete(job.tree);
        if (job.status === "ok")
            setTimeout(() => {
                for (const x of list)
                    runTask(job.tree, x.task, x.input).catch((e) => console.error("перезапуск после сборки:", e.message));
            }, 1500);
    }
    if (job.status === "ok")
        setTimeout(() => autoTrain(job), 3000);
    out.end(`\n── ${job.status} (код ${code}) за ${Math.round((job.endedAt - job.startedAt) / 1000)} с ──\n`);
    save();
}

// ───────────────────────────── постановка в очередь ─────────────────────────────

/** Ввод-регулярка `wide` покрывает `narrow` (прежнее имя — для модулей, которые его зовут). */
export const jestCovers = regexCovers;

/**
 * Защита от дублей на входе в очередь: живой (ждёт или идёт) прогон того же слота и задачи с тем же вводом в любой
 * записи (порядок, «,» или «|») или шире по составу — возвращается он, новый не ставится. Конвейер (влив, коммит) — мимо.
 */
export function liveTwin(treeKey, taskId, input, extra = {}) {
    if (extra.pipeline || taskId === "commit")
        return null;
    const ci = canonInput(taskId, input || "");
    const live = jobList().filter((j) => j.tree === treeKey && j.task === taskId && ["queued", "waiting", "running"].includes(j.status) && !j.cancelled);
    return live.find((j) => canonInput(taskId, j.input || "") === ci || (ci && jobCovers(j, { task: taskId, input: input || "" }))) || null;
}

// Бронь на время постановки: второй одновременный вызов того же прогона ждёт первый и получает его задачу.
const enqInflight = new Map();

/** Какой вагон проверяет прогон у слота-поезда. */
function trainScopeOf(key) {
    try {
        const t = snapNow() && snapNow().trees.find((x) => x.key === key);
        if (!t || !t.train || !t.wagon)
            return {};
        return { wagons: { scope: "wagon", waves: [t.wagon] } };
    }
    catch {
        return {};
    }
}

/**
 * Поставить прогон в очередь → запись прогона (новую или уже живую такую же). Одновременные вызовы с тем же
 * слотом, задачей и вводом получают один и тот же прогон: проверка дублей асинхронная (git), иначе прошли бы оба.
 */
export function enqueue(args) {
    const { treeKey, taskId, input, extra = {} } = args;
    if (extra.pipeline || taskId === "commit")
        return enqueueRun(args);
    const k = treeKey + "|" + taskId + "|" + canonInput(taskId, input || ""), cur = enqInflight.get(k);
    if (cur)
        return cur;
    const p = enqueueRun(args).finally(() => {
        if (enqInflight.get(k) === p)
            enqInflight.delete(k);
    });
    enqInflight.set(k, p);
    return p;
}

async function enqueueRun({ treeKey, cwd, label, taskId, input, steps, lane, profile, extra = {} }) {
    {
        const tw = liveTwin(treeKey, taskId, input, extra);
        if (tw) {
            console.log("очередь:", taskId, String(input || "").slice(0, 80), "— такой уже", tw.status === "running" ? "идёт" : "в очереди", tw.id, "— второй не ставлю");
            logEvent("job.dedup", { tree: treeKey, task: taskId, input: String(input || "").slice(0, 200), twin: tw.id, by: extra.by || "" });
            return tw;
        }
    }
    if (input && !extra.pipeline && specInput(taskId)) {
        // покрытое прогоном в очереди не ставим; покрытое новым — снимаем из очереди
        const same = (j) => j.tree === treeKey && j.task === taskId && ["queued", "waiting"].includes(j.status) && !j.picked;
        const cover = jobList().find((j) => same(j) && jobCovers(j, { task: taskId, input }));
        if (cover) {
            console.log("очередь:", taskId, input, "покрыт", cover.id, "— не ставлю");
            return cover;
        }
        for (const j of jobList().filter((x) => same(x) && jobCovers({ task: taskId, input }, { task: taskId, input: x.input || "" }))) {
            for (const qq of Object.values(queues)) {
                const i = qq.indexOf(j);
                if (i >= 0)
                    qq.splice(i, 1);
            }
            j.status = "cancelled";
            j.endedAt = Date.now();
            j.summary = "снят: его спеки входят в более широкий прогон «" + input + "»";
        }
    }
    {
        const x = slotOf(treeKey);
        const no = x && NEED_PKGS.has(taskId) ? areaRefusal(x, taskId) : "";
        if (no)
            throw new Error(no);
    }
    // Дерево кода и чистота папки при постановке: по ним видно, на каком коде прогон ставили и были ли незакоммиченные правки.
    const [tree, st] = await Promise.all([git(cwd, ["rev-parse", "HEAD^{tree}"]), git(cwd, ["status", "--porcelain"])]);
    const job = {
        id: `j${nextSeq()}`, epic: epicOfKey(treeKey), tree: treeKey, task: taskId, label, input: input || "", lane, status: "queued", queuedAt: Date.now(),
        treeSha: tree.out, cleanAtStart: !st.out.split("\n").some((l) => l && !l.startsWith("??")), steps, ...trainScopeOf(treeKey), ...extra,
    };
    addJob(job);
    laneQ(lane).push(job);
    job.waitReason = serverWait(job);
    save();
    pump(lane);
    logEvent("job.queued", { id: job.id, tree: treeKey, task: taskId, input: input || "", lane, by: job.by || "", auto: !!job.auto });
    return job;
}

// Прогоны общих линий (staging, main) без эпика: эпик выката — тот, чьи вагоны он вёз.
export const jobEpic = (j) => {
    if (j.epic)
        return j.epic;
    const fallback = j.epic !== undefined ? j.epic : epicOfKey(j.tree);
    if (fallback || j.task !== "deploy-staging" || !Array.isArray(j.wagons))
        return fallback;
    for (const w of j.wagons) {
        const e = epicOfKey(w && w.key);
        if (e)
            return e;
    }
    return fallback;
};

/**
 * Задача кнопки конвейера: встаёт в очередь сразу (ждёт, пока идёт проверка), проверка — в check() → { ok, why, label?, extra? }.
 * ok: задача снимается с удержания и идёт как обычно; не ok: она тут же падает с причиной (status fail, gateFailed).
 */
export async function enqueueChecked(args, check) {
    const job = await withGitPriority(() => enqueue({ ...args, extra: { ...(args.extra || {}), gate: "pending" } }));
    job.waitReason = "проверяю условия перед запуском…";
    save();
    Promise.resolve().then(check).catch((e) => ({ ok: false, why: "проверка не завершилась: " + e.message })).then((res) => {
        if (job.cancelled || FINAL.includes(job.status))
            return;
        if (res && res.ok) {
            job.gate = "ok";
            job.waitReason = "";
            if (res.label)
                job.label = res.label;
            if (res.extra)
                Object.assign(job, res.extra);
            save();
            pump(job.lane);
            return;
        }
        for (const qq of Object.values(queues)) {
            const i = qq.indexOf(job);
            if (i >= 0)
                qq.splice(i, 1);
        }
        job.gate = "failed";
        job.gateFailed = true;
        job.status = "fail";
        job.endedAt = Date.now();
        job.waitReason = "";
        job.summary = "Не запущено: " + ((res && res.why) || "условия не выполнены");
        logEvent("job.end", { id: job.id, tree: job.tree, task: job.task, status: "fail", gateFailed: true, summary: job.summary.slice(0, 300) });
        save();
        kick();
    });
    return job;
}

// Перезапуск сервера не должен терять работу: прогоны проверок, оборванные остановкой или сбоем связи с удалённой
// машиной, ставятся в очередь заново (один раз). Выкат, влив и коммит заново сами не запускаются.
export const isBaselineJob = (j) => !!(j && (j.baseline || (j.tree === "orchestrator-staging" && j.by === "сверка со staging")));

/**
 * Вернуть в очередь прогоны, оборванные перезапуском сервера или недоступностью удалённой машины (когда она снова на связи).
 * Не возвращаются: конвейер (влив, выкат), прогоны старше 6 ч, слоты без папки и прогоны, которые на нынешнем коде уже
 * не нужны (ворота runGate: зелёный или дважды красный на этом коде).
 */
export async function requeueInterrupted() {
    const hostBack = () => {
        try {
            return remoteOn() && shardApi().slotAnyOnline();
        }
        catch {
            return false;
        }
    };
    for (const j of jobList().filter((x) => !x.requeued && (x.bootInterrupted || infraRequeueDue(x, { hostUp: hostBack() })))) {
        j.requeued = true;
        const task = TASKS[j.task], isStg = j.tree === "orchestrator-staging", tree = isStg ? null : treeByKey(j.tree);
        if (!task || j.pipeline || (isBaselineJob(j) && !STAGING_BASELINE_RUNS) || (Date.now() - (j.queuedAt || 0)) > 6 * 3600e3 || (!isStg && (!tree || !exists(tree.path))))
            continue;
        try {
            const cwd = isStg ? MAIN : tree.path;
            // тот же прогон за время ожидания мог пройти — тогда возвращать нечего
            if (!isStg) {
                const inp = task.input ? j.input || "" : "",
                    g = runGate({
                        jobs: jobList().filter((x) => x !== j),
                        tree: j.tree,
                        task: j.task,
                        input: inp,
                        fp: await codeFp(cwd, true),
                        dist: DIST_TASKS.has(j.task),
                        covers: (k) => jobCovers(k, { task: j.task, input: inp }),
                        realFail,
                        inherited: (k) => onlyStagingRed(k.id),
                    });
                if (!g.run) {
                    console.log("после перезапуска не возвращаю", j.id, j.task, j.tree, "—", g.why);
                    continue;
                }
            }
            const steps = task.dynamic ? await task.dynamic(cwd) : [stepOfTask(task, cwd, j.input || "")];
            if (!steps)
                continue;
            await enqueue({
                treeKey: j.tree,
                cwd,
                label: task.label,
                taskId: j.task,
                input: task.input ? j.input || "" : "",
                lane: task.lane,
                steps,
                extra: {
                    requeuedFrom: j.id,
                    by: j.by || "",
                    ...(j.baseline ? { baseline: true, auto: true } : {}),
                    ...(j.infra ? { infraTry: (j.infraTry || 0) + 1 } : {}),
                },
            });
            console.log("снова в очереди после перезапуска:", j.id, j.task, j.tree);
        }
        catch (e) {
            console.error("не поставил заново", j.id, e.message);
        }
    }
    save();
}

export const liveTail = new Map();

// Списки сьютов и текст ревью уходят только для идущих прогонов и по отдельному запросу (full): ответ /api/state лёгкий.
export const publicJob = (j, full = false) => {
    const { steps, snap, suiteDone, suiteExp, review, ...rest } = j;
    const qq = queues[j.lane] || [], i = qq.indexOf(j);
    const t = j.status === "running" ? liveTail.get(j.id) : null;
    const tailLines = t ? t.replace(ANSI, "").split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-7).map((l) => l.slice(0, 220)) : undefined;
    const live = full || !FINAL.includes(j.status);
    // место выбрано — шаги этого места; ждёт места — все варианты
    const shown = j.picked && Array.isArray(steps) ? stepsFor(j) : steps || [];
    return { ...rest, epic: jobEpic(j), cmd: shown.map((s) => s.show).join(" → "), pos: i >= 0 ? i + 1 : undefined, tailLines,
        ...(live ? { suiteDone, suiteExp } : { suiteN: suiteExp ? suiteExp.length : undefined }), ...(review ? { review: full ? review : { verdict: review.verdict } } : {}) };
};
