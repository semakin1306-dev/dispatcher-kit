// tasks.js — правая колонка «Задачи»: карточки прогонов, «ждут вашего действия», поезд влива, порядок, напоминания,
// эпики.
import { IN, OPENCHAT, PENDING, REM_ADD_OPEN, S } from "./state.js";
import { $, call, agentIcon, dur, esc, gateTasks, ls, modOn, SPIN } from "./core.js";
import { ownerQuestions } from "./owner-options.js";
import { oqFormHTML, oqScope } from "./oqform.js";
import { press } from "./render.js";
import { manyMsg, runMany } from "./run.js";
import { treeOf } from "./data.js";
import { jobCarsHtml, readyStg, reviewOwed, stgBtn } from "./lines.js";
import { RAILM, renderSide } from "./side.js";
import { hhmm } from "./monitor.js";

export const DISM = new Set((() => {
    try {
        return JSON.parse(localStorage.getItem("dash.dismissed") || "[]");
    }
    catch {
        return [];
    }
})());

const PIPELINE_TASKS = ["merge", "deploy-staging", "release", "commit", "slot-up"];
export const FLY_MS = 5000;

export function adviceUi(j) {
    const a = j.advice || {}, b = (act, lab, extra = "") => `<button class="sm primary" data-act="${act}" ${extra}>${lab}</button>`;
    const btn = a.act === "rerun" ? b("rerun", "↻ Перепрогнать", `data-id="${j.id}"`)
        : a.act === "build" ? b("run", "🔨 Сборка", `data-tree="${esc(j.tree)}" data-task="build"`)
            : a.act === "relay" ? b("inbox-send", "→ Ответ агента оркестратору", `data-id="${esc(a.ib)}"`)
                : a.act === "report" ? b("report", j.note === "baseline-shrunk" ? "→ Оркестратору" : batchLabel(j), `data-id="${j.id}"${j.note === "baseline-shrunk" ? ' data-to="orchestrator"' : ""}`)
                    : a.act === "wait" ? `<span class="chip ok">✓ у агента${j.reportedAt ? " с " + hhmm(j.reportedAt) : ""}</span><button class="sm" data-act="focuschat" data-tree="${esc(j.tree)}">чат</button>`
                        : a.act === "busy" ? `<span class="chip running">${SPIN} идёт</span>`
                            : a.act === "agent" ? `<span class="chip running">${SPIN} агент думает</span><button class="sm" data-act="focuschat" data-tree="${esc(j.tree)}">чат</button>`
                                : "";
    return { text: a.text || "", btn };
}

export function failedUnresolved() {
    const byKey = new Map();
    for (const j of S.jobs) {
        const k = j.tree + "|" + j.task + "|" + (j.input || "");
        if (!byKey.has(k))
            byKey.set(k, []);
        byKey.get(k).push(j);
    }
    const out = [];
    for (const list of byKey.values()) {
        const last = list[list.length - 1], active = ["running", "queued", "waiting"].includes(last.status);
        const j = active ? [...list].reverse().find((x) => ["ok", "fail", "interrupted", "skipped", "cancelled"].includes(x.status)) : last;
        if (!j || DISM.has(j.id) || j.task === "slot-up" || (j.advice && ["inherited", "obsolete"].includes(j.advice.act)))
            continue;
        if (j.task === "review" && /^ВЕРДИКТ/.test(j.summary || ""))
            continue;
        if (j.status === "fail" || (j.status === "interrupted" && !j.requeued && !active))
            out.push(active ? { ...j, rerunning: last } : j);
    }
    const toks = (x) => String(x.input || "").toLowerCase().split(/[\s,]+/).filter(Boolean);
    const greenAfter = (j) => {
        const a = toks(j);
        let seen = false;
        for (const x of S.jobs) {
            if (x === j || x.id === j.id) {
                seen = true;
                continue;
            }
            if (!seen || x.status !== "ok" || x.tree !== j.tree || x.task !== j.task)
                continue;
            const b = toks(x);
            if ((!a.length && !b.length) || b.some((w) => a.includes(w)))
                return true;
        }
        return false;
    };
    return out.filter((j) => !greenAfter(j));
}

function taskWho(j) {
    const t = treeOf(j.tree);
    return t ? `<span class="dotc" style="--c:${t.color}"></span>${esc(t.tag)}${t.train ? jobCarsHtml(t, j.wagons) : ""}` : j.tree === "orchestrator-staging" ? "staging" : j.tree === "orchestrator-main" ? "main" : esc(j.tree);
}

function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return s >= 60 ? Math.floor(s / 60) + " мин " + (s % 60) + " с" : s + " с";
}

export function progBar(j) {
    const el = j.startedAt ? Date.now() - j.startedAt : 0, eta = j.etaMs, pr = j.prog;
    let p = null, left = null, timed = false;
    const parts = [];
    if (pr && pr.total) {
        p = Math.min(0.97, (pr.done + (pr.kind === "marks" ? 0.5 : Math.min(pr.total - pr.done, j.workers || 2) * 0.35)) / pr.total);
        parts.push((pr.unit || "сьютов") + " " + pr.done + " из " + (pr.approx ? "≈" : "") + pr.total + (pr.phase ? ": " + pr.phase : ""));
        const byRate = pr.done > 0 ? (el / pr.done) * Math.max(0, pr.total - pr.done) : null, byHist = eta ? Math.max(0, eta - el) : null;
        left = byRate != null && byHist != null ? (byRate + byHist) / 2 : byRate != null ? byRate : byHist;
    }
    else if (pr) {
        parts.push("сьютов прошло " + pr.done);
        if (eta && el < eta) {
            p = Math.min(0.97, el / eta);
            left = Math.max(0, eta - el);
            timed = true;
        }
        else if (eta) {
            p = 0.97;
            parts.push("дольше прежних прогонов (~" + fmtDur(eta) + "), идёт — смотрите счётчик сьютов");
            left = -1;
        }
    }
    else if (eta) {
        p = Math.min(0.97, el / eta);
        left = Math.max(0, eta - el);
        timed = true;
    }
    if (j.stepsTotal > 1)
        parts.push("шаг " + j.step + " из " + j.stepsTotal);
    parts.push('прошло <span data-t0="' + (j.startedAt || Date.now()) + '"></span>');
    if (left === -1) { }
    else if (left != null)
        parts.push(eta && el > eta * 1.25 && !(pr && pr.done) ? "дольше обычного (~" + fmtDur(eta) + ")" : "осталось ≈ " + fmtDur(left));
    else
        parts.push("замеров прежних прогонов нет, осталось неизвестно");
    return '<div class="pbar ' + (p == null ? "ind" : "") + '"><i ' + (timed ? 'data-pb="' + j.startedAt + "," + eta + '"' : "") + ' style="width:' + (p == null ? 38 : Math.round(p * 100)) + '%"></i></div><div class="sub" style="font-size:11px">' + parts.join(" · ") + "</div>";
}

