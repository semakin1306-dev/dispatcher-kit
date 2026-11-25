// modules.mjs — реестр модулей сервера: кто включён, кто стартует, чьи маршруты открыты.
//
// Каталог (что за модули и чего им не хватает) — modules-catalog.mjs; состояние считается по конфигу проекта
// (moduleStates). Здесь — три шва сервера:
//   • запуск: boot.mjs регистрирует запуск модуля (onModuleBoot), startModules() зовёт только включённые;
//   • маршруты: в начале api() сторож routeGate() — путь выключенного модуля отвечает 404;
//   • состояние: modulesPublic() — поле `modules` в /api/state, по нему страница прячет панели.
// Модуль может отдать свой обработчик маршрутов (moduleHttp): тогда http.mjs передаёт ему запросы его префиксов.
import { PROJECT } from "../slots.mjs"
import { MODULES, moduleStates } from "../modules-catalog.mjs"

/**
 * Префиксы маршрутов модулей. Путь принадлежит модулю, если совпадает с префиксом или продолжается после него
 * знаком `/`, `-` или `?` (`/api/accept-state`, `/api/accept/file` — модуль accept).
 */
export const MODULE_ROUTES = {
  review: ["/api/review"],
  backlog: ["/api/backlog"],
  retro: ["/api/retro"],
  machines: ["/api/shard", "/shard"],
  release: ["/api/release", "/api/run-staging-full"],
  accept: ["/api/accept", "/api/stand-checklist", "/api/reminders"],
  tg: ["/api/tg"],
  "win-desktop": ["/api/win", "/api/ssh-unlock"],
}

let states = null
let platform = process.platform

/** Состояния модулей (кеш до сброса). */
export function moduleStatesNow() {
  if (!states) states = moduleStates(PROJECT, { platform })
  return states
}

/** Тесты: подменить состояния модулей (`{ id: true|false }`) или вернуть расчёт по конфигу (без аргумента). */
export function setModuleStates(over = null, { platform: p = process.platform } = {}) {
  platform = p
  states = null
  if (!over) return
  states = moduleStatesNow().map((s) => (s.id in over ? { ...s, on: !!over[s.id], why: over[s.id] ? "" : "выключен в тесте" } : s))
}

/** Включён ли модуль. Неизвестный id — false. */
export const enabled = (id) => { const s = moduleStatesNow().find((x) => x.id === id); return !!(s && s.on) }

/** Для /api/state: [{ id, title, about, wanted, on, why }]. */
export const modulesPublic = () => moduleStatesNow().map((s) => ({ ...s }))

const startsAt = (pathname, p) => pathname === p || (pathname.startsWith(p) && "/-?".includes(pathname[p.length]))

/** Какому модулю принадлежит путь; null — ядру. */
export function moduleOfPath(pathname) {
  for (const [id, list] of Object.entries(MODULE_ROUTES)) if (list.some((p) => startsAt(String(pathname || ""), p))) return id
  return null
}

/** Сторож маршрутов: null — путь открыт; иначе { id, why } — модуль выключен, ответить 404. */
export function routeGate(pathname) {
  const id = moduleOfPath(pathname)
  if (!id || enabled(id)) return null
  const s = moduleStatesNow().find((x) => x.id === id)
  return { id, why: "модуль «" + id + "» выключен" + (s && s.why ? ": " + s.why : "") }
}

// ── запуск модулей ──
const boots = new Map()
const handlers = new Map()
const started = new Set()

/** Зарегистрировать запуск модуля (boot.mjs). Повторная регистрация заменяет прежнюю. */
export function onModuleBoot(id, fn) {
  if (!MODULES.some((m) => m.id === id)) throw new Error("нет такого модуля: " + id)
  boots.set(id, fn)
}

/** Модуль отдаёт свой обработчик маршрутов: (req, res, url, ctx) → true, если запрос обработан. */
export function moduleHttp(id, handler) {
  if (!MODULE_ROUTES[id]) throw new Error("у модуля " + id + " нет маршрутов")
  handlers.set(id, handler)
}
export const moduleHandler = (id) => handlers.get(id) || null

/**
 * Запустить включённые модули в порядке каталога с учётом `after` (модуль идёт после тех, от кого зависит).
 * Сбой одного модуля не роняет сервер и не мешает остальным.
 * @returns {{ started: string[], failed: {id:string, error:string}[] }}
 */
export function startModules(ctx = {}) {
  const order = [], seen = new Set()
  const visit = (m) => { if (seen.has(m.id)) return; seen.add(m.id); for (const d of m.after || []) { const dm = MODULES.find((x) => x.id === d); if (dm) visit(dm) } order.push(m.id) }
  for (const m of MODULES) visit(m)
  const out = { started: [], failed: [] }
  for (const id of order) {
    if (!enabled(id) || started.has(id) || !boots.has(id)) continue
    try {
      boots.get(id)(ctx)
      started.add(id)
      out.started.push(id)
    } catch (e) {
      out.failed.push({ id, error: String((e && e.message) || e) })
      console.error("модуль " + id + ":", (e && e.message) || e)
    }
  }
  return out
}

export const startedModules = () => [...started]
