// codex.test.mjs — контрактный тест адаптера Codex на поддельном бинарнике: скрипт node печатает синтетический JSONL по схеме
// `codex exec --json` и записывает, с какими аргументами и каким заданием его запустили. Настоящий Codex не запускается.
// Проверяется: разбор событий в нормализованные, первый ход без resume и второй через `resume <id>` (флаги до resume),
// очередь сообщений во время хода, прерывание (процесс уходит, следующий ход — resume), сбой хода, своя история ходов,
// разовый запуск, запреты слота в AGENTS.override.md и info/exclude.
import { describe, test, after } from "node:test"
import assert from "node:assert/strict"
import cp from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as C from "./codex.mjs"
import { KINDS, runOnce, runtime } from "./index.mjs"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dk-codex-"))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

// Поддельный codex: ход по заданию из stdin. «ЗАВИСНИ» — начать команду и ждать сигнала; «СБОЙ» — turn.failed;
// «ПАУЗА» — обычный ход с задержкой (чтобы успеть поставить сообщения в очередь); иначе — полный обычный ход.
const FAKE = path.join(TMP, "fake-codex.mjs")
fs.writeFileSync(FAKE, `
import fs from "node:fs"
const args = process.argv.slice(2), ri = args.indexOf("resume"), thread = ri >= 0 ? args[ri + 1] : "th-1"
let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (d) => { input += d })
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, input }) + "\\n")
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
  out({ type: "thread.started", thread_id: thread })
  out({ type: "turn.started" })
  if (input.includes("ЗАВИСНИ")) {
    out({ type: "item.started", item: { id: "item_0", type: "command_execution", command: "sleep 100", aggregated_output: "", exit_code: null, status: "in_progress" } })
    process.on("SIGINT", () => process.exit(130))
    setInterval(() => {}, 1000)
    return
  }
  if (input.includes("СБОЙ")) {
    out({ type: "error", message: "повтор запроса" })
    out({ type: "turn.failed", error: { message: "лимит исчерпан" } })
    process.exit(1)
  }
  const go = () => {
    process.stdout.write("служебная строка не JSON\\n")
    out({ type: "error", message: "предупреждение" })
    out({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "думаю" } })
    out({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "git status", aggregated_output: "", exit_code: null, status: "in_progress" } })
    out({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "git status", aggregated_output: "чисто", exit_code: 0, status: "completed" } })
    out({ type: "item.completed", item: { id: "item_2", type: "file_change", changes: [{ path: "src/new.ts", kind: "add" }], status: "completed" } })
    out({ type: "item.completed", item: { id: "item_3", type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }, { path: "src/b.ts", kind: "delete" }], status: "completed" } })
    out({ type: "item.completed", item: { id: "item_4", type: "mcp_tool_call", server: "docs", tool: "find", arguments: { q: "x" }, result: "ok", error: null, status: "completed" } })
    out({ type: "item.completed", item: { id: "item_5", type: "error", message: "мелкое предупреждение" } })
    out({ type: "item.completed", item: { id: "item_6", type: "agent_message", text: "Готово: " + input.trim().split("\\n").pop() } })
    out({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 30, reasoning_output_tokens: 5 } })
  }
  if (input.includes("ПАУЗА")) setTimeout(go, 400); else go()
})
`)
const LOG = path.join(TMP, "calls.jsonl")
process.env.FAKE_CODEX_LOG = LOG
const BIN = { cmd: process.execPath, pre: [FAKE] }
const calls = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []
const resetCalls = () => { try { fs.rmSync(LOG) } catch { /* нет */ } }

/** Ждать события, удовлетворяющего условию (с пределом времени, чтобы тест не висел). */
function waitFor(events, pred, ms = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
        const e = events.find(pred)
        if (e) return resolve(e)
        if (Date.now() - t0 > ms)
            return reject(new Error("не дождался события; есть: " + events.map((x) => x.type).join(",")))
        setTimeout(tick, 20)
    }
    tick()
  })
}

