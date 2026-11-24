// Команда эпиков на временном git-репозитории и демо-конфиге (области api и web): эпик с папкой оркестратора, слот волны
// с записью в реестре и заготовкой плана, поезд и вагон от областей конфига, отказы с перечнем областей и задач проекта.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planIsStub } from "./dashboard/slot-rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)), CLI = path.join(HERE, "epic.mjs");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dk-epic-")));
const MAIN = path.join(TMP, "main"), WT = path.join(TMP, "wt"), CFG = path.join(TMP, "dispatcher.project.json");
const git = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8" });

for (const k of Object.keys(process.env))
    if (/^GIT_/.test(k))
        delete process.env[k];
fs.mkdirSync(MAIN, { recursive: true });
git(MAIN, "init", "-q", "-b", "staging");
git(MAIN, "config", "user.email", "t@example.com");
git(MAIN, "config", "user.name", "t");
fs.writeFileSync(path.join(MAIN, "README.md"), "demo\n");
git(MAIN, "add", "README.md");
git(MAIN, "commit", "-q", "-m", "init");

const demo = JSON.parse(fs.readFileSync(path.join(HERE, "..", "..", "test", "fixtures", "project.demo.json"), "utf8"));
fs.writeFileSync(CFG, JSON.stringify({ ...demo, repo: { ...demo.repo, main: MAIN, worktrees: WT, data: path.join(TMP, "data") }, slotPrepare: [{ run: "node -e 0" }] }, null, 2));
// Порт 1 закрыт: команда считает, что диспетчерская не запущена, и папку слота поднимает сама.
const env = { ...process.env, DISPATCHER_PROJECT: CFG, DASH_PORT: "1" };
for (const k of ["DISPATCHER_MAIN", "DISPATCHER_WT", "DASH_EPIC_FILE", "DASH_DATA"])
    delete env[k];
const cli = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: TMP, encoding: "utf8", env });
const reg = () => JSON.parse(fs.readFileSync(path.join(WT, "_epics", "epics.json"), "utf8"));
const epic = () => reg().epics.find((e) => e.id === "demo");
const ok = (r) => assert.equal(r.status, 0, r.stdout + r.stderr);

after(() => {
    try {
        fs.rmSync(TMP, { recursive: true, force: true });
    }
    catch { }
});

test("new: эпик в реестре и папка оркестратора на ветке dev/epic-<id> от staging", () => {
    ok(cli("new", "--id", "demo", "--title", "Демо", "--activate"));
    const e = epic();
    assert.equal(reg().active, "demo");
    assert.deepEqual(e.orch, { branch: "dev/epic-demo", path: path.join(WT, "epic-demo").replace(/\\/g, "/") });
    assert.equal(git(e.orch.path, "branch", "--show-current").stdout.trim(), "dev/epic-demo");
    assert.notEqual(cli("new", "--id", "demo", "--title", "ещё").status, 0, "второй эпик с тем же id — отказ");
});

test("add-slot: запись в реестре от области конфига, заготовка плана, папка слота с шагами подготовки", () => {
    const r = cli("add-slot", "--title", "Первая волна", "--area", "api");
    ok(r);
    const s = epic().slots[0];
    assert.equal(s.tag, "П1");
    assert.equal(s.slot, "wv0001-pervaya-volna");
    assert.equal(s.branch, "dev/wv-0001-pervaya-volna");
    assert.equal(s.title, "WV-0001 Первая волна");
    assert.equal(s.area, "api");
    assert.equal(s.build, true);
    assert.deepEqual(s.presets, [{ task: "api-test", input: "wv-0001" }], "тесты волны — задачи области с номером волны");
    const plan = path.join(WT, "epic-demo", ".claude", "plans", "waves", "WV-0001-pervaya-volna.md");
    assert.ok(fs.existsSync(plan));
    const text = fs.readFileSync(plan, "utf8");
    assert.match(text, /^id: WV-0001$/m);
    assert.match(text, /^epic: demo$/m);
    assert.ok(planIsStub(text), "заготовка — пока подсказки шаблона на месте");
    assert.match(r.stdout, /✔ подготовка: node -e 0/);
    assert.equal(git(path.join(WT, s.slot), "branch", "--show-current").stdout.trim(), s.branch);
});

