// runtimes/codex.mjs — адаптер Codex CLI на `codex exec --json`: флаги запуска хода, разбор событий JSONL в нормализованные
// (runtimes/index.mjs), очередь сообщений между ходами, прерывание, своя запись истории ходов, разовый запуск и запреты слота.
//
// ЭКСПЕРИМЕНТАЛЬНЫЙ: написан по документации и исходникам Codex CLI и вживую не проверялся — автор диспетчерской пользуется
// только Claude Code. Проверен лишь контрактным тестом на поддельном бинарнике (codex.test.mjs); флаги и события сверять
// с `codex exec --help` установленной версии. Как подключить и известные ограничения (запреты в основном текстом
// AGENTS.override.md; песочница закрывает только запись вне слота и сеть; коммит агента может не пройти — git-папка вне
// песочницы; ctxTokens = 0, ротация оркестратора по токенам не срабатывает) — docs/recipes/codex.md.
// Заработало, нашли ошибку или доделали — присылайте pull request.
//
// Как устроено:
//   · ход = процесс. Первый ход — `codex exec --json … -` (задание в stdin), следующие — `codex exec --json … resume <id> -`;
//     id беседы (thread_id) приходит событием `thread.started`. Между ходами процесса нет (caps.persistentProcess: false);
//   · сообщения, пришедшие во время хода, копятся и уходят следующим ходом одним заданием;
//   · прерывание — остановка процесса хода (SIGINT, на Windows — снятие дерева процессов); следующий ход идёт через resume;
//   · запросов разрешения нет (caps.permissionHook: false): права задаёт песочница. Слот — `workspace-write` с папкой слота,
//     разовые запуски — `read-only`. Сеть в песочнице выключена; включает её `agent.network: true` в конфиге проекта;
//   · системной подсказки у `codex exec` нет — подсказка роли идёт началом первого задания новой беседы;
//   · формат записей сессий самого Codex не подтверждён, поэтому история чата — своя: нормализованные события ходов пишутся
//     в папку данных диспетчерской (<данные>/codex-sessions/<папка>/<thread_id>.jsonl).
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import { PROJECT } from "../slots.mjs"
import { DATA } from "../dashboard/config.mjs"
import { killTree } from "../dashboard/spawner.mjs"
import { ensureExcluded } from "./git-exclude.mjs"
import { findAgentBin } from "./bin.mjs"

export const name = "codex"
export const label = "Codex CLI (экспериментальный)"
export const experimental = true
export const EXPERIMENTAL_NOTE = "поддержка Codex экспериментальная: адаптер написан по документации и не проверен на живом прогоне"
export const caps = { permissionHook: false, persistentProcess: false, rateLimits: false }

const fwd = (p) => String(p).replace(/\\/g, "/")
const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s }

// ───────────────────────────── бинарник ─────────────────────────────

/**
 * Как запускать Codex: `agent.bin` из конфига (путь или имя в PATH), иначе `codex` из PATH (runtimes/bin.mjs).
 * На Windows обёртку npm (`codex.cmd`) без оболочки не запустить — берётся её скрипт `@openai/codex/bin/codex.js` и node.
 * @returns {{cmd:string, pre:string[]}|null}
 */
export const findBin = ({ bin = PROJECT.agent.bin, env = process.env, platform = process.platform } = {}) => findAgentBin("codex", { bin, env, platform })

const NO_BIN = "не найден Codex CLI: поставьте его так, чтобы команда `codex` была в PATH, или укажите путь в `agent.bin` конфига проекта"

/** Есть ли рантайм на этой машине. Модель не запускается. */
export function probe(o = {}) {
  const b = findBin(o)
  return b ? { ok: true, bin: b.pre.length ? b.pre[0] : b.cmd, why: "", note: EXPERIMENTAL_NOTE } : { ok: false, bin: "", why: NO_BIN, note: EXPERIMENTAL_NOTE }
}

// ───────────────────────────── флаги ─────────────────────────────

