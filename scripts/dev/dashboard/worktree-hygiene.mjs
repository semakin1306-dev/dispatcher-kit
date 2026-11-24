// worktree-hygiene.mjs — уборка лишних папок слотов: всё, что не принадлежит открытому эпику, не служебное и не в списке
// «оставить». Незакоммиченное уходит в git stash, папка — git worktree remove, ветка удаляется, только если целиком
// влита в staging.
import path from "node:path";
import { execFile } from "node:child_process";
import { MAIN, WT } from "../slots.mjs";

// Служебные папки диспетчерской (выкат, снимки, база регресса) — не слоты и не убираются.
export const SPECIAL_RE = /[\\/](_main|_shard|_stg|regress-base)$/i;
// Папки, которые оставить всегда; человек дополняет список настройкой keepWorktrees.
export const KEEP_DEFAULT = [];
const norm = (p) => path.normalize(String(p || "")).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const git = (args, cwd = MAIN, timeout = 120000) => new Promise((res) => execFile("git", args, { cwd, timeout, windowsHide: true, maxBuffer: 16e6 }, (e, so, se) => res({ ok: !e, out: String(so || "").trim(), err: String(se || "").trim() })));

export function parseWorktrees(text) {
    return String(text || "").split(/\r?\n\r?\n/).filter(Boolean).map((b) => ({ p: (/^worktree (.*)$/m.exec(b) || [])[1], br: (/^branch refs\/heads\/(.*)$/m.exec(b) || [])[1] || null })).filter((w) => w.p);
}

export function extraWorktrees(list, epics, { wtRoot = WT, keep = KEEP_DEFAULT, main = MAIN } = {}) {
    const keepSet = new Set([norm(main)]);
    for (const e of epics || []) {
        for (const s of e.slots || [])
            keepSet.add(norm(path.join(wtRoot, s.slot)));
        if (e.orch && e.orch.path)
            keepSet.add(norm(e.orch.path));
    }
    for (const k of keep || [])
        keepSet.add(norm(path.join(wtRoot, k)));
    return list.filter((w) => !keepSet.has(norm(w.p)) && !SPECIAL_RE.test(norm(w.p)));
}

export async function hygienePlan(epics, opts = {}) {
    const r = await git(["worktree", "list", "--porcelain"]);
    if (!r.ok)
        throw new Error("git worktree list: " + r.err);
    const all = parseWorktrees(r.out), extra = extraWorktrees(all, epics, opts);
    for (const w of extra) {
        w.ahead = w.br ? Number((await git(["rev-list", "--count", "staging.." + w.br])).out || 0) : 0;
    }
    return { total: all.length, extra, at: Date.now() };
}

export const hygieneNow = { total: 0, extra: 0, at: 0, running: false };

export async function hygieneRefresh(epics, opts) {
    const p = await hygienePlan(epics, opts);
    Object.assign(hygieneNow, { total: p.total, extra: p.extra.length, at: p.at });
    return p;
}

export async function hygieneRun(plan) {
    const out = { removed: 0, branches: 0, stashed: 0, failed: 0, log: [] };
    for (const w of plan.extra) {
        const name = w.p.split(/[\\/]/).pop();
        const st = await git(["status", "--porcelain"], w.p, 120000);
        if (st.ok && st.out) {
            const s = await git(["stash", "push", "-u", "-q", "-m", "уборка папок " + new Date().toISOString().slice(0, 10) + ": " + name + (w.br ? " (" + w.br + ")" : "")], w.p, 300000);
            if (s.ok)
                out.stashed++;
            else {
                out.failed++;
                out.log.push("✗ " + name + ": незакоммиченное не сохранилось — папка оставлена");
                continue;
            }
        }
        const rm = await git(["worktree", "remove", "--force", w.p], MAIN, 600000);
        if (!rm.ok) {
            out.failed++;
            out.log.push("✗ " + name + ": " + rm.err.slice(0, 160));
            continue;
        }
        out.removed++;
        if (w.br && !w.ahead) {
            const b = await git(["branch", "-D", w.br]);
            if (b.ok)
                out.branches++;
        }
        else if (w.br)
            out.log.push("ветка оставлена (невлитых коммитов " + w.ahead + "): " + w.br);
    }
    await git(["worktree", "prune"]);
    return out;
}
