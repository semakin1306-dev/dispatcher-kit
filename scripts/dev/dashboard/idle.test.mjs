import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SYNC_RETRY_MS, mergedBranches, syncMemo, syncTargets, untriedSteps } from "./idle.mjs";

const WB = "epic-a", RP = "epic-b", STG = "46e748eac8", STG2 = "c0c90474b3";
const tree = (key, o = {}) => ({ key, kind: "slot", epic: WB, exists: true, behind: 2, ahead: 0, dirtyTracked: 0, dirtyUntracked: 0, ...o });
const pick = (trees, o = {}) => syncTargets({ trees, epic: WB, staging: STG, done: new Map(), ...o }).map((t) => t.key);

describe("syncTargets — кого перематывать на staging", () => {
    test("отставший нетронутый слот активного эпика — перематывать", () => {
        assert.deepEqual(pick([tree("wv0970")]), ["wv0970"]);
    });
    test("слоты другого эпика не трогаются, даже отставшие", () => {
        assert.deepEqual(pick([tree("wv0942-other", { epic: RP }), tree("wv0970"), tree("wv0950-other", { epic: RP })]), ["wv0970"]);
    });
    test("своё в ветке, правки отслеживаемых файлов, нет папки, не отстал, оркестратор — не перематывать", () => {
        assert.deepEqual(pick([
            tree("a", { ahead: 1 }), tree("b", { dirtyTracked: 3 }), tree("c", { exists: false }), tree("d", { behind: 0 }),
            tree("orchestrator@" + WB, { kind: "orch" }), tree("e", { dirtyUntracked: 5 }),
        ]), ["e"]);
    });
    test("агент пишет или у слота прогоны — не сейчас", () => {
        assert.deepEqual(pick([tree("a"), tree("b")], { busy: new Set(["a"]) }), ["b"]);
    });
    test("на этом staging уже перематывали — второй раз нет (снимок ещё не догнал перемотку)", () => {
        const done = new Map([["a", { sha: STG, result: "ok", at: Date.now() }], ["b", { sha: STG, result: "skip", at: Date.now() }], ["c", { sha: STG, result: "conflict", at: Date.now() }]]);
        assert.deepEqual(pick([tree("a"), tree("b"), tree("c"), tree("d")], { done }), ["d"]);
    });
    test("staging сдвинулся — снова перематывать", () => {
        const done = new Map([["a", { sha: STG, result: "ok", at: Date.now() }]]);
        assert.deepEqual(pick([tree("a")], { done, staging: STG2 }), ["a"]);
    });
    test("неудача на том же staging — повтор не раньше SYNC_RETRY_MS", () => {
        const now = 1793900000000, done = new Map([["a", { sha: STG, result: "fail", at: now - 60000 }], ["b", { sha: STG, result: "fail", at: now - SYNC_RETRY_MS - 1 }]]);
        assert.deepEqual(pick([tree("a"), tree("b")], { done, now }), ["b"]);
    });
    test("нет активного эпика или staging неизвестен — никого", () => {
        assert.deepEqual(pick([tree("a")], { epic: null }), []);
        assert.deepEqual(pick([tree("a")], { staging: "" }), []);
    });
    test("порядок — как в снимке", () => {
        assert.deepEqual(pick([tree("z"), tree("a"), tree("m")]), ["z", "a", "m"]);
    });
});

describe("syncMemo — какой итог перемотки запоминать до сдвига staging", () => {
    test("занятый агент и прогоны не запоминаются: повтор в следующий круг", () => {
        assert.equal(syncMemo({ skip: "агент слота сейчас работает — подтяну, когда закончит" }), null);
        assert.equal(syncMemo({ skip: "у слота идут прогоны" }), null);
    });
    test("перемотано, свои коммиты, конфликт, неудача — запоминаются", () => {
        assert.equal(syncMemo({ ok: true, text: "перемотано на staging (+2)" }), "ok");
        assert.equal(syncMemo({ skip: "у ветки свои коммиты — только кнопкой владельца" }), "skip");
        assert.equal(syncMemo({ conflict: ["a.ts"] }), "conflict");
        assert.equal(syncMemo({ fail: "на сервере: нет ответа" }), "fail");
    });
});

