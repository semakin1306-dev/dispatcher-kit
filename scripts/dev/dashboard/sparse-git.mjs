// sparse-git.mjs — временные индексы (снимок слота, зеркало) в папке с частичной выкладкой: у файлов вне выкладки
// ставится бит skip-worktree, иначе git счёл бы их удалёнными, а снимок — правкой. Папки без выкладки идут прежним
// путём.
import fs from "node:fs";
import path from "node:path";
import { outsideCone, sparseConfig } from "./sparse-rules.mjs";

export function gitDirOf(cwd) {
    try {
        const dg = path.join(cwd, ".git"), st = fs.statSync(dg);
        if (st.isDirectory())
            return dg;
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dg, "utf8"));
        return m ? path.resolve(cwd, m[1]) : null;
    }
    catch {
        return null;
    }
}

export function sparseState(cwd) {
    const gd = gitDirOf(cwd);
    if (!gd)
        return null;
    let t = "";
    try {
        t = fs.readFileSync(path.join(gd, "config.worktree"), "utf8");
    }
    catch {
        return null;
    }
    const c = sparseConfig(t);
    return c.on ? { gitDir: gd, cone: c.cone } : null;
}

export async function coneList(cwd, run) {
    const r = await run(["sparse-checkout", "list"]);
    if (r.code)
        throw new Error("sparse-checkout list: " + String(r.err || r.out).trim().slice(0, 200));
    return String(r.out).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

export async function markOutside(cwd, idx, run, cone = null) {
    const c = cone || (await coneList(cwd, run)), env = { GIT_INDEX_FILE: idx };
    const ls = await run(["ls-files", "-z"], { env });
    if (ls.code)
        throw new Error("ls-files: " + String(ls.err).slice(0, 200));
    const out = outsideCone(String(ls.out).split("\0"), c);
    if (!out.length)
        return 0;
    const u = await run(["update-index", "-z", "--skip-worktree", "--stdin"], { env, input: out.join("\0") + "\0" });
    if (u.code)
        throw new Error("update-index --skip-worktree: " + String(u.err).slice(0, 200));
    return out.length;
}

export async function readTreeInto(cwd, idx, rev, run) {
    const r = await run(["read-tree", rev], { env: { GIT_INDEX_FILE: idx } });
    if (r.code)
        return r;
    const sp = sparseState(cwd);
    if (!sp)
        return r;
    if (!sp.cone)
        return { code: 1, out: "", err: "папка в sparse-checkout не в режиме cone — не поддерживается" };
    await markOutside(cwd, idx, run);
    return r;
}

export const addAllArgs = (cwd) => (sparseState(cwd) ? ["add", "--sparse", "-A"] : ["add", "-A"]);

export async function snapIndexInit(cwd, idx, run) {
    const sp = sparseState(cwd);
    if (!sp)
        return run(["read-tree", "HEAD"], { env: { GIT_INDEX_FILE: idx } });
    try {
        fs.copyFileSync(path.join(sp.gitDir, "index"), idx);
    }
    catch (e) {
        return { code: 1, out: "", err: "копия индекса папки с выкладкой: " + e.message };
    }
    return { code: 0, out: "", err: "" };
}
