import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { validateProject, normalizeProject, loadProject, loadProjectCode, forgetProject, expandPath, branchNameOk, ProjectConfigError, BASE_DENY, HOME, agentBinPath, isBareCommand, fwd } from "./project.mjs"
import { moduleStates, MODULE_IDS } from "./modules-catalog.mjs"

const DEMO = path.join(HOME, "test", "fixtures", "project.demo.json")
const demo = () => JSON.parse(fs.readFileSync(DEMO, "utf8"))
const paths = (issues) => issues.map((i) => i.path)
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "dk-project-"))

test("демо-конфиг проходит проверку без ошибок и предупреждений", () => {
  const { errors, warnings } = validateProject(demo())
  assert.deepEqual(errors, [])
  assert.deepEqual(warnings, [])
})

test("не объект — одна понятная ошибка", () => {
  for (const bad of [null, [], "x", 5]) assert.equal(validateProject(bad).errors.length, 1)
})

test("схема: нет номера, новее диспетчерской, не число", () => {
  const a = demo(); delete a.schema
  assert.ok(paths(validateProject(a).errors).includes("schema"))
  const b = demo(); b.schema = 99
  assert.match(validateProject(b).errors.find((e) => e.path === "schema").message, /новее диспетчерской/)
  const c = demo(); c.schema = "1"
  assert.ok(paths(validateProject(c).errors).includes("schema"))
})

test("repo: обязательны main и upstream.staging; прод-ветка не равна интеграционной", () => {
  const a = demo(); delete a.repo
  assert.ok(paths(validateProject(a).errors).includes("repo"))
  const b = demo(); b.repo.main = ""
  assert.ok(paths(validateProject(b).errors).includes("repo.main"))
  const c = demo(); delete c.repo.upstream.staging
  assert.ok(paths(validateProject(c).errors).includes("repo.upstream.staging"))
  const d = demo(); d.repo.upstream.main = "develop"
  assert.ok(paths(validateProject(d).errors).includes("repo.upstream.main"))
  const e = demo(); e.repo.upstream.main = null
  assert.deepEqual(validateProject(e).errors, [])
})

test("имя ветки не может стать флагом git и не содержит запретных знаков", () => {
  for (const ok of ["main", "develop", "release/2.x", "feature-1"]) assert.ok(branchNameOk(ok), ok)
  for (const bad of ["", "-D", "a b", "a..b", "x~1", "a:b", "tail/", "x.lock", "a\\b"]) assert.ok(!branchNameOk(bad), bad)
  const a = demo(); a.repo.upstream.staging = "--upload-pack=x"
  assert.ok(paths(validateProject(a).errors).includes("repo.upstream.staging"))
})

test("имя remote проверяется", () => {
  const a = demo(); a.repo.remote = "ori gin"
  assert.ok(paths(validateProject(a).errors).includes("repo.remote"))
})

test("задача: ввод и {input} обязаны совпадать", () => {
  const a = demo(); delete a.tasks["api-test"].input
  assert.ok(paths(validateProject(a).errors).includes("tasks.api-test.input"))
  const b = demo(); b.tasks.lint.input = { label: "что" }
  assert.ok(paths(validateProject(b).errors).includes("tasks.lint.run"))
})

test("задача: id, подпись, команда, папка запуска", () => {
  const a = demo(); a.tasks["Bad_Id"] = { label: "x", run: "true" }
  assert.ok(paths(validateProject(a).errors).includes("tasks.Bad_Id"))
  const b = demo(); delete b.tasks.lint.label; b.tasks.lint.run = ""
  const pb = paths(validateProject(b).errors)
  assert.ok(pb.includes("tasks.lint.label") && pb.includes("tasks.lint.run"))
  for (const cwd of ["../outside", "/abs", "C:/abs", "a/../../b"]) {
    const c = demo(); c.tasks.lint.cwd = cwd
    assert.ok(paths(validateProject(c).errors).includes("tasks.lint.cwd"), cwd)
  }
})

