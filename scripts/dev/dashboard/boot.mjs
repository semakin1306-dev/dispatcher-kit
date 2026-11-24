// boot.mjs — порядок запуска сервера: файлы состояния, пульс, таймеры ядра, включённые модули, HTTP-сервер.
//
// Вызовы нижних модулей вверх (late.mjs) подключает wiring.mjs — он импортируется первым, до кода этого файла.
// Модули из каталога (modules-catalog.mjs) регистрируют здесь свой запуск через onModuleBoot; стартуют только включённые
// (modules.mjs startModules). Выключенный модуль загружен, но ничего не делает, его маршруты отвечают 404.
import "./wiring.mjs"
import { EPIC_FILE, fwd } from "../slots.mjs"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { flushSync, readJson, saveJson, setCorruptHook, sweepTmp, writeJsonSync } from "./store.mjs"
import { S } from "./state.mjs"
import { jobList, keepLastJobs, loadJobs } from "./jobs.mjs"
import { infraFailure } from "./host-health.mjs"
import * as acceptMod from "./accept.mjs"
import { loadTg, startTg, tgAnswered } from "./tg.mjs"
import { mergeKey } from "./tg-rules.mjs"
import { AGENT_IDLE_MIN, IDLE_NUDGE_EVERY_MIN, IDLE_NUDGE_MIN, IDLE_NUDGE_TEXT, agentPublic, agentSession, agents, deliver, ensureAgent, loadOrchHeld, loadSessions, push, resumeInterrupted } from "./agents.mjs"
import { kickStalled } from "./autochain.mjs"
import { DATA, DRY, EVENTS_JSONL, FINAL, HERE, HOST, KEEP_JOBS, LOGS, PORT, SETTINGS_FILE, TOKEN, logEvent, rotateLogs, setEventEpicOf, settings } from "./config.mjs"
import { autoSyncSlots, drainState, loadSyncMarks, orchFollow, provisionMissing } from "./epics.mjs"
import { loadBuildStamps } from "./fingerprint.mjs"
import { gitLoad } from "./git.mjs"
import { addCard, ibId, inboxCards, loadInbox, saveInbox } from "./inbox.mjs"
import { api, okHost, pipelineStart, send } from "./http.mjs"
import { onOwnerAnswer, ownerAnswer } from "./annot.mjs"
import { readyStg, stagesView } from "./view.mjs"
import { MACHINE_SAMPLE_MS, memState, sampleMachine, sampleStack, startCpuSampler } from "./monitor.mjs"
import { resetVer, startHeartbeat } from "./events.mjs"
import { activity, startLoopWatch } from "./loopwatch.mjs"
import { loadOrderDismissed, loadTrain } from "./pipeline.mjs"
import { SAFE_HOOKS, STAGING_BASELINE_RUNS, foreignRedBaseline, loadSpecHist, loadStgRed, recordSpecs, specHistMap } from "./regress.mjs"
import { RELAY_FACTS_FILE, drainQueued, lastRelay, loadRelaySent, loadTestReqs, mergeExtraPresets, mergeWaitTick, nudgeIdleSlots, orchAfterBoot, relayAfterPrep, slotPromptText, startOffered } from "./relay.mjs"
import { orchNudgeDue } from "./loops.mjs"
import { autoSyncConflicts } from "./auto-merge.mjs"
import { loadMergeWait } from "./merge-wait.mjs"
import { loadOrchLog } from "./orchlog.mjs"
import { loadReviewNotes } from "./review.mjs"
import { loadTrains } from "./trains.mjs"
import { loadSlotDone } from "./slot-done.mjs"
import { RETRO_AUTO_MS, loadRetro, retroAuto } from "./retro.mjs"
import { KEEP_DEFAULT, hygieneRefresh } from "./worktree-hygiene.mjs"
import { flushRuns, killTree, loadRuns, procs, pumpAll, requeueInterrupted, runsSeen, save } from "./runner.mjs"
import { kick, rebuildFresh, snapNow, startSnapshotLoop } from "./snapshot.mjs"
import { loadStationMarks, loadSummaries, planExists } from "./stations.mjs"
import { TREES, applyEpics, epicOfKey, epicSlots, openEpics, orchKey, viewEpic } from "./trees.mjs"
import { UI_SHARED } from "./ui-shared.mjs"
import { PULSE_MS, bootSeen, markBootInterrupted, startReason } from "./restart-rules.mjs"
import { hangsSince } from "./deadline.mjs"
import { classifyPrevStop, exitRecord, pcGap } from "./lifecycle-rules.mjs"
import { setSshGateHook } from "./spawner.mjs"
import { epicRulesCheck } from "./epic-rules.mjs"
import { shardApi } from "./shard.mjs"
import { initMachines } from "./machines.mjs"
import { enabled, onModuleBoot, startModules } from "./modules.mjs"

