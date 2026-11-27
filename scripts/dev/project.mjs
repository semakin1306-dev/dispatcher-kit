// project.mjs — единый загрузчик конфига проекта (dispatcher.project.json).
//
// Всё, что диспетчерская знает о ЧУЖОМ проекте — где он лежит, какие в нём области, чем он проверяется, на каких машинах,
// как выкатывается, — приходит отсюда. В коде ядра нет ни путей, ни команд, ни имён конкретного проекта.
// Файл пишет стартовая настройка (`node setup.mjs apply`); руками его править можно, проверка — `node setup.mjs doctor`.
//
// Три шага: validateProject (сырой JSON → ошибки и предупреждения человеческим языком) → normalizeProject (умолчания,
// абсолютные пути) → loadProject (чтение с диска, кеш). Проверка не бросает исключений: настройке нужен полный список
// ошибок разом, а не первая.
//
// Дом (dispatcher.home.json, необязателен) — несколько проектов на одной диспетчерской: общее (агент по умолчанию, машины,
// общий предел агентов, порт хаба) и список проектов-ссылок на конфиги того же формата. Знает о доме только этот файл:
// конфиг проекта из дома загружается уже с общим, ядро сервера получает обычный нормализованный проект.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { MODULE_IDS } from "./modules-catalog.mjs"
import { canonPath, insidePath, samePath } from "./paths.mjs"

/** Дом диспетчерской — её собственный репозиторий. */
export const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
export const SCHEMA = 1
export const RUNTIMES = ["claude", "codex"]
/** Заготовки разбора вывода задачи. `exit-code` — только код возврата, без имён спек. */
export const PARSERS = ["exit-code", "jest", "vitest", "go-test", "pytest"]
/** Функции, которые проект может дать кодом в dispatcher.project.mjs. Список закрытый. */
export const CODE_HOOKS = ["buildSteps", "slotPrepare", "remoteCmd", "parseOutput"]
export const SLOT_PREPARE_WHEN = ["always", "build"]
/** Режим проекта. `light` — маленький репозиторий без поездов, стенда и прода; в разработке, пока ведётся как `full`. */
export const PROJECT_MODES = ["full", "light"]

export const ID_RE = /^[a-z][a-z0-9-]{0,39}$/
const REMOTE_RE = /^[A-Za-z0-9._-]+$/
const TOP_KEYS = ["schema", "name", "mode", "repo", "agent", "areas", "deny", "protected", "slotPrepare", "tasks", "stations", "machines", "release", "accept", "ci", "modules", "limits"]

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
 * Где лежит конфиг: переменная DISPATCHER_PROJECT; под `node --test` без неё — демо-проект (тесты диспетчерской не
 * читают конфиг настоящего проекта и не могут задеть его папки); есть дом — проект дома (homeEntryFor); иначе
 * dispatcher.project.json рядом с файлом дома, то есть в папке диспетчерской.
 */
export function projectFile(env = process.env, { cwd = process.cwd() } = {}) {
  if (env.DISPATCHER_PROJECT) return path.resolve(env.DISPATCHER_PROJECT)
  if (env.NODE_TEST_CONTEXT) return DEMO_PROJECT
  const entry = homeEntryFor(env, { cwd })
  return entry ? entry.file : legacyProjectFile(env)
}