/** Сеть в песочнице: явный выбор сильнее, иначе `agent.network` конфига; по умолчанию выключена. */
export const networkOn = (explicit) => explicit != null ? !!explicit : !!(PROJECT.agent && PROJECT.agent.network)

/** Песочница по роли: только чтение — `read-only`; агент без автоприёма правок пишет только в addDirs, но песочница
 *  точнее «папка + addDirs» не умеет, поэтому и он получает `workspace-write` (правила записи держит подсказка). */
export const sandboxOf = ({ readOnly = false, sandbox = "" } = {}) => sandbox || (readOnly ? "read-only" : "workspace-write")

/**
 * Аргументы одного хода. `-s`/`-C` стоят до `resume`: у подкоманды resume их нет. Задание — из stdin (`-`).
 * addDirs в `workspace-write` становятся записываемыми папками; читать песочница и так даёт везде.
 */
export function argv({ model = "", resume = null, sandbox = "workspace-write", cwd = "", addDirs = [], network = false } = {}) {
  const args = ["exec", "--json"]
  if (model) args.push("-m", model)
  args.push("-s", sandbox)
  if (cwd) args.push("-C", fwd(cwd))
  if (sandbox === "workspace-write") {
    for (const d of addDirs) args.push("--add-dir", fwd(d))
    if (network) args.push("-c", "sandbox_workspace_write.network_access=true")
  }
  args.push("--skip-git-repo-check")
  if (resume) args.push("resume", resume)
  args.push("-")
  return args
}

// ───────────────────────────── разбор событий ─────────────────────────────

/** Состояние разбора одного хода. prefix делает id сообщений и инструментов уникальными между ходами и запусками. */
export const newParseState = (prefix = "", model = "") => ({ prefix, model, seen: new Set(), ended: false, turnSeen: false, threadSeen: false })

const fileKind = (changes) => (changes || []).length && changes.every((c) => c.kind === "add") ? "write" : "edit"
const changesText = (changes) => (changes || []).map((c) => (c.kind || "update") + " " + c.path).join("\n")

/** Начало инструмента по item Codex → нормализованное tool.start (или null — не инструмент). */
function toolStart(item, id) {
  switch (item.type) {
    case "command_execution": return { type: "tool.start", id, name: "shell", kind: "bash", input: { command: item.command, raw: item } }
    case "file_change": {
      const ch = item.changes || []
      return { type: "tool.start", id, name: "apply_patch", kind: fileKind(ch), input: { path: ch[0] && ch[0].path, text: changesText(ch), raw: item } }
    }
    case "mcp_tool_call": return { type: "tool.start", id, name: [item.server, item.tool].filter(Boolean).join("."), kind: "other", input: { raw: item.arguments ?? {} } }
    case "web_search": return { type: "tool.start", id, name: "web_search", kind: "other", input: { text: item.query || "", raw: item } }
    case "todo_list": return { type: "tool.start", id, name: "todo_list", kind: "other", input: { text: (item.items || []).map((t) => (t.completed ? "✓ " : "· ") + t.text).join("\n"), raw: item } }
    default: return null
  }
}

/** Итог инструмента по завершённому item Codex. */
function toolEnd(item, id) {
  const failed = item.status === "failed" || item.status === "declined"
  switch (item.type) {
    case "command_execution": return { type: "tool.end", id, ok: !failed && (item.exit_code == null || item.exit_code === 0), result: clip(item.aggregated_output, 700) }
    case "file_change": return { type: "tool.end", id, ok: !failed, result: clip(changesText(item.changes), 700) }
    case "mcp_tool_call": return { type: "tool.end", id, ok: !failed && !item.error, result: clip(item.error ? (item.error.message || JSON.stringify(item.error)) : typeof item.result === "string" ? item.result : JSON.stringify(item.result ?? ""), 700) }
    default: return { type: "tool.end", id, ok: !failed, result: "" }
  }
}

/**
 * Одна строка JSONL `codex exec --json` → нормализованные события (0 и больше). Чистая функция над состоянием `st`.
 * Предупреждения (`error` верхнего уровня и item `error`) — это `stderr`: нормализованное `error` значит «агент не запустился».
 * @returns {object[]}
 */
