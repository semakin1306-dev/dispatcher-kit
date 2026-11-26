// Хаб дома: выбор проекта запроса, подмена токена, окружение ядра — по отдельности; затем сквозной прогон на двух
// игрушечных проектах с поддельным Claude Code: пересылка, сводка, ленивый запуск, общий предел агентов слотов между
// процессами, падение ядра и перезапуск, остановка без дел, остановка хаба со всеми ядрами. Порты — свободные
// случайные (4777 не трогается), всё во временной папке, настоящие агенты не запускаются.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { coreHeaders, pageWithToken, pickProject, projectInUrl } from "./proxy.mjs"
import { BACKOFF_MS, backoffMs, coreEnv } from "./cores.mjs"
import { freePort, installFakeClaude } from "../../../test/fixtures/fake-runtime.mjs"

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const fwd = (p) => p.split(path.sep).join("/")

test("выбор проекта: заголовок, ?project=, путь /p/<id>/, Referer своей страницы, единственный; иначе 400 или 404", () => {
  const req = (headers = {}) => ({ headers: { host: "127.0.0.1:5000", ...headers } })
  const u = (s) => new URL(s, "http://127.0.0.1:5000")
  const ids = ["shop", "site"]
  assert.deepEqual(pickProject(req({ "x-dash-project": "site" }), u("/api/state"), ids), { id: "site", path: "/api/state" })
  assert.deepEqual(pickProject(req(), u("/api/state?project=shop&ver=3"), ids), { id: "shop", path: "/api/state?project=shop&ver=3" })
  assert.deepEqual(pickProject(req(), u("/p/site/"), ids), { id: "site", path: "/" })
  assert.deepEqual(pickProject(req(), u("/p/site/ui/dash.css?v=1"), ids), { id: "site", path: "/ui/dash.css?v=1" })
  assert.deepEqual(pickProject(req({ referer: "http://127.0.0.1:5000/p/site/" }), u("/api/events?epic=e1"), ids).id, "site")
  assert.deepEqual(pickProject(req({ referer: "http://127.0.0.1:5000/?project=shop" }), u("/api/state"), ids).id, "shop")
  assert.equal(pickProject(req({ referer: "http://evil.test:5000/p/site/" }), u("/api/state"), ids).code, 400, "Referer чужого адреса не выбирает проект")
  assert.equal(pickProject(req(), u("/api/state"), ids).code, 400)
  assert.match(pickProject(req(), u("/api/state"), ids).error, /shop, site/)
  assert.equal(pickProject(req({ "x-dash-project": "nope" }), u("/api/state"), ids).code, 404)
  assert.deepEqual(pickProject(req(), u("/api/state"), ["solo"]), { id: "solo", path: "/api/state" }, "проект один — он и есть")
  assert.equal(projectInUrl(u("/api/state")), null)
})

test("токен: страница ядра уходит с токеном хаба; ядру — Host и токен ядра, заголовки хаба не уходят", () => {
  const html = '<meta name="dash-token" content="aaa111"><script>x</script>'
  assert.equal(pageWithToken(html, "aaa111", "bbb222"), '<meta name="dash-token" content="bbb222"><script>x</script>')
  assert.equal(pageWithToken(html, "", "bbb222"), html, "токена ядра ещё нет — страница как есть")
  const h = coreHeaders({ host: "127.0.0.1:4777", "x-dash-project": "a", "x-dash-token": "hub", "x-dash-epic": "e1", connection: "keep-alive" }, { port: 4801, token: "core" })
  assert.deepEqual(h, { "x-dash-epic": "e1", host: "127.0.0.1:4801", "x-dash-token": "core" })
  assert.deepEqual(coreHeaders({ host: "x", "x-dash-token": "hub" }, { port: 4801 }), { host: "127.0.0.1:4801" }, "чтение — без токена")
})

