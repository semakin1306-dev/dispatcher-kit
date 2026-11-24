import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STATUSES, checkPatch, checkSet, itemOf, lastClosedEpic, newItemText, retroGateWhy, retroOfMeta, retroTriage } from "./backlog-rules.mjs";
import { createItem, listItems, readItem, updateItem } from "./backlog-store.mjs";
import { proposalItem, freshProposals } from "./retro-rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)), CLI = path.resolve(HERE, "..", "backlog.mjs"), EPIC = path.resolve(HERE, "..", "epic.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "retro-triage-"));

after(() => {
    try {
        fs.rmSync(TMP, { recursive: true, force: true });
    }
    catch { }
});

const EPICS = [{ id: "old", title: "Старый", status: "closed", closedAt: "2026-11-10T10:00:00Z", slots: [] }, { id: "ep-a", title: "Эпик А: что-то", status: "closed", closedAt: "2026-11-16T10:00:00Z", slots: [] }, { id: "open1", title: "Открытый", status: "open", slots: [] }];

test("статус rejected (отказ) — только с причиной одной строкой; dropped остаётся для старых элементов", () => {
    assert.ok(STATUSES.includes("rejected") && STATUSES.includes("dropped"));
    assert.throws(() => checkPatch({ status: "new" }, { status: "rejected" }), /с причиной/);
    assert.doesNotThrow(() => checkPatch({ status: "new" }, { status: "rejected", reason: "дубль BL-0042" }));
    assert.doesNotThrow(() => checkPatch({ status: "rejected", reason: "было" }, { area: "x" }), "причина уже в файле");
    assert.throws(() => checkPatch({ status: "rejected", reason: "было" }, { reason: "" }), /с причиной/, "снять причину у отказа нельзя");
    assert.equal(checkSet("reason", "  две\nстроки  "), "две строки");
    assert.throws(() => checkSet("reason", "x".repeat(301)), /одна строка/);
    assert.throws(() => checkSet("retro", "ep"), /менять нельзя/, "эпик-источник не меняется командой set");
});

test("происхождение: предложение ретро → карточка с retro: <эпик>; старые карточки — по source «ретро <эпик>»", () => {
    const p = proposalItem({ kind: "гард", title: "проверять порт", episodes: ["j1"] }, { epic: "ep-a", doc: "docs/retro/ep-a.md" });
    assert.equal(p.retro, "ep-a");
    const body = newItemText({ id: "BL-0001", text: p.text, source: p.source, area: p.area, retro: p.retro, at: 0 });
    assert.match(body, /^retro: ep-a$/m);
    assert.equal(itemOf("BL-0001-x.md", body).retro, "ep-a");
    assert.equal(retroOfMeta({ source: "ретро retro-guards" }), "retro-guards");
    assert.equal(retroOfMeta({ source: "владелец, быстрый ввод" }), "");
    assert.throws(() => newItemText({ id: "BL-0002", text: "x", retro: "плохой id!" }), /retro/);
    assert.deepEqual(freshProposals([{ kind: "гард", title: "проверять порт", episodes: [] }], [itemOf("BL-0001-x.md", body)], "ep-a"), [], "повторное ретро по полю retro не дублирует");
});

test("разбор: последний закрытый эпик, карточки без решения (new/researching/researched); отказ — с подсказкой команд", () => {
    assert.equal(lastClosedEpic(EPICS).id, "ep-a");
    assert.equal(lastClosedEpic([{ id: "o", status: "open" }]), null);
    const it = (id, status, retro) => ({ id, status, retro, title: id + " заголовок" });
    const items = [it("BL-0010", "new", "ep-a"), it("BL-0011", "researched", "ep-a"), it("BL-0012", "planned", "ep-a"), it("BL-0013", "rejected", "ep-a"), it("BL-0014", "new", "old"), it("BL-0015", "new", "")];
    const tr = retroTriage(items, EPICS);
    assert.deepEqual({ epic: tr.epic, total: tr.total, open: tr.open.map((x) => x.id) }, { epic: "ep-a", total: 4, open: ["BL-0010", "BL-0011"] });
    const why = retroGateWhy(tr, "/x/backlog.mjs");
    for (const w of ["Эпик А", "2 из 4", "BL-0010, BL-0011", "backlog.mjs triage", "--status rejected --reason", "--skip-retro"])
        assert.ok(why.includes(w), w);
    assert.equal(retroGateWhy(retroTriage(items.filter((x) => x.id !== "BL-0010" && x.id !== "BL-0011"), EPICS)), "", "всё разобрано — можно");
    assert.equal(retroGateWhy(retroTriage(items, [])), "", "закрытых эпиков нет — можно");
    assert.equal(retroTriage(items, EPICS, "old").open[0].id, "BL-0014", "--epic — разбор конкретного эпика");
});

