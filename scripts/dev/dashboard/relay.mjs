// relay.mjs — текстовый протокол между агентами и человеком: передачи слот ↔ оркестратор, карточки «Ждут вашего
// действия», автоотчёты о прогонах, просьбы агентов о проверках, решения «ДАЛЬШЕ: …» и команды оркестратора (ПРОГНАТЬ,
// ВЛИТЬ, КОММИТ, СБРОСИТЬ, ПОРЯДОК, ПРИНЯТЬ РЕВЬЮ). Команды, которые меняют ветки, исполняются только при слове
// владельца; пуш, выкат и «принудительно» оставлены человеку.
//
// Кто зовёт: agents.mjs после каждого хода агента (inboxAfterTurn, поздней привязкой), runner.mjs по итогу прогона
// (queueResult, buildReport), boot.mjs на старте и по таймерам (orchAfterBoot, mergeWaitTick, nudgeIdleSlots, relayAfterPrep,
// загрузка файлов), http.mjs — кнопки страницы (doRelay, inboxSend, sendBatch, agentCommit, inboxPublic, testReqsPublic).
//
// Состояние: поля S.relaySent (хеши уже переданных блоков), S.testReqs (просьбы о прогонах по слотам), S.presetsExtra
// (тесты волны, добавленные просьбами), S.relayFactsTimer. Файлы в DATA: relay-sent.json, relay-facts.json (что оркестратор
// уже видел о слоте — для справки разностью), test-requests.json, presets-extra.json, slot-nudges.json. Карточки — inbox.mjs,
// журнал команд оркестратора и слово владельца — orchlog.mjs, ожидание влива — merge-wait.mjs.
//
// Инварианты:
// - один и тот же блок одному адресату дважды не уходит: хеш (от кого, кому, нормализованный текст) — в S.relaySent,
//   одновременная вторая отправка того же блока отсекается relayFlight;
// - агенту, который сейчас отвечает (busy и не служебный пинг), сообщение не вливается в середину хода: передача встаёт
//   в очередь и уходит из drainQueued, когда ход закончен;
// - команда оркестратора записывается в журнал до исполнения (cmdBegin) и исполняется один раз на ход, итог — после;
//   прерванная перезапуском команда не повторяется молча, а возвращается оркестратору отказом;
// - справку о слоте («факты») пишет диспетчерская по git и прогонам, а не слот: оркестратор сверяет слова слота с ней.
import { EPIC_CLI, EPIC_FILE, PROJECT, fwd, loadEpics, saveEpics } from "../slots.mjs";
import {
    MERGE_LABEL,
    ORCH_GATHER_MS,
    SLOT_ASKS_RE,
    blockTargetTag,
    factsDelta,
    guardViolations,
    mergeArm,
    mergeWaitStep,
    parseRunList,
    redGroupNote,
    relayDecision,
    slotAsks,
    staleRed,
} from "./loops.mjs";
import { dropMergeWait, keepMergeWord, mergeWaitOf, mergeWaits, mergeWordOf, setMergeWait } from "./merge-wait.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import { readJson, saveJson, writeJsonSync } from "./store.mjs";
import path from "node:path";
import { S } from "./state.mjs";
import { drainState } from "./epics.mjs";
import { jobList } from "./jobs.mjs";
import { remAddFromText } from "./accept.mjs";
import {
    COMMIT_GRANT_MS,
    PROMPTS_DIR,
    agentCwd,
    agentPublic,
    agentSession,
    agents,
    deliver,
    ensureAgent,
    genSlotPrompt,
    lastAnswerOf,
    push,
    readSessionTail,
    recordRelay,
    rotateOrchIfDue,
    sendWhenFree,
    slotPreparing,
    turnEdits,
} from "./agents.mjs";
import { relayToSlot, rerunByChain, slotIdleNudge, slotIdleText, startHeldByStub } from "./slot-rules.mjs";
import { autoChain, autoTrainOffFor, nextHint, runTask } from "./autochain.mjs";
import { workChanges } from "./changes.mjs";
import { ANSI, DATA, DRY, FINAL, logEvent, logPath, readLog, settings, short } from "./config.mjs";
import { naAdvice } from "./na-rules.mjs";
import { PRESETS, TREES, epicOfKey, epicSlots, isOrch, orchKey, orchOfKey, trainWaveOf, treeByKey, viewEpic } from "./trees.mjs";
import { DIST_TASKS, codeFp, jobFresh } from "./fingerprint.mjs";
import { exists, git } from "./git.mjs";
import { addCard, ibId, inboxCards, keepCards, saveInbox } from "./inbox.mjs";
import { late } from "./late.mjs";
import { preflight, recipe, setOrder } from "./pipeline.mjs";
import { withDeadline } from "./deadline.mjs";
import { deadlockText, normWhy, streakClear, streakNote } from "./deadlock.mjs";
import { cmdBegin, cmdEnd, cmdKey, lastTurnSeen, orchLogSince, ownerWord, takeInterrupted, turnSeen } from "./orchlog.mjs";
import { wordGrants } from "./owner-word.mjs";
import { SUITE_FAM, curSnapOf, failingSpecs, inheritedRed, jobCovers, knownRed, onStagingRed, onlyStagingRed, realFail, redCarryOf, specHistMap, stgRedMap, stgRedText } from "./regress.mjs";
import { dropSnap, kick, rebuild, rebuildFresh, snapNow } from "./snapshot.mjs";
import { bumpVer } from "./events.mjs";
import { digestSession } from "./digest-ledger.mjs";
import { DECISION_HELP, FACTS_RULES_FULL, FACTS_RULES_SHORT, VERDICT_WORDS, reportMessage, resultsMessage, slotStateLine } from "./prompt.mjs";
import { STAGES_FILE, SUMMARY_FILE, afterSlotTurn, markReviewAccepted, planExists, planFileOf, planIsStubOf, setSummary } from "./stations.mjs";
import { TASKS, matchAny } from "./tasks.mjs";
import { enabled } from "./modules.mjs";
const reviewEnabled = () => enabled("review");
import { BLOCK_RE, DECISION_RE, FENCE, TESTS_HEAD_RE, hasDecision, isReportBlock, reportBlockOf, summaryOf, waitsHead } from "./protocol.mjs";
import { slotReset } from "./slot-reset.mjs";
import { BACKLOG_KEY } from "./backlog-agent.mjs";
import { backlogAfterTurn } from "./backlog.mjs";
import { isSyncAsk } from "./sync-rules.mjs";
import { prompt } from "../prompts.mjs";

// runner.mjs сам импортирует этот модуль (итоги прогонов → queueResult), поэтому очередь задач — поздней привязкой.
const { enqueue, publicJob, pumpAll, save } = late("runner.mjs", ["enqueue", "publicJob", "pumpAll", "save"]);

// Задачи станций — из конфига проекта: гарды (ворота влива) и тесты. `build`, `review`, `commit` — свои задачи диспетчерской.
export const GUARD_TASKS = new Set(PROJECT.stations.guards);
export const TEST_TASKS = new Set(PROJECT.stations.tests);
const guardIds = () => [...GUARD_TASKS].filter((id) => TASKS[id]);
// Строки, по которым в логе видна причина падения (jest/vitest, tsc, Node, npm). Ищем их, а не берём хвост: хвост лога
// обычно — сводка раннера без самой ошибки.
export const FAIL_LINE = /(^\s*●\s|^\s*FAIL\s|✗|\berror TS\d+|\bAssertionError\b|\bTypeError\b|\bReferenceError\b|^\s*Error:|Expected:|Received:|НОВЫЕ ошибки|ELIFECYCLE|Cannot find module)/i;

/**
 * Выжимка лога для агента: до 4 блоков вокруг строк ошибки (2 строки до, 22 после) и хвост; не длиннее max знаков.
 * Обрез — только здесь и с пометкой: справка и итоги прогонов раньше дорезали выжимку ещё раз, посреди строки и молча.
 */
export function failureExcerpt(text, max = 9000) {
    const lines = text.replace(ANSI, "").split(/\r?\n/).map((l) => l.trimEnd());
    const blocks = [];
    let i = 0;
    while (i < lines.length && blocks.length < 4) {
        if (FAIL_LINE.test(lines[i])) {
            const from = Math.max(0, i - 2), to = Math.min(lines.length, i + 22);
            blocks.push(lines.slice(from, to).join("\n"));
            i = to;
        }
        else
            i++;
    }
    const tail = lines.filter((l) => l.trim()).slice(-25).join("\n");
    let out = blocks.length ? "── причина (блоки с ошибками из лога) ──\n" + blocks.join("\n   ⋯\n") + "\n\n" : "── в логе не нашлось явных строк ошибки; ниже хвост ──\n";
    out += "── хвост лога ──\n" + tail;
    return out.length > max ? out.slice(0, max) + "\n… (обрезано: всего " + out.length + " знаков)" : out;
}

export { BLOCK_RE, FENCE };

export function lastAnswer(a) {
    const x = lastAnswerItem(a);
    return x ? x.text : "";
}

/** Последний ответ агента в текущем ходе: поиск идёт с конца ленты и обрывается на сообщении человека (старый ход не берём). */
export function lastAnswerItem(a) {
    for (let i = a.items.length - 1; i >= 0; i--) {
        const x = a.items[i];
        if (x.t === "user")
            return null;
        if (x.t === "assistant" && x.text)
            return x;
    }
    return null;
}

export const ORCH_RUN_RE = /^[\s>*_-]*ПРОГНАТЬ\s+([ПТ]\d+)\s*:\s*(.+)$/gim;

/**
 * «ПРОГНАТЬ ПN: задача=фильтр» из ответа оркестратора: просьба ставится в тесты волны слота (setTestReqs), при автопоезде —
 * сразу в очередь. turn — id хода: вместе с позицией строки даёт ключ команды, и разбор того же хода второй раз
 * (повтор после перезапуска) её не исполняет.
 */
export function orchRunCommands(a, text, turn = "") {
    for (const m of String(text || "").matchAll(ORCH_RUN_RE)) {
        const once = cmdKey(turn, text, m.index);
        if (!cmdBegin({ key: once, orch: a.key, cmd: "ПРОГНАТЬ", target: m[1], line: m[0].trim() }))
            continue;
        const t = TREES.find((x) => x.kind === "slot" && x.epic === epicOfKey(a.key) && x.tag.toLowerCase() === m[1].toLowerCase());
        if (!t) {
            cmdEnd(once, false, "нет такого слота в эпике");
            runFeedback(a.key, m[1], [], [], "нет такого слота в эпике");
            logEvent("orch.command", { tree: a.key, cmd: "ПРОГНАТЬ", target: m[1], ok: false, detail: "нет такого слота в эпике" });
            push(a, { id: "orun-" + a.rev + m.index, t: "status", text: "«ПРОГНАТЬ " + m[1] + "»: нет такого слота в эпике." });
            continue;
        }
        const parsed = parseRunList(m[2], TASKS), reqs = parsed.reqs, bad = parsed.bad.map((x) => x.word);
        if (reqs.length)
            setTestReqs(t.key, reqs, "просьба оркестратора");
        runFeedback(a.key, t.tag, reqs, parsed.bad);
        const runDetail = (reqs.map((r) => r.task + (r.input ? "=" + r.input : "")).join(", ") + (bad.length ? " | не понял: " + bad.join(", ") : "")).slice(0, 200);
        cmdEnd(once, reqs.length > 0, runDetail);
        logEvent("orch.command", { tree: a.key, cmd: "ПРОГНАТЬ", target: t.tag, ok: reqs.length > 0, detail: runDetail });
        push(a, {
            id: "orun-" + a.rev + m.index,
            t: "status",
            text:
                (reqs.length
                    ? "Поставлено в прогон " +
                      t.tag +
                      ": " +
                      reqs.map((r) => TASKS[r.task].label + (r.input ? " " + r.input : "")).join(", ") +
                      (settings.autoTrain ? " (автопоезд)" : " (автопоезд выключен: только в тесты волны)") +
                      "."
                    : "") +
                (bad.length
                    ? " Не понял: " +
                      parsed.bad.map((x) => x.word + " — " + x.why).join("; ") +
                      " (формат задача=фильтр, задачи: " +
                      Object.keys(TASKS).join(", ") +
                      ")."
                    : ""),
        });
    }
}

export const RUN_FORMAT_HINT = "Формат: «ПРОГНАТЬ ПN: задача=набор,набор, задача=набор» — наборы одной задачи подряд после неё через запятую, пояснения — после « — ».";

/**
 * Непонятое в «ПРОГНАТЬ» — оркестратору сообщением (иначе он считает, что прогон стоит). Всё понято — молчим.
 * Та же формулировка тому же оркестратору — не чаще раза в 30 минут: он мог повторить строку, не прочитав ответ.
 */
export function runFeedback(key, tag, reqs, bad, noSlot = "", now = Date.now()) {
    if (!noSlot && !bad.length)
        return "";
    const body =
        "«ПРОГНАТЬ " +
        tag +
        "»: " +
        (noSlot
            ? noSlot + "."
            : (reqs.length
                  ? "поставлено: " + reqs.map((r) => r.task + (r.input ? "=" + r.input : "")).join(", ") + "; "
                  : "ничего не поставлено; ") +
              "не понял: " +
              bad.map((x) => x.word + " (" + x.why + ")").join(", ") +
              ".");
    const k = key + "|run|" + body;
    if (now - (orchFailSeen.get(k) || 0) < 30 * 60e3)
        return "";
    orchFailSeen.set(k, now);
    const msg = "[Диспетчерская] " + body + "\n" + RUN_FORMAT_HINT + " Непонятое не ставилось — поправь и повтори только его.";
    _orchSteps.send(key, msg);
    return msg;
}

const gateSeen = new Map();

/** Что делать, когда ворота отказали в прогоне: подсказка по причине отказа, чтобы агент не повторял ту же просьбу. */
export function gateHint(why, tag) {
    if (/поезд влива/.test(why))
        return "Прогон не нужен: волну проверит поезд влива. Готова — «ВЛИТЬ " + tag + "» по слову владельца; нужна проверка до влива — сначала правка кода, после неё прогон встанет сам.";
    if (/дважды красный/.test(why))
        return "Без правки кода повтор даст то же: сначала правка (слоту — причина из лога), потом прогон встанет сам.";
    if (/красное staging/.test(why))
        return "Красное — в самом staging, не от волны: на влив не влияет, повторять незачем.";
    if (/зелёный/.test(why))
        return "Результат на этом коде уже есть (справка слота) — повтор не нужен.";
    return "Ту же просьбу без правки кода не повторяй.";
}

// Тупик правил: тот же отказ на том же коде с той же причиной подряд (deadlock.mjs). Счёт — по области (прогон задачи у
// слота или команда оркестратора); на пороге — карточка человеку и одно сообщение оркестратору.
const deadStreaks = new Map();

export function deadlockNote({ scope, sig, what, why, tree = "", orch = "" }, now = Date.now()) {
    const r = streakNote(deadStreaks, scope, sig, now);
    if (!r.fire)
        return "";
    const msg = deadlockText({ what, why: normWhy(why), n: r.n, since: r.since, now });
    logEvent("deadlock", { scope, tree, orch, what, why: normWhy(why).slice(0, 200), n: r.n, since: r.since });
    keepCards((c) => !(c.kind === "deadlock" && c.scope === scope));
    addCard({ id: ibId(), kind: "deadlock", scope, tree: tree || orch, to: orch, what, why: normWhy(why), n: r.n, since: r.since, at: now });
    saveInbox();
    if (orch)
        _orchSteps.send(orch, msg);
    return msg;
}

export const deadlockClear = (scope) => {
    if (streakClear(deadStreaks, scope)) {
        const n = inboxCards().length;
        keepCards((c) => !(c.kind === "deadlock" && c.scope === scope));
        if (inboxCards().length !== n)
            saveInbox();
    }
};

// Область счёта тупика для отказов ворот: слот + задача + ввод.
export const gateScope = (tree, task, input = "") => "gate|" + tree + "|" + task + "|" + input;

/** Итог команды оркестратора в счёт тупика: исполнена — счёт и карточка сняты, отказ — +1 к серии. */
export function cmdDeadlock(orch, what, detail, ok) {
    const scope = "cmd|" + orch + "|" + what;
    if (ok)
        return deadlockClear(scope);
    deadlockNote({ scope, sig: normWhy(detail), what, why: String(detail).replace(/^не исполнено:\s*/, ""), orch });
}

/**
 * Отказ ворот в прогоне — тому, кто просил: просьба оркестратора — оркестратору, просьба агента — самому слоту.
 * Автопоезд и «уже идёт/в очереди» не сообщаются: там никто не ждёт ответа. Одна и та же причина на том же коде
 * (fp) — одно сообщение за жизнь сервера; память ограничена 500 записями.
 */
export function gateFeedback({ tree, task, input = "", by, why, fp = "" }, now = Date.now()) {
    const to = by === "просьба оркестратора" ? orchOfKey(tree) : by === "просьба агента" ? tree : null;
    if (!to || /^уже (идёт|в очереди)/.test(String(why)))
        return "";
    {
        const t0 = treeByKey(tree);
        deadlockNote(
            {
                scope: gateScope(tree, task, input),
                sig: fp + "|" + normWhy(why),
                what: "прогон " + task + (input ? "=" + input : "") + " у " + (t0 ? t0.tag : tree),
                why: String(why),
                tree,
                orch: orchOfKey(tree),
            },
            now,
        );
    }
    const k = [to, tree, task, input, fp, String(why).replace(/\s*\([^)]*\)/g, "")].join("|");
    if (gateSeen.has(k))
        return "";
    gateSeen.set(k, now);
    if (gateSeen.size > 500)
        gateSeen.delete(gateSeen.keys().next().value);
    const t = treeByKey(tree), tag = t ? t.tag : tree, label = (TASKS[task] && TASKS[task].label) || task;
    const msg =
        "[Диспетчерская] Ворота не пустили прогон, который " +
        (to === tree ? "ты просил" : "ты поставил строкой ПРОГНАТЬ") +
        ": «" +
        label +
        (input ? " " + input : "") +
        "» у " +
        tag +
        " — " +
        why +
        ". " +
        gateHint(String(why), tag);
    logEvent("gate.notice", { to, tree, task, input });
    // Предмет сведения — слот и прогон: в копилке оркестратора новый отказ по тому же прогону заменит прежний.
    _orchSteps.send(to, msg, { tree, what: task + "|" + input });
    return msg;
}

