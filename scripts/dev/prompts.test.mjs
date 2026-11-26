// prompts.test.mjs — тексты подсказок агентам: помощник prompt() (подстановки, ошибки, кеш), каждый файл
// scripts/dev/prompts/*.md кем-то используется, и эталон — итоговые подсказки (как их видит агент) совпадают с
// test/fixtures/prompts-golden.json.
//
// Эталон снят с кода до выноса текстов в файлы: вынос не должен был поменять ни знака. Если подсказку правишь намеренно,
// перезапиши эталон и посмотри дифф фикстуры глазами:
//   DK_PROMPTS_GOLDEN=write node --test scripts/dev/prompts.test.mjs
// Пути машины (папки проекта, данных, временные), порт и персона заменены в эталоне метками <MAIN>, <DATA>, <PERSONA> и т. п.,
// поэтому эталон один на все ОС.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..", "..")
const GOLDEN = path.join(ROOT, "test", "fixtures", "prompts-golden.json")
// Подсказки пишут время местным поясом (окно эпика у ретро): без закреплённого пояса эталон, снятый на одной машине,
// расходится на раннерах CI в UTC. Node подхватывает смену TZ на ходу, а дат до этой строки ещё никто не создавал.
process.env.TZ = "UTC"
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dk-prompts-"))
process.env.DASH_DATA = path.join(TMP, "data")
process.env.DASH_DRY = "1"
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

const { PROMPTS_DIR, prompt, promptSource, promptVars } = await import("./prompts.mjs")
const { EPIC_CLI, HOME, MAIN, PERSONA_PATH, WT, fwd } = await import("./slots.mjs")
const { DATA, PORT, settings } = await import("./dashboard/config.mjs")
const { S } = await import("./dashboard/state.mjs")
const { TREES } = await import("./dashboard/trees.mjs")
const A = await import("./dashboard/agents.mjs")
const P = await import("./dashboard/prompt.mjs")
const BR = await import("./dashboard/backlog-rules.mjs")
const { BACKLOG_KEY } = await import("./dashboard/backlog-agent.mjs")
const CR = await import("./dashboard/commit-rules.mjs")
const TR = await import("./dashboard/train-rules.mjs")
const RR = await import("./dashboard/retro-rules.mjs")
const R = await import("./dashboard/relay.mjs")
const DL = await import("./dashboard/deadlock.mjs")
const AR = await import("./dashboard/accept-rules.mjs")
const AC = await import("./dashboard/autochain.mjs")
const RG = await import("./dashboard/regress.mjs")
const ER = await import("./dashboard/epic-rules.mjs")

// Эпик с обычным слотом (план волны лежит), слотом без плана и поездом — чтобы подсказки собрались со всеми условными кусками.
const ORCH_DIR = path.join(TMP, "orch")
const WAVES = path.join(ORCH_DIR, ".claude", "plans", "waves")
fs.mkdirSync(WAVES, { recursive: true })
fs.writeFileSync(path.join(WAVES, "WV-0001-first.md"), "# план\n")
const SLOTS = [
  { slot: "wv-g1", tag: "П1", title: "Первая", branch: "dev/wv-0001-first" },
  { slot: "wv-g2", tag: "П2", title: "Вторая", branch: "dev/wv-0002-second" },
  { slot: "tr-g", tag: "Т1", title: "Поезд", branch: "dev/tr-g", kind: "train", wagons: [{ wave: "WV-0003" }] },
]
S.EPICS = [{ id: "ep-g", title: "Эталон", orch: { path: ORCH_DIR }, slots: SLOTS }]
TREES.push({ key: "orchestrator@ep-g", kind: "orch", epic: "ep-g", path: ORCH_DIR }, ...SLOTS.map((x) => ({ key: x.slot, kind: "slot", epic: "ep-g", path: path.join(WT, x.slot) })))

let persona = ""
try { persona = fs.readFileSync(PERSONA_PATH, "utf8") } catch { /* персоны нет — заменять нечего */ }
const personaTail = persona.split(/\r?\n---\r?\n/).slice(1).join("\n---\n").trim()