function batchLabel(j) {
    const c = (S.inbox || []).find((x) => x.kind === "result" && (x.jobIds || []).includes(j.id));
    return c ? "→ Агенту: весь пакет (" + c.jobIds.length + ")" : "→ Агенту";
}

export const shortInput = (j) => {
    const x = String(j.input || "");
    if (x.length <= 70)
        return x;
    const n = (j.suiteExp || []).length;
    return x.slice(0, 60) + "…" + (n ? " (" + n + " спек)" : "");
};

export function suiteListHTML(j) {
    const done = j.suiteDone || {}, exp = j.suiteExp || [], names = [...new Set([...exp, ...Object.keys(done)])];
    if (!names.length)
        return "";
    const ok = names.filter((n) => done[n] === "ok").length, bad = names.filter((n) => done[n] === "fail").length, left = names.length - ok - bad;
    const order = (n) => (done[n] === "fail" ? 0 : !done[n] ? 1 : 2);
    const rows = names.slice().sort((a, b) => order(a) - order(b)).map((n) => {
        const st = done[n], ic = st === "ok" ? '<span style="color:var(--good)">✓</span>' : st === "fail" ? '<span style="color:var(--bad)">✗</span>' : j.status === "running" ? '<span class="mute">○</span>' : '<span class="mute">–</span>';
        return `<div class="vst">${ic}<span class="mono">${esc(n.replace(/\.(spec|test)\.[cm]?[jt]sx?$/, ""))}</span></div>`;
    }).join("");
    return `<details class="vstree" ${names.length <= 40 ? "open" : ""}><summary>сьюты: <span style="color:var(--good)">✓ ${ok}</span>${bad ? ` · <span style="color:var(--bad)">✗ ${bad}</span>` : ""}${left ? ` · <span class="mute">○ ${left}</span>` : ""} из ${names.length}${exp.length ? "" : " (пока известные)"}</summary><div class="vsl">${rows}</div></details>`;
}

export function taskCard(j, kind) {
    const title = `${esc(j.label)}${j.input ? ` <span class="mono mute" title="${esc(j.input)}">${esc(shortInput(j))}</span>` : ""}`;
    if (kind === "run") {
        const quiet = j.lastOutAt ? Math.round((Date.now() - j.lastOutAt) / 1000) : null, tail = (j.tailLines || []).slice(-3).map((l) => esc(l.slice(0, 120))).join("\n");
        return `<div class="tk run"><div class="tkh"><span class="beat ${quiet != null && quiet > 20 ? "quiet" : ""}"></span><b>${taskWho(j)}</b><span class="chip running">${SPIN} ${dur(j)}</span><span class="sp"></span><button class="kill" data-act="cancel" data-id="${j.id}" title="Остановить">⏹</button></div>
      <div class="tkt">${title}</div>${progBar(j)}${suiteListHTML(j)}<pre class="tkp" data-act="log" data-id="${j.id}" title="Открыть весь лог">${tail || "ждём первых строк…"}</pre></div>`;
    }
    if (kind === "wait")
        return `<div class="tk wait"><div class="tkh"><b>${taskWho(j)}</b><span class="chip queued">${j.status === "waiting" ? "ждёт память" : j.waitReason ? "ждёт агента" : "очередь" + (j.pos ? " №" + j.pos : "")}</span><span class="sp"></span>${j.status === "waiting" || j.waitReason ? `<button class="sm" data-act="force" data-id="${j.id}" title="Запустить, не дожидаясь памяти или агента слота">всё равно</button>` : ""}<button class="kill" data-act="cancel" data-id="${j.id}" title="Убрать из очереди">⏹</button></div><div class="tkt">${title}</div>${j.waitReason ? `<div class="sub" style="font-size:11px">${esc(j.waitReason)}</div>` : (() => {
            const r = S.jobs.find((x) => x.status === "running" && x.lane === j.lane);
            const rt = r && treeOf(r.tree);
            return r ? `<div class="sub" style="font-size:11px">принят, стоит в очереди: начнётся, когда закончится ${esc(rt ? rt.tag : r.tree)} · ${esc(r.label)}</div>` : '<div class="sub" style="font-size:11px">принят, сейчас начнётся</div>';
        })()}</div>`;
    if (kind === "ok") {
        const elapsed = (Date.now() - (j.endedAt || Date.now())) / 1000;
        return `<div class="tk ok fly" style="--d:${(FLY_MS / 1000 - elapsed).toFixed(2)}s"><div class="tkh"><b>${taskWho(j)}</b><span class="chip ok">✓ готово · ${dur(j)}</span></div><div class="tkt">${title}</div></div>`;
    }
    const rerun = !PIPELINE_TASKS.includes(j.task);
    const adv = !j.rerunning && j.advice ? adviceUi(j) : null;
    return `<div class="tk bad"><div class="tkh"><b>${taskWho(j)}</b><span class="chip fail">${j.status === "interrupted" ? "! прерван" : "✗ упал"} ${j.endedAt ? hhmm(j.endedAt) : ""} · ${dur(j)}</span><span class="sp"></span><button class="kill" data-act="dismiss" data-id="${j.id}" title="Убрать из списка" style="color:var(--text-2)">✕</button></div>
    <div class="tkt">${title}</div><div class="sub tks" data-act="log" data-id="${j.id}" title="Открыть лог">${esc((j.summary || "").slice(0, 160)) || "см. лог"}</div>
    ${adv ? `<div class="sub" style="font-size:12px;color:var(--text)"><b>Дальше:</b> ${esc(adv.text)}</div><div class="chips">${adv.btn}<button class="sm" data-act="log" data-id="${j.id}">лог</button></div></div>` : ""}${adv ? "" : `<div class="chips">${j.rerunning ? '<span class="chip running" title="Это падение прошлого прогона: новый ещё идёт, карточка обновится сама">' + SPIN + " идёт повторный прогон</span>" : j.reported ? '<span class="chip ok" title="Причина именно этого падения отправлена агенту слота">✓ отправлено агенту' + (j.reportedAt ? " " + hhmm(j.reportedAt) : "") + (j.reportedVia === "auto" ? " (автоотчёт)" : "") + "</span>" : (j.note === "baseline-shrunk" ? `<button class="sm primary" data-act="report" data-to="orchestrator" data-id="${j.id}" title="Базис гарда правит оркестратор: гард говорит, что долг стал меньше">→ Оркестратору</button>` : `<button class="sm primary" data-act="report" data-id="${j.id}" title="Причина падения уйдёт в чат агента этой ветки">${batchLabel(j)}</button>`)}<button class="sm" data-act="log" data-id="${j.id}">лог</button>${rerun ? `<button class="sm" data-act="rerun" data-id="${j.id}">повторить</button>` : ""}</div></div>`}`;
}

