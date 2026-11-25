// free-mem.mjs — сколько памяти машина может отдать процессам прямо сейчас, на любой ОС. os.freemem() на Linux и
// Windows это и есть, а на macOS считает только совсем свободные страницы: на занятой машине — доли гигабайта при
// гигабайтах, которые система отдаст по первому требованию. Там доступное берётся из `vm_stat`.
import cp from "node:child_process"
import os from "node:os"

/** Доступно по выводу `vm_stat`: свободные + спекулятивные + неактивные страницы, в байтах; нет нужных строк — null. */
export function vmStatAvail(text, total = os.totalmem()) {
  const t = String(text || ""), page = Number((/page size of (\d+) bytes/.exec(t) || [])[1])
  const pages = (k) => { const m = new RegExp("^Pages " + k + ":\\s+(\\d+)", "m").exec(t); return m ? Number(m[1]) : null }
  const free = pages("free"), inactive = pages("inactive")
  if (!page || free == null || inactive == null) return null
  return Math.min(total, (free + (pages("speculative") || 0) + inactive) * page)
}

let cache = { at: 0, v: 0 }

/** Доступная память в байтах; на macOS — по `vm_stat` с кешем на 10 с. */
export function availMem(now = Date.now()) {
  if (process.platform !== "darwin") return os.freemem()
  if (cache.at && now - cache.at < 10000) return cache.v
  let v = null
  try { v = vmStatAvail(cp.execFileSync("vm_stat", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })) } catch { /* без vm_stat — как есть */ }
  cache = { at: now, v: v ?? os.freemem() }
  return cache.v
}
