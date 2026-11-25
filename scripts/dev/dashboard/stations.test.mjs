import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-stations-"));
process.env.DASH_DATA = TMP;
process.env.DASH_DRY = "1";
const { S } = await import("./state.mjs");
// весь конвейер станций: модули ревью, выката и приёмки включены (в демо-конфиге выкат и приёмка выключены)
(await import("./modules.mjs")).setModuleStates({ review: true, release: true, accept: true });
const { STATIONS, applyReqs, dropEmptyChecks, mergedCarry, stagesOf } = await import("./stations.mjs");
const { frozenAfterCommit } = await import("./autochain.mjs");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const FP = "6ba8276c1c0ee27e", KEY = "wv0000-sample";
const CHECKS = ["build", "guards", "tests", "review", "regress"];

const tree = (o = {}) => ({ key: KEY, kind: "slot", branch: "dev/wv-0000-sample", exists: true, readOnly: false, ahead: 1, dirtyTracked: 0, dirtyUntracked: 0, hasCode: true, fp: FP, ownerQ: null,
    verdict: { tests: "green", build: "notneeded", guards: "green", regress: "notneeded", note: "", bnote: "", gnote: "", rnote: "" }, ...o });

const greenAuto = () => ({
    impl: "коммитов впереди staging: 1",
    build: "сборка не нужна",
    guards: "тайпчек долга зелёный",
    tests: "зелёные на текущем коде",
    review: "независимый ревьюер «ЗА»",
    regress: "тронутые пути не задевают соседей",
});
const done = (st) => st.filter((x) => x.done).map((x) => x.id);
const MERGE = { sha: "46e748eac8a1b2c3d4e5f60718293a4b5c6d7e8f", ct: 1793880000000, subject: "Merge branch 'dev/wv-0000-sample' into staging" };

describe("dropEmptyChecks — пустая ветка проверки не засчитывает", () => {
    test("ни коммитов, ни правок, не влита — зелёное staging не «Гарды» и не «Тесты» волны", () => {
        const t = tree({ ahead: 0, hasCode: false }), auto = { ...greenAuto(), plan: "найден файл плана волны" };
        delete auto.impl;
        dropEmptyChecks(t, auto, {});
        for (const k of CHECKS)
            assert.equal(k in auto, false, k);
        assert.equal(auto.plan, "найден файл плана волны");
        const st = stagesOf(t, auto, {});
        assert.deepEqual(done(st), ["plan"]);
    });
    test("влитая ветка (своего кода впереди staging нет) — отметки остаются", () => {
        const t = tree({ ahead: 0, hasCode: false }), auto = { ...greenAuto(), commit: "влито в staging", staging: "влито: 46e748eac8" };
        dropEmptyChecks(t, auto, {});
        for (const k of CHECKS)
            assert.ok(auto[k], k);
        const only = { ...greenAuto(), staging: "влито: 46e748eac8" };
        dropEmptyChecks(t, only, {});
        for (const k of CHECKS)
            assert.ok(only[k], "только «В staging»: " + k);
    });
    test("закоммиченная или отмеченная вручную «Коммит»/«В staging» — отметки остаются", () => {
        for (const [a, mk] of [[{ commit: "коммитов впереди staging: 1, дерево чистое" }, {}], [{}, { commit: true }], [{}, { staging: true }]]) {
            const auto = { ...greenAuto(), ...a };
            dropEmptyChecks(tree({ ahead: 0, hasCode: false }), auto, mk);
            for (const k of CHECKS)
                assert.ok(auto[k], k + " " + JSON.stringify(mk));
        }
    });
    test("есть код или слот разведки — правило не действует", () => {
        let auto = greenAuto();
        dropEmptyChecks(tree({ ahead: 0, dirtyTracked: 2, hasCode: true }), auto, {});
        for (const k of CHECKS)
            assert.ok(auto[k], k);
        auto = greenAuto();
        dropEmptyChecks(tree({ ahead: 0, hasCode: false, readOnly: true }), auto, {});
        for (const k of CHECKS)
            assert.ok(auto[k], k);
    });
});

