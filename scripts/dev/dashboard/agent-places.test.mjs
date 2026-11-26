// Предел агентов слотов: кто уступает место, места-файлы общего предела нескольких процессов (проекты дома).
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { evictable, holdersText, placesNow, releasePlace, takePlace } from "./agent-places.mjs"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dk-places-"))
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
let n = 0
const dir = () => path.join(TMP, "p" + ++n)
const MOD = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "agent-places.mjs")).href

test("уступает место молчащий дольше всех; занятый ходом и ждущий разрешения — нет", () => {
  const a = { key: "a", busy: false, pending: new Map(), lastActive: 300 }
  const b = { key: "b", busy: false, pending: new Map(), lastActive: 100 }
  const c = { key: "c", busy: true, pending: new Map(), lastActive: 50 }
  const d = { key: "d", busy: false, pending: new Map([["r1", {}]]), lastActive: 10 }
  assert.equal(evictable([a, b, c, d]).key, "b")
  assert.equal(evictable([c, d]), null)
  assert.equal(evictable([]), null)
})

test("места: не больше предела; тот же ключ — то же место; снятие освобождает; кто держит — в отказе", () => {
  const d = dir()
  assert.deepEqual(takePlace(d, 2, { project: "shop", key: "wv0001-a" }), { ok: true, n: 1 })
  assert.deepEqual(takePlace(d, 2, { project: "shop", key: "wv0001-a" }), { ok: true, n: 1 }, "повтор — то же место")
  assert.deepEqual(takePlace(d, 2, { project: "shop", key: "wv0003-c" }), { ok: true, n: 2 })
  const no = takePlace(d, 2, { project: "shop", key: "wv0002-b" })
  assert.equal(no.ok, false)
  assert.equal(holdersText(no.holders), "shop: wv0001-a, shop: wv0003-c")
  assert.equal(releasePlace(d, { key: "wv0001-a" }), 1)
  assert.equal(releasePlace(d, { key: "wv0003-c" }), 1)
  assert.equal(takePlace(d, 2, { project: "blog", key: "wv0002-b" }).ok, true)
  assert.equal(placesNow(d).length, 1)
  assert.equal(takePlace(d, 1, { project: "x", key: "k" }).ok, false, "предел понизили — занятые места считаются все")
})

test("место умершего процесса снимается при следующем счёте; неразборчивый свежий файл — занят, старый — снимается", () => {
  const d = dir(); fs.mkdirSync(d, { recursive: true })
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout
  fs.writeFileSync(path.join(d, "slot-1.lock"), JSON.stringify({ pid: Number(dead), project: "gone", key: "k" }))
  fs.writeFileSync(path.join(d, "slot-2.lock"), "")
  assert.deepEqual(placesNow(d).map((p) => p.n), [2], "умерший снят, пишущийся — занят")
  const old = new Date(Date.now() - 120000); fs.utimesSync(path.join(d, "slot-2.lock"), old, old)
  assert.deepEqual(placesNow(d), [])
  fs.writeFileSync(path.join(d, "notes.txt"), "чужой файл не место")
  assert.deepEqual(placesNow(d), [])
})

test("общий предел между процессами: место другого живого процесса держится, после его выхода — свободно", async () => {
  const d = dir()
  const src = `import { takePlace } from ${JSON.stringify(MOD)}
const r = takePlace(${JSON.stringify(d)}, 1, { project: "other", key: "wv0009-x" }); console.log(JSON.stringify(r)); setInterval(() => {}, 1000)`
  const child = spawn(process.execPath, ["--input-type=module", "-e", src], { stdio: ["ignore", "pipe", "inherit"] })
  const first = await new Promise((r) => child.stdout.once("data", (b) => r(JSON.parse(String(b)))))
  assert.equal(first.ok, true)
  const no = takePlace(d, 1, { project: "shop", key: "wv0001-a" })
  assert.equal(no.ok, false); assert.equal(no.holders[0].project, "other"); assert.equal(no.holders[0].pid, child.pid)
  child.kill()
  await new Promise((r) => child.once("exit", r))
  assert.equal(takePlace(d, 1, { project: "shop", key: "wv0001-a" }).ok, true, "место упавшего процесса не держится вечно")
})
