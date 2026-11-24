// autochain.mjs — автопоезд: после прогона ставит следующую станцию слота, толкает застрявших, замораживает слот после
// коммита, сужает набор спек до упавших.
import { mergedBranches, untriedSteps } from "./idle.mjs";
import { NO_GATE, canonInput, carryRedSpecs, runGate } from "./loops.mjs";
import { drainState } from "./epics.mjs";
import { jobList } from "./jobs.mjs";
import { agents, push } from "./agents.mjs";
import { issueWagon } from "./trains.mjs";
import { trainNext } from "./train-rules.mjs";
import { DRY, FINAL, logEvent, settings } from "./config.mjs";
import { PRESETS, TREES, epicSlots, openEpics, treeByKey } from "./trees.mjs";
import { DIST_TASKS, codeFp, jobFresh } from "./fingerprint.mjs";
import { exists } from "./git.mjs";
import { late } from "./late.mjs";
import { REGRESS_CHUNK, SUITE_FAM, jobCovers, narrowRedRun, onlyStagingRed, realFail, redCarryOf, regexCovers, suiteRunArgs } from "./regress.mjs";
import { PROJECT } from "../slots.mjs";
import { specInput } from "./parsers.mjs";
import { isSyncing, rebuildOne, snapNow } from "./snapshot.mjs";
import { TASKS, stepOfTask } from "./tasks.mjs";
import { waveFinalOf } from "./slot-done.mjs";
import { selfCommitOn } from "./commit-rules.mjs";
import { autoMerge, autoMergeReady } from "./auto-merge.mjs";

const { agentCommit, gateFeedback, deadlockClear, gateScope, testReqsOf, reqItemStatus } = late("relay.mjs", ["agentCommit", "gateFeedback", "deadlockClear", "gateScope", "testReqsOf", "reqItemStatus"]);
const { reviewCapped, reviewEscalate, startReview } = late("review.mjs", ["reviewCapped", "reviewEscalate", "startReview"]);
const { enqueue } = late("runner.mjs", ["enqueue"]);
export const runInflight = new Set();

/** Гарды и тесты станций — из конфига проекта. */
const GUARDS = PROJECT.stations.guards, TESTS = PROJECT.stations.tests;

/** Как дописать красные спеки к вводу задачи и что ввод уже покрывает: { join, covered } или ничего. */
export function carryJoin(taskId, input) {
    const si = specInput(taskId);
    if (!si)
        return {};
    const t = PROJECT.tasks[taskId];
    return { join: si.add, covered: t && t.parser === "jest" ? (spec) => regexCovers(input, spec) : null };
}

export async function runTask(key, taskId, input, by = "решение слота", more = {}) {
    const ik = key + "|" + taskId + "|" + canonInput(taskId, input || "");
    if (runInflight.has(ik))
        return null;
    runInflight.add(ik);
    try {
        return await runTaskNow(key, taskId, input, by, more);
    }
    finally {
        runInflight.delete(ik);
    }
}

const gateRefused = new Map();
export const refusedOnCode = (key, fp) => !!fp && gateRefused.get(key) === fp;
const gateCovered = new Map();
export const coveredOnCode = (key, task, input, fp) => !!fp && gateCovered.get(key + "|" + task + "|" + (input || "")) === fp;

