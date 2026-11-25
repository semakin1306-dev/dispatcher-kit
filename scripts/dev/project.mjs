// project.mjs — единый загрузчик конфига проекта (dispatcher.project.json).
//
// Всё, что диспетчерская знает о ЧУЖОМ проекте — где он лежит, какие в нём области, чем он проверяется, на каких машинах,
// как выкатывается, — приходит отсюда. В коде ядра нет ни путей, ни команд, ни имён конкретного проекта.
// Файл пишет стартовая настройка (`node setup.mjs apply`); руками его править можно, проверка — `node setup.mjs doctor`.
//
// Три шага: validateProject (сырой JSON → ошибки и предупреждения человеческим языком) → normalizeProject (умолчания,
// абсолютные пути) → loadProject (чтение с диска, кеш). Проверка не бросает исключений: настройке нужен полный список
// ошибок разом, а не первая.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { MODULE_IDS } from "./modules-catalog.mjs"

/** Дом диспетчерской — её собственный репозиторий. */
export const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
export const SCHEMA = 1
export const RUNTIMES = ["claude", "codex"]
/** Заготовки разбора вывода задачи. `exit-code` — только код возврата, без имён спек. */
export const PARSERS = ["exit-code", "jest", "vitest", "go-test", "pytest"]
/** Функции, которые проект может дать кодом в dispatcher.project.mjs. Список закрытый. */
export const CODE_HOOKS = ["buildSteps", "slotPrepare", "remoteCmd", "parseOutput"]
export const SLOT_PREPARE_WHEN = ["always", "build"]

const ID_RE = /^[a-z][a-z0-9-]{0,39}$/
const REMOTE_RE = /^[A-Za-z0-9._-]+$/
const TOP_KEYS = ["schema", "name", "repo", "agent", "areas", "deny", "protected", "slotPrepare", "tasks", "stations", "machines", "release", "accept", "ci", "modules", "limits"]

/**
 * Запреты для агента слота, которые действуют в любом проекте: история и ветки меняются только диспетчерской,
 * на чужие машины агент не ходит, секреты окружения не читает. Коммит не запрещён, а спрашивается (`ask`).
 * Проект добавляет к этому своё; снять базовый набор — `deny.base: false`.
 * Команда — начало командной строки; с `=` в начале — команда целиком («=git add .» не закрывает `git add .gitignore`).
 */
export const BASE_DENY = {
  commands: [
    "git push", "git rebase", "git reset --hard", "git clean", "git branch -D", "git worktree", "git switch",
    "git add -A", "git add --all", "=git add .", "ssh", "scp",
  ],
  ask: ["git commit"],
  read: ["**/.env", "**/.env.*"],
  edit: [],
}

export const fwd = (p) => String(p).replace(/\\/g, "/")

/** Ошибка конфига: `code` — missing | json | invalid; `issues` — список для печати. */
export class ProjectConfigError extends Error {
  constructor(message, { code = "invalid", issues = [], file = "" } = {}) {
    super(message)
    this.name = "ProjectConfigError"
    this.code = code
    this.issues = issues
    this.file = file
  }
}

/** Демо-проект для тестов диспетчерской. */
export const DEMO_PROJECT = path.join(HOME, "test", "fixtures", "project.demo.json")

/**
 * Где лежит конфиг: переменная DISPATCHER_PROJECT, иначе dispatcher.project.json в доме диспетчерской.
 * Под `node --test` без заданной переменной берётся демо-проект: тесты диспетчерской не читают конфиг настоящего
 * проекта и не могут задеть его папки.
 */
export function projectFile(env = process.env) {
  if (env.DISPATCHER_PROJECT) return path.resolve(env.DISPATCHER_PROJECT)
  if (env.NODE_TEST_CONTEXT) return DEMO_PROJECT
  return path.join(HOME, "dispatcher.project.json")
}

/** `~` → домашняя папка; относительный путь — от папки конфига. Результат абсолютный, с прямыми слэшами. */
export function expandPath(p, baseDir = HOME) {
  let s = String(p).trim()
  if (s === "~") s = os.homedir()
  else if (s.startsWith("~/") || s.startsWith("~\\")) s = path.join(os.homedir(), s.slice(2))
  return fwd(path.resolve(baseDir, s))
}

/** Голое имя команды (без разделителя пути, например `claude`) — имя в PATH, а не путь. */
export const isBareCommand = (s) => !/[\\/]/.test(String(s))

