// doctor.mjs — проверка установки: конфиг, git и ветки проекта, папки, бинарник агента, задачи, машины, модули.
// В доме (runHomeDoctor) — ещё сам файл дома и то, что проекты дома не делят.
// Только читает. Каждая проверка — { id, level, title, detail, fix }; level: ok | warn | error | info.
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { loadHome, loadProject, loadProjectCode, formatIssues, homeFile, isBareCommand, projectFile, ProjectConfigError } from "../scripts/dev/project.mjs"
import { canonPath } from "../scripts/dev/paths.mjs"
import { moduleStates } from "../scripts/dev/modules-catalog.mjs"
import { whichBin } from "./detect.mjs"

const MIN_NODE = 22
const run = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 15000,
      ...opts,
    }).trim()
  } catch {
    return null
  }
}
const git = (repo, args) => run("git", ["-C", repo, ...args])

/**
 * Что с локальной веткой-ролью (`staging` или `main`): диспетчерская зовёт ветки проекта своими именами,
 * а локальная ветка с этим именем отслеживает настоящую ветку проекта.
 * @returns {{state:"ok"|"missing"|"foreign"|"no-remote-ref", tracks:string, want:string}}
 */
export function roleBranchState(repo, role, remote, upstream) {
  const want = remote + "/" + upstream
  if (git(repo, ["rev-parse", "--verify", "--quiet", "refs/remotes/" + want]) == null) return { state: "no-remote-ref", tracks: "", want }
  if (git(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/" + role]) == null) return { state: "missing", tracks: "", want }
  const tracks = git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", role + "@{upstream}"]) || ""
  return { state: tracks === want ? "ok" : "foreign", tracks, want }
}

/** Создать недостающие ветки-роли. Существующие не трогает: чужую ветку с этим именем человек разбирает сам. */
export function ensureRoleBranches(project) {
  const { main: repo, remote, upstream } = project.repo
  const done = []
  for (const [role, up] of Object.entries(upstream)) {
    if (!up) continue
    const st = roleBranchState(repo, role, remote, up)
    if (st.state !== "missing") { done.push({ role, ...st, created: false }); continue }
    const ok = git(repo, ["branch", "--track", role, st.want]) != null
    done.push({ role, ...roleBranchState(repo, role, remote, up), created: ok })
  }
  return done
}

function checkRole(checks, project, role) {
  const { main: repo, remote, upstream } = project.repo
  const up = upstream[role]
  if (!up) { checks.push({ id: "branch." + role, level: "info", title: `Ветка-роль \`${role}\``, detail: "отдельной прод-ветки нет — выкат прода из диспетчерской выключен" }); return }
  const st = roleBranchState(repo, role, remote, up)
  const title = `Ветка-роль \`${role}\` → \`${st.want}\``
  if (st.state === "ok")
    checks.push({ id: "branch." + role, level: "ok", title, detail: "локальная ветка есть и отслеживает нужную" })
  else if (st.state === "missing")
    checks.push({
      id: "branch." + role,
      level: "error",
      title,
      detail: `локальной ветки \`${role}\` нет`,
      fix: `git -C "${repo}" branch --track ${role} ${st.want}   (или: node setup.mjs apply … --branches)`,
    })
  else if (st.state === "no-remote-ref")
    checks.push({
      id: "branch." + role,
      level: "error",
      title,
      detail: `ветки \`${st.want}\` нет среди известных — проверьте имя или подтяните remote`,
      fix: `git -C "${repo}" fetch ${remote}`,
    })
  else
    checks.push({
      id: "branch." + role,
      level: "error",
      title,
      detail:
        `локальная ветка \`${role}\` уже есть и отслеживает ${st.tracks ? "`" + st.tracks + "`" : "ничего"}, ` +
        `а не \`${st.want}\`. Диспетчерская зовёт интеграционную ветку \`staging\`, прод-ветку \`main\` — в ` +
        `первой редакции эти имена заняты.`,
      fix:
        role === up
          ? `git -C "${repo}" branch --set-upstream-to=${st.want} ${role}`
          : `переименуйте свою ветку \`${role}\` или выберите её же в \`repo.upstream.${role}\``,
    })
}

/** Можно ли создать папку: существует сама или существует и доступен на запись ближайший предок. */
function dirState(dir) {
  let p = dir
  while (!fs.existsSync(p)) { const up = path.dirname(p); if (up === p) return { ok: false, exists: false }; p = up }
  try { fs.accessSync(p, fs.constants.W_OK); return { ok: true, exists: p === dir } } catch { return { ok: false, exists: p === dir } }
}

/**
 * Прогнать все проверки.
 * @param net проверять ли ssh до удалённых машин (ходит в сеть)
 * @returns {Promise<{ok:boolean, checks:object[], project:object|null, modules:object[]}>}
 */
const nodeCheck = () => {
  const major = Number(process.versions.node.split(".")[0])
  return {
    id: "node",
    level: major >= MIN_NODE ? "ok" : "error",
    title: "Node.js",
    detail: `версия ${process.versions.node}` + (major >= MIN_NODE ? "" : `, нужна ${MIN_NODE} или новее`),
  }
}

export async function runDoctor({
  file = projectFile(),
  net = false,
  env = process.env,
  platform = process.platform,
  node = true, // проверка дома печатает версию Node один раз, а не у каждого проекта
} = {}) {
  const checks = []
  const add = (c) => checks.push(c)
  if (node) add(nodeCheck())

  let project = null
  try {
    project = loadProject({ file, fresh: true, env })
  } catch (e) {
    if (!(e instanceof ProjectConfigError)) throw e
    add({
      id: "config",
      level: "error",
      title: "Конфиг проекта",
      detail: e.message,
      fix:
        e.code === "missing"
          ? "node setup.mjs detect --repo <путь к проекту>"
          : "исправьте файл и запустите проверку снова",
    })
    return { ok: false, checks, project: null, modules: [] }
  }
  add({
    id: "config",
    level: project.warnings.length ? "warn" : "ok",
    title: "Конфиг проекта",
    detail: project.file + (project.warnings.length ? "\n" + formatIssues(project.warnings) : ""),
  })

  try {
    const { hooks, warnings } = await loadProjectCode({ file })
    if (Object.keys(hooks).length || warnings.length)
      add({
        id: "code",
        level: warnings.length ? "warn" : "ok",
        title: "Код-надстройка проекта",
        detail:
          "функции: " +
          (Object.keys(hooks).join(", ") || "нет") +
          (warnings.length ? "\n" + warnings.map((w) => "  • " + w).join("\n") : ""),
      })
  } catch (e) {
    add({
      id: "code",
      level: "error",
      title: "Код-надстройка проекта",
      detail: "dispatcher.project.mjs не загружается: " + e.message,
    })
  }

  // git и ветки
  const repo = project.repo.main
  const gitVersion = run("git", ["--version"])
  // README обещает git 2.31+ — проверяется версия, а не только наличие
  const gitVer = gitVersion && /(\d+)\.(\d+)/.exec(gitVersion)
  if (gitVer && (Number(gitVer[1]) < 2 || (Number(gitVer[1]) === 2 && Number(gitVer[2]) < 31)))
    add({ id: "git-version", level: "error", title: "git", detail: `${gitVersion.trim()} — нужна 2.31 или новее`, fix: "обновите git" })
  if (!gitVersion) add({ id: "git", level: "error", title: "git", detail: "git не найден в PATH" })
  else if (git(repo, ["rev-parse", "--is-inside-work-tree"]) !== "true")
    add({
      id: "repo",
      level: "error",
      title: "Репозиторий проекта",
      detail: `${repo} — не рабочая папка git`,
      fix: "проверьте `repo.main`",
    })
  else {
    add({ id: "repo", level: "ok", title: "Репозиторий проекта", detail: repo })
    const remotes = (git(repo, ["remote"]) || "").split("\n").filter(Boolean)
    if (!remotes.includes(project.repo.remote))
      add({
        id: "remote",
        level: "error",
        title: "Remote",
        detail: `remote \`${project.repo.remote}\` в репозитории нет; есть: ${remotes.join(", ") || "ни одного"}`,
        fix: "исправьте `repo.remote`",
      })
    else {
      add({ id: "remote", level: "ok", title: "Remote", detail: project.repo.remote })
      checkRole(checks, project, "staging")
      checkRole(checks, project, "main")
    }
  }

  // папки
  for (const [id, title, dir] of [
    ["worktrees", "Папка слотов", project.repo.worktrees],
    ["data", "Папка данных", project.repo.data],
  ]) {
    const st = dirState(dir)
    add({
      id: "dir." + id,
      level: st.ok ? "ok" : "error",
      title,
      detail: dir + (st.ok ? (st.exists ? "" : " — будет создана") : " — нет прав на запись"),
    })
  }
  const settingsFile = path.join(project.repo.data, "settings.json")
  add(
    fs.existsSync(settingsFile)
      ? { id: "settings", level: "ok", title: "Переключатели", detail: settingsFile.replace(/\\/g, "/") }
      : {
          id: "settings",
          level: "warn",
          title: "Переключатели",
          detail: "settings.json ещё нет — диспетчерская стартует с безопасными умолчаниями (всё по кнопке)",
          fix: "node setup.mjs apply … создаёт его по ответу об автономии",
        },
  )

  // бинарник агента
  // `agent.bin` уже развёрнут при загрузке конфига (agentBinPath): путь — абсолютный, голое имя — имя в PATH
  const rt = project.agent.runtime,
    cfgBin = project.agent.bin,
    bare = !!cfgBin && isBareCommand(cfgBin)
  const bin = !cfgBin ? whichBin(rt, env, platform) : bare ? whichBin(cfgBin, env, platform) : cfgBin
  // Квиз путь к бинарнику не спрашивает: обычно агент есть в PATH. Если нет — ключ `agent.bin` правится руками.
  if (!cfgBin && !bin)
    add({
      id: "agent",
      level: "error",
      title: "Агент",
      detail: `\`${rt}\` не найден в PATH, и ключ \`agent.bin\` не задан`,
      fix:
        `установите ${rt === "claude" ? "Claude Code" : "Codex CLI"} так, чтобы \`${rt}\` был в PATH, или ` +
        `впишите полный путь к нему в \`agent.bin\` (раздел \`agent\` в dispatcher.project.json; \`~/…\` и ` +
        `путь от папки конфига тоже подходят)`,
    })
  else if (bare && !bin)
    add({
      id: "agent",
      level: "error",
      title: "Агент",
      detail: `\`${cfgBin}\` из \`agent.bin\` не найден в PATH`,
      fix: "впишите в `agent.bin` полный путь к агенту или уберите ключ, чтобы искался `" + rt + "`",
    })
  else if (!bare && cfgBin && !fs.existsSync(cfgBin))
    add({
      id: "agent",
      level: "error",
      title: "Агент",
      detail: `файла из \`agent.bin\` нет: ${cfgBin}`,
      fix: "исправьте путь в `agent.bin` (`~/…` — от домашней папки, относительный — от папки конфига) или уберите ключ, чтобы агент искался в PATH",
    })
  else {
    // .cmd и .bat на Windows запускаются только через оболочку; путь — в кавычках, аргументов от человека здесь нет
    const version = /\.(cmd|bat)$/i.test(bin) ? run(`"${bin}" --version`, [], { shell: true }) : run(bin, ["--version"])
    add({
      id: "agent",
      level: rt === "codex" ? "warn" : "ok",
      title: "Агент",
      detail:
        `${rt}: ${bin}` +
        (version ? ` (${version.split("\n")[0]})` : "") +
        (rt === "codex"
          ? "\n  • поддержка Codex экспериментальная: адаптер написан по документации и не проверен на живом прогоне"
          : ""),
    })
  }

  // задачи и области
  if (fs.existsSync(repo)) {
    const lostCwd = Object.values(project.tasks).filter((t) => t.cwd && !fs.existsSync(path.join(repo, t.cwd)))
    add(
      lostCwd.length
        ? {
            id: "tasks",
            level: "error",
            title: "Задачи",
            detail: "папки запуска нет в репозитории: " + lostCwd.map((t) => `${t.id} → ${t.cwd}`).join(", "),
          }
        : {
            id: "tasks",
            level: Object.keys(project.tasks).length ? "ok" : "warn",
            title: "Задачи",
            detail: Object.keys(project.tasks).length
              ? `${Object.keys(project.tasks).length}: ${Object.keys(project.tasks).join(", ")}; гарды: ${project.stations.guards.join(", ") || "нет"}`
              : "ни одной задачи — станции проверок будут пустыми",
          },
    )
    const staticPrefix = (glob) =>
      glob
        .replace(/^\//, "")
        .split("/")
        .filter((seg, i, all) => all.slice(0, i + 1).every((x) => !/[*?[{]/.test(x)))
        .join("/")
    const lostPaths = Object.values(project.areas)
      .flatMap((a) => a.paths.map((g) => [a.id, g, staticPrefix(g)]))
      .filter(([, , pre]) => pre && !fs.existsSync(path.join(repo, pre)))
    if (Object.keys(project.areas).length)
      add(
        lostPaths.length
          ? {
              id: "areas",
              level: "warn",
              title: "Области",
              detail: "путей нет в репозитории: " + lostPaths.map(([a, g]) => `${a} → ${g}`).join(", "),
            }
          : { id: "areas", level: "ok", title: "Области", detail: Object.keys(project.areas).join(", ") },
      )
    else add({ id: "areas", level: "warn", title: "Области", detail: "областей нет — слоты не разделены по путям" })
  }

  // машины
  for (const m of Object.values(project.machines)) {
    if (!m.ssh) {
      add({
        id: "machine." + m.id,
        level: "ok",
        title: `Машина \`${m.id}\``,
        detail:
          `${m.label}: воркеров ${m.workers}` +
          (m.services.length ? `, службы: ${m.services.map((s) => s.name).join(", ")}` : ""),
      })
      continue
    }
    if (!net) {
      add({
        id: "machine." + m.id,
        level: "info",
        title: `Машина \`${m.id}\``,
        detail: `ssh ${m.ssh}, папка ${m.dir} — связь не проверялась`,
        fix: "node setup.mjs doctor --net",
      })
      continue
    }
    const out = run(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", m.ssh, "echo dk-ok && git --version && node --version"],
      { timeout: 20000 },
    )
    add(
      out && out.includes("dk-ok")
        ? {
            id: "machine." + m.id,
            level: /git version/.test(out) && /^v\d/m.test(out) ? "ok" : "warn",
            title: `Машина \`${m.id}\``,
            detail: `ssh ${m.ssh}: ` + out.split("\n").slice(1).join(", "),
          }
        : {
            id: "machine." + m.id,
            level: "error",
            title: `Машина \`${m.id}\``,
            detail: `ssh ${m.ssh} не отвечает без пароля`,
            fix: "проверьте запись хоста в ~/.ssh/config и вход по ключу",
          },
    )
  }

  const modules = moduleStates(project, { platform })
  for (const m of modules)
    if (m.wanted && !m.on)
      add({
        id: "module." + m.id,
        level: "warn",
        title: `Модуль «${m.title}»`,
        detail: "включён в конфиге, но не заработает: " + m.why,
      })
  return { ok: !checks.some((c) => c.level === "error"), checks, project, modules }
}

/**
 * Проверка дома: сам файл дома, каждый проект (как runDoctor) и то, что проекты не делят: папки, порты, клон на
 * удалённой машине, бот Телеграма и рабочий стол Windows (в первой редакции — не больше чем в одном проекте).
 * only — проверить один проект по id.
 * @returns {Promise<{ok:boolean, checks:object[], projects:object[], home:object|null}>}
 */
export async function runHomeDoctor({ file = homeFile(), net = false, env = process.env, platform = process.platform, only = "" } = {}) {
  const checks = [nodeCheck()], projects = []
  const add = (c) => checks.push(c)
  let home
  try { home = loadHome({ file }) } catch (e) {
    if (!(e instanceof ProjectConfigError)) throw e
    add({ id: "home", level: "error", title: "Дом", detail: e.message, fix: "исправьте dispatcher.home.json и запустите проверку снова" })
    return { ok: false, checks, projects, home: null }
  }
  add({
    id: "home",
    level: home.warnings.length ? "warn" : "ok",
    title: "Дом",
    detail: `${home.file}: проектов ${home.projects.length}, хаб — порт ${home.hub.port}, данные хаба ${home.hub.data}` + (home.warnings.length ? "\n" + formatIssues(home.warnings) : ""),
  })
  add({
    id: "home.limit",
    level: "info",
    title: "Общий предел агентов слотов",
    detail: home.shared.limits.slots ? `${home.shared.limits.slots} на все проекты (\`shared.limits.slots\`)` : "не задан — у каждого проекта только свой `limits.slots`",
  })
  const list = only ? home.projects.filter((e) => e.id === only) : home.projects
  if (only && !list.length) add({ id: "home.project", level: "error", title: "Проект", detail: `в доме нет проекта \`${only}\`; есть: ${home.projects.map((e) => e.id).join(", ")}` })
  for (const e of list) projects.push({ id: e.id, port: e.port, start: e.start, file: e.file, ...(await runDoctor({ file: e.file, net, env, platform, node: false })) })

  // что проекты дома не делят
  const loaded = projects.filter((p) => p.project)
  const clash = (title, keyOf) => {
    const by = new Map()
    for (const p of loaded) for (const k of keyOf(p.project)) { if (!by.has(k)) by.set(k, []); by.get(k).push(p.id) }
    for (const [k, ids] of by) if (ids.length > 1) add({ id: "home.clash", level: "error", title, detail: `${k} — у проектов ${ids.join(", ")}`, fix: "у каждого проекта дома свои папки и места" })
  }
  clash("Одна основная папка у нескольких проектов", (p) => [canonPath(p.repo.main)])
  clash("Одна папка слотов у нескольких проектов", (p) => [canonPath(p.repo.worktrees)])
  clash("Одна папка данных у нескольких проектов", (p) => [canonPath(p.repo.data)])
  clash("Один клон на удалённой машине у нескольких проектов", (p) => Object.values(p.machines).filter((m) => m.ssh).map((m) => m.ssh + ":" + m.dir))
  for (const [mod, why] of [["tg", "бот опрашивает Телеграм один на токен"], ["win-desktop", "окна и монитор — одни на машину"]]) {
    const on = loaded.filter((p) => p.modules.some((m) => m.id === mod && m.on)).map((p) => p.id)
    if (on.length > 1) {
      const fix = "оставьте модуль включённым в одном проекте (`modules." + mod + "`)"
      add({ id: "home.module." + mod, level: "error", title: `Модуль \`${mod}\` в нескольких проектах`, detail: `${on.join(", ")}: ${why}`, fix })
    }
  }
  const ok = !checks.some((c) => c.level === "error") && projects.every((p) => p.ok)
  return { ok, checks, projects, home }
}

const MARK = { ok: "✔", warn: "!", error: "✖", info: "·" }

function checkLines(checks) {
  const lines = []
  for (const c of checks) {
    lines.push(`${MARK[c.level] || "?"} ${c.title}: ${c.detail}`)
    if (c.fix && c.level !== "ok") lines.push(`    → ${c.fix}`)
  }
  return lines
}

const verdict = (ok, checks) => {
  const errors = checks.filter((c) => c.level === "error").length, warns = checks.filter((c) => c.level === "warn").length
  return ok ? `Готово: ошибок нет${warns ? ", предупреждений " + warns : ""}.` : `Ошибок: ${errors}${warns ? ", предупреждений " + warns : ""} — исправьте и запустите проверку снова.`
}

/** Отчёт текстом. */
export function formatDoctor({ ok, checks, modules }) {
  const lines = checkLines(checks)
  if (modules.length) {
    lines.push("", "Модули:")
    for (const m of modules) lines.push(`  ${m.on ? "вкл " : "выкл"} ${m.id.padEnd(12)} ${m.title}${m.on ? "" : " — " + m.why}`)
  }
  lines.push("", verdict(ok, checks))
  return lines.join("\n")
}

/** Отчёт проверки дома: общее, затем каждый проект своим разделом, итог — по всему дому. */
export function formatHomeDoctor({ ok, checks, projects }) {
  const lines = checkLines(checks)
  for (const p of projects) lines.push("", `── проект ${p.id} (порт ${p.port}${p.start === "lazy" ? ", по требованию" : ""}) ──`, formatDoctor(p))
  lines.push("", "Дом: " + verdict(ok, [...checks, ...projects.flatMap((p) => p.checks)]))
  return lines.join("\n")
}
