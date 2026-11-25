// paths.mjs — сравнение путей так, как их видит файловая система, а не как они записаны. Один и тот же каталог
// приходит разной записью: из конфига и временной папки — с короткими именами 8.3 Windows (RUNNER~1) или через ссылку
// (/var → /private/var на macOS), от git — уже раскрытым. Строковое сравнение таких путей считает их разными.
import fs from "node:fs"
import path from "node:path"

// Windows и macOS по умолчанию не различают регистр в именах файлов.
const FOLD = process.platform === "win32" || process.platform === "darwin"

/**
 * Канонический вид пути для сравнения: абсолютный, ссылки и короткие имена раскрыты (по ближайшему существующему
 * предку, если самого пути ещё нет), косые черты прямые, без хвостовой черты; на Windows и macOS — в нижнем регистре.
 */
export function canonPath(p) {
  let head = path.resolve(String(p))
  const tail = []
  for (;;) {
    try { head = fs.realpathSync.native(head); break } catch { /* такого пути ещё нет — раскрываем предка */ }
    const up = path.dirname(head)
    if (up === head) break
    tail.unshift(path.basename(head))
    head = up
  }
  let s = path.join(head, ...tail).replace(/\\/g, "/")
  if (s.length > 1 && !/^[A-Za-z]:\/$/.test(s)) s = s.replace(/\/+$/, "")
  return FOLD ? s.toLowerCase() : s
}

/** Один ли это каталог (файл), как бы ни были записаны пути. */
export const samePath = (a, b) => canonPath(a) === canonPath(b)

/** Лежит ли путь внутри каталога root (или совпадает с ним). */
export function insidePath(p, root) {
  const c = canonPath(p), r = canonPath(root)
  return c === r || c.startsWith(r.endsWith("/") ? r : r + "/")
}
