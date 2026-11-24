// build.mjs — из ответов квиза собрать конфиг проекта и стартовые переключатели.
// Чистые функции: ничего не читают с диска, кроме файла вопросов, и ничего не пишут.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { SCHEMA } from "../scripts/dev/project.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const QUIZ_FILE = path.join(HERE, "quiz.json")
export const loadQuiz = (file = QUIZ_FILE) => JSON.parse(fs.readFileSync(file, "utf8"))

/** Ответы, которые сборка читает. Сверяется с quiz.json тестом в обе стороны: вопрос без сборки и сборка без вопроса — ошибка. */
export const ANSWER_IDS = [
  "project.name", "repo.worktrees",
  "git.remote", "git.integration", "git.production", "git.pushDeploys",
  "areas", "tasks", "slotPrepare", "deny.edit", "deny.commands",
  "ci.kind", "ci.runners",
  "machines.localWorkers", "limits.slots", "machines.remote", "tests.services",
  "stand.run", "stand.url", "accept.run", "prod.run", "prod.verify",
  "agent.runtime", "agent.models", "agent.proxy", "agent.network",
  "autonomy", "modules.tg", "modules.optional",
]

const filled = (v) => Array.isArray(v) ? v.length > 0 : v != null && v !== "" && v !== false && v !== "none" // «none» (нет CI) — тоже пусто: зависимые вопросы не нужны

/**
 * Что спросить у человека.
 * Вопрос задаётся, если он `always`, либо `auto` и ответ не определился уверенно. Прежний ответ (повторная настройка)
 * не переспрашивается. Условие `when` проверяется по уже известным ответам: пока родительский ответ пуст или неизвестен
 * с уверенностью, зависимый вопрос помечается `dependsOn` — агент задаёт его, только если родитель оказался непустым.
 * @returns {{ask:object[], known:object[]}}
 */
export function planQuestions(quiz, suggestions, { facts = null } = {}) {
  const ask = [], known = []
  const blockTitle = Object.fromEntries(quiz.blocks.map((b) => [b.id, b.title]))
  for (const q of quiz.questions) {
    const s = suggestions[q.id]
    const base = { id: q.id, block: blockTitle[q.block] || q.block, type: q.type, text: q.text, why: q.why }
    if (q.options) base.options = q.options
    if (q.optionsFrom && facts) base.options = optionsFrom(q.optionsFrom, facts, suggestions)
    if (s && s.value !== undefined) { base.suggested = s.value; if (s.why) base.suggestedWhy = s.why }
    if (q.when) {
      const parent = suggestions[q.when]
      if (parent && parent.confidence !== "low" && !filled(parent.value)) continue // родитель уверенно пуст — вопрос не нужен
      base.dependsOn = q.when
    }
    const settled = s && (s.confidence === "prev" || (s.confidence === "high" && q.ask !== "always") || q.ask === "never")
    if (settled) known.push({ id: q.id, value: s.value, why: s.why || "" })
    else ask.push(base)
  }
  return { ask, known }
}

function optionsFrom(source, facts, suggestions) {
  if (source === "git.remotes") return facts.git.remotes.map((r) => r.name)
  if (source === "git.remoteBranches") {
    const remote = (suggestions["git.remote"] && suggestions["git.remote"].value) || (facts.git.remotes[0] && facts.git.remotes[0].name) || ""
    return (facts.git.remoteBranches[remote] || []).slice(0, 30)
  }
  return []
}

// selfCommit — коммиты агента слота: word — только по слову человека, station — сам после каждой станции плана.
const AUTONOMY = {
  manual: { selfCommit: "word", autoCommit: false, autoMerge: false, autoTrain: false, autoSyncConflict: false },
  commit: { selfCommit: "station", autoCommit: true, autoMerge: false, autoTrain: false, autoSyncConflict: false },
  merge: { selfCommit: "station", autoCommit: true, autoMerge: true, autoTrain: true, autoSyncConflict: true },
}

/**
 * Собрать конфиг проекта.
 * @param repo абсолютный путь к репозиторию проекта
 * @param answers плоский объект { "<id вопроса>": значение } — определённое и отвеченное вместе
 * @returns {{project:object, settings:object, problems:string[]}} `problems` — чего не хватает, чтобы собрать
 */