export async function runTaskNow(key, taskId, input, by, more) {
    if (taskId === "review")
        return startReview(key);
    const tree = treeByKey(key), task = TASKS[taskId];
    if (!tree || !task)
        throw new Error("неизвестный слот или задача");
    const dup = jobList().find((j) => j.tree === key && j.task === taskId && (j.input || "") === (task.input ? input || "" : "") && ["queued", "waiting", "running"].includes(j.status));
    if (dup)
        return dup;
    if (!more.envRetryOf) {
        let inp = task.input ? input || "" : "";
        const fp = await codeFp(tree.path, true);
        {
            const c = carryRedSpecs({ task: taskId, input: inp, fails: redCarryOf(key, fp), ...carryJoin(taskId, inp) });
            if (c.added.length) {
                inp = c.input;
                input = c.input;
                logEvent("run.carry", { tree: key, task: taskId, by, added: c.added.slice(0, 20).join(",") });
                const a = agents.get(key);
                if (a)
                    push(a, { id: "carry-" + a.rev + Math.random().toString(36).slice(2, 4), t: "status", text: "К «" + task.label + "» (" + by + ") добавлены спеки, красные в прошлом прогоне и ещё не прошедшие: " + c.added.join(", ") + "." });
            }
        }
        {
            const frozen = !NO_GATE.has(taskId) && frozenAfterCommit(key, fp, taskId, inp);
            if (frozen) {
                logEvent("gate.blocked", { tree: key, task: taskId, input: inp, by, why: frozen });
                gateFeedback({ tree: key, task: taskId, input: inp, by, why: frozen, fp });
                gateRefused.set(key, fp);
                const a = agents.get(key);
                if (a)
                    push(a, { id: "frz-" + a.rev, t: "status", text: "Не ставлю «" + task.label + "» (" + by + "): " + frozen + "." });
                return null;
            }
        }
        const gate = (x) => runGate({ jobs: jobList(), tree: key, task: taskId, input: x, fp, dist: DIST_TASKS.has(taskId), covers: (j) => jobCovers(j, { task: taskId, input: x }), realFail, inherited: (j) => onlyStagingRed(j.id), freshOk: (k) => {
                const tt = snapNow() && snapNow().trees.find((x) => x.key === key);
                return !!tt && tt.fp === fp && jobFresh(k, tt) === "ok";
            } });
        const g = gate(inp);
        if (!g.run) {
            const a = agents.get(key);
            if (a)
                push(a, { id: "gate-" + a.rev + Math.random().toString(36).slice(2, 4), t: "status", text: "Не ставлю «" + task.label + (inp ? " " + inp : "") + "» (" + by + "): " + g.why + "." });
            console.log("ворота прогона:", key, taskId, inp, "—", g.why);
            logEvent("gate.blocked", { tree: key, task: taskId, input: inp, by, why: String(g.why || "").slice(0, 200), job: g.job ? g.job.id : null });
            gateFeedback({ tree: key, task: taskId, input: inp, by, why: String(g.why || ""), fp });
            gateRefused.set(key, fp);
            if (g.job && g.job.status === "ok")
                gateCovered.set(key + "|" + taskId + "|" + (inp || ""), fp);
            return g.job;
        }
    }
    let steps;
    if (task.dynamic) {
        steps = await task.dynamic(tree.path);
        if (!steps)
            return null;
    }
    else
        steps = [stepOfTask(task, tree.path, input)];
    try {
        deadlockClear(gateScope(key, taskId, task.input ? input || "" : ""));
    }
    catch { }
    return enqueue({ treeKey: key, cwd: tree.path, label: task.label, taskId, input: task.input ? input : "", lane: task.lane, profile: "auto", steps, extra: { by, auto: true, ...more } });
}

/** Задача, по которой станция считается проверенной на коде («*» — любая задача). */
export const STAGE_TASK = { build: "build", guards: GUARDS[0] || "*", tests: TESTS[0] || "*", regress: "*", review: "review", commit: "commit" };

export function frozenAfterCommit(treeKey, fp, task = null, input = null) {
    const t = snapNow() && snapNow().trees.find((x) => x.key === treeKey);
    if (!t || !fp || t.fp !== fp || t.dirtyTracked || t.dirtyUntracked || !(t.ahead > 0) || (t.verdict && t.verdict.merged))
        return "";
    if (!((t.stages || []).find((x) => x.id === "commit") || {}).done)
        return "";
    if (!waveFinalOf(t))
        return "";
    if (task) {
        const checked = jobList().some((j) => j.tree === treeKey && (task === "*" || j.task === task) && (input === null || (j.input || "") === (input || "")) && ["ok", "fail"].includes(j.status) && j.fpStart === fp);
        if (!checked)
            return "";
    }
    return "волна закоммичена, код с коммита не менялся — проверять дальше будет поезд влива";
}

