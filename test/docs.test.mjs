// Документы сверены с кодом: два входных файла агента одинаковы, SETUP.md называет существующие вопросы и команды,
// README и рецепты называют существующие модули, переключатели, ключи конфига и функции надстройки.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { HOME, CODE_HOOKS, DEMO_PROJECT, normalizeProject } from "../scripts/dev/project.mjs"
import { MODULE_IDS } from "../scripts/dev/modules-catalog.mjs"
import { settings } from "../scripts/dev/dashboard/config.mjs"
import { loadQuiz } from "../setup/build.mjs"

const read = (rel) => fs.readFileSync(path.join(HOME, rel), "utf8").replace(/\r\n/g, "\n")
const RECIPES = "docs/recipes"
const recipeFiles = () => fs.readdirSync(path.join(HOME, RECIPES)).filter((f) => f.endsWith(".md")).sort()
/** Раздел markdown от заголовка `head` до следующего заголовка того же или старшего уровня. */
const section = (text, head) => {
  const i = text.indexOf("\n" + head + "\n")
  assert.ok(i >= 0, "нет раздела " + head)
  const level = head.match(/^#+/)[0].length, rest = text.slice(i + head.length + 2)
  const end = rest.search(new RegExp("^#{1," + level + "} ", "m"))
  return end < 0 ? rest : rest.slice(0, end)
}
const firstColumn = (md) => [...md.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1])

test("AGENTS.md и CLAUDE.md одинаковы: агент любого рантайма читает одно и то же", () => {
  assert.equal(read("AGENTS.md"), read("CLAUDE.md"))
  assert.match(read("AGENTS.md"), /SETUP\.md/)
  assert.match(read("AGENTS.md"), /dispatcher\.project\.json/)
})

test("SETUP.md: вопросы, которые он называет, есть в квизе", () => {
  const ids = new Set(loadQuiz().questions.map((q) => q.id))
  const named = [...read("SETUP.md").matchAll(/`((?:git|modules|machines|stand|prod|accept|agent|ci|deny|tests|limits|project|repo)\.[A-Za-z.]+|areas|tasks|autonomy|slotPrepare)`/g)].map((m) => m[1])
  assert.ok(named.length >= 5, "в SETUP.md названы вопросы: " + named.join(", "))
  // ответы из примера файла ответов — тоже настоящие вопросы
  const example = /```json\n(\{[\s\S]*?\})\n```/.exec(read("SETUP.md"))
  for (const id of Object.keys(JSON.parse(example[1]))) assert.ok(ids.has(id), "в примере ответов нет вопроса " + id)
  for (const id of named) if (!["repo.upstream"].includes(id)) assert.ok(ids.has(id), "нет вопроса " + id)
})

test("SETUP.md: команды и флаги, которые он называет, понимает setup.mjs", () => {
  const setup = read("setup.mjs"), doc = read("SETUP.md")
  for (const cmd of ["detect", "apply", "doctor"]) { assert.ok(doc.includes("node setup.mjs " + cmd), cmd); assert.ok(setup.includes(`cmd === "${cmd}"`), cmd) }
  const flags = new Set([...doc.matchAll(/(?<![\w-])--([a-z][a-z-]+)/g)].map((m) => m[1]))
  for (const flag of flags) assert.ok(setup.includes(`"${flag}"`) || setup.includes("args." + flag) || setup.includes(`args["${flag}"]`), "флаг --" + flag)
})

test("SETUP.md: список функций код-надстройки совпадает с загрузчиком", () => {
  const doc = read("SETUP.md")
  for (const hook of CODE_HOOKS) assert.ok(doc.includes("`" + hook + "`"), hook)
})

test("файлы установки, которые пользователь не должен коммитить, закрыты .gitignore", () => {
  const ignore = read(".gitignore")
  for (const p of ["/dispatcher.project.json", "/dispatcher.project.mjs", "/project/", "/.private-denylist"]) assert.ok(ignore.split("\n").includes(p), p)
})

test("README: таблица модулей совпадает с каталогом в обе стороны", () => {
  const rows = firstColumn(section(read("README.md"), "## Модули").split("\n### ")[0])
  assert.deepEqual([...rows].sort(), [...MODULE_IDS].sort())
})

test("README: таблица переключателей совпадает с умолчаниями settings в обе стороны", () => {
  const rows = firstColumn(section(read("README.md"), "### Переключатели поведения"))
  assert.deepEqual([...rows].sort(), Object.keys(settings).sort())
})

test("README и рецепты называют все функции код-надстройки", () => {
  for (const file of ["README.md", RECIPES + "/README.md"]) for (const hook of CODE_HOOKS) assert.ok(read(file).includes("`" + hook + "`"), file + ": " + hook)
})

test("рецепты: оглавление и файлы папки совпадают в обе стороны", () => {
  const index = read(RECIPES + "/README.md")
  const linked = [...index.matchAll(/\]\(([\w-]+\.md)\)/g)].map((m) => m[1]).sort()
  assert.deepEqual(linked, recipeFiles().filter((f) => f !== "README.md"))
})

test("README и рецепты: названные ключи конфига существуют в схеме", () => {
  // Путь ключа разрешается по нормализованному демо-конфигу; `*` и `<…>` — любой элемент; modules.<id> — по каталогу.
  const demo = normalizeProject(JSON.parse(fs.readFileSync(DEMO_PROJECT, "utf8")))
  const resolves = (dotted) => {
    const segs = dotted.split(".")
    if (segs[0] === "modules") return segs.length === 2 && MODULE_IDS.includes(segs[1])
    let cur = demo
    for (const s of segs) {
      if (cur == null || typeof cur !== "object") return false
      if (s === "*" || /^<.+>$/.test(s)) { const vals = Object.values(cur); if (!vals.length) return false; cur = vals[0]; continue }
      if (!(s in cur)) return false
      cur = cur[s]
    }
    return true
  }
  const KEY_RE = /`((?:repo|agent|areas|deny|protected|slotPrepare|tasks|stations|machines|release|accept|modules|limits|ci)(?:\.[\w*<>-]+)+)`/g
  let named = 0
  for (const file of ["README.md", ...recipeFiles().map((f) => RECIPES + "/" + f)]) {
    for (const m of read(file).matchAll(KEY_RE)) { named++; assert.ok(resolves(m[1]), file + ": ключа `" + m[1] + "` нет в схеме конфига") }
  }
  assert.ok(named >= 20, "проверено ключей: " + named)
  // самопроверка: выдуманный ключ не проходит
  assert.equal(resolves("release.prod.rollback"), false)
  assert.equal(resolves("modules.nope"), false)
})
