// auto-merge.mjs — исполнитель автовлива ветки в staging и автоподтягивания staging при конфликте. Работает только при
// включённом settings.autoMerge; проверки перед вливом — те же, что у кнопки «Влить».
import { DRY, logEvent, settings } from "./config.mjs";
import { jobList } from "./jobs.mjs";
import { agents, push, sendWhenFree } from "./agents.mjs";
import { snapNow, rebuildOne } from "./snapshot.mjs";
import { epicSlots, treeByKey, viewEpic } from "./trees.mjs";
import { drainState, syncReport, syncSlot } from "./epics.mjs";
import { waveFinalOf } from "./slot-done.mjs";
import { late } from "./late.mjs";
import { askDoneAct, askDoneText, autoMergeAct, autoSyncAct, mergePin } from "./auto-merge-rules.mjs";
import { git } from "./git.mjs";
import { TASKS } from "./tasks.mjs";
import { MAIN } from "../slots.mjs";

const { preflight, recipe } = late("pipeline.mjs", ["preflight", "recipe"]);
const { enqueue } = late("runner.mjs", ["enqueue"]);
// Автовлив и автоподтягивание включаются только явно (settings.json); по умолчанию выключены.
export const autoMergeOn = () => settings.autoMerge === true;
export const autoSyncOn = () => settings.autoSyncConflict === true;
const LIVE = ["queued", "waiting", "running"];
const mergeLive = () => jobList().some((j) => j.task === "merge" && LIVE.includes(j.status));

const busyOf = (key) => {
    const a = agents.get(key);
    return !!(a && !a.dead && (a.busy || (a.pending && a.pending.size))) || jobList().some((j) => j.tree === key && LIVE.includes(j.status));
};

const say = (key, text) => {
    const a = agents.get(key);
    if (a)
        push(a, { id: "am-" + a.rev + Math.random().toString(36).slice(2, 4), t: "status", text });
};

const refused = new Map();
let inflight = false;

export async function autoMerge(key, why = "автопоезд") {
    if (DRY || inflight)
        return { ok: false, why: inflight ? "влив уже ставится" : "сухой режим" };
    let t = (snapNow() && snapNow().trees.find((x) => x.key === key)) || null;
    if (t && t.ahead > 0 && t.conflict == null)
        t = (await rebuildOne(key).catch(() => null)) || t;
    const d = autoMergeAct({ on: autoMergeOn(), drain: !!drainState(), t, final: !!t && waveFinalOf(t), mergeLive: mergeLive() });
    if (d.act !== "merge")
        return { ok: false, why: d.why };
    inflight = true;
    try {
        const p = await preflight("merge", key);
        const bad = (p.checks || []).filter((c) => c.ok === false);
        if (bad.length) {
            const sig = t.fp + "|" + bad.map((c) => c.id).join(",");
            if (refused.get(key) !== sig) {
                refused.set(key, sig);
                logEvent("merge.auto.refused", { tree: key, why, detail: bad.map((c) => c.text + (c.detail ? " (" + c.detail + ")" : "")).join("; ").slice(0, 300) });
            }
            return { ok: false, why: "проверка влива: " + bad.map((c) => c.text).join("; ") };
        }
        const tt = (p.trees || []).find((x) => x.key === key) || {}, br = tt.branch || t.branch;
        const pin = mergePin({ head: (await git(MAIN, ["rev-parse", "--verify", "--quiet", br + "^{commit}"])).out, snapSha: (t.last || {}).sha });
        if (!pin.ok) {
            logEvent("merge.auto.refused", { tree: key, why, detail: pin.why });
            return { ok: false, why: pin.why };
        }
        const r = recipe("merge", { slotKey: key, branch: br, sha: pin.sha });
        const job = await enqueue({
            treeKey: r.treeKey,
            cwd: r.cwd,
            label: r.label,
            taskId: "merge",
            lane: r.lane,
            steps: r.steps,
            extra: { pipeline: true, by: "автовлив (слово владельца 20.11)", auto: true, slot: key },
        });
        refused.delete(key);
        logEvent("merge.auto", { tree: key, why, job: job && job.id, branch: br, sha: pin.sha });
        say(
            key,
            "Автовлив: ветка " +
                br +
                " @" +
                pin.sha.slice(0, 10) +
                " — в staging (" +
                (job ? job.id : "") +
                "). Коммиты после него в этот влив не войдут. После влива ветка подтянет staging, и следующий вагон очереди придёт сам.",
        );
        return { ok: true, why: "вливаю (" + (job ? job.id : "") + ")" };
    }
    finally {
        inflight = false;
    }
}

