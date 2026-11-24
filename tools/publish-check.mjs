#!/usr/bin/env node
// publish-check.mjs — ворота публикации: в репозитории не должно быть адресов, личных путей, почты, ключей и частных слов.
//
// Два слоя правил:
//   • общие шаблоны — здесь, в коде: IPv4 (кроме локальных и учебных), домашние папки пользователей, почта, виды ключей;
//   • частные слова (имена, домены, хосты, названия проектов) — в файле .private-denylist в корне. Он вне git:
//     сам список публиковать нельзя. Строка — подстрока без учёта регистра или /регулярка/; `#` — комментарий.
//
// Гард фатальный: находка, пустой набор файлов и отсутствие списка частных слов при локальном запуске — код возврата 1.
// В CI списка нет по построению — там запуск с --ci (только общие шаблоны).
// Снять находку с одной строки — пометка `publish-check: allow` в этой строке, с причиной рядом.
// Одно исключение без пометки: строка правообладателя в LICENSE корня (licenseAllow) — текст лицензии стандартный,
// пометку в него не поставить. Снимаются только частные слова и только в первой строке «Copyright (c) <год> <имя>»;
// почта, адреса и ключи в ней ловятся как везде, имя в любой другой строке или другом файле — тоже.
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const ALLOW_MARK = "publish-check: allow"
export const DENYLIST_NAME = ".private-denylist"
const MAX_BYTES = 2 * 1024 * 1024

const ipAllowed = (ip) => {
  const [a, b, c] = ip.split(".").map(Number)
  if (a === 127 || ip === "0.0.0.0" || ip === "255.255.255.255") return true // локальные и служебные
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return true // учебные диапазоны RFC 5737
  return false
}
// `git@хост` — адрес ssh-репозитория, а не почта
const mailAllowed = (m) => /@(example\.(com|org|net)|[\w.-]+\.(invalid|example|test)|users\.noreply\.github\.com|noreply\.[\w.-]+)$/i.test(m) || /^(noreply|git)@/i.test(m)
const homeAllowed = (name) => /^(user|username|you|me|name|<[^>]+>|\$\{?\w+\}?|%\w+%|\*)$/i.test(name)

