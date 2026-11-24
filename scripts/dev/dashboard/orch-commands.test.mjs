import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-orch-cmd-"));
process.env.DASH_DATA = path.join(TMP, "data");
process.env.DASH_DRY = "1";
process.env.DISPATCHER_WT = path.join(TMP, "wt");
process.env.DASH_EPIC_FILE = path.join(TMP, "epics.json");
process.env.DASH_ORCH_STEP_MS = "60";
fs.mkdirSync(process.env.DASH_DATA, { recursive: true });
fs.mkdirSync(path.join(TMP, "orch", ".git"), { recursive: true });

for (const s of ["wv9003-a", "wv9007-b"])
    fs.mkdirSync(path.join(TMP, "wt", s, ".git"), { recursive: true });

fs.writeFileSync(process.env.DASH_EPIC_FILE, JSON.stringify({ active: "e1", epics: [{ id: "e1", title: "т", status: "open", orch: { path: path.join(TMP, "orch"), branch: "orch/e1" }, slots: [{ slot: "wv9003-a", tag: "П3", branch: "dev/wv-9003", title: "а" }, { slot: "wv9007-b", tag: "П7", branch: "dev/wv-9007", title: "б" }] }] }));
await import("./wiring.mjs");
const { applyEpics } = await import("./trees.mjs");
const { loadInbox } = await import("./inbox.mjs");
const R = await import("./relay.mjs");
const { loadSessions } = await import("./agents.mjs");
const { loadJobs } = await import("./jobs.mjs");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
applyEpics();
loadInbox();
loadSessions();
loadJobs([]);
R.loadRelaySent();
R.loadTestReqs();
const ORCH = "orchestrator@e1";
const orchAgent = (ownerText) => ({ key: ORCH, items: [{ id: "u1", t: "user", owner: true, text: ownerText, at: Date.now() }], rev: 1 });
let sends = [], real = null;

beforeEach(() => {
    sends = [];
    R.orchFailSeen.clear();
    real = real || { ...R._orchSteps };
    Object.assign(R._orchSteps, real, { send: (key, text) => sends.push({ key, text }) });
});

test("А1: проверка влива зависла — отказ по сроку, остальные строки исполняются; отказ раньше зависшей строки ушёл до неё", async () => {
    const seenAtHang = [];
    R._orchSteps.preflight = async (action, key) => {
        if (key === "wv9003-a") {
            seenAtHang.push(sends.map((s) => s.text).join("\n"));
            return new Promise(() => { });
        }
        return { checks: [{ id: "clean", ok: false, text: "в слоте нет незакоммиченных изменений" }], trees: [] };
    };
    const t0 = Date.now();
    await R.orchGitCommands(orchAgent("влей П3, П7"), "ВЛИТЬ П9\nВЛИТЬ П3\nВЛИТЬ П7");
    assert.ok(Date.now() - t0 < 2000, "весь список — за срок, а не навсегда");
    assert.match(seenAtHang[0] || "", /«ВЛИТЬ П9»: нет такого слота/, "отказ П9 ушёл оркестратору до зависшей проверки П3");
    const all = sends.map((s) => s.text).join("\n");
    assert.match(all, /«ВЛИТЬ П3»: [^\n]*нет ответа за/);
    assert.match(all, /«ВЛИТЬ П7»: не исполнено: в слоте нет незакоммиченных/);
    assert.ok(sends.every((s) => s.key === ORCH));
});

const L = await import("./orchlog.mjs");
const A = await import("./agents.mjs");
const readLog = () => JSON.parse(fs.readFileSync(L.ORCH_LOG_FILE, "utf8"));

test("А2: команда записана в журнал ДО исполнения, итог — после; тот же ход второй раз не исполняется", async () => {
    L.loadOrchLog();
    let during = null, calls = 0;
    R._orchSteps.preflight = async () => {
        calls++;
        during = readLog().items.find((x) => x.id.startsWith("msg_turn1"));
        return { checks: [{ id: "ahead", ok: false, text: "в ветке есть что вливать" }], trees: [] };
    };
    await R.orchGitCommands(orchAgent("влей П7"), "ВЛИТЬ П7", "msg_turn1");
    assert.equal(during && during.state, "run", "на время исполнения в файле — «идёт»");
    const done = readLog().items.find((x) => x.id.startsWith("msg_turn1"));
    assert.equal(done.state, "fail");
    assert.match(done.detail, /не исполнено/);
    assert.equal(done.cmd, "ВЛИТЬ");
    await R.orchGitCommands(orchAgent("влей П7"), "ВЛИТЬ П7", "msg_turn1");
    assert.equal(calls, 1, "тот же ход (id сообщения) — повторно не исполняется");
    await R.orchGitCommands(orchAgent("влей П7"), "ВЛИТЬ П7", "msg_turn2");
    assert.equal(calls, 2, "тот же текст в новом ходе — исполняется (раньше молча пропускался)");
});

test("А2: после перезапуска «идущие» команды — оркестратору отказом «прервано перезапуском», в журнале — fail", async () => {
    fs.writeFileSync(L.ORCH_LOG_FILE, JSON.stringify({ since: 1, items: [{ id: "k1", at: Date.now() - 60e3, orch: ORCH, cmd: "ВЛИТЬ", target: "П3", line: "ВЛИТЬ П3", state: "run" }, { id: "k2", at: Date.now() - 60e3, orch: ORCH, cmd: "ВЛИТЬ", target: "П9", line: "ВЛИТЬ П9", state: "ok", detail: "вливаю" }], turns: {}, owner: {} }));
    L.loadOrchLog();
    await R.orchAfterBoot({ readSession: async () => "", lastAnswer: () => null });
    assert.equal(sends.length, 1);
    assert.match(sends[0].text, /Перезапуск диспетчерской прервал/);
    assert.match(sends[0].text, /«ВЛИТЬ П3»/);
    assert.doesNotMatch(sends[0].text, /П9/);
    const it = readLog().items.find((x) => x.id === "k1");
    assert.equal(it.state, "fail");
    assert.match(it.detail, /прервано перезапуском/);
    sends = [];
    await R.orchAfterBoot({ readSession: async () => "", lastAnswer: () => null });
    assert.equal(sends.length, 0, "второй раз не шлём");
});

