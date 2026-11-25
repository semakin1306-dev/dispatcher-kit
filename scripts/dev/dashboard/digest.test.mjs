// Выжимки логов на синтетическом выводе раннеров: вид лога, упавшее с причиной и местом, выбросы окружения, бюджет.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DIGEST_BUDGET, cleanLines, collapse, digestDiff, digestLog, digestReview, estTok, handleLine, logKind, setDigestDirs, sliceLog } from "./digest.mjs";

const JEST_RED = [
    "$ npx jest wv-0001", "  (в /work/slot/apps/api)",
    "FAIL __tests__/orders/wv-0001-total.spec.ts (4.2 s)",
    "  ● Итог заказа › а: сумма со скидкой",
    "",
    "    expect(received).toBe(expected)",
    "",
    "    Expected: 90",
    "    Received: 100",
    "",
    "      at Object.<anonymous> (__tests__/orders/wv-0001-total.spec.ts:41:20)",
    "",
    "  ● Итог заказа › б: сумма без скидки",
    "",
    "    TypeError: Cannot read properties of undefined (reading 'total')",
    "",
    "      at Object.<anonymous> (__tests__/orders/wv-0001-total.spec.ts:58:11)",
    "",
    "Test Suites: 1 failed, 1 total",
    "Tests:       2 failed, 3 passed, 5 total",
    "── fail (код 1) за 12 с ──",
].join("\n");

const JEST_GREEN = ["PASS __tests__/a.spec.ts", "Test Suites: 1 passed, 1 total", "Tests:       4 passed, 4 total", "── ok (код 0) за 3 с ──"].join("\n");

const VITEST_RED = [
    " ✓ src/a.test.ts (3 tests) 5ms",
    " ❯ src/b.test.ts (2 tests | 1 failed) 10ms",
    "",
    "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
    "",
    " FAIL  src/b.test.ts > корзина > пустая корзина",
    "ReferenceError: cart is not defined",
    " ❯ src/b.test.ts:14:9",
    "",
    "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯",
    " Test Files  1 failed | 1 passed (2)",
    "      Tests  1 failed | 4 passed (5)",
    "── fail (код 1) за 5 с ──",
].join("\n");

const GO_RED = [
    "=== RUN   TestTotal",
    "    total_test.go:19: want 90, got 100",
    "--- FAIL: TestTotal (0.00s)",
    "FAIL",
    "FAIL\texample.com/shop/orders\t0.004s",
    "ok  \texample.com/shop/users\t0.002s",
    "── fail (код 1) за 2 с ──",
].join("\n");

const PYTEST_RED = [
    "============================= test session starts ==============================",
    "tests/test_total.py .F                                                   [100%]",
    "=================================== FAILURES ===================================",
    "FAILED tests/test_total.py::test_discount - assert 100 == 90",
    "========================= 1 failed, 1 passed in 0.12s ==========================",
    "── fail (код 1) за 1 с ──",
].join("\n");

const TSC_RED =
    Array.from(
        { length: 6 },
        (_, i) =>
            `src/m${i}.ts(3,20): error TS2307: Cannot find module '@demo/core' or its corresponding type declarations.`,
    ).join("\n") + "\n── fail (код 2) за 9 с ──";

const PW_RED = [
    "Running 4 tests using 2 workers",
    "  1) [chromium] › tests/e2e/cart.spec.ts:12:3 › [i1] корзина открывается",
    "    Error: expect(locator).toBeVisible() failed",
    "    Locator: getByTestId('cart')",
    "    Error Context: test-results/cart-i1/error-context.md",
    "  1 failed",
    "  3 passed",
].join("\n");

const REVIEW = ["… разбор …", "ВЕРДИКТ: ВОПРОСЫ", "- " + "в обработчике нет проверки владельца заказа; ".repeat(10), "Заметки (не блокируют):", "- имя переменной", "── ok (код 0)"].join("\n");

const H = (id) => (kind, lines) => handleLine({ id, lines, kind, logFile: "/data/logs/" + id + ".log", cli: "/kit/scripts/dev/dash-log.mjs" });
const count = (s, sub) => s.split(sub).length - 1;