const AGENT_DONE_MS = 9000;

function agentCards() {
    const out = [], ags = S.agents || {}, now = Date.now();
    for (const t of S.trees) {
        const ag = ags[t.key];
        if (!ag)
            continue;
        const who = '<span class="dotc" style="--c:' + t.color + '"></span>' + esc(t.tag);
        if (ag.pending)
            out.push({ k: "wait", html: '<div class="tk wait"><div class="tkh">' + agentIcon(t.color, "wait", 26) + '<b>' + who + '</b><span class="chip queued">🔐 ждёт разрешения</span><span class="sp"></span><button class="sm primary" data-act="focuschat" data-tree="' + esc(t.key) + '">Открыть чат</button></div><div class="tkt">Агент ' + esc(t.tag) + ' просит разрешение</div><div class="sub" style="font-size:11px">' + esc(ag.activity || "") + "</div></div>" });
        else if (ag.busy)
            out.push({ k: "run", html: '<div class="tk run"><div class="tkh">' + agentIcon(t.color, "work", 26) + '<b>' + who + '</b><span class="chip running">работает ' + (ag.turnAt ? '<span data-t0="' + ag.turnAt + '"></span>' : "") + '</span><span class="sp"></span><button class="sm" data-act="focuschat" data-tree="' + esc(t.key) + '">чат</button><button class="kill" data-act="agentstop" data-tree="' + esc(t.key) + '" title="Прервать ответ">⏹</button></div><div class="tkt">Агент ' + esc(t.tag) + ' отвечает</div><div class="sub tks" style="cursor:default">' + esc(ag.activity || "думает…") + "</div></div>" });
        else if (ag.last && now - ag.last.at < AGENT_DONE_MS) {
            const el = (now - ag.last.at) / 1000;
            out.push({ k: ag.last.ok ? "ok" : "bad", html: ag.last.ok
                    ? '<div class="tk ok fly" style="--d:' + (AGENT_DONE_MS / 1000 - 0.7 - el).toFixed(2) + 's"><div class="tkh">' + agentIcon(t.color, "warm", 26) + '<b>' + who + '</b><span class="chip ok">✓ агент ответил · ' + ag.last.sec + ' с</span><span class="sp"></span><button class="sm" data-act="focuschat" data-tree="' + esc(t.key) + '">читать</button></div></div>'
                    : '<div class="tk bad"><div class="tkh"><b>' + who + '</b><span class="chip fail">✗ ответ с ошибкой</span><span class="sp"></span><button class="sm" data-act="focuschat" data-tree="' + esc(t.key) + '">чат</button></div><div class="sub" style="font-size:11px">' + esc(ag.last.why || "") + "</div></div>" });
        }
    }
    return out;
}

export function runGuards(tree) {
    press("rungards|" + tree, () => runMany(gateTasks().map((task) => ({ tree, task, input: "" }))), manyMsg("гарды"));
}

export function agentCommit(tree) {
    press("commit|" + tree, async () => {
        const r = await call("/api/agent-commit", { tree });
        OPENCHAT.add(tree);
        ls("dash.chats", [...OPENCHAT]);
        return r;
    }, (r) => (r.already ? "Коммит " : "Коммит поставлен в очередь задач: ") + (treeOf(tree) ? treeOf(tree).tag : tree) + ", " + r.files + " файл(ов)" + (r.already ? " уже в очереди" : "; уйдёт агенту, когда он допишет текущий ответ, подпись он напишет сам"));
}

export function pendingCards(run, wait) {
    const live = (tree, task) => run.concat(wait).some((j) => j.tree === tree && (!task || j.task === task)), out = [];
    for (const k of PENDING) {
        let m, tree, label;
        if ((m = /^run\|([^|]+)\|(.+)$/.exec(k))) {
            tree = m[1];
            if (live(tree, m[2]))
                continue;
            label = (S.tasks[m[2]] || {}).label || m[2];
        }
        else if ((m = /^runall\|(.+)$/.exec(k))) {
            tree = m[1];
            if (live(tree))
                continue;
            label = "Тесты волны";
        }
        else if (k === "stg-sec") {
            if (live("orchestrator-staging"))
                continue;
            tree = "orchestrator-staging";
            label = "Гарды на staging";
        }
        else
            continue;
        const t = treeOf(tree), who = t ? `<span class="dotc" style="--c:${t.color}"></span>${esc(t.tag)}` : "staging";
        out.push(`<div class="tk run"><div class="tkh"><b>${who}</b><span class="chip running">${SPIN} запускаю…</span></div><div class="tkt">${esc(label)}</div><div class="sub" style="font-size:11px">собираю шаги и ставлю в очередь</div></div>`);
    }
    return out.join("");
}

const reqLeft = (g) => g.items.filter((x) => x.status !== "ok" && x.status !== "run" && x.status !== "skip");
const ownerReqs = () => (S.testReqs || []).filter((g) => reqLeft(g).length);

function reqCards() {
    return ownerReqs().map((g) => {
        const t = treeOf(g.tree) || {}, who = `<span class="dotc" style="--c:${t.color || "var(--accent)"}"></span>${esc(t.tag || g.tree)}`;
        const left = reqLeft(g).length, ic = { ok: "✓", run: "⏳", fail: "✗", stale: "⟳", todo: "○", skip: "∅" }, col = { ok: "var(--good)", fail: "var(--bad)", stale: "var(--warn)", run: "var(--run)", todo: "var(--text-2)", skip: "var(--text-3)" };
        const rows = g.items.map((x) => `<div class="stf" style="grid-template-columns:20px minmax(0,1fr) auto;align-items:center"><span style="color:${col[x.status] || "var(--text-3)"};font-weight:700" title="${esc({ ok: "прогнан и зелёный на нынешнем коде", run: "идёт", fail: "упал", stale: "был зелёным, но код менялся", todo: "ещё не запускали", skip: "неприменимо — тесты не запускались" + (x.why ? ": " + x.why : "") }[x.status] || x.status || "")}">${ic[x.status] || "?"}</span><span style="min-width:0"><span style="font-size:12.5px">${esc((S.tasks[x.task] || {}).label || x.task)}</span> <span class="mono mute">${esc(x.input)}</span>${x.note ? `<div class="sub" style="font-size:11px">${esc(x.note)}</div>` : ""}</span>${x.status === "ok" || x.status === "run" || x.status === "skip" ? "" : `<button class="sm" data-act="reqrun" data-tree="${esc(g.tree)}" data-task="${esc(x.task)}" data-input="${esc(x.input)}">▶</button>`}</div>`).join("");
        return `<div class="tk ${left ? "go" : "ok"}"><div class="tkh"><b>${who}</b><span class="chip queued">не запущено: ${left} из ${g.items.length}</span></div><div class="tkt">Агент назвал тесты для запуска в своей ветке</div>${rows}${left > 1 ? `<div class="chips"><button class="sm primary" data-act="reqall" data-tree="${esc(g.tree)}">▶ Запустить незапущенные (${left})</button></div>` : ""}</div>`;
    }).join("");
}

