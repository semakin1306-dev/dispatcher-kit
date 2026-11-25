import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { epicCounters, epicProgress, waveTimeline, idleSpans, holdReason, turnAct, unionSpans, reasonKind, normReason, DAY_MS } from "./epic-progress-rules.mjs";

const H = 3600e3, M = 60e3;
const T0 = Date.parse("2026-11-08T11:00:00Z");
const at = (h, m = 0) => T0 + h * H + m * M;
const ORCH = "orchestrator@ep";

const EPIC = { id: "ep", slots: [
        { tag: "П3", slot: "wv0998-a", branch: "dev/wv-0998-a" },
        { tag: "П7", slot: "wv1002-b", branch: "dev/wv-1002-b" },
        { tag: "П8", slot: "wv1003-c", branch: "dev/wv-1003-c" },
    ] };

const commit = (id, slot, t) => ({ id, epic: "ep", tree: slot, task: "commit", status: "ok", queuedAt: t - M, startedAt: t - M, endedAt: t });
const merge = (id, branch, t) => ({
    id,
    epic: null,
    tree: "orchestrator-staging",
    task: "merge",
    status: "ok",
    label: "Влить " + branch + " в staging",
    queuedAt: t - M,
    startedAt: t - M,
    endedAt: t,
    mergeSha: { [branch]: "abc" },
});

function night() {
    const runs = [
        commit("j1", "wv0998-a", at(7, 30)),
        commit("j2", "wv1002-b", at(8, 45)),
        commit("j3", "wv1003-c", at(12, 0)),
        merge("j4", "dev/wv-1003-c", at(13, 39)),
        merge("j5", "dev/wv-0998-a", at(18, 40)),
        merge("j6", "dev/wv-1002-b", at(18, 45)),
    ];
    const events = [
        { at: at(0), type: "slot.provision", key: "wv0998-a" },
        { at: at(0, 5), type: "slot.provision", key: "wv1002-b" },
        { at: at(0, 10), type: "slot.provision", key: "wv1003-c" },
        {
            at: at(8, 49),
            type: "orch.command",
            tree: ORCH,
            cmd: "ВЛИТЬ",
            target: "П7",
            ok: false,
            detail: "не исполнено: в последнем сообщении владельца нет слова «влей».",
        },
        { at: at(8, 49), type: "agent.turn", key: ORCH, act: true, in: 10, cr: 100000, cw: 0, out: 500 },
        ...[10, 11, 12, 14, 15, 16, 17]
            .map((h) => [
                { at: at(h, 28), type: "idle.nudge", key: ORCH },
                { at: at(h, 29), type: "agent.turn", key: ORCH, act: false, in: 5, cr: 200000, cw: 1000, out: 300 },
            ])
            .flat(),
        {
            at: at(13, 33),
            type: "orch.command",
            tree: ORCH,
            cmd: "ВЛИТЬ",
            target: "П8",
            ok: true,
            detail: "вливаю dev/wv-1003-c в staging (j4).",
        },
        { at: at(18, 38), type: "owner.message", key: ORCH, chars: 20 },
        {
            at: at(18, 39),
            type: "orch.command",
            tree: ORCH,
            cmd: "ВЛИТЬ",
            target: "П3",
            ok: true,
            detail: "вливаю (j5)",
        },
        {
            at: at(18, 40),
            type: "orch.command",
            tree: ORCH,
            cmd: "ВЛИТЬ",
            target: "П7",
            ok: true,
            detail: "вливаю (j6)",
        },
        { at: at(5), type: "agent.turn", key: "wv1003-c", in: 100, cr: 50000, cw: 2000, out: 4000, cost: 0.5 },
        { at: at(5, 50), type: "agent.turn", key: "wv1003-c", in: 100, cr: 60000, cw: 0, out: 1000, cost: 0.25 },
    ];
    return { runs, events };
}