/** Путь к бинарнику агента: пусто — искать в PATH; голое имя — тоже в PATH, как есть; остальное — как пути конфига. */
export const agentBinPath = (b, baseDir = HOME) => {
  const s = String(b || "").trim()
  return !s ? "" : isBareCommand(s) ? s : expandPath(s, baseDir)
}

// ───────────────────────────── проверка ─────────────────────────────

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v)
const isStr = (v) => typeof v === "string" && v.trim() !== ""
const isStrList = (v) => Array.isArray(v) && v.every(isStr)
const captureGroups = (re) => new RegExp(re.source + "|").exec("").length - 1

/** Имя ветки без пробелов, `..`, управляющих знаков и ведущего дефиса — достаточно, чтобы не уйти в флаги git. */
export const branchNameOk = (s) => isStr(s) && !/[\s~^:?*[\\\0-\x1f]/.test(s) && !s.includes("..") && !s.startsWith("-") && !s.endsWith("/") && !s.endsWith(".lock")

/**
 * Проверить сырой конфиг.
 * @returns {{errors:{path:string,message:string}[], warnings:{path:string,message:string}[]}}
 */
export function validateProject(raw) {
  const errors = [], warnings = []
  const E = (p, message) => errors.push({ path: p, message })
  const W = (p, message) => warnings.push({ path: p, message })
  if (!isObj(raw)) { E("", "конфиг должен быть объектом JSON"); return { errors, warnings } }

  if (raw.schema === undefined) E("schema", "нет номера схемы — ожидается `\"schema\": " + SCHEMA + "`")
  else if (!Number.isInteger(raw.schema)) E("schema", "номер схемы — целое число")
  else if (raw.schema > SCHEMA) E("schema", `конфиг новее диспетчерской (схема ${raw.schema}, диспетчерская понимает ${SCHEMA}) — обновите диспетчерскую`)
  else if (raw.schema < 1) E("schema", "номер схемы начинается с 1")

  for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) W(k, "неизвестный ключ — не используется")
  if (raw.name !== undefined && !isStr(raw.name)) E("name", "название проекта — непустая строка")

  const optObj = (key) => { const v = raw[key]; if (v === undefined) return null; if (!isObj(v)) { E(key, "ожидается объект"); return null } return v }
  const optStr = (obj, p, key) => { if (obj[key] !== undefined && obj[key] !== "" && !isStr(obj[key])) E(p + "." + key, "ожидается строка") }
  const optList = (obj, p, key) => { if (obj[key] !== undefined && !isStrList(obj[key])) E(p + "." + key, "ожидается список непустых строк") }
  const optBool = (obj, p, key) => { if (obj[key] !== undefined && typeof obj[key] !== "boolean") E(p + "." + key, "ожидается true или false") }

  // repo
  if (!isObj(raw.repo)) E("repo", "нет раздела `repo` — где лежит проект и какие у него ветки")
  else {
    const r = raw.repo
    if (!isStr(r.main)) E("repo.main", "путь к основной папке репозитория проекта обязателен")
    optStr(r, "repo", "worktrees"); optStr(r, "repo", "data"); optBool(r, "repo", "sparse")
    if (r.remote !== undefined && !(isStr(r.remote) && REMOTE_RE.test(r.remote))) E("repo.remote", "имя remote — латиница, цифры, точка, дефис, подчёркивание")
    if (!isObj(r.upstream)) E("repo.upstream", "нет `repo.upstream` — на какие ветки проекта смотрят роли `staging` и `main`")
    else {
      if (!branchNameOk(r.upstream.staging)) E("repo.upstream.staging", "имя интеграционной ветки проекта обязательно (например `develop` или `main`)")
      if (r.upstream.main != null && !branchNameOk(r.upstream.main)) E("repo.upstream.main", "имя прод-ветки — строка или null, если отдельной прод-ветки нет")
      if (isStr(r.upstream.main) && r.upstream.main === r.upstream.staging) E("repo.upstream.main", "прод-ветка совпадает с интеграционной — если ветка одна, поставьте `main: null`")
    }
  }

  // agent
  const agent = optObj("agent")
  if (agent) {
    if (agent.runtime !== undefined && !RUNTIMES.includes(agent.runtime)) E("agent.runtime", "рантайм агента — один из: " + RUNTIMES.join(", "))
    optStr(agent, "agent", "bin"); optStr(agent, "agent", "proxy"); optBool(agent, "agent", "network")
    if (agent.models !== undefined) {
      if (!isObj(agent.models)) E("agent.models", "ожидается объект { orch, slot, review }")
      else for (const [k, v] of Object.entries(agent.models)) {
        if (!["orch", "slot", "review"].includes(k)) W("agent.models." + k, "неизвестная роль — не используется")
        else if (typeof v !== "string") E("agent.models." + k, "имя модели — строка (пустая = умолчание рантайма)")
      }
    }
  }

  // tasks — раньше областей и станций: на них ссылаются
  const taskIds = new Set()
  const tasks = raw.tasks === undefined ? {} : raw.tasks
  if (!isObj(tasks)) E("tasks", "ожидается объект { <id задачи>: {…} }")
  else {
    if (!Object.keys(tasks).length) W("tasks", "нет ни одной задачи — станции проверок будут пустыми")
    for (const [id, t] of Object.entries(tasks)) {
      const p = "tasks." + id
      if (!ID_RE.test(id)) { E(p, "id задачи — строчная латиница, цифры и дефис, с буквы"); continue }
      if (!isObj(t)) { E(p, "ожидается объект"); continue }
      taskIds.add(id)
      if (!isStr(t.label)) E(p + ".label", "подпись задачи обязательна")
      optStr(t, p, "group")
      if (!isStr(t.run)) E(p + ".run", "команда запуска обязательна")
      const wantsInput = isStr(t.run) && t.run.includes("{input}")
      if (t.input !== undefined) {
        if (!isObj(t.input) || !isStr(t.input.label)) E(p + ".input", "ожидается { label, placeholder? }")
        else if (isStr(t.run) && !wantsInput) E(p + ".run", "у задачи есть ввод, но в команде нет `{input}`")
      } else if (wantsInput) E(p + ".input", "в команде есть `{input}`, но ввод не описан: добавьте `input: { label }`")
      if (
        t.cwd !== undefined &&
        !(isStr(t.cwd) && !path.isAbsolute(t.cwd) && !/^[A-Za-z]:/.test(t.cwd) && !fwd(t.cwd).split("/").includes(".."))
      )
        E(p + ".cwd", "папка запуска — относительный путь внутри репозитория, без `..`")
      if (t.lane !== undefined && !(isStr(t.lane) && ID_RE.test(t.lane))) E(p + ".lane", "дорожка — строчная латиница, цифры и дефис")
      optBool(t, p, "gate")
      if (t.timeoutMin !== undefined && !(typeof t.timeoutMin === "number" && t.timeoutMin > 0)) E(p + ".timeoutMin", "предел времени — положительное число минут")
      if (t.parser !== undefined) validateParser(t.parser, p + ".parser", E)
    }
  }
  const refTasks = (list, p) => {
    if (list === undefined) return
    if (!isStrList(list)) { E(p, "ожидается список id задач"); return }
    for (const id of list) if (!taskIds.has(id)) E(p, `задачи \`${id}\` нет в \`tasks\``)
  }

  // areas
  const areas = optObj("areas")
  if (areas) for (const [id, a] of Object.entries(areas)) {
    const p = "areas." + id
    if (!ID_RE.test(id)) { E(p, "id области — строчная латиница, цифры и дефис, с буквы"); continue }
    if (!isObj(a)) { E(p, "ожидается объект"); continue }
    optStr(a, p, "title")
    if (!isStrList(a.paths) || !a.paths.length) E(p + ".paths", "у области должен быть хотя бы один путь (например `apps/api/**`)")
    optList(a, p, "denyEdit"); optBool(a, p, "build")
    refTasks(a.tasks, p + ".tasks")
  }

  // deny, protected, slotPrepare
  const deny = optObj("deny")
  if (deny) { for (const k of ["commands", "edit", "read", "ask"]) optList(deny, "deny", k); optBool(deny, "deny", "base") }
  if (raw.protected !== undefined && !isStrList(raw.protected)) E("protected", "ожидается список путей")
  if (raw.slotPrepare !== undefined) {
    if (!Array.isArray(raw.slotPrepare)) E("slotPrepare", "ожидается список шагов { run, when? }")
    else raw.slotPrepare.forEach((s, i) => {
      const p = `slotPrepare[${i}]`
      if (!isObj(s) || !isStr(s.run)) { E(p, "шаг — объект с непустой командой `run`"); return }
      if (s.when !== undefined && !SLOT_PREPARE_WHEN.includes(s.when)) E(p + ".when", "когда выполнять — один из: " + SLOT_PREPARE_WHEN.join(", "))
    })
  }

  // stations
  const stations = optObj("stations")
  if (stations) { refTasks(stations.tests, "stations.tests"); refTasks(stations.guards, "stations.guards") }

  // machines
  const machines = optObj("machines")
  const servedLanes = new Set(); let anyServesAll = !machines || !machines.local || machines.local.lanes === undefined
  if (machines) for (const [id, m] of Object.entries(machines)) {
    const p = "machines." + id
    if (!ID_RE.test(id)) { E(p, "id машины — строчная латиница, цифры и дефис, с буквы"); continue }
    if (!isObj(m)) { E(p, "ожидается объект"); continue }
    optStr(m, p, "label"); optStr(m, p, "ssh"); optStr(m, p, "dir"); optList(m, p, "prepare")
    if (id === "local" && isStr(m.ssh)) E(p + ".ssh", "`local` — эта машина, поля `ssh` у неё нет; удалённой машине дайте другой id")
    if (id !== "local" && !isStr(m.ssh)) E(p + ".ssh", "у удалённой машины обязателен ssh-хост (как в ~/.ssh/config)")
    if (isStr(m.ssh) && !isStr(m.dir)) E(p + ".dir", "у удалённой машины обязательна рабочая папка `dir`")
    if (m.workers !== undefined && !(Number.isInteger(m.workers) && m.workers >= 1)) E(p + ".workers", "число воркеров — целое от 1")
    if (m.lanes !== undefined) {
      if (!isStrList(m.lanes) || !m.lanes.every((l) => ID_RE.test(l))) E(p + ".lanes", "дорожки — список id (строчная латиница, цифры, дефис)")
      else m.lanes.forEach((l) => servedLanes.add(l))
    } else anyServesAll = true
    if (m.services !== undefined) {
      if (!Array.isArray(m.services)) E(p + ".services", "ожидается список служб { name, up, down?, check? }")
      else m.services.forEach((s, i) => { if (!isObj(s) || !isStr(s.name) || !isStr(s.up)) E(`${p}.services[${i}]`, "служба — объект с `name` и командой запуска `up`") })
    }
  }
  if (isObj(tasks) && !anyServesAll) for (const [id, t] of Object.entries(tasks)) {
    const lane = isObj(t) && isStr(t.lane) ? t.lane : "main"
    if (!servedLanes.has(lane)) W("tasks." + id + ".lane", `дорожку \`${lane}\` не обслуживает ни одна машина — задача не запустится`)
  }

  // release, accept, ci
  const release = optObj("release")
  if (release) {
    for (const k of ["stand", "prod"]) if (release[k] !== undefined && !isObj(release[k])) E("release." + k, "ожидается объект")
    if (isObj(release.stand)) { optStr(release.stand, "release.stand", "run"); optStr(release.stand, "release.stand", "url") }
    if (isObj(release.prod)) {
      optStr(release.prod, "release.prod", "run"); optStr(release.prod, "release.prod", "verify"); optBool(release.prod, "release.prod", "pushDeploys")
      if (isObj(raw.repo) && isObj(raw.repo.upstream) && raw.repo.upstream.main == null) E("release.prod", "выкат прода описан, а прод-ветки нет: задайте `repo.upstream.main`")
    }
  }
  const accept = optObj("accept")
  if (accept) for (const k of ["run", "specGlob", "standUrl"]) optStr(accept, "accept", k)
  const ci = optObj("ci")
  if (ci) { optStr(ci, "ci", "kind"); optStr(ci, "ci", "runners"); optList(ci, "ci", "files") }

  // modules, limits
  const modules = optObj("modules")
  if (modules) for (const [id, v] of Object.entries(modules)) {
    if (!MODULE_IDS.includes(id)) E("modules." + id, "такого модуля нет; известные: " + MODULE_IDS.join(", "))
    else if (typeof v !== "boolean") E("modules." + id, "ожидается true или false")
  }
  const limits = optObj("limits")
  if (limits && limits.slots !== undefined && !(Number.isInteger(limits.slots) && limits.slots >= 1 && limits.slots <= 20)) E("limits.slots", "число параллельных слотов — целое от 1 до 20")

  return { errors, warnings }
}