export function renderEpics() {
    const host = $("epics");
    if (!host || !S)
        return;
    const eps = S.epics || [];
    if (!eps.length) {
        host.innerHTML = "";
        return;
    }
    const open = eps.filter((e) => e.status !== "closed"), closed = eps.filter((e) => e.status === "closed"), act = eps.find((e) => e.active);
    const closedHtml = closed.map((e) => `<button class="sm" data-act="epicrestore" data-id="${esc(e.id)}">↺ ${esc(e.title.split(":")[0])}</button>${modOn("retro") ? `<button class="sm ghost" data-act="epicretro" data-id="${esc(e.id)}" title="Ретроспектива эпика: ответ агента ретро">📝</button>` : ""}`).join(" ");
    host.innerHTML = `<span class="mute" style="font-size:11px;letter-spacing:.04em">ЭПИКИ</span>` + open.map((e) => `<button class="ept ${e.active ? "on" : ""}" data-act="epicgo" data-id="${esc(e.id)}" title="${esc(e.title)}&#10;ветка оркестратора: ${esc(e.orchBranch)}&#10;слотов: ${e.slots}">${esc(e.title.split(":")[0] || e.id)}<small>${e.slots}</small></button>`).join("") +
        `<button class="ept add" data-act="epicnew" title="Как завести новый эпик">+ новый эпик</button>` +
        (act && open.length > 1 ? `<button class="sm ghost" data-act="epicarchive" data-id="${esc(act.id)}" title="Убрать вкладку (папки и ветки не трогаются)">в архив</button>` : "") +
        (act ? `<button class="sm" data-act="epicclose" data-id="${esc(act.id)}" data-title="${esc(act.title)}" title="Закрыть эпик после выката (epic.mjs close: ветка оркестратора влита, нет несохранённого). Папки и ветки не трогаются; сразу запускается ретро-агент — окно с ответом откроется само">✓ Закрыть эпик</button>` : "") +
        (act && modOn("retro") ? `<button class="sm ghost" data-act="epicretro" data-id="${esc(act.id)}" title="Ретроспектива эпика: ответ ретро-агента (на открытом эпике — промежуточная)">📝 Ретро</button>` : "") +
        (act ? `<button class="sm" data-act="epicprogress" data-id="${esc(act.id)}" title="Ход эпика за сутки: что готово и не влито (сколько ждёт, что держит), простой с причиной, отказы и тупики команд, перезапуски, касания владельца, токены агентов">📈 Ход эпика</button>` : "") +
        (closed.length ? `<details class="epc"><summary>архив · ${closed.length}</summary>${closedHtml}</details>` : "");
}

export function openNewEpic() {
    const tr = S.retroTriage && (S.retroTriage.open || []).length ? S.retroTriage : null;
    $("mb").innerHTML = `<h3>Новый эпик</h3><div class="sub">Эпик заводит оркестратор: ему нужно обсудить с вами слоты, написать план и поднять папки. Дашборд только показывает вкладку.</div>
    ${tr ? `<div class="stb"><div class="stt">⚠ Сначала ретро «${esc(String(tr.title || tr.epic).split(":")[0])}»</div><div class="stf"><span>!</span><span>${tr.open.length} карточек ретро ждут решения (${esc(tr.open.join(", "))}): «берём» в эпик или «отказ» с причиной. До разбора <code>epic.mjs new</code> откажет; обход — только вашим словом (<code>--skip-retro</code>).</span><span></span></div><div class="chips"><button class="sm primary" data-act="bltriage">📥 Разобрать</button></div></div>` : ""}
    <div class="stb"><div class="stt">Быстро: волна в текущий эпик</div><div class="stf"><span>→</span><span>В окне оркестратора напишите коротко, что за волна (и, если нужно, область). Он сам найдёт свободный номер WV, ветку, слот, папку и план; слот появится здесь сам через несколько секунд:</span><span></span></div><pre class="stpre">/new-slot Короткое описание волны, область api</pre></div>
    <div class="stb"><div class="stt">Новый эпик</div><div class="stf"><span>1.</span><span>Откройте окно «Оркестратор» (папка эпика) и напишите команду:</span><span></span></div><pre class="stpre">/new-epic</pre>
    <div class="stf"><span>2.</span><span>Ответьте на вопросы: название, цель, слоты (метка, ветка, область). Оркестратор сам создаст ветки и папки, файлы плана и эту вкладку.</span><span></span></div>
    <div class="stf"><span>3.</span><span>Когда эпик закончен и всё влито в staging:</span><span></span></div><pre class="stpre">/close-epic</pre></div>
    <div class="sub">Вкладка появится здесь сама. Ничего не коммитится и не удаляется без вашего слова: ветки остаются.</div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button class="primary" data-act="mclose">Понятно</button></div>`;
    $("modal").classList.add("on");
}

