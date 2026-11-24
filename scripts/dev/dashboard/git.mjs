// git.mjs — обёртка git с ограничением параллельности и приоритетной полосой для страницы, состояние рабочей копии слота
// (ветка, грязь, отставание от staging, риск устаревания) и состояние конвейера staging → main.
import { MAIN, fwd, UP_STAGING, UP_MAIN } from "../slots.mjs";
import { execFile, killTree } from "./spawner.mjs";
import { human, procBy } from "./deadline.mjs";
import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { S } from "./state.mjs";
import { MAIN_WT } from "./config.mjs";

const untrFlight = new Map();

export function untrackedList(cwd) {
    const old = untrFlight.get(cwd);
    if (old && Date.now() - old.at < 400)
        return old.p;
    const p = git(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"], 60000, true).then((r) => {
        const parts = String(r.out || "").split("\0"), files = [];
        for (let i = 0; i < parts.length; i++) {
            const e = parts[i];
            if (!e)
                continue;
            const xy = e.slice(0, 2);
            if (/[RC]/.test(xy))
                i++;
            if (xy === "??")
                files.push(e.slice(3));
        }
        return { ok: r.ok, files };
    }).finally(() => {
        const cur = untrFlight.get(cwd);
        if (cur && cur.p === p)
            untrFlight.delete(cwd);
    });
    untrFlight.set(cwd, { at: Date.now(), p });
    return p;
}

export async function untrackedShim(cwd) {
    return { out: (await untrackedList(cwd)).files.join("\n") };
}

export async function untrackedUnder(cwd, prefixes) {
    const r = await untrackedList(cwd);
    return { ok: r.ok, out: r.files.filter((f) => prefixes.some((p) => f === p || f.startsWith(p + "/"))).join("\n") };
}

export const GIT_MAX = Number(process.env.DASH_GIT_PARALLEL) || 4;
export const gitWait = [];
export const stagingTreeSha = () => S.STG_TREE;
export const gitLoad = () => ({ active: S.gitActive, wait: gitWait.length });
export const GIT_PRIO_EXTRA = 2;
const prioCtx = new AsyncLocalStorage();
export const withGitPriority = (fn) => prioCtx.run({ prio: true }, fn);

export const gitSlot = () => new Promise((res) => {
    const prio = !!(prioCtx.getStore() || {}).prio;
    const go = () => {
        S.gitActive++;
        res(() => {
            S.gitActive--;
            const n = gitWait[0];
            if (n && S.gitActive < GIT_MAX + (n.prio ? GIT_PRIO_EXTRA : 0)) {
                gitWait.shift();
                n();
            }
        });
    };
    if (S.gitActive < GIT_MAX + (prio ? GIT_PRIO_EXTRA : 0))
        go();
    else if (prio) {
        go.prio = true;
        gitWait.unshift(go);
    }
    else
        gitWait.push(go);
});

let gitExec = execFile;

export const _gitExec = () => gitExec, _setGitExec = (f) => {
    gitExec = f;
};

export async function git(cwd, args, timeout = 20000, raw = false) {
    const release = await gitSlot();
    try {
        const t0 = Date.now(), what = "git " + args.slice(0, 2).join(" ");
        const r = await procBy((done) => gitExec("git", args, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (err, stdout, stderr) => done({ ok: !err, out: raw ? String(stdout || "") : String(stdout || "").trim(), err: String(stderr || "").trim() })), timeout, what + " в " + cwd, (cap) => ({ ok: false, out: "", err: what + ": процесс не вернул ответ за " + human(cap) + " — снят", hung: true }), killTree);
        if (process.env.DASH_TIMING && Date.now() - t0 > 1500)
            console.log("[время] git " + (Date.now() - t0) + " мс: " + args.slice(0, 4).join(" ") + " в " + cwd);
        return r;
    }
    finally {
        release();
    }
}

export const exists = (p) => fs.existsSync(path.join(p, ".git"));

export const waveOf = (branch) => {
    const m = /wv-?0*(\d{1,4})/i.exec(branch || "");
    return m ? `wv-${m[1].padStart(4, "0")}` : "";
};

export const pairs = (s) => {
    const [a, b] = (s || "0\t0").split(/\s+/).map(Number);
    return [a || 0, b || 0];
};