describe("mergedCarry — влитая ветка засчитывает проверки, прошедшие до влива", () => {
    test("влита и после влива ничего нет — тесты/гарды/регресс зелёные, сборка ok, пояснения сняты, merged", () => {
        const t = tree({
                ahead: 0,
                hasCode: false,
                verdict: {
                    tests: "stale",
                    build: "stale",
                    guards: "none",
                    regress: "notneeded",
                    note: "зелёные тесты шли на другом коде",
                    bnote: "x",
                    gnote: "y",
                    rnote: "z",
                },
            }),
            auto = {};
        mergedCarry(t, auto, MERGE);
        assert.deepEqual(t.verdict, { tests: "green", build: "ok", guards: "green", regress: "notneeded", note: "", bnote: "", gnote: "", rnote: "", merged: true });
        for (const k of CHECKS)
            assert.equal(auto[k], "влито в staging: проверки шли до влива", k);
        for (const k of ["plan", "red", "impl", "commit"])
            assert.equal(auto[k], "влито в staging: станция пройдена до влива", k);
        dropEmptyChecks(t, { ...auto, staging: "влито" }, {});
        const upTo = STATIONS.slice(0, STATIONS.findIndex((s) => s.id === "staging") + 1).map((s) => s.id);
        assert.deepEqual(done(stagesOf(t, { ...auto, staging: "влито" }, {})), upTo);
    });
    test("ручное «снято» сильнее «влито» и для станций до проверок", () => {
        const t = tree({ ahead: 0, hasCode: false }), auto = {};
        mergedCarry(t, auto, MERGE);
        assert.ok(!done(stagesOf(t, auto, { impl: false })).includes("impl"));
    });
    test("своя авто-отметка сильнее «влито»; notneeded остаётся notneeded", () => {
        const t = tree({ ahead: 0, verdict: { tests: "notneeded", build: "notneeded", guards: "green", regress: "notneeded" } }), auto = { review: "независимый ревьюер «ЗА»" };
        mergedCarry(t, auto, MERGE);
        assert.equal(auto.review, "независимый ревьюер «ЗА»");
        assert.equal(t.verdict.tests, "notneeded");
        assert.equal(t.verdict.build, "notneeded");
    });
    test("после влива доделка (коммиты или правки) — проверки заново, вердикт не трогается (влита, впереди 2 коммита)", () => {
        for (const o of [{ ahead: 2 }, { ahead: 0, dirtyTracked: 1 }]) {
            const t = tree({
                    ...o,
                    verdict: {
                        tests: "stale",
                        build: "ok",
                        guards: "green",
                        regress: "green",
                        note: "зелёные тесты шли на другом коде",
                    },
                }),
                before = JSON.stringify(t.verdict),
                auto = {};
            mergedCarry(t, auto, MERGE);
            assert.equal(JSON.stringify(t.verdict), before);
            assert.deepEqual(auto, {});
        }
    });
    test("не влита — ничего", () => {
        const t = tree({ ahead: 0 }), auto = {};
        mergedCarry(t, auto, null);
        assert.deepEqual(auto, {});
        assert.equal(t.verdict.merged, undefined);
    });
});

