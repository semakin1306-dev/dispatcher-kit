// claude.test.mjs — адаптер Claude Code и интерфейс рантайма: записанный руками поток stream-json → нормализованные события;
// протокол процесса (рукопожатие, сообщение, прерывание, смена модели, ответ на запрос разрешения) на поддельном процессе;
// поиск бинарника, записи сессий, разовый запуск, запреты слота.
import { describe, test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import * as C from "./claude.mjs"
import { KINDS, modelOf, proxyEnv, registerRuntime, runOnce, runtime } from "./index.mjs"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dk-claude-"))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

// Поток одного хода: начало сессии, печать ответа кусками, ответ с вызовом команды, запрос разрешения на правку,
// итог команды, лимиты, итог хода, служебный ответ на рукопожатие.
const STREAM = [
    { type: "system", subtype: "init", session_id: "sess-1", model: "model-a" },
    { type: "stream_event", event: { type: "message_start", message: { id: "msg1" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "При" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "вет" } } },
    {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } },
    },
    {
        type: "assistant",
        message: {
            id: "msg1",
            content: [
                { type: "text", text: "Привет" },
                { type: "tool_use", id: "t1", name: "Bash", input: { command: "git status", description: "статус" } },
            ],
            usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 },
        },
    },
    {
        type: "control_request",
        request_id: "r1",
        request: {
            subtype: "can_use_tool",
            tool_name: "Edit",
            input: { file_path: "/w/a.ts", old_string: "a", new_string: "b" },
        },
    },
    {
        type: "user",
        message: {
            content: [
                { type: "tool_result", tool_use_id: "t1", is_error: false, content: [{ type: "text", text: "чисто" }] },
            ],
        },
    },
    {
        type: "assistant",
        message: {
            id: "msg2",
            content: [
                {
                    type: "tool_use",
                    id: "t2",
                    name: "TodoWrite",
                    input: { todos: [{ content: "шаг", status: "in_progress" }] },
                },
                { type: "tool_use", id: "t3", name: "Grep", input: { pattern: "x", path: "src" } },
            ],
            usage: { input_tokens: 5, cache_read_input_tokens: 2000 },
        },
    },
    {
        type: "rate_limit_event",
        rate_limit_info: { rateLimitType: "five_hour", utilization: 0.5, status: "allowed", resetsAt: 1700000000 },
    },
    {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 4200,
        total_cost_usd: 0.0123,
        usage: { input_tokens: 15, output_tokens: 20, cache_read_input_tokens: 3000, cache_creation_input_tokens: 100 },
    },
    { type: "control_response", response: { subtype: "success", request_id: "init_x" } },
]
const WANT = [
  { type: "session", id: "sess-1", model: "model-a" },
  { type: "text.delta", msgId: "msg1", text: "" },
  { type: "text.delta", msgId: "msg1", text: "При" },
  { type: "text.delta", msgId: "msg1", text: "вет" },
  { type: "text", msgId: "msg1", text: "Привет" },
  { type: "tool.start", id: "t1", name: "Bash", kind: "bash", input: { command: "git status", description: "статус", raw: { command: "git status", description: "статус" } } },
  { type: "permission", id: "r1", name: "Edit", kind: "edit", input: { path: "/w/a.ts", old: "a", neu: "b", raw: { file_path: "/w/a.ts", old_string: "a", new_string: "b" } } },
  { type: "tool.end", id: "t1", ok: true, result: "чисто" },
  { type: "text", msgId: "msg2", text: "" },
  { type: "tool.start", id: "t2", name: "TodoWrite", kind: "other", input: { text: "▶ шаг", raw: { todos: [{ content: "шаг", status: "in_progress" }] } } },
  { type: "tool.start", id: "t3", name: "Grep", kind: "search", input: { pattern: "x", path: "src", raw: { pattern: "x", path: "src" } } },
  { type: "limits", limit: "five_hour", util: 0.5, status: "allowed", resetsAt: 1700000000000 },
  { type: "turn.end", ok: true, why: "", ms: 4200, cost: 0.0123, usage: { in: 15, out: 20, cacheRead: 3000, cacheWrite: 100 }, ctxTokens: 2005 },
]

