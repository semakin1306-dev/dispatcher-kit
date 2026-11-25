import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

for (const k of Object.keys(process.env))
    if (/^GIT_/.test(k))
        delete process.env[k];

const { addAllArgs, readTreeInto, snapIndexInit, sparseState } = await import("./sparse-git.mjs");
const HERE = path.dirname(fileURLToPath(import.meta.url)), SLOTUP = path.join(HERE, "..", "slot-up.mjs");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dash-sparse-"))), REPO = path.join(TMP, "demo"), WTD = path.join(TMP, "wt");
const git = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8" });

const run = (cwd) => async (args, o = {}) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...(o.env || {}) }, input: o.input, maxBuffer: 64e6 });
    return { code: r.status, out: r.stdout, err: r.stderr };
};

const put = (root, f, t) => {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), t);
};

const tmpIdx = () => path.join(TMP, "idx-" + crypto.randomBytes(4).toString("hex"));

async function snapTree(cwd) {
    const idx = tmpIdx(), env = { ...process.env, GIT_INDEX_FILE: idx }, g = async (a) => {
        const r = spawnSync("git", a, { cwd, encoding: "utf8", env });
        return { code: r.status, out: r.stdout.trim(), err: r.stderr };
    };
    const i = await snapIndexInit(cwd, idx, g);
    assert.equal(i.code, 0, i.err);
    const a = await g(addAllArgs(cwd));
    assert.equal(a.code, 0, "add: " + a.err);
    const t = await g(["write-tree"]);
    fs.rmSync(idx, { force: true });
    return t.out;
}

put(REPO, "package.json", "{}\n");
// Демо-проект: область api — apps/api/** и packages/**, область web — apps/web/**.
put(REPO, "apps/api/src/a.ts", "a\n");
put(REPO, "apps/api/b.ts", "b\n");
put(REPO, "apps/web/c.ts", "c\n");
put(REPO, "packages/p/index.ts", "p\n");
put(REPO, "scripts/s.mjs", "s\n");
put(REPO, ".claude/CLAUDE.md", "m\n");
put(REPO, ".claude/plans/w.md", "w\n");
put(REPO, "docs/x.md", "x\n");
git(REPO, "init", "-q", "-b", "staging");
git(REPO, "config", "user.email", "t@t");
git(REPO, "config", "user.name", "t");
git(REPO, "config", "core.autocrlf", "false");
git(REPO, "add", "-A");
git(REPO, "commit", "-q", "-m", "init");
const REG = path.join(TMP, "epics.json");

fs.writeFileSync(REG, JSON.stringify({ active: "e", epics: [{ id: "e", status: "open", orch: { path: TMP, branch: "dev/epic-e" }, slots: [
                { tag: "П1", slot: "wv9300-be", branch: "dev/wv-9300-be", area: "api", build: true },
                { tag: "П2", slot: "wv9301-full", branch: "dev/wv-9301-full", area: "api", build: true },
                { tag: "П3", slot: "wv9302-recon", branch: "dev/wv-9302-recon", readOnly: true }
            ] }] }));

const slotUp = (slot, ...extra) =>
    spawnSync(
        process.execPath,
        [SLOTUP, slot, "--branch", "dev/" + slot.replace(/^wv(\d+)/, "wv-$1"), "--root", WTD, "--no-prepare", ...extra],
        {
            cwd: REPO,
            encoding: "utf8",
            env: { ...process.env, DASH_EPIC_FILE: REG, DISPATCHER_MAIN: REPO, DISPATCHER_WT: WTD, DASH_SPARSE: "0" },
        },
    );
const SP = path.join(WTD, "wv9300-be");

test("slot-up: без включения — полная выкладка, как было", () => {
    const r = slotUp("wv9301-full");
    assert.ok(fs.existsSync(path.join(WTD, "wv9301-full", "apps", "web", "c.ts")), r.stdout + r.stderr);
    assert.equal(sparseState(path.join(WTD, "wv9301-full")), null);
});

