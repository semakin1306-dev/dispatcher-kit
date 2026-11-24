// http.mjs — маршруты /api/*: состояние для страницы, прогоны, агенты, коммит, влив и выкат, карточки, настройки. В
// начале — сторож модулей: маршрут выключенного модуля отвечает 404. Проверка Host и токена страницы на каждой мутации.
import { MAIN, PROJECT, REMOTE, UP_STAGING, WT, loadEpics, saveEpics } from "../slots.mjs";
import { NO_GATE, runGate } from "./loops.mjs";
import { execFile, spawn, sshGateStats } from "./spawner.mjs";
import fs from "node:fs";
import { corruptList, saveJson } from "./store.mjs";
import path from "node:path";
import { shardApi } from "./shard.mjs";
import { jobList } from "./jobs.mjs";
import { STAND_ASK, acceptBrief, acceptOp, acceptPublic, remindersOp, remindersPublic } from "./accept.mjs";
import { DEFAULT_MODEL, PROMPTS_DIR, agentCwd, agentPublic, agentSession, agents, answerPermission, deliver, ensureAgent, epicOrderWagons, genSlotPrompt, interruptAgent, latestSession, push, readHistory, relays, sendUserText, sendWhenFree, setAgentModel, slotOf, startAgent, stopAgent } from "./agents.mjs";
import { autoChain, autoRan, frozenAfterCommit, jobsForState, narrowBySuites } from "./autochain.mjs";
import { issueWagon, markLanded } from "./trains.mjs";
import { isTrain, normWave } from "./train-rules.mjs";
import { SENSITIVE, branchChanges, fileDiff, graphCaches, graphData, safeRel, withTrailer, workChanges } from "./changes.mjs";
import { ANSI, DRY, FINAL, HERE, PORT, SETTINGS_FILE, TOKEN, logEvent, logPath, settings } from "./config.mjs";
import { brief } from "./epic-journal.mjs";
import { AUTO_OWNER_HOURS, autoOwnerToggle } from "./auto-owner.mjs";
import { epicJournalOp, epicProgressOp } from "./epic-progress.mjs";
import { retroGet, retroStart } from "./retro.mjs";
import { activateEpic, closeEpicOp, drainState, enqueueProvision, epicsPublic, setDrain, setEpicStatus, slotMissing, syncReport, syncSlot, taskSpecMatches } from "./epics.mjs";
import { DIST_TASKS, codeFp, fpLast, jobFresh } from "./fingerprint.mjs";
import { exists, git, pairs, pipelineState, treeState, withGitPriority } from "./git.mjs";
import { releaseNotes } from "./release-notes.mjs";
import { inboxCards, keepCards, saveInbox } from "./inbox.mjs";
import { memState, procRows, sampleMachine, slotUsageState, stackState, sysState } from "./monitor.mjs";
import { PIPELINE_ACTIONS, TRAIN_FILE, clearTrain, markTrain, mergeShaStep, preflight, recipe, releaseAction, saveTrain, setOrder, trainNow, trainPublic, trainStart, trainValid } from "./pipeline.mjs";
import { flakyList, jobCovers, onlyStagingRed, realFail, stgRedMap, suiteRunArgs } from "./regress.mjs";
import { ganttView, treeView } from "./view.mjs";
import { FORCE_SOFT, agentCommit, buildReport, cancelMergeWait, doRelay, ownerStopsMergeWaits, drainQueued, failAdvice, inboxPublic, inboxSend, relaySentList, sendBatch, slotFacts, testReqsPublic } from "./relay.mjs";
import { recentNotes, startReview } from "./review.mjs";
import { annotGet, annotPost, ownerAnswer } from "./annot.mjs";
import { backlogHttp, retroTriageBrief } from "./backlog.mjs";
import { enqueue, enqueueChecked, killTree, procs, publicJob, pumpAll, queues, save } from "./runner.mjs";
import { dropSnap, kick, markMergedNow, rebuild, rebuildOne, rebuildingNow, snapNow, touchSnap } from "./snapshot.mjs";
import { bumpVer, sseClients, sseOpen, stateVerNow } from "./events.mjs";
import { digestBrief, digestStats } from "./digest-ledger.mjs";
import { sliceLog } from "./digest.mjs";
import { STATIONS, markStage, redCache, stationInfo, wagonPlanFile } from "./stations.mjs";
import { UI_SHARED } from "./ui-shared.mjs";
import { INPUT_RE, TASKS, buildCache, stepOfTask } from "./tasks.mjs";
import { specAware } from "./parsers.mjs";
import { PRESETS, TREES, applyEpics, epicById, isOrch, openEpics, orchKey, orchOfKey, treeByKey, viewEpic } from "./trees.mjs";
import { KEEP_DEFAULT, hygieneNow, hygieneRefresh, hygieneRun } from "./worktree-hygiene.mjs";
import { slotReset } from "./slot-reset.mjs";
import { tgPublic, tgSettingsChanged } from "./tg.mjs";
import { pipelineAction, wordGrants } from "./owner-word.mjs";
import { caps } from "../runtimes/index.mjs";
import { enabled, moduleHandler, moduleOfPath, modulesPublic, routeGate } from "./modules.mjs";
import { closeWindow } from "./monitor-win.mjs";

export const send = (res, code, body, type = "application/json; charset=utf-8") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
};

export const readBody = (req) => new Promise((r) => {
    req.setEncoding("utf8");
    let b = "";
    req.on("data", (d) => {
        b += d;
        if (b.length > 20000)
            req.destroy();
    });
    req.on("end", () => {
        try {
            r(JSON.parse(b || "{}"));
        }
        catch {
            r({});
        }
    });
});

export const okHost = (req) => [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host || "");

/** Кто нажал: метка в журнале событий. Страница — одна; бот и команды ставят свою. */
const BY_PAGE = "страница";
/** Состояние для страницы: что за проект, рантайм и модули — то, чего нет в снимке git. */
export function projectPublic() {
    return {
        project: { name: PROJECT.name, upStaging: UP_STAGING, remote: REMOTE },
        runtime: { id: PROJECT.agent.runtime, caps: caps(), models: [...new Set(Object.values(PROJECT.agent.models).filter(Boolean))].map((id) => ({ id, label: id })) },
        modules: modulesPublic(),
        stations: { tests: PROJECT.stations.tests, guards: PROJECT.stations.guards },
    };
}
/** Задачи проекта для страницы: подпись, группа, ввод, разбор вывода, гейт. */
export const tasksPublic = () => Object.fromEntries(Object.entries(TASKS).map(([k, v]) => [k, { label: v.label, group: v.group, input: v.input ? { label: v.input.label, placeholder: v.input.ph || v.input.placeholder || "" } : null, parser: typeof v.parser === "string" ? v.parser : v.parser ? "custom" : "exit-code", gate: !!v.gate }]));

export function viewOf(req, url) {
    const v = url.searchParams.get("epic") || req.headers["x-dash-epic"] || "";
    return epicById(v) ? v : viewEpic() ? viewEpic().id : null;
}

export const ORCH_ALIAS_FIELDS = ["tree", "key", "to", "from", "slot"];
let uiVerCache = { at: 0, v: 0 }, uiWatch = null;
const uiFiles = () => [...fs.readdirSync(HERE).filter((f) => /\.(html|js|css)$/.test(f)), ...fs.readdirSync(path.join(HERE, "ui")).filter((f) => /\.(html|js|css)$/.test(f)).map((f) => "ui/" + f), ...Object.values(UI_SHARED).map((f) => path.relative(HERE, f))];

function uiWatchStart() {
    if (uiWatch)
        return;
    uiWatch = true;
    let t = null;
    const hit = (f) => {
        if (f && !/\.(html|js|css)$/.test(String(f)))
            return;
        clearTimeout(t);
        t = setTimeout(() => {
            uiVerCache.at = 0;
            bumpVer("ui");
        }, 300);
    };
    for (const d of [path.join(HERE, "ui"), HERE])
        try {
            fs.watch(d, (_, f) => hit(f)).on("error", () => { }).unref();
        }
        catch { }
    const shared = new Set(Object.values(UI_SHARED).map((f) => path.basename(f)));
    for (const d of new Set(Object.values(UI_SHARED).map((f) => path.dirname(f))))
        try {
            fs.watch(d, (_, f) => {
                if (f && shared.has(path.basename(String(f))))
                    hit(f);
            }).on("error", () => { }).unref();
        }
        catch { }
}

function uiVer() {
    uiWatchStart();
    if (Date.now() - uiVerCache.at > 5000) {
        try {
            uiVerCache = { at: Date.now(), v: Math.round(Math.max(...uiFiles().map((f) => fs.statSync(path.join(HERE, f)).mtimeMs))) };
        }
        catch {
            uiVerCache = { at: Date.now(), v: 0 };
        }
    }
    return uiVerCache.v;
}