describe("готово, но не влито", () => {
    test("ожидание от последнего коммита до влива, волна-часы за окно, без тревоги у влитых", () => {
        const { runs, events } = night(), p = epicProgress({ epic: EPIC, events, runs, now: at(20), windowMs: DAY_MS });
        const by = Object.fromEntries(p.ready.map((r) => [r.tag, r]));
        assert.equal(by["П3"].waitMin, 11 * 60 + 10);
        assert.equal(by["П7"].waitMin, 10 * 60);
        assert.equal(by["П8"].waitMin, 99);
        assert.equal(p.readyNow, 0);
        assert.equal(p.readyWaveH, Math.round((11 + 10 / 60 + 10 + 99 / 60) * 10) / 10);
    });
    test("невлитая волна: сколько ждёт, что держит, тревога после 30 мин", () => {
        const { runs, events } = night(), now = at(9, 30);
        const p = epicProgress({ epic: EPIC, events, runs: runs.filter((r) => (r.endedAt || 0) <= now), now });
        const p7 = p.ready.find((r) => r.tag === "П7"), p3 = p.ready.find((r) => r.tag === "П3");
        assert.equal(p.readyNow, 2);
        assert.equal(p7.mergedAt, null);
        assert.equal(p7.waitMin, 45);
        assert.equal(p7.alarm, true);
        assert.equal(p7.hold.kind, "слово владельца");
        assert.equal(p3.hold.kind, "нет команды ВЛИТЬ");
    });
    test("новый коммит после готовности — отсчёт заново; после влива — снова с нуля", () => {
        const runs = [commit("a", "wv0998-a", at(1)), commit("b", "wv0998-a", at(3)), merge("m", "dev/wv-0998-a", at(4)), commit("c", "wv0998-a", at(6))];
        const w = waveTimeline(EPIC, [], runs).find((x) => x.tag === "П3");
        assert.deepEqual(w.spans, [{ readyAt: at(3), mergedAt: at(4) }, { readyAt: at(6), mergedAt: null }]);
    });
    test("ручная отметка станции «Коммит» тоже делает волну готовой", () => {
        const w = waveTimeline(EPIC, [{ at: at(2), type: "stage.mark", tree: "wv1002-b", stage: "commit", value: true }], []).find((x) => x.tag === "П7");
        assert.deepEqual(w.spans, [{ readyAt: at(2), mergedAt: null }]);
    });
});

describe("что держит", () => {
    const slot = { slot: "wv1002-b", tag: "П7", orch: ORCH };
    test("тупик важнее более раннего отказа; поздний блок ворот — последнее слово", () => {
        const ev = [
            { at: at(1), type: "orch.command", tree: ORCH, cmd: "ВЛИТЬ", target: "П7", ok: false, detail: "не исполнено: регресс по тронутым путям не пройден" },
            { at: at(2), type: "deadlock", tree: "wv1002-b", orch: ORCH, what: "ВЛИТЬ П7", why: "регресс не пройден" },
        ];
        assert.equal(holdReason(slot, ev, at(0)).kind, "тупик");
        assert.equal(holdReason(slot, [...ev, { at: at(3), type: "gate.blocked", tree: "wv1002-b", task: "api-test", why: "волна закоммичена" }], at(0)).kind, "ворота");
    });
    test("отказ до готовности не в счёт; ВЛИТЬ ok — влив в очереди; П1 не путается с П17", () => {
        const ev = [
            { at: at(1), type: "orch.command", tree: ORCH, cmd: "ВЛИТЬ", target: "П7", ok: false, detail: "нет слова «влей»" },
            { at: at(3), type: "orch.command", tree: ORCH, cmd: "ВЛИТЬ", target: "П17", ok: false, detail: "конфликт" },
        ];
        assert.equal(holdReason(slot, ev, at(2)).kind, "нет команды ВЛИТЬ");
        assert.equal(holdReason(slot, [...ev, { at: at(4), type: "orch.command", tree: ORCH, cmd: "ВЛИТЬ ПРИНУДИТЕЛЬНО", target: "П7", ok: true, detail: "вливаю" }], at(2)).kind, "влив в очереди");
    });
    test("разбор причины отказа", () => {
        assert.equal(reasonKind("не исполнено: в последнем сообщении владельца нет слова «влей»."), "слово владельца");
        assert.equal(reasonKind("сначала влита П3: эта волна стоит на её коде; порядок"), "порядок");
        assert.equal(reasonKind("security:check не зелёный на этом коде"), "красное");
        assert.equal(reasonKind("прервано перезапуском диспетчерской"), "перезапуск");
        assert.equal(normReason("вливаю (j2387) 13b3fa7 за 3 мин"), "вливаю # за N мин");
    });
});

