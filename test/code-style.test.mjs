// code-style.test.mjs — сторож длины строк кода: строка .mjs длиннее MAX_LINE знаков — падение.
//
// Зачем: длинная строка — это обычно вшитый текст подсказки агенту или выражение, которое нельзя прочитать без прокрутки.
// Тексты подсказок живут в scripts/dev/prompts/*.md (помощник scripts/dev/prompts.mjs), длинные выражения переносятся.
// Исключения — test/fixtures/long-lines-allow.txt: строка «путь<TAB>начало строки<TAB># почему»; оправданы только данные,
// которые не делятся без потери смысла (регулярные выражения одной альтернативой). Исключение, которого больше нет в коде, —
// тоже падение: список не копит мёртвых записей.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const MAX_LINE = 200
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const ALLOW_FILE = path.join(ROOT, "test", "fixtures", "long-lines-allow.txt")
// Не код конструктора: своё у установки (как в .gitignore), зависимости, инструменты переноса.
const SKIP = new Set([".git", "node_modules", ".import", "project", "projects", ".hub", "dispatcher.project.mjs"])

/** Все .mjs конструктора: пути от корня через «/». */
export function codeFiles(root = ROOT) {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(".mjs")) out.push(path.relative(root, p).split(path.sep).join("/"))
    }
  }
  walk(root)
  return out.sort()
}

/** Разбор списка исключений: [{ file, start, why }]; пустые строки и строки с «#» в начале пропускаются. */
export function parseAllow(text) {
  return String(text).replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => {
    const [file = "", start = "", why = ""] = l.split("\t")
    return { file: file.trim(), start: start.trim(), why: why.replace(/^#\s*/, "").trim() }
  })
}

/** Длинные строки файлов → { bad: ["путь:строка (длина)"], used: Set индексов исключений }. */
export function longLines(files, read, allow = [], max = MAX_LINE) {
  const bad = [], used = new Set()
  for (const f of files) {
    read(f).replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
      if (line.length <= max) return
      const k = allow.findIndex((a) => a.file === f && a.start && line.trim().startsWith(a.start))
      if (k >= 0) used.add(k)
      else bad.push(f + ":" + (i + 1) + " (" + line.length + ")")
    })
  }
  return { bad, used }
}

test("сторож длины строк: в .mjs нет строк длиннее " + MAX_LINE + " знаков, кроме списка исключений", () => {
  const files = codeFiles(), allow = parseAllow(fs.readFileSync(ALLOW_FILE, "utf8"))
  assert.ok(files.length > 100, "файлов кода нашлось " + files.length)
  for (const a of allow) assert.ok(a.file && a.start && a.why, "исключение без пути, начала строки или причины: " + JSON.stringify(a))
  const { bad, used } = longLines(files, (f) => fs.readFileSync(path.join(ROOT, f), "utf8"), allow)
  assert.deepEqual(bad, [], "строки длиннее " + MAX_LINE + " знаков: текст подсказки — в scripts/dev/prompts/*.md, выражение — перенеси")
  const stale = allow.filter((_, k) => !used.has(k)).map((a) => a.file + "\t" + a.start)
  assert.deepEqual(stale, [], "исключения, которых больше нет в коде (убери из " + path.basename(ALLOW_FILE) + ")")
})

test("сторож длины строк ловит длинную строку и узнаёт исключение по началу строки", () => {
  const src = { "a.mjs": "const x = 1\n" + "const s = \"" + "я".repeat(MAX_LINE) + "\"\n", "b.mjs": "  /" + "a|".repeat(MAX_LINE) + "/\n" }
  const read = (f) => src[f]
  assert.deepEqual(longLines(["a.mjs", "b.mjs"], read).bad, ["a.mjs:2 (" + (MAX_LINE + 12) + ")", "b.mjs:1 (" + (2 * MAX_LINE + 4) + ")"])
  const allow = parseAllow("# комментарий\nb.mjs\t/a|a|\t# регулярка\n\nc.mjs\tнет\t# лишнее\n")
  const r = longLines(["a.mjs", "b.mjs"], read, allow)
  assert.deepEqual(r.bad, ["a.mjs:2 (" + (MAX_LINE + 12) + ")"])
  assert.deepEqual([...r.used], [0], "второе исключение не использовано — тест выше назовёт его мёртвым")
})
