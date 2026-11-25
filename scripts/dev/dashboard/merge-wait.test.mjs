import { test, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-mwait-"));
process.env.DASH_DATA = path.join(TMP, "data");
process.env.DASH_DRY = "1";
process.env.DISPATCHER_WT = path.join(TMP, "wt");
process.env.DASH_EPIC_FILE = path.join(TMP, "epics.json");
process.env.DASH_ORCH_STEP_MS = "200";
fs.mkdirSync(process.env.DASH_DATA, { recursive: true });
fs.mkdirSync(path.join(TMP, "orch", ".git"), { recursive: true });

for (const s of ["wv9003-a", "wv9007-b"])
    fs.mkdirSync(path.join(TMP, "wt", s, ".git"), { recursive: true });

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
                slots: [
                    { slot: "wv9003-a", tag: "П3", branch: "dev/wv-9003", title: "а" },
                    { slot: "wv9007-b", tag: "П7", branch: "dev/wv-9007", title: "б" },
                ],
            },
        ],
    }),
);
await import("./wiring.mjs");
const { applyEpics } = await import("./trees.mjs");
const { loadInbox } = await import("./inbox.mjs");
const R = await import("./relay.mjs");
const L = await import("./loops.mjs");
const MW = await import("./merge-wait.mjs");
const { loadSessions } = await import("./agents.mjs");
const { loadJobs } = await import("./jobs.mjs");
const { loadOrchLog } = await import("./orchlog.mjs");
const { settings } = await import("./config.mjs");
const { S } = await import("./state.mjs");
const { flushSync, settled } = await import("./store.mjs");

after(async () => {
    await settled();
    flushSync();
    fs.rmSync(TMP, { recursive: true, force: true });
});

applyEpics();
loadInbox();
loadSessions();
loadJobs([]);
R.loadRelaySent();
R.loadTestReqs();
loadOrchLog();
MW.loadMergeWait();
const ORCH = "orchestrator@e1", SLOT = "wv9003-a", MIN = 60e3;
const orchAgent = (ownerText, at = Date.now()) => ({ key: ORCH, items: [{ id: "u1", t: "user", owner: true, text: ownerText, at }], rev: 1 });
const SEC = { id: "sec", ok: false, text: "гарды (Линтер, Типы) зелёные на этом коде", detail: "код менялся после последнего зелёного прогона гардов" };
const REG = { id: "regress", ok: false, text: "регресс по тронутым путям пройден (или снят вручную)", detail: "регресс шёл на другом коде" };
const CONFLICT = { id: "conflict", ok: false, text: "ветка вливается в staging без конфликтов", detail: "конфликтуют со staging (1): a.ts" };
let sends = [], queued = [], merged = [], checks = [], real = null, turn = 0;

const snapWith = (fp, o = {}) => {
    S.snap = { trees: [{ key: SLOT, kind: "slot", exists: true, fp, verdict: { merged: false, regress: o.regress || "stale" }, stages: [], review: o.review || null }] };
};

beforeEach(() => {
    sends = [];
    queued = [];
    merged = [];
    checks = [SEC, REG];
    R.orchFailSeen.clear();
    MW.loadMergeWait();
    S.mergeWait = { waits: {}, words: {} };
    loadJobs([]);
    snapWith("fp1");
    settings.mergeWait = undefined;
    real = real || { ...R._orchSteps };
    Object.assign(R._orchSteps, real, {
        send: (key, text) => sends.push({ key, text }),
        preflight: async () => ({ checks: checks.slice(), trees: [{ key: SLOT, branch: "dev/wv-9003" }] }),
        recipe: () => ({ treeKey: "orchestrator-staging", cwd: TMP, label: "Влить dev/wv-9003 в staging", lane: "git", steps: [] }),
        enqueue: async (o) => {
            merged.push(o);
            return { id: "j9" + merged.length };
        },
        queueChecks: async (key, need, direct) => {
            queued.push({ key, need: need.join(","), direct });
        },
    });
});

const vlit = (owner = "влей П3", text = "ВЛИТЬ П3") => R.orchGitCommands(orchAgent(owner), text, "msg_t" + ++turn);
const statusOf = () => JSON.parse(fs.readFileSync(path.join(process.env.DASH_DATA, "orch-commands.json"), "utf8")).items.filter((x) => x.cmd === "ВЛИТЬ").pop();

