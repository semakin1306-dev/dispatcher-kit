// detect.mjs — что о проекте можно узнать без вопросов: git, стек, области, CI, машина, рантаймы агента.
// Из фактов строятся предложенные ответы квиза с оценкой уверенности: high — можно не спрашивать, low — показать и уточнить.
// Ничего не пишет и ничего не запускает, кроме `git` на чтение.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const fwd = (p) => String(p).replace(/\\/g, "/")
const readText = (file) => { try { return fs.readFileSync(file, "utf8") } catch { return null } }
const readJson = (file) => { try { return JSON.parse(readText(file).replace(/^\uFEFF/, "")) } catch { return null } }
const exists = (...parts) => fs.existsSync(path.join(...parts))
const listDirs = (dir) => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** id из имени папки: строчная латиница, цифры, дефис; с буквы. */
export function toId(name) {
  let s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  if (!/^[a-z]/.test(s)) s = "x" + (s ? "-" + s : "")
  return s.slice(0, 40)
}

// ───────────────────────────── git ─────────────────────────────

const gitOut = (repo, args) => { try { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim() } catch { return null } }

/** Хостинг по адресу remote — только для подсказки, какой CI ждать. */
export function hostKind(url) {
  const u = String(url || "").toLowerCase()
  if (u.includes("github.com")) return "github"
  if (u.includes("gitlab")) return "gitlab"
  if (u.includes("bitbucket")) return "bitbucket"
  if (u.includes("gitflic")) return "gitflic"
  if (u.includes("gitea") || u.includes("codeberg") || u.includes("forgejo")) return "gitea"
  if (u.includes("dev.azure.com") || u.includes("visualstudio.com")) return "azure"
  return u ? "other" : ""
}

export function gitFacts(repo) {
  const top = gitOut(repo, ["rev-parse", "--show-toplevel"])
  if (top == null) return { isRepo: false, remotes: [], localBranches: [], remoteBranches: {}, current: "", defaultBranch: {} }
  const remotes = (gitOut(repo, ["remote"]) || "").split("\n").filter(Boolean).map((name) => {
    const url = gitOut(repo, ["remote", "get-url", name]) || ""
    return { name, kind: hostKind(url) } // сам адрес в факты не кладём: в нём бывают токены
  })
  const localBranches = (gitOut(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]) || "").split("\n").filter(Boolean)
  const remoteBranches = {}, defaultBranch = {}
  for (const r of remotes) {
    const refs = (gitOut(repo, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/" + r.name]) || "").split("\n").filter(Boolean)
    remoteBranches[r.name] = refs.map((x) => x.slice(r.name.length + 1)).filter((x) => x && x !== "HEAD")
    const head = gitOut(repo, ["symbolic-ref", "--short", "refs/remotes/" + r.name + "/HEAD"])
    defaultBranch[r.name] = head ? head.slice(r.name.length + 1) : ""
  }
  return { isRepo: true, top: fwd(top), remotes, localBranches, remoteBranches, defaultBranch, current: gitOut(repo, ["rev-parse", "--abbrev-ref", "HEAD"]) || "" }
}

// ───────────────────────────── стек ─────────────────────────────

const PM_LOCKS = [["pnpm", "pnpm-lock.yaml"], ["yarn", "yarn.lock"], ["bun", "bun.lockb"], ["bun", "bun.lock"], ["npm", "package-lock.json"]]

/** Папки рабочих пространств: шаблоны `apps/*`, `packages/**` из pnpm-workspace.yaml или package.json. */
function workspaceDirs(repo, pkg) {
  let patterns = []
  const yaml = readText(path.join(repo, "pnpm-workspace.yaml"))
  if (yaml) {
    let inPackages = false
    for (const line of yaml.split(/\r?\n/)) {
      if (/^packages\s*:/.test(line)) { inPackages = true; continue }
      if (inPackages) { const m = /^\s+-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line); if (m) patterns.push(m[1].trim()); else if (/^\S/.test(line)) inPackages = false }
    }
  }
  if (!patterns.length && pkg) patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces && Array.isArray(pkg.workspaces.packages) ? pkg.workspaces.packages : [])
  const dirs = new Set()
  for (const pat of patterns) {
    if (pat.startsWith("!")) continue
    const clean = fwd(pat).replace(/\/+$/, "")
    const star = clean.indexOf("*")
    if (star < 0) { if (exists(repo, clean, "package.json")) dirs.add(clean); continue }
    const base = clean.slice(0, star).replace(/\/+$/, "")
    const deep = clean.includes("**")
    const walk = (rel, depth) => {
      for (const d of listDirs(path.join(repo, rel))) {
        const sub = rel ? rel + "/" + d : d
        if (exists(repo, sub, "package.json")) dirs.add(sub)
        else if (deep && depth < 3) walk(sub, depth + 1)
      }
    }
    walk(base, 0)
  }
  return [...dirs].sort()
}

