// monitor.mjs — монитор машины без привязки к ОС: загрузка ЦП, память, тяжёлые процессы, проверка служб проекта.
//
// Общая часть работает везде: ЦП — по os.cpus(), память — /proc/meminfo (Linux), `vm_stat` (macOS) или os, процессы — `ps` (Linux, macOS).
// Подробности конкретной ОС подставляет модуль платформы через setPlatformMonitor (например, win-desktop: лимит
// выделения памяти Windows и список процессов) — ядро о них не знает.
import { execFile } from "./spawner.mjs"
import fs from "node:fs"
import os from "node:os"
import { S } from "./state.mjs"
import { PROJECT } from "../slots.mjs"
import { PORT } from "./config.mjs"
import { lateObject } from "./late.mjs"
import { agents } from "./agents.mjs"
import { jobList } from "./jobs.mjs"
import { MAIN, WT } from "../slots.mjs"
import { TREES, treeByKey } from "./trees.mjs"
import { enabled } from "./modules.mjs"
import { localServices } from "./services.mjs"
import * as win from "./monitor-win.mjs"
import { availMem } from "./free-mem.mjs"

const procs = lateObject("runner.mjs", "procs")
const GB = 1073741824
/** Процесс агента: у рантайма без постоянного процесса он есть только во время хода (a.rt.proc). */
const agentPid = (a) => (a && !a.dead && ((a.rt && a.rt.proc && a.rt.proc.pid) || (a.proc && a.proc.pid))) || 0
const winOn = () => process.platform === "win32" && enabled("win-desktop")

/** Что модулю win-desktop нужно знать о прогонах, агентах и слотах для разбора снимка. */
function winCtx() {
  const jobs = []
  try {
    for (const [id, ch] of procs.entries())
      if (ch && ch.pid) {
        const j = jobList().find((x) => x.id === id)
        jobs.push({ id, pid: ch.pid, slot: j && j.tree, label: j ? j.label : id })
      }
  } catch {
    /* раннер ещё не подключён */
  }
  const ags = [...agents.values()].filter(agentPid).map((a) => ({ key: a.key, pid: agentPid(a), label: (treeByKey(a.key) || {}).tag || a.key }))
  const tagOf = (k) => { const t = treeByKey(k); return t ? { tag: t.tag, epic: t.epic || null, emoji: t.emoji, title: t.title } : { tag: k, epic: null } }
  return { jobs, agents: ags, tagOf, tagSlots: Object.fromEntries(TREES.filter((t) => t.tag).map((t) => [t.tag, t.key])), wt: WT, main: MAIN }
}

// ── платформа ──
// memInfo(): Promise<{freeCommitGB,totalCommitGB,freePhysGB,totalPhysGB,commit?}> — `commit: true`, если ОС знает
// настоящий лимит выделения (тогда страница рисует его отдельной полосой);
// listProcs(): Promise<[{pid, ppid, name, mb, cpu, cmd}]> — снимок процессов.
const platform = { memInfo: null, listProcs: null }

/** Модуль ОС подставляет свои замеры; не заданное остаётся общим. */
export function setPlatformMonitor({ memInfo = null, listProcs = null } = {}) {
  if (memInfo) platform.memInfo = memInfo
  if (listProcs) platform.listProcs = listProcs
}

/** Память Linux из /proc/meminfo: доступно = MemAvailable + свободная подкачка. Не Linux — null. */
export function procMeminfo(text = null) {
  let t = text
  if (t == null) { try { t = fs.readFileSync("/proc/meminfo", "utf8") } catch { return null } }
  const kb = (k) => { const m = new RegExp("^" + k + ":\\s+(\\d+)", "m").exec(t); return m ? Number(m[1]) * 1024 : null }
  const total = kb("MemTotal"), avail = kb("MemAvailable")
  if (total == null || avail == null) return null
  const swapFree = kb("SwapFree") || 0, swapTotal = kb("SwapTotal") || 0
  return { freeCommitGB: (avail + swapFree) / GB, totalCommitGB: (total + swapTotal) / GB, freePhysGB: avail / GB, totalPhysGB: total / GB }
}

