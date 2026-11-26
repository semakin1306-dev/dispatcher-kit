// Сквозной прогон на игрушечном репозитории: временный git-проект с двумя областями и bare-remote → setup.mjs detect →
// apply с заготовленными ответами и --branches → doctor зелёный → сервер диспетчерской на свободном порту → эпик и слот
// через epic.mjs → прогон задачи через API → агент (поддельный Claude Code из test/fixtures/fake-claude.mjs.tpl) пишет
// файл → коммит со страницы → влив в staging через API. Настоящие агенты не запускаются, сеть не нужна, всё — во
// временной папке; порт 4777 не трогается.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { freePort, installFakeClaude } from "./fixtures/fake-runtime.mjs"

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dk-e2e-"))
const fwd = (p) => p.split(path.sep).join("/")
const REPO = path.join(TMP, "toy"), REMOTE = path.join(TMP, "remote.git"), KIT = path.join(TMP, "kit"), BIN = path.join(TMP, "bin")
const CONFIG = path.join(KIT, "dispatcher.project.json")
let server = null

after(async () => {
  if (server && server.exitCode === null) {
    server.kill()
    await new Promise((r) => { server.once("exit", r); setTimeout(r, 5000) })
  }
  if (process.env.DK_E2E_KEEP) console.log("папка прогона оставлена: " + TMP)
  else fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

// ── окружение дочерних процессов: без признака node --test, с поддельным claude первым в PATH ──
const ENV = { ...process.env }
delete ENV.NODE_TEST_CONTEXT
for (const k of ["DASH_DATA", "DASH_PORT", "DASH_DRY", "DASH_EPIC_FILE", "DISPATCHER_MAIN", "DISPATCHER_WT"]) delete ENV[k]
Object.assign(ENV, {
  DISPATCHER_PROJECT: CONFIG, DISPATCHER_HOME: path.join(TMP, "no-home.json"), DISPATCHER_SKILLS_DIR: path.join(TMP, "skills"), FAKE_CLAUDE_LOG: path.join(TMP, "fake-claude.log"),
  GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.com",
  PATH: BIN + path.delimiter + process.env.PATH,
})

const sh = (cmd, args, cwd = TMP, env = ENV) => {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", windowsHide: true, timeout: 120000 })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} → код ${r.status}\n${r.stdout}\n${r.stderr}`)
  return r.stdout
}
const git = (cwd, ...args) => sh("git", args, cwd).trim()
const node = (...args) => sh(process.execPath, args, HOME)

const fakeClaude = () => installFakeClaude(BIN)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test("сквозной прогон: настройка → сервер → эпик и слот → задача → агент → коммит → влив в staging", { timeout: 420000 }, async (t) => {
  // ── игрушечный проект: две области, bare-remote с интеграционной и прод-веткой ──
  fs.mkdirSync(REPO, { recursive: true })
  git(TMP, "init", "-q", "--bare", REMOTE)
  git(REPO, "init", "-q", "-b", "develop")
  git(REPO, "config", "core.autocrlf", "false")
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(REPO, rel)), { recursive: true }); fs.writeFileSync(path.join(REPO, rel), text) }
  put("package.json", '{ "name": "toy", "private": true }\n')
  put("apps/api/index.mjs", "export const add = (a, b) => a + b\n")
  put("apps/api/test.mjs", 'import { add } from "./index.mjs"\nif (add(2, 2) !== 4) process.exit(1)\nconsole.log("api: 1 passed")\n')
  put("apps/web/test.mjs", 'console.log("web: 1 passed")\n')
  put("tools/lint.mjs", 'console.log("lint: ok")\n')
  put(".gitignore", "node_modules/\n")
  git(REPO, "add", "-A"); git(REPO, "commit", "-qm", "init")
  git(REPO, "remote", "add", "origin", fwd(REMOTE))
  git(REPO, "push", "-q", "origin", "develop", "develop:main")
  const fake = fakeClaude()

  await t.test("setup.mjs detect: проект и рантайм определились, вопросы названы", () => {
    const r = JSON.parse(node("setup.mjs", "detect", "--repo", REPO, "--json"))
    const known = Object.fromEntries(r.known.map((k) => [k.id, k.value]))
    assert.equal(known["git.integration"], "develop")
    assert.equal(known["git.production"], "main")
    assert.equal(known["agent.runtime"], "claude")
    assert.ok(r.ask.some((q) => q.id === "areas") && r.ask.some((q) => q.id === "autonomy"))
  })

  await t.test("setup.mjs apply с ответами и --branches пишет конфиг, ветки-роли и навыки; doctor зелёный", () => {
    const answers = {
      "git.pushDeploys": false,
      areas: { api: { title: "API", paths: ["apps/api/**"], tasks: ["api-test"] }, web: { title: "Витрина", paths: ["apps/web/**"], tasks: ["web-test"] } },
      tasks: {
        "api-test": { label: "API: тесты", group: "Тесты", run: "node test.mjs", cwd: "apps/api" },
        "web-test": { label: "Витрина: тесты", group: "Тесты", run: "node test.mjs", cwd: "apps/web" },
        lint: { label: "Линтер", group: "Гарды", run: "node tools/lint.mjs", gate: true },
      },
      slotPrepare: [], "deny.edit": ["/package.json"], "deny.commands": [], "ci.kind": "none", "machines.remote": [], "tests.services": [],
      "machines.localWorkers": 2, "limits.slots": 2,
      "stand.run": "", "prod.run": "", "prod.verify": "", autonomy: "manual", "modules.tg": false, "modules.optional": [],
      "repo.worktrees": fwd(path.join(TMP, "toy-wt")),
    }
    const af = path.join(TMP, "answers.json")
    fs.writeFileSync(af, JSON.stringify(answers, null, 2))
    const r = spawnSync(process.execPath, ["setup.mjs", "apply", "--repo", REPO, "--answers", af, "--branches"], { cwd: HOME, env: ENV, encoding: "utf8", windowsHide: true })
    assert.ok(fs.existsSync(CONFIG), r.stdout + r.stderr)
    // путь к поддельному рантайму — agent.bin конфига (у человека его ставит квиз или правка руками)
    const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"))
    cfg.agent.bin = fwd(fake)
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n")
    assert.match(r.stdout, /Ветка-роль staging → origin\/develop: создана/)
    assert.equal(git(REPO, "rev-parse", "--abbrev-ref", "staging@{upstream}"), "origin/develop")
    const skill = fs.readFileSync(path.join(TMP, "skills", "new-slot", "SKILL.md"), "utf8")
    assert.ok(skill.includes(fwd(HOME) + "/scripts/dev/epic.mjs") && !skill.includes("<дом диспетчерской>"), "навык — с путём дома диспетчерской")
    const d = JSON.parse(spawnSync(process.execPath, ["setup.mjs", "doctor", "--json"], { cwd: HOME, env: ENV, encoding: "utf8", windowsHide: true }).stdout)
    assert.equal(d.ok, true, JSON.stringify(d.checks.filter((c) => c.level === "error" || c.ok === false), null, 1))
  })

  // основная папка проекта стоит на роли staging: в ней диспетчерская вливает ветки слотов
  git(REPO, "checkout", "-q", "staging")

  const PORT = await freePort(), B = "http://127.0.0.1:" + PORT
  let token = ""
  const get = async (p) => { const r = await fetch(B + p, { signal: AbortSignal.timeout(20000) }); return { code: r.status, body: await r.json().catch(() => null) } }
  const post = async (p, body) => {
      const r = await fetch(B + p, {
          method: "POST",
          headers: { "content-type": "application/json", "x-dash-token": token },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
      })
      return { code: r.status, body: await r.json().catch(() => null) }
  }
  const state = async () => { for (let i = 0; i < 60; i++) { const s = (await get("/api/state")).body; if (s && !s.booting) return s; await sleep(500) } throw new Error("сервер не собрал снимок") }
  const until = async (what, fn, ms = 90000) => {
      const t0 = Date.now()
      let last
      while (Date.now() - t0 < ms) {
          last = await fn()
          if (last) return last
          await sleep(700)
      }
      throw new Error("не дождался: " + what)
  }
  const jobDone = (id) =>
      until("прогон " + id, async () => {
          const j = (await get("/api/job/" + id)).body
          return j && ["ok", "fail", "cancelled", "skipped", "interrupted"].includes(j.status) ? j : null
      })

  await t.test("сервер поднимается и отдаёт страницу и состояние с полями конструктора", async () => {
    let log = ""
    server = spawn(process.execPath, ["scripts/dev/dashboard/server.mjs"], { cwd: HOME, env: { ...ENV, DASH_PORT: String(PORT) }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    const logFile = path.join(TMP, "server.log")
    server.stdout.on("data", (d) => { log += d; fs.appendFileSync(logFile, d) }); server.stderr.on("data", (d) => { log += d; fs.appendFileSync(logFile, d) })
    await until(
        "порт сервера",
        async () =>
            await fetch(B + "/", { signal: AbortSignal.timeout(2000) }).then(
                (r) => r.ok,
                () => false,
            ),
        30000,
    ).catch((e) => {
        throw new Error(e.message + "\n" + log)
    })
    const html = await (await fetch(B + "/")).text()
    token = /name="dash-token" content="([0-9a-f]+)"/.exec(html)?.[1] || ""
    assert.ok(token, "токен страницы")
    const s = await state()
    assert.equal(s.project.name, "toy")
    assert.deepEqual(s.stations, { tests: ["api-test", "web-test"], guards: ["lint"] })
    assert.equal(s.tasks.lint.gate, true)
    assert.equal(s.pipeline.upStaging, "origin/develop")
    assert.equal(s.modules.find((m) => m.id === "release").on, false)
    assert.equal((await get("/api/accept-state")).code, 404, "выключенный модуль — 404")
    assert.equal((await get("/api/backlog")).code, 404)
    assert.equal((await get("/api/monitor")).code, 200)
  })

  let slot = ""
  await t.test("эпик и слот через epic.mjs; подготовка слота через API: хук и запреты агента, дерево чистое", async () => {
    node("scripts/dev/epic.mjs", "new", "--id", "toy-e1", "--title", "Игрушечный эпик", "--activate")
    node("scripts/dev/epic.mjs", "add-slot", "--title", "Сложение", "--area", "api", "--epic", "toy-e1", "--wave", "auto")
    const reg = JSON.parse(fs.readFileSync(path.join(TMP, "toy-wt", "_epics", "epics.json"), "utf8"))
    slot = reg.epics[0].slots[0].slot
    assert.match(reg.epics[0].slots[0].branch, /^dev\/wv-\d{4}/)
    // сервер видит новый слот, когда перечитает реестр эпиков (следит за файлом раз в несколько секунд)
    const pr = await until("слот в реестре сервера", async () => { const r = await post("/api/provision", { tree: slot }); return r.code === 404 ? null : r })
    if (pr.code === 200) { const j = await jobDone(pr.body.id); assert.equal(j.status, "ok", JSON.stringify(j)) }
    else assert.equal(pr.code, 409, JSON.stringify(pr.body)) // диспетчерская уже готовит слот сама
    const dir = path.join(TMP, "toy-wt", slot)
    await until("папка слота", async () => fs.existsSync(path.join(dir, ".claude", "settings.local.json")))
    assert.equal(git(dir, "status", "--porcelain"), "", "файл запретов агента не делает слот изменённым")
  })

  await t.test("задача через API: гард «Линтер» в слоте зелёный", async () => {
    const r = await post("/api/run", { tree: slot, task: "lint" })
    assert.equal(r.code, 200, JSON.stringify(r.body))
    const j = await jobDone(r.body.id)
    assert.equal(j.status, "ok", JSON.stringify(j))
  })

  await t.test("агент (поддельный рантайм) пишет код; коммит со страницы — с подписью Wave от хука", async () => {
    const r = await post("/api/agent/send", { key: slot, text: "Сделай волну.\nFAKE-WRITE apps/api/sub.mjs export const sub = (a, b) => a - b" })
    assert.equal(r.code, 200, JSON.stringify(r.body))
    const dir = path.join(TMP, "toy-wt", slot)
    await until("файл от агента", async () => fs.existsSync(path.join(dir, "apps", "api", "sub.mjs")), 30000)
    await until("агент закончил ход", async () => { const s = await state(); const a = s.agents[slot]; return a && !a.busy })
    const c = await post("/api/commit", { tree: slot, message: "feat(api): вычитание", paths: ["apps/api/sub.mjs"] })
    assert.equal(c.code, 200, JSON.stringify(c.body))
    assert.equal((await jobDone(c.body.id)).status, "ok")
    const msg = git(dir, "log", "-1", "--format=%B")
    assert.match(msg, /^feat\(api\): вычитание/)
    assert.match(msg, /Wave: WV-\d{4}/, "строку Wave ставит хук commit-msg слота")
  })

  await t.test("влив ветки слота в staging через API", async (t) => {
    // гарды на новом коде — снова зелёные (влив проверяет их на нынешнем отпечатке)
    const g = await post("/api/run", { tree: slot, task: "lint", force: true })
    if (g.body && g.body.id) await jobDone(g.body.id)
    const branch = git(path.join(TMP, "toy-wt", slot), "rev-parse", "--abbrev-ref", "HEAD")
    const pre = await until("проверки влива", async () => {
        const p = (await post("/api/preflight", { action: "merge", slot })).body
        return p && p.checks.find((c) => c.id === "ahead" && c.ok) ? p : null
    })
    const hard = pre.checks.filter((c) => c.ok === false && !["regress", "review", "sec", "done"].includes(c.id))
    assert.deepEqual(hard, [], "жёстких отказов нет: " + JSON.stringify(pre.checks))
    t.diagnostic("проверки влива: " + pre.checks.map((c) => (c.ok === false ? "✗ " : c.ok ? "✓ " : "· ") + c.id).join(", "))
    const m = await post("/api/pipeline", { action: "merge", slot, force: !pre.ok })
    assert.equal(m.code, 200, JSON.stringify(m.body))
    const j = await jobDone(m.body.id)
    assert.equal(j.status, "ok", JSON.stringify(j))
    git(REPO, "merge-base", "--is-ancestor", branch, "staging")
    assert.match(git(REPO, "log", "-1", "--format=%s", "staging"), /^merge: /)
  })
  await t.test("пути /api, которые зовёт страница, отвечают; пути выключенных модулей — 404 с именем модуля", async () => {
    const GET = [
        "/api/state",
        "/api/monitor",
        "/api/epic-progress?epic=toy-e1",
        "/api/changes?tree=" + slot,
        "/api/filediff?tree=" + slot + "&path=apps/api/sub.mjs",
        "/api/station?tree=" + slot + "&id=tests",
        "/api/graph",
        "/api/annot?tree=" + slot,
        "/api/log/j1?from=0",
    ]
    for (const p of GET) {
        const r = await get(p)
        assert.ok(
            r.code < 500 && !(r.body && /^нет такого адреса$/.test(r.body.error || "")),
            p + " → " + r.code + " " + JSON.stringify(r.body).slice(0, 200),
        )
    }
    const POST = [
        "/api/agent/prompt",
        "/api/agent-report",
        "/api/autochain",
        "/api/cancel",
        "/api/epic",
        "/api/fetch",
        "/api/force",
        "/api/hygiene",
        "/api/inbox",
        "/api/kill",
        "/api/merge-wait",
        "/api/order",
        "/api/order-wagons",
        "/api/ownerq-answer",
        "/api/pipeline",
        "/api/preflight",
        "/api/provision",
        "/api/rebuild",
        "/api/relay",
        "/api/run",
        "/api/run-staging",
        "/api/run-staging-guards",
        "/api/slot-archive",
        "/api/slot-reset",
        "/api/slot-start",
        "/api/slot-stop",
        "/api/slot-sync",
        "/api/stage",
        "/api/sync-staging",
        "/api/train",
        "/api/train-wagon",
        "/api/drain",
    ]
    for (const p of POST) {
        const r = await post(p, p === "/api/slot-reset" ? { tree: slot, dry: true } : {})
        assert.ok(
            r.code < 500 && !(r.body && /^нет такого адреса$/.test(r.body.error || "")),
            p + " → " + r.code + " " + JSON.stringify(r.body).slice(0, 200),
        )
    }
    for (const [p, mod] of [
        ["/api/accept", "accept"],
        ["/api/accept-state", "accept"],
        ["/api/reminders", "accept"],
        ["/api/stand-checklist", "accept"],
        ["/api/retro", "retro"],
        ["/api/backlog", "backlog"],
        ["/api/shard", "machines"],
        ["/api/ssh-unlock", "win-desktop"],
    ]) {
        const r = await post(p, {})
        assert.equal(r.code, 404, p)
        assert.equal(r.body.module, mod, p)
    }
    const rv = await post("/api/run", { tree: slot, task: "review" })
    assert.equal(rv.code, 404, "ревью при выключенном модуле — 404")
    for (const action of ["deploy-staging", "release"]) assert.equal((await post("/api/pipeline", { action, confirm: "ВЫКАТ", accepted: true })).code, 404, action)
  })
})
