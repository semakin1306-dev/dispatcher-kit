import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { fwd, loadProject, validateProject } from "../scripts/dev/project.mjs"
import { MODULE_IDS } from "../scripts/dev/modules-catalog.mjs"
import { toId, hostKind, gitFacts, stackFacts, ciFacts, servicesFacts, whichBin, detectFacts, suggestAnswers, suggestTasks, suggestAreas } from "./detect.mjs"
import { loadQuiz, planQuestions, buildProject, mergeAnswers, ANSWER_IDS, SHARED_IDS } from "./build.mjs"
import { runDoctor, formatDoctor, formatHomeDoctor, roleBranchState, ensureRoleBranches, runHomeDoctor } from "./doctor.mjs"
import { addProject, apply, detect, listProjects, parseArgs, removeProject } from "../setup.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const tmp = (name = "dk-setup-") => fs.mkdtempSync(path.join(os.tmpdir(), name))
const write = (root, rel, text) => {
  const f = path.join(root, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, typeof text === "string" ? text : JSON.stringify(text, null, 2))
}
const git = (cwd, ...args) =>
  execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim()

/** Монорепо: два приложения и общий пакет, pnpm, CI с выкатом по пушу. */
function monorepoFiles(root) {
  write(root, "package.json", { name: "demo-shop", private: true, scripts: { build: "x", lint: "x", typecheck: "x", dev: "x" } })
  write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
  write(root, "pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n  - \"packages/*\"\n")
  write(root, "apps/api/package.json", { name: "@demo/api", scripts: { test: "jest" }, devDependencies: { jest: "^29" } })
  write(root, "apps/web/package.json", { name: "@demo/web", devDependencies: { vitest: "^2", "@playwright/test": "^1" } })
  write(root, "packages/ui/package.json", { name: "@demo/ui" })
  write(root, ".github/workflows/ci.yml", "on: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n")
  write(root, ".github/workflows/deploy.yml", "name: deploy\non:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: [self-hosted, linux]\n")
  write(root, "docker-compose.yml", "services:\n  db:\n    image: postgres:16\n  cache:\n    image: redis:7\n  app:\n    image: ghcr.io/demo/app\n")
  write(root, "deploy.sh", "#!/bin/sh\n")
}

/** Репозиторий с удалённым origin и ветками main и develop. */
function makeRepo({ files = monorepoFiles, develop = true } = {}) {
  const root = tmp()
  const bare = path.join(root, "origin.git"), repo = path.join(root, "demo-shop")
  fs.mkdirSync(repo)
  git(root, "init", "--bare", "-b", "main", bare)
  git(repo, "init", "-b", "main")
  files(repo)
  git(repo, "add", "-A"); git(repo, "commit", "-m", "init")
  git(repo, "remote", "add", "origin", bare)
  git(repo, "push", "-u", "origin", "main")
  if (develop) { git(repo, "branch", "develop"); git(repo, "push", "origin", "develop") }
  git(repo, "remote", "set-head", "origin", "main")
  return { root, repo: repo.replace(/\\/g, "/") }
}

const HUMAN = {
  "git.pushDeploys": true, "areas": null, "tasks": null, "slotPrepare": null, "deny.edit": null, "deny.commands": null,
  "ci.runners": "mixed", "machines.remote": [], "tests.services": [], "stand.run": "", "prod.run": "", "prod.verify": "",
  "autonomy": "manual", "modules.tg": false, "modules.optional": ["review", "backlog"],
}
/** Ответы человека: где null — берётся предложенное. */
const humanFor = (r) => Object.fromEntries(Object.entries(HUMAN).map(([id, v]) => [id, v === null ? r.ask.find((q) => q.id === id).suggested : v]))

test("toId: из имени папки получается допустимый id", () => {
  assert.equal(toId("API Server"), "api-server")
  assert.equal(toId("@scope/pkg_name"), "scope-pkg-name")
  assert.equal(toId("123go"), "x-123go")
  assert.equal(toId("---"), "x")
})

test("hostKind: хостинг по адресу", () => {
  assert.equal(hostKind("git@github.com:a/b.git"), "github")
  assert.equal(hostKind("https://gitlab.example.com/a/b"), "gitlab")
  assert.equal(hostKind("ssh://git@host.example/a/b"), "other")
  assert.equal(hostKind(""), "")
})

