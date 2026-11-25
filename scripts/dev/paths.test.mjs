// paths.test.mjs — сравнение путей по файловой системе: ссылка на каталог (как /var → /private/var на macOS или
// короткие имена Windows) — тот же каталог; несуществующий хвост раскрывается по предку.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { canonPath, insidePath, samePath } from "./paths.mjs"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dk-paths-"))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))
const REAL = path.join(TMP, "real"), LINK = path.join(TMP, "link")
fs.mkdirSync(path.join(REAL, "sub"), { recursive: true })
fs.symlinkSync(REAL, LINK, "junction")

test("ссылка и настоящий путь — один каталог; и для ещё не созданного хвоста", () => {
  assert.ok(samePath(LINK, REAL))
  assert.ok(samePath(path.join(LINK, "sub"), path.join(REAL, "sub")))
  assert.ok(samePath(path.join(LINK, "нет", "ещё"), path.join(REAL, "нет", "ещё")))
  assert.ok(!samePath(path.join(REAL, "sub"), REAL))
})

test("запись не важна: обратные черты, хвостовая черта, относительный путь", () => {
  assert.ok(samePath(REAL + path.sep, REAL.replace(/\\/g, "/")))
  assert.ok(samePath(path.relative(process.cwd(), REAL), REAL))
  assert.ok(!canonPath(REAL).includes("\\"))
})

test("внутри каталога: по файловой системе, а не по началу строки", () => {
  assert.ok(insidePath(path.join(LINK, "sub", "x"), REAL))
  assert.ok(insidePath(REAL, LINK))
  assert.ok(!insidePath(REAL + "-соседний", REAL), "соседний каталог с тем же началом имени — не внутри")
})

test("регистр: на Windows и macOS не различается, на Linux — различается", () => {
  const same = samePath(path.join(REAL, "SUB"), path.join(REAL, "sub"))
  assert.equal(same, process.platform === "win32" || process.platform === "darwin")
})