/** Конфиг единственного проекта (установка без дома): dispatcher.project.json в папке файла дома. */
export const legacyProjectFile = (env = process.env) => path.join(homeDir(env), "dispatcher.project.json")

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

  validateSchema(raw, E)

  for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) W(k, "неизвестный ключ — не используется")
  if (raw.name !== undefined && !isStr(raw.name)) E("name", "название проекта — непустая строка")
  if (raw.mode !== undefined) {
    if (!PROJECT_MODES.includes(raw.mode)) E("mode", "режим проекта — один из: " + PROJECT_MODES.join(", "))
    else if (raw.mode === "light") W("mode", "лёгкий режим в разработке: пока проект ведётся как полный")
  }

  const optObj = (key) => { const v = raw[key]; if (v === undefined) return null; if (!isObj(v)) { E(key, "ожидается объект"); return null } return v }
  const { optStr, optList, optBool } = checkers(E)

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
  if (agent) validateAgent(agent, "agent", E, W)

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
      // «неприменимо»: признак в логе (naLog) и каталог существующих имён (naList, группа 1) — см. dashboard/na-rules.mjs
      for (const k of ["naLog", "naList"])
        if (t[k] !== undefined) {
          let ok = isStr(t[k]) && t[k].length > 0
          if (ok) try { new RegExp(t[k]) } catch { ok = false }
          if (!ok) E(p + "." + k, "ожидается непустой регэксп (строка)")
        }
      if (t.naList !== undefined && t.naLog === undefined) E(p + ".naList", "naList работает только вместе с naLog")
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
  const { servedLanes, anyServesAll } = validateMachines(machines, "machines", E)
  if (isObj(tasks) && !anyServesAll) for (const [id, t] of Object.entries(tasks)) {
    const lane = isObj(t) && isStr(t.lane) ? t.lane : "main"
    if (!servedLanes.has(lane)) W("tasks." + id + ".lane", `дорожку \`${lane}\` не обслуживает ни одна машина — задача не запустится`)
  }

  // release, accept, ci
  const release = optObj("release")
  if (release) {
    for (const k of ["stand", "prod"]) if (release[k] !== undefined && !isObj(release[k])) E("release." + k, "ожидается объект")
    if (isObj(release.stand)) {
      optStr(release.stand, "release.stand", "run"); optStr(release.stand, "release.stand", "url")
      // этапы экрана выката по меткам вывода команды выката: [[id, подпись, регулярка-строка], …]
      const sg = release.stand.stages
      if (sg !== undefined) {
        if (!Array.isArray(sg)) E("release.stand.stages", "ожидается массив [id, подпись, регулярка]")
        else {
          const seen = new Set()
          sg.forEach((x, i) => {
            const at = "release.stand.stages[" + i + "]"
            if (!Array.isArray(x) || x.length !== 3 || !x.every(isStr)) return E(at, "ожидается [id, подпись, регулярка] — три строки")
            if (!/^[a-z][\w-]*$/i.test(x[0])) E(at, "id этапа — латиница/цифры/-/_")
            else if (x[0] === "push") E(at, "id `push` занят: пуш staging делает сама диспетчерская до команды выката")
            else if (seen.has(x[0])) E(at, "id `" + x[0] + "` повторяется")
            seen.add(x[0])
            try { new RegExp(x[2]) } catch (e) { E(at, "неверная регулярка: " + e.message) }
          })
        }
      }
    }
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
  if (limits) validateLimits(limits, "limits", E)

  return { errors, warnings }
}

// Проверки, общие для конфига проекта и раздела `shared` дома: одинаковые ключи — одинаковые правила и тексты.

function validateSchema(raw, E, what = "конфиг") {
  if (raw.schema === undefined) E("schema", "нет номера схемы — ожидается `\"schema\": " + SCHEMA + "`")
  else if (!Number.isInteger(raw.schema)) E("schema", "номер схемы — целое число")
  else if (raw.schema > SCHEMA) E("schema", `${what} новее диспетчерской (схема ${raw.schema}, диспетчерская понимает ${SCHEMA}) — обновите диспетчерскую`)
  else if (raw.schema < 1) E("schema", "номер схемы начинается с 1")
}

const checkers = (E) => ({
  optStr: (obj, p, key) => { if (obj[key] !== undefined && obj[key] !== "" && !isStr(obj[key])) E(p + "." + key, "ожидается строка") },
  optList: (obj, p, key) => { if (obj[key] !== undefined && !isStrList(obj[key])) E(p + "." + key, "ожидается список непустых строк") },
  optBool: (obj, p, key) => { if (obj[key] !== undefined && typeof obj[key] !== "boolean") E(p + "." + key, "ожидается true или false") },
})