/** Заменить значения машины метками: длинные первыми (путь CLI эпика содержит дом диспетчерской). */
function norm(s) {
  const swaps = [[persona, "<PERSONA>"], [personaTail, "<PERSONA_TAIL>"], [fwd(EPIC_CLI), "<EPIC_CLI>"], [fwd(TMP), "<TMP>"], [fwd(DATA), "<DATA>"],
    [fwd(MAIN), "<MAIN>"], [fwd(WT), "<WT>"], [fwd(HOME), "<HOME>"], [EPIC_CLI, "<EPIC_CLI>"], [TMP, "<TMP>"], [DATA, "<DATA>"], [MAIN, "<MAIN>"], [WT, "<WT>"], [HOME, "<HOME>"]]
    .filter(([v]) => v && v.length > 3).sort((a, b) => b[0].length - a[0].length)
  let out = String(s)
  for (const [v, k] of swaps) out = out.split(v).join(k)
  return out.split(":" + PORT + "/").join(":<PORT>/")
}

/** Итоговые подсказки: имя случая → текст. Вход — фиксированный, как у агента в обычной работе. */
function cases() {
  const out = {}
  const put = (k, v) => { out[k] = norm(v) }
  put("agents.orch", A.agentSystemPrompt("orchestrator@ep-g"))
  put("agents.orch.empty", A.agentSystemPrompt("orchestrator@ep-none"))
  put("agents.slot", A.agentSystemPrompt("wv-g1"))
  put("agents.backlog", A.agentSystemPrompt(BACKLOG_KEY))
  put("agents.slotStart.plan", A.genSlotPrompt("wv-g1"))
  put("agents.slotStart.noPlan", A.genSlotPrompt("wv-g2"))
  put("agents.resume", A.RESUME_TEXT)
  put("agents.idleNudge", A.IDLE_NUDGE_TEXT)
  put("prompt.tools", P.toolsSection())
  put("prompt.tools.slot", P.toolsSection({ slot: true, logsDir: "/logs", cli: "/dash-log.mjs", port: 1234 }))
  put("prompt.results", P.resultsMessage({ lines: ["- api-test: УПАЛ, 12 с"], bad: ["причина"], hint: "следующая станция" }))
  put("prompt.report", P.reportMessage({ word: "УПАЛ", what: "тесты", dir: "/d", cmd: "npm test", exit: "код 1", excerpt: "выжимка" }))
  put("prompt.factsFull", P.FACTS_RULES_FULL)
  put("prompt.factsShort", P.FACTS_RULES_SHORT)
  put("prompt.review", P.reviewPrompt({ br: "dev/wv-0001-first", plan: "ПЛАН", prev: "ПРОШЛОЕ" }))
  put("prompt.review.bare", P.reviewPrompt({ br: "dev/wv-0001-first" }))
  put("prompt.orchPrimer", P.orchPrimer({ ep: "ep-g", orchDir: "/orch", prevId: "0123456789ab", ctx: 123456,
    slots: [P.slotStateLine({ key: "wv-g1", tag: "П1", branch: "dev/wv-0001-first", exists: true, ahead: 2, verdict: { build: "ok", tests: "fail", guards: "green" } }, "busy"),
      P.slotStateLine({ key: "tr-g", tag: "Т1", branch: "dev/tr-g", exists: true, train: true, wagon: "WV-0003", verdict: { merged: true } }, "session"),
      P.slotStateLine({ key: "wv-g2", tag: "П2", branch: "dev/wv-0002-second", exists: false }, "", ["твоя передача ему ждёт отправки"])],
    questions: [{ who: "П1", text: "вопрос 1" }], waits: ["ВЛИТЬ П1 — слово владельца в силе до 12:00; ждёт зелёного: нет «регресс»."], owner: ["слово владельца"] }))
  put("prompt.orchPrimer.bare", P.orchPrimer({ ep: "ep-g", orchDir: "/orch" }))
  put("backlog.system", BR.backlogSystemPrompt({ dir: "/bl", cwd: "/cwd", main: "/main", cli: "/backlog.mjs" }))
  put("backlog.orch", BR.orchBacklogSection({ dir: "/bl", cli: "/backlog.mjs" }))
  put("backlog.research", BR.researchMessage({ id: "BL-0001", file: "/bl/BL-0001-x.md", sha: "abc", notes: "заметки" }))
  put("backlog.epic", BR.epicMessage({ id: "BL-0001", title: "Тема", file: "/bl/BL-0001-x.md", epic: "ep-g", wave: "WV-0001", status: "in-wave", cli: "/backlog.mjs" }))
  for (const m of CR.SELF_COMMIT_MODES) put("commit." + m, CR.selfCommitRule(m))
  put("trains.orch", TR.ORCH_TRAINS_RULE)
  put("retro.rules", RR.RETRO_RULES)
  put("retro.prompt", RR.retroPrompt({ epic: { id: "ep-g", title: "Эталон" }, from: 0, to: 86400e3, waves: [{ tag: "П1", wave: "WV-0001", title: "Первая" }], brief: "сводка",
    counts: { "agent.turn": 3 }, files: { progress: "/p.json", failures: "/f.md", journal: "/j.txt", logs: "/logs", plans: ["/e.md"], plansDir: "/w" }, made: [{ id: "BL-0002", title: "было" }] }))
  put("relay.commitAsk", R.commitAsk({ key: "wv-g1", tag: "П1" }, "dev/wv-0001-first", [{ path: "a.mjs" }, { path: "b.mjs" }]))
  put("relay.commitAsk.train", R.commitAsk({ key: "tr-g", tag: "Т1", train: true }, "dev/tr-g", [{ path: "a.mjs" }]))
  put("relay.trainNote", R.trainCommitNote("Т1", "WV-0003"))
  put("relay.trainNote.noWave", R.trainCommitNote("Т1", ""))
  put("relay.failHint", R.ORCH_FAIL_HINT)
  const RT = { orch: { key: "orchestrator@ep-g" }, p1: { key: "wv-g1", tag: "П1", plannedBranch: "dev/wv-0001-first" }, p2: { key: "wv-g2", tag: "П2" } }
  for (const via of Object.keys(R.RELAY_VIA)) {
    put("relay.head.toOrch." + via, R.relayHead(via, { from: RT.p1, to: RT.orch }))
    put("relay.head.toSlot." + via, R.relayHead(via, { from: RT.orch, to: RT.p1 }))
    put("relay.head.toPeer." + via, R.relayHead(via, { from: RT.p1, to: RT.p2 }))
  }
  put("relay.noBlock", prompt("relay-no-block", { to: "ОРК" }))
  put("deadlock", DL.deadlockText({ what: "ВЛИТЬ П1", why: "причина", n: 3, since: 0, now: 180000 }))
  const w = { tag: "П1", wave: "WV-0001", title: "Первая" }
  put("accept.ask.manual", AR.acceptAskText(w, { standUrl: "https://stand" }))
  put("accept.ask.spec", AR.acceptAskText(w, { runnable: true, specs: ["e2e/wv-0001.spec.ts"] }))
  put("accept.ask.noSpec", AR.acceptAskText({ ...w, wagonOf: "Т1" }, { runnable: true }))
  const items = [{ id: "i1", where: "экран", todo: "нажать", expect: "видно", how: "auto" }, { id: "i2", where: "форма", todo: "ввести", expect: "ошибка", how: "manual" }]
  put("accept.spec", AR.acceptSpecAskText(w, items, { specGlob: "e2e/**/*.spec.ts" }))
  put("accept.spec.noGlob", AR.acceptSpecAskText(w, items))
  const green = { key: "wv-g1", wave: "wv-0001", verdict: { build: "ok", guards: "green", tests: "green", regress: "green" }, stages: [{ id: "review", done: true }] }
  const saved = { ...settings }
  try {
    Object.assign(settings, { selfCommit: "station", autoTrain: true })
    put("autochain.commit.self", AC.nextHint(green))
    Object.assign(settings, { selfCommit: "word", autoTrain: true, autoCommit: true })
    put("autochain.commit.auto", AC.nextHint(green))
  } finally { for (const k of Object.keys(settings)) delete settings[k]; Object.assign(settings, saved) }
  put("regress.stagingRed", RG.stgRedText({ jobId: "j7", task: "api-test", input: "wv-0001", specs: ["a.spec.ts", "b.spec.ts"] }))
  put("epicRules.task", ER.rulesTask({ file: "C:\\orch\\rules.md", findings: [{ n: 3, line: "npm ci", why: "папку готовит диспетчерская" }] }))
  return out
}

