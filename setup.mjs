#!/usr/bin/env node
// setup.mjs — стартовая настройка диспетчерской под проект. Три шага, их ведёт агент по SETUP.md:
//   detect  — что о проекте видно без вопросов и что осталось спросить у человека;
//   apply   — из ответов собрать dispatcher.project.json и стартовые переключатели, разложить навыки агента;
//   doctor  — проверить установку.
// Второй и следующие проекты — `add`: те же detect и apply, но конфиг ложится в projects/<id>/ и вписывается в дом
// (dispatcher.home.json); `list` и `remove` — список проектов дома и снятие проекта из дома (данные не трогаются).
// Ничего не делает молча: detect, doctor и list только читают, apply и add перечисляют записанные файлы.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  CORE_PORT_FROM, HOME_FILE_NAME, HUB_PORT, ID_RE, SCHEMA, formatIssues, fwd, homeDir, homeExists, homeFile,
  legacyProjectFile, loadHome, loadProject, normalizeProject, projectFile, validateProject,
} from "./scripts/dev/project.mjs"
import { samePath } from "./scripts/dev/paths.mjs"
import { detectFacts, suggestAnswers, toId } from "./setup/detect.mjs"
import { SHARED_IDS, buildProject, forHome, loadQuiz, mergeAnswers, planQuestions } from "./setup/build.mjs"
import { ensureRoleBranches, formatDoctor, formatHomeDoctor, runDoctor, runHomeDoctor } from "./setup/doctor.mjs"
import { installSkills, skillsDir } from "./setup/skills.mjs"

/** Прежние ответы человека — чтобы повторная настройка не переспрашивала: папка project/ рядом с конфигом (вне git). */
export const answersFileFor = (env = process.env, file = projectFile(env)) => path.join(path.dirname(file), "project", "answers.json")

const USAGE = `Настройка диспетчерской под проект.

  node setup.mjs detect --repo <путь к проекту> [--json] [--fresh]
      Что определилось само и что спросить у человека. --fresh — забыть прежние ответы.

  node setup.mjs apply --repo <путь к проекту> --answers <файл.json> [--force] [--branches] [--dry-run] [--accept-suggested]
      Собрать dispatcher.project.json. --force — перезаписать существующий (прежний сохранится рядом как .prev);
      --branches — создать в проекте локальные ветки-роли staging и main; --dry-run — показать и ничего не писать;
      --accept-suggested — принять предложенные ответы на незаданные вопросы (без человека так не делать).

  node setup.mjs add --repo <путь к проекту> [--id <id>] [--light] [--json] [--fresh]
  node setup.mjs add --repo <путь к проекту> --answers <файл.json> [--id <id>] [--light] [--force] [--branches] [--dry-run]
      Второй и следующий проект: без --answers — что спросить (общее — машины, агент, предел — берётся из дома);
      с --answers — конфиг в projects/<id>/ и строка в dispatcher.home.json. Первый add создаёт дом, а прежний
      dispatcher.project.json входит в него ссылкой, без переноса. --light — лёгкий режим (в разработке).

  node setup.mjs list [--json]                  проекты дома: id, порт, конфиг
  node setup.mjs remove --id <id>               снять проект с дома (конфиг, данные и ветки не трогаются)

  node setup.mjs doctor [--net] [--json] [--project <id>]
      Проверить установку; в доме — дом и каждый проект (--project — один). --net — проверить ssh до удалённых машин.
`

export function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) { out._.push(a); continue }
    const eq = a.indexOf("=")
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue }
    const key = a.slice(2), next = argv[i + 1]
    if (["repo", "answers", "id", "project"].includes(key) && next !== undefined && !next.startsWith("--")) { out[key] = next; i++ } else out[key] = true
  }
  return out
}

const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
const readPrev = (file) => { try { return readJsonFile(file) } catch { return {} } }
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n") }

function requireRepo(args) {
  if (typeof args.repo !== "string") throw new Error("нужен путь к проекту: --repo <путь>")
  const repo = path.resolve(args.repo)
  if (!fs.existsSync(repo)) throw new Error("папки проекта нет: " + fwd(repo))
  return fwd(repo)
}

