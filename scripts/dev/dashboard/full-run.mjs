// full-run.mjs — полный прогон по частям: каталог частей проекта → по прогону на часть → машины прогонов разбирают очередь.
// Конфиг проекта `fullRun`: { task, listCmd, listRe, exclude?, pin? } (project.mjs). Решения — в full-run-rules.mjs.
// Подключается в boot.mjs поверх реализации машин (installFullRun): shardApi().start/cancel/pub/summary/log.
// Данные: DATA/full-run.json — последние прогоны (id, коммит staging, части и номера их прогонов). Итоги частей — в
// записях прогонов диспетчерской (runs.jsonl), сюда не копируются.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MAIN, PROJECT } from "../slots.mjs";
import { DATA, logEvent, logPath } from "./config.mjs";
import { git } from "./git.mjs";
import { jobList } from "./jobs.mjs";
import { envFailInLog } from "./regress.mjs";
import { enqueue, killTree, procs, queues, save } from "./runner.mjs";
import { kick } from "./snapshot.mjs";
import { readJson, saveJson } from "./store.mjs";
import { TASKS, stepOfTask } from "./tasks.mjs";
import { lastDurations, orderParts, parseCatalog, redParts, retryPlan, runView, summarize } from "./full-run-rules.mjs";

export const FULL_RUN_FILE = path.join(DATA, "full-run.json");
const KEEP = 10, TREE = "orchestrator-staging", JOB_ID_RE = /^j\d{1,7}$/;
const NO_CFG = "полный прогон не настроен: в dispatcher.project.json нет `fullRun` (task, listCmd, listRe)";

const byId = () => new Map((jobList() || []).map((j) => [j.id, j]));

