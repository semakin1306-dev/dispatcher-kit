import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-dirty-"));
process.env.DASH_DATA = path.join(TMP, "data");
process.env.DASH_DRY = "1";
fs.mkdirSync(process.env.DASH_DATA);
const { treeState, dirtyCache } = await import("./git.mjs");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const repo = path.join(TMP, "repo");
fs.mkdirSync(repo);
const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
g("init", "-q", "-b", "staging");
g("config", "core.autocrlf", "false");
g("config", "user.email", "t@t");
g("config", "user.name", "t");
fs.writeFileSync(path.join(repo, ".nvmrc"), "20\n");
fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
g("add", ".");
g("commit", "-qm", "init");
const state = () => treeState({ key: "t", path: repo });

const bump = (f) => {
    const p = path.join(repo, f), t = new Date(Date.now() + 5000);
    fs.utimesSync(p, t, t);
};

test("файл с CRLF при LF в коммите — не правка: dirtyTracked 0, eolOnly 1", async () => {
    fs.writeFileSync(path.join(repo, ".nvmrc"), "20\r\n");
    assert.match(g("status", "--porcelain"), /M \.nvmrc/, "git status считает его изменённым — потому и нужна сверка");
    const s = await state();
    assert.equal(s.dirtyTracked, 0);
    assert.equal(s.eolOnly, 1);
});

test("настоящая правка того же файла видна сразу, хотя строка status та же (кеш по размеру и времени правки)", async () => {
    fs.writeFileSync(path.join(repo, ".nvmrc"), "22\r\n");
    bump(".nvmrc");
    const s = await state();
    assert.equal(s.dirtyTracked, 1);
    assert.equal(s.eolOnly, 0);
});

test("смесь: одна настоящая правка и один CRLF — 1 и 1; удалённый файл — правка", async () => {
    fs.writeFileSync(path.join(repo, ".nvmrc"), "20\r\n");
    bump(".nvmrc");
    fs.writeFileSync(path.join(repo, "a.txt"), "b\n");
    let s = await state();
    assert.deepEqual([s.dirtyTracked, s.eolOnly], [1, 1]);
    fs.rmSync(path.join(repo, "a.txt"));
    s = await state();
    assert.deepEqual([s.dirtyTracked, s.eolOnly], [1, 1], "удалённый a.txt — правка, .nvmrc — только конец строки");
});

test("чистая папка — без вызова diff и без записей в кеше", async () => {
    g("checkout", "--", ".");
    dirtyCache.clear();
    const s = await state();
    assert.deepEqual([s.dirtyTracked, s.eolOnly], [0, 0]);
    assert.equal(dirtyCache.size, 0);
});
