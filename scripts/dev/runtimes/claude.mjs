// runtimes/claude.mjs — адаптер Claude Code: флаги CLI, протокол stream-json (рукопожатие, сообщение, прерывание, смена модели,
// ответ на запрос разрешения), разбор событий в нормализованные (runtimes/index.mjs), записи сессий на диске и разовый запуск.
// Только здесь известны имена инструментов Claude Code; наружу уходит вид инструмента (bash, read, write, edit, search, other).
//
// Процесс один на агента и живёт между ходами: сообщения пишутся строками JSON в stdin, события читаются строками из stdout.
// Запросы разрешения приходят через --permission-prompt-tool=stdio и ждут ответа диспетчерской.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { StringDecoder } from "node:string_decoder"
import { PROJECT } from "../slots.mjs"
import { findAgentBin } from "./bin.mjs"
import { ensureExcluded, trackedIn } from "./git-exclude.mjs"
import { toClaudeRules } from "./claude-policy.mjs"

export const name = "claude"
export const label = "Claude Code"
export const caps = { permissionHook: true, persistentProcess: true, rateLimits: true }

// ───────────────────────────── бинарник ─────────────────────────────

/**
 * Как запускать Claude Code: `agent.bin` из конфига (путь или имя в PATH), иначе `claude` из PATH (runtimes/bin.mjs).
 * На Windows обёртку npm (`claude.cmd`) без оболочки не запустить — тогда берётся её скрипт `cli.js` и node.
 * @returns {{cmd:string, pre:string[]}|null}
 */
export const findBin = ({ bin = PROJECT.agent.bin, env = process.env, platform = process.platform } = {}) => findAgentBin("claude", { bin, env, platform })

const NO_BIN = "не найден Claude Code: поставьте его так, чтобы команда `claude` была в PATH, или укажите путь в `agent.bin` конфига проекта"

/** Есть ли рантайм на этой машине. Модель не запускается. */
export function probe(o = {}) {
  const b = findBin(o)
  return b ? { ok: true, bin: b.pre.length ? b.pre[0] : b.cmd, why: "" } : { ok: false, bin: "", why: NO_BIN }
}

// ───────────────────────────── флаги и протокол ─────────────────────────────

/** Флаги постоянного процесса агента. */
export function argv({ model = "", resume = null, systemPrompt = "", acceptEdits = true, userSettings = true, addDirs = [], keepMcp = false } = {}) {
  const args = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--permission-prompt-tool=stdio",
    "--setting-sources=" + (userSettings ? "user,project,local" : "project,local"),
    "--permission-mode=" + (acceptEdits ? "acceptEdits" : "default"), "--include-partial-messages"]
  if (resume) args.push("--resume=" + resume)
  // Описания чужих MCP-серверов — тысячи токенов на каждый ход; набор задаётся при старте, смена посреди сессии сбрасывает кеш.
  if (!keepMcp) args.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}')
  if (model) args.push("--model", model)
  for (const d of addDirs) args.push("--add-dir", fwd(d))
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt)
  return args
}

const fwd = (p) => String(p).replace(/\\/g, "/")
let seq = 0
const rid = (p) => p + Date.now().toString(36) + (++seq)

/** Строки протокола (то, что пишется в stdin процесса). */
export const proto = {
  init: () => ({ type: "control_request", request_id: rid("init_"), request: { subtype: "initialize", hooks: null } }),
  user: (text) => ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" }),
  interrupt: () => ({ type: "control_request", request_id: rid("i"), request: { subtype: "interrupt" } }),
  setModel: (model) => ({ type: "control_request", request_id: rid("m"), request: { subtype: "set_model", model } }),
  permission: (requestId, { allow, input, message = "" }, rawInput = {}) => ({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: allow ? { behavior: "allow", updatedInput: input || rawInput || {} } : { behavior: "deny", message: message || "Отклонено в диспетчерской" } },
  }),
}

// ───────────────────────────── инструменты ─────────────────────────────

const KIND_OF = {
  Bash: "bash", Read: "read", NotebookRead: "read", Write: "write", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit",
  Grep: "search", Glob: "search", LS: "search",
}
/** Вид инструмента Claude Code. */
export const toolKind = (tool) => KIND_OF[tool] || "other"

const todoText = (todos) => (todos || []).map((t) => `${t.status === "completed" ? "✓" : t.status === "in_progress" ? "▶" : "·"} ${t.content}`).join("\n")