function validateAgent(agent, p, E, W) {
  const { optStr, optBool } = checkers(E)
  if (agent.runtime !== undefined && !RUNTIMES.includes(agent.runtime)) E(p + ".runtime", "рантайм агента — один из: " + RUNTIMES.join(", "))
  optStr(agent, p, "bin"); optStr(agent, p, "proxy"); optBool(agent, p, "network")
  if (agent.models !== undefined) {
    if (!isObj(agent.models)) E(p + ".models", "ожидается объект { orch, slot, review }")
    else for (const [k, v] of Object.entries(agent.models)) {
      if (!["orch", "slot", "review"].includes(k)) W(p + ".models." + k, "неизвестная роль — не используется")
      else if (typeof v !== "string") E(p + ".models." + k, "имя модели — строка (пустая = умолчание рантайма)")
    }
  }
}

/** → { servedLanes, anyServesAll }: какие дорожки обслуживают машины (для предупреждения о задачах без машины). */
function validateMachines(machines, p0, E) {
  const { optStr, optList } = checkers(E)
  const servedLanes = new Set(); let anyServesAll = !machines || !machines.local || machines.local.lanes === undefined
  if (machines) for (const [id, m] of Object.entries(machines)) {
    const p = p0 + "." + id
    if (!ID_RE.test(id)) { E(p, "id машины — строчная латиница, цифры и дефис, с буквы"); continue }
    if (!isObj(m)) { E(p, "ожидается объект"); continue }
    optStr(m, p, "label"); optStr(m, p, "ssh"); optStr(m, p, "dir"); optList(m, p, "prepare")
    if (id === "local" && isStr(m.ssh)) E(p + ".ssh", "`local` — эта машина, поля `ssh` у неё нет; удалённой машине дайте другой id")
    if (id !== "local" && !isStr(m.ssh)) E(p + ".ssh", "у удалённой машины обязателен ssh-хост (как в ~/.ssh/config)")
    if (isStr(m.ssh) && !isStr(m.dir)) E(p + ".dir", "у удалённой машины обязательна рабочая папка `dir`")
    if (m.workers !== undefined && !(Number.isInteger(m.workers) && m.workers >= 1)) E(p + ".workers", "число воркеров — целое от 1")
    if (m.prefer !== undefined && typeof m.prefer !== "boolean") E(p + ".prefer", "prefer — true/false (машина первой в очереди мест)")
    if (m.laneMax !== undefined && !(isObj(m.laneMax) && Object.entries(m.laneMax).every(([k, v]) => ID_RE.test(k) && Number.isInteger(v) && v >= 1)))
      E(p + ".laneMax", "laneMax — объект { <дорожка>: целое от 1 }")
    if (m.lanes !== undefined) {
      if (!isStrList(m.lanes) || !m.lanes.every((l) => ID_RE.test(l))) E(p + ".lanes", "дорожки — список id (строчная латиница, цифры, дефис)")
      else m.lanes.forEach((l) => servedLanes.add(l))
    } else anyServesAll = true
    if (m.services !== undefined) {
      if (!Array.isArray(m.services)) E(p + ".services", "ожидается список служб { name, up, down?, check? }")
      else m.services.forEach((s, i) => { if (!isObj(s) || !isStr(s.name) || !isStr(s.up)) E(`${p}.services[${i}]`, "служба — объект с `name` и командой запуска `up`") })
    }
  }
  return { servedLanes, anyServesAll }
}

