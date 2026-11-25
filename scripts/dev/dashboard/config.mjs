// config.mjs — настройки сервера: порт, папка данных, пути файлов состояния, переключатели по умолчанию,
// журнал событий (logEvent) и уборка старых логов.
//
// Что откуда: где лежит проект и папка данных — из конфига проекта (slots.mjs → project.mjs); порт и прочее — из
// переменных окружения DASH_*, чтобы рядом с рабочим экземпляром можно было поднять пробный (другой порт и папка данных).
import { WT, WT_OVERRIDDEN, PROJECT } from "../slots.mjs"
import crypto from "node:crypto"
import fs from "node:fs"
import { writeAtomicSync } from "./store.mjs"
import { eventEpic } from "./epic-journal.mjs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Диспетчерская живёт на DASH_PORT. Переменную PORT убираем из своего окружения до любого запуска: её наследуют
// прогоны, а тестовые серверы многих фреймворков садятся на PORT, если он задан, — и сталкиваются с диспетчерской.
if (process.env.PORT && !process.env.DASH_KEEP_PORT) delete process.env.PORT

export const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Занятые локальные порты. Новый сервер берёт порт, которого здесь нет, и дописывает его сюда. Все — 127.0.0.1. */
export const LOCAL_PORTS = {
  4777: "диспетчерская (DASH_PORT)",
  4786: "пробный экземпляр диспетчерской при правках (DASH_DRY=1 DASH_PORT=4786)",
}

export const PORT = Number(process.env.DASH_PORT || 4777)
export const HOST = "127.0.0.1"
export const TOKEN = crypto.randomBytes(16).toString("hex")
/** Папка данных. DASH_DATA — отдельная папка для пробного экземпляра; при перекрытой папке слотов данные идут за ней. */
export const DATA = process.env.DASH_DATA || (WT_OVERRIDDEN ? path.join(WT, "_dashboard") : PROJECT.repo.data)
export const LOGS = path.join(DATA, "logs")
export const RUNS = path.join(DATA, "runs.json")
/** Отдельная рабочая копия на ветке `main`: выкат делается в ней. */
export const MAIN_WT = path.join(WT, "_main")
/** Сухой экземпляр: только показывает — без прогонов, агентов и записей в git. */
export const DRY = process.env.DASH_DRY === "1"
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Переключатели поведения (settings.json в папке данных; читает boot.mjs, меняет страница настроек).
 * Умолчания безопасные: всё, что действует без человека, выключено. Стартовая настройка включает нужное
 * по ответу об автономии. selfCommit — коммиты агента слота: word | station | free (commit-rules.mjs).
 */
export const SETTINGS_FILE = path.join(DATA, "settings.json")
export const settings = {
  autoResults: true,
  autoTrain: false,
  autoCommit: false,
  autoMerge: false,
  autoSyncConflict: false,
  fullPermissions: false,
  selfCommit: "word",
  retroAuto: false,
  tgBot: false,
  commitTrailer: "",
}

// Журнал прогонов: runs.jsonl, только дозапись. Каждая смена записи прогона — строка; при старте побеждает последняя
// строка по id. В памяти — последние KEEP_JOBS прогонов, на диске — все.
export const RUNS_JSONL = path.join(DATA, "runs.jsonl"), KEEP_JOBS = Number(process.env.DASH_KEEP_JOBS) || 2000
export const jobNum = (j) => Number(String(j && j.id || "").slice(1)) || 0

// Журнал событий: решения автоматики, ворота, передачи, отметки — одной строкой на событие, только дозапись.
// Источник для разбора «почему стояло» без чтения чатов. Поле epic ставится по ключу слота или агента события;
// сбой определения журнал не роняет — событие пишется без поля.
export const EVENTS_JSONL = path.join(DATA, "events.jsonl")
let eventEpicOf = null
export const setEventEpicOf = (fn) => { eventEpicOf = fn }

export function logEvent(type, data = {}) {
  if (DRY) return
  let epic = null
  if (eventEpicOf) try { epic = eventEpic(data, eventEpicOf) } catch { epic = null }
  fs.appendFile(EVENTS_JSONL, JSON.stringify(epic ? { at: Date.now(), type, epic, ...data } : { at: Date.now(), type, ...data }) + "\n", () => { })
}

export const EPIC_EVENTS_KEEP_DAYS = Number(process.env.DASH_EPIC_KEEP_DAYS) || 60
export const LOG_KEEP_DAYS = Number(process.env.DASH_LOG_KEEP_DAYS) || 7

/** Убрать логи прогонов и общие события старше LOG_KEEP_DAYS; события эпиков живут EPIC_EVENTS_KEEP_DAYS. */
export function rotateLogs(retry = 0) {
  if (DRY) return
  const cut = Date.now() - LOG_KEEP_DAYS * 86400e3
  let n = 0, mb = 0
  const ev = trimJsonl(EVENTS_JSONL, cut, { epicCut: Date.now() - EPIC_EVENTS_KEEP_DAYS * 86400e3 })
  if (ev.busy && retry < 5) setTimeout(() => rotateLogs(retry + 1), 60000).unref()
  if (retry) return
  try {
    for (const f of fs.readdirSync(LOGS)) {
      if (!/^j\d+\.log$/.test(f)) continue
      const p = path.join(LOGS, f)
      try {
        const st = fs.statSync(p)
        if (st.mtimeMs < cut) { mb += st.size / 1048576; fs.unlinkSync(p); n++ }
      } catch { /* файл уже убран */ }
    }
  } catch { /* папки логов ещё нет */ }
  if (n) {
    console.log("логи прогонов старше " + LOG_KEEP_DAYS + " сут. удалены:", n, "(" + Math.round(mb) + " МБ)")
    logEvent("logs.rotated", { n, mb: Math.round(mb) })
  }
  if (ev.dropped) {
    console.log("события старше " + LOG_KEEP_DAYS + " сут. убраны из events.jsonl:", ev.dropped, "строк, осталось", ev.kept)
    logEvent("events.rotated", { dropped: ev.dropped, kept: ev.kept })
  }
}

/** Оставить в журнале строки не старше `cut`; строки с полем epic — не старше `epicCut`. Строка без времени не трогается. */
export function trimJsonl(file, cut, { epicCut = null } = {}) {
  let text
  try { text = fs.readFileSync(file, "utf8") } catch { return { dropped: 0, kept: 0 } }
  const at = (l) => { try { const o = JSON.parse(l); return { t: Number(o.at) || null, ep: !!o.epic } } catch { return { t: null, ep: false } } }
  const lines = text.split("\n").filter(Boolean)
  const keep = lines.filter((l) => { const { t, ep } = at(l); return t == null || t >= (ep && epicCut != null ? Math.min(cut, epicCut) : cut) })
  if (keep.length === lines.length) return { dropped: 0, kept: lines.length }
  try { writeAtomicSync(file, keep.length ? keep.join("\n") + "\n" : "") } catch { return { dropped: 0, kept: lines.length, busy: true } }
  return { dropped: lines.length - keep.length, kept: keep.length }
}

export const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
export const logPath = (id) => path.join(LOGS, `${id}.log`)
/** Конечные состояния прогона. */
export const FINAL = ["ok", "fail", "skipped", "cancelled", "interrupted"]
export const short = (s, n = 600) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + `… (+${s.length - n})` : s }
export const readLog = (id) => { try { return fs.readFileSync(logPath(id), "utf8") } catch { return "" } }