export function narrowBySuites(treeKey, task, input, fpNow) {
    const t = snapNow() && snapNow().trees.find((x) => x.key === treeKey);
    if (!t || !t.fp || t.fp !== fpNow)
        return null;
    const e = (t.suites || []).find((x) => x.task === task && (x.input || "") === (input || ""));
    if (!e || !Array.isArray(e.list) || !e.list.length || e.list.length !== e.total)
        return null;
    const need = e.list.filter((x) => ["fail", "stale", "unknown"].includes(x.st));
    if (!need.length)
        return e.state === "ok" ? { skip: true, why: "все " + e.total + " спек набора уже зелёные на этом коде (красное — только известное staging)" } : null;
    if (need.length === e.list.length || !specInput(e.fam))
        return null;
    const names = [...new Set(need.map((x) => x.spec))].sort(), runs = chunkRuns(e.fam, names);
    return runs.length ? { runs, n: names.length, total: e.total } : null;
}

/** Прогоны «только эти спеки» задачи частями по REGRESS_CHUNK; задача без ввода из спек — целиком или ничего. */
function chunkRuns(fam, names) {
    if (!specInput(fam) || names.length <= REGRESS_CHUNK)
        return [suiteRunArgs(fam, names)].filter(Boolean);
    const parts = Math.ceil(names.length / REGRESS_CHUNK), size = Math.ceil(names.length / parts), runs = [];
    for (let i = 0; i < parts; i++)
        runs.push(suiteRunArgs(fam, names.slice(i * size, (i + 1) * size)));
    return runs.filter(Boolean);
}

export function suitesToRun(t, kind) {
    const groups = new Map();
    let n = 0, known = false;
    for (const e of (t.suites || []).filter((x) => x.kind === kind)) {
        known = true;
        for (const x of e.list)
            if (["fail", "stale", "unknown"].includes(x.st)) {
                const g = groups.get(e.fam) || new Set();
                g.add(x.spec);
                groups.set(e.fam, g);
            }
    }
    if (!known || !groups.size)
        return null;
    const runs = [];
    for (const [fam, set] of groups.entries()) {
        n += set.size;
        runs.push(...chunkRuns(fam, [...set].sort()));
    }
    return runs.length ? { runs, n } : null;
}

export function testsDue(verdictTests, presetsFresh, fast = false) {
    if (!presetsFresh.length || fast)
        return false;
    if (verdictTests === "green")
        return false;
    if (verdictTests === "notneeded" && presetsFresh.every(Boolean))
        return false;
    return true;
}

export const autoTrainOffFor = (key) => !!(settings.autoTrainOff && settings.autoTrainOff[key]);

