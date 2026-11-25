// runtimes/index.mjs — интерфейс рантайма агента: выбор адаптера по `PROJECT.agent.runtime`, общие типы событий и разовый
// запуск (ревью, ретро). Остальной код диспетчерской говорит с агентом только через этот интерфейс и agents.mjs и не знает
// ни флагов CLI, ни формата протокола, ни имён инструментов конкретного рантайма.
//
// ── Контракт адаптера (runtimes/<имя>.mjs) ──
//
//   name, label, experimental?           имя для конфига и подпись для страницы.
//   caps { permissionHook, persistentProcess, rateLimits }
//       permissionHook    — рантайм спрашивает разрешение на каждый инструмент (событие `permission`, ответ answerPermission).
//                           Нет — права задаются заранее (песочница, список разрешённого), карточек «Разрешить?» не бывает.
//       persistentProcess — один процесс живёт между ходами (send пишет в него). Нет — каждый ход отдельный процесс,
//                           продолжение беседы — по id сессии.
//       rateLimits        — рантайм сообщает о лимитах (событие `limits`); диспетчерская их только показывает.
//   probe() → { ok, bin, why }           есть ли рантайм на этой машине (без запуска модели).
//   start(opts, { spawn, onEvent }) → handle
//       opts: { cwd, model, resume (id сессии | null), systemPrompt, acceptEdits, userSettings, addDirs[], disallow[], env }
//       handle: { proc | null, send(text), interrupt(), setModel(model), answerPermission(id, { allow, input?, message? }), kill() }
//       proc у рантайма без постоянного процесса — процесс текущего хода (геттер; между ходами null): кто считает
//       память и ЦП агента, читает handle.proc в момент замера, а не запоминает его при запуске.
//       Всё, что приходит от рантайма, адаптер отдаёт в onEvent нормализованными событиями (ниже). Ошибка запуска — исключение.
//   latestSession(cwd) → { id, at } | null       последняя сессия рантайма для папки.
//   readHistory(cwd, id) → [{ t: "user"|"assistant", text } | { t: "tool", name, kind, input }]
//   readTail(cwd, id, bytes) → string            хвост записи сессии как есть (для lastAnswer).
//   lastAnswer(tail) → { text, at, id } | null   последний законченный ответ агента (ход без незавершённых инструментов).
//   onceCommand(opts) → { cmd, args, env, input }   разовый запуск (см. runOnce); input — текст в stdin. Тот же набор годится
//                           шагом очереди прогонов (ревью идёт прогоном): { cmd, args, env } + задание в stdin.
//   onceText?(stdout) → string                   ответ разового запуска из его вывода (нет — вывод как есть).
//   writeSlotPolicy(dir, policy)                 запреты слота в формате рантайма (policy — нейтральный раздел `deny` и `editDeny`).
//
// ── Нормализованные события (onEvent) ──
//
//   { type: "session", id, model }                        беседа началась или продолжена (id может смениться при продолжении)
//   { type: "text.delta", msgId, text }                   кусок ответа по ходу печати; text "" — начало нового ответа
//   { type: "text", msgId, text }                         ответ целиком (text может быть "", если в сообщении только инструменты)
//   { type: "tool.start", id, name, kind, input }         вызов инструмента; kind — один из KINDS, input — NeutralInput
//   { type: "tool.end", id, ok, result }                  итог инструмента (result — короткий текст)
//   { type: "permission", id, name, kind, input }         рантайм спрашивает разрешение (только при caps.permissionHook)
//   { type: "turn.end", ok, why, ms, cost, usage: { in, out, cacheRead, cacheWrite }, ctxTokens }   ход окончен
//   { type: "limits", limit, util, status, resetsAt }      сведения о лимитах (только при caps.rateLimits)
//   { type: "stderr", text } · { type: "error", message }
//   { type: "exit", code }                                агент закончился (процесс ушёл); у рантайма без постоянного процесса —
//                                                         только после kill(), не после каждого хода
//   { type: "turn.start", queued }                        только у рантайма без постоянного процесса: адаптер сам начал ход из
//                                                         сообщений, накопленных во время прошлого хода (queued — сколько их);
//                                                         агент снова занят. Обычный ход начинает send() вызывающего — события нет.
//
//   NeutralInput: { command?, description?, path?, pattern?, content?, old?, neu?, offset?, limit?, text?, raw }
//       raw — исходный ввод инструмента как есть (нужен только адаптеру и для показа «прочего»).
//
// ── Codex (runtimes/codex.mjs, экспериментальный, не проверен на живом прогоне) ──
//
//   Ход — процесс `codex exec --json` (продолжение — `resume <thread_id>`), задание в stdin. caps = { permissionHook: false,
//   persistentProcess: false, rateLimits: false }: запросов разрешения нет, права — песочница (`workspace-write` с папкой слота,
//   разовые запуски — `read-only`), answerPermission ничего не делает. Сообщения во время хода копятся и уходят следующим
//   ходом (событие `turn.start`). interrupt() останавливает процесс хода; setModel() — модель следующего хода. Предупреждения
//   Codex приходят как `stderr`, не `error`. История чата — своя запись адаптера в папке данных. Запреты слота — текстом в
//   AGENTS.override.md папки слота: машиной держатся только запись вне папки и сеть.
import path from "node:path"
import { PROJECT } from "../slots.mjs"
import * as claude from "./claude.mjs"
import * as codex from "./codex.mjs"
import { spawn, killTree } from "../dashboard/spawner.mjs"