export function buildProject({ repo, answers, facts = null }) {
  const problems = []
  const A = (id, fallback) => answers[id] === undefined || answers[id] === null ? fallback : answers[id]
  const need = (id, what) => { const v = A(id, ""); if (!filled(v)) problems.push(`нет ответа \`${id}\` — ${what}`); return v }
  for (const id of Object.keys(answers)) if (!ANSWER_IDS.includes(id)) problems.push(`неизвестный ответ \`${id}\` — такого вопроса нет`)

  const production = String(A("git.production", "") || "").trim()
  const standRun = String(A("stand.run", "") || "").trim()
  const pushDeploys = production ? !!A("git.pushDeploys", false) : false
  const prodRun = production ? String(A("prod.run", "") || "").trim() : ""
  const acceptRun = standRun ? String(A("accept.run", "") || "").trim() : ""
  const remoteMachines = A("machines.remote", [])
  const services = A("tests.services", [])
  const optional = A("modules.optional", ["review", "backlog"])
  const autonomy = A("autonomy", "manual")
  if (!AUTONOMY[autonomy]) problems.push("`autonomy` — один из: " + Object.keys(AUTONOMY).join(", "))
  if (!Array.isArray(remoteMachines)) problems.push("`machines.remote` — список машин")
  if (!Array.isArray(services)) problems.push("`tests.services` — список служб")
  if (!Array.isArray(optional)) problems.push("`modules.optional` — список id модулей")

  const machines = { local: { workers: A("machines.localWorkers", 1), ...(Array.isArray(services) && services.length ? { services } : {}) } }
  if (Array.isArray(remoteMachines)) for (const m of remoteMachines) {
    if (!m || !m.id) { problems.push("у машины в `machines.remote` нет `id`"); continue }
    const { id, ...rest } = m
    machines[id] = rest
  }

  const project = {
    schema: SCHEMA,
    name: need("project.name", "название проекта"),
    repo: {
      main: repo,
      worktrees: A("repo.worktrees", repo + "-wt"),
      remote: need("git.remote", "имя remote"),
      upstream: { staging: need("git.integration", "интеграционная ветка"), main: production || null },
    },
    agent: { runtime: A("agent.runtime", "claude"), ...(A("agent.proxy", "") ? { proxy: A("agent.proxy", "") } : {}), ...(A("agent.network", false) ? { network: true } : {}), ...(Object.keys(A("agent.models", {})).length ? { models: A("agent.models", {}) } : {}) },
    areas: A("areas", {}),
    deny: { commands: A("deny.commands", []), edit: A("deny.edit", []) },
    slotPrepare: A("slotPrepare", []).map((s) => typeof s === "string" ? { run: s } : s),
    tasks: A("tasks", {}),
    machines,
    limits: { slots: A("limits.slots", 3) },
    ci: { kind: A("ci.kind", "none"), ...(A("ci.runners", "") ? { runners: A("ci.runners", "") } : {}), ...(facts && facts.ci.files.length ? { files: facts.ci.files } : {}) },
  }
  if (standRun || prodRun || pushDeploys) {
    project.release = {}
    if (standRun) project.release.stand = { run: standRun, ...(A("stand.url", "") ? { url: A("stand.url", "") } : {}) }
    if (prodRun || pushDeploys || A("prod.verify", "")) project.release.prod = { ...(prodRun ? { run: prodRun } : {}), ...(production && A("prod.verify", "") ? { verify: A("prod.verify", "") } : {}), pushDeploys }
  }
  if (acceptRun) project.accept = { run: acceptRun, ...(A("stand.url", "") ? { standUrl: A("stand.url", "") } : {}) }

  const opt = Array.isArray(optional) ? optional : []
  project.modules = {
    review: opt.includes("review"), backlog: opt.includes("backlog"), retro: opt.includes("retro"),
    machines: Object.keys(machines).length > 1,
    release: !!project.release, accept: !!project.accept,
    tg: !!A("modules.tg", false), "win-desktop": opt.includes("win-desktop"),
  }

  // Стартовые переключатели поведения: всё, что действует без человека, включается только выбранным режимом автономии.
  const settings = { ...(AUTONOMY[autonomy] || AUTONOMY.manual), fullPermissions: false, autoResults: true, tgBot: project.modules.tg }
  return { project, settings, problems }
}

/** Ответы из предложений (то, что определилось) поверх которых ложатся ответы человека. */
export const mergeAnswers = (suggestions, given = {}) => ({ ...Object.fromEntries(Object.entries(suggestions).map(([id, s]) => [id, s.value])), ...given })