describe("вид лога", () => {
    const want = { jest: JEST_RED, vitest: VITEST_RED, "go-test": GO_RED, pytest: PYTEST_RED, tsc: TSC_RED, playwright: PW_RED, review: REVIEW, generic: "просто текст\nбез раннера" };
    for (const [k, text] of Object.entries(want))
        test(k, () => assert.equal(logKind(cleanLines(text)), k));
    test("подготовка слота", () => assert.equal(logKind(["ИТОГ: выполнено 4, провалено 1"]), "slot-up"));
});

describe("упавшее: первая строка причины и место", () => {
    test("jest: сьют один раз в заголовке, причина и строка спеки у каждого теста", () => {
        const d = digestLog(JEST_RED, { handle: H("j1") });
        assert.equal(d.fails.length, 2);
        assert.equal(count(d.text, "Итог заказа"), 1);
        assert.match(d.text, /Упало \(2\) в «Итог заказа», __tests__\/orders\/wv-0001-total\.spec\.ts/);
        assert.match(d.text, /- а: сумма со скидкой — expect\(received\)\.toBe\(expected\)/);
        assert.match(d.text, /TypeError: Cannot read properties of undefined/);
        assert.match(d.text, /Tests: +2 failed, 3 passed, 5 total/);
        assert.match(d.text, /⤷ Полный лог j1 \(\d+ стр\.\)/);
    });
    test("зелёный jest — только итог", () => {
        const d = digestLog(JEST_GREEN);
        assert.equal(d.fails.length, 0);
        assert.doesNotMatch(d.text, /Упало/);
        assert.ok(d.text.length < 300);
    });
    test("vitest: тест, причина, место", () => {
        const d = digestLog(VITEST_RED);
        assert.deepEqual(d.fails.map((f) => f.what), ["корзина > пустая корзина"]);
        assert.match(d.text, /ReferenceError: cart is not defined/);
        assert.match(d.text, /Упало \(1\), src\/b\.test\.ts:\n.* @ строка 14:9/);
    });
    test("go test: тест, строка и причина, упавший пакет", () => {
        const d = digestLog(GO_RED);
        assert.deepEqual(d.fails, [{ what: "TestTotal", why: "want 90, got 100", where: "total_test.go:19" }]);
        assert.deepEqual(d.files, ["example.com/shop/orders"]);
    });
    test("pytest: узел теста и причина", () => {
        const d = digestLog(PYTEST_RED);
        assert.deepEqual(d.fails, [{ what: "tests/test_total.py::test_discount", why: "assert 100 == 90", where: "tests/test_total.py" }]);
        assert.match(d.text, /1 failed, 1 passed in 0\.12s/);
    });
    test("tsc: одинаковые ошибки — одной строкой со счётчиком, причина окружения «модуль не собран»", () => {
        const d = digestLog(TSC_RED);
        assert.match(d.text, /TS2307 ×6 — Cannot find module '@demo\/core'/);
        assert.ok(d.env.some((e) => e.key === "pkg-missing"));
    });
    test("playwright: пункт, локатор, место, снимок страницы", () => {
        const d = digestLog(PW_RED);
        assert.equal(d.fails.length, 1);
        assert.match(d.text, /\[chromium\] \[i1\] корзина открывается.*Locator: getByTestId\('cart'\) @ строка 12:3/);
        assert.match(d.text, /Упало \(1\), tests\/e2e\/cart\.spec\.ts:/);
        assert.match(d.text, /Снимок страницы упавшего теста: test-results\/<папка теста>\/error-context\.md/);
    });
});

describe("бюджет и ручка", () => {
    test("выжимка в бюджете; малый бюджет режет упавшее с «… ещё N», ручка остаётся", () => {
        const many = Array.from({ length: 60 }, (_, i) => `  ● Набор › тест номер ${i}\n\n    Error: причина ${i} ${"x".repeat(80)}\n`).join("\n") + "\nTests: 60 failed, 60 total\n";
        const d = digestLog(many, { handle: H("j2") });
        assert.ok(d.text.length <= DIGEST_BUDGET + 200, String(d.text.length));
        const s = digestLog(many, { budget: 900, handle: H("j2") });
        assert.ok(s.text.length <= 1100, String(s.text.length));
        assert.match(s.text, /… ещё \d+ — в полном логе/);
        assert.match(s.text, /⤷ Полный лог j2/);
        assert.ok(estTok(s.text) * 5 < estTok(many));
    });
    test("ручка: путь к полному логу и dash-log.mjs с подсказкой grep по виду лога", () => {
        assert.match(handleLine({ id: "j7", lines: 3, kind: "jest", logFile: "/x/j7.log", cli: "/d/dash-log.mjs" }), /\/x\/j7\.log — кусок: node \/d\/dash-log\.mjs j7 --grep/);
    });
});

