// snapshot.mjs — снимок состояния всех деревьев для страницы. Собирается по событиям (конец прогона, ход агента,
// действие на странице, смена реестра), в простое — не чаще SNAP_IDLE_MS; событие во время сборки не теряется — сборка
// повторится.
import { S } from "./state.mjs";
import { logEvent } from "./config.mjs";
import { TREES, viewEpic } from "./trees.mjs";
import { bumpVer } from "./events.mjs";
import { pipelineState, treeState } from "./git.mjs";
import { mergedBranches } from "./idle.mjs";
import { late, lateObject } from "./late.mjs";
import { jobList } from "./jobs.mjs";
import { activity } from "./loopwatch.mjs";
import { snapMaxAge } from "./snap-rules.mjs";
import { withDeadline } from "./deadline.mjs";

const { orderHints } = late("pipeline.mjs", ["orderHints"]);
const agentsMap = lateObject("agents.mjs", "agents");
const { markMergedTree, stagingMerges, withStages } = late("stations.mjs", ["markMergedTree", "stagingMerges", "withStages"]);
export const SNAP_IDLE_MS = Number(process.env.DASH_SNAP_IDLE_MS) || 180000;
let dirty = false, timer = null;
export const snapNow = () => S.snap;
export const rebuildingNow = () => S.rebuilding;

export const dropSnap = () => {
    S.snap = null;
};

export const isSyncing = (key) => !!(S.syncing && S.syncing.has(key));
const SYNC_GEN = new Map(), SYNC_N = new Map();
export const syncGen = (key) => SYNC_GEN.get(key) || 0;

export function markSyncing(key) {
    if (!S.syncing)
        S.syncing = new Set();
    S.syncing.add(key);
    SYNC_N.set(key, (SYNC_N.get(key) || 0) + 1);
    SYNC_GEN.set(key, syncGen(key) + 1);
}

export const unmarkSyncing = (key) => {
    const n = (SYNC_N.get(key) || 1) - 1;
    if (n > 0)
        SYNC_N.set(key, n);
    else {
        SYNC_N.delete(key);
        if (S.syncing)
            S.syncing.delete(key);
    }
    SYNC_GEN.set(key, syncGen(key) + 1);
};

export const FP_HOLD_MS = 120000;

export function holdShaken(trees, oldTrees, g0, gen, syncing, now = Date.now()) {
    const held = [];
    let again = false;
    const out = trees.map((t) => {
        const old = (oldTrees || []).find((x) => x.key === t.key);
        if (!old || old === t)
            return t;
        const moved = gen(t.key) !== (g0.get(t.key) || 0) || syncing(t.key);
        const noFp = !moved && t.exists && !t.fp && old.fp && now - (old.fpHeldSince || now) < FP_HOLD_MS;
        if (!moved && !noFp)
            return t;
        held.push(t.key);
        if (moved)
            again = true;
        if (noFp && !old.fpHeldSince)
            old.fpHeldSince = now;
        return old;
    });
    return { trees: out, held, again };
}

export const SNAP_DEADLINE_MS = Number(process.env.DASH_SNAP_DEADLINE_MS) || 10 * 60000;

export function rebuild() {
    return _rebuildWith(buildSnap, SNAP_DEADLINE_MS);
}

export function _rebuildWith(build, ms) {
    if (S.rebuilding) {
        dirty = true;
        return S.rebuilding;
    }
    dirty = false;
    const t0 = Date.now();
    const work = build(t0).then((snap) => {
        if (!snap || (S.snap && (S.snap.t0 || 0) > t0))
            return;
        S.snap = snap;
        bumpVer("snap");
    });
    S.rebuilding = withDeadline(work, ms, "сборка снимка").catch((e) => console.error("снимок:", e.message)).finally(() => {
        S.rebuilding = null;
        if (dirty)
            kick(500);
    });
    return S.rebuilding;
}

const TOUCHED = new Set();

export const touchSnap = (key) => {
    TOUCHED.add(key);
};

function reusable(t, prev) {
    if (!prev || !prev.snapAt)
        return false;
    if (TOUCHED.has(t.key)) {
        TOUCHED.delete(t.key);
        return false;
    }
    const a = agentsMap.get ? agentsMap.get(t.key) : null;
    return (
        Date.now() - prev.snapAt <
        snapMaxAge({
            kind: t.kind,
            epic: t.epic,
            viewEpic: (viewEpic() || {}).id,
            merged: !!(prev.verdict && prev.verdict.merged) && !(prev.ahead > 0) && !prev.dirtyTracked,
            agentBusy: !!(a && !a.dead && (a.busy || a.pending.size)),
            jobLive: jobList().some((j) => j.tree === t.key && ["queued", "waiting", "running"].includes(j.status)),
        })
    );
}

