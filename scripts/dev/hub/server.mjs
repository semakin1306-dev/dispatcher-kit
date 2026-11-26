#!/usr/bin/env node
// server.mjs — хаб дома: одна страница на DASH_PORT (по умолчанию `hub.port` дома, 4777) для нескольких проектов.
// Запуск: node scripts/dev/hub/server.mjs. Нужен dispatcher.home.json (`node setup.mjs add …`); без дома хаб не нужен —
// диспетчерская одного проекта запускается как прежде (scripts/dev/dashboard/server.mjs).
//
// Что делает: поднимает по процессу на проект (cores.mjs), пересылает в нужный процесс страницу и /api/* (proxy.mjs),
// отдаёт /api/summary — сводку по проектам — и простую страницу-список на «/». Перезапускает упавший процесс проекта,
// при выходе снимает все процессы проектов с деревом потомков.
//
// Безопасность — как у ядра: слушает только 127.0.0.1, Host — только 127.0.0.1 или localhost с портом хаба (защита от
// подмены DNS), изменения — только POST с токеном страницы хаба (он новый при каждом запуске и есть только в страницах,
// которые отдаёт хаб). Своих данных проекта хаб не читает: ни реестра эпиков, ни состояния ядра — только его HTTP.
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import { ProjectConfigError, homeFile, loadHome } from "../project.mjs"
import { Core } from "./cores.mjs"
import { forward, pickProject } from "./proxy.mjs"

const HOST = "127.0.0.1"
const HUB_TOKEN = crypto.randomBytes(16).toString("hex")
const BOOT = Date.now()

let home
try { home = loadHome({ file: homeFile() }) } catch (e) {
  if (!(e instanceof ProjectConfigError)) throw e
  console.error("✗ " + e.message)
  process.exit(2)
}
const PORT = Number(process.env.DASH_PORT || home.hub.port)
fs.mkdirSync(home.hub.data, { recursive: true })

const cores = new Map(home.projects.map((e) => [e.id, new Core(e, { home })]))
const ids = [...cores.keys()]

const send = (res, code, body, type = "application/json; charset=utf-8") => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" })
  res.end(typeof body === "string" ? body : JSON.stringify(body))
}
const okHost = (req) => [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host || "")
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])

/** Сводка хаба: сам хаб и каждый проект — состояние процесса и сводка его ядра (свежая у работающих). */
async function summary() {
  const projects = await Promise.all([...cores.values()].map(async (c) => ({ ...c.public(), summary: await c.poll() })))
  return { hub: { pid: process.pid, port: PORT, home: home.file, startedAt: BOOT, rssMB: Math.round(process.memoryUsage().rss / 1048576) }, projects }
}

const STATE_TEXT = { running: "работает", starting: "запускается", stopped: "остановлен", backoff: "упал, перезапуск" }