export function parseEvent(m, st = newParseState()) {
  if (!m || typeof m !== "object") return []
  switch (m.type) {
    case "thread.started": st.threadSeen = true; return [{ type: "session", id: m.thread_id, model: st.model || "" }]
    case "turn.started": st.turnSeen = true; return []
    case "turn.completed": {
      st.turnSeen = true; st.ended = true
      const u = m.usage || {}
      // usage Codex — сумма за ход (несколько вызовов модели), а не размер контекста; поэтому ctxTokens не заполняется.
      return [{ type: "turn.end", ok: true, why: "", ms: 0, cost: 0, usage: { in: u.input_tokens || 0, out: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0), cacheRead: u.cached_input_tokens || 0, cacheWrite: u.cache_write_input_tokens || 0 }, ctxTokens: 0 }]
    }
    case "turn.failed":
      st.turnSeen = true; st.ended = true
      return [{ type: "turn.end", ok: false, why: String((m.error && m.error.message) || "ошибка хода"), ms: 0, cost: 0, usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, ctxTokens: 0 }]
    case "error": return [{ type: "stderr", text: String(m.message || "") }]
    case "item.started": case "item.updated": case "item.completed": {
      const it = m.item || {}, id = st.prefix + (it.id || "")
      if (it.type === "agent_message") return m.type === "item.completed" ? [{ type: "text", msgId: id, text: String(it.text || "") }] : []
      if (it.type === "reasoning") return []
      if (it.type === "error") return m.type === "item.completed" ? [{ type: "stderr", text: String(it.message || "") }] : []
      const out = []
      if (!st.seen.has(id)) { const s = toolStart(it, id); if (!s) return []; st.seen.add(id); out.push(s) }
      if (m.type === "item.completed") out.push(toolEnd(it, id))
      return out
    }
    default: return []
  }
}

/** Байты stdout → объекты JSON построчно; неполная последняя строка остаётся в буфере, буква UTF-8 на стыке не рвётся. */
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

// ───────────────────────────── история ходов ─────────────────────────────

/** Корень записей истории Codex в папке данных диспетчерской. */
export const historyRoot = (data = DATA) => path.join(data, "codex-sessions")
const slugOf = (cwd) => path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()
const histDir = (cwd, root) => path.join(root, slugOf(cwd))
const histFile = (cwd, id, root) => path.join(histDir(cwd, root), String(id).replace(/[^\w.-]/g, "_") + ".jsonl")
const KEEP_EVENTS = new Set(["session", "text", "tool.start", "tool.end", "turn.end"])

/** Запись истории одной беседы. Пока id беседы неизвестен (первый ход), строки копятся в памяти. */
function historyWriter(cwd, root) {
  let id = null, pending = []
  const line = (o) => JSON.stringify({ at: Date.now(), ...o }) + "\n"
  const append = (s) => { try { fs.mkdirSync(histDir(cwd, root), { recursive: true }); fs.appendFileSync(histFile(cwd, id, root), s) } catch { /* история не должна ронять агента */ } }
  return {
    setId(x) { if (!x || x === id) return; id = x; if (pending.length) { append(pending.join("")); pending = [] } },
    write(o) {
      if (o.type !== "user" && !KEEP_EVENTS.has(o.type)) return
      const s = line(o.type === "tool.start" ? { ...o, input: { ...o.input, raw: undefined } } : o)
      if (id) append(s); else pending.push(s)
    },
    drop() { pending = [] },
  }
}

export function latestSession(cwd, root = historyRoot()) {
  if (!cwd) return null
  const dir = histDir(cwd, root)
  try {
    return fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl")).map((x) => ({ id: x.slice(0, -6), at: fs.statSync(path.join(dir, x)).mtimeMs })).sort((a, b) => b.at - a.at)[0] || null
  } catch { return null }
}