describe("разбор потока stream-json", () => {
  test("записанный поток → нормализованные события; строка приходит кусками, UTF-8 рвётся посреди буквы", () => {
    const st = C.newParseState(), got = []
    const split = C.lineSplitter((m) => got.push(...C.parseLine(m, st)))
    const bytes = Buffer.from(STREAM.map((m) => JSON.stringify(m)).join("\n") + "\nне JSON — служебный вывод\n\n", "utf8")
    for (let i = 0; i < bytes.length; i += 7) split(bytes.subarray(i, i + 7)) // 7 байт: кириллица (2 байта) режется посреди буквы
    assert.deepEqual(got, WANT)
    assert.equal(st.raw.get("r1").file_path, "/w/a.ts", "исходный ввод запроса — для ответа разрешением")
    for (const e of got) if (e.kind) assert.ok(KINDS.includes(e.kind), e.kind)
  })
  test("ход с ошибкой и ход, прерванный человеком", () => {
    assert.deepEqual(C.parseLine({ type: "result", subtype: "error_max_turns", is_error: true }), [
        {
            type: "turn.end",
            ok: false,
            why: "error_max_turns",
            ms: 0,
            cost: 0,
            usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
            ctxTokens: 0,
        },
    ])
    assert.equal(C.parseLine({ type: "result", subtype: "success", is_error: true })[0].why, "ошибка")
    assert.deepEqual(C.parseLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t9", is_error: true, content: "x".repeat(800) }] } })[0].result.length, 701)
  })
  test("виды инструментов", () => {
    for (const [t, k] of [
        ["Bash", "bash"],
        ["Read", "read"],
        ["Write", "write"],
        ["Edit", "edit"],
        ["MultiEdit", "edit"],
        ["NotebookEdit", "edit"],
        ["Glob", "search"],
        ["Grep", "search"],
        ["WebFetch", "other"],
        ["Task", "other"],
        ["mcp__x__y", "other"],
    ])
        assert.equal(C.toolKind(t), k, t)
    assert.deepEqual(C.neutralInput("MultiEdit", { file_path: "a", edits: [{ old_string: "1", new_string: "2" }] }).neu, "2")
    assert.equal(C.neutralInput("NotebookEdit", { notebook_path: "n.ipynb", new_source: "x" }).path, "n.ipynb")
  })
})

/** Поддельный процесс: stdout/stderr — потоки, stdin копит строки. */
function fakeProc() {
  const p = new EventEmitter()
  p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.lines = []
  p.stdin = { destroyed: false, write: (s) => { p.lines.push(...String(s).split("\n").filter(Boolean).map((l) => JSON.parse(l))); return true }, on() { } }
  return p
}

describe("процесс агента", () => {
  test("флаги, рукопожатие, сообщение, прерывание, смена модели, ответы на запросы, выход", async () => {
    let call = null; const proc = fakeProc(), events = []
    const h = C.start({ cwd: TMP, model: "model-b", resume: "sess-0", systemPrompt: "роль", addDirs: [TMP], env: { HTTPS_PROXY: "http://127.0.0.1:9" }, bin: { cmd: "claude-bin", pre: [] } },
      { spawn: (cmd, args, opts) => { call = { cmd, args, opts }; return proc }, kill: () => { proc.killed = true }, onEvent: (e) => events.push(e) })
    assert.equal(call.cmd, "claude-bin"); assert.equal(call.opts.cwd, TMP); assert.equal(call.opts.env.HTTPS_PROXY, "http://127.0.0.1:9")
    for (const f of [
        "--output-format",
        "stream-json",
        "--input-format",
        "--permission-prompt-tool=stdio",
        "--permission-mode=acceptEdits",
        "--setting-sources=user,project,local",
        "--resume=sess-0",
        "--strict-mcp-config",
        "--include-partial-messages",
    ])
        assert.ok(call.args.includes(f), f)
    assert.equal(call.args[call.args.indexOf("--model") + 1], "model-b"); assert.equal(call.args[call.args.indexOf("--append-system-prompt") + 1], "роль")
    assert.deepEqual(proc.lines[0].request, { subtype: "initialize", hooks: null }, "рукопожатие — первой строкой")
    h.send("сделай"); h.interrupt(); h.setModel("model-c")
    assert.deepEqual(proc.lines[1], { type: "user", message: { role: "user", content: "сделай" }, parent_tool_use_id: null, session_id: "" })
    assert.equal(proc.lines[2].request.subtype, "interrupt"); assert.deepEqual(proc.lines[3].request, { subtype: "set_model", model: "model-c" })
    proc.stdout.write(
        JSON.stringify(STREAM[6]) +
            "\n" +
            JSON.stringify({
                type: "control_request",
                request_id: "r2",
                request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "git push" } },
            }) +
            "\n",
    )
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(events.filter((e) => e.type === "permission").map((e) => [e.id, e.kind]), [["r1", "edit"], ["r2", "bash"]])
    h.answerPermission("r1", { allow: true }); h.answerPermission("r2", { allow: false, message: "нельзя" })
    assert.deepEqual(proc.lines[4].response, { subtype: "success", request_id: "r1", response: { behavior: "allow", updatedInput: { file_path: "/w/a.ts", old_string: "a", new_string: "b" } } })
    assert.deepEqual(proc.lines[5].response.response, { behavior: "deny", message: "нельзя" })
    proc.stderr.write("предупреждение\n"); await new Promise((r) => setImmediate(r))
    proc.emit("close", 0); h.kill()
    assert.deepEqual(events.slice(-2), [{ type: "stderr", text: "предупреждение" }, { type: "exit", code: 0 }]); assert.equal(proc.killed, true)
  })
  test("агент с узкими правами: без автоприёма правок и без пользовательских настроек", () => {
    const a = C.argv({ acceptEdits: false, userSettings: false, keepMcp: true })
    assert.ok(a.includes("--permission-mode=default") && a.includes("--setting-sources=project,local"))
    assert.ok(!a.includes("--strict-mcp-config"))
    assert.ok(!a.some((x) => x.startsWith("--resume")))
  })
})