/** Шаг 1. skip — вопросы, которые не задаются (у проекта дома общее берётся из дома). */
export function detect({ repo, fresh = false, env = process.env, file = projectFile(env), answersFile = answersFileFor(env, file), skip = [] }) {
  const facts = detectFacts(repo, { env })
  const suggestions = suggestAnswers(facts, fresh ? {} : readPrev(answersFile))
  const { ask, known } = planQuestions(loadQuiz(), suggestions, { facts })
  const keep = (q) => !skip.includes(q.id)
  return { repo: facts.repo, configFile: fwd(file), configExists: fs.existsSync(file), facts, known: known.filter(keep), ask: ask.filter(keep) }
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

/**
 * Шаг 2. Возвращает, что записано; при ошибках бросает исключение со списком.
 * file — куда писать конфиг; skip — незаданные вопросы (общее дома); shape — правка собранного конфига перед проверкой
 * (у проекта дома — снять общее); skills: false — навыки раскладывает вызывающий (add — после записи дома).
 */
export function apply({
  repo, given, force = false, branches = false, dryRun = false, acceptSuggested = false, env = process.env,
  file = projectFile(env), answersFile = answersFileFor(env, file), skip = [], shape = (p) => p, skills = true,
}) {
  const facts = detectFacts(repo, { env })
  if (!facts.git.isRepo) throw new Error(`${facts.repo} — не репозиторий git`)
  const prev = readPrev(answersFile)
  const human = { ...prev, ...given }
  const suggestions = suggestAnswers(facts, human)
  // Вопрос, который положено задать человеку, не закрывается предложением молча.
  const { ask } = planQuestions(loadQuiz(), suggestAnswers(facts, {}), { facts })
  const filled = (v) => Array.isArray(v) ? v.length > 0 : v != null && v !== "" && v !== false && v !== "none"
  const unanswered = ask
    .filter((q) => !skip.includes(q.id) && !(q.id in human) && !(q.dependsOn && q.dependsOn in human && !filled(human[q.dependsOn])))
    .map((q) => q.id)
  if (unanswered.length && !acceptSuggested)
    throw new Error(
      "нет ответов на вопросы: " +
        unanswered.join(", ") +
        "\nЗадайте их человеку и добавьте в файл ответов. Принять предложенное без вопроса — флаг --accept-suggested.",
    )

  const built = buildProject({ repo: facts.repo, answers: mergeAnswers(suggestions, human), facts })
  if (built.problems.length) throw new Error("конфиг не собрать:\n" + built.problems.map((p) => "  • " + p).join("\n"))
  const project = shape(built.project), settings = built.settings
  const { errors, warnings } = validateProject(project)
  if (errors.length) throw new Error("собранный конфиг не прошёл проверку:\n" + formatIssues(errors))

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
  const sk = skills ? installSkills({ runtime: normalized.agent.runtime, dir: skillsDir(normalized.agent.runtime, env) }) : []
  return { project, settings, warnings, written, file: fwd(file), dryRun: false, branches: branches ? ensureRoleBranches(normalized) : [], skills: sk }
}

// ───────────────────────────── дом: второй и следующие проекты ─────────────────────────────

/** Сырой дом с диска (проверенный loadHome) или заготовка нового: строки дома правятся сами по себе, без нормализации. */
function rawHome(hf) {
  if (!fs.existsSync(hf)) return null
  loadHome({ file: hf }) // сломанный дом не дописывается: сначала его чинят по `doctor`
  return readJsonFile(hf)
}

/** Первый свободный порт процесса проекта: не хаба, не пробного экземпляра (4786) и не другого проекта. */
export function nextCorePort(home) {
  const used = new Set([(home.hub && home.hub.port) || HUB_PORT, 4786, ...home.projects.map((e) => e.port)])
  let p = CORE_PORT_FROM
  while (used.has(p)) p++
  return p
}

/** Путь к конфигу проекта для строки дома: внутри папки дома — относительный, иначе абсолютный. */
const homeRel = (dir, file) => { const r = path.relative(dir, file); return r && !r.startsWith("..") && !path.isAbsolute(r) ? fwd(r) : fwd(file) }

/**
 * Новый дом: проектов пока нет. Есть прежний dispatcher.project.json — он входит в дом ссылкой (id — слаг названия),
 * а его агент и предел копируются в общее: так новые проекты получают те же рантайм, модели и предел, а сам прежний
 * конфиг не меняется. Прежнего нет — общее из предложений detect (рантайм в PATH, предел по памяти машины).
 */
function newHome(env, facts) {
  const home = { schema: SCHEMA, hub: { port: HUB_PORT }, shared: {}, projects: [] }
  const legacy = legacyProjectFile(env)
  if (fs.existsSync(legacy)) {
    const raw = readJsonFile(legacy)
    const { errors } = validateProject(raw)
    if (errors.length) throw new Error(`прежний конфиг ${fwd(legacy)} с ошибками — сначала почините его (node setup.mjs doctor):\n` + formatIssues(errors))
    const id = toId(raw.name || path.basename(String(raw.repo.main)))
    home.projects.push({ id, file: homeRel(homeDir(env), legacy), port: CORE_PORT_FROM })
    if (raw.agent && Object.keys(raw.agent).length) home.shared.agent = { ...raw.agent }
    if (raw.limits && raw.limits.slots) home.shared.limits = { slots: raw.limits.slots }
    return { home, adopted: id }
  }
  const s = suggestAnswers(facts)
  home.shared = { agent: { runtime: s["agent.runtime"].value }, limits: { slots: s["limits.slots"].value } }
  return { home, adopted: "" }
}

/**
 * Добавить проект в дом. Без `given` — только план вопросов (detect для проекта дома); с `given` — apply в
 * projects/<id>/ и строка в dispatcher.home.json. Повтор для того же id — только с force (перезапись конфига).
 */
export function addProject({
  repo, id = "", light = false, given = null, force = false, branches = false, dryRun = false, acceptSuggested = false, fresh = false, env = process.env,
}) {
  const hf = homeFile(env)
  if (!hf) throw new Error("файл дома не задан: под node --test нужна переменная DISPATCHER_HOME")
  const facts = detectFacts(repo, { env })
  const existing = rawHome(hf)
  const { home, adopted } = existing ? { home: existing, adopted: "" } : newHome(env, facts)
  const name = (given && given["project.name"]) || suggestAnswers(facts)["project.name"].value
  const pid = String(id || toId(name))
  if (!ID_RE.test(pid)) throw new Error(`id проекта «${pid}» — строчная латиница, цифры и дефис, с буквы (--id <id>)`)
  const dir = homeDir(env), same = home.projects.find((e) => e.id === pid)
  if (same && !force) throw new Error(`проект \`${pid}\` уже в доме (${same.file}). Перенастроить — флаг --force; другой проект — --id <id>.`)
  for (const e of home.projects) {
    if (e.id === pid) continue
    let p = null
    try { p = loadProject({ file: path.resolve(dir, e.file), fresh: true, env }) } catch { /* сломанный конфиг покажет doctor */ }
    if (p && samePath(p.repo.main, repo)) throw new Error(`этот репозиторий уже в доме проектом \`${e.id}\` — повтор только с --id ${e.id} --force`)
  }
  const file = same ? path.resolve(dir, same.file) : path.join(dir, "projects", pid, "dispatcher.project.json")
  const port = same ? same.port : nextCorePort(home)
  const answersFile = answersFileFor(env, file)
  const plan = { id: pid, port, file: fwd(file), homeFile: fwd(hf), homeCreated: !existing, adopted }
  const remoteMachines = Object.values((home.shared && home.shared.machines) || {}).some((m) => m && m.ssh)
  if (!given) return { ...plan, ...detect({ repo, fresh, env, file, answersFile, skip: SHARED_IDS }), mode: light ? "light" : "full" }

  const r = apply({
    repo, given: { ...given, ...(light ? { mode: "light" } : {}) }, force: force && !!same, branches, dryRun, acceptSuggested, env,
    file, answersFile, skip: SHARED_IDS, shape: (p) => forHome(p, { remoteMachines }), skills: false,
  })
  if (!same) home.projects.push({ id: pid, file: homeRel(dir, file), port })
  if (dryRun) return { ...plan, ...r, home }
  if (existing) fs.copyFileSync(hf, hf + ".prev")
  writeJson(hf, home)
  r.written.push(fwd(hf))
  // рантайм проекта — с общим из дома: навыки ложатся туда, где их ищет агент именно этого проекта
  const rt = loadProject({ file, fresh: true, env }).agent.runtime
  return { ...plan, ...r, home, skills: installSkills({ runtime: rt, dir: skillsDir(rt, env) }) }
}

/** Снять проект с дома: строка из dispatcher.home.json; конфиг, данные, папки слотов и ветки остаются. */
export function removeProject({ id, env = process.env }) {
  const hf = homeFile(env), home = hf && rawHome(hf)
  if (!home) throw new Error("дома нет (" + HOME_FILE_NAME + ") — снимать нечего")
  const e = home.projects.find((x) => x.id === id)
  if (!e) throw new Error(`в доме нет проекта \`${id}\`; есть: ${home.projects.map((x) => x.id).join(", ")}`)
  if (home.projects.length === 1) throw new Error(`\`${id}\` — последний проект дома. Без дома диспетчерская ведёт один проект: удалите ${fwd(hf)} сами.`)
  home.projects = home.projects.filter((x) => x.id !== id)
  fs.copyFileSync(hf, hf + ".prev")
  writeJson(hf, home)
  return { removed: e, homeFile: fwd(hf) }
}

/** Проекты дома и состояние их конфигов (для `list`). */
export function listProjects({ env = process.env } = {}) {
  const home = loadHome({ file: homeFile(env) })
  return home.projects.map((e) => {
    try { const p = loadProject({ file: e.file, fresh: true, env }); return { ...e, name: p.name, mode: p.mode, repo: p.repo.main, ok: true } }
    catch (err) { return { ...e, ok: false, error: err.message.split("\n")[0] } }
  })
}

// ───────────────────────────── командная строка ─────────────────────────────

const printSkills = (skills) => {
  const sk = skills.filter((x) => x.status !== "skipped")
  if (!sk.length) return
  const what = (x) => x.name + (x.status === "written" ? "" : x.status === "same" ? " (без изменений)" : " (НЕ тронут: там чужой навык с этим именем)")
  console.log("\nНавыки агента (" + path.dirname(path.dirname(sk[0].file)) + "): " + sk.map(what).join(", "))
}

function printApplied(r) {
  console.log("Записано:\n" + r.written.map((f) => "  " + f).join("\n"))
  if (r.warnings.length) console.log("\nПредупреждения:\n" + formatIssues(r.warnings))
  for (const b of r.branches) console.log(`Ветка-роль ${b.role} → ${b.want}: ${b.created ? "создана" : b.state === "ok" ? "уже есть" : "не создана (" + b.state + ")"}`)
  printSkills(r.skills)
}

const dryText = (r) => "Сухой прогон — ничего не записано. Конфиг был бы таким:\n" + JSON.stringify(r.project, null, 2) + "\n\nПереключатели:\n" + JSON.stringify(r.settings, null, 2)

/** Проверка установки: в доме — дом и все проекты (или один), без дома — как прежде, один конфиг. */
async function doctorNow(args, env = process.env) {
  if (!env.DISPATCHER_PROJECT && homeExists(env)) {
    const d = await runHomeDoctor({ net: !!args.net, env, only: typeof args.project === "string" ? args.project : "" })
    const json = { ok: d.ok, checks: d.checks, projects: d.projects.map((p) => ({ id: p.id, port: p.port, ok: p.ok, checks: p.checks, modules: p.modules })) }
    return { ok: d.ok, text: args.json ? JSON.stringify(json, null, 2) : formatHomeDoctor(d) }
  }
  const d = await runDoctor({ net: !!args.net })
  return { ok: d.ok, text: args.json ? JSON.stringify({ ok: d.ok, checks: d.checks, modules: d.modules }, null, 2) : formatDoctor(d) }
}

async function main(argv) {
  const args = parseArgs(argv)
  const cmd = args._[0]
  // в доме у каждого проекта своя папка: прежние detect и apply писали бы в общий dispatcher.project.json
  if ((cmd === "detect" || cmd === "apply") && homeExists() && !process.env.DISPATCHER_PROJECT)
    throw new Error("в доме проекты настраиваются командой add: node setup.mjs add --repo <путь> [--id <id>] (повторно — с --force)")
  if (cmd === "detect") {
    const r = detect({ repo: requireRepo(args), fresh: !!args.fresh })
    console.log(args.json ? JSON.stringify(r, null, 2) : formatDetect(r))
    return 0
  }
  if (cmd === "apply") {
    if (typeof args.answers !== "string") throw new Error("нужен файл ответов: --answers <файл.json>")
    const given = readJsonFile(path.resolve(args.answers))
    const r = apply({ repo: requireRepo(args), given, force: !!args.force, branches: !!args.branches, dryRun: !!args["dry-run"], acceptSuggested: !!args["accept-suggested"] })
    if (r.dryRun) { console.log(dryText(r)); return 0 }
    printApplied(r)
    console.log("\nПроверка установки:\n")
    const d = await doctorNow({})
    console.log(d.text)
    return d.ok ? 0 : 1
  }
  if (cmd === "add") {
    const opts = { repo: requireRepo(args), id: typeof args.id === "string" ? args.id : "", light: !!args.light, fresh: !!args.fresh }
    if (typeof args.answers !== "string") {
      const r = addProject(opts)
      const head = `Проект дома: ${r.id} (порт ${r.port}${r.mode === "light" ? ", лёгкий режим — в разработке" : ""}), конфиг ${r.file}\n` +
        (r.homeCreated ? `Дома ещё нет — add создаст ${r.homeFile}` + (r.adopted ? `; прежний dispatcher.project.json войдёт в него проектом \`${r.adopted}\`` : "") + ".\n" : "") +
        "Общее (машины, агент, предел агентов) — из дома, эти вопросы не задаются.\n\n"
      console.log(args.json ? JSON.stringify(r, null, 2) : head + formatDetect(r))
      return 0
    }
    const given = readJsonFile(path.resolve(args.answers))
    const r = addProject({ ...opts, given, force: !!args.force, branches: !!args.branches, dryRun: !!args["dry-run"], acceptSuggested: !!args["accept-suggested"] })
    if (r.dryRun) { console.log(dryText(r) + "\n\nДом:\n" + JSON.stringify(r.home, null, 2)); return 0 }
    printApplied(r)
    console.log(`\nПроект \`${r.id}\` в доме: порт ${r.port}.` + (r.adopted ? ` Прежний конфиг вошёл в дом проектом \`${r.adopted}\`.` : "") +
      "\nЗапуск всех проектов — хаб: node scripts/dev/hub/server.mjs\n\nПроверка дома:\n")
    const d = await doctorNow({})
    console.log(d.text)
    return d.ok ? 0 : 1
  }
  if (cmd === "list") {
    const rows = listProjects()
    if (args.json) console.log(JSON.stringify(rows, null, 2))
    else for (const p of rows) console.log(`${p.ok ? "✔" : "✖"} ${p.id.padEnd(16)} порт ${p.port}  ${p.start === "lazy" ? "по требованию" : "всегда"}  ${p.ok ? p.name + " — " + p.repo : p.error}`)
    return rows.every((p) => p.ok) ? 0 : 1
  }
  if (cmd === "remove") {
    if (typeof args.id !== "string") throw new Error("нужен id проекта: --id <id>")
    const r = removeProject({ id: args.id })
    console.log(`Проект \`${r.removed.id}\` снят с дома ${r.homeFile}. Конфиг ${r.removed.file}, данные и ветки остались на месте.`)
    return 0
  }
  if (cmd === "doctor") {
    const d = await doctorNow(args)
    console.log(d.text)
    return d.ok ? 0 : 1
  }
  console.log(USAGE)
  return cmd ? 2 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (e) => { console.error("✖ " + e.message); process.exitCode = 1 },
  )
}
