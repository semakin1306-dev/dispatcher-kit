// git-exclude.mjs — служебные файлы агента в папке слота (запреты рантайма) не должны делать слот «изменённым»:
// их строка вносится в info/exclude репозитория. Общий помощник адаптеров рантайма.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const gitOut = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim()

/**
 * Внести строку в info/exclude репозитория (для рабочей копии слота это общий exclude основной папки:
 * у git нет exclude отдельной рабочей копии). → true — строка есть; false — папка не в git.
 */
export function ensureExcluded(dir, pattern) {
  let file
  try { file = gitOut(dir, ["rev-parse", "--git-path", "info/exclude"]) } catch { return false }
  if (!path.isAbsolute(file)) file = path.resolve(dir, file)
  let cur = ""; try { cur = fs.readFileSync(file, "utf8") } catch { /* файла ещё нет */ }
  if (cur.split(/\r?\n/).includes(pattern)) return true
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, (cur && !cur.endsWith("\n") ? "\n" : "") + pattern + "\n")
  return true
}

/** Файл в индексе git этой папки? */
export const trackedIn = (dir, rel) => { try { gitOut(dir, ["ls-files", "--error-unmatch", "--", rel]); return true } catch { return false } }
