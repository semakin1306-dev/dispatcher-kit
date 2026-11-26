// Дом (dispatcher.home.json): проверка схемы, относительные пути, повторы, общее в конфиге проекта, выбор проекта,
// и главное — без дома всё как прежде.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  DEMO_PROJECT, HUB_PORT, forgetProject, fwd, homeEntryFor, homeFile, legacyProjectFile, loadHome, loadProject,
  normalizeHome, normalizeProject, projectFile, validateHome, validateProject,
} from "./project.mjs"
import { selectProject, takeProjectArg } from "./select-project.mjs"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dk-home-"))
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
let n = 0
const dir = () => { const d = path.join(TMP, "h" + ++n); fs.mkdirSync(d, { recursive: true }); return d }
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v, null, 2)) }
const demo = () => JSON.parse(fs.readFileSync(DEMO_PROJECT, "utf8"))
const paths = (r) => r.errors.map((e) => e.path)

/** Дом с двумя проектами в папке d: конфиги проектов — демо с репозиториями внутри d. */
function makeHome(d, { shared = {}, hub, projects } = {}) {
  for (const id of ["shop", "site"]) {
    const raw = demo(); raw.name = id; raw.repo.main = fwd(path.join(d, id)); raw.repo.worktrees = fwd(path.join(d, id + "-wt"))
    if (id === "site") { delete raw.agent; delete raw.machines; delete raw.limits }
    write(path.join(d, "projects", id, "dispatcher.project.json"), raw)
    fs.mkdirSync(path.join(d, id), { recursive: true })
  }
  const home = { schema: 1, ...(hub ? { hub } : {}), shared, projects: projects || [
    { id: "shop", file: "projects/shop/dispatcher.project.json", port: 4801 },
    { id: "site", file: "./projects/site/dispatcher.project.json", port: 4802, start: "lazy" },
  ] }
  const file = path.join(d, "dispatcher.home.json")
  write(file, home)
  return { file, env: { DISPATCHER_HOME: file } }
}

test("схема дома: понятные ошибки по пути ключа", () => {
  assert.deepEqual(paths(validateHome(null)), [""])
  assert.deepEqual(paths(validateHome({ schema: 1 })), ["projects"], "без проектов дом не нужен")
  assert.deepEqual(paths(validateHome({ schema: 1, projects: [] })), ["projects"])
  const r = validateHome({
    schema: 2, extra: 1, hub: { port: 80, idleStopMin: 0 },
    shared: { agent: { runtime: "gpt" }, limits: { slots: 99 }, machines: { box: { workers: 2 } }, tg: true },
    projects: [{ id: "Bad Id", file: "", port: "4801", start: "sometimes" }, "x"],
  })
  assert.deepEqual(paths(r).sort(), [
    "hub.idleStopMin", "hub.port", "projects[0].file", "projects[0].id", "projects[0].port", "projects[0].start", "projects[1]",
    "schema", "shared.agent.runtime", "shared.limits.slots", "shared.machines.box.ssh",
  ].sort())
  assert.match(r.errors.find((e) => e.path === "schema").message, /новее диспетчерской/)
  assert.deepEqual(r.warnings.map((w) => w.path).sort(), ["extra", "shared.tg"])
})

test("схема дома: повтор id, порта, файла (в разной записи) и порт хаба — ошибка с указанием, чем занят", () => {
  const base = dir()
  const r = validateHome({
    schema: 1, hub: { port: 4900 },
    projects: [
      { id: "a", file: "projects/a/dispatcher.project.json", port: 4801 },
      { id: "a", file: "./projects/a/../a/dispatcher.project.json", port: 4801 },
      { id: "b", file: fwd(path.join(base, "projects/a/dispatcher.project.json")), port: 4900 },
    ],
  }, { baseDir: base })
  const by = Object.fromEntries(r.errors.map((e) => [e.path, e.message]))
  assert.match(by["projects[1].id"], /id `a` уже занят: `projects\[0\]\.id`/)
  assert.match(by["projects[1].port"], /порт 4801 уже занят/)
  assert.match(by["projects[1].file"], /этот конфиг уже занят: `projects\[0\]\.file`/, "./a/../a — тот же файл")
  assert.match(by["projects[2].file"], /уже занят/, "абсолютный путь к тому же файлу — тот же файл")
  assert.match(by["projects[2].port"], /`hub\.port`/, "порт хаба процессу проекта не отдаётся")
  assert.equal(validateHome({ schema: 1, projects: [{ id: "a", file: "x.json", port: HUB_PORT }] }).errors[0].path, "projects[0].port")
})

