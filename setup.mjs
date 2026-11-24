#!/usr/bin/env node
// setup.mjs — стартовая настройка диспетчерской под проект. Три шага, их ведёт агент по SETUP.md:
//   detect  — что о проекте видно без вопросов и что осталось спросить у человека;
//   apply   — из ответов собрать dispatcher.project.json и стартовые переключатели, разложить навыки агента;
//   doctor  — проверить установку.
// Ничего не делает молча: detect и doctor только читают, apply пишет три файла и перечисляет их.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { projectFile, validateProject, normalizeProject, formatIssues, fwd } from "./scripts/dev/project.mjs"
import { detectFacts, suggestAnswers } from "./setup/detect.mjs"
import { loadQuiz, planQuestions, buildProject, mergeAnswers } from "./setup/build.mjs"
import { runDoctor, formatDoctor, ensureRoleBranches } from "./setup/doctor.mjs"
import { installSkills, skillsDir } from "./setup/skills.mjs"

/** Прежние ответы человека — чтобы повторная настройка не переспрашивала: папка project/ рядом с конфигом (вне git). */
export const answersFileFor = (env = process.env) => path.join(path.dirname(projectFile(env)), "project", "answers.json")
export const ANSWERS_FILE = answersFileFor()

const USAGE = `Настройка диспетчерской под проект.

  node setup.mjs detect --repo <путь к проекту> [--json] [--fresh]
      Что определилось само и что спросить у человека. --fresh — забыть прежние ответы.

  node setup.mjs apply --repo <путь к проекту> --answers <файл.json> [--force] [--branches] [--dry-run] [--accept-suggested]
      Собрать dispatcher.project.json. --force — перезаписать существующий (прежний сохранится рядом как .prev);
      --branches — создать в проекте локальные ветки-роли staging и main; --dry-run — показать и ничего не писать;
      --accept-suggested — принять предложенные ответы на незаданные вопросы (без человека так не делать).

  node setup.mjs doctor [--net] [--json]
      Проверить установку. --net — проверить ssh до удалённых машин.
`

export function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) { out._.push(a); continue }
    const eq = a.indexOf("=")
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue }
    const key = a.slice(2), next = argv[i + 1]
    if (["repo", "answers"].includes(key) && next !== undefined && !next.startsWith("--")) { out[key] = next; i++ } else out[key] = true
  }
  return out
}

const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
const readPrev = (file = ANSWERS_FILE) => { try { return readJsonFile(file) } catch { return {} } }
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n") }

function requireRepo(args) {
  if (typeof args.repo !== "string") throw new Error("нужен путь к проекту: --repo <путь>")
  const repo = path.resolve(args.repo)
  if (!fs.existsSync(repo)) throw new Error("папки проекта нет: " + fwd(repo))
  return fwd(repo)
}

/** Шаг 1. */
export function detect({ repo, fresh = false, env = process.env, answersFile = answersFileFor(env) }) {
  const facts = detectFacts(repo, { env })
  const suggestions = suggestAnswers(facts, fresh ? {} : readPrev(answersFile))
  const { ask, known } = planQuestions(loadQuiz(), suggestions, { facts })
  return { repo: facts.repo, configFile: fwd(projectFile(env)), configExists: fs.existsSync(projectFile(env)), facts, known, ask }
}

function formatDetect(r) {
  const lines = [`Проект: ${r.repo}`, ""]
  if (!r.facts.git.isRepo) lines.push("✖ Это не репозиторий git — диспетчерская работает только с git.", "")
  lines.push("Определилось само:")
  for (const k of r.known) lines.push(`  ${k.id} = ${JSON.stringify(k.value)}${k.why ? "   (" + k.why + ")" : ""}`)
  lines.push("", `Спросить у человека (${r.ask.length}):`)
  let block = ""
  for (const q of r.ask) {
    if (q.block !== block) { block = q.block; lines.push("", "— " + block) }
    lines.push(`  [${q.id}] ${q.text}`)
    if (q.suggested !== undefined && q.suggested !== "") lines.push(`      предложение: ${JSON.stringify(q.suggested)}${q.suggestedWhy ? "   (" + q.suggestedWhy + ")" : ""}`)
    if (q.dependsOn) lines.push(`      только если непусто: ${q.dependsOn}`)
  }
  lines.push("", r.configExists ? `Конфиг уже есть: ${r.configFile} — apply перезапишет его только с --force.` : `Конфига ещё нет: ${r.configFile}`)
  return lines.join("\n")
}