/** Память машины (кеш 60 с). freeCommitGB — сколько ещё можно выделить процессам: по нему решают, хватит ли места агенту. */
export async function memInfo() {
  if (S.memCache.v && Date.now() - S.memCache.at < 60000) return S.memCache.v
  let v = null
  try { v = platform.memInfo ? await platform.memInfo() : winOn() ? await win.readOsMemory() : null } catch { v = null }
  if (v && winOn() && !platform.memInfo) v = { ...v, commit: true }
  if (!v) v = procMeminfo()
  if (!v) { const free = availMem() / GB, total = os.totalmem() / GB; v = { freeCommitGB: free, totalCommitGB: total, freePhysGB: free, totalPhysGB: total } }
  S.memCache = { at: Date.now(), v }
  return v
}

// ── ЦП ──
export const HIST_N = 90
export const sysHist = { cpu: [], phys: [], commit: [] }

/** Загрузка ЦП по ядрам раз в 2 с: разница времён os.cpus() между замерами. */
export function cpuLoad(prev, cur) {
  const sum = (x) => x.user + x.nice + x.sys + x.irq + x.idle
  return cur.map((t, i) => {
    const p = prev[i] || t, tot = sum(t) - sum(p), idle = t.idle - p.idle
    return tot > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - idle / tot)))) : 0
  })
}

export function startCpuSampler() {
  S.prevCpu = os.cpus().map((c) => ({ ...c.times }))
  S.sysNow = null
  S.topProcs = []
  const tick = () => {
    const cur = os.cpus().map((c) => ({ ...c.times }))
    const cores = cpuLoad(S.prevCpu, cur)
    S.prevCpu = cur
    const cpu = Math.round(cores.reduce((a, b) => a + b, 0) / Math.max(1, cores.length))
    const total = os.totalmem(), m = S.memCache.v, free = m ? m.freePhysGB * GB : availMem()
    const phys = Math.round(100 * (1 - free / total)), commit = m && m.commit ? Math.round(100 * (1 - m.freeCommitGB / m.totalCommitGB)) : null
    for (const [k, v] of [["cpu", cpu], ["phys", phys], ["commit", commit]]) { sysHist[k].push(v); if (sysHist[k].length > HIST_N) sysHist[k].shift() }
    S.sysNow = {
      cpu,
      cores,
      model: (os.cpus()[0] || {}).model || "",
      physTotalGB: total / GB,
      physUsedGB: (total - free) / GB,
      phys,
      commit,
      commitTotalGB: commit != null ? m.totalCommitGB : null,
      commitFreeGB: commit != null ? m.freeCommitGB : null,
      load: sysHist,
      top: S.topProcs || [],
      topCpu: S.cpuTop || [],
      cpuTasks: S.cpuTasks || [],
      at: Date.now(),
    }
  }
  tick()
  setInterval(tick, 2000).unref()
}

export const memState = () => S.memCache
export const sysState = () => S.sysNow
export const stackState = () => S.stackNow
export const procRows = () => S.procList
export const slotUsageState = () => S.slotUsage

// ── процессы ──
export const MACHINE_SAMPLE_MS = Number(process.env.DASH_MACHINE_SAMPLE_MS) || 60000
export const maskCmd = (c) => String(c || "").replace(/((?:key|token|secret|password|pass)[=:\s]+)\S+/gi, "$1***").replace(/\s+/g, " ").slice(0, 200)

/** Разбор `ps -A -o pid=,ppid=,rss=,pcpu=,comm=`. */
export function parsePs(out) {
  const rows = []
  for (const l of String(out || "").split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/.exec(l)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), mb: Math.round(Number(m[3]) / 1024), cpu: Number(m[4]), name: m[5].trim().split("/").pop(), cmd: m[5].trim() })
  }
  return rows
}

const psProcs = () => new Promise((res) => {
  if (process.platform === "win32") return res(null) // список процессов Windows — модуль win-desktop
  execFile("ps", ["-A", "-o", "pid=,ppid=,rss=,pcpu=,comm="], { timeout: 15000, maxBuffer: 16e6 }, (err, out) => res(err ? null : parsePs(out)))
})

