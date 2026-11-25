// Вид ветки для страницы (view.mjs): станции, «Дальше», группа, готовность к staging — на демо-проекте
// (гарды — задачи lint и typecheck, тесты — api-test и web-test).
import { describe, test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-view-"));
process.env.DASH_DATA = TMP;
process.env.DASH_DRY = "1";
const { S } = await import("./state.mjs");
// весь конвейер станций: модули ревью, выката и приёмки включены (в демо-конфиге выкат и приёмка выключены)
(await import("./modules.mjs")).setModuleStates({ review: true, release: true, accept: true });
const { stagesOf } = await import("./stations.mjs");
const { farOf, nextStep, readyStg, reviewOwed, slotGroup, stagesView } = await import("./view.mjs");
const relayMod = await import("./relay.mjs");
after(async () => {
    const st = await import("./store.mjs");
    await st.settled(); st.flushSync(); await st.settled();
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const FP = "08f5cdfc403bd6da", KEY = "wv0000-sample";
const CHECK_AUTO = { build: "сборка не нужна", guards: "гарды зелёные", tests: "зелёные на текущем коде", review: "независимый ревьюер «ЗА»", regress: "тронутые пути не задевают соседей" };

const tree = (o = {}) => ({
    key: KEY,
    kind: "slot",
    tag: "П0",
    branch: "dev/wv-0000-sample",
    exists: true,
    readOnly: false,
    ahead: 1,
    behind: 0,
    dirtyTracked: 0,
    dirtyUntracked: 0,
    hasCode: true,
    fp: FP,
    deps: [],
    conflict: [],
    regress: [],
    verdict: {
        tests: "green",
        build: "notneeded",
        note: "",
        bnote: "",
        guards: "green",
        gnote: "",
        regress: "notneeded",
        rnote: "",
    },
    review: { verdict: "ЗА", fresh: true, jobId: "j1766", reported: true },
    ...o,
});

const AUTO = { committed: { plan: "найден файл плана волны", impl: "коммитов впереди staging: 1", ...CHECK_AUTO, commit: "коммитов впереди staging: 1, дерево чистое" } };
AUTO.merged = { ...AUTO.committed, impl: "код влит в staging", commit: "влито в staging", staging: "влито: 46e748eac8" };
AUTO.stand = { ...AUTO.merged, stand: "стенд выкачен запуском j1700" };

const view = (t, auto, mk = {}, ag = null) => {
    t.stages = stagesOf(t, auto, mk);
    const st = stagesView(t, ag), far = farOf(st, t, ag);
    return { st, far, cur: st[far + 1] && st[far + 1].id, next: nextStep(t, st, ag, far) };
};

const ctx = (o = {}) => ({ inbox: [], reqs: [], ...o });
let seq = 2000;
const job = (o = {}) => ({ id: "j" + seq++, tree: KEY, task: "lint", label: "Линтер", input: "", status: "ok", fpStart: FP, fpEnd: FP, queuedAt: seq, ...o });

beforeEach(() => {
    S.jobs = [];
    S.snap = { trees: [], orderHints: [] };
    S.train = null;
    S.specHist = {};
});

describe("пустая ветка (нет ни коммитов, ни правок)", () => {
    test("«Дальше» — ждём код агента; к влива не готова; группа «ждёт»", () => {
        const t = tree({ ahead: 0, hasCode: false, review: null }), v = view(t, { plan: "найден файл плана волны" });
        assert.equal(v.cur, "impl");
        assert.deepEqual(v.next, { kind: "info", text: "Кода ещё нет: агент пишет — ждём его отчёт" });
        assert.equal(readyStg(t, v.st), false);
        assert.equal(slotGroup(t, null, v.next, ctx()), "idle");
    });
    test("папки слота ещё нет — «нужен ты», а пока идёт подготовка — «работает»", () => {
        const t = tree({ exists: false });
        assert.equal(slotGroup(t, null, null, ctx()), "need");
        S.jobs = [job({ task: "slot-up", status: "running" })];
        assert.equal(slotGroup(t, null, null, ctx()), "work");
    });
});

describe("закоммичена, проверки зелёные, не влита (П12)", () => {
    test("«Можно вливать в staging», готова к staging, группа «нужен ты»", () => {
        const t = tree(), v = view(t, AUTO.committed);
        assert.equal(v.cur, "staging");
        assert.deepEqual(v.next, { kind: "go", text: "Можно вливать в staging", act: "merge" });
        assert.equal(readyStg(t, v.st), true);
        assert.equal(slotGroup(t, null, v.next, ctx()), "need");
    });
    test("не готова: незакоммиченные правки, зависимость не влита, слот разведки, нет коммитов", () => {
        const st = view(tree(), AUTO.committed).st;
        assert.equal(readyStg(tree({ dirtyTracked: 2 }), st), false);
        assert.equal(readyStg(tree({ deps: [{ tag: "П3", merged: false }] }), st), false);
        assert.equal(readyStg(tree({ readOnly: true }), st), false);
        assert.equal(readyStg(tree({ ahead: 0 }), st), false);
        assert.equal(readyStg(null, st), false);
    });
    test("зависимость не влита — «Вливать после П3», без кнопки", () => {
        const t = tree({ deps: [{ tag: "П3", merged: false }] }), v = view(t, AUTO.committed);
        assert.equal(v.next.kind, "warn");
        assert.match(v.next.text, /^Вливать после П3: /);
        assert.equal(v.next.act, undefined);
    });
    test("в поезде влива — «в поезде»; идут её прогоны — «Идут или ждут запуски», группа «работает»", () => {
        const t = tree(), v = view(t, AUTO.committed);
        S.train = { status: "run", keys: [KEY] };
        assert.equal(slotGroup(t, null, v.next, ctx()), "train");
        S.train = null;
        S.jobs = [job({ status: "queued" })];
        assert.deepEqual(nextStep(t, v.st, null, v.far), { kind: "info", text: "Идут или ждут запуски этого слота" });
        assert.equal(slotGroup(t, null, v.next, ctx()), "work");
    });
});

describe("влита в staging (П5) и на стенде (П10)", () => {
    const merged = (o = {}) =>
        tree({
            ahead: 0,
            hasCode: false,
            conflict: undefined,
            verdict: {
                tests: "green",
                build: "notneeded",
                guards: "green",
                regress: "notneeded",
                note: "",
                bnote: "",
                gnote: "",
                rnote: "",
                merged: true,
            },
            ...o,
        });
    test("влита: «Выкатить staging на стенд», группа «влито», к staging не готова", () => {
        const t = merged(), v = view(t, AUTO.merged);
        assert.equal(v.cur, "stand");
        assert.deepEqual(v.next, { kind: "go", stand: true, text: "Выкатить staging на стенд и принять", act: "stand" });
        assert.equal(readyStg(t, v.st), false);
        assert.equal(slotGroup(t, null, v.next, ctx()), "merged");
    });
    test("влитая ветка без своего кода — не «Кода ещё нет» (проверки засчитаны до влива)", () => {
        const v = view(merged(), AUTO.merged);
        assert.notEqual(v.next.text, "Кода ещё нет: агент пишет — ждём его отчёт");
    });
    test("на стенде: «Принять на стенде»", () => {
        const v = view(merged(), AUTO.stand);
        assert.equal(v.cur, "accept");
        assert.deepEqual(v.next, { kind: "go", text: "Принять на стенде: чек-лист в панели «Приёмка»", act: "accept" });
    });
    test("агент пишет код во влитой ветке — станции не сбрасываются", () => {
        const t = merged();
        t.stages = stagesOf(t, AUTO.merged, {});
        assert.equal(stagesView(t, { coding: true }), t.stages);
    });
    test("влита, но после влива доделка (П2: впереди 2 коммита, тесты на другом коде) — «Прогнать тесты» с пояснением", () => {
        const note = "зелёные тесты шли на другом коде: файлы менялись после прогона. Прогоните заново.";
        const t = tree({
                ahead: 2,
                verdict: {
                    tests: "stale",
                    build: "ok",
                    note,
                    bnote: "",
                    guards: "green",
                    gnote: "",
                    regress: "green",
                    rnote: "",
                },
            }),
            a = {
                ...AUTO.merged,
                impl: "коммитов впереди staging: 2",
                commit: "коммитов впереди staging: 2, дерево чистое",
            };
        delete a.tests;
        const v = view(t, a);
        assert.equal(v.cur, "tests");
        assert.deepEqual(v.next, { kind: "go", text: note, act: "tests" });
        assert.equal(readyStg(t, v.st), false);
    });
});

describe("ревью «ВОПРОСЫ»", () => {
    const noReview = () => {
        const a = { ...AUTO.committed };
        delete a.review;
        return a;
    };
    test("замечания не отданы агенту — reviewOwed, «bad»: повторять ревью незачем", () => {
        const t = tree({ review: { verdict: "ВОПРОСЫ", fresh: true, jobId: "j967", reported: false } }), v = view(t, noReview());
        assert.equal(reviewOwed(t), true);
        assert.equal(v.cur, "review");
        assert.equal(v.next.kind, "bad");
        assert.equal(v.next.act, "review");
        assert.match(v.next.text, /^Ревьюер: ВОПРОСЫ\. Замечания ещё НЕ отданы агенту волны/);
        assert.equal(slotGroup(t, null, v.next, ctx()), "need");
    });
    test("замечания у агента — ждём правку («info»), не долг", () => {
        const t = tree({ review: { verdict: "ВОПРОСЫ", fresh: true, jobId: "j967", reported: true } }), v = view(t, noReview());
        assert.equal(reviewOwed(t), false);
        assert.equal(v.next.kind, "info");
        assert.match(v.next.text, /Замечания у агента — ждём правку/);
        assert.equal(slotGroup(t, null, v.next, ctx()), "idle");
    });
    test("код менялся после ревью — «повторить»; вердикт не свежий — не долг", () => {
        const t = tree({ review: { verdict: "ВОПРОСЫ", fresh: false, jobId: "j967", reported: false } }), v = view(t, noReview());
        assert.equal(reviewOwed(t), false);
        assert.deepEqual(v.next, { kind: "go", text: "Код менялся после ревью — повторить", act: "review" });
    });
    test("reviewOwed: «ЗА», без вердикта, без ревью и reported не задан — не долг", () => {
        assert.equal(reviewOwed(tree({ review: { verdict: "ЗА", fresh: true, reported: false } })), false);
        assert.equal(reviewOwed(tree({ review: { verdict: null, fresh: true, reported: false } })), false);
        assert.equal(reviewOwed(tree({ review: null })), false);
        assert.equal(reviewOwed(tree({ review: { verdict: "ВОПРОСЫ", fresh: true } })), false);
    });
});

describe("регресс снят вручную", () => {
    test("станция стоит на «Регрессе», «Дальше» — прогнать соседей, к staging не готова", () => {
        const t = tree({ regress: [{ task: "web-test", input: "", label: "Витрина: тесты по фильтру" }] }), v = view(t, AUTO.committed, { regress: false });
        const r = v.st.find((x) => x.id === "regress");
        assert.equal(r.done, false);
        assert.equal(r.source, "manual");
        assert.equal(v.cur, "regress");
        assert.deepEqual(v.next, { kind: "go", text: "Прогнать регресс: соседи по тронутым путям — Витрина: тесты по фильтру", act: "regress" });
        assert.equal(readyStg(t, v.st), false);
    });
    test("если бы дошло до «В staging» — «Вливать рано», мягкий влив (не сборка и не тесты)", () => {
        const t = tree(), st = stagesOf(t, AUTO.committed, { regress: false }), far = st.findIndex((x) => x.id === "staging") - 1;
        const n = nextStep(t, st, null, far);
        assert.equal(n.kind, "warn");
        assert.equal(n.act, "regress");
        assert.equal(n.mergeSoft, true);
        assert.match(n.text, /не пройдено «Регресс»/);
        const st2 = stagesOf(t, AUTO.committed, { tests: false });
        assert.equal(nextStep(t, st2, null, far).mergeSoft, false);
    });
    test("агент пишет код — ручное «снято» остаётся, авто-отметки от «Кода» до «Коммита» ждут конца хода", () => {
        const t = tree();
        t.stages = stagesOf(t, AUTO.committed, { regress: false, review: true });
        const st = stagesView(t, { coding: true }), by = (id) => st.find((x) => x.id === id);
        assert.equal(by("impl").done, false);
        assert.equal(by("impl").hint, "агент сейчас пишет код");
        for (const id of ["build", "tests", "guards", "commit"])
            assert.equal(by(id).done, false, id);
        assert.equal(by("review").done, true, "ручная отметка не трогается");
        assert.equal(by("regress").source, "manual");
        assert.equal(by("plan").done, true, "до «Кода» — как было");
        assert.equal(farOf(st, t, { coding: true }), st.findIndex((x) => x.id === "impl") - 1);
        assert.equal(nextStep(t, st, { coding: true }, farOf(st, t, { coding: true })).text, "Агент пишет код — сборку и тесты автопоезд запустит сам, когда он допишет");
        assert.equal(stagesView(t, { coding: false }), t.stages);
        assert.equal(stagesView(t, null), t.stages);
    });
});

describe("упавший прогон и «нужен ты»", () => {
    test("красный гард без совета по слоту — «Упал …», act advice, группа «нужен ты»", () => {
        const t = tree(), v0 = view(t, AUTO.committed), j = job({ status: "fail", summary: "✗ lint: причина" });
        S.jobs = [j];
        const n = nextStep(t, v0.st, null, v0.far);
        assert.equal(n.kind, "bad");
        assert.equal(n.act, "advice");
        assert.equal(n.jobId, j.id);
        assert.match(n.text, /^Упал «Линтер»\. /);
        assert.equal(slotGroup(t, null, n, ctx()), "need");
    });
    test("поезд, чей код целиком в staging, — старое падение не висит «Упал …» (сверху «Сборка» у влитого Т1)", () => {
        const t = tree({ train: true, ahead: 0, aheadLanded: 7, buildNeeded: true, fp: "new", verdict: { merged: true } });
        S.snap = { trees: [t], orderHints: [] };
        const v0 = view(t, AUTO.committed), j = job({ task: "api-test", label: "API: тесты по шаблону", status: "fail", fpEnd: "old" });
        S.jobs = [j];
        const { failAdvice } = relayMod;
        assert.equal(failAdvice(j).act, "obsolete");
        assert.ok(!/^Упал/.test(nextStep(t, v0.st, null, v0.far).text || ""));
        t.ahead = 1;
        assert.notEqual(failAdvice(j).act, "obsolete", "следующий вагон в работе — падение снова значит");
    });
    test("красный поезда влива — унаследованный: «Дальше» по станции, а не «Упал»", () => {
        const t = tree(), v0 = view(t, AUTO.committed);
        S.jobs = [job({ status: "fail", train: true })];
        assert.equal(nextStep(t, v0.st, null, v0.far).act, "merge");
    });
    test("«нужен ты»: просьба агента, вопрос владельцу, открытая просьба прогона, порядок вливов", () => {
        const t = tree(), info = { kind: "info", text: "x" };
        assert.equal(slotGroup(t, { pending: 1 }, info, ctx()), "need");
        for (const kind of ["relay", "verify", "result", "slotstart", "ownerq"])
            assert.equal(slotGroup(t, null, info, ctx({ inbox: [{ tree: KEY, kind }] })), "need", kind);
        assert.equal(slotGroup(t, null, info, ctx({ inbox: [{ tree: "другой", kind: "relay" }] })), "idle");
        assert.equal(slotGroup(t, null, info, ctx({ reqs: [{ tree: KEY, items: [{ status: "todo" }] }] })), "need");
        assert.equal(slotGroup(t, null, info, ctx({ reqs: [{ tree: KEY, items: [{ status: "ok" }, { status: "run" }] }] })), "idle");
        S.snap.orderHints = [{ a: "другой", b: KEY }];
        assert.equal(slotGroup(t, null, info, ctx()), "need");
        S.snap.orderHints = [];
        assert.equal(slotGroup(t, { busy: true }, info, ctx()), "work");
    });
    test("путь пройден — 🏁", () => {
        const t = tree(), st = stagesOf(t, {}, {});
        assert.deepEqual(nextStep(t, st, null, st.length - 1), { kind: "done", text: "Путь пройден 🏁" });
    });
});

describe("зелёный влив — карточка «влита» сразу, без git (markMergedTree / markMergedNow)", async () => {
    await import("./wiring.mjs");
    const { markMergedTree } = await import("./stations.mjs");
    const { markMergedNow, snapNow } = await import("./snapshot.mjs");
    const SHA = "46e748eac8f1c0ffee0000000000000000000000";
    const ready = () => {
        const t = tree();
        t.stages = stagesOf(t, AUTO.committed, {});
        return t;
    };
    const look = (t) => {
        const st = stagesView(t, null), far = farOf(st, t, null);
        return { st, cur: st[far + 1] && st[far + 1].id, next: nextStep(t, st, null, far) };
    };
    test("до влива — «Можно вливать», после отметки — как у влитой по снимку: стенд, группа «влито», к staging не готова", () => {
        const t = ready(), a = look(t);
        assert.equal(a.next.text, "Можно вливать в staging");
        assert.equal(readyStg(t, a.st), true);
        const m = markMergedTree(t, { sha: SHA, at: 1700000000000 }), b = look(m);
        assert.notEqual(m, t);
        assert.equal(t.ahead, 1, "исходная ветка не тронута");
        assert.equal(m.ahead, 0);
        assert.deepEqual(m.merge, { sha: SHA, ct: 1700000000000, all: [SHA], optimistic: true });
        assert.equal(m.stages.find((s) => s.id === "staging").done, true);
        assert.match(m.stages.find((s) => s.id === "staging").hint, /^влито: 46e748eac8/);
        assert.equal(m.verdict.merged, true);
        assert.equal("reconGate" in m, false, "разведки нет — поля нет");
        const real = tree({ ahead: 0, hasCode: false, verdict: { ...t.verdict, merged: true } }), r = look(Object.assign(real, { stages: stagesOf(real, AUTO.merged, {}) }));
        assert.equal(b.cur, r.cur);
        assert.deepEqual(b.next, r.next);
        assert.equal(b.cur, "stand");
        assert.equal(readyStg(m, b.st), false);
        assert.equal(slotGroup(m, null, b.next, ctx()), "merged");
    });
    test("ручное «снято» не перекрывается; грязное дерево — только «В staging», проверки как были; невлитая/чужая — без изменений", () => {
        const t = tree({ dirtyTracked: 2 });
        t.stages = stagesOf(t, { ...AUTO.committed, tests: "" }, { review: false });
        const m = markMergedTree(t, { sha: null });
        assert.equal(m.stages.find((s) => s.id === "review").done, false);
        assert.equal(m.stages.find((s) => s.id === "tests").done, false);
        assert.equal(m.stages.find((s) => s.id === "staging").done, true);
        assert.match(m.stages.find((s) => s.id === "staging").hint, /только что/);
        assert.ok(!m.verdict.merged);
        assert.deepEqual(m.merge.all, []);
        const z = tree({ ahead: 0 });
        assert.equal(markMergedTree(z, { sha: SHA }), z);
        const o = { key: "orchestrator", kind: "orch", ahead: 3 };
        assert.equal(markMergedTree(o, { sha: SHA }), o);
    });
    test("markMergedNow: по шагам влива — только слоты влитых веток, sha из шага, версия состояния растёт", async () => {
        const { stateVerNow } = await import("./events.mjs");
        const t = ready(), other = { ...ready(), key: "wv0001-x", branch: "dev/wv-0001-x" };
        S.snap = { trees: [t, other], orderHints: [] };
        const v0 = stateVerNow();
        const keys = markMergedNow({
            task: "merge",
            status: "ok",
            endedAt: Date.now(),
            steps: [
                { cmd: "git", args: ["merge", "--no-ff", t.branch, "-m", "merge: " + t.branch] },
                { show: "merge-коммит", js: () => {} },
            ],
            mergeSha: { [t.branch]: SHA },
        });
        assert.deepEqual(keys, [KEY]);
        assert.ok(stateVerNow() > v0, "версия состояния поднята");
        const [a, b] = snapNow().trees;
        assert.equal(a.ahead, 0);
        assert.equal(a.merge.sha, SHA);
        assert.equal(b, other, "чужая ветка не тронута");
        assert.deepEqual(markMergedNow({ steps: [] }), []);
    });
    test("снимок, начатый ДО влива, отметку не затирает; начатый после — правда git, отметка снята", async () => {
        const { keepMerged } = await import("./snapshot.mjs");
        const t = ready(), at = Date.now();
        S.snap = { trees: [t], orderHints: [] };
        markMergedNow({ endedAt: at, steps: [{ cmd: "git", args: ["merge", "--no-ff", t.branch] }], mergeSha: { [t.branch]: SHA } });
        const stale = ready(), [s1] = keepMerged([stale], at - 5000);
        assert.equal(s1.ahead, 0);
        assert.equal(s1.merge.sha, SHA);
        const fresh = { ...ready(), ahead: 0 }, [s2] = keepMerged([fresh], at + 1);
        assert.equal(s2, fresh);
        const again = ready();
        assert.equal(keepMerged([again], at - 5000)[0], again, "после сверки отметка снята");
    });
});