/** Команда каталога частей в основной папке (staging): stdout, без прокси, с таймаутом. */
function runList(cmd, timeoutMs = 120000) {
    return new Promise((res, rej) => {
        const env = { ...process.env };
        for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"])
            delete env[k];
        const c = spawn("bash", ["-lc", cmd], { cwd: MAIN, env, stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        const t = setTimeout(() => {
            try { c.kill("SIGKILL"); } catch { /* уже нет */ }
            rej(new Error("каталог частей: нет ответа за " + Math.round(timeoutMs / 1000) + " с"));
        }, timeoutMs);
        c.stdout.on("data", (d) => { out += d; });
        c.stderr.on("data", (d) => { err = (err + d).slice(-400); });
        c.on("error", (e) => { clearTimeout(t); rej(e); });
        c.on("close", (code) => {
            clearTimeout(t);
            if (code === 0 || out.trim())
                res(out);
            else
                rej(new Error("каталог частей: код " + code + (err ? " — " + err.trim() : "")));
        });
    });
}

/** Снять прогон диспетчерской (как кнопка ✕ на странице): из очереди — сразу, идущий — отметкой и сигналом. */
async function cancelJob(j, slotCancel) {
    if (j.status === "queued") {
        for (const q of Object.values(queues)) {
            const i = q.indexOf(j);
            if (i >= 0)
                q.splice(i, 1);
        }
        j.status = "cancelled";
        j.endedAt = Date.now();
    }
    else if (j.status === "waiting")
        j.cancelled = true;
    else if (j.status === "running") {
        j.cancelled = true;
        if (j.runOn && slotCancel)
            await slotCancel(j.id, j.runOn).catch(() => { });
        killTree(procs.get(j.id));
    }
}

/**
 * Реализация полного прогона поверх машин. base — текущая реализация shardApi() (машины): её pub/machineLabel/slotCancel
 * берутся как есть. → объект с методами, которые ставятся в shardApi() вместо заглушек «полного прогона нет».
 */
export function createFullRun(base, { cfg = PROJECT.fullRun, file = FULL_RUN_FILE, tickMs = 5000 } = {}) {
    const st = { runs: (readJson(file, { runs: [] }) || { runs: [] }).runs || [] };
    const persist = () => saveJson(file, { runs: st.runs.slice(-KEEP) });
    const active = () => {
        const r = st.runs[st.runs.length - 1];
        return r && r.status === "running" ? r : null;
    };
    const label = (mk) => (base.machineLabel ? base.machineLabel(mk) : mk);
    const task = cfg && cfg.task ? TASKS[cfg.task] : null;

    async function enqueuePart(run, id, only = null, note = "") {
        const p = run.parts[id] || (run.parts[id] = { id, jobs: [], only: null, note: "" });
        const pin = only || (cfg.pin && cfg.pin[id]) || null;
        const job = await enqueue({
            treeKey: TREE, cwd: MAIN, label: task.label + " · полный прогон", taskId: cfg.task, input: id, lane: task.lane,
            steps: [stepOfTask(task, MAIN, id)], extra: { by: "полный прогон", fullRun: run.id, only: pin },
        });
        if (job && job.id && !p.jobs.includes(job.id))
            p.jobs.push(job.id);
        p.only = pin;
        if (note)
            p.note = note;
        return job;
    }

    async function start({ prepOnly = false, rerunRed = false, by = "кнопка" } = {}) {
        if (!cfg || !task)
            return { ok: false, error: NO_CFG };
        if (prepOnly)
            return { ok: false, error: "отдельной подготовки машин нет: машина готовит свою папку прогона сама перед каждой частью" };
        if (active())
            return { ok: false, error: "полный прогон уже идёт: " + active().id };
        const head = await git(MAIN, ["rev-parse", "staging"]), subj = await git(MAIN, ["log", "-1", "--format=%s", "staging"]);
        if (!head.ok)
            return { ok: false, error: "staging не прочитан: " + head.err.slice(0, 160) };
        const prev = st.runs[st.runs.length - 1] || null, jobs = byId();
        let ids;
        if (rerunRed) {
            if (!prev)
                return { ok: false, error: "перепрогонять нечего: полного прогона ещё не было" };
            ids = redParts(prev, jobs);
            if (!ids.length)
                return { ok: false, error: "красных частей нет" };
        }
        else {
            try {
                ids = parseCatalog(await runList(cfg.listCmd), cfg.listRe, cfg.exclude || []);
            }
            catch (e) {
                return { ok: false, error: String((e && e.message) || e) };
            }
            if (!ids.length)
                return { ok: false, error: "каталог частей пуст: проверьте fullRun.listCmd и fullRun.listRe" };
        }
        const order = orderParts(ids, prev ? lastDurations(prev, jobs) : {});
        const run = { id: "fr" + Date.now().toString(36), sha: head.out, subject: subj.out || "", status: "running", startedAt: Date.now(), by, parts: {}, order, rerunOf: rerunRed ? prev.id : null };
        st.runs.push(run);
        persist();
        logEvent("fullrun.start", { id: run.id, sha: run.sha, parts: order.length, rerun: !!rerunRed, by });
        for (const id of order)
            await enqueuePart(run, id).catch((e) => { logEvent("fullrun.enqueue.fail", { id: run.id, part: id, error: String(e.message || e).slice(0, 200) }); });
        persist();
        kick(50);
        return { ok: true, id: run.id, parts: order.length, sha: run.sha.slice(0, 10) };
    }

    async function cancel() {
        const run = active();
        if (!run)
            return { ok: false, error: "полный прогон не идёт" };
        const jobs = byId();
        for (const p of Object.values(run.parts))
            for (const id of p.jobs) {
                const j = jobs.get(id);
                if (j && ["queued", "waiting", "running"].includes(j.status))
                    await cancelJob(j, base.slotCancel);
            }
        run.status = "cancelled";
        run.endedAt = Date.now();
        persist();
        save();
        kick(50);
        logEvent("fullrun.cancel", { id: run.id });
        return { ok: true };
    }

    // Слежение: окружное падение на удалённой — повтор на этой машине; все части с итогом — прогон закончен.
    let ticking = false;
    async function tick() {
        const run = active();
        if (!run || ticking)
            return;
        ticking = true;
        try {
            const jobs = byId();
            for (const p of Object.values(run.parts)) {
                const plan = retryPlan(p, jobs, (j) => envFailInLog(j));
                if (plan) {
                    logEvent("fullrun.retry", { id: run.id, part: p.id, why: plan.why });
                    await enqueuePart(run, p.id, plan.only, plan.why).catch(() => { });
                }
            }
            const sm = summarize(run, byId());
            if (sm && sm.status === "done") {
                run.status = "done";
                run.endedAt = Date.now();
                logEvent("fullrun.done", { id: run.id, ok: sm.ok, fail: sm.fail, skipped: sm.skipped, notrun: sm.notrun, total: sm.total });
            }
            persist();
        }
        finally {
            ticking = false;
        }
    }
    const timer = tickMs ? setInterval(() => { tick().catch(() => { }); }, tickMs) : null;
    if (timer && timer.unref)
        timer.unref();

    const last = () => st.runs[st.runs.length - 1] || null;
    return {
        start,
        cancel,
        tick,
        fullRunOn: () => false, // части идут обычными прогонами через места машин — слоты не ждут конца полного прогона
        fullRunLeft: () => {
            const run = active();
            return run ? summarize(run, byId()).running : 0;
        },
        summary: () => summarize(last(), byId()),
        pub: () => {
            const b = base.pub ? base.pub() : {};
            return { ...b, configured: !!(cfg && task), run: runView(last(), byId(), { label }), history: st.runs.slice(-KEEP).reverse().map((r) => summarize(r, byId())) };
        },
        log: async (f) => {
            const id = String(f || "");
            if (!JOB_ID_RE.test(id))
                return null;
            try {
                return fs.readFileSync(logPath(id), "utf8").slice(-200000);
            }
            catch {
                return null;
            }
        },
        clean: async () => ({ ok: false, error: "уборка не нужна: папки прогонов на машинах — общие с проверками слотов" }),
        check: async () => ({ ok: true, configured: !!(cfg && task) }),
        stop: () => { if (timer) clearInterval(timer); },
    };
}
