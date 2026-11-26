// review.mjs — независимое ревью правки слота перед вливом: разовый агент-ревьюер читает план и дифф и выносит вердикт
// ЗА, ВОПРОСЫ или ПРОТИВ. Число кругов с вопросами ограничено; вердикт уходит агенту слота, упор в потолок — человеку.
// Модуль можно выключить в конфиге проекта — тогда станция ревью не требуется.
import fs from "node:fs";
import { readJson, saveJson } from "./store.mjs";
import path from "node:path";
import { S } from "./state.mjs";
import { snapNow } from "./snapshot.mjs";
import { jobList } from "./jobs.mjs";
import { agents, itemById, push } from "./agents.mjs";
import { runOnce } from "../runtimes/index.mjs";
import { PROJECT } from "../slots.mjs";
import { moduleStates } from "../modules-catalog.mjs";
import { enabled } from "./modules.mjs";
import { ANSI, DATA, FINAL, logEvent, readLog, settings, short } from "./config.mjs";
import { reportBlockOf } from "./protocol.mjs";
import { isOrch, treeByKey } from "./trees.mjs";
import { codeFp } from "./fingerprint.mjs";
import { exists, git } from "./git.mjs";
import { addCard, ibId, inboxCards, saveInbox } from "./inbox.mjs";
import { late, lateObject } from "./late.mjs";
import { autoRelay, sendBatch } from "./relay.mjs";
import { planFileOf } from "./stations.mjs";

const { enqueue } = late("runner.mjs", ["enqueue"]);
const procs = lateObject("runner.mjs", "procs");

import { reviewPrompt } from "./prompt.mjs";

/** Модель ревьюера — роль `review` в конфиге проекта; пусто — модель рантайма по умолчанию. */
export const REVIEW_MODEL = () => PROJECT.agent.models.review || "";
/** Команды оболочки, которые ревьюеру можно: только просмотр истории и правки. */
export const REVIEW_BASH = ["git diff", "git log", "git show", "git status"];
export const REVIEW_LIMIT_MS = 30 * 60e3;

/** Включён ли модуль ревью в этой установке. Выключен — станция ревью не требуется и ревьюер не ставится. */
export function reviewEnabled(project = PROJECT) {
    if (project !== PROJECT) {
        const st = moduleStates(project).find((m) => m.id === "review");
        return !!(st && st.on);
    }
    return enabled("review");
}

const planBody = (pf) => {
    try {
        return pf ? fs.readFileSync(pf, "utf8").replace(/^---[\s\S]*?\n---\n/, "").trim() : "";
    }
    catch {
        return "";
    }
};

/**
 * Ответ автора на замечания ревью → { said — его ответы после замечаний, reply — блок доклада из последнего }. Дальше
 * уходит только блок: раньше бралось всё, что агент писал после замечаний, с обрезом начала, и ревьюер получал
 * рассуждения и пересказ инструментов, начатые посреди фразы.
 */
function authorReply(t) {
    const a = agents.get(t.key), items = a ? a.items : [], i = items.map((x) => x.t === "user" && /Ревью|ревьюер/.test(String(x.text || ""))).lastIndexOf(true);
    const said = i >= 0 ? items.slice(i + 1).filter((x) => x.t === "assistant" && String(x.text || "").trim()) : [];
    return { said, reply: said.length ? reportBlockOf(said[said.length - 1].text) : "" };
}

export function reviewContext(t) {
    let plan = "";
    const pf = planFileOf(t);
    if (pf) {
        plan = planBody(pf);
        if (plan.length > 9000)
            plan = plan.slice(0, 9000) + "\n… (план обрезан)";
    }
    let prev = "";
    const last = [...jobList()]
        .reverse()
        .find(
            (j) =>
                j.tree === t.key &&
                j.task === "review" &&
                j.review &&
                j.review.verdict &&
                j.review.verdict !== "ЗА" &&
                (!t.train || ((j.wagons || {}).waves || []).includes(t.wagon)),
        );
    if (last) {
        const { said, reply } = authorReply(t);
        prev =
            "— Вердикт " +
            last.review.verdict +
            " (" +
            last.id +
            "):\n" +
            short(last.review.text || "", 3500) +
            (reply
                ? "\n— Ответ автора (его доклад):\n" + short(reply, 4000)
                : said.length
                  ? "\n— Ответ автора без блока доклада — его ход сюда не передаётся, суди по коду."
                  : "\n— Ответа автора дашборд не видит (агент перезапускался) — суди по коду.");
    }
    return { plan, prev };
}

