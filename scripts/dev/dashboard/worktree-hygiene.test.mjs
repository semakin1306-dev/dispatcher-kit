// Уборка лишних папок слотов: разбор `git worktree list`, правило «лишняя» на условных путях и полный цикл на временном
// репозитории — свои лишние слоты убираются, а основная папка, служебные папки и рабочие копии, заведённые человеком
// (вне папки слотов или внутри неё, но не по правилу имён), не предлагаются и не трогаются.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extraWorktrees, hygienePlan, hygieneRun, parseWorktrees } from "./worktree-hygiene.mjs";

// Папки условные: правила только сравнивают пути, на диск не ходят.
const MAIN = "/work/demo", WT = "/work/demo-wt";
const LIST = parseWorktrees(
    [
        `worktree ${MAIN}`,
        "HEAD 1",
        "branch refs/heads/staging",
        "",
        `worktree ${WT}/wv1022-viewer-users`,
        "HEAD 2",
        "branch refs/heads/dev/wv-1022",
        "",
        `worktree ${WT}/epic-demo`,
        "HEAD 3",
        "branch refs/heads/dev/epic-demo",
        "",
        `worktree ${WT}/wv0933`,
        "HEAD 4",
        "branch refs/heads/dev/wv-0933",
        "",
        `worktree ${WT}/_main`,
        "HEAD 5",
        "branch refs/heads/main",
        "",
        `worktree ${WT}/reserve`,
        "HEAD 6",
        "branch refs/heads/dev/reserve",
        "",
        `worktree ${WT}/_stg`,
        "HEAD 7",
        "detached",
        "",
        `worktree ${WT}/wv0934-next`,
        "HEAD 8",
        "branch refs/heads/dev/wv-0934-next",
        "",
    ].join("\n"),
);

test("разбор worktree list: путь и ветка (у отсоединённой — null)", () => {
    assert.equal(LIST.length, 8);
    assert.equal(LIST[1].br, "dev/wv-1022");
    assert.equal(LIST[6].br, null);
});

test("лишние — свои слоты не из открытых эпиков и не из «оставить»; чужое имя в папке слотов — не лишнее", () => {
    const epics = [
        { id: "demo", status: "open", slots: [{ slot: "wv1022-viewer-users" }], orch: { path: `${WT}/epic-demo` } },
        { id: "old", status: "closed", slots: [{ slot: "wv0933" }], orch: { path: `${WT}/epic-old` } },
    ];
    const extra = (keep) => extraWorktrees(LIST, epics, { wtRoot: WT, main: MAIN, keep }).map((w) => w.p.split("/").pop());
    // wv0933 — не по правилу имён, но слот закрытого эпика из реестра; reserve не знает никто — чужая, не лишняя.
    assert.deepEqual(extra([]), ["wv0933", "wv0934-next"]);
    assert.deepEqual(extra(["wv0934-next"]), ["wv0933"], "«оставить» снимает папку с уборки");
    assert.deepEqual(extra(undefined), ["wv0933", "wv0934-next"], "по умолчанию список «оставить» пуст");
    assert.deepEqual(extra("мусор"), ["wv0933", "wv0934-next"], "keepWorktrees не список — как пустой");
});

// ── полный цикл на временном репозитории ──

// Не раскрываем путь realpath: git отдаёт его раскрытым (macOS /private/var, длинные имена Windows), а правило должно
// узнать свои папки и в такой записи.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dk-hygiene-"));
const PROJ = path.join(TMP, "proj"), PWT = path.join(TMP, "proj-wt");
const run = (cwd, ...a) => {
    const r = spawnSync("git", a, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, "git " + a.join(" ") + ": " + r.stderr);
    return r.stdout;
};
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

for (const k of Object.keys(process.env))
    if (/^GIT_/.test(k))
        delete process.env[k];
fs.mkdirSync(PROJ, { recursive: true });
fs.writeFileSync(path.join(PROJ, "a.txt"), "a\n");
run(PROJ, "init", "-q", "-b", "staging");
run(PROJ, "config", "user.email", "t@example.com");
run(PROJ, "config", "user.name", "t");
run(PROJ, "add", "-A");
run(PROJ, "commit", "-q", "-m", "init");
const add = (dir, br) => run(PROJ, "worktree", "add", "-q", ...(br ? ["-b", br, dir, "staging"] : ["--detach", dir, "staging"]));
// Чужие: копия человека рядом с проектом, копия внутри папки слотов не по правилу имён, копия глубже папки слотов.
add(path.join(TMP, "mine-elsewhere"), "personal/a");
add(path.join(PWT, "scratch"), "personal/b");
add(path.join(PWT, "sub", "wv0009-deep"), "personal/c");
// Служебные: выкат, бэклог, папка поезда, будущая основная папка лёгкого режима.
for (const d of ["_main", "_backlog", "regress-train", "_staging"])
    add(path.join(PWT, d));
// Свои: живой слот и оркестратор открытого эпика; лишние — слот по правилу, оркестратор и слот с особым именем
// закрытого эпика, поезд закрытого эпика.
for (const [d, br] of [["wv0008-live", "dev/wv-0008-live"], ["epic-demo", "dev/epic-demo"], ["wv0007-old", "dev/wv-0007-old"],
    ["epic-gone", "dev/epic-gone"], ["custom-old", "dev/custom-old"], ["tr-api-gone", "dev/tr-api-gone"]])
    add(path.join(PWT, d), br);