// ───────────────────────────── коммит силами агента ─────────────────────────────

// Кнопка «Коммит», команда «КОММИТ ПN» и автопоезд могут попросить коммит одновременно: второй вызов получает тот же
// результат, а не ставит вторую задачу.
const commitInflight = new Map();

export function agentCommit(key) {
    const run = commitInflight.get(key);
    if (run)
        return run.then((r) => (r.code === 200 && r.body && r.body.job ? { code: 200, body: { ...r.body, already: true } } : r));
    const p = agentCommitRun(key).finally(() => commitInflight.delete(key));
    commitInflight.set(key, p);
    return p;
}

/** Поставить задачу «коммит силами агента»: только ветка волны (не staging/main), есть изменения, такой задачи ещё нет. */
async function agentCommitRun(key) {
    const t = treeByKey(key);
    if (!t || /^orchestrator/.test(t.key) || !agentCwd(t.key))
        return { code: 404, body: { error: "нет такого слота" } };
    const br = (await git(t.path, ["rev-parse", "--abbrev-ref", "HEAD"])).out;
    if (!br || ["staging", "main", "HEAD"].includes(br))
        return { code: 409, body: { error: "в ветку «" + (br || "?") + "» коммитить отсюда нельзя" } };
    const work = await workChanges(t.path);
    if (!work.length)
        return { code: 409, body: { error: "в слоте нет изменений: коммитить нечего" } };
    const dup = jobList().find((j) => j.tree === t.key && j.task === "commit" && !FINAL.includes(j.status));
    if (dup)
        return { code: 200, body: { ok: true, job: publicJob(dup), files: work.length, already: true } };
    const job = await enqueue({ treeKey: t.key, cwd: t.path, label: "Коммит силами агента", taskId: "commit", lane: "commit", profile: "eco",
        steps: [{ show: "коммит силами агента " + t.tag + ": подпись пишет агент, " + work.length + " файл(ов)", cwd: t.path, js: (write) => commitStep(t, write) }], extra: { pipeline: true } });
    return { code: 200, body: { ok: true, job: publicJob(job), files: work.length } };
}

// Сколько шаг коммита ждёт конца текущего хода агента и как часто смотрит (объект, а не константы: тест укорачивает срок).
export const COMMIT_WAIT = { ms: 20 * 60000, step: 2000 };

/**
 * Шаг задачи коммита: агенту — просьба с разрешением на коммит (commitUntil, COMMIT_GRANT_MS), дальше ждём, пока
 * сдвинется HEAD. Подпись пишет агент, диспетчерская только проверяет, что коммит появился.
 */
export async function commitStep(t, write) {
    const br = (await git(t.path, ["rev-parse", "--abbrev-ref", "HEAD"])).out, before = (await git(t.path, ["rev-parse", "HEAD"])).out;
    const work = await workChanges(t.path);
    if (!work.length) {
        write("в слоте нет изменений: коммитить нечего\n");
        return;
    }
    let a = agents.get(t.key);
    if (!a || a.dead)
        a = await ensureAgent(t.key);
    // Просьба не должна попасть в середину чужого хода: ждём конца текущего ответа (до COMMIT_WAIT.ms).
    for (const t0 = Date.now(); a.busy && !a.pinging && Date.now() - t0 < COMMIT_WAIT.ms;)
        await new Promise((r) => setTimeout(r, COMMIT_WAIT.step));
    // Не дождались — отказ, а не просьба поверх хода: сообщение посреди работы агент смешал бы со своей задачей, а
    // разрешение на коммит (commitUntil) накрыло бы и его собственные правки. Ошибка шага — красная задача с этой причиной
    // на странице и в журнале; повторить можно кнопкой или «КОММИТ ПN», когда агент освободится.
    if (a.busy && !a.pinging)
        throw new Error("агент " + t.tag + " занят своим ходом дольше " + Math.round(COMMIT_WAIT.ms / 60000) + " мин — просьба о коммите не отправлена;"
            + " повторите коммит, когда агент допишет ответ");
    a.commitUntil = Date.now() + COMMIT_GRANT_MS;
    deliver(a, commitAsk(t, br, work));
    recordRelay(t.key, "git", work.length, "commit");
    write("задача отправлена агенту " + t.tag + " (" + work.length + " файл(ов)); жду, пока он закоммитит\n");
    const t0 = Date.now(), nap = (ms) => new Promise((r) => setTimeout(r, ms));
    await nap(3000);
    // HEAD сдвинулся — ждём ещё 6 с тишины или конца хода: агент может сделать несколько коммитов или поправить подпись.
    let moved = "", movedAt = 0, now = before;
    while (!a.dead && Date.now() - t0 < 30 * 60000) {
        if (!a.busy && now === before)
            break;
        now =(await git(t.path, ["rev-parse", "HEAD"])).out;
        if (now !== before) {
            if (now !== moved) {
                moved = now;
                movedAt = Date.now();
            }
            if (!a.busy || Date.now() - movedAt >= 6000)
                break;
        }
        await nap(2000);
    }
    if (a.dead && now === before)
        throw new Error("агент остановился, не закончив коммит" + (a.lastErr ? ": " + a.lastErr : ""));
    if (a.busy && now === before)
        throw new Error("агент коммитит дольше 30 минут — смотрите его чат");
    const after = (await git(t.path, ["rev-parse", "HEAD"])).out;
    if (after === before)
        throw new Error("агент ответил, но коммита в ветке нет — смотрите его ответ в чате " + t.tag);
    const subj = (await git(t.path, ["log", "-1", "--format=%h %s"])).out, left = await workChanges(t.path);
    write("✓ коммит " + subj + "\n" + (left.length ? "вне коммита осталось файлов: " + left.length + " (" + left.slice(0, 5).map((w) => w.path).join(", ") + ")\n" : "дерево чистое\n"));
}

// ───────────────────────────── команды оркестратора: ВЛИТЬ, КОММИТ, СБРОСИТЬ ─────────────────────────────

// Строка команды — целиком отдельной строкой (разметка markdown вокруг допускается): упоминание в тексте не исполняется.
export const ORCH_GIT_RE = /^[\s>*_`-]*(ВЛИТЬ|КОММИТ)\s+([ПТ]\d+)(\s+ПРИНУДИТЕЛЬНО)?[\s.*_`]*$/gim;
export const OWNER_WORD = { ВЛИТЬ: /вле[йи]|влить|влива|слей|слить|мерж|merge/i, КОММИТ: /коммит|закоммит|commit/i };
// Что снимает «принудительно» — только мягкие проверки влива (id из pipeline.preflightRun → человеческое название):
// sec — гарды, done — доклад агента «ГОТОВО» по вагону поезда (его снимает и кнопка «Влить всё равно»). Конфликт,
// незакоммиченное и порядок волн — нет. Названия идут и в подсказку оркестратора (orch-system.md), и в отказ команды;
// prompts.test.mjs сверяет подсказку с этим списком, чтобы обещание оркестратору не разошлось с кодом.
export const FORCE_SOFT_LABELS = { regress: "регресс", review: "ревью", sec: "гарды", done: "доклад «ГОТОВО» по вагону поезда" };
export const FORCE_SOFT = new Set(Object.keys(FORCE_SOFT_LABELS));
const forceSoftText = () => {
    const v = Object.values(FORCE_SOFT_LABELS);
    return v.slice(0, -1).join(", ") + " и " + v[v.length - 1];
};
// Слово владельца действует 12 часов от момента, когда он его написал.
export const OWNER_WORD_TTL_MS = 12 * 3600e3;

export function ownerLastText(a, now = Date.now(), opt = {}) {
    const w = ownerLastWord(a, now, opt);
    return w ? w.text : null;
}

/**
 * Последнее сообщение владельца оркестратору → { text, at, by } | null. Сначала лента агента; её нет (после перезапуска
 * лента пустая) — журнал orchlog.mjs, где слово владельца переживает перезапуск. real — только набранное самим владельцем
 * на странице: автоответ режима «без владельца» и ответ из бота не дают права (wordGrants), это нужно для сброса ветки.
 */
export function ownerLastWord(a, now = Date.now(), { real = false } = {}) {
    for (let i = a.items.length - 1; i >= 0; i--) {
        const x = a.items[i];
        if (x.t !== "user" || !x.owner || (real && !wordGrants(x.by, "reset")))
            continue;
        const at = x.at || x.ts || 0;
        return !at || now - at <= OWNER_WORD_TTL_MS ? { text: x.text, at: at || now, by: x.by || "" } : null;
    }
    const w = ownerWord(a.key, { real });
    return w && now - (w.at || 0) <= OWNER_WORD_TTL_MS ? { text: w.text, at: w.at || now, by: w.by || "" } : null;
}

export const orchFailSeen = new Map();
export const ORCH_FAIL_HINT = prompt("orch-fail-hint");

/** Неисполненные команды — оркестратору одним сообщением с подсказкой; та же причина повторно — не раньше чем через 30 минут. */
export function orchFailFeedback(key, fails, now = Date.now()) {
    const fresh = fails.filter((f) => {
        const k = key + "|" + f;
        if (now - (orchFailSeen.get(k) || 0) < 30 * 60e3)
            return false;
        orchFailSeen.set(k, now);
        return true;
    });
    return fresh.length ? "[Диспетчерская] Команды не исполнены:\n" + fresh.map((f) => "- " + f).join("\n") + "\n" + ORCH_FAIL_HINT : "";
}

// Предел на один долгий шаг команды (проверка влива, постановка задачи): зависшая проверка не держит разбор хода вечно.
export const ORCH_STEP_MS = Number(process.env.DASH_ORCH_STEP_MS) || 120000;

// Внешние шаги команд оркестратора одним объектом: тесты подменяют их (проверку влива, постановку задачи, отправку) и
// проверяют разбор команд без git и без агентов.
export const _orchSteps = { preflight, recipe: (action, o) => recipe(action, o), agentCommit: (k) => agentCommit(k), reset: (o) => slotReset(o), enqueue: (o) => enqueue(o),
    send: (key, msg, about) => {
        if (!DRY)
            sendWhenFree(key, msg, about);
    },
    queueChecks: (key, need, direct) => mergeQueueChecks(key, need, direct) };

/**
 * Команды оркестратора, меняющие ветки: ВЛИТЬ/КОММИТ, ОТМЕНИТЬ ВЛИТЬ, СБРОСИТЬ — по порядку в одном ходе. Отказы копятся
 * и уходят оркестратору (flush) перед каждым долгим шагом и в конце: он узнаёт об отказе, не дожидаясь чужих проверок.
 */
export async function orchGitCommands(a, text, turn = "") {
    const fails = [], flush = () => {
        const msg = orchFailFeedback(a.key, fails.splice(0));
        if (msg)
            _orchSteps.send(a.key, msg);
    };
    try {
        await orchGitRun(a, text, fails, flush, turn);
        orchUnwaitRun(a, text, fails, turn);
        await orchResetRun(a, text, fails, flush, turn);
    }
    finally {
        flush();
    }
}

// ───────────────────────────── ВЛИТЬ ждёт зелёного ─────────────────────────────