describe("правило (loops.mjs)", () => {
    test("mergeArm: только гарды, регресс и ревью — ожидание; конфликт, грязное дерево, порядок — отказ; «принудительно» и выключатель — как раньше", () => {
        assert.deepEqual(L.mergeArm({ fails: [SEC, REG] }), { arm: true, need: ["sec", "regress"] });
        assert.equal(L.mergeArm({ fails: [SEC, CONFLICT] }).arm, false);
        assert.equal(L.mergeArm({ fails: [{ id: "clean", ok: false }] }).arm, false);
        assert.equal(L.mergeArm({ fails: [SEC], force: true }).arm, false);
        assert.equal(L.mergeArm({ fails: [SEC], on: false }).arm, false);
    });
    test("mergeWaitStep: срок, помеха, зелёное, красное на этом коде, пауза до правки, постановка, «не встаёт»", () => {
        const now = 1e12, w = { state: "wait", until: now + 60 * MIN, queuedFp: "", queuedAt: 0, tries: 0 };
        assert.equal(L.mergeWaitStep({ w: { ...w, until: now - 1 }, checks: [SEC], now }).act, "expire");
        assert.equal(L.mergeWaitStep({ w, checks: [SEC, CONFLICT], now }).act, "cancel");
        assert.equal(L.mergeWaitStep({ w, checks: [{ id: "sec", ok: true }], now }).act, "merge");
        assert.deepEqual(L.mergeWaitStep({ w, checks: [SEC, REG], red: { regress: "регресс красный" }, fp: "f1", now }), { act: "red", need: ["sec", "regress"], why: "регресс красный" });
        assert.equal(L.mergeWaitStep({ w: { ...w, state: "red", redFp: "f1" }, checks: [REG], fp: "f1", now }).act, "hold", "на том же коде — пауза");
        assert.equal(L.mergeWaitStep({ w: { ...w, state: "red", redFp: "f1" }, checks: [REG], fp: "f2", now }).act, "resume", "код поправили — ждём снова");
        assert.equal(L.mergeWaitStep({ w, checks: [REG, { id: "clean", ok: false }], fp: "f1", now }).act, "wait", "агент коммитит — не отказ");
        assert.deepEqual(L.mergeWaitStep({ w, checks: [SEC], fp: "f1", now }), { act: "queue", need: ["sec"], direct: false });
        assert.equal(L.mergeWaitStep({ w: { ...w, queuedFp: "f1", queuedAt: now - MIN }, checks: [SEC], fp: "f1", now }).act, "wait");
        assert.equal(L.mergeWaitStep({ w: { ...w, queuedFp: "f1", queuedAt: now - 6 * MIN }, checks: [SEC], fp: "f1", now }).direct, true, "автопоезд не сдвинулся — задачи напрямую");
        const stuck = L.mergeWaitStep({ w: { ...w, queuedFp: "f1", queuedAt: now - 25 * MIN, tries: 2 }, checks: [SEC], fp: "f1", now });
        assert.equal(stuck.act, "red");
        assert.equal(stuck.stuck, true);
        assert.match(stuck.why, /не встали/);
        assert.equal(L.mergeWaitStep({ w: { ...w, queuedFp: "f1", queuedAt: now - 25 * MIN }, checks: [SEC], fp: "f1", now, live: true }).act, "wait", "идут — ждём");
    });
});