test("add-slot: номер волны — следующий по реестру и планам; --read-only — без тестов и сборки; --no-worktree — без папки", () => {
    ok(cli("add-slot", "--title", "WV-0002 Разведка", "--read-only", "--no-worktree"));
    const s = epic().slots[1];
    assert.equal(s.slot, "wv0002-razvedka");
    assert.equal(s.readOnly, true);
    assert.deepEqual(s.presets, []);
    assert.equal("build" in s, false);
    assert.ok(!fs.existsSync(path.join(WT, s.slot)));
});

test("неизвестная область — отказ с перечнем областей проекта; без области при двух областях — тоже", () => {
    const before = JSON.stringify(reg());
    const r = cli("add-slot", "--title", "x", "--area", "backend");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /неизвестная область backend; области проекта: api \| web/);
    const r2 = cli("add-slot", "--title", "x");
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /нужна область --area: api \| web/);
    const r3 = cli("add-train", "--area", "nope");
    assert.equal(r3.status, 1);
    assert.match(r3.stderr, /области проекта: api \| web/);
    assert.equal(JSON.stringify(reg()), before, "реестр не тронут");
});

test("add-train и add-wagon: поезд области конфига, вагон с тестами области и заготовкой плана", () => {
    ok(cli("add-train", "--area", "web", "--dry-run"));
    assert.equal(epic().slots.length, 2, "сухой прогон реестр не меняет");
    ok(cli("add-train", "--area", "web"));
    const t = epic().slots.find((z) => z.kind === "train");
    assert.deepEqual([t.tag, t.slot, t.branch, t.trainArea, t.area, t.title], ["Т1", "tr-web-demo", "dev/tr-web-demo", "web", "web", "Витрина"]);
    assert.ok(t.scope.includes("apps/web"));
    ok(cli("add-wagon", "--train", "Т1", "--title", "Корзина"));
    const w = epic().slots.find((z) => z.kind === "train").wagons[0];
    assert.deepEqual(w, { wave: "WV-0003", title: "Корзина", presets: [{ task: "web-test", input: "wv-0003" }] });
    assert.ok(fs.existsSync(path.join(WT, "epic-demo", ".claude", "plans", "waves", "WV-0003-korzina.md")));
    const tr = cli("trains");
    ok(tr);
    assert.match(tr.stdout, /WV-0003 Корзина: следующий/);
});

test("presets: белый список — задачи конфига проекта", () => {
    ok(cli("presets", "П1", "lint", "api-test=wv-0001"));
    assert.deepEqual(epic().slots[0].presets, [{ task: "lint" }, { task: "api-test", input: "wv-0001" }]);
    const r = cli("presets", "П1", "be-jest=x");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /неизвестная задача be-jest \(есть: api-test, web-test, lint, typecheck\)/);
    ok(cli("presets", "WV-0003", "-"));
    assert.deepEqual(epic().slots.find((z) => z.kind === "train").wagons[0].presets, []);
});

test("status и close: состояние веток; невлитый слот держит закрытие, --force закрывает", () => {
    const st = cli("status", "demo");
    ok(st);
    assert.match(st.stdout, /П1 wv0001-pervaya-volna: папка есть · ветка есть · влита: да/);
    fs.writeFileSync(path.join(WT, "wv0001-pervaya-volna", "a.txt"), "a\n");
    const c = cli("close", "demo");
    assert.equal(c.status, 2);
    assert.match(c.stdout, /П1 wv0001-pervaya-volna: несохранённых файлов 1/);
    ok(cli("close", "demo", "--force"));
    assert.equal(epic().status, "closed");
});

test("без команды — справка с перечнем областей проекта", () => {
    const r = cli();
    assert.match(r.stdout, /add-slot --title T/);
    assert.match(r.stdout, /области проекта: api \| web/);
});
