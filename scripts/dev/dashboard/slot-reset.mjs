// slot-reset.mjs — сброс ветки слота на staging или коммит — одна дверь для кнопки, команды оркестратора и epic.mjs
// reset-slot: факты о папке слота и состоянии диспетчерской → правило сброса → исполнение с
// тегами-страховками → новый снимок слота.
import { MAIN } from "../slots.mjs";
import { localSlotReset } from "./shard.mjs";
import { jobList } from "./jobs.mjs";
import { agents, epicOfSlot, slotOf, slotPreparing } from "./agents.mjs";
import { DRY, FINAL, logEvent } from "./config.mjs";
import { exists, git } from "./git.mjs";
import { isSyncing, kick, markSyncing, rebuildOne, unmarkSyncing } from "./snapshot.mjs";
import { treeByKey } from "./trees.mjs";
import { RESET_TO_RE, resetSlotPlan } from "./loops.mjs";

const ok = async (cwd, args) => (await git(cwd, args)).ok;

export async function slotResetFacts(key, to = "staging") {
    const t = treeByKey(key), x = slotOf(key), e = epicOfSlot(key);
    if (!t || t.kind !== "slot" || !x || !e)
        throw new Error("нет такого слота в открытых эпиках: " + key);
    const branch = x.branch, pcExists = !!t.path && exists(t.path), toArg = String(to || "staging").trim();
    const target = RESET_TO_RE.test(toArg) ? (await git(MAIN, ["rev-parse", "--verify", "-q", toArg + "^{commit}"])).out : "";
    const pc = { exists: pcExists, head: "", onBranch: "", dirty: [] };
    if (pcExists) {
        const [h, b, s] = await Promise.all([git(t.path, ["rev-parse", "HEAD"]), git(t.path, ["symbolic-ref", "-q", "--short", "HEAD"]), git(t.path, ["status", "--porcelain=v1"], 120000, true)]);
        Object.assign(pc, { head: h.out, onBranch: b.ok ? b.out : "", dirty: String(s.out || "").split("\n").filter((l) => l.length > 3).map((l) => l.slice(3)) });
    }
    const rel = {};
    if (target) {
        rel.targetInStaging = await ok(MAIN, ["merge-base", "--is-ancestor", target, "staging"]);
        rel.targetInBranch = !!pc.head && await ok(MAIN, ["merge-base", "--is-ancestor", target, pc.head]);
    }
    const lost = target && pc.head ? (await git(MAIN, ["log", "--format=%h %s", "-20", target + ".." + pc.head])).out.split("\n").filter(Boolean).map((l) => l.slice(0, 90)) : [];
    const tagsTaken = (await git(MAIN, ["tag", "--list", "backup/" + e.id + "/" + key + "/*"])).out.split("\n").filter(Boolean);
    const a = agents.get(key);
    const f = { epic: e.id, tag: x.tag, slot: key, branch, to: toArg, target, at: Date.now(), pc, rel, lost,
        agent: { alive: !!(a && !a.dead), busy: !!(a && !a.dead && (a.busy || (a.pending && a.pending.size))) },
        jobs: jobList().filter((j) => j.tree === key && !FINAL.includes(j.status)).map((j) => j.id), preparing: slotPreparing(key), syncing: isSyncing(key), tagsTaken };
    return { f, t, x };
}

export async function slotReset({ key, to = "staging", dry = false, by = "" }) {
    if (DRY && !dry)
        return { code: 409, body: { error: "сухой экземпляр: сброс не делаю (только --dry-run)" } };
    let facts;
    try {
        facts = await slotResetFacts(key, to);
    }
    catch (e) {
        return { code: 404, body: { error: e.message } };
    }
    const { f, t } = facts, plan = resetSlotPlan(f);
    if (plan.refuse.length) {
        if (!dry)
            logEvent("slot.reset", { key, ok: false, by, to: f.to, why: plan.refuse.join("; ").slice(0, 300) });
        return { code: 409, body: { error: plan.text, refuse: plan.refuse } };
    }
    if (dry || plan.noop)
        return { code: 200, body: { ok: true, dry, noop: plan.noop, message: plan.text + (dry && !plan.noop ? "\n(сухой прогон: ничего не тронуто)" : ""), tags: plan.tags.map((x) => x.name) } };
    let log = "";
    markSyncing(key);
    try {
        await localSlotReset({ branch: f.branch, pcPath: t.path, target: f.target, expect: { pcHead: f.pc.head }, tags: plan.tags }, (s) => {
            log += s;
        });
    }
    catch (e) {
        logEvent("slot.reset", { key, ok: false, by, to: f.to, from: f.pc.head, why: String(e.message).slice(0, 300) });
        return { code: 500, body: { error: f.tag + ": " + e.message + (log ? "\n" + log.trim() : "") } };
    }
    finally {
        unmarkSyncing(key);
    }
    logEvent("slot.reset", { key, ok: true, by, to: f.to, target: f.target, from: f.pc.head, tags: plan.tags.map((x) => x.name) });
    await rebuildOne(key).catch(() => { });
    kick();
    return { code: 200, body: { ok: true, message: plan.text + "\n✓ сброшено" + (log ? "\n" + log.trim() : ""), tags: plan.tags.map((x) => x.name) } };
}