test("разбор вывода: имя заготовки или объект регулярок с группой", () => {
  const a = demo(); a.tasks.lint.parser = "mocha"
  assert.ok(paths(validateProject(a).errors).includes("tasks.lint.parser"))
  const b = demo(); b.tasks.lint.parser = { pass: "^ok (\\S+)", fail: "^not ok (\\S+)", totals: "^# tests" }
  assert.deepEqual(validateProject(b).errors, [])
  const c = demo(); c.tasks.lint.parser = { pass: "^ok \\S+" }
  assert.match(validateProject(c).errors.find((e) => e.path === "tasks.lint.parser.pass").message, /группа/)
  const d = demo(); d.tasks.lint.parser = { fail: "(" }
  assert.match(validateProject(d).errors.find((e) => e.path === "tasks.lint.parser.fail").message, /не разбирается/)
  const e = demo(); e.tasks.lint.parser = { names: "^x" }
  assert.ok(paths(validateProject(e).errors).includes("tasks.lint.parser"))
  const f = demo(); f.tasks.lint.parser = { pass: "(a)", extra: "b" }
  assert.ok(paths(validateProject(f).errors).includes("tasks.lint.parser.extra"))
})

test("ссылки на задачи из областей и станций проверяются", () => {
  const a = demo(); a.areas.api.tasks = ["nope"]
  assert.ok(paths(validateProject(a).errors).includes("areas.api.tasks"))
  const b = demo(); b.stations = { tests: ["api-test"], guards: ["ghost"] }
  assert.deepEqual(paths(validateProject(b).errors), ["stations.guards"])
})

test("область без путей — ошибка", () => {
  const a = demo(); a.areas.web.paths = []
  assert.ok(paths(validateProject(a).errors).includes("areas.web.paths"))
})

test("машины: local без ssh, удалённой нужны ssh и dir", () => {
  const a = demo(); a.machines.local.ssh = "box"
  assert.ok(paths(validateProject(a).errors).includes("machines.local.ssh"))
  const b = demo(); b.machines.build = { workers: 2 }
  assert.ok(paths(validateProject(b).errors).includes("machines.build.ssh"))
  const c = demo(); c.machines.build = { ssh: "build-box" }
  assert.ok(paths(validateProject(c).errors).includes("machines.build.dir"))
  const d = demo(); d.machines.build = { ssh: "build-box", dir: "~/dk", workers: 0 }
  assert.ok(paths(validateProject(d).errors).includes("machines.build.workers"))
})

test("дорожка без машины — предупреждение, а не ошибка", () => {
  const a = demo(); a.machines.local.lanes = ["main"]
  const { errors, warnings } = validateProject(a)
  assert.deepEqual(errors, [])
  assert.deepEqual(paths(warnings), ["tasks.api-test.lane"])
})

test("выкат прода без прод-ветки — ошибка", () => {
  const a = demo(); a.repo.upstream.main = null; a.release = { prod: { run: "./deploy.sh" } }
  assert.ok(paths(validateProject(a).errors).includes("release.prod"))
})

test("модули: неизвестный id и не булево значение", () => {
  const a = demo(); a.modules = { ghost: true, tg: "yes" }
  assert.deepEqual(paths(validateProject(a).errors).sort(), ["modules.ghost", "modules.tg"])
})

test("неизвестный ключ верхнего уровня — предупреждение", () => {
  const a = demo(); a.extra = 1
  const r = validateProject(a)
  assert.deepEqual(r.errors, [])
  assert.deepEqual(paths(r.warnings), ["extra"])
})

test("проверка собирает все ошибки разом", () => {
  const r = validateProject({ schema: 1, repo: { upstream: {} }, tasks: { a: {} }, modules: { x: true } })
  assert.ok(r.errors.length >= 5, "ошибок: " + r.errors.length)
})

test("нормализация: пути абсолютные, умолчания проставлены", () => {
  const p = normalizeProject(demo(), { baseDir: os.tmpdir(), cpus: 8 })
  assert.equal(p.repo.main, expandPath("~/code/demo-shop"))
  assert.ok(path.isAbsolute(p.repo.main) && !p.repo.main.includes("\\"))
  assert.equal(p.repo.data, p.repo.worktrees + "/_dashboard")
  assert.equal(p.repo.sparse, false)
  assert.equal(p.agent.runtime, "claude")
  assert.ok(p.agent.models.orch && p.agent.models.slot)
  assert.equal(p.tasks.lint.lane, "main")
  assert.equal(p.tasks.lint.parser, "exit-code")
  assert.equal(p.tasks["api-test"].lane, "db")
  assert.equal(p.machines.local.workers, 4)
  assert.equal(p.machines.local.lanes, null)
  assert.equal(p.limits.slots, 3)
})

