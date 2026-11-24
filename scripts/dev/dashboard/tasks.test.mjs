// Каталог задач из конфига проекта: ввод не уходит в оболочку, сборка — по областям конфига.
import { test } from "node:test"
import assert from "node:assert/strict"
import { TASKS, stepOfTask, splitWords, argvOf, globRe, matchAny, buildAreasOf, launchOf, shQuote } from "./tasks.mjs"

test("каталог строится из PROJECT.tasks демо-проекта", () => {
  assert.deepEqual(Object.keys(TASKS).sort(), ["api-test", "lint", "typecheck", "web-test"])
  assert.equal(TASKS["api-test"].lane, "db")
  assert.equal(TASKS["web-test"].lane, "main")
  assert.equal(TASKS.lint.gate, true)
  assert.equal(TASKS["api-test"].input.label, "шаблон пути")
  assert.equal(TASKS["api-test"].input.ph, "wv-0001")
})

test("задача с вводом: ввод с ; и && приходит одним аргументом, без оболочки", () => {
  const evil = "x; rm -rf / && echo pwned | cat > out $(whoami) `id`"
  const st = stepOfTask(TASKS["api-test"], "/tmp/slot", evil)
  assert.equal(st.text, undefined, "шаг с вводом не должен быть строкой для оболочки")
  assert.equal(st.cmd, "npx")
  assert.deepEqual(st.args, ["jest", evil])
  assert.match(st.cwd.replace(/\\/g, "/"), /\/tmp\/slot\/apps\/api$/)
})

test("ввод с кавычками и пробелами тоже один аргумент", () => {
  const st = stepOfTask(TASKS["web-test"], "/r", `a "b" 'c' d`)
  assert.deepEqual(st.args, ["vitest", "run", `a "b" 'c' d`])
})

test("ввод с переводом строки или пустой — отказ", () => {
  assert.throws(() => stepOfTask(TASKS["api-test"], "/r", "a\nb"))
  assert.throws(() => stepOfTask(TASKS["api-test"], "/r", ""))
})

test("задача без ввода — строкой в оболочку", () => {
  const st = stepOfTask(TASKS.lint, "/r", "")
  assert.equal(st.text, "npm run lint")
  assert.equal(st.cmd, undefined)
})

test("splitWords: кавычки держат слово, экранирование", () => {
  assert.deepEqual(splitWords(`node "a b.js" 'c d' e\\ f --x={input}`), ["node", "a b.js", "c d", "e f", "--x={input}"])
  assert.deepEqual(argvOf("tool --filter={input}", "a b;c"), ["tool", "--filter=a b;c"])
  assert.throws(() => splitWords(`node "open`))
})

test("шаблоны путей областей", () => {
  assert.ok(globRe("apps/api/**").test("apps/api/src/x.ts"))
  assert.ok(!globRe("apps/api/**").test("apps/web/x.ts"))
  assert.ok(globRe("src/*.ts").test("src/a.ts"))
  assert.ok(!globRe("src/*.ts").test("src/a/b.ts"))
  assert.ok(matchAny("packages/core/a.js", ["apps/api/**", "packages/**"]))
  assert.deepEqual(buildAreasOf(["packages/core/a.js"]).map((a) => a.id), ["api"])
  assert.deepEqual(buildAreasOf(["apps/web/a.vue", "README.md"]), [])
})

test("Windows: пускатель .cmd идёт через bash с кавычками sh, .exe — напрямую", () => {
  const step = { cmd: "npx", args: ["jest", "a'; rm -rf / && b"] }
  const viaCmd = launchOf(step, { platform: "win32", which: () => "C:/node/npx.cmd", bash: () => "C:/Git/bin/bash.exe" })
  assert.equal(viaCmd.file, "C:/Git/bin/bash.exe")
  assert.deepEqual(viaCmd.args, ["-c", `'npx' 'jest' ${shQuote("a'; rm -rf / && b")}`])
  assert.equal(shQuote("a'b"), `'a'\\''b'`)
  const viaExe = launchOf(step, { platform: "win32", which: () => "C:/node/node.exe", bash: () => "" })
  assert.deepEqual(viaExe, { file: "npx", args: step.args })
  assert.throws(() => launchOf(step, { platform: "win32", which: () => "C:/node/npx.cmd", bash: () => "" }), /bash/)
  assert.deepEqual(launchOf(step, { platform: "linux" }), { file: "npx", args: step.args })
})