export async function autoMergeReady(why = "проверка простоя") {
    if (DRY || !autoMergeOn() || !snapNow() || mergeLive())
        return;
    const keys = new Set(epicSlots().filter((x) => !x.archived).map((x) => x.slot));
    for (const t of snapNow().trees.filter((x) => keys.has(x.key))) {
        if (autoMergeAct({ t: t.conflict == null ? { ...t, conflict: [] } : t, final: waveFinalOf(t) }).act !== "merge") {
            askDone(t);
            continue;
        }
        const r = await autoMerge(t.key, why);
        if (r.ok)
            return;
    }
}

const askedDone = new Map();

function askDone(t) {
    const d = autoMergeAct({ drain: !!drainState(), t, final: waveFinalOf(t) });
    const a = askDoneAct({ d, t, busy: busyOf(t.key), asked: askedDone.get(t.key) || "" });
    if (a.act !== "ask")
        return;
    askedDone.set(t.key, t.fp);
    logEvent("merge.auto.ask-done", { tree: t.key, fp: t.fp, wave: t.wagon || "", why: a.why });
    sendWhenFree(t.key, askDoneText({ ...t, key: t.key }));
}

// Задачи станций — все задачи проекта и сборка ветки.
const stationTask = (id) => id === "build" || Object.hasOwn(TASKS, id);

function redOnCode(t) {
    if (!t || !t.fp)
        return false;
    const last = new Map();
    for (const j of jobList())
        if (j.tree === t.key && stationTask(j.task) && ["ok", "fail"].includes(j.status))
            last.set(j.task + "|" + (j.input || ""), j);
    return [...last.values()].some((j) => j.status === "fail" && (j.fpEnd || j.fpStart) === t.fp);
}

const syncTried = new Map();
let syncRun = false;

export async function autoSyncConflicts() {
    if (DRY || syncRun || !autoSyncOn() || !snapNow() || !viewEpic() || drainState())
        return;
    syncRun = true;
    try {
        const staging = (snapNow().pl && snapNow().pl.staging) || "", epic = viewEpic().id;
        for (const t0 of snapNow().trees.filter((x) => x.epic === epic)) {
            const sig = staging + "|" + t0.fp;
            const d = autoSyncAct({ on: autoSyncOn(), t: t0, busy: busyOf(t0.key), tried: syncTried.get(t0.key) === sig, red: redOnCode(t0) });
            if (d.act !== "sync")
                continue;
            syncTried.set(t0.key, sig);
            const x = treeByKey(t0.key);
            if (!x)
                continue;
            const tt = { ...x, ...t0 };
            const r = await syncSlot(tt, { ffOnly: false, why: "авто: конфликт со staging" }).catch((e) => ({ fail: e.message }));
            syncReport(tt, r);
            logEvent("slot.sync.auto", {
                tree: t0.key,
                result: r.ok ? "ok" : r.conflict ? "conflict" : r.skip ? "skip" : "fail",
                detail: String(r.text || r.skip || r.fail || (r.conflict || []).join(", ")).slice(0, 200),
            });
            if (r.skip)
                syncTried.delete(t0.key);
            if (r.ok)
                await rebuildOne(t0.key).catch(() => { });
        }
    }
    finally {
        syncRun = false;
    }
}