export const dirtyCache = new Map();
const statusPath = (l) => l.slice(3).replace(/^"|"$/g, "").split(" -> ").pop();

export async function trackedDirty(cwd, lines, head = "") {
    const tracked = lines.filter((l) => l && !l.startsWith("??"));
    if (!tracked.length)
        return { real: 0, eolOnly: 0 };
    let sig = cwd + "|" + head + "|" + tracked.join("\n");
    for (const l of tracked) {
        try {
            const s = fs.statSync(path.join(cwd, statusPath(l)));
            sig += "|" + s.size + ":" + s.mtimeMs;
        }
        catch {
            sig = "";
            break;
        }
    }
    const hit = sig && dirtyCache.get(sig);
    if (hit)
        return hit;
    const d = await git(cwd, ["diff", "--ignore-cr-at-eol", "--name-only", "HEAD"], 60000);
    if (!d.ok)
        return { real: tracked.length, eolOnly: 0 };
    const real = Math.min(tracked.length, d.out.split("\n").filter(Boolean).length), r = { real, eolOnly: tracked.length - real };
    if (sig) {
        dirtyCache.set(sig, r);
        if (dirtyCache.size > 300)
            dirtyCache.delete(dirtyCache.keys().next().value);
    }
    return r;
}

export async function treeState(t) {
    if (!exists(t.path))
        return { ...t, exists: false };
    const [br, st, lr, last, tree] = await Promise.all([
        git(t.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
        git(t.path, ["status", "--porcelain", "--untracked-files=all"], 60000),
        git(t.path, ["rev-list", "--left-right", "--count", "staging...HEAD"]),
        git(t.path, ["log", "-1", "--format=%h%x09%s%x09%cr%x09%ct"]),
        git(t.path, ["rev-parse", "HEAD^{tree}"]),
    ]);
    const lines = st.out ? st.out.split("\n") : [];
    const { real: realDirty, eolOnly } = await trackedDirty(t.path, lines, tree.out);
    const [behind, ahead] = pairs(lr.out);
    const [h, subj, when, ct] = (last.out || "").split("\t");
    return {
        ...t, exists: true, branch: br.out, wave: waveOf(br.out),
        dirtyTracked: realDirty, eolOnly, dirtyUntracked: lines.filter((l) => l.startsWith("??")).length,
        ahead, behind, last: { sha: h, subject: subj, when, ct: Number(ct) * 1000 || 0 }, tree: tree.out,
        commits: ahead ? (await git(t.path, ["log", "staging..HEAD", "--format=%h%x09%s", "-8"])).out.split("\n").map((l) => l.split("\t")) : [],
        staleRisk: behind && (ahead || lines.length) ? await staleOverlap(t.path, lines) : [],
    };
}

export const overlapCache = new Map();

export async function staleOverlap(cwd, statusLines) {
    const [hd, sg] = await Promise.all([git(cwd, ["rev-parse", "HEAD"]), git(cwd, ["rev-parse", "staging"])]);
    const dirty = statusLines.map((l) => l.slice(3).replace(/^"|"$/g, "").split(" -> ").pop()), k = cwd + "|" + hd.out + "|" + sg.out;
    let base = overlapCache.get(k);
    if (!base) {
        const mb = (await git(cwd, ["merge-base", "staging", "HEAD"])).out;
        if (!mb)
            return [];
        const [st, mine] = await Promise.all([git(cwd, ["diff", "--name-only", mb, "staging"]), git(cwd, ["diff", "--name-only", mb, "HEAD"])]);
        base = { st: new Set(st.out.split("\n").filter(Boolean)), mine: mine.out.split("\n").filter(Boolean) };
        overlapCache.set(k, base);
        if (overlapCache.size > 300)
            overlapCache.delete(overlapCache.keys().next().value);
    }
    return [...new Set([...base.mine, ...dirty])].filter((f) => base.st.has(f)).slice(0, 40);
}

export const firstCommitCache = new Map();

export async function firstCommitAt(cwd, range, key) {
    if (!range)
        return 0;
    if (firstCommitCache.has(key))
        return firstCommitCache.get(key);
    const r = await git(cwd, ["log", "--no-merges", "--format=%ct", range], 30000);
    const ls = r.ok ? r.out.split("\n").filter(Boolean) : [], at = ls.length ? Number(ls[ls.length - 1]) * 1000 || 0 : 0;
    if (r.ok) {
        firstCommitCache.set(key, at);
        if (firstCommitCache.size > 300)
            firstCommitCache.delete(firstCommitCache.keys().next().value);
    }
    return at;
}

// Состояние конвейера. `staging` и `main` — локальные ветки-роли; за ними стоят ветки проекта UP_STAGING и UP_MAIN
// (slots.mjs). У проекта без отдельной прод-ветки роли `main` нет: всё, что про неё, отдаётся пустым, а признак
// noMain говорит странице и выкату, что релизной части конвейера нет.
export async function pipelineState() {
    const o = {};
    const gitMain = UP_MAIN ? git : async () => ({ ok: true, out: "" });
    const [stg, mn, om, os, anc, cnt, cars, lastMain, vsO, stgTree, mainBr, mainSt, mwBr, mwSt, mwExists] = await Promise.all([
        git(MAIN, ["rev-parse", "--short", "staging"]), gitMain(MAIN, ["rev-parse", "--short", "main"]),
        gitMain(MAIN, ["rev-parse", "--short", UP_MAIN]), git(MAIN, ["rev-parse", "--short", UP_STAGING]),
        gitMain(MAIN, ["merge-base", "--is-ancestor", "main", "staging"]),
        gitMain(MAIN, ["rev-list", "--count", "main..staging"]),
        gitMain(MAIN, ["log", "main..staging", "--first-parent", "--format=%h%x09%p%x09%s%x09%cr", "-40"]),
        gitMain(MAIN, ["log", "main", "--first-parent", "--format=%h%x09%s%x09%cr", "-4"]),
        gitMain(MAIN, ["rev-list", "--left-right", "--count", UP_MAIN + "...main"]).then(async (r) => {
            o.stagingVsOrigin = pairs((await git(MAIN, ["rev-list", "--left-right", "--count", UP_STAGING + "...staging"])).out);
            const lst = async (range) => ((await git(MAIN, ["log", range, "--format=%h %s", "-6"])).out || "").split("\n").filter(Boolean);
            if (o.stagingVsOrigin[0])
                o.stgBehind = await lst("staging.." + UP_STAGING);
            if (o.stagingVsOrigin[1])
                o.stgAhead = await lst(UP_STAGING + "..staging");
            return r;
        }),
        git(MAIN, ["rev-parse", "staging^{tree}"]),
        git(MAIN, ["rev-parse", "--abbrev-ref", "HEAD"]), git(MAIN, ["status", "--porcelain"]),
        exists(MAIN_WT) ? git(MAIN_WT, ["rev-parse", "--abbrev-ref", "HEAD"]) : { out: "" },
        exists(MAIN_WT) ? git(MAIN_WT, ["status", "--porcelain"]) : { out: "" },
        Promise.resolve(exists(MAIN_WT)),
    ]);
    const tracked = (s) => (s ? s.split("\n").filter((l) => !l.startsWith("??")).length : 0);
    Object.assign(o, {
        noMain: !UP_MAIN, upStaging: UP_STAGING, upMain: UP_MAIN,
        staging: stg.out, main: mn.out, originMain: om.out, originStaging: os.out, stagingTree: (S.STG_TREE = stgTree.out),
        invariantOk: anc.ok, unreleased: Number(cnt.out) || 0,
        cars: cars.out ? cars.out.split("\n").map((l) => {
            const [sha, parents, subject, when] = l.split("\t");
            return { sha, merge: (parents || "").includes(" "), subject, when };
        }) : [],
        lastMain: lastMain.out ? lastMain.out.split("\n").map((l) => {
            const [sha, subject, when] = l.split("\t");
            return { sha, subject, when };
        }) : [],
        mainVsOrigin: pairs(vsO.out),
        stagingFolder: { path: fwd(MAIN), branch: mainBr.out, dirtyTracked: tracked(mainSt.out) },
        mainFolder: { path: fwd(MAIN_WT), exists: mwExists, branch: mwBr.out, dirtyTracked: tracked(mwSt.out) },
    });
    return o;
}
