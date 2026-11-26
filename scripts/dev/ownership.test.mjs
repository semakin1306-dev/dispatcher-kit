// Правило «что моё» (ownership.mjs) и сторож вокруг него.
//
// Сторож: всякое место кода, которое удаляет рабочую копию или папку (git worktree remove, rm -rf, рекурсивный rmSync),
// записано в ALLOW с числом таких мест и причиной. Локальная уборка обязана брать цели из ownership.mjs: новая функция
// уборки в обход правила (в новом файле или рядом со старой) меняет число мест — и тест падает, пока её не проведут через
// правило. Список сверяется в обе стороны: запись без мест в коде — тоже падение.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { OWN, orchDirName, ownerOf, registeredDirs, slotDirName, splitWorktrees } from "./ownership.mjs"
import { trainSlotName } from "./dashboard/train-rules.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const WT = "/work/demo-wt", MAIN = "/work/demo"
const own = (name, ctx = {}) => ownerOf(path.posix.join(WT, name), { wtRoot: WT, main: MAIN, ...ctx })

test("строители имён диспетчерской проходят правило «моё»", () => {
  for (const n of [slotDirName("0001", "login-form-big"), slotDirName("12345", "wave"), trainSlotName("api", "my-epic"),
    trainSlotName("web", "my-epic", 2), orchDirName("demo")])
    assert.equal(own(n), OWN.SLOT, n)
})

test("служебные папки — свои, но не слоты; чужое имя в папке слотов — чужое", () => {
  for (const n of ["_main", "_staging", "_backlog", "regress-train", "regress-base", "_stg"]) assert.equal(own(n), OWN.SERVICE, n)
  for (const n of ["scratch", "My Copy", "wv12-x", "wv0001", "epic-", "tr-"]) assert.equal(own(n), OWN.FOREIGN, n)
})

test("основная папка, папка вне папки слотов и глубже неё — не мои, даже по имени", () => {
  assert.equal(ownerOf(MAIN, { wtRoot: WT, main: MAIN }), OWN.MAIN)
  assert.equal(own("_staging", { main: WT + "/_staging" }), OWN.MAIN, "основная папка лёгкого режима — раньше служебной")
  assert.equal(own("wv0001-a", { main: WT + "/wv0001-a" }), OWN.MAIN)
  assert.equal(ownerOf("/work/wv0001-a", { wtRoot: WT, main: MAIN }), OWN.OUTSIDE)
  assert.equal(own("sub/wv0001-a"), OWN.OUTSIDE)
  assert.equal(ownerOf(WT, { wtRoot: WT, main: MAIN }), OWN.OUTSIDE, "сама папка слотов")
  assert.equal(ownerOf("/work/demo-wt-2/wv0001-a", { wtRoot: WT, main: MAIN }), OWN.OUTSIDE, "соседняя папка с тем же началом")
})

test("реестр: слот с особым именем — свой; эпик другого репозитория и оркестратор вне папки слотов — нет", () => {
  const epics = [
    { id: "a", status: "closed", orch: { path: WT + "/epic-a" }, slots: [{ slot: "custom" }] },
    { id: "b", status: "closed", orch: { path: "/elsewhere/orch-b" }, slots: [] },
    { id: "c", status: "closed", repo: { main: "/other" }, orch: { path: WT + "/c-orch" }, slots: [{ slot: "theirs" }] },
  ]
  const known = registeredDirs(epics, WT)
  assert.equal(own("custom", { known }), OWN.SLOT)
  assert.equal(own("theirs", { known }), OWN.FOREIGN)
  assert.equal(own("c-orch", { known }), OWN.FOREIGN)
  const { extra, foreign } = splitWorktrees([{ p: "/elsewhere/orch-b" }, { p: WT + "/custom" }], epics, { wtRoot: WT, main: MAIN })
  assert.deepEqual([extra.map((w) => w.p), foreign.map((w) => w.own)], [[WT + "/custom"], [OWN.OUTSIDE]])
})

