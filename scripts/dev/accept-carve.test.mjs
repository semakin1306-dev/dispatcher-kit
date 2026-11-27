// Приёмка: каталог спек приёмки (accept.specGlob) вырезается из запретов области слота — тест своей волны слот
// пишет и вне своей области, остальное в той папке ему по-прежнему закрыто.
import { test } from "node:test";
import assert from "node:assert/strict";
import { carveSpecDir, specDirOf } from "./areas.mjs";

const tree = {
    "apps/web": [{ name: "pages", dir: true }, { name: "tests", dir: true }, { name: "nuxt.config.ts", dir: false }],
    "apps/web/tests": [{ name: "unit", dir: true }, { name: "acc", dir: true }],
};
const list = (rel) => tree[rel] || [];

test("статическая часть шаблона спек", () => {
    assert.equal(specDirOf("apps/web/tests/acc/*.accept*.spec.ts"), "apps/web/tests/acc");
    assert.equal(specDirOf("/e2e/acceptance/**/*.spec.ts"), "e2e/acceptance");
    assert.equal(specDirOf("tests/acc/one.spec.ts"), "tests/acc");
});

test("запрет папки, накрывающий каталог спек, раскрывается в запреты соседей", () => {
    const out = carveSpecDir(["/apps/web/**", "/apps/landing/**"], "apps/web/tests/acc", list);
    assert.deepEqual(out, ["/apps/web/pages/**", "/apps/web/nuxt.config.ts", "/apps/web/tests/unit/**", "/apps/landing/**"]);
    assert.ok(!out.some((g) => g.includes("/acc")), "каталог спек открыт");
});

test("запрет, не накрывающий каталог спек, не меняется; запрет ровно каталога спек снимается", () => {
    assert.deepEqual(carveSpecDir(["/apps/api/**"], "apps/web/tests/acc", list), ["/apps/api/**"]);
    assert.deepEqual(carveSpecDir(["/apps/web/tests/acc/**", "/x/**"], "apps/web/tests/acc", list), ["/x/**"]);
    assert.deepEqual(carveSpecDir(["/apps/web/**"], "", list), ["/apps/web/**"]);
});