test("окружение ядра: свои проект, порт и данные; переменные хаба и тестов не наследуются; паузы перезапуска растут", () => {
  const env = coreEnv(
    { PATH: "p", DASH_DATA: "/hub", DASH_DRY: "1", DISPATCHER_MAIN: "/x", DISPATCHER_PROJECT_ID: "z", NODE_TEST_CONTEXT: "child" },
    { file: "/h/projects/a/dispatcher.project.json", homeFile: "/h/dispatcher.home.json", port: 4801, data: "/a-wt/_dashboard", reason: "r" },
  )
  assert.deepEqual(env, {
    PATH: "p", DISPATCHER_PROJECT: "/h/projects/a/dispatcher.project.json", DISPATCHER_HOME: "/h/dispatcher.home.json",
    DASH_PORT: "4801", DASH_DATA: "/a-wt/_dashboard", DASH_START_REASON: "r",
  })
  assert.deepEqual([1, 2, 3, 99].map(backoffMs), [BACKOFF_MS[0], BACKOFF_MS[1], BACKOFF_MS[2], BACKOFF_MS.at(-1)])
})

// ───────────────────────────── сквозной прогон ─────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dk-hub-"))
let hub = null
after(async () => {
  if (hub && hub.exitCode === null) {
    try { if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(hub.pid), "/T", "/F"], { stdio: "ignore" }); else hub.kill() } catch { /* вышел */ }
    await new Promise((r) => { hub.once("exit", r); setTimeout(r, 5000) })
  }
  if (process.env.DK_E2E_KEEP) console.log("папка прогона оставлена: " + TMP)
  else fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const ENV = { ...process.env }
delete ENV.NODE_TEST_CONTEXT
for (const k of Object.keys(ENV)) if (/^(DASH_|DISPATCHER_)/.test(k)) delete ENV[k]
const HOME_FILE = path.join(TMP, "kit", "dispatcher.home.json")
Object.assign(ENV, {
  DISPATCHER_HOME: HOME_FILE, DISPATCHER_SKILLS_DIR: path.join(TMP, "skills"), FAKE_CLAUDE_LOG: path.join(TMP, "fake-claude.log"), DASH_HUB_TICK_MS: "1000",
  GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.com",
})
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const node = (...args) => execFileSync(process.execPath, args, { cwd: KIT, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (what, fn, ms = 90000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(500) }
  throw new Error("не дождался: " + what)
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === "EPERM" } }

/** Игрушечный проект: репозиторий с bare-remote, локальная staging на origin/main, конфиг с поддельным агентом. */
function toyProject(id, fake) {
  const repo = path.join(TMP, id), bare = path.join(TMP, id + ".git")
  fs.mkdirSync(repo, { recursive: true })
  git(TMP, "init", "-q", "--bare", "-b", "main", bare)
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "core.autocrlf", "false")
  fs.writeFileSync(path.join(repo, "app.mjs"), "export const x = 1\n")
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "init")
  git(repo, "remote", "add", "origin", fwd(bare)); git(repo, "push", "-q", "origin", "main")
  git(repo, "branch", "--track", "staging", "origin/main"); git(repo, "checkout", "-q", "staging")
  const cfg = {
    schema: 1, name: id,
    repo: { main: fwd(repo), worktrees: fwd(repo + "-wt"), remote: "origin", upstream: { staging: "main", main: null } },
    agent: { runtime: "claude", bin: fwd(fake) },
    areas: { app: { title: "Всё", paths: ["**"], tasks: ["lint"] } },
    tasks: { lint: { label: "Линтер", group: "Гарды", run: "node -e 0", gate: true } },
    modules: { review: false, backlog: false },
  }
  const file = path.join(TMP, "kit", "projects", id, "dispatcher.project.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
  return { repo, file }
}

