// stations.mjs — станции волны: авто-отметки по git и истории прогонов, содержимое станции по клику, улики красного
// теста. Набор тестов и гардов — из PROJECT.stations; гард нужен только при правке продуктового кода (пути областей
// конфига).
//
// Станции волны по порядку — STATIONS: план → красный тест → код → сборка → гарды → тесты → ревью → регресс → коммит →
// staging → стенд → приёмка → прод → сайт. Станции модулей (ревью, выкат, приёмка) есть, только когда модуль включён.
//
// Кто зовёт: снимок (snapshot.mjs) на каждое дерево — withStages: вердикт проверок t.verdict и отметки t.stages; страница —
// stationInfo по клику на станцию; relay.mjs после хода агента — afterSlotTurn, строка «СВОДКА», «ПРИНЯТЬ РЕВЬЮ»;
// http.mjs и annot.mjs — ручные отметки; pipeline.mjs — конфликт, найденный при вливе (noteConflict).
// Файлы данных: stages.json — ручные отметки станций (S.manual), summaries.json — строка «СВОДКА» агента (S.summaries).
//
// Инварианты:
// - проверка засчитывается только «на нынешнем коде»: прогон, чей отпечаток кода (fingerprint.mjs codeFp) совпадает с
//   текущим; иначе вердикт «stale» и станция не пройдена. Исключения — сборка, если её входы не менялись, и ревью «ЗА»,
//   если после него менялись только тесты и документы;
// - ручная отметка сильнее авто-отметки: «отмечено» проходит станцию, «снято» снимает её даже при авто-отметке;
// - влитая ветка без нового кода впереди staging несёт проверки, пройденные до влива; доделка после влива — проверки заново;
// - у поезда ручные отметки — по вагону дерева (ветка одна на все вагоны), у слота — по ветке.
import { MAIN, PROJECT, fwd } from "../slots.mjs";
import fs from "node:fs";
import { readJson, saveJson, writeJsonSync } from "./store.mjs";
import path from "node:path";
import { S } from "./state.mjs";
import { kick, rebuildOne, snapNow } from "./snapshot.mjs";
import { jobList } from "./jobs.mjs";
import { accEntry, accKey, checklistOf, chkKey, wagonAccepted } from "./accept.mjs";
import { agents, deliver, ensureAgent } from "./agents.mjs";
import { markSlotDone } from "./slot-done.mjs";
import { brief } from "./epic-journal.mjs";
import { autoAnswer } from "./auto-owner.mjs";
import { branchChanges, workChanges } from "./changes.mjs";
import { ANSI, DATA, DRY, FINAL, logEvent, logPath, settings } from "./config.mjs";
import { syncAskOf, syncMarkOf } from "./epics.mjs";
import { branchOfMerge, wavesOfMerge } from "./train-rules.mjs";
import { ACC_SPEC_RE, DOC_RE, SPEC_RE, specOnlyOf, buildInput, DIST_TASKS, buildStampOf, codeFp, jobFresh, productFiles, setBuildStamp } from "./fingerprint.mjs";
import { firstCommitAt, git, stagingTreeSha, untrackedShim, withGitPriority } from "./git.mjs";
import { addCard, ibId, inboxCards, keepCards } from "./inbox.mjs";
import { late } from "./late.mjs";
import { verdictJob } from "./loops.mjs";
import { depsOf } from "./pipeline.mjs";
import { prompt } from "../prompts.mjs";
import {
    BASE_TASKS,
    ENV_FAIL_RE,
    SUITE_FAM,
    changedBetween,
    curSnapOf,
    entrySuites,
    failingSpecs,
    inheritedRed,
    jobCovers,
    onlyStagingRed,
    regressPlan,
    specsPassedSince,
    stagingBase,
    stagingSpecSets,
    suiteLedger,
    suitesPublic,
    touchedFiles,
} from "./regress.mjs";
import { parseTaskLog } from "./parsers.mjs";
import { PRESETS, TREES, isOrch, orchOfKey, trainWaveOf, treeByKey } from "./trees.mjs";
import { TASKS, buildHow, buildNeed } from "./tasks.mjs";
import { autoChain, frozenAfterCommit } from "./autochain.mjs";
import { applyTrain } from "./trains.mjs";
import { enabled } from "./modules.mjs";
import { planIsStub } from "./slot-rules.mjs";

// Поздняя привязка: relay.mjs сам импортирует этот модуль (afterSlotTurn), прямой импорт замкнул бы круг.
const { failureExcerpt, pruneDeadPresets, reqItemStatus, testReqsOf } = late("relay.mjs", ["failureExcerpt", "pruneDeadPresets", "reqItemStatus", "testReqsOf"]);

/** Гарды и тесты станций — из конфига проекта. */
const GUARDS = PROJECT.stations.guards;
const TEST_DEFAULT = PROJECT.stations.tests.filter((id) => TASKS[id] && !TASKS[id].input).map((task) => ({ task, input: "" }));
const label = (id) => (TASKS[id] || {}).label || id;
const STAND_URL = PROJECT.release.stand.url || PROJECT.accept.standUrl || "";

export const STATIONS = [
    { id: "plan", label: "План", how: "есть файл .claude/plans/waves/WV-NNNN*.md (в слоте или в staging)" },
    {
        id: "red",
        label: "Красный тест",
        how: "в ветке есть тесты и улики красного: тесты раньше кода в истории, или красный прогон был до зелёного",
    },
    { id: "impl", label: "Код", how: "в ветке есть коммиты или изменённые файлы" },
    {
        id: "build",
        label: "Сборка",
        how: "сборка зелёная в дашборде; или не нужна — правка не касается областей со сборкой",
    },
    {
        id: "guards",
        label: "Гарды",
        how: "гарды проекта (stations.guards) зелёные на нынешнем коде; нужны, только если тронут продуктовый код",
    },
    { id: "tests", label: "Тесты", how: "все тесты волны из карточки зелёные в дашборде на нынешнем коде" },
    {
        id: "review",
        label: "Ревью",
        how:
            "независимый ревьюер (отдельная сессия, только чтение) сказал «ЗА» на нынешнем коде; «ВОПРОСЫ» — " +
            "замечания ушли агенту, после правок автопоезд ставит новое ревью; принять без него — кликом",
    },
    {
        id: "regress",
        label: "Регресс",
        how: "соседи по тронутым путям зелёные на нынешнем коде: спеки тронутых областей, где упомянуты изменённые файлы, или задача области целиком",
    },
    { id: "commit", label: "Коммит", how: "все изменения слота закоммичены: коммиты впереди staging и чистое дерево" },
    { id: "staging", label: "В staging", how: "в staging есть merge-коммит этой ветки" },
    { id: "stand", label: "На стенде", how: "после вливания стенд выкачен из дашборда" },
    {
        id: "accept",
        label: "Приёмка",
        how: "в панели «Приёмка» по этой волне вердикт «принято» (по коммиту влива: доделка вливается новым коммитом — и приёмка заново)",
    },
    { id: "prod", label: "В проде", how: "merge-коммит ветки дошёл до main" },
    { id: "site", label: "На сайте", how: "только вручную: проверили результат на живом сайте" },
];

export const STAGES_FILE = path.join(DATA, "stages.json");

// ───────────────────────────── ручные отметки и сводки ─────────────────────────────

export function loadStationMarks() {
    S.manual = readJson(STAGES_FILE, {}) || {};
}

export function loadSummaries() {
    S.summaries = readJson(SUMMARY_FILE, {}) || {};
}

/** Ключ ручных отметок «ключ|ветка»; у поезда — с номером вагона дерева: ветка поезда одна, а отметки у каждого вагона свои. */
export const manualKeyOf = (k) => {
    const w = trainWaveOf(String(k).split("|")[0]);
    return w ? k + "#" + w : k;
};

/** Ручная отметка станции: true — пройдена, false — снята, null — вернуть авто; note — пояснение (видно в станции). */
export function markStage(k0, stage, value, note) {
    const k = manualKeyOf(k0);
    S.manual[k] = { ...(S.manual[k] || {}) };
    if (typeof note === "string")
        S.manual[k][stage + "_note"] = note.slice(0, 4000);
    if (value === null)
        delete S.manual[k][stage];
    else if (value === true || value === false)
        S.manual[k][stage] = value;
    writeJsonSync(STAGES_FILE, S.manual, 1);
}

export function markReviewAccepted(k0, note) {
    const k = manualKeyOf(k0);
    S.manual[k] = { ...(S.manual[k] || {}), review: true, review_note: note };
    writeJsonSync(STAGES_FILE, S.manual, 1);
}

export function setSummary(key, v) {
    S.summaries[key] = v;
    saveJson(SUMMARY_FILE, S.summaries);
}