export async function autoChain(key, why, tries = 0) {
    if (!settings.autoTrain || drainState())
        return;
    if (autoTrainOffFor(key))
        return;
    const tr = treeByKey(key);
    if (!tr || tr.readOnly || /^orchestrator/.test(key) || !exists(tr.path))
        return;
    const ag = agents.get(key), busy = (ag && !ag.dead && ag.busy && !ag.pinging) || jobList().some((j) => j.tree === key && ["running", "queued", "waiting"].includes(j.status));
    if (busy || isSyncing(key)) {
        if (tries < 360)
            setTimeout(() => autoChain(key, why, tries + 1), 5000);
        return;
    }
    const t = await rebuildOne(key);
    if (!t || !t.verdict)
        return;
    if (t.train && !t.hasCode)
        return trainStep(t, (st) => chainOnce(key, t, st, why), (x, step) => chainNote(key, t, x, step, why));
    if (!t.hasCode)
        return;
    const tag = t.tag || key;
    const v = t.verdict, once = (stage) => {
        const k = key + "|chain|" + t.fp + "|" + stage + presetSig(t, stage);
        if (autoRan.has(k)) {
            if (!chainQuiet.has(k)) {
                chainQuiet.add(k);
                console.log("автопоезд", tag, "(" + why + "): станцию «" + stage + "» на этом коде уже ставил — жду её итога");
                logEvent("chain.skip", { tree: key, why, step: stage });
            }
            return false;
        }
        autoRan.add(k);
        return true;
    };
    const note = (x, step) => {
        console.log("автопоезд", tag, "(" + why + "):", x);
        logEvent("chain.step", { tree: key, why, step, detail: String(x).slice(0, 200) });
        const a = agents.get(key);
        if (a)
            push(a, { id: "ch-" + a.rev + Math.random().toString(36).slice(2, 4), t: "status", text: "Автопоезд (" + why + "): " + x });
    };
    const run = async (task, input) => {
        const j = await runTask(key, task, input || "", "автопоезд").catch((e) => {
            console.error("автопоезд:", e.message);
            return null;
        });
        if (!j && !refusedOnCode(key, t.fp)) {
            for (const k of [...autoRan])
                if (k.startsWith(key + "|chain|" + t.fp + "|")) {
                    autoRan.delete(k);
                    chainQuiet.delete(k);
                }
        }
        return j;
    };
    if (t.buildNeeded && v.build !== "ok") {
        if (!once("build"))
            return;
        note("сборка", "build");
        return run("build");
    }
    if (!["green", "notneeded"].includes(v.guards)) {
        if (!once("guards"))
            return;
        const need = GUARDS.filter((task) => {
            if (!t.prodTouched && !t.accTouched)
                return false;
            const j = [...jobList()].reverse().find((k) => k.tree === key && k.task === task && ["ok", "fail"].includes(k.status));
            return !j || jobFresh(j, t) !== "ok";
        });
        note("гарды: " + (need.length ? need.join(", ") : "уже прогнаны на этом коде или не нужны"), "guards");
        for (const x of need)
            await run(x);
        return;
    }
    const presets = PRESETS[key] || [];
    const presetFresh = (pr) => {
        const j = [...jobList()].reverse().find((k) => k.tree === key && k.task === pr.task && (k.input || "") === (pr.input || "") && ["ok", "fail"].includes(k.status));
        return !!j && j.status === "ok" && jobFresh(j, t) === "ok";
    };
    if (v.tests === "requested") {
        const due = (testReqsOf(key) || []).filter((r) => r.task !== "build" && !GUARDS.includes(r.task) && reqItemStatus(key, r, t).status === "todo")
            .filter((r) => {
            const k = key + "|req|" + t.fp + "|" + r.id;
            if (autoRan.has(k))
                return false;
            autoRan.add(k);
            return true;
        });
        if (due.length) {
            note("просьбы перепрогнать: " + due.map((r) => r.task + (r.input ? " " + r.input : "")).join(", "), "tests");
            for (const r of due)
                await run(r.task, r.input);
            return;
        }
    }
    if (testsDue(v.tests, presets.map(presetFresh), !!t.specOnly && v.tests === "notneeded")) {
        if (!once("tests"))
            return;
        const loose = presets.filter((p) => !SUITE_FAM[p.task] && !presetFresh(p));
        const part = suitesToRun(t, "tests");
        if (part) {
            note("тесты волны, только красные и задетые правкой сьюты: " + part.n + (loose.length ? " + " + loose.map((p) => p.task + (p.input ? "=" + p.input : "")).join(", ") : ""), "tests");
            for (const x of part.runs)
                await run(x.task, x.input);
            for (const p of loose)
                await run(p.task, p.input);
            return;
        }
        note("тесты волны", "tests");
        for (const p of presets)
            await run(p.task, p.input);
        return;
    }
    const rv = (t.stages || []).find((x) => x.id === "review");
    if (rv && !rv.done) {
        if (t.review && t.review.fresh)
            return;
        if (reviewCapped(key)) {
            if (!once("review-cap"))
                return;
            note("ревью: уже два раза с вопросами — третье само не ставлю, решение за оркестратором и владельцем", "review-cap");
            reviewEscalate(t);
            return;
        }
        if (!once("review"))
            return;
        note("ревью", "review");
        return startReview(key).catch((e) => console.error("автопоезд, ревью:", e.message));
    }
    if (!["green", "notneeded"].includes(v.regress) && (t.regress || []).length) {
        if (!once("regress"))
            return;
        const part = suitesToRun(t, "regress");
        if (part) {
            note("регресс, только красные и задетые правкой сьюты: " + part.n, "regress");
            for (const x of part.runs)
                await run(x.task, x.input);
            for (const y of t.regress.filter((r) => !["ok", "inherited", "run"].includes(r.status) && !(t.suites || []).some((e) => e.kind === "regress" && e.task === r.task && (e.input || "") === (r.input || ""))))
                await run(y.task, y.input || "");
            return;
        }
        note("регресс", "regress");
        for (const x of t.regress.filter((y) => !["ok", "inherited", "run"].includes(y.status))) {
            const nr = x.status === "fail" ? narrowRedRun(t.key, x.task, { input: x.input || "" }) : null;
            if (nr) {
                note("регресс: только упавшие спеки (" + nr.specs.length + ") красного прогона " + nr.from, "regress");
                await run(nr.task, nr.input);
                continue;
            }
            await run(x.task, x.input);
        }
        return;
    }
    const commitTried = jobList().some((j) => j.tree === key && j.task === "commit" && FINAL.includes(j.status) && j.fpStart && j.fpStart === t.fp);
    if (rv && rv.done && settings.autoCommit !== false && !commitTried && (t.dirtyTracked || t.dirtyUntracked) && !(t.verdict && t.verdict.merged) && !jobList().some((j) => j.tree === key && j.task === "commit" && !FINAL.includes(j.status))) {
        if (!once("commit"))
            return;
        note("коммит: гарды, тесты, ревью «ЗА» и регресс зелёные — коммит силами агента", "commit");
        return agentCommit(key).catch((e) => console.error("автопоезд, коммит:", e.message));
    }
    const am = await autoMerge(key, why).catch((e) => ({ ok: false, why: e.message }));
    if (am.ok)
        note("автовлив в staging: " + am.why, "merge");
}