test("нормализация: папки по умолчанию — рядом с репозиторием", () => {
  const raw = demo(); delete raw.repo.worktrees; raw.repo.main = "repo"
  const base = tmpDir()
  const p = normalizeProject(raw, { baseDir: base })
  assert.equal(p.repo.main, expandPath("repo", base))
  assert.equal(p.repo.worktrees, expandPath("repo-wt", base))
})

test("нормализация: станции по умолчанию — гейты в гарды, остальное в тесты", () => {
  const p = normalizeProject(demo())
  assert.deepEqual(p.stations.guards, ["lint", "typecheck"])
  assert.deepEqual(p.stations.tests, ["api-test", "web-test"])
})

test("нормализация: запреты проекта добавляются к базовым; base:false снимает базовые", () => {
  const p = normalizeProject(demo())
  for (const c of BASE_DENY.commands) assert.ok(p.deny.commands.includes(c), c)
  assert.ok(p.deny.commands.includes("npx jest"))
  assert.deepEqual(p.deny.ask, ["git commit"])
  const raw = demo(); raw.deny.base = false
  const q = normalizeProject(raw)
  assert.deepEqual(q.deny.commands, ["npx jest", "npx vitest", "npm test"])
  assert.deepEqual(q.deny.ask, [])
})

test("нормализация: у Codex модели по умолчанию пустые, машина local есть всегда", () => {
  const raw = demo(); raw.agent = { runtime: "codex" }; delete raw.machines
  const p = normalizeProject(raw, { cpus: 2 })
  assert.deepEqual(p.agent.models, { orch: "", slot: "", review: "" })
  assert.equal(p.machines.local.workers, 1)
  assert.equal(p.machines.local.label, "Эта машина")
})

test("loadProject: нет файла, не JSON, ошибки проверки — три разных кода", () => {
  const dir = tmpDir()
  const file = path.join(dir, "dispatcher.project.json")
  assert.throws(() => loadProject({ file }), (e) => e instanceof ProjectConfigError && e.code === "missing" && /SETUP\.md/.test(e.message))
  fs.writeFileSync(file, "{ not json")
  assert.throws(() => loadProject({ file }), (e) => e.code === "json")
  fs.writeFileSync(file, JSON.stringify({ schema: 1 }))
  assert.throws(() => loadProject({ file }), (e) => e.code === "invalid" && e.issues.length > 0 && /repo/.test(e.message))
})

test("loadProject: читает файл с BOM, кеширует, fresh перечитывает", () => {
  forgetProject()
  const dir = tmpDir()
  const file = path.join(dir, "dispatcher.project.json")
  const raw = demo(); raw.repo.main = "repo"; delete raw.repo.worktrees
  fs.writeFileSync(file, "\uFEFF" + JSON.stringify(raw))
  const a = loadProject({ file })
  assert.equal(a.repo.main, expandPath("repo", dir))
  assert.equal(a.file, file.replace(/\\/g, "/"))
  assert.deepEqual(a.warnings, [])
  raw.name = "renamed"
  fs.writeFileSync(file, JSON.stringify(raw))
  assert.equal(loadProject({ file }).name, "demo-shop")
  assert.equal(loadProject({ file, fresh: true }).name, "renamed")
})

test("код-надстройка: нет файла — пусто; лишний экспорт — предупреждение; не функция — ошибка", async () => {
  const dir = tmpDir()
  const file = path.join(dir, "dispatcher.project.json")
  assert.deepEqual(await loadProjectCode({ file }), { hooks: {}, warnings: [] })
  fs.writeFileSync(path.join(dir, "dispatcher.project.mjs"), "export const buildSteps = () => []\nexport const stray = 1\n")
  const r = await loadProjectCode({ file })
  assert.deepEqual(Object.keys(r.hooks), ["buildSteps"])
  assert.equal(r.warnings.length, 1)
  const dir2 = tmpDir()
  fs.writeFileSync(path.join(dir2, "dispatcher.project.mjs"), "export const slotPrepare = 5\n")
  await assert.rejects(loadProjectCode({ file: path.join(dir2, "dispatcher.project.json") }), (e) => e instanceof ProjectConfigError)
})