/** Страница-список проектов. Вкладки проектов и общая сводка на странице — следующий шаг; здесь — ссылки на страницы. */
async function listPage() {
  const s = await summary()
  const rows = s.projects.map((p) => {
    const sm = p.summary || {}
    const live = (sm.agents && sm.agents.live) ?? "—"
    const what = p.state === "running" ? `эпиков ${sm.epics ?? "—"}, агентов ${live}, ждут вас ${sm.waitingOwner ?? 0}, память ${sm.rssMB ?? "—"} МБ` : esc(p.lastError || p.stopWhy)
    return `<tr><td><a href="/p/${esc(p.id)}/">${esc(p.name)}</a></td><td>${esc(p.id)}</td><td>${esc(STATE_TEXT[p.state] || p.state)}</td><td>${p.port}</td><td>${what}</td></tr>`
  }).join("\n")
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="dash-token" content="${HUB_TOKEN}"><title>Диспетчерская · дом</title>
<meta http-equiv="refresh" content="15">
<style>body{font:15px system-ui,sans-serif;margin:2rem}table{border-collapse:collapse}
td,th{padding:.4rem .8rem;border-bottom:1px solid #ddd;text-align:left}</style>
</head><body><h1>Диспетчерская · проекты дома</h1><table><tr><th>Проект</th><th>id</th><th>Состояние</th><th>Порт</th><th></th></tr>
${rows}</table><p>Дом: ${esc(home.file)}</p></body></html>`
}

const server = http.createServer(async (req, res) => {
  try {
    if (!okHost(req)) return send(res, 403, { error: "неверный Host" })
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (req.method === "GET" && url.pathname === "/api/summary") return send(res, 200, await summary())
    if (url.pathname.startsWith("/api/hub/")) return await hubApi(req, res, url)
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html") && !url.searchParams.get("project") && !req.headers["x-dash-project"])
      return send(res, 200, await listPage(), "text/html; charset=utf-8")
    const pick = pickProject(req, url, ids)
    if (pick.error) return send(res, pick.code, { error: pick.error, projects: ids })
    // изменения — только с токеном хаба: чужая вкладка его не знает, а без него хаб в ядро не пустит
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-dash-token"] !== HUB_TOKEN) return send(res, 403, { error: "нет токена запуска: обновите страницу" })
    const core = cores.get(pick.id)
    core.touch()
    // остановленный (ленивый) проект поднимается запросом; упавший ждёт своей паузы — частые запросы страницы не
    // должны превращать перезапуск с паузами в перезапуск без пауз
    if (core.state !== "running" && !(core.state !== "backoff" && (await core.start("по запросу страницы"))))
      return send(res, 503, { error: `проект ${pick.id} не запущен: ${core.lastError || STATE_TEXT[core.state]}`, project: core.public() })
    await forward(req, res, core, pick.path, { hubToken: HUB_TOKEN })
  } catch (e) {
    if (res.headersSent) { res.destroy(); return }
    send(res, e.code === 413 ? 413 : 502, { error: String((e && e.message) || e) })
  }
})

/** Действия хаба: остановка хаба со всеми проектами (ярлык «остановить», тесты; на Windows сигналов процессу нет). */
async function hubApi(req, res, url) {
  if (req.method !== "POST") return send(res, 404, { error: "нет такого адреса" })
  if (req.headers["x-dash-token"] !== HUB_TOKEN) return send(res, 403, { error: "нет токена запуска: обновите страницу" })
  if (url.pathname === "/api/hub/exit") { send(res, 200, { ok: true, stopping: ids }); setTimeout(() => shutdown("запрос /api/hub/exit"), 50); return }
  return send(res, 404, { error: "нет такого адреса" })
}

let closing = false
async function shutdown(why) {
  if (closing) return
  closing = true
  console.log("хаб останавливается (" + why + "): снимаю процессы проектов")
  server.close()
  await Promise.all([...cores.values()].map((c) => c.stop("остановка хаба").catch(() => { })))
  process.exit(0)
}
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) { try { process.on(sig, () => shutdown(sig)) } catch { /* сигнала нет на этой ОС */ } }
// выход в обход shutdown (необработанная ошибка, process.exit): снять детей синхронно, асинхронное уже не выполнится
process.on("exit", () => { for (const c of cores.values()) c.stopSync() })

// ленивые проекты без дел — остановить; сводки работающих — освежить
setInterval(async () => {
  for (const c of cores.values()) {
    await c.poll()
    if (c.idleDue()) { console.log(`[${c.id}] без дел ${home.hub.idleStopMin} мин — останавливаю (поднимется по первому запросу)`); c.stop("без дел " + home.hub.idleStopMin + " мин") }
  }
}, Number(process.env.DASH_HUB_TICK_MS) || 15000).unref()

server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `Порт ${PORT} занят — хаб или диспетчерская уже запущены? http://${HOST}:${PORT}` : e.message)
  process.exit(1)
})
server.listen(PORT, HOST, () => {
  console.log(`Хаб диспетчерской: http://${HOST}:${PORT}  (дом: ${home.file}, проектов ${ids.length})`)
  for (const c of cores.values()) if (c.entry.start !== "lazy") c.start("запуск хаба").catch((e) => console.error(`[${c.id}]`, e.message))
})