/** Статус в заголовке доклада слота «(слот …): ГОТОВО|ЧАСТИЧНО|ЖДУ|СТОП|ВОПРОС». */
export const SLOT_STATUS_RE = /\(слот [^)\n]*\):\s*\**\s*(ГОТОВО|ЧАСТИЧНО|ЖДУ|СТОП|ВОПРОС)/;

/**
 * Раздел «Вопросы владельцу:» из ответа агента → текст пунктов или null. Раздел кончается пустой строкой, блоком кода или
 * следующим заголовком «Слово:». Пункты-«шум» (просьбы нажать кнопку, «решений нет», напоминания «когда …») выкидываются:
 * карточка в «Ждут вашего действия» должна требовать решения, а не действия, которое диспетчерская делает сама.
 */
export function ownerQuestions(text) {
    const ls = String(text || "").split(/\r?\n/), strip = (l) => l.replace(/^[\s>#*_]+|[\s*_]+$/g, "");
    const i = ls.findIndex((l) => /^вопрос(?:ы)?\s+владельцу[^:\n]{0,40}:/i.test(strip(l)));
    if (i < 0)
        return null;
    const out = [], first = strip(ls[i]).replace(/^[^:]*:\s*/, "");
    if (first)
        out.push(first);
    for (const l of ls.slice(i + 1)) {
        const s = l.trim();
        if (s.startsWith("```") || (/^[А-ЯЁA-Z][^:\n]{0,60}:$/.test(strip(l)) && !/^\d/.test(s)))
            break;
        if (!s) {
            if (out.length)
                break;
            continue;
        }
        out.push(s);
    }
    const items = [], cur = [];
    for (const l of out) {
        if (/^\s*\d+[.)]\s/.test(l) && cur.length) {
            items.push(cur.join("\n"));
            cur.length = 0;
        }
        cur.push(l);
    }
    if (cur.length)
        items.push(cur.join("\n"));
    const noise = (x) =>
        (/нажм(и|ите)|нажать|кнопк[ауеиой]/i.test(x) && !/\?/.test(x)) ||
        /^\s*(\d+[.)]\s*)?(решений нет|вопросов нет|нет вопросов|ничего не нужно)/i.test(x) ||
        /^\s*(\d+[.)]\s*)?когда\b[^?]*$/i.test(x);
    const q = items.filter((x) => !noise(x)).join("\n").trim();
    return q && !/^(нет|—|-)\.?$/i.test(q) ? q.slice(0, 2000) : null;
}

/**
 * После хода агента: доклад «ГОТОВО» — отметка «волна закончена» и толчок автопоезда; раздел «Вопросы владельцу» —
 * карточка (или автоответ в режиме «без владельца»).
 */
export function afterSlotTurn(key, text) {
    const q = ownerQuestions(text);
    if (!isOrch(key)) {
        const hs = SLOT_STATUS_RE.exec(text);
        if (hs && hs[1] === "ГОТОВО") {
            const tt = treeByKey(key);
            if (tt && tt.path)
                // Отпечаток кода на момент доклада: «волна закончена» верно только для этого кода (ворота заморозки сверяют его).
                // Толчок автопоезда — с паузой, чтобы снимок успел увидеть отметку.
                codeFp(tt.path, true).then((fp) => {
                    markSlotDone(key, fp);
                    if (!DRY)
                        setTimeout(() => autoChain(key, "доклад ГОТОВО").catch(() => { }), 5000);
                }).catch((e) => console.error("отметка ГОТОВО:", e.message));
        }
        if (!hs && !q)
            return;
    }
    else if (!q)
        return;
    // Новый ответ заменяет прежнюю карточку вопросов этого дерева: старые вопросы либо повторены, либо уже не нужны.
    keepCards((x) => !(x.kind === "ownerq" && x.tree === key));
    // Режим «без владельца»: на вопросы с рекомендуемым вариантом отвечает автоответ; вопросы без рекомендации и вопросы
    // только для человека остаются карточкой.
    if (q && !DRY && (settings.autoOwnerUntil || 0) > Date.now()) {
        const ans = autoAnswer(q);
        if (ans) {
            logEvent("auto.owner", { tree: key, skipped: ans.skipped.length });
            setTimeout(() => ensureAgent(key).then((a) => {
                if (!a.busy)
                    deliver(a, ans.text, "auto-owner", { owner: true });
            }).catch((e) => console.error("автоответ владельца:", e.message)), 1500);
            if (!ans.skipped.length)
                return;
        }
    }
    if (q) {
        addCard({ id: ibId(), kind: "ownerq", tree: key, text: q, at: Date.now(), sid: (agents.get(key) || {}).sessionId || null });
        logEvent("owner.question", { tree: key, n: (q.match(/^\s*\d+[.)]\s/gm) || []).length || 1, chars: q.length, brief: brief(q) });
    }
}

// ───────────────────────────── вливы и планы ─────────────────────────────

/**
 * Вливы в staging, новые первыми: merge-коммиты первой линии плюс вливы веток с боковой линии staging за 45 дней (их видно
 * только без --first-parent). Боковые берутся лишь по STAGING_MERGE_RE, чтобы подтягивание staging в ветку не сошло за влив.
 */
export async function stagingMerges() {
    const rows = (out) => (out ? out.split("\n").filter(Boolean).map((l) => {
        const [sha, ct, subject] = l.split("\t");
        return { sha, ct: Number(ct) * 1000, subject: subject || "" };
    }) : []);
    const fp = rows((await git(MAIN, ["log", "staging", "--merges", "--first-parent", "--format=%H%x09%ct%x09%s", "-400"])).out);
    const side = rows((await git(MAIN, ["log", "staging", "--merges", "--since=45.days", "--format=%H%x09%ct%x09%s"], 60000)).out)
        .filter((x) => STAGING_MERGE_RE.test(x.subject));
    const seen = new Set(fp.map((x) => x.sha));
    return [...fp, ...side.filter((x) => !seen.has(x.sha))].sort((a, b) => b.ct - a.ct);
}

/** Все вливы ветки дерева (новые первыми): ветка из темы merge-коммита совпадает целиком, а не подстрокой. */
export const treeMerges = (t, merges) => (t.branch ? merges.filter((x) => branchOfMerge(x.subject) === t.branch) : []);

/**
 * Влив дерева в staging → запись из stagingMerges или null. У поезда ветка общая на все вагоны, поэтому берётся влив
 * с номером вагона дерева: прошлые вливы той же ветки — другие вагоны. Одна функция для снимка и станций «В staging»,
 * «На стенде», «В проде», чтобы страница и вердикт не показывали разные вливы.
 */
export function treeMerge(t, merges) {
    if (!t.branch || ["staging", "main", "HEAD"].includes(t.branch))
        return null;
    return treeMerges(t, merges).find((x) => !t.train || wavesOfMerge(x.subject).includes(t.wagon)) || null;
}

export const STAGING_MERGE_RE = /^(?:merge: (?:dev|hotfix)\/|Merge branch '(?:dev|hotfix)\/[^']+' into staging)/;

export const orchDirOf = (t) => {
    const o = treeByKey(isOrch(t.key) ? t.key : orchOfKey(t.key));
    return (o && o.path) || (TREES[0] && TREES[0].path) || null;
};

/**
 * Файл плана WV-NNNN в первой из папок bases, где он есть: <папка>/.claude/plans/waves/WV-NNNN*.md. Одна функция на все
 * поиски плана — раньше их было три, и одна из них принимала за план любой файл с номером волны (заметку, картинку).
 */
function findPlan(num, bases) {
    for (const base of bases.filter(Boolean)) {
        try {
            const d = path.join(base, ".claude", "plans", "waves"), f = fs.readdirSync(d).find((x) => x.toUpperCase().startsWith(num) && x.endsWith(".md"));
            if (f)
                return path.join(d, f);
        }
        catch { }
    }
    return null;
}

/** Файл плана волны: сначала в папке слота, потом в основной папке, потом в папке эпика оркестратора. */
export function planFileOf(t) {
    const num = (t.wave || "").toUpperCase();
    return num ? findPlan(num, [t.path, MAIN, orchDirOf(t)]) : null;
}

/** План вагона поезда: сначала папка эпика — планы вагонов пишет оркестратор, в ветку поезда они не попадают. */
export function wagonPlanFile(t, wave) {
    const num = String(wave || "").toUpperCase();
    return /^WV-\d{4}$/.test(num) ? findPlan(num, [orchDirOf(t), t.path, MAIN]) : null;
}

export function planIsStubOf(t) {
    try {
        const f = t && planFileOf(t);
        return !!f && planIsStub(fs.readFileSync(f, "utf8"));
    }
    catch {
        return false;
    }
}