test("модули: умолчания, платформа, нехватка конфига, зависимость", () => {
  const p = normalizeProject(demo())
  const st = Object.fromEntries(moduleStates(p, { platform: "linux" }).map((m) => [m.id, m]))
  assert.deepEqual(Object.keys(st), MODULE_IDS)
  assert.ok(st.review.on && st.backlog.on)
  assert.ok(!st.tg.on && /по умолчанию/.test(st.tg.why))
  const raw = demo(); raw.modules = { machines: true, release: true, accept: true, "win-desktop": true, retro: true, backlog: false }
  const q = Object.fromEntries(moduleStates(normalizeProject(raw), { platform: "linux" }).map((m) => [m.id, m]))
  assert.match(q.machines.why, /ssh/)
  assert.match(q.release.why, /release\.stand\.run/)
  assert.match(q.accept.why, /accept\.run/)
  assert.match(q["win-desktop"].why, /win32/)
  assert.match(q.retro.why, /backlog/)
  assert.match(q.backlog.why, /выключен в/)
  raw.machines.build = { ssh: "build-box", dir: "~/dk" }; raw.release = { stand: { run: "./stand.sh" } }; raw.accept = { run: "npx playwright test" }
  const r = Object.fromEntries(moduleStates(normalizeProject(raw), { platform: "win32" }).map((m) => [m.id, m]))
  assert.ok(r.machines.on && r.release.on && r.accept.on && r["win-desktop"].on)
})

test("agent.network: только true/false, по умолчанию сети нет (песочница Codex без выхода в сеть)", () => {
  const raw = demo()
  assert.equal(normalizeProject(raw).agent.network, false)
  raw.agent.network = true
  assert.deepEqual(validateProject(raw).errors, [])
  assert.equal(normalizeProject(raw).agent.network, true)
  raw.agent.network = "yes"
  assert.deepEqual(paths(validateProject(raw).errors), ["agent.network"])
})

test("agent.bin: путь к бинарнику агента — строка; пусто — искать в PATH", () => {
  const raw = demo()
  assert.equal(normalizeProject(raw).agent.bin, "")
  const abs = fwd(path.join(os.tmpdir(), "agent", "bin", "claude"))
  raw.agent.bin = abs
  assert.deepEqual(validateProject(raw).errors, [])
  assert.equal(normalizeProject(raw).agent.bin, abs)
  raw.agent.bin = ""
  assert.deepEqual(validateProject(raw).errors, [])
  for (const bad of [42, true, ["claude"], "   "]) {
    raw.agent.bin = bad
    assert.deepEqual(paths(validateProject(raw).errors), ["agent.bin"], JSON.stringify(bad))
  }
})

test("agent.bin разворачивается как остальные пути: `~` — домашняя папка, относительный — от папки конфига; голое имя — имя в PATH", () => {
  const raw = demo(), base = path.join(os.tmpdir(), "dk-cfg-dir")
  const bin = (v) => { raw.agent.bin = v; return normalizeProject(raw, { baseDir: base }).agent.bin }
  assert.equal(bin("~/tools/claude"), fwd(path.join(os.homedir(), "tools", "claude")))
  assert.equal(bin("~\\tools\\claude.exe"), fwd(path.join(os.homedir(), "tools", "claude.exe")))
  assert.equal(bin("bin/claude"), fwd(path.join(base, "bin", "claude")), "относительный путь — от папки конфига, а не от текущей")
  assert.equal(bin("./claude"), fwd(path.join(base, "claude")), "с разделителем — путь, даже если рядом с конфигом")
  assert.equal(bin(fwd(path.join(base, "abs", "claude"))), fwd(path.join(base, "abs", "claude")))
  assert.equal(bin("claude"), "claude", "голое имя не трогается")
  assert.equal(bin("  codex.cmd  "), "codex.cmd")
  assert.equal(agentBinPath(""), "")
  assert.ok(isBareCommand("claude") && !isBareCommand("a/claude") && !isBareCommand("a\\claude") && !isBareCommand("~/claude"))
})
