// cores.mjs — процессы проектов дома. Процесс проекта («ядро») — обычный сервер диспетчерской
// (scripts/dev/dashboard/server.mjs) со своим окружением: DISPATCHER_PROJECT — его конфиг, DASH_PORT — его порт из дома,
// DASH_DATA — его папка данных. Ядро о доме не знает: для него это обычный запуск с переменными, как у пробного экземпляра.
//
// Здесь: запуск и проверка готовности (ядро отвечает /api/summary своим pid), токен страницы ядра (хаб подставляет его в
// пересылаемые изменения), перезапуск при падении с растущими паузами, остановка деревом процессов на любой ОС
// (Windows — taskkill /T, Linux и macOS — proc-tree.mjs), ядро, оставшееся от прошлого хаба на том же порту, — снимается.
// Проект с `start: "lazy"` поднимается по первому запросу и останавливается, когда без дел дольше `hub.idleStopMin`.
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadProject } from "../project.mjs"
import { samePath } from "../paths.mjs"
import { killPosixTree } from "../dashboard/proc-tree.mjs"
import { pageToken } from "../dashboard/restart-rules.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const CORE_ENTRY = path.resolve(HERE, "..", "dashboard", "server.mjs")
const KIT = path.resolve(HERE, "..", "..", "..")

/** Паузы перед перезапуском упавшего ядра: n-е падение подряд ждёт BACKOFF_MS[n-1], дальше — последнюю. */
export const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000]
export const backoffMs = (n) => BACKOFF_MS[Math.min(Math.max(0, n - 1), BACKOFF_MS.length - 1)]
/** Ядро проработало столько без падения — счёт падений подряд обнуляется. */
export const STABLE_MS = 120000
/** Сколько ждать, пока ядро ответит после запуска (первый запуск собирает снимок git всех папок). */
export const READY_MS = Number(process.env.DASH_HUB_READY_MS) || 90000

// Переменные хаба и тестов, которые ядру не передаются: у каждого ядра свои, иначе пробные папки одного ушли бы всем.
const STRIP = ["DASH_DATA", "DASH_PORT", "DASH_DRY", "DASH_EPIC_FILE", "DASH_START_REASON", "DISPATCHER_MAIN", "DISPATCHER_WT",
  "DISPATCHER_PROJECT", "DISPATCHER_PROJECT_ID", "NODE_TEST_CONTEXT"]

/** Окружение ядра: окружение хаба без чужих переменных плюс своё. Токен страницы через окружение не идёт — его унаследовали бы агенты. */
export function coreEnv(base, { file, homeFile, port, data, reason }) {
  const env = { ...base }
  for (const k of STRIP) delete env[k]
  return { ...env, DISPATCHER_PROJECT: file, DISPATCHER_HOME: homeFile, DASH_PORT: String(port), DASH_DATA: data, DASH_START_REASON: reason }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = async (url, ms = 3000) => { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error("HTTP " + r.status); return r.json() }

/** Снять процесс с деревом потомков: агенты и прогоны ядра не остаются сиротами. sync — из обработчика выхода хаба. */
export function killCoreTree(child, { force = false } = {}) {
  if (!child || !(child.pid > 0) || child.exitCode !== null) return
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 15000 })
    else killPosixTree(child.pid, force ? "SIGKILL" : "SIGTERM", (sig) => child.kill(sig))
  } catch { /* уже вышел */ }
}

/** Снять чужое по pid (ядро прошлого хаба): у него нет объекта дочернего процесса. */
function killPid(pid) {
  if (!(pid > 0)) return
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 15000 })
    else killPosixTree(pid, "SIGTERM")
  } catch { /* уже вышел */ }
}

export class Core {
  /**
   * @param entry проект дома { id, file, port, start }
   * @param home нормализованный дом (loadHome)
   */
  constructor(entry, { home, env = process.env, log = (s) => console.log(s) } = {}) {
    Object.assign(this, { entry, home, env, log })
    this.id = entry.id; this.port = entry.port
    this.state = "stopped" // stopped | starting | running | backoff
    this.child = null; this.token = ""; this.pid = 0; this.name = entry.id
    this.restarts = 0; this.crashes = 0; this.startedAt = 0; this.lastError = ""; this.stopWhy = ""
    this.lastUse = Date.now(); this.streams = 0; this.summary = null; this.timer = null; this.ready = null
    this.tail = []
  }

  base() { return "http://127.0.0.1:" + this.port }

  /** Для сводки хаба. */
  public() {
    return {
      id: this.id, name: this.name, port: this.port, start: this.entry.start, state: this.state, pid: this.pid || null,
      restarts: this.restarts, startedAt: this.startedAt || null, lastError: this.lastError || "", stopWhy: this.stopWhy || "",
    }
  }

  /** Запросом пользуются (страница, API): ленивому проекту — отсрочка остановки без дел. */
  touch() { this.lastUse = Date.now() }

  /** Поднять ядро и дождаться готовности. Уже работает или поднимается — тот же итог. → true, если работает. */
  start(reason = "запуск хаба") {
    if (this.state === "running") return Promise.resolve(true)
    if (this.ready) return this.ready
    clearTimeout(this.timer); this.timer = null
    this.stopping = false; this.state = "starting"; this.stopWhy = ""
    this.ready = this.boot(reason).finally(() => { this.ready = null })
    return this.ready
  }