export function trainCard() {
    const T = S.train || {}, c = T.candidates || [], cur = T.cur, st = cur && cur.status;
    const busy = (k) => PENDING.has("train|" + k) ? "busy" : "";
    if (!cur || ["merged", "stopped"].includes(st)) {
        if (c.length < 2)
            return st === "merged" ? '<div class="tk ok"><div class="tkh"><b>Поезд</b><span class="chip ok">✓ влит</span><span class="sp"></span><button class="kill" data-act="train" data-op="clear" title="Убрать">✕</button></div><div class="tkt">' + esc((cur.keys || []).map((k) => (S.trees.find((t) => t.key === k) || {}).tag).join(" + ")) + " в staging</div></div>" : "";
        return `<div class="tk go"><div class="tkh"><b>Поезд в staging</b><span class="chip ok">готовы: ${c.length}</span></div><div class="tkt">Готовы ветки ${esc(c.map((x) => x.tag).join(", "))}. Проверить их ВМЕСТЕ на дереве «staging + все» одним прогоном регресса; упадёт — диспетчерская сама поделит состав пополам и найдёт виновника.</div><div class="chips"><button class="sm primary ${busy("start")}" data-act="train" data-op="start">▶ Проверить вместе</button></div></div>`;
    }
    const runs = (cur.runs || []).map((r) => `<div class="sub" style="font-size:11.5px">${r.status === "ok" ? "✓" : r.status === "fail" ? "✗" : r.status === "cancelled" ? "⏹" : "⏳"} ${esc((r.tags || []).join(" + "))} <span class="mute">· ${esc(r.why || "")}${r.fails && r.fails.length ? " · " + esc(r.fails.slice(0, 3).join(", ")) : ""}</span> <button class="sm ghost" data-act="log" data-id="${r.id}">лог</button></div>`).join("");
    const cul = Object.entries(cur.culpritTags || {}).map(([t, why]) => `<div class="sub" style="font-size:11.5px;color:var(--bad)">✗ ${esc(t)}: ${esc(why)}</div>`).join("");
    const head = { run: ["running", SPIN + " проверяется"], green: ["ok", "✓ зелёный"], fail: ["fail", "✗ все вагоны красные"], merging: ["running", SPIN + " вливается"], mergefail: ["fail", "✗ влив упал"] }[st] || ["", st];
    const btn = st === "green" ? `<button class="sm primary ${busy("merge")}" data-act="train" data-op="merge">⇢ Влить поездом (${(cur.runs.find((r) => r.id === cur.green) || {}).keys.length})</button>` : st === "run" ? `<button class="sm ghost" data-act="train" data-op="stop">⏹ остановить</button>` : `<button class="sm" data-act="train" data-op="start">↻ собрать заново</button><button class="sm ghost" data-act="train" data-op="clear">убрать</button>`;
    return `<div class="tk ${st === "fail" || st === "mergefail" ? "bad" : "go"}"><div class="tkh"><b>Поезд в staging</b><span class="chip ${head[0]}">${head[1]}</span></div><div class="tkt">Состав: ${esc((cur.keys || []).map((k) => (S.trees.find((t) => t.key === k) || {}).tag).join(" + "))}${st === "green" ? ". Зелёный на staging + все; действует, пока staging и код вагонов не менялись" : ""}</div>${cur.note ? `<div class="sub" style="font-size:11.5px;color:var(--bad)">${esc(cur.note)}</div>` : ""}${cul}${runs}<div class="chips">${btn}</div></div>`;
}

export function trainStatusCard() {
    const c = (S.train && S.train.candidates) || [], NEED = ["build", "tests", "guards", "regress", "review"];
    const near = S.trees.filter((t) => t.kind === "slot" && t.exists && !t.readOnly && t.ahead > 0 && !(t.verdict && t.verdict.merged) && !c.some((x) => x.key === t.key))
        .map((t) => ({ t, miss: (t.stages || []).filter((x) => NEED.includes(x.id) && !x.done).map((x) => x.label) })).sort((a, b) => a.miss.length - b.miss.length).slice(0, 5);
    return `<div class="tk"><div class="tkh"><b>Поезд в staging</b><span class="chip ${c.length >= 2 ? "ok" : ""}">готовы: ${c.length}</span></div><div class="tkt">Собирается из двух и более веток, у которых пройдены сборка, тесты, гарды, регресс и ревью. Тогда здесь и в «Ждут вашего действия» появится «▶ Проверить вместе».${c.length ? " Готовы: " + esc(c.map((x) => x.tag).join(", ")) + "." : ""}</div>${near.map((x) => `<div class="sub" style="font-size:11.5px"><span class="dotc" style="--c:${x.t.color}"></span>${esc(x.t.tag)}: не хватает ${esc(x.miss.join(", ") || "—")}${reviewOwed(x.t) ? ` · <b style="color:var(--bad)">замечания ревью не отданы агенту</b> <button class="sm primary" data-act="report" data-id="${x.t.review.jobId}">→ Агенту</button>` : ""}</div>`).join("")}</div>`;
}

function orderCards() {
    return (S.orderHints || []).map((h) => `<div class="tk go"><div class="tkh"><b>Порядок: ${esc(h.at)} и ${esc(h.bt)}</b>${h.conflict ? '<span class="chip fail">конфликт слияния</span>' : '<span class="chip queued">общий код</span>'}</div><div class="tkt">Обе ветки трогают ${esc([...h.zones, ...(h.nfiles ? [h.nfiles + " общ. файл(ов)"] : [])].join(", "))}. Если одна строится на коде другой, вливать надо по порядку.</div>${h.files.length ? '<div class="sub mono" style="font-size:11px">' + h.files.map(esc).join("<br>") + "</div>" : ""}<div class="chips"><button class="sm" data-act="order" data-a="${esc(h.b)}" data-b="${esc(h.a)}">${esc(h.bt)} после ${esc(h.at)}</button><button class="sm" data-act="order" data-a="${esc(h.a)}" data-b="${esc(h.b)}">${esc(h.at)} после ${esc(h.bt)}</button><button class="sm ghost" data-act="order" data-a="${esc(h.a)}" data-b="${esc(h.b)}" data-op="none">не связаны</button></div></div>`).join("");
}

export function flakyCards() {
    const f = S.flaky || [];
    if (!f.length)
        return "";
    return `<div class="tk"><div class="tkh"><b>Карантин</b><span class="chip queued">${f.length}</span></div><div class="tkt">Нестабильные спеки: на одном и том же коде и падали, и проходили. Слотам не вменяются и волн не заводят; выходят сами после 8 зелёных подряд.</div>${f.map((x) => `<div class="sub mono" style="font-size:11px">≈ ${esc(x.spec)} <span class="mute">· красных ${x.fails} из ${x.runs}</span></div>`).join("")}</div>`;
}

const tgChip = () => {
    const g = S.tg || {}, on = !!(S.settings && S.settings.tgBot);
    return `<button class="sm ${on ? (g.warn ? "warn" : "good") : ""}" data-act="tgbot" title="Вопросы агентов и ветки, готовые к вливу, — в Telegram с кнопками. Ответ из бота — ответ владельца и слово на влив в staging; выкат стенда и прода и «принудительно» — только здесь.">Telegram: ${on ? esc(g.text || "включён") + (g.open ? " · вопросов " + g.open : "") : "выкл"}</button>`;
};