test("вопросы квиза и сборка конфига сверены в обе стороны", () => {
  const quiz = loadQuiz()
  const ids = quiz.questions.map((q) => q.id)
  assert.deepEqual([...ids].sort(), [...ANSWER_IDS].sort(), "у каждого вопроса есть сборка и у каждой сборки — вопрос")
  assert.equal(new Set(ids).size, ids.length, "id вопросов не повторяются")
  const blocks = quiz.blocks.map((b) => b.id)
  for (const q of quiz.questions) {
    assert.ok(blocks.includes(q.block), q.id + ": блок")
    assert.ok(["auto", "always", "never"].includes(q.ask), q.id + ": ask")
    assert.ok(["text", "path", "choice", "multi", "bool", "number", "list", "object"].includes(q.type), q.id + ": type")
    assert.ok(q.text && q.why, q.id + ": текст и зачем")
    if (q.when) assert.ok(ids.includes(q.when), q.id + ": when ссылается на вопрос")
    if (["choice", "multi"].includes(q.type)) assert.ok(q.options || q.optionsFrom, q.id + ": варианты")
  }
  const optional = quiz.questions.find((q) => q.id === "modules.optional").options
  for (const id of optional) assert.ok(MODULE_IDS.includes(id), "модуль " + id)
})

test("предложения покрывают только известные вопросы", () => {
  const { repo } = makeRepo()
  const s = suggestAnswers(detectFacts(repo))
  for (const id of Object.keys(s)) assert.ok(ANSWER_IDS.includes(id), id)
})

test("стек монорепо: менеджер пакетов, рабочие пространства, инструменты тестов", () => {
  const root = tmp(); monorepoFiles(root)
  const s = stackFacts(root)
  assert.equal(s.pm, "pnpm"); assert.equal(s.lockfile, "pnpm-lock.yaml")
  assert.deepEqual(s.languages, ["node"])
  assert.deepEqual(s.workspaces.map((w) => w.dir), ["apps/api", "apps/web", "packages/ui"])
  assert.ok(s.workspaces[0].jest && s.workspaces[1].vitest && s.playwright)
})

test("стек: npm workspaces из package.json, Go-сервисы, Python", () => {
  const root = tmp()
  write(root, "package.json", { name: "x", workspaces: ["apps/*"], scripts: { test: "x" } })
  write(root, "package-lock.json", "{}")
  write(root, "apps/site/package.json", { name: "site" })
  write(root, "services/mailer/go.mod", "module mailer\n")
  write(root, "pyproject.toml", "[tool.ruff]\n[tool.pytest.ini_options]\n")
  const s = stackFacts(root)
  assert.equal(s.pm, "npm")
  assert.deepEqual(s.languages, ["node", "python", "go"])
  assert.deepEqual(s.goDirs, ["services/mailer"])
  assert.ok(s.pytest && s.ruff)
  const { tasks } = suggestTasks(s)
  assert.equal(tasks["test-all"].run, "npm test")
  assert.equal(tasks["mailer-go-test"].cwd, "services/mailer")
  assert.equal(tasks.pytest.parser, "pytest")
  assert.ok(tasks.ruff.gate)
})

test("задачи и области монорепо: тест на приложение, гарды из скриптов, чужие пути закрыты", () => {
  const root = tmp(); monorepoFiles(root)
  const s = stackFacts(root)
  const { tasks, byDir } = suggestTasks(s)
  assert.deepEqual(Object.keys(tasks).sort(), ["api-test", "build", "lint", "typecheck", "web-test"])
  assert.equal(tasks["api-test"].run, "npx jest {input}")
  assert.equal(tasks["web-test"].parser, "vitest")
  assert.equal(tasks.lint.run, "pnpm run lint")
  assert.ok(tasks.lint.gate && tasks.typecheck.gate && !tasks.build.gate)
  const areas = suggestAreas(s, byDir)
  assert.deepEqual(Object.keys(areas).sort(), ["api", "packages", "web"])
  assert.deepEqual(areas.api.tasks, ["api-test"])
  assert.deepEqual(areas.api.denyEdit.sort(), ["apps/web/**", "packages/**"])
  assert.deepEqual(areas.packages.paths, ["packages/**"])
})

test("проект без деления — одна область на весь репозиторий", () => {
  const root = tmp()
  write(root, "package.json", { name: "solo", scripts: { test: "x" }, devDependencies: { vitest: "1" } })
  const s = stackFacts(root)
  const { tasks, byDir } = suggestTasks(s)
  assert.deepEqual(suggestAreas(s, byDir), { app: { title: "Проект", paths: ["**"], tasks: Object.keys(tasks) } })
})