/** Ввод инструмента → нейтральный вид (runtimes/index.mjs, NeutralInput). */
export function neutralInput(tool, input) {
  const i = input || {}
  switch (toolKind(tool)) {
    case "bash": return { command: i.command, description: i.description, raw: i }
    case "read": return { path: i.file_path || i.notebook_path, offset: i.offset, limit: i.limit, raw: i }
    case "write": return { path: i.file_path, content: i.content, raw: i }
    case "edit": {
      const first = Array.isArray(i.edits) && i.edits[0] || {}
      return { path: i.file_path || i.notebook_path, old: i.old_string ?? first.old_string, neu: i.new_string ?? first.new_string ?? i.new_source, raw: i }
    }
    case "search": return { pattern: i.pattern, path: i.path, raw: i }
    default: return tool === "TodoWrite" ? { text: todoText(i.todos), raw: i } : { raw: i }
  }
}

const blockText = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b && b.type === "text" ? b.text : "")).join("") : ""
const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s }

// ───────────────────────────── разбор потока ─────────────────────────────

/** Состояние разбора одного процесса: id текущего сообщения, контекст последнего вызова модели, исходный ввод запросов. */
export const newParseState = () => ({ cur: null, ctx: 0, raw: new Map() })

/**
 * Одна строка stream-json → нормализованные события (0 и больше). Чистая функция над состоянием `st`.
 * @returns {object[]}
 */
export function parseLine(m, st = newParseState()) {
  if (!m || typeof m !== "object") return []
  if (m.type === "system" && m.subtype === "init") return [{ type: "session", id: m.session_id, model: m.model || "" }]
  if (m.type === "rate_limit_event" && m.rate_limit_info) {
    const r = m.rate_limit_info
    return [{ type: "limits", limit: r.rateLimitType || "", util: r.utilization ?? null, status: r.status || "", resetsAt: r.resetsAt ? r.resetsAt * 1000 : null }]
  }
  if (m.type === "stream_event") {
    const e = m.event || {}
    if (e.type === "message_start" && e.message) { st.cur = e.message.id; return [{ type: "text.delta", msgId: e.message.id, text: "" }] }
    if (e.type === "content_block_delta" && e.delta && e.delta.type === "text_delta" && st.cur) return [{ type: "text.delta", msgId: st.cur, text: e.delta.text || "" }]
    return []
  }
  if (m.type === "assistant" && m.message) {
    const u = m.message.usage || {}, c = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
    if (c) st.ctx = c
    const content = Array.isArray(m.message.content) ? m.message.content : []
    const out = [{ type: "text", msgId: m.message.id, text: content.filter((b) => b.type === "text").map((b) => b.text).join("") }]
    for (const b of content) if (b.type === "tool_use") out.push({ type: "tool.start", id: b.id, name: b.name, kind: toolKind(b.name), input: neutralInput(b.name, b.input) })
    return out
  }
  if (m.type === "user" && m.message && Array.isArray(m.message.content)) {
    return m.message.content.filter((b) => b.type === "tool_result").map((b) => ({ type: "tool.end", id: b.tool_use_id, ok: !b.is_error, result: clip(blockText(b.content), 700) }))
  }
  if (m.type === "result") {
    const u = m.usage || {}, ok = m.subtype === "success" && !m.is_error
    return [{ type: "turn.end", ok, why: m.subtype === "success" ? (m.is_error ? "ошибка" : "") : String(m.subtype || "ошибка"), ms: m.duration_ms || 0, cost: m.total_cost_usd || 0,
      usage: { in: u.input_tokens || 0, out: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 }, ctxTokens: st.ctx }]
  }
  if (m.type === "control_request" && m.request && m.request.subtype === "can_use_tool") {
    const tool = m.request.tool_name
    st.raw.set(m.request_id, m.request.input)
    return [{ type: "permission", id: m.request_id, name: tool, kind: toolKind(tool), input: neutralInput(tool, m.request.input) }]
  }
  return []
}

/** Текст stdout → события построчно; неполная последняя строка остаётся в буфере. */
export function lineSplitter(onLine) {
  const dec = new StringDecoder("utf8"); let buf = ""
  return (chunk) => {
    buf += typeof chunk === "string" ? chunk : dec.write(chunk)
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      let m; try { m = JSON.parse(line) } catch { continue } // не JSON — служебный вывод CLI
      onLine(m)
    }
  }
}

