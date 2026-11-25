// Сброс ветки слота (slot-reset.mjs): факты о папке → правило resetSlotPlan → исполнение; команда оркестратора «СБРОСИТЬ»
// только по слову человека; агент не зовёт сброс сам (вопрос человеку). Агент слота работает только на этой машине —
// сбрасывается только здешняя папка слота.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dash-slotreset-")));
const MAIN = path.join(TMP, "main"), WT = path.join(TMP, "wt"), SLOT = "wv1104-x", BR = "dev/wv-1104-x";
process.env.DASH_DATA = path.join(TMP, "data");
process.env.DASH_DRY = "1";
process.env.DISPATCHER_MAIN = MAIN;
process.env.DISPATCHER_WT = WT;
process.env.DASH_EPIC_FILE = path.join(TMP, "epics.json");
fs.mkdirSync(process.env.DASH_DATA, { recursive: true });
fs.mkdirSync(path.join(TMP, "orch", ".git"), { recursive: true });
fs.mkdirSync(MAIN, { recursive: true });
const g = (cwd, ...a) => String(spawnSync("git", a, { cwd, encoding: "utf8" }).stdout || "").trim();
g(MAIN, "init", "-q", "-b", "staging");
g(MAIN, "config", "user.email", "t@t");
g(MAIN, "config", "user.name", "t");
g(MAIN, "config", "core.autocrlf", "false");
fs.writeFileSync(path.join(MAIN, "a.txt"), "a\n");
g(MAIN, "add", "-A");
g(MAIN, "commit", "-q", "-m", "staging");
const STG = g(MAIN, "rev-parse", "HEAD");
g(MAIN, "worktree", "add", "-q", "-b", BR, path.join(WT, SLOT), STG);
fs.writeFileSync(path.join(WT, SLOT, "b.txt"), "лишний\n");
g(path.join(WT, SLOT), "add", "-A");
g(path.join(WT, SLOT), "commit", "-q", "-m", "лишний коммит");
const EXTRA = g(path.join(WT, SLOT), "rev-parse", "HEAD");
fs.writeFileSync(
    process.env.DASH_EPIC_FILE,
    JSON.stringify({
        active: "e1",
        epics: [
            {
                id: "e1",
                title: "т",
                status: "open",
                orch: { path: path.join(TMP, "orch"), branch: "orch/e1" },
                slots: [{ slot: SLOT, tag: "П2", branch: BR, title: "WV-1104", area: "api" }],
            },
        ],
    }),
);
await import("./wiring.mjs");
const { applyEpics } = await import("./trees.mjs");
const { EPIC_CLI } = await import("../slots.mjs");
const { setShardApi, noMachinesApi } = await import("./shard.mjs");
const { loadJobs, addJob } = await import("./jobs.mjs");
const SR = await import("./slot-reset.mjs");
const R = await import("./relay.mjs");
const A = await import("./agents.mjs");
const L = await import("./orchlog.mjs");
const { loadInbox } = await import("./inbox.mjs");

