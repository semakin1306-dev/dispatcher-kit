// Запреты слотов и окна редактора (slot-workspaces.mjs): по всем открытым эпикам или одному (--epic), запреты области —
// из `areas.<id>.denyEdit` конфига, allowEdit слота снимает запрет правки. Демо-проект: api запрещает apps/web/**,
// web — apps/api/** и packages/**.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-deny-"));
const WT = path.join(TMP, "wt"), REG = path.join(TMP, "epics.json");
const slot = (s, tag, extra) => ({ tag, emoji: "🟢", slot: s, branch: "dev/" + s, title: s, color: "#2e7d32", ...extra });
fs.writeFileSync(REG, JSON.stringify({ active: "e1", epics: [
    { id: "e1", title: "активный", status: "open", orch: { branch: "dev/epic-e1", path: path.join(TMP, "o1") }, slots: [slot("wva-one", "П1", { area: "api" }), slot("wva-ro", "П2", { readOnly: true })] },
    { id: "e2", title: "неактивный", status: "open", orch: { branch: "dev/epic-e2", path: path.join(TMP, "o2") }, slots: [slot("wvb-two", "П1", { area: "web", allowEdit: ["/packages/**"] })] },
    { id: "e3", title: "закрытый", status: "closed", orch: { branch: "dev/epic-e3", path: path.join(TMP, "o3") }, slots: [slot("wvc-three", "П1", { area: "api" })] },
] }));
for (const s of ["wva-one", "wva-ro", "wvb-two", "wvc-three"])
    fs.mkdirSync(path.join(WT, s), { recursive: true });