// ── папка данных и файлы состояния ──
fs.mkdirSync(LOGS, { recursive: true })
setEventEpicOf(epicOfKey)
// Битый файл состояния не превращается молча в {}: он откладывается рядом, событие state.corrupt, плашка на странице.
setCorruptHook((r) => logEvent("state.corrupt", { file: r.file, movedTo: r.movedTo, error: r.error, bytes: r.bytes, held: !!r.held }))
sweepTmp(DATA)

// ── пульс и причина остановки ──
// При запуске — событие server.start (версия, причина, когда замолчал прошлый экземпляр); раз в минуту — pulse.json для
// внешнего сторожа и событие server.pulse с задержкой цикла событий и очередью git. При выходе причина пишется синхронно.
const PULSE_FILE = path.join(DATA, "pulse.json"), BOOT_STARTED = Date.now()
const pulseWrite = !DRY || !!process.env.DASH_DATA
const CODE_SHA = (() => { try { return String(spawnSync("git", ["-C", HERE, "rev-parse", "--short", "HEAD"], { encoding: "utf8", windowsHide: true, timeout: 5000 }).stdout || "").trim() } catch { return "" } })()
const EXIT_FILE = path.join(DATA, "last-exit.json")
{
  const prev = readJson(PULSE_FILE, null), prevExit = readJson(EXIT_FILE, null)
  const stop = classifyPrevStop({ prev, prevExit, bootAt: BOOT_STARTED, envReason: String(process.env.DASH_START_REASON || "").trim() })
  logEvent("server.start", { pid: process.pid, port: PORT, sha: CODE_SHA, reason: startReason(process.env), dry: DRY, stop, prev: prev && prev.at ? { pid: prev.pid, at: prev.at, sha: prev.sha, silentS: Math.round((BOOT_STARTED - prev.at) / 1000) } : null, ...(prevExit && prevExit.pid === (prev && prev.pid) ? { prevExit } : {}) })
  console.log("запуск: версия " + (CODE_SHA || "?") + ", причина: " + startReason(process.env) + (prev && prev.at ? "; прошлый пульс " + new Date(prev.at).toLocaleTimeString("ru-RU") + " (pid " + prev.pid + ")" : "") + "; прошлый экземпляр: " + stop.why)
}
let exitNoted = false
const noteExit = (extra) => {
  if (DRY || exitNoted) return
  exitNoted = true
  const rec = exitRecord({ pid: process.pid, now: Date.now(), ...extra })
  try { writeJsonSync(EXIT_FILE, rec) } catch { /* диск недоступен */ }
  try { fs.appendFileSync(EVENTS_JSONL, JSON.stringify({ at: rec.at, type: "server.exit", pid: process.pid, code: rec.code, signal: rec.signal, ...(rec.error ? { error: rec.error, origin: rec.origin } : {}) }) + "\n") } catch { /* как выше */ }
}
process.on("exit", (code) => noteExit({ code }))
process.on("uncaughtExceptionMonitor", (err, origin) => noteExit({ err, origin, code: 1 }))
for (const sig of ["SIGBREAK", "SIGHUP", "SIGTERM"]) { try { process.on(sig, () => { noteExit({ signal: sig, code: 0 }); process.exit(0) }) } catch { /* сигнала нет на этой ОС */ } }
setSshGateHook((x) => { const now = Date.now(); if (now - (setSshGateHook.last || 0) < 30000) return; setSshGateHook.last = now; logEvent("ssh.gate", x) })
const pulseRec = (lagMs) => ({ at: Date.now(), pid: process.pid, port: PORT, sha: CODE_SHA, startedAt: BOOT_STARTED, lagMs })
if (pulseWrite) writeJsonSync(PULSE_FILE, pulseRec(0))
{
  let due = Date.now() + PULSE_MS, last = Date.now()
  setInterval(() => {
    const now = Date.now(), lagMs = Math.max(0, now - due); due = now + PULSE_MS
    { const g = pcGap(lagMs); if (g) logEvent("pc.gap", g) }
    if (pulseWrite) saveJson(PULSE_FILE, pulseRec(lagMs))
    const sn = snapNow(), hangs = hangsSince(last); last = now
    logEvent("server.pulse", { lagMs, git: gitLoad(), snapAgeS: sn ? Math.round((now - sn.at) / 1000) : null, jobs: jobList().filter((j) => j.status === "running").length, busy: [...agents.values()].filter((a) => !a.dead && a.busy).length, drain: !!drainState(), ...(hangs.length ? { hangs: hangs.map((h) => h.what) } : {}) })
  }, PULSE_MS).unref()
}