describe("сбои окружения — выбросы", () => {
    test("ENOSPC; префикс рабочей папки удалённой машины срезается", () => {
        setDigestDirs(["/srv/kit-runs/s0"]);
        try {
            const d = digestLog("$ npm test\nError: ENOSPC: no space left on device, write '/srv/kit-runs/s0/tmp/x'\n── fail (код 1)");
            assert.equal(d.env[0].key, "disk");
            assert.doesNotMatch(d.text, /kit-runs/);
        }
        finally {
            setDigestDirs([]);
        }
    });
    test("снимок не принят, нехватка памяти, менеджер пакетов", () => {
        const d = digestLog("remote: error: unable to create temporary object directory\nFATAL ERROR: Reached heap limit — JavaScript heap out of memory\nnpm ERR! code ELIFECYCLE");
        for (const k of ["git-push", "oom", "pkg-manager"])
            assert.ok(d.env.some((e) => e.key === k), k);
    });
});

describe("ревью, дифф, повторы, куски", () => {
    test("ревью: вердикт, пункт целиком, заметки короче", () => {
        const r = digestReview(REVIEW, { handle: "⤷ x" });
        assert.match(r.text, /^ВЕРДИКТ: ВОПРОСЫ/);
        assert.equal(r.points, 1);
        assert.match(r.text, /Заметки \(не блокируют\):/);
        assert.match(r.text, /⤷ x$/);
    });
    test("дифф: каждый файл виден, даже когда первый огромный", () => {
        const big = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n" + Array.from({ length: 400 }, (_, i) => "+строка " + i).join("\n") + "\n";
        const patch = big + "diff --git a/b.ts b/b.ts\n@@ -1 +1 @@\n-старое\n+новое\n" + "diff --git a/c.vue b/c.vue\n@@ -2 +2 @@\n+x\n";
        const d = digestDiff(patch, { budget: 1500, more: "… целиком — git diff" });
        assert.ok(d.length <= 1600, String(d.length));
        for (const f of ["a.ts (+400 −0)", "b.ts (+1 −1)", "c.vue (+1 −0)"])
            assert.ok(d.includes("▸ " + f), f);
        assert.match(d, /ещё \d+ строк диффа этого файла/);
        assert.match(d, /целиком — git diff$/);
        assert.equal(digestDiff("diff --git a/x b/x\n+1\n", { budget: 500 }), "diff --git a/x b/x\n+1\n");
    });
    test("collapse: строки, отличные только числами и хешами, — одной со счётчиком", () => {
        assert.deepEqual(
            collapse([
                "Progress: resolved 1, added 0",
                "Progress: resolved 2689, added 971",
                "снимок 96c4ba6f48 готов",
                "снимок 7d12e50a72 готов",
                "другое",
            ]),
            ["Progress: resolved 1, added 0  (×2)", "снимок 96c4ba6f48 готов  (×2)", "другое"],
        );
    });
    test("sliceLog: grep с контекстом и номерами строк, разрыв «…», предел --max и продолжение --from", () => {
        const t = Array.from({ length: 50 }, (_, i) => (i === 10 || i === 30 ? "FAIL x" + i : "строка " + i)).join("\n");
        const r = sliceLog(t, { grep: "^FAIL", ctx: 1 });
        assert.equal(r.text, "10: строка 9\n11: FAIL x10\n12: строка 11\n…\n30: строка 29\n31: FAIL x30\n32: строка 31");
        const m = sliceLog(t, { from: 5, max: 40 });
        assert.match(m.text, /^5: строка 4\n/);
        assert.match(m.text, /… обрезано по --max 40: дальше — --from \d+/);
        assert.match(sliceLog(t, { grep: "([" }).text, /ничего не нашлось/);
    });
    test("cleanLines: цвета и прогресс через \\r убраны", () => {
        assert.deepEqual(cleanLines("\x1b[31mкрасный\x1b[0m\nа\rб\rв  \n"), ["красный", "в", ""]);
    });
    test("estTok: кириллица дороже латиницы", () => {
        assert.ok(estTok("тест".repeat(100)) > estTok("test".repeat(100)));
    });
});