/** Записи истории → реплики и инструменты (нейтрально). Последние `max`. */
export function parseHistory(text, max = 40) {
  const out = []
  for (const l of String(text || "").split("\n")) {
    if (!l.trim()) continue
    let m; try { m = JSON.parse(l) } catch { continue }
    if (m.type === "user" && m.text) out.push({ t: "user", text: m.text })
    else if (m.type === "text" && m.text) out.push({ t: "assistant", text: m.text })
    else if (m.type === "tool.start") out.push({ t: "tool", name: m.name, kind: m.kind, input: m.input || {} })
  }
  return out.slice(-max)
}

export async function readHistory(cwd, sessionId, root = historyRoot()) {
  if (!cwd || !sessionId) return []
  try { return parseHistory(await fs.promises.readFile(histFile(cwd, sessionId, root), "utf8")) } catch { return [] }
}

export async function readTail(cwd, sessionId, bytes = 3e6, root = historyRoot()) {
  if (!cwd || !sessionId) return ""
  try {
    const fh = await fs.promises.open(histFile(cwd, sessionId, root), "r")
    try { const { size } = await fh.stat(), n = Math.min(size, bytes), b = Buffer.alloc(n); await fh.read(b, 0, n, size - n); return b.toString("utf8") } finally { await fh.close() }
  } catch { return "" }
}

/** Последний законченный ответ: текст агента, после которого не было ни инструмента, ни нового сообщения человека. */
export function lastAnswer(jsonl) {
  const lines = String(jsonl || "").split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim(); if (!s) continue
    let m; try { m = JSON.parse(s) } catch { continue }
    if (m.type === "user" || m.type === "tool.start" || m.type === "tool.end") return null
    if (m.type === "text" && m.text) return { text: m.text, at: m.at || 0, id: m.msgId || "" }
  }
  return null
}

// ───────────────────────────── агент: ходы-процессы ─────────────────────────────

/** Сколько ждать выхода после SIGINT, прежде чем снять дерево процессов. */
export const INTERRUPT_GRACE_MS = 5000

/**
 * «Агент» Codex: ручка над последовательностью ходов-процессов. opts — см. runtimes/index.mjs (start) и argv();
 * дополнительно: readOnly, sandbox, network, histRoot, bin. deps.spawn — запуск процесса, deps.kill — снятие дерева.
 * Кроме событий контракта шлёт `{ type: "turn.start", queued }`, когда сам начинает ход из очереди.
 * @returns {{proc, send(text), interrupt(), setModel(model), answerPermission(), kill(), queued():number}}
 */
