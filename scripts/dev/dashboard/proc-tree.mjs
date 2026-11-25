// proc-tree.mjs — снять процесс вместе с потомками на Linux и macOS. На Windows это делает `taskkill /T`; здесь сигнал
// одному процессу оставил бы его детей (тесты, сборки, инструменты агента) сиротами. Потомки — по таблице «pid → ppid»:
// на Linux из /proc, на остальных системах из `ps`. Сигнал идёт всем из снимка, глубоким первыми.
import cp from "node:child_process"
import fs from "node:fs"

/** Строки `ps -A -o pid= -o ppid=` → Map pid → ppid. */
export function parsePs(text) {
  const m = new Map()
  for (const line of String(text || "").split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (pid > 0 && ppid >= 0) m.set(pid, ppid)
  }
  return m
}

/** Содержимое /proc/<pid>/stat → ppid (имя процесса в скобках может содержать пробелы и скобки). */
export function ppidOfStat(text) {
  const s = String(text || ""), i = s.lastIndexOf(")")
  const n = i < 0 ? NaN : Number(s.slice(i + 2).split(" ")[1])
  return Number.isInteger(n) ? n : null
}

/** Таблица pid → ppid всех процессов; не удалось прочитать — пустая (тогда снимается только сам процесс). */
export function parentTable() {
  if (process.platform === "linux") {
    try {
      const m = new Map()
      for (const d of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(d)) continue
        try { const pp = ppidOfStat(fs.readFileSync("/proc/" + d + "/stat", "utf8")); if (pp != null) m.set(Number(d), pp) } catch { /* процесс уже вышел */ }
      }
      if (m.size) return m
    } catch { /* без /proc — через ps */ }
  }
  try { return parsePs(cp.execFileSync("ps", ["-A", "-o", "pid=", "-o", "ppid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 })) } catch { return new Map() }
}

/** pid и все его потомки, глубокие первыми, сам pid — последним. */
export function treeOf(pid, table = parentTable()) {
  const kids = new Map()
  for (const [p, pp] of table) { if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(p) }
  const seen = new Set([pid]), order = [pid]
  for (let i = 0; i < order.length; i++)
    for (const k of kids.get(order[i]) || []) if (!seen.has(k)) { seen.add(k); order.push(k) }
  return order.reverse()
}

/**
 * Сигнал процессу и всем его потомкам (Linux, macOS). killRoot — чем снять сам процесс (у дочернего процесса Node —
 * его kill(), чтобы он знал, что снят); по умолчанию process.kill.
 */
export function killPosixTree(pid, sig = "SIGTERM", killRoot = null) {
  if (!(pid > 0)) return
  for (const p of treeOf(pid)) {
    try { if (p === pid && killRoot) killRoot(sig); else process.kill(p, sig) } catch { /* уже вышел */ }
  }
}