test("хаб на двух проектах: пересылка, сводка, ленивый запуск, общий предел агентов, перезапуск упавшего, остановка без дел и всех", { timeout: 600000 }, async (t) => {
  const fake = installFakeClaude(path.join(TMP, "bin"))
  toyProject("alpha", fake); toyProject("beta", fake)
  const [HUB, PA, PB] = [await freePort(), await freePort(), await freePort()]
  fs.writeFileSync(HOME_FILE, JSON.stringify({
    schema: 1, hub: { port: HUB, data: ".hub", idleStopMin: 0.1 },
    shared: { limits: { slots: 1 } },
    projects: [
      { id: "alpha", file: "projects/alpha/dispatcher.project.json", port: PA },
      { id: "beta", file: "projects/beta/dispatcher.project.json", port: PB, start: "lazy" },
    ],
  }, null, 2))
  const B = "http://127.0.0.1:" + HUB
  let log = ""
  hub = spawn(process.execPath, ["scripts/dev/hub/server.mjs"], { cwd: KIT, env: ENV, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  hub.stdout.on("data", (d) => { log += d }); hub.stderr.on("data", (d) => { log += d })
  const get = async (p, headers = {}) => {
    const r = await fetch(B + p, { headers, signal: AbortSignal.timeout(60000) }), text = await r.text()
    let body = text
    try { body = JSON.parse(text) } catch { /* страница — текстом */ }
    return { code: r.status, body }
  }
  let token = ""
  const post = async (p, body, headers = {}) => {
    const r = await fetch(B + p, { method: "POST", headers: { "content-type": "application/json", "x-dash-token": token, ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) })
    return { code: r.status, body: await r.json().catch(() => null) }
  }
  const summary = async () => (await get("/api/summary")).body
  const proj = async (id) => (await summary()).projects.find((p) => p.id === id)
  const A = { "x-dash-project": "alpha" }, Bp = { "x-dash-project": "beta" }

  await t.test("хаб поднял постоянный проект, ленивый ждёт запроса; сводка — по проектам", async () => {
    await until("alpha работает", async () => (await proj("alpha")).state === "running").catch((e) => { throw new Error(e.message + "\n" + log) })
    const s = await summary()
    assert.equal(s.hub.port, HUB)
    const a = s.projects.find((p) => p.id === "alpha"), b = s.projects.find((p) => p.id === "beta")
    assert.equal(a.summary.project.name, "alpha"); assert.equal(a.summary.limits.shared, 1); assert.equal(a.summary.idle, true)
    assert.ok(a.summary.rssMB > 0); t.diagnostic(`память: хаб ${s.hub.rssMB} МБ, ядро alpha ${a.summary.rssMB} МБ (после загрузки, без агентов)`)
    assert.equal(b.state, "stopped"); assert.equal(b.summary, null)
    const list = await get("/")
    assert.equal(list.code, 200); assert.match(list.body, /href="\/p\/alpha\/"/); assert.match(list.body, /href="\/p\/beta\/"/)
    token = /name="dash-token" content="([0-9a-f]+)"/.exec(list.body)[1]
  })

  await t.test("страница проекта по пути: ленивый проект поднимается запросом, в странице — токен хаба", async () => {
    const page = await get("/p/beta/")
    assert.equal(page.code, 200, String(page.body).slice(0, 300))
    assert.equal(/name="dash-token" content="([0-9a-f]+)"/.exec(page.body)[1], token, "токен ядра в браузер не уходит")
    assert.equal((await proj("beta")).state, "running")
    const css = await get("/ui/dash.css", { referer: B + "/p/beta/" })
    assert.equal(css.code, 200, "файлы страницы — через Referer страницы проекта")
  })

  await t.test("пересылка: заголовок, параметр и Referer выбирают проект; без проекта — 400; чужой Host — 403; без токена — 403", async () => {
    const st = async (p, h) => { for (let i = 0; i < 60; i++) { const r = await get(p, h); if (r.body && !r.body.booting) return r.body; await sleep(500) } throw new Error("снимка нет") }
    assert.equal((await st("/api/state", A)).project.name, "alpha")
    assert.equal((await st("/api/state", Bp)).project.name, "beta")
    assert.equal((await st("/api/state?project=beta")).project.name, "beta")
    assert.equal((await st("/api/state", { referer: B + "/p/alpha/" })).project.name, "alpha")
    const none = await get("/api/state")
    assert.equal(none.code, 400); assert.deepEqual(none.body.projects, ["alpha", "beta"])
    // fetch не даёт подменить Host — запрос низкого уровня, как его прислала бы страница с подменой DNS
    const code = await new Promise((r) => http.get({ host: "127.0.0.1", port: HUB, path: "/api/summary", headers: { host: "evil.test:" + HUB } }, (res) => { res.resume(); r(res.statusCode) }))
    assert.equal(code, 403)
    assert.equal((await post("/api/drain", { on: false }, { ...A, "x-dash-token": "" })).code, 403)
    const ok = await post("/api/drain", { on: false }, A)
    assert.equal(ok.code, 200, JSON.stringify(ok.body)); assert.equal(typeof ok.body.idle, "boolean", "ответ ядра")
  })

  // слот с папкой в каждом проекте: команды — с --project, как их зовёт человек из папки дома
  const slots = {}
  for (const id of ["alpha", "beta"]) {
    await t.test(`эпик и слот в ${id} через epic.mjs --project`, async () => {
      node("scripts/dev/epic.mjs", "new", "--id", id + "-e1", "--title", "Эпик " + id, "--activate", "--project", id)
      node("scripts/dev/epic.mjs", "add-slot", "--title", "Волна", "--area", "app", "--epic", id + "-e1", "--wave", "auto", "--project", id)
      const reg = JSON.parse(fs.readFileSync(path.join(TMP, id + "-wt", "_epics", "epics.json"), "utf8"))
      slots[id] = reg.epics[0].slots[0].slot
      const h = { "x-dash-project": id }
      const pr = await until("слот в реестре " + id, async () => { const r = await post("/api/provision", { tree: slots[id] }, h); return r.code === 404 ? null : r })
      assert.ok([200, 409].includes(pr.code), JSON.stringify(pr.body))
      await until("папка слота " + id, async () => fs.existsSync(path.join(TMP, id + "-wt", slots[id], ".claude", "settings.local.json")))
      await until("слот готов " + id, async () => (await get("/api/state", h)).body.jobs.every((j) => j.task !== "slot-up" || ["ok", "fail"].includes(j.status)))
    })
  }

  await t.test("общий предел агентов слотов (1 на дом): второй проект получает отказ с причиной, после остановки первого — запускается", async () => {
    const a = await post("/api/agent/start", { key: slots.alpha }, A)
    assert.equal(a.code, 200, JSON.stringify(a.body))
    const no = await post("/api/agent/start", { key: slots.beta }, Bp)
    assert.equal(no.code, 500)
    assert.match(no.body.error, /общий предел агентов слотов нескольких проектов — 1/)
    assert.match(no.body.error, new RegExp("alpha: " + slots.alpha))
    assert.equal((await post("/api/agent/stop", { key: slots.alpha }, A)).code, 200)
    const b = await until("место освободилось", async () => { const r = await post("/api/agent/start", { key: slots.beta }, Bp); return r.code === 200 ? r : null }, 30000)
    assert.equal(b.code, 200)
    assert.equal((await post("/api/agent/stop", { key: slots.beta }, Bp)).code, 200)
    const locks = () => fs.readdirSync(path.join(TMP, "kit", ".hub", "places")).filter((f) => f.endsWith(".lock"))
    await until("места сняты", async () => locks().length === 0, 20000)
  })

  await t.test("упавшее ядро хаб поднимает заново", async () => {
    const before = await proj("alpha")
    process.kill(before.pid)
    const now = await until("alpha перезапущен", async () => { const p = await proj("alpha"); return p.state === "running" && p.pid !== before.pid ? p : null }, 120000)
    assert.ok(now.restarts >= 1)
    assert.match(log, /\[alpha\] ядро вышло/)
  })

  await t.test("ленивый проект без дел останавливается и снова поднимается запросом", async () => {
    const b = await until("beta остановлен без дел", async () => { const p = await proj("beta"); return p.state === "stopped" ? p : null }, 120000)
    assert.match(b.stopWhy, /без дел/)
    const st = await get("/api/monitor", Bp)
    assert.equal(st.code, 200, JSON.stringify(st.body).slice(0, 300))
    assert.equal((await proj("beta")).state, "running")
  })

  await t.test("выход хаба снимает все ядра", async () => {
    const pids = (await summary()).projects.map((p) => p.pid).filter(Boolean)
    assert.equal(pids.length, 2)
    assert.equal((await post("/api/hub/exit", {})).code, 200)
    await until("хаб вышел", async () => hub.exitCode !== null, 30000)
    await until("ядра сняты", async () => pids.every((p) => !alive(p)), 30000)
    for (const port of [PA, PB]) assert.equal(await fetch("http://127.0.0.1:" + port + "/").then(() => true, () => false), false, "порт " + port + " свободен")
  })
})