test("А2: последний ответ оркестратора закончен, а сервер его не разобрал (перезапуск) — команды из него исполняются после старта", async () => {
    const t = Date.now() - 60e3;
    fs.writeFileSync(L.ORCH_LOG_FILE, JSON.stringify({ since: t - 3600e3, items: [], turns: { [ORCH]: t - 600e3 }, owner: {} }));
    L.loadOrchLog();
    // запись сессии и законченный ответ в ней разбирает рантайм; здесь — готовый итог разбора
    const fin = { text: "Ставлю прогон.\nПРОГНАТЬ П3: api-test=wv-0999", at: t, id: "msg_b" };
    const boot = () => R.orchAfterBoot({ readSession: async (k) => (k === ORCH ? "tail-orch" : ""), lastAnswer: (tail) => (tail === "tail-orch" ? fin : null) });
    await boot();
    assert.deepEqual((R.testReqsOf("wv9003-a") || []).map((x) => x.task + "=" + x.input), ["api-test=wv-0999"]);
    assert.ok(readLog().items.some((x) => x.cmd === "ПРОГНАТЬ" && x.target === "П3" && x.state === "ok"));
    assert.ok(readLog().turns[ORCH] >= t, "ход отмечен разобранным");
    const n = readLog().items.length;
    await boot();
    assert.equal(readLog().items.length, n, "второй старт тот же ход не разбирает");
});

test("А2: слово владельца переживает перезапуск — после старта в памяти агента его нет, а ВЛИТЬ его видит", () => {
    L.loadOrchLog();
    const live = { key: ORCH, items: [], rev: 0 };
    A.push(live, { id: "u9", t: "user", owner: true, text: "П3 влей" });
    const fresh = { key: ORCH, items: [{ id: "h0", t: "user", text: "П3 влей" }], rev: 0 };
    assert.equal(R.ownerLastText(fresh), "П3 влей");
    assert.equal(R.ownerLastText(fresh, Date.now() + 13 * 3600e3), null, "срок слова тот же — 12 ч");
});

test("А3: итог «поставлено X, не понял Y (почему)» — оркестратору сообщением; всё понято — сообщения нет", async () => {
    R.orchRunCommands(orchAgent("прогони"), "ПРОГНАТЬ П3: api-test=wv-0999,wv-0996 web-test", "msg_run1");
    assert.equal(sends.length, 1, JSON.stringify(sends));
    assert.equal(sends[0].key, ORCH);
    assert.match(sends[0].text, /«ПРОГНАТЬ П3»: поставлено: api-test=wv-0999/);
    assert.match(sends[0].text, /не понял: web-test/);
    sends = [];
    R.orchRunCommands(orchAgent("прогони"), "ПРОГНАТЬ П3: api-test=wv-0999,wv-0996", "msg_run2");
    assert.equal(sends.length, 0);
    R.orchRunCommands(orchAgent("прогони"), "ПРОГНАТЬ П42: api-test=wv-0999", "msg_run3");
    assert.match(sends[0].text, /«ПРОГНАТЬ П42»: нет такого слота в эпике/);
});

test("А4: отказ ворот по просьбе оркестратора — ему сообщением с причиной и подсказкой; не чаще раза на код и причину", () => {
    const ask = { tree: "wv9003-a", task: "api-test", input: "wv-0999", by: "просьба оркестратора", fp: "fp1", why: "волна закоммичена, код с коммита не менялся — проверять дальше будет поезд влива" };
    const msg = R.gateFeedback(ask);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].key, ORCH);
    assert.match(msg, /Ворота не пустили прогон/);
    assert.match(msg, /API: тесты по шаблону|api-test/);
    assert.match(msg, /wv-0999/);
    assert.match(msg, /П3/);
    assert.match(msg, /поезд влива/);
    assert.match(msg, /ВЛИТЬ П3/);
    assert.equal(R.gateFeedback(ask), "", "тот же код и причина — второй раз не шлём");
    assert.notEqual(R.gateFeedback({ ...ask, fp: "fp2" }), "", "код сменился — снова");
});

test("А4: просьба слота — самому слоту; автопоезд и «уже идёт» — никому", () => {
    R.gateFeedback({ tree: "wv9007-b", task: "web-test", input: "wv-1", by: "просьба агента", fp: "f", why: "дважды красный на этом же коде (j1, j2): без правки повтор даст то же" });
    assert.equal(sends.length, 1);
    assert.equal(sends[0].key, "wv9007-b");
    assert.match(sends[0].text, /сначала правка/);
    assert.equal(R.gateFeedback({ tree: "wv9007-b", task: "web-test", input: "wv-1", by: "автопоезд", fp: "f", why: "зелёный на этом же коде (j3)" }), "");
    assert.equal(R.gateFeedback({ tree: "wv9007-b", task: "web-test", input: "wv-2", by: "просьба агента", fp: "f", why: "уже в очереди (j4)" }), "");
    assert.equal(sends.length, 1);
});