/** План есть: файл WV-NNNN в одной из папок или раздел «**WV-NNNN» в плане эпика (_EPIC/MASTER) — волна описана там. */
export function planExists(t) {
    const num = (t.wave || "").toUpperCase();
    if (!num)
        return false;
    if (planFileOf(t))
        return true;
    const orchWaves = path.join(orchDirOf(t) || "", ".claude", "plans", "waves");
    try {
        return fs.readdirSync(orchWaves).filter((f) => /^(_EPIC|MASTER).*\.md$/i.test(f))
            .some((f) => fs.readFileSync(path.join(orchWaves, f), "utf8").toUpperCase().includes(`**${num}`));
    }
    catch {
        return false;
    }
}

// ───────────────────────────── вердикт проверок и станции дерева ─────────────────────────────

/**
 * Вердикт проверок и станции дерева для снимка: заполняет t.verdict, t.stages, t.regress, t.review, t.suites, t.conflict и др.
 * Порядок важен: сначала отпечаток кода и вагон поезда (от них свежесть всех прогонов и ключ ручных отметок), потом проверки,
 * потом быстрые пути (только спеки, разведка, вагон без тестов) переписывают вердикт, и в конце — перенос проверок влитой
 * ветки и сами станции.
 */
export async function withStages(t, merges) {
    if (!t.exists)
        return t;
    t.fp = await codeFp(t.path);
    if (t.train)
        await applyTrain(t);
    const auto = {};
    // Влив этой ветки; у поезда — только влив с номером вагона дерева: прошлые вливы той же ветки — другие вагоны.
    const m = treeMerge(t, merges);
    if (planExists(t))
        auto.plan = "найден файл плана волны";
    {
        const re = await redEvidence(t);
        t.redEvidence = re.applies ? { done: re.done, suspicious: re.suspicious, tests: re.testFiles.length } : null;
        if (re.applies && re.done)
            auto.red =
                "красный тест: " +
                re.testFiles.length +
                " тест. файл(ов), " +
                (re.order === "tests-first"
                    ? "тесты раньше кода"
                    : re.seq === "red-green"
                      ? "красный → зелёный"
                      : "красный прогон был");
    }
    if (t.ahead > 0)
        auto.impl = `коммитов впереди staging: ${t.ahead}`;
    else if (t.dirtyTracked > 0)
        auto.impl = `изменено файлов: ${t.dirtyTracked} (не закоммичено)`;
    else if (m)
        auto.impl = "код влит в staging";
    if (t.ahead > 0 && !t.dirtyTracked)
        auto.commit = `коммитов впереди staging: ${t.ahead}, дерево чистое`;
    else if (m)
        auto.commit = "влито в staging";
    t.deps = await depsOf(t.key).catch(() => []);
    const bn = await buildNeed(t);
    t.buildNeeded = bn.needed;
    t.buildWhat = bn.what;
    const hasCode = t.ahead > 0 || t.dirtyTracked > 0 || t.dirtyUntracked > 0;
    t.hasCode = hasCode;
    {
        const oq = inboxCards().find((x) => x.kind === "ownerq" && x.tree === t.key);
        t.ownerQ = oq ? oq.text : null;
    }
    if (!bn.needed && t.exists && hasCode)
        auto.build = "сборка не нужна: правка не касается областей со сборкой";
    const bj = [...jobList()].reverse().find((j) => j.tree === t.key && j.task === "build" && ["ok", "fail"].includes(j.status));
    let bfresh = bj && bj.status === "ok" ? jobFresh(bj, t) : "no";
    // Код менялся после сборки, но не в её входах (тесты, документы): сборка годна, отметка сборки переносится на новый код.
    if (bj && bj.status === "ok" && bfresh !== "ok" && bj.snap) {
        const cur = await curSnapOf(t).catch(() => null);
        if (cur && [...new Set([...Object.keys(bj.snap), ...Object.keys(cur)])].filter(buildInput).every((f) => (bj.snap[f] || "—") === (cur[f] || "—"))) {
            bfresh = "ok";
            if (t.fp && (buildStampOf(t.key) || {}).fp !== t.fp)
                setBuildStamp(t.key, { fp: t.fp, at: Date.now(), job: bj.id, carried: true });
        }
    }
    // Прогон на удалённой машине собирает там сам: его зелёный итог на этом коде засчитывает и сборку.
    if (bn.needed && bfresh !== "ok") {
        const rj = [...jobList()].reverse().find((j) => j.tree === t.key && j.runOn && DIST_TASKS.has(j.task) && j.status === "ok");
        if (rj && jobFresh(rj, t) === "ok") {
            bfresh = "ok";
            auto.build = "сборка шла на удалённой машине перед прогоном " + rj.id + " на текущем коде";
        }
    }
    if (bn.needed && bfresh === "ok" && !auto.build)
        auto.build = "сборка зелёная на текущем коде: " + bn.what;
    // Пресеты задачи, которые не нашли ни одной спеки, снимаются до подсчёта: иначе станция «Тесты» ждала бы их вечно.
    try {
        await pruneDeadPresets(t);
    }
    catch (e) {
        console.error("пресеты без спек:", e.message);
    }
    // Тесты волны: пресеты слота, иначе тесты по умолчанию из конфига (без ввода), иначе первый гард — чтобы станции было что ждать.
    const entries0 = (PRESETS[t.key] || []).length ? PRESETS[t.key] : TEST_DEFAULT.length ? TEST_DEFAULT : GUARDS.slice(0, 1).map((task) => ({ task, input: "" }));
    const taskIds = entries0.map((p) => p.task);
    const last = (id) => [...jobList()].reverse().find((j) => j.tree === t.key && j.task === id && ["ok", "fail"].includes(j.status));
    // Прогон-ответ по задаче: падение по признакам сбоя окружения (ENV_FAIL_RE) не считается — это не ответ о коде.
    const answerOf = (id, input) => verdictJob({ jobs: [...jobList()].reverse().filter((j) => j.tree === t.key && !(j.status === "fail" && ENV_FAIL_RE.test(j.summary || ""))),
        task: id, input, fp: t.fp, fresh: (j) => jobFresh(j, t) === "ok" });
    const L = suiteLedger(t), cur = await curSnapOf(t), entries = entries0;
    t.suites = [];
    const states = entries.map((p) => {
        const j = answerOf(p.task, p.input || "");
        // Красный прогон на коде, который потом менялся, — «stale», а не «fail»: агент мог уже починить. Красное только от staging
        // (те же спеки красные на самом staging) ветке не вменяется.
        let st = !j ? "none" : j.status === "fail" ? (j.fpEnd && j.fpEnd !== t.fp ? "stale" : onlyStagingRed(j.id) ? "ok" : "fail") : jobFresh(j, t);
        const es = SUITE_FAM[p.task] ? entrySuites(t, p, L, cur) : null;
        if (es) {
            t.suites.push({ kind: "tests", task: p.task, input: p.input || "", state: es.state, fam: es.fam, ...suitesPublic(es) });
            if (st !== "ok")
                st = es.state === "ok" ? "ok" : es.state === "fail" ? "fail" : st;
        }
        return st;
    });
    let tv = states.includes("fail") ? "fail" : states.every((x) => x === "ok") ? "green" : states.includes("none") ? "none" : states.includes("nobuild") ? "nobuild" : "stale";
    // Зелёное при уже идущем прогоне той же задачи — ещё не итог: ждём новый результат.
    if (tv === "green" && jobList().some((j) => j.tree === t.key && ["running", "queued", "waiting"].includes(j.status) && entries.some((p) => p.task === j.task)))
        tv = "stale";
    t.verdict = {
        tests: tv,
        build: !bn.needed
            ? "notneeded"
            : bfresh === "ok"
              ? "ok"
              : !bj
                ? "none"
                : bj.status === "fail"
                  ? "fail"
                  : "stale",
        note:
            tv === "nobuild"
                ? "тесты зелёные, но без сборки на этом коде: dist мог быть от старого кода. Соберите и прогоните заново."
                : tv === "stale"
                  ? "зелёные тесты шли на другом коде: файлы менялись после прогона. Прогоните заново."
                  : "",
        bnote:
            bn.needed && bj && bj.status === "ok" && bfresh !== "ok"
                ? "сборка была на другом коде: файлы менялись после неё. Соберите заново."
                : "",
    };
    if (tv === "green")
        auto.tests = `зелёные на текущем коде: ${taskIds.join(", ")}`;
    {
        // Просьбы перепрогнать (строки ПРОГНАТЬ): пока не выполнены, станция не пройдена. После коммита и доклада ГОТОВО волна
        // заморожена — просьба уходит поезду влива, а отметка остаётся.
        const pend = (testReqsOf(t.key) || []).filter((r) => ["todo", "run", "stale"].includes(reqItemStatus(t.key, r, t).status));
        applyReqs(t, auto, pend, pend.length ? frozenAfterCommit(t.key, t.fp) : "");
    }
    const touched = t.readOnly ? [] : await touchedFiles(t.path);
    t.touched = touched.filter((f) => !/__tests__\//.test(f));
    t.prodTouched = productFiles(touched).length;
    t.accTouched = touched.some((f) => ACC_SPEC_RE.test(f));
    {
        // гард нужен только при правке продуктового кода (пути областей конфига) или спек приёмки
        const need = !!(t.prodTouched || t.accTouched);
        const gs = GUARDS.map((id) => answerOf(id)), gst = gs.map((j) => (!need ? "ok" : !j ? "none" : j.status === "fail" ? "fail" : jobFresh(j, t)));
        t.verdict.guards =
            t.readOnly || !GUARDS.length || (!need && !gs.some(Boolean))
                ? "notneeded"
                : gst.includes("fail")
                  ? "fail"
                  : gst.every((x) => x === "ok")
                    ? "green"
                    : gst.includes("none")
                      ? "none"
                      : "stale";
        {
            const red = gs.find((j, i) => gst[i] === "fail");
            if (t.verdict.guards === "fail" && red) {
                t.verdict.gfailJob = red.id;
                t.verdict.gfail = "гарды красные на этом коде (" + red.id + "): " + String(red.summary || "").replace(/\s+/g, " ").slice(0, 220);
            }
        }
        t.verdict.gnote = t.verdict.guards === "stale" ? "гарды были зелёными на другом коде: файлы менялись после прогона. Прогоните заново." : "";
        if (t.verdict.guards === "green")
            auto.guards = need ? "гарды зелёные на текущем коде: " + GUARDS.map(label).join(", ") : "продуктовый код не тронут — гарды не нужны (их проверит поезд влива)";
        else if (t.verdict.guards === "notneeded")
            auto.guards = t.readOnly ? "слоту разведки гарды не нужны" : !GUARDS.length ? "в конфиге проекта нет гардов" : "продуктовый код не тронут — гарды не нужны";
    }
    {
        // Регресс — соседи по тронутым путям. Красное, которое есть и на самом staging (сверка прогоном staging), унаследовано и
        // ветке не вменяется; упавшие спеки, прошедшие позже на этом же коде, — зелёные.
        const plan = t.readOnly ? [] : regressPlan(touched, t.path);
        const stgSets = plan.some((it) => BASE_TASKS.has(it.task)) ? await stagingSpecSets().catch(() => null) : null;
        const calc = (it) => {
            const j = [...jobList()].reverse().find((k) => k.tree === t.key && jobCovers(k, it) && ["ok", "fail", "running", "queued", "waiting"].includes(k.status));
            let st = !j ? "none" : ["running", "queued", "waiting"].includes(j.status) ? "run" : j.status === "fail" ? "fail" : jobFresh(j, t), base = null, inh = null;
            if (j && j.status === "fail") {
                const fl = failingSpecs(j.id);
                if (fl.length && specsPassedSince(fl, t.key, t.fp, j.endedAt || 0)) {
                    st = "ok";
                    base = "упавшие спеки набора (" + fl.length + ") прошли позже на нынешнем коде";
                }
            }
            if (st === "fail" && j.fpEnd && j.fpEnd !== t.fp)
                st = "stale";
            if (st === "fail" && BASE_TASKS.has(it.task)) {
                const mine = failingSpecs(j.id);
                const b = mine.length && mine.every((f) => inheritedRed(j, f)) ? null : stagingBase(it, mine, stgSets);
                if (mine.length && mine.every((f) => inheritedRed(j, f))) {
                    st = "inherited";
                    inh = mine;
                }
                else if (b && b.virtual)
                    base = b.why;
                else if (!b)
                    base = "сверка со staging поставлена в очередь";
                else if (!FINAL.includes(b.status))
                    base = "сверка со staging идёт (" + b.id + ")";
                else if (b.status === "ok")
                    base = "на staging этот набор зелёный: красное принесла ветка";
                else {
                    const theirs = failingSpecs(b.id);
                    if (!theirs.length)
                        base = "сверка со staging не удалась, до тестов не дошла (" + b.id + "): " + String(b.summary || "").slice(0, 120);
                    else if (mine.length && mine.every((f) => theirs.includes(f))) {
                        st = "inherited";
                        inh = mine;
                    }
                    else
                        base = "на staging тоже красно, но у ветки упало другое: " + mine.filter((f) => !theirs.includes(f)).join(", ");
                }
            }
            return { j, st, base, inh };
        };
        t.regress = plan.map((it) => {
            let { j, st, base, inh } = calc(it);
            if (SUITE_FAM[it.task]) {
                const es = entrySuites(t, it, L, cur);
                if (es) {
                    t.suites.push({ kind: "regress", task: it.task, input: it.input || "", state: es.state, fam: es.fam, ...suitesPublic(es) });
                    if (!["ok", "inherited", "run"].includes(st) && es.state === "ok")
                        st = "ok";
                    else if (["ok", "inherited"].includes(st) && es.state === "stale")
                        st = "stale";
                }
            }
            return { ...it, label: (TASKS[it.task] || {}).label || it.task, status: st, jobId: j ? j.id : null, base, inherited: inh };
        });
        const rs = t.regress.map((x) => (x.status === "inherited" ? "ok" : x.status));
        t.verdict.regress = !rs.length ? "notneeded" : rs.includes("fail") ? "fail" : rs.every((x) => x === "ok") ? "green" : rs.includes("run") ? "run" : rs.includes("none") ? "none" : "stale";
        t.verdict.rnote =
            t.verdict.regress === "fail"
                ? "регресс красный: " +
                  t.regress
                      .filter((x) => x.status === "fail")
                      .map((x) => x.label + (x.input ? " " + x.input : ""))
                      .join(", ")
                : t.verdict.regress === "stale" || t.verdict.regress === "nobuild"
                  ? "регресс шёл на другом коде: прогоните заново"
                  : "";
        {
            const inh = t.regress.filter((x) => x.status === "inherited");
            if (inh.length)
                t.verdict.rnote = (t.verdict.rnote ? t.verdict.rnote + "; " : "") + "красное унаследовано от staging, не от ветки: " + inh.map((x) => x.inherited.join(", ")).join("; ");
        }
        if (t.verdict.regress === "green")
            auto.regress = "соседи зелёные на текущем коде (красное staging не в счёт): " + t.regress.map((x) => x.label + (x.input ? " " + x.input : "")).join("; ");
        else if (t.verdict.regress === "notneeded" && hasCode)
            auto.regress = t.readOnly ? "слоту разведки регресс не нужен" : "тронутые пути не задевают соседей";
    }
    {
        // Ревью: последний прогон ревьюера; если у него нет вердикта (оборвался), берётся последний с вердиктом на том же коде.
        const rAll = [...jobList()].reverse().filter((j) => j.tree === t.key && j.task === "review" && ["ok", "fail"].includes(j.status));
        const last = rAll[0], withVerdict = rAll.find((j) => j.review && j.review.verdict);
        const rj = last && !(last.review && last.review.verdict) && withVerdict && withVerdict.fpEnd === last.fpEnd ? withVerdict : last;
        const rv = rj && rj.review;
        let rf = !!rj && rj.fpStart === rj.fpEnd && rj.fpEnd === t.fp;
        let carried = [];
        // «ЗА» переживает правки только тестов и документов: смысл кода, который смотрел ревьюер, не менялся.
        if (!rf && rv && rv.verdict === "ЗА" && rj.snap && cur) {
            const moved = changedBetween(rj.snap, cur);
            if (moved.every((f) => SPEC_RE.test(f) || DOC_RE.test(f))) {
                rf = true;
                carried = moved;
            }
        }
        t.review = rj
            ? {
                  verdict: (rv && rv.verdict) || null,
                  fresh: rf,
                  jobId: rj.id,
                  reported: !!rj.reported,
                  reportedAt: rj.reportedAt || null,
                  text: rv ? String(rv.text || "").slice(0, 1500) : "",
              }
            : null;
        if (t.readOnly)
            auto.review = "разведке ревью не нужно";
        else if (rf && rv && rv.verdict === "ЗА")
            auto.review = carried.length
                ? "независимый ревьюер «ЗА» (" +
                  rj.id +
                  "); после него менялись только тесты и документы: " +
                  carried.slice(0, 4).join(", ") +
                  (carried.length > 4 ? " …" : "")
                : "независимый ревьюер «ЗА» на нынешнем коде";
    }
    // Быстрый путь: правка только спек (и документов) не задевает соседей и не требует сборки и ревью; спеки приёмки идут на
    // стенде, поэтому и станция «Тесты» не нужна.
    t.specOnly = specOnlyOf(touched, hasCode);
    if (t.specOnly && t.verdict) {
        t.verdict.regress = "notneeded";
        t.verdict.rnote = "";
        auto.regress = "быстрый путь: правка только спек — соседей не задевает";
        t.buildNeeded = false;
        if (t.verdict.build !== "ok") {
            t.verdict.build = "notneeded";
            t.verdict.bnote = "";
        }
        auto.build = auto.build || "быстрый путь: правка только спек — сборка не нужна";
        auto.review = auto.review || "быстрый путь: правка только спек и документов — ревью не нужно";
        if (touched.every((f) => ACC_SPEC_RE.test(f) || DOC_RE.test(f))) {
            t.verdict.tests = "notneeded";
            t.verdict.note = "";
            auto.tests = "быстрый путь: спеки приёмки идут на стенде, а не здесь";
        }
    }
    t.summary = S.summaries[t.key]
        ? { ...S.summaries[t.key], src: "agent" }
        : t.ahead > 0
          ? {
                text: (await git(t.path, ["log", "--format=%s", "-3", "staging..HEAD"])).out
                    .split("\n")
                    .filter(Boolean)
                    .join(" · "),
                src: "commits",
            }
          : null;
    // Конфликт со staging — пробным слиянием merge-tree в фоне: снимок не ждёт git, результат кешируется по ветке, последнему
    // коммиту, коду и дереву staging, а готовый ответ перестраивает только это дерево.
    if (t.ahead > 0 && t.branch && !["staging", "main", "HEAD"].includes(t.branch)) {
        const ck = t.branch + "|" + ((t.last && t.last.sha) || "") + "|" + t.fp + "|" + stagingTreeSha();
        if (!stgConflict.has(ck)) {
            stgConflict.set(ck, null);
            withGitPriority(() => git(MAIN, ["merge-tree", "--write-tree", "--name-only", "staging", t.branch], 60000, true)).then((r) => {
                const ls = String(r.out || "").split(/\r?\n/);
                const files = [];
                for (const l of ls.slice(1)) {
                    if (!l.trim())
                        break;
                    files.push(l.trim());
                }
                stgConflict.set(ck, r.ok ? [] : files.length ? files : ["(см. git merge-tree)"]);
                rebuildOne(t.key).catch(() => { });
            });
        }
        t.conflict = stgConflict.get(ck);
    }
    if (t.readOnly && t.verdict) {
        t.verdict.tests = "notneeded";
        t.verdict.note = "";
        auto.tests = "слоту разведки тесты не нужны: кода он не пишет";
    }
    // У вагона без своих тестов станция «Тесты» не нужна; гарды поезда — отдельная станция.
    if (t.train && !(PRESETS[t.key] || []).length && t.verdict) {
        t.verdict.tests = "notneeded";
        t.verdict.note = "";
        auto.tests = "у вагона " + (t.wagon || "") + " нет своих тестов — станция не нужна (гарды — своя станция)";
    }
    t.syncAsk = syncAskOf(t.key);
    t.syncMark = syncMarkOf(t.key);
    if (!t.train)
        t.firstCommitAt = await firstCommitAt(t.path, m ? m.sha + "^1.." + m.sha + "^2" : t.ahead > 0 ? "staging..HEAD" : "", m ? m.sha : t.path + "|" + ((t.last && t.last.sha) || ""));
    mergedCarry(t, auto, m);
    // Влив есть, но впереди staging снова коммиты — волну открыли заново (reopened): станция «В staging» не пройдена.
    const landed = mergeLanded(t, m);
    if (m) {
        t.merge = { sha: m.sha, ct: m.ct, all: treeMerges(t, merges).map((x) => x.sha) };
        if (landed)
            auto.staging = `влито: ${m.sha.slice(0, 10)}`;
        else
            t.reopened = { ahead: t.ahead, sha: m.sha.slice(0, 10) };
    }
    if (t.train) {
        t.trainMerges = treeMerges(t, merges).map((x) => x.sha);
        const lastDep = [...jobList()].reverse().find((j) => j.task === "deploy-staging" && j.status === "ok");
        // Вагоны на стенде: все их вливы были до начала последнего удачного выката стенда.
        t.standWaves = lastDep ? (t.wagons || []).map((w) => w.wave).filter((wv) => {
            const mm = treeMerges(t, merges).filter((x) => wavesOfMerge(x.subject).includes(wv));
            return mm.length && mm.every((x) => x.ct <= lastDep.startedAt);
        }) : [];
    }
    if (landed) {
        const dep = jobList().find((j) => j.task === "deploy-staging" && j.status === "ok" && j.startedAt >= m.ct);
        if (dep)
            auto.stand = `стенд выкачен запуском ${dep.id}`;
        if (t.train) {
            if (wagonAccepted(t.key, t.wagon))
                auto.accept = "вагон " + t.wagon + " принят в приёмке";
        }
        else {
            const e = accEntry(accKey(t));
            if (e && e.verdict === "accepted")
                auto.accept = "принято в приёмке" + (e.sentAt ? ", итоги отправлены" : "");
        }
        if ((await git(MAIN, ["merge-base", "--is-ancestor", m.sha, "main"])).ok)
            auto.prod = "слияние ветки есть в main";
    }
    const mk = S.manual[manualKeyOf(`${t.key}|${t.branch}`)] || {};
    dropEmptyChecks(t, auto, mk);
    t.stages = stagesOf(t, auto, mk);
    return t;
}

// ───────────────────────────── правила вердикта ─────────────────────────────

const GUARD_REQ = new Set(GUARDS);

/**
 * Невыполненные просьбы перепрогнать (pend) снимают авто-отметки «Сборка» и «Тесты» и ставят вердикт «requested».
 * frozen — волна закоммичена и доложена: отметки остаются, в пояснении — «проверит поезд влива». Просьбы про гарды
 * «Тесты» не держат (у гардов своя станция); build — просьба пересобрать, а не перепрогнать.
 */
export function applyReqs(t, auto, pend, frozen) {
    const name = (r) => ((TASKS[r.task] || {}).label || r.task) + (r.input ? " " + r.input : "");
    const pb = pend.filter((r) => r.task === "build"), pt = pend.filter((r) => r.task !== "build" && !GUARD_REQ.has(r.task));
    if (pb.length && frozen) {
        t.verdict.bnote = "просили пересобрать после коммита: " + pb.map(name).join(", ") + " — проверит поезд влива";
    }
    else if (pb.length) {
        delete auto.build;
        t.verdict.build = "requested";
        t.verdict.bnote = "попросили пересобрать: " + pb.map(name).join(", ");
    }
    if (pt.length && frozen) {
        t.verdict.note = "просили перепрогнать после коммита: " + pt.map(name).join(", ") + " — проверит поезд влива";
    }
    else if (pt.length) {
        delete auto.tests;
        t.verdict.tests = "requested";
        t.verdict.note = "попросили перепрогнать: " + pt.map(name).join(", ");
    }
}

/** Влив считается состоявшимся, только если своего кода впереди staging нет: доделка после влива — волна открыта. */
export const mergeLanded = (t, m) => !!m && !(t.ahead > 0);

/**
 * Влитая ветка без доделки (ни коммитов впереди, ни правок): проверки шли до влива, вердикт — зелёный, пояснения сняты.
 * Свои авто-отметки сильнее «влито»; «не нужна» остаётся «не нужна».
 */
export function mergedCarry(t, auto, m) {
    if (!(m && !(t.ahead > 0) && !t.dirtyTracked))
        return;
    const v = t.verdict;
    for (const k of ["tests", "guards", "regress"])
        if (v[k] !== "notneeded")
            v[k] = "green";
    if (v.build !== "notneeded")
        v.build = "ok";
    v.note = v.gnote = v.bnote = v.rnote = "";
    v.merged = true;
    for (const k of ["build", "tests", "guards", "regress", "review"])
        auto[k] = auto[k] || "влито в staging: проверки шли до влива";
    for (const k of ["plan", "red", "impl", "commit"])
        auto[k] = auto[k] || "влито в staging: станция пройдена до влива";
}

/**
 * Оптимистичная отметка влива сразу после него, до следующего снимка: страница не показывает влитую ветку «невлитой»
 * несколько секунд. Снимок потом сверит по git. Ручные отметки не трогаются.
 */
export function markMergedTree(t, { sha = null, at = Date.now() } = {}) {
    if (!t || t.kind !== "slot" || !(t.ahead > 0))
        return t;
    const clean = !t.dirtyTracked, v = { ...(t.verdict || {}) };
    if (clean) {
        for (const k of ["tests", "guards", "regress"])
            if (v[k] !== "notneeded")
                v[k] = "green";
        if (v.build !== "notneeded")
            v.build = "ok";
        v.note = v.gnote = v.bnote = v.rnote = "";
        v.merged = true;
    }
    const carry = clean ? ["build", "tests", "guards", "regress", "review"] : [];
    const stages = (t.stages || []).map((s) => s.done || s.source === "manual" ? s
        : s.id === "staging" ? { ...s, done: true, source: "auto", hint: "влито: " + (sha ? sha.slice(0, 10) : "только что") + " (снимок ещё сверит)" }
            : carry.includes(s.id) ? { ...s, done: true, source: "auto", hint: "влито в staging: проверки шли до влива" } : s);
    return { ...t, ahead: 0, verdict: v, stages, conflict: null, merge: { sha, ct: at, all: [sha, ...((t.merge && t.merge.all) || [])].filter(Boolean), optimistic: true } };
}

/**
 * Пустая ветка (ни коммитов, ни правок, не влита) — авто-отметки проверок снимаются: зелёное staging — не «Гарды» и не
 * «Тесты» этой волны. Закоммиченное, влитое и отмеченное вручную не трогается.
 */
export function dropEmptyChecks(t, auto, mk) {
    if (!t.hasCode && !t.readOnly && !auto.commit && !auto.staging && !mk.commit && !mk.staging)
        for (const k of ["build", "guards", "tests", "review", "regress"])
            delete auto[k];
}

/** Станции модулей: без включённого модуля их у ветки нет (ревью, стенд, приёмка, прод, сайт). */
export const STATION_MODULE = { review: "review", stand: "release", prod: "release", site: "release", accept: "accept" };
export const stationOn = (id) => !STATION_MODULE[id] || enabled(STATION_MODULE[id]);

/** Станции дерева по порядку STATIONS: ручная отметка сильнее авто; открытый вопрос владельцу — «?» на станции «План». */
export function stagesOf(t, auto, mk) {
    return STATIONS.filter((s) => stationOn(s.id)).map((s) => {
        const man = mk[s.id], a = auto[s.id] || "";
        const done = man === true || (man !== false && !!a);
        const q = s.id === "plan" && !!t.ownerQ;
        return {
            id: s.id,
            label: s.label,
            done,
            q,
            source: man === true || man === false ? "manual" : a ? "auto" : "none",
            hint: q
                ? "вопрос владельцу: " + t.ownerQ.slice(0, 600)
                : man === true
                  ? "отмечено вручную"
                  : man === false
                    ? `снято вручную${a ? " (авто: " + a + ")" : ""}`
                    : a ||
                      (s.id === "tests" && t.verdict && t.verdict.note) ||
                      (s.id === "build" && t.verdict && t.verdict.bnote) ||
                      (s.id === "guards" && t.verdict && t.verdict.gnote) ||
                      (s.id === "regress" && t.verdict && t.verdict.rnote) ||
                      `не пройдено · авто: ${s.how}`,
        };
    });
}

export const SUMMARY_FILE = path.join(DATA, "summaries.json");

/** Конфликт со staging, найденный не здесь (например, при попытке влива), — сразу в кеш конфликтов и в снимок дерева. */
export function noteConflict(key, files) {
    const t = snapNow() && snapNow().trees.find((x) => x.key === key);
    if (!t || !t.branch)
        return;
    stgConflict.set(t.branch + "|" + ((t.last && t.last.sha) || "") + "|" + t.fp + "|" + stagingTreeSha(), files && files.length ? files : ["(см. git merge-tree)"]);
    rebuildOne(key).catch(() => { });
}

export const stgConflict = new Map();

// ───────────────────────────── содержимое станции по клику ─────────────────────────────

export async function commitFor(t) {
    const blocks = [];
    if (t.dirtyTracked || t.dirtyUntracked) {
        const files = await workChanges(t.path).catch(() => []);
        for (const f of files)
            if (f.untracked && f.add == null) {
                try {
                    const p = path.join(t.path, f.path), st = fs.statSync(p);
                    if (st.isFile() && st.size < 2e6)
                        f.add = fs.readFileSync(p, "utf8").split(String.fromCharCode(10)).length;
                }
                catch { }
            }
        const add = files.reduce((n, f) => n + (f.add || 0), 0), del = files.reduce((n, f) => n + (f.del || 0), 0);
        blocks.push({ kind: "kv", items: [["не закоммичено", t.dirtyTracked + " изменённых, " + t.dirtyUntracked + " новых файлов · +" + add + " −" + del + " строк"]] });
        if (files.length)
            blocks.push({ kind: "files", title: "Изменения в рабочем дереве", files });
    }
    if (t.ahead)
        blocks.push({ kind: "commits", title: "Коммиты впереди staging", commits: t.commits || [] });
    if (!blocks.length)
        blocks.push({ kind: "empty", text: "В ветке нет ни коммитов, ни изменений." });
    return { blocks, actions: t.dirtyTracked ? [{ id: "agent-commit", label: "Коммит силами агента" }] : [] };
}

export function guardsFor(t) {
    if (t.readOnly)
        return { blocks: [{ kind: "empty", text: "Слот только читает код (разведка): гарды перед слиянием ему не нужны, станция отмечена как не требуемая." }], actions: [] };
    const blocks = [];
    if (t.verdict && t.verdict.gnote)
        blocks.push({ kind: "empty", text: t.verdict.gnote });
    if (!GUARDS.length)
        blocks.push({ kind: "empty", text: "В конфиге проекта гардов нет (stations.guards и задачи с gate: true)." });
    for (const id of GUARDS) {
        const j = lastOf(t.key, id), def = TASKS[id] || { label: id };
        if (t.prodTouched === 0 && !t.accTouched && !j) {
            blocks.push({
                kind: "job",
                job: { status: "none", label: def.label, input: "" },
                text: "Не нужен: продуктовый код волны не тронут (только тесты, спеки, документы). Гарды проверит поезд влива.",
            });
            continue;
        }
        if (!j) {
            blocks.push({ kind: "job", job: { status: "none", label: def.label, input: "" }, text: "Не запускали." });
            continue;
        }
        const txt = readLogFull(j.id), p = parseTestLog(txt, id), bad = ["fail", "interrupted"].includes(j.status);
        blocks.push({ kind: "tests", job: jobBrief(j), totals: p.totals, passed: p.passed, failed: p.failed, names: p.names, text: bad ? failureExcerpt(txt) : "" });
    }
    return { blocks, actions: GUARDS.length ? [{ id: "run-guards", label: "Запустить гарды: " + GUARDS.map(label).join(", ") }] : [] };
}

export const TEST_FILE = SPEC_RE;
export const DOC_ONLY = DOC_RE;
export const redCache = new Map();

/**
 * Улики красного теста по истории ветки и прогонам тестов волны (с кешем по состоянию дерева и списку прогонов).
 * order — что появилось раньше в коммитах: тесты или код; seq — был ли красный прогон до зелёного.
 * done — улики есть; suspicious — тесты есть, но первый же прогон зелёный и порядка «тест → код» нет (ложная зелень?).
 */
export async function redEvidence(t) {
    if (!t.exists || isOrch(t.key) || t.readOnly)
        return { applies: false };
    const tasks = new Set((PRESETS[t.key] || []).map((p) => p.task));
    const runs = jobList().filter((j) => j.tree === t.key && tasks.has(j.task) && ["ok", "fail"].includes(j.status)).sort((a, b) => a.queuedAt - b.queuedAt);
    const key = [t.key, t.tree, t.dirtyTracked, t.dirtyUntracked, t.ahead, runs.map((j) => j.id + j.status).join(",")].join("|");
    const hit = redCache.get(t.key);
    if (hit && hit.key === key)
        return hit.v;
    const [diff, untr, log] = await Promise.all([
        git(t.path, ["diff", "--name-only", "staging"], 60000),
        untrackedShim(t.path),
        git(t.path, ["log", "--reverse", "--name-only", "--format=@@%h", "staging..HEAD"], 60000),
    ]);
    const all = [...new Set((diff.out + "\n" + untr.out).split("\n").map((x) => x.trim()).filter(Boolean))];
    const testFiles = all.filter((f) => TEST_FILE.test(f)), srcFiles = all.filter((f) => !TEST_FILE.test(f) && !DOC_ONLY.test(f));
    let order = "unknown", firstTest = -1, firstSrc = -1;
    const commits = [];
    let cur = null;
    for (const l of (log.out || "").split("\n")) {
        if (l.startsWith("@@")) {
            cur = { sha: l.slice(2), files: [] };
            commits.push(cur);
        }
        else if (l.trim() && cur)
            cur.files.push(l.trim());
    }
    commits.forEach((c, i) => {
        if (firstTest < 0 && c.files.some((f) => TEST_FILE.test(f)))
            firstTest = i;
        if (firstSrc < 0 && c.files.some((f) => !TEST_FILE.test(f) && !DOC_ONLY.test(f)))
            firstSrc = i;
    });
    if (firstTest >= 0 && (firstSrc < 0 || firstTest <= firstSrc))
        order = "tests-first";
    else if (firstTest >= 0 && firstSrc >= 0)
        order = "source-first";
    else if (testFiles.length && !srcFiles.length)
        order = "tests-only";
    let seq = "none";
    if (runs.length) {
        const firstRun = runs[0];
        const laterOk = runs.slice(1).some((j) => j.status === "ok");
        seq = firstRun.status === "ok" ? "green-first" : laterOk ? "red-green" : "red-only";
    }
    const done = testFiles.length > 0 && (order === "tests-first" || seq === "red-green" || seq === "red-only");
    const suspicious = testFiles.length > 0 && seq === "green-first" && order !== "tests-first" && order !== "tests-only";
    const v = {
        applies: true,
        testFiles,
        srcCount: srcFiles.length,
        order,
        seq,
        runs: runs.map((j) => ({ id: j.id, status: j.status, label: j.label, at: j.endedAt || j.queuedAt })),
        done,
        suspicious,
    };
    redCache.set(t.key, { key, v });
    return v;
}

export const RED_WORD = {
    "tests-first": "тесты появились раньше кода (по коммитам)",
    "tests-only": "пока в ветке только тесты, кода ещё нет — самое время прогнать их красными",
    "source-first": "код появился раньше тестов (или в том же коммите): порядок «тест, потом код» не соблюдён",
    unknown: "коммитов с тестами и кодом ещё нет — порядок по истории не определить",
};
export const SEQ_WORD = {
    "red-green": "был красный прогон, потом зелёный — как и должно быть",
    "red-only": "первый прогон красный (пока не починено) — это хороший знак",
    "green-first": "САМЫЙ ПЕРВЫЙ прогон сразу зелёный: тест мог не проверять ничего",
    none: "прогонов тестов этой ветки в дашборде ещё не было",
};

/** Станция «Красный тест»: вердикт по уликам, файлы, прогоны и кнопка «докажи красный» — вопрос агенту из red-proof-ask. */
export async function redFor(t) {
    const e = await redEvidence(t);
    if (!e.applies)
        return { blocks: [{ kind: "empty", text: "Для этого слота красный тест не применим (нет кода или это оркестратор)." }] };
    const verdict = e.done
        ? "Улики есть: красный тест, судя по истории, был."
        : e.suspicious
          ? "ПОДОЗРЕНИЕ НА ЛОЖНУЮ ЗЕЛЕНЬ: тесты есть, но первый же прогон зелёный, и порядка «тест → код» в истории нет."
          : !e.testFiles.length
            ? "В ветке нет тестовых файлов — красному тесту не из чего родиться."
            : "Улик пока недостаточно: прогоните тесты волны и посмотрите, был ли красный.";
    const blocks = [
        { kind: "pre", title: "Вердикт", text: verdict },
        {
            kind: "kv",
            items: [
                ["тестовых файлов в ветке", String(e.testFiles.length)],
                ["файлов кода (не тесты, не доки)", String(e.srcCount)],
                ["порядок по истории", RED_WORD[e.order]],
                ["история прогонов", SEQ_WORD[e.seq]],
            ],
        },
    ];
    if (e.testFiles.length)
        blocks.push({ kind: "files", title: "Тестовые файлы", files: e.testFiles.map((p) => ({ path: p, code: "T", status: "тест" })), scope: "work" });
    if (e.runs.length)
        blocks.push({ kind: "pre", title: "Прогоны волны по порядку", text: e.runs.map((r) => (r.status === "ok" ? "✓ зелёный  " : "✗ красный  ") + r.id + "  " + r.label).join("\n") });
    blocks.push({
        kind: "pre",
        title: "Как доказать красный честно",
        text:
            "1. Тест написан ДО кода и запущен: он обязан упасть, и упасть по смыслу (не из-за опечатки в " +
            "импорте).\n2. После реализации тот же тест становится зелёным.\n3. Если тест зелёный с первого раза " +
            "— он, скорее всего, ничего не проверяет. Проверка: временно сломать реализацию (убрать условие, " +
            "поменять константу) — тест обязан покраснеть.\nАвтоматического прогона «на базе без реализации» " +
            "дашборд не делает: зависимости и сборка слота смешались бы с базой, и красный вышел бы ложным.",
    });
    const ask = prompt("red-proof-ask");
    return { blocks, actions: [{ id: "ask-red", label: "→ Агенту: докажи красный" }, { id: "run-tests", label: "Запустить тесты волны" }], askText: ask };
}

export const READ_CAP = 90000;

export function readText(p, cap = READ_CAP) {
    try {
        const s = fs.readFileSync(p, "utf8");
        return s.length > cap ? s.slice(0, cap) + "\n… (обрезано, файл " + s.length + " знаков)" : s;
    }
    catch {
        return null;
    }
}

/** Лог прогона без цветовых кодов; длинный — хвост: причина падения обычно в конце. */
export function readLogFull(id, cap = 3000000) {
    try {
        const s = fs.readFileSync(logPath(id), "utf8");
        return (s.length > cap ? s.slice(-cap) : s).replace(ANSI, "");
    }
    catch {
        return "";
    }
}

/** Разбор лога прогона задачи (parsers.mjs): { passed, failed, totals, names }. */
export const parseTestLog = (text, taskId) => parseTaskLog(text, taskId);

export function jobBrief(j) {
    if (!j)
        return null;
    return {
        id: j.id,
        status: j.status,
        label: j.label,
        input: j.input || "",
        sec: j.startedAt ? Math.round(((j.endedAt || Date.now()) - j.startedAt) / 1000) : null,
        at: j.endedAt || j.startedAt || j.queuedAt,
        summary: j.summary || "",
        code: j.code,
        peakMB: j.peakMB || null,
    };
}

export const lastOf = (treeKey, taskId) => [...jobList()].reverse().find((j) => j.tree === treeKey && j.task === taskId && ["ok", "fail", "interrupted", "running"].includes(j.status));

export function planFor(t) {
    const wave = (t.wave || "").toUpperCase();
    const num = /WV-(\d+)/.exec(wave);
    if (!num)
        return { blocks: [{ kind: "empty", text: "У ветки нет номера волны в названии, плана не найти." }] };
    const dirs = [path.join(t.path, ".claude", "plans", "waves"), path.join(MAIN, ".claude", "plans", "waves"), path.join(orchDirOf(t) || "", ".claude", "plans", "waves")];
    const blocks = [];
    for (const d of dirs) {
        let names = [];
        try {
            names = fs.readdirSync(d);
        }
        catch {
            continue;
        }
        const f = names.find((n) => n.toUpperCase().startsWith(wave) && n.toLowerCase().endsWith(".md"));
        if (f) {
            blocks.push({ kind: "doc", title: "План волны · " + f, path: fwd(path.join(d, f)), text: readText(path.join(d, f), 400000), open: true });
            break;
        }
    }
    if (!blocks.length) {
        const d = dirs[2];
        let names = [];
        try {
            names = fs.readdirSync(d);
        }
        catch { }
        const order = (n) => (/^_EPIC/i.test(n) ? 0 : 1);
        for (const n of names.filter((x) => /^(_EPIC|MASTER).*\.md$/i.test(x)).sort((a, b) => order(a) - order(b))) {
            const src = readText(path.join(d, n), 400000);
            if (!src)
                continue;
            const hits = src.split("\n").filter((l) => l.toUpperCase().includes(wave)).length;
            if (!hits)
                continue;
            blocks.push({
                kind: "doc",
                title: (/^_EPIC/i.test(n) ? "Эпик" : "MASTER") + " · " + n + " · упоминаний " + wave + ": " + hits,
                path: fwd(path.join(d, n)),
                text: src,
                highlight: wave,
                open: !blocks.length,
            });
        }
    }
    return {
        blocks: blocks.length
            ? blocks
            : [
                  {
                      kind: "empty",
                      text: "Плана волны " + wave + " не нашла ни в ветке, ни в основной папке, ни в эпике.",
                  },
              ],
        actions: blocks.length ? [{ id: "annot-plan", label: "✎ Разметить план → агенту / одобрить" }] : [],
    };
}

export async function codeFor(t) {
    const [work, br] = await Promise.all([workChanges(t.path), branchChanges(t.path)]);
    const sum = (a) => a.reduce((x, f) => ({ add: x.add + (f.add || 0), del: x.del + (f.del || 0) }), { add: 0, del: 0 });
    const rows = (a) => a.map((f) => ({ path: f.path, code: f.code, status: f.status, add: f.add, del: f.del, untracked: !!f.untracked }));
    const w = sum(work), b = sum(br);
    const blocks = [
        {
            kind: "kv",
            items: [
                [
                    "не закоммичено",
                    work.length +
                        " файл(ов), +" +
                        w.add +
                        " / −" +
                        w.del +
                        (work.some((f) => f.untracked) ? " (в новых файлах строки не посчитаны)" : ""),
                ],
                ["в ветке против staging", br.length + " файл(ов), +" + b.add + " / −" + b.del],
                ["коммитов впереди staging", String(t.ahead)],
            ],
        },
    ];
    if (work.length)
        blocks.push({ kind: "files", title: "Не закоммичено", files: rows(work), scope: "work" });
    if (br.length)
        blocks.push({ kind: "files", title: "Закоммичено в ветке", files: rows(br), scope: "branch" });
    if (t.commits && t.commits.length)
        blocks.push({ kind: "commits", title: "Коммиты ветки", commits: t.commits });
    return { blocks, actions: [{ id: "diff", label: "Открыть дифф и коммит" }, ...(br.length ? [{ id: "annot-diff", label: "✎ Ревью владельца по строкам диффа" }] : [])] };
}

export async function buildFor(t) {
    const need = await buildNeed(t), j = lastOf(t.key, "build");
    const blocks = [{ kind: "kv", items: [["нужна ли сборка", need.needed ? "да: " + need.what : "нет — правка не касается областей со сборкой"], ["как собирается", buildHow()]] }];
    if (j) {
        const txt = readLogFull(j.id), tail = txt.split(/\r?\n/).filter((l) => l.trim()).slice(-30).join("\n");
        blocks.push({ kind: "job", job: jobBrief(j), text: j.status === "ok" ? "Последние строки лога:\n" + tail : failureExcerpt(txt) });
    }
    else
        blocks.push({ kind: "empty", text: "Сборку ещё не запускали." });
    return { blocks, actions: need.needed ? [{ id: "run-build", label: "Запустить сборку" }] : [] };
}

export function testsFor(t) {
    const presets = PRESETS[t.key] || [], ids = presets.length ? presets.map((p) => ({ task: p.task, input: p.input })) : [];
    for (const g of GUARDS)
        ids.push({ task: g });
    const blocks = [];
    for (const it of ids) {
        const j = lastOf(t.key, it.task), def = TASKS[it.task];
        if (!def)
            continue;
        if (!j) {
            blocks.push({ kind: "job", job: { status: "none", label: def.label, input: it.input || "" }, text: "Не запускали." });
            continue;
        }
        const txt = readLogFull(j.id), p = parseTestLog(txt, it.task);
        const bad = ["fail", "interrupted"].includes(j.status);
        blocks.push({ kind: "tests", job: jobBrief(j), totals: p.totals, passed: p.passed, failed: p.failed, names: p.names, text: bad ? failureExcerpt(txt) : "" });
    }
    return { blocks, actions: [{ id: "run-tests", label: "Запустить тесты волны" }] };
}

// merges — список вливов (тест передаёт свой); по умолчанию — из git.
export async function stagingFor(t, merges = null) {
    const m = treeMerge(t, merges || (await stagingMerges()));
    if (!m)
        return {
            blocks: [
                {
                    kind: "empty",
                    text:
                        "Ветка ещё не влита в staging." +
                        (t.dirtyTracked
                            ? " В слоте " + t.dirtyTracked + " незакоммиченных файлов — сначала коммит."
                            : t.ahead
                              ? " Готова к вливанию (коммитов впереди: " + t.ahead + ")."
                              : " В ветке нет коммитов."),
                },
            ],
            actions: t.ahead && !t.dirtyTracked ? [{ id: "merge", label: "Влить в staging…" }] : [],
        };
    const st = await git(MAIN, ["show", "--stat", "--format=%h %s%n%an · %cr", m.sha], 60000);
    return { blocks: [{ kind: "kv", items: [["слияние", m.sha.slice(0, 10)], ["когда", new Date(m.ct).toLocaleString("ru-RU")]] }, { kind: "pre", title: "Что вошло", text: st.out.slice(0, 6000) }] };
}

export async function standFor(t, merges = null) {
    const m = treeMerge(t, merges || (await stagingMerges()));
    const dep = [...jobList()].reverse().find((j) => j.task === "deploy-staging" && ["ok", "fail", "running"].includes(j.status));
    const chk = checklistOf(chkKey(t.key, t.branch)), ag = agents.get(t.key), pending = !!(ag && !ag.dead && ag.capture && ag.capture.kind === "stand-checklist");
    const blocks = [{ kind: "kv", items: [["адрес стенда", STAND_URL || "не задан (release.stand.url)"], ["слияние ветки в staging", m ? "есть, " + new Date(m.ct).toLocaleString("ru-RU") : "нет"]] }];
    if (dep) {
        const txt = readLogFull(dep.id);
        blocks.push({ kind: "job", job: jobBrief(dep), text: dep.status === "ok" ? "Последние строки:\n" + txt.split(/\r?\n/).filter((l) => l.trim()).slice(-15).join("\n") : failureExcerpt(txt) });
    }
    else
        blocks.push({ kind: "empty", text: "Выкат на стенд из дашборда ещё не запускали." });
    blocks.unshift({ kind: "checklist", text: chk ? chk.text : "", at: chk ? chk.at : null, pending, tree: t.key });
    return {
        blocks,
        actions: [
            { id: "ask-checklist", label: chk ? "Обновить чек-лист у агента" : "Запросить чек-лист у агента" },
            { id: "deploy-staging", label: "Выкатить staging на стенд…" },
        ],
        links: STAND_URL ? [{ label: "Открыть стенд", url: STAND_URL }] : [],
    };
}

export async function prodFor(t, merges = null) {
    const m = treeMerge(t, merges || (await stagingMerges()));
    let inMain = false;
    if (m)
        inMain = (await git(MAIN, ["merge-base", "--is-ancestor", m.sha, "main"])).ok;
    const rel = [...jobList()].reverse().find((j) => j.task === "release" && ["ok", "fail", "running"].includes(j.status));
    const main = await git(MAIN, ["log", "main", "--first-parent", "--format=%h %s · %cr", "-3"]);
    const blocks = [
        {
            kind: "kv",
            items: [["ветка в main", !m ? "не влита даже в staging" : inMain ? "да, выкачена" : "нет, ждёт выката"]],
        },
        { kind: "pre", title: "Последнее в проде", text: main.out },
    ];
    if (rel)
        blocks.push({ kind: "job", job: jobBrief(rel), text: rel.status === "ok" ? "" : failureExcerpt(readLogFull(rel.id)) });
    return { blocks, actions: inMain ? [] : m ? [{ id: "release", label: "Выкат в прод…" }] : [] };
}

export function siteFor(t) {
    const mk = S.manual[manualKeyOf(t.key + "|" + t.branch)] || {};
    return {
        blocks: [
            {
                kind: "kv",
                items: [
                    [
                        "что это",
                        "последняя станция: после выката вы своими глазами проверяете результат на живом сайте",
                    ],
                    ["что проверить", "то, что меняла волна; главный сценарий; нет ли ошибок в журнале или консоли"],
                    ["автоматика", "проверка после выката — команда release.prod.verify из конфига проекта"],
                ],
            },
            { kind: "note", text: mk.site_note || "" },
        ],
        note: true,
    };
}

/** Содержимое станции по клику: общая часть (отметка, источник, идущий прогон) и блоки станции. */
export async function stationInfo(t, id) {
    const st = (t.stages || []).find((x) => x.id === id);
    const run = jobList().find((j) => j.tree === t.key && j.task === id && !FINAL.includes(j.status));
    const base = {
        id,
        label: (STATIONS.find((x) => x.id === id) || {}).label || id,
        done: !!(st && st.done),
        source: st ? st.source : "none",
        hint: st ? st.hint : "",
        running: run ? { id: run.id, label: run.label, status: run.status } : null,
    };
    let r;
    switch (id) {
        case "plan":
            r = planFor(t);
            break;
        case "red":
            r = await redFor(t);
            break;
        case "impl":
            r = await codeFor(t);
            break;
        case "build":
            r = await buildFor(t);
            break;
        case "tests":
            r = testsFor(t);
            break;
        case "guards":
            r = guardsFor(t);
            break;
        case "commit":
            r = await commitFor(t);
            break;
        case "staging":
            r = await stagingFor(t);
            break;
        case "stand":
            r = await standFor(t);
            break;
        case "prod":
            r = await prodFor(t);
            break;
        case "site":
            r = siteFor(t);
            break;
        default: r = { blocks: [] };
    }
    return { ...base, ...r };
}
