import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DASH_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dash-idle-"));
process.env.DASH_DRY = "1";
after(() => fs.rmSync(process.env.DASH_DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
const A = await import("./agents.mjs");
const { orchNudgeDue } = await import("./loops.mjs");
const MIN = 60e3, now = 10000 * MIN;
const base = { now, busy: false, queued: false, liveJobs: 0, lastWork: now - (A.IDLE_NUDGE_MIN + 1) * MIN, orchSawAt: 0, lastNudge: 0, slotsWithSession: 3, slotsWaitingOwner: 1, idleMs: A.IDLE_NUDGE_MIN * MIN, everyMs: A.IDLE_NUDGE_EVERY_MIN * MIN };
const due = (o) => orchNudgeDue({ ...base, ...o }).due;

describe("сторож простоя", () => {
    test("никто не работает дольше порога, очередей нет, не все ждут владельца — толкаем", () => assert.equal(due({}), true));
    test("кто-то работает, передача в очереди или идут прогоны — не толкаем", () => {
        assert.equal(due({ busy: true }), false);
        assert.equal(due({ queued: true }), false);
        assert.equal(due({ liveJobs: 2 }), false);
    });
    test("простой меньше порога — не толкаем", () => assert.equal(due({ lastWork: now - 5 * MIN }), false));
    test("все слоты ждут владельца или слотов с сессией нет — оркестратора не будим", () => {
        assert.equal(due({ slotsWaitingOwner: 3 }), false);
        assert.equal(due({ slotsWithSession: 0 }), false);
    });
    test("не чаще раза в час и не второй раз подряд без работы между толчками", () => {
        assert.equal(due({ lastNudge: now - 30 * MIN, lastWork: now - 40 * MIN }), false, "толкнули 30 мин назад");
        assert.equal(due({ lastNudge: now - 90 * MIN, lastWork: now - 100 * MIN }), false, "после толчка никто ничего не сделал");
        assert.equal(due({ lastNudge: now - 90 * MIN, lastWork: now - 61 * MIN }), true, "после толчка была работа, снова час простоя");
    });
    test("текст сторожа — не слово владельца и с выходом «ждём»", () => {
        assert.match(A.IDLE_NUDGE_TEXT, /^\[Диспетчерская/);
        assert.match(A.IDLE_NUDGE_TEXT, /ждём/);
    });
});

describe("возобновление после перезапуска", () => {
    test("будятся только агенты с отметкой «на середине хода», оркестратор первым", () => {
        const sessions = { wv1: { id: "a", mid: 5 }, "orchestrator@e": { id: "b", mid: 7 }, wv2: { id: "c" }, wv3: { id: "d", mid: 9 } };
        assert.deepEqual(A.interruptedKeys(["wv1", "wv2", "wv3", "orchestrator@e", "wv4"], sessions), ["orchestrator@e", "wv1", "wv3"]);
    });
    test("текст возобновления велит смотреть git status и не начинать с нуля", () => {
        assert.match(A.RESUME_TEXT, /git status/);
        assert.match(A.RESUME_TEXT, /С нуля не начинай/);
    });
});

describe("порядок влива — командой оркестратора", () => {
    test("«ПОРЯДОК П7 ПОСЛЕ П6» и «ПОРЯДОК П6 П8 НЕ СВЯЗАНЫ» разбираются, упоминание в тексте — нет", async () => {
        const src = fs.readFileSync(new URL("./relay.mjs", import.meta.url), "utf8"), m = /export const ORCH_ORDER_RE = (\/.+\/gim)/.exec(src);
        const re = eval(m[1]), parse = (s) => [...s.matchAll(re)].map((x) => [x[1], x[2] ? "after" : "none", x[3] || x[4]]);
        assert.deepEqual(parse("ПОРЯДОК П7 ПОСЛЕ П6"), [["П7", "after", "П6"]]);
        assert.deepEqual(parse("- **ПОРЯДОК П6 П8 НЕ СВЯЗАНЫ**"), [["П6", "none", "П8"]]);
        assert.deepEqual(parse("пиши строку ПОРЯДОК П1 ПОСЛЕ П2 отдельно"), []);
    });
    test("правило оркестратора о конфликтах: порядок ставит он, храповики пересобираются, владельца не спрашивать", () => {
        const src = fs.readFileSync(new URL("./agents.mjs", import.meta.url), "utf8");
        assert.match(src, /КОНФЛИКТЫ ВЕТОК ПО ОБЩИМ ФАЙЛАМ/);
        assert.match(src, /базовые линии/, "храповики гардов пересобираются командой гарда, а не сливаются руками");
        assert.match(src, /Владельца по порядку влива не спрашивай/);
    });
});

describe("отказ команды оркестратора доходит до него", () => {
    test("неисполненная команда — сообщение с подсказкой; та же причина повторно в 30 мин не уходит", async () => {
        const R = await import("./relay.mjs"), now = 5e12;
        const msg = R.orchFailFeedback("orchestrator@t", ["«ВЛИТЬ П9»: не исполнено: сначала влита П3"], now);
        assert.match(msg, /^\[Диспетчерская\] Команды не исполнены:\n- «ВЛИТЬ П9»/);
        assert.match(msg, /влей сначала ту ветку, от которой эта зависит/);
        assert.equal(R.orchFailFeedback("orchestrator@t", ["«ВЛИТЬ П9»: не исполнено: сначала влита П3"], now + 60e3), "", "повтор не шлём");
        assert.notEqual(R.orchFailFeedback("orchestrator@t", ["«ВЛИТЬ П9»: не исполнено: сначала влита П3"], now + 31 * 60e3), "", "через 30 мин — снова");
    });
});

describe("правила темпа", () => {
    test("стартовый промпт слота: станции подряд, один доклад в конце, без «остановись до вывода»", () => {
        const src = fs.readFileSync(new URL("./agents.mjs", import.meta.url), "utf8");
        assert.ok(!/остановись до его вывода/.test(src));
        assert.match(src, /Промежуточных докладов по станциям не шли/);
        assert.match(src, /ТЕМП СЛОТОВ/);
    });
    test("персона слота: разведка — не отдельный ответ, есть раздел «Когда заканчивать ход»", () => {
        const p = fs.readFileSync(new URL("../../../agent-briefs/SLOT-ENGINEER-persona.md", import.meta.url), "utf8");
        assert.ok(!/Первый ответ после стартового промпта — доклад разведки/.test(p));
        assert.match(p, /КОГДА ЗАКАНЧИВАТЬ ХОД ДОКЛАДОМ/);
    });
});

describe("просьбы о тестах — не висят после влива", () => {
    test("влитая ветка — просьба снята; ветки нет в снимке — карточки нет", async () => {
        const R = await import("./relay.mjs"), { S } = await import("./state.mjs");
        S.jobs = [];
        S.snap = { trees: [{ key: "wvA", verdict: { merged: true }, suites: [] }, { key: "wvB", verdict: { merged: false }, suites: [] }] };
        S.testReqs = { wvA: [{ id: "t1", task: "lint", input: "", at: 1 }], wvB: [{ id: "t2", task: "lint", input: "", at: 1 }], wvC: [{ id: "t3", task: "lint", input: "", at: 1 }] };
        const out = R.testReqsPublic();
        assert.deepEqual(out.map((g) => g.tree), ["wvB"]);
        assert.equal(S.testReqs.wvA, undefined, "влитая — удалена");
        assert.ok(S.testReqs.wvC, "вне снимка — хранится, но не показывается");
    });
});