// Куски, которые не видны через публичные функции на конфиге примера (модуль выключен, текст внутри асинхронной станции):
// эталон — сам файл подсказки. piece.<имя> в эталоне — текст файла <имя>.md.
const PIECES = ["after-deploy", "red-proof-ask"]

test("эталон: итоговые подсказки агентам не изменились (вынос в файлы — без единого знака разницы)", () => {
  const got = cases()
  for (const n of PIECES) got["piece." + n] = prompt(n)
  if (process.env.DK_PROMPTS_GOLDEN === "write") {
    fs.writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + "\n")
    return
  }
  const want = JSON.parse(fs.readFileSync(GOLDEN, "utf8"))
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), "набор случаев эталона")
  for (const k of Object.keys(want)) assert.equal(got[k], want[k], "подсказка «" + k + "» разошлась с эталоном")
})

// Перечень «что снимает принудительно» в подсказке оркестратора и FORCE_SOFT в relay.mjs уже расходились: подсказка
// обещала одно, код снимал другое. Сверка в обе стороны — по человеческим названиям станций из FORCE_SOFT_LABELS.
test("подсказка оркестратора: «ВЛИТЬ ПN ПРИНУДИТЕЛЬНО» снимает ровно станции FORCE_SOFT", () => {
  assert.deepEqual(Object.keys(R.FORCE_SOFT_LABELS).sort(), [...R.FORCE_SOFT].sort(), "у каждой мягкой станции есть название")
  const m = /«ВЛИТЬ ПN ПРИНУДИТЕЛЬНО»: это снимает только ([^;]+);/.exec(promptSource("orch-system"))
  assert.ok(m, "в подсказке есть фраза «…ПРИНУДИТЕЛЬНО»: это снимает только …;»")
  const said = m[1].split(/,\s*|\s+и\s+/).map((s) => s.trim()).filter(Boolean)
  assert.deepEqual(said.sort(), Object.values(R.FORCE_SOFT_LABELS).sort())
})

