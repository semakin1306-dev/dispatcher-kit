// Заготовки разбора вывода на синтетическом выводе jest, vitest, go test, pytest и пользовательские регулярки.
import { test } from "node:test"
import assert from "node:assert/strict"
import { PRESETS, compileParser, parseWith, parseTaskLog, specAware, lineVerdict } from "./parsers.mjs"

const JEST = `
PASS src/a.test.ts (2.1 s)
FAIL src/b.test.ts
  ● sum › adds numbers

    expect(received).toBe(expected)

PASS src/c.spec.js
Test Suites: 1 failed, 2 passed, 3 total
Tests:       1 failed, 7 passed, 8 total
Snapshots:   0 total
`

const VITEST = `
 ✓ src/a.test.ts (3 tests) 5ms
 ❯ src/b.test.ts (2 tests | 1 failed) 10ms
   × adds > fails 3ms
 ✓ src/c.spec.tsx (1 test) 2ms

 FAIL  src/b.test.ts > adds > fails
AssertionError: expected 1 to be 2

 Test Files  1 failed | 2 passed (3)
      Tests  1 failed | 5 passed (6)
`

const GO = `
=== RUN   TestOk
--- PASS: TestOk (0.00s)
=== RUN   TestBad
    bad_test.go:9: want 2, got 1
--- FAIL: TestBad (0.00s)
FAIL
FAIL	example.com/demo/bad	0.004s
ok  	example.com/demo/good	0.002s
?   	example.com/demo/notests	[no test files]
`

const PYTEST = `
============================= test session starts ==============================
tests/test_a.py::test_one PASSED                                         [ 33%]
tests/test_a.py::test_two FAILED                                         [ 66%]
tests/test_b.py::test_three PASSED                                       [100%]
=================================== FAILURES ===================================
FAILED tests/test_a.py::test_two - assert 1 == 2
========================= 1 failed, 2 passed in 0.12s ==========================
`

const PYTEST_SHORT = `
tests/test_a.py .F                                                       [ 66%]
tests/test_b.py .s                                                       [100%]
FAILED tests/test_a.py::test_two - assert 1 == 2
========================= 1 failed, 2 passed, 1 skipped in 0.1s ===============
`

test("jest", () => {
  const r = parseWith(PRESETS.jest, JEST)
  assert.deepEqual(r.passed, ["src/a.test.ts", "src/c.spec.js"])
  assert.deepEqual(r.failed, ["src/b.test.ts"])
  assert.deepEqual(r.names, ["sum › adds numbers"])
  assert.equal(r.totals.length, 3)
  assert.match(r.totals[0], /^Test Suites:/)
})

test("jest: хвост-итог обёртки (jest-batch) не входит в имя спеки", () => {
  const log = [
    "  FAIL  __tests__/integration/a/wv-9001-x.spec.ts  6 ✗ / 0 ✓ · 2с",
    "  PASS  __tests__/unit/a/wv-9002-y.spec.ts  20 ✓ · 2с",
    "  \x1b[31mFAIL\x1b[0m  __tests__/integration/a/wv-9003-z.spec.ts  \x1b[2m\x1b[31m5 ✗\x1b[0m / 0 ✓ · 3с\x1b[0m",
    "PASS src/a.test.ts (2.1 s)",
  ].join("\n")
  const r = parseWith(PRESETS.jest, log)
  assert.deepEqual(r.failed, ["__tests__/integration/a/wv-9001-x.spec.ts", "__tests__/integration/a/wv-9003-z.spec.ts"])
  assert.deepEqual(r.passed, ["__tests__/unit/a/wv-9002-y.spec.ts", "src/a.test.ts"])
  for (const p of [...r.failed, ...r.passed]) assert.doesNotMatch(p, /[✓✗·]|\s/)
})

test("vitest", () => {
  const r = parseWith(PRESETS.vitest, VITEST)
  assert.deepEqual(r.passed, ["src/a.test.ts", "src/c.spec.tsx"])
  assert.deepEqual(r.failed, ["src/b.test.ts"])
  assert.ok(r.names.includes("adds > fails"))
  assert.deepEqual(r.totals, ["Test Files  1 failed | 2 passed (3)", "Tests  1 failed | 5 passed (6)"])
})

test("go-test", () => {
  const r = parseWith(PRESETS["go-test"], GO)
  assert.deepEqual(r.passed, ["example.com/demo/good"])
  assert.deepEqual(r.failed, ["example.com/demo/bad"])
  assert.deepEqual(r.names, ["TestBad"])
  assert.equal(r.totals.length, 2)
})

test("pytest -v и короткий вывод", () => {
  const r = parseWith(PRESETS.pytest, PYTEST)
  assert.deepEqual(r.failed, ["tests/test_a.py"])
  assert.deepEqual(r.passed, ["tests/test_b.py"], "файл с упавшим тестом в passed не попадает")
  assert.deepEqual(r.names, ["tests/test_a.py::test_two"])
  assert.match(r.totals[0], /1 failed, 2 passed/)
  const s = parseWith(PRESETS.pytest, PYTEST_SHORT)
  assert.deepEqual(s.failed, ["tests/test_a.py"])
  assert.deepEqual(s.passed, ["tests/test_b.py"])
})

test("exit-code: имён спек нет", () => {
  assert.equal(compileParser("exit-code"), null)
  assert.equal(compileParser(undefined), null)
  assert.deepEqual(parseWith(compileParser("exit-code"), JEST), { passed: [], failed: [], totals: [], names: [] })
})

test("пользовательские регулярки { pass, fail, totals, names }", () => {
  const rules = compileParser({ pass: "^OK (\\S+)$", fail: "^BAD (\\S+)$", totals: "^итого:", names: "^  причина: (.+)$" })
  const r = parseWith(rules, "OK one\nBAD two\n  причина: сломалось\nOK three\nитого: 2 из 3\n")
  assert.deepEqual(r, { passed: ["one", "three"], failed: ["two"], totals: ["итого: 2 из 3"], names: ["сломалось"] })
})

test("задачи демо-проекта: разбор по полю parser, specAware", () => {
  assert.equal(specAware("api-test"), true)
  assert.equal(specAware("web-test"), true)
  assert.equal(specAware("lint"), false)
  assert.deepEqual(parseTaskLog(JEST, "api-test").failed, ["src/b.test.ts"])
  assert.deepEqual(parseTaskLog(JEST, "lint").failed, [])
  assert.deepEqual(lineVerdict("web-test", " ✓ src/a.test.ts (3 tests) 5ms"), { spec: "src/a.test.ts", ok: true })
  assert.deepEqual(lineVerdict("api-test", "FAIL src/b.test.ts"), { spec: "src/b.test.ts", ok: false })
  assert.equal(lineVerdict("lint", "FAIL src/b.test.ts"), null)
})