function validateLimits(limits, p, E) {
  if (limits.slots !== undefined && !(Number.isInteger(limits.slots) && limits.slots >= 1 && limits.slots <= 20))
    E(p + ".slots", "число параллельно работающих агентов слотов — целое от 1 до 20")
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
      naLog: t.naLog || "", naList: t.naList || "",
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
    // prefer — машина в очереди мест первой и без ожидания (по умолчанию эта машина последняя: SPILL_MS);
    // laneMax — потолок одновременных прогонов дорожки на машине ({ "db": 4 }), сверх него места дорожке не даются.
    prefer: m.prefer === true, laneMax: isObj(m.laneMax) ? { ...m.laneMax } : null,
  })
  machines.local = mk("local", rawMachines.local || {})
  for (const [id, m] of Object.entries(rawMachines)) if (id !== "local") machines[id] = mk(id, m)

  const rel = raw.release || {}
  return {
    schema: raw.schema, name: raw.name || path.basename(main), file: file ? fwd(file) : "", mode: raw.mode || "full",
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
      stand: {
        run: (rel.stand && rel.stand.run) || "", url: (rel.stand && rel.stand.url) || "",
        stages: (rel.stand && Array.isArray(rel.stand.stages) ? rel.stand.stages : []).map((x) => [x[0], x[1], x[2]]),
      },
      prod: { run: (rel.prod && rel.prod.run) || "", verify: (rel.prod && rel.prod.verify) || "", pushDeploys: !!(rel.prod && rel.prod.pushDeploys) },
    },
    accept: { run: (raw.accept && raw.accept.run) || "", specGlob: (raw.accept && raw.accept.specGlob) || "", standUrl: (raw.accept && raw.accept.standUrl) || "" },
    ci: { kind: (raw.ci && raw.ci.kind) || "", runners: (raw.ci && raw.ci.runners) || "", files: (raw.ci && raw.ci.files) || [] },
    modules: { ...(raw.modules || {}) },
    // shared — общий предел нескольких проектов дома (места-файлы в папке хаба); без дома null
    limits: { slots: (raw.limits && raw.limits.slots) || 3, shared: null },
  }
}

// ───────────────────────────── чтение ─────────────────────────────

/** Список замечаний одной строкой на каждое — для печати и для текста исключения. */
export const formatIssues = (issues) => issues.map((i) => "  • " + (i.path ? "`" + i.path + "`: " : "") + i.message).join("\n")

const cache = new Map()

/**
 * Прочитать, проверить и нормализовать конфиг проекта. Конфиг, на который ссылается дом, получает общее из дома
 * (withHomeShared) и общий предел агентов `limits.shared`.
 * @throws {ProjectConfigError} файла нет (`missing`), он не JSON (`json`), не прошёл проверку (`invalid`) или сломан дом (`home`)
 */
export function loadProject({ file = projectFile(), fresh = false, env = process.env } = {}) {
  const abs = path.resolve(file), hf = homeFile(env), key = abs + "\n" + hf
  if (!fresh && cache.has(key)) return cache.get(key)
  const raw = readJsonConfig(abs, "Конфиг проекта", () =>
    `Проект не настроен: нет файла ${fwd(abs)}.\nОткройте папку диспетчерской в агенте — он проведёт настройку по SETUP.md, — или запустите \`node setup.mjs detect --repo <путь к проекту>\`.`)
  const { errors, warnings } = validateProject(raw)
  if (errors.length)
    throw new ProjectConfigError(
      `В конфиге проекта ${fwd(abs)} ошибки:\n${formatIssues(errors)}\nПроверка целиком — \`node setup.mjs doctor\`.`,
      { code: "invalid", issues: errors, file: abs },
    )
  const home = hf && fs.existsSync(hf) ? loadHome({ file: hf }) : null
  const entry = home ? homeEntryOf(home, abs) : null
  const project = normalizeProject(entry ? withHomeShared(raw, home, entry) : raw, { baseDir: path.dirname(abs), file: abs })
  if (entry && home.shared.limits.slots) project.limits.shared = { slots: home.shared.limits.slots, dir: fwd(path.join(home.hub.data, "places")) }
  project.warnings = warnings
  cache.set(key, project)
  return project
}

/** Прочитать JSON конфига: нет файла — `missing` с текстом missingText(), не JSON — `json`. */
function readJsonConfig(abs, what, missingText) {
  let text
  try { text = fs.readFileSync(abs, "utf8") } catch { throw new ProjectConfigError(missingText(), { code: "missing", file: abs }) }
  let raw
  try { raw = JSON.parse(text.replace(/^\uFEFF/, "")) } catch (e) {
    throw new ProjectConfigError(`${what} ${fwd(abs)} не читается как JSON: ${e.message}`, { code: "json", file: abs })
  }
  return raw
}