test("CI: вид, свои и облачные раннеры, выкат по пушу, что закрыть от правки", () => {
  const root = tmp(); monorepoFiles(root)
  const c = ciFacts(root)
  assert.deepEqual(c.kinds, ["github-actions"])
  assert.ok(c.selfHosted && c.cloud)
  assert.deepEqual(c.deployOnPush, [".github/workflows/deploy.yml"])
  assert.deepEqual(c.protect, ["/.github/**"])
  const empty = ciFacts(tmp())
  assert.deepEqual(empty.kinds, []); assert.ok(!empty.selfHosted)
})

test("службы: из compose берутся только известные образы баз и очередей", () => {
  const root = tmp(); monorepoFiles(root)
  assert.deepEqual(servicesFacts(root), { composeFiles: ["docker-compose.yml"], images: ["postgres", "redis"] })
})

test("git: remote, ветки, основная ветка; адрес remote в факты не попадает", () => {
  const { repo } = makeRepo()
  const g = gitFacts(repo)
  assert.ok(g.isRepo)
  assert.deepEqual(g.remotes, [{ name: "origin", kind: "other" }])
  assert.deepEqual(g.remoteBranches.origin.sort(), ["develop", "main"])
  assert.equal(g.defaultBranch.origin, "main")
  assert.ok(!JSON.stringify(g).includes("origin.git"))
  assert.equal(gitFacts(tmp()).isRepo, false)
})

test("ветки: develop → интеграционная, main → прод; при одной ветке — уточнить", () => {
  const two = suggestAnswers(detectFacts(makeRepo().repo))
  assert.deepEqual([two["git.integration"].value, two["git.integration"].confidence], ["develop", "high"])
  assert.deepEqual([two["git.production"].value, two["git.production"].confidence], ["main", "high"])
  assert.equal(two["git.remote"].confidence, "high")
  const one = suggestAnswers(detectFacts(makeRepo({ develop: false }).repo))
  assert.deepEqual([one["git.integration"].value, one["git.integration"].confidence], ["main", "low"])
  assert.equal(one["git.production"].value, "")
})

test("whichBin: находит файл в PATH, на Windows — с расширением", () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, "tool.cmd"), "")
  fs.writeFileSync(path.join(dir, "plain"), "")
  assert.equal(whichBin("tool", { PATH: dir, PATHEXT: ".EXE;.cmd" }, "win32"), path.join(dir, "tool.cmd").replace(/\\/g, "/"))
  assert.equal(whichBin("tool", { PATH: dir }, "linux"), "")
  assert.equal(whichBin("plain", { PATH: dir }, "linux"), path.join(dir, "plain").replace(/\\/g, "/"))
  assert.equal(whichBin("ghost", { PATH: dir }, "linux"), "")
})

test("план вопросов: always спрашивается всегда, уверенное auto — нет, прежний ответ — нет", () => {
  const facts = detectFacts(makeRepo().repo)
  const quiz = loadQuiz()
  const first = planQuestions(quiz, suggestAnswers(facts), { facts })
  const asked = first.ask.map((q) => q.id)
  for (const id of ["areas", "tasks", "autonomy", "git.pushDeploys", "machines.remote", "stand.run"]) assert.ok(asked.includes(id), id)
  for (const id of ["project.name", "git.remote", "git.integration", "git.production", "repo.worktrees", "agent.models"]) assert.ok(!asked.includes(id), id)
  assert.deepEqual(first.ask.find((q) => q.id === "git.integration"), undefined)
  assert.equal(first.ask.find((q) => q.id === "stand.url").dependsOn, "stand.run")
  assert.ok(first.ask.find((q) => q.id === "tasks").suggested["api-test"])
  const again = planQuestions(quiz, suggestAnswers(facts, { autonomy: "merge", "stand.run": "" }), { facts })
  const askedAgain = again.ask.map((q) => q.id)
  assert.ok(!askedAgain.includes("autonomy") && !askedAgain.includes("stand.run"))
  assert.ok(!askedAgain.includes("stand.url") && !askedAgain.includes("accept.run"), "стенда нет — зависимые вопросы не нужны")
})

test("план вопросов: при одной ветке вопрос о ветке задаётся с вариантами из remote", () => {
  const facts = detectFacts(makeRepo({ develop: false }).repo)
  const { ask } = planQuestions(loadQuiz(), suggestAnswers(facts), { facts })
  const q = ask.find((x) => x.id === "git.integration")
  assert.deepEqual(q.options, ["main"]); assert.equal(q.suggested, "main")
})