export const reviewInflight = new Map();

export function startReview(key, force = false) {
    const p = reviewInflight.get(key);
    if (p)
        return p;
    const q = startReviewNow(key, force).finally(() => reviewInflight.delete(key));
    reviewInflight.set(key, q);
    return q;
}

export async function startReviewNow(key, force) {
    const t = treeByKey(key);
    if (!reviewEnabled())
        throw new Error("модуль ревью выключен в конфиге проекта (modules.review)");
    if (!t || t.kind !== "slot" || !exists(t.path))
        throw new Error("нет такого слота");
    const dup = jobList().find((j) => j.tree === key && j.task === "review" && ["queued", "waiting", "running"].includes(j.status));
    if (dup)
        return dup;
    {
        const ag = agents.get(key);
        if (ag && !ag.dead && ag.busy && !ag.pinging)
            throw new Error(t.tag + ": агент сейчас правит код — ревью на меняющемся коде бесполезно, оно запустится автопоездом после его хода");
    }
    if (!force) {
        const fp = await codeFp(t.path, true), last = [...jobList()].reverse().find((j) => j.tree === key && j.task === "review" && ["ok", "fail"].includes(j.status) && j.review);
        if (last && last.fpStart === last.fpEnd && last.fpEnd === fp)
            throw new Error(
                t.tag +
                    ": ревью на этом коде уже есть (вердикт " +
                    last.review.verdict +
                    ", " +
                    last.id +
                    ")" +
                    (last.review.verdict !== "ЗА" && !last.reported
                        ? " — замечания ещё не отданы агенту: кнопка «→ Агенту замечания ревью»"
                        : "") +
                    ". Код не менялся, повтор даст то же самое",
            );
    }
    const br = (await git(t.path, ["rev-parse", "--abbrev-ref", "HEAD"])).out;
    const ctx = reviewContext(t);
    const prompt = reviewPrompt({ br, plan: ctx.plan, prev: ctx.prev });
    const model = REVIEW_MODEL(), who = "ревьюер" + (model ? " " + model : "");
    logEvent("review.start", { tree: key, force: !!force });
    // Ревьюер — разовый запуск рантайма: дерево только на чтение, из оболочки — только просмотр истории git.
    // Его ответ пишется в лог прогона, вердикт оттуда достаёт parseReview.
    const step = { cwd: t.path, show: "разовый агент (" + who + ", только чтение)", js: async (write, job) => {
            const r = await runOnce({
                prompt,
                cwd: t.path,
                model,
                readOnly: true,
                allowBash: REVIEW_BASH,
                maxTurns: 60,
                timeoutMs: REVIEW_LIMIT_MS,
                onProc: (c) => procs.set(job.id, c),
            }).finally(() => procs.delete(job.id));
            write(String(r.text || "") + "\n");
            if (!r.ok)
                throw new Error("ревьюер завершился с кодом " + (r.code ?? "?"));
        } };
    return enqueue({ treeKey: key, cwd: t.path, label: "Ревью: независимый " + who, taskId: "review", input: "", lane: "review", steps: [step], extra: { auto: true } });
}

export function reviewCapped(key) {
    const day = Date.now() - 24 * 3600e3, lastZa = Math.max(0, ...jobList().filter((j) => j.tree === key && j.task === "review" && j.status === "ok").map((j) => j.endedAt || 0));
    return jobList().filter((j) => j.tree === key && j.task === "review" && j.status === "fail" && (j.endedAt || 0) > Math.max(day, lastZa)).length >= 2;
}