// Эталон снят в UTC; та же сборка под другим поясом обязана давать тот же текст (пояс закреплён в начале файла).
test("эталон не зависит от пояса машины: окно ретро — в закреплённом UTC", () => {
  assert.equal(process.env.TZ, "UTC")
  assert.match(cases()["retro.prompt"], /окно 01\.01 00:00 → 02\.01 00:00/)
})

// ── помощник prompt() ──

test("prompt: подстановка, число как значение, значение с {{…}} не раскрывается повторно", () => {
  const name = "orch-trains", text = promptSource(name)
  assert.deepEqual(promptVars(name), ["epicCli"])
  assert.equal(prompt(name, { epicCli: "/x/epic.mjs" }), text.split("{{epicCli}}").join("/x/epic.mjs"))
  assert.equal(prompt(name, { epicCli: "{{epicCli}}" }), text, "подстановка — один проход")
  assert.match(prompt("idle-nudge", { min: 7 }), / 7 минут /)
})

test("prompt: непереданная и лишняя переменная, не строка, плохое имя, нет файла — ошибка", () => {
  assert.throws(() => prompt("orch-trains"), /не переданы переменные epicCli/)
  assert.throws(() => prompt("orch-trains", { epicCli: "x", extra: "y" }), /в тексте нет переменных extra/)
  assert.throws(() => prompt("orch-trains", { epicCli: undefined }), /нужна строка или число/)
  assert.throws(() => prompt("orch-trains", { epicCli: null }), /нужна строка или число/)
  assert.throws(() => prompt("../prompts", {}), /недопустимое имя/)
  assert.throws(() => prompt("нет-такой"), /недопустимое имя/)
  assert.throws(() => prompt("no-such-prompt"), /ENOENT/)
})

test("prompt: последний перевод строки файла в текст не входит, переводы строк — LF", () => {
  for (const f of fs.readdirSync(PROMPTS_DIR)) {
    const raw = fs.readFileSync(path.join(PROMPTS_DIR, f), "utf8")
    assert.ok(raw.endsWith("\n") && !raw.endsWith("\n\n"), f + ": файл кончается ровно одним переводом строки")
    assert.ok(!raw.includes("\r"), f + ": CRLF")
    assert.equal(promptSource(f.replace(/\.md$/, "")), raw.slice(0, -1))
  }
})

/** Имена подсказок из вызовов prompt("…") во всём коде диспетчерской (без тестов). */
function promptCalls() {
  const names = new Map()
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (!["node_modules", ".git", "fixtures"].includes(e.name) && !e.name.startsWith(".")) walk(p); continue }
      if (!e.name.endsWith(".mjs") || e.name.endsWith(".test.mjs")) continue
      for (const m of fs.readFileSync(p, "utf8").matchAll(/\bprompt\("([a-z0-9-]+)"/g)) names.set(m[1], path.relative(ROOT, p))
    }
  }
  walk(ROOT)
  return names
}

test("каждый файл подсказки используется, и у каждого вызова prompt(\"…\") есть файл", () => {
  const files = fs.readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort()
  assert.deepEqual(fs.readdirSync(PROMPTS_DIR).filter((f) => !f.endsWith(".md")), [], "в папке подсказок — только .md")
  const calls = promptCalls()
  assert.deepEqual(files.filter((n) => !calls.has(n)), [], "файлы подсказок без вызова prompt(\"имя\")")
  assert.deepEqual([...calls.keys()].filter((n) => !files.includes(n)).map((n) => n + " (" + calls.get(n) + ")"), [], "вызовы без файла")
})
