// areas.mjs — области проекта для эпиков, слотов и поездов: одно место, где из раздела `areas` конфига проекта выводятся
// области поездов, запреты правки слота, тесты волны по умолчанию и перечень областей для подсказок.
// Чистые функции над нормализованным конфигом (project.mjs normalizeProject); по умолчанию — конфиг этой установки.
import { PROJECT } from "./slots.mjs"

/** Перечень областей проекта для подсказок и ошибок: «api | web». */
export const areaList = (project = PROJECT) => Object.keys(project.areas || {}).join(" | ") || "(в конфиге проекта нет областей — раздел `areas`)"

/** Область по id или null. */
export const areaOf = (id, project = PROJECT) => (id && Object.prototype.hasOwnProperty.call(project.areas || {}, id) ? project.areas[id] : null)

/**
 * Папки области: каталоги пути до первого шаблона («apps/api/**» → «apps/api»); путь к файлу даёт его каталог.
 * Корневые шаблоны и файлы корня («deploy*.sh», «README.md») папки не дают.
 */
export function areaDirs(area) {
  const out = []
  for (const p of (area && area.paths) || []) {
    const s = String(p).replace(/\\/g, "/").replace(/^\/+/, ""), segs = s.split("/").filter(Boolean)
    const gi = segs.findIndex((x) => /[*?[{]/.test(x))
    const dirSegs = gi >= 0 ? segs.slice(0, gi) : s.endsWith("/") || !String(segs[segs.length - 1] || "").includes(".") ? segs : segs.slice(0, -1)
    const dir = dirSegs.join("/")
    if (dir && !out.includes(dir)) out.push(dir)
  }
  return out
}

/** Ключевые слова области: id, title и папки её путей (и последние имена папок) — строчными, без повторов. */
export function areaScope(area) {
  const words = [area.id, area.title, ...areaDirs(area).flatMap((d) => [d, d.split("/").pop()])]
  return [...new Set(words.map((w) => String(w || "").trim().toLowerCase()).filter(Boolean))]
}

/** Области поездов: поезд — слот области проекта. { <id>: { base: id, title, scope } } */
export function trainAreasOf(project = PROJECT) {
  return Object.fromEntries(Object.values(project.areas || {}).map((a) => [a.id, { base: a.id, title: a.title, scope: areaScope(a) }]))
}

/** Запреты правки области в нейтральной записи: путь от корня репозитория с «/» в начале. */
export const areaDenyEdit = (area) => ((area && area.denyEdit) || []).map((p) => "/" + String(p).replace(/\\/g, "/").replace(/^\/+/, ""))

/**
 * Тесты волны по умолчанию — задачи области (`areas.<id>.tasks`). Задаче с вводом подставляется номер волны строчными
 * («wv-0950»): так спеки волны находятся по имени. Задачи, которой нет в `tasks`, не бывает — это ловит проверка конфига.
 */
export function areaPresets(area, wave, project = PROJECT) {
  const input = String(wave || "").toLowerCase()
  return ((area && area.tasks) || []).filter((id) => project.tasks && project.tasks[id]).map((id) => (project.tasks[id].input && input ? { task: id, input } : { task: id }))
}

/** Поля области в записи слота реестра: область и нужна ли сборка при подготовке. */
export const slotAreaFields = (area) => ({ area: area.id, ...(area.build ? { build: true } : {}) })

/**
 * Запреты слота в нейтральной записи для рантайма (`runtime().writeSlotPolicy`): запреты конфига; правка закрыта путям
 * `denyEdit` области и `deny` записи слота, кроме разрешённых слоту `allowEdit`. Слоту «только чтение» закрыто всё.
 */
export function slotPolicy(rec = {}, project = PROJECT) {
  const allow = new Set((rec.allowEdit || []).map(String))
  const area = areaOf(rec.area, project)
  const editDeny = rec.readOnly ? ["/**"] : [...new Set([...areaDenyEdit(area), ...(rec.deny || []).map(String)])].filter((p) => !allow.has(p))
  return { deny: { ...project.deny, edit: project.deny.edit.filter((p) => !allow.has(p)) }, editDeny, allowEdit: [...allow] }
}
