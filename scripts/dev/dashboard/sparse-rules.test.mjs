import { test } from "node:test";
import assert from "node:assert/strict";
import { inCone, outsideCone, sparseArea, sparseCone, sparseConfig, sparseNote, sparseWanted } from "./sparse-rules.mjs";

// Области как в демо-проекте: api — apps/api/** и packages/**, web — apps/web/**.
const AREAS = {
    api: { id: "api", title: "API", paths: ["apps/api/**", "packages/**"] },
    web: { id: "web", title: "Витрина", paths: ["apps/web/**"] },
};
const DIRS = [".github", ".github/workflows", "apps", "apps/api", "apps/api/src", "apps/web", "apps/web/pages", "docs", "packages", "packages/core", "scripts", "vendor", "vendor/big", "vendor/small"];

test("по умолчанию выключено; поле реестра решает; затем DASH_SPARSE; затем настройка", () => {
    assert.equal(sparseWanted({}, {}, {}), false);
    assert.equal(sparseWanted({}, { DASH_SPARSE: "1" }, {}), true);
    assert.equal(sparseWanted({}, {}, { sparse: true }), true);
    assert.equal(sparseWanted({ sparse: false }, { DASH_SPARSE: "1" }, { sparse: true }), false, "слот с sparse:false — полная даже при общем включении");
    assert.equal(sparseWanted({ sparse: true }, { DASH_SPARSE: "0" }, {}), true);
    assert.equal(sparseWanted({}, { DASH_SPARSE: "0" }, { sparse: true }), false);
});

test("область слота — из областей проекта; без области, неизвестная и «только чтение» — без sparse", () => {
    assert.equal(sparseArea({ area: "api" }, AREAS), AREAS.api);
    assert.equal(sparseArea({ area: "mobile" }, AREAS), null);
    assert.equal(sparseArea({ area: "constructor" }, AREAS), null, "имя свойства объекта — не область");
    assert.equal(sparseArea({ area: "api", readOnly: true }, AREAS), null);
    for (const s of [{ area: "mobile" }, { area: "api", readOnly: true }, {}, null])
        assert.equal(sparseCone(s, DIRS, { areas: AREAS }), null);
});

test("api: свои папки и всё общее; папки области web не выложены", () => {
    assert.deepEqual(sparseCone({ area: "api" }, DIRS, { areas: AREAS }), [".github", "apps/api", "docs", "packages", "scripts", "vendor"]);
});

test("web: своё приложение и общее; packages принадлежит api — не выложен", () => {
    assert.deepEqual(sparseCone({ area: "web" }, DIRS, { areas: AREAS }), [".github", "apps/web", "docs", "scripts", "vendor"]);
});

test("skip — каталог не нужен никому: родитель раскрывается, соседи остаются", () => {
    assert.deepEqual(sparseCone({ area: "web" }, DIRS, { areas: AREAS, skip: ["vendor/big"] }), [".github", "apps/web", "docs", "scripts", "vendor/small"]);
});

test("своя папка внутри чужой: чужая раскрывается до своей, остальное чужое не выкладывается", () => {
    const areas = { all: { id: "all", paths: ["src/**"] }, core: { id: "core", paths: ["src/core/**"] } };
    assert.deepEqual(sparseCone({ area: "core" }, ["src", "src/core", "src/ui", "docs"], { areas }), ["docs", "src/core"]);
});

test("ни одной папки области нет в дереве — без sparse (полная выкладка безопасна)", () => {
    assert.equal(sparseCone({ area: "api" }, ["src", "docs"], { areas: AREAS }), null);
});

test("подпись для журнала slot-up: число каталогов и область", () => {
    assert.equal(sparseNote(null), "полная выкладка");
    assert.match(sparseNote(["a", "b"], { area: "web" }), /2 каталогов; область web/);
});

test("inCone как у git: файлы корня, файлы внутри каталога и файлы каталога-предка — в выкладке", () => {
    const cone = ["docs/guide", "apps/api", "packages"];
    assert.ok(inCone("package.json", cone));
    assert.ok(inCone("apps/api/src/a.ts", cone));
    assert.ok(inCone("packages/x/y/z.ts", cone));
    assert.ok(inCone("docs/README.md", cone), "файл docs — предок выкладки");
    assert.ok(inCone("apps/README.md", cone));
    assert.ok(!inCone("docs/other/a.md", cone));
    assert.ok(!inCone("apps/web/x.ts", cone));
    assert.ok(!inCone("apps/apix/a.ts", cone), "префикс имени — не каталог");
    assert.deepEqual(outsideCone(["a.json", "apps/web/x", "apps/api/y", ""], cone), ["apps/web/x"]);
});

test("config.worktree: включено и режим cone", () => {
    assert.deepEqual(sparseConfig("[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n"), { on: true, cone: true });
    assert.deepEqual(sparseConfig("[core]\n\tsparsecheckout = true\n"), { on: true, cone: false });
    assert.deepEqual(sparseConfig("[core]\n\tsparseCheckout = false\n"), { on: false, cone: false });
    assert.deepEqual(sparseConfig(""), { on: false, cone: false });
});