after(async () => {
    const st = await import("./store.mjs");
    await st.settled(); st.flushSync(); await st.settled();
    try {
        fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    catch { }
});

applyEpics();
loadInbox();
A.loadSessions();
loadJobs([]);
R.loadRelaySent();
R.loadTestReqs();
L.loadOrchLog();
beforeEach(() => {
    setShardApi(noMachinesApi());
    loadJobs([]);
});

test("сухой прогон: в ветке лишний коммит — план: тег-страховка на старую вершину, ветка — на staging", async () => {
    const r = await SR.slotReset({ key: SLOT, to: "staging", dry: true });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.equal(r.body.dry, true);
    assert.match(r.body.message, new RegExp("здесь: " + EXTRA.slice(0, 10) + " → " + STG.slice(0, 10) + "; снимаются коммиты \\(1\\): [0-9a-f]+ лишний коммит"));
    assert.match(r.body.message, /страховка: backup\/e1\/wv1104-x\/\d{4}-\d\d-\d\d-\d{4} → /);
    assert.match(r.body.message, /ничего не тронуто/);
    assert.equal(g(path.join(WT, SLOT), "rev-parse", "HEAD"), EXTRA, "сухой прогон ничего не двигает");
    assert.equal(g(MAIN, "tag", "--list", "backup/*"), "");
});

test("сухой экземпляр настоящий сброс не делает", async () => {
    const r = await SR.slotReset({ key: SLOT, to: "staging" });
    assert.equal(r.code, 409);
    assert.match(r.body.error, /сухой экземпляр/);
});

test("отказы из фактов: несохранённое в папке, прогон слота, неизвестный коммит, нет слота", async () => {
    fs.writeFileSync(path.join(WT, SLOT, "new.txt"), "x");
    try {
        const r = await SR.slotReset({ key: SLOT, dry: true });
        assert.equal(r.code, 409);
        assert.match(r.body.error, /в папке слота несохранённое \(1\): new\.txt/);
    }
    finally {
        fs.rmSync(path.join(WT, SLOT, "new.txt"));
    }
    addJob({ id: "j9", tree: SLOT, task: "api-test", status: "running", startedAt: Date.now() });
    assert.match((await SR.slotReset({ key: SLOT, dry: true })).body.error, /идут прогоны слота: j9/);
    loadJobs([]);
    assert.match((await SR.slotReset({ key: SLOT, to: "1234567", dry: true })).body.error, /не найден/);
    assert.equal((await SR.slotReset({ key: "nope", dry: true })).code, 404);
});

test("сброс на тот же коммит — «уже на месте»; назад по ветке — план со страховкой", async () => {
    const same = await SR.slotReset({ key: SLOT, to: EXTRA, dry: true });
    assert.equal(same.body.noop, true);
    assert.match(same.body.message, /сбрасывать нечего/);
    const back = await SR.slotReset({ key: SLOT, to: STG.slice(0, 9), dry: true });
    assert.equal(back.code, 200, JSON.stringify(back.body));
    assert.match(back.body.message, /страховка: backup\//);
});

const ORCH = "orchestrator@e1";
let sends = [], resets = [], real = null;

beforeEach(() => {
    sends = [];
    resets = [];
    R.orchFailSeen.clear();
    real = real || { ...R._orchSteps };
    Object.assign(R._orchSteps, real, { send: (key, text) => sends.push({ key, text }), reset: async (o) => {
            resets.push(o);
            return { code: 200, body: { ok: true, message: "П2: сброс ветки … ✓ сброшено" } };
        } });
});

const agentWith = (items) => ({ key: ORCH, items: items.map((x, i) => ({ id: "u" + i, t: "user", owner: true, at: Date.now(), ...x })), rev: items.length });

test("«СБРОСИТЬ П2» по слову владельца — сброс на staging, в журнале команд; «НА <sha>» — на коммит", async () => {
    await R.orchGitCommands(agentWith([{ text: "сбрось П2 на staging, лишний коммит не вливаем" }]), "Сбрасываю.\nСБРОСИТЬ П2", "msg_r1");
    assert.deepEqual(resets.map((x) => [x.key, x.to]), [[SLOT, "staging"]]);
    assert.match(resets[0].by, /по слову владельца/);
    const it = L.orchLogItems().find((x) => x.id.startsWith("msg_r1"));
    assert.equal(it.cmd, "СБРОСИТЬ");
    assert.equal(it.state, "ok");
    assert.equal(sends.length, 0);
    await R.orchGitCommands(agentWith([{ text: "откати П2 на b22331da47" }]), "СБРОСИТЬ П2 НА b22331da47", "msg_r2");
    assert.equal(resets[1].to, "b22331da47");
});

test("без слова самого владельца — не исполняется (автоответ «без владельца» не в счёт); чужой слот — отказ", async () => {
    await R.orchGitCommands(agentWith([{ text: "как там П2?" }]), "СБРОСИТЬ П2", "msg_r3");
    await R.orchGitCommands(agentWith([{ text: "ок" }, { text: "Рекомендованный ответ: сбрось", by: "auto-owner" }]), "СБРОСИТЬ П2", "msg_r4");
    await R.orchGitCommands(agentWith([{ text: "сбрось П9" }]), "СБРОСИТЬ П9", "msg_r5");
    assert.equal(resets.length, 0);
    const all = sends.map((s) => s.text).join("\n");
    assert.match(all, /«СБРОСИТЬ П2»: не исполнено: [^\n]*сбрось/);
    assert.match(all, /«СБРОСИТЬ П9»: нет такого слота/);
});

test("отказ сброса — оркестратору с причиной", async () => {
    R._orchSteps.reset = async () => ({ code: 409, body: { error: "П2: сброс не выполнен —\n  - агент слота запущен — сначала остановите его" } });
    await R.orchGitCommands(agentWith([{ text: "сбрось П2" }]), "СБРОСИТЬ П2", "msg_r6");
    assert.match(sends[0].text, /«СБРОСИТЬ П2»: не исполнено: П2: сброс не выполнен/);
});

test("агент, позвавший «epic.mjs reset-slot» без --dry-run, получает вопрос владельцу; сухой прогон и прочие команды epic.mjs — без вопроса", () => {
    const cli = "node " + EPIC_CLI + " reset-slot П2 --epic e1";
    assert.equal(A.protectedBash(cli), true);
    assert.equal(A.protectedBash(cli + " --to b22331da47"), true);
    assert.equal(A.protectedBash(cli + " --dry-run"), false);
    assert.equal(A.protectedBash("node " + EPIC_CLI + " status e1"), false);
});