export function start(opts, { spawn, kill = killTree, onEvent, platform = process.platform }) {
  const bin = opts.bin || findBin(); if (!bin) throw new Error(NO_BIN)
  const sandbox = sandboxOf({ readOnly: opts.readOnly, sandbox: opts.sandbox })
  const network = networkOn(opts.network)
  const hid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  let sessionId = opts.resume || null, model = opts.model || "", primed = !!opts.resume
  let cur = null, queue = [], dead = false, turnN = 0, exitSent = false
  let hist = historyWriter(opts.cwd, opts.histRoot || historyRoot())
  if (sessionId) hist.setId(sessionId)

  const emit = (ev) => { try { onEvent(ev) } catch (e) { console.error("событие агента", ev && ev.type, e && e.stack || e) } }
  const sendExit = (code) => { if (exitSent) return; exitSent = true; emit({ type: "exit", code }) }

  function runTurn(text, { retried = false } = {}) {
    const n = ++turnN, t0 = Date.now(), st = newParseState(hid + "." + n + ":", model), wasResume = !!sessionId
    const prompt = !primed && opts.systemPrompt ? opts.systemPrompt + "\n\n" + text : text
    primed = true
    const args = argv({ model, resume: sessionId, sandbox, cwd: opts.cwd, addDirs: opts.addDirs || [], network })
    hist.write({ type: "user", text })
    let proc
    try { proc = spawn(bin.cmd, [...bin.pre, ...args], { cwd: opts.cwd, windowsHide: true, env: { ...process.env, ...(opts.env || {}) } }) } catch (e) { fail(e); return }
    const turn = { proc, interrupted: false, grace: null, done: false }
    cur = turn

    const onEv = (ev) => {
      if (ev.type === "session") { sessionId = ev.id; hist.setId(ev.id) }
      if (ev.type === "turn.end") ev.ms = Date.now() - t0
      hist.write(ev); emit(ev)
    }
    proc.stdout.on("data", lineSplitter((m) => { for (const ev of parseEvent(m, st)) onEv(ev) }))
    proc.stderr.on("data", (d) => { const s = String(d).trim(); if (s) emit({ type: "stderr", text: s }) })
    if (proc.stdin) { proc.stdin.on("error", () => { /* процесс закрылся раньше записи */ }); proc.stdin.end(prompt) }
    const finish = (code, err) => {
      if (turn.done) return; turn.done = true
      clearTimeout(turn.grace); if (cur === turn) cur = null
      // Продолжение не удалось (процесс ушёл, не начав ход) — один раз начать новую беседу с тем же заданием.
      if (wasResume && !retried && !err && !turn.interrupted && !dead && !st.turnSeen && !st.threadSeen && code !== 0) {
        emit({ type: "stderr", text: `продолжить беседу ${String(sessionId).slice(0, 8)} не удалось (код ${code}) — начата новая` })
        sessionId = null; primed = false; hist.drop(); hist = historyWriter(opts.cwd, opts.histRoot || historyRoot())
        runTurn(text, { retried: true }); return
      }
      if (!st.ended) onEv({ type: "turn.end", ok: false, why: turn.interrupted ? "прерван" : err ? "не запустился: " + err.message : `codex завершился с кодом ${code}`, ms: 0, cost: 0, usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, ctxTokens: 0 })
      if (err) { dead = true; emit({ type: "error", message: err.message }); return }
      if (dead) { sendExit(code); return }
      if (queue.length && !turn.interrupted) { const q = queue.splice(0); emit({ type: "turn.start", queued: q.length }); runTurn(q.join("\n\n")) }
    }
    proc.on("error", (e) => finish(null, e))
    proc.on("close", (code) => finish(code, null))
  }

  function fail(e) { dead = true; emit({ type: "turn.end", ok: false, why: "не запустился: " + e.message, ms: 0, cost: 0, usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, ctxTokens: 0 }); emit({ type: "error", message: e.message }) }

  function stopTurn(t, hard) {
    if (!t || t.done) return
    t.interrupted = true
    if (hard || platform === "win32") { try { kill(t.proc) } catch { /* уже закончился */ } return }
    try { t.proc.kill("SIGINT") } catch { /* уже закончился */ }
    if (!t.grace) { t.grace = setTimeout(() => { if (!t.done) try { kill(t.proc) } catch { /* уже закончился */ } }, INTERRUPT_GRACE_MS); if (t.grace.unref) t.grace.unref() }
  }

  return {
    get proc() { return cur ? cur.proc : null },
    /** Сообщение агенту: свободен — новый ход; занят — в очередь. Отложенное прерыванием уходит вместе со следующим. */
    send(text) {
      if (dead) throw new Error("агент Codex остановлен")
      if (cur) { queue.push(String(text)); return }
      const q = queue.splice(0); runTurn([...q, String(text)].join("\n\n"))
    },
    /** Прервать ход: процесс останавливается, накопленные сообщения ждут следующего send. */
    interrupt() { stopTurn(cur, false) },
    setModel(m) { model = m || "" },
    answerPermission() { /* у Codex в exec нет запросов разрешения: права — песочница */ },
    kill() {
      dead = true; queue = []
      if (cur) stopTurn(cur, true); else setImmediate(() => sendExit(0))
    },
    queued: () => queue.length,
  }
}

// ───────────────────────────── разовый запуск ─────────────────────────────

/**
 * Команда разового запуска (ревью, ретро): `codex exec --json -s read-only -`, задание — в stdin.
 * allowBash и maxTurns у Codex не выражаются: в `read-only` команды идут, но ничего не пишут; предела ходов нет.
 */
