// agent-policy.mjs — политика прав агентов над нейтральным запросом { kind, command, path }: что диспетчерская разрешает сама,
// что отклоняет с причиной агенту и что оставляет человеку. Не знает ни рантайма, ни имён его инструментов; запреты берёт из
// конфига проекта (`deny`, `protected`, команды задач). Чистые функции: всё состояние приходит в ctx (agents.mjs policyCtx).
//
// ctx: { key, role: "slot"|"orch", roots[] — свои папки агента, commitOpen — открыто разрешение коммита кнопкой,
//        selfCommit — агент слота коммитит сам (settings.selfCommit ≠ word), night — режим «без владельца», full — полные
//        разрешения (settings.fullPermissions), project — нормализованный конфиг, guarded[] — папки диспетчерской,
//        home — дом диспетчерской (её инструменты агентам можно звать), tmp[] — временные папки, remote — имя remote }
//
// Решение: "allow" — пропустить; { deny } — отказ с причиной агенту (он продолжает сам); null — вопрос человеку.
import { commitCmdShape } from "./commit-rules.mjs"
import { deployWriteWhy } from "./loops.mjs"

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Путь для сравнения: прямые слэши, `/c/…` → `c:/…`, без кавычек и хвостового слэша, строчными. */
export const normPath = (x) => String(x || "").trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/").replace(/^\/([a-z])\//i, "$1:/").replace(/\/+$/, "").toLowerCase()
const under = (q, r) => !!r && (q === r || q.startsWith(r + "/"))