  async boot(reason) {
    let project
    try { project = loadProject({ file: this.entry.file, fresh: true, env: this.env }) } catch (e) {
      return this.failed("конфиг проекта не загрузился: " + e.message.split("\n").slice(0, 4).join(" | "))
    }
    this.name = project.name
    // на порту уже сидит ядро этого проекта от прошлого хаба (хаб сняли жёстко — дети пережили его) — снять его
    const old = await getJson(this.base() + "/api/summary", 1500).catch(() => null)
    if (old && old.project && old.project.file && samePath(old.project.file, project.file) && old.pid > 0) {
      this.log(`[${this.id}] на порту ${this.port} ядро прошлого хаба (pid ${old.pid}) — снимаю`)
      killPid(old.pid)
      for (let i = 0; i < 40 && (await getJson(this.base() + "/api/summary", 800).catch(() => null)); i++) await sleep(250)
    } else if (await fetch(this.base() + "/", { signal: AbortSignal.timeout(1500) }).then(() => true, () => false))
      return this.failed(`порт ${this.port} занят другим процессом — смените \`port\` проекта в доме или освободите порт`)
    if (this.stopping) return this.failed("остановлен до запуска")

    const logDir = path.join(this.home.hub.data, "logs")
    fs.mkdirSync(logDir, { recursive: true })
    const out = fs.createWriteStream(path.join(logDir, this.id + ".log"), { flags: "a" })
    const env = coreEnv(this.env, { file: this.entry.file, homeFile: this.home.file, port: this.port, data: project.repo.data, reason: "хаб: " + reason })
    const child = spawn(process.execPath, [CORE_ENTRY], { cwd: KIT, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    this.child = child; this.pid = child.pid || 0; this.startedAt = Date.now(); this.token = ""
    const keep = (d) => { out.write(d); for (const l of String(d).split(/\r?\n/)) if (l.trim()) this.tail.push(l.trim()); this.tail = this.tail.slice(-20) }
    child.stdout.on("data", keep); child.stderr.on("data", keep)
    child.on("error", (e) => { this.lastError = "не запустился: " + e.message })
    child.on("exit", (code, sig) => { out.end(); this.exited(child, code, sig) })
    this.log(`[${this.id}] запуск ядра pid ${child.pid} на порту ${this.port} (${reason})`)

    const until = Date.now() + READY_MS
    while (Date.now() < until && this.child === child && child.exitCode === null) {
      const s = await getJson(this.base() + "/api/summary", 2000).catch(() => null)
      if (s && s.pid === child.pid) {
        if (await this.refreshToken()) { this.summary = s; this.state = "running"; this.lastError = ""; this.log(`[${this.id}] ядро готово`); return true }
      }
      await sleep(300)
    }
    if (this.child === child && child.exitCode === null) { this.lastError = `ядро не ответило за ${Math.round(READY_MS / 1000)} с`; killCoreTree(child) }
    return false
  }

  /** Токен страницы ядра: из <meta name="dash-token"> его страницы (новый при каждом запуске ядра). */
  async refreshToken() {
    try {
      const t = pageToken(await (await fetch(this.base() + "/", { signal: AbortSignal.timeout(3000) })).text())
      if (t) this.token = t
      return !!t
    } catch { return false }
  }

  failed(why) {
    this.lastError = why; this.crashes++
    this.log(`[${this.id}] ${why}`)
    this.later()
    return false
  }

  /** Следующая попытка запуска через паузу; ленивому проекту без спроса — нет: его поднимет следующий запрос. */
  later() {
    if (this.stopping) { this.state = "stopped"; return }
    this.state = this.entry.start === "lazy" && Date.now() - this.lastUse > 60000 ? "stopped" : "backoff"
    if (this.state !== "backoff") return
    const ms = backoffMs(this.crashes)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.restarts++; this.start("перезапуск после падения").catch(() => { }) }, ms)
    this.timer.unref()
  }

  exited(child, code, sig) {
    if (this.child !== child) return
    this.child = null; this.pid = 0; this.token = ""
    if (this.stopping) { this.state = "stopped"; this.log(`[${this.id}] ядро остановлено (${this.stopWhy || "хаб"})`); return }
    if (Date.now() - this.startedAt > STABLE_MS) this.crashes = 0
    const why = `ядро вышло (код ${code ?? "—"}${sig ? ", сигнал " + sig : ""})` + (this.tail.length ? ": " + this.tail.slice(-3).join(" | ") : "")
    this.failed(why)
  }

  /** Остановить ядро с деревом процессов и дождаться выхода. */
  async stop(why = "хаб") {
    this.stopping = true; this.stopWhy = why
    clearTimeout(this.timer); this.timer = null
    const child = this.child
    if (!child) { this.state = "stopped"; return }
    const gone = new Promise((r) => { if (child.exitCode !== null) r(); else child.once("exit", r) })
    killCoreTree(child)
    const t = setTimeout(() => killCoreTree(child, { force: true }), 5000)
    await Promise.race([gone, sleep(15000)])
    clearTimeout(t)
    this.state = "stopped"
  }

  /** Синхронно — из обработчика `exit` хаба, где асинхронное уже не выполнится. */
  stopSync() { this.stopping = true; clearTimeout(this.timer); if (this.child) killCoreTree(this.child, { force: true }) }

  /** Сводка ядра (/api/summary) — свежая, если ядро отвечает; иначе прежняя. */
  async poll() {
    if (this.state !== "running") return this.summary
    try { this.summary = await getJson(this.base() + "/api/summary", 3000) } catch { /* ответит в следующий раз */ }
    return this.summary
  }

  /** Ленивый проект без дел (нет агентов и прогонов, нет открытых страниц, давно без запросов) — пора остановить. */
  idleDue(now = Date.now()) {
    const ms = this.home.hub.idleStopMin * 60000
    return this.entry.start === "lazy" && this.state === "running" && !!this.summary && this.summary.idle && this.streams === 0 &&
      now - this.lastUse > ms && now - this.startedAt > ms
  }
}