export async function api(req, res, url) {
    {
        const g = routeGate(url.pathname);
        if (g)
            return send(res, 404, { error: "нет такого адреса: " + g.why, module: g.id });
    }
    const VIEW = viewOf(req, url), VK = VIEW ? orchKey(VIEW) : null;
    if (VK) {
        url.pathname = url.pathname.replace(/^\/api\/agent\/orchestrator(\/|$)/, "/api/agent/" + encodeURIComponent(VK) + "$1");
        for (const f of ORCH_ALIAS_FIELDS)
            if (url.searchParams.get(f) === "orchestrator")
                url.searchParams.set(f, VK);
        const q = '"' + VK + '"', end = res.end.bind(res);
        res.end = (chunk, ...rest) => end(typeof chunk === "string" && chunk.includes(q) ? chunk.split(q).join('"orchestrator"') : chunk, ...rest);
    }
    {
        const mid = moduleOfPath(url.pathname), h = mid ? moduleHandler(mid) : null;
        if (h && (await h(req, res, url, { send, readBody, token: TOKEN, view: VIEW })))
            return;
    }
    if (req.method === "GET" && url.pathname === "/api/slot-facts") {
        const k = url.searchParams.get("tree") || "";
        if (!treeByKey(k))
            return send(res, 404, { error: "нет такого слота" });
        const text = await slotFacts(k, false);
        return send(res, 200, { text });
    }
    if (req.method === "GET" && url.pathname === "/api/shard")
        return send(res, 200, shardApi().pub());
    if (req.method === "GET" && url.pathname === "/api/shard-log") {
        const t = await shardApi().log(String(url.searchParams.get("f") || ""));
        return t === null ? send(res, 404, "нет такого лога", "text/plain; charset=utf-8") : send(res, 200, t, "text/plain; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/api/events")
        return sseOpen(req, res, VK);
    if (req.method === "GET" && url.pathname === "/api/state") {
        if (!snapNow()) {
            rebuild();
            return send(res, 200, { booting: true, now: Date.now() });
        }
        if (url.searchParams.get("ver") && Number(url.searchParams.get("ver")) === (stateVerNow() || 0))
            return send(res, 200, { unchanged: true, ver: stateVerNow() || 0, now: Date.now() });
        const { pl } = snapNow(), mine = (t) => !t.epic || t.epic === VIEW, trees = snapNow().trees.filter(mine);
        const running = new Set(jobList().filter((j) => j.status === "running").map((j) => j.tree));
        const jobsNow = jobsForState(), ctx = { inbox: inboxPublic(), reqs: testReqsPublic() };
        const views = trees.map((t) => ({ ...t, ...treeView(t, ctx), running: running.has(t.key), presets: PRESETS[t.key] || [], defaultWave: t.wave }));
        return send(res, 200, {
            ...projectPublic(),
            now: Date.now(), hygiene: { ...hygieneNow }, ver: stateVerNow() || 0, snapAgeSec: Math.round((Date.now() - snapNow().at) / 1000), uiVer: uiVer(), shard: enabled("machines") ? shardApi().summary() : null, relays: relays.slice(-8), relaySent: relaySentList().slice(-200),
            agents: Object.fromEntries(TREES.filter((t) => mine(t) && exists(t.path)).map((t) => [t.key, agentPublic(t.key)])), serverOnline: shardApi().slotOnline(), trees: views, gantt: ganttView(views, VIEW, ctx),
            pipeline: { ...pl, pushDeploys: !!PROJECT.release.prod.pushDeploys }, jobs: jobsNow.map((j) => {
                const p = publicJob(j);
                if (FINAL.includes(j.status)) {
                    delete p.cmd;
                    if (j.task !== "deploy-staging")
                        delete p.prog;
                    delete p.treeSha;
                    delete p.cleanAtStart;
                    delete p.waitReason;
                    delete p.profileLabel;
                }
                if (j.status === "fail") {
                    try {
                        p.advice = failAdvice(j);
                    }
                    catch { }
                }
                return p;
            }), settings, drain: drainState(), activeEpic: VIEW, dry: DRY, epics: epicsPublic(VIEW), testReqs: ctx.reqs, inbox: ctx.inbox, orderHints: (snapNow() && snapNow().orderHints) || [], train: trainPublic(VIEW), flaky: flakyList(), stagingRed: stgRedMap(),
            accept: enabled("accept") ? { ...acceptBrief(), runnable: !!PROJECT.accept.run, specGlob: PROJECT.accept.specGlob, standUrl: PROJECT.accept.standUrl || PROJECT.release.stand.url } : null, reminders: enabled("accept") ? remindersPublic() : [],
            fresh: Object.fromEntries(jobsNow.filter((j) => j.status === "ok" && trees.some((t) => t.key === j.tree)).map((j) => [j.id, jobFresh(j, trees.find((t) => t.key === j.tree))])),
            tasks: tasksPublic(),
            queue: Object.fromEntries(Object.entries(queues).map(([k, q]) => [k, q.length])),
            digest: digestBrief(settings),
            stateCorrupt: corruptList(),
            retroTriage: enabled("retro") ? retroTriageBrief() : null,
            tg: enabled("tg") ? tgPublic() : null,
        });
    }
    if (req.method === "GET" && url.pathname === "/api/monitor")
        return send(res, 200, { now: Date.now(), hosts: (() => {
                const l = { ...(shardApi().load() || {}) };
                delete l.local;
                return l;
            })(), mem: memState().v, sys: sysState(), stack: stackState(), procs: procRows(), slotUsage: slotUsageState(), serverOnline: shardApi().slotOnline(), hostHealth: shardApi().hostHealth(), sshGate: sshGateStats(), sseClients: sseClients.size });
    if (req.method === "GET" && url.pathname === "/api/epic-progress") {
        const r = await epicProgressOp(url.searchParams.get("epic") || "", url.searchParams.get("hours") || 24);
        return send(res, r.code, r.body);
    }
    if (req.method === "GET" && url.pathname === "/api/retro") {
        const r = retroGet(url.searchParams.get("epic") || "");
        return send(res, r.code, r.body);
    }
    if (req.method === "GET" && url.pathname === "/api/epic-journal") {
        const q = url.searchParams;
        const r = await epicJournalOp(q.get("epic") || "", { from: q.get("from") || 0, to: q.get("to") || Infinity, types: q.get("types") || "", limit: q.get("limit") || 2000, format: q.get("format") || "json" });
        return send(res, r.code, r.body);
    }
    if (req.method === "GET" && url.pathname === "/api/digest-stats")
        return send(res, 200, digestStats(settings));
    if (req.method === "GET" && url.pathname === "/api/accept-state")
        return send(res, 200, acceptPublic());
    if (req.method === "GET" && url.pathname.startsWith("/api/job/")) {
        const j = jobList().find((x) => x.id === url.pathname.split("/").pop());
        return j ? send(res, 200, publicJob(j, true)) : send(res, 404, { error: "нет такого запуска" });
    }
    if (req.method === "GET" && url.pathname === "/api/graph")
        return send(res, 200, await graphData(VIEW));
    if (req.method === "GET" && url.pathname.startsWith("/api/log/")) {
        const id = url.pathname.split("/").pop();
        const from = Number(url.searchParams.get("from") || 0);
        const j = jobList().find((x) => x.id === id);
        if (!j)
            return send(res, 404, { error: "нет такого запуска" });
        const q = (k) => url.searchParams.get(k);
        if (q("grep") != null || q("max") != null || q("to") != null) {
            let all = "";
            try {
                all = await fs.promises.readFile(logPath(id), "utf8");
            }
            catch {
                return send(res, 404, "лога нет (логи старше 7 суток удаляются)", "text/plain; charset=utf-8");
            }
            const r = sliceLog(all, { grep: q("grep") || "", ctx: Number(q("ctx") || 2), from: Math.max(1, from || 1), to: Number(q("to") || 0), max: Math.min(60000, Number(q("max") || 6000)) });
            return send(res, 200, r.text + "\n", "text/plain; charset=utf-8");
        }
        let text = "", next = from;
        try {
            const fh = await fs.promises.open(logPath(id), "r");
            try {
                const size = (await fh.stat()).size;
                if (size > from) {
                    const buf = Buffer.alloc(Math.min(size - from, 400000));
                    await fh.read(buf, 0, buf.length, from);
                    text = buf.toString("utf8").replace(ANSI, "");
                    next = from + buf.length;
                }
            }
            finally {
                await fh.close();
            }
        }
        catch { }
        return send(res, 200, { text, next, status: j.status, job: publicJob(j) });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/agent/") && url.pathname.endsWith("/events")) {
        const key = decodeURIComponent(url.pathname.split("/")[3]), since = Number(url.searchParams.get("since") || 0);
        if (!agentCwd(key))
            return send(res, 404, { error: "нет такого слота" });
        const a = agents.get(key), pub = agentPublic(key);
        const hist = since === 0 && (!a || !a.items.length) ? [...(await readHistory(agentCwd(key), (agentSession(key) || latestSession(agentCwd(key)) || {}).id)), ...recentNotes(key)] : [];
        return send(res, 200, { ...pub, items: a ? a.items.filter((x) => x.rev > since) : [], history: hist, err: a && a.dead ? a.lastErr || "" : "" });
    }
    if (req.method === "GET" && url.pathname === "/api/station") {
        const t0 = treeByKey(url.searchParams.get("tree") || ""), sid = url.searchParams.get("id") || "";
        if (!t0 || !exists(t0.path) || !STATIONS.some((x) => x.id === sid))
            return send(res, 404, { error: "нет такой станции" });
        if (!snapNow())
            await rebuild();
        const t = snapNow().trees.find((x) => x.key === t0.key) || t0;
        return send(res, 200, await stationInfo(t, sid));
    }
    if (req.method === "GET" && url.pathname === "/api/changes") {
        const t = treeByKey(url.searchParams.get("tree") || "");
        if (!t || !exists(t.path))
            return send(res, 404, { error: "нет такого слота" });
        const [br, work, branch, log] = await Promise.all([git(t.path, ["rev-parse", "--abbrev-ref", "HEAD"]), workChanges(t.path), branchChanges(t.path), git(t.path, ["log", "--format=%h%x09%s", "-6"])]);
        return send(res, 200, { branch: br.out, work, branch_files: branch, recent: log.out ? log.out.split("\n").map((l) => l.split("\t")) : [] });
    }
    if (req.method === "GET" && url.pathname === "/api/filediff") {
        const t = treeByKey(url.searchParams.get("tree") || ""), p = url.searchParams.get("path") || "", scope = url.searchParams.get("scope") === "branch" ? "branch" : "work";
        if (!t || !exists(t.path) || !safeRel(p))
            return send(res, 400, { error: "неверные параметры" });
        return send(res, 200, { text: await fileDiff(t.path, scope, p) });
    }
    if (req.method === "GET" && url.pathname === "/api/wagon-plan") {
        const key = url.searchParams.get("tree") || "", wave = String(url.searchParams.get("wave") || "").toUpperCase(), t = treeByKey(key);
        if (!t || !t.train)
            return send(res, 404, { error: "нет такого поезда" });
        const w = (t.wagons || []).find((z) => z.wave === wave);
        if (!w)
            return send(res, 404, { error: "в поезде нет вагона " + wave });
        const f = wagonPlanFile(t, wave);
        if (!f)
            return send(res, 404, { error: "файла плана " + wave + " нет" });
        let text = "";
        try {
            text = fs.readFileSync(f, "utf8");
        }
        catch (e) {
            return send(res, 500, { error: "план не читается: " + e.message });
        }
        return send(res, 200, { wave, title: w.title || "", after: w.after || [], file: f.split(path.sep).join("/"), text });
    }
    if (req.method === "GET" && url.pathname === "/api/annot") {
        const r = await annotGet(url.searchParams.get("tree") || "", url.searchParams.get("doc") || "plan");
        return send(res, r.code, r.body);
    }
    if (url.pathname === "/api/backlog")
        return backlogHttp(req, res, { send, readBody, token: TOKEN, gate: () => null });
    if (req.method !== "POST")
        return send(res, 404, { error: "нет такого адреса" });
    if (req.headers["x-dash-token"] !== TOKEN)
        return send(res, 403, { error: "нет токена запуска: обновите страницу" });
    const b = await readBody(req);
    if (VK)
        for (const f of ORCH_ALIAS_FIELDS)
            if (b[f] === "orchestrator")
                b[f] = VK;
    if (DRY && url.pathname === "/api/dry/merge-sim") {
        const t = snapNow() && snapNow().trees.find((x) => x.key === String(b.key || "") && x.kind === "slot");
        if (!t)
            return send(res, 404, { error: "нет такого слота в снимке" });
        const keys = markMergedNow({ task: "merge", status: "ok", endedAt: Date.now(), steps: [{ cmd: "git", args: ["merge", "--no-ff", t.branch] }], mergeSha: /^[0-9a-f]{40}$/.test(String(b.sha || "")) ? { [t.branch]: String(b.sha) } : {} });
        return send(res, 200, { keys, message: keys.length ? "влив сымитирован: " + keys.join(", ") : "впереди staging ничего — отмечать нечего" });
    }
    if (DRY && url.pathname !== "/api/drain" && !(url.pathname === "/api/epic" && b.op === "activate") && !(url.pathname === "/api/accept" && ["item", "verdict", "comment"].includes(String(b.op))) && !["/api/annot", "/api/ownerq-answer", "/api/retro"].includes(url.pathname))
        return send(res, 403, { error: "сухой режим: это действие в пробном экземпляре не выполняется" });
    if (url.pathname === "/api/retro") {
        const r = await retroStart(String(b.epic || ""), { by: "кнопка", force: !!b.force });
        return send(res, r.code, r.body);
    }
    if (url.pathname === "/api/shard") {
        try {
            if (b.op === "start" || b.op === "prep" || b.op === "rerun")
                return send(res, 200, { ...(await shardApi().start({ prepOnly: b.op === "prep", rerunRed: b.op === "rerun" })), message: b.op === "prep" ? "подготовка машин начата" : b.op === "rerun" ? "перепрогон красных частей начат" : "прогон начат" });
            if (b.op === "cancel")
                return send(res, 200, { ...(await shardApi().cancel()), message: "остановлено" });
            if (b.op === "clean") {
                const r = await shardApi().clean();
                return send(res, 200, { message: Object.entries(r).map(([k, v]) => k + (v.ok ? ": " : " ✗: ") + v.log.replace(/\n/g, " · ")).join("  |  ") || "чистить нечего" });
            }
            if (b.op === "check") {
                const r = await shardApi().check();
                return send(res, 200, { message: Object.entries(r).map(([k, v]) => k + (v.ok ? ": " : " ✗: ") + v.log.replace(/\n/g, " · ")).join("  |  ") });
            }
            return send(res, 400, { error: "op: start, prep, rerun, cancel, clean или check" });
        }
        catch (e) {
            return send(res, 409, { error: e.message });
        }
    }
    if (url.pathname !== "/api/preflight")
        res.on("finish", () => {
            kick();
            bumpVer("post:" + url.pathname.slice(5));
        });
    if (url.pathname === "/api/run" && b.task === "review") {
        if (!enabled("review"))
            return send(res, 404, { error: "модуль «review» выключен" });
        try {
            return send(res, 200, publicJob(await startReview(String(b.tree || ""), !!b.force)));
        }
        catch (e) {
            return send(res, 400, { error: e.message });
        }
    }
    if (url.pathname === "/api/run") {
        if (Array.isArray(b.specs) && b.fam) {
            const a = suiteRunArgs(String(b.fam), b.specs.map(String).slice(0, 400));
            b.task = a.task;
            b.input = a.input;
        }
        const tree = treeByKey(b.tree), task = TASKS[b.task];
        if (!tree || !task || !exists(tree.path))
            return send(res, 400, { error: "неизвестный слот или задача" });
        if (task.input && !INPUT_RE.test(String(b.input || "")))
            return send(res, 400, { error: `нужен ввод: ${task.input.label}` });
        let steps;
        if (task.dynamic) {
            steps = await task.dynamic(tree.path);
            if (!steps)
                return send(res, 200, { notNeeded: true, label: task.label, message: "Сборка не нужна: ветка не меняет областей со сборкой." });
        }
        else
            steps = [stepOfTask(task, tree.path, b.input)];
        {
            const dup = jobList().find((j) => j.tree === tree.key && j.task === b.task && (j.input || "") === String(task.input ? b.input || "" : "") && ["queued", "waiting"].includes(j.status));
            if (dup)
                return send(res, 200, { ...publicJob(dup), duplicate: true });
        }
        if (!b.force) {
            const inp = task.input ? String(b.input || "") : "", fpNow = await codeFp(tree.path, true), who = (tree.tag || tree.key) + ": «" + task.label + (inp ? " " + inp.slice(0, 60) + (inp.length > 60 ? "…" : "") : "") + "» — ";
            const frozen = !NO_GATE.has(b.task) && frozenAfterCommit(tree.key, fpNow, b.task, inp);
            if (frozen)
                return send(res, 200, { gated: true, label: task.label, message: who + "не запускаю: " + frozen });
            const g = runGate({ jobs: jobList(), tree: tree.key, task: b.task, input: inp, fp: fpNow, dist: DIST_TASKS.has(b.task), covers: (k) => jobCovers(k, { task: b.task, input: inp }), realFail, inherited: (k) => onlyStagingRed(k.id), freshOk: (k) => {
                    const tt = snapNow() && snapNow().trees.find((x) => x.key === tree.key);
                    return !!tt && tt.fp === fpNow && jobFresh(k, tt) === "ok";
                } });
            if (!g.run)
                return send(res, 200, { gated: true, label: task.label, job: g.job ? publicJob(g.job) : null, message: who + "не запускаю: " + g.why });
            const nr = narrowBySuites(tree.key, b.task, inp, fpNow);
            if (nr && nr.skip)
                return send(res, 200, { gated: true, label: task.label, message: who + "не запускаю: " + nr.why });
            if (nr && nr.runs) {
                const out = [];
                for (const r of nr.runs) {
                    const tk = TASKS[r.task];
                    out.push(await enqueue({ treeKey: tree.key, cwd: tree.path, label: tk.label, taskId: r.task, input: tk.input ? r.input : "", lane: tk.lane, profile: b.profile, steps: [stepOfTask(tk, tree.path, r.input)], extra: { by: BY_PAGE + " (только незелёные)" } }));
                }
                return send(res, 200, { ...publicJob(out[0]), narrowed: true, message: who + "только незелёные спеки: " + nr.n + " из " + nr.total + (out.length > 1 ? ", частями: " + out.length : "") });
            }
        }
        if (task.input && specAware(b.task) && taskSpecMatches(tree.path, b.task, b.input) === 0)
            return send(res, 200, { notNeeded: true, label: task.label, message: (tree.tag || tree.key) + ": по вводу «" + b.input + "» в ветке нет ни одной спеки задачи «" + task.label + "» — прогон дал бы «нет тестов». Красный тест ещё не написан или ввод неверен." });
        const job = await enqueue({ treeKey: tree.key, cwd: tree.path, label: task.label, taskId: b.task, input: task.input ? b.input : "", lane: task.lane, profile: b.profile, steps, extra: { by: BY_PAGE } });
        return send(res, 200, publicJob(job));
    }
    if (url.pathname === "/api/run-staging") {
        const task = TASKS[b.task];
        if (!task)
            return send(res, 400, { error: "задача — одна из: " + Object.keys(TASKS).join(", ") });
        if (task.input && !INPUT_RE.test(String(b.input || "")))
            return send(res, 400, { error: `нужен ввод: ${task.input.label}` });
        const job = await enqueue({ treeKey: "orchestrator-staging", cwd: MAIN, label: task.label + " · staging", taskId: b.task, input: task.input ? String(b.input) : "", lane: task.lane, profile: b.profile, steps: [stepOfTask(task, MAIN, b.input)], extra: { by: BY_PAGE } });
        return send(res, 200, publicJob(job));
    }
    if (url.pathname === "/api/run-staging-guards") {
        const ids = PROJECT.stations.guards.filter((id) => TASKS[id] && !TASKS[id].input);
        if (!ids.length)
            return send(res, 400, { error: "у проекта нет гардов без ввода (stations.guards или задачи с gate: true)" });
        const out = [];
        for (const id of ids)
            out.push(await enqueue({ treeKey: "orchestrator-staging", cwd: MAIN, label: TASKS[id].label + " · staging", taskId: id, lane: TASKS[id].lane, profile: b.profile, steps: [stepOfTask(TASKS[id], MAIN)], extra: { by: BY_PAGE } }));
        return send(res, 200, { ...publicJob(out[0]), jobs: out.map((j) => j.id), message: "Гарды на staging поставлены: " + ids.map((id) => TASKS[id].label).join(", ") });
    }
    if (url.pathname === "/api/cancel") {
        const j = jobList().find((x) => x.id === b.id);
        if (!j)
            return send(res, 404, { error: "нет такого запуска" });
        logEvent("job.cancel", { id: j.id, tree: j.tree, status: j.status, by: BY_PAGE });
        if (j.status === "queued") {
            for (const q of Object.values(queues)) {
                const i = q.indexOf(j);
                if (i >= 0)
                    q.splice(i, 1);
            }
            j.status = "cancelled";
            j.endedAt = Date.now();
            save();
        }
        else if (j.status === "waiting")
            j.cancelled = true;
        else if (j.status === "running") {
            j.cancelled = true;
            save();
            kick(50);
            if (j.runOn)
                await shardApi().slotCancel(j.id, j.runOn).catch(() => { });
            killTree(procs.get(j.id));
        }
        return send(res, 200, { ok: true });
    }
    if (url.pathname.startsWith("/api/agent/")) {
        const op = url.pathname.split("/")[3], key = String(b.key || ""), cwd = agentCwd(key);
        if (!cwd)
            return send(res, 404, { error: "нет такого слота" });
        if (op === "start") {
            const a = await startAgent(key, { resume: !!b.resume, model: String(b.model || "").replace(/[^a-z0-9.\-]/gi, "") });
            return send(res, 200, agentPublic(key));
        }
        if (op === "prompt") {
            const f = fs.existsSync(PROMPTS_DIR) ? fs.readdirSync(PROMPTS_DIR).find((x) => x.includes(key)) : null;
            if (f)
                return send(res, 200, { text: fs.readFileSync(path.join(PROMPTS_DIR, f), "utf8") });
            const g = genSlotPrompt(key);
            return g ? send(res, 200, { text: g, generated: true }) : send(res, 404, { error: "файла промпта нет" });
        }
        let a = agents.get(key);
        if (op === "send") {
            const byDispatcher = b.from === "dispatcher";
            const text0 = String(b.text || "").trim();
            if (!text0)
                return send(res, 400, { error: "пустое сообщение" });
            const text = byDispatcher && !/^\[Диспетчерская/.test(text0) ? "[Диспетчерская, не слово владельца]\n" + text0 : text0;
            if (!byDispatcher) {
                const n0 = inboxCards().length;
                keepCards((x) => !(x.tree === key && (x.kind === "ownerq" || x.kind === "slotstart")));
                if (inboxCards().length !== n0)
                    saveInbox();
            }
            logEvent(byDispatcher ? "dispatcher.message" : "owner.message", { key, chars: text.length, brief: brief(text) });
            a = await sendUserText(key, text, { owner: !byDispatcher, by: byDispatcher ? "dispatcher" : "", model: String(b.model || "").replace(/[^a-z0-9.\-]/gi, "") });
            if (!byDispatcher) {
                const au = autoOwnerToggle(text);
                if (au !== null) {
                    settings.autoOwnerUntil = au;
                    saveJson(SETTINGS_FILE, settings);
                    logEvent("auto.owner.mode", { on: au > 0, until: au });
                    push(a, { id: "auo-" + a.rev, t: "status", text: au ? "Режим «без владельца» включён до " + new Date(au).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + ": вопросы владельцу получают рекомендованный ответ (кроме денег, прав и прода). Выключить — «я тут»." : "Режим «без владельца» выключен." });
                }
            }
            if (!byDispatcher && isOrch(key)) {
                const off = ownerStopsMergeWaits(key, text);
                if (off.length)
                    push(a, { id: "mwoff-" + a.rev, t: "status", text: "Ожидание ВЛИТЬ снято словом владельца: " + off.join(", ") + "." });
            }
            return send(res, 200, agentPublic(key));
        }
        if (op === "model") {
            const r = setAgentModel(key, String(b.model || "").replace(/[^a-z0-9.\-]/gi, ""));
            return send(res, 200, { ok: true, message: r.live ? "Модель " + r.model + ": со следующего сообщения" : "Агент не запущен: модель «" + r.model + "» возьмётся при запуске" });
        }
        if (!a || a.dead)
            return send(res, 409, { error: "агент не запущен" });
        if (op === "perm") {
            if (!answerPermission(key, b.reqId, { allow: !!b.allow }))
                return send(res, 404, { error: "запрос уже закрыт" });
            return send(res, 200, agentPublic(key));
        }
        if (op === "interrupt") {
            interruptAgent(key);
            return send(res, 200, agentPublic(key));
        }
        if (op === "stop") {
            stopAgent(a);
            return send(res, 200, agentPublic(key));
        }
        return send(res, 400, { error: "неизвестная операция" });
    }
    if (url.pathname === "/api/agent-report") {
        const j = jobList().find((x) => x.id === b.id);
        if (!j)
            return send(res, 404, { error: "нет такого запуска" });
        if (["queued", "waiting", "running"].includes(j.status))
            return send(res, 409, { error: "прогон ещё идёт" });
        const t = treeByKey(j.tree) || TREES[0], key = isOrch(b.to) || b.to === "orchestrator" ? orchOfKey(t.key) : t.key;
        if (!agentCwd(key))
            return send(res, 404, { error: "у слота нет папки" });
        const text = buildReport(j, { to: key, record: !b.preview && (isOrch(key) || j.note === "baseline-shrunk") });
        if (b.preview)
            return send(res, 200, { text, key });
        if (!isOrch(key) && j.note !== "baseline-shrunk") {
            if (j.reported)
                return send(res, 409, { error: "этот прогон уже отправлен агенту" + (j.reportedAt ? " в " + new Date(j.reportedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "") });
            const r = await sendBatch(t.key, [j.id]);
            return send(res, r.code, r.code === 200 ? { ...agentPublic(t.key), key: t.key, batched: r.body.batched } : r.body);
        }
        j.reported = true;
        j.reportedAt = Date.now();
        j.reportedVia = "button";
        save();
        let a = agents.get(key);
        if (!a || a.dead)
            a = await ensureAgent(key);
        deliver(a, text, "report", { by: "button" });
        return send(res, 200, { ...agentPublic(key), key });
    }
    if (url.pathname === "/api/slot-stop") {
        const key = String(b.tree || "");
        if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(key))
            return send(res, 400, { error: "неверный слот" });
        const done = [];
        const a = agents.get(key);
        if (a && !a.dead) {
            stopAgent(a);
            done.push("агент остановлен (сессия сохранена)");
        }
        if (b.cancelJobs) {
            let n = 0;
            for (const j of jobList().filter((x) => x.tree === key && ["running", "queued", "waiting"].includes(x.status))) {
                if (j.status === "queued") {
                    for (const q of Object.values(queues)) {
                        const i = q.indexOf(j);
                        if (i >= 0)
                            q.splice(i, 1);
                    }
                    j.status = "cancelled";
                    j.endedAt = Date.now();
                }
                else {
                    j.cancelled = true;
                    if (j.status === "running") {
                        if (j.runOn)
                            shardApi().slotCancel(j.id, j.runOn).catch(() => { });
                        killTree(procs.get(j.id));
                    }
                }
                n++;
            }
            if (n) {
                save();
                done.push("прогонов отменено: " + n);
            }
        }
        if (enabled("win-desktop"))
            for (const w of ((slotUsageState() || {}).windows || []).filter((x) => x.slot === key)) {
                await closeWindow(w.hwnd).catch(() => { });
                done.push("окно редактора закрывается (несохранённое редактор спросит сам)");
            }
        setTimeout(sampleMachine, 1500);
        return send(res, 200, { ok: true, message: done.length ? done.join("; ") : "у слота нечего останавливать" });
    }
    if (url.pathname === "/api/autochain") {
        const key = String(b.tree || "");
        if (!treeByKey(key))
            return send(res, 404, { error: "нет такого слота" });
        if (b.on === false || b.on === true) {
            const off = { ...(settings.autoTrainOff || {}) };
            if (b.on)
                delete off[key];
            else
                off[key] = Date.now();
            settings.autoTrainOff = off;
            saveJson(SETTINGS_FILE, settings);
            logEvent("autochain.toggle", { tree: key, on: b.on });
            if (!b.on)
                return send(res, 200, { ok: true, on: false, message: "Автопоезд ветки выключен: станции, коммит и поезд — вручную" });
        }
        for (const k of [...autoRan])
            if (k.startsWith(key + "|chain|"))
                autoRan.delete(k);
        const was = settings.autoTrain;
        settings.autoTrain = true;
        autoChain(key, "кнопка владельца").finally(() => {
            settings.autoTrain = was;
        });
        return send(res, 200, { ok: true, message: "Автопоезд пошёл с первой непройденной станции; доедет до коммита (если автокоммит включён), влив — за вами" });
    }
    if (url.pathname === "/api/train-wagon") {
        const t = snapNow() && snapNow().trees.find((x) => x.key === String(b.tree || ""));
        if (!t || !t.train)
            return send(res, 404, { error: "нет такого поезда" });
        const wave = String(t.head || ""), w = (t.wagons || []).find((z) => z.wave === wave);
        if (!w)
            return send(res, 409, { error: "в очереди нет вагонов — все влиты в staging" });
        if (b.wave && String(b.wave).toUpperCase() !== wave)
            return send(res, 409, { error: "вагоны идут по очереди: следующий — " + wave + " (порядок меняется перетаскиванием в очереди)" });
        if (w.state === "wait" && !b.force)
            return send(res, 409, { error: "вагон " + wave + " ждёт " + (w.waitFor || []).join(", ") + " — запустить в обход: в окне вагона «Запустить сейчас»" });
        if (t.issued === wave)
            return send(res, 409, { error: "вагон " + wave + " уже у агента поезда" });
        const r = await issueWagon(t, wave, { by: "кнопка владельца" });
        return send(res, r.ok ? 200 : 409, r.ok ? { ok: true, message: r.why } : { error: r.why });
    }
    if (url.pathname === "/api/order-wagons") {
        const t = snapNow() && snapNow().trees.find((x) => x.key === String(b.tree || ""));
        if (!t || !t.train)
            return send(res, 404, { error: "нет такого поезда" });
        const waves = (Array.isArray(b.waves) ? b.waves : []).map((w) => String(w).toUpperCase()).filter((w) => /^WV-[0-9]{4}$/.test(w));
        if (!waves.length)
            return send(res, 400, { error: "нет списка вагонов" });
        const r = await epicOrderWagons(t.tag, waves, t.epic || "");
        if (r.status !== 0)
            return send(res, 409, { error: (r.stderr || r.stdout || "epic.mjs order-wagons не сработал").trim().split(/\r?\n/).pop() });
        logEvent("train.order", { tree: t.key, waves });
        try {
            applyEpics();
            await rebuildOne(t.key);
        }
        catch (e) {
            console.error("порядок депо, пересборка:", e.message);
        }
        return send(res, 200, { ok: true, message: (r.stdout || "").trim() || "порядок депо обновлён" });
    }
    if (url.pathname === "/api/slot-archive") {
        {
            const t0 = snapNow() && snapNow().trees.find((x) => x.key === String(b.tree || ""));
            if (t0 && t0.train && (t0.wagons || []).some((w) => w.state !== "staging"))
                return send(res, 409, { error: "у поезда остались невлитые вагоны (" + t0.wagons.filter((w) => w.state !== "staging").map((w) => w.wave).join(", ") + ") — поезд живёт до закрытия эпика, в архив нельзя" });
        }
        const r = await archiveSlotOp(String(b.tree || ""));
        return send(res, r.code, r.body);
    }
    if (url.pathname === "/api/merge-wait") {
        const t = treeByKey(String(b.slot || ""));
        if (!t || t.kind !== "slot")
            return send(res, 404, { error: "нет такого слота" });
        if (b.op !== "cancel")
            return send(res, 400, { error: "op: cancel" });
        return send(res, 200, { ok: true, message: cancelMergeWait(t.key, "владелец") ? t.tag + ": ожидание влива снято, слово владельца по нему погашено" : t.tag + ": ожидания влива нет" });
    }
    if (url.pathname === "/api/slot-sync") {
        const t = treeByKey(String(b.tree || ""));
        if (!t || t.kind !== "slot" || !exists(t.path))
            return send(res, 404, { error: "нет такого слота" });
        const tt = { ...t, ...((snapNow() && snapNow().trees.find((x) => x.key === t.key)) || {}) };
        const r = await syncSlot(tt, { ffOnly: false, why: "кнопка владельца" });
        kick();
        syncReport(tt, r);
        if (r.ok)
            return send(res, 200, { ok: true, message: t.tag + ": " + r.text });
        if (r.dirty && r.dirty.length)
            return send(res, 409, { error: t.tag + ": в слоте незакоммиченные правки в файлах, которые правит и staging (" + r.dirty.slice(0, 3).join(", ") + "): влив не начат, агент получил просьбу закоммитить" });
        if (r.conflict)
            return send(res, 409, { error: t.tag + ": конфликт с staging в " + r.conflict.length + " файл(ах) — влив откатан, агент получил список: " + r.conflict.slice(0, 4).join(", ") });
        return send(res, 409, { error: t.tag + ": " + (r.skip || r.fail) });
    }
    if (url.pathname === "/api/slot-reset") {
        const r = await slotReset({ key: String(b.tree || ""), to: String(b.to || "staging"), dry: b.dry === true, by: b.by === "epic.mjs" ? "epic.mjs reset-slot" : "кнопка владельца" });
        return send(res, r.code, r.body);
    }
    if (url.pathname === "/api/slot-start") {
        const key = String(b.tree || "");
        if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(key))
            return send(res, 400, { error: "неверный слот" });
        const ws = path.join(WT, "_workspaces", (isOrch(key) ? "orchestrator" : key) + ".code-workspace"), dir = isOrch(key) ? (treeByKey(key) || {}).path : path.join(WT, key);
        const target = fs.existsSync(ws) ? ws : dir && fs.existsSync(dir) ? dir : null;
        if (!target)
            return send(res, 404, { error: "нет ни файла окна, ни папки слота" });
        spawn("code", [JSON.stringify(target)], { shell: true, detached: true, stdio: "ignore", windowsHide: true }).unref();
        setTimeout(sampleMachine, 4000);
        return send(res, 200, { ok: true, message: "окно открывается: " + path.basename(target) });
    }
    if (url.pathname === "/api/kill") {
        const pid = Number(b.pid), p = procRows().find((x) => x.pid === pid);
        if (!p)
            return send(res, 404, { error: "процесса уже нет в списке — обновите страницу" });
        if (!p.killable || pid === process.pid)
            return send(res, 409, { error: "этот процесс останавливать нельзя" });
        await killPid(pid);
        const a = [...agents.values()].find((x) => x.proc && x.proc.pid === pid);
        if (a) {
            a.stopping = true;
        }
        setTimeout(sampleMachine, 600);
        return send(res, 200, { ok: true, killed: p.name + " " + pid });
    }
    if (url.pathname === "/api/reminders") {
        const r = await remindersOp(b);
        return send(res, r.code, r.body);
    }
    if (url.pathname === "/api/accept") {
        const r = await acceptOp(b);
        return send(res, r.code, r.body);
    }
    if (url.pathname === "/api/stand-checklist") {
        const t0 = treeByKey(String(b.tree || ""));
        if (!t0 || !agentCwd(t0.key))
            return send(res, 404, { error: "нет такого слота" });
        if (!snapNow())
            await rebuild();
        const t = snapNow().trees.find((x) => x.key === t0.key) || t0;
        let a = agents.get(t.key);
        if (!a || a.dead)
            a = await ensureAgent(t.key);
        if (a.busy)
            return send(res, 409, { error: "агент сейчас отвечает — дождитесь конца ответа" });
        a.capture = { kind: "stand-checklist", tree: t.key, branch: t.branch, startRev: a.rev };
        deliver(a, STAND_ASK, "accept", { by: "dispatcher" });
        return send(res, 200, { ...agentPublic(t.key), key: t.key });
    }
    if (url.pathname === "/api/drain") {
        const was = !!drainState();
        if (b.on) {
            if (!drainState()) {
                setDrain({ since: Date.now(), by: String(b.by || "restart").slice(0, 60) });
                console.log("подготовка к перезапуску:", drainState().by);
            }
        }
        else if (drainState()) {
            setDrain(null);
            console.log("подготовка к перезапуску снята");
            pumpAll();
            for (const to of new Set(inboxCards().filter((x) => x.kind === "relay" && x.queued).map((x) => x.to)))
                drainQueued(to);
        }
        if (was !== !!drainState())
            logEvent("drain", { on: !!b.on, by: String(b.by || "restart").slice(0, 60) });
        const busyJobs = jobList().filter((j) => ["running", "waiting"].includes(j.status)).map((j) => ({ id: j.id, task: j.task, tree: j.tree, status: j.status }));
        const permStuck = (a) => a.pending.size > 0 && Date.now() - (a.permAt || 0) > 5 * 60e3;
        const busyAgents = [...agents.values()].filter((a) => !a.dead && (a.busy || a.pending.size) && !permStuck(a)).map((a) => ({ key: a.key, pending: a.pending.size }));
        const fr = (() => {
            try {
                const p = shardApi().pub(), r = p && (p.run || p);
                return r && ["prep", "running"].includes(r.status) ? { id: r.id || "", status: r.status } : null;
            }
            catch {
                return null;
            }
        })();
        if (fr)
            busyJobs.push({ id: "полный прогон " + fr.id, task: "shard", tree: "staging", status: fr.status });
        return send(res, 200, { drain: drainState(), idle: !busyJobs.length && !busyAgents.length, busyJobs, busyAgents, queued: jobList().filter((j) => j.status === "queued").length });
    }
    if (url.pathname === "/api/relay") {
        logEvent("relay.button", { from: String(b.from || ""), to: String(b.to || ""), force: b.force === true });
        const r = await doRelay(String(b.from || ""), String(b.to || ""), String(b.text || ""), b.force === true);
        return send(res, r.code, r.body);
    }
    if (url.pathname === "/api/annot") {
        try {
            const r = await annotPost(b);
            return send(res, r.code, r.body);
        }
        catch (e) {
            return send(res, e.code || 500, { error: e.message });
        }
    }
    if (url.pathname === "/api/ownerq-answer") {
        try {
            const r = await ownerAnswer(String(b.tree || ""), String(b.text || ""), b.id ? String(b.id) : "");
            return send(res, r.code, r.body);
        }
        catch (e) {
            return send(res, 500, { error: e.message });
        }
    }
    if (url.pathname === "/api/inbox") {
        const op = String(b.op || ""), id = String(b.id || "");
        if (op === "send") {
            const it = inboxCards().find((x) => x.id === id);
            logEvent("relay.button", { id, kind: it ? it.kind : "", from: it ? it.tree || "" : "", to: it ? it.to || "" : "" });
            const r = await inboxSend(id, true);
            return send(res, r.code, r.body);
        }
        if (op === "dismiss") {
            keepCards((x) => x.id !== id);
            saveInbox();
            return send(res, 200, { ok: true });
        }
        return send(res, 400, { error: "op: send или dismiss" });
    }
    if (url.pathname === "/api/settings") {
        if (typeof b.autoOwner === "boolean") {
            settings.autoOwnerUntil = b.autoOwner ? Date.now() + AUTO_OWNER_HOURS * 3600e3 : 0;
            logEvent("auto.owner.mode", { on: b.autoOwner, until: settings.autoOwnerUntil, via: "settings" });
        }
        if (typeof b.autoCommit === "boolean")
            settings.autoCommit = b.autoCommit;
        if (typeof b.autoMerge === "boolean") {
            settings.autoMerge = b.autoMerge;
            logEvent("merge.auto.toggle", { on: b.autoMerge });
        }
        if (typeof b.autoSyncConflict === "boolean") {
            settings.autoSyncConflict = b.autoSyncConflict;
            logEvent("slot.sync.auto.toggle", { on: b.autoSyncConflict });
        }
        if (typeof b.autoResults === "boolean")
            settings.autoResults = b.autoResults;
        if (typeof b.autoTrain === "boolean")
            settings.autoTrain = b.autoTrain;
        if (typeof b.fullPermissions === "boolean")
            settings.fullPermissions = b.fullPermissions;
        logEvent("settings", { by: BY_PAGE, ...b });
        if (typeof b.selfCommit === "string" && ["word", "station", "free"].includes(b.selfCommit))
            settings.selfCommit = b.selfCommit;
        if (typeof b.commitTrailer === "string")
            settings.commitTrailer = b.commitTrailer.replace(/\r/g, "").slice(0, 300);
        for (const k of ["modelOrch", "modelSlot", "modelBacklog", "modelRetro"])
            if (typeof b[k] === "string")
                settings[k] = b[k].replace(/[^a-z0-9.\-]/gi, "") || (k === "modelBacklog" || k === "modelRetro" ? "" : DEFAULT_MODEL[k === "modelOrch" ? "orch" : "slot"]);
        if (typeof b.retroAuto === "boolean")
            settings.retroAuto = b.retroAuto;
        if (typeof b.tgBot === "boolean") {
            settings.tgBot = b.tgBot;
            if (enabled("tg"))
                tgSettingsChanged();
        }
        saveJson(SETTINGS_FILE, settings);
        return send(res, 200, { ok: true, settings });
    }
    if (url.pathname === "/api/hygiene") {
        const keep = Array.isArray(settings.keepWorktrees) ? settings.keepWorktrees : KEEP_DEFAULT;
        if (b.op === "run") {
            if (hygieneNow.running)
                return send(res, 409, { error: "уборка уже идёт" });
            hygieneNow.running = true;
            const p = await hygieneRefresh(openEpics(), { keep });
            logEvent("hygiene.run", { extra: p.extra.length, by: BY_PAGE });
            hygieneRun(p).then((r) => {
                logEvent("hygiene.done", { removed: r.removed, branches: r.branches, stashed: r.stashed, failed: r.failed });
                return hygieneRefresh(openEpics(), { keep });
            }).catch((e) => console.error("уборка папок:", e.message)).finally(() => {
                hygieneNow.running = false;
                kick();
            });
            return send(res, 200, { ok: true, message: "Убираю " + p.extra.length + " лишних папок слотов: незакоммиченное — в git stash, невлитые ветки остаются. Займёт несколько минут." });
        }
        const p = await hygieneRefresh(openEpics(), { keep });
        return send(res, 200, { total: p.total, extra: p.extra.map((w) => ({ path: w.p, branch: w.br, ahead: w.ahead })) });
    }
    if (url.pathname === "/api/agent-commit") {
        const r = await agentCommit(String(b.tree || ""));
        return send(res, r.code, r.body);
    }
    if (url.pathname === "/api/commit") {
        const t = treeByKey(String(b.tree || ""));
        if (!t || !exists(t.path))
            return send(res, 404, { error: "нет такого слота" });
        const msg = String(b.message || "").trim(), paths = Array.isArray(b.paths) ? b.paths.map(String) : [];
        if (msg.length < 5 || msg.length > 2000)
            return send(res, 400, { error: "сообщение коммита: от 5 до 2000 знаков" });
        if (!paths.length || paths.length > 600 || !paths.every(safeRel))
            return send(res, 400, { error: "не выбраны файлы" });
        const br = (await git(t.path, ["rev-parse", "--abbrev-ref", "HEAD"])).out;
        if (!br || ["staging", "main", "HEAD"].includes(br))
            return send(res, 409, { error: `в ветку «${br || "?"}» коммитить отсюда нельзя` });
        const work = await workChanges(t.path), known = new Set(work.map((f) => f.path));
        const unknown = paths.filter((p) => !known.has(p));
        if (unknown.length)
            return send(res, 409, { error: "файлы уже не числятся изменёнными: " + unknown.slice(0, 3).join(", ") + ". Обновите список." });
        const bad = paths.filter((p) => SENSITIVE.test(p));
        if (bad.length)
            return send(res, 409, { error: "похоже на секреты, не коммичу: " + bad.slice(0, 3).join(", ") });
        const full = withTrailer(msg);
        const job = await enqueue({ treeKey: t.key, cwd: t.path, label: `Коммит в ${br}`, taskId: "commit", lane: "ops", extra: { pipeline: true, commitFiles: paths.length }, steps: [
                { cmd: "git", args: ["add", "--", ...paths], show: `git add -- (${paths.length} файлов поимённо)`, cwd: t.path },
                { cmd: "git", args: ["commit", "--only", "-m", full, "--", ...paths], show: `git commit --only -m "${msg.split("\n")[0].slice(0, 80)}" -- (${paths.length} файлов)`, cwd: t.path },
                { cmd: "git", args: ["log", "-1", "--stat", "--format=%h %s"], show: "git log -1 --stat", cwd: t.path },
            ] });
        return send(res, 200, publicJob(job));
    }
    if (url.pathname === "/api/stage") {
        const tree = treeByKey(b.tree);
        if (!tree || !exists(tree.path) || !STATIONS.some((s) => s.id === b.stage) || (b.value !== undefined && ![true, false, null].includes(b.value)) || (b.value === undefined && typeof b.note !== "string"))
            return send(res, 400, { error: "неизвестный слот или станция" });
        const br = (await withGitPriority(() => git(tree.path, ["rev-parse", "--abbrev-ref", "HEAD"]))).out;
        const k = `${tree.key}|${br}`;
        markStage(k, b.stage, b.value, b.note);
        logEvent("stage.mark", { tree: tree.key, stage: b.stage, value: b.value ?? null, note: !!b.note, by: BY_PAGE });
        if (b.stage === "review" && b.value === true && settings.autoTrain)
            setTimeout(() => autoChain(tree.key, "ревью принято вручную").catch((e) => console.error("автопоезд:", e.message)), 1500);
        await withGitPriority(() => rebuildOne(tree.key)).catch(() => { });
        {
            const inflight = rebuildingNow();
            if (inflight)
                inflight.then(() => withGitPriority(() => rebuildOne(tree.key))).catch(() => { });
        }
        return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/force") {
        const j = jobList().find((x) => x.id === b.id && (x.status === "waiting" || (x.status === "queued" && x.waitReason)));
        if (!j)
            return send(res, 404, { error: "запуск ничего не ждёт" });
        j.force = true;
        j.waitReason = "";
        logEvent("job.force", { id: j.id, tree: j.tree });
        pumpAll();
        return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/provision") {
        const x = slotOf(String(b.tree || ""));
        if (!x)
            return send(res, 404, { error: "нет такого слота в активном эпике" });
        const lastUp = [...jobList()].reverse().find((j) => j.task === "slot-up" && j.tree === x.slot);
        if (!slotMissing(x) && (!lastUp || lastUp.status === "ok"))
            return send(res, 409, { error: "слот уже подготовлен: папка есть, подготовка прошла" });
        if (jobList().some((j) => j.task === "slot-up" && j.tree === x.slot && ["queued", "waiting", "running"].includes(j.status)))
            return send(res, 409, { error: "подготовка уже идёт" });
        return send(res, 200, publicJob(await enqueueProvision(x)));
    }
    if (url.pathname === "/api/epic" && b.op === "close") {
        const id = String(b.id || ""), r = await closeEpicOp(id, { force: !!b.force });
        if (r.code === 200 && enabled("retro") && settings.retroAuto !== false) {
            const rt = await retroStart(id, { by: "закрытие эпика", force: true }).catch((e) => ({ code: 500, body: { error: e.message } }));
            r.body.retro = rt.body.retro || null;
            r.body.retroMsg = rt.body.message || rt.body.error || "";
        }
        return send(res, r.code, r.body);
    }
    if (url.pathname === "/api/epic") {
        const op = String(b.op || ""), id = String(b.id || "");
        const r = op === "activate" ? activateEpic(id) : op === "archive" ? setEpicStatus(id, "closed") : op === "restore" ? setEpicStatus(id, "open") : { code: 400, body: { error: "op: activate, archive или restore" } };
        return send(res, r.code, r.body);
    }
    if (url.pathname === "/api/rebuild") {
        fpLast.clear();
        graphCaches.clear();
        buildCache.clear();
        redCache.clear();
        for (const t of TREES)
            touchSnap(t.key);
        await rebuild();
        return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/sync-staging") {
        const br = (await git(MAIN, ["rev-parse", "--abbrev-ref", "HEAD"])).out;
        if (br !== "staging")
            return send(res, 409, { error: "основная папка не на staging (сейчас " + br + ")" });
        const st = (await git(MAIN, ["status", "--porcelain", "--untracked-files=no"])).out;
        if (st)
            return send(res, 409, { error: "в основной папке есть изменения отслеживаемых файлов: сначала разберитесь с ними" });
        await git(MAIN, ["fetch", REMOTE], 60000);
        const [behind, ahead] = pairs((await git(MAIN, ["rev-list", "--left-right", "--count", UP_STAGING + "...staging"])).out);
        if (!behind)
            return send(res, 200, { ok: true, message: "локальный staging уже содержит " + UP_STAGING });
        const steps = ahead
            ? [{ cmd: "git", args: ["merge", "--no-ff", UP_STAGING, "-m", "merge: " + UP_STAGING + " в локальный staging"], show: "git merge --no-ff " + UP_STAGING + " (ветки разошлись: своих " + ahead + ", чужих " + behind + ")", cwd: MAIN }]
            : [{ cmd: "git", args: ["merge", "--ff-only", UP_STAGING], show: "git merge --ff-only " + UP_STAGING + " (перемотка на " + behind + ")", cwd: MAIN }];
        const job = await enqueue({ treeKey: "orchestrator-staging", cwd: MAIN, label: ahead ? "Слить " + UP_STAGING + " в локальный staging" : "Догнать " + UP_STAGING, taskId: "sync-staging", lane: "ops", steps, extra: { pipeline: true } });
        return send(res, 200, { ok: true, id: job.id, message: (ahead ? "Слияние" : "Перемотка") + " поставлено: " + job.id + (enabled("release") ? ". Пуш staging — при выкате стенда." : "") });
    }
    if (url.pathname === "/api/fetch") {
        const r = await git(MAIN, ["fetch", REMOTE], 60000);
        return send(res, r.ok ? 200 : 500, { ok: r.ok, message: r.err || REMOTE + " обновлён" });
    }
    if (url.pathname === "/api/order") {
        try {
            setOrder(String(b.a || ""), String(b.b || ""), b.op === "none" ? "none" : "after");
        }
        catch (e) {
            return send(res, 400, { error: e.message });
        }
        dropSnap();
        kick();
        return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/train") {
        if (b.op === "start") {
            try {
                const j = await trainStart(viewOf(req, url));
                return send(res, 200, { ok: true, job: publicJob(j), message: "Поезд: " + trainNow().keys.map((k) => treeByKey(k).tag).join(" + ") + " — проверка на staging + все вместе поставлена" });
            }
            catch (e) {
                return send(res, 400, { error: e.message });
            }
        }
        if (b.op === "stop") {
            if (trainNow()) {
                for (const r of trainNow().runs) {
                    const j = jobList().find((x) => x.id === r.id);
                    if (j && ["queued", "waiting", "running"].includes(j.status)) {
                        if (j.status === "queued") {
                            for (const q of Object.values(queues)) {
                                const i = q.indexOf(j);
                                if (i >= 0)
                                    q.splice(i, 1);
                            }
                            j.status = "cancelled";
                            j.endedAt = Date.now();
                        }
                        else {
                            j.cancelled = true;
                            if (j.status === "running") {
                                if (j.runOn)
                                    shardApi().slotCancel(j.id, j.runOn).catch(() => { });
                                killTree(procs.get(j.id));
                            }
                        }
                    }
                }
                markTrain({ status: "stopped" });
                saveTrain();
                save();
            }
            return send(res, 200, { ok: true });
        }
        if (b.op === "merge") {
            const v = await trainValid();
            if (!v.ok)
                return send(res, 409, { error: v.why });
            const pl = await pipelineState(), sf = pl.stagingFolder;
            if (sf.branch !== "staging" || sf.dirtyTracked)
                return send(res, 409, { error: "основная папка не на staging или в ней изменения" });
            for (const k of v.keys) {
                const t = await treeState(treeByKey(k));
                if (t.dirtyTracked)
                    return send(res, 409, { error: t.tag + ": появились незакоммиченные изменения" });
            }
            const steps = v.keys.flatMap((k) => {
                const t = treeByKey(k);
                return [{ cmd: "git", args: ["merge", "--no-ff", t.branch, "-m", "merge: " + t.branch], show: "git merge --no-ff " + t.branch + " (" + t.tag + ")", cwd: MAIN }, mergeShaStep(t.branch)];
            });
            const job = await enqueue({ treeKey: "orchestrator-staging", cwd: MAIN, label: "Влить поездом: " + v.keys.map((k) => treeByKey(k).tag).join(" + "), taskId: "merge", lane: "ops", steps, extra: { pipeline: true, trainMerge: trainNow().id } });
            markTrain({ status: "merging", mergeJob: job.id });
            saveTrain();
            return send(res, 200, publicJob(job));
        }
        if (b.op === "landed") {
            const x = treeByKey(String(b.key || "")), wave = normWave(b.wave), sha = String(b.sha || "").trim();
            if (!x || !isTrain(x))
                return send(res, 400, { error: "нет такого поезда" });
            if (!wave || !(x.wagons || []).some((z) => z.wave === wave))
                return send(res, 400, { error: "в поезде " + x.tag + " нет вагона " + (wave || b.wave) });
            if (!/^[0-9a-f]{7,40}$/.test(sha))
                return send(res, 400, { error: "sha влива — 7–40 hex" });
            const anc = await git(MAIN, ["merge-base", "--is-ancestor", sha, "staging"], 30000, true);
            if (!anc.ok)
                return send(res, 409, { error: sha + " не в staging — отметить вагон влитым нельзя" });
            const ct = await git(MAIN, ["show", "-s", "--format=%ct", sha], 30000, true);
            markLanded(x.key, wave, sha, Number(String(ct.out || "").trim()) * 1000 || Date.now());
            await rebuildOne(x.key).catch(() => { });
            return send(res, 200, { ok: true, message: x.tag + ": вагон " + wave + " отмечен влитым (" + sha.slice(0, 10) + ")" });
        }
        if (b.op === "clear") {
            clearTrain();
            try {
                fs.unlinkSync(TRAIN_FILE);
            }
            catch { }
            return send(res, 200, { ok: true });
        }
        return send(res, 400, { error: "op: start | stop | merge | landed | clear" });
    }
    if (url.pathname === "/api/preflight") {
        if (releaseAction(b.action) && !enabled("release"))
            return send(res, 404, { error: "модуль «release» выключен" });
        const p = await preflight(b.action, b.slot);
        return send(res, 200, { checks: p.checks, ok: p.ok, cmd: preflightCmd(b.action, b.slot) });
    }
    if (url.pathname === "/api/pipeline") {
        const r = await pipelineStart(b, { view: VIEW });
        return send(res, r.code, r.body);
    }
    send(res, 404, { error: "нет такого адреса" });
}

export async function pipelineStart(b, { view = null, via = "" } = {}) {
    const action = b.action;
    if (!PIPELINE_ACTIONS.includes(action))
        return { code: 400, body: { error: "неизвестное действие" } };
    // сначала право источника слова (бот выкатывать не может никогда), потом — есть ли модуль выката
    if (!wordGrants(via, pipelineAction(action, b.force === true)))
        return { code: 403, body: { error: "из бота — только влив в staging без «всё равно»: выкат стенда, прода и принудительный влив — на странице" } };
    if (releaseAction(action) && !enabled("release"))
        return { code: 404, body: { error: "модуль «release» выключен" } };
    const VIEW = view;
    if (action === "release" && (b.confirm !== "ВЫКАТ" || b.accepted !== true))
        return { code: 400, body: { error: "для выката в прод нужно слово ВЫКАТ и отметка «принято на стенде»" } };
    const t = action === "merge" ? treeByKey(b.slot) : null;
    if (action === "merge" && !t)
        return { code: 404, body: { error: "нет такого слота" } };
    const snapT = t ? ((snapNow() || {}).trees || []).find((x) => x.key === t.key) : null, branch = t ? (snapT && snapT.branch) || t.plannedBranch : undefined;
    const r = recipe(action, { slotKey: b.slot, branch });
    if (!r)
        return { code: 400, body: { error: "нет рецепта: " + (action === "deploy-staging" ? "не задано release.stand.run" : action === "release" ? "нет прод-ветки (repo.upstream.main)" : "нет ветки слота") } };
    if (action === "deploy-staging") {
        const wagons = ((snapNow() && snapNow().trees) || []).filter((x) => x.kind === "slot" && x.merge && !((x.stages || []).find((s) => s.id === "stand") || {}).done)
            .map((x) => ({ key: x.key, tag: x.tag, color: x.color, title: x.title }));
        r.extra = { wagons, stagesDef: [["push", "Пуш staging"], ["stand", "Выкат стенда"]], epic: VIEW || null };
    }
    if (via === "tg")
        r.extra = { ...(r.extra || {}), by: "владелец через бота" };
    logEvent("pipeline", { action, slot: String(b.slot || ""), by: via === "tg" ? "бот" : BY_PAGE });
    const check = async () => {
        const p = await preflight(action, b.slot);
        const forced = action === "merge" && b.force === true ? p.checks.filter((c) => c.ok === false && FORCE_SOFT.has(c.id)) : [];
        if (!p.ok && !(forced.length && p.checks.every((c) => c.ok !== false || FORCE_SOFT.has(c.id))))
            return { ok: false, why: p.checks.filter((c) => c.ok === false).map((c) => c.text + (c.detail ? " (" + String(c.detail).slice(0, 160) + ")" : "")).join("; ") };
        if (t) {
            const live = (p.trees || []).find((x) => x.key === t.key);
            if (live && live.branch && live.branch !== branch)
                return { ok: false, why: "ветка слота сменилась: ждали " + branch + ", в папке " + live.branch };
        }
        const extra = { ...(r.extra || {}) };
        if (action === "release") {
            const rn = await releaseNotes().catch(() => null);
            Object.assign(extra, { version: (rn && rn.version) || null, wagons: ((rn && rn.waves) || []).map((w) => ({ key: w.branch, tag: w.tag, color: w.color, title: w.title || w.branch })) });
        }
        return { ok: true, label: r.label + (forced.length ? " (всё равно: снято — " + forced.map((c) => c.id).join(", ") + ")" : ""), extra: { ...extra, ...(forced.length ? { forced: forced.map((c) => c.text) } : {}) } };
    };
    const job = await enqueueChecked({ treeKey: r.treeKey, cwd: r.cwd, label: r.label, taskId: action, lane: r.lane, steps: r.steps, extra: { pipeline: true } }, check);
    return { code: 200, body: publicJob(job) };
}

/** Текст команды для окна подтверждения: что именно сделает действие конвейера. */
export function preflightCmd(action, slotKey) {
    try {
        const t = action === "merge" ? treeByKey(slotKey) : null;
        const snapT = t ? ((snapNow() || {}).trees || []).find((x) => x.key === t.key) : null;
        const r = recipe(action, { slotKey, branch: t ? (snapT && snapT.branch) || t.plannedBranch : undefined });
        return r ? r.steps.filter((x) => x.show && (x.cmd || x.text)).map((x) => x.show).join("\n") : "";
    }
    catch {
        return "";
    }
}

/** Остановить процесс со страницы (только из списка «можно остановить» монитора). */
function killPid(pid) {
    return new Promise((r) => {
        if (process.platform === "win32")
            return execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => r());
        try {
            process.kill(pid, "SIGTERM");
        }
        catch { }
        r();
    });
}