// ── эпики, станции, отпечатки ──
applyEpics()
loadStationMarks()
loadBuildStamps()
try { fs.mkdirSync(SAFE_HOOKS, { recursive: true }) } catch { /* есть */ }
if (process.env.DASH_EXIT_AFTER) setTimeout(() => process.exit(0), Number(process.env.DASH_EXIT_AFTER) * 1000) // замеры: выйти через N секунд

// ── прогоны ──
// Что застал перезапуск — событием restart.interrupted. Прогон, упавший из-за связи с удалённой машиной, — не красный:
// он переводится в «не дошёл до запуска» и уходит в очередь заново, когда машина на связи.
{
  const { runs, cut } = markBootInterrupted(loadRuns()); loadJobs(runs)
  if (cut.length) logEvent("restart.interrupted", { n: cut.length, jobs: cut.slice(0, 40) })
}
const bootLoaded = new Map(jobList().map((j) => [j.id, JSON.stringify(j)]))
{
  let n = 0
  for (const j of jobList()) {
    if ((j.baseline || (j.tree === "orchestrator-staging" && j.by === "сверка со staging")) && ["queued", "waiting"].includes(j.status) && !STAGING_BASELINE_RUNS) { j.status = "cancelled"; j.cancelled = true; j.endedAt = Date.now(); j.summary = "снята: сверочные прогоны на staging выключены"; n++; continue }
    if (j.status !== "fail" || j.infra || !j.runOn || j.runOn === "local") continue
    const sm = String(j.summary || ""); if (sm.length > 300 || !sm.startsWith("✗")) continue
    const f = infraFailure(sm, { runOn: j.runOn }); if (!f) continue
    j.status = "interrupted"; j.infra = f.kind; j.infraWhy = f.label; j.requeued = true; j.summary = "машина недоступна: " + f.label + " — не поломка кода"; n++
  }
  if (n) { logEvent("jobs.infra-migrated", { n }); console.log("прогоны, упавшие из-за связи с машиной, сняты с красного:", n) }
}
for (const [id, line] of bootSeen(jobList(), bootLoaded)) runsSeen.set(id, line)
if (jobList().some((j) => !runsSeen.has(j.id))) save()
if (jobList().length > KEEP_JOBS) keepLastJobs(KEEP_JOBS)
if (!DRY) { setTimeout(rotateLogs, 60000).unref(); setInterval(rotateLogs, 24 * 3600e3).unref() }
// лишние папки слотов — считаем (страница предлагает убрать); сама уборка — только кнопкой
if (!DRY) { const hy = () => hygieneRefresh(openEpics(), { keep: Array.isArray(settings.keepWorktrees) ? settings.keepWorktrees : KEEP_DEFAULT }).catch((e) => console.error("папки слотов:", e.message)); setTimeout(hy, 180000).unref(); setInterval(hy, 6 * 3600e3).unref() }