function stageErr(t, e) {
    t.stagesError = String((e && e.message) || e).slice(0, 300);
    console.error("станции " + t.key + ":", t.stagesError);
    try {
        logEvent("snap.stage_error", { tree: t.key, error: t.stagesError });
    }
    catch { }
}

async function buildSnap(t0) {
    activity("снимок: сборка");
    const g0 = new Map(SYNC_GEN), old = S.snap ? S.snap.trees : [];
    const T = process.env.DASH_TIMING ? (name, p) => {
        const t0 = Date.now();
        return Promise.resolve(p).then((v) => {
            console.log("[время] " + name + ": " + (Date.now() - t0) + " мс");
            return v;
        });
    } : (name, p) => p;
    const [trees0, pl, merges] = await Promise.all([Promise.all(TREES.map((t) => {
            const prev = old.find((x) => x.key === t.key), o = (isSyncing(t.key) || reusable(t, prev)) && prev;
            return o ? Promise.resolve(o) : T("состояние " + t.key, treeState(t).then((x) => (x.snapAt = Date.now(), x)));
        })), T("конвейер", pipelineState()), T("слияния staging", stagingMerges())]);
    await Promise.all(trees0.map((t) => old.includes(t) ? null : (activity("станции " + t.key), T("станции " + t.key, withStages(t, merges)).catch((e) => {
        stageErr(t, e);
    }))));
    const h = holdShaken(trees0, old, g0, syncGen, isSyncing), trees = h.trees;
    if (h.again)
        dirty = true;
    const hints = await orderHints(trees).catch(() => []);
    return { trees: keepMerged(trees, t0), pl, at: Date.now(), orderHints: hints, merges, t0 };
}

export async function rebuildFresh() {
    if (S.rebuilding)
        await S.rebuilding.catch(() => { });
    return rebuild();
}

export async function rebuildOne(key) {
    const base = TREES.find((x) => x.key === key);
    if (!base || !S.snap || !S.snap.merges) {
        await rebuildFresh();
        return S.snap && S.snap.trees.find((x) => x.key === key);
    }
    if (isSyncing(key))
        return S.snap.trees.find((x) => x.key === key);
    const g0 = new Map([[key, syncGen(key)]]), t0 = Date.now(), t = await treeState(base);
    t.snapAt = Date.now();
    await withStages(t, S.snap.merges);
    const h = holdShaken([t], S.snap.trees, g0, syncGen, isSyncing);
    if (h.held.length) {
        if (h.again)
            kick(500);
        return h.trees[0];
    }
    const [t1] = keepMerged([t], t0), i = S.snap.trees.findIndex((x) => x.key === key);
    if (i >= 0)
        S.snap.trees[i] = t1;
    else
        S.snap.trees.push(t1);
    bumpVer("tree:" + key);
    return t1;
}

const MERGED = new Map();

export function markMergedNow(job) {
    const br = mergedBranches(job);
    if (!br.length || !S.snap)
        return [];
    const at = (job && job.endedAt) || Date.now();
    for (const b of br)
        MERGED.set(b, { sha: ((job && job.mergeSha) || {})[b] || null, at });
    const before = S.snap.trees;
    S.snap.trees = keepMerged(before, at - 1);
    const keys = S.snap.trees.filter((t, i) => t !== before[i]).map((t) => t.key);
    if (keys.length)
        bumpVer("merged:" + keys.join(","));
    return keys;
}

export function keepMerged(trees, t0) {
    if (!MERGED.size)
        return trees;
    for (const [b, o] of MERGED)
        if (Date.now() - o.at > 3600e3)
            MERGED.delete(b);
    return trees.map((t) => {
        const o = t.kind === "slot" && MERGED.get(t.branch);
        if (!o)
            return t;
        if (t0 >= o.at) {
            MERGED.delete(t.branch);
            return t;
        }
        return markMergedTree(t, o);
    });
}

export async function rebuildMerged(job) {
    const br = mergedBranches(job);
    if (!br.length || !S.snap)
        return;
    S.snap.merges = await stagingMerges();
    for (const t of S.snap.trees.filter((x) => x.kind === "slot" && br.includes(x.branch)))
        await rebuildOne(t.key).catch((e) => console.error("снимок влитого слота", t.key, e.message));
}

export function kick(ms = 300) {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
        if (S.rebuilding)
            return;
        rebuild();
    }, ms);
}

export function startSnapshotLoop() {
    rebuild();
    setInterval(() => {
        if (!S.rebuilding && Date.now() - ((S.snap && S.snap.at) || 0) > SNAP_IDLE_MS)
            kick(0);
    }, 5000);
}
