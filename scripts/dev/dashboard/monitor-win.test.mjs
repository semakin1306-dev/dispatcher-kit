// monitor-win.test.mjs — Windows-часть монитора на синтетическом снимке машины (как печатает monitor.ps1) и на поддельном
// запуске процессов: PowerShell не запускается. Проверяется разбор процессов по прогонам, агентам и слотам, загрузка ЦП,
// память ОС, окна VS Code и аргументы скриптов окон.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import * as W from "./monitor-win.mjs"

const MB = 1048576
const SAMPLE = {
  procs: [
    { ProcessId: 10, ParentProcessId: 1, Name: "node.exe", CommandLine: "node scripts/dev/dashboard/server.mjs", WorkingSetSize: 200 * MB, Created: 1000 },
    { ProcessId: 20, ParentProcessId: 10, Name: "node.exe", CommandLine: "node runner.mjs", WorkingSetSize: 50 * MB, Created: 0 },
    { ProcessId: 21, ParentProcessId: 20, Name: "node.exe", CommandLine: "node node_modules/jest/bin/jest.js", WorkingSetSize: 300 * MB, Created: 0 },
    { ProcessId: 22, ParentProcessId: 21, Name: "node.exe", CommandLine: "node jest-worker/processChild.js", WorkingSetSize: 100 * MB, Created: 0 },
    { ProcessId: 23, ParentProcessId: 21, Name: "node.exe", CommandLine: "node jest-worker/processChild.js", WorkingSetSize: 110 * MB, Created: 0 },
    { ProcessId: 30, ParentProcessId: 10, Name: "codex.exe", CommandLine: "codex exec --json resume th-1 -", WorkingSetSize: 80 * MB, Created: 0 },
    { ProcessId: 40, ParentProcessId: 1, Name: "cmd.exe", CommandLine: "cmd /c cd D:\\Work\\proj-wt\\s-two && npm run dev", WorkingSetSize: 5 * MB, Created: 0 },
    { ProcessId: 41, ParentProcessId: 40, Name: "node.exe", CommandLine: "node vite --port 5173 --token=abc123", WorkingSetSize: 90 * MB, Created: 0 },
    { ProcessId: 50, ParentProcessId: 1, Name: "Code.exe", CommandLine: "Code.exe", WorkingSetSize: 400 * MB, Created: 0 },
    { ProcessId: 60, ParentProcessId: 1, Name: "chrome.exe", CommandLine: "chrome", WorkingSetSize: 500 * MB, Created: 0 },
  ],
  perf: [
    { Name: "node", IDProcess: 22, PercentProcessorTime: 160 },
    { Name: "node#1", IDProcess: 10, PercentProcessorTime: 8 },
    { Name: "codex", IDProcess: 30, PercentProcessorTime: 16 },
    { Name: "chrome", IDProcess: 60, PercentProcessorTime: 40 },
  ],
  windows: [
    { hwnd: 111, title: "[S1 Поиск] dev/wv-0001-search - a.ts" },
    { hwnd: 222, title: "b.ts - s-two (Workspace)" },
  ],
  mem: { freeCommitKB: 8 * MB, totalCommitKB: 32 * MB, freePhysKB: 4 * MB, totalPhysKB: 16 * MB },
}
const CTX = {
  selfPid: 10, cores: 8, now: 11000, wt: "D:/Work/proj-wt", main: "D:/Work/proj",
  jobs: [{ id: "j7", pid: 20, slot: "s-one", label: "S1 · Тесты · j7" }],
  agents: [{ key: "s-one", pid: 30, label: "S1" }],
  tagSlots: { S1: "s-one" },
  tagOf: (k) => ({ tag: k === "s-one" ? "S1" : k, epic: "e1" }),
}