const depsOf = (pkg) => ({ ...(pkg && pkg.dependencies), ...(pkg && pkg.devDependencies) })

export function stackFacts(repo) {
  const pkg = readJson(path.join(repo, "package.json"))
  const pm = (PM_LOCKS.find(([, lock]) => exists(repo, lock)) || [pkg ? "npm" : ""])[0]
  const lockfile = (PM_LOCKS.find(([, lock]) => exists(repo, lock)) || [, ""])[1]
  const languages = []
  if (pkg) languages.push("node")
  if (exists(repo, "go.mod") || exists(repo, "go.work")) languages.push("go")
  if (exists(repo, "pyproject.toml") || exists(repo, "requirements.txt") || exists(repo, "setup.py")) languages.push("python")
  if (exists(repo, "Cargo.toml")) languages.push("rust")
  if (exists(repo, "pom.xml") || exists(repo, "build.gradle") || exists(repo, "build.gradle.kts")) languages.push("jvm")
  if (exists(repo, "composer.json")) languages.push("php")
  if (exists(repo, "Gemfile")) languages.push("ruby")

  const workspaces = workspaceDirs(repo, pkg).map((dir) => {
    const p = readJson(path.join(repo, dir, "package.json")) || {}
    const deps = depsOf(p)
    return {
      dir,
      name: p.name || dir,
      scripts: Object.keys(p.scripts || {}),
      jest: "jest" in deps,
      vitest: "vitest" in deps,
      playwright: "@playwright/test" in deps || "playwright" in deps,
      cypress: "cypress" in deps,
    }
  })
  // Go-модули вне корня: сервисы в монорепо
  const goDirs = []
  for (const top of ["services", "apps", "cmd"]) for (const d of listDirs(path.join(repo, top))) if (exists(repo, top, d, "go.mod")) goDirs.push(top + "/" + d)
  if (goDirs.length && !languages.includes("go")) languages.push("go")

  const rootDeps = depsOf(pkg)
  const pyproject = readText(path.join(repo, "pyproject.toml")) || ""
  return {
    languages, pm, lockfile, name: (pkg && pkg.name) || "",
    scripts: Object.keys((pkg && pkg.scripts) || {}),
    jest: "jest" in rootDeps, vitest: "vitest" in rootDeps,
    playwright: "@playwright/test" in rootDeps || "playwright" in rootDeps || workspaces.some((w) => w.playwright),
    cypress: "cypress" in rootDeps || workspaces.some((w) => w.cypress),
    workspaces, goDirs, goRoot: exists(repo, "go.mod"),
    pytest: /\bpytest\b/.test(pyproject) || /\bpytest\b/.test(readText(path.join(repo, "requirements.txt")) || "") || exists(repo, "pytest.ini") || exists(repo, "conftest.py"),
    ruff: /\[tool\.ruff/.test(pyproject) || exists(repo, "ruff.toml"),
    topDirs: listDirs(repo),
  }
}

// ───────────────────────────── CI ─────────────────────────────

const CI_FILES = [
  ["gitlab-ci", ".gitlab-ci.yml"], ["gitflic-ci", "gitflic-ci.yaml"], ["jenkins", "Jenkinsfile"], ["circleci", ".circleci/config.yml"],
  ["azure-pipelines", "azure-pipelines.yml"], ["bitbucket-pipelines", "bitbucket-pipelines.yml"], ["drone", ".drone.yml"],
]
const listFiles = (dir, re) => { try { return fs.readdirSync(dir).filter((f) => re.test(f)).sort() } catch { return [] } }

export function ciFacts(repo) {
  const found = [] // { kind, file }
  for (const f of listFiles(path.join(repo, ".github", "workflows"), /\.ya?ml$/)) found.push({ kind: "github-actions", file: ".github/workflows/" + f })
  for (const f of listFiles(path.join(repo, ".gitea", "workflows"), /\.ya?ml$/)) found.push({ kind: "gitea-actions", file: ".gitea/workflows/" + f })
  for (const [kind, file] of CI_FILES) if (exists(repo, file)) found.push({ kind, file })
  const kinds = [...new Set(found.map((x) => x.kind))]
  let selfHosted = false, cloud = false, deployOnPush = []
  for (const { file } of found) {
    const text = readText(path.join(repo, file)) || ""
    if (/runs-on:\s*\[?\s*['"]?self-hosted/.test(text) || /^\s*tags:\s*$/m.test(text) || /^\s*tags:\s*\[/m.test(text)) selfHosted = true
    if (/runs-on:\s*['"]?(ubuntu|windows|macos)-/.test(text) || /^\s*image:\s*\S/m.test(text)) cloud = true
    // Эвристика «пуш выкатывает»: файл про выкат и в нём есть запуск по пушу. Уверенность низкая — человек подтверждает.
    if (/deploy|release|publish|выкат/i.test(file + "\n" + text) && /(^|\n)\s*(on:\s*\[?\s*push|push:|only:|rules:)/.test(text)) deployOnPush.push(file)
  }
  return { kinds, files: found.map((x) => x.file), protect: ciProtect(found), selfHosted, cloud, deployOnPush }
}
function ciProtect(found) {
  const out = new Set()
  for (const { file } of found) out.add(file.startsWith(".github/") ? "/.github/**" : file.startsWith(".gitea/") ? "/.gitea/**" : file.startsWith(".circleci/") ? "/.circleci/**" : "/" + file)
  return [...out]
}

// ───────────────────────────── службы для тестов, выкат, машина, рантаймы ─────────────────────────────

export function servicesFacts(repo) {
  const files = listFiles(repo, /^(docker-)?compose[\w.-]*\.ya?ml$/)
  const images = new Set()
  for (const f of files) for (const m of (readText(path.join(repo, f)) || "").matchAll(/^\s*image:\s*['"]?([\w./-]+)/gm)) {
    const base = m[1].split("/").pop()
    if (/^(postgres|mysql|mariadb|mongo|redis|valkey|rabbitmq|kafka|elasticsearch|opensearch|minio|clickhouse|memcached|nats)/.test(base)) images.add(base)
  }
  return { composeFiles: files, images: [...images].sort() }
}

export function deployFacts(repo) {
  const scripts = listFiles(repo, /^deploy[\w.-]*\.(sh|ps1|mjs|js|py)$/)
  const dirs = ["infra", "deploy", "ops", "k8s", "helm", "terraform", "ansible"].filter((d) => exists(repo, d))
  return { scripts, dirs }
}

export function machineFacts() {
  return { platform: process.platform, cpus: os.cpus().length, totalGB: Math.round(os.totalmem() / 2 ** 30), freeGB: Math.round(os.freemem() / 2 ** 30), node: process.versions.node }
}

/** Найти исполняемый файл в PATH без запуска. На Windows перебираются расширения из PATHEXT. */
export function whichBin(name, env = process.env, platform = process.platform) {
  const exts = platform === "win32" ? ["", ...String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)] : [""]
  for (const dir of String(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext)
      try { if (fs.statSync(file).isFile()) return fwd(file) } catch { /* нет */ }
    }
  }
  return ""
}
export const runtimeFacts = (env = process.env) => ({ claude: whichBin("claude", env), codex: whichBin("codex", env) })

/** Все факты разом. */
export function detectFacts(repo, { env = process.env } = {}) {
  const abs = path.resolve(repo)
  return {
    repo: fwd(abs),
    exists: fs.existsSync(abs),
    git: gitFacts(abs),
    stack: stackFacts(abs),
    ci: ciFacts(abs),
    services: servicesFacts(abs),
    deploy: deployFacts(abs),
    machine: machineFacts(),
    runtimes: runtimeFacts(env),
  }
}

// ───────────────────────────── предложения ответов ─────────────────────────────

const INTEGRATION_NAMES = ["staging", "develop", "dev", "development", "integration", "next"]
const PROD_NAMES = ["main", "master", "production", "prod", "release", "trunk"]

const runScript = (pm, script) =>
  pm === "npm"
    ? script === "test"
      ? "npm test"
      : "npm run " + script
    : pm === "bun"
      ? "bun run " + script
      : pm + " " + (["test", "start"].includes(script) || pm === "yarn" ? script : "run " + script)
const INSTALL = { pnpm: "pnpm install --frozen-lockfile --prefer-offline", npm: "npm ci --prefer-offline", yarn: "yarn install --immutable", bun: "bun install --frozen-lockfile" }
const firstScript = (scripts, names) => names.find((n) => scripts.includes(n)) || ""

/** Каталог задач по стеку. Возвращает и то, какой области какая задача подходит. */
export function suggestTasks(stack) {
  const tasks = {}, byDir = {}
  const add = (id, task, dir = "") => { tasks[id] = task; (byDir[dir] ||= []).push(id) }
  const pm = stack.pm || "npm"
  const input = (label, placeholder = "wv-0001") => ({ label, placeholder })
  if (stack.languages.includes("node")) {
    const testers = stack.workspaces.filter((w) => w.jest || w.vitest)
    if (testers.length) for (const w of testers) {
      const id = toId(path.basename(w.dir)) + "-test"
      if (w.jest) add(id, { label: `${w.name}: jest по шаблону`, group: "Тесты", run: "npx jest {input}", input: input("шаблон пути спеки"), cwd: w.dir, parser: "jest" }, w.dir)
      else add(id, { label: `${w.name}: vitest по фильтру`, group: "Тесты", run: "npx vitest run {input}", input: input("подстрока имени спеки"), cwd: w.dir, parser: "vitest" }, w.dir)
    }
    else if (stack.jest) add("test", { label: "Jest по шаблону", group: "Тесты", run: "npx jest {input}", input: input("шаблон пути спеки"), parser: "jest" })
    else if (stack.vitest) add("test", { label: "Vitest по фильтру", group: "Тесты", run: "npx vitest run {input}", input: input("подстрока имени спеки"), parser: "vitest" })
    if (stack.scripts.includes("test")) add("test-all", { label: "Тесты: весь набор", group: "Тесты", run: runScript(pm, "test"), parser: stack.jest ? "jest" : stack.vitest ? "vitest" : "exit-code" })
    const lint = firstScript(stack.scripts, ["lint", "lint:check", "eslint"])
    if (lint) add("lint", { label: "Линтер", group: "Гарды", run: runScript(pm, lint), gate: true })
    const types = firstScript(stack.scripts, ["typecheck", "type-check", "check-types", "tsc", "types"])
    if (types) add("typecheck", { label: "Типы", group: "Гарды", run: runScript(pm, types), gate: true })
    if (stack.scripts.includes("build")) add("build", { label: "Сборка", group: "Сборка", run: runScript(pm, "build") })
  }
  if (stack.languages.includes("go")) {
    if (stack.goRoot) {
      add("go-test", { label: "Go: тесты", group: "Тесты", run: "go test ./...", parser: "go-test" })
      add("go-vet", { label: "Go: vet", group: "Гарды", run: "go vet ./...", gate: true })
    }
    for (const dir of stack.goDirs) add(toId(path.basename(dir)) + "-go-test", { label: `${dir}: go test`, group: "Тесты", run: "go test ./...", cwd: dir, parser: "go-test" }, dir)
  }
  if (stack.languages.includes("python")) {
    if (stack.pytest) add("pytest", { label: "Pytest по выражению", group: "Тесты", run: "python -m pytest -k {input}", input: input("выражение -k", "wv_0001"), parser: "pytest" })
    if (stack.ruff) add("ruff", { label: "Ruff", group: "Гарды", run: "ruff check .", gate: true })
  }
  if (stack.languages.includes("rust")) {
    add("cargo-test", { label: "Cargo: тесты", group: "Тесты", run: "cargo test" })
    add("clippy", { label: "Clippy", group: "Гарды", run: "cargo clippy --all-targets -- -D warnings", gate: true })
  }
  return { tasks, byDir }
}

/** Области: приложения и сервисы монорепо — каждое своя область, общие пакеты — одна; иначе весь репозиторий. */
export function suggestAreas(stack, byDir = {}) {
  const groups = new Map() // id → { title, paths, dirs }
  const put = (id, title, dir, glob) => { const g = groups.get(id) || { title, paths: [], dirs: [] }; g.paths.push(glob); g.dirs.push(dir); groups.set(id, g) }
  const dirs = [...new Set([...stack.workspaces.map((w) => w.dir), ...stack.goDirs])]
  for (const dir of dirs) {
    const top = dir.split("/")[0]
    if (["packages", "libs", "lib", "shared", "common"].includes(top)) put(toId(top), "Общие пакеты", dir, top + "/**")
    else put(toId(path.basename(dir)), path.basename(dir), dir, dir + "/**")
  }
  if (!groups.size) return { app: { title: "Проект", paths: ["**"], tasks: byDir[""] || [] } }
  const areas = {}
  for (const [id, g] of groups) {
    const paths = [...new Set(g.paths)]
    const others = [...groups].filter(([other]) => other !== id).flatMap(([, x]) => x.paths)
    const tasks = [...new Set(g.dirs.flatMap((d) => byDir[d] || []))]
    areas[id] = { title: g.title, paths, denyEdit: [...new Set(others)], ...(stack.scripts.includes("build") && stack.languages.includes("node") ? { build: true } : {}), tasks }
  }
  return areas
}

function suggestSlotPrepare(stack) {
  const steps = []
  if (stack.languages.includes("node") && INSTALL[stack.pm]) steps.push({ run: INSTALL[stack.pm] })
  if (stack.languages.includes("node") && stack.scripts.includes("build") && stack.workspaces.length) steps.push({ run: runScript(stack.pm, "build"), when: "build" })
  if (stack.languages.includes("go")) steps.push({ run: "go mod download" })
  if (stack.languages.includes("rust")) steps.push({ run: "cargo fetch" })
  return steps
}

function suggestDenyEdit(facts) {
  const { stack, ci, deploy } = facts
  const out = []
  if (stack.languages.includes("node") && stack.workspaces.length) out.push("/package.json")
  if (stack.lockfile) out.push("/" + stack.lockfile)
  if (fs.existsSync(path.join(facts.repo, "pnpm-workspace.yaml"))) out.push("/pnpm-workspace.yaml")
  if (stack.goRoot && stack.goDirs.length) out.push("/go.work")
  out.push(...ci.protect, ...deploy.scripts.map((s) => "/" + s), ...deploy.dirs.map((d) => "/" + d + "/**"))
  return [...new Set(out)]
}

function suggestDenyCommands(stack, tasks) {
  const out = new Set()
  for (const t of Object.values(tasks)) if (t.group === "Тесты") out.add(t.run.replace(/\s*\{input\}.*$/, "").split(/\s+/).slice(0, t.run.startsWith("python -m") ? 3 : 2).join(" "))
  for (const s of ["dev", "start", "serve"]) if (stack.scripts.includes(s)) out.add(runScript(stack.pm || "npm", s))
  return [...out]
}

const high = (value, why) => ({ value, confidence: "high", why })
const low = (value, why) => ({ value, confidence: "low", why })

/**
 * Предложенные ответы квиза.
 * @param prev прежние ответы (повторная настройка) — берутся как есть
 * @returns {Record<string,{value:any, confidence:"high"|"low"|"prev", why:string}>}
 */
export function suggestAnswers(facts, prev = {}) {
  const a = {}
  const { git, stack, ci, machine, runtimes, services } = facts

  a["project.name"] = high(stack.name && !stack.name.startsWith("@") ? stack.name : path.basename(facts.repo), stack.name ? "имя из package.json" : "имя папки")
  a["repo.worktrees"] = high(facts.repo + "-wt", "соседняя папка")
  a["mode"] = high("full", "лёгкий режим — флагом --light у `setup.mjs add`")

  if (git.isRepo && git.remotes.length) {
    const origin = git.remotes.find((r) => r.name === "origin")
    const remote = git.remotes.length === 1 ? git.remotes[0].name : origin ? "origin" : ""
    if (remote) a["git.remote"] = git.remotes.length === 1 ? high(remote, "remote один") : low(remote, "remote несколько: " + git.remotes.map((r) => r.name).join(", "))
    const branches = git.remoteBranches[remote] || []
    const def = git.defaultBranch[remote] || PROD_NAMES.find((n) => branches.includes(n)) || ""
    const integ = INTEGRATION_NAMES.filter((n) => branches.includes(n))
    if (integ.length === 1) {
      a["git.integration"] = high(integ[0], `на ${remote} есть ветка ${integ[0]}`)
      const prod = def && def !== integ[0] ? def : PROD_NAMES.find((n) => branches.includes(n) && n !== integ[0]) || ""
      a["git.production"] = prod ? high(prod, `основная ветка ${remote} — ${prod}`) : low("", "отдельной прод-ветки не видно")
    } else if (integ.length > 1) {
      a["git.integration"] = low(integ[0], "похожих веток несколько: " + integ.join(", "))
      if (def) a["git.production"] = low(def, `основная ветка ${remote} — ${def}`)
    } else if (def) {
      a["git.integration"] = low(def, `отдельной интеграционной ветки не видно — работа идёт прямо в ${def}?`)
      a["git.production"] = low("", "при одной ветке отдельной прод-ветки нет")
    }
  }
  if (ci.deployOnPush.length) a["git.pushDeploys"] = low(true, "в CI есть выкат по пушу: " + ci.deployOnPush.join(", "))

  const { tasks, byDir } = suggestTasks(stack)
  a["tasks"] = low(tasks, Object.keys(tasks).length ? "по стеку: " + (stack.languages.join(", ") || "не определён") : "стек не определён — задачи нужно назвать")
  a["areas"] = low(suggestAreas(stack, byDir), stack.workspaces.length || stack.goDirs.length ? "по рабочим пространствам монорепо" : "репозиторий без деления — одна область")
  a["slotPrepare"] = low(suggestSlotPrepare(stack), stack.pm ? "менеджер пакетов — " + stack.pm : "по стеку")
  a["deny.edit"] = low(suggestDenyEdit(facts), "манифесты, lock-файл, CI и выкат")
  a["deny.commands"] = low(suggestDenyCommands(stack, tasks), "запуск тестов и dev-серверов — дело диспетчерской")

  a["ci.kind"] =
    ci.kinds.length === 1
      ? high(ci.kinds[0], "найдено: " + ci.files.join(", "))
      : ci.kinds.length > 1
        ? low(ci.kinds[0], "найдено несколько: " + ci.kinds.join(", "))
        : low("none", "файлов CI в репозитории нет")
  if (ci.kinds.length)
    a["ci.runners"] = low(
      ci.selfHosted && ci.cloud ? "mixed" : ci.selfHosted ? "self-hosted" : "cloud",
      ci.selfHosted ? "в CI есть метки своих раннеров" : "меток своих раннеров не видно",
    )

  a["machines.localWorkers"] = high(Math.min(8, Math.max(1, Math.floor(machine.cpus / 2))), `ядер ${machine.cpus}`)
  a["limits.slots"] = high(Math.min(6, Math.max(1, Math.floor(machine.totalGB / 8))), `памяти ${machine.totalGB} ГБ, по 8 ГБ на слот`)
  a["machines.remote"] = low([], "других машин диспетчерская не знает")
  a["tests.services"] = low([], services.images.length ? `в ${services.composeFiles.join(", ")} есть ${services.images.join(", ")} — нужны ли они тестам?` : "служб в репозитории не видно")

  a["stand.run"] = low("", "стенд по репозиторию не определить")
  a["stand.url"] = low("", "")
  a["accept.run"] = low(
    stack.playwright ? "npx playwright test" : stack.cypress ? "npx cypress run" : "",
    stack.playwright
      ? "в зависимостях есть Playwright"
      : stack.cypress
        ? "в зависимостях есть Cypress"
        : "e2e-инструмента в зависимостях нет",
  )
  a["prod.run"] = low("", facts.deploy.scripts.length ? "в корне есть " + facts.deploy.scripts.join(", ") : "")
  a["prod.verify"] = low("", "")

  const found = ["claude", "codex"].filter((r) => runtimes[r])
  if (found.length === 1) a["agent.runtime"] = high(found[0], `в PATH найден только ${found[0]}`)
  else if (found.length === 2) a["agent.runtime"] = low("claude", "в PATH есть и claude, и codex")
  else a["agent.runtime"] = low("claude", "ни claude, ни codex в PATH нет — рантайм нужно поставить")
  a["agent.models"] = high({}, "умолчания рантайма")
  a["agent.proxy"] = high("", "выход напрямую")
  a["agent.network"] = high(false, "без сети в песочнице агента (ключ читает только Codex)")

  a["autonomy"] = low("manual", "безопасное начало: коммит и влив — кнопкой человека")
  a["modules.tg"] = low(false, "")
  a["modules.optional"] = low(["review", "backlog"], "ревью и бэклог включены, остальное по желанию")

  for (const [id, value] of Object.entries(prev)) a[id] = { value, confidence: "prev", why: "прежний ответ" }
  return a
}