const run = (...a) => spawnSync(process.execPath, [path.join(HERE, "..", "slot-workspaces.mjs"), ...a], { encoding: "utf8", env: { ...process.env, DASH_EPIC_FILE: REG, DISPATCHER_WT: WT } });
const permsOf = (s) => {
    try {
        return JSON.parse(fs.readFileSync(path.join(WT, s, ".claude", "settings.local.json"), "utf8")).permissions;
    }
    catch {
        return null;
    }
};
after(async () => {
    const st = await import("./store.mjs");
    await st.settled(); st.flushSync(); await st.settled();
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const wsOf = (s) => JSON.parse(fs.readFileSync(path.join(WT, "_workspaces", s + ".code-workspace"), "utf8"));

test("без флагов — запреты слотов всех открытых эпиков: общие из конфига и запреты области; закрытый эпик не трогается", () => {
    const r = run();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const one = permsOf("wva-one");
    assert.ok(one.deny.includes("Edit(/apps/web/**)"), "область api: правка web закрыта");
    assert.ok(one.deny.includes("Bash(git push:*)") && one.deny.includes("Edit(/package.json)"), "общие запреты");
    assert.ok(!one.deny.includes("Edit(/packages/**)"));
    assert.deepEqual(one.ask, ["Bash(git commit:*)"]);
    const two = permsOf("wvb-two");
    assert.ok(two.deny.includes("Edit(/apps/api/**)"), "неактивный эпик — тоже");
    assert.ok(!two.deny.includes("Edit(/packages/**)"), "allowEdit снимает запрет области");
    assert.equal(permsOf("wvc-three"), null, "закрытый эпик — нет");
});

test("окно редактора: только-чтение защищённых путей конфига; слоту «только чтение» — всё", () => {
    run();
    assert.deepEqual(wsOf("wva-one").settings["files.readonlyInclude"], { "deploy*.sh": true, "package.json": true, "package-lock.json": true, ".github/**": true });
    assert.deepEqual(wsOf("wva-ro").settings["files.readonlyInclude"], { "**": true });
    assert.equal(wsOf("wva-one").folders[0].path, path.join(WT, "wva-one").replace(/\\/g, "/"));
});

test("--epic e2 --only <слот> — только этот слот (так зовёт подготовка слота); неизвестный эпик — ошибка", () => {
    fs.rmSync(path.join(WT, "wva-one", ".claude"), { recursive: true, force: true });
    fs.rmSync(path.join(WT, "wvb-two", ".claude"), { recursive: true, force: true });
    const r = run("--epic", "e2", "--only", "wvb-two");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(permsOf("wvb-two").deny.includes("Edit(/apps/api/**)"));
    assert.equal(permsOf("wva-one"), null);
    assert.notEqual(run("--epic", "нет-такого").status, 0, "неизвестный эпик — ошибка, а не тишина");
});

test("существующие настройки агента не затираются: свои разрешения остаются, запреты добавляются", () => {
    const f = path.join(WT, "wva-one", ".claude", "settings.local.json");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"], deny: ["Bash(rm:*)"] }, model: "x" }));
    assert.equal(run("--only", "wva-one").status, 0);
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    assert.equal(j.model, "x");
    assert.deepEqual(j.permissions.allow, ["Bash(ls:*)"]);
    assert.ok(j.permissions.deny.includes("Bash(rm:*)") && j.permissions.deny.includes("Edit(/apps/web/**)"));
});

test("slotPolicy: запреты конфига + denyEdit области и записи слота − allowEdit; слоту «только чтение» закрыто всё", async () => {
    const { slotPolicy } = await import("../areas.mjs");
    const { PROJECT } = await import("../slots.mjs");
    const api = slotPolicy({ area: "api" });
    assert.deepEqual(api.editDeny, ["/apps/web/**"]);
    assert.deepEqual(api.deny.commands, PROJECT.deny.commands);
    const web = slotPolicy({ area: "web", allowEdit: ["/packages/**", "/package.json"], deny: ["/apps/web/legacy/**"] });
    assert.deepEqual(web.editDeny, ["/apps/api/**", "/apps/web/legacy/**"], "allowEdit снимает запрет области");
    assert.ok(!web.deny.edit.includes("/package.json"), "allowEdit снимает и общий запрет правки");
    assert.deepEqual(web.allowEdit, ["/packages/**", "/package.json"]);
    assert.deepEqual(slotPolicy({ readOnly: true, area: "api" }).editDeny, ["/**"]);
});

test("подготовка слота: slot-up, затем запреты окна вторым шагом (slot-workspaces --epic --only)", async () => {
    const D = path.join(TMP, "data");
    fs.mkdirSync(D, { recursive: true });
    process.env.DASH_DATA = D;
    process.env.DASH_DRY = "1";
    process.env.DISPATCHER_WT = WT;
    const { provide } = await import("./late.mjs");
    const { loadJobs } = await import("./jobs.mjs");
    let got = null;
    provide({ "runner.mjs": { enqueue: async (o) => { got = o; return { id: "j1" }; } } });
    loadJobs([]);
    const E = await import("./epics.mjs");
    await E.enqueueProvision({ slot: "wvb-two", tag: "П1", branch: "dev/wvb-two", __epic: "e2" });
    assert.equal(got.steps.length, 2);
    assert.match(got.steps[0].show, /slot-up\.mjs wvb-two --branch dev\/wvb-two/);
    assert.match(got.steps[1].show, /slot-workspaces\.mjs --epic e2 --only wvb-two/);
});

test("slot-up сам пишет запреты рантайма и хук commit-msg; файл запретов — в info/exclude, дерево слота чистое", () => {
    const R = path.join(TMP, "repo"), W = path.join(TMP, "repo-wt"), CFG = path.join(TMP, "dispatcher.project.json"), EP = path.join(TMP, "epics-up.json");
    const git = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8" });
    fs.mkdirSync(path.join(R, "apps", "api"), { recursive: true });
    fs.writeFileSync(path.join(R, "apps", "api", "a.js"), "a\n");
    git(R, "init", "-q", "-b", "staging");
    git(R, "config", "user.email", "t@example.com");
    git(R, "config", "user.name", "t");
    git(R, "add", "-A");
    git(R, "commit", "-q", "-m", "init");
    const demo = JSON.parse(fs.readFileSync(path.join(HERE, "..", "..", "..", "test", "fixtures", "project.demo.json"), "utf8"));
    fs.writeFileSync(CFG, JSON.stringify({ ...demo, repo: { ...demo.repo, main: R, worktrees: W, data: path.join(TMP, "data-up") }, slotPrepare: [] }));
    fs.writeFileSync(EP, JSON.stringify({ active: "e", epics: [{ id: "e", title: "э", status: "open", orch: { branch: "dev/epic-e", path: path.join(TMP, "o") }, slots: [{ tag: "П1", slot: "wv0007-api", branch: "dev/wv-0007-api", area: "api" }] }] }));
    const env = { ...process.env, DISPATCHER_PROJECT: CFG, DASH_EPIC_FILE: EP };
    for (const k of ["DISPATCHER_MAIN", "DISPATCHER_WT", "DASH_DATA", "DASH_SPARSE"]) delete env[k];
    for (const k of Object.keys(env)) if (/^GIT_/.test(k)) delete env[k];
    const r = spawnSync(process.execPath, [path.join(HERE, "..", "slot-up.mjs"), "wv0007-api", "--branch", "dev/wv-0007-api"], { cwd: TMP, encoding: "utf8", env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /✔ хук commit-msg/);
    assert.match(r.stdout, /✔ запреты агента — claude: \d+ правил/);
    const dir = path.join(W, "wv0007-api");
    const perms = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.local.json"), "utf8")).permissions;
    assert.ok(perms.deny.includes("Edit(/apps/web/**)"), "запрет области");
    assert.ok(perms.deny.includes("Bash(git push:*)"), "общие запреты");
    const ex = git(dir, "rev-parse", "--git-path", "info/exclude").stdout.trim();
    assert.ok(fs.readFileSync(path.resolve(dir, ex), "utf8").split(/\r?\n/).includes("/.claude/settings.local.json"));
    assert.equal(git(dir, "status", "--porcelain").stdout.trim(), "", "слот не выглядит изменённым");
    assert.ok(git(dir, "config", "--worktree", "core.hooksPath").stdout.trim(), "свои хуки у рабочей копии слота");
    assert.equal(git(R, "config", "--get", "core.hooksPath").status, 1, "хуки основной папки не тронуты");
});