test("нормализация дома: пути — от папки дома, умолчания хаба, путь агента — от дома, а не от проекта", () => {
  const d = dir()
  const h = normalizeHome({ schema: 1, shared: { agent: { bin: "tools/agent" } }, projects: [{ id: "a", file: "projects/a/p.json", port: 4801 }] }, { file: path.join(d, "dispatcher.home.json") })
  assert.equal(h.projects[0].file, fwd(path.join(d, "projects/a/p.json")))
  assert.equal(h.projects[0].start, "always")
  assert.deepEqual(h.hub, { port: HUB_PORT, data: fwd(path.join(d, ".hub")), idleStopMin: 30 })
  assert.equal(h.shared.agent.bin, fwd(path.join(d, "tools/agent")))
  assert.equal(h.shared.limits.slots, null)
})

test("loadHome: нет файла, не JSON, ошибки схемы — свои коды; правка файла видна без сброса кеша", () => {
  const d = dir(), f = path.join(d, "dispatcher.home.json")
  assert.throws(() => loadHome({ file: f }), (e) => e.code === "missing" && /setup\.mjs add/.test(e.message))
  write(f, "{ нет"); assert.throws(() => loadHome({ file: f }), (e) => e.code === "json")
  write(f, { schema: 1, projects: [{ id: "a", file: "a.json", port: 1 }] })
  assert.throws(() => loadHome({ file: f }), (e) => e.code === "home" && e.issues[0].path === "projects[0].port" && /doctor/.test(e.message))
  write(f, { schema: 1, projects: [{ id: "a", file: "a.json", port: 4801 }] })
  assert.equal(loadHome({ file: f }).projects.length, 1)
  const t = new Date(Date.now() + 5000)
  write(f, { schema: 1, projects: [{ id: "a", file: "a.json", port: 4801 }, { id: "b", file: "b.json", port: 4802 }] }); fs.utimesSync(f, t, t)
  assert.deepEqual(loadHome({ file: f }).projects.map((e) => e.id), ["a", "b"])
})

test("проект дома получает общее: агент и модели по ролям, машины с папкой проекта, свой и общий предел", () => {
  const d = dir()
  const { file, env } = makeHome(d, {
    hub: { data: "state" },
    shared: { agent: { runtime: "codex", models: { orch: "big" }, proxy: "http://127.0.0.1:3128" }, machines: { box: { ssh: "box", dir: "~/dk/", workers: 6 } }, limits: { slots: 4 } },
  })
  const shop = loadProject({ file: path.join(d, "projects/shop/dispatcher.project.json"), fresh: true, env })
  const site = loadProject({ file: path.join(d, "projects/site/dispatcher.project.json"), fresh: true, env })
  assert.equal(shop.agent.runtime, "claude", "свой рантайм проекта перекрывает общий")
  assert.equal(shop.agent.proxy, "http://127.0.0.1:3128", "незаданное у проекта — из дома")
  assert.equal(site.agent.runtime, "codex"); assert.equal(site.agent.models.orch, "big")
  assert.equal(site.machines.box.dir, "~/dk/site", "у каждого проекта свой клон на общей машине")
  assert.equal(shop.machines.box.dir, "~/dk/shop"); assert.equal(shop.machines.local.workers, 4, "своя машина проекта — как в его конфиге")
  assert.equal(shop.limits.slots, 3, "свой предел проекта"); assert.equal(site.limits.slots, 4, "своего нет — общий")
  for (const p of [shop, site]) assert.deepEqual(p.limits.shared, { slots: 4, dir: fwd(path.join(d, "state", "places")) })
  // тот же файл без дома — ровно прежняя нормализация
  const alone = loadProject({ file: path.join(d, "projects/shop/dispatcher.project.json"), fresh: true, env: { DISPATCHER_HOME: path.join(d, "нет.json") } })
  const raw = JSON.parse(fs.readFileSync(path.join(d, "projects/shop/dispatcher.project.json"), "utf8"))
  const { warnings, ...rest } = alone
  assert.deepEqual(rest, normalizeProject(raw, { baseDir: path.join(d, "projects", "shop"), file: path.join(d, "projects/shop/dispatcher.project.json") }))
  assert.equal(alone.limits.shared, null); assert.ok(!alone.machines.box)
  assert.ok(file)
})