function validateParser(parser, p, E) {
  if (typeof parser === "string") { if (!PARSERS.includes(parser)) E(p, "заготовка разбора — одна из: " + PARSERS.join(", ") + "; либо объект { pass, fail, totals, names }"); return }
  if (!isObj(parser)) { E(p, "ожидается имя заготовки или объект { pass, fail, totals, names }"); return }
  const known = ["pass", "fail", "totals", "names"]
  for (const k of Object.keys(parser)) if (!known.includes(k)) E(p + "." + k, "неизвестный ключ; допустимы: " + known.join(", "))
  if (!known.slice(0, 3).some((k) => isStr(parser[k]))) E(p, "нужна хотя бы одна из регулярок `pass`, `fail`, `totals`")
  for (const k of known) {
    if (parser[k] === undefined) continue
    if (!isStr(parser[k])) { E(p + "." + k, "регулярка — непустая строка"); continue }
    let re; try { re = new RegExp(parser[k]) } catch (e) { E(p + "." + k, "регулярка не разбирается: " + e.message); continue }
    if ((k === "pass" || k === "fail") && captureGroups(re) < 1) E(p + "." + k, "в регулярке нужна одна группа в скобках — имя спеки")
  }
}

// ───────────────────────────── нормализация ─────────────────────────────

