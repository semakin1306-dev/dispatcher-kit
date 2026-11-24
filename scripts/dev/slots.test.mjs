import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { pathToFileURL, fileURLToPath } from "node:url"
import { MAIN, WT, WT_OVERRIDDEN, PROJECT, COMMON_DENY, COMMON_ASK, EPIC_FILE, SLOTS, ORCH, loadEpics, saveEpics, activeEpic, orchOf } from "./slots.mjs"
import { DATA, settings, SETTINGS_FILE } from "./dashboard/config.mjs"
import { DEMO_PROJECT } from "./project.mjs"
import { toClaudeRules } from "./runtimes/claude-policy.mjs"

const SLOTS_URL = pathToFileURL(fileURLToPath(new URL("./slots.mjs", import.meta.url))).href
const CONFIG_URL = pathToFileURL(fileURLToPath(new URL("./dashboard/config.mjs", import.meta.url))).href
/** Загрузить модули в отдельном процессе с заданным окружением и вернуть напечатанный JSON. */
function probe(env, expr) {
  const clean = { ...process.env }
  for (const k of ["NODE_TEST_CONTEXT", "DISPATCHER_PROJECT", "DISPATCHER_MAIN", "DISPATCHER_WT", "DASH_DATA", "DASH_EPIC_FILE"]) delete clean[k]
  return spawnSync(process.execPath, ["--input-type=module", "-e", `const s = await import(${JSON.stringify(SLOTS_URL)}); const c = await import(${JSON.stringify(CONFIG_URL)}); console.log(JSON.stringify(${expr}))`], { encoding: "utf8", env: { ...clean, ...env } })
}

test("под тестами — демо-проект, а пути в песочнице временной папки", () => {
  assert.equal(path.resolve(PROJECT.file), path.resolve(DEMO_PROJECT))
  const tmp = fs.realpathSync(os.tmpdir())
  for (const p of [MAIN, WT, DATA, EPIC_FILE, SETTINGS_FILE]) assert.ok(path.resolve(p).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()) || path.resolve(p).toLowerCase().startsWith(tmp.toLowerCase()), p)
  assert.ok(WT_OVERRIDDEN)
  assert.equal(DATA, path.join(WT, "_dashboard"))
})

test("запреты слота: команда-начало, команда целиком, пути правки и чтения; коммит — спрашивать", () => {
  for (const r of ["Bash(git push:*)", "Bash(git add .)", "Bash(ssh:*)", "Bash(npx jest:*)", "Edit(/package.json)", "Edit(/.github/**)", "Read(**/.env)"]) assert.ok(COMMON_DENY.includes(r), r)
  assert.ok(!COMMON_DENY.includes("Bash(git add .:*)"), "«git add .» закрыт целиком, а не началом: `git add .gitignore` остаётся")
  assert.deepEqual(COMMON_ASK, ["Bash(git commit:*)"])
  assert.deepEqual(toClaudeRules({ commands: ["a b", "=c d"], edit: ["/x/**"], read: ["**/.env"], ask: ["git commit"] }), { deny: ["Bash(a b:*)", "Bash(c d)", "Edit(/x/**)", "Read(**/.env)"], ask: ["Bash(git commit:*)"] })
})

test("реестр эпиков: пустой без файла и чтение ничего не пишет; запись хранит прежнюю версию", () => {
  assert.ok(!fs.existsSync(EPIC_FILE))
  assert.deepEqual(loadEpics(), { active: null, epics: [] })
  assert.ok(!fs.existsSync(EPIC_FILE), "чтение реестра файл не создаёт")
  assert.equal(activeEpic(), null)
  assert.deepEqual(SLOTS, []); assert.equal(ORCH, null)
  const epic = { id: "demo", title: "Демо", status: "open", orch: { branch: "dev/epic-demo", path: path.join(WT, "epic-demo") }, slots: [] }
  saveEpics({ active: "demo", epics: [epic] })
  assert.equal(activeEpic().id, "demo")
  saveEpics({ active: "demo", epics: [{ ...epic, title: "Демо 2" }, { ...epic, id: "old", status: "closed" }] })
  assert.equal(JSON.parse(fs.readFileSync(EPIC_FILE + ".prev", "utf8")).epics[0].title, "Демо")
  assert.equal(activeEpic().title, "Демо 2")
  assert.equal(activeEpic({ active: "old", epics: [{ id: "old", status: "closed" }, { id: "new", status: "open" }] }).id, "new", "закрытый эпик активным не бывает, пока есть открытый")
  assert.deepEqual(orchOf(epic).folders.map((f) => f.path), [MAIN.replace(/\\/g, "/"), epic.orch.path])
  fs.rmSync(path.dirname(EPIC_FILE), { recursive: true, force: true })
})

test("переключатели по умолчанию: всё, что действует без человека, выключено", () => {
  for (const k of ["autoTrain", "autoCommit", "autoMerge", "autoSyncConflict", "fullPermissions", "retroAuto"]) assert.equal(settings[k], false, k)
  assert.equal(settings.selfCommit, "word")
})

test("вне тестов пути берутся из конфига проекта, а окружение их перекрывает", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dk-slots-"))
  const file = path.join(dir, "dispatcher.project.json")
  fs.writeFileSync(file, JSON.stringify({ schema: 1, repo: { main: "repo", upstream: { staging: "develop" } }, tasks: { t: { label: "t", run: "true" } } }))
  const plain = probe({ DISPATCHER_PROJECT: file }, "{ main: s.MAIN, wt: s.WT, over: s.WT_OVERRIDDEN, data: c.DATA }")
  assert.equal(plain.status, 0, plain.stderr)
  const a = JSON.parse(plain.stdout)
  assert.equal(a.main, path.join(dir, "repo")); assert.equal(a.wt, path.join(dir, "repo-wt")); assert.equal(a.over, false)
  assert.equal(path.resolve(a.data), path.join(dir, "repo-wt", "_dashboard"))
  const over = probe({ DISPATCHER_PROJECT: file, DISPATCHER_MAIN: path.join(dir, "m"), DISPATCHER_WT: path.join(dir, "w") }, "{ main: s.MAIN, wt: s.WT, over: s.WT_OVERRIDDEN, data: c.DATA }")
  const b = JSON.parse(over.stdout)
  assert.deepEqual([b.main, b.wt, b.over, b.data], [path.join(dir, "m"), path.join(dir, "w"), true, path.join(dir, "w", "_dashboard")])
  const data = probe({ DISPATCHER_PROJECT: file, DASH_DATA: path.join(dir, "d") }, "c.DATA")
  assert.equal(JSON.parse(data.stdout), path.join(dir, "d"))
})

test("нет конфига проекта — загрузка отказывает и говорит, что делать", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dk-slots-"))
  const r = probe({ DISPATCHER_PROJECT: path.join(dir, "none.json") }, "s.MAIN")
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /Проект не настроен/); assert.match(r.stderr, /SETUP\.md/)
})
