// slots.mjs — где лежит проект и реестр эпиков: одно место, откуда это знают и сервер, и команды.
//
// Пути и запреты приходят из конфига проекта (project.mjs). Переменные окружения DISPATCHER_MAIN и DISPATCHER_WT
// перекрывают пути конфига — так тесты и пробные экземпляры смотрят на временные папки, не трогая настоящий проект.
//
// Реестр эпиков — один файл epics.json в папке слотов: { active, epics: [{ id, title, status, orch: { branch, path },
// slots: [...] }] }. Перед каждой записью прежняя версия сохраняется рядом как .prev.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { HOME, fwd, loadProject } from "./project.mjs"
import { toClaudeRules } from "./runtimes/claude-policy.mjs"

export { HOME, fwd }
/** Прежнее имя дома диспетчерской; оставлено для модулей, которые его читают. */
export const REPO = HOME

/** Нормализованный конфиг проекта. Нет файла или он с ошибками — исключение с человеческим текстом. */
export const PROJECT = loadProject()

// Тесты диспетчерской (демо-проект, пути не заданы окружением) живут в песочнице во временной папке:
// всё, что тест создаст по этим путям, не попадёт ни в домашнюю папку, ни в настоящий проект.
const sandbox = process.env.NODE_TEST_CONTEXT && !process.env.DISPATCHER_PROJECT ? path.join(os.tmpdir(), "dk-test-" + process.pid) : ""

/** Основная папка репозитория проекта: в ней живёт ветка `staging`. */
export const MAIN = path.resolve(process.env.DISPATCHER_MAIN || (sandbox ? path.join(sandbox, "main") : PROJECT.repo.main))
/** Корень рабочих копий слотов и служебных папок диспетчерской. */
export const WT = path.resolve(process.env.DISPATCHER_WT || (sandbox ? path.join(sandbox, "wt") : PROJECT.repo.worktrees))
/** Папка слотов перекрыта окружением или песочницей — тогда и папка данных идёт за ней, а не из конфига. */
export const WT_OVERRIDDEN = path.resolve(PROJECT.repo.worktrees) !== WT

// Ветки. Диспетчерская зовёт интеграционную ветку `staging`, прод-ветку — `main`: это локальные ветки-роли в
// основной папке проекта. За ними стоят настоящие ветки проекта на remote — их имена здесь.
export const REMOTE = PROJECT.repo.remote
/** Интеграционная ветка проекта на remote, например `origin/develop`. */
export const UP_STAGING = REMOTE + "/" + PROJECT.repo.upstream.staging
/** Прод-ветка проекта на remote; пусто, если отдельной прод-ветки нет. */
export const UP_MAIN = PROJECT.repo.upstream.main ? REMOTE + "/" + PROJECT.repo.upstream.main : ""

/** Путь к команде эпиков — для подсказок агентам: её зовут по полному пути из любой папки. */
export const EPIC_CLI = fwd(HOME) + "/scripts/dev/epic.mjs"

/** Персона инженера слота: общая для всех эпиков, поэтому живёт в диспетчерской, а не в папке эпика. */
export const PERSONA_PATH = path.join(HOME, "agent-briefs", "SLOT-ENGINEER-persona.md")

const rules = toClaudeRules(PROJECT.deny)
/** Запреты для всех слотов в записи прав агента. */
export const COMMON_DENY = rules.deny
/** Спрашивать, а не запрещать: коммит агента слота разрешает кнопка «Коммит», иначе вопрос уходит человеку. */
export const COMMON_ASK = rules.ask

const ORCH_BASE = { tag: "ОРК", emoji: "🟥", slot: "orchestrator", title: "Оркестратор", color: "#dc2626" }

/** Цветной текст для терминала по цвету слота (#rrggbb). */
export function ansi(color, text) {
  const n = parseInt(color.slice(1), 16)
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${text}\x1b[0m`
}

export const EPIC_FILE = process.env.DASH_EPIC_FILE || path.join(WT, "_epics", "epics.json")

export function saveEpics(reg) {
  fs.mkdirSync(path.dirname(EPIC_FILE), { recursive: true })
  if (fs.existsSync(EPIC_FILE)) fs.copyFileSync(EPIC_FILE, EPIC_FILE + ".prev")
  const tmp = EPIC_FILE + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n")
  fs.renameSync(tmp, EPIC_FILE)
}

/** Реестр эпиков. Файла ещё нет — пустой реестр; при чтении ничего не пишется. */
export function loadEpics() {
  try { return JSON.parse(fs.readFileSync(EPIC_FILE, "utf8")) } catch { return { active: null, epics: [] } }
}

/** Активный эпик: названный в реестре, иначе первый открытый, иначе первый; в пустом реестре — null. */
export function activeEpic(reg = loadEpics()) {
  return reg.epics.find((e) => e.id === reg.active && e.status !== "closed") || reg.epics.find((e) => e.status !== "closed") || reg.epics[0] || null
}

/** Описание оркестратора эпика: его папки — основная (только читать) и папка эпика (здесь он пишет). */
export function orchOf(epic) {
  return { ...ORCH_BASE, folders: [{ name: "staging (общая папка, только читать)", path: fwd(MAIN) }, { name: "эпик (здесь пишет оркестратор)", path: epic.orch.path }] }
}

/** Эпик другого репозитория: в реестре только ради истории. */
export const isForeignEpic = (e) => !!(e && e.repo)

const _active = activeEpic()
/** Слоты активного эпика на момент загрузки модуля — для команд; сервер читает реестр сам. */
export const SLOTS = _active ? _active.slots : []
export const ORCH = _active ? orchOf(_active) : null