const data = path.join(TMP, "data"), dir = path.join(data, "backlog"), reg = path.join(TMP, "epics.json");
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(path.join(TMP, "main", "apps", "backend"), { recursive: true });
fs.writeFileSync(reg, JSON.stringify({ active: "open1", epics: EPICS.map((e) => ({ ...e, orch: { branch: "dev/epic-" + e.id, path: path.join(TMP, "wt", "epic-" + e.id) } })) }));
const env = { ...process.env, DASH_DATA: data, DASH_EPIC_FILE: reg, DISPATCHER_WT: path.join(TMP, "wt"), DISPATCHER_MAIN: path.join(TMP, "main") };

for (const k of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_COMMON_DIR"])
    delete env[k];

const cli = (...a) => spawnSync(process.execPath, [CLI, ...a], { env, encoding: "utf8" });
const epic = (...a) => spawnSync(process.execPath, [EPIC, ...a], { env, encoding: "utf8", cwd: TMP });

test("store и CLI: отказ без причины не сохраняется; set --status rejected --reason; triage — список и код 1, разобрано — код 0", () => {
    const a = createItem(dir, { text: "Гард: проверять порт до прогона", source: "ретро ep-a", retro: "ep-a" }).item, b = createItem(dir, { text: "Правило: X", source: "ретро ep-a", retro: "ep-a" }).item;
    assert.equal(a.retro, "ep-a");
    assert.throws(() => updateItem(dir, a.id, { set: { status: "rejected" } }), /с причиной/);
    let r = cli("triage");
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, new RegExp("2 из 2 карточек ждут решения — " + a.id + ", " + b.id));
    assert.equal(JSON.parse(cli("triage", "--json").stdout).open.length, 2);
    r = cli("set", a.id, "--status", "rejected");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /с причиной/);
    r = cli("set", a.id, "--status", "rejected", "--reason", "уже сделано в WV-1090");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /отказ \(rejected\): уже сделано в WV-1090/);
    assert.equal(readItem(dir, a.id).item.reason, "уже сделано в WV-1090");
    assert.match(readItem(dir, a.id).text, /^reason: уже сделано в WV-1090$/m);
    r = cli("triage");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /1 из 2/);
    r = epic("new", "--id", "ep-b", "--title", "Эпик Б", "--dry-run");
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp("новый эпик не заводится: ретро эпика «Эпик А: что-то» \\(ep-a\\): 1 из 2 карточек ждут решения — " + b.id));
    r = epic("new", "--id", "ep-b", "--title", "Эпик Б", "--dry-run", "--skip-retro");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"id": "ep-b"/);
    assert.equal(fs.existsSync(path.join(data, "events.jsonl")), false, "сухой прогон событие не пишет");
    execFileSync(process.execPath, [CLI, "set", b.id, "status=planned", "epic=open1"], { env, encoding: "utf8" });
    r = cli("triage");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /все 2 карточек разобраны/);
    r = epic("new", "--id", "ep-b", "--title", "Эпик Б", "--dry-run");
    assert.equal(r.status, 0, r.stderr);
});

test("--skip-retro по слову владельца — эпик заводится, событие retro.skip с эпиком-источником и карточками", () => {
    const c = createItem(dir, { text: "Правка навыка: Y", source: "ретро ep-a", retro: "ep-a" }).item;
    const main = path.join(TMP, "main"), g = (...a) => execFileSync("git", a, { cwd: main, env: { ...env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, encoding: "utf8" });
    g("init", "-q", "-b", "staging");
    fs.writeFileSync(path.join(main, "a"), "a");
    g("add", "a");
    g("commit", "-q", "-m", "base");
    let r = epic("new", "--id", "ep-c", "--title", "Эпик В");
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(c.id));
    r = epic("new", "--id", "ep-c", "--title", "Эпик В", "--skip-retro");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /--skip-retro/);
    const ev = fs.readFileSync(path.join(data, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "retro.skip");
    assert.equal(ev.length, 1);
    assert.equal(ev[0].epic, "ep-c");
    assert.equal(ev[0].retro, "ep-a");
    assert.deepEqual(ev[0].open, [c.id]);
    assert.match(ev[0].by, /--skip-retro/);
    assert.ok(JSON.parse(fs.readFileSync(reg, "utf8")).epics.some((e) => e.id === "ep-c"), "эпик в реестре");
    assert.ok(listItems(dir).every((x) => x.retro === "ep-a"));
});