describe("applyReqs и frozenAfterCommit — закоммиченная волна не зовёт перепрогнать", () => {
    const req = (task, input = "") => ({ id: "r" + task, task, input, at: 1 });
    const doneOn = (fp) => {
        S.slotDone = { since: 0, slots: { [KEY]: { fp, at: 1 } } };
    };
    test("frozenAfterCommit: закоммичена, агент доложил ГОТОВО, код с коммита тот же, станция «Коммит» пройдена — да", () => {
        doneOn(FP);
        const t = tree({ stages: [{ id: "commit", done: true }] });
        S.snap = { trees: [t] };
        assert.match(frozenAfterCommit(KEY, FP), /волна закоммичена/);
        assert.equal(frozenAfterCommit(KEY, "другой"), "", "код сменился");
        for (const o of [{ dirtyTracked: 1 }, { dirtyUntracked: 1 }, { ahead: 0 }, { verdict: { merged: true } }, { stages: [{ id: "commit", done: false }] }]) {
            S.snap = { trees: [tree({ stages: [{ id: "commit", done: true }], ...o })] };
            assert.equal(frozenAfterCommit(KEY, FP), "", JSON.stringify(o));
        }
        S.snap = { trees: [] };
        assert.equal(frozenAfterCommit(KEY, FP), "", "ветки нет в снимке");
    });
    test("с задачей ворота держат только повтор уже проверенного на этом коде", () => {
        doneOn(FP);
        S.snap = { trees: [tree({ stages: [{ id: "commit", done: true }] })] };
        S.jobs = [];
        assert.equal(frozenAfterCommit(KEY, FP, "lint"), "", "на этом коде гард не гонялся (слили staging после коммита) — пропустить");
        assert.equal(frozenAfterCommit(KEY, FP, "*"), "", "ни одной проверки на этом коде — толчок нужен");
        S.jobs = [{ id: "j1", tree: KEY, task: "lint", status: "ok", fpStart: FP }];
        assert.match(frozenAfterCommit(KEY, FP, "lint"), /волна закоммичена/, "уже проверено на этом коде — держим");
        assert.match(frozenAfterCommit(KEY, FP, "*"), /волна закоммичена/);
        assert.equal(frozenAfterCommit(KEY, FP, "typecheck"), "", "другая задача на этом коде не гонялась");
        S.jobs = [{ id: "j2", tree: KEY, task: "lint", status: "ok", fpStart: "старый" }];
        assert.equal(frozenAfterCommit(KEY, FP, "lint"), "", "результат на старом коде не в счёт");
        S.jobs = [];
    });
    test("закоммичена — «Тесты» и «Сборка» остаются пройденными, в пояснении «проверит поезд влива»", () => {
        const t = tree(), auto = greenAuto();
        applyReqs(t, auto, [req("api-test", "wv-0000"), req("build")], "волна закоммичена, код с коммита не менялся");
        assert.ok(auto.tests);
        assert.ok(auto.build);
        assert.equal(t.verdict.tests, "green");
        assert.equal(t.verdict.build, "notneeded");
        assert.match(t.verdict.note, /^просили перепрогнать после коммита: API: тесты по шаблону wv-0000 — проверит поезд влива$/);
        assert.match(t.verdict.bnote, /^просили пересобрать после коммита: .* — проверит поезд влива$/);
        const st = stagesOf(t, auto, {});
        assert.ok(st.find((x) => x.id === "tests").done);
        assert.ok(st.find((x) => x.id === "build").done);
    });
    test("не закоммичена — «попросили»: отметка снята, станция ждёт прогона", () => {
        const t = tree({ ahead: 0, dirtyTracked: 3 }), auto = greenAuto();
        applyReqs(t, auto, [req("web-test", "wv-0000-a")], "");
        assert.equal(auto.tests, undefined);
        assert.equal(t.verdict.tests, "requested");
        assert.equal(t.verdict.note, "попросили перепрогнать: Витрина: тесты по фильтру wv-0000-a");
        const s = stagesOf(t, auto, {}).find((x) => x.id === "tests");
        assert.equal(s.done, false);
        assert.equal(s.hint, t.verdict.note);
    });
    test("просьбы про гарды станцию «Тесты» не держат; просьб нет — ничего не меняется", () => {
        const t = tree({ ahead: 0, dirtyTracked: 1 }), auto = greenAuto(), v = JSON.stringify(t.verdict);
        applyReqs(t, auto, [req("lint"), req("typecheck")], "");
        assert.equal(JSON.stringify(t.verdict), v);
        assert.deepEqual(auto, greenAuto());
        applyReqs(t, auto, [], "");
        assert.equal(JSON.stringify(t.verdict), v);
    });
    test("build — просьба пересобрать, а не перепрогнать", () => {
        const t = tree({ ahead: 0, dirtyTracked: 1 }), auto = greenAuto();
        applyReqs(t, auto, [req("build")], "");
        assert.equal(t.verdict.build, "requested");
        assert.equal(auto.build, undefined);
        assert.ok(auto.tests);
    });
});

