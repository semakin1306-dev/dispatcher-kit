// monitor-win.mjs — Windows-часть монитора машины (модуль win-desktop): снимок машины через PowerShell (monitor.ps1),
// лимит выделения памяти ОС, разбор процессов по прогонам, агентам и слотам, окна VS Code слотов (windows.ps1) и их
// раскладка (slot-windows.ps1). Общий монитор (monitor.mjs) зовёт эти функции только при включённом модуле win-desktop.
//
// Модуль не держит состояния сервера и не импортирует агентов и прогоны: всё, что нужно знать о них, приходит в `ctx`
// (см. analyzeSample), а результат возвращается — куда его положить, решает общий монитор.
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "./spawner.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const MONITOR_PS1 = path.join(HERE, "monitor.ps1")
export const WINDOWS_PS1 = path.join(HERE, "windows.ps1")
export const SLOT_WINDOWS_PS1 = path.join(HERE, "..", "slot-windows.ps1")
const PS = "powershell.exe"
const psFile = (file, args = []) => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, ...args]
const KB_PER_GB = 1048576
const r1 = (x) => Math.round(x * 10) / 10
const mbOf = (r) => (r.WorkingSetSize || 0) / 1048576

// ───────────────────────────── память ОС ─────────────────────────────

/** Килобайты из Win32_OperatingSystem → гигабайты; null — ответ не разобран. */
export function memFromKB(kb) {
  if (!kb || !kb.totalCommitKB) return null
  const v = { freeCommitGB: kb.freeCommitKB / KB_PER_GB, totalCommitGB: kb.totalCommitKB / KB_PER_GB, freePhysGB: kb.freePhysKB / KB_PER_GB, totalPhysGB: kb.totalPhysKB / KB_PER_GB }
  return Object.values(v).some((x) => !Number.isFinite(x)) ? null : v
}

/**
 * Память ОС с лимитом выделения (commit) прямым запросом — для проверки перед запуском агента, когда снимок устарел.
 * Кеширует вызывающий (снимок машины приносит то же раз в минуту).
 * @returns {Promise<{freeCommitGB, totalCommitGB, freePhysGB, totalPhysGB}|null>}
 */
export function readOsMemory({ exec = execFile } = {}) {
  return new Promise((res) => exec(PS, ["-NoProfile", "-NonInteractive", "-Command",
    "$o=Get-CimInstance Win32_OperatingSystem;\"$($o.FreeVirtualMemory) $($o.TotalVirtualMemorySize) $($o.FreePhysicalMemory) $($o.TotalVisibleMemorySize)\""],
  { windowsHide: true, timeout: 15000 }, (err, out) => {
    const n = String(out || "").trim().split(/\s+/).map(Number)
    res(err || n.length < 4 ? null : memFromKB({ freeCommitKB: n[0], totalCommitKB: n[1], freePhysKB: n[2], totalPhysKB: n[3] }))
  }))
}

// ───────────────────────────── снимок машины ─────────────────────────────

let sampling = false
/**
 * Один снимок машины (monitor.ps1): { procs, perf, windows, mem } как есть. Пока идёт прошлый — null без нового запуска.
 * @returns {Promise<object|null>}
 */
export function sampleMachine({ exec = execFile, timeoutMs = 45000 } = {}) {
  if (sampling) return Promise.resolve(null)
  sampling = true
  return new Promise((res) => exec(PS, psFile(MONITOR_PS1), { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
    sampling = false
    if (err || !out) return res(null)
    try { res(JSON.parse(String(out))) } catch { res(null) }
  }))
}

// ───────────────────────────── разбор снимка ─────────────────────────────

const AGENT_CLI = /^(node|claude|codex)\.exe$/i
const SHELLS = /^(node|claude|codex|cmd|powershell|pwsh|bash|pnpm|npm|yarn)\.exe$/i
const WORKER_RE = /processChild\.js|jest-worker|tinypool|vitest[\\/]dist[\\/]workers?|forks\.js/i
const MAIN_RE = /jest[\\/]bin[\\/]jest\.js|vitest\.mjs|vitest[\\/]dist[\\/]cli/i
const RUNNER_RE = /slot-up\.mjs/i
const DEV_RE = /\b(vite|next|nuxt|astro|webpack|nodemon)\b/i

/** Командная строка без значений ключей и паролей, в одну строку. */
export const maskCmd = (c) => String(c || "").replace(/((?:key|token|secret|password|pass)[=:\s]+)\S+/gi, "$1***").replace(/\s+/g, " ").slice(0, 200)