const STREAM = [
  { type: "thread.started", thread_id: "th-9" },
  { type: "turn.started" },
  { type: "error", message: "предупреждение" },
  { type: "item.started", item: { id: "item_1", type: "command_execution", command: "ls", status: "in_progress" } },
  { type: "item.updated", item: { id: "item_1", type: "command_execution", command: "ls", status: "in_progress" } },
  { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "ls", aggregated_output: "x".repeat(800), exit_code: 2, status: "failed" } },
  { type: "item.completed", item: { id: "item_2", type: "file_change", changes: [{ path: "a.ts", kind: "add" }], status: "completed" } },
  { type: "item.completed", item: { id: "item_3", type: "web_search", query: "node test" } },
  { type: "item.completed", item: { id: "item_4", type: "agent_message", text: "ответ" } },
  { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, cache_write_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 } },
]

describe("разбор событий codex exec --json", () => {
  test("синтетический поток → нормализованные события", () => {
    const st = C.newParseState("p:", "m1"), got = []
    const split = C.lineSplitter((m) => got.push(...C.parseEvent(m, st)))
    const bytes = Buffer.from(STREAM.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf8")
    for (let i = 0; i < bytes.length; i += 5) split(bytes.subarray(i, i + 5)) // кириллица режется посреди буквы
    assert.deepEqual(got.map((e) => e.type), ["session", "stderr", "tool.start", "tool.end", "tool.start", "tool.end", "tool.start", "tool.end", "text", "turn.end"])
    assert.deepEqual(got[0], { type: "session", id: "th-9", model: "m1" })
    assert.deepEqual(got[1], { type: "stderr", text: "предупреждение" }, "error верхнего уровня — предупреждение, не сбой агента")
    assert.equal(got[2].kind, "bash"); assert.equal(got[2].id, "p:item_1"); assert.equal(got[2].input.command, "ls")
    assert.equal(got[3].ok, false); assert.equal(got[3].result.length, 701)
    assert.equal(got[4].kind, "write"); assert.equal(got[4].input.path, "a.ts")
    assert.equal(got[6].kind, "other"); assert.equal(got[6].input.text, "node test")
    assert.deepEqual(got[8], { type: "text", msgId: "p:item_4", text: "ответ" })
    assert.deepEqual(got[9], { type: "turn.end", ok: true, why: "", ms: 0, cost: 0, usage: { in: 10, out: 4, cacheRead: 4, cacheWrite: 2 }, ctxTokens: 0 })
    for (const e of got) if (e.kind) assert.ok(KINDS.includes(e.kind), e.kind)
    assert.equal(st.ended, true)
  })
  test("turn.failed, правка с удалением, нет text.delta и permission", () => {
    assert.deepEqual(C.parseEvent({ type: "turn.failed", error: { message: "нет сети" } }).map((e) => [e.type, e.ok, e.why]), [["turn.end", false, "нет сети"]])
    assert.equal(C.parseEvent({ type: "item.started", item: { id: "i", type: "file_change", changes: [{ path: "a", kind: "update" }] } })[0].kind, "edit")
    const all = STREAM.flatMap((m) => C.parseEvent(m))
    assert.ok(!all.some((e) => e.type === "text.delta" || e.type === "permission"))
  })
})

describe("ходы-процессы на поддельном бинарнике", () => {
  const cwd = path.join(TMP, "slot"), hroot = path.join(TMP, "hist")
  fs.mkdirSync(cwd, { recursive: true })

  test("первый ход — новый тред с подсказкой роли, второй — resume <id>; очередь; прерывание; остановка", async () => {
    resetCalls()
    const events = []
    const h = C.start({ cwd, model: "model-x", systemPrompt: "РОЛЬ: слот", bin: BIN, histRoot: hroot, network: false }, { spawn: cp.spawn, onEvent: (e) => events.push(e) })
    assert.equal(h.proc, null, "до первого сообщения процесса нет")

    // ход 1
    h.send("привет")
    assert.ok(h.proc && h.proc.pid, "во время хода proc — процесс хода")
    await waitFor(events, (e) => e.type === "turn.end")
    const types = events.map((e) => e.type)
    assert.deepEqual(types, ["session", "stderr", "tool.start", "tool.end", "tool.start", "tool.end", "tool.start", "tool.end", "tool.start", "tool.end", "stderr", "text", "turn.end"])
    assert.deepEqual(events[0], { type: "session", id: "th-1", model: "model-x" })
    const tools = events.filter((e) => e.type === "tool.start")
    assert.deepEqual(tools.map((e) => [e.name, e.kind]), [["shell", "bash"], ["apply_patch", "write"], ["apply_patch", "edit"], ["docs.find", "other"]])
    assert.equal(events.find((e) => e.type === "tool.end").result, "чисто")
    assert.equal(events.find((e) => e.type === "text").text, "Готово: привет")
    const end1 = events.find((e) => e.type === "turn.end")
    assert.equal(end1.ok, true); assert.deepEqual(end1.usage, { in: 1200, out: 35, cacheRead: 1000, cacheWrite: 0 }); assert.ok(end1.ms >= 0)
    let c = calls()
    assert.equal(c.length, 1)
    const a1 = c[0].args
    assert.deepEqual(a1.slice(0, 2), ["exec", "--json"])
    assert.equal(a1[a1.indexOf("-m") + 1], "model-x"); assert.equal(a1[a1.indexOf("-s") + 1], "workspace-write")
    assert.equal(a1[a1.indexOf("-C") + 1], cwd.replace(/\\/g, "/"))
    assert.ok(!a1.includes("resume")); assert.equal(a1[a1.length - 1], "-", "задание — из stdin")
    assert.ok(!a1.some((x) => /network_access/.test(x)), "сеть по умолчанию выключена")
    assert.ok(c[0].input.startsWith("РОЛЬ: слот\n\n") && c[0].input.endsWith("привет"))
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(h.proc, null, "между ходами процесса нет")

    // ход 2 + очередь: пока идёт ход, два сообщения копятся и уходят одним ходом
    events.length = 0
    h.setModel("model-y")
    h.send("ПАУЗА раз")
    h.send("два"); h.send("три")
    assert.equal(h.queued(), 2)
    await waitFor(events, (e) => e.type === "turn.start")
    await waitFor(events, (e) => e.type === "turn.end" && events.indexOf(e) > events.findIndex((x) => x.type === "turn.start"))
    c = calls()
    assert.equal(c.length, 3)
    for (const x of c.slice(1)) {
      const a = x.args, ri = a.indexOf("resume")
      assert.ok(ri > 0 && a[ri + 1] === "th-1", "продолжение — resume <thread_id>")
      assert.ok(a.indexOf("-s") < ri && a.indexOf("-C") < ri && a.indexOf("-m") < ri, "флаги — до resume")
      assert.equal(a[a.indexOf("-m") + 1], "model-y", "модель — со следующего хода")
      assert.ok(!x.input.includes("РОЛЬ"), "подсказка роли — только в первом ходе беседы")
    }
    assert.equal(c[2].input, "два\n\nтри")
    assert.equal(events.find((e) => e.type === "turn.start").queued, 2)

    // прерывание: процесс хода уходит, ход закрыт как прерванный, отложенное ждёт следующего send
    events.length = 0
    h.send("ЗАВИСНИ")
    await waitFor(events, (e) => e.type === "tool.start")
    const proc = h.proc
    const closed = new Promise((r) => proc.once("close", () => r(true)))
    h.send("после прерывания")
    h.interrupt()
    assert.equal(await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 10000).unref())]), true, "процесс хода завершён")
    const end = await waitFor(events, (e) => e.type === "turn.end")
    assert.deepEqual([end.ok, end.why], [false, "прерван"])
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(calls().length, 4, "после прерывания очередь сама не уходит")
    assert.ok(!events.some((e) => e.type === "exit"), "прерывание — не конец агента")
    events.length = 0
    h.send("дальше")
    await waitFor(events, (e) => e.type === "turn.end")
    c = calls()
    const last = c[c.length - 1]
    assert.ok(last.args.includes("resume") && last.args[last.args.indexOf("resume") + 1] === "th-1", "после прерывания — resume")
    assert.equal(last.input, "после прерывания\n\nдальше")

    // остановка агента: exit — только после kill()
    h.kill()
    const ex = await waitFor(events, (e) => e.type === "exit")
    assert.equal(ex.code, 0)
    assert.throws(() => h.send("ещё"), /остановлен/)
  })

  test("сбой хода: turn.failed → turn.end ok:false; продолжение известной беседы, сеть из конфига", async () => {
    resetCalls()
    const events = []
    const h = C.start({ cwd, resume: "th-1", systemPrompt: "РОЛЬ", bin: BIN, histRoot: hroot, network: true }, { spawn: cp.spawn, onEvent: (e) => events.push(e) })
    h.send("СБОЙ")
    const end = await waitFor(events, (e) => e.type === "turn.end")
    assert.deepEqual([end.ok, end.why], [false, "лимит исчерпан"])
    assert.ok(events.some((e) => e.type === "stderr" && e.text === "повтор запроса"))
    const a = calls()[0].args
    assert.ok(a.includes("resume") && !calls()[0].input.includes("РОЛЬ"), "продолжение без подсказки роли")
    assert.ok(a.includes("sandbox_workspace_write.network_access=true"))
    h.kill(); await waitFor(events, (e) => e.type === "exit")
  })

  test("нет бинарника: событие error (агент мёртв), а не зависание", async () => {
    const events = []
    const h = C.start({ cwd, bin: { cmd: path.join(TMP, "нет-такого-codex"), pre: [] }, histRoot: hroot }, { spawn: cp.spawn, onEvent: (e) => events.push(e) })
    h.send("x")
    await waitFor(events, (e) => e.type === "error")
    assert.equal(events.find((e) => e.type === "turn.end").ok, false)
  })

  test("своя история ходов: последняя беседа папки, реплики, последний ответ", async () => {
    assert.equal(C.latestSession(cwd, hroot).id, "th-1")
    const hist = await C.readHistory(cwd, "th-1", hroot)
    assert.deepEqual(hist[0], { t: "user", text: "привет" }, "в истории — слова человека, без подсказки роли")
    assert.ok(hist.some((x) => x.t === "assistant" && x.text === "Готово: привет"))
    assert.ok(hist.some((x) => x.t === "tool" && x.kind === "bash" && x.input.command === "git status"))
    const tail = await C.readTail(cwd, "th-1", 1e6, hroot)
    assert.equal(C.lastAnswer(tail), null, "последний ход упал — законченного ответа после него нет")
    const lines = tail.split("\n").filter(Boolean), firstEnd = lines.findIndex((l) => JSON.parse(l).type === "turn.end")
    const ok = lines.slice(0, firstEnd + 1).join("\n") // запись по конец первого хода
    assert.equal(C.lastAnswer(ok).text, "Готово: привет")
    assert.equal(C.latestSession(path.join(TMP, "чужая"), hroot), null)
  })
})