export const stripHeredoc = (c) => { const i = c.search(/<<-?\s*['"]?\w+['"]?/); return i < 0 ? c : c.slice(0, i) }
/** Команда → части по `&&`, `||`, `;` и переводам строк (тело heredoc не в счёт). */
export const splitSegs = (command) => stripHeredoc(String(command || "")).replace(/\$\(cat\s*<<.*$/s, "").split(/&&|\|\||;|\n/).map((x) => x.trim()).filter(Boolean)
/** Без общих ключей git (-C, -c, --git-dir, --work-tree): запреты проверяются по самой команде git. */
export const gitBare = (seg) => String(seg).replace(/\bgit\s+((?:-C\s+\S+|-c\s+\S+|--git-dir[=\s]\S+|--work-tree[=\s]\S+|--no-pager)\s+)+/g, "git ")
/** Сама команда: без слов оболочки и присваиваний окружения в начале («do FOO=1 npm test» → «npm test») и лишних пробелов. */
const bareCmd = (seg) => gitBare(seg).replace(/^(?:(?:do|then|else|time|exec|nohup|command|env)\s+|\(\s*|\w+=\S*\s+)+/, "").replace(/\s+/g, " ").trim()

// Опасное в любом проекте: история и ветки, чужие машины и службы, массовое удаление, остановка процессов,
// выполнение скачанного. Без разрешения не пропускается; при полных разрешениях — отказ с причиной.
export const BASH_ASK = [
  /\bgit\s+(push|merge|rebase|reset|clean|switch|checkout|restore|worktree|stash|tag|remote|config|cherry-pick|revert|am|apply|pull|fetch)\b/,
  /\bgit\s+branch\s+-[dDmM]/, /\bgit\s+commit\b/,
  /\b(ssh|scp|sftp|rsync|pm2|gh|docker|systemctl|sudo|shutdown|reboot|netsh|reg|schtasks|choco|winget)(\.exe)?\b/i,
  /\brm\s+(-[a-zA-Z]*r|-[a-zA-Z]*f|--recursive|--force)/, /\bRemove-Item\b/i, /\b(del|erase)\s+\/[sq]/i, /\brmdir\s+\/s/i, /\bformat\b\s+[a-z]:/i,
  /\b(taskkill|Stop-Process|pkill|killall)\b/i, /\bkill\s+-/,
  /\|\s*(sh|bash|zsh|powershell|pwsh|cmd)\b/i, /\b(curl|wget|iwr|Invoke-WebRequest)\b.*\|\s*\S/i,
]
/** Своё в своей ветке, пока открыто разрешение коммита (кнопка или самокоммит слота). */
export const GIT_GRANT_OK = /^git\s+(add\s+(?!.*(?:\s-A\b|\s--all\b|\s-u\b|\s\.(?:\s|$)|\*))|commit\b(?!.*--no-verify)|status|diff|log|show|rev-parse|branch\s+--show-current|ls-files|check-ignore)/
/** Режим «без владельца»: агенту слота в своей ветке ещё и влив staging с разбором конфликта. */
export const gitNightRe = (remote = "origin") =>
  new RegExp(
    "^(cd\\s+\\S+\\s*$|git\\s+(add\\s+(?!.*(?:\\s-A\\b|\\s--all\\b|\\s-u\\b|\\s\\.(?:\\s|$)|\\*))|commit\\b(?!.*--no-verify)|merge\\s+(staging|" +
      esc(remote) +
      "\\/staging|--continue|--abort|--no-edit\\s+staging|--no-ff\\s+staging)\\b|checkout\\s+(--ours|--theirs|--)\\s|" +
      "restore\\s|status|diff|log|show|rev-parse|ls-files|branch\\s+--show-current|merge-base|check-ignore))",
  )
/** Чтение — его можно и в папках диспетчерской, и над защищёнными файлами. */
export const READ_VERB = /^(cat|type|ls|dir|head|tail|wc|grep|rg|find|stat|file|less|more|tree)\b|^git\s+(-C\s+\S+\s+)?(status|log|diff|show|ls-files|rev-parse|branch\s+--show-current|blame)\b/i
/** Инструменты диспетчерской, которые агентам можно звать; сброс ветки слота — только с --dry-run (сам сброс — слово человека). */
const OWN_TOOLS = "(epic\\.mjs\\b(?!\\s+reset-slot\\b(?!.*--dry-run))|(slots|slot-up|fleet|slot-workspaces|dash-log|backlog)\\.mjs\\b)"

// ───────────────────────────── шаблоны путей ─────────────────────────────

/**
 * Шаблон пути как в gitignore: `/x` — от корня папки, шаблон со слэшем — от корня, без слэша — на любом уровне;
 * `**` — любые папки, `*` — в пределах одной.
 */
export function globRe(glob) {
  const g = String(glob).replace(/\\/g, "/"), anchored = g.startsWith("/"), body = anchored ? g.slice(1) : g
  const re = body.split(/(\*\*\/|\*\*|\*|\?)/).map((p) => p === "**/" ? "(?:.*/)?" : p === "**" ? ".*" : p === "*" ? "[^/]*" : p === "?" ? "[^/]" : esc(p)).join("")
  return new RegExp((anchored || body.replace(/\/$/, "").includes("/") ? "^" : "(?:^|/)") + re + "(?:/.*)?$", "i")
}
/** Путь от корня своей папки (или как есть, если он относительный); вне своих папок — null. */
export function relOf(ctx, p) {
  const q = normPath(p)
  if (!/^([a-z]:\/|\/|~)/.test(q)) return q.replace(/^\.\//, "")
  const r = (ctx.roots || []).map(normPath).find((x) => under(q, x))
  return r ? q.slice(r.length + 1) : null
}
const hitGlob = (globs, rel) => rel != null && (globs || []).find((g) => globRe(g).test(rel)) || ""

// ───────────────────────────── части решения ─────────────────────────────

/** Все `cd` ведут в свою папку: относительный путь без `..` — тоже своя. */
export function cdInside(ctx, segs) {
  const roots = (ctx.roots || []).map(normPath)
  return segs.every((seg) => {
    const m = /^cd\s+(\S+)\s*$/.exec(seg); if (!m) return true
    const q = normPath(m[1])
    if (!/^(\/|[a-z]:\/|~)/.test(q) && !/(^|\/)\.\.(\/|$)/.test(q)) return true
    return q === "." || roots.some((r) => under(q, r))
  })
}

/** Команда трогает папки диспетчерской не чтением и не её инструментом. */
export function guardedBash(ctx, seg) {
  const s = normPath(seg).replace(/(^|[\s"'=])\/([a-z])\//g, "$1$2:/"), dirs = (ctx.guarded || []).map(normPath).filter(Boolean)
  if (!dirs.some((d) => s.includes(d))) return false
  if (READ_VERB.test(seg.trim())) return false
  const home = normPath(ctx.home || "")
  return !(home && new RegExp("^node\\s+\\S*" + esc(home) + "/scripts/dev/" + OWN_TOOLS, "i").test(s))
}
const guardedPath = (ctx, p) => { const q = normPath(p); return (ctx.guarded || []).map(normPath).some((d) => d && under(q, d)) }

/** Начало команды задачи из конфига: слова до ввода, ключей и путей, не больше трёх («npx jest {input}» → «npx jest»). */
export function taskPrefix(run) {
  const out = []
  for (const w of String(run || "").trim().split(/\s+/)) {
    if (!w || /[{}]/.test(w) || /^[-.]/.test(w) || /[\\/]/.test(w) || /^\w+=/.test(w) || out.length >= 3) break
    out.push(w)
  }
  return out.join(" ")
}
/** Правило из `deny.commands`/`deny.ask`: начало командной строки, с `=` — команда целиком. */
const ruleHit = (rules, s) => (rules || []).find((r) => r.startsWith("=") ? s === r.slice(1).trim() : s === r || s.startsWith(r + " ")) || ""
const taskPrefixes = (ctx) => Object.values((ctx.project && ctx.project.tasks) || {}).map((t) => taskPrefix(t.run)).filter(Boolean)
const runsTask = (ctx, s) => taskPrefixes(ctx).some((p) => s === p || s.startsWith(p + " "))

const WHY = {
  guarded: "папки диспетчерской агентам закрыты — нужна правка там: напиши оркестратору",
  tests: "тесты, сборку и гарды гоняет диспетчерская — сам не запускай: в докладе строка «Нужно от оркестратора: ПРОГНАТЬ <метка>: задача=фильтр», и продолжай работу",
  push: "git push — только диспетчерская по слову владельца; коммита в своей ветке достаточно",
  commitOrch: "коммит в ветке эпика — по слову владельца: напиши ему в ответе, сам не коммить",
  commitSlot: "коммит — только в своей папке слота (cd в чужую папку и git -C не пропускаются); перейди в свою папку и повтори",
  history: "это действие меняет историю или ветки — его делает диспетчерская (влив, перемотка, «Подтянуть staging»); свою правку оставь коммитом в своей ветке",
  machines: "чужие машины, службы и выкат — не из сессии агента: нужно — строкой оркестратору",
  kill: "процессы останавливает диспетчерская (кнопка «стоп» у прогона) — сам не убивай",
  pipe: "выполнение скачанного или собранного на лету скрипта через конвейер — нельзя; сохрани файл в своей папке и посмотри его",
  rmAbs: "удаление по абсолютному пути — только в своей папке слота относительными путями; вне её — запрос оркестратору",
  cdGit: "git — только в своей папке слота: в команде cd в чужую папку; перейди в свою и повтори",
  protected: "защищённые файлы проекта (`protected` конфига) из сессии агента не правят и не запускают — опиши нужный шаг в докладе",
  outside: "файл вне папки твоего слота — правь только в своей папке; чужой файл — запрос оркестратору",
}

/** Причина по виду команды; "" — вид не опасный (или относительное удаление в своей папке). */
function kindWhy(ctx, s) {
  const orch = ctx.role === "orch"
  if (runsTask(ctx, s)) return WHY.tests
  if (/\bgit\s+push\b/.test(s)) return WHY.push
  if (/\bgit\s+commit\b/.test(s)) return orch ? WHY.commitOrch : WHY.commitSlot
  if (/\bgit\s+(merge|rebase|reset|clean|switch|checkout|worktree|tag|remote|config|cherry-pick|revert|am|apply|pull|fetch|stash)\b|\bgit\s+branch\s+-[dDmM]/.test(s)) return WHY.history
  if (/\b(ssh|scp|sftp|rsync|pm2|gh|docker|systemctl|sudo|shutdown|reboot|netsh|reg|schtasks|choco|winget)(\.exe)?\b/i.test(s)) return WHY.machines
  if (/\b(taskkill|Stop-Process|pkill|killall)\b|\bkill\s+-/i.test(s)) return WHY.kill
  if (/\|\s*(sh|bash|zsh|powershell|pwsh|cmd)\b/i.test(s) || /\b(curl|wget|iwr|Invoke-WebRequest)\b.*\|\s*\S/i.test(s)) return WHY.pipe
  if (/\brm\s+(-[a-zA-Z]*r|-[a-zA-Z]*f|--recursive|--force)|\bRemove-Item\b|\b(del|erase)\s+\/[sq]|\brmdir\s+\/s|\bformat\b\s+[a-z]:/i.test(s)) {
    const abs = /(^|\s)(\/|[a-zA-Z]:[\\/]|~)/.test(s.replace(/^\S+\s+(-\S+\s+)*/, " "))
    return abs ? WHY.rmAbs : ""
  }
  return ""
}

/** Команда пишет в защищённый файл проекта или запускает его (чтение можно). */
export function protectedBashWhy(ctx, command) {
  const globs = (ctx.project && ctx.project.protected) || []; if (!globs.length) return ""
  for (const seg of splitSegs(command)) {
    if (READ_VERB.test(seg)) continue
    for (const tok of seg.split(/[\s<>|&;()]+/)) {
      const t = tok.replace(/^["']|["']$/g, ""); if (!t || t.startsWith("-")) continue
      if (hitGlob(globs, relOf(ctx, t))) return WHY.protected + " (" + t + ")"
    }
  }
  return ""
}

/** Можно ли пропустить команду без вопроса. */
export function bashAllowed(ctx, command) {
  const segs = splitSegs(command), deny = (ctx.project && ctx.project.deny) || {}
  const grant = !!ctx.commitOpen || (ctx.role === "slot" && !!ctx.selfCommit && cdInside(ctx, segs))
  const night = ctx.role !== "orch" && !!ctx.night, nightRe = gitNightRe(ctx.remote)
  return segs.every((seg) => {
    const s = bareCmd(seg)
    if (guardedBash(ctx, seg) || ruleHit(deny.commands, s)) return false
    const risky = BASH_ASK.some((re) => re.test(s)) || runsTask(ctx, s) || !!ruleHit(deny.ask, s)
    return !risky || (grant && GIT_GRANT_OK.test(seg)) || (night && nightRe.test(seg))
  })
}

/** Почему команда не пропущена (при полных разрешениях — отказ с причиной вместо вопроса человеку); "" — пропустить. */
export function bashDenyWhy(ctx, command) {
  const segs = splitSegs(command), deny = (ctx.project && ctx.project.deny) || {}
  if (!cdInside(ctx, segs) && segs.some((seg) => /\bgit\s+(add|commit|merge|checkout|restore|stash|reset|clean)\b/.test(gitBare(seg)))) return WHY.cdGit
  const nightRe = gitNightRe(ctx.remote)
  for (const seg of segs) {
    const s = bareCmd(seg)
    if (guardedBash(ctx, seg)) return WHY.guarded
    const rule = ruleHit(deny.commands, s)
    if (rule) return kindWhy(ctx, s) || "команда закрыта конфигом проекта (deny.commands: «" + rule + "»)"
    if (ctx.role !== "orch" && nightRe.test(seg)) continue // свои git-действия слота: add, commit, merge staging, --ours/--theirs, restore
    const w = kindWhy(ctx, s); if (w) return w
  }
  return ""
}

/** Правка файла: своя папка — да; папки диспетчерской, защищённое и запрещённое конфигом — отказ; прочее — отказ с причиной. */
export function editDecision(ctx, p) {
  const q = normPath(p)
  if (guardedPath(ctx, q)) return { deny: WHY.guarded }
  const rel = relOf(ctx, p)
  if (ctx.role === "slot" && rel != null) {
    const pg = hitGlob(ctx.project && ctx.project.protected, rel); if (pg) return { deny: WHY.protected + " (" + rel + ")" }
    const dg = hitGlob(ctx.project && ctx.project.deny && ctx.project.deny.edit, rel); if (dg) return { deny: "путь закрыт для правки конфигом проекта (deny.edit: «" + dg + "»): " + rel }
  }
  if (rel != null) return "allow" // своя папка (относительный путь — тоже от неё)
  if ((ctx.tmp || []).map(normPath).some((t) => t && under(q, t))) return "allow" // свои временные файлы
  return { deny: WHY.outside + " (" + q.slice(0, 120) + ")" }
}

/** Чтение: закрыты только пути `deny.read` конфига (секреты окружения). */
export function readDecision(ctx, p) {
  if (!p) return "allow"
  const q = normPath(p), rel = relOf(ctx, p), globs = (ctx.project && ctx.project.deny && ctx.project.deny.read) || []
  const g = hitGlob(globs, rel != null ? rel : q) || globs.find((x) => !x.startsWith("/") && globRe(x).test(q))
  return g ? { deny: "чтение закрыто конфигом проекта (deny.read: «" + g + "»)" } : "allow"
}

/**
 * Решение по запросу разрешения. req — нейтральный: { kind, command?, path? }.
 * Коммит агента слота с -a, -A или --no-verify — отказ с причиной всегда (строку Wave ставит хук commit-msg, без хука её нет).
 * Без полных разрешений остальное — человеку (null).
 */
export function decide(ctx, req) {
  const kind = req && req.kind
  if (kind === "bash" && ctx.role === "slot" && ctx.selfCommit) {
    const c = commitCmdShape(req.command); if (!c.ok) return { deny: "Коммит не пропущен диспетчерской: " + c.why + ". Исправь и повтори (навык slot-commit)." }
  }
  if (!ctx.full) return null
  if (kind === "bash") {
    // защищённые файлы: по словам команды (protectedBashWhy) и по записи из кода — перенаправление, sed -i, writeFileSync… (deployWriteWhy)
    if (ctx.role === "slot") { const pw = protectedBashWhy(ctx, req.command) || deployWriteWhy(req.command, (ctx.project && ctx.project.protected) || []); if (pw) return { deny: pw } }
    if (bashAllowed(ctx, req.command)) return "allow"
    const why = bashDenyWhy(ctx, req.command)
    return why ? { deny: why } : "allow"
  }
  if (kind === "write" || kind === "edit") return editDecision(ctx, req.path)
  if (kind === "read" || kind === "search") return readDecision(ctx, req.path)
  return "allow" // прочие инструменты: задачи, навыки, планы
}