export const presetSig = (t, stage) => stage === "tests" ? "|" + JSON.stringify((t && t.presets) || []) : "";

const chainOnce = (key, t, stage, why) => {
    const k = key + "|chain|" + t.fp + "|" + stage + presetSig(t, stage);
    if (autoRan.has(k)) {
        if (!chainQuiet.has(k)) {
            chainQuiet.add(k);
            logEvent("chain.skip", { tree: key, why, step: stage });
        }
        return false;
    }
    autoRan.add(k);
    return true;
};

const chainNote = (key, t, x, step, why) => {
    console.log("автопоезд", t.tag || key, "(" + why + "):", x);
    logEvent("chain.step", { tree: key, why, step, detail: String(x).slice(0, 200) });
    const a = agents.get(key);
    if (a)
        push(a, { id: "ch-" + a.rev + Math.random().toString(36).slice(2, 4), t: "status", text: "Автопоезд (" + why + "): " + x });
};

async function trainStep(t, once, note) {
    const nx = trainNext(t);
    if (!nx.act)
        return;
    if (!once("wagon-" + t.current))
        return;
    const r = await issueWagon(t, t.current, { by: "автопоезд" });
    note(r.why, "wagon");
    if (!r.ok)
        for (const k of [...autoRan])
            if (k.endsWith("|wagon-" + t.current) && k.startsWith(t.key + "|chain|"))
                autoRan.delete(k);
}