describe("простой эпика", () => {
    test("ночь: ответы «ждём» сторожу — не работа; простой рвут только коммит и влив П8; причина — готовые волны и отказ ВЛИТЬ", () => {
        const { runs, events } = night(), p = epicProgress({ epic: EPIC, events, runs, now: at(20), windowMs: 20 * H });
        const night_ = p.idle.spans.filter((s) => s.from >= at(8, 49));
        assert.deepEqual(night_.map((s) => [s.from, s.to]), [[at(8, 49), at(12) - M], [at(12), at(13, 33)], [at(13, 39), at(18, 38)]]);
        assert.match(night_[0].why, /готово, не влито: П3, П7/);
        assert.match(night_[0].why, /ждём слова владельца: ВЛИТЬ П7/);
        assert.equal(night_.reduce((s, x) => s + x.min, 0), (3 * 60 + 10) + 93 + (4 * 60 + 59));
    });
    test("волна после последнего влива без новой работы закрыта — после влива простоя нет", () => {
        const runs = [commit("a", "wv0998-a", at(1)), merge("m", "dev/wv-0998-a", at(2))];
        const ep = { id: "ep", slots: [EPIC.slots[0]] };
        const p = epicProgress({ epic: ep, events: [{ at: at(0), type: "slot.provision", key: "wv0998-a" }], runs, now: at(10), windowMs: 10 * H });
        assert.ok(p.idle.spans.every((s) => s.to <= at(2)));
        assert.equal(p.idle.openMin, 120);
    });
    test("снятая в архив волна открыта не дольше отметки архива", () => {
        const ep = { id: "ep", slots: [{ ...EPIC.slots[0], archived: new Date(at(3)).toISOString() }] };
        const w = waveTimeline(ep, [{ at: at(0), type: "slot.provision", key: "wv0998-a" }], [])[0];
        assert.equal(w.openTo, at(3));
    });
    test("idleSpans: занятость режет открытый отрезок, короче порога — не простой", () => {
        const s = idleSpans({ open: [[0, 100 * M]], work: [[10 * M, 20 * M], 30 * M, [90 * M, 95 * M]], from: 0, to: 100 * M });
        assert.deepEqual(s.map((x) => [x.from / M, x.to / M]), [[30, 90]]);
        assert.deepEqual(unionSpans([[5, 8], [1, 3], [2, 6]]), [[1, 8]]);
    });
});