test("сборка конфига: предложенное проходит проверку, модули и переключатели следуют ответам", () => {
  const { repo } = makeRepo()
  const facts = detectFacts(repo)
  const s = suggestAnswers(facts)
  const base = buildProject({ repo, answers: mergeAnswers(s), facts })
  assert.deepEqual(base.problems, [])
  assert.deepEqual(validateProject(base.project).errors, [])
  assert.deepEqual(base.project.repo.upstream, { staging: "develop", main: "main" })
  assert.deepEqual(base.settings, { selfCommit: "word", autoCommit: false, autoMerge: false, autoTrain: false, autoSyncConflict: false, fullPermissions: false, autoResults: true, tgBot: false })
  assert.equal(base.project.modules.machines, false); assert.equal(base.project.modules.release, true, "в CI найден выкат по пушу")
  assert.deepEqual(base.project.ci.files.sort(), [".github/workflows/ci.yml", ".github/workflows/deploy.yml"])

  const full = buildProject({ repo, facts, answers: mergeAnswers(s, {
    "machines.remote": [{ id: "build", ssh: "build-box", dir: "~/dk", workers: 6 }],
    "tests.services": [{ name: "postgres", up: "docker compose up -d db", check: "pg_isready" }],
    "stand.run": "./deploy.sh stand", "stand.url": "https://stand.example.com", "accept.run": "npx playwright test",
    "prod.run": "./deploy.sh prod", "git.pushDeploys": false, autonomy: "merge", "modules.tg": true, "modules.optional": ["review", "backlog", "retro"],
    "slotPrepare": ["pnpm install"], "agent.runtime": "codex",
  }) })
  assert.deepEqual(full.problems, [])
  assert.deepEqual(validateProject(full.project).errors, [])
  assert.deepEqual(full.project.modules, { review: true, backlog: true, retro: true, machines: true, release: true, accept: true, tg: true, "win-desktop": false })
  assert.deepEqual(full.project.machines.build, { ssh: "build-box", dir: "~/dk", workers: 6 })
  assert.equal(full.project.machines.local.services[0].name, "postgres")
  assert.deepEqual(full.project.slotPrepare, [{ run: "pnpm install" }])
  assert.deepEqual(full.project.release, { stand: { run: "./deploy.sh stand", url: "https://stand.example.com" }, prod: { run: "./deploy.sh prod", pushDeploys: false } })
  assert.equal(full.project.accept.standUrl, "https://stand.example.com")
  assert.deepEqual([full.settings.selfCommit, full.settings.autoCommit, full.settings.autoMerge, full.settings.fullPermissions, full.settings.tgBot], ["station", true, true, false, true])
})

test("сборка конфига: без прод-ветки выкат прода не описывается; неизвестный ответ — проблема", () => {
  const { repo } = makeRepo({ develop: false })
  const facts = detectFacts(repo)
  const r = buildProject({ repo, facts, answers: mergeAnswers(suggestAnswers(facts), { "prod.run": "./deploy.sh", "git.pushDeploys": true, "stand.url": "x", "accept.run": "y" }) })
  assert.equal(r.project.repo.upstream.main, null)
  assert.equal(r.project.release, undefined); assert.equal(r.project.accept, undefined)
  assert.deepEqual(validateProject(r.project).errors, [])
  const bad = buildProject({ repo, facts, answers: { ...mergeAnswers(suggestAnswers(facts)), "ghost.key": 1, autonomy: "wild" } })
  assert.equal(bad.problems.length, 2)
})

test("ветки-роли: отсутствует → создаётся; занята другим смыслом → не трогается", () => {
  const { repo } = makeRepo()
  assert.equal(roleBranchState(repo, "staging", "origin", "develop").state, "missing")
  assert.equal(roleBranchState(repo, "main", "origin", "main").state, "ok")
  assert.equal(roleBranchState(repo, "staging", "origin", "ghost").state, "no-remote-ref")
  const made = ensureRoleBranches({ repo: { main: repo, remote: "origin", upstream: { staging: "develop", main: "main" } } })
  assert.deepEqual(made.map((b) => [b.role, b.state, b.created]), [["staging", "ok", true], ["main", "ok", false]])
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "staging@{upstream}"), "origin/develop")
  // у проекта своя ветка staging, а интеграционная — develop
  const other = makeRepo().repo
  git(other, "branch", "staging")
  assert.equal(roleBranchState(other, "staging", "origin", "develop").state, "foreign")
  assert.deepEqual(ensureRoleBranches({ repo: { main: other, remote: "origin", upstream: { staging: "develop", main: null } } }).map((b) => [b.state, b.created]), [["foreign", false]])
})