describe("stagesOf — ручная отметка сильнее автоматической", () => {
    test("снято вручную: не пройдено, источник manual, в подсказке прежняя авто-отметка", () => {
        const st = stagesOf(tree(), greenAuto(), { regress: false }), r = st.find((x) => x.id === "regress");
        assert.equal(r.done, false);
        assert.equal(r.source, "manual");
        assert.equal(r.hint, "снято вручную (авто: тронутые пути не задевают соседей)");
    });
    test("отмечено вручную без авто; без отметок — «не пройдено · авто: как»; порядок станций — STATIONS", () => {
        const st = stagesOf(tree(), {}, { review: true });
        assert.deepEqual(st.map((x) => x.id), STATIONS.map((x) => x.id));
        const rv = st.find((x) => x.id === "review");
        assert.equal(rv.done, true);
        assert.equal(rv.source, "manual");
        assert.equal(rv.hint, "отмечено вручную");
        assert.match(st.find((x) => x.id === "site").hint, /^не пройдено · авто: только вручную/);
    });
    test("«Разведки» среди станций нет; открытый вопрос владельцу — «?» на «Плане» с текстом вопроса", () => {
        assert.equal(STATIONS.some((s) => s.id === "recon"), false);
        const st = stagesOf(tree({ ownerQ: "1. Какой срок держать?" }), { plan: "найден файл плана волны" }, {}), r = st.find((x) => x.id === "plan");
        assert.equal(r.q, true);
        assert.equal(r.done, true, "план есть — пройден");
        assert.equal(r.hint, "вопрос владельцу: 1. Какой срок держать?");
        assert.equal(st.filter((x) => x.q).length, 1, "вопрос — на одной станции");
    });
});

test("ветка влита, но после влива дописан коммит (впереди staging 1) — волна не «влитая»; без новых коммитов — влитая", async () => {
    const { mergeLanded } = await import("./stations.mjs");
    const m = { sha: "ccaf4611dec2b8b3915d7a69a56a54ec9d1256b7", ct: 1 };
    assert.equal(mergeLanded({ ahead: 1 }, m), false, "правка после влива");
    assert.equal(mergeLanded({ ahead: 0 }, m), true);
    assert.equal(mergeLanded({ ahead: 0 }, null), false);
});

test("STAGING_MERGE_RE: влив ветки в staging — да, подтягивание staging в ветку — нет (вливы с боковой линии staging)", async () => {
    const { STAGING_MERGE_RE } = await import("./stations.mjs");
    for (const s of ["merge: dev/wv-0010-orders-list — П1", "merge: dev/tr-web-c4 — поезд Т1#4: WV-0015", "merge: hotfix/login-redirect — PUT", "Merge branch 'dev/wv-0900-x' into staging"])
        assert.ok(STAGING_MERGE_RE.test(s), s);
    for (const s of [
        "merge: staging в dev/wv-0010-x",
        "merge: staging -> dev/wv-0010-x",
        "Merge branch 'staging' into dev/tr-web-guards",
        "merge: main -> staging (хотфикс)",
        "hotfix: staging -> main (сайт)",
        "release: staging -> main",
    ])
        assert.ok(!STAGING_MERGE_RE.test(s), s);
});

test("станции модулей: без модуля выката нет «На стенде», «В проде», «На сайте»; без приёмки — «Приёмки»; без ревью — «Ревью»", async () => {
    const M = await import("./modules.mjs");
    try {
        M.setModuleStates({ review: false, release: false, accept: false });
        const ids = stagesOf({}, {}, {}).map((x) => x.id);
        for (const id of ["review", "stand", "prod", "site", "accept"]) assert.ok(!ids.includes(id), id);
        for (const id of ["plan", "build", "guards", "tests", "regress", "commit", "staging"]) assert.ok(ids.includes(id), id);
        M.setModuleStates({ review: true, release: true, accept: true });
        assert.deepEqual(stagesOf({}, {}, {}).map((x) => x.id), STATIONS.map((x) => x.id));
    } finally { M.setModuleStates({ review: true, release: true, accept: true }) }
});