export const autoRan = new Set();
const LIVE_ST = ["queued", "waiting", "running"];
export const chainQuiet = new Set();

export function jobsForState() {
    const out = new Set(jobList().slice(-40));
    for (const j of jobList())
        if (!FINAL.includes(j.status))
            out.add(j);
    const lastOf = (tree, task, input) => {
        for (let i = jobList().length - 1; i >= 0; i--) {
            const j = jobList()[i];
            if (j.tree === tree && j.task === task && (input == null || (j.input || "") === input) && ["ok", "fail", "skipped"].includes(j.status))
                return j;
        }
        return null;
    };
    for (const t of (snapNow() ? snapNow().trees : TREES)) {
        const pairs = [["build", null], ...GUARDS.map((g) => [g, null]), ["review", null], ...(PRESETS[t.key] || []).map((p) => [p.task, p.input || ""])];
        for (const [task, input] of pairs) {
            const j = lastOf(t.key, task, input);
            if (j)
                out.add(j);
        }
        for (const r of t.regress || []) {
            const j = r.jobId && jobList().find((x) => x.id === r.jobId);
            if (j)
                out.add(j);
        }
        if (t.review && t.review.jobId) {
            const j = jobList().find((x) => x.id === t.review.jobId);
            if (j)
                out.add(j);
        }
    }
    {
        for (const g of GUARDS) {
            const j = lastOf("orchestrator-staging", g, null);
            if (j)
                out.add(j);
        }
    }
    return jobList().filter((j) => out.has(j));
}

export function kickStalled(why) {
    if (DRY || !settings.autoTrain || !snapNow() || !openEpics().length)
        return;
    autoMergeReady(why).catch((e) => console.error("автовлив:", e.message));
    let i = 0;
    for (const x of epicSlots().filter((z) => !z.archived)) {
        const t = snapNow().trees.find((z) => z.key === x.slot);
        if (t && t.exists && t.train && !t.hasCode) {
            const nx = trainNext(t);
            if (nx.act && !autoRan.has(x.slot + "|chain|" + t.fp + "|wagon-" + t.current) && !jobList().some((j) => j.tree === x.slot && ["running", "queued", "waiting"].includes(j.status))) {
                logEvent("chain.kick", { tree: x.slot, why: why + ": поезд — " + nx.why });
                setTimeout(() => autoChain(x.slot, why + ": " + nx.why).catch((e) => console.error("толчок поезда:", e.message)), (i++) * 20000);
            }
            continue;
        }
        if (!t || !t.exists || t.readOnly || !t.hasCode || (t.verdict && t.verdict.merged))
            continue;
        const need = (t.stages || []).filter((s) => ['build', 'tests', 'guards', 'regress', 'review'].includes(s.id) && !s.done);
        if (!need.length && settings.autoCommit !== false && (t.dirtyTracked || t.dirtyUntracked) && (t.stages || []).some((s) => s.id === 'review' && s.done))
            need.push({ id: 'commit', label: 'Коммит' });
        if (!need.length || need.every((s) => frozenAfterCommit(x.slot, t.fp, STAGE_TASK[s.id] || s.id)))
            continue;
        if (jobList().some((j) => j.tree === x.slot && ['running', 'queued', 'waiting'].includes(j.status)))
            continue;
        if ((agents.get(x.slot) || {}).busy)
            continue;
        const commitTried = jobList().some((j) => j.tree === x.slot && j.task === 'commit' && FINAL.includes(j.status) && j.fpStart && j.fpStart === t.fp);
        if (!untriedSteps({ ...t, key: x.slot }, need.map((s) => s.id), autoRan, { presets: (PRESETS[x.slot] || []).length, commitTried }).length)
            continue;
        const w = why + ': поезд стоял на «' + need[0].label + '»';
        logEvent("chain.kick", { tree: x.slot, why: w });
        setTimeout(() => autoChain(x.slot, w).catch((e) => console.error('толчок поезда:', e.message)), (i++) * 20000);
    }
}