describe("бинарник", () => {
  const dir = path.join(TMP, "bin"); fs.mkdirSync(path.join(dir, "node_modules", "@anthropic-ai", "claude-code"), { recursive: true })
  for (const f of ["claude", "claude.cmd", "node_modules/@anthropic-ai/claude-code/cli.js"]) fs.writeFileSync(path.join(dir, f), "")
  test("PATH: на Windows обёртка npm → node + cli.js, файл без расширения не берётся; иначе — `claude`", () => {
    const win = C.findBin({ bin: "", env: { PATH: dir }, platform: "win32" })
    assert.equal(win.cmd, process.execPath); assert.match(win.pre[0].replace(/\\/g, "/"), /claude-code\/cli\.js$/)
    fs.writeFileSync(path.join(dir, "claude.exe"), "")
    assert.match(C.findBin({ bin: "", env: { PATH: dir }, platform: "win32" }).cmd, /claude\.exe$/i, "программа сильнее обёртки")
    assert.match(C.findBin({ bin: "", env: { PATH: dir }, platform: "linux" }).cmd, /claude$/)
    assert.equal(C.findBin({ bin: "", env: { PATH: path.join(TMP, "нет") }, platform: "linux" }), null)
    assert.deepEqual(C.findBin({ bin: "/opt/claude", env: {}, platform: "linux" }), { cmd: "/opt/claude", pre: [] }, "agent.bin из конфига")
    assert.equal(C.probe({ bin: "", env: { PATH: path.join(TMP, "нет") }, platform: "linux" }).ok, false)
  })
  test("agent.bin — голое имя: ищется в PATH под этим именем (на Windows — .exe, затем обёртка npm); путь — как есть, уже развёрнутый", () => {
    const own = path.join(TMP, "bin-own"); fs.mkdirSync(path.join(own, "node_modules", "@anthropic-ai", "claude-code"), { recursive: true })
    for (const f of ["claude-beta", "claude-beta.cmd", "node_modules/@anthropic-ai/claude-code/cli.js"]) fs.writeFileSync(path.join(own, f), "")
    assert.match(C.findBin({ bin: "claude-beta", env: { PATH: own }, platform: "linux" }).cmd.replace(/\\/g, "/"), /bin-own\/claude-beta$/)
    const win = C.findBin({ bin: "claude-beta", env: { PATH: own }, platform: "win32" })
    assert.equal(win.cmd, process.execPath, "на Windows файл без расширения — не программа: берётся обёртка npm"); assert.match(win.pre[0].replace(/\\/g, "/"), /claude-code\/cli\.js$/)
    assert.equal(C.findBin({ bin: "claude-beta", env: { PATH: path.join(TMP, "нет") }, platform: "linux" }), null, "голого имени нет в PATH — не найден")
    assert.equal(C.findBin({ bin: "claude", env: { PATH: own }, platform: "linux" }), null, "голое имя — именно оно, без подмены")
    const abs = path.join(own, "claude-beta").replace(/\\/g, "/")
    assert.deepEqual(C.findBin({ bin: abs, env: { PATH: "" }, platform: "linux" }), { cmd: abs, pre: [] }, "путь не ищется в PATH")
  })
})