/** Поддельный бинарник агента в отдельной папке PATH. */
function fakeAgent(name = "claude") {
  const dir = tmp("dk-bin-")
  if (process.platform === "win32") fs.writeFileSync(path.join(dir, name + ".cmd"), "@echo 9.9.9 (test)\r\n")
  else { fs.writeFileSync(path.join(dir, name), "#!/bin/sh\necho '9.9.9 (test)'\n"); fs.chmodSync(path.join(dir, name), 0o755) }
  return { PATH: dir + path.delimiter + (process.env.PATH || process.env.Path || ""), PATHEXT: process.env.PATHEXT || ".EXE;.CMD" }
}

test("apply: без ответов человека отказывает и называет вопросы; с ответами пишет три файла; doctor зелёный", async () => {
  const { root, repo } = makeRepo()
  const env = { ...process.env, ...fakeAgent(), DISPATCHER_PROJECT: path.join(root, "kit", "dispatcher.project.json") }
  const answersFile = path.join(root, "kit", "project", "answers.json")
  const r = detect({ repo, env, answersFile })
  assert.equal(r.configExists, false)
  assert.throws(() => apply({ repo, given: {}, env, answersFile }), /нет ответов на вопросы: .*areas.*autonomy/s)
  assert.ok(!fs.existsSync(env.DISPATCHER_PROJECT), "при отказе ничего не пишется")

  const given = humanFor(r)
  const dry = apply({ repo, given, env, answersFile, dryRun: true })
  assert.deepEqual(dry.written, []); assert.ok(!fs.existsSync(env.DISPATCHER_PROJECT))

  const done = apply({ repo, given, env, answersFile, branches: true })
  assert.equal(done.written.length, 3)
  for (const f of done.written) assert.ok(fs.existsSync(f), f)
  assert.deepEqual(done.branches.map((b) => [b.role, b.state]), [["staging", "ok"], ["main", "ok"]])
  const saved = JSON.parse(fs.readFileSync(env.DISPATCHER_PROJECT, "utf8"))
  assert.equal(saved.repo.main, repo); assert.equal(saved.release.prod.pushDeploys, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(answersFile, "utf8")), given)

  const d = await runDoctor({ file: env.DISPATCHER_PROJECT, env })
  assert.deepEqual(d.checks.filter((c) => c.level === "error"), [])
  assert.ok(d.ok)
  assert.match(formatDoctor(d), /Готово: ошибок нет/)
  assert.match(d.checks.find((c) => c.id === "agent").detail, /9\.9\.9/)

  // повторная настройка: прежние ответы не переспрашиваются; перезапись — только с --force
  assert.deepEqual(detect({ repo, env, answersFile }).ask.map((q) => q.id), [])
  assert.throws(() => apply({ repo, given: {}, env, answersFile }), /конфиг уже есть/)
  const again = apply({ repo, given: { autonomy: "commit" }, env, answersFile, force: true })
  assert.ok(again.written.some((f) => f.endsWith(".prev")))
  assert.ok(!again.written.some((f) => f.endsWith("settings.json")), "существующие переключатели не затираются")
  assert.equal(JSON.parse(fs.readFileSync(answersFile, "utf8")).autonomy, "commit")
})

test("doctor: нет конфига, нет ветки-роли, нет агента — ошибки с подсказкой, что сделать", async () => {
  const { root, repo } = makeRepo()
  const file = path.join(root, "kit", "dispatcher.project.json")
  const none = await runDoctor({ file })
  assert.ok(!none.ok); assert.match(none.checks.find((c) => c.id === "config").fix, /setup\.mjs detect/)

  const env = { ...process.env, DISPATCHER_PROJECT: file, PATH: tmp("dk-empty-"), Path: "" }
  const answersFile = path.join(root, "kit", "project", "answers.json")
  const r = detect({ repo, env, answersFile })
  assert.ok(r.ask.some((q) => q.id === "agent.runtime"), "рантайма в PATH нет — вопрос о нём задаётся человеку")
  apply({ repo, given: { ...humanFor(r), "agent.runtime": "claude" }, env, answersFile })
  const d = await runDoctor({ file, env })
  assert.ok(!d.ok)
  assert.equal(d.checks.find((c) => c.id === "branch.staging").level, "error")
  assert.match(d.checks.find((c) => c.id === "branch.staging").fix, /branch --track staging origin\/develop/)
  assert.equal(d.checks.find((c) => c.id === "branch.main").level, "ok")
  const agent = d.checks.find((c) => c.id === "agent")
  assert.equal(agent.level, "error")
  assert.match(agent.detail, /не найден в PATH.*`agent\.bin`/, "квиз agent.bin не спрашивает — сообщение называет ключ")
  assert.match(agent.fix, /`agent\.bin`/)
  assert.match(formatDoctor(d), /Ошибок: 2/)

  // agent.bin указывает на несуществующий файл — ошибка называет ключ и как исправить
  const raw = JSON.parse(fs.readFileSync(file, "utf8")); raw.agent.bin = path.join(tmp("dk-nobin-"), "no-such-agent")
  fs.writeFileSync(file, JSON.stringify(raw))
  const d2 = await runDoctor({ file, env })
  const agent2 = d2.checks.find((c) => c.id === "agent")
  assert.equal(agent2.level, "error")
  assert.match(agent2.detail, /`agent\.bin`/); assert.match(agent2.fix, /`agent\.bin`/)

  // голое имя — имя в PATH: нет его там — ошибка; есть — агент найден
  const agentOf = async (bin, e = env) => { raw.agent.bin = bin; fs.writeFileSync(file, JSON.stringify(raw)); return (await runDoctor({ file, env: e })).checks.find((c) => c.id === "agent") }
  const bare = await agentOf("no-such-agent")
  assert.equal(bare.level, "error"); assert.match(bare.detail, /`no-such-agent` из `agent\.bin` не найден в PATH/)
  const found = await agentOf("my-agent", { ...env, ...fakeAgent("my-agent") })
  assert.equal(found.level, "ok", found.detail); assert.match(found.detail, /9\.9\.9/)
  // относительный путь — от папки конфига, а не от текущей папки процесса
  fs.mkdirSync(path.join(root, "kit", "tools"), { recursive: true }); fs.writeFileSync(path.join(root, "kit", "tools", "agent"), "")
  const rel = await agentOf("tools/agent")
  assert.equal(rel.level, "ok", rel.detail); assert.ok(rel.detail.includes(path.join(root, "kit", "tools", "agent").replace(/\\/g, "/")), rel.detail)
})

