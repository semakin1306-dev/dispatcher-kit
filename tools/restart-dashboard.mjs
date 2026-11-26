// restart-dashboard.mjs — безопасный перезапуск сервера диспетчерской: подготовка к перезапуску (новые прогоны не
// начинаются), ожидание тишины, остановка и запуск заново с проверкой готовности.
//
//   node tools/restart-dashboard.mjs                — дождаться тишины (до 90 мин) и перезапустить
//   node tools/restart-dashboard.mjs --wait-min=30  — свой предел ожидания; не дождались — подготовка снимается, код 2
//   node tools/restart-dashboard.mjs --force        — оборвать идущее и перезапустить сразу (только когда сервер завис)
//   node tools/restart-dashboard.mjs --skip-checks  — без проверок перед перезапуском (только если сломана сама проверка)
//   node tools/restart-dashboard.mjs --reason="…"   — причина: попадёт в событие server.start нового сервера
//
// Перед перезапуском — тесты (node --test) и сухая проверка журналов: сломанный код не должен подняться вместо живого
// сервера (код 3, сервер не трогается). Неответ /api/drain несколько раз подряд — не «тихо»: код 2, идущее не обрывается.
// Окружение то же, что у сервера: DISPATCHER_PROJECT, DASH_PORT, DASH_DATA.
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DRAIN_PAUSE_MS, drainRetry, pageToken } from "../scripts/dev/dashboard/restart-rules.mjs"
import { DATA, PORT } from "../scripts/dev/dashboard/config.mjs"
import { portOpen, portPid } from "./port-pid.mjs"
import { killPosixTree } from "../scripts/dev/dashboard/proc-tree.mjs"
import { homeEntryOf, homeExists, homeFile, loadHome, projectFile } from "../scripts/dev/project.mjs"

// Процесс проекта дома ведёт хаб (scripts/dev/hub/server.mjs): перезапуск отсюда столкнулся бы с ним на порту, а
// остановка по порту 4777 сняла бы сам хаб. Упавший процесс проекта хаб поднимает сам.
if (homeExists() && homeEntryOf(loadHome({ file: homeFile() }), projectFile())) {
  console.log("Проект ведёт хаб дома: перезапуск — остановите хаб (Ctrl+C в его окне) и запустите снова: node scripts/dev/hub/server.mjs")
  process.exit(3)
}

const DIR = process.env.DASH_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const B = "http://127.0.0.1:" + PORT, force = process.argv.includes("--force"), sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const reasonArg = (process.argv.find((a) => a.startsWith("--reason=")) || "").slice("--reason=".length).trim()
const waitMin = Number((process.argv.find((a) => a.startsWith("--wait-min=")) || "").split("=")[1]) || 90

/** pid сервера на порту диспетчерской: null — порт свободен, -1 — занят, владельца не узнать. */
const listener = () => portPid(PORT)
const portUp = () => portOpen(PORT)
const killPid = (pid) => {
  if (!(pid > 0)) return
  try { if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); else killPosixTree(pid) } catch { /* уже остановлен */ }
}

let T = null
const token = async () => T || (T = pageToken(await (await fetch(B + "/", { signal: AbortSignal.timeout(8000) })).text()))
const drain = async (on) => {
  const r = await (
    await fetch(B + "/api/drain", {
      method: "POST",
      headers: { "content-type": "application/json", "x-dash-token": await token() },
      body: JSON.stringify({ on, by: "restart-dashboard" }),
      signal: AbortSignal.timeout(8000),
    })
  ).json()
  if (r.error) throw new Error(r.error)
  return r
}
// Выход после сетевых запросов — через process.exitCode: немедленный process.exit на Windows бывает аварийным.
class Quit { constructor(code) { this.code = code } }
const drainPause = Number(process.env.DASH_DRAIN_PAUSE_MS) || DRAIN_PAUSE_MS
const drainOrQuit = async () => {
  const r = await drainRetry(() => drain(true), { pauseMs: drainPause })
  if (r.ok) return r.st
  try { await drain(false) } catch { /* сервер не отвечает */ }
  console.log(
    "Сервер не ответил на /api/drain " +
      r.errors.length +
      " раза подряд (" +
      r.errors[r.errors.length - 1] +
      "): перезапуск не делаю — идущее не оборвётся. Повторите позже или --force, если сервер завис.",
  )
  throw new Quit(2)
}