/** Шаг 2. Возвращает, что записано; при ошибках бросает исключение со списком. */
export function apply({ repo, given, force = false, branches = false, dryRun = false, acceptSuggested = false, env = process.env, answersFile = answersFileFor(env) }) {
  const facts = detectFacts(repo, { env })
  if (!facts.git.isRepo) throw new Error(`${facts.repo} — не репозиторий git`)
  const prev = readPrev(answersFile)
  const human = { ...prev, ...given }
  const suggestions = suggestAnswers(facts, human)
  // Вопрос, который положено задать человеку, не закрывается предложением молча.
  const { ask } = planQuestions(loadQuiz(), suggestAnswers(facts, {}), { facts })
  const filled = (v) => Array.isArray(v) ? v.length > 0 : v != null && v !== "" && v !== false && v !== "none"
  const unanswered = ask.filter((q) => !(q.id in human) && !(q.dependsOn && q.dependsOn in human && !filled(human[q.dependsOn]))).map((q) => q.id)
  if (unanswered.length && !acceptSuggested) throw new Error("нет ответов на вопросы: " + unanswered.join(", ") + "\nЗадайте их человеку и добавьте в файл ответов. Принять предложенное без вопроса — флаг --accept-suggested.")

  const { project, settings, problems } = buildProject({ repo: facts.repo, answers: mergeAnswers(suggestions, human), facts })
  if (problems.length) throw new Error("конфиг не собрать:\n" + problems.map((p) => "  • " + p).join("\n"))
  const { errors, warnings } = validateProject(project)
  if (errors.length) throw new Error("собранный конфиг не прошёл проверку:\n" + formatIssues(errors))

  const file = projectFile(env)
  const normalized = normalizeProject(project, { baseDir: path.dirname(file), file })
  const settingsFile = path.join(normalized.repo.data, "settings.json")
  const written = []
  if (dryRun) return { project, settings, warnings, written, file: fwd(file), dryRun: true, branches: [], skills: [] }
  if (fs.existsSync(file)) {
    if (!force) throw new Error(`конфиг уже есть: ${fwd(file)}\nПерезаписать — флаг --force (прежний сохранится как ${path.basename(file)}.prev).`)
    fs.copyFileSync(file, file + ".prev"); written.push(fwd(file + ".prev"))
  }
  writeJson(file, project); written.push(fwd(file))
  writeJson(answersFile, human); written.push(fwd(answersFile))
  if (!fs.existsSync(settingsFile)) { writeJson(settingsFile, settings); written.push(fwd(settingsFile)) }
  // навыки — в каталог рантайма агента, с путём этого дома диспетчерской вместо заглушки
  const skills = installSkills({ runtime: normalized.agent.runtime, dir: skillsDir(normalized.agent.runtime, env) })
  return { project, settings, warnings, written, file: fwd(file), dryRun: false, branches: branches ? ensureRoleBranches(normalized) : [], skills }
}

async function main(argv) {
  const args = parseArgs(argv)
  const cmd = args._[0]
  if (cmd === "detect") {
    const r = detect({ repo: requireRepo(args), fresh: !!args.fresh })
    console.log(args.json ? JSON.stringify(r, null, 2) : formatDetect(r))
    return 0
  }
  if (cmd === "apply") {
    if (typeof args.answers !== "string") throw new Error("нужен файл ответов: --answers <файл.json>")
    const given = readJsonFile(path.resolve(args.answers))
    const r = apply({ repo: requireRepo(args), given, force: !!args.force, branches: !!args.branches, dryRun: !!args["dry-run"], acceptSuggested: !!args["accept-suggested"] })
    if (r.dryRun) { console.log("Сухой прогон — ничего не записано. Конфиг был бы таким:\n" + JSON.stringify(r.project, null, 2) + "\n\nПереключатели:\n" + JSON.stringify(r.settings, null, 2)); return 0 }
    console.log("Записано:\n" + r.written.map((f) => "  " + f).join("\n"))
    if (r.warnings.length) console.log("\nПредупреждения:\n" + formatIssues(r.warnings))
    for (const b of r.branches) console.log(`Ветка-роль ${b.role} → ${b.want}: ${b.created ? "создана" : b.state === "ok" ? "уже есть" : "не создана (" + b.state + ")"}`)
    const sk = r.skills.filter((x) => x.status !== "skipped")
    if (sk.length) console.log("\nНавыки агента (" + path.dirname(path.dirname(sk[0].file)) + "): " + sk.map((x) => x.name + (x.status === "written" ? "" : x.status === "same" ? " (без изменений)" : " (НЕ тронут: там чужой навык с этим именем)")).join(", "))
    console.log("\nПроверка установки:\n")
    const d = await runDoctor({})
    console.log(formatDoctor(d))
    return d.ok ? 0 : 1
  }
  if (cmd === "doctor") {
    const d = await runDoctor({ net: !!args.net })
    console.log(args.json ? JSON.stringify({ ok: d.ok, checks: d.checks, modules: d.modules }, null, 2) : formatDoctor(d))
    return d.ok ? 0 : 1
  }
  console.log(USAGE)
  return cmd ? 2 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (e) => { console.error("✖ " + e.message); process.exitCode = 1 })
}