// ── агенты ──
// остановить процесс агента: у рантайма без постоянного процесса он есть только во время хода — снимает адаптер
const killAgent = (a) => { try { if (a.rt && a.rt.kill) a.rt.kill(); else killTree(a.proc) } catch { /* уже остановлен */ } }
loadSessions()
// простой агентов: остановить давно молчащего (сессия сохраняется) и самого давнего при нехватке памяти
setInterval(() => {
  const now = Date.now(), live = [...agents.values()].filter((a) => !a.dead)
  const idleOf = (a) => now - (a.lastReal || a.lastActive || now)
  const stopIdle = (a, why) => { push(a, { id: "idle-" + a.rev, t: "status", text: why }); a.stopping = true; killAgent(a) }
  for (const a of live) if (!a.busy && a.pending.size === 0 && idleOf(a) > AGENT_IDLE_MIN * 60000) stopIdle(a, "Остановлен по простою (" + Math.round(AGENT_IDLE_MIN / 60) + " ч), чтобы вернуть память. Сессия сохранена — следующее сообщение продолжит её.")
  const m = memState().v
  if (m && m.freeCommitGB < 3) {
    const cand = live.filter((a) => !a.dead && !a.busy && a.pending.size === 0 && idleOf(a) > 30 * 60000).sort((x, y) => idleOf(y) - idleOf(x))[0]
    if (cand) stopIdle(cand, "Остановлен: мало памяти (свободно " + m.freeCommitGB.toFixed(1) + " ГБ). Сессия сохранена.")
  }
}, 60000).unref()
const epicAgentKeys = () => { const e = viewEpic(); return e ? TREES.filter((t) => t.epic === e.id && (t.kind === "orch" || t.kind === "slot") && !t.archived).map((t) => t.key) : [] }
// после перезапуска агенты, которых он застал посреди хода, продолжают сами — оркестратор первым
if (!DRY) setTimeout(() => { if (settings.autoResume === false || drainState()) return; resumeInterrupted(epicAgentKeys()).then((ks) => { if (ks.length) console.log("возобновлены после перезапуска:", ks.join(", ")) }).catch((e) => console.error("возобновление:", e.message)) }, 45000).unref()
const BOOT_AT = Date.now()
let idleNudgeAt = 0
// сторож простоя: никто в эпике не работает, очередей нет, не все слоты ждут человека — одно сообщение оркестратору
setInterval(() => {
  try {
    if (DRY || settings.idleWatch === false || drainState()) return
    const keys = epicAgentKeys(), orch = keys.find((k) => TREES.find((t) => t.key === k && t.kind === "orch")); if (!orch || !agentSession(orch)) return
    const as = keys.map((k) => agents.get(k)).filter(Boolean), slots = keys.filter((k) => k !== orch)
    const cards = inboxCards(), now = Date.now()
    let requeued = 0
    for (const x of cards) if (x.kind === "relay" && x.to === orch && !x.queued && !x.sending && now - (x.at || now) > 10 * 60e3) { x.queued = now; x.note = "не ушла сама — сторож простоя поставил в очередь к оркестратору"; requeued++ }
    if (requeued) { saveInbox(); logEvent("idle.requeue", { key: orch, n: requeued }); return }
    const ep = viewEpic(), oa = agents.get(orch), slotAg = slots.map((k) => agents.get(k)).filter(Boolean)
    const ejobs = jobList().filter((j) => keys.includes(j.tree) || (ep && j.epic === ep.id))
    const due = orchNudgeDue({ now, busy: as.some((a) => !a.dead && a.busy), queued: cards.some((x) => x.kind === "relay" && x.queued && keys.includes(x.tree)),
      liveJobs: ejobs.filter((j) => ["queued", "waiting", "running"].includes(j.status)).length,
      lastWork: Math.max(BOOT_AT, ...slotAg.map((a) => a.realEndAt || 0), ...ejobs.map((j) => j.endedAt || 0)), orchSawAt: (oa && oa.realEndAt) || 0, lastNudge: idleNudgeAt,
      slotsWithSession: slots.filter((k) => agentSession(k)).length, slotsWaitingOwner: new Set(cards.filter((x) => x.kind === "ownerq" && slots.includes(x.tree)).map((x) => x.tree)).size,
      idleMs: IDLE_NUDGE_MIN * 60e3, everyMs: IDLE_NUDGE_EVERY_MIN * 60e3 })
    if (!due.due) return
    idleNudgeAt = now
    ensureAgent(orch).then((a) => { if (!a.busy) { deliver(a, IDLE_NUDGE_TEXT, "nudge"); logEvent("idle.nudge", { key: orch, why: due.why }) } }).catch((e) => console.error("сторож простоя:", e.message))
  } catch (e) { console.error("сторож простоя:", e.message) }
}, 60000).unref()