function checks() {
  let bad = ""
  try {
    if (execFileSync("git", ["-C", DIR, "diff", "--name-only", "--diff-filter=U"], { encoding: "utf8" }).trim())
      bad = "в рабочей копии незавершённое слияние (git diff --diff-filter=U)"
  } catch {
    /* не git — проверка слияния не нужна */
  }
  if (!bad) {
    let m = ""
    try {
      m = execFileSync(
        "git",
        ["-C", DIR, "grep", "-l", "-E", "^(<<<<<<<|>>>>>>>) ", "--", "scripts", "tools", "setup"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim()
    } catch {
      /* маркеров нет */
    }
    if (m) bad = "маркеры конфликта в файлах: " + m.split("\n").join(", ")
  }
  if (!bad) {
    try {
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import(${JSON.stringify("file:///" + DIR.replace(/\\/g, "/") + "/scripts/dev/dashboard/http.mjs")}).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1) })`,
        ],
        {
          cwd: DIR,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: { ...process.env, DASH_IMPORT_CHECK: "1", DASH_DRY: "1" },
        },
      )
    } catch (e) {
      bad =
        "модули сервера не грузятся: " +
        String(e.stderr || e.message)
          .trim()
          .split("\n")
          .slice(0, 3)
          .join(" | ")
    }
  }
  if (bad) { console.log("Перезапуск отменён: " + bad + ". Живой сервер не тронут."); process.exit(3) }
  console.log("проверка перед перезапуском: слияния и модули сервера — ок")
  const checkEnv = { ...process.env }
  for (const k of ["DASH_DATA", "DASH_DRY", "DASH_PORT", "DASH_EPIC_FILE", "DISPATCHER_PROJECT", "DISPATCHER_MAIN", "DISPATCHER_WT"]) delete checkEnv[k]
  const dataArg = ["--data=" + DATA]
  for (const [name, args, env] of [
    ["тесты диспетчерской", ["--test"], checkEnv],
    [
      "сухая проверка журналов loops.check.mjs",
      ["scripts/dev/dashboard/loops.check.mjs", "--quiet", ...dataArg],
      process.env,
    ],
  ]) {
    let res
    try {
      res = execFileSync(process.execPath, args, {
        cwd: DIR,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env,
      })
    } catch (e) {
      process.stdout.write(String(e.stdout || "").slice(-4000) + String(e.stderr || "").slice(-2000))
      console.log(
        "Перезапуск отменён: " +
          name +
          " — не прошла (код " +
          (e.status ?? "?") +
          "). Почините код и повторите; --skip-checks — только если сломана сама проверка.",
      )
      process.exit(3)
    }
    console.log(
      "проверка перед перезапуском: " + name + " — ок" + (/loops\.check/.test(name) ? "\n  " + res.trim() : ""),
    )
  }
}

async function main() {
  const pid = await listener()
  if (pid) {
    if (!force) {
      let st = await drainOrQuit()
      if (!st.idle) {
        console.log("Подготовка к перезапуску: новые прогоны и автоходы ждут, жду конца идущего (до " + waitMin + " мин).")
        const until = Date.now() + waitMin * 60000
        let last = ""
        while (!st.idle) {
          const now =
            "прогонов " +
            st.busyJobs.length +
            " (" +
            st.busyJobs.map((j) => j.id + " " + j.task).join(", ") +
            "), агентов " +
            st.busyAgents.length +
            (st.busyAgents.length ? " (" + st.busyAgents.map((a) => a.key).join(", ") + ")" : "") +
            ", в очереди " +
            st.queued
          if (now !== last) { console.log("  " + new Date().toTimeString().slice(0, 8) + " идёт: " + now); last = now }
          if (Date.now() > until) {
            try { await drain(false) } catch { /* сервер не отвечает */ }
            console.log("Не дождался тишины за " + waitMin + " мин: подготовка снята, сервер работает дальше. Повторите позже или --force.")
            throw new Quit(2)
          }
          await sleep(10000)
          st = await drainOrQuit()
        }
      }
      console.log("Тихо: перезапускаю (очередь переживёт перезапуск).")
    } else console.log("--force: идущие прогоны и ответы агентов оборвутся.")
    if (pid < 0) { console.log("порт " + PORT + " занят, но чей процесс его держит, узнать не удалось — остановите сервер сами."); throw new Quit(1) }
    killPid(pid)
    for (let i = 0; i < 360 && (await portUp()); i++) { await sleep(500); if (i === 40 || i === 200) killPid(pid) }
    if (await portUp()) { console.log("не удалось остановить старый сервер"); throw new Quit(1) }
    await sleep(1500)
  }
  const reason = reasonArg || (force ? "--force (restart-dashboard)" : pid ? "перезапуск со сливом (restart-dashboard)" : "запуск restart-dashboard: сервер не работал")
  fs.mkdirSync(DATA, { recursive: true })
  const out = fs.openSync(path.join(DATA, "server.log"), "a"), err = fs.openSync(path.join(DATA, "server.err.log"), "a")
  spawn(process.execPath, ["scripts/dev/dashboard/server.mjs"], {
    cwd: DIR,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, err],
    env: { ...process.env, DASH_PORT: String(PORT), DASH_START_REASON: reason.slice(0, 300) },
  }).unref()
  for (let i = 0; i < 40; i++) {
    await sleep(1000)
    let up = false
    try { up = (await fetch(B + "/api/state", { signal: AbortSignal.timeout(4000) })).ok } catch { /* ещё поднимается */ }
    if (up) { console.log("сервер поднят, pid", await listener()); return }
  }
  console.log("сервер не поднялся за 40 с: см. " + path.join(DATA, "server.err.log"))
  throw new Quit(1)
}

if (!process.argv.includes("--skip-checks")) checks()
else console.log("--skip-checks: проверки перед перезапуском пропущены.")
try { await main() } catch (e) { if (e instanceof Quit) process.exitCode = e.code; else throw e }