// ───────────────────────────── процесс агента ─────────────────────────────

/**
 * Запустить процесс агента. opts — см. argv() и runtimes/index.mjs; deps.spawn — запуск процесса, deps.kill — остановка дерева.
 * @returns {{proc, send(text), interrupt(), setModel(model), answerPermission(id, d), kill()}}
 */
export function start(opts, { spawn, kill = (p) => p && p.kill(), onEvent }) {
  const bin = opts.bin || findBin(); if (!bin) throw new Error(NO_BIN)
  const proc = spawn(bin.cmd, [...bin.pre, ...argv(opts)], { cwd: opts.cwd, windowsHide: true, env: { ...process.env, ...(opts.env || {}), CLAUDE_CODE_ENTRYPOINT: "dispatcher" } })
  const st = newParseState()
  const emit = (ev) => { try { onEvent(ev) } catch (e) { console.error("событие агента", ev && ev.type, e && e.stack || e) } }
  const write = (obj) => { if (proc.stdin && !proc.stdin.destroyed) proc.stdin.write(JSON.stringify(obj) + "\n") }
  proc.stdout.on("data", lineSplitter((m) => { for (const ev of parseLine(m, st)) emit(ev) }))
  proc.stderr.on("data", (d) => { const s = String(d).trim(); if (s) emit({ type: "stderr", text: s }) })
  proc.on("error", (e) => emit({ type: "error", message: e.message }))
  proc.on("close", (code) => emit({ type: "exit", code }))
  if (proc.stdin && proc.stdin.on) proc.stdin.on("error", () => { /* процесс закрылся раньше записи */ })
  write(proto.init())
  return {
    proc,
    send: (text) => write(proto.user(text)),
    interrupt: () => write(proto.interrupt()),
    setModel: (model) => write(proto.setModel(model)),
    answerPermission: (id, d) => { write(proto.permission(id, d, st.raw.get(id))); st.raw.delete(id) },
    kill: () => kill(proc),
  }
}

// ───────────────────────────── сессии на диске ─────────────────────────────

/** Папка записей сессий Claude Code (CLAUDE_CONFIG_DIR перекрывает домашнюю). */
export const projectsRoot = (env = process.env) => path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects")

/** Папка сессий для рабочей папки агента (имя — путь, где всё кроме латиницы и цифр заменено дефисом). */
export function projectDirFor(cwd, root = projectsRoot()) {
  const slug = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()
  try { const d = fs.readdirSync(root).find((x) => x.toLowerCase() === slug); return d ? path.join(root, d) : null } catch { return null }
}

export function latestSession(cwd) {
  const dir = projectDirFor(cwd); if (!dir) return null
  try {
    return fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl")).map((x) => ({ id: x.slice(0, -6), at: fs.statSync(path.join(dir, x)).mtimeMs })).sort((a, b) => b.at - a.at)[0] || null
  } catch { return null }
}

/** Записи сессии → реплики и инструменты (нейтрально). Последние `max`. */
export function parseHistory(text, max = 40) {
  const out = []
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    const c = m.message && m.message.content
    if (m.type === "user" && !m.isMeta) { const t = blockText(c); if (t && !t.startsWith("<")) out.push({ t: "user", text: t }) }
    else if (m.type === "assistant" && Array.isArray(c)) {
      const t = c.filter((b) => b.type === "text").map((b) => b.text).join(""); if (t) out.push({ t: "assistant", text: t })
      for (const b of c) if (b.type === "tool_use") out.push({ t: "tool", name: b.name, kind: toolKind(b.name), input: neutralInput(b.name, b.input) })
    }
  }
  return out.slice(-max)
}

export async function readHistory(cwd, sessionId) {
  const dir = projectDirFor(cwd); if (!dir || !sessionId) return []
  try { return parseHistory(await fs.promises.readFile(path.join(dir, sessionId + ".jsonl"), "utf8")) } catch { return [] }
}

/** Хвост записи сессии (последние `bytes` байт) — без чтения мегабайтов целиком. */
export async function readTail(cwd, sessionId, bytes = 3e6) {
  const dir = projectDirFor(cwd); if (!dir || !sessionId) return ""
  try {
    const fh = await fs.promises.open(path.join(dir, sessionId + ".jsonl"), "r")
    try { const { size } = await fh.stat(), n = Math.min(size, bytes), b = Buffer.alloc(n); await fh.read(b, 0, n, size - n); return b.toString("utf8") } finally { await fh.close() }
  } catch { return "" }
}

