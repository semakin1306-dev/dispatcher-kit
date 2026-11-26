// proxy.mjs — пересылка запросов страницы в процесс нужного проекта.
//
// Какой проект: заголовок x-dash-project → параметр ?project= → путь /p/<id>/… → те же признаки в Referer (страница
// проекта, открытая по /p/<id>/ или ?project=, сама шлёт запросы на /api/… без проекта — браузер приписывает адрес
// страницы) → единственный проект дома. Не определился — 400 со списком проектов: угадывать проект нельзя.
//
// Токен: у хаба свой токен страницы. Страница проекта уходит в браузер с токеном хаба вместо токена ядра; изменяющий
// запрос хаб пускает только со своим токеном и подставляет токен ядра. Так браузер знает один токен, вкладка переживает
// перезапуск ядра (новый токен ядра хаб берёт сам), а чужая вкладка без токена хаба не дойдёт до ядра.
import http from "node:http"

/** Тело изменяющего запроса больше этого — отказ (ядро само рвёт тела больше 20 000 знаков). */
export const MAX_BODY = 1 << 20
const ID_IN_PATH = /^\/p\/([a-z][a-z0-9-]{0,39})(\/.*)?$/

/** Проект в адресе: ?project= или путь /p/<id>/…; → { id, path } (path — адрес для ядра) или null. */
export function projectInUrl(u) {
  const q = u.searchParams.get("project")
  const m = ID_IN_PATH.exec(u.pathname)
  if (m) return { id: m[1], path: (m[2] || "/") + u.search }
  if (q) return { id: q, path: u.pathname + u.search }
  return null
}

/**
 * Выбрать проект запроса.
 * @returns {{id:string, path:string} | {error:string, code:number}}
 */
export function pickProject(req, url, ids) {
  const own = projectInUrl(url)
  const head = String(req.headers["x-dash-project"] || "").trim()
  let id = head || (own && own.id) || ""
  const path = own ? own.path : url.pathname + url.search
  if (!id && req.headers.referer) {
    try {
      const r = new URL(req.headers.referer)
      if (r.host === req.headers.host) id = (projectInUrl(r) || {}).id || ""
    } catch { /* неразборчивый Referer — как без него */ }
  }
  if (!id && ids.length === 1) id = ids[0]
  if (!id) return { code: 400, error: "какой проект? Укажите заголовок x-dash-project, ?project=<id> или путь /p/<id>/ — проекты: " + ids.join(", ") }
  if (!ids.includes(id)) return { code: 404, error: "нет такого проекта: " + id + "; проекты: " + ids.join(", ") }
  return { id, path }
}

/** Прочитать тело запроса целиком (изменяющие запросы малы; буфер нужен для повтора с новым токеном ядра). */
export const readRaw = (req) => new Promise((resolve, reject) => {
  const parts = []; let n = 0
  req.on("data", (d) => { n += d.length; if (n > MAX_BODY) { reject(Object.assign(new Error("слишком большое тело запроса"), { code: 413 })); req.destroy(); return } parts.push(d) })
  req.on("end", () => resolve(Buffer.concat(parts)))
  req.on("error", reject)
})

/** Заголовки для ядра: Host — ядра, проект и токен хаба не уходят, токен ядра — только если хаб его подставил. */
export function coreHeaders(headers, { port, token = "" }) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) if (!["host", "x-dash-project", "x-dash-token", "connection", "content-length"].includes(k)) out[k] = v
  out.host = "127.0.0.1:" + port
  if (token) out["x-dash-token"] = token
  return out
}

/** Подставить в страницу ядра токен хаба вместо токена ядра. */
export const pageWithToken = (html, coreToken, hubToken) => coreToken ? String(html).split('content="' + coreToken + '"').join('content="' + hubToken + '"') : String(html)

/** Один запрос к ядру. → Promise<http.IncomingMessage>. */
export function coreRequest({ port, method, path, headers, body = null, signal }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers, ...(body ? { "content-length": String(body.length) } : {}) }
    const r = http.request({ host: "127.0.0.1", port, method, path, headers: h, signal }, resolve)
    r.on("error", reject)
    r.end(body || undefined)
  })
}

const readAll = (res) => new Promise((resolve, reject) => { const p = []; res.on("data", (d) => p.push(d)); res.on("end", () => resolve(Buffer.concat(p))); res.on("error", reject) })
const isPage = (path) => /^\/(index\.html)?(\?|$)/.test(path)

/**
 * Переслать запрос в ядро core (Core из cores.mjs). Страница — буфером с подменой токена; остальное, включая поток
 * событий /api/events, — потоком, без буфера. Ядро ответило «нет токена запуска» — его токен сменился (перезапуск):
 * хаб перечитывает токен и повторяет запрос один раз.
 */
export async function forward(req, res, core, path, { hubToken }) {
  const write = req.method !== "GET" && req.method !== "HEAD"
  const body = write ? await readRaw(req) : null
  const ac = new AbortController()
  res.on("close", () => { if (!res.writableEnded) ac.abort() })
  const once = () => coreRequest({ port: core.port, method: req.method, path, headers: coreHeaders(req.headers, { port: core.port, token: write ? core.token : "" }), body, signal: ac.signal })
  let up = await once()
  if (write && up.statusCode === 403) {
    const text = (await readAll(up)).toString("utf8")
    if (!/нет токена запуска/.test(text) || !(await core.refreshToken())) return send(res, 403, text, up.headers)
    up = await once()
  }
  if (isPage(path) && req.method === "GET" && /text\/html/.test(String(up.headers["content-type"] || ""))) {
    const html = pageWithToken((await readAll(up)).toString("utf8"), core.token, hubToken)
    return send(res, up.statusCode, html, up.headers)
  }
  const stream = /text\/event-stream/.test(String(up.headers["content-type"] || ""))
  if (stream) { core.streams++; res.on("close", () => { core.streams--; core.touch() }) }
  res.writeHead(up.statusCode, up.headers)
  if (stream) res.flushHeaders()
  up.pipe(res)
}

function send(res, code, text, headers = {}) {
  const h = { ...headers }
  delete h["content-length"]; delete h["transfer-encoding"]
  res.writeHead(code, h)
  res.end(text)
}
