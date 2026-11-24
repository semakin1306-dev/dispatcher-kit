// view.mjs — вид ветки для страницы: станции с поправкой на пишущего агента, текущая станция, следующий шаг с кодом
// действия, группа («нужен ты / работает / в поезде / ждёт / влито»), готовность к staging, вагоны поезда и Гант эпика.
// Правило одно — здесь, на сервере; страница только рисует кнопки по коду действия.
import { staleRed } from "./loops.mjs";
import { trainNow } from "./pipeline.mjs";
import { waveFinalOf } from "./slot-done.mjs";
import { wagonUnfinished } from "./auto-merge-rules.mjs";
import { snapNow } from "./snapshot.mjs";
import { jobList } from "./jobs.mjs";
import { agentPublic } from "./agents.mjs";
import { PRESETS } from "./trees.mjs";
import { failAdvice } from "./relay.mjs";
import { conflictNext } from "./sync-rules.mjs";
import { prepNext } from "./slot-rules.mjs";
import { trainNext, wagonStation } from "./train-rules.mjs";
import { mergeWaitView } from "./merge-wait.mjs";
import { ganttLayout } from "./gantt-rules.mjs";
import { ganttEventsOf } from "./gantt.mjs";
import { PROJECT } from "../slots.mjs";

const ACTIVE = ["running", "queued", "waiting"];
const LEAD = new Set(["plan", "red"]);
const CHECKS = ["build", "tests", "guards", "regress", "review"];
/** Задачи-гейты проекта (гарды): по ним судят о ветке без своих наборов тестов. */
const gateIds = () => Object.values(PROJECT.tasks || {}).filter((x) => x.gate).map((x) => x.id);
// Набор спек через «|»: прогон надмножества тоже засчитывается.
export const lastJobIn = (tree, task, input) => [...jobList()].reverse().find((j) => j.tree === tree && j.task === task && (input == null || (j.input || "") === input || (!!input && input.includes("|") && input.split("|").every((n) => String(j.input || "").split("|").includes(n)))));

export function stagesView(t, ag) {
    const st = t.stages || [];
    if (!ag || !ag.coding || (t.verdict && t.verdict.merged))
        return st;
    const i = st.findIndex((x) => x.id === "impl");
    if (i < 0)
        return st;
    return st.map((x, k) => (k >= i && x.source !== "manual" && ["impl", "build", "tests", "guards", "regress", "review", "commit"].includes(x.id) ? { ...x, done: false, hint: k === i ? "агент сейчас пишет код" : x.hint } : x));
}

export function farOf(st, t, ag) {
    if (ag && ag.coding && !(t.verdict && t.verdict.merged)) {
        const i = st.findIndex((x) => x.id === "impl");
        if (i > 0)
            return i - 1;
    }
    const k = st.findIndex((x) => !x.done && !LEAD.has(x.id));
    return k < 0 ? st.length - 1 : k - 1;
}

export const reviewOwed = (t) => !!(t.review && t.review.fresh && t.review.verdict && t.review.verdict !== "ЗА" && t.review.reported === false);

export function readyStg(t, st) {
    if (!t || !t.exists || t.kind === "orch" || t.readOnly || !t.ahead || t.dirtyTracked)
        return false;
    if ((t.deps || []).some((d) => !d.merged))
        return false;
    if (conflictNext(t))
        return false;
    const s = st.find((x) => x.id === "staging");
    return !!s && !s.done && !st.some((x) => CHECKS.includes(x.id) && !x.done);
}

