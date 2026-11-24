// Регресс по тронутым путям на демо-проекте, сужение красного прогона до упавших спек, «прошли позже на этом коде».
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DASH_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dash-narrow-"));
process.env.DASH_DRY = "1";
const R = await import("./regress.mjs");
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "dash-narrow-repo-"));
after(() => { fs.rmSync(REPO, { recursive: true, force: true }); fs.rmSync(process.env.DASH_DATA, { recursive: true, force: true }); });
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(REPO, rel)), { recursive: true }); fs.writeFileSync(path.join(REPO, rel), text); };
put("apps/api/__tests__/orders.spec.ts", "import { orderTotal } from '../src/orderTotal'\n");
put("apps/api/__tests__/users.spec.ts", "import { userName } from '../src/userName'\n");
put("apps/api/node_modules/x/orderTotal.spec.ts", "orderTotal");
put("apps/web/tests/cart.spec.ts", "cartTotal");

test("семьи спек — задачи, чей разбор знает имена спек", () => {
    assert.deepEqual(R.SUITE_FAM, { "api-test": "api-test", "web-test": "web-test" });
    assert.ok(R.TEST_LOG_TASKS.has("train") && !R.TEST_LOG_TASKS.has("lint"));
});

test("тронут исходник области api — задетые спеки задачей с вводом-регуляркой; vitest-область без ввода из спек не строится", () => {
    const plan = R.regressPlan(["apps/api/src/orderTotal.ts", "apps/web/cartTotal.vue"], REPO);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].task, "api-test");
    assert.equal(plan[0].input, "orders\\.spec\\.ts");
    assert.match(plan[0].why, /ключи: orderTotal/);
    assert.deepEqual(R.regressPlan(["README.md"], REPO), []);
    assert.deepEqual(R.regressPlan(["apps/api/__tests__/users.spec.ts"], REPO).map((x) => x.input), ["users\\.spec\\.ts"], "правленная спека задета сама");
});

test("покрытие ввода: тот же набор другой записью, шире по составу, регулярка шире", () => {
    assert.ok(R.jobCovers({ task: "api-test", input: "b|a" }, { task: "api-test", input: "a" }));
    assert.ok(R.jobCovers({ task: "api-test", input: "orders" }, { task: "api-test", input: "orders\\.spec\\.ts" }));
    assert.ok(!R.jobCovers({ task: "api-test", input: "a" }, { task: "api-test", input: "a|b" }));
    assert.ok(!R.jobCovers({ task: "web-test", input: "a" }, { task: "api-test", input: "a" }));
});

test("сужение: последний прогон задачи красный по коду — только упавшие спеки; по связи, зелёный, без спек — нет", () => {
    const J = (id, status, o = {}) => ({ id, tree: "s1", task: "api-test", input: "x", status, endedAt: Number(id.slice(1)), ...o });
    const fails = { j1: ["__tests__/b.spec.ts", "__tests__/a.spec.ts"], j3: ["__tests__/c.spec.ts"] };
    const f = (id) => fails[id] || [];
    assert.deepEqual(R.narrowRedRun("s1", "api-test", { jobs: [J("j1", "fail")], fails: f }), { task: "api-test", input: "a\\.spec\\.ts|b\\.spec\\.ts", specs: ["__tests__/a.spec.ts", "__tests__/b.spec.ts"], from: "j1" });
    assert.equal(R.narrowRedRun("s1", "api-test", { jobs: [J("j1", "fail"), J("j2", "ok")], fails: f }), null, "последний — зелёный");
    assert.equal(R.narrowRedRun("s1", "api-test", { jobs: [J("j3", "fail", { summary: "Timeout, server build1 not responding" })], fails: f }), null, "красное по связи");
    assert.equal(R.narrowRedRun("s1", "api-test", { jobs: [J("j4", "fail")], fails: f }), null, "без упавших спек");
    assert.equal(R.narrowRedRun("s1", "web-test", { jobs: [{ ...J("j1", "fail"), task: "web-test" }], fails: f }), null, "vitest: ввод из спек не строится");
});

test("упавшие спеки прошли позже на нынешнем коде — да; на другом коде или раньше падения — нет", () => {
    const f = "__tests__/a.spec.ts", hist = { [f]: [{ ok: false, at: 100, code: "s1:fpA" }, { ok: true, at: 200, code: "s1:fpA" }], g: [{ ok: true, at: 50, code: "s1:fpA" }], h: [{ ok: true, at: 300, code: "s1:fpB" }] };
    assert.equal(R.specsPassedSince([f], "s1", "fpA", 150, hist), true);
    assert.equal(R.specsPassedSince([f, "g"], "s1", "fpA", 150, hist), false, "g прошла до падения");
    assert.equal(R.specsPassedSince(["h"], "s1", "fpA", 150, hist), false, "h прошла на другом коде");
    assert.equal(R.specsPassedSince([], "s1", "fpA", 0, hist), false);
});

test("прогон спек задачи: с вводом-регуляркой — имена, без ввода из спек — null", () => {
    assert.deepEqual(R.suiteRunArgs("api-test", ["a.spec.ts", "b.spec.ts"]), { task: "api-test", input: "a\\.spec\\.ts|b\\.spec\\.ts" });
    assert.equal(R.suiteRunArgs("web-test", ["a.spec.ts"]), null);
    assert.deepEqual(R.suiteRunArgs("lint", []), { task: "lint", input: "" });
    assert.deepEqual(R.namesOfInput("api-test", "a\\.spec\\.ts|b\\.spec\\.ts"), ["a.spec.ts", "b.spec.ts"]);
    assert.equal(R.namesOfInput("api-test", "orders"), null);
});
