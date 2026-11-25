// commit-msg.test.mjs — хук папки слота на временном git-репозитории: строка «Wave: WV-NNNN» ставится, переносится и
// перенумеровывается; основная папка и другие копии не задеты; хуки проекта продолжают работать.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { installSlotHooks, writeSlotWave, slotWave, gitDirOf } from "./commit-msg.mjs"
import { commitMessageCheck, fixWaveMessage } from "../dashboard/commit-rules.mjs"
import { samePath } from "../paths.mjs"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dk-hook-"))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"),
}
for (const k of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete env[k]
fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "")
const g = (dir, ...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env }).trim()
const MAIN = path.join(TMP, "main"), SLOT = path.join(TMP, "wv0042-slot"), TRAIN = path.join(TMP, "tr-api")
const commit = (dir, file, ...msg) => {
  fs.writeFileSync(path.join(dir, file), file)
  g(dir, "add", file)
  g(dir, "commit", "-q", ...msg.flatMap((m) => ["-m", m]))
  return g(dir, "log", "-1", "--format=%B")
}

fs.mkdirSync(MAIN)
g(MAIN, "init", "-q", "-b", "staging"); commit(MAIN, "base", "base")
// Хук проекта: pre-commit пишет метку — после установки хуков слота он должен по-прежнему срабатывать.
const projHooks = path.join(MAIN, ".git", "hooks"); fs.mkdirSync(projHooks, { recursive: true })
fs.writeFileSync(path.join(projHooks, "pre-commit"), "#!/bin/sh\necho ok >> \"$(git rev-parse --show-toplevel)/../pre-commit-ran\"\nexit 0\n"); fs.chmodSync(path.join(projHooks, "pre-commit"), 0o755)
g(MAIN, "worktree", "add", "-q", "-b", "dev/wv-0042-slot", SLOT, "staging")
g(MAIN, "worktree", "add", "-q", "-b", "dev/tr-api-demo", TRAIN, "staging")

test("установка: своя папка хуков только у этой копии, хуки проекта запоминаются", () => {
  const r = installSlotHooks(SLOT)
  assert.match(r.hooks, /dispatcher-hooks$/)
  // TMP записан как его дала ОС (короткие имена Windows, /var на macOS), git отдаёт пути раскрытыми: сравнение — по файловой системе
  assert.ok(samePath(r.orig, projHooks), r.orig + " ≠ " + projHooks)
  assert.ok(samePath(path.resolve(SLOT, g(SLOT, "rev-parse", "--git-path", "hooks")), r.hooks))
  assert.ok(samePath(path.resolve(MAIN, g(MAIN, "rev-parse", "--git-path", "hooks")), projHooks), "основная папка — со своими хуками")
  const again = installSlotHooks(SLOT)
  assert.ok(samePath(again.orig, projHooks), "повторная установка не принимает свою папку за папку проекта: " + again.orig)
})

test("подпись без строки — хук ставит номер по ветке слота; хук проекта отработал", () => {
  fs.rmSync(path.join(TMP, "pre-commit-ran"), { force: true })
  const msg = commit(SLOT, "a.txt", "feat(api): WV-0042 ST1: ручка")
  assert.equal(commitMessageCheck(msg, "WV-0042").ok, true, msg)
  assert.ok(fs.existsSync(path.join(TMP, "pre-commit-ran")), "pre-commit проекта вызван через папку хуков слота")
  assert.deepEqual(g(SLOT, "log", "-1", "--format=%(trailers:key=Wave,valueonly)").split("\n").filter(Boolean), ["WV-0042"], "git видит строку трейлером")
})

test("строка не в последнем абзаце и перед Co-Authored-By — переносится в блок трейлеров", () => {
  const msg = commit(SLOT, "b.txt", "fix(api): WV-0042 ST2: x", "тело", "Wave: WV-0042", "Co-Authored-By: c <c@example.com>")
  assert.equal(commitMessageCheck(msg, "WV-0042").ok, true, msg)
  assert.equal(msg.match(/Wave:/g).length, 1)
  assert.match(msg, /Co-Authored-By: c <c@example.com>\nWave: WV-0042\s*$/)
})

test("поезд: номер из файла диспетчерской; чужой — заменяется на вагон в работе, разрешённый — остаётся", () => {
  installSlotHooks(TRAIN, { wave: { cur: "WV-0051", allowed: ["WV-0050"] } })
  assert.deepEqual(slotWave(gitDirOf(TRAIN)), { cur: "WV-0051", allowed: ["WV-0051", "WV-0050"] })
  assert.match(commit(TRAIN, "c.txt", "feat: x", "Wave: WV-0049"), /\n\nWave: WV-0051\s*$/)
  assert.match(commit(TRAIN, "d.txt", "fix: починка влитого вагона", "Wave: WV-0050"), /\n\nWave: WV-0050\s*$/, "верная подпись не меняется")
  writeSlotWave(TRAIN, { cur: "WV-0052", allowed: ["WV-0051"] })
  assert.match(commit(TRAIN, "e.txt", "feat: следующий вагон"), /Wave: WV-0052\s*$/)
})

test("основная папка не задета: коммит без строки остаётся как был", () => {
  assert.equal(commit(MAIN, "m.txt", "chore: своё"), "chore: своё")
})

test("fixWaveMessage: номер неизвестен, пустая подпись, верная подпись — null; комментарии git остаются в конце", () => {
  assert.equal(fixWaveMessage("feat: x", {}), null)
  assert.equal(fixWaveMessage("\n# комментарий\n", { cur: "WV-0001" }), null)
  assert.equal(fixWaveMessage("feat: x\n\nWave: WV-0001\n", { cur: "WV-0001" }), null)
  const r = fixWaveMessage("feat: x\n\n# Please enter the commit message\n# строки с # убираются\n", { cur: "wv-1" })
  assert.equal(r.to, "WV-0001"); assert.equal(r.how, "added")
  assert.match(r.text, /^feat: x\n\nWave: WV-0001\n\n# Please enter/)
  const one = fixWaveMessage("fix: x\nWave: WV-0007", { cur: "WV-0007" })
  assert.equal(one.text, "fix: x\n\nWave: WV-0007\n"); assert.equal(one.how, "moved")
})
