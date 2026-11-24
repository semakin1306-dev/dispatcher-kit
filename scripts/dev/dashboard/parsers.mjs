// parsers.mjs — разбор вывода прогона задачи в единый вид { passed[], failed[], totals[], names[] }.
//
// Как разбирать, говорит поле `parser` задачи в конфиге проекта: имя заготовки (`exit-code`, `jest`, `vitest`, `go-test`,
// `pytest`) или объект из регулярок { pass, fail, totals, names }. В `pass` и `fail` группа 1 — имя спеки (файла, пакета);
// в `names` группа 1 (если есть) — имя упавшего теста; `totals` — строки итога целиком.
// `exit-code` имён спек не знает: итог прогона — только код возврата. Всё, что опирается на имена спек (регресс, карантин,
// сужение набора, выжимки), для такой задачи выключается само — проверка `specAware`.
// Код-надстройка проекта может дать свою функцию parseOutput(text, taskId) — она сильнее заготовки (setParseHook).
import { PROJECT } from "../slots.mjs"

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const SPEC = String.raw`\S+\.(?:spec|test)\.[cm]?[jt]sx?`

/** Заготовки: по каждому ключу — список регулярок, строка подходит под любую. */
export const PRESETS = {
  "exit-code": null,
  jest: {
    pass: [/^\s*PASS\s+(\S.*?)(?:\s+\(\d[\d.]*\s*m?s\))?\s*$/],
    fail: [/^\s*FAIL\s+(\S.*?)(?:\s+\(\d[\d.]*\s*m?s\))?\s*$/],
    totals: [/^\s*(?:Tests|Test Suites|Snapshots):\s/],
    names: [/^\s*●\s+(.+?)\s*$/],
  },
  vitest: {
    pass: [new RegExp(String.raw`^\s*✓\s+(${SPEC})`)],
    // файл упал: «❯ файл (… failed)», «× файл» или строка сводки «FAIL файл > тест»
    fail: [new RegExp(String.raw`^\s*❯\s+(${SPEC})\b.*\bfailed\b`), new RegExp(String.raw`^\s*[×✗]\s+(${SPEC})`), new RegExp(String.raw`^\s*FAIL\s+(${SPEC})`)],
    totals: [/^\s*(?:Test Files|Tests)\s+\d/],
    names: [new RegExp(String.raw`^\s*FAIL\s+${SPEC}\s+>\s+(.+?)\s*$`), /^\s*[×✗]\s+(?!\S+\.(?:spec|test)\.)(.+?)(?:\s+\d+\s*m?s)?\s*$/],
  },
  "go-test": {
    pass: [/^ok\s+(\S+)/],
    fail: [/^FAIL\s+(\S+)\s+(?:[\d.]+s|\[)/],
    totals: [/^(?:ok|FAIL)\s+\S+\s/],
    names: [/^\s*--- FAIL:\s+(\S+)/],
  },
  pytest: {
    // `-v`: «путь::тест PASSED»; короткий вывод: «путь .s.» без F и E
    pass: [/^(\S+\.py)::\S+\s+PASSED\b/, /^(\S+\.py)\s+[.sxX]+\s*(?:\[\s*\d+%\])?\s*$/],
    fail: [/^(?:FAILED|ERROR)\s+(\S+\.py)(?:::|\s|$)/, /^(\S+\.py)::\S+\s+(?:FAILED|ERROR)\b/, /^(\S+\.py)\s+[.sxXFE]*[FE][.sxXFE]*\s*(?:\[\s*\d+%\])?\s*$/],
    totals: [/^=+ .*\b(?:passed|failed|error|errors|skipped|no tests ran)\b.*=+$/],
    names: [/^(?:FAILED|ERROR)\s+(\S+::\S+)/],
  },
}

const toList = (v) => (v === undefined ? [] : [new RegExp(v)])

/** Правила разбора по значению `parser` задачи: null — только код возврата. Неизвестное имя — как `exit-code`. */
export function compileParser(parser) {
  if (parser == null || typeof parser === "string") return PRESETS[parser || "exit-code"] || null
  if (typeof parser !== "object") return null
  return { pass: toList(parser.pass), fail: toList(parser.fail), totals: toList(parser.totals), names: toList(parser.names) }
}

const compiled = new Map()
/** Правила разбора задачи из конфига проекта (кеш по id). */
export function rulesOf(taskId) {
  if (compiled.has(taskId)) return compiled.get(taskId)
  const t = PROJECT.tasks[taskId]
  const r = t ? compileParser(t.parser) : null
  compiled.set(taskId, r)
  return r
}

/** Знает ли разбор задачи имена спек. Нет — регресс, карантин, сужение и выжимки по спекам для неё выключены. */
export function specAware(taskId) {
  if (parseHook) return true
  const r = rulesOf(taskId)
  return !!(r && (r.pass.length || r.fail.length))
}

let parseHook = null
/** Функция разбора из dispatcher.project.mjs: (text, taskId) → { passed, failed, totals, names } или null (тогда — заготовка). */
export const setParseHook = (fn) => { parseHook = typeof fn === "function" ? fn : null; compiled.clear() }

const capture = (re, line) => {
  const m = re.exec(line)
  if (!m) return null
  return (m[1] !== undefined ? m[1] : m[0]).trim()
}
const firstHit = (list, line) => { for (const re of list) { const v = capture(re, line); if (v) return v } return null }
const uniq = (a) => [...new Set(a)]

/** Разобрать текст по правилам (результат compileParser). Спека, упавшая хоть раз, в `passed` не попадает. */
export function parseWith(rules, text) {
  const empty = { passed: [], failed: [], totals: [], names: [] }
  if (!rules) return empty
  const lines = String(text || "").replace(ANSI, "").split(/\r?\n/)
  const passed = [], failed = [], totals = [], names = []
  for (const l of lines) {
    const f = firstHit(rules.fail, l)
    if (f) failed.push(f)
    else { const p = firstHit(rules.pass, l); if (p) passed.push(p) }
    if (rules.totals.some((re) => re.test(l))) totals.push(l.trim())
    const n = firstHit(rules.names, l)
    if (n) names.push(n)
  }
  const bad = new Set(failed)
  return { passed: uniq(passed).filter((p) => !bad.has(p)), failed: uniq(failed), totals: totals.slice(-4), names: uniq(names).slice(0, 25) }
}

/** Разобрать лог прогона задачи из конфига. Без id задачи (или задачи нет в конфиге) — заготовка jest, как прежний разбор. */
export function parseTaskLog(text, taskId) {
  if (parseHook && taskId) {
    try {
      const r = parseHook(String(text || ""), taskId)
      if (r && typeof r === "object") return { passed: r.passed || [], failed: r.failed || [], totals: r.totals || [], names: r.names || [] }
    } catch (e) { console.error("parseOutput проекта:", e.message) }
  }
  return parseWith(taskId && PROJECT.tasks[taskId] ? rulesOf(taskId) : PRESETS.jest, text)
}

// ───────────────────────────── ввод задачи из имён спек ─────────────────────────────
// Регресс, автоповтор и узкий перепрогон ставят задачу с вводом «эти спеки». Ввод идёт одним аргументом, поэтому
// список спек в одном аргументе понимают не все раннеры: jest — регулярка путей (альтернативы через |), pytest -k —
// выражение (or). У vitest фильтр — подстрока, у go test спека — пакет: для них ввод из спек не строится, и всё,
// что на нём держится, для такой задачи выключено.

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const baseName = (p) => String(p || "").replace(/\\/g, "/").split("/").pop()
const pyStem = (p) => baseName(p).replace(/\.py$/, "")

export const SPEC_INPUT = {
  jest: {
    make: (specs) => [...new Set(specs.map((s) => escRe(baseName(s))))].join("|"),
    add: (input, specs) => [input, ...specs.map((s) => escRe(baseName(s)))].join("|"),
    names: (input) => String(input || "").split("|").map((x) => x.trim().replace(/\\(.)/g, "$1")).filter(Boolean),
  },
  pytest: {
    make: (specs) => [...new Set(specs.map(pyStem))].join(" or "),
    add: (input, specs) => [input, ...specs.map(pyStem)].join(" or "),
    names: (input) => String(input || "").split(/\s+or\s+/).map((x) => x.trim()).filter(Boolean),
  },
}

/** Как строить ввод задачи из имён спек: { make, add, names } или null (задача без ввода, разбор не умеет). */
export function specInput(taskId) {
  const t = PROJECT.tasks[taskId]
  if (!t || !t.input || typeof t.parser !== "string") return null
  return SPEC_INPUT[t.parser] || null
}

/**
 * Одна строка вывода → итог спеки по мере прогона: { spec, ok } или null. Для живого счётчика сьютов;
 * правила те же, что у полного разбора.
 */
export function lineVerdict(taskId, line) {
  const r = rulesOf(taskId)
  if (!r) return null
  const l = String(line || "").replace(ANSI, "")
  const f = firstHit(r.fail, l)
  if (f) return { spec: f, ok: false }
  const p = firstHit(r.pass, l)
  return p ? { spec: p, ok: true } : null
}