export function stgCards() {
    return S.trees.filter(readyStg).map((t) => `<div class="tk go"><div class="tkh">${t.color ? agentIcon(t.color, "warm", 26) : ""}<b><span class="dotc" style="--c:${t.color}"></span>${esc(t.tag)}</b><span class="chip ok">готова к staging</span></div><div class="tkt">Сборка, тесты, гарды и регресс пройдены на нынешнем коде, коммитов: ${t.ahead}. Можно вливать в staging.</div><div class="chips">${stgBtn(t, true)}<button class="sm" data-act="changes" data-tree="${esc(t.key)}">Изменения</button></div></div>`).join("");
}

const agoText = (at) => {
    const m = Math.round((Date.now() - at) / 60000);
    return m < 1 ? "только что" : m < 90 ? m + " мин назад" : Math.round(m / 60) + " ч назад";
};

function oqForm(ib) {
    const raw = String(ib.full || ib.preview || "").trim();
    if (!raw)
        return "";
    let qs = ownerQuestions("Вопросы владельцу:\n" + raw);
    if (!qs.length)
        qs = [{ n: "1", text: raw, head: raw.split(/\r?\n/)[0], options: [] }];
    return oqFormHTML(qs, { mode: "card", target: ib.tree, scope: oqScope("card:" + ib.tree, qs), extraKey: "oq|" + ib.tree, max: 60 });
}

function inboxCards(part = "all") {
    const when = agoText;
    const list = (S.inbox || []).filter((ib) => part === "all" || (part === "ownerq") === (ib.kind === "ownerq"));
    if (part === "ownerq")
        list.sort((x, y) => (y.at || 0) - (x.at || 0));
    return list.map((ib) => {
        const t = treeOf(ib.tree) || {}, who = `<span class="dotc" style="--c:${t.color || "var(--accent)"}"></span>${esc(t.tag || ib.tree)}`, cr = t.color ? agentIcon(t.color, "warm", 26) : "";
        const x = `<button class="kill" data-act="inbox-dismiss" data-id="${ib.id}" title="Убрать карточку" style="color:var(--text-2)">✕</button>`;
        if (ib.kind === "relay") {
            const busy = PENDING.has("ib|" + ib.id);
            return `<div class="tk go"><div class="tkh">${cr}<b>${who}</b>${ib.sending ? `<span class="chip running">${SPIN} передаётся сам</span>` : ib.queued ? `<span class="chip queued">⏳ в очереди</span>` : `<span class="chip ok">${ib.tree === "orchestrator" ? "указание готово" : "ответ готов"}</span>`}<span class="sp"></span>${x}</div><div class="tkt">${who} → ${esc(ib.toTag)} <span class="mute">· ${when(ib.at)}</span></div><div class="sub tks" style="cursor:default">${esc(ib.preview)}${ib.len > 240 ? "…" : ""}</div>${ib.note ? `<div class="sub" style="font-size:11.5px;color:var(--warn)">${esc(ib.note)}</div>` : ""}<div class="chips">${ib.sending || ib.queued ? "" : `<button class="sm primary ${busy ? "busy" : ""}" data-act="inbox-send" data-id="${ib.id}">${busy ? SPIN : "→"} ${esc(ib.toTag)}</button>`}<button class="sm" data-act="focuschat" data-tree="${esc(ib.tree)}">читать</button></div></div>`;
        }
        if (ib.kind === "stgred") {
            const busy = PENDING.has("ib|" + ib.id);
            return `<div class="tk bad"><div class="tkh"><b>staging</b><span class="chip fail">красное вне волн</span><span class="sp"></span>${x}</div><div class="tkt">Сверка регресса: на самом staging падают спеки, которых нет в манифестах слотов <span class="mute">· ${when(ib.at)}</span></div>${(ib.specs || []).map((f) => `<div class="sub mono" style="font-size:11.5px">✗ ${esc(f)}</div>`).join("")}<div class="chips"><button class="sm primary ${busy ? "busy" : ""}" data-act="inbox-send" data-id="${ib.id}">${busy ? SPIN : "→"} ОРК: завести волну-фикс</button>${ib.jobId ? `<button class="sm" data-act="log" data-id="${ib.jobId}">лог</button>` : ""}</div></div>`;
        }
        if (ib.kind === "slotstart") {
            const busy = PENDING.has("ib|" + ib.id);
            return `<div class="tk go"><div class="tkh">${cr}<b>${who}</b><span class="chip ok">слот готов</span><span class="sp"></span>${x}</div><div class="tkt">Папка поднята, план волны есть, агент ещё не запускался <span class="mute">· ${when(ib.at)}</span></div><div class="chips"><button class="sm primary ${busy ? "busy" : ""}" data-act="inbox-send" data-id="${ib.id}">${busy ? SPIN : "▶"} Запустить слот</button><button class="sm" data-act="chat" data-tree="${esc(ib.tree)}" data-open="1">чат</button></div></div>`;
        }
        if (ib.kind === "ownerq") {
            return `<div class="tk wait"><div class="tkh">${cr}<b>${who}</b><span class="chip queued">❓ вопрос владельцу</span><span class="sp"></span>${x}</div><div class="tkt">${ib.tree === "orchestrator" ? "Оркестратор ждёт вашего решения" : "Слот ждёт вашего решения: ответьте здесь, агент продолжит"} <span class="mute">· ${when(ib.at)}</span></div>${(() => {
                const q = String(ib.full || ib.preview || "").trim(), first = (q.split(/\r?\n/).find((l) => l.trim()) || "").trim();
                return q ? `<details class="oq-q" style="margin:4px 0"><summary style="cursor:pointer;font-size:12.5px;color:var(--text)">▾ ${esc(first.length > 110 ? first.slice(0, 109) + "…" : first)}</summary><div class="sub" style="white-space:pre-wrap;font-size:12.5px;color:var(--text);margin-top:4px">${esc(q)}</div></details>` : `<div class="sub mute">текст вопроса не пришёл — откройте чат</div>`;
            })()}${oqForm(ib)}<div class="chips" style="margin-top:4px"><button class="sm" data-act="focuschat" data-tree="${esc(ib.tree)}">Открыть чат</button></div></div>`;
        }
        if (ib.kind === "deadlock") {
            return `<div class="tk bad"><div class="tkh">${cr}<b>${who}</b><span class="chip fail">⛔ тупик правил</span><span class="sp"></span>${x}</div><div class="tkt">«${esc(ib.what)}» отклонено ${ib.n} раза подряд на том же коде с одной причиной <span class="mute">· с ${hhmm(ib.since || ib.at)}</span></div><div class="sub" style="font-size:12px">${esc(ib.why)}</div><div class="sub" style="font-size:11.5px">Оркестратору отправлено «правила противоречат». Если он не разрулит — решение за вами: правка кода, порядок влива или «принудительно».</div><div class="chips">${ib.to ? `<button class="sm" data-act="focuschat" data-tree="${esc(ib.to)}">чат оркестратора</button>` : ""}${ib.tree && ib.tree !== ib.to ? `<button class="sm" data-act="focuschat" data-tree="${esc(ib.tree)}">чат ${esc(t.tag || "")}</button>` : ""}</div></div>`;
        }
        if (ib.kind === "verify") {
            return `<div class="tk go"><div class="tkh">${cr}<b>${who}</b><span class="chip queued">нужна проверка</span><span class="sp"></span>${x}</div><div class="tkt">Агент изменил файлы (правок: ${ib.edits}). Прогнать сборку и тесты? <span class="mute">· ${when(ib.at)}</span></div><div class="chips"><button class="sm ${PENDING.has("run|" + ib.tree + "|build") ? "busy" : ""}" data-act="run" data-tree="${esc(ib.tree)}" data-task="build">🔨 Сборка</button><button class="sm primary ${PENDING.has("runall|" + ib.tree) ? "busy" : ""}" data-act="runall" data-tree="${esc(ib.tree)}">▶ Тесты волны</button><button class="sm" data-act="changes" data-tree="${esc(ib.tree)}">Изменения</button></div></div>`;
        }
        const rows = (ib.jobs || []).map((j) => `<div class="sub" style="font-size:11.5px">${j.status === "ok" ? "✓" : j.status === "fail" ? "✗" : "∅"} ${esc(j.label)}${j.input ? " · " + esc(j.input) : ""}</div>`).join("");
        return `<div class="tk go"><div class="tkh">${cr}<b>${who}</b><span class="chip">итог прогонов</span><span class="sp"></span>${x}</div><div class="tkt">Сборка и тесты: ${(ib.jobs || []).length} прогон(а), не отправлены агенту <span class="mute">· ${when(ib.at)}</span></div>${rows}<div class="chips"><button class="sm primary ${PENDING.has("ib|" + ib.id) ? "busy" : ""}" data-act="inbox-send" data-id="${ib.id}">→ Агенту: всё одним сообщением</button></div></div>`;
    }).join("");
}