describe("ВЛИТЬ → ожидание → влив (relay.mjs)", () => {
    test("ВЛИТЬ без зелёных гардов и регресса — не отказ: ожидание записано в файл, слово владельца сохранено, оркестратору отказ не уходит", async () => {
        await vlit();
        const w = MW.mergeWaitOf(SLOT);
        assert.ok(w);
        assert.equal(w.state, "wait");
        assert.deepEqual(w.need, ["sec", "regress"]);
        assert.equal(statusOf().state, "ok");
        assert.match(statusOf().detail, /ждёт зелёного/);
        assert.equal(sends.length, 0, "«Команды не исполнены» не ушло");
        await settled();
        flushSync();
        const file = JSON.parse(fs.readFileSync(MW.MERGE_WAIT_FILE, "utf8"));
        assert.ok(file.waits[SLOT]);
        assert.equal(file.words[SLOT].orch, ORCH);
        MW.loadMergeWait();
        assert.ok(MW.mergeWaitOf(SLOT), "переживает перезапуск");
        assert.match(MW.mergeWaitView(SLOT).text, /ВЛИТЬ ждёт зелёного: гарды, регресс/);
    });
    test("шаг: недостающие проверки ставятся один раз на код; зелёное — влив сам, оркестратору сведение «Влито по ожиданию», слово израсходовано", async () => {
        await vlit();
        await R.mergeWaitTick(SLOT);
        await R.mergeWaitTick(SLOT);
        assert.deepEqual(queued, [{ key: SLOT, need: "sec,regress", direct: false }], "второй шаг на том же коде — не ставит снова");
        checks = [];
        let n = 0;
        const ask = R._orchSteps.preflight;
        R._orchSteps.preflight = async (...a) => {
            n++;
            return ask(...a);
        };
        await R.mergeWaitTick(SLOT);
        assert.equal(n, 0, "ничего не сдвинулось (код, концы прогонов, отметки станций) — проверка влива не повторяется");
        loadJobs([{ id: "j8", tree: SLOT, task: "lint", status: "ok", fpStart: "fp1", fpEnd: "fp1", endedAt: Date.now() }]);
        await R.mergeWaitTick(SLOT);
        assert.equal(merged.length, 1);
        assert.match(merged[0].extra.by, /ждал зелёного/);
        assert.equal(MW.mergeWaitOf(SLOT), null);
        assert.equal(MW.mergeWordOf(SLOT), null);
        assert.match(sends[0].text, /^\[Диспетчерская\] Влито по ожиданию/);
        assert.equal(L.orchWake(sends[0].text).wake, false, "сведение — без отдельного хода");
    });
    test("красное на нынешнем коде — пауза с причиной оркестратору; слово в силе: повтор без правки — отказ, правка и зелёное — влив без нового слова владельца", async () => {
        await vlit();
        loadJobs([{ id: "j7", tree: SLOT, task: "lint", status: "fail", fpStart: "fp1", fpEnd: "fp1", summary: "✗ lint — ошибок 3" }]);
        await R.mergeWaitTick(SLOT);
        assert.equal(MW.mergeWaitOf(SLOT).state, "red");
        assert.match(sends[0].text, /^\[Диспетчерская\] Влив П3 на паузе: гард «Линтер» красный на этом коде \(j7/);
        assert.match(sends[0].text, /владельца заново не спрашивай/);
        assert.equal(L.orchWake(sends[0].text).wake, true);
        await vlit("п3 почему застрял?");
        assert.equal(statusOf().state, "fail");
        assert.match(statusOf().detail, /уже на паузе/);
        assert.doesNotMatch(statusOf().detail, /нет слова/);
        snapWith("fp2");
        await R.mergeWaitTick(SLOT);
        assert.equal(MW.mergeWaitOf(SLOT).state, "wait");
        checks = [];
        loadJobs([{ id: "j9", tree: SLOT, task: "lint", status: "ok", fpStart: "fp2", fpEnd: "fp2", endedAt: Date.now() }]);
        await R.mergeWaitTick(SLOT);
        assert.equal(merged.length, 1, "влито по сохранённому слову, владельца второй раз не спрашивали");
    });
    test("помеха, которую ожидание не лечит (конфликт), — сразу отказ, как раньше; в ожидании — снятие с причиной, слово остаётся", async () => {
        checks = [SEC, CONFLICT];
        await vlit();
        assert.equal(MW.mergeWaitOf(SLOT), null);
        assert.match(sends[0].text, /Команды не исполнены/);
        sends = [];
        checks = [SEC];
        await vlit();
        checks = [SEC, CONFLICT];
        await R.mergeWaitTick(SLOT);
        assert.equal(MW.mergeWaitOf(SLOT), null);
        assert.match(sends[0].text, /^\[Диспетчерская\] Ожидание влива снято: П3 — ветка вливается/);
        assert.ok(MW.mergeWordOf(SLOT), "слово владельца до срока остаётся — повторный ВЛИТЬ без нового вопроса");
    });
    test("срок слова владельца истёк — ожидание и слово сняты, оркестратору причина", async () => {
        await vlit("влей П3");
        const w = MW.mergeWaitOf(SLOT);
        MW.setMergeWait(SLOT, { ...w, until: Date.now() - 1 });
        await R.mergeWaitTick(SLOT);
        assert.equal(MW.mergeWaitOf(SLOT), null);
        assert.match(sends[0].text, /срок слова владельца истёк/);
    });
    test("срок — от момента слова владельца (12 ч), а не от команды", async () => {
        await R.orchGitCommands(orchAgent("влей П3", Date.now() - 11 * 3600e3), "ВЛИТЬ П3", "msg_old" + ++turn);
        const left = MW.mergeWaitOf(SLOT).until - Date.now();
        assert.ok(left > 50 * MIN && left < 61 * MIN, String(left));
    });
    test("«ОТМЕНИТЬ ВЛИТЬ ПN» и кнопка снимают ожидание и гасят слово; выключатель settings.mergeWait=false — прежний отказ", async () => {
        await vlit();
        await R.orchGitCommands(orchAgent("отмени"), "ОТМЕНИТЬ ВЛИТЬ П3", "msg_c" + ++turn);
        assert.equal(MW.mergeWaitOf(SLOT), null);
        assert.equal(MW.mergeWordOf(SLOT), null);
        await vlit();
        assert.equal(R.cancelMergeWait(SLOT), true);
        assert.equal(MW.mergeWaitOf(SLOT), null);
        settings.mergeWait = false;
        await vlit();
        assert.equal(MW.mergeWaitOf(SLOT), null);
        assert.match(sends.pop().text, /Команды не исполнены:[\s\S]*гарды/);
    });
    test("владелец отзывает: «не вливай», «стоп» в его сообщении снимают ожидания этого оркестратора; обычные слова — нет", async () => {
        await vlit();
        assert.deepEqual(R.ownerStopsMergeWaits(ORCH, "П3 почему застрял? стопка тестов красная"), [], "«стопка» — не стоп");
        assert.ok(MW.mergeWaitOf(SLOT));
        assert.deepEqual(R.ownerStopsMergeWaits("orchestrator@другой", "не вливай"), []);
        assert.deepEqual(R.ownerStopsMergeWaits(ORCH, "П3 пока не вливай, есть вопрос"), ["П3"]);
        assert.equal(MW.mergeWaitOf(SLOT), null);
        assert.equal(MW.mergeWordOf(SLOT), null);
        await vlit();
        assert.deepEqual(R.ownerStopsMergeWaits(ORCH, "Стоп. Подожди."), ["П3"]);
    });
});