/**
 * Убрать слот в архив: запись реестра получает archived и пропадает из рабочего вида. Папка и ветка не трогаются —
 * их убирает уборка папок слотов. Нельзя, пока у слота идут прогоны, работает агент или ветка не влита.
 */
export async function archiveSlotOp(key) {
    const reg = loadEpics(), e = reg.epics.find((x) => (x.slots || []).some((s) => s.slot === key)), s = e && e.slots.find((x) => x.slot === key);
    if (!s)
        return { code: 404, body: { error: "нет такого слота" } };
    if (s.archived)
        return { code: 200, body: { ok: true, message: s.tag + ": уже в архиве" } };
    const a = agents.get(key);
    if (a && !a.dead)
        return { code: 409, body: { error: s.tag + ": сначала остановите агента (сессия сохранится)" } };
    if (jobList().some((j) => j.tree === key && ["running", "queued", "waiting"].includes(j.status)))
        return { code: 409, body: { error: s.tag + ": идут прогоны слота — дождитесь" } };
    const t = snapNow() && snapNow().trees.find((x) => x.key === key);
    if (t && t.exists && t.ahead > 0 && !(t.verdict && t.verdict.merged))
        return { code: 409, body: { error: s.tag + ": в ветке есть невлитые коммиты (" + t.ahead + ") — сначала влейте или сбросьте" } };
    s.archived = true;
    s.archivedAt = new Date().toISOString();
    saveEpics(reg);
    applyEpics();
    logEvent("slot.archive", { tree: key, by: BY_PAGE });
    return { code: 200, body: { ok: true, message: s.tag + ": в архиве (папка и ветка остались — их уберёт уборка папок слотов)" } };
}