/** Сбросить кеш (тесты; настройка после перезаписи файла). */
export const forgetProject = () => { cache.clear(); homeCache.clear() }

// ───────────────────────────── дом: несколько проектов ─────────────────────────────
//
// dispatcher.home.json: { schema, hub: { port, data, idleStopMin }, shared: { agent, machines, limits },
// projects: [{ id, file, port, start }] }. Проекты — списком, а не объектом по id: повтор ключа в объекте JSON молча
// теряется при разборе, а в списке его видно и о нём можно сказать. Относительные пути — от папки файла дома.

export const HOME_FILE_NAME = "dispatcher.home.json"
/** Порт хаба по умолчанию — прежний порт страницы: для человека адрес не меняется. */
export const HUB_PORT = 4777
/** Первый порт, который `setup add` предлагает процессу проекта. */
export const CORE_PORT_FROM = 4801
/** Когда хаб поднимает процесс проекта: always — при своём запуске; lazy — по первому запросу, без дел — останавливает. */
export const HOME_START = ["always", "lazy"]
const HOME_KEYS = ["schema", "hub", "shared", "projects"]
const SHARED_KEYS = ["agent", "machines", "limits"]

/**
 * Файл дома: DISPATCHER_HOME, иначе dispatcher.home.json в папке диспетчерской. Под `node --test` без переменной дома
 * нет — тесты не видят дом владельца, как не видят и его конфиг проекта. Пустая строка — дома нет.
 */
export function homeFile(env = process.env) {
  if (env.DISPATCHER_HOME) return path.resolve(env.DISPATCHER_HOME)
  if (env.NODE_TEST_CONTEXT) return ""
  return path.join(HOME, HOME_FILE_NAME)
}
export const homeDir = (env = process.env) => { const f = homeFile(env); return f ? path.dirname(f) : HOME }
/** Есть ли дом: только тогда команды и проверка работают с несколькими проектами. */
export const homeExists = (env = process.env) => { const f = homeFile(env); return !!f && fs.existsSync(f) }

const isPort = (v) => Number.isInteger(v) && v >= 1024 && v <= 65535

/**
 * Проверить сырой файл дома. Пути проектов сверяются после разрешения от baseDir: `./a/x.json` и `a/x.json` — один файл.
 * @returns {{errors:{path:string,message:string}[], warnings:{path:string,message:string}[]}}
 */