// ── передачи, карточки, настройки ──
loadInbox()
loadOrchHeld()
loadMergeWait()
if (!DRY) setTimeout(() => setInterval(() => { if (!drainState()) mergeWaitTick().catch((e) => console.error("ожидание влива:", e.message)) }, 60000).unref(), 90000).unref()
for (const x of inboxCards()) { const ep = x.epic || (viewEpic() && viewEpic().id); if (x.to === "orchestrator" && ep) x.to = orchKey(ep); if (x.tree === "orchestrator" && ep) x.tree = orchKey(ep) }
Object.assign(settings, readJson(SETTINGS_FILE, {}))
for (const [k, v] of Object.entries(readJson(RELAY_FACTS_FILE, {}) || {})) lastRelay.set(k, v)
loadRelaySent()
loadOrchLog()
// прерванные перезапуском команды оркестратора — отказом; законченный, но не разобранный ход — исполнить
if (!DRY) setTimeout(() => orchAfterBoot().catch((e) => console.error("команды оркестратора после старта:", e.message)), 30000).unref()

// ── регресс ──
loadStgRed()
if (!DRY) setTimeout(() => { const since = Date.now() - 12 * 3600e3; for (const j of jobList()) if (j.status === "fail" && (j.endedAt || 0) > since) { try { foreignRedBaseline(j) } catch { /* следующий */ } } }, 120000).unref()
loadSpecHist()
// первый запуск: история спек из уже сохранённых логов, иначе карантин стартовал бы пустым
setTimeout(() => { if (Object.keys(specHistMap()).length) return; let n = 0; for (const j of jobList()) { try { recordSpecs(j); n++ } catch { /* лог мог не сохраниться */ } } if (n) console.log("история спек: из логов", n, "прогонов, спек", Object.keys(specHistMap()).length) }, 5000).unref()

// ── конвейер, ревью, поезда, ретро ──
loadOrderDismissed()
loadReviewNotes()
loadTrains()
loadSyncMarks()
loadSlotDone()
loadRetro()
loadSummaries()
loadTrain()
// приёмка: данные чек-листов читают станции ядра, поэтому они загружаются всегда; прогоны и напоминания — модуль accept
if (typeof acceptMod.loadAcceptance === "function") acceptMod.loadAcceptance()
if (typeof acceptMod.loadReminders === "function") acceptMod.loadReminders()

// ── карточка «запустить агента слота», передачи после подготовки ──
setInterval(() => {
  try {
    if (!openEpics().length || !snapNow()) return
    for (const x of epicSlots()) {
      const t = snapNow().trees.find((z) => z.key === x.slot), ap = agentPublic(x.slot)
      if (!t || !t.exists || t.unbuilt || ap.running || ap.hasLast || startOffered.has(x.slot)) continue
      if (jobList().some((j) => j.tree === x.slot && j.task === "slot-up" && !FINAL.includes(j.status))) continue
      if (!planExists(t) || !slotPromptText(x.slot)) continue
      if (inboxCards().some((z) => z.kind === "relay" && z.to === x.slot)) continue
      startOffered.add(x.slot)
      if (!inboxCards().some((z) => z.kind === "slotstart" && z.tree === x.slot)) { addCard({ id: ibId(), kind: "slotstart", epic: x.__epic, tree: x.slot, tag: x.tag, at: Date.now() }); saveInbox() }
    }
  } catch (e) { console.error("карточка запуска слота:", e.message) }
  try { relayAfterPrep() } catch (e) { console.error("передачи после подготовки:", e.message) }
  try { nudgeIdleSlots() } catch (e) { console.error("толчок по готовому слоту без агента:", e.message) }
}, 30000).unref()
// очередь передач к агенту: страховка на случай, если ход кончился без результата или сервер перезапускался
setInterval(() => { for (const to of new Set(inboxCards().filter((x) => x.kind === "relay" && x.queued).map((x) => x.to))) drainQueued(to) }, 20000).unref()