export function nextStep(t, st, ag, far) {
    const cur = st[far + 1], presets = PRESETS[t.key] || [];
    const tests = presets.length ? presets.map((p) => lastJobIn(t.key, p.task, p.input || "")) : gateIds().map((id) => lastJobIn(t.key, id, null));
    const adv = (j) => {
        try {
            return failAdvice(j);
        }
        catch {
            return undefined;
        }
    };
    const failed = tests.find((j) => {
        if (!j || j.status !== "fail")
            return false;
        if (t.train && staleRed(j, t.fp))
            return false;
        const a = adv(j);
        return !(a && ["inherited", "obsolete"].includes(a.act));
    });
    const active = jobList().some((j) => j.tree === t.key && ACTIVE.includes(j.status));
    if (!cur)
        return { kind: "done", text: "Путь пройден 🏁" };
    if (t.train && !active && !t.hasCode && t.verdict && t.verdict.merged) {
        const tn = trainNext(t);
        if (tn.act === "issue")
            return { kind: "info", text: "Вагон " + t.wagon + " влит. Следующий вагон " + t.current + " — агенту поезда в ту же сессию (автопоезд сам или кнопкой)", act: "train-wagon" };
    }
    if (ag && ag.coding)
        return { kind: "info", text: "Агент пишет код — сборку и тесты автопоезд запустит сам, когда он допишет" };
    if (active)
        return { kind: "info", text: "Идут или ждут запуски этого слота" };
    if (!t.readOnly && !t.ahead && !t.dirtyTracked && !t.dirtyUntracked && !(t.verdict && t.verdict.merged)) {
        if (t.train && t.wagonStaged)
            return { kind: "info", text: "Код вагона " + t.wagon + " уже в staging (коммитов: " + t.wagonStaged + ", влиты с другим вагоном), вагон не закрыт: в ветке нового кода нет" + (ag && ag.busy ? " — агент работает" : " — агент ждёт следующего шага (ваше слово или условие из плана)") };
        return { kind: "info", text: ag && !ag.busy && !ag.running ? "Кода ещё нет, агент не работает: ждёт сообщения" : "Кода ещё нет: агент пишет — ждём его отчёт" };
    }
    if (failed) {
        const a = adv(failed);
        if (a)
            return { kind: ["wait", "busy", "agent"].includes(a.act) ? "info" : "bad", text: `Упал «${failed.label}». ${a.text}`, act: "advice", jobId: failed.id, advice: a, note: failed.note || "" };
        return { kind: "bad", text: `Упал «${failed.label}» — отдайте лог агенту слота`, act: "report", jobId: failed.id };
    }
    const v = t.verdict || {};
    {
        const c = ["build", "tests", "guards", "review", "regress", "staging"].includes(cur.id) && conflictNext(t);
        if (c)
            return c;
    }
    switch (cur.id) {
        case "plan": return { kind: "info", text: "Нет плана волны — это работа оркестратора" };
        case "impl": return { kind: "info", text: "Агент пишет код — ждём его отчёт" };
        case "build": return { kind: "go", text: v.bnote || "Собрать перед тестами" + (t.buildWhat ? ": " + t.buildWhat : ""), act: "build" };
        case "tests": return { kind: "go", text: v.note || "Прогнать тесты " + (t.train ? "вагона " + (t.wagon || "") : "волны"), act: "tests" };
        case "guards":
            if (v.guards === "fail" && v.gfail)
                return { kind: "bad", text: v.gfail + ". Перепрогонять нечего — нужна правка кода агентом слота", act: "advice", jobId: v.gfailJob };
            return { kind: "go", text: v.gnote || "Прогнать гарды — задачи-гейты проекта: " + (gateIds().join(", ") || "в конфиге их нет"), act: "guards" };
        case "review": {
            const r = t.review;
            const n = r && r.fresh && r.verdict && r.verdict !== "ЗА"
                ? (reviewOwed(t) ? { kind: "bad", text: "Ревьюер: " + r.verdict + ". Замечания ещё НЕ отданы агенту волны — повторять ревью незачем, код тот же" } : { kind: "info", text: "Ревьюер: " + r.verdict + ". Замечания у агента — ждём правку; если вопросы снимаются без правок, отметьте станцию «Ревью» кликом" })
                : { kind: "go", text: r && !r.fresh ? "Код менялся после ревью — повторить" : "Независимое ревью: отдельная сессия без контекста автора посмотрит дифф" };
            return { ...n, act: "review" };
        }
        case "regress": return { kind: "go", text: v.rnote || "Прогнать регресс: соседи по тронутым путям — " + (t.regress || []).map((x) => x.label + (x.input ? " " + x.input : "")).join("; "), act: "regress" };
        case "commit":
            if (t.dirtyTracked)
                return { kind: "warn", text: `Нужен коммит: в слоте ${t.dirtyTracked} изменённых файлов. Кнопка отправит задачу агенту слота: подпись он напишет сам`, act: "commit" };
            return { kind: "info", text: "В ветке нет коммитов: закоммитьте работу слота" };
        case "staging": {
            if (t.dirtyTracked)
                return { kind: "warn", text: `Нужен коммит: в слоте ${t.dirtyTracked} изменённых файлов. Кнопка отправит задачу агенту слота: подпись он напишет сам`, act: "commit" };
            if (!t.ahead)
                return { kind: "info", text: "В ветке нет коммитов — вливать нечего" };
            const w = (t.deps || []).filter((d) => !d.merged);
            if (w.length)
                return { kind: "warn", text: "Вливать после " + w.map((d) => d.tag).join(", ") + ": эта волна стоит на их коде, а они ещё не в staging. Кнопка «Влить» появится, когда " + (w.length > 1 ? "они будут влиты" : w[0].tag + " будет влита") };
            const gap = st.filter((x) => CHECKS.includes(x.id) && !x.done);
            if (gap.length)
                return { kind: "warn", text: "Вливать рано: не пройдено «" + gap.map((x) => x.label).join("», «") + "» на нынешнем коде. Если проверка правда не нужна — отметьте станцию кликом или «Влить…» → «Влить всё равно»", act: gap[0].id, mergeSoft: !gap.some((x) => x.id === "build" || x.id === "tests") };
            if (wagonUnfinished(t, waveFinalOf(t)))
                return { kind: "info", text: "Станции зелёные, но агент не доложил «ГОТОВО» по вагону " + t.wagon + " — вливать рано: диспетчерская спросит агента сама. Влить без доклада — «Влить…» → «Влить всё равно»" };
            return { kind: "go", text: "Можно вливать в staging", act: "merge" };
        }
        case "accept": return { kind: "go", text: "Принять на стенде: чек-лист в панели «Приёмка»", act: "accept" };
        case "stand": return { kind: "go", stand: true, text: "Выкатить staging на стенд и принять", act: "stand" };
        case "prod": return { kind: "go", text: "Принять стенд и выкатить в прод", act: "prod" };
        case "site": return { kind: "info", text: "Проверьте результат на сайте и отметьте станцию кликом" };
    }
    return { kind: "info", text: cur.label };
}