describe("разбор снимка машины", () => {
  const r = W.analyzeSample(SAMPLE, CTX)
  test("память ОС и тяжёлые процессы", () => {
    assert.deepEqual(r.mem, { freeCommitGB: 8, totalCommitGB: 32, freePhysGB: 4, totalPhysGB: 16 })
    assert.deepEqual(r.topProcs[0], { name: "node", n: 6, mb: 850 })
    assert.equal(W.memFromKB({}), null)
  })
  test("роли процессов: сервер, прогон и его воркеры, агент, dev-сервер; ключи в командной строке скрыты", () => {
    const by = Object.fromEntries(r.procList.map((p) => [p.pid, p]))
    assert.deepEqual([by[10].role, by[10].killable, by[10].upSec], ["диспетчерская", false, 10])
    assert.equal(by[21].role, "тесты · главный"); assert.equal(by[21].jobId, "j7"); assert.equal(by[21].what, "S1 · Тесты · j7")
    assert.equal(by[22].role, "воркер №1 из 2"); assert.equal(by[23].role, "воркер №2 из 2")
    assert.deepEqual([by[30].role, by[30].agentKey], ["агент диспетчерской", "s-one"])
    assert.equal(by[41].role, "dev-сервер"); assert.ok(by[41].what.includes("--token=***") && !by[41].what.includes("abc123"))
    assert.ok(!by[60] && !by[50], "в списке — только node и агентские CLI")
  })
  test("ЦП: свои задачи по дереву процессов, чужие — отдельно", () => {
    assert.deepEqual(r.cpuTasks.map((e) => [e.kind, e.label, e.pct]), [["job", "S1 · Тесты · j7", 20], ["agent", "агент S1", 2], ["dash", "диспетчерская (сервер)", 1]])
    assert.deepEqual(r.cpuTop, [{ name: "chrome", role: "", n: 1, pct: 5 }])
  })
  test("слоты: прогон и агент по корню, прочее — по папке слота, доля окон VS Code", () => {
    const by = Object.fromEntries(r.slotUsage.rows.map((x) => [x.key, x]))
    assert.equal(by["s-one"].tag, "S1"); assert.equal(by["s-one"].job, 560); assert.equal(by["s-one"].agent, 80)
    assert.equal(by["s-one"].win, 200); assert.equal(by["s-one"].hwnd, 111)
    assert.equal(by["s-two"].other, 90); assert.deepEqual(by["s-two"].pids, [41]); assert.equal(by["s-two"].hwnd, 222)
    assert.deepEqual(r.slotUsage.vscode, { mb: 400, cpu: 0, windows: 2, perWindow: 200 })
  })
})

describe("слот по командной строке и по окну", () => {
  test("slotNameOf: папка слотов, служебные папки, основная папка", () => {
    const o = { wt: "D:\\Work\\proj-wt", main: "D:/Work/proj" }
    assert.equal(W.slotNameOf("node D:\\Work\\proj-wt\\s-two\\x.mjs", o), "s-two")
    assert.equal(W.slotNameOf("node D:/Work/proj-wt/_dashboard/x.mjs", o), null)
    assert.equal(W.slotNameOf("node D:/Work/proj/scripts/x.mjs", o), "staging")
    assert.equal(W.slotNameOf("node D:/Work/project2/x.mjs", o), null, "соседняя папка с тем же началом — не основная")
  })
  test("winSlot: метка слота в заголовке и заголовок по умолчанию", () => {
    assert.equal(W.winSlot("[S1 Поиск] dev/x - a.ts", { S1: "s-one" }), "s-one")
    assert.equal(W.winSlot("a.ts - s-two (Рабочая область)"), "s-two")
    assert.equal(W.winSlot("просто окно"), null)
  })
})

describe("запуск PowerShell (поддельный)", () => {
  const fake = (out, err = null) => { const calls = []; const exec = (file, args, opts, cb) => { calls.push({ file, args, opts }); setImmediate(() => cb(err, out, "")) }; return { exec, calls } }
  test("снимок: monitor.ps1 через -File, второй запрос во время первого — null", async () => {
    const f = fake(JSON.stringify(SAMPLE))
    const [a, b] = await Promise.all([W.sampleMachine({ exec: f.exec }), W.sampleMachine({ exec: f.exec })])
    assert.equal(a.procs.length, SAMPLE.procs.length); assert.equal(b, null); assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].file, "powershell.exe"); assert.equal(f.calls[0].args[f.calls[0].args.indexOf("-File") + 1], W.MONITOR_PS1)
    assert.equal(await W.sampleMachine({ exec: fake("не JSON").exec }), null)
  })
  test("память ОС прямым запросом", async () => {
    assert.deepEqual(await W.readOsMemory({ exec: fake(`${8 * MB} ${32 * MB} ${4 * MB} ${16 * MB}\r\n`).exec }), { freeCommitGB: 8, totalCommitGB: 32, freePhysGB: 4, totalPhysGB: 16 })
    assert.equal(await W.readOsMemory({ exec: fake("", new Error("нет")).exec }), null)
  })
  test("окна: список, закрытие, раскладка", async () => {
    assert.deepEqual(await W.listWindows({ exec: fake('[{"hwnd":1,"pid":2,"title":"t"}]').exec }), [{ hwnd: 1, pid: 2, title: "t" }])
    const c = fake("ok\r\n")
    assert.equal(await W.closeWindow(123, { exec: c.exec }), true); assert.deepEqual(c.calls[0].args.slice(-2), ["-Close", "123"])
    assert.equal(await W.closeWindow("x; rm", { exec: c.exec }), false, "дескриптор — только число")
    const a = fake("Arranged")
    await W.arrangeSlotWindows({ apply: true, rows: 2, columns: 3, leftReserve: 0, exec: a.exec })
    const args = a.calls[0].args
    assert.equal(args[args.indexOf("-File") + 1], W.SLOT_WINDOWS_PS1); assert.ok(args.includes("-Apply"))
    assert.deepEqual(args.slice(args.indexOf("-Rows")), ["-Rows", "2", "-Columns", "3", "-LeftReserve", "0"])
  })
})