/** Виды инструментов, которые понимает диспетчерская. Политика прав и лента работают только с ними. */
export const KINDS = ["bash", "read", "write", "edit", "search", "other"]
export const EVENT_TYPES = ["session", "text.delta", "text", "tool.start", "tool.end", "permission", "turn.end", "limits", "stderr", "error", "exit", "turn.start"]

const ADAPTERS = new Map([[claude.name, claude], [codex.name, codex]])

/** Подключить адаптер (новый рантайм регистрируется здесь, не правкой вызывающих модулей). */
export function registerRuntime(adapter) {
  for (const k of ["name", "caps", "start", "onceCommand", "latestSession", "readHistory"]) if (!(k in adapter)) throw new Error("адаптер рантайма без `" + k + "`")
  ADAPTERS.set(adapter.name, adapter)
}

/** Выбранный адаптер. Имя — из конфига проекта; можно спросить конкретный. */
export function runtime(name = PROJECT.agent.runtime) {
  const a = ADAPTERS.get(name || "claude")
  if (!a) throw new Error("рантайм агента «" + name + "» не подключён в этой версии диспетчерской; доступны: " + [...ADAPTERS.keys()].join(", "))
  return a
}

export const caps = () => runtime().caps

/** Модель роли: явный выбор сильнее, иначе — `PROJECT.agent.models[role]`; пусто — умолчание рантайма. */
export const modelOf = (role, explicit = "") => String(explicit || "").trim() || (PROJECT.agent.models && PROJECT.agent.models[role]) || ""

/** Окружение процесса агента: прокси из конфига (`agent.proxy`), если он задан. */
export function proxyEnv(proxy = PROJECT.agent.proxy) {
  if (!proxy) return {}
  return { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: "127.0.0.1,localhost" }
}

/**
 * Разовый запуск агента: задание в stdin, ответ — текст из stdout.
 * readOnly — без записи файлов; allowBash — false, true или список начал команд (например ["git diff", "git log"]);
 * addDirs — папки, которые агенту можно читать вне cwd; maxTurns — предел ходов; timeoutMs — предел времени.
 * @returns {Promise<{ok:boolean, text:string, code:number|null, err:string}>}
 */
export function runOnce({
    prompt,
    cwd,
    model = "",
    readOnly = true,
    allowBash = false,
    addDirs = [],
    maxTurns = 60,
    timeoutMs = 30 * 60e3,
    onProc = null,
    rt = runtime(),
    spawnFn = spawn,
    killFn = killTree,
} = {}) {
    const c = rt.onceCommand({
        prompt,
        model,
        readOnly,
        allowBash,
        addDirs: addDirs.map((d) => path.resolve(d)),
        maxTurns,
    })
    return new Promise((resolve) => {
        let child
        try {
            child = spawnFn(c.cmd, c.args, { cwd, windowsHide: true, env: { ...process.env, ...proxyEnv(), ...c.env } })
        } catch (e) {
            resolve({ ok: false, text: "", code: null, err: e.message })
            return
        }
        if (onProc) onProc(child)
        const out = [],
            err = []
        let timedOut = false
        const lim = setTimeout(() => {
            timedOut = true
            try {
                killFn(child)
            } catch {
                /* уже закончился */
            }
        }, timeoutMs)
        child.stdout.on("data", (b) => out.push(Buffer.from(b)))
        child.stderr.on("data", (b) => err.push(Buffer.from(b)))
        child.on("error", (e) => {
            clearTimeout(lim)
            resolve({ ok: false, text: "", code: null, err: e.message })
        })
        child.on("close", (code) => {
            clearTimeout(lim)
            const raw = Buffer.concat(out).toString("utf8"),
                e =
                    Buffer.concat(err).toString("utf8") +
                    (timedOut ? "\nснят по времени: " + Math.round(timeoutMs / 60e3) + " мин" : "")
            const text = rt.onceText ? rt.onceText(raw) : raw // ok — по ответу, а не по служебному выводу (у Codex stdout — JSONL)
            resolve({ ok: code === 0 && !timedOut && !!text.trim(), text, code, err: e.trim() })
        })
        child.stdin.on("error", () => {})
        child.stdin.end(c.input || "")
    })
}