/** Последний законченный ответ в записи сессии: ход без вызова инструмента после него. */
export function lastAnswer(jsonl) {
  const lines = String(jsonl || "").split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim(); if (!s) continue
    let m; try { m = JSON.parse(s) } catch { continue }
    if (m.type === "user") { if (m.isMeta) continue; return null }
    if (m.type !== "assistant") continue
    const c = m.message && m.message.content; if (!Array.isArray(c)) continue
    if (c.some((b) => b.type === "tool_use")) return null
    const text = c.filter((b) => b.type === "text").map((b) => b.text).join("")
    if (!text) continue // только размышления — текст ответа строкой выше
    return { text, at: Date.parse(m.timestamp) || 0, id: (m.message && m.message.id) || "" }
  }
  return null
}

// ───────────────────────────── разовый запуск ─────────────────────────────

/** Команда разового запуска (`claude -p`): задание — в stdin, ответ — текстом. */
export function onceCommand({ prompt = "", model = "", readOnly = true, allowBash = false, addDirs = [], maxTurns = 60, bin = null } = {}) {
  const b = bin || findBin(); if (!b) throw new Error(NO_BIN)
  // Без пользовательских настроек: их правила разрешений не должны действовать на разового агента.
  const args = ["-p", "--output-format", "text", "--max-turns", String(maxTurns), "--setting-sources", "project", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']
  if (model) args.push("--model", model)
  const allowed = ["Read", "Grep", "Glob"], denied = []
  if (allowBash === true) allowed.push("Bash")
  else if (Array.isArray(allowBash) && allowBash.length) allowed.push(...allowBash.map((c) => `Bash(${c}:*)`))
  else denied.push("Bash")
  if (readOnly) denied.push("Edit", "Write", "MultiEdit", "NotebookEdit")
  else { allowed.push("Edit", "Write", "MultiEdit"); args.push("--permission-mode", "acceptEdits") }
  args.push("--allowedTools", allowed.join(","))
  if (denied.length) args.push("--disallowedTools", denied.join(","))
  for (const d of addDirs) args.push("--add-dir", fwd(d))
  return { cmd: b.cmd, args: [...b.pre, ...args], env: { CLAUDE_CODE_ENTRYPOINT: "dispatcher-once" }, input: prompt }
}

// ───────────────────────────── запреты слота ─────────────────────────────

/**
 * Запреты слота в .claude/settings.local.json папки слота. Существующий файл не затирается: Claude Code сам дописывает туда
 * разрешения человека. policy: { deny — нормализованный раздел `deny` конфига, editDeny — пути, закрытые слоту на правку
 * (запреты его области), allowEdit — снятые для этого слота общие запреты }.
 * @returns {{file:string, deny:number, merged:boolean}|null} null — существующий файл не разобран, не тронут
 */
export function writeSlotPolicy(dir, { deny = PROJECT.deny, editDeny = [], allowEdit = [] } = {}) {
  const file = path.join(dir, ".claude", "settings.local.json")
  let cur = {}
  if (fs.existsSync(file)) { try { cur = JSON.parse(fs.readFileSync(file, "utf8")) } catch { return null } }
  const rules = toClaudeRules(deny), allowed = new Set(allowEdit.map((p) => "Edit(" + fwd(p) + ")"))
  const perms = cur.permissions || {}
  const denyList = [...new Set([...(perms.deny || []).filter((x) => !rules.ask.includes(x) && !allowed.has(x)), ...rules.deny.filter((x) => !allowed.has(x)), ...editDeny.map((p) => "Edit(" + fwd(p) + ")")])]
  const ask = [...new Set([...(perms.ask || []), ...rules.ask])]
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ...cur, permissions: { ...perms, deny: denyList, ask } }, null, 2) + "\n")
  // файл запретов — не правка слота: строка в info/exclude, если проект сам не держит его в git
  const excluded = trackedIn(dir, ".claude/settings.local.json") ? false : ensureExcluded(dir, "/.claude/settings.local.json")
  return { file: fwd(file), deny: denyList.length, merged: Object.keys(cur).length > 0, excluded }
}