describe("сессии на диске", () => {
  const cfg = path.join(TMP, "cfg"), cwd = path.join(TMP, "Work Dir"), prev = process.env.CLAUDE_CONFIG_DIR
  after(() => { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev })
  test("последняя сессия папки, история, хвост и последний законченный ответ", async () => {
    process.env.CLAUDE_CONFIG_DIR = cfg
    const dir = path.join(cfg, "projects", path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-")); fs.mkdirSync(dir, { recursive: true })
    const lines =
        [
            { type: "user", message: { content: "сделай" } },
            { type: "user", isMeta: true, message: { content: "служебное" } },
            { type: "user", message: { content: "<command-name>x</command-name>" } },
            {
                type: "assistant",
                timestamp: "2026-01-02T03:04:05Z",
                message: {
                    id: "m1",
                    content: [
                        { type: "text", text: "делаю" },
                        { type: "tool_use", id: "t", name: "Write", input: { file_path: "a.ts", content: "x" } },
                    ],
                },
            },
            { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } },
            {
                type: "assistant",
                timestamp: "2026-01-02T03:05:00Z",
                message: { id: "m2", content: [{ type: "text", text: "готово" }] },
            },
        ]
            .map((m) => JSON.stringify(m))
            .join("\n") + "\n"
    fs.writeFileSync(path.join(dir, "old.jsonl"), ""); fs.utimesSync(path.join(dir, "old.jsonl"), new Date(1e12), new Date(1e12))
    fs.writeFileSync(path.join(dir, "new.jsonl"), lines)
    assert.equal(C.latestSession(cwd).id, "new")
    assert.deepEqual(await C.readHistory(cwd, "new"), [
        { t: "user", text: "сделай" },
        { t: "assistant", text: "делаю" },
        {
            t: "tool",
            name: "Write",
            kind: "write",
            input: { path: "a.ts", content: "x", raw: { file_path: "a.ts", content: "x" } },
        },
        { t: "assistant", text: "готово" },
    ])
    const tail = await C.readTail(cwd, "new", 400)
    assert.ok(tail.length <= 400 * 2 && tail.endsWith("\n"))
    assert.deepEqual(C.lastAnswer(lines), { text: "готово", at: Date.parse("2026-01-02T03:05:00Z"), id: "m2" })
    assert.equal(C.lastAnswer(lines + JSON.stringify({ type: "user", message: { content: "ещё" } }) + "\n"), null, "после ответа — новое сообщение: хода нет")
    assert.equal(C.latestSession(path.join(TMP, "чужая")), null)
  })
})

