// prompt.test.mjs — постоянное начало сообщений и подсказок не «плавает» между ходами: правила первыми, меняющееся — в конце;
// в постоянной части нет меток слотов, дат и sha; задачи и пути — из конфига проекта, а не зашитые.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { EPIC_CLI, PROJECT } from "../slots.mjs"
import {
    DECISION_HELP,
    FACTS_RULES_FULL,
    FACTS_RULES_SHORT,
    REPORT_RULES,
    RESULTS_MARK,
    REVIEW_RULES,
    TOOLS_EXTRA,
    commonPrefix,
    orchPrimer,
    reportMessage,
    resultsMessage,
    reviewPrompt,
    taskHint,
    toolsSection,
} from "./prompt.mjs"

describe("префикс не плавает", () => {
  test("итоги прогонов: два сбора при разных итогах — одно и то же начало до метки «ИТОГИ» включительно", () => {
    const a = resultsMessage({ lines: ["- API: тесты — wv-0986: УПАЛ, 289 с"], bad: ["── API: причина ──\nИтог: Tests: 8 failed"] })
    const b = resultsMessage({ lines: ["- Сборка: ЗЕЛЁНЫЙ, 61 с", "- Витрина: тесты — wv-0984: ЗЕЛЁНЫЙ, 62 с"], bad: [], hint: "Следующая станция: ревью" })
    const head = a.slice(0, a.indexOf(RESULTS_MARK) + RESULTS_MARK.length)
    assert.ok(commonPrefix(a, b) >= head.length, commonPrefix(a, b) + " < " + head.length)
    assert.ok(a.startsWith(head) && b.startsWith(head))
    assert.ok(head.includes(DECISION_HELP))
  })
  test("отчёт кнопкой: правила первыми, итог и выжимка — после метки", () => {
    const a = reportMessage({ word: "УПАЛ", what: "api-test — wv-1", dir: "/w/a", cmd: "x", exit: "Код выхода 1, 3 с.", excerpt: "Итог: …" })
    const b = reportMessage({ word: "ЗЕЛЁНЫЙ", what: "web-test — wv-2", dir: "/w/b", cmd: "y", exit: "Код выхода 0, 9 с.", excerpt: "" })
    assert.ok(commonPrefix(a, b) >= (REPORT_RULES + "\n" + RESULTS_MARK).length)
  })
  test("ревью: правила, порог и формат одинаковы для любых ветки, плана и прошлого круга", () => {
    const a = reviewPrompt({ br: "dev/wv-0984-help", plan: "план 1" }), b = reviewPrompt({ br: "dev/wv-0986-lead", plan: "", prev: "— Вердикт ВОПРОСЫ" })
    assert.ok(commonPrefix(a, b) >= REVIEW_RULES.length)
    assert.doesNotMatch(REVIEW_RULES, /wv-\d{4}|\d{2}\.\d{2}/i)
  })
  test("вводная оркестратора: номер старой сессии и токены — не в начале", () => {
    const a = orchPrimer({ ep: "e1", orchDir: "/w/o", prevId: "aaaaaaaa-1", ctx: 512000 }), b = orchPrimer({ ep: "e1", orchDir: "/w/o", prevId: "bbbbbbbb-2", ctx: 640000, asked: ["влей"] })
    assert.ok(commonPrefix(a, b) > a.indexOf("Прошлая сессия:") - 1)
  })
  test("постоянные тексты — без меток слотов, дат и sha", () => {
    for (const s of [DECISION_HELP.replace("СЛОТУ П6", ""), FACTS_RULES_FULL.replace(/П4|ПN/g, ""), FACTS_RULES_SHORT.replace(/ПN/g, ""), REPORT_RULES, toolsSection(), toolsSection({ slot: true })]) {
      assert.doesNotMatch(s, /(^|[^А-ЯЁа-яё])П\d+|\b\d{1,2}\.\d{2}\.\d{4}\b|\b[0-9a-f]{10,40}\b/)
    }
  })
  test("раздел «Инструменты»: одинаков между сборками; строки других инструментов (TOOLS_EXTRA) — в конце раздела", () => {
    assert.equal(toolsSection({ slot: true }), toolsSection({ slot: true }))
    const before = toolsSection()
    TOOLS_EXTRA.push("- ещё инструмент: …")
    const after = toolsSection()
    TOOLS_EXTRA.pop()
    assert.ok(after.startsWith(before) && after.endsWith("- ещё инструмент: …"))
    assert.match(toolsSection(), /dash-log\.mjs jNNN --grep/)
    assert.match(toolsSection(), /\/logs\/jNNN\.log/)
  })
})

describe("из конфига проекта", () => {
  test("задачи для «ПРОГНАТЬ» — из PROJECT.tasks по алфавиту, с вводом — с фильтром; команда эпика — EPIC_CLI", () => {
    const h = taskHint()
    assert.deepEqual(h.split(", ").map((x) => x.split("=")[0]), Object.keys(PROJECT.tasks).sort())
    assert.match(h, /api-test=<шаблон пути>/); assert.match(h, /web-test=фильтр/); assert.match(h, /(^|, )lint(,|$)/)
    assert.ok(FACTS_RULES_FULL.includes(h)); assert.ok(FACTS_RULES_FULL.includes(EPIC_CLI + " presets"))
  })
})