describe("команды, перезапуски, касания владельца, токены", () => {
    test("отказы и «не понял» по командам, частые причины без номеров", () => {
        const ev = [
            { at: at(1), type: "orch.command", tree: ORCH, cmd: "ПРОГНАТЬ", target: "П4", ok: true, detail: "поставлено: api-test (j1); не понял: wv-0996, admin-offers" },
            { at: at(2), type: "orch.command", tree: ORCH, cmd: "ВЛИТЬ", target: "П7", ok: false, detail: "не исполнено: нет слова «влей» (j2380)" },
            { at: at(3), type: "orch.command", tree: ORCH, cmd: "ВЛИТЬ", target: "П9", ok: false, detail: "не исполнено: нет слова «влей» (j2381)" },
            { at: at(4), type: "orch.command", tree: ORCH, cmd: "ВЛИТЬ", target: "П9", ok: false, detail: "прервано перезапуском диспетчерской" },
            { at: at(5), type: "orch.command", tree: "orchestrator@other", cmd: "ВЛИТЬ", target: "П1", ok: false, detail: "чужой эпик" },
            { at: at(5), type: "deadlock", tree: "wv1002-b", orch: ORCH, what: "ВЛИТЬ П7", why: "x" },
            { at: at(5), type: "gate.blocked", tree: "wv1002-b", task: "security", why: "y" },
        ];
        const c = epicProgress({ epic: EPIC, events: ev, runs: [], now: at(6) }).commands;
        assert.deepEqual(c.byCmd["ПРОГНАТЬ"], { n: 1, fail: 0, partial: 1 });
        assert.deepEqual(c.byCmd["ВЛИТЬ"], { n: 3, fail: 3, partial: 0 });
        assert.deepEqual(c.topReasons[0], { why: "ВЛИТЬ: не исполнено: нет слова «влей»", n: 2 });
        assert.equal(c.deadlocks, 1);
        assert.equal(c.gateBlocked, 1);
    });
    test("перезапуски: сухие не считаются; прерванные прогоны эпика и оборванные команды", () => {
        const ev = [
            { at: at(1), type: "server.start", sha: "903f1f3", reason: "по слову владельца", prev: { silentS: 35 } },
            { at: at(2), type: "server.start", sha: "x", dry: true },
            { at: at(2), type: "orch.command", tree: ORCH, cmd: "ВЛИТЬ", target: "П3", ok: false, detail: "прервано перезапуском диспетчерской" },
        ];
        const runs = [{ id: "j9", epic: "ep", tree: "wv0998-a", task: "api-test", status: "interrupted", bootInterrupted: true, queuedAt: at(1), endedAt: at(1) }];
        const r = epicProgress({ epic: EPIC, events: ev, runs, now: at(3) }).restarts;
        assert.deepEqual(r.starts, [{ at: at(1), sha: "903f1f3", reason: "по слову владельца", silentS: 35 }]);
        assert.equal(r.interrupted, 1);
        assert.equal(r.cutCommands, 1);
    });
    test("касания владельца и ходы оркестратора без действия с их токенами; токены слотов на сервере", () => {
        const { runs, events } = night(), p = epicProgress({ epic: EPIC, events, runs, now: at(20), windowMs: DAY_MS, live: { questions: 2 } });
        assert.deepEqual({ ...p.owner }, { messages: 1, answers: 0, questions: 2, nudges: 7, orchTurns: 8, emptyTurns: 7, emptyTok: 7 * (5 + 200000 + 1000 + 300) });
        const slot = p.tokens.find((t) => t.key === "wv1003-c");
        assert.deepEqual(slot, { key: "wv1003-c", tag: "П8", turns: 2, in: 200, out: 5000, cr: 110000, cw: 2000, cost: 0.75 });
        assert.equal(p.tokens[0].tag, "ОРК");
        assert.equal(p.turnsTracked, true);
    });
});

describe("ход агента (agent.turn)", () => {
    test("действие оркестратора: блок slot:, строки команд, «Вопросы владельцу:»; «ждём» — не действие", () => {
        assert.equal(turnAct("```slot: П3\nсделай\n```"), true);
        assert.equal(turnAct("Итог.\n\nВЛИТЬ П3\n"), true);
        assert.equal(turnAct("- ПРОГНАТЬ П4: api-test=wv-0999"), true);
        assert.equal(turnAct("ПОРЯДОК П7 ПОСЛЕ П6"), true);
        assert.equal(turnAct("**Вопросы владельцу:**\n1. влить?"), true);
        assert.equal(turnAct("Ждём: слова «влей» по П7. Ничего не делаю."), false);
        assert.equal(turnAct("напишу ВЛИТЬ П3, когда владелец ответит"), false);
    });
});