const REM_ST = { wait: ["ждёт выката стенда", "queued"], ready: ["стенд выкачен — можно выполнять", "ok"], run: ["выполняется", "running"], fail: ["упало — смотрите лог", "fail"], done: ["выполнено", ""] };

function remCards() {
    const list = (S.reminders || []).filter((r) => r.st !== "done" || Date.now() - (r.doneAt || 0) < 3600e3);
    const cards = list.map((r) => {
        const [st, cls] = REM_ST[r.st] || [r.st, ""], busy = PENDING.has("remrun|" + r.id);
        return `<div class="tk ${r.st === "ready" ? "go" : ""}"><div class="tkh"><b>📌 ${esc(r.text)}</b><span class="sp"></span><button class="sm ghost" data-act="remdismiss" data-id="${r.id}" title="Убрать">✕</button></div>
      <div class="tkt"><span class="chip ${cls}">${r.st === "run" ? SPIN + " " : ""}${esc(st)}</span> <span class="mute">· от ${esc(r.fromTag)} · ${agoText(r.at)}</span></div>
      ${r.cmd ? `<div class="sub mono" style="font-size:11.5px;word-break:break-all">${esc(r.cmd)}</div>` : r.cmdRaw ? `<div class="sub" style="font-size:11.5px">команда не того вида, с кнопки не запускается: <span class="mono">${esc(r.cmdRaw)}</span></div>` : ""}
      <div class="chips">${r.cmd && r.st !== "done" && r.st !== "run" ? `<button class="sm ${r.st === "ready" ? "primary" : ""} ${busy ? "busy" : ""}" data-act="remrun" data-id="${r.id}" title="Выполнить задачу проекта в основной папке (адрес стенда — в DISPATCHER_STAND_URL)">${busy ? SPIN : "▶"} Выполнить задачу</button>` : ""}${r.jobId ? `<button class="sm" data-act="log" data-id="${r.jobId}">лог</button>` : ""}${r.st !== "done" ? `<button class="sm ghost" data-act="remdone" data-id="${r.id}" title="Я сделал это вручную — убрать из напоминаний">Отметить сделанным</button>` : ""}</div></div>`;
    }).join("");
    const add = `<details class="remadd" ${REM_ADD_OPEN ? "open" : ""}><summary class="sub" style="cursor:pointer">＋ добавить напоминание</summary><div style="display:grid;gap:6px;margin-top:6px"><input type="text" id="remText" placeholder="что сделать после выката"><input type="text" id="remCmd" class="mono" placeholder="команда на стенде (необязательно)"><button class="sm" data-act="remadd">Добавить</button></div></details>`;
    return cards + add;
}

function toggleRows(root) {
    for (const chips of root.querySelectorAll(".mc:first-child > .chips")) {
        let any = false;
        for (const b of [...chips.querySelectorAll("button.sm")]) {
            const m = /^(.*?):\s*(вкл|выкл)\s*(?:·\s*(.*))?$/s.exec(b.textContent.trim());
            if (!m)
                continue;
            const on = m[2] === "вкл";
            any = true;
            b.className = "tgrow" + (on ? " on" : "") + (b.classList.contains("busy") ? " busy" : "");
            b.setAttribute("role", "switch");
            b.setAttribute("aria-checked", String(on));
            b.innerHTML = `<span class="tgt"><b>${m[1].trim().replace(/^./, (c) => c.toUpperCase())}</b>${m[3] ? `<small>${m[3].trim()}</small>` : ""}</span><i class="tgl"></i>`;
        }
        if (any)
            chips.classList.add("tgbox");
    }
}