describe("разовый запуск и запреты слота", () => {
  test("ревьюер: только чтение, git-команды списком, задание в stdin", () => {
    const c = C.onceCommand({ prompt: "задание", model: "m", readOnly: true, allowBash: ["git diff", "git log"], addDirs: [TMP], maxTurns: 7, bin: { cmd: "claude-bin", pre: [] } })
    assert.equal(c.cmd, "claude-bin"); assert.equal(c.input, "задание")
    assert.equal(c.args[c.args.indexOf("--allowedTools") + 1], "Read,Grep,Glob,Bash(git diff:*),Bash(git log:*)")
    assert.equal(c.args[c.args.indexOf("--disallowedTools") + 1], "Edit,Write,MultiEdit,NotebookEdit")
    assert.equal(c.args[c.args.indexOf("--max-turns") + 1], "7"); assert.ok(c.args.includes("-p") && !c.args.includes("задание"))
    const w = C.onceCommand({ readOnly: false, allowBash: false, bin: { cmd: "x", pre: [] } })
    assert.equal(w.args[w.args.indexOf("--disallowedTools") + 1], "Bash"); assert.ok(w.args.includes("acceptEdits"))
  })
  test("запреты слота дописываются к существующим настройкам, разрешения человека не теряются", () => {
    const dir = path.join(TMP, "slot"); fs.mkdirSync(path.join(dir, ".claude"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".claude", "settings.local.json"), JSON.stringify({ model: "x", permissions: { allow: ["Bash(ls:*)"], deny: ["Edit(/old/**)", "Bash(git commit:*)"] } }))
    const r = C.writeSlotPolicy(dir, {
        deny: { commands: ["git push", "=git add ."], edit: ["/package.json"], read: ["**/.env"], ask: ["git commit"] },
        editDeny: ["apps/web/**"],
        allowEdit: ["/package.json"],
    })
    const j = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.local.json"), "utf8"))
    assert.equal(j.model, "x"); assert.deepEqual(j.permissions.allow, ["Bash(ls:*)"])
    assert.deepEqual(j.permissions.deny, ["Edit(/old/**)", "Bash(git push:*)", "Bash(git add .)", "Read(**/.env)", "Edit(apps/web/**)"])
    assert.deepEqual(j.permissions.ask, ["Bash(git commit:*)"]); assert.equal(r.merged, true)
  })
})

describe("интерфейс рантайма", () => {
  test("выбор адаптера, модели ролей, прокси", () => {
    assert.equal(runtime().name, "claude"); assert.deepEqual(runtime().caps, { permissionHook: true, persistentProcess: true, rateLimits: true })
    assert.throws(() => runtime("нет-такого"), /не подключён/)
    assert.throws(() => registerRuntime({ name: "x" }), /без `caps`/)
    assert.equal(modelOf("slot", "явная"), "явная"); assert.equal(typeof modelOf("orch"), "string")
    assert.deepEqual(proxyEnv(""), {}); assert.equal(proxyEnv("http://127.0.0.1:8080").HTTPS_PROXY, "http://127.0.0.1:8080")
  })
  test("runOnce: ответ из stdout, код возврата, снятие по времени", async () => {
    const rt = { onceCommand: (o) => ({ cmd: "x", args: [o.prompt], env: { A: "1" }, input: o.prompt }), onceText: (t) => t.trim() }
    const spawnOk = (cmd, args, opts) => {
        const p = fakeProc()
        p.stdin = new PassThrough()
        p.stdin.on("data", (d) => {
            p.stdout.end("ответ на " + d)
            setImmediate(() => p.emit("close", 0))
        })
        assert.equal(opts.env.A, "1")
        return p
    }
    assert.deepEqual(await runOnce({ prompt: "вопрос", cwd: TMP, rt, spawnFn: spawnOk }), { ok: true, text: "ответ на вопрос", code: 0, err: "" })
    const spawnHang = () => { const p = fakeProc(); p.stdin = new PassThrough(); p.pid = 0; p.kill = () => setImmediate(() => p.emit("close", null)); return p }
    const r = await runOnce({ prompt: "x", cwd: TMP, rt, spawnFn: spawnHang, killFn: (p) => p.kill(), timeoutMs: 20 })
    assert.equal(r.ok, false); assert.match(r.err, /снят по времени/)
  })
})