test("выбор проекта: DISPATCHER_PROJECT побеждает дом; id; папка проекта или слотов; единственный; иначе — список", () => {
  const d = dir(), { env } = makeHome(d)
  forgetProject()
  const other = path.join(d, "other.json")
  assert.equal(projectFile({ ...env, DISPATCHER_PROJECT: other }), path.resolve(other))
  assert.equal(projectFile({ ...env, DISPATCHER_PROJECT_ID: "site" }), fwd(path.join(d, "projects/site/dispatcher.project.json")))
  assert.throws(() => projectFile({ ...env, DISPATCHER_PROJECT_ID: "nope" }), (e) => e.code === "unknown-project" && /есть: shop, site/.test(e.message))
  assert.equal(homeEntryFor(env, { cwd: path.join(d, "site", "src") }).id, "site", "cwd внутри основной папки")
  assert.equal(homeEntryFor(env, { cwd: path.join(d, "shop-wt", "wv0001-x") }).id, "shop", "cwd внутри папки слотов")
  assert.throws(() => projectFile(env, { cwd: TMP }), (e) => e.code === "ambiguous" && /shop, site/.test(e.message) && /--project/.test(e.message))
  const one = dir(), solo = makeHome(one, { projects: [{ id: "shop", file: "projects/shop/dispatcher.project.json", port: 4801 }] })
  assert.equal(projectFile(solo.env, { cwd: TMP }), fwd(path.join(one, "projects/shop/dispatcher.project.json")), "проект один — он и выбран")
})

test("без дома — как прежде: конфиг рядом с местом дома, демо под тестом, проект без общего", () => {
  const d = dir(), env = { DISPATCHER_HOME: path.join(d, "dispatcher.home.json") }
  assert.equal(homeEntryFor(env), null)
  assert.equal(projectFile(env), path.join(d, "dispatcher.project.json"))
  assert.equal(legacyProjectFile(env), path.join(d, "dispatcher.project.json"))
  assert.equal(projectFile({ NODE_TEST_CONTEXT: "child" }), DEMO_PROJECT, "под node --test — демо")
  assert.equal(homeFile({ NODE_TEST_CONTEXT: "child" }), "", "под node --test дома владельца нет")
  assert.equal(homeFile({}).endsWith("dispatcher.home.json"), true)
  write(path.join(d, "dispatcher.project.json"), demo())
  const p = loadProject({ file: projectFile(env), fresh: true, env })
  assert.equal(p.limits.shared, null); assert.equal(p.mode, "full"); assert.equal(p.machines.local.workers, 4)
})

test("режим проекта: full | light; light — предупреждение «в разработке»", () => {
  const r = (mode) => validateProject({ ...demo(), mode })
  assert.deepEqual(r("full").errors, []); assert.deepEqual(r("full").warnings, [])
  assert.deepEqual(r("light").errors, []); assert.match(r("light").warnings[0].message, /в разработке/)
  assert.equal(r("heavy").errors[0].path, "mode")
  assert.equal(normalizeProject({ ...demo(), mode: "light" }).mode, "light")
})

test("--project у команд: снимается из argv, ставит проект и порт его процесса; без дома и чужой — ошибка", () => {
  const argv = ["node", "epic.mjs", "list", "--project", "site", "--dry-run"]
  assert.equal(takeProjectArg(argv), "site"); assert.deepEqual(argv, ["node", "epic.mjs", "list", "--dry-run"])
  const eq = ["node", "x", "--project=shop"]; assert.equal(takeProjectArg(eq), "shop"); assert.deepEqual(eq, ["node", "x"])
  assert.equal(takeProjectArg(["node", "x", "list"]), "")
  assert.throws(() => takeProjectArg(["node", "x", "--project"]), /нужен id/)
  const d = dir(), { env } = makeHome(d)
  const e1 = { ...env }
  assert.equal(selectProject(["node", "x", "--project", "site"], e1).id, "site")
  assert.equal(e1.DISPATCHER_PROJECT, fwd(path.join(d, "projects/site/dispatcher.project.json"))); assert.equal(e1.DASH_PORT, "4802")
  const e2 = { ...env, DASH_PORT: "5000" }; selectProject(["node", "x", "--project", "shop"], e2)
  assert.equal(e2.DASH_PORT, "5000", "заданный порт не перекрывается")
  assert.throws(() => selectProject(["node", "x", "--project", "site"], { ...env, DISPATCHER_PROJECT: e2.DISPATCHER_PROJECT }), /другого проекта/)
  assert.equal(selectProject(["node", "x"], { ...env, DISPATCHER_PROJECT: e2.DISPATCHER_PROJECT }), null, "процесс проекта и его агенты — без выбора")
  assert.throws(() => selectProject(["node", "x", "--project", "a"], { DISPATCHER_HOME: path.join(d, "нет.json") }), /дома нет/)
})