export function onceCommand({ prompt = "", model = "", readOnly = true, addDirs = [], network = null, bin = null } = {}) {
  const b = bin || findBin(); if (!b) throw new Error(NO_BIN)
  const args = argv({ model, sandbox: readOnly ? "read-only" : "workspace-write", addDirs: readOnly ? [] : addDirs, network: networkOn(network) })
  return { cmd: b.cmd, args: [...b.pre, ...args], env: {}, input: prompt }
}

/** Ответ разового запуска — текст последнего сообщения агента в выводе JSONL. */
export function onceText(stdout) {
  let text = ""
  lineSplitter((m) => { if (m.type === "item.completed" && m.item && m.item.type === "agent_message") text = String(m.item.text || "") })(String(stdout || "") + "\n")
  return text
}

// ───────────────────────────── запреты слота ─────────────────────────────

/** Файл инструкций слота. Codex читает AGENTS.override.md вместо AGENTS.md той же папки — поэтому правила проекта
 *  из AGENTS.md переписываются в него следом за правилами слота. */
export const POLICY_FILE = "AGENTS.override.md"
const MARK = "<!-- dispatcher: slot-policy -->"

const cmdLine = (c) => c.startsWith("=") ? "ровно `" + c.slice(1) + "`" : "`" + c + "` и всё, что так начинается"

/** Текст правил слота для агента. Песочница держит только запись вне папки слота и сеть — остальное держат эти слова. */
export function policyText({ deny = PROJECT.deny, editDeny = [], allowEdit = [] } = {}, { network = networkOn() } = {}) {
  const allowed = new Set(allowEdit.map(fwd))
  const edit = [...new Set([...(deny.edit || []), ...editDeny].map(fwd))].filter((p) => !allowed.has(p))
  const list = (xs, f = (x) => "`" + x + "`") => xs.map((x) => "- " + f(x)).join("\n")
  const parts = [MARK, "# Правила слота (диспетчерская)", "",
    "Файл создан диспетчерской для этой рабочей копии и перезаписывается при подготовке слота; в git он не попадает.", "",
    "Песочница Codex сама не даёт писать вне папки слота" + (network ? "." : " и выходить в сеть.") + " Всё остальное ниже машина НЕ проверяет — соблюдай сам. Если задача требует запретного, остановись и спроси человека."]
  if ((deny.commands || []).length) parts.push("", "## Нельзя запускать", list(deny.commands, cmdLine))
  if ((deny.ask || []).length) parts.push("", "## Только по слову человека", list(deny.ask, cmdLine))
  if (edit.length) parts.push("", "## Нельзя править (шаблоны путей как в .gitignore)", list(edit))
  if ((deny.read || []).length) parts.push("", "## Нельзя читать", list(deny.read))
  return parts.join("\n") + "\n"
}

const gitOut = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim()

/** Файл в индексе git этой папки? */
const tracked = (dir, rel) => { try { gitOut(dir, ["ls-files", "--error-unmatch", "--", rel]); return true } catch { return false } }

export { ensureExcluded }

/**
 * Запреты слота для Codex: AGENTS.override.md в корне папки слота (правила слота + AGENTS.md проекта) и строка о нём
 * в info/exclude. Файл, который проект сам держит в git, не трогается.
 * @returns {{file:string, deny:number, merged:boolean, excluded:boolean}|null} null — AGENTS.override.md есть в git проекта
 */
export function writeSlotPolicy(dir, policy = {}) {
  const file = path.join(dir, POLICY_FILE)
  if (tracked(dir, POLICY_FILE)) return null
  let base = ""; try { base = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8").trim() } catch { /* у проекта нет AGENTS.md */ }
  const p = { deny: PROJECT.deny, editDeny: [], allowEdit: [], ...policy }
  const text = policyText(p) + (base ? "\n---\n\n# Правила проекта (копия AGENTS.md на момент подготовки слота)\n\n" + base + "\n" : "")
  const excluded = ensureExcluded(dir, "/" + POLICY_FILE)
  fs.writeFileSync(file, text)
  const d = p.deny || {}
  return { file: fwd(file), deny: (d.commands || []).length + (d.ask || []).length + (d.read || []).length + (d.edit || []).length + p.editDeny.length, merged: !!base, excluded }
}