describe("счётчики эпика ", () => {
    const E = { id: "ep", slots: [
            { tag: "П1", slot: "s1", presets: [{ task: "api-test", input: "wv-1" }, { task: "web-test", input: "x" }] },
            { tag: "Т2", slot: "tr2", kind: "train", wagons: [{ wave: "WV-0002", presets: [{ task: "web-test", input: "wv-2" }] }] },
        ] };
    const run = (id, tree, task, status, min, extra = {}) => ({ id, tree, task, status, input: "", queuedAt: at(1), startedAt: at(1), endedAt: at(1) + min * M, ...extra });
    test("регресс: тестовая задача проекта не из тестов волны этого дерева; тесты волны и чужие деревья — не регресс; гарды — по станции «Гарды»; потерянные отдельно", () => {
        const runs = [
            run("a", "s1", "api-test", "ok", 10), run("b", "s1", "api-test", "interrupted", 20), run("c", "s1", "web-test", "cancelled", 5),
            run("d", "s1", "api-test", "ok", 3, { input: "wv-1" }), run("e", "s1", "api-test", "fail", 4, { input: "x\.spec\.ts|y\.test\.ts" }),
            run("f", "s1", "web-test", "ok", 1, { input: "x" }), run("g", "s1", "web-test", "ok", 2, { input: "wv-2" }), run("h", "tr2", "web-test", "ok", 2, { input: "wv-2" }),
            run("i", "s1", "review", "ok", 3), run("j", "s1", "review", "fail", 3, { review: { verdict: "ВОПРОСЫ" } }), run("k", "s1", "review", "interrupted", 1),
            run("l", "s1", "lint", "ok", 6), run("m", "s1", "typecheck", "fail", 4), run("n", "чужой", "api-test", "ok", 50), run("o", "s1", "api-test", "running", 0),
        ];
        const c = epicCounters({ epic: E, events: [], runs, from: at(0), to: at(5) });
        assert.deepEqual(c.regress, { runs: 5, min: 41, done: 3, doneMin: 16, lost: 2, lostMin: 25 });
        assert.deepEqual(c.review, { runs: 2, questions: 1 });
        assert.deepEqual(c.security, { runs: 2, min: 10 });
        assert.equal(c.runs, 13);
    });
    test("пик агентов слотов в час и p50; ходы оркестратора и чужих — не в счёт; счётчика отправок поездов нет", () => {
        const ev = [{ at: at(1, 1), type: "agent.turn", key: "s1" }, { at: at(1, 2), type: "agent.turn", key: "tr2" }, { at: at(1, 3), type: "agent.turn", key: "s1" },
            { at: at(2, 1), type: "agent.turn", key: "s1" }, { at: at(2, 2), type: "agent.turn", key: ORCH }, { at: at(3, 1), type: "agent.turn", key: "чужой" },
            { at: at(2, 5), type: "train.depart", tree: "tr2" }];
        const c = epicCounters({ epic: E, events: ev, runs: [], from: at(0), to: at(5) });
        assert.deepEqual(c.agents, { peak: 2, p50: 1, hours: 2 });
        assert.equal(c.trains, undefined, "составов нет — и счётчика отправок");
    });
    test("повторы на том же коде — сверх первого, без прерванных, коммитов и вливов; потерянные — все прерванные и отменённые", () => {
        const fp = { fpStart: "f1" };
        const runs = [
            run("a", "s1", "review", "fail", 3, fp), run("b", "s1", "review", "fail", 4, fp), run("c", "s1", "review", "ok", 5, fp),
            run("d", "s1", "review", "ok", 3, { fpStart: "f2" }), run("e", "s1", "api-test", "ok", 2, { ...fp, input: "a" }), run("f", "s1", "api-test", "ok", 2, { ...fp, input: "b" }),
            run("g", "s1", "web-test", "interrupted", 7, fp), run("h", "s1", "web-test", "ok", 6, fp), run("i", "s1", "web-test", "cancelled", 1, { input: "все" }),
            run("k", "s1", "commit", "ok", 1, fp), run("l", "s1", "commit", "ok", 1, fp),
        ];
        const c = epicCounters({ epic: E, events: [], runs, from: at(0), to: at(5) });
        assert.deepEqual({ runs: c.repeats.runs, min: c.repeats.min }, { runs: 2, min: 9 });
        assert.deepEqual(c.repeats.top[0], { tree: "s1", task: "review", input: "", n: 3, ids: ["b", "c"] });
        assert.deepEqual(c.lost, { runs: 2, min: 8 });
    });
    test("простой на вопросах — до ответа, сообщения владельца, автоответа или хода агента через минуту; открытые — до конца окна", () => {
        const q = (h, m, tree) => ({ at: at(h, m), type: "owner.question", tree });
        const ev = [
            q(1, 0, "s1"), { at: at(1, 0), type: "agent.turn", key: "s1" }, q(1, 10, "s1"), { at: at(1, 30), type: "owner.answer", key: "s1" },
            q(2, 0, ORCH), { at: at(2, 45), type: "owner.message", key: ORCH },
            q(3, 0, "tr2"), { at: at(3, 20), type: "agent.turn", key: "tr2" },
            q(3, 30, "s1"), { at: at(3, 35), type: "auto.owner", tree: "s1" },
            q(4, 0, "чужой"), q(4, 30, "s1"),
        ];
        const c = epicCounters({ epic: { id: "ep", slots: E.slots }, events: ev, runs: [], from: at(0), to: at(5) });
        assert.equal(c.questions.n, 6);
        assert.equal(c.questions.waitMin, 30 + 45 + 20 + 5 + 30);
        assert.equal(c.questions.open, 1);
        assert.deepEqual(c.questions.longest[0], { key: ORCH, from: at(2), min: 45 });
    });
    test("ожидание, начатое до окна, считается только внутри окна", () => {
        const ev = [{ at: at(0), type: "owner.question", tree: "s1" }, { at: at(3), type: "owner.answer", key: "s1" }];
        assert.equal(epicCounters({ epic: E, events: ev, runs: [], from: at(2), to: at(5) }).questions.waitMin, 60);
    });
    test("сводка «Ход эпика» несёт счётчики", () => {
        const { runs, events } = night();
        assert.ok(epicProgress({ epic: EPIC, events, runs, now: at(20) }).counters.runs >= 3);
    });
    test("прогоны дерева состава <поезд>-c — прогоны эпика (ревью с вопросами состава видны); стенд — не прогоны слотов", () => {
        const runs = [run("r1", "tr2-c", "review", "fail", 3, { review: { verdict: "ВОПРОСЫ" } }), run("r2", "tr2-c", "web-test", "ok", 2), run("x", "s1-c", "review", "fail", 3),
            run("st", "orchestrator-staging", "accept-run", "ok", 30, { epic: "ep" })];
        const c = epicCounters({ epic: E, events: [], runs, from: at(0), to: at(5) });
        assert.deepEqual(c.review, { runs: 1, questions: 1 }, "s1 не поезд — s1-c не его дерево");
        assert.equal(c.runs, 2);
    });
    test("вопрос оркестратора не закрывается его же следующим ходом; переспрос при открытом — не новое ожидание", () => {
        const ev = [{ at: at(1), type: "owner.question", tree: ORCH }, { at: at(1, 5), type: "agent.turn", key: ORCH }, { at: at(2), type: "owner.question", tree: ORCH },
            { at: at(3), type: "agent.turn", key: ORCH }, { at: at(4), type: "owner.answer", key: ORCH }];
        const c = epicCounters({ epic: E, events: ev, runs: [], from: at(0), to: at(5) });
        assert.equal(c.questions.waitMin, 180);
        assert.equal(c.questions.n, 2);
        assert.equal(c.questions.waits, 1);
    });
});