export function renderTasks() {
    const el = $("tasks");
    if (!el || !S)
        return;
    {
        const ae = document.activeElement;
        if (ae && el.contains(ae) && /^(INPUT|TEXTAREA)$/.test(ae.tagName))
            return;
    }
    if (RAILM === "runs")
        renderSide();
    const run = S.jobs.filter((j) => j.status === "running"), wait = S.jobs.filter((j) => j.status === "queued" || j.status === "waiting");
    const bad = failedUnresolved(), now = Date.now(), pend = pendingCards(run, wait), pendN = (pend.match(/class="tk run"/g) || []).length;
    const done = S.jobs.filter((j) => j.status === "ok" && j.endedAt && now - j.endedAt < FLY_MS + 800);
    const sec = (title, n, body) => body ? `<div class="mc"><h3><span>${title}</span><span class="mute">${n}</span></h3><div class="tklist">${body}</div></div>` : "";
    el.innerHTML = `
    <div class="mc"><h3 style="flex-wrap:wrap;gap:6px"><span style="white-space:nowrap">Задачи</span><span class="chips"><span class="chip ${run.length + pendN ? "running" : ""}">идёт ${run.length + pendN}</span><span class="chip ${agentCards().some((x) => x.k === "run" || x.k === "wait") ? "running" : ""}">агенты ${agentCards().filter((x) => x.k === "run" || x.k === "wait").length}</span><span class="chip ${wait.length ? "queued" : ""}">ждёт ${wait.length}</span><span class="chip ${bad.length ? "fail" : "ok"}">упало ${bad.length}</span><span class="chip ${(S.inbox || []).length + ownerReqs().length ? "queued" : ""}">ждут вас ${(S.inbox || []).length + ownerReqs().length}</span></span></h3>
      <div class="chips"><button class="sm ${S.settings && S.settings.autoResults ? "good" : ""}" data-act="autoresults" title="Когда прогоны слота закончились, итог (зелёный, упал, нет тестов, хвост лога) уходит агенту этого слота сам. Спящего слота не будим: вместо этого остаётся карточка с кнопкой.">автоотчёт слоту: ${S.settings && S.settings.autoResults ? "вкл" : "выкл"}</button><button class="sm ${S.settings && !!S.settings.autoCommit ? "good" : ""}" data-act="autocommit" title="Когда ревью «ЗА» и всё зелёное на текущем коде, автопоезд сам ставит «Коммит силами агента». Выкат стенда и релиз остаются за вами.">автокоммит: ${S.settings && !!S.settings.autoCommit ? "вкл" : "выкл"}</button><button class="sm ${S.settings && !!S.settings.autoMerge ? "good" : ""}" data-act="automerge" title="ветка прошла все станции на нынешнем коде, ревью «ЗА», агент доложил «ГОТОВО», конфликта и невлитых зависимостей нет — диспетчерская сама вливает её в staging (те же проверки, что у кнопки «Влить»), и поезд получает следующий вагон. Выкат стенда, релиз и «принудительно» — только ваше слово.">автовлив: ${S.settings && !!S.settings.autoMerge ? "вкл" : "выкл"}</button><button class="sm ${S.settings && !!S.settings.autoSyncConflict ? "good" : ""}" data-act="autosync" title="ветка с конфликтом со staging сама подтягивает staging; конфликтные файлы уходят агенту слота (как кнопка «Подтянуть staging»).">автоподтягивание: ${S.settings && !!S.settings.autoSyncConflict ? "вкл" : "выкл"}</button><button class="sm ${S.settings && S.settings.autoTrain ? "good" : ""}" data-act="autotrain" title="Цепочка без курьера: сборка → гарды → тесты волны → ревью → регресс; замечания ревью и красные итоги уходят агенту волны (спящего будят); ответы слотов и указания оркестратора передаются сами (не больше 6 в час между парой); просьбы агента «прогоните X» ставятся в очередь. Коммит, влив, выкат и заведение волн остаются за вами.">автопоезд: ${S.settings && S.settings.autoTrain ? "вкл" : "выкл"}</button>${S.otherEpicRunning ? `<span class="chip running" title="Прогоны других эпиков идут на этой же машине и делят память; здесь они не показываются">другие эпики: ${S.otherEpicRunning}</span>` : ""}<button class="sm ${S.settings && S.settings.fullPermissions ? "good" : ""}" data-act="fullperm" title="Агенты не спрашивают разрешения на правки в своей папке, чтение и безопасные команды. Пуш, слияние, выкат, ssh, удаление и тесты по-прежнему спрашивают.">полные разрешения: ${S.settings && S.settings.fullPermissions ? "вкл" : "выкл"}</button>${(() => { const u = (S.settings && S.settings.autoOwnerUntil) || 0, on = u > Date.now(); return `<button class="sm ${on ? "good" : ""}" data-act="nightmode" title="Ночной режим (12 ч): вопросы агентов получают ответ рекомендованным вариантом от вашего имени; просьбы агентов о прогонах и повторы упавших из-за окружения идут сами (вместе с ним включаются автопоезд и автоотчёт слоту); слотам — расширенный набор git-команд. Деньги, оферты, персональные данные, права доступа, прод и релиз — только вы: такие вопросы ждут утра. Выкат прода ночной режим не делает никогда. Выключается этой кнопкой или словами «я тут».">ночной режим: ${on ? "вкл до " + new Date(u).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "выкл"}</button>`; })()}${S.hygiene && S.hygiene.extra ? `<button class="sm warn" data-act="hygiene" title="Папки слотов, которые не принадлежат открытым эпикам: каждая замедляет git всех слотов. Незакоммиченное уйдёт в git stash, невлитые ветки останутся. Основная папка, служебные папки и рабочие копии, заведённые не диспетчерской, не трогаются${S.hygiene.foreign ? " (таких чужих копий: " + S.hygiene.foreign + ")" : ""}.">${S.hygiene.running ? "убираю папки…" : "лишних папок слотов: " + S.hygiene.extra + " из " + S.hygiene.total + " — убрать"}</button>` : ""}${modOn("tg") ? tgChip() : ""}</div>
      ${!run.length && !pendN && !wait.length && !bad.length && !done.length && !agentCards().length && !(S.inbox || []).length && !ownerReqs().length ? '<div class="sub">Сейчас ничего не выполняется. Здесь будут идти сборки и тесты: успешные улетают через несколько секунд, упавшие остаются, пока вы их не уберёте.</div>' : ""}</div>
    ${sec("Ждут вашего действия", (S.inbox || []).length + ownerReqs().length + S.trees.filter(readyStg).length + (S.orderHints || []).length + (trainCard() ? 1 : 0), inboxCards("ownerq") + trainCard() + orderCards() + stgCards() + reqCards() + inboxCards("rest"))}
    ${modOn("release") ? sec("После выката на стенд", (S.reminders || []).filter((r) => r.st !== "done").length, remCards()) : ""}
    ${sec("Нестабильные спеки", (S.flaky || []).length, flakyCards())}
    ${sec("Агенты", agentCards().length, agentCards().map((x) => x.html).join(""))}
    ${run.length + pendN + wait.length + bad.length ? `<div class="mc"><div class="chips"><button class="sm" data-act="rail" data-m="runs">▶ Запуски: идёт ${run.length + pendN}, ждёт ${wait.length}, упало ${bad.length} →</button></div></div>` : ""}`;
    toggleRows(el);
}