// Слово владельца «влей» при незелёных проверках не пропадает: команда становится ожиданием (merge-wait.mjs), диспетчерская
// сама ставит недостающие проверки и вливает, когда всё зелёное, пока не истёк срок слова. Решение шага — loops.mjs
// mergeWaitStep; здесь — исполнение.
const MW_BY = "ВЛИТЬ ждёт зелёного";
const hhmmOf = (at) => new Date(at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

/**
 * Поставить недостающие для влива проверки. При автопоезде порядок станций знает он сам (autoChain); direct — поставить
 * именно эти проверки в обход автопоезда (решение шага, когда автопоезд их не ставит).
 */
export async function mergeQueueChecks(key, need, direct = false) {
    if (!direct && settings.autoTrain && !autoTrainOffFor(key))
        return autoChain(key, MW_BY);
    const t = snapNow() && snapNow().trees.find((x) => x.key === key);
    for (const id of need) {
        if (id === "sec")
            for (const g of guardIds())
                await runTask(key, g, "", MW_BY).catch((e) => console.error("ожидание влива, гард " + g + ":", e.message));
        else if (id === "review" && reviewEnabled())
            await runTask(key, "review", "", MW_BY).catch((e) => console.error("ожидание влива, ревью:", e.message));
        else if (id === "regress")
            for (const x of ((t && t.regress) || []).filter((y) => !["ok", "inherited", "run"].includes(y.status)))
                await runTask(key, x.task, x.input || "", MW_BY).catch((e) => console.error("ожидание влива, регресс:", e.message));
    }
}

/**
 * Что красное на нынешнем коде слота → { sec?, regress?, review? }. Красное только на этом же отпечатке кода (fpEnd === fp):
 * старое красное после правки ожидание не останавливает.
 */
export function mergeRedOf(key, t) {
    const red = {};
    if (!t)
        return red;
    for (const g of guardIds()) {
        const sec = [...jobList()].reverse().find((j) => j.tree === key && j.task === g && ["ok", "fail"].includes(j.status));
        if (sec && sec.status === "fail" && sec.fpEnd && sec.fpEnd === t.fp && realFail(sec)) {
            red.sec = "гард «" + TASKS[g].label + "» красный на этом коде (" + sec.id + (sec.summary ? ": " + short(sec.summary, 200) : "") + ")";
            break;
        }
    }
    if (t.verdict && t.verdict.regress === "fail") {
        const rg = (t.stages || []).find((x) => x.id === "regress");
        red.regress = "регресс красный на этом коде" + (rg && rg.hint ? " (" + short(rg.hint, 300) + ")" : "");
    }
    if (t.review && t.review.fresh && t.review.verdict && t.review.verdict !== "ЗА")
        red.review = "ревью «" + t.review.verdict + "» на этом коде — замечания к правке";
    return red;
}

/**
 * Превратить «ВЛИТЬ» в ожидание. Срок — от момента слова владельца, а не от команды. Если ожидание уже на паузе из-за
 * красного на этом же коде, повторная команда отказывает: без правки кода оно не продолжится.
 */
function mergeWaitArm(a, t, fails, word) {
    const now = Date.now(), at = (word && word.at) || now, until = at + OWNER_WORD_TTL_MS, need = fails.map((c) => c.id);
    const old = mergeWaitOf(t.key), sn = snapNow() && snapNow().trees.find((x) => x.key === t.key), fp = (sn && sn.fp) || "";
    keepMergeWord(t.key, { text: String((word && word.text) || "").slice(0, 300), at, until, orch: a.key, by: (word && word.by) || "" });
    if (old && old.state === "red" && old.redFp && old.redFp === fp)
        return {
            ok: false,
            text:
                "не исполнено: ВЛИТЬ " +
                t.tag +
                " уже на паузе — на этом коде красное: " +
                (old.why || "") +
                ". Нужна правка кода; после неё ожидание продолжится само (слово владельца в силе до " +
                hhmmOf(until) +
                ").",
        };
    setMergeWait(t.key, { orch: a.key, tag: t.tag, at: old ? old.at : now, until, state: "wait", need, why: "", queuedFp: "", queuedAt: 0, tries: 0 });
    logEvent("merge.wait", { tree: t.key, orch: a.key, need: need.join(",") });
    if (!DRY)
        setTimeout(() => mergeWaitTick(t.key).catch((e) => console.error("ожидание влива:", e.message)), 1500);
    return {
        ok: true,
        text:
            "ждёт зелёного: на нынешнем коде нет «" +
            need.map((id) => MERGE_LABEL[id] || id).join("», «") +
            "». Диспетчерская сама ставит недостающие проверки и вольёт " +
            t.tag +
            ", когда всё позеленеет (до " +
            hhmmOf(until) +
            ", срок слова владельца). Красное — пауза с причиной, слово владельца остаётся до срока: поправят код — продолжу сам, владельца заново не спрашивай. Отменить — строкой «ОТМЕНИТЬ ВЛИТЬ " +
            t.tag +
            "».",
    };
}

// «ОТМЕНИТЬ ВЛИТЬ ПN» снимает ожидание влива и гасит слово владельца по этому слоту.
export const ORCH_UNWAIT_RE = /^[\s>*_`-]*ОТМЕНИТЬ\s+ВЛИТЬ\s+([ПТ]\d+)[\s.*_`]*$/gim;

function orchUnwaitRun(a, text, fails, turn = "") {
    for (const m of String(text || "").matchAll(ORCH_UNWAIT_RE)) {
        const once = cmdKey(turn, text, m.index);
        if (!cmdBegin({ key: once, orch: a.key, cmd: "ОТМЕНИТЬ ВЛИТЬ", target: m[1], line: m[0].replace(/[*_`>]/g, "").trim() }))
            continue;
        const t = TREES.find((x) => x.kind === "slot" && x.epic === epicOfKey(a.key) && x.tag.toLowerCase() === m[1].toLowerCase());
        const ok = !!t && dropMergeWait(t.key, { word: true, why: "отменил оркестратор", by: a.key }),
            s = !t
                ? "нет такого слота в эпике."
                : ok
                  ? "ожидание влива " + t.tag + " снято, слово владельца по нему погашено."
                  : "у " + t.tag + " нет ожидания влива.";
        cmdEnd(once, ok, s);
        logEvent("orch.command", { tree: a.key, cmd: "ОТМЕНИТЬ ВЛИТЬ", target: m[1], ok, detail: s });
        if (!ok)
            fails.push("«ОТМЕНИТЬ ВЛИТЬ " + m[1] + "»: " + s);
        push(a, { id: "ounw-" + once.replace(/\W/g, ""), t: "status", text: "«ОТМЕНИТЬ ВЛИТЬ " + m[1] + "»: " + s });
    }
}

export const OWNER_STOP_RE = /(не\s+(?:надо\s+)?вли|не\s+сливай|отмен\S*\s+вл|подожд\S*\s+с\s+вл|(?:^|[\s,.!])стоп(?![а-яё]))/i;

/** Владелец написал оркестратору «не вливай», «стоп» и т. п. — снять все ожидания влива этого оркестратора и погасить слово. */
export function ownerStopsMergeWaits(orch, text) {
    if (!OWNER_STOP_RE.test(String(text || "")))
        return [];
    const off = mergeWaits().filter((w) => w.orch === orch).map((w) => {
        dropMergeWait(w.key, { word: true, why: "владелец: " + String(text).slice(0, 120), by: "владелец" });
        return w.tag || w.key;
    });
    return off;
}

export function cancelMergeWait(key, by = "владелец") {
    return dropMergeWait(key, { word: true, why: "отменил " + by, by });
}

// Таймер и ручной толчок (после постановки, после «продолжить») могут зайти в одно ожидание сразу: шаг по ключу — по одному.
const mwBusy = new Set();

/** Шаг всех ожиданий влива (или одного — only). Во время подготовки к перезапуску не ходим: влив не должен оборваться. */
export async function mergeWaitTick(only = "") {
    if (drainState())
        return;
    for (const w of mergeWaits()) {
        if (only && w.key !== only)
            continue;
        if (mwBusy.has(w.key))
            continue;
        mwBusy.add(w.key);
        try {
            await mergeWaitOne(w.key, mergeWaitOf(w.key));
        }
        catch (e) {
            console.error("ожидание влива " + w.key + ":", e.message);
        }
        finally {
            mwBusy.delete(w.key);
        }
    }
}

async function mergeWaitOne(key, w0) {
    let w = w0;
    if (!w)
        return;
    const t = TREES.find((x) => x.key === key && x.kind === "slot"), tag = (t && t.tag) || w.tag || key, orch = w.orch;
    const stop = (msg, word = false) => {
        dropMergeWait(key, { word, why: msg.slice(0, 200), by: "диспетчерская" });
        _orchSteps.send(orch, msg);
    };
    if (!t)
        return stop("[Диспетчерская] Ожидание влива снято: слота " + tag + " больше нет в эпике.", true);
    const sn = snapNow() && snapNow().trees.find((x) => x.key === key);
    if (sn && sn.verdict && sn.verdict.merged) {
        dropMergeWait(key, { word: true, why: "уже влито", by: "диспетчерская" });
        return;
    }
    const mine = jobList().filter((j) => j.tree === key || (treeByKey(j.tree) || {}).checkOf === key);
    const fp = (sn && sn.fp) || "", live = mine.some((j) => ["queued", "waiting", "running"].includes(j.status));
    const ag = agents.get(key), busy = !!ag && !ag.dead && ag.busy && !ag.pinging;
    const marks = ((sn && sn.stages) || []).filter((x) => ["guards", "regress", "review"].includes(x.id)).map((x) => x.id + (x.done ? "+" : "-")).join(",");
    // Подпись состояния: код, последний итог прогона, идёт ли что-то, занят ли агент, отметки станций. Пока она та же,
    // результат проверки влива берётся из ожидания (до 10 минут) — проверка дорогая (git, конфликт со staging).
    const sig = [fp, Math.max(0, ...mine.map((j) => j.endedAt || 0)), live ? 1 : 0, busy ? 1 : 0, marks].join("|");
    const ask = async () => {
        const p = await withDeadline(_orchSteps.preflight("merge", key), ORCH_STEP_MS, "проверка влива " + tag);
        return { p, checks: (p.checks || []).map(({ id, ok, text, detail }) => ({ id, ok, text, detail })) };
    };
    let p = null, checks = w.sig === sig && Date.now() - (w.checkedAt || 0) < 10 * 60e3 ? w.checks : null;
    if (!checks) {
        try {
            ({ p, checks } = await ask());
        }
        catch {
            return;
        }
        w = { ...w, sig, checks, checkedAt: Date.now() };
        setMergeWait(key, w);
    }
    let d = mergeWaitStep({ w, checks, red: mergeRedOf(key, sn), live, busy, fp });
    // Вливать по проверке из кеша нельзя: перед вливом — свежая проверка и повторное решение по ней.
    if (d.act === "merge" && !p) {
        try {
            ({ p, checks } = await ask());
        }
        catch {
            return;
        }
        w = { ...w, sig, checks, checkedAt: Date.now() };
        setMergeWait(key, w);
        d = mergeWaitStep({ w, checks, red: mergeRedOf(key, sn), live, busy, fp });
    }
    const upd = (o) => setMergeWait(key, { ...w, ...o });
    if (d.act === "expire")
        return stop(
            "[Диспетчерская] Ожидание влива снято: " +
                tag +
                " — срок слова владельца истёк (" +
                hhmmOf(w.until) +
                "), а условия влива так и не позеленели. Нужен новый ответ владельца.",
            true,
        );
    if (d.act === "cancel")
        return stop(
            "[Диспетчерская] Ожидание влива снято: " +
                tag +
                " — " +
                d.why +
                ". Слово владельца в силе до " +
                hhmmOf(w.until) +
                ": устрани помеху и повтори «ВЛИТЬ " +
                tag +
                "», владельца заново не спрашивай.",
        );
    if (d.act === "merge") {
        const tt = (p.trees || []).find((x) => x.key === key) || { branch: t.branch }, r = _orchSteps.recipe("merge", { slotKey: key, branch: tt.branch });
        const job = await withDeadline(
            _orchSteps.enqueue({
                treeKey: r.treeKey,
                cwd: r.cwd,
                label: r.label,
                taskId: "merge",
                lane: r.lane,
                steps: r.steps,
                extra: { pipeline: true, by: "оркестратор по слову владельца (ждал зелёного)" },
            }),
            ORCH_STEP_MS,
            "постановка влива " + tag,
        );
        dropMergeWait(key, { word: true, why: "вливаю (" + job.id + ")", by: "диспетчерская" });
        logEvent("merge.wait.done", { tree: key, orch, job: job.id });
        const a = agents.get(orch);
        if (a)
            push(a, { id: "mwd-" + key + "-" + job.id, t: "status", text: "«ВЛИТЬ " + tag + "» по ожиданию: проверки зелёные — вливаю " + tt.branch + " в staging (" + job.id + ")." });
        return _orchSteps.send(orch, "[Диспетчерская] Влито по ожиданию: «ВЛИТЬ " + tag + "» — проверки позеленели, " + tt.branch + " вливается в staging (" + job.id + ").",
            { tree: key });
    }
    if (d.act === "red") {
        upd({ state: "red", redFp: fp, why: d.why, need: d.need });
        logEvent("merge.wait.red", { tree: key, orch, why: d.why.slice(0, 200), stuck: !!d.stuck });
        return _orchSteps.send(
            orch,
            "[Диспетчерская] Влив " +
                tag +
                " на паузе: " +
                d.why +
                ". Слово владельца в силе до " +
                hhmmOf(w.until) +
                ": когда код поправят и проверки позеленеют, волью сам — владельца заново не спрашивай. Отменить — «ОТМЕНИТЬ ВЛИТЬ " +
                tag +
                "».",
        );
    }
    if (d.act === "resume") {
        upd({ state: "wait", redFp: "", why: "", need: d.need, queuedFp: "", tries: 0 });
        logEvent("merge.wait.resume", { tree: key, orch });
        if (!DRY)
            setTimeout(() => mergeWaitTick(key).catch(() => { }), 1000);
        return;
    }
    if (d.act === "queue") {
        upd({ need: d.need, why: "ставлю недостающие проверки", queuedFp: fp, queuedAt: Date.now(), tries: w.queuedFp === fp ? (w.tries || 0) + 1 : 0 });
        logEvent("merge.wait.queue", { tree: key, need: d.need.join(","), direct: !!d.direct });
        return _orchSteps.queueChecks(key, d.need, !!d.direct);
    }
    if ((d.act === "wait" || d.act === "hold") && (w.why !== d.why || String(w.need) !== String(d.need)))
        upd({ need: d.need, why: d.why });
}

// Метка поезда принимается и с латинской T: оркестратор иногда пишет её так.
export const ORCH_RESET_RE = /^[\s>*_`-]*СБРОСИТЬ\s+([ПТT]\d+)(?:\s+НА\s+(staging|[0-9a-f]{7,40}))?[\s.*_`]*$/gim;
export const OWNER_RESET_WORD = /сбро[сш]|откат|reset/i;

/**
 * «СБРОСИТЬ ПN [НА staging|<sha>]»: снимает коммиты слота, поэтому нужно слово «сбрось» в последнем сообщении, которое
 * владелец набрал сам (real). Проверки и страховочный тег — slot-reset.mjs.
 */
async function orchResetRun(a, text, fails, flush = () => { }, turn = "") {
    for (const m of String(text || "").matchAll(ORCH_RESET_RE)) {
        const tag = m[1].replace(/^T/i, "Т"), to = m[2] || "staging", once = cmdKey(turn, text, m.index), line = m[0].replace(/[*_`>]/g, "").trim().replace(/^-\s*/, "");
        if (!cmdBegin({ key: once, orch: a.key, cmd: "СБРОСИТЬ", target: tag, line }))
            continue;
        const say = (s, ok = true) => {
            cmdEnd(once, ok, s);
            logEvent("orch.command", { tree: a.key, cmd: "СБРОСИТЬ", target: tag, ok, detail: String(s).slice(0, 200) });
            cmdDeadlock(a.key, "СБРОСИТЬ " + tag, s, ok);
            if (!ok)
                fails.push("«СБРОСИТЬ " + tag + "»: " + short(s, 400));
            return push(a, { id: "orst-" + once.replace(/\W/g, ""), t: "status", text: "«" + line + "»: " + s });
        };
        const t = TREES.find((x) => x.kind === "slot" && x.epic === epicOfKey(a.key) && x.tag.toLowerCase() === tag.toLowerCase());
        if (!t) {
            say("нет такого слота в эпике.", false);
            continue;
        }
        const word = ownerLastText(a, Date.now(), { real: true });
        if (!word || !OWNER_RESET_WORD.test(word)) {
            say(
                "не исполнено: в последнем сообщении, которое набрал сам владелец, нет слова «сбрось» (автоответ " +
                    "«без владельца» и ответ из бота не в счёт): коммиты слота снимаются — только по его слову.",
                false,
            );
            continue;
        }
        try {
            flush();
            const r = await withDeadline(_orchSteps.reset({ key: t.key, to, by: "оркестратор по слову владельца" }), 10 * 60000, "сброс " + tag);
            say(r.code === 200 ? r.body.message : "не исполнено: " + r.body.error, r.code === 200);
        }
        catch (e) {
            say("ошибка: " + e.message, false);
        }
    }
}

/**
 * ВЛИТЬ и КОММИТ. Слово владельца — из его последнего сообщения; для ВЛИТЬ ещё и сохранённое слово ожидания влива (kept):
 * повтор команды после правки не требует нового ответа владельца. «Принудительно» — только для ВЛИТЬ и только если
 * владелец сам написал это слово на странице. Незелёное при включённом ожидании — не отказ, а ожидание (mergeArm).
 */
async function orchGitRun(a, text, fails, flush = () => { }, turn = "") {
    const step = (run, what) => {
        flush();
        return withDeadline(run(), ORCH_STEP_MS, what);
    };
    for (const m of String(text || "").matchAll(ORCH_GIT_RE)) {
        const op = m[1].toUpperCase(), force = !!m[3], once = cmdKey(turn, text, m.index);
        if (!cmdBegin({ key: once, orch: a.key, cmd: op + (force ? " ПРИНУДИТЕЛЬНО" : ""), target: m[2], line: m[0].replace(/[*_`>]/g, "").trim() }))
            continue;
        const say = (s, ok = true) => {
            cmdEnd(once, ok, s);
            logEvent("orch.command", { tree: a.key, cmd: op + (force ? " ПРИНУДИТЕЛЬНО" : ""), target: m[2], ok, detail: String(s).slice(0, 200) });
            cmdDeadlock(a.key, op + " " + m[2], s, ok);
            if (!ok)
                fails.push("«" + op + " " + m[2] + "»: " + short(s, 400));
            return push(a, { id: "ogit-" + once.replace(/\W/g, ""), t: "status", text: "«" + m[0].replace(/[*_`>]/g, "").trim().replace(/^-\s*/, "") + "»: " + s });
        };
        const t = TREES.find((x) => x.kind === "slot" && x.epic === epicOfKey(a.key) && x.tag.toLowerCase() === m[2].toLowerCase());
        if (!t) {
            say("нет такого слота в эпике.", false);
            continue;
        }
        const lw = ownerLastWord(a), said = lw && OWNER_WORD[op].test(lw.text) && wordGrants(lw.by, op === "ВЛИТЬ" ? "merge" : "commit") ? lw : null;
        const kept = op === "ВЛИТЬ" && !said ? mergeWordOf(t.key) : null, src = said || kept, word = src ? src.text : "";
        if (!src) {
            say("не исполнено: в последнем сообщении владельца нет слова «" + (op === "ВЛИТЬ" ? "влей" : "коммить") + "».", false);
            continue;
        }
        if (force && (op !== "ВЛИТЬ" || !/принудительн/i.test(word) || !wordGrants(src.by, "force"))) {
            say("не исполнено: «принудительно» — только для вливания и только если владелец сам так написал на дашборде (ответ из Telegram и автоответ «без владельца» не в счёт).", false);
            continue;
        }
        try {
            if (op === "КОММИТ") {
                const r = await step(() => _orchSteps.agentCommit(t.key), "коммит " + t.tag);
                say(
                    r.code === 200
                        ? "коммит " +
                              t.tag +
                              " поставлен в очередь задач (" +
                              r.body.files +
                              " файлов, " +
                              (r.body.job ? r.body.job.id : "") +
                              "): уйдёт агенту, когда он допишет текущий ответ."
                        : "не исполнено: " + r.body.error,
                    r.code === 200,
                );
                continue;
            }
            const p = await step(() => _orchSteps.preflight("merge", t.key), "проверка влива " + t.tag);
            const fail = p.checks.filter((c) => c.ok === false), bad = fail.filter((c) => !(force && FORCE_SOFT.has(c.id)));
            if (bad.length) {
                const arm = mergeArm({ fails: bad, force, on: settings.mergeWait !== false });
                if (arm.arm) {
                    const r = mergeWaitArm(a, t, bad, said || kept);
                    say(r.text, r.ok);
                    continue;
                }
                say(
                    "не исполнено: " +
                        bad.map((c) => c.text + (c.detail ? " (" + c.detail + ")" : "")).join("; ") +
                        (fail.some((c) => FORCE_SOFT.has(c.id)) && !force
                            ? ". " + forceSoftText().replace(/^./, (c) => c.toUpperCase()) + " снимаются словом владельца «принудительно»."
                            : ""),
                    false,
                );
                continue;
            }
            const tt = p.trees.find((x) => x.key === t.key), r = _orchSteps.recipe("merge", { slotKey: t.key, branch: tt.branch });
            const job = await step(
                () =>
                    _orchSteps.enqueue({
                        treeKey: r.treeKey,
                        cwd: r.cwd,
                        label: r.label,
                        taskId: "merge",
                        lane: r.lane,
                        steps: r.steps,
                        extra: {
                            pipeline: true,
                            by: "оркестратор по слову владельца" + (force ? ", принудительно" : ""),
                        },
                    }),
                "постановка влива " + t.tag,
            );
            dropMergeWait(t.key, { word: true, why: "вливаю (" + job.id + ")", by: a.key });
            say("вливаю " + tt.branch + " в staging (" + job.id + ")" + (force && fail.length ? "; снято принудительно: " + fail.map((c) => c.text).join("; ") : "") + ".");
        }
        catch (e) {
            say("ошибка: " + e.message, false);
        }
    }
}

export const ORCH_ORDER_RE = /^[\s>*_`-]*ПОРЯДОК\s+([ПТ]\d+)\s+(?:(ПОСЛЕ)\s+([ПТ]\d+)|([ПТ]\d+)\s+НЕ\s+СВЯЗАНЫ)[\s.*_`]*$/gim;

/**
 * «ПОРЯДОК ПM ПОСЛЕ ПN» / «ПОРЯДОК ПN ПM НЕ СВЯЗАНЫ» — запись в реестр порядка вливов (pipeline.mjs setOrder), как кнопка
 * карточки «Порядок». Слова владельца не нужно: порядок вливов решает оркестратор. → строки исполненных команд.
 */
export function orchOrderCommands(a, text, turn = "") {
    const done = [];
    for (const m of String(text || "").matchAll(ORCH_ORDER_RE)) {
        const once = cmdKey(turn, text, m.index);
        if (!cmdBegin({ key: once, orch: a.key, cmd: "ПОРЯДОК", target: m[1], line: m[0].replace(/[*_`>]/g, "").trim() }))
            continue;
        const slot = (tag) => TREES.find((x) => x.kind === "slot" && x.epic === epicOfKey(a.key) && x.tag.toLowerCase() === tag.toLowerCase());
        const ta = slot(m[1]), tb = slot(m[3] || m[4]), op = m[2] ? "after" : "none";
        const say = (s, ok = true) => {
            cmdEnd(once, ok, s);
            logEvent("orch.command", { tree: a.key, cmd: "ПОРЯДОК", target: m[1] + (op === "after" ? " после " : " ~ ") + (m[3] || m[4]), ok, detail: String(s).slice(0, 200) });
            push(a, { id: "oord-" + a.rev + "-" + m.index, t: "status", text: "«" + m[0].replace(/[*_`>]/g, "").trim() + "»: " + s });
        };
        if (!ta || !tb || ta === tb) {
            say("нет такого слота в эпике.", false);
            continue;
        }
        try {
            setOrder(ta.key, tb.key, op);
            say(op === "after" ? ta.tag + " вливается после " + tb.tag + " — записано в реестр." : "пара отмечена «не связаны».");
            done.push(m[0].trim());
        }
        catch (e) {
            say("не исполнено: " + e.message, false);
        }
    }
    return done;
}

export const ORCH_ACCEPT_RE = /^[\s>*_`-]*ПРИНЯТЬ\s+РЕВЬЮ\s+([ПТ]\d+)[\s.*_`]*$/gim;

/**
 * «ПРИНЯТЬ РЕВЬЮ ПN»: оркестратор проверил замечания и считает их неблокирующими — станция «Ревью» отмечается для
 * текущей ветки слота, автопоезд идёт к коммиту. Отметка повторяемая, поэтому журнал команд (cmdBegin) не нужен.
 */
export async function orchAcceptReview(a, text) {
    for (const m of String(text || "").matchAll(ORCH_ACCEPT_RE)) {
        const t = TREES.find((x) => x.kind === "slot" && x.epic === epicOfKey(a.key) && x.tag.toLowerCase() === m[1].toLowerCase()), say = (x, ok = true) => {
            logEvent("orch.command", { tree: a.key, cmd: "ПРИНЯТЬ РЕВЬЮ", target: m[1], ok, detail: String(x).slice(0, 200) });
            return push(a, { id: "oacc-" + a.rev, t: "status", text: "«ПРИНЯТЬ РЕВЬЮ " + m[1] + "»: " + x });
        };
        if (!t || !exists(t.path)) {
            say("нет такого слота.", false);
            continue;
        }
        const br = (await git(t.path, ["rev-parse", "--abbrev-ref", "HEAD"])).out, k = `${t.key}|${br}`;
        markReviewAccepted(k, "принято оркестратором " + new Date().toLocaleString("ru-RU"));
        say("станция «Ревью» у " + t.tag + " отмечена пройденной" + (settings.autoTrain && settings.autoCommit !== false ? "; автопоезд ставит коммит" : ""));
        if (settings.autoTrain)
            setTimeout(() => autoChain(t.key, "ревью принято оркестратором").catch((e) => console.error("автопоезд:", e.message)), 1500);
    }
}

export const RESTART_CUT_HINT = "Если они ещё нужны — проверь состояние (влито ли, стоит ли прогон) и повтори строками в ответе; слово владельца после перезапуска сохранено.";

/**
 * После старта сервера: прерванные перезапуском команды — оркестратору отказом; законченный, но не разобранный ход
 * оркестратора (запись сессии читает рантайм) — исполнить. readSession и lastAnswer подменяют тесты.
 */
export async function orchAfterBoot({ readSession = readSessionTail, lastAnswer = lastAnswerOf, now = Date.now() } = {}) {
    const cut = takeInterrupted(now), byOrch = new Map();
    for (const x of cut) {
        if (!byOrch.has(x.orch))
            byOrch.set(x.orch, []);
        byOrch.get(x.orch).push(x);
        logEvent("orch.command", { tree: x.orch, cmd: x.cmd, target: x.target, ok: false, detail: "прервано перезапуском диспетчерской" });
    }
    for (const [orch, list] of byOrch)
        _orchSteps.send(
            orch,
            "[Диспетчерская] Перезапуск диспетчерской прервал исполнение твоих команд — исполнение НЕ подтверждено:\n" +
                list.map((x) => "- «" + x.line + "»").join("\n") +
                "\n" +
                RESTART_CUT_HINT,
        );
    for (const t of TREES.filter((x) => x.kind === "orch" && !x.archived)) {
        let fin = null;
        try {
            fin = lastAnswer(await readSession(t.key));
        }
        catch { }
        if (!fin || !fin.at || fin.at <= Math.max(orchLogSince(), lastTurnSeen(t.key)))
            continue;
        const a = agents.get(t.key) || { key: t.key, items: [], rev: 0 };
        logEvent("orch.replay", { key: t.key, at: fin.at, turn: fin.id });
        turnSeen(t.key, now);
        orchRunCommands(a, fin.text, fin.id);
        await orchGitCommands(a, fin.text, fin.id).catch((e) => console.error("ВЛИТЬ/КОММИТ после старта:", e.message));
        try {
            if (orchOrderCommands(a, fin.text, fin.id).length)
                kick();
        }
        catch (e) {
            console.error("ПОРЯДОК после старта:", e.message);
        }
    }
}

// ───────────────────────────── разбор хода агента ─────────────────────────────

/**
 * Разбор законченного хода агента: блоки передач → карточки (и автопередача), просьбы о прогонах, команды оркестратора,
 * «ГОТОВО» и вопросы владельцу (stations.mjs), напоминания, сводка, решение «ДАЛЬШЕ: …», правки кода → проверка.
 */
export function inboxAfterTurn(a) {
    const key = a.key, ans = lastAnswerItem(a), text = ans ? ans.text : "", turn = ans ? ans.id : "";
    if (key === BACKLOG_KEY)
        return backlogAfterTurn(a, text);
    // Карточки передач от этого агента пересобираются по новому ответу: прежний ответ устарел.
    keepCards((x) => !(x.kind === "relay" && x.tree === key));
    for (const m of text.matchAll(BLOCK_RE)) {
        const lang = m[1].trim(), body = m[2].trim();
        let to = null;
        if (isOrch(key)) {
            const ep = epicOfKey(key);
            const tt = blockTargetTag(lang, TREES.filter((x) => !isOrch(x.key) && x.epic === ep));
            if (tt && body.length > 3)
                to = tt;
        }
        // Доклад слота — первый блок ```text: одна передача на ход. Нужна ли она оркестратору (есть ли для него дело, новое ли
        // это) — решает relayDecision; «ЖДУ» и «Принял» без дела остаются в чате слота.
        else if (isReportBlock(lang, body) && !inboxCards().some((x) => x.kind === "relay" && x.tree === key)) {
            const lr = lastRelay.get(key), t = snapNow() && snapNow().trees.find((x) => x.key === key);
            const lastUser = [...a.items].reverse().find((x) => x.t === "user");
            const rd = relayDecision({ body, prev: lr, cur: t ? { fp: t.fp, sha: t.last && t.last.sha } : null, sync: !!lastUser && isSyncAsk(lastUser.text) });
            if (!rd.relay) {
                logEvent("relay.skipped", { tree: key, why: String(rd.why || "").slice(0, 200) });
                // Ответ на слово владельца в чате слота — разговор с человеком, а не доклад: пометку о непередаче не вешаем.
                if (!(lastUser && lastUser.owner))
                    push(a, { id: "nr-" + a.rev, t: "status", text: "Оркестратору не передаю: " + rd.why + ". Передать всё равно — кнопка «→ ОРК» над блоком." });
                continue;
            }
            to = treeByKey(orchOfKey(key));
        }
        // Блок уже передан (тот же ответ разбирается повторно) — карточку не заводим.
        if (to && S.relaySent.includes(relayHash(key, to.key, body)))
            to = null;
        if (to) {
            const card = { id: ibId(), kind: "relay", tree: key, to: to.key, toTag: to.tag, text: body, at: Date.now() };
            addCard(card);
            if (settings.autoTrain)
                setTimeout(() => autoRelay(card.id), 1500);
        }
    }
    if (!isOrch(key)) {
        try {
            const rq = parseRunRequests(text);
            if (rq.length)
                setTestReqs(key, rq);
        }
        catch { }
    }
    if (isOrch(key)) {
        turnSeen(key);
        orchRunCommands(a, text, turn);
        orchGitCommands(a, text, turn).catch((e) => console.error("ВЛИТЬ/КОММИТ:", e.message));
        orchAcceptReview(a, text).catch((e) => console.error("ПРИНЯТЬ РЕВЬЮ:", e.message));
        try {
            if (orchOrderCommands(a, text, turn).length)
                kick();
        }
        catch (e) {
            console.error("ПОРЯДОК:", e.message);
        }
    }
    // ход слота: «ГОТОВО» — отметка волны и автопоезд, «Вопросы владельцу» — карточка или автоответ (stations.mjs)
    try {
        afterSlotTurn(key, text);
    }
    catch (e) {
        console.error("разбор хода слота:", e.message);
    }
    try {
        remAddFromText(key, text);
    }
    catch (e) {
        console.error("напоминания:", e.message);
    }
    setTimeout(pumpAll, 500);
    kick();
    // Агент освободился — отдать ему передачи, которые ждали в очереди, пока он отвечал.
    setTimeout(() => drainQueued(key), 1500);
    if (!isOrch(key)) {
        const sm = summaryOf(text);
        if (sm)
            setSummary(key, { text: sm, at: Date.now() });
    }
    // Решение «ДАЛЬШЕ: …» — после разбора блоков: передача, которую оно отправляет, уже должна лежать карточкой.
    if (!isOrch(key) && hasDecision(text))
        setTimeout(() => applyDecision(a, text).catch((e) => console.error("решение слота:", e.message)), 300);
    const edits = isOrch(key) ? 0 : turnEdits(a);
    // Агент правил код в этом ходе — прежние проверки устарели: автопоезд пройдёт станции заново (если ход не закончился
    // решением — тогда ведёт решение), без автопоезда — карточка «проверить».
    if (edits > 0 && agentCwd(key)) {
        keepCards((x) => !(x.kind === "verify" && x.tree === key));
        if (settings.autoTrain && !hasDecision(text))
            setTimeout(() => autoChain(key, "агент поправил код"), 5000);
        else if (!settings.autoTrain)
            addCard({ id: ibId(), kind: "verify", tree: key, edits, at: Date.now() });
    }
    saveInbox();
}

// ───────────────────────────── справка о слоте для оркестратора ─────────────────────────────

// Что оркестратор уже видел о каждом слоте (отпечаток кода, план, список красных): следующая справка идёт разностью.
// Файл читает boot.mjs при старте, поэтому разность переживает перезапуск.
export const RELAY_FACTS_FILE = path.join(DATA, "relay-facts.json");
export const lastRelay = new Map();

/** Запись файла фактов с задержкой 500 мс: несколько передач подряд дают одну запись. */
export function saveRelayFacts() {
    if (DRY)
        return;
    clearTimeout(S.relayFactsTimer);
    S.relayFactsTimer = setTimeout(() => saveJson(RELAY_FACTS_FILE, Object.fromEntries(lastRelay)), 500);
}

/**
 * Факты для вводной новой сессии оркестратора (prompt.mjs orchPrimer): строки слотов эпика по снимку, открытые вопросы
 * владельцу и тупики правил, ожидания влива по его слову и сообщения владельца, на которые старая сессия не ответила, —
 * целиком. Зовётся до остановки старой сессии: неотвеченное ищется в её ленте a. Ответы старой сессии сюда не берутся:
 * обрывки рассуждений новая сессия читала как действующие решения, а решения живут в файлах плана эпика.
 */
export function orchPrimerFacts(orch, a) {
    const ep = epicOfKey(orch), snap = snapNow(), cards = inboxCards();
    const slots = TREES.filter((t) => !isOrch(t.key) && t.epic === ep), tagOf = (k) => (treeByKey(k) || {}).tag || k;
    const keys = new Set([orch, ...slots.map((t) => t.key)]);
    const lines = slots.map((t0) => {
        const t = (snap && snap.trees.find((x) => x.key === t0.key)) || { ...t0, branch: t0.plannedBranch, exists: exists(t0.path), verdict: null };
        const ag = agents.get(t0.key), st = ag && !ag.dead ? (ag.busy ? "busy" : "idle") : agentSession(t0.key) ? "session" : "";
        const extra = [];
        if (cards.some((c) => c.kind === "relay" && c.tree === t0.key && c.to === orch))
            extra.push("его доклад тебе ждёт отправки — придёт следующим сообщением");
        if (cards.some((c) => c.kind === "relay" && c.tree === orch && c.to === t0.key))
            extra.push("твоя передача ему ждёт отправки");
        return slotStateLine({ ...t, tag: t0.tag, key: t0.key }, st, extra);
    });
    const questions = [
        ...cards.filter((c) => c.kind === "ownerq" && keys.has(c.tree)).map((c) => ({ who: c.tree === orch ? "твой" : tagOf(c.tree), text: c.text })),
        ...cards.filter((c) => c.kind === "deadlock" && (keys.has(c.tree) || c.to === orch)).map((c) => ({ who: "тупик правил", text: c.what + ": " + c.why })),
    ];
    const waits = mergeWaits().filter((w) => w.orch === orch).map((w) => "ВЛИТЬ " + (w.tag || tagOf(w.key)) + " — слово владельца в силе до " + hhmmOf(w.until) + "; " +
        (w.state === "red" ? "на паузе: " + (w.why || "красное на этом коде") : "ждёт зелёного: нет «" + (w.need || []).map((id) => MERGE_LABEL[id] || id).join("», «") + "»") + ".");
    const owner = [];
    for (let i = a.items.length - 1; i >= 0; i--) {
        const x = a.items[i];
        if (x.t === "assistant" && x.text && !x.live)
            break;
        if (x.t === "user" && x.owner && x.text)
            owner.unshift(x.text);
    }
    return { slots: lines, questions, waits, owner };
}

/** Забыть, что видел оркестратор эпика: после ротации его сессии новая сессия должна получить справки целиком. */
export function forgetRelayFacts(epicId) {
    for (const k of [...lastRelay.keys()])
        if (epicOfKey(k) === epicId)
            lastRelay.delete(k);
    saveRelayFacts();
}

// Шум в диффе для оркестратора: файлы блокировок пакетов, собранное, снимки тестов. В справку они идут только списком.
const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "go.sum", "Cargo.lock", "poetry.lock", "uv.lock", "composer.lock", "Gemfile.lock"];
export const DIFF_NOISE = [...LOCKFILES.map((f) => "*" + f), "**/dist/**", "**/*.snap"];
export const DIFF_NOISE_RE = new RegExp("(^|/)dist/|\\.snap$|(^|/)(" + LOCKFILES.map((f) => f.replace(/[.]/g, "\\.")).join("|") + ")$");

/**
 * Справка диспетчерской о слоте к передаче оркестратору: ветка, коммиты, незакоммиченное, станции, последние прогоны,
 * регресс, план волны, дифф, причины красного. Что оркестратор уже видел (lastRelay), не повторяется — factsDelta.
 * record=false — собрать, не запоминая как увиденное (предпросмотр).
 */
export async function slotFacts(key, record = true) {
    try {
        await rebuildFresh();
    }
    catch { }
    const t = snapNow() && snapNow().trees.find((x) => x.key === key);
    if (!t || !t.exists)
        return "";
    const prev = lastRelay.get(key);
    const v = t.verdict || {}, fwdp = (p) => String(p).replace(/\\/g, "/"), W = VERDICT_WORDS;
    const [st, df] = await Promise.all([git(t.path, ["status", "--porcelain"], 60000, true), git(t.path, ["diff", "--name-only", "staging...HEAD"])]);
    const dirty = (st.out || "").split("\n").filter((l) => l.trim() && !l.startsWith("??")).map((l) => l.slice(3));
    const added = (st.out || "").split("\n").filter((l) => l.startsWith("??")).map((l) => l.slice(3));
    const touched = [...new Set([...(df.out || "").split("\n").filter(Boolean), ...dirty, ...added])];
    const lastJob = (task, input) =>
        [...jobList()]
            .reverse()
            .find(
                (k) =>
                    k.tree === key &&
                    k.task === task &&
                    (input == null || (k.input || "") === input) &&
                    ["ok", "fail", "skipped"].includes(k.status),
            );
    const jl = (j) =>
        !j
            ? "не прогонялся"
            : ["running", "queued", "waiting"].includes(j.status)
              ? "идёт или в очереди, " + j.id
              : (j.status === "ok" ? "зелёный" : j.status === "fail" ? "УПАЛ" : j.na ? "неприменимо (тесты не запускались)" : "нет тестов") +
                (j.status === "ok" ? (jobFresh(j, t) === "ok" ? ", на текущем коде" : ", на ДРУГОМ коде") : "") +
                ", " +
                j.id +
                ", лог " +
                fwdp(logPath(j.id)) +
                (j.summary ? " — " + short(j.summary, 160) : "");
    const ses = digestSession({ to: orchOfKey(key), kind: "facts", seed: key + "|" + (t.fp || "") + "|" + (t.last ? t.last.sha : ""), settings, record });
    // Место правил сверки держим меткой: полные или короткие правила зависят от того, целиком ли справка, а это известно
    // только после factsDelta ниже. Правила — в начале, чтобы начало сообщения не плавало между передачами.
    const out = ["── Справка диспетчерской о слоте (факты на момент передачи, слот их не писал) ──", "@@RULES@@",
        "Слот " + t.tag + ". Ветка " + t.branch + ", HEAD " + (t.last ? t.last.sha + " «" + t.last.subject + "» (" + t.last.when + ")" : "?") + ". Папка " + fwdp(t.path) + ".",
        t.ahead ? "Впереди staging " + t.ahead + " коммит(а): " + (t.commits || []).map((c) => c[0] + " " + c[1]).join("; ") : "Впереди staging коммитов НЕТ.",
        dirty.length ? "Изменено и не закоммичено " + dirty.length + " файл(ов): " + dirty.slice(0, 12).join(", ") + (dirty.length > 12 ? " …" : "") : "Изменённых незакоммиченных нет.",
        added.length ? "Новые файлы вне git " + added.length + ": " + added.slice(0, 12).join(", ") + (added.length > 12 ? " …" : "") : "Новых файлов вне git нет.",
        "Станции: сборка — " + (W[v.build] || v.build) + "; тесты волны — " + (W[v.tests] || v.tests) + (v.note ? " (" + v.note + ")" : "") + "; гарды — " + (W[v.guards] || v.guards) + "."];
    const pairs = [["build", ""], ...(PRESETS[key] || []).map((p) => [p.task, p.input || ""]), ...guardIds().map((g) => [g, ""])];
    const seen = new Set(), runs = [];
    for (const [task, input] of pairs) {
        const k = task + "|" + input;
        if (seen.has(k))
            continue;
        seen.add(k);
        if (task === "build" && !t.buildNeeded)
            continue;
        runs.push("- " + ((TASKS[task] || {}).label || task) + (input ? " " + input : "") + ": " + jl(lastJob(task, input)));
    }
    out.push("Последние прогоны:", ...runs);
    // Регресс по тронутым областям: задачи области без ввода (весь набор), которых нет среди прогонов волны.
    const reg = [];
    for (const area of Object.values(PROJECT.areas)) {
        if (!touched.some((f) => matchAny(f, area.paths)))
            continue;
        for (const id of area.tasks)
            if (TASKS[id] && !TASKS[id].input && !GUARD_TASKS.has(id) && !seen.has(id + "|"))
                reg.push(area.title + ": " + TASKS[id].label + " — " + jl(lastJob(id, "")));
    }
    if ((t.regress || []).length)
        out.push(
            "Станция «Регресс» (соседи по тронутым путям): " + (W[v.regress] || v.regress) + ".",
            ...t.regress.map(
                (x) =>
                    "- " +
                    x.label +
                    (x.input ? " " + x.input : "") +
                    " (" +
                    x.why +
                    "): " +
                    jl(x.jobId ? jobList().find((k) => k.id === x.jobId) : null),
            ),
        );
    else if (reg.length)
        out.push("Регресс по тронутым путям (вне тестов волны):", ...reg.map((x) => "- " + x));
    const pend = (S.testReqs[key] || []).filter((r) => ["todo", "run", "stale"].includes(reqItemStatus(key, r, t).status));
    if (pend.length)
        out.push("Ждут прогона по просьбе слота: " + pend.map((r) => ((TASKS[r.task] || {}).label || r.task) + (r.input ? " " + r.input : "")).join(", "));
    const pf = planFileOf(t);
    let planBody = "";
    if (pf) {
        try {
            planBody = fs.readFileSync(pf, "utf8").replace(/^---[\s\S]*?\n---\n/, "").trim();
        }
        catch { }
    }
    const red = [...new Set(pairs.map(([task, input]) => lastJob(task, input)).filter((j) => j && j.status === "fail"))].slice(0, 3);
    const curSnap = await curSnapOf(t).catch(() => null);
    const cur = { planHash: crypto.createHash("sha1").update(planBody).digest("hex").slice(0, 12), fp: t.fp, snap: curSnap, reds: red.map((j) => j.id) };
    const d = factsDelta({ prev, cur });
    if (!d.full)
        out.push("", "(Справка — разностью с прошлой передачей этого слота: то, что ты уже видел, не повторяется. Целиком — в папке слота и логах по путям.)");
    if (!pf)
        out.push("", "ТЗ волны: файла плана " + (t.wave || "") + " не нашлось.");
    else if (d.plan)
        out.push("", "ТЗ волны — " + fwdp(pf) + (d.full ? "" : " (изменилось с прошлой справки)") + (planBody.length > 2500 ? " (начало, целиком — по пути)" : "") + ":", short(planBody, 2500));
    else
        out.push("", "ТЗ волны — " + fwdp(pf) + ": без изменений с прошлой справки.");
    try {
        const mb = ((await git(t.path, ["merge-base", "staging", "HEAD"])).out || "").trim();
        if (mb && touched.length && d.diff === "same")
            out.push("", "Правки ветки — те же, что в прошлой справке: код с неё не менялся.");
        else if (mb && touched.length) {
            const EXCL = ["--", ".", ...DIFF_NOISE.map((p) => ":(exclude)" + p)];
            const only = d.diff === "files" ? d.files.filter((f) => !DIFF_NOISE_RE.test(f)) : null;
            const [stat, patch] = await Promise.all([
                git(t.path, ["diff", "--stat=140", mb, ...EXCL], 60000),
                only
                    ? only.length
                        ? git(t.path, ["diff", "-U2", "--no-color", mb, "--", ...only], 60000)
                        : { out: "" }
                    : git(t.path, ["diff", "-U2", "--no-color", mb, ...EXCL], 60000),
            ]);
            const p = patch.out || "", CAP = 6000, whole = "целиком — git -C " + fwdp(t.path) + " diff " + mb.slice(0, 10);
            const untr = only ? only.filter((f) => added.includes(f)) : [];
            out.push(
                "",
                only
                    ? "Правки ветки против staging (весь список файлов; дифф — только " +
                          only.length +
                          " файл(ов), тронутых после прошлой справки" +
                          (untr.length ? "; из них новые вне git, их diff не покажет: " + untr.join(", ") : "") +
                          "):"
                    : "Правки ветки против staging (закоммиченное и незакоммиченное; новые файлы вне git — выше):",
                (stat.out || "").trim(),
                FENCE + "diff",
                p.length > CAP
                    ? ses.diff(
                          p,
                          p.slice(0, CAP) + "\n… (обрезано: всего " + p.length + " знаков; " + whole + ")",
                          "… (выжимка диффа: всего " + p.length + " знаков; " + whole + ")",
                      )
                    : p,
                FENCE,
            );
        }
    }
    catch (e) {
        out.push("", "Правки: не удалось собрать diff (" + e.message + ").");
    }
    for (const j of red) {
        if (!d.reds.includes(j.id)) {
            out.push("", "Причина красного — " + j.label + (j.input ? " " + j.input : "") + " (" + j.id + "): та же, что в прошлой справке; лог " + fwdp(logPath(j.id)) + ".");
            continue;
        }
        out.push("", "Причина красного — " + j.label + (j.input ? " " + j.input : "") + " (" + j.id + "):", FENCE + "text", ses.log(j.id, (raw) => failureExcerpt(raw, 1800), 1800), FENCE);
    }
    out[out.indexOf("@@RULES@@")] = d.full ? FACTS_RULES_FULL : FACTS_RULES_SHORT;
    if (record) {
        lastRelay.set(key, {
            ...(prev || {}),
            fp: t.fp,
            sha: t.last && t.last.sha,
            planHash: cur.planHash,
            snap: cur.snap,
            reds: [...new Set([...((prev && prev.reds) || []), ...cur.reds])].slice(-30),
            at: Date.now(),
        });
        saveRelayFacts();
    }
    const text = out.join("\n");
    ses.close(text);
    return text;
}

export { DECISION_HELP };
export { DECISION_RE };
// Слот → прогоны, которые перезапустить после сборки (решение «перепрогон» для задач, которые идут по собранному).
export const afterBuild = new Map();
// «Слот|задача|ввод» → отпечаток кода последнего перепрогона по решению: тот же код второй раз не гоняем.
export const rerunGuard = new Map();

/** Упавшие прогоны слота: последний по каждой паре «задача|ввод», кроме подготовки, влива и красного только в staging. */
export function unresolvedFails(key) {
    const by = new Map();
    for (const j of jobList())
        if (j.tree === key && !["slot-up", "merge"].includes(j.task))
            by.set(j.task + "|" + (j.input || ""), j);
    return [...by.values()].filter((j) => j.status === "fail" && !onlyStagingRed(j.id));
}

// Слот → когда ему последний раз ответили «доклад не передан»: агент, который снова ответил без блока, второй просьбы
// сразу не получает — иначе два хода подряд без блока дали бы пинг-понг диспетчерской с агентом.
const noBlockSeen = new Map();
const NO_BLOCK_EVERY_MS = 10 * 60e3;

/** Решение «передать», а блока доклада в ответе нет: не передавать ничего, агенту — просьба оформить блоком, в журнал — событие. */
function noBlock(a, to, note, now = Date.now()) {
    const key = a.key, again = now - (noBlockSeen.get(key) || 0) < NO_BLOCK_EVERY_MS;
    logEvent("relay.noblock", { tree: key, to: to.key, asked: !again });
    if (!again) {
        noBlockSeen.set(key, now);
        _orchSteps.send(key, prompt("relay-no-block", { to: to.tag }));
    }
    return note("доклад " + to.tag + " не передан: в ответе нет блока ```text" + (again ? " (просьба оформить блоком уже отправлена)" : " — агенту отправлена просьба оформить его блоком"));
}

/**
 * Кто отправил передачу — подпись в начале сообщения адресату. Подписи только здесь: раньше любая передача, и
 * автоматическая, подписывалась «кнопкой дашборда», и агент принимал решение автоматики за слово человека.
 * owner — кнопка человека на странице; agent — решение самого отправителя («ДАЛЬШЕ: …»); auto — автоматика диспетчерской
 * (автопоезд, очередь, передача после подготовки слота).
 */
export const RELAY_VIA = Object.freeze({ owner: "кнопкой владельца", agent: "по решению самого отправителя", auto: "диспетчерской автоматически" });

/**
 * Заголовок передачи: от кого и как передано. Начало «Ответ слота» у доклада оркестратору держим неизменным — по нему
 * loops.mjs orchWake узнаёт доклад и будит оркестратора. from, to — деревья (key, tag, branch).
 */
export function relayHead(via, { from, to }) {
    if (!Object.hasOwn(RELAY_VIA, via))
        throw new Error("передача: неизвестное происхождение «" + via + "»");
    const v = RELAY_VIA[via];
    if (isOrch(to.key))
        return prompt("relay-head-orch", { tag: from.tag, key: from.key, via: v });
    if (isOrch(from.key))
        return prompt("relay-head-slot", { via: v });
    return prompt("relay-head-peer", { tag: from.tag, key: from.key, branch: from.branch || from.plannedBranch || "?", via: v });
}

/** Сообщение передачи целиком: заголовок происхождения, блок и (оркестратору) справка диспетчерской — и ничего больше. */
export const relayMessage = ({ via, from, to, body, facts = "" }) => [relayHead(via, { from, to }), body, facts].filter(Boolean).join("\n\n");

/**
 * Исполнить решение слота из последних строк ответа: ПЕРЕПРОГОН — перезапустить упавшее (при автопоезде — через него,
 * сборка — раньше задач по собранному), ОРКЕСТРАТОРУ / СЛОТУ ПN — передать блок, ПРИНЯЛ / ЖДУ — только в журнал.
 */
export async function applyDecision(a, text) {
    const key = a.key, m = DECISION_RE.exec(text.split(/\r?\n/).slice(-6).join("\n"));
    if (!m)
        return;
    const word = m[1].toUpperCase(), note = (s) => {
        logEvent("slot.decision", { tree: key, word, detail: String(s).slice(0, 200) });
        return push(a, { id: "dec-" + a.rev + "-" + Math.random().toString(36).slice(2, 5), t: "status", text: "Диспетчерская: " + s });
    };
    if (/^(ПРИНЯЛ|ЖДУ)/.test(word))
        return logEvent("slot.decision", { tree: key, word, detail: "" });
    if (word.startsWith("ПЕРЕПРОГОН")) {
        const t = treeByKey(key), fails = unresolvedFails(key).filter((j) => j.task !== "review");
        if (!fails.length) {
            if (settings.autoTrain) {
                autoChain(key, "решение «перепрогон»");
                return note("перепрогон: автопоезд пойдёт с первой непройденной станции (сборка → гарды → тесты → ревью → регресс → коммит)");
            }
            return note("решение «перепрогон», но упавших прогонов нет");
        }
        const fp = await codeFp(t.path, true), todo = fails.filter((j) => {
            const g = key + "|" + j.task + "|" + (j.input || "");
            if (j.fpEnd === fp && rerunGuard.get(g) === fp)
                return false;
            rerunGuard.set(g, fp);
            return true;
        });
        if (!todo.length)
            return note("код не менялся с прошлого перезапуска по решению — второй раз то же самое не гоню. Поправь код или передай оркестратору.");
        if (rerunByChain({ autoTrain: settings.autoTrain, off: autoTrainOffFor(key), todo: todo.length })) {
            autoChain(key, "решение «перепрогон» после правок");
            return note("перепрогон после правок: автопоезд перегонит только красные и задетые правкой сьюты (" + todo.map((j) => j.label).join(", ") + "), а не упавшие прогоны целиком");
        }
        const snapT = snapNow() && snapNow().trees.find((x) => x.key === key), bj = [...jobList()].reverse().find((k) => k.tree === key && k.task === "build" && ["ok", "fail"].includes(k.status));
        const needBuild = todo.some((j) => DIST_TASKS.has(j.task)) && snapT && snapT.buildNeeded && !(bj && bj.status === "ok" && bj.fpEnd === fp);
        if (needBuild) {
            afterBuild.set(key, todo.map((j) => ({ task: j.task, input: j.input || "" })));
            await runTask(key, "build", "").catch((e) => note("сборка не встала в очередь: " + e.message));
            return note("собираю, потом перезапущу: " + todo.map((j) => j.label).join(", "));
        }
        for (const j of todo)
            await runTask(key, j.task, j.input || "").catch((e) => note("не встало в очередь: " + j.label + " — " + e.message));
        return note("перезапускаю после правок: " + todo.map((j) => j.label + (j.input ? " " + j.input : "")).join(", "));
    }
    if (word.startsWith("ОРКЕСТРАТОРУ") || word.startsWith("СЛОТУ")) {
        const ep = epicOfKey(key), to = word.startsWith("СЛОТУ") ? TREES.find((x) => (x.epic === ep && x.tag === m[2]) || x.key === m[2]) : treeByKey(orchOfKey(key));
        if (!to || to.key === key)
            return note("адресат «" + (m[2] || "") + "» не найден — передайте вручную");
        // Карточки нет, когда блока не было или relayDecision счёл доклад «нечего передавать». Явное решение агента сильнее
        // этого фильтра: фильтр отсеивает доклады, которые слот не адресовал, а «ДАЛЬШЕ: ОРКЕСТРАТОРУ» — адресовал. Но уходит
        // только блок: остальной ответ — рассуждения и пересказ инструментов, и обрезок его конца адресат читал как доклад.
        let card = inboxCards().find((x) => x.kind === "relay" && x.tree === key);
        if (!card) {
            const body = reportBlockOf(text);
            if (!body)
                return noBlock(a, to, note);
            card = { id: ibId(), kind: "relay", tree: key, text: body, at: Date.now() };
            addCard(card);
        }
        noBlockSeen.delete(key);
        card.to = to.key;
        card.toTag = to.tag;
        saveInbox();
        const r = await doRelay(key, to.key, card.text, false, false, "agent").catch((e) => ({ code: 500, body: { error: e.message } }));
        return note(
            r.code === 200
                ? "передано " + to.tag + " само, по решению слота"
                : r.code === 202
                  ? "в очереди к " + to.tag + ": уйдёт само, когда он допишет ответ"
                  : r.body && r.body.already
                    ? "не передано " + to.tag + ": " + r.body.error + " — повторно не шлю"
                    : "не передано " + to.tag + " (" + (r.body && r.body.error) + "): карточка ждёт кнопку",
        );
    }
}

// ───────────────────────────── передачи ─────────────────────────────

// Хеши уже переданных блоков (последние 400): разбор того же ответа повторно (перезапуск, повторный ход) не передаёт
// блок второй раз.
export const RELAY_SENT_FILE = path.join(DATA, "relay-sent.json");
export const relaySentList = () => S.relaySent;

export function loadRelaySent() {
    S.relaySent = readJson(RELAY_SENT_FILE, []) || [];
}

export function loadTestReqs() {
    S.testReqs = readJson(TREQ_FILE, {}) || {};
    S.presetsExtra = readJson(PRESETS_X_FILE, {}) || {};
}

export const relayNorm = (s) => String(s || "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd()).join("\n").trim();

/** Хеш передачи (FNV-1a) по отправителю, получателю и тексту без хвостовых пробелов и разницы переводов строк. */
export function relayHash(from, to, text) {
    let h = 0x811c9dc5;
    const s = from + ">" + to + "\n" + relayNorm(text);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

export function markRelaySent(h) {
    if (S.relaySent.includes(h))
        return;
    S.relaySent.push(h);
    if (S.relaySent.length > 400)
        S.relaySent = S.relaySent.slice(-400);
    saveJson(RELAY_SENT_FILE, S.relaySent);
}

/**
 * Передать блок агенту → { code, body }: 200 — передан, 202 — в очереди (адресат отвечает, пачка к оркестратору,
 * папка слота готовится), 409 — уже передан или передаётся, 404/400 — нет адресата или текст не годится.
 * force — передать повторно уже переданный; now — без пачки и без ожидания подготовки к перезапуску.
 * via — кто отправил (RELAY_VIA): по умолчанию автоматика — «кнопкой» подписывает только тот, кто передал признак кнопки.
 */
export async function doRelay(from, to, text, force, now = !!force, via = "auto") {
    text = String(text || "").trim();
    if (to === "orchestrator")
        to = orchOfKey(from) || to;
    const rh = relayHash(from, to, text);
    if (!force && S.relaySent.includes(rh)) {
        keepCards((x) => !(x.kind === "relay" && x.tree === from && x.to === to && relayHash(from, to, x.text) === rh));
        saveInbox();
        return { code: 409, body: { error: "этот блок уже передан", already: true, hash: rh } };
    }
    if (!agentCwd(from))
        return { code: 404, body: { error: "нет такого слота" } };
    const slotTo = !isOrch(to) && (treeByKey(to) || {}).kind === "slot";
    if (!agentCwd(to) && !slotTo)
        return { code: 404, body: { error: "нет такого слота" } };
    if (from === to)
        return { code: 400, body: { error: "отправитель и получатель — один и тот же агент" } };
    if (text.length < 3 || text.length > 30000)
        return { code: 400, body: { error: "текст передачи: от 3 до 30000 знаков" } };
    // Кнопка и автопередача могут отправить один блок одновременно: пока передача идёт, вторая отказывает. Пометка
    // sending у карточки — для страницы.
    if (relayFlight.has(rh))
        return { code: 409, body: { error: "этот блок уже передаётся", already: true, hash: rh } };
    relayFlight.add(rh);
    for (const x of inboxCards())
        if (x.kind === "relay" && x.tree === from && x.to === to && relayHash(from, to, x.text) === rh)
            x.sending = Date.now();
    try {
        return await relayNow(from, to, text, rh, now, via);
    }
    finally {
        relayFlight.delete(rh);
        for (const x of inboxCards())
            if (x.sending && relayHash(x.tree, x.to, x.text) === rh)
                delete x.sending;
    }
}

export const relayFlight = new Set();

/** Адресат ещё не готов (папка слота готовится, план — заготовка): карточка ждёт, relayAfterPrep отправит её сама. */
function relayWaitPrep(from, to, text, why, until = "когда подготовка кончится", via = "auto") {
    const tt = treeByKey(to);
    let card = inboxCards().find((x) => x.kind === "relay" && x.tree === from && x.to === to && relayNorm(x.text) === relayNorm(text));
    if (!card) {
        card = { id: ibId(), kind: "relay", tree: from, to, toTag: tt.tag, text, at: Date.now() };
        addCard(card);
    }
    // Происхождение едет с карточкой: отложенная передача уходит потом с той же подписью, что при отправке.
    card.via = via;
    if (!card.waitPrep)
        logEvent("relay.waitprep", { from, to, why });
    card.waitPrep = card.waitPrep || Date.now();
    card.queued = 0;
    card.note = why + " у " + tt.tag + ": передача уйдёт сама, " + until + (isOrch(from) ? " (агент слота запустится со стартовым промптом)" : "");
    saveInbox();
    return { code: 202, body: { ok: true, queued: true, waitPrep: true, toTag: tt.tag } };
}

/** По таймеру: отправить передачи, ждавшие подготовки слота, когда подготовка кончилась и план заполнен. */
export function relayAfterPrep() {
    if (DRY)
        return;
    for (const x of inboxCards().filter((c) => c.kind === "relay" && c.waitPrep)) {
        if (!agentCwd(x.to) || slotPreparing(x.to) || stubHold(x.to) || relayFlight.has(relayHash(x.tree, x.to, x.text)))
            continue;
        delete x.waitPrep;
        x.note = "";
        saveInbox();
        doRelay(x.tree, x.to, x.text, false, false, x.via).then((r) => {
            if (r.code >= 400 && r.code !== 409) {
                x.note = "после подготовки не ушло: " + ((r.body && r.body.error) || r.code) + " — отправьте кнопкой";
                saveInbox();
            }
        }).catch((e) => console.error("передача после подготовки:", e.message));
    }
}

// Агента слота не запускаем, пока план волны — заготовка: со стартовым промптом без плана он начнёт работу вслепую.
const stubHold = (to) => {
    const a = agents.get(to), t = snapNow() && snapNow().trees.find((z) => z.key === to);
    return !!t && startHeldByStub({ kind: t.kind, live: !!(a && !a.dead), session: !!agentSession(to), stub: planIsStubOf(t) });
};

/**
 * Доставка передачи (doRelay уже проверил адресата и повторы). Слоту без агента и сессии — сначала стартовый промпт,
 * передача — следом из очереди. Оркестратору доклады копятся ORCH_GATHER_MS и уходят пачкой, со справкой о слоте.
 */
export async function relayNow(from, to, text, rh, now = false, via = "auto") {
    const tf = treeByKey(from), tt = treeByKey(to);
    let a = agents.get(to), start = "";
    if (!isOrch(to) && tt && tt.kind === "slot") {
        // startText, а не prompt: имя prompt занято импортом из prompts.mjs (сборка подсказок из файлов).
        const startText = !(a && !a.dead) && !agentSession(to) ? slotPromptText(to) : "";
        const d = relayToSlot({ folder: !!agentCwd(to), preparing: slotPreparing(to), live: !!(a && !a.dead), session: !!agentSession(to), prompt: !!startText });
        if (d.act === "wait")
            return relayWaitPrep(from, to, text, d.why, undefined, via);
        if (d.act === "start" && stubHold(to)) {
            const sa = agents.get(from);
            if (sa && !sa.dead && isOrch(from))
                push(sa, {
                    id: "stub-" + sa.rev,
                    t: "status",
                    text:
                        tt.tag +
                        ": план волны — заготовка, агент слота не запущен. Заполните план (источник, решения, станции, манифест) — передача уйдёт сама.",
                });
            return relayWaitPrep(from, to, text, "план волны — заготовка", "когда план будет заполнен", via);
        }
        if (d.act === "start")
            start = startText;
    }
    if (!a || a.dead)
        a = await ensureAgent(to);
    if (start) {
        deliver(a, start);
        startOffered.add(to);
        keepCards((x) => !(x.kind === "slotstart" && x.tree === to));
        saveInbox();
        logEvent("slot.autostart", { key: to, from, chars: start.length });
        const sa = agents.get(from);
        if (sa && !sa.dead)
            push(sa, { id: "ast-" + sa.rev, t: "status", text: tt.tag + ": агента не было — запущен со стартовым промптом, передача уйдёт следом." });
    }
    // Встать в очередь к адресату: карточка с пометкой времени, место в очереди — по времени постановки.
    const queueIt = (gather = false) => {
        let card = inboxCards().find((x) => x.kind === "relay" && x.tree === from && x.to === to && relayNorm(x.text) === relayNorm(text));
        if (!card) {
            card = { id: ibId(), kind: "relay", tree: from, to, toTag: tt.tag, text, at: Date.now() };
            addCard(card);
        }
        // drainQueued и пачка подпишут передачу по карточке: кто отправил, тот и остаётся отправителем после очереди.
        card.via = via;
        if (!card.queued)
            card.queued = Date.now();
        if (gather)
            card.gather = true;
        const pos = inboxCards().filter((x) => x.kind === "relay" && x.to === to && x.queued && x.queued <= card.queued).length;
        card.note = gather
            ? "собирается пачка к " +
              tt.tag +
              ": уйдёт через ~" +
              Math.round(ORCH_GATHER_MS / 1000) +
              " с вместе с попутными докладами"
            : drainState()
              ? "диспетчерская готовится к перезапуску: уйдёт после него"
              : "в очереди к " + tt.tag + " (" + pos + "-я): уйдёт сама, когда он допишет ответ";
        saveInbox();
        const sa = agents.get(from);
        if (sa && !sa.dead)
            push(sa, {
                id: "rq-" + sa.rev,
                t: "status",
                text: gather
                    ? "Доклад ждёт попутных (до " +
                      Math.round(ORCH_GATHER_MS / 1000) +
                      " с) и уйдёт " +
                      tt.tag +
                      " одной пачкой."
                    : "В очереди к " + tt.tag + " (" + pos + "-я): он сейчас отвечает, передача уйдёт сама.",
            });
        logEvent("relay.queued", { from, to, gather, pos });
        return { code: 202, body: { ok: true, queued: true, pos, toTag: tt.tag } };
    };
    if (start)
        return queueIt();
    if (drainState() && !now)
        return queueIt();
    if (a.busy && !a.pinging)
        return queueIt();
    // Доклады оркестратору собираются в пачку: каждый отдельный ход оркестратора дорог (он перечитывает весь контекст).
    if (isOrch(to) && !now && ORCH_GATHER_MS > 0) {
        const r = queueIt(true);
        setTimeout(() => drainQueued(to), ORCH_GATHER_MS + 500);
        return r;
    }
    if (isOrch(to))
        // Ротация сессии оркестратора — до сбора справки: новая сессия забыла увиденное, справка для неё должна быть полной.
        a = await rotateOrchIfDue(a);
    let facts = "";
    if (isOrch(to)) {
        try {
            facts = await slotFacts(from);
        }
        catch (e) {
            facts = "── Справку диспетчерской собрать не удалось: " + e.message + " ──";
        }
        // Запомнить «ЖДУ» и просьбы слота из доклада: по ним loops.mjs решает, будить ли оркестратора и стоит ли слот.
        const lr = lastRelay.get(from);
        if (lr) {
            lr.wait = waitsHead(text);
            lr.asks = slotAsks(text);
            saveRelayFacts();
        }
    }
    if (a.busy && !a.pinging)
        return queueIt();
    deliver(a, relayMessage({ via, from: tf, to: tt, body: text, facts }));
    if (!isOrch(to)) {
        try {
            const rq = parseRunRequests(text);
            if (rq.length) {
                setTestReqs(to, rq);
                dropSnap();
                rebuild().catch(() => { });
            }
        }
        catch { }
    }
    const sa = agents.get(from);
    if (sa && !sa.dead)
        push(sa, { id: "rel-" + sa.rev, t: "status", text: "Передано: " + tf.tag + " → " + tt.tag + " (" + text.length + " знаков)." });
    keepCards((x) => !(x.kind === "relay" && x.tree === from && x.to === to && x.text === text));
    saveInbox();
    const r = recordRelay(from, to, text.length);
    markRelaySent(rh);
    logEvent("relay.sent", { from, to, chars: text.length, hash: rh, batched: false, now, via });
    return { code: 200, body: { ok: true, relay: r, hash: rh, to: agentPublic(to) } };
}

// ───────────────────────────── итоги прогонов агенту слота ─────────────────────────────

/**
 * Сообщение агенту с итогами прогонов: строка на прогон, у красных — причина (выжимка лога; красное staging и
 * нестабильные спеки помечены, чтобы агент их не разбирал), у зелёных — подсказка следующей станции.
 */
export function resultsText(ids, { to = "", record = true } = {}) {
    const js = ids.map((id) => jobList().find((j) => j.id === id)).filter(Boolean), key = to || (js[0] && js[0].tree) || "";
    const ses = digestSession({ to: key, kind: "results", seed: js.map((j) => j.id).join(","), settings, record });
    const legacy = (raw) => failureExcerpt(raw, 3500);
    const word = { ok: "ЗЕЛЁНЫЙ", fail: "УПАЛ", skipped: "НЕТ ТЕСТОВ (шаблон не совпал ни с одним сьютом)" };
    const lines = js.map(
        (j) =>
            "- " +
            j.label +
            (j.input ? " — " + j.input : "") +
            ": " +
            (j.na ? "НЕПРИМЕНИМО — тесты не запускались" : word[j.status] || j.status) +
            ", " +
            Math.round(((j.endedAt || Date.now()) - (j.startedAt || Date.now())) / 1000) +
            " с" +
            (j.summary ? ". " + j.summary : ""),
    );
    const bad = js.filter((j) => j.status === "fail").map((j) => {
        if (j.task === "review")
            return (
                "── Ревью: замечания независимого ревьюера (сессия без твоего контекста, только чтение) ──\n" +
                (j.review && j.review.text ? ses.review(j.id, j.review.text, j.review.text) : ses.log(j.id, legacy)) +
                "\nРазбери по пунктам: согласен — поправь; не согласен — коротко почему (это уйдёт владельцу)."
            );
        const sp = failingSpecs(j.id),
            known = sp.filter((f) => onStagingRed(f) && inheritedRed(j, f)),
            flaky = sp.filter((f) => !onStagingRed(f) && inheritedRed(j, f)),
            own = sp.filter((f) => !inheritedRed(j, f));
        const note = [known.length ? "Красные И В САМОМ staging (их чинит отдельная волна, тебе не вменяются, не разбирай): " + known.join(", ") : "",
            flaky.length ? "Нестабильные (на том же коде и падали, и проходили — в карантине, не разбирай): " + flaky.join(", ") : "",
            (known.length || flaky.length) && own.length ? "Остальное — смотри: " + own.join(", ") : ""].filter(Boolean).join("\n");
        if ((known.length || flaky.length) && !own.length)
            return "── " + j.label + ": упало только известное красное staging или нестабильное ──\n" + note;
        let grp = "";
        try {
            const fam = SUITE_FAM[j.task];
            grp = redGroupNote({
                own,
                carry: fam
                    ? redCarryOf(j.tree, "", { exceptJob: j.id })
                          .filter((x) => x.fam === fam)
                          .map((x) => x.spec)
                    : [],
                violations: sp.length ? [] : guardViolations(readLog(j.id)),
            });
        }
        catch { }
        return "── " + j.label + ": причина ──\n" + (note ? note + "\n" : "") + (grp ? grp + "\n" : "") + ses.log(j.id, legacy);
    });
    for (const j of js)
        if (j.na)
            bad.push(naAdvice(j.label, j.input || "", { line: j.na, list: j.naList || [] }));
    const msg = resultsMessage({ lines, bad, hint: js.some((j) => j.status === "fail") ? "" : nextHint(snapNow() && js[0] && snapNow().trees.find((x) => x.key === js[0].tree)) });
    ses.close(msg);
    return msg;
}


/**
 * Совет по красному прогону для страницы → { act, text } (undefined — прогон не красный). Сначала причины «делать нечего»
 * (унаследованное, служебное, позже прошло, фильтр снят), потом «уже идёт», потом «код поменялся», и последним — «отдайте
 * причину агенту».
 */
export function failAdvice(j) {
    if (j.status !== "fail")
        return undefined;
    const t = snapNow() && snapNow().trees.find((x) => x.key === j.tree);
    const specs = failingSpecs(j.id);
    if (specs.length && specs.every((f) => inheritedRed(j, f)))
        return {
            act: "inherited",
            text: "Упало только известное: красное в самом staging (его чинит отдельная волна) или нестабильная спека в карантине. Слоту не вменяется, делать ничего не нужно.",
        };
    if (j.train)
        return { act: "inherited", text: "Поезд влива: итог и деление состава — в карточке поезда." };
    if (j.baseline)
        return { act: "inherited", text: "Сверка со staging: служебный прогон, его итог уже учтён в станции «Регресс» слотов и в карточке красного staging." };
    {
        const later = jobList().find(
            (k) =>
                k.tree === j.tree &&
                k.task === j.task &&
                k.status === "ok" &&
                (k.queuedAt || 0) > (j.queuedAt || 0) &&
                jobCovers(k, { task: j.task, input: j.input || "" }),
        );
        if (later)
            return { act: "inherited", text: "Позже тот же прогон прошёл зелёным (" + later.id + ")." };
    }
    if (specs.length) {
        const end = j.endedAt || 0, pref = j.tree + ":", passedLater = (f) => (specHistMap()[f] || []).some((x) => x.ok && x.at > end && String(x.code).startsWith(pref));
        if (specs.every((f) => inheritedRed(j, f) || passedLater(f)))
            return {
                act: "inherited",
                text:
                    "Каждая упавшая здесь спека позже прошла в этом слоте" +
                    (specs.some(knownRed) ? " или красная в самом staging" : "") +
                    ": прогон устарел, делать ничего не нужно.",
            };
    }
    if (!t || /^orchestrator/.test(j.tree))
        return { act: "log", text: "Посмотрите лог" };
    if (t.train && !t.ahead && !t.dirtyTracked && !t.dirtyUntracked)
        return { act: "obsolete", text: "Код поезда целиком в staging: старое падение ничего не значит (staging проверяет свой полный прогон)." };
    if (TEST_TASKS.has(j.task) && /совпало имён 0 из/.test(j.summary || "")) {
        const inWave = (PRESETS[j.tree] || []).some((p) => p.task === j.task && (p.input || "") === (j.input || ""));
        return inWave
            ? {
                  act: "log",
                  text:
                      "Фильтр не нашёл ни одной спеки: перепрогон даст то же. Смените фильтр тестов волны: node " +
                      EPIC_CLI +
                      " presets " +
                      (t.tag || "ПN") +
                      " " +
                      j.task +
                      "=<фильтр>.",
              }
            : {
                  act: "obsolete",
                  text: "Фильтр не нашёл ни одной спеки и уже снят с тестов волны: прогон устарел, делать ничего не нужно.",
              };
    }
    {
        const act = jobList().filter((k) => k.tree === j.tree && ["running", "queued", "waiting"].includes(k.status));
        if (act.length)
            return {
                act: "busy",
                text:
                    "Уже идёт: " +
                    act.map((k) => k.label + (k.status === "running" ? "" : " (в очереди)")).join(", ") +
                    (afterBuild.has(j.tree) ? "; после сборки перезапущу упавшее" : "") +
                    ". Карточка обновится сама.",
            };
    }
    {
        const ag = agents.get(j.tree);
        if (ag && ag.busy && !ag.pinging && j.reported)
            return { act: "agent", text: "Агент слота разбирает падение. Когда закончит, его решение («ДАЛЬШЕ: …») исполнится само." };
    }
    {
        const later = jobList().find((k) => k.tree === j.tree && k.task === j.task && (k.input || "") === (j.input || "") && k.status === "ok" && (k.endedAt || 0) > (j.endedAt || 0));
        if (later)
            return { act: "obsolete", text: "Позже тот же прогон прошёл (" + later.id + "): падение устарело, делать ничего не нужно." };
    }
    if (t.fp && j.fpEnd && t.fp !== j.fpEnd) {
        const bj = [...jobList()].reverse().find((k) => k.tree === t.key && k.task === "build" && ["ok", "fail"].includes(k.status));
        if (DIST_TASKS.has(j.task) && t.buildNeeded && !(bj && bj.status === "ok" && jobFresh(bj, t) === "ok"))
            return { act: "build", text: "Код поменялся после падения, а тесты этой задачи идут по собранному: сначала сборка, потом перепрогон (автопоезд перезапустит тесты сам)." };
        return { act: "rerun", text: "Код поменялся после падения: перепрогоните, старый красный уже ничего не значит." };
    }
    if (TEST_TASKS.has(j.task) && !specs.length && DIST_TASKS.has(j.task) && t.buildNeeded)
        return { act: "build", text: "До тестов не дошло (ни одной упавшей спеки): скорее всего не собрано. Соберите и перепрогоните." };
    const reply = inboxCards().find((x) => x.kind === "relay" && x.tree === j.tree && isOrch(x.to) && x.at > (j.reportedAt || j.endedAt || 0));
    if (reply)
        return { act: "relay", ib: reply.id, text: "Агент разобрал падение и ответил оркестратору: передайте ответ (код не менялся — значит, он считает падение не своим или ждёт решения)." };
    if (j.reported)
        return { act: "wait", text: "Причина уже у агента" + (j.reportedVia === "auto" ? " (автоотчёт)" : "") + ": ждём правку кода или его ответ. Перепрогонять пока нечего — код тот же." };
    return { act: "report", text: "Отдайте причину агенту слота." };
}

// Слот → итоги прогонов, ещё не отданные агенту. Прогоны одной станции кончаются почти вместе: копим 5 с и отдаём одним
// сообщением, а не ходом на каждый.
export const resultQ = new Map();

export function queueResult(job) {
    if (!["ok", "fail", "skipped"].includes(job.status) || job.task === "slot-up" || job.task === "commit" || job.task === "accept-ask")
        return;
    const t = treeByKey(job.tree);
    if (!t || /^orchestrator/.test(t.key) || !agentCwd(t.key))
        return;
    const q = resultQ.get(t.key) || { ids: [], timer: null };
    q.ids.push(job.id);
    clearTimeout(q.timer);
    q.timer = setTimeout(() => flushResults(t.key, 0), 5000);
    resultQ.set(t.key, q);
}

export function markReported(ids, via = "button") {
    for (const id of ids) {
        const j = jobList().find((x) => x.id === id);
        if (j) {
            j.reported = true;
            j.reportedAt = Date.now();
            j.reportedVia = via;
        }
    }
    save();
}

export function resultCard(key, ids) {
    const old = inboxCards().find((x) => x.kind === "result" && x.tree === key), all = [...new Set([...(old ? old.jobs : []), ...ids])];
    keepCards((x) => !(x.kind === "result" && x.tree === key));
    addCard({ id: old ? old.id : ibId(), kind: "result", tree: key, jobs: all, at: Date.now() });
    saveInbox();
}

/**
 * Отдать накопленные итоги: пока у слота идут прогоны — ждём (до 20 минут), чтобы агент получил итог станции целиком.
 * Зелёное при автопоезде агенту не шлём (автопоезд едет сам); красное при мёртвом агенте — поднимаем агента; агент занят —
 * ждём до 10 минут, потом карточка; автоотчёты выключены — карточка.
 */
export function flushResults(key, tries) {
    const q = resultQ.get(key);
    if (!q)
        return;
    if (drainState()) {
        q.timer = setTimeout(() => flushResults(key, tries), 10000);
        return;
    }
    if (tries < 240 && jobList().some((j) => j.tree === key && ["running", "queued", "waiting"].includes(j.status))) {
        q.timer = setTimeout(() => flushResults(key, tries + 1), 5000);
        return;
    }
    const a = agents.get(key);
    const curFp = ((snapNow() && snapNow().trees.find((x) => x.key === key)) || {}).fp || "";
    const redNow = q.ids.some((id) => {
        const j = jobList().find((x) => x.id === id);
        return j && j.status === "fail" && !onlyStagingRed(j.id) && !staleRed(j, curFp);
    });
    // Красное только в staging или на устаревшем коде не считается: агенту чинить нечего.
    if (settings.autoTrain && !redNow) {
        resultQ.delete(key);
        markReported(q.ids, "green-auto");
        logEvent("results.green", { tree: key, n: q.ids.length });
        const old = inboxCards().find((x) => x.kind === "result" && x.tree === key);
        if (old) {
            keepCards((x) => x !== old);
            saveInbox();
        }
        if (a)
            push(a, { id: "grn-" + a.rev, t: "status", text: "Итог прогонов зелёный (" + q.ids.length + "): агенту не отправляю — автопоезд едет дальше сам." });
        return;
    }
    if (settings.autoTrain && redNow && (!a || a.dead)) {
        resultQ.delete(key);
        sendBatch(key, q.ids).then((r) => {
            if (r.code !== 200)
                resultCard(key, q.ids);
            else
                logEvent("results.sent", { tree: key, n: r.body.batched, via: "wake" });
        }).catch(() => resultCard(key, q.ids));
        return;
    }
    if (!settings.autoResults || !a || a.dead) {
        resultCard(key, q.ids);
        resultQ.delete(key);
        return;
    }
    if (a.busy && !a.pinging) {
        if (tries < 60)
            q.timer = setTimeout(() => flushResults(key, tries + 1), 10000);
        else {
            resultCard(key, q.ids);
            resultQ.delete(key);
        }
        return;
    }
    const old = inboxCards().find((x) => x.kind === "result" && x.tree === key), ids = [...new Set([...(old ? old.jobs : []), ...q.ids])];
    if (old) {
        keepCards((x) => x !== old);
        saveInbox();
    }
    resultQ.delete(key);
    deliver(a, resultsText(ids, { to: key }), "results");
    markReported(ids, "auto");
    logEvent("results.sent", { tree: key, n: ids.length, via: "auto" });
    push(a, { id: "auto-" + a.rev, t: "status", text: "Автоотчёт: итог прогонов (" + ids.length + ") отправлен агенту одним сообщением." });
}

// ───────────────────────────── карточки «Ждут вашего действия» ─────────────────────────────

/** Почему карточка больше не нужна (строка) или "" — нужна. Карточки «результат» по пути сужаются до неотданных прогонов. */
export function inboxStale(x) {
    if (x.tree && !/^orchestrator/.test(x.tree) && !treeByKey(x.tree) && !epicOfKey(x.tree))
        return "слота больше нет";
    const same = (a, b) => a.tree === b.tree && a.task === b.task && (a.input || "") === (b.input || "");
    switch (x.kind) {
        case "slotstart": {
            const ap = agentPublic(x.tree);
            return ap.running || ap.hasLast ? "агент уже запущен" : "";
        }
        case "verify": return settings.autoTrain ? "проверит автопоезд" : jobList().some((j) => j.tree === x.tree && j.task !== "build" && j.queuedAt > x.at) ? "тесты запущены" : "";
        case "result": {
            const left = (x.jobs || []).filter((id) => {
                const j = jobList().find((k) => k.id === id);
                return j && !j.reported && !jobList().some((k) => k !== j && same(k, j) && (k.queuedAt || 0) > (j.queuedAt || 0));
            });
            if (!left.length)
                return "эти прогоны уже у агента или перепрогнаны";
            const lj = left.map((id) => jobList().find((k) => k.id === id)), end = Math.max(...lj.map((j) => j.endedAt || 0));
            const moved =
                ((agentSession(x.tree) || {}).at || 0) > end + 5000 ||
                jobList().some(
                    (k) =>
                        k.tree === x.tree &&
                        ["commit", "merge"].includes(k.task) &&
                        k.status === "ok" &&
                        (k.endedAt || 0) > end,
                );
            if (lj.every((j) => ["ok", "skipped"].includes(j.status)) && moved)
                return "всё зелёное, слот уже ушёл дальше";
            x.jobs = left;
            return "";
        }
        case "stgred": return (x.specs || []).some((f) => stgRedMap()[f]) ? "" : "эти спеки staging уже зелёные";
        case "relay": return x.to && S.relaySent.includes(relayHash(x.tree, x.to, x.text))
            ? "уже передано"
            : /дважды вернулось с вопросами/.test(x.text || "") &&
                jobList().some(
                    (j) =>
                        j.tree === x.tree &&
                        j.task === "review" &&
                        j.review &&
                        j.review.verdict === "ЗА" &&
                        (j.endedAt || 0) > x.at,
                )
              ? "новое ревью — ЗА"
              : isOrch(x.to) && !isOrch(x.tree) && waitsHead(x.text) && !SLOT_ASKS_RE.test(x.text || "")
                ? "«ЖДУ» без просьб к оркестратору"
                : "";
        default: return "";
    }
}

/** Карточки для страницы: устаревшие убираются, у передачи — превью и признак «уходит сама» (автопоезд, первая минута). */
export function inboxPublic() {
    const n0 = inboxCards().length;
    keepCards((x) => !inboxStale(x));
    if (inboxCards().length !== n0)
        saveInbox();
    for (const x of inboxCards())
        if (x.epic === undefined)
            x.epic = epicOfKey(x.tree);
    return inboxCards().map((x) => ({
        id: x.id,
        epic: x.epic,
        specs: x.specs,
        task: x.task,
        input: x.input,
        jobId: x.jobId,
        tag: x.tag,
        kind: x.kind,
        tree: x.tree,
        to: x.to,
        toTag: x.toTag,
        at: x.at,
        edits: x.edits,
        note: x.note || "",
        sending:
            x.kind === "relay" &&
            ((!!x.sending && relayFlight.has(relayHash(x.tree, x.to, x.text))) ||
                (!!settings.autoTrain && !x.note && !x.queued && Date.now() - x.at < 60000)),
        queued: !!(x.kind === "relay" && x.queued),
        len: x.text ? x.text.length : 0,
        preview: x.text ? x.text.slice(0, 240) : "",
        full: x.kind === "ownerq" ? x.text : undefined,
        // Карточка тупика правил рисуется по своим полям (ui/tasks.js): без них страница показывала «» и «undefined раза».
        ...(x.kind === "deadlock" ? { what: x.what || "", why: x.why || "", n: x.n || 0, since: x.since || x.at } : {}),
        jobIds: x.jobs || [],
        jobs: (x.jobs || [])
            .map((id) => {
                const j = jobList().find((k) => k.id === id);
                return j ? { label: j.label, input: j.input || "", status: j.status } : null;
            })
            .filter(Boolean),
    }));
}

/** Отдать агенту слота все итоги из карточки и очереди одним сообщением (кнопка или пробуждение агента автопоездом). */
export async function sendBatch(tree, extraIds = []) {
    const card = inboxCards().find((x) => x.kind === "result" && x.tree === tree), q = resultQ.get(tree);
    const ids = [...new Set([...(card ? card.jobs : []), ...(q ? q.ids : []), ...extraIds])];
    if (!ids.length)
        return { code: 404, body: { error: "нечего отправлять" } };
    let a = agents.get(tree);
    if (!a || a.dead)
        a = await ensureAgent(tree);
    if (a.busy && !a.pinging)
        return { code: 409, body: { error: "агент сейчас отвечает: дождитесь конца ответа" } };
    if (q) {
        clearTimeout(q.timer);
        resultQ.delete(tree);
    }
    if (card) {
        keepCards((x) => x !== card);
        saveInbox();
    }
    deliver(a, resultsText(ids, { to: tree }), "results");
    markReported(ids);
    return { code: 200, body: { ok: true, key: tree, batched: ids.length } };
}

export async function sendToAgent(key, text) {
    if (!agentCwd(key))
        return { code: 404, body: { error: "нет такого агента" } };
    let a = agents.get(key);
    if (!a || a.dead)
        a = await ensureAgent(key);
    if (a.busy && !a.pinging)
        return { code: 409, body: { error: (treeByKey(key) || {}).tag + " сейчас отвечает: подождите конца ответа" } };
    a = await rotateOrchIfDue(a);
    deliver(a, text);
    return { code: 200, body: { ok: true, to: agentPublic(key) } };
}

/** Стартовый промпт слота: готовый файл *-<слот>.txt в папке промптов главнее; нет — собирается из плана (genSlotPrompt). */
export function slotPromptText(key) {
    const f = fs.existsSync(PROMPTS_DIR) ? fs.readdirSync(PROMPTS_DIR).find((x) => x.endsWith("-" + key + ".txt")) : null;
    return f ? fs.readFileSync(path.join(PROMPTS_DIR, f), "utf8") : genSlotPrompt(key);
}

export const startOffered = new Set();
// Слот → id последней подготовки, о простое после которой оркестратор уже предупреждён: после перезапуска не повторяем.
const NUDGES_FILE = path.join(DATA, "slot-nudges.json");
let slotNudges = null;

export function nudgeIdleSlots(now = Date.now(), send = sendWhenFree) {
    if (DRY || drainState() || !snapNow())
        return [];
    if (!slotNudges)
        slotNudges = readJson(NUDGES_FILE, {}) || {};
    const out = [];
    for (const x of epicSlots()) {
        const t = snapNow().trees.find((z) => z.key === x.slot), ap = agentPublic(x.slot), preps = jobList().filter((j) => j.task === "slot-up" && j.tree === x.slot);
        const n = slotIdleNudge({
            archived: !!x.archived,
            merged: !!(t && t.verdict && t.verdict.merged),
            exists: !!(t && t.exists),
            agent: ap.running || ap.hasLast,
            relay: inboxCards().some((z) => z.kind === "relay" && z.to === x.slot),
            preparing: slotPreparing(x.slot),
            stub: planIsStubOf(t),
            lastPrep: preps[preps.length - 1] || null,
            nudged: slotNudges[x.slot] || "",
            now,
        });
        if (!n)
            continue;
        const okey = orchOfKey(x.slot);
        if (!okey || !agentCwd(okey))
            continue;
        slotNudges[x.slot] = n.jobId;
        saveJson(NUDGES_FILE, slotNudges);
        send(okey, slotIdleText({ tag: x.tag, title: x.title, min: n.min, jobId: n.jobId, plan: planExists(t) }));
        logEvent("slot.idle.nudge", { key: x.slot, job: n.jobId, min: n.min });
        out.push(x.slot);
    }
    return out;
}

// Пара «от>кому» → времена автопередач за последний час: защита от пинг-понга двух агентов без человека.
export const autoRelayLog = new Map();
export const AUTO_RELAY_WINDOW_MS = 3600e3;

/**
 * Записать автопередачу пары. Заодно убрать из карты всё старше окна: решения принимаются только по последнему часу,
 * а пары живут, пока живут слоты и эпики, — без уборки карта росла бы с каждой новой парой до перезапуска сервера.
 */
export function noteAutoRelay(pk, at = Date.now()) {
    for (const [k, v] of autoRelayLog) {
        const fresh = v.filter((t) => at - t < AUTO_RELAY_WINDOW_MS);
        if (fresh.length)
            autoRelayLog.set(k, fresh);
        else
            autoRelayLog.delete(k);
    }
    autoRelayLog.set(pk, [...(autoRelayLog.get(pk) || []), at]);
}

/**
 * Автопередача карточки при автопоезде. Стоп, если за час 12+ передач туда и 8+ обратно (пинг-понг) или 15 в одну сторону
 * (зациклился слот). 409 «уже передаётся» — повтор через 20 с, до 30 минут.
 */
export function autoRelay(id, tries = 0) {
    if (!settings.autoTrain)
        return;
    const card = inboxCards().find((x) => x.id === id && x.kind === "relay");
    if (!card)
        return;
    const pk = card.tree + ">" + card.to, now = Date.now(), log = (autoRelayLog.get(pk) || []).filter((t) => now - t < AUTO_RELAY_WINDOW_MS);
    const back = (autoRelayLog.get(card.to + ">" + card.tree) || []).filter((t) => now - t < AUTO_RELAY_WINDOW_MS);
    if (log.length >= 12 && back.length >= 8) {
        card.note = "автопередача остановлена: за час " + log.length + " туда и " + back.length + " обратно между этой парой — похоже на пинг-понг, решите сами";
        saveInbox();
        return;
    }
    if (log.length >= 15) {
        card.note = "автопередача остановлена: 15 передач за час в одну сторону — проверьте, не зациклился ли слот";
        saveInbox();
        return;
    }
    inboxSend(id).then((r) => {
        if (r.code === 200)
            noteAutoRelay(pk, now);
        if (r.code === 409 && !r.body.already && tries < 90)
            setTimeout(() => autoRelay(id, tries + 1), 20000);
    }).catch((e) => console.error("автопередача:", e.message));
}

// Адресаты, чья очередь передач сейчас отдаётся: второй вызов drainQueued не отправляет ту же карточку параллельно.
export const draining = new Set();

/** Отдать очередь передач освободившемуся агенту: оркестратору — всё пачкой (после окна сбора), слоту — по одной. */
export function drainQueued(to) {
    const a = agents.get(to);
    if (drainState() || draining.has(to) || (a && !a.dead && a.busy && !a.pinging))
        return;
    const queued = inboxCards().filter((x) => x.kind === "relay" && x.to === to && x.queued).sort((x, y) => x.queued - y.queued);
    if (!queued.length)
        return;
    if (isOrch(to)) {
        // Окно сбора пачки ещё не кончилось — ждём попутных докладов (таймер из relayNow придёт сюда снова).
        if (queued.some((x) => x.gather) && Date.now() - queued[0].queued < ORCH_GATHER_MS)
            return;
        draining.add(to);
        deliverOrchBatch(to, queued).finally(() => draining.delete(to)).catch((e) => {
            console.error("пачка оркестратору:", e.message);
            for (const x of queued)
                if (inboxCards().includes(x)) {
                    x.queued = 0;
                    x.gather = false;
                    x.note = "пачкой не ушло: " + e.message + " — отправьте кнопкой";
                }
            saveInbox();
        });
        return;
    }
    const next = queued[0];
    draining.add(to);
    doRelay(next.tree, next.to, next.text, false, false, next.via).finally(() => draining.delete(to)).then((r) => {
        if (r.code === 200)
            noteAutoRelay(next.tree + ">" + next.to);
        else if (r.code !== 202) {
            next.queued = 0;
            next.note = "из очереди не ушло: " + ((r.body && r.body.error) || r.code) + " — отправьте кнопкой";
            saveInbox();
        }
    }).catch((e) => console.error("очередь передач:", e.message));
}

/**
 * Пачка докладов оркестратору одним сообщением, у каждого — справка о слоте. Справки собираются асинхронно, поэтому
 * перед отправкой «занят ли адресат» проверяется ещё раз: за это время он мог начать ход.
 */
export async function deliverOrchBatch(to, cards) {
    const tt = treeByKey(to);
    // Пока пачка собиралась, карточку могли отправить кнопкой или снять: такие не дублируем.
    const fresh = cards.filter((c) => inboxCards().includes(c) && !S.relaySent.includes(relayHash(c.tree, c.to, c.text)));
    if (fresh.length !== cards.length) {
        keepCards((x) => !(cards.includes(x) && !fresh.includes(x)));
        saveInbox();
    }
    if (!fresh.length)
        return;
    let a = agents.get(to);
    if (!a || a.dead)
        a = await ensureAgent(to);
    if (a.busy && !a.pinging)
        return;
    a = await rotateOrchIfDue(a);
    const parts = [];
    for (const c of fresh) {
        const tf = treeByKey(c.tree);
        if (!tf)
            continue;
        let facts = "";
        try {
            facts = await slotFacts(c.tree);
        }
        catch (e) {
            facts = "── Справку диспетчерской собрать не удалось: " + e.message + " ──";
        }
        const lr = lastRelay.get(c.tree);
        if (lr) {
            lr.wait = waitsHead(c.text);
            lr.asks = slotAsks(c.text);
        }
        parts.push({ c, tf, body: relayMessage({ via: c.via || "auto", from: tf, to: tt || { key: to }, body: c.text, facts }) });
    }
    saveRelayFacts();
    if (!parts.length)
        return;
    if (a.busy && !a.pinging)
        return;
    const msg =
        parts.length === 1
            ? parts[0].body
            : "Доклады слотов пачкой (" +
              parts.length +
              "): диспетчерская собрала их в одно сообщение, чтобы не тратить ход на каждый. Разбери все в одном ответе — блоком slot:ПN каждому, кому нужно.\n\n" +
              parts
                  .map((p, i) => "═════ " + (i + 1) + " из " + parts.length + " · " + p.tf.tag + " ═════\n" + p.body)
                  .join("\n\n");
    deliver(a, msg);
    for (const p of parts) {
        const h = relayHash(p.c.tree, to, p.c.text);
        markRelaySent(h);
        recordRelay(p.c.tree, to, p.c.text.length);
        logEvent("relay.sent", { from: p.c.tree, to, chars: p.c.text.length, hash: h, batched: true, n: parts.length, via: p.c.via || "auto" });
        keepCards((x) => x !== p.c);
        noteAutoRelay(p.c.tree + ">" + to);
        const sa = agents.get(p.c.tree);
        if (sa && !sa.dead)
            push(sa, {
                id: "rel-" + sa.rev,
                t: "status",
                text:
                    "Передано: " +
                    p.tf.tag +
                    " → " +
                    (tt ? tt.tag : "ОРК") +
                    (parts.length > 1 ? " пачкой вместе с " + (parts.length - 1) + " друг(ими) доклад(ами)" : "") +
                    " (" +
                    p.c.text.length +
                    " знаков).",
            });
    }
    saveInbox();
}

/**
 * Отправить карточку: красное staging — оркестратору, старт слота, передача, итоги прогонов. Зовут кнопка страницы
 * (via "owner") и автопередача автопоезда (по умолчанию — автоматика): от этого зависит подпись передачи.
 */
export async function inboxSend(id, now = false, via = "auto") {
    const it = inboxCards().find((x) => x.id === id);
    if (!it)
        return { code: 404, body: { error: "карточки уже нет: обновите страницу" } };
    if (it.kind === "stgred") {
        const r = await sendToAgent(isOrch(it.to) ? it.to : orchKey((viewEpic() || {}).id), stgRedText(it));
        if (r.code === 200) {
            keepCards((x) => x.id !== id);
            saveInbox();
            recordRelay("orchestrator-staging", "orchestrator", 0);
        }
        return r;
    }
    if (it.kind === "slotstart") {
        const p = slotPromptText(it.tree);
        if (!p)
            return { code: 404, body: { error: "стартового промпта нет: нет плана волны" } };
        const r = await sendToAgent(it.tree, p);
        if (r.code === 200) {
            keepCards((x) => x.id !== id);
            saveInbox();
        }
        return r;
    }
    if (it.kind === "relay")
        return doRelay(it.tree, it.to, it.text, false, now, via);
    if (it.kind === "result")
        return sendBatch(it.tree);
    return { code: 400, body: { error: "у этой карточки нет отправки" } };
}

/** Просьба агенту о коммите: правила из подсказки, у поезда — номер вагона в работе, список изменённых файлов (до 80). */
export function commitAsk(t, br, work) {
    const files = work.slice(0, 80).map((f) => "  " + f.path).join("\n") + (work.length > 80 ? "\n  … и ещё " + (work.length - 80) : "");
    return [prompt("commit-ask", { branch: br }),
        ...(t.train ? [trainCommitNote(t.tag, trainWaveOf(t.key))] : []),
        "Изменённые файлы в папке слота (" + work.length + "):\n" + files,
        "Ответь одним блоком по формату слота: КОММИТ <хеш> <тема>; сколько файлов; что не включил и почему; что дальше (влить в staging решит владелец)."].join("\n\n");
}

/** Поезду номер волны для подписи коммита — вагон в работе, а не имя ветки. */
export function trainCommitNote(tag, wave) {
    return prompt("train-commit-note", { tag, current: wave || "(не определён — спроси оркестратора)", wave: wave || "WV-NNNN" });
}

// ───────────────────────────── просьбы о прогонах и тесты волны ─────────────────────────────

export const TREQ_FILE = path.join(DATA, "test-requests.json"), PRESETS_X_FILE = path.join(DATA, "presets-extra.json");
/** Задачи станций (сборка и гарды): их ставит автопоезд сам, в тесты волны они не попадают. */
export const STATION_TASKS = new Set(["build", ...GUARD_TASKS]);

/** Добавить к тестам волны из реестра эпиков те, что слоты добавили просьбами (после загрузки реестра и presets-extra.json). */
export function mergeExtraPresets() {
    for (const [k, list] of Object.entries(S.presetsExtra)) {
        S.presetsExtra[k] = list.filter((x) => !STATION_TASKS.has(x.task));
        if (!treeByKey(k))
            continue;
        const cur = PRESETS[k] || (PRESETS[k] = []);
        for (const x of S.presetsExtra[k])
            if (!cur.some((p) => p.task === x.task && (p.input || "") === (x.input || "")))
                cur.push(x);
    }
}

const reEsc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Подпись задачи из конфига → id: агент называет проверку её подписью («Линтер», «API: тесты по шаблону»). Длинные — первыми. */
export const TITLE_TASKS = Object.values(TASKS).filter((t) => t.label).sort((a, b) => b.label.length - a.label.length).map((t) => [new RegExp(reEsc(t.label), "i"), t.id]);

/** Короткие просьбы: «задача=ввод» для задач с вводом и команда задачи без ввода, названная дословно (`npm run lint`). */
export function shortTestRequests(body) {
    const b = String(body || ""), out = [], add = (task, input = "") => {
        if (TASKS[task] && !out.some((r) => r.task === task && r.input === input))
            out.push({ task, input, note: "" });
    };
    for (const m of b.matchAll(/(?:^|[\s`«(])([a-z][a-z0-9-]*)=([a-z0-9][\w.,\/-]*)/gi))
        if (TASKS[m[1]] && TASKS[m[1]].input)
            add(m[1], m[2].replace(/[.,;:]+$/, ""));
    for (const t of Object.values(TASKS))
        if (!t.input && t.run && b.includes(t.run))
            add(t.id);
    return out;
}

/**
 * Раздел «Тесты для запуска владельцем» из доклада слота: пункты списка до первой пустой строки после них. Задача —
 * по подписи из конфига или короткой записи; задача с вводом без найденного фильтра пропускается (прогон всего набора
 * по ошибке разбора дороже, чем пропуск).
 */
export function parseTestRequests(text) {
    const i = String(text || "").search(TESTS_HEAD_RE);
    if (i < 0)
        return [];
    const out = [];
    for (const raw of String(text).slice(i).split("\n").slice(1)) {
        const l = raw.trim();
        if (!l) {
            if (out.length)
                break;
            continue;
        }
        if (!/^(\d+[.)]|[-•*])\s+/.test(l)) {
            if (out.length)
                break;
            continue;
        }
        const body = l.replace(/^(\d+[.)]|[-•*])\s+/, ""), hit = TITLE_TASKS.find(([re]) => re.test(body));
        if (!hit) {
            for (const r of shortTestRequests(body))
                if (!out.some((o) => o.task === r.task && o.input === r.input))
                    out.push(r);
            continue;
        }
        const task = hit[1], m = /(?:(?:pattern|filter)\s*[:=]?|(?:шаблон|фильтр|подстрок)[а-яё]*\s*(?:[:=]|(?=[«"'`])))\s*[«"'`]?([^\s«»"'`()]+)/i.exec(body);
        const input = TASKS[task] && TASKS[task].input ? (m ? m[1].replace(/[.,;:]+$/, "") : "") : "";
        if (TASKS[task] && TASKS[task].input && !input)
            continue;
        out.push({ task, input, note: ((/Контроль:\s*(.*)$/i.exec(body) || [])[1] || (/(Пришлите[^.]*)/i.exec(body) || [])[1] || "").slice(0, 200) });
    }
    return out;
}

/**
 * Все просьбы о прогоне в тексте: строки с подписью задачи и фильтром плюс раздел тестов. Строка, которая сообщает итог
 * («зелёный», «упал»), а не просит прогнать, просьбой не считается.
 */
export function parseRunRequests(text) {
    const out = [],
        seen = new Set();
    for (const line of String(text || "").split("\n"))
        for (const seg of line.split(/,?\s+(?:потом|затем|после этого)\s+|;\s+/i)) {
            if (!/«|pattern|filter|задач/i.test(seg)) continue;
            if (
                /(зел[её]н|упал|красн|прош(ёл|ел|ли)|passed|failed|принял|итог)/i.test(seg) &&
                !/(прогон(и|ите)|запуст(и|ите)|нажм(и|ите)|пришлите|перепрогна|повтор(и|ите)|нужен прогон|нужно прогнать)/i.test(
                    seg,
                )
            )
                continue;
            const hit = TITLE_TASKS.find(([re]) => re.test(seg));
            if (!hit) continue;
            const task = hit[1],
                m =
                    /(?:(?:pattern|filter)\s*[:=]?|(?:шаблон|фильтр|подстрок)[а-яё]*\s*(?:[:=]|(?=[«"'`])))\s*[«"'`]?([^\s«»"'`()]+)/i.exec(
                        seg,
                    );
            const input = TASKS[task] && TASKS[task].input ? (m ? m[1].replace(/[.,;:]+$/, "") : "") : "";
            if (TASKS[task] && TASKS[task].input && !input) continue;
            const k = task + "|" + input;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ task, input, note: seg.trim().slice(0, 160) });
        }
    for (const r of parseTestRequests(text)) {
        const k = r.task + "|" + r.input;
        if (!seen.has(k)) {
            seen.add(k);
            out.push(r);
        }
    }
    return out;
}

/** Пресет тестов волны «мёртв»: последний его прогон не нашёл ни одной спеки, или в папке слота нет спеки под фильтр. */
export function deadPreset(tree, p, files) {
    const j = [...jobList()].reverse().find((k) => k.tree === tree && k.task === p.task && (k.input || "") === (p.input || "") && ["ok", "fail", "skipped"].includes(k.status));
    if (j && (j.status === "skipped" || /совпало имён 0 из/.test(j.summary || "")))
        return true;
    return !!files && !presetHasSpecs(p, files);
}

export const specFilesCache = new Map();

/** Файлы спек: имена тестов в принятых соглашениях (JS/TS, Go, Python). */
export const SPEC_NAME_RE = /(\.(spec|test)\.[cm]?[jt]sx?|_test\.go|(^|\/)test_[^/]+\.py|_test\.py)$/;

export async function specFiles(t) {
    const k = t.path + "|" + t.fp;
    if (specFilesCache.has(k))
        return specFilesCache.get(k);
    const r = await git(t.path, ["ls-files", "--cached", "--others", "--exclude-standard"], 60000);
    const v = (r.out || "").split("\n").map((x) => x.trim()).filter((x) => SPEC_NAME_RE.test(x) && !/node_modules\//.test(x));
    if (specFilesCache.size > 60)
        specFilesCache.clear();
    specFilesCache.set(k, v);
    return v;
}

/**
 * Найдёт ли набор хоть одну спеку. Смысл ввода известен по заготовке разбора задачи: у jest — регулярка пути,
 * у vitest — подстроки имён через запятую; ищется в папке задачи. Прочие задачи не проверяются (считается, что найдёт).
 */
export function presetHasSpecs(p, files) {
    const task = PROJECT.tasks[p.task];
    if (!task || !task.input)
        return true;
    const sub = task.cwd ? task.cwd + "/" : "", mine = files.filter((x) => !sub || x.startsWith(sub));
    if (task.parser === "jest") {
        let re;
        try {
            re = new RegExp(p.input || "");
        }
        catch {
            return true;
        }
        return mine.some((x) => re.test(x));
    }
    if (task.parser === "vitest")
        return String(p.input || "").split(",").map((x) => x.trim()).filter(Boolean).some((n) => mine.some((x) => x.includes(n)));
    return true;
}

export const samePreset = (a, b) => a.task === b.task && (a.input || "") === (b.input || "");

/** Снять пресеты из тестов волны: в памяти, в presets-extra.json и в реестре эпиков (с копией реестра .prev). */
export function dropPresets(tree, dead, why) {
    if (!dead.length)
        return;
    PRESETS[tree] = (PRESETS[tree] || []).filter((p) => !dead.some((d) => samePreset(d, p)));
    if (S.presetsExtra[tree])
        S.presetsExtra[tree] = S.presetsExtra[tree].filter((p) => !dead.some((d) => samePreset(d, p)));
    try {
        const reg = loadEpics(), sl = reg.epics.flatMap((e) => e.slots).find((x) => x.slot === tree);
        if (sl && sl.presets && sl.presets.some((p) => dead.some((d) => samePreset(d, p)))) {
            fs.copyFileSync(EPIC_FILE, EPIC_FILE + ".prev");
            sl.presets = sl.presets.filter((p) => !dead.some((d) => samePreset(d, p)));
            saveEpics(reg);
        }
    }
    catch (e) {
        console.error("пресеты слота:", e.message);
    }
    saveJson(PRESETS_X_FILE, S.presetsExtra, 1);
    console.log("тесты волны", tree, ": снят пресет —", why, "—", dead.map((p) => p.task + " " + (p.input || "")).join(", "));
}

/** Снять мёртвые пресеты; последний пресет волны не снимается никогда — волна без тестов хуже, чем с неудачным фильтром. */
export async function pruneDeadPresets(t) {
    const list = PRESETS[t.key] || [];
    if (list.length < 2)
        return;
    const files = await specFiles(t), dead = list.filter((p) => deadPreset(t.key, p, files));
    if (dead.length && dead.length < list.length)
        dropPresets(t.key, dead, "в папке слота нет спеки под фильтр");
}

export const testReqsOf = (key) => S.testReqs[key];

/**
 * Записать просьбу слота (или оркестратора) о прогонах: при автопоезде — сразу в очередь, задачи (кроме станций) — в тесты
 * волны. Пресет той же задачи с другим фильтром, который не нашёл спек, снимается: слот назвал правильный фильтр.
 */
export function setTestReqs(tree, reqs, by = "просьба агента") {
    logEvent("agent.asks", { tree, n: reqs.length, tasks: reqs.map((r) => r.task + (r.input ? "=" + r.input : "")).join(", ").slice(0, 200) });
    if (settings.autoTrain)
        setTimeout(() => {
            for (const r of reqs)
                runTask(tree, r.task, r.input || "", by).catch((e) => console.error("автопоезд, просьба:", e.message));
        }, 1000);
    S.testReqs[tree] = reqs.map((r) => ({ ...r, id: "tr" + Math.random().toString(36).slice(2, 7), at: Date.now() }));
    const list = PRESETS[tree] || (PRESETS[tree] = []);
    for (const r of reqs)
        if (!STATION_TASKS.has(r.task) && !list.some((p) => p.task === r.task && (p.input || "") === (r.input || ""))) {
            const p = { task: r.task, input: r.input, extra: true };
            list.push(p);
            (S.presetsExtra[tree] = S.presetsExtra[tree] || []).push(p);
        }
    dropPresets(
        tree,
        list.filter(
            (p) => reqs.some((r) => r.task === p.task && (r.input || "") !== (p.input || "")) && deadPreset(tree, p),
        ),
        "прогон не нашёл ни одной спеки, слот назвал другой фильтр",
    );
    saveJson(TREQ_FILE, S.testReqs);
    saveJson(PRESETS_X_FILE, S.presetsExtra, 1);
}

/**
 * Состояние одной просьбы → { j, status: todo|run|ok|fail|stale|skip }. Свежий зелёный прогон до просьбы засчитывается,
 * красное только в staging — как зелёное (слоту не вменяется).
 */
export function reqItemStatus(tree, r, t) {
    const same = (k) => k.tree === tree && k.task === r.task && (k.input || "") === (r.input || "");
    const j = [...jobList()].reverse().find((k) => same(k) && (k.queuedAt || 0) >= r.at - 1000 && ["ok", "fail", "running", "queued", "waiting"].includes(k.status));
    if (!j && t) {
        const sk = [...jobList()].reverse().find((k) => same(k) && k.status === "skipped" && k.fpEnd === t.fp);
        if (sk)
            return { j: sk, status: "skip", why: sk.na ? "неприменимо: " + String(sk.na).slice(0, 160) : "фильтр не нашёл сьютов: " + String(sk.summary || "").slice(0, 160) };
    }
    if (!j && t) {
        const prev = [...jobList()].reverse().find((k) => same(k) && ["ok", "fail"].includes(k.status));
        if (prev && prev.status === "ok" && jobFresh(prev, t) === "ok")
            return { j: prev, status: "ok" };
        if (prev && prev.status === "fail" && onlyStagingRed(prev.id))
            return { j: prev, status: "ok", inherited: true };
    }
    if (j && j.status === "fail" && onlyStagingRed(j.id))
        return { j, status: "ok", inherited: true };
    // Прогон просьбы упал из-за окружения (не собран dist и т.п.), а её недостающие спеки уже зелёные на этом коде в
    // других прогонах: просьба выполнена. Иначе тупик: ворота не дают повтор («зелёный на этом же коде»), а просьба
    // висит красной, и станция «Тесты» не засчитывается.
    const lastDone = j || (t ? [...jobList()].reverse().find((k) => same(k) && ["ok", "fail"].includes(k.status)) : null);
    if (lastDone && lastDone.status === "fail" && t && !realFail(lastDone) && (!j || !["running", "queued", "waiting"].includes(j.status))) {
        const es = (t.suites || []).find((x) => x.task === r.task && x.input === (r.input || ""));
        if (es && Array.isArray(es.list) && es.list.length && es.list.length === es.total) {
            const need = es.list.filter((x) => x.st !== "ok");
            const greenOnFp = (spec) =>
                jobList().some((k) => k.tree === tree && k.task === r.task && k.status === "ok" && k.fpStart === t.fp && k.fpEnd === t.fp &&
                    jobCovers(k, { task: r.task, input: spec }));
            if (need.every((x) => greenOnFp(x.spec)))
                return { j, status: "ok", bySpecs: true };
        }
    }
    {
        const es = t && (t.suites || []).find((x) => x.task === r.task && x.input === (r.input || ""));
        if (es && es.state === "ok" && (!j || !["running", "queued", "waiting"].includes(j.status)))
            return { j, status: "ok", bySuites: true };
    }
    return { j, status: !j ? "todo" : ["running", "queued", "waiting"].includes(j.status) ? "run" : j.status === "fail" ? "fail" : t && jobFresh(j, t) === "ok" ? "ok" : "stale" };
}

/** Просьбы для страницы. Влитая ветка — просьба снята; всё зелёное — показывается ещё 45 с и снимается. */
export function testReqsPublic() {
    const out = [];
    for (const [tree, list] of Object.entries(S.testReqs)) {
        const t = snapNow() && snapNow().trees.find((x) => x.key === tree);
        if (t && t.verdict && t.verdict.merged) {
            delete S.testReqs[tree];
            saveJson(TREQ_FILE, S.testReqs);
            logEvent("reqs.dropped", { tree, why: "merged" });
            continue;
        }
        if (!t)
            continue;
        const items = list.map((r) => {
            const { j, status } = reqItemStatus(tree, r, t);
            return { id: r.id, task: r.task, input: r.input, note: r.note, status, jobId: j ? j.id : null };
        });
        const allOk = items.length && items.every((x) => x.status === "ok" || x.status === "skip");
        const g = S.testReqs[tree];
        if (allOk && !g.doneAt) {
            g.doneAt = Date.now();
        }
        if (allOk && Date.now() - (g.doneAt || 0) > 45000) {
            delete S.testReqs[tree];
            saveJson(TREQ_FILE, S.testReqs);
            continue;
        }
        out.push({ tree, epic: epicOfKey(tree), items, doneAt: allOk ? g.doneAt : null });
    }
    return out;
}

/** Отчёт агенту о прогоне, который владелец запустил кнопкой: правила разбора, итог, команда, выжимка лога. */
export function buildReport(j, { to = "", record = false } = {}) {
    const t = TREES.find((x) => x.key === j.tree) || TREES[0], key = to || t.key;
    const ses = digestSession({ to: key, kind: "report", seed: j.id, settings, record });
    const word = { fail: "УПАЛ", interrupted: "ПРЕРВАН", cancelled: "ОТМЕНЁН", ok: "ЗЕЛЁНЫЙ" }[j.status] || j.status;
    const secs = Math.round(((j.endedAt || Date.now()) - (j.startedAt || Date.now())) / 1000);
    const msg = reportMessage({ word, what: j.label + (j.input ? " — " + j.input : ""), dir: fwd(t.path), cmd: (j.steps || []).map((x) => x.show).join(" → "),
        exit: "Код выхода " + (j.code ?? "?") + ", " + secs + " с" + (j.peakMB ? ", пик памяти " + j.peakMB + " МБ" : "") + ".", excerpt: ses.log(j.id, (raw) => failureExcerpt(raw)) });
    ses.close(msg);
    return msg;
}
