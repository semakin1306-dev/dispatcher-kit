// epics.mjs — эпики и слоты на сервере диспетчерской: вкладки эпиков, подготовка папок слотов очередью прогонов (slot-up
// и запреты слота), закрытие эпика командой epic.mjs, перемотка папки оркестратора и слотов на staging и разбор
// конфликтов такой перемотки.
import { EPIC_CLI, MAIN, PROJECT, WT, isForeignEpic, loadEpics, saveEpics } from "../slots.mjs";
import fs from "node:fs";
import path from "node:path";
import { S } from "./state.mjs";
import { readJson, saveJson } from "./store.mjs";
import { shardApi } from "./shard.mjs";
import { jobList } from "./jobs.mjs";
import { agentCwd, agents, epicOfSlot, push, sendWhenFree } from "./agents.mjs";
import { DATA, DRY, FINAL, HERE, logEvent, sleep } from "./config.mjs";
import { spawn as spawnP } from "./spawner.mjs";
import { git } from "./git.mjs";
import { syncMemo, syncTargets } from "./idle.mjs";
import { late } from "./late.mjs";
import { kick, markSyncing, rebuildOne, snapNow, unmarkSyncing } from "./snapshot.mjs";
import { applyEpics, epicById, epicSlots, openEpics, orchKey, setViewEpic, treeByKey, viewEpic } from "./trees.mjs";
import { dirtyBlockers, parseSync, syncConflictText, syncDirtyText } from "./sync-rules.mjs";
import { provisionArgs, provisionDue } from "./slot-rules.mjs";

const { enqueue } = late("runner.mjs", ["enqueue"]);

export const drainState = () => S.drainMode;

export const setDrain = (v) => {
    S.drainMode = v;
};

export const epicsPublic = (view) => loadEpics().epics.map((e) => ({ id: e.id, title: e.title, status: isForeignEpic(e) ? "closed" : e.status, active: (view || (viewEpic() && viewEpic().id)) === e.id, slots: e.slots.length, orchBranch: e.orch.branch }));

export function activateEpic(id) {
    const reg = loadEpics(), ep = reg.epics.find((e) => e.id === id && e.status !== "closed" && !isForeignEpic(e));
    if (!ep)
        return { code: 404, body: { error: "нет такого открытого эпика" } };
    if (!DRY && reg.active !== ep.id) {
        reg.active = ep.id;
        saveEpics(reg);
        setViewEpic(epicById(ep.id) || viewEpic());
    }
    return { code: 200, body: { ok: true, id: ep.id, view: true } };
}

export const SLOT_UP = process.env.DASH_SLOTUP_SCRIPT || path.join(HERE, "..", "slot-up.mjs");
const SLOT_WS = path.join(HERE, "..", "slot-workspaces.mjs");
export const slotMissing = (x) => !fs.existsSync(path.join(WT, x.slot, ".git"));
const SPEC_RE = /\.(spec|test)\.[cm]?[jt]sx?$|_test\.go$|(^|[\\/])test_[^\\/]*\.py$|_test\.py$/;
const SPEC_SKIP = new Set(["node_modules", "dist", "build", "vendor", "target", "__pycache__", ".venv", ".git"]);
export const specCache = new Map();

/** Файлы спек задачи в папке слота: обход папки запуска задачи (`tasks.<id>.cwd`, иначе корень), пути через «/». */
export function taskSpecs(dir, taskId, project = PROJECT) {
    const t = project.tasks[taskId], root = path.join(dir, (t && t.cwd) || ""), k = root;
    const hit = specCache.get(k);
    if (hit && Date.now() - hit.at < 30e3)
        return hit.v;
    const out = [], walk = (d, depth) => {
        let es = [];
        try {
            es = fs.readdirSync(d, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of es) {
            if (SPEC_SKIP.has(e.name) || e.name.startsWith("."))
                continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) {
                if (depth < 12)
                    walk(p, depth + 1);
            }
            else if (SPEC_RE.test(e.name))
                out.push(p.replace(/\\/g, "/"));
        }
    };
    walk(root, 0);
    specCache.set(k, { at: Date.now(), v: out });
    return out;
}

