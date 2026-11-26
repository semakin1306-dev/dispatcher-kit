// ownership.mjs — какие рабочие копии (git worktree) репозитория проекта создала диспетчерская, а какие нет. Одно правило
// для всех, кто убирает папки: уборка лишних слотов (dashboard/worktree-hygiene.mjs) и `epic.mjs close --remove-worktrees`.
//
// Зачем отдельное правило: у репозитория бывают и чужие копии — человек завёл свою рядом или внутри папки слотов, а в
// лёгком режиме основная папка проекта сама лежит в папке слотов (`_staging`). Уборка, которая судит только по «не нужно
// открытому эпику», прятала бы такую копию в stash и удаляла её. Поэтому «моё» — это узкий список, а всё остальное чужое.
//
// Моё — только прямые дети папки слотов:
//   · служебные папки: имя с `_` (`_main`, `_staging`, `_backlog` …) и `regress-*` (папка поезда `regress-train`) —
//     их ведёт сама диспетчерская, уборка их не трогает никогда;
//   · папки слотов, поездов и оркестраторов: имя по правилу ниже или имя из реестра эпиков (слот с особым именем).
// Основная папка проекта и всё вне папки слотов — не моё, где бы ни лежало. Пути сравниваются по файловой системе (paths.mjs).
import path from "node:path"
import { canonPath } from "./paths.mjs"

/** Имя папки (и ключ) нового слота: wv<NNNN>-<два первых слова слага>. Это же имя узнаёт уборка. */
export const slotDirName = (num, slug) => "wv" + num + "-" + String(slug).split("-").slice(0, 2).join("-")
/** Приставка имени слота поезда (tr-<область>[полоса]-<эпик>, train-rules.mjs). */
export const TRAIN_PREFIX = "tr-"
/** Имя папки оркестратора эпика по умолчанию. */
export const orchDirName = (id) => "epic-" + id

// Правило имён — пара к строителям выше; сверка в ownership.test.mjs гоняет строители через правило.
const NAME_RE = /^(wv\d{4,}-[a-z0-9][a-z0-9-]*|tr-[a-z0-9][a-z0-9-]*|epic-[a-z0-9][a-z0-9-]*)$/
const SERVICE_RE = /^(_[^\\/]+|regress-[a-z0-9-]+)$/

/** Чей путь: main — основная папка; outside — вне папки слотов; service — служебная; slot — слот, поезд или
 *  оркестратор диспетчерской; foreign — в папке слотов, но не по её правилу. Только slot может быть убран. */
export const OWN = Object.freeze({ MAIN: "main", OUTSIDE: "outside", SERVICE: "service", SLOT: "slot", FOREIGN: "foreign" })

// Имя прямого ребёнка папки root (оба пути уже канонические) или null. Строкой, а не path.dirname: у корня диска «c:/»
// dirname дал бы «c:», и папка слотов в корне диска не узнала бы своих детей.
function childOf(c, root) {
  const r = root.endsWith("/") ? root : root + "/"
  return c.startsWith(r) && c.length > r.length && !c.slice(r.length).includes("/") ? c.slice(r.length) : null
}

/** Имена папок слотов и оркестраторов из реестра эпиков своего репозитория — открытых и закрытых. */
export function registeredDirs(epics, wtRoot) {
  const root = canonPath(wtRoot), out = new Set()
  for (const e of epics || []) {
    if (e.repo) continue // эпик другого репозитория: его папки не наши
    for (const s of e.slots || []) if (s.slot) out.add(canonPath(path.join(wtRoot, s.slot)))
    if (e.orch && e.orch.path && childOf(canonPath(e.orch.path), root)) out.add(canonPath(e.orch.path))
  }
  return out
}

/**
 * Чей это путь рабочей копии. ctx: { wtRoot, main, known } — known из registeredDirs (необязательно).
 * Порядок проверок важен: основная папка — первой, она может лежать и в папке слотов (`_staging`).
 */
export function ownerOf(p, { wtRoot, main, known = new Set() }) {
  const c = canonPath(p)
  if (main && c === canonPath(main)) return OWN.MAIN
  const name = childOf(c, canonPath(wtRoot))
  if (!name) return OWN.OUTSIDE
  if (SERVICE_RE.test(name)) return OWN.SERVICE
  return known.has(c) || NAME_RE.test(name) ? OWN.SLOT : OWN.FOREIGN
}

/**
 * Разбор списка рабочих копий ({ p, … }) на лишние и чужие. Лишняя — slot, не нужная ни одному открытому эпику и не из
 * «оставить» (keep — имена в папке слотов). Чужие (outside, foreign) возвращаются, чтобы их можно было показать, но не
 * убирать; основная и служебные не попадают никуда.
 */
export function splitWorktrees(list, epics, { wtRoot, main, keep = [] }) {
  const known = registeredDirs(epics, wtRoot), live = new Set()
  for (const e of epics || []) {
    if (e.status === "closed" || e.repo) continue
    for (const s of e.slots || []) live.add(canonPath(path.join(wtRoot, s.slot)))
    if (e.orch && e.orch.path) live.add(canonPath(e.orch.path))
  }
  for (const k of keep || []) live.add(canonPath(path.join(wtRoot, k)))
  const extra = [], foreign = []
  for (const w of list) {
    const own = ownerOf(w.p, { wtRoot, main, known })
    if (own === OWN.SLOT && !live.has(canonPath(w.p))) extra.push({ ...w, own })
    else if (own === OWN.OUTSIDE || own === OWN.FOREIGN) foreign.push({ ...w, own })
  }
  return { extra, foreign }
}