const DEFAULT_MODELS = {
  claude: { orch: "claude-opus-5-5", slot: "claude-sonnet-5-5", review: "claude-sonnet-5-5" },
  codex: { orch: "", slot: "", review: "" }, // пусто — рантайм берёт свою модель по умолчанию
}

/**
 * Привести проверенный конфиг к полному виду: умолчания проставлены, пути абсолютные.
 * Звать только после validateProject без ошибок.
 */
export function normalizeProject(raw, { baseDir = HOME, file = "", cpus = os.cpus().length } = {}) {
  const r = raw.repo
  const main = expandPath(r.main, baseDir)
  const worktrees = r.worktrees ? expandPath(r.worktrees, baseDir) : fwd(path.join(path.dirname(main), path.basename(main) + "-wt"))
  const data = r.data ? expandPath(r.data, baseDir) : fwd(path.join(worktrees, "_dashboard"))
  const runtime = (raw.agent && raw.agent.runtime) || "claude"

  const tasks = {}
  for (const [id, t] of Object.entries(raw.tasks || {})) {
    tasks[id] = {
      id, label: t.label, group: t.group || "Проверки", run: t.run,
      input: t.input ? { label: t.input.label, placeholder: t.input.placeholder || "" } : null,
      cwd: t.cwd ? fwd(t.cwd).replace(/\/+$/, "") : "", lane: t.lane || "main",
      parser: t.parser || "exit-code", gate: !!t.gate, timeoutMin: t.timeoutMin || 30,
    }
  }
  const areas = {}
  for (const [id, a] of Object.entries(raw.areas || {})) {
    areas[id] = { id, title: a.title || id, paths: a.paths.map(fwd), denyEdit: (a.denyEdit || []).map(fwd), build: !!a.build, tasks: a.tasks || [] }
  }
  const d = raw.deny || {}, base = d.base === false ? { commands: [], ask: [], read: [], edit: [] } : BASE_DENY
  const merge = (k) => [...new Set([...base[k], ...(d[k] || [])])]
  const gateIds = Object.values(tasks).filter((t) => t.gate).map((t) => t.id)
  const st = raw.stations || {}

  const machines = {}
  const rawMachines = raw.machines || {}
  const mk = (id, m) => ({
    id, label: m.label || (id === "local" ? "Эта машина" : id), ssh: m.ssh || "", dir: m.dir ? fwd(m.dir) : "",
    workers: m.workers || (id === "local" ? Math.max(1, Math.floor(cpus / 2)) : 1),
    lanes: m.lanes || null, // null — машина берёт любую дорожку
    prepare: m.prepare || [], services: (m.services || []).map((s) => ({ name: s.name, up: s.up, down: s.down || "", check: s.check || "" })),
  })
  machines.local = mk("local", rawMachines.local || {})
  for (const [id, m] of Object.entries(rawMachines)) if (id !== "local") machines[id] = mk(id, m)

  const rel = raw.release || {}
  return {
    schema: raw.schema, name: raw.name || path.basename(main), file: file ? fwd(file) : "",
    repo: { main, worktrees, data, sparse: !!r.sparse, remote: r.remote || "origin", upstream: { staging: r.upstream.staging, main: r.upstream.main || null } },
    agent: {
      runtime, bin: agentBinPath(raw.agent && raw.agent.bin, baseDir), proxy: (raw.agent && raw.agent.proxy) || "", network: !!(raw.agent && raw.agent.network),
      models: { ...DEFAULT_MODELS[runtime], ...((raw.agent && raw.agent.models) || {}) },
    },
    areas, tasks,
    deny: { commands: merge("commands"), edit: merge("edit").map(fwd), read: merge("read").map(fwd), ask: merge("ask") },
    protected: (raw.protected || []).map(fwd),
    slotPrepare: (raw.slotPrepare || []).map((s) => ({ run: s.run, when: s.when || "always" })),
    stations: {
      tests: st.tests || Object.keys(tasks).filter((id) => !gateIds.includes(id)),
      guards: st.guards || gateIds,
    },
    machines,
    release: {
      stand: { run: (rel.stand && rel.stand.run) || "", url: (rel.stand && rel.stand.url) || "" },
      prod: { run: (rel.prod && rel.prod.run) || "", verify: (rel.prod && rel.prod.verify) || "", pushDeploys: !!(rel.prod && rel.prod.pushDeploys) },
    },
    accept: { run: (raw.accept && raw.accept.run) || "", specGlob: (raw.accept && raw.accept.specGlob) || "", standUrl: (raw.accept && raw.accept.standUrl) || "" },
    ci: { kind: (raw.ci && raw.ci.kind) || "", runners: (raw.ci && raw.ci.runners) || "", files: (raw.ci && raw.ci.files) || [] },
    modules: { ...(raw.modules || {}) },
    limits: { slots: (raw.limits && raw.limits.slots) || 3 },
  }
}

