import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { untrackedList, untrackedShim, untrackedUnder } from "./git.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-untr-")), g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
g("init", "-q");
g("config", "user.email", "t@t");
g("config", "user.name", "t");
fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
fs.writeFileSync(path.join(dir, "a.txt"), "a");
fs.writeFileSync(path.join(dir, "old.txt"), "o");
g("add", ".");
g("commit", "-qm", "init");
fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
fs.writeFileSync(path.join(dir, "node_modules", "x", "i.js"), "1");
fs.mkdirSync(path.join(dir, "docs", "research"), { recursive: true });
fs.writeFileSync(path.join(dir, "docs", "research", "отчёт 1.md"), "x");
fs.writeFileSync(path.join(dir, "new file.txt"), "n");
g("mv", "old.txt", "moved.txt");
fs.writeFileSync(path.join(dir, "a.txt"), "changed");

test("то же множество, что у ls-files --others --exclude-standard: игнорируемое не в счёте, имена с пробелами и кириллицей — как есть, переименование не мешает", async () => {
    const want = g("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean).sort();
    const r = await untrackedList(dir);
    assert.equal(r.ok, true);
    assert.deepEqual([...r.files].sort(), want);
    assert.ok(r.files.includes("docs/research/отчёт 1.md") && r.files.includes("new file.txt"));
    assert.ok(!r.files.some((f) => f.startsWith("node_modules")));
});

test("untrackedShim — построчно; untrackedUnder — только под префиксами", async () => {
    assert.equal((await untrackedShim(dir)).out.split("\n").sort().join("|"), ["docs/research/отчёт 1.md", "new file.txt"].sort().join("|"));
    assert.equal((await untrackedUnder(dir, ["docs/research"])).out, "docs/research/отчёт 1.md");
    assert.equal((await untrackedUnder(dir, ["docs"])).out, "docs/research/отчёт 1.md");
    assert.equal((await untrackedUnder(dir, ["doc"])).out, "");
});