describe("простой эпика с поездами и стендом", () => {
    const TE = { id: "ep", slots: [{ tag: "Т4", slot: "tr4", branch: "dev/tr4", wagons: [{ wave: "WV-1068" }] }] };
    const run = (id, tree, task, h0, h1, extra = {}) => ({ id, tree, task, status: "ok", input: "", queuedAt: at(h0), startedAt: at(h0), endedAt: at(h1), ...extra });
    const base = () => ({
        runs: [
            run("c1", "tr4", "commit", 1, 1.05),
            run("m1", "orchestrator-staging", "merge", 2, 2.05, {
                label: "Влить dev/tr4-c3 в staging",
                mergeSha: { "dev/tr4-c3": "ab" },
            }),
            run("c2", "tr4", "commit", 3, 3.05),
        ],
        events: [{ at: at(0), type: "slot.provision", key: "tr4" }],
    });
    test("влив состава dev/<поезд>-cN — влив поезда; выкат и приёмка стенда после первого влива эпика — работа, а не простой", () => {
        const { runs, events } = base();
        const tl = waveTimeline(TE, events, runs)[0];
        assert.deepEqual(tl.merges, [at(2, 3)]);
        const idle0 = epicProgress({ epic: TE, events, runs, now: at(8), windowMs: 8 * H }).idle.spans.filter((s) => s.from >= at(3, 3));
        assert.ok(idle0.length && idle0[0].min > 200, "без стенда — простой после коммита");
        const stand = [
            run("d", "orchestrator-staging", "deploy-staging", 3.1, 3.4),
            run("a", "orchestrator-staging", "accept-run", 3.4, 7.9),
            run("early", "orchestrator-staging", "accept-run", 0, 1.9),
        ];
        const p = epicProgress({ epic: TE, events, runs: [...runs, ...stand], now: at(8), windowMs: 8 * H });
        assert.deepEqual(p.idle.spans.filter((s) => s.from >= at(3, 3)), [], "стенд работал за эпик");
        assert.ok(p.idle.spans.some((s) => s.from < at(1) && s.to <= at(1)), "приёмка до первого влива эпика — не его работа");
    });
    test("причина простоя: ждём ответа ОРК; «уже зелёный» и отказ старше получаса — не причина; диспетчерская стояла", () => {
        const { runs, events } = base();
        const ev = [...events,
            { at: at(3, 10), type: "gate.blocked", tree: "tr4", task: "build", why: "зелёный на этом же коде (j1)" },
            { at: at(3, 15), type: "owner.question", tree: ORCH },
            { at: at(5), type: "server.start", prev: { silentS: 3600 }, stop: { kind: "pc-off" } },
            { at: at(7), type: "owner.answer", key: ORCH }];
        const p = epicProgress({ epic: TE, events: ev, runs, now: at(8), windowMs: 8 * H });
        const s = p.idle.spans.find((x) => x.from >= at(3, 3) && x.from <= at(3, 20));
        assert.ok(s, JSON.stringify(p.idle.spans));
        assert.doesNotMatch(s.why, /ворота/);
        assert.match(s.why, /ждём ответа владельца: ОРК/);
        assert.match(s.why, /диспетчерская стояла 60 мин \(ПК выключен\)/);
        const old = [...events, { at: at(1, 30), type: "orch.command", tree: ORCH, cmd: "ОТПРАВИТЬ", target: "Т4", ok: false, detail: "не исполнено: поезд уже отправляется" }];
        const s2 = epicProgress({ epic: TE, events: old, runs, now: at(8), windowMs: 8 * H }).idle.spans.find((x) => x.from >= at(3, 3));
        assert.doesNotMatch(s2.why, /ОТПРАВИТЬ/, "отказ за полтора часа до простоя — не его причина");
    });
});