/** Общие правила: { id, re, ok?(совпадение, группы) → true, если находка допустима }. */
export const RULES = [
  { id: "ipv4", what: "IP-адрес", re: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g, ok: (m) => ipAllowed(m) },
  { id: "home-win", what: "домашняя папка Windows", re: /[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"'`<>|:*?]+)/g, ok: (m, g) => homeAllowed(g[0]) },
  { id: "home-posix", what: "домашняя папка", re: /(?<![\w.:-])\/(?:home|Users)\/([^\/\s"'`<>|:*?)]+)/g, ok: (m, g) => homeAllowed(g[0]) },
  { id: "email", what: "адрес почты", re: /[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, ok: (m) => mailAllowed(m) },
  { id: "key-private", what: "закрытый ключ", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: "key-anthropic", what: "ключ Anthropic", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "key-openai", what: "ключ OpenAI", re: /sk-(?:proj-)?[A-Za-z0-9]{32,}/g },
  { id: "key-github", what: "токен GitHub", re: /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/g },
  { id: "key-slack", what: "токен Slack", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: "key-telegram", what: "токен бота Telegram", re: /(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g },
  { id: "key-aws", what: "ключ AWS", re: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g },
]

/** Разобрать список частных слов в правила. */
export function parseDenylist(text) {
  const rules = []
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const m = /^\/(.+)\/([a-z]*)$/.exec(line)
    const re = m ? new RegExp(m[1], [...new Set((m[2] + "g").split(""))].join("")) : new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
    rules.push({ id: "private", what: "частное слово", re })
  }
  return rules
}

/** Файл лицензии и вид строки правообладателя в нём. */
export const LICENSE_FILE = "LICENSE"
export const COPYRIGHT_RE = /^Copyright \(c\) \d{4}(?:-\d{4})? \S.*$/

/**
 * Точечное разрешение для текста файла: (номер строки в тексте, строка, правило) → находка допустима. У LICENSE корня —
 * только частные слова и только в первой строке правообладателя; у остальных файлов разрешений нет.
 */
export function licenseAllow(rel, text) {
  if (rel !== LICENSE_FILE) return null
  const at = text.split(/\r?\n/).findIndex((l) => COPYRIGHT_RE.test(l))
  return at < 0 ? null : (i, line, rule) => i === at && rule.id === "private"
}

/** Найти нарушения в одном тексте; allow(i, строка, правило) — точечное разрешение (licenseAllow). */
export function scanText(text, rules, allow = null) {
  const found = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes(ALLOW_MARK)) continue
    for (const rule of rules) {
      if (allow && allow(i, line, rule)) continue
      rule.re.lastIndex = 0
      for (const m of line.matchAll(rule.re)) {
        if (rule.ok && rule.ok(m[0], m.slice(1))) continue
        found.push({ line: i + 1, rule: rule.id, what: rule.what, match: m[0] })
      }
    }
  }
  return found
}

/** Файлы под проверкой: всё, что git отслеживает или отследил бы (игнорируемое не входит). */
export function listFiles(root) {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  return [...new Set(out.split("\0").filter(Boolean))].sort()
}

/**
 * Проверить репозиторий.
 * @returns {{files:number, skipped:string[], findings:{file:string,line:number,rule:string,what:string,match:string}[]}}
 */
export function scanRepo({ root = HOME, extraRules = [] } = {}) {
  const rules = [...RULES, ...extraRules]
  const findings = [], skipped = []
  let files = 0
  for (const rel of listFiles(root)) {
    const abs = path.join(root, rel)
    let buf
    try { buf = fs.readFileSync(abs) } catch { continue } // удалён из рабочей папки, но ещё в индексе
    if (buf.length > MAX_BYTES) { skipped.push(rel + " (больше 2 МБ)"); continue }
    if (buf.subarray(0, 8000).includes(0)) { skipped.push(rel + " (двоичный)"); continue }
    files++
    const text = rel + "\n" + buf.toString("utf8") // строка 0 — само имя файла
    for (const f of scanText(text, rules, licenseAllow(rel, text))) findings.push({ file: rel, ...f, line: f.line - 1 })
  }
  return { files, skipped, findings }
}

function main(argv) {
  const ci = argv.includes("--ci")
  const rootArg = argv.find((a) => a.startsWith("--root="))
  const root = rootArg ? path.resolve(rootArg.slice(7)) : HOME
  const denyFile = path.join(root, DENYLIST_NAME)
  let extraRules = []
  if (fs.existsSync(denyFile)) extraRules = parseDenylist(fs.readFileSync(denyFile, "utf8"))
  else if (!ci) {
    console.error(`✖ Нет списка частных слов ${DENYLIST_NAME} — без него проверены были бы только общие шаблоны.\n  Создайте файл в корне (он вне git): по строке на слово, имя, домен или хост, которые нельзя публиковать.\n  В CI запускайте с --ci.`)
    return 1
  }
  if (!ci && !extraRules.length) { console.error(`✖ Список частных слов ${DENYLIST_NAME} пуст.`); return 1 }
  const { files, skipped, findings } = scanRepo({ root, extraRules })
  if (!files) { console.error("✖ Не проверено ни одного файла — ворота, которые ничего не смотрят, не пропускают."); return 1 }
  for (const f of findings) console.error(`${f.file}:${f.line || 1}: [${f.rule}] ${f.what}: ${f.match.length > 60 ? f.match.slice(0, 57) + "…" : f.match}${f.line === 0 ? " (в имени файла)" : ""}`)
  const tail = `файлов ${files}${skipped.length ? ", пропущено " + skipped.length : ""}, частных слов ${extraRules.length}${ci ? " (режим CI: только общие шаблоны)" : ""}`
  if (findings.length) { console.error(`\n✖ Находок: ${findings.length} — ${tail}.\n  Убрать из текста; если совпадение ложное и нужное — пометка \`${ALLOW_MARK}\` в той же строке с причиной.`); return 1 }
  console.log(`✔ Ворота публикации: чисто — ${tail}.`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