// ── автопоезд ──
setTimeout(() => rebuildFresh().then(() => kickStalled("после запуска диспетчерской")).catch(() => { }), 90000).unref()
{ const rules = () => { try { epicRulesCheck() } catch (e) { console.error("правила сессий эпика:", e.message) } }; setTimeout(rules, 120000).unref(); setInterval(rules, 3600e3).unref() }
setInterval(() => kickStalled("проверка простоя"), 180000).unref()
setTimeout(() => kickStalled("после запуска диспетчерской"), 45000).unref()
setInterval(pumpAll, 15000).unref()

// ── проверки, заказанные агентами ──
loadTestReqs()
mergeExtraPresets()

// ── подготовка слотов и слежение за реестром эпиков ──
setTimeout(() => provisionMissing().catch(() => { }), 15000).unref()
setInterval(() => provisionMissing().catch(() => { }), 60000).unref()
// время реестра, который прочитал запуск; -1 — файла не было: его появление — тоже перемена
S.epicMtime = (() => { try { return fs.statSync(EPIC_FILE).mtimeMs } catch { return -1 } })()
setInterval(() => {
  try {
    const m = fs.statSync(EPIC_FILE).mtimeMs
    if (m !== S.epicMtime) {
      applyEpics(); mergeExtraPresets(); kick(); setTimeout(() => provisionMissing().catch(() => { }), 1500)
      if (!DRY && enabled("retro")) setTimeout(() => retroAuto().catch((e) => console.error("ретро:", e.message)), 3000)
    }
    S.epicMtime = m
  } catch { S.epicMtime = -1 /* реестра пока нет */ }
}, 4000).unref()
setTimeout(() => orchFollow("запуск диспетчерской").catch(() => { }), 20000).unref()
setInterval(() => { autoSyncSlots().catch((e) => console.error("автоперемотка слотов:", e.message)).then(() => autoSyncConflicts()).catch((e) => console.error("автоподтягивание при конфликте:", e.message)) }, 30000).unref()

// ── модули ──
onModuleBoot("machines", () => {
  initMachines()
  // уборка папок прогонов слотов, которых больше нет, на удалённых машинах
  if (!DRY) { const prune = async () => { const live = epicSlots().filter((x) => !x.archived).map((x) => x.slot).concat(["orchestrator-staging"]); await shardApi().slotPrune(live).then((r) => console.log("уборка папок прогонов на машинах:", r)).catch((e) => console.error("уборка папок прогонов:", e.message)) }; setTimeout(prune, 300000).unref(); setInterval(prune, 6 * 3600e3).unref() }
})
onModuleBoot("retro", () => {
  if (!DRY) { const rt = () => retroAuto().catch((e) => console.error("ретро:", e.message)); setTimeout(rt, 240000).unref(); setInterval(rt, RETRO_AUTO_MS).unref() }
})
onModuleBoot("accept", () => { if (typeof acceptMod.startAccept === "function") acceptMod.startAccept({ DRY }) })
onModuleBoot("tg", () => {
  // вопросы агентов и ветки, готовые к вливу, — в Телеграм с кнопками; ответ идёт тем же путём, что со страницы
  loadTg()
  const label = (t) => [t.tag, t.wave ? String(t.wave).toUpperCase() : "", t.title || ""].filter(Boolean).join(" · ")
  startTg({
    cards: () => inboxCards(),
    who: (k) => { const t = TREES.find((x) => x.key === k) || {}; let ep = null; try { ep = epicOfKey(k) } catch { /* реестр ещё не прочитан */ } return (t.kind === "orch" ? "Оркестратор" : label({ ...t, tag: t.tag || k })) + (ep ? " · эпик " + ep : "") },
    readyMerges: () => ((snapNow() && snapNow().trees) || []).filter((t) => t.kind === "slot" && !t.archived).filter((t) => { try { return readyStg(t, stagesView(t, agentPublic(t.key))) } catch { return false } })
      .map((t) => ({ mkey: mergeKey(t), slot: t.key, who: label(t) + (t.epic ? " · эпик " + t.epic : "") })),
    ownerAnswer: (tree, text, id) => ownerAnswer(tree, text, id, { via: "tg" }),
    merge: (slot) => pipelineStart({ action: "merge", slot }, { via: "tg" }),
  })
  onOwnerAnswer(tgAnswered)
})
// машины ставят свою реализацию до первого возврата прерванных прогонов в очередь
{ const r = startModules({ DRY }); if (r.started.length) console.log("модули:", r.started.join(", ")) }
if (!DRY) setTimeout(() => requeueInterrupted().catch(() => { }), 7000).unref()
if (!DRY) setInterval(() => requeueInterrupted().catch(() => { }), 30000).unref()

