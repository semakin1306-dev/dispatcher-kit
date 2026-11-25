// proc-tree.test.mjs — дерево процессов для снятия на Linux и macOS: разбор `ps` и /proc/<pid>/stat, порядок обхода.
import { test } from "node:test"
import assert from "node:assert/strict"
import { parsePs, ppidOfStat, treeOf, parentTable } from "./proc-tree.mjs"

test("разбор `ps -A -o pid= -o ppid=`: пробелы в начале, мусорные строки пропускаются", () => {
  const m = parsePs("    1     0\n  200     1\n  201   200\n\nPID PPID\n")
  assert.deepEqual([...m], [[1, 0], [200, 1], [201, 200]])
})

test("ppid из /proc/<pid>/stat: имя процесса со скобками и пробелами не сбивает", () => {
  assert.equal(ppidOfStat("4242 (node) S 4100 4242 4100 0 -1"), 4100)
  assert.equal(ppidOfStat("77 (a) b (c)) R 12 77 12 0"), 12)
  assert.equal(ppidOfStat("мусор"), null)
})

test("дерево: потомки глубокими первыми, сам процесс последним; чужие ветки и петли не берутся", () => {
  const t = new Map([[10, 1], [11, 10], [12, 10], [13, 11], [20, 1], [30, 30]])
  const order = treeOf(10, t)
  assert.equal(order.at(-1), 10)
  assert.deepEqual([...order].sort((a, b) => a - b), [10, 11, 12, 13])
  assert.ok(order.indexOf(13) < order.indexOf(11), "внук раньше сына")
  assert.deepEqual(treeOf(30, t), [30])
  assert.deepEqual(treeOf(99, new Map()), [99], "таблицы нет — снимается только сам процесс")
})

test("таблица этой машины видит текущий процесс и его родителя", { skip: process.platform === "win32" && "на Windows дерево снимает taskkill /T" }, () => {
  const t = parentTable()
  assert.equal(t.get(process.pid), process.ppid)
})
