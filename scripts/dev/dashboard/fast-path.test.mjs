// Быстрый путь «только спеки» и зоны задач по областям демо-проекта.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACC_SPEC_RE, DIST_TASKS, SPEC_RE, TASK_AREA, buildInput, isProduct, productFiles, specOnlyOf, FP_SKIP } from "./fingerprint.mjs";

test("только спеки и документы — быстрый путь; есть продуктовый файл — нет", () => {
    assert.equal(specOnlyOf(["apps/web/tests/e2e/cart.spec.ts"], true), true);
    assert.equal(specOnlyOf(["apps/api/__tests__/unit/x.spec.ts", "docs/README.md"], true), true);
    assert.equal(specOnlyOf(["svc/orders/total_test.go", "tests/test_total.py"], true), true);
    assert.equal(specOnlyOf(["apps/web/tests/e2e/cart.spec.ts", "apps/web/pages/x.vue"], true), false);
    assert.equal(specOnlyOf(["docs/a.md"], true), false, "одни документы — не правка спек");
    assert.equal(specOnlyOf([], true), false);
    assert.equal(specOnlyOf(["a.spec.ts"], false), false);
    assert.ok(!ACC_SPEC_RE.test("apps/web/tests/e2e/acceptance/a.spec.ts"), "в демо-проекте шаблона приёмки нет");
});

test("продуктовый код — пути областей конфига, без спек, документов и папок агента", () => {
    assert.deepEqual(productFiles(["apps/api/src/a.ts", "apps/web/b.vue", "packages/core/c.ts", "scripts/x.js", "apps/api/__tests__/a.spec.ts", "README.md", ".claude/x.json"]),
        ["apps/api/src/a.ts", "apps/web/b.vue", "packages/core/c.ts"]);
    assert.equal(isProduct(".codex/config.toml"), false);
    assert.ok(SPEC_RE.test("apps/api/__tests__/x.ts"));
    assert.ok(FP_SKIP.test("docs/x.txt") && FP_SKIP.test("a/node_modules/b.js") && !FP_SKIP.test("apps/api/a.ts"));
});

test("сборка и зоны задач: область api со сборкой, web — без", () => {
    assert.ok(buildInput("packages/core/a.ts"));
    assert.ok(!buildInput("packages/core/a.spec.ts"));
    assert.ok(!buildInput("apps/web/a.vue"));
    assert.deepEqual([...DIST_TASKS], ["api-test"]);
    assert.ok(TASK_AREA["api-test"].test("apps/api/x.ts") && !TASK_AREA["api-test"].test("apps/web/x.vue"));
    assert.ok(TASK_AREA["web-test"].test("apps/web/x.vue"));
    assert.ok(TASK_AREA.lint.test("apps/web/x.vue") && !TASK_AREA.lint.test("apps/web/x.spec.ts"), "гард — весь продуктовый код");
});
