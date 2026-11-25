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

/** Вводная новой сессии оркестратора после ротации: память и порядок — первыми, номер сессии и токены — в конце. */
export function orchPrimer({ ep, orchDir, prevId = "", ctx = 0, asked = [], said = [] }) {
  return [prompt("orch-primer", { ep, orchDir }),
    "Прошлая сессия: " + String(prevId || "?").slice(0, 8) + ", " + Math.round((ctx || 0) / 1000) + " тыс. токенов контекста.",
    asked.length ? "Последние сообщения владельца:\n" + asked.map((x) => "— " + x).join("\n") : "",
    said.length ? "Твои последние ответы в прошлой сессии (для связности; решения — в файлах плана):\n" + said.map((x) => "— " + x).join("\n\n") : ""].filter(Boolean).join("\n\n")
}