export function validateHome(raw, { baseDir = HOME } = {}) {
  const errors = [], warnings = []
  const E = (p, message) => errors.push({ path: p, message })
  const W = (p, message) => warnings.push({ path: p, message })
  if (!isObj(raw)) { E("", "файл дома должен быть объектом JSON"); return { errors, warnings } }
  validateSchema(raw, E, "файл дома")
  for (const k of Object.keys(raw)) if (!HOME_KEYS.includes(k)) W(k, "неизвестный ключ — не используется; допустимы: " + HOME_KEYS.join(", "))
  const { optStr } = checkers(E)

  let hubPort = HUB_PORT
  if (raw.hub !== undefined) {
    if (!isObj(raw.hub)) E("hub", "ожидается объект { port, data, idleStopMin }")
    else {
      if (raw.hub.port !== undefined) { if (isPort(raw.hub.port)) hubPort = raw.hub.port; else E("hub.port", "порт хаба — целое от 1024 до 65535") }
      optStr(raw.hub, "hub", "data")
      if (raw.hub.idleStopMin !== undefined && !(typeof raw.hub.idleStopMin === "number" && raw.hub.idleStopMin > 0))
        E("hub.idleStopMin", "через сколько минут без дел останавливать проект с `start: \"lazy\"` — положительное число")
    }
  }

  if (raw.shared !== undefined) {
    const s = raw.shared
    if (!isObj(s)) E("shared", "ожидается объект { agent, machines, limits }")
    else {
      for (const k of Object.keys(s)) if (!SHARED_KEYS.includes(k)) W("shared." + k, "неизвестный ключ — не используется; общее в доме: " + SHARED_KEYS.join(", "))
      for (const k of SHARED_KEYS) if (s[k] !== undefined && !isObj(s[k])) E("shared." + k, "ожидается объект")
      if (isObj(s.agent)) validateAgent(s.agent, "shared.agent", E, W)
      if (isObj(s.machines)) validateMachines(s.machines, "shared.machines", E)
      if (isObj(s.limits)) validateLimits(s.limits, "shared.limits", E)
    }
  }

  if (!Array.isArray(raw.projects) || !raw.projects.length) {
    E("projects", "нужен список проектов [{ id, file, port }] — хотя бы один")
    return { errors, warnings }
  }
  const seen = { id: new Map(), port: new Map([[hubPort, "`hub.port`"]]), file: new Map() }
  const once = (kind, value, p, what) => {
    if (seen[kind].has(value)) E(p, `${what} уже занят: ${seen[kind].get(value)}`)
    else seen[kind].set(value, "`" + p + "`")
  }
  raw.projects.forEach((e, i) => {
    const p = `projects[${i}]`
    if (!isObj(e)) { E(p, "проект — объект { id, file, port, start? }"); return }
    for (const k of Object.keys(e)) if (!["id", "file", "port", "start"].includes(k)) W(p + "." + k, "неизвестный ключ — не используется")
    if (!isStr(e.id) || !ID_RE.test(e.id)) E(p + ".id", "id проекта — строчная латиница, цифры и дефис, с буквы")
    else once("id", e.id, p + ".id", "id `" + e.id + "`")
    if (!isStr(e.file)) E(p + ".file", "путь к конфигу проекта (dispatcher.project.json) обязателен")
    else once("file", canonPath(expandPath(e.file, baseDir)), p + ".file", "этот конфиг")
    if (!isPort(e.port)) E(p + ".port", "порт процесса проекта — целое от 1024 до 65535")
    else once("port", e.port, p + ".port", "порт " + e.port)
    if (e.start !== undefined && !HOME_START.includes(e.start)) E(p + ".start", "когда запускать — один из: " + HOME_START.join(", "))
  })
  return { errors, warnings }
}

/** Привести проверенный дом к полному виду: пути абсолютные, умолчания проставлены. Звать после validateHome без ошибок. */
export function normalizeHome(raw, { file }) {
  const dir = path.dirname(path.resolve(file)), hub = raw.hub || {}, s = raw.shared || {}
  const agent = { ...(s.agent || {}) }
  // путь к агенту в доме — от папки дома: в конфиге проекта он разрешался бы от папки проекта
  if (agent.bin) agent.bin = agentBinPath(agent.bin, dir)
  return {
    schema: raw.schema, file: fwd(path.resolve(file)), dir: fwd(dir),
    hub: { port: hub.port || HUB_PORT, data: expandPath(hub.data || ".hub", dir), idleStopMin: hub.idleStopMin || 30 },
    shared: { agent, machines: { ...(s.machines || {}) }, limits: { slots: (s.limits && s.limits.slots) || null } },
    projects: raw.projects.map((e) => ({ id: e.id, file: expandPath(e.file, dir), port: e.port, start: e.start || "always" })),
  }
}

const homeCache = new Map()

/**
 * Прочитать, проверить и нормализовать дом. Кеш — по времени изменения файла: `setup add` дописывает дом, и
 * следующее чтение в том же процессе видит новый проект без явного сброса.
 * @throws {ProjectConfigError} code `missing` | `json` | `home`
 */