// ── монитор машины ──
startCpuSampler()
sampleMachine(); setInterval(sampleMachine, MACHINE_SAMPLE_MS).unref()
sampleStack(); setInterval(sampleStack, 15000).unref()

// ── снимок (git по всем папкам и станции) ──
resetVer()
startSnapshotLoop(); startHeartbeat(); startLoopWatch()

// ── HTTP ──
const uiStamp = () => { try { return Math.round(Math.max(...[...["index.html", ...fs.readdirSync(path.join(HERE, "ui")).map((f) => "ui/" + f)].map((f) => path.join(HERE, f)), ...Object.values(UI_SHARED)].map((f) => fs.statSync(f).mtimeMs))) } catch { return 0 } }
const UI_TYPES = { css: "text/css; charset=utf-8", svg: "image/svg+xml", png: "image/png" }
S.server = http.createServer(async (req, res) => {
  try {
    activity("http " + req.method + " " + String(req.url || "").split("?")[0])
    if (!okHost(req)) return send(res, 403, { error: "неверный Host" }, "text/plain; charset=utf-8")
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = fs.readFileSync(path.join(HERE, "index.html"), "utf8").replace("__TOKEN__", TOKEN).split("__UIVER__").join(String(uiStamp()))
      return send(res, 200, html, "text/html; charset=utf-8")
    }
    // файлы страницы: /ui/v<отметка>/x.js — вложенные импорты наследуют путь с отметкой, кеш на час
    const uiM = /^\/ui\/(v\d+\/)?[\w.-]+\.(js|css|svg|png)$/.exec(url.pathname)
    if (uiM) {
      const f = UI_SHARED[path.basename(url.pathname)] || path.join(HERE, "ui", path.basename(url.pathname))
      if (!fs.existsSync(f)) return send(res, 404, "нет такого файла", "text/plain; charset=utf-8")
      res.writeHead(200, { "content-type": UI_TYPES[path.extname(f).slice(1)] || "text/javascript; charset=utf-8", "cache-control": url.searchParams.get("v") || uiM[1] ? "max-age=3600" : "no-store" })
      return fs.createReadStream(f).pipe(res)
    }
    if (url.pathname.startsWith("/api/")) return await api(req, res, url)
    send(res, 404, "нет такой страницы", "text/plain; charset=utf-8")
  } catch (e) { send(res, 500, { error: String(e && e.message || e) }) }
})
S.server.listen(PORT, HOST, () => console.log(`Диспетчерская: http://${HOST}:${PORT}  (данные: ${fwd(DATA)})`))
S.server.on("error", (e) => { console.error(e.code === "EADDRINUSE" ? `Порт ${PORT} занят — диспетчерская уже запущена? http://${HOST}:${PORT}` : e.message); process.exit(1) })
process.on("SIGINT", () => { for (const c of procs.values()) killTree(c); for (const a of agents.values()) if (!a.dead) killAgent(a); flushRuns(true); flushSync(); process.exit(0) })