// ───────────────────────────── чтение ─────────────────────────────

/** Список замечаний одной строкой на каждое — для печати и для текста исключения. */
export const formatIssues = (issues) => issues.map((i) => "  • " + (i.path ? "`" + i.path + "`: " : "") + i.message).join("\n")

const cache = new Map()

/**
 * Прочитать, проверить и нормализовать конфиг проекта.
 * @throws {ProjectConfigError} файла нет (`missing`), он не JSON (`json`) или не прошёл проверку (`invalid`)
 */
export function loadProject({ file = projectFile(), fresh = false } = {}) {
  const abs = path.resolve(file)
  if (!fresh && cache.has(abs)) return cache.get(abs)
  let text
  try { text = fs.readFileSync(abs, "utf8") } catch {
    throw new ProjectConfigError(
      `Проект не настроен: нет файла ${fwd(abs)}.\nОткройте папку диспетчерской в агенте — он проведёт настройку по SETUP.md, — или запустите \`node setup.mjs detect --repo <путь к проекту>\`.`,
      { code: "missing", file: abs },
    )
  }
  let raw
  try { raw = JSON.parse(text.replace(/^\uFEFF/, "")) } catch (e) {
    throw new ProjectConfigError(`Конфиг проекта ${fwd(abs)} не читается как JSON: ${e.message}`, { code: "json", file: abs })
  }
  const { errors, warnings } = validateProject(raw)
  if (errors.length)
    throw new ProjectConfigError(
      `В конфиге проекта ${fwd(abs)} ошибки:\n${formatIssues(errors)}\nПроверка целиком — \`node setup.mjs doctor\`.`,
      { code: "invalid", issues: errors, file: abs },
    )
  const project = normalizeProject(raw, { baseDir: path.dirname(abs), file: abs })
  project.warnings = warnings
  cache.set(abs, project)
  return project
}