export function loadHome({ file = homeFile() } = {}) {
  const abs = path.resolve(file)
  let mtime = -1
  try { mtime = fs.statSync(abs).mtimeMs } catch { /* нет файла — скажет чтение ниже */ }
  const hit = homeCache.get(abs)
  if (hit && hit.mtime === mtime) return hit.home
  const raw = readJsonConfig(abs, "Файл дома", () => `Дома нет: нет файла ${fwd(abs)}. Второй проект добавляет \`node setup.mjs add --repo <путь>\`.`)
  const { errors, warnings } = validateHome(raw, { baseDir: path.dirname(abs) })
  if (errors.length)
    throw new ProjectConfigError(`В файле дома ${fwd(abs)} ошибки:\n${formatIssues(errors)}\nПроверка целиком — \`node setup.mjs doctor\`.`, { code: "home", issues: errors, file: abs })
  const home = normalizeHome(raw, { file: abs })
  home.warnings = warnings
  homeCache.set(abs, { mtime, home })
  return home
}

/** Запись проекта дома, чей конфиг — этот файл; null — файл в дом не входит. */
export const homeEntryOf = (home, file) => home.projects.find((e) => samePath(e.file, file)) || null

/**
 * Какой проект дома выбран: DISPATCHER_PROJECT_ID (его ставит `--project <id>` команд через select-project.mjs), иначе
 * проект, в чьей основной папке или папке слотов стоит cwd, иначе единственный. Дома нет — null.
 * @throws {ProjectConfigError} `unknown-project` — нет такого id; `ambiguous` — проектов несколько, выбрать не по чему
 */
export function homeEntryFor(env = process.env, { cwd = process.cwd() } = {}) {
  if (!homeExists(env)) return null
  const home = loadHome({ file: homeFile(env) }), ids = home.projects.map((e) => e.id)
  const want = String(env.DISPATCHER_PROJECT_ID || "").trim()
  if (want) {
    const e = home.projects.find((x) => x.id === want)
    if (!e) throw new ProjectConfigError(`В доме ${home.file} нет проекта \`${want}\`; есть: ${ids.join(", ")}.`, { code: "unknown-project", file: home.file })
    return e
  }
  let best = null, bestLen = -1
  for (const e of home.projects) {
    let p
    try { p = loadProject({ file: e.file, env }) } catch { continue } // сломанный конфиг по папке не выбрать — его покажет doctor
    for (const root of [p.repo.main, p.repo.worktrees]) {
      const len = canonPath(root).length
      if (len > bestLen && insidePath(cwd, root)) { best = e; bestLen = len }
    }
  }
  if (best) return best
  if (home.projects.length === 1) return home.projects[0]
  throw new ProjectConfigError(
    `В доме ${home.file} несколько проектов: ${ids.join(", ")}. Укажите проект: \`--project <id>\` в команде или переменная DISPATCHER_PROJECT_ID.`,
    { code: "ambiguous", issues: ids.map((id) => ({ path: id, message: "проект дома" })), file: home.file },
  )
}

/**
 * Сырой конфиг проекта с общим из дома. Агент: ключи проекта перекрывают общие, модели — по ролям. Машины: общие плюс
 * свои; удалённой общей машине папка `dir` достаётся с окончанием `/<id проекта>` — иначе два проекта делили бы один
 * клон на машине, и уборка папок прогонов одного (ключи слотов `wv0001-…` в проектах совпадают) снесла бы папки другого.
 * Свой предел `limits.slots` проекта, если не задан, — общий.
 */
export function withHomeShared(raw, home, entry) {
  const sh = home.shared, out = { ...raw }
  if (Object.keys(sh.agent).length) {
    const pa = raw.agent || {}, models = { ...(sh.agent.models || {}), ...(pa.models || {}) }
    out.agent = { ...sh.agent, ...pa, ...(Object.keys(models).length ? { models } : {}) }
  }
  const machines = {}
  for (const [id, m] of Object.entries(sh.machines)) machines[id] = m.ssh ? { ...m, dir: fwd(m.dir).replace(/\/+$/, "") + "/" + entry.id } : { ...m }
  for (const [id, m] of Object.entries(raw.machines || {})) machines[id] = { ...(machines[id] || {}), ...m }
  if (Object.keys(machines).length) out.machines = machines
  const slots = (raw.limits && raw.limits.slots) || sh.limits.slots
  if (slots) out.limits = { ...(raw.limits || {}), slots }
  return out
}

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
