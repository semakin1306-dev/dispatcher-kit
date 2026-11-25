// free-mem.test.mjs — доступная память: на macOS — по `vm_stat` (свободные + спекулятивные + неактивные), а не os.freemem().
import { test } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import { availMem, vmStatAvail } from "./free-mem.mjs"

const VM = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               13000.
Pages active:                            200000.
Pages inactive:                          180000.
Pages speculative:                         7000.
Pages throttled:                              0.
Pages wired down:                         90000.
`

test("vm_stat: доступно — свободные, спекулятивные и неактивные страницы; не больше всей памяти", () => {
  const GB = 2 ** 30
  assert.equal(vmStatAvail(VM, 16 * GB), (13000 + 7000 + 180000) * 16384)
  assert.equal(vmStatAvail(VM, GB), GB, "не больше всей памяти")
  assert.equal(vmStatAvail(VM.replace(/^Pages speculative.*\n/m, ""), 16 * GB), (13000 + 180000) * 16384)
  assert.equal(vmStatAvail("нет такого", 16 * GB), null)
  assert.equal(vmStatAvail(VM.replace(/^Pages inactive.*\n/m, ""), 16 * GB), null)
})

test("доступная память этой машины — положительное число не больше всей", () => {
  const v = availMem()
  assert.ok(v > 0 && v <= os.totalmem(), String(v))
  if (process.platform !== "darwin") assert.ok(Math.abs(v - os.freemem()) < os.totalmem() / 4, "вне macOS — os.freemem()")
})