export function reviewEscalate(t) {
    if (jobList().some((j) => j.tree === t.key && j.task === "review" && !FINAL.includes(j.status)))
        return;
    const last = [...jobList()].reverse().find((j) => j.tree === t.key && j.task === "review" && j.review);
    // Текст пишет диспетчерская, а не слот: так и подписано. Доводы автора — его доклад, а не «в его последнем ответе»:
    // чат слота оркестратор не видит.
    const { reply } = authorReply(t);
    const txt =
        "[Диспетчерская] Ревью " +
        t.tag +
        " (" +
        t.key +
        ") дважды вернулось с вопросами, агент разобрал их (согласен с частью, с остальным — нет). Автопоезд третье ревью сам не ставит.\n\nПоследнее ревью (" +
        (last ? last.id : "?") +
        "):\n" +
        short((last && last.review && last.review.text) || "", 3000) +
        "\n\nДоклад автора после замечаний:\n" +
        (reply ? short(reply, 4000) : "(блоком доклада автор не ответил — доводы смотри в коде ветки)") +
        "\n\nРеши: принять волну с этими разногласиями — отдельной строкой «ПРИНЯТЬ РЕВЬЮ " +
        t.tag +
        "» (дашборд отметит станцию, автопоезд поставит коммит); или назови пункт, который слот обязан поправить, — блоком slot:" +
        t.tag +
        ".";
    if (!inboxCards().some((x) => x.kind === "relay" && x.tree === t.key && isOrch(x.to) && /дважды вернулось с вопросами/.test(x.text || ""))) {
        const card = { id: ibId(), kind: "relay", tree: t.key, to: "orchestrator", toTag: "ОРК", text: txt, at: Date.now() };
        addCard(card);
        saveInbox();
        logEvent("review.escalate", { tree: t.key });
        if (settings.autoTrain)
            setTimeout(() => autoRelay(card.id), 1500);
    }
}

export function autoSendReview(job, tries = 0) {
    if (!settings.autoTrain || job.reported || job.status !== "fail" || !job.review)
        return;
    {
        const t = treeByKey(job.tree);
        if (t && exists(t.path) && job.fpEnd && snapNow()) {
            const st = snapNow().trees.find((x) => x.key === job.tree);
            if (st && st.fp && st.fp !== job.fpEnd)
                return;
        }
    }
    if (jobList().some((j) => j !== job && j.tree === job.tree && j.task === "review" && (j.queuedAt || 0) > (job.queuedAt || 0)))
        return;
    const a = agents.get(job.tree), retry = () => {
        if (tries < 90)
            setTimeout(() => autoSendReview(job, tries + 1), 20000);
    };
    if (a && !a.dead && a.busy && !a.pinging)
        return retry();
    sendBatch(job.tree, [job.id]).then((r) => {
        if (r.code === 200) {
            const x = agents.get(job.tree);
            if (x)
                push(x, { id: "rv-" + x.rev, t: "status", text: "Автопоезд: замечания ревьюера отданы агенту волны." });
        }
        else if (r.code === 409)
            retry();
    }).catch((e) => {
        console.error("ревью → агенту:", e.message);
        retry();
    });
}

export const REVIEW_NOTES_FILE = path.join(DATA, "review-notes.json");

export function loadReviewNotes() {
    S.reviewNotes = readJson(REVIEW_NOTES_FILE, {}) || {};
}

export const recentNotes = (key) => (S.reviewNotes[key] || []).filter((n) => Date.now() - n.at < 48 * 3600e3);

export function reviewToChat(job) {
    const note = {
        id: "rv-" + job.id,
        t: "review",
        at: Date.now(),
        jobId: job.id,
        verdict: job.review ? job.review.verdict : "",
        text: job.review ? job.review.text : job.summary || "ревьюер не дал вердикта",
    };
    S.reviewNotes[job.tree] = [...(S.reviewNotes[job.tree] || []).filter((n) => n.id !== note.id), note].slice(-3);
    saveJson(REVIEW_NOTES_FILE, S.reviewNotes);
    const a = agents.get(job.tree);
    if (a && !itemById(a, note.id))
        push(a, { ...note });
}

export function parseReview(job) {
    const log = readLog(job.id).replace(ANSI, ""), ms = [...log.matchAll(/ВЕРДИКТ:\s*\**\s*(ЗА|ВОПРОСЫ|ПРОТИВ)/g)], m = ms.pop();
    if (!m) {
        job.status = job.cancelled ? "cancelled" : "fail";
        job.summary = "ревьюер не дал вердикта: " + (job.summary || "");
        logEvent("review.verdict", { tree: job.tree, id: job.id, verdict: "" });
        return;
    }
    const text = log.slice(m.index).split(/\n── (ok|fail)/)[0].trim().slice(0, 6000);
    job.review = { verdict: m[1], text };
    job.status = m[1] === "ЗА" ? "ok" : "fail";
    logEvent("review.verdict", { tree: job.tree, id: job.id, verdict: m[1] });
    job.summary = "ВЕРДИКТ: " + m[1] + ((text.split("\n").find((l) => /^\s*-/.test(l)) || "").replace(/^\s*-\s*/, " · ").slice(0, 200));
}
