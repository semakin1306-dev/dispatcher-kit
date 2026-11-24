#!/usr/bin/env node
// fake-claude.mjs.tpl — (шаблон: сквозной тест копирует его во временную папку как .mjs; расширение .tpl — чтобы node --test не принял его за тест) поддельный Claude Code для сквозного теста: читает stream-json из stdin и отвечает синтетическим
// потоком stream-json (рукопожатие, init сессии, текст ответа, итог хода). Настоящую модель не зовёт и в сеть не ходит.
// Строка «FAKE-WRITE <путь> <текст>» в сообщении — записать файл в рабочую папку (так агент «пишет код»).
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n")
const sid = "fake-" + process.pid + "-" + Date.now().toString(36)
let started = false, n = 0
const log = process.env.FAKE_CLAUDE_LOG
const note = (s) => { if (log) fs.appendFileSync(log, s + "\n") }
note("argv " + JSON.stringify(process.argv.slice(2)) + " cwd " + process.cwd())

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.type === "control_request") {
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } })
    return
  }
  if (m.type !== "user") return
  const text = typeof m.message.content === "string" ? m.message.content : JSON.stringify(m.message.content)
  note("user " + text.length + " " + text.slice(0, 120).replace(/\n/g, " "))
  if (!started) { started = true; out({ type: "system", subtype: "init", session_id: sid, model: "fake-model" }) }
  const id = "msg_" + (++n)
  const wrote = []
  for (const mm of text.matchAll(/FAKE-WRITE (\S+) ([^\n]+)/g)) {
    const f = path.resolve(process.cwd(), mm[1])
    if (!f.startsWith(path.resolve(process.cwd()))) continue
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, mm[2] + "\n"); wrote.push(mm[1])
  }
  const reply = wrote.length ? "Записал: " + wrote.join(", ") + "." : "Принято."
  out({ type: "stream_event", event: { type: "message_start", message: { id } } })
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: reply } } })
  out({ type: "assistant", message: { id, content: [{ type: "text", text: reply }], usage: { input_tokens: 10, output_tokens: 5 } } })
  out({ type: "result", subtype: "success", is_error: false, duration_ms: 3, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5 } })
})