/** Сбросить кеш (тесты; настройка после перезаписи файла). */
export const forgetProject = () => cache.clear()

/**
 * Код-надстройка проекта: dispatcher.project.mjs рядом с конфигом. Необязательна.
 * Экспортирует только функции из CODE_HOOKS — то, что не выразить данными (сборка по диффу, особая подготовка слота).
 * @returns {Promise<{hooks:Record<string,Function>, warnings:string[]}>}
 */
export async function loadProjectCode({ file = projectFile() } = {}) {
  const codeFile = path.join(path.dirname(path.resolve(file)), "dispatcher.project.mjs")
  if (!fs.existsSync(codeFile)) return { hooks: {}, warnings: [] }
  const mod = await import(pathToFileURL(codeFile).href)
  const hooks = {}, warnings = []
  for (const [name, value] of Object.entries(mod)) {
    if (name === "default") continue
    if (!CODE_HOOKS.includes(name)) { warnings.push(`dispatcher.project.mjs: экспорт \`${name}\` не используется; допустимы: ${CODE_HOOKS.join(", ")}`); continue }
    if (typeof value !== "function") throw new ProjectConfigError(`dispatcher.project.mjs: \`${name}\` должен быть функцией`, { code: "invalid", file: codeFile })
    hooks[name] = value
  }
  return { hooks, warnings }
}