/** Процессы, которые диспетчерская запустила сама (прогоны и агенты), и их потомки: только их можно остановить со страницы. */
export function ownTree(rows, roots) {
  const kids = new Map()
  for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r.pid) }
  const own = new Set(), stack = [...roots]
  while (stack.length) { const p = stack.pop(); if (own.has(p)) continue; own.add(p); for (const k of kids.get(p) || []) stack.push(k) }
  return own
}

/** Применить снимок процессов: тяжёлые по памяти (по имени) и список для страницы с признаком «можно остановить». */
export function applyMachineSample(rows) {
  if (!Array.isArray(rows)) return
  const roots = new Set()
  try { for (const c of procs.values()) if (c && c.pid) roots.add(c.pid) } catch { /* раннер ещё не подключён */ }
  for (const a of agents.values()) { const p = agentPid(a); if (p) roots.add(p) }
  const own = ownTree(rows, roots)
  const by = new Map()
  for (const r of rows) { const e = by.get(r.name) || { name: r.name, n: 0, mb: 0 }; e.n++; e.mb += r.mb || 0; by.set(r.name, e) }
  S.topProcs = [...by.values()].sort((a, b) => b.mb - a.mb).slice(0, 7).map((e) => ({ name: String(e.name).replace(/\.exe$/i, ""), n: e.n, mb: Math.round(e.mb) }))
  S.cpuTop = rows.filter((r) => r.cpu > 0).sort((a, b) => b.cpu - a.cpu).slice(0, 6).map((r) => ({ name: r.name, pid: r.pid, cpu: Math.round(r.cpu) }))
  S.procList = rows.filter((r) => own.has(r.pid) || r.mb >= 200).sort((a, b) => b.mb - a.mb).slice(0, 40)
    .map((r) => ({ pid: r.pid, name: r.name, mb: r.mb, cpu: Math.round(r.cpu || 0), cmd: maskCmd(r.cmd), killable: own.has(r.pid) && r.pid !== process.pid }))
}

let machineBusy = false
export async function sampleMachine() {
  if (machineBusy) return
  machineBusy = true
  try {
    if (winOn() && !platform.listProcs) {
      // Windows: снимок PowerShell разбирает модуль win-desktop (процессы по ролям, слоты, окна редактора)
      const d = await win.sampleMachine()
      if (d) {
        const r = win.analyzeSample(d, winCtx())
        if (r.mem) S.memCache = { at: Date.now(), v: { ...r.mem, commit: true } }
        S.topProcs = r.topProcs; S.procList = r.procList; S.cpuTop = r.cpuTop; S.cpuTasks = r.cpuTasks; S.slotUsage = r.slotUsage
      }
      return
    }
    await memInfo()
    let rows = null
    try { rows = platform.listProcs ? await platform.listProcs() : await psProcs() } catch { rows = null }
    if (rows) applyMachineSample(rows)
  } catch (e) { console.error("снимок машины:", e.message) } finally { machineBusy = false }
}

// ── службы проекта ──

/**
 * Службы этой машины из конфига (`machines.local.services`): у кого есть команда `check`, та проверяется раз в проход
 * (код 0 — работает) тем же запуском, что поднимает службы перед прогоном (services.mjs, через bash). Первой строкой —
 * сама диспетчерская.
 */
export async function sampleStack() {
  const ls = localServices(), svcs = ls.list
  const rows = [{ id: "dash", name: "Диспетчерская", port: PORT, ok: true, ms: null, pid: process.pid, need: true, note: "этот сервер" }]
  const checks = await Promise.all(svcs.map((s) => s.check ? ls.check(s, PROJECT.repo.main) : Promise.resolve(null)))
  svcs.forEach((s, i) => {
    const r = checks[i]
    rows.push({
      id: "svc-" + s.name,
      name: s.name,
      ok: r ? r.ok : true,
      ms: r ? r.ms : null,
      need: !!r,
      note: r
        ? r.ok
          ? "проверка прошла"
          : r.why || "проверка не прошла: " + s.check
        : "проверки нет (ключ `check`); поднимается командой `up` перед каждым прогоном",
    })
  })
  S.stackNow = rows
}