describe("untriedSteps — толкать ли поезд", () => {
    const t = { key: "wv0970", fp: "6ba8276c1c0ee27e", regress: [{ task: "be-jest" }] };
    const ran = (...ids) => new Set(ids.map((id) => t.key + "|chain|" + t.fp + "|" + id));
    test("ничего не ставилось — толкать", () => {
        assert.deepEqual(untriedSteps(t, ["guards", "tests"], ran(), { presets: 1 }), ["guards", "tests"]);
    });
    test("все непройденные станции на этом коде уже ставились — не толкать", () => {
        assert.deepEqual(untriedSteps(t, ["guards", "tests"], ran("guards", "tests"), { presets: 1 }), []);
    });
    test("на другом коде ставились — толкать", () => {
        assert.deepEqual(untriedSteps({ ...t, fp: "99299a2419d84b70" }, ["guards"], ran("guards")), ["guards"]);
    });
    test("ревью: ставилось, упёрлось в потолок или на этом коде уже с вопросами — не толкать", () => {
        assert.deepEqual(untriedSteps(t, ["review"], ran("review")), []);
        assert.deepEqual(untriedSteps(t, ["review"], ran("review-cap")), []);
        assert.deepEqual(untriedSteps({ ...t, review: { fresh: true } }, ["review"], ran()), []);
        assert.deepEqual(untriedSteps(t, ["review"], ran()), ["review"]);
    });
    test("тестов волны нет или регресс пустой — станцию автопоезд не везёт", () => {
        assert.deepEqual(untriedSteps(t, ["tests"], ran(), { presets: 0 }), []);
        assert.deepEqual(untriedSteps({ ...t, regress: [] }, ["regress"], ran()), []);
    });
    test("коммит на этом коде уже пробовали — не толкать", () => {
        assert.deepEqual(untriedSteps(t, ["commit"], ran(), { commitTried: true }), []);
        assert.deepEqual(untriedSteps(t, ["commit"], ran()), ["commit"]);
    });
});

describe("mergedBranches — какие ветки влил прогон", () => {
    test("кнопка «Влить» и поезд", () => {
        assert.deepEqual(mergedBranches({ steps: [{ cmd: "git", args: ["merge", "--no-ff", "dev/wv-0970-x", "-m", "merge: dev/wv-0970-x"] }] }), ["dev/wv-0970-x"]);
        assert.deepEqual(mergedBranches({ steps: [{ cmd: "git", args: ["merge", "--no-ff", "dev/a", "-m", "m"] }, { cmd: "git", args: ["merge", "--no-ff", "dev/b", "-m", "m"] }] }), ["dev/a", "dev/b"]);
        const sha = "dab595183b56c355f6df98e57c0f71c2f84e9c82";
        assert.deepEqual(mergedBranches({ steps: [{ cmd: "git", args: ["merge", "--no-ff", sha, "-m", "m"], branch: "dev/tr-x" }] }), ["dev/tr-x"]);
        assert.deepEqual(mergedBranches({ steps: [{ cmd: "git", args: ["merge", "--no-ff", sha, "-m", "m"] }] }), []);
    });
    test("выкат (merge staging в main), перемотка, другие шаги — не ветки волн", () => {
        assert.deepEqual(mergedBranches({ steps: [{ cmd: "git", args: ["fetch", "origin"] }, { show: "проверка", js: () => { } }, { cmd: "git", args: ["merge", "--no-ff", "staging", "-m", "release"] }, { cmd: "git", args: ["merge", "--ff-only", "origin/staging"] }] }), []);
        assert.deepEqual(mergedBranches({}), []);
        assert.deepEqual(mergedBranches(null), []);
    });
});
