// select-project.mjs — выбор проекта дома для команд диспетчерской (epic.mjs, slot-up.mjs, fleet.mjs …).
//
// Команды импортируют slots.mjs статически, а он читает конфиг проекта при загрузке. Поэтому выбор — первым импортом
// команды: ESM исполняет импорты по порядку, и к загрузке slots.mjs окружение уже указывает на нужный проект.
//   --project <id> (или --project=<id>) снимается из process.argv и ставится в DISPATCHER_PROJECT_ID;
//   есть дом, а DISPATCHER_PROJECT не задан — сюда ставится файл выбранного проекта, а DASH_PORT (если не задан) — его
//   порт: команды, которые стучатся в сервер (есть ли он, сброс слота), попадают в процесс своего проекта, а не в хаб.
// Агентам флаг не нужен: процесс проекта уже запущен хабом с DISPATCHER_PROJECT, агенты наследуют окружение.
// Дома нет — ничего не меняется.
import { ProjectConfigError, homeEntryFor, homeExists } from "./project.mjs"
import { samePath } from "./paths.mjs"

/** Снять `--project` из argv → id или "" (флага нет). Без значения — ошибка, а не тихий выбор проекта по умолчанию. */
export function takeProjectArg(argv) {
  const i = argv.findIndex((a, k) => k >= 2 && (a === "--project" || a.startsWith("--project=")))
  if (i < 0) return ""
  const a = argv[i], id = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[i + 1]
  if (!id || id.startsWith("--")) throw new ProjectConfigError("--project: нужен id проекта дома", { code: "unknown-project" })
  argv.splice(i, a.includes("=") ? 1 : 2)
  return id
}

/** Выбрать проект дома в окружение env. → запись проекта дома или null (дома нет либо проект уже задан явно). */
export function selectProject(argv = process.argv, env = process.env) {
  const id = takeProjectArg(argv)
  if (id && !homeExists(env)) throw new ProjectConfigError("--project " + id + ": дома нет (dispatcher.home.json) — проект один, флаг не нужен", { code: "unknown-project" })
  if (id) env.DISPATCHER_PROJECT_ID = id
  if (env.DISPATCHER_PROJECT) {
    // процесс проекта и его агенты уже привязаны к своему проекту: чужой --project — ошибка, а не тихая подмена
    const e = id ? homeEntryFor({ ...env, DISPATCHER_PROJECT: "" }) : null
    if (e && !samePath(e.file, env.DISPATCHER_PROJECT))
      throw new ProjectConfigError(`--project ${id}: команда запущена для другого проекта (DISPATCHER_PROJECT=${env.DISPATCHER_PROJECT})`, { code: "unknown-project" })
    return null
  }
  const e = homeEntryFor(env)
  if (!e) return null
  env.DISPATCHER_PROJECT = e.file
  if (!env.DASH_PORT) env.DASH_PORT = String(e.port)
  return e
}

try { selectProject() } catch (e) {
  if (!(e instanceof ProjectConfigError)) throw e
  console.error("✗ " + e.message)
  process.exit(2)
}
