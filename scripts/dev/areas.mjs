// areas.mjs — области проекта для эпиков, слотов и поездов: одно место, где из раздела `areas` конфига проекта выводятся
// области поездов, запреты правки слота, тесты волны по умолчанию и перечень областей для подсказок.
// Чистые функции над нормализованным конфигом (project.mjs normalizeProject); по умолчанию — конфиг этой установки.
import fs from "node:fs"
import path from "node:path"
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
export function slotPolicy(rec = {}, project = PROJECT, list = listDir) {
  const allow = new Set((rec.allowEdit || []).map(String))
  const area = areaOf(rec.area, project)
  let editDeny = rec.readOnly ? ["/**"] : [...new Set([...areaDenyEdit(area), ...(rec.deny || []).map(String)])].filter((p) => !allow.has(p))
  // Приёмка: тест приёмки своей волны слот пишет и вне своей области (accept.specGlob). Запрет «/<папка>/**», накрывающий
  // каталог спек, заменяется запретами соседей по пути к нему — остальное в этой папке слоту по-прежнему закрыто.
  // dropEdit — раскрытые запреты: их надо убрать из уже записанных настроек слота (иначе общий запрет остаётся).
  let dropEdit = []
  const sg = project.accept && project.accept.run && project.accept.specGlob
  if (sg && !rec.readOnly) {
    const carved = carveSpecDir(editDeny, specDirOf(sg), (rel) => list(project.repo && project.repo.main, rel))
    dropEdit = editDeny.filter((g) => !carved.includes(g))
    editDeny = carved
  }
  return { deny: { ...project.deny, edit: project.deny.edit.filter((p) => !allow.has(p)) }, editDeny, allowEdit: [...allow], dropEdit }
}

/** Статическая часть шаблона спек: «apps/web/tests/acc/*.spec.ts» → «apps/web/tests/acc». */
export function specDirOf(glob) {
  const segs = String(glob).replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter(Boolean)
  const gi = segs.findIndex((x) => /[*?[{]/.test(x))
  return (gi < 0 ? segs.slice(0, -1) : segs.slice(0, gi)).join("/")
}

/** Содержимое каталога репозитория (имена и признак каталога); нет каталога — пусто. */
function listDir(root, rel) {
  if (!root) return []
  try {
    return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }))
  } catch {
    return []
  }
}

/**
 * Запреты правки без каталога dir: шаблон «/A/**» (или «/A/B/**»), внутри которого лежит dir, раскрывается в запреты
 * соседей на каждом уровне пути к dir (каталог — «/x/**», файл — «/x»). Чистая функция: list(rel) → [{ name, dir }].
 */
export function carveSpecDir(denies, dir, list) {
  if (!dir) return denies
  const out = []
  for (const g of denies) {
    const m = /^\/(.+)\/\*\*$/.exec(String(g))
    const base = m ? m[1].replace(/\/+$/, "") : null
    if (!base || !(dir === base || dir.startsWith(base + "/"))) { out.push(g); continue }
    if (dir === base) continue // накрыт ровно каталог спек — запрет снимается целиком
    const rest = dir.slice(base.length + 1).split("/")
    let cur = base
    for (const seg of rest) {
      for (const e of list(cur)) {
        if (e.name === seg) continue
        out.push("/" + cur + "/" + e.name + (e.dir ? "/**" : ""))
      }
      cur += "/" + seg
    }
  }
  return [...new Set(out)]
}