test("doctor: включённый модуль без нужного конфига — предупреждение; удалённая машина без --net не проверяется", async () => {
  const { root, repo } = makeRepo()
  const file = path.join(root, "kit", "dispatcher.project.json")
  const env = { ...process.env, ...fakeAgent(), DISPATCHER_PROJECT: file }
  const answersFile = path.join(root, "kit", "project", "answers.json")
  const given = { ...humanFor(detect({ repo, env, answersFile })), "machines.remote": [{ id: "build", ssh: "dk-no-such-host", dir: "~/dk" }] }
  apply({ repo, given, env, answersFile, branches: true })
  const raw = JSON.parse(fs.readFileSync(file, "utf8")); raw.modules.accept = true
  fs.writeFileSync(file, JSON.stringify(raw))
  const d = await runDoctor({ file, env })
  assert.ok(d.ok)
  assert.equal(d.checks.find((c) => c.id === "machine.build").level, "info")
  assert.match(d.checks.find((c) => c.id === "module.accept").detail, /accept\.run/)
  assert.ok(d.modules.find((m) => m.id === "machines").on)
})

test("разбор аргументов командной строки", () => {
  assert.deepEqual(parseArgs(["apply", "--repo", "C:/x", "--answers=a.json", "--force", "--dry-run"]), { _: ["apply"], repo: "C:/x", answers: "a.json", force: true, "dry-run": true })
  assert.deepEqual(parseArgs(["detect", "--repo", "--json"]), { _: ["detect"], repo: true, json: true })
})