const lowFwd = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Слот по командной строке процесса: процесс, запущенный в папке слота, относится к нему.
 * wt — папка слотов (служебные папки с `_` в начале — не слоты), main — основная папка проекта (её ключ — "staging").
 */
export function slotNameOf(cmd, { wt = "", main = "" } = {}) {
  const c = lowFwd(cmd)
  if (wt) { const m = new RegExp(reEsc(lowFwd(wt)) + "/([a-z0-9][a-z0-9._-]{0,40})(?=[/\"\\s]|$)").exec(c); if (m) return m[1] }
  if (main && new RegExp(reEsc(lowFwd(main)) + "(?=[/\"\\s]|$)").test(c)) return "staging"
  return null
}

/**
 * Слот по заголовку окна VS Code: заголовок окна слота — «[<метка> <название>] …» (slot-workspaces.mjs), заголовок
 * по умолчанию — «… - <папка> (Workspace)». tagSlots — { метка: ключ слота }.
 */
export function winSlot(title, tagSlots = {}) {
  const t = String(title || "")
  const tag = /^\[(\S+)\s/.exec(t); if (tag && tagSlots[tag[1]]) return tagSlots[tag[1]]
  const m = / - ([^\s]+) \((?:Workspace|Рабочая область)\)/.exec(t)
  return m ? m[1] : null
}

/** Семь самых тяжёлых имён процессов по памяти. */
export function topProcsOf(rows) {
  const by = new Map()
  for (const r of rows) { const e = by.get(r.Name) || { name: r.Name, n: 0, mb: 0 }; e.n++; e.mb += mbOf(r); by.set(r.Name, e) }
  return [...by.values()].sort((a, b) => b.mb - a.mb).slice(0, 7).map((e) => ({ name: String(e.name).replace(/\.exe$/i, ""), n: e.n, mb: Math.round(e.mb) }))
}

const fullCtx = (ctx = {}) => ({
  selfPid: process.pid, cores: Math.max(1, os.cpus().length), jobs: [], agents: [], wt: "", main: "", tagSlots: {}, now: Date.now(),
  tagOf: (k) => ({ tag: k, epic: null }), ...ctx,
})

/** Процессы node и агентских CLI с ролью: прогон, агент, тесты, dev-сервер, сам сервер. Самые тяжёлые 25. */
export function procRowsOf(rows, ctx0) {
  const ctx = fullCtx(ctx0)
  const byPid = new Map(rows.map((r) => [r.ProcessId, r]))
  const jobBy = new Map(ctx.jobs.filter((j) => j.pid).map((j) => [j.pid, j])), agentBy = new Map(ctx.agents.filter((a) => a.pid).map((a) => [a.pid, a]))
  const ancestors = (pid) => { const seen = []; let p = pid, n = 0; while (p && byPid.has(p) && n++ < 12) { seen.push(p); p = byPid.get(p).ParentProcessId } return seen }
  return rows.filter((r) => AGENT_CLI.test(r.Name)).map((r) => {
    const anc = ancestors(r.ProcessId), cmd = String(r.CommandLine || ""), exe = r.Name.toLowerCase()
    const job = anc.map((p) => jobBy.get(p)).find(Boolean) || null, agent = anc.map((p) => agentBy.get(p)).find(Boolean) || null
    const self = r.ProcessId === ctx.selfPid
    let role = exe === "node.exe" ? "node" : exe.replace(/\.exe$/, ""), what = ""
    if (self || /dashboard[\\/]server\.mjs/.test(cmd)) { role = "диспетчерская"; what = "этот сервер" }
    else if (job) {
      const kind = WORKER_RE.test(cmd) ? "worker" : MAIN_RE.test(cmd) ? "main" : RUNNER_RE.test(cmd) ? "runner" : "other"
      let wn = ""
      if (kind === "worker") { const sib = rows.filter((x) => x.ParentProcessId === r.ParentProcessId && WORKER_RE.test(String(x.CommandLine || ""))).map((x) => x.ProcessId).sort((a, b) => a - b); wn = " №" + (sib.indexOf(r.ProcessId) + 1) + " из " + sib.length }
      role = kind === "worker" ? "воркер" + wn : kind === "main" ? "тесты · главный" : kind === "runner" ? "раннер" : "прогон"
      what = job.label || job.id
    } else if (agent) { role = "агент диспетчерской"; what = agent.label || agent.key }
    else if (/jest|vitest|mocha|playwright/i.test(cmd)) { role = "тесты"; what = maskCmd(cmd).slice(0, 90) }
    else if (DEV_RE.test(cmd)) { role = "dev-сервер"; what = maskCmd(cmd).slice(0, 90) }
    else if (exe !== "node.exe") { role = role + " (окно редактора)"; what = /\bresume\b/.test(cmd) ? "с продолжением сессии" : "" }
    else what = maskCmd(cmd).slice(0, 90)
    const created = Number(r.Created) || 0
    return { pid: r.ProcessId, name: r.Name.replace(/\.exe$/i, ""), role, what, jobId: job ? job.id : null, agentKey: agent ? agent.key : null, mb: Math.round(mbOf(r)),
      upSec: created > 0 ? Math.max(0, Math.round((ctx.now - created) / 1000)) : null, killable: !self && role !== "диспетчерская" }
  }).sort((a, b) => b.mb - a.mb).slice(0, 25)
}

/** Загрузка ЦП: свои задачи (прогоны, агенты, сервер — по дереву процессов) и пятёрка чужих потребителей. */
export function cpuOf(perf, rows, procList, ctx0) {
  const ctx = fullCtx(ctx0)
  const parent = new Map(rows.map((r) => [r.ProcessId, r.ParentProcessId]))
  const roots = new Map([[ctx.selfPid, { t: "dash", label: "диспетчерская (сервер)" }]])
  for (const j of ctx.jobs) if (j.pid) roots.set(j.pid, { t: "job", id: j.id, label: j.label || j.id })
  for (const a of ctx.agents) if (a.pid) roots.set(a.pid, { t: "agent", key: a.key, label: "агент " + (a.label || a.key) })
  const mine = new Map(), by = new Map(), byPid = new Map((procList || []).map((p) => [p.pid, p]))
  for (const r of perf) {
    const pct = (Number(r.PercentProcessorTime) || 0) / ctx.cores
    let p = r.IDProcess, hit = null, n = 0
    while (p && n++ < 14) { if (roots.has(p)) { hit = roots.get(p); break } p = parent.get(p) }
    if (hit) { const k = hit.t + ":" + (hit.id || hit.key || ""), e = mine.get(k) || { ...hit, pct: 0, n: 0 }; e.pct += pct; e.n++; mine.set(k, e); continue }
    const base = String(r.Name).replace(/#\d+$/, ""), pr = byPid.get(r.IDProcess), role = pr ? pr.role + (pr.what && pr.role !== "node" ? ": " + String(pr.what).slice(0, 40) : "") : ""
    const key = base + "|" + role, e = by.get(key) || { name: base, role, n: 0, raw: 0 }
    e.n++; e.raw += pct; by.set(key, e)
  }
  return {
    cpuTasks: [...mine.values()].map((e) => ({ kind: e.t, label: e.label, pct: r1(e.pct), n: e.n })).filter((e) => e.pct >= 0.1).sort((a, b) => b.pct - a.pct),
    cpuTop: [...by.values()].map((e) => ({ name: e.name, role: e.role, n: e.n, pct: r1(e.raw) })).filter((e) => e.pct >= 0.5).sort((a, b) => b.pct - a.pct).slice(0, 5),
  }
}

/** Память и ЦП по слотам: процессы прогонов и агентов слота, прочие процессы из его папки и доля окон VS Code. */
export function slotUsageOf(rows, perf, wins0, ctx0) {
  const ctx = fullCtx(ctx0)
  const byPid = new Map(rows.map((r) => [r.ProcessId, r]))
  const cpu = new Map(perf.map((r) => [r.IDProcess, (Number(r.PercentProcessorTime) || 0) / ctx.cores]))
  const roots = new Map()
  for (const j of ctx.jobs) if (j.pid && j.slot) roots.set(j.pid, { slot: j.slot, kind: "job" })
  for (const a of ctx.agents) if (a.pid) roots.set(a.pid, { slot: a.key, kind: "agent" })
  const blank = (slot) => ({ slot, cpu: 0, mb: 0, n: 0, job: 0, agent: 0, other: 0, pids: [] })
  const acc = new Map(), add = (slot, kind, r) => { const e = acc.get(slot) || blank(slot); const mb = mbOf(r); e.cpu += cpu.get(r.ProcessId) || 0; e.mb += mb; e.n++; e[kind] += mb; if (kind === "other") e.pids.push(r.ProcessId); acc.set(slot, e) }
  const vs = { mb: 0, cpu: 0, n: 0 }
  for (const r of rows) {
    if (r.ProcessId === ctx.selfPid) continue
    let p = r.ProcessId, n = 0, hit = null, bySlot = null
    while (p && n++ < 16) {
      if (roots.has(p)) { hit = roots.get(p); break }
      const pr = byPid.get(p); if (!pr) break
      if (!bySlot && SHELLS.test(pr.Name)) bySlot = slotNameOf(pr.CommandLine, ctx)
      p = pr.ParentProcessId
    }
    if (hit) { add(hit.slot, hit.kind, r); continue }
    if (r.Name === "Code.exe") { vs.mb += mbOf(r); vs.cpu += cpu.get(r.ProcessId) || 0; vs.n++; continue }
    if (bySlot && AGENT_CLI.test(r.Name)) add(bySlot, "other", r)
  }
  // Память VS Code делится поровну между его окнами: процесс редактора один на все окна.
  const wins = wins0.map((w) => ({ hwnd: w.hwnd, title: w.title, slot: winSlot(w.title, ctx.tagSlots) }))
  const share = wins.length ? vs.mb / wins.length : 0, cshare = wins.length ? vs.cpu / wins.length : 0
  for (const w of wins) if (w.slot) { const e = acc.get(w.slot) || blank(w.slot); e.win = Math.round(share); e.winCpu = cshare; e.hwnd = w.hwnd; acc.set(w.slot, e) }
  return {
    at: ctx.now, vscode: { mb: Math.round(vs.mb), cpu: r1(vs.cpu), windows: wins.length, perWindow: Math.round(share) }, windows: wins,
    rows: [...acc.values()].map((e) => ({ ...ctx.tagOf(e.slot), key: e.slot, cpu: r1(e.cpu + (e.winCpu || 0)), mb: Math.round(e.mb + (e.win || 0)), job: Math.round(e.job), agent: Math.round(e.agent), other: Math.round(e.other), win: e.win || 0, hwnd: e.hwnd || null, pids: e.pids })).sort((a, b) => b.mb - a.mb),
  }
}

/**
 * Снимок машины → всё, что показывает монитор. ctx:
 *   jobs   [{ id, pid, slot, label }] — корневые процессы идущих прогонов: ключ слота и подпись для списка;
 *   agents [{ key, pid, label }]      — процессы агентов (у рантайма без постоянного процесса — процесс текущего хода);
 *   tagOf(key) → { tag, epic, emoji?, title? } — подпись строки слота; tagSlots — { метка окна: ключ слота };
 *   wt, main — папка слотов и основная папка проекта; selfPid, cores, now — для тестов.
 * @returns {{mem, topProcs, procList, cpuTasks, cpuTop, slotUsage}}
 */
export function analyzeSample(d, ctx = {}) {
  const rows = [].concat((d && d.procs) || []), perf = [].concat((d && d.perf) || []), wins = [].concat((d && d.windows) || [])
  const procList = procRowsOf(rows, ctx)
  return { mem: memFromKB(d && d.mem), topProcs: topProcsOf(rows), procList, ...cpuOf(perf, rows, procList, ctx), slotUsage: slotUsageOf(rows, perf, wins, ctx) }
}

// ───────────────────────────── окна слотов ─────────────────────────────

const runPs = (exec, file, args, timeout) => new Promise((r) => exec(PS, psFile(file, args), { windowsHide: true, timeout }, (e, out) => r({ ok: !e, out: String(out || "") })))

/** Видимые окна VS Code: [{ hwnd, pid, title }]. */
export async function listWindows({ exec = execFile } = {}) {
  const r = await runPs(exec, WINDOWS_PS1, ["-List"], 15000)
  try { return [].concat(JSON.parse(r.out.trim() || "[]") || []) } catch { return [] }
}

/** Вежливо закрыть окно (как крестик: VS Code сам спросит про несохранённое). */
export async function closeWindow(hwnd, { exec = execFile } = {}) {
  const n = Number(hwnd); if (!Number.isInteger(n) || n <= 0) return false
  return (await runPs(exec, WINDOWS_PS1, ["-Close", String(n)], 15000)).out.trim() === "ok"
}

/** Разложить окна слотов сеткой; без apply — только список найденного. → { ok, out } */
export function arrangeSlotWindows({ apply = false, rows = 1, columns = 0, leftReserve = 0.2, exec = execFile } = {}) {
  const args = ["-Rows", String(Math.max(1, rows | 0)), "-Columns", String(Math.max(0, columns | 0)), "-LeftReserve", String(Number(leftReserve) || 0)]
  if (apply) args.unshift("-Apply")
  return runPs(exec, SLOT_WINDOWS_PS1, args, 20000)
}