export async function autoTrain(done) {
    try {
        if (!settings.autoTrain || !(done.status === "ok" || (done.status === "fail" && onlyStagingRed(done.id))))
            return;
        if (done.task === "merge" && done.status === "ok") {
            const branches = new Set(mergedBranches(done));
            const keys = ((snapNow() && snapNow().trees) || []).filter((t) => branches.has(t.branch)).map((t) => t.key);
            setTimeout(() => {
                for (const k of keys)
                    autoChain(k, "после влива " + done.id).catch((e) => console.error("автопоезд после влива:", e.message));
                autoMergeReady("после влива " + done.id).catch(() => { });
            }, 10000);
            return;
        }
        const tr = treeByKey(done.tree);
        if (!tr || /^orchestrator/.test(tr.key) || tr.readOnly)
            return;
        await autoChain(tr.key, "после " + done.id);
    }
    catch (e) {
        console.error("автопоезд:", e.message);
    }
}

export function nextHint(t) {
    const v = t && t.verdict;
    if (!v)
        return "";
    const self = settings.autoTrain ? ": дашборд запустит сам и пришлёт результат, ты не запускай." : ": запустит владелец.";
    const okB = v.build === "ok" || v.build === "notneeded", okG = v.guards === "green" || v.guards === "notneeded";
    const okR = v.regress === "green" || v.regress === "notneeded", rv = (t.stages || []).find((x) => x.id === "review"), okRv = !rv || rv.done;
    if (!okB)
        return "";
    if (!okG)
        return v.guards === "fail" ? "" : "Сборка зелёная. Следующая станция: гарды" + (GUARDS.length ? " (" + GUARDS.map((g) => (PROJECT.tasks[g] || {}).label || g).join(", ") + ")" : "") + " — раньше тестов, они дешевле" + self;
    if (v.tests !== "green")
        return v.tests === "fail" ? "" : "Гарды зелёные. Следующая станция: тесты волны" + self;
    if (!okRv)
        return "Гарды и тесты волны зелёные. Следующая станция: независимое ревью — до регресса, чтобы правки по замечаниям не гоняли регресс дважды" + self;
    if (!okR)
        return "Гарды, тесты волны и ревью пройдены. Следующая станция: регресс — соседи по тронутым путям (" + ((t.regress || []).map((x) => x.label + (x.input ? " " + x.input : "")).join("; ")) + ")" + self + (v.regress === "fail" ? " Регресс КРАСНЫЙ: разберись, твоя ли это поломка." : "");
    if (selfCommitOn(settings))
        return "ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ на текущем коде: сборка, гарды, тесты волны, ревью, регресс по тронутым путям. Следующая станция: коммит — если в папке есть незакоммиченное своё, закоммить сам по навыку slot-commit (строка «Wave: " + (t.wagon || (t.wave ? String(t.wave).toUpperCase() : "WV-NNNN")) + "» в последнем абзаце), затем влив в staging — диспетчерская вольёт сама после твоего «ГОТОВО» (автовлив), если всё зелёное и конфликта нет. Тесты не запускай; если ещё не отчитался, дай итоговый отчёт по формату слота.";
    return "ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ на текущем коде: сборка, гарды, тесты волны, ревью, регресс по тронутым путям. Следующая станция: коммит" + (settings.autoTrain && settings.autoCommit !== false ? " — автопоезд поставит его сам" : "") + ", затем влив в staging — диспетчерская вольёт сама после твоего «ГОТОВО» (автовлив), если всё зелёное и конфликта нет. Ничего не запускай; если ещё не отчитался, дай итоговый отчёт по формату слота.";
}
