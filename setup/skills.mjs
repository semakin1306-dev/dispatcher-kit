// skills.mjs — раскладка навыков диспетчерской (skills/*/SKILL.md) туда, где их ищет рантайм агента.
//
// Куда: в профиль пользователя — Claude Code читает ~/.claude/skills/<имя>/SKILL.md, Codex — ~/.agents/skills/<имя>/SKILL.md.
// Не в папку проекта: агенты работают в рабочих копиях слотов и в папке эпика, а навыки в проекте пришлось бы держать
// в его git (иначе каждая копия выглядела бы изменённой). Свой каталог — DISPATCHER_SKILLS_DIR.
// В текстах навыков заглушка `<дом диспетчерской>` заменяется настоящим путём: команды эпиков зовутся по полному пути.
// Чужой навык с тем же именем не перезаписывается: свой узнаётся по метке в конце файла.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { HOME, fwd } from "../scripts/dev/project.mjs"

export const SKILLS_SRC = path.join(HOME, "skills")
export const HOME_MARK = "<дом диспетчерской>"
const MARK = "<!-- dispatcher-kit: навык диспетчерской, перезаписывается `node setup.mjs apply` -->"

/** Каталог навыков рантайма. Под `node --test` без явного каталога — null: тесты не пишут в профиль пользователя. */
export function skillsDir(runtime = "claude", env = process.env) {
  if (env.DISPATCHER_SKILLS_DIR) return path.resolve(env.DISPATCHER_SKILLS_DIR)
  if (env.NODE_TEST_CONTEXT) return null
  return path.join(os.homedir(), runtime === "codex" ? ".agents" : ".claude", "skills")
}

/** Текст навыка для установки: путь дома диспетчерской вместо заглушки и метка «свой». */
export const skillText = (src, home = HOME) => src.split(HOME_MARK).join(fwd(home)).replace(/\s*$/, "\n") + "\n" + MARK + "\n"

/**
 * Разложить навыки. → [{ name, file, status }] — status: written (записан), same (уже такой), kept (чужой файл с тем же
 * именем — не тронут), skipped (каталога нет: тест).
 */
export function installSkills({ runtime = "claude", dir = skillsDir(runtime), home = HOME, src = SKILLS_SRC, dryRun = false } = {}) {
  const out = []
  for (const name of fs.readdirSync(src).filter((n) => fs.existsSync(path.join(src, n, "SKILL.md"))).sort()) {
    if (!dir) { out.push({ name, file: "", status: "skipped" }); continue }
    const file = path.join(dir, name, "SKILL.md"), text = skillText(fs.readFileSync(path.join(src, name, "SKILL.md"), "utf8"), home)
    let cur = null
    try { cur = fs.readFileSync(file, "utf8") } catch { /* навыка ещё нет */ }
    if (cur === text) { out.push({ name, file: fwd(file), status: "same" }); continue }
    if (cur !== null && !cur.includes(MARK)) { out.push({ name, file: fwd(file), status: "kept" }); continue }
    if (!dryRun) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
    out.push({ name, file: fwd(file), status: "written" })
  }
  return out
}
