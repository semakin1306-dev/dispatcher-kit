// idle.mjs — чистые правила простоя: какие слоты перематывать на staging, кого толкать автопоездом, какие ветки влил
// прогон.
export const SYNC_RETRY_MS = 30 * 60000;

export function syncTargets({ trees, epic, staging, done, busy = new Set(), now = Date.now() }) {
    if (!epic || !staging)
        return [];
    return (trees || []).filter((t) => {
        if (t.kind !== "slot" || !t.exists || t.epic !== epic)
            return false;
        if (!(t.behind > 0) || t.ahead > 0 || t.dirtyTracked > 0 || busy.has(t.key))
            return false;
        const d = done && done.get(t.key);
        return !d || d.sha !== staging || (d.result === "fail" && now - d.at > SYNC_RETRY_MS);
    });
}

export const syncMemo = (r) => (r.skip && /работает|прогоны/.test(r.skip) ? null : r.ok ? "ok" : r.skip ? "skip" : r.conflict ? "conflict" : "fail");

export function untriedSteps(t, need, ran, { presets = 0, commitTried = false } = {}) {
    const was = (id) => ran.has(t.key + "|chain|" + t.fp + "|" + id);
    return need.filter((id) => {
        if (id === "review")
            return !was("review") && !was("review-cap") && !(t.review && t.review.fresh);
        if (id === "tests" && !presets)
            return false;
        if (id === "regress" && !(t.regress || []).length)
            return false;
        if (id === "commit" && commitTried)
            return false;
        return !was(id);
    });
}

export const mergedBranches = (job) => ((job && job.steps) || [])
    .filter((s) => s && s.cmd === "git" && Array.isArray(s.args) && s.args[0] === "merge" && s.args[1] === "--no-ff")
    .map((s) => s.branch || s.args[2]).filter((b) => b && !/^[0-9a-f]{40}$/.test(b) && !["staging", "main", "origin/staging"].includes(b));