/** Сколько спек задачи подходит под фильтр-регулярку (-1 — фильтр не регулярка). У задачи без ввода фильтра нет — null. */
export function taskSpecMatches(dir, taskId, input, project = PROJECT) {
    const t = project.tasks[taskId];
    if (!t || !t.input)
        return null;
    let re;
    try {
        re = new RegExp(String(input || ""));
    }
    catch {
        return -1;
    }
    return taskSpecs(dir, taskId, project).filter((p) => re.test(p) || re.test(p.replace(/\//g, "\\"))).length;
}

/** Задачи, которым нужна сборка: задачи областей со сборкой (`areas.<id>.build`). */
export const NEED_PKGS = new Set(Object.values(PROJECT.areas).filter((a) => a.build).flatMap((a) => a.tasks));
const provLocks = new Map();
const liveProvision = (key) => jobList().find((j) => j.task === "slot-up" && j.tree === key && ["queued", "waiting", "running"].includes(j.status));

export function enqueueProvision(x) {
    if (provLocks.has(x.slot))
        return provLocks.get(x.slot);
    const live = liveProvision(x.slot);
    if (live)
        return Promise.resolve(live);
    const p = (async () => {
        const args = [SLOT_UP, ...provisionArgs(x, slotMissing(x))];
        const steps = [{ cmd: process.execPath, args, show: "node scripts/dev/slot-up.mjs " + args.slice(1).join(" "), cwd: MAIN }];
        const epicId = x.__epic || (epicOfSlot(x.slot) || {}).id;
        if (epicId) {
            const wa = [SLOT_WS, "--epic", epicId, "--only", x.slot];
            steps.push({ cmd: process.execPath, args: wa, show: "node scripts/dev/slot-workspaces.mjs " + wa.slice(1).join(" "), cwd: MAIN });
        }
        return enqueue({ treeKey: x.slot, cwd: MAIN, label: "Подготовка слота " + x.tag, taskId: "slot-up", lane: "prep", steps, extra: { provision: true, pipeline: true, by: "подготовка слота" } });
    })().finally(() => provLocks.delete(x.slot));
    provLocks.set(x.slot, p);
    return p;
}

export function provisionPlan(now = Date.now()) {
    const out = [];
    for (const x of epicSlots()) {
        const t = snapNow() && snapNow().trees.find((z) => z.key === x.slot);
        const d = provisionDue({ archived: !!x.archived, missing: slotMissing(x), merged: !!(t && t.verdict && t.verdict.merged), jobs: jobList().filter((j) => j.task === "slot-up" && j.tree === x.slot), now, drain: drainState() });
        if (d.due)
            out.push({ x, d });
    }
    return out;
}

export async function provisionMissing() {
    if (DRY || !openEpics().length)
        return;
    for (const { x, d } of provisionPlan()) {
        try {
            await enqueueProvision(x);
            console.log("подготовка слота поставлена в очередь:", x.slot, "—", d.why);
            logEvent("slot.provision", { key: x.slot, why: d.why, reuse: !!d.reuse });
        }
        catch (e) {
            console.error("подготовка слота:", e.message);
        }
    }
}

export function setEpicStatus(id, status) {
    const reg = loadEpics(), e = reg.epics.find((x) => x.id === id);
    if (!e)
        return { code: 404, body: { error: "нет такого эпика" } };
    if (isForeignEpic(e))
        return { code: 409, body: { error: "эпик другого репозитория — только запись в истории: диспетчерская ведёт один проект" } };
    if (status === "closed" && viewEpic() && viewEpic().id === id && !reg.epics.some((x) => x.id !== id && x.status !== "closed"))
        return { code: 409, body: { error: "это единственный открытый эпик" } };
    e.status = status;
    if (status === "closed" && reg.active === id)
        reg.active = (reg.epics.find((x) => x.status !== "closed") || e).id;
    if (DRY)
        return { code: 403, body: { error: "сухой режим: реестр не меняю" } };
    saveEpics(reg);
    applyEpics();
    kick();
    return { code: 200, body: { ok: true } };
}

export function closeEpicOp(id, { force = false } = {}) {
    const e = (loadEpics().epics || []).find((x) => x.id === id);
    if (!e)
        return Promise.resolve({ code: 404, body: { error: "нет такого эпика" } });
    if (e.status === "closed")
        return Promise.resolve({ code: 409, body: { error: "эпик уже закрыт" } });
    if (DRY)
        return Promise.resolve({ code: 403, body: { error: "сухой режим: реестр не меняю" } });
    return new Promise((resolve) => {
        let out = "";
        const c = spawnP(process.execPath, [EPIC_CLI, "close", id, ...(force ? ["--force"] : [])], { windowsHide: true, env: { ...process.env, DASH_DATA: DATA } });
        c.stdout.on("data", (d) => {
            out += d;
        });
        c.stderr.on("data", (d) => {
            out += d;
        });
        c.on("error", (er) => resolve({ code: 500, body: { error: er.message } }));
        c.on("close", (code) => {
            logEvent("epic.close", { epic: id, code, force });
            if (code === 0) {
                applyEpics();
                kick();
                return resolve({ code: 200, body: { ok: true, out: out.trim(), message: "эпик " + id + " закрыт" } });
            }
            const problems = out.split("\n").filter((l) => /^\s+- /.test(l)).map((l) => l.replace(/^\s+- /, "").trim());
            resolve({ code: 409, body: { error: problems.length ? "эпик нельзя закрыть: " + problems.join("; ") : "epic.mjs close: код " + code + " — " + out.trim().slice(-400), problems, out: out.trim() } });
        });
    });
}

export async function orchFollow(why) {
    if (DRY)
        return;
    for (const e of openEpics())
        await orchFollowOne(orchKey(e.id), why).catch((er) => console.error("папка оркестратора", e.id, er.message));
}

export async function orchFollowOne(okey, why) {
    const cwd = agentCwd(okey);
    if (!cwd)
        return;
    const st = await git(cwd, ["rev-list", "--left-right", "--count", "staging...HEAD"]);
    const [behind, ahead] = String(st.out || "0 0").trim().split(/\s+/).map(Number);
    if (!behind)
        return;
    const r = await git(cwd, ["merge", "--ff-only", "staging"], 120000);
    const a = agents.get(okey);
    if (!r.ok) {
        if (a)
            push(a, { id: "of-" + a.rev, t: "status", text: "Папка эпика не подтянута до staging (" + why + "): " + ((r.err || r.out || "").split("\n").filter(Boolean).slice(-2).join(" ") || "перемотка невозможна") + (ahead ? "; в ветке эпика " + ahead + " своих коммитов" : ""), bad: true });
        return;
    }
    if (a)
        push(a, { id: "of-" + a.rev, t: "status", text: "Папка эпика подтянута до staging (" + why + "): +" + behind + " коммит(ов). Твои незакоммиченные планы на месте." });
    kick();
}

const syncLogged = new Map();
export const SYNC_MARKS_FILE = path.join(DATA, "sync-marks.json");

export function loadSyncMarks() {
    const v = readJson(SYNC_MARKS_FILE, {});
    S.syncMarks = v && typeof v === "object" ? v : {};
}

export const syncMarkOf = (key) => (S.syncMarks || {})[key] || null;

function markSynced(key, r) {
    if (!r || !r.ok || /^уже/.test(r.text || ""))
        return;
    S.syncMarks = { ...(S.syncMarks || {}), [key]: { at: Date.now(), how: /влит/.test(r.text || "") ? "merge" : "ff" } };
    if (!DRY)
        saveJson(SYNC_MARKS_FILE, S.syncMarks, 1);
}

export async function syncSlot(t, opts) {
    const r = await syncSlotNow(t, opts);
    markSynced(t.key, r);
    const result = r.ok ? "ok" : r.skip ? "skip" : r.conflict ? "conflict" : "fail", detail = String(r.text || r.skip || r.fail || (r.conflict ? r.conflict.length + " файл(ов)" : "")).slice(0, 200), sig = result + "|" + detail;
    if (opts.why !== "авто" || syncLogged.get(t.key) !== sig) {
        syncLogged.set(t.key, sig);
        logEvent("slot.sync", { key: t.key, result, why: opts.why || "", detail });
    }
    return r;
}

export async function syncSlotNow(t, opts) {
    markSyncing(t.key);
    try {
        return await syncSlotRaw(t, opts);
    }
    finally {
        unmarkSyncing(t.key);
    }
}

async function syncSlotRaw(t, { ffOnly, why }) {
    const a = agents.get(t.key);
    if (a && !a.dead && (a.busy || a.pending.size))
        return { skip: "агент слота сейчас работает — подтяну, когда закончит" };
    if (jobList().some((j) => j.tree === t.key && !FINAL.includes(j.status)))
        return { skip: "у слота идут прогоны" };
    const [ah, bh] = await Promise.all([git(t.path, ["rev-list", "--count", "staging..HEAD"]), git(t.path, ["rev-list", "--count", "HEAD..staging"])]);
    const ahead = Number(ah.out || 0), behind = Number(bh.out || 0);
    if (!behind)
        return { ok: true, text: "уже на staging" };
    if (!ahead) {
        const ff = await git(t.path, ["merge", "--ff-only", "-q", "staging"], 120000);
        return ff.ok ? { ok: true, text: "перемотано на staging (+" + behind + ")" } : { fail: "перемотка не прошла: " + (ff.err || ff.out).split("\n").slice(-2).join(" ") };
    }
    if (ffOnly)
        return { skip: "у ветки свои коммиты — только кнопкой владельца" };
    const m = await git(t.path, ["merge", "--no-edit", "-q", "staging"], 180000);
    if (m.ok)
        return { ok: true, text: "staging влит в ветку волны (+" + behind + ")" };
    const conf = (await git(t.path, ["diff", "--name-only", "--diff-filter=U"])).out.split("\n").filter(Boolean);
    await git(t.path, ["merge", "--abort"]);
    const dirty = conf.length ? [] : dirtyBlockers(m.err || m.out);
    if (dirty.length)
        return { fail: "в слоте незакоммиченные правки в файлах, которые правит и staging: " + dirty.slice(0, 4).join(", ") + (dirty.length > 4 ? " …" : "") + " — влив не начат", dirty };
    return conf.length ? { conflict: conf } : { fail: "влив staging не прошёл, конфликтных файлов нет: " + String(m.err || m.out || "").split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 200) + " — влив откатан" };
}

export { parseSync };
const syncAsks = new Map();
export const syncAskOf = (key) => syncAsks.get(key) || null;

export function syncReport(t, r) {
    if (r && r.ok)
        syncAsks.delete(t.key);
    if (r && ((r.dirty && r.dirty.length) || (r.conflict && r.conflict.length)))
        syncAsks.set(t.key, { at: Date.now(), files: (r.conflict || r.dirty).slice(0, 8), kind: r.conflict ? "conflict" : "dirty" });
    if (r.dirty && r.dirty.length)
        return sendWhenFree(t.key, syncDirtyText(t.branch, r.dirty));
    if (!r.conflict || !r.conflict.length)
        return;
    sendWhenFree(t.key, syncConflictText(t.branch, r.conflict));
}

const syncDone = new Map();
let syncRun = null;

export function autoSyncSlots() {
    if (DRY || syncRun || !snapNow() || !viewEpic() || S.drainMode)
        return syncRun || Promise.resolve();
    const staging = (snapNow().pl && snapNow().pl.staging) || "";
    const busy = new Set(snapNow().trees.filter((t) => {
        const a = agents.get(t.key);
        return (a && !a.dead && (a.busy || a.pending.size)) || jobList().some((j) => j.tree === t.key && !FINAL.includes(j.status));
    }).map((t) => t.key));
    const list = syncTargets({ trees: snapNow().trees, epic: viewEpic().id, staging, done: syncDone, busy });
    if (!list.length)
        return Promise.resolve();
    S.autoSyncAt = Date.now();
    syncRun = (async () => {
        for (const t0 of list) {
            const t = treeByKey(t0.key);
            if (!t || !viewEpic() || t.epic !== viewEpic().id || S.drainMode)
                continue;
            const r = await syncSlot(t, { ffOnly: true, why: "авто" }).catch((e) => ({ fail: e.message }));
            const memo = syncMemo(r);
            if (memo)
                syncDone.set(t.key, { sha: staging, result: memo, at: Date.now() });
            if (r.ok && r.text !== "уже на staging")
                console.log("слот перемотан на staging:", t.tag, r.text);
            if (r.ok)
                await rebuildOne(t.key).catch(() => { });
            await sleep(1000);
        }
    })().catch((e) => console.error("автоперемотка слотов:", e.message)).finally(() => {
        syncRun = null;
    });
    return syncRun;
}
