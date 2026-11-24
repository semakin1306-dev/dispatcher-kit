// dash-sentry.mjs — внешний сторож сервера диспетчерской. Сервер раз в минуту пишет пульс (<папка данных>/pulse.json:
// pid, время, версия). Сторож запускается планировщиком ОС раз в минуту и смотрит пульс: порт держит тот же процесс,
// а пульса нет 3 мин — перезапуск `restart-dashboard.mjs --force` с причиной. Сервер не запущен — не трогает: его
// остановили намеренно. После перезапуска — 10 мин без повторов. Правило — restart-rules.mjs sentryVerdict.
//
//   node tools/dash-sentry.mjs            — один обход (так его зовёт планировщик)
//   node tools/dash-sentry.mjs --dry-run  — только показать решение, ничего не делать
//
// Регистрация в планировщике — делает человек, один раз: cron (`* * * * * node <путь>/tools/dash-sentry.mjs`),
// launchd или «Планировщик заданий» Windows. Окружение — как у сервера: DISPATCHER_PROJECT, DASH_PORT, DASH_DATA.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { sentryVerdict } from "../scripts/dev/dashboard/restart-rules.mjs"
import { portPid } from "./port-pid.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.DASH_PORT || 4777)
// папка данных: DASH_DATA, иначе — из конфига проекта (как у сервера)
const DATA = process.env.DASH_DATA || (await import("../scripts/dev/dashboard/config.mjs")).DATA
const dry = process.argv.includes("--dry-run")
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) } catch { return null } }
const STATE = path.join(DATA, "sentry.json"), LOG = path.join(DATA, "sentry.log")
const log = (s) => { try { fs.appendFileSync(LOG, new Date().toISOString() + " " + s + "\n") } catch { /* папки данных нет */ } }

const now = Date.now(), st = readJson(STATE) || {}
const pid = await portPid(PORT)
const v = sentryVerdict({ now, listenerPid: pid && pid > 0 ? pid : null, pulse: readJson(path.join(DATA, "pulse.json")), lastRestartAt: st.lastRestartAt || 0 })
if (dry) { console.log(JSON.stringify(v)); process.exit(0) }
if (v.act !== "restart") {
  if (st.lastAct && st.lastAct !== v.act) log("ок: " + v.why) // строка — только при смене состояния, не каждую минуту
  if (st.lastAct !== v.act) { try { fs.writeFileSync(STATE, JSON.stringify({ ...st, lastAct: v.act })) } catch { /* нет папки */ } }
  process.exit(0)
}
fs.writeFileSync(STATE, JSON.stringify({ ...st, lastAct: v.act, lastRestartAt: now, lastWhy: v.why }))
log("ПЕРЕЗАПУСК: " + v.why)
try { fs.appendFileSync(path.join(DATA, "events.jsonl"), JSON.stringify({ at: now, type: "sentry.restart", why: v.why }) + "\n") } catch { /* журнал не обязателен */ }
let code = 0, out = ""
try { out = execFileSync(process.execPath, [path.join(HERE, "restart-dashboard.mjs"), "--force", "--reason=" + v.why], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 15 * 60000 }) } catch (e) { code = e.status ?? 1; out = String(e.stdout || "") + String(e.stderr || "") }
log("restart-dashboard: код " + code + " — " + out.trim().split(/\r?\n/).slice(-3).join(" | "))
process.exitCode = code