describe("разовый запуск", () => {
  test("ревью: read-only, задание в stdin, ответ — последний agent_message", async () => {
    const c = C.onceCommand({ prompt: "задание", model: "m", readOnly: true, addDirs: [TMP], bin: { cmd: "codex-bin", pre: [] } })
    assert.equal(c.cmd, "codex-bin"); assert.equal(c.input, "задание")
    assert.equal(c.args[c.args.indexOf("-s") + 1], "read-only"); assert.ok(!c.args.includes("--add-dir") && !c.args.includes("задание"))
    const w = C.onceCommand({ readOnly: false, addDirs: [TMP], bin: { cmd: "x", pre: [] } })
    assert.equal(w.args[w.args.indexOf("-s") + 1], "workspace-write"); assert.ok(w.args.includes("--add-dir"))
    resetCalls()
    const rt = { ...C, onceCommand: (o) => C.onceCommand({ ...o, bin: BIN }) }
    const r = await runOnce({ prompt: "проверь правку", cwd: TMP, rt })
    assert.deepEqual([r.ok, r.text, r.code], [true, "Готово: проверь правку", 0])
    assert.equal(C.onceText('{"type":"turn.completed","usage":{}}\n'), "")
  })
})

describe("запреты слота", () => {
  const git = (dir, ...a) => cp.execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim()
  test("AGENTS.override.md: правила слота + AGENTS.md проекта, в info/exclude, рабочая копия чистая", () => {
    const main = path.join(TMP, "repo"), wt = path.join(TMP, "repo-slot")
    fs.mkdirSync(main, { recursive: true })
    git(main, "init", "-q", "-b", "staging")
    fs.writeFileSync(path.join(main, "AGENTS.md"), "Правило проекта: тесты зовёт человек.\n")
    git(main, "add", "AGENTS.md"); git(main, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init")
    git(main, "worktree", "add", "-q", "-b", "dev/wv-0001-x", wt)
    const policy = { deny: { commands: ["git push", "=git add ."], ask: ["git commit"], read: ["**/.env"], edit: ["/package.json"] }, editDeny: ["apps/web/**"], allowEdit: ["/package.json"] }
    const r = C.writeSlotPolicy(wt, policy)
    assert.equal(r.merged, true); assert.equal(r.excluded, true)
    const text = fs.readFileSync(path.join(wt, "AGENTS.override.md"), "utf8")
    for (const s of ["`git push` и всё, что так начинается", "ровно `git add .`", "`git commit`", "`apps/web/**`", "`**/.env`", "Правило проекта: тесты зовёт человек."]) assert.ok(text.includes(s), s)
    assert.ok(!text.includes("/package.json"), "снятый для слота запрет не попадает")
    assert.ok(text.indexOf("Правила слота") < text.indexOf("Правило проекта"))
    assert.equal(git(wt, "status", "--porcelain"), "", "файл не виден git — не уедет в коммит")
    C.writeSlotPolicy(wt, policy)
    const ex = fs.readFileSync(path.join(main, ".git", "info", "exclude"), "utf8")
    assert.equal(ex.split("\n").filter((l) => l === "/AGENTS.override.md").length, 1, "строка в exclude — одна")
    // свой AGENTS.override.md проекта не трогается
    fs.writeFileSync(path.join(wt, "AGENTS.override.md"), "свой\n")
    git(wt, "add", "-f", "AGENTS.override.md")
    assert.equal(C.writeSlotPolicy(wt, policy), null)
    assert.equal(fs.readFileSync(path.join(wt, "AGENTS.override.md"), "utf8"), "свой\n")
  })
  test("текст правил: сеть включена конфигом — о ней не обещаем", () => {
    assert.ok(!C.policyText({ deny: { commands: [], ask: [], read: [], edit: [] } }, { network: true }).includes("выходить в сеть"))
  })
})

describe("регистрация и бинарник", () => {
  test("runtime('codex'): экспериментальный, без разрешений, без постоянного процесса, без лимитов", () => {
    const rt = runtime("codex")
    assert.equal(rt.name, "codex"); assert.equal(rt.experimental, true); assert.match(rt.label, /экспериментальный/)
    assert.deepEqual(rt.caps, { permissionHook: false, persistentProcess: false, rateLimits: false })
    assert.match(C.EXPERIMENTAL_NOTE, /не проверен на живом прогоне/)
  })
  test("PATH: на Windows обёртка npm → node + codex.js; иначе — `codex`; agent.bin сильнее", () => {
    const dir = path.join(TMP, "bin"); fs.mkdirSync(path.join(dir, "node_modules", "@openai", "codex", "bin"), { recursive: true })
    for (const f of ["codex", "codex.cmd", "node_modules/@openai/codex/bin/codex.js"]) fs.writeFileSync(path.join(dir, f), "")
    const win = C.findBin({ bin: "", env: { PATH: dir }, platform: "win32" })
    assert.equal(win.cmd, process.execPath); assert.match(win.pre[0].replace(/\\/g, "/"), /@openai\/codex\/bin\/codex\.js$/)
    fs.writeFileSync(path.join(dir, "codex.exe"), "")
    assert.match(C.findBin({ bin: "", env: { PATH: dir }, platform: "win32" }).cmd, /codex\.exe$/i)
    assert.match(C.findBin({ bin: "", env: { PATH: dir }, platform: "linux" }).cmd, /codex$/)
    assert.deepEqual(C.findBin({ bin: "/opt/codex", env: {}, platform: "linux" }), { cmd: "/opt/codex", pre: [] })
    assert.match(C.findBin({ bin: "codex.cmd", env: { PATH: dir }, platform: "win32" }).pre[0].replace(/\\/g, "/"), /@openai\/codex\/bin\/codex\.js$/, "голое имя с расширением — из PATH")
    const p = C.probe({ bin: "", env: { PATH: path.join(TMP, "нет") }, platform: "linux" })
    assert.equal(p.ok, false); assert.match(p.note, /экспериментальная/)
  })
})
