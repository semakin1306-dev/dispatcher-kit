// Реестр модулей сервера (modules.mjs): включённость по конфигу и подмена в тестах, сторож маршрутов, порядок запуска,
// обработчик маршрутов модуля; разбор вывода netstat/ss для поиска владельца порта (tools/port-pid.mjs).
import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import { MODULE_ROUTES, enabled, moduleHandler, moduleHttp, moduleOfPath, modulesPublic, onModuleBoot, routeGate, setModuleStates, startModules } from "./modules.mjs"
import { netstatPid, ssPid } from "../../../tools/port-pid.mjs"

afterEach(() => setModuleStates())

test("по демо-конфигу: ревью и бэклог включены, выкат, приёмка, машины, бот — нет, с причиной", () => {
  assert.equal(enabled("review"), true)
  assert.equal(enabled("backlog"), true)
  for (const id of ["release", "accept", "machines", "tg", "retro"]) assert.equal(enabled(id), false, id)
  assert.equal(enabled("нет-такого"), false)
  const m = modulesPublic().find((x) => x.id === "release")
  assert.equal(m.on, false); assert.ok(m.why)
})

test("сторож маршрутов: путь выключенного модуля — отказ с именем модуля, ядро открыто всегда", () => {
  assert.equal(moduleOfPath("/api/accept-state"), "accept")
  assert.equal(moduleOfPath("/api/accept/file"), "accept")
  assert.equal(moduleOfPath("/api/acceptor"), null, "префикс — только до границы / - ?")
  assert.equal(moduleOfPath("/api/run"), null)
  assert.deepEqual(routeGate("/api/run"), null)
  assert.equal(routeGate("/api/reminders").id, "accept")
  assert.match(routeGate("/api/reminders").why, /выключен/)
  setModuleStates({ accept: true })
  assert.equal(routeGate("/api/reminders"), null)
  for (const [id, list] of Object.entries(MODULE_ROUTES)) for (const p of list) assert.equal(moduleOfPath(p), id, p)
})

test("запуск: стартуют только включённые, зависимые — после тех, от кого зависят; сбой одного не мешает другим", () => {
  setModuleStates({ retro: true, backlog: true, tg: true, machines: false })
  const order = []
  onModuleBoot("retro", () => order.push("retro"))
  onModuleBoot("backlog", () => order.push("backlog"))
  onModuleBoot("machines", () => order.push("machines"))
  onModuleBoot("tg", () => { throw new Error("нет токена") })
  const r = startModules()
  assert.deepEqual(order, ["backlog", "retro"])
  assert.deepEqual(r.failed.map((x) => x.id), ["tg"])
  assert.deepEqual(startModules().started, [], "второй раз не стартуют")
  assert.throws(() => onModuleBoot("нет-такого", () => { }), /нет такого модуля/)
})

test("модуль отдаёт свой обработчик маршрутов", () => {
  const h = async () => true
  moduleHttp("win-desktop", h)
  assert.equal(moduleHandler("win-desktop"), h)
  assert.equal(moduleHandler("tg"), null)
  assert.throws(() => moduleHttp("нет-такого", h), /нет маршрутов/)
})

test("владелец порта: разбор netstat (Windows) и ss (Linux)", () => {
  const ns = "  TCP    0.0.0.0:135     0.0.0.0:0   LISTENING   1100\r\n  TCP    127.0.0.1:4791   0.0.0.0:0   LISTENING   4242\r\n  TCP    127.0.0.1:47910  0.0.0.0:0   LISTENING   9\r\n"
  assert.equal(netstatPid(ns, 4791), 4242)
  assert.equal(netstatPid(ns, 4792), null)
  const ss = 'LISTEN 0 511 127.0.0.1:4791 0.0.0.0:* users:(("node",pid=5151,fd=21))\nLISTEN 0 511 127.0.0.1:47910 0.0.0.0:* users:(("node",pid=7,fd=3))\n'
  assert.equal(ssPid(ss, 4791), 5151)
  assert.equal(ssPid(ss, 1), null)
})