export const trainHasWagonsLeft = (t) => !!t && !!t.train && (t.wagons || []).some((w) => w.state !== "staging");

export function slotGroup(t, ag, next, ctx) {
    if (t.verdict && t.verdict.merged && !trainHasWagonsLeft(t))
        return "merged";
    const active = jobList().some((j) => j.tree === t.key && ACTIVE.includes(j.status));
    if (!t.exists)
        return active ? "work" : "need";
    if (ag && ag.pending)
        return "need";
    if (ctx.inbox.some((x) => x.tree === t.key && ["relay", "verify", "result", "slotstart", "ownerq"].includes(x.kind)))
        return "need";
    if (ctx.reqs.some((g) => g.tree === t.key && g.items.some((i) => i.status !== "ok" && i.status !== "run" && i.status !== "skip")))
        return "need";
    if (((snapNow() && snapNow().orderHints) || []).some((h) => h.a === t.key || h.b === t.key))
        return "need";
    if (active || (ag && ag.busy))
        return "work";
    const tr = trainNow();
    if (tr && ["run", "green", "merging"].includes(tr.status) && (tr.keys || []).includes(t.key))
        return "train";
    return next && ["bad", "go", "warn"].includes(next.kind) ? "need" : "idle";
}

export function wagonsView(t, st, far) {
    if (!t || !t.train || !Array.isArray(t.wagons))
        return null;
    const cur = st[far + 1] || null, committed = t.ahead > 0 && !t.dirtyTracked && !t.dirtyUntracked;
    const ti = t.wagons.findIndex((w) => w.wave === t.wagon), prodDone = ti >= 0 && t.wagons[ti].state === "staging" && !!(st.find((s) => s.id === "prod") || {}).done;
    return t.wagons.map((w, i) => ({ wave: w.wave, title: w.title || "", state: w.state, commits: w.commits || 0, after: w.after || [], waitFor: w.waitFor || [], times: w.times || {},
        ...wagonStation(w, { tree: t.wagon || "", issued: t.issued || "", cur, committed, stages: st, stand: (t.standWaves || []).includes(w.wave), prod: prodDone && i < ti }) }));
}

export function treeView(t, ctx) {
    if (t.kind !== "slot")
        return { cur: null, next: null, group: null, readyStg: false };
    const ag = agentPublic(t.key);
    if (!t.exists)
        return { cur: null, next: { kind: "info", text: "папка слота готовится" }, group: slotGroup(t, ag, null, ctx), readyStg: false };
    const st = stagesView(t, ag), far = farOf(st, t, ag);
    const mw = !(t.verdict && t.verdict.merged) ? mergeWaitView(t.key) : null;
    const next = (!(t.verdict && t.verdict.merged) && prepNext({ jobs: jobList().filter((j) => j.tree === t.key && j.task === "slot-up") })) || (mw ? { kind: mw.state === "red" ? "warn" : "info", text: mw.text, act: "mergewait" } : null) || nextStep(t, st, ag, far);
    return { stages: st, cur: far + 1, next, readyStg: readyStg(t, st), group: slotGroup(t, ag, next, ctx), ...(mw ? { mergeWait: mw } : {}), ...(t.train ? { wagonsView: wagonsView(t, st, far) } : {}) };
}

export function ganttView(views, epic, ctx = {}, now = Date.now()) {
    const slots = (views || []).filter((t) => t.kind === "slot" && !t.archived);
    if (!slots.length)
        return null;
    const openAsk = (ctx.inbox || []).filter((c) => c.kind === "ownerq").map((c) => c.tree);
    try {
        return ganttLayout({ trees: slots, events: ganttEventsOf(epic, slots, { now }), now, openAsk });
    }
    catch (e) {
        return { error: String(e && e.message || e) };
    }
}
