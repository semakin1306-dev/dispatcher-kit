// prompt.mjs — неизменное начало сообщений и подсказок агентам: постоянное (правила, инструменты, формат ответа) —
// первым и одинаковым между ходами, меняющееся (метки, ветка, итоги) — в конце. Итоги прогонов слоту, отчёт прогона,
// справка оркестратору, задание ревьюеру, вводная новой сессии оркестратора. Чистые функции.
//
// Правило: в постоянной части нет дат, меток слотов (ПN), sha и списков без сортировки — иначе начало подсказки «плавает» между
// ходами, и рантайм не может переиспользовать уже прочитанное начало (prompt.test.mjs проверяет общий префикс).
import { EPIC_CLI, HOME, PROJECT, fwd } from "../slots.mjs"
import { DATA, PORT } from "./config.mjs"
import { prompt } from "../prompts.mjs"

/** Длина общего начала двух строк (для проверки «префикс не плавает»). */
export const commonPrefix = (a, b) => {
  let i = 0
  const n = Math.min(a.length, b.length)
  while (i < n && a[i] === b[i]) i++
  return i
}

/**
 * Строки других инструментов раздела «Инструменты»: строка «- …» (всем) или функция ({ slot }) → строка «- …» / "".
 * Порядок фиксированный — раздел одинаков у всех агентов одной роли.
 */
export const TOOLS_EXTRA = []

export function toolsSection({ slot = false, logsDir = fwd(DATA) + "/logs", cli = fwd(HOME) + "/scripts/dev/dash-log.mjs", port = PORT } = {}) {
  return [prompt("tools", { logsDir, cli, port }),
    ...TOOLS_EXTRA.map((x) => (typeof x === "function" ? x({ slot }) : x)).filter(Boolean)].join("\n")
}

export const RESULTS_HEAD = "Автоотчёт дашборда: прогоны, которые запустил владелец, закончились. Итоги — в конце сообщения."
export const RESULTS_RULES = prompt("results-rules")

export const DECISION_HELP = prompt("decision-help")

export const RESULTS_MARK = "──────── ИТОГИ ────────"

/** lines — строки «- задача: ИТОГ, N с»; bad — блоки причин (выжимки); hint — следующая станция (если всё зелёное). */
export function resultsMessage({ lines = [], bad = [], hint = "" }) {
  return [RESULTS_HEAD, RESULTS_RULES, DECISION_HELP, RESULTS_MARK, lines.join("\n"), ...bad, hint].filter(Boolean).join("\n\n")
}

export const REPORT_RULES = prompt("report-rules")

export function reportMessage({ word, what, dir, cmd, exit, excerpt }) {
  return [REPORT_RULES, RESULTS_MARK, "Итог: " + word + ".", "Что запускали: " + what, "Папка: " + dir, "Команда: " + cmd, exit, "", excerpt].join("\n")
}

/** Задачи проекта для подсказки «ПРОГНАТЬ»: id по алфавиту (порядок не плавает); задача с вводом — с «=фильтр». */
export const taskHint = (tasks = PROJECT.tasks) => Object.values(tasks).map((t) => t.id + (t.input ? "=" + (t.input.placeholder ? "<" + t.input.label + ">" : "фильтр") : "")).sort().join(", ")

export const FACTS_RULES_FULL = prompt("facts-rules", { tasks: taskHint(), epicCli: EPIC_CLI })

export const FACTS_RULES_SHORT = "Сверь слова слота со справкой; прогон ставь сам строкой «ПРОГНАТЬ ПN: задача=фильтр»; владельцу — только решения."

export const REVIEW_RULES = prompt("review-rules")

export function reviewPrompt({ br, plan = "", prev = "" }) {
  return [REVIEW_RULES, "ВЕТКА: " + br,
    plan ? "ПЛАН ВОЛНЫ:\n" + plan : "Плана волны не нашлось: суди по диффу и правилам.",
    prev ? "ПРОШЛЫЙ КРУГ РЕВЬЮ и ответ автора:\n" + prev : ""].filter(Boolean).join("\n\n")
}

/** Слова станций слота (verdict снимка): справка о слоте и вводная новой сессии говорят о станциях одинаково. */
export const VERDICT_WORDS = {
  ok: "зелёная на текущем коде",
  green: "зелёные на текущем коде",
  fail: "КРАСНЫЕ",
  stale: "были на ДРУГОМ коде, файлы менялись после прогона",
  nobuild: "зелёные, но без сборки на этом коде",
  none: "НЕ ПРОГОНЯЛИСЬ",
  notneeded: "не нужны",
  requested: "попросили перепрогнать",
}

/**
 * Строка о слоте для вводной оркестратора — по снимку диспетчерской, а не по словам агентов.
 * t — дерево снимка (tag, key, branch, exists, ahead, verdict, train, wagon); agent — "busy" | "idle" | "session" | "".
 */
export function slotStateLine(t, agent = "", extra = []) {
  const v = t.verdict || {}, w = (x) => VERDICT_WORDS[x] || x || "?"
  const head = (t.tag || "?") + " " + t.key + " (ветка " + (t.branch || "?") + (t.train ? ", поезд" + (t.wagon ? ", вагон " + t.wagon : "") : "") + "): "
  if (!t.exists) return head + "папки слота нет (не подготовлен или убран)" + (extra.length ? "; " + extra.join("; ") : "") + "."
  const st = !t.verdict ? ["станций в снимке диспетчерской ещё нет"]
    : v.merged && !(t.ahead > 0) ? ["влита в staging"]
    : [t.ahead ? "впереди staging " + t.ahead + " коммит(а)" : "впереди staging коммитов нет",
      "сборка — " + w(v.build) + ", тесты волны — " + w(v.tests) + ", гарды — " + w(v.guards) + (v.regress ? ", регресс — " + w(v.regress) : "")]
  const ag = { busy: "агент отвечает", idle: "агент запущен и ждёт", session: "агент не запущен, сессия есть" }[agent] || "агента нет"
  return head + [...st, ag, ...extra].join("; ") + "."
}

/**
 * Вводная новой сессии оркестратора после ротации: память и порядок — первыми, номер сессии и токены — в конце.
 * Всё ниже правил — факты диспетчерской на момент ротации: строки слотов, открытые вопросы владельцу ({ who, text }),
 * ожидания влива по слову владельца и сообщения владельца, на которые прошлая сессия не ответила, — целиком.
 * Ответов прошлой сессии здесь нет намеренно: их обрывки новая сессия читала как действующие решения.
 */
export function orchPrimer({ ep, orchDir, prevId = "", ctx = 0, slots = [], questions = [], waits = [], owner = [] }) {
  const list = (head, xs) => (xs.length ? head + "\n" + xs.join("\n") : "")
  return [prompt("orch-primer", { ep, orchDir }),
    list("Слоты эпика:", slots.map((x) => "- " + x)),
    list("Открытые вопросы владельцу (ещё без ответа):", questions.map((q) => "- " + q.who + ": " + q.text)),
    list("Слово владельца, ещё не исполненное:", waits.map((x) => "- " + x)),
    list("Сообщения владельца, на которые прошлая сессия не ответила (целиком):", owner.map((x) => "— " + x)),
    "Прошлая сессия: " + String(prevId || "?").slice(0, 8) + ", " + Math.round((ctx || 0) / 1000) + " тыс. токенов контекста."].filter(Boolean).join("\n\n")
}