test("навыки: путь дома вместо заглушки, повтор — без изменений, чужой навык с тем же именем не трогается, в тесте без каталога — пропуск", async () => {
  const { installSkills, skillsDir, HOME_MARK } = await import("./skills.mjs")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dk-skills-"))
  try {
    const r1 = installSkills({ runtime: "claude", dir, home: "/opt/dk" })
    assert.ok(r1.length >= 5 && r1.every((x) => x.status === "written"), JSON.stringify(r1))
    const t = fs.readFileSync(path.join(dir, "new-epic", "SKILL.md"), "utf8")
    assert.ok(!t.includes(HOME_MARK) && t.includes("node /opt/dk/scripts/dev/epic.mjs"), "заглушка заменена путём дома")
    assert.ok(installSkills({ runtime: "claude", dir, home: "/opt/dk" }).every((x) => x.status === "same"))
    fs.writeFileSync(path.join(dir, "slot-commit", "SKILL.md"), "мой навык\n")
    const r3 = installSkills({ runtime: "claude", dir, home: "/opt/dk" })
    assert.equal(r3.find((x) => x.name === "slot-commit").status, "kept")
    assert.equal(fs.readFileSync(path.join(dir, "slot-commit", "SKILL.md"), "utf8"), "мой навык\n")
    assert.ok(installSkills({ runtime: "claude", dir: null }).every((x) => x.status === "skipped"))
    assert.equal(skillsDir("claude", { NODE_TEST_CONTEXT: "1" }), null, "под node --test без DISPATCHER_SKILLS_DIR профиль не трогается")
    assert.match(skillsDir("codex", {}).split(path.sep).join("/"), /\/\.agents\/skills$/)
    assert.match(skillsDir("claude", {}).split(path.sep).join("/"), /\/\.claude\/skills$/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ── дом: второй и следующие проекты (setup.mjs add) ──

const homeEnv = (root) => {
  const env = { ...process.env, ...fakeAgent(), DISPATCHER_HOME: path.join(root, "kit", "dispatcher.home.json"), DISPATCHER_SKILLS_DIR: path.join(root, "skills") }
  delete env.DISPATCHER_PROJECT
  return env
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"))

test("add: первый add создаёт дом, прежний конфиг входит в него ссылкой; новый — в projects/<id>/ без общего; doctor дома зелёный", async () => {
  const { root, repo } = makeRepo()
  const env = homeEnv(root), kit = path.join(root, "kit"), legacy = path.join(kit, "dispatcher.project.json")
  // прежняя установка одного проекта
  const r0 = detect({ repo, env, file: legacy })
  apply({ repo, given: humanFor(r0), env, file: legacy, branches: true })
  const legacyText = fs.readFileSync(legacy, "utf8")

  const repo2 = makeRepo().repo
  assert.throws(() => addProject({ repo: repo2, env }), /проект `demo-shop` уже в доме.*--id/s, "имя совпало с прежним проектом — нужен --id")
  const plan = addProject({ repo: repo2, id: "blog", env })
  assert.deepEqual([plan.id, plan.port, plan.homeCreated, plan.adopted], ["blog", 4802, true, "demo-shop"])
  assert.equal(plan.file, fwd(path.join(kit, "projects", "blog", "dispatcher.project.json")))
  for (const id of SHARED_IDS) assert.ok(!plan.ask.some((q) => q.id === id) && !plan.known.some((q) => q.id === id), "общее не спрашивается: " + id)
  assert.ok(!fs.existsSync(env.DISPATCHER_HOME), "план ничего не пишет")

  const done = addProject({ repo: repo2, id: "blog", env, given: humanFor(plan), branches: true })
  for (const f of [plan.file, env.DISPATCHER_HOME]) assert.ok(done.written.includes(fwd(f)), f)
  const home = readJson(env.DISPATCHER_HOME)
  assert.deepEqual(home.projects, [
    { id: "demo-shop", file: "dispatcher.project.json", port: 4801 },
    { id: "blog", file: "projects/blog/dispatcher.project.json", port: 4802 },
  ])
  assert.equal(home.shared.agent.runtime, "claude"); assert.equal(home.shared.limits.slots, readJson(legacy).limits.slots)
  assert.equal(fs.readFileSync(legacy, "utf8"), legacyText, "прежний конфиг не тронут")
  const cfg = readJson(plan.file)
  assert.ok(!cfg.agent && !cfg.limits && !cfg.machines, "общее — в доме, не в конфиге проекта")
  assert.equal(cfg.modules.tg, false)
  assert.ok(fs.existsSync(path.join(kit, "projects", "blog", "project", "answers.json")), "ответы — рядом со своим конфигом")
  const p = loadProject({ file: plan.file, fresh: true, env })
  assert.equal(p.agent.runtime, "claude"); assert.equal(p.limits.shared.slots, home.shared.limits.slots)

  const d = await runHomeDoctor({ file: env.DISPATCHER_HOME, env })
  assert.equal(d.ok, true, formatHomeDoctor(d))
  assert.deepEqual(d.projects.map((x) => [x.id, x.ok]), [["demo-shop", true], ["blog", true]])
  assert.match(formatHomeDoctor(d), /── проект blog \(порт 4802\) ──/)

  assert.throws(() => addProject({ repo: repo2, id: "blog", env, given: {} }), /уже в доме.*--force/s)
  assert.throws(() => addProject({ repo: repo2, id: "blog2", env, given: {} }), /уже в доме проектом `blog`/)
  const repo3 = makeRepo({ develop: false }).repo
  const tinyPlan = addProject({ repo: repo3, id: "tiny", env })
  const light = addProject({ repo: repo3, id: "tiny", light: true, env, given: { ...humanFor(tinyPlan), "git.integration": "main", "git.production": "" }, branches: true })
  assert.equal(readJson(light.file).mode, "light"); assert.equal(light.port, 4803)
  const tiny = (await runHomeDoctor({ file: env.DISPATCHER_HOME, env, only: "tiny" })).projects[0]
  assert.match(tiny.checks.find((c) => c.id === "config").detail, /в разработке/)

  assert.deepEqual(listProjects({ env }).map((x) => [x.id, x.ok, x.mode]), [["demo-shop", true, "full"], ["blog", true, "full"], ["tiny", true, "light"]])
  removeProject({ id: "blog", env })
  assert.deepEqual(readJson(env.DISPATCHER_HOME).projects.map((x) => x.id), ["demo-shop", "tiny"])
  assert.ok(fs.existsSync(plan.file), "снятие с дома не удаляет конфиг")
  assert.throws(() => removeProject({ id: "nope", env }), /нет проекта `nope`/)
})

test("doctor дома: общие папки и бот в нескольких проектах — ошибки; неизвестный --project и сломанный дом — ошибки", async () => {
  const { root, repo } = makeRepo(), repo2 = makeRepo().repo
  const env = homeEnv(root), kit = path.join(root, "kit")
  const fileA = path.join(kit, "projects", "a", "dispatcher.project.json"), fileB = path.join(kit, "projects", "b", "dispatcher.project.json")
  apply({ repo, given: humanFor(detect({ repo, env, file: fileA })), env, file: fileA, branches: true })
  apply({ repo: repo2, given: humanFor(detect({ repo: repo2, env, file: fileB })), env, file: fileB, branches: true })
  const a = readJson(fileA), b = readJson(fileB)
  b.repo.worktrees = a.repo.worktrees; a.modules.tg = b.modules.tg = true
  fs.writeFileSync(fileA, JSON.stringify(a)); fs.writeFileSync(fileB, JSON.stringify(b))
  const projects = [{ id: "a", file: "projects/a/dispatcher.project.json", port: 4801 }, { id: "b", file: "projects/b/dispatcher.project.json", port: 4802 }]
  fs.writeFileSync(env.DISPATCHER_HOME, JSON.stringify({ schema: 1, projects }))
  const d = await runHomeDoctor({ file: env.DISPATCHER_HOME, env })
  assert.equal(d.ok, false)
  const errs = d.checks.filter((c) => c.level === "error").map((c) => c.title + ": " + c.detail)
  assert.ok(errs.some((t) => /Одна папка слотов/.test(t) && /a, b/.test(t)), errs.join("\n"))
  assert.ok(errs.some((t) => /Одна папка данных/.test(t)), "папка данных по умолчанию — внутри папки слотов")
  assert.ok(errs.some((t) => /Модуль `tg` в нескольких проектах/.test(t)))
  const one = await runHomeDoctor({ file: env.DISPATCHER_HOME, env, only: "zzz" })
  assert.match(one.checks.find((c) => c.id === "home.project").detail, /нет проекта `zzz`/)
  fs.writeFileSync(env.DISPATCHER_HOME, "{")
  assert.equal((await runHomeDoctor({ file: env.DISPATCHER_HOME, env })).checks.find((c) => c.id === "home").level, "error")
})

test("без дома — как прежде: apply пишет dispatcher.project.json в папку диспетчерской, doctor — прежний отчёт; в доме apply отсылает к add", () => {
  const { root, repo } = makeRepo()
  const kit = path.join(root, "kit"), env = homeEnv(root)
  delete env.NODE_TEST_CONTEXT
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, "setup.mjs"), ...args], { cwd: root, env, encoding: "utf8", windowsHide: true })
  const answers = path.join(root, "answers.json")
  fs.writeFileSync(answers, JSON.stringify(humanFor(detect({ repo, env: homeEnv(root), file: path.join(kit, "dispatcher.project.json") }))))
  const r = cli("apply", "--repo", repo, "--answers", answers, "--branches")
  assert.ok(fs.existsSync(path.join(kit, "dispatcher.project.json")), r.stdout + r.stderr)
  assert.ok(!fs.existsSync(env.DISPATCHER_HOME), "дом сам не появляется")
  const d = JSON.parse(cli("doctor", "--json").stdout)
  assert.deepEqual(Object.keys(d).sort(), ["checks", "modules", "ok"])
  assert.equal(d.ok, true, JSON.stringify(d.checks.filter((c) => c.level === "error")))
  fs.writeFileSync(env.DISPATCHER_HOME, JSON.stringify({ schema: 1, projects: [{ id: "demo-shop", file: "dispatcher.project.json", port: 4801 }] }))
  const refused = cli("apply", "--repo", repo, "--answers", answers)
  assert.equal(refused.status, 1); assert.match(refused.stderr, /командой add/)
  const hd = JSON.parse(cli("doctor", "--json").stdout)
  assert.deepEqual(hd.projects.map((p) => [p.id, p.ok]), [["demo-shop", true]])
})