const REG = [
    { id: "demo", status: "open", orch: { branch: "dev/epic-demo", path: path.join(PWT, "epic-demo") }, slots: [{ slot: "wv0008-live" }] },
    { id: "gone", status: "closed", orch: { branch: "dev/epic-gone", path: path.join(PWT, "epic-gone") }, slots: [{ slot: "custom-old" }] },
];
const names = (ws) => ws.map((w) => path.relative(TMP, w.p).split(path.sep).join("/").toLowerCase()).sort();

test("план на настоящем репозитории: лишние — только свои слоты; чужие показаны отдельно, основная и служебные — нигде", async () => {
    const p = await hygienePlan(REG, { wtRoot: PWT, main: PROJ });
    assert.equal(p.total, 14);
    assert.deepEqual(names(p.extra), ["proj-wt/custom-old", "proj-wt/epic-gone", "proj-wt/tr-api-gone", "proj-wt/wv0007-old"]);
    assert.deepEqual(names(p.foreign), ["mine-elsewhere", "proj-wt/scratch", "proj-wt/sub/wv0009-deep"]);
    assert.deepEqual(p.foreign.map((w) => w.own).sort(), ["foreign", "outside", "outside"]);
});

test("лёгкий режим: основная папка — служебная копия в папке слотов, папка владельца вне её — обе не предлагаются", async () => {
    const p = await hygienePlan(REG, { wtRoot: PWT, main: path.join(PWT, "_staging") });
    const all = [...names(p.extra), ...names(p.foreign)];
    assert.ok(!all.includes("proj-wt/_staging"), "основная папка лёгкого режима");
    assert.ok(names(p.foreign).includes("proj"), "папка владельца — чужая, только для показа");
    assert.ok(!names(p.extra).includes("proj"));
});

test("папка слотов через ссылку (junction / symlink) и другой записью: свои узнаются, чужие не становятся лишними", async (t) => {
    const link = path.join(TMP, "link-wt");
    try {
        fs.symlinkSync(PWT, link, process.platform === "win32" ? "junction" : "dir");
    }
    catch (e) {
        return t.skip("ссылку не создать: " + e.message);
    }
    const reg = REG.map((e) => ({ ...e, orch: { ...e.orch, path: path.join(link, path.basename(e.orch.path)) } }));
    const p = await hygienePlan(reg, { wtRoot: link + path.sep, main: PROJ });
    assert.deepEqual(names(p.extra), ["proj-wt/custom-old", "proj-wt/epic-gone", "proj-wt/tr-api-gone", "proj-wt/wv0007-old"]);
});

test("уборка: свои лишние убраны (грязная — через stash, невлитая ветка оставлена), чужие и служебные на месте", async () => {
    fs.writeFileSync(path.join(PWT, "wv0007-old", "wip.txt"), "незакоммиченное\n");
    fs.writeFileSync(path.join(PWT, "tr-api-gone", "b.txt"), "b\n");
    run(path.join(PWT, "tr-api-gone"), "add", "b.txt");
    run(path.join(PWT, "tr-api-gone"), "commit", "-q", "-m", "вагон");
    const plan = await hygienePlan(REG, { wtRoot: PWT, main: PROJ });
    const r = await hygieneRun(plan);
    assert.deepEqual([r.removed, r.stashed, r.failed, r.branches], [4, 1, 0, 3], JSON.stringify(r));
    assert.ok(r.log.some((l) => l.includes("dev/tr-api-gone")), "невлитая ветка поезда оставлена");
    for (const d of ["wv0007-old", "epic-gone", "custom-old", "tr-api-gone"])
        assert.ok(!fs.existsSync(path.join(PWT, d)), d + " убрана");
    for (const d of [path.join(TMP, "mine-elsewhere"), path.join(PWT, "scratch"), path.join(PWT, "sub", "wv0009-deep"), path.join(PWT, "_staging"),
        path.join(PWT, "regress-train"), path.join(PWT, "wv0008-live"), path.join(PWT, "epic-demo")])
        assert.ok(fs.existsSync(path.join(d, ".git")), d + " на месте");
    assert.match(run(PROJ, "stash", "list"), /wv0007-old/);
    const left = parseWorktrees(run(PROJ, "worktree", "list", "--porcelain"));
    assert.equal(left.length, 10);
    assert.equal((await hygienePlan(REG, { wtRoot: PWT, main: PROJ })).extra.length, 0, "второй проход — убирать нечего");
});

test("пункт плана без отметки правила (план собран в обход splitWorktrees) не убирается", async () => {
    const plan = { main: PROJ, extra: [{ p: path.join(PWT, "scratch"), br: "personal/b", ahead: 0 }] };
    const r = await hygieneRun(plan);
    assert.deepEqual([r.removed, r.failed], [0, 1]);
    assert.ok(fs.existsSync(path.join(PWT, "scratch", ".git")));
    assert.match(run(PROJ, "branch", "--list", "personal/b"), /personal\/b/);
});
