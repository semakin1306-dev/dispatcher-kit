#!/usr/bin/env node
// commit-msg.mjs — git-хук папки слота: ставит в подпись коммита строку «Wave: WV-NNNN» последним абзацем. Номер — из файла
// dispatcher-wave.json в git-папке рабочей копии (его пишет диспетчерская: волна слота, у поезда — вагон в работе и
// разрешённые вагоны), иначе из имени ветки (`…wv-NNNN…`). Строка в другом месте переносится, чужой номер заменяется; номера не
// узнать — подпись не трогается. Коммит хук не останавливает никогда.
//
// Ставится только в папку слота: своя папка хуков через `core.hooksPath` в настройках этой рабочей копии (extensions.worktreeConfig),
// основная папка проекта и другие копии не задеты. Остальные хуки проекта (pre-commit и т. д.) и его собственный commit-msg
// продолжают работать: папка хуков слота передаёт им вызов.
//
//   node scripts/dev/hooks/commit-msg.mjs <файл подписи>        так зовёт git
//   node scripts/dev/hooks/commit-msg.mjs --install <папка слота> [--wave WV-NNNN]
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { fixWaveMessage } from "../dashboard/commit-rules.mjs"

export const SCRIPT = fileURLToPath(import.meta.url)
export const WAVE_FILE = "dispatcher-wave.json"
export const HOOKS_DIR = "dispatcher-hooks"
const ORIG_FILE = ".orig-hooks-path"
/** Хуки, вызов которых папка слота передаёт хукам проекта. */
export const HOOK_NAMES = ["applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg",
  "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push", "post-rewrite", "reference-transaction", "pre-auto-gc", "push-to-checkout", "post-index-change"]

const fwd = (p) => String(p).replace(/\\/g, "/")
const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
const cleanEnv = () => { const e = { ...process.env }; for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete e[k]; return e }
const git = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim()

/** git-папка рабочей копии без запуска git: `.git` — папка или файл `gitdir: …` (у дополнительной рабочей копии). */
export function gitDirOf(dir) {
  const dot = path.join(dir, ".git")
  let st; try { st = fs.statSync(dot) } catch { return null }
  if (st.isDirectory()) return dot
  const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, "utf8"))
  return m ? path.resolve(dir, m[1].trim()) : null
}

/** Записать номер волны папки слота: cur — волна (вагон в работе), allowed — номера, под которыми коммит законен. */
export function writeSlotWave(dir, { cur = "", allowed = [] } = {}) {
  const g = gitDirOf(dir); if (!g) return null
  const file = path.join(g, WAVE_FILE), text = JSON.stringify({ cur, allowed: [...new Set([cur, ...allowed].filter(Boolean))] }) + "\n"
  try { if (fs.readFileSync(file, "utf8") === text) return file } catch { /* файла ещё нет */ }
  const tmp = file + ".tmp"; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file)
  return file
}

/** Номер волны для хука: файл диспетчерской, иначе ветка. → { cur, allowed } */
export function slotWave(gitDir) {
  try { const w = JSON.parse(fs.readFileSync(path.join(gitDir, WAVE_FILE), "utf8")); if (w && (w.cur || (w.allowed || []).length)) return { cur: w.cur || "", allowed: w.allowed || [] } } catch { /* нет файла — по ветке */ }
  let head = ""; try { head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8") } catch { /* без HEAD номера нет */ }
  const m = /^ref:\s*refs\/heads\/(.+)$/m.exec(head), w = m && /wv-?0*(\d{1,4})(?!\d)/i.exec(m[1])
  return w ? { cur: "WV-" + w[1].padStart(4, "0"), allowed: [] } : { cur: "", allowed: [] }
}

/** Хук: починить подпись в файле. → { fixed, to, how } */
export function runHook(msgFile, gitDir) {
  const wave = slotWave(gitDir)
  const text = fs.readFileSync(msgFile, "utf8"), r = fixWaveMessage(text, wave)
  if (!r) return { fixed: false }
  fs.writeFileSync(msgFile, r.text)
  return { fixed: true, to: r.to, how: r.how }
}

/**
 * Поставить хуки в папку слота. Идемпотентно. Папка хуков проекта, которая действовала до установки, запоминается:
 * хуки слота передают вызов ей. wave — сразу записать номер волны (иначе — по ветке, пока диспетчерская не запишет).
 * @returns {{hooks:string, orig:string}}
 */
export function installSlotHooks(dir, { wave = null, node = process.execPath } = {}) {
  const gitDir = gitDirOf(dir); if (!gitDir) throw new Error("не git-папка: " + dir)
  const ours = path.join(gitDir, HOOKS_DIR), origFile = path.join(ours, ORIG_FILE)
  const effective = path.resolve(dir, git(dir, ["rev-parse", "--git-path", "hooks"]))
  let orig = effective
  if (fwd(effective).toLowerCase() === fwd(ours).toLowerCase()) { try { orig = fs.readFileSync(origFile, "utf8").trim() } catch { orig = path.join(git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "hooks") } }
  fs.mkdirSync(ours, { recursive: true })
  fs.writeFileSync(origFile, fwd(orig) + "\n")
  const fwdTo = (name) => "h=" + sq(fwd(path.join(orig, name))) + "\n[ -x \"$h\" ] && exec \"$h\" \"$@\"\nexit 0\n"
  for (const name of HOOK_NAMES) {
    const body = name === "commit-msg" ? sq(fwd(node)) + " " + sq(fwd(SCRIPT)) + " \"$1\" || exit $?\n" + fwdTo(name) : fwdTo(name)
    const file = path.join(ours, name)
    fs.writeFileSync(file, "#!/bin/sh\n# хук папки слота диспетчерской\n" + body)
    try { fs.chmodSync(file, 0o755) } catch { /* Windows: права не нужны */ }
  }
  if (git(dir, ["config", "--local", "--default", "", "--get", "extensions.worktreeConfig"]) !== "true") git(dir, ["config", "--local", "extensions.worktreeConfig", "true"])
  git(dir, ["config", "--worktree", "core.hooksPath", fwd(ours)])
  if (wave) writeSlotWave(dir, typeof wave === "string" ? { cur: wave } : wave)
  return { hooks: fwd(ours), orig: fwd(orig) }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT
if (isMain) {
  const args = process.argv.slice(2)
  if (args[0] === "--install") {
    const dir = path.resolve(args[1] || "."), wi = args.indexOf("--wave")
    try { const r = installSlotHooks(dir, { wave: wi > 0 ? args[wi + 1] : null }); console.log("хуки слота: " + r.hooks + " (хуки проекта: " + r.orig + ")") } catch (e) { console.error(e.message); process.exitCode = 1 }
  } else if (args[0]) {
    // Хук не останавливает коммит: любая ошибка — только строка в stderr.
    try {
      const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8", windowsHide: true }).trim()
      const r = runHook(path.resolve(args[0]), gitDir)
      if (r.fixed) process.stderr.write("подпись: строка «Wave: " + r.to + "» поставлена хуком (" + r.how + ")\n")
    } catch (e) { process.stderr.write("хук commit-msg диспетчерской: " + e.message + "\n") }
  } else { console.error("нужно: commit-msg.mjs <файл подписи> | --install <папка слота> [--wave WV-NNNN]"); process.exitCode = 2 }
}