test("slot-up --sparse: выложено всё, кроме папок других областей; ветка та, дерево чистое", () => {
    const r = slotUp("wv9300-be", "--sparse"), out = r.stdout + r.stderr;
    assert.match(out, /частичная выкладка \(cone\)/, out);
    for (const f of ["package.json", "apps/api/src/a.ts", "apps/api/b.ts", "packages/p/index.ts", "scripts/s.mjs", ".claude/CLAUDE.md", ".claude/plans/w.md", "docs/x.md"])
        assert.ok(fs.existsSync(path.join(SP, f)), f);
    for (const f of ["apps/web/c.ts"])
        assert.ok(!fs.existsSync(path.join(SP, f)), f);
    assert.equal(git(SP, "branch", "--show-current").stdout.trim(), "dev/wv-9300-be");
    assert.equal(git(SP, "status", "--porcelain").stdout, "", "невыложенные файлы — не «удалённые»");
    assert.deepEqual(sparseState(SP) && sparseState(SP).cone, true);
});

test("slot-up --sparse слоту «только чтение» не выкладывает частично", () => {
    const r = slotUp("wv9302-recon", "--sparse");
    assert.match(r.stdout + r.stderr, /полная выкладка/);
    assert.ok(fs.existsSync(path.join(WTD, "wv9302-recon", "apps", "web", "c.ts")));
});

test("снимок папки с выкладкой: правки, новый и удалённый файл; невыложенное — из HEAD, неотслеживаемое вне выкладки — в снимке", async () => {
    const head = git(SP, "rev-parse", "HEAD^{tree}").stdout.trim();
    assert.equal(await snapTree(SP), head, "без правок снимок = дерево HEAD");
    put(SP, "apps/api/src/a.ts", "a2\n");
    put(SP, "apps/api/new.ts", "n\n");
    fs.rmSync(path.join(SP, "apps/api/b.ts"));
    put(SP, "apps/web/out.ts", "o\n");
    const t = await snapTree(SP), d = git(SP, "diff", "--name-status", head, t).stdout.trim().split("\n").sort();
    assert.deepEqual(d, ["A\tapps/api/new.ts", "A\tapps/web/out.ts", "D\tapps/api/b.ts", "M\tapps/api/src/a.ts"]);
    assert.equal(git(SP, "rev-parse", t + ":apps/web/c.ts").status, 0, "невыложенный файл в снимке есть");
    const idx = tmpIdx(), env = { ...process.env, GIT_INDEX_FILE: idx };
    spawnSync("git", ["read-tree", "HEAD"], { cwd: SP, env });
    assert.notEqual(spawnSync("git", ["add", "-A"], { cwd: SP, env }).status, 0);
    fs.rmSync(idx, { force: true });
    git(SP, "checkout", "-q", "--", ".");
    git(SP, "clean", "-fdq");
});

test("индекс зеркала из дерева: в папке с выкладкой невыложенное не «удалено» (diff-files пуст), в полной — как было", async () => {
    for (const [dir, sparse] of [[SP, true], [path.join(WTD, "wv9301-full"), false]]) {
        const mi = tmpIdx(), env = { ...process.env, GIT_INDEX_FILE: mi };
        const r = await readTreeInto(dir, mi, "HEAD", run(dir));
        assert.equal(r.code, 0, r.err);
        spawnSync("git", ["update-index", "-q", "--refresh"], { cwd: dir, env });
        assert.equal(spawnSync("git", ["diff-files", "--name-only"], { cwd: dir, env, encoding: "utf8" }).stdout, "", dir);
        const skip = spawnSync("git", ["ls-files", "-t"], { cwd: dir, env, encoding: "utf8" }).stdout.split("\n").filter((l) => l.startsWith("S ")).length;
        assert.equal(skip > 0, sparse, "биты skip-worktree только в папке с выкладкой");
        assert.deepEqual(addAllArgs(dir), sparse ? ["add", "--sparse", "-A"] : ["add", "-A"]);
        fs.rmSync(mi, { force: true });
    }
});

test("полная папка: снимок прежним путём (read-tree HEAD + add -A)", async () => {
    const d = path.join(WTD, "wv9301-full");
    put(d, "apps/web/c.ts", "c2\n");
    const t = await snapTree(d);
    assert.equal(git(d, "diff", "--name-only", "HEAD", t).stdout.trim(), "apps/web/c.ts");
    git(d, "checkout", "-q", "--", ".");
});

test.after(() => {
    for (const s of ["wv9300-be", "wv9301-full", "wv9302-recon"])
        git(REPO, "worktree", "remove", "--force", path.join(WTD, s));
    try {
        fs.rmSync(TMP, { recursive: true, force: true });
    }
    catch { }
});
