// Подготовка папки слота на временном git-репозитории: worktree от staging, шаги `slotPrepare` конфига (шаг «build» — только
// у области со сборкой), функция slotPrepare из dispatcher.project.mjs, провал шага и правки дерева после подготовки.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), SLOT_UP = path.join(HERE, "slot-up.mjs");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dk-slotup-")));
const MAIN = path.join(TMP, "main"), WT = path.join(TMP, "wt"), CFG = path.join(TMP, "dispatcher.project.json"), REG = path.join(TMP, "epics.json");
const git = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8" });

for (const k of Object.keys(process.env))
    if (/^GIT_/.test(k))
        delete process.env[k];
fs.mkdirSync(path.join(MAIN, "apps", "api"), { recursive: true });
fs.writeFileSync(path.join(MAIN, "apps", "api", "a.js"), "a\n");
fs.writeFileSync(path.join(MAIN, ".gitignore"), ".prep-*\n");
git(MAIN, "init", "-q", "-b", "staging");
git(MAIN, "config", "user.email", "t@example.com");
git(MAIN, "config", "user.name", "t");
git(MAIN, "add", "-A");
git(MAIN, "commit", "-q", "-m", "init");

// Шаги пишут файлы-метки, которые .gitignore проекта прячет: дерево после подготовки остаётся чистым.
const mark = (name) => `node -e "require('fs').writeFileSync('.prep-${name}','1')"`;
const demo = JSON.parse(fs.readFileSync(path.join(HERE, "..", "..", "test", "fixtures", "project.demo.json"), "utf8"));
const writeCfg = (slotPrepare, worktrees = WT) => fs.writeFileSync(CFG, JSON.stringify({ ...demo, repo: { ...demo.repo, main: MAIN, worktrees, data: path.join(TMP, "data") }, slotPrepare }, null, 2));
writeCfg([{ run: mark("always") }, { run: mark("build"), when: "build" }]);
fs.writeFileSync(REG, JSON.stringify({ active: "e", epics: [{ id: "e", title: "э", status: "open", orch: { branch: "dev/epic-e", path: path.join(TMP, "orch") }, slots: [
    { tag: "П1", slot: "wv0001-api", branch: "dev/wv-0001-api", area: "api", build: true },
    { tag: "П2", slot: "wv0002-web", branch: "dev/wv-0002-web", area: "web" },
    { tag: "П3", slot: "wv0003-look", branch: "dev/wv-0003-look", readOnly: true },
] }] }));
const env = { ...process.env, DISPATCHER_PROJECT: CFG, DASH_EPIC_FILE: REG };
for (const k of ["DISPATCHER_MAIN", "DISPATCHER_WT", "DASH_SPARSE"])
    delete env[k];
const up = (slot, ...a) => spawnSync(process.execPath, [SLOT_UP, slot, "--branch", "dev/" + slot.replace(/^wv(\d+)/, "wv-$1"), ...a], { cwd: TMP, encoding: "utf8", env });
const has = (slot, f) => fs.existsSync(path.join(WT, slot, f));

after(() => {
    try {
        fs.rmSync(TMP, { recursive: true, force: true });
    }
    catch { }
});

test("область со сборкой: worktree от staging на ветке волны, оба шага подготовки, дерево чистое", () => {
    const r = up("wv0001-api");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(git(path.join(WT, "wv0001-api"), "branch", "--show-current").stdout.trim(), "dev/wv-0001-api");
    assert.ok(has("wv0001-api", ".prep-always") && has("wv0001-api", ".prep-build"));
    assert.match(r.stdout, /✔ дерево — чистое/);
    assert.ok(fs.existsSync(path.join(WT, "_logs", "slot-up-wv0001-api.log")), "журнал шагов — вне папки слота");
});

test("область без сборки — шаг «build» пропущен; --no-build — тоже; слот «только чтение» — без подготовки", () => {
    assert.equal(up("wv0002-web").status, 0);
    assert.ok(has("wv0002-web", ".prep-always") && !has("wv0002-web", ".prep-build"));
    const ro = up("wv0003-look");
    assert.equal(ro.status, 0, ro.stdout + ro.stderr);
    assert.ok(!has("wv0003-look", ".prep-always"));
    assert.match(ro.stdout, /– подготовка — слот только читает код/);
});

test("повторный запуск на той же папке и ветке — как --reuse; сухой прогон показывает шаги и ничего не делает", () => {
    const r = up("wv0001-api");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /подготовка как с --reuse/);
    // папка слотов в конфиге записана через ссылку (как короткие имена Windows или /var на macOS), git отдаёт путь
    // раскрытым — это всё равно тот же слот
    const link = path.join(TMP, "wt-link");
    fs.symlinkSync(WT, link, "junction");
    writeCfg([{ run: mark("always") }, { run: mark("build"), when: "build" }], link);
    try {
        const l = up("wv0001-api");
        assert.equal(l.status, 0, l.stdout + l.stderr);
        assert.match(l.stdout, /подготовка как с --reuse/);
    }
    finally {
        writeCfg([{ run: mark("always") }, { run: mark("build"), when: "build" }]);
        fs.unlinkSync(link);
    }
    const d = up("wv0009-new", "--area", "api", "--dry-run");
    assert.equal(d.status, 0);
    assert.match(d.stdout, /шаги {5}node -e .* → node -e /);
    assert.ok(!fs.existsSync(path.join(WT, "wv0009-new")));
    assert.equal(up("wv0010-x", "--area", "nope").status, 2, "неизвестная область — отказ до действий");
});

test("функция slotPrepare проекта: получает слот и область, её шаги выполняются следом", () => {
    fs.writeFileSync(path.join(TMP, "dispatcher.project.mjs"), `export function slotPrepare(c) { return c.area && c.area.id === "web" ? [${JSON.stringify(mark("hook"))}] : [] }\n`);
    const r = up("wv0012-web2", "--area", "web");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(has("wv0012-web2", ".prep-hook"));
    assert.match(r.stdout, /✔ slotPrepare проекта — шагов ещё 1/);
    fs.rmSync(path.join(TMP, "dispatcher.project.mjs"));
});

test("упавший шаг — код 1 и журнал; шаг, оставивший правку в дереве, — тоже провал", () => {
    // шаг — строка оболочки (cmd на Windows, sh на Linux и macOS): скобки — в кавычках, иначе sh падает на разборе с кодом 2
    writeCfg([{ run: `node -e "process.exit(3)"` }]);
    const r = up("wv0013-fail", "--area", "web");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /✖ подготовка: node -e "process\.exit\(3\)" — код 3; журнал/);
    writeCfg([{ run: `node -e "require('fs').writeFileSync('dirty.txt','x')"` }]);
    const d = up("wv0014-dirty", "--area", "web");
    assert.equal(d.status, 1);
    assert.match(d.stdout, /✖ дерево — 1 изменённых файлов после подготовки/);
});