test("эталон: каждая папка, которую код кладёт в папку слотов по имени, — служебная", () => {
  const hits = []
  for (const f of codeFiles()) for (const m of read(f).matchAll(/join\(WT,\s*"([^"]+)"/g)) hits.push([f, m[1]])
  assert.ok(hits.length >= 5, "сторож не нашёл ни одной папки — сломан поиск")
  for (const [f, n] of hits) assert.equal(own(n), OWN.SERVICE, f + ": папка «" + n + "» в папке слотов не служебная — уборка сочтёт её чужой или слотом")
})

// ── сторож мест удаления ──

// Где код удаляет папку: аргументами git, командой оболочки (git -C … worktree remove, rm -rf) или рекурсивным rm.
// Подсказки человеку («git worktree remove <папка>» без -C) — не вызов и не считаются.
const REMOVE_RES = [
  /["']worktree["']\s*,\s*["']remove["']/g,
  /git\s+-C\s+\S+\s+worktree\s+remove/g,
  /\brm\s+-rf\b/g,
  /\brm(?:Sync)?\s*\([^)]*recursive\s*:\s*true/g,
]
/** Число мест удаления в исходнике. Комментарии вырезаются — в них об удалении можно писать; блочные только с начала
 *  строки: «"$W"/*» в команде оболочки иначе съел бы код до следующего конца комментария. */
function removalSites(src) {
  const code = String(src).replace(/^\s*\/\*[\s\S]*?\*\//gm, "").replace(/^\s*\/\/.*$/gm, "")
  return REMOVE_RES.reduce((n, re) => n + [...code.matchAll(re)].length, 0)
}
/** Берёт ли файл цели из правила «что моё». */
const usesRule = (src) => /from\s+["'][./]*\/?ownership\.mjs["']/.test(src) && /\b(ownerOf|splitWorktrees)\(/.test(src)

// rule: true — уборка рабочих копий этой машины, цели обязаны идти через ownership.mjs.
const ALLOW = {
  "scripts/dev/dashboard/worktree-hygiene.mjs": { sites: 1, rule: true, why: "уборка лишних папок слотов (кнопка страницы)" },
  "scripts/dev/epic.mjs": { sites: 1, rule: true, why: "epic.mjs close --remove-worktrees" },
  "scripts/dev/dashboard/machines.mjs": {
    sites: 3, rule: false,
    why: "удалённая машина: папки прогонов <dir>-wt/<ключ>-p<N> создаёт и ведёт только диспетчерская; живые ключи — в команде",
  },
}

/** Нарушения правила для одного файла: [] — всё в порядке. */
function checkRemoval(file, src, allow = ALLOW) {
  const n = removalSites(src), a = allow[file]
  if (!n) return a ? [file + ": в списке ALLOW, но мест удаления в коде нет — убрать запись"] : []
  if (!a) return [file + ": удаляет папки (" + n + " мест) мимо списка — цели через ownership.mjs, затем запись в ALLOW"]
  const out = []
  if (n !== a.sites) out.push(file + ": мест удаления " + n + ", в ALLOW " + a.sites + " — новое место провести через ownership.mjs, снятое — поправить число")
  if (a.rule && !usesRule(src)) out.push(file + ": уборка без ownership.mjs (ownerOf / splitWorktrees)")
  return out
}

// project/ и projects/ — свои файлы пользователя (ответы квиза, конфиги и надстройки проектов дома), не код ядра
const SKIP = new Set([".git", "node_modules", ".import", "project", "projects"])
function codeFiles(dir = ROOT) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...codeFiles(p))
    else if (/\.(mjs|js)$/.test(e.name) && !/\.test\.mjs$/.test(e.name)) out.push(path.relative(ROOT, p).split(path.sep).join("/"))
  }
  return out
}
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8")

test("сторож: удаляют папки только места из списка, и локальная уборка — через правило «что моё»", () => {
  const files = codeFiles(), bad = files.flatMap((f) => checkRemoval(f, read(f)))
  for (const f of Object.keys(ALLOW)) if (!files.includes(f)) bad.push(f + ": в ALLOW, но файла нет")
  assert.deepEqual(bad, [])
})

test("сторож ловит мутации: новая уборка в обход правила, лишнее место в разрешённом файле, мёртвую запись", () => {
  const rogue = 'export async function sweep(list) { for (const w of list) await git(["worktree", "remove", "--force", w.p]) }'
  assert.equal(removalSites(rogue), 1)
  assert.match(checkRemoval("scripts/dev/new-sweep.mjs", rogue).join(), /мимо списка/)
  const ruled = 'import { ownerOf } from "../ownership.mjs"\nif (ownerOf(p, c) === "slot") await git(["worktree", "remove", p])'
  const allow = { "x.mjs": { sites: 1, rule: true } }
  assert.deepEqual(checkRemoval("x.mjs", ruled, allow), [])
  assert.match(checkRemoval("x.mjs", rogue, allow).join(), /без ownership/)
  assert.match(checkRemoval("x.mjs", ruled + "\nfs.rmSync(w.p, { recursive: true, force: true })", allow).join(), /мест удаления 2/)
  assert.match(checkRemoval("x.mjs", "const a = 1", allow).join(), /убрать запись/)
  assert.equal(removalSites("// git -C R worktree remove d\nconsole.log('git worktree remove ' + p)"), 0, "комментарий и подсказка — не место")
  assert.equal(removalSites("sh(`git -C \"$R\" worktree remove --force \"$d\" || rm -rf \"$d\"`)"), 2)
  const shell = ["sh('for d in \"$W\"/*; do rm -rf \"$d\"; done')", "/** справка */", "fs.rmSync(p, { recursive: true })"].join("\n")
  assert.equal(removalSites(shell), 2, "«/*» в команде оболочки — не начало комментария")
})
