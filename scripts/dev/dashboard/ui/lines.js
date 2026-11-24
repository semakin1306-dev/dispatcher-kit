// lines.js — линии веток: карточка ветки со станциями, тесты волны, регресс, сьюты, группы и фокус. Следующий шаг и
// группу присылает сервер (view.mjs), здесь только показ.
import { FOCUS, IN, OPEN, OPENCHAT, PENDING, S, SEL, SELK, setState } from "./state.js";
import { $, branchLabel, commitBusy, agentIcon, agentState, dur, esc, gateTasks, hasMain, ICON, modOn, runWhen, smart, SPIN, testTasks, toast } from "./core.js";
import { press } from "./render.js";
import { manyMsg, runMany } from "./run.js";
import { inKey, inVal, lastJob, lastJobIn, lastJobOf, treeOf } from "./data.js";
import { adviceUi, progBar, shortInput, suiteListHTML } from "./tasks.js";
import { SIDEBAR } from "./chat.js";
import { drawOrderLinks, orderMapHtml } from "./ordermap.js";
import { ganttHtml, modeSeg, orderMode } from "./gantt.js";

export function renderOrderMap() {
    const el = $("ordermap");
    if (!el)
        return;
    const gantt = orderMode() === "gantt";
    const html = gantt ? ganttHtml(el.clientWidth - 26) : orderMapHtml(locoSvg({ key: "__order" }, "warm"), modeSeg());
    if (el.dataset.sig === html)
        return;
    el.dataset.sig = html;
    el.innerHTML = html;
    if (!gantt)
        requestAnimationFrame(() => drawOrderLinks());
}

export function renderKanban() {
    renderOrderMap();
    const slots = S.trees.filter((t) => t.kind === "slot" && !t.archived), ref = slots.find((t) => stagesOf(t).length);
    const cols = ref ? stagesOf(ref).map((x) => ({ id: x.id, label: x.label })) : [];
    cols.push({ id: "__done", label: "🏁 Пройдено" });
    const by = Object.fromEntries(cols.map((c) => [c.id, []]));
    for (const t of slots) {
        const st = stagesOf(t), cur = st[farOf(t) + 1];
        (by[cur ? cur.id : "__done"] || by.__done).push(t);
    }
    const card = (t) => {
        const n = t.exists ? nextStep(t) : { kind: "info", text: "папка слота готовится" }, ag = (S.agents || {})[t.key] || {};
        const js = S.jobs.filter((j) => j.tree === t.key && ["running", "queued", "waiting"].includes(j.status));
        const run = js.filter((j) => j.status === "running").length, q = js.length - run;
        const need = ["bad", "go", "warn"].includes(n.kind);
        const ic = [run ? `<span title="идёт прогонов: ${run}">${SPIN}</span>` : "", q ? `<span title="ждут в очереди: ${q}">⏳${q > 1 ? q : ""}</span>` : "", ag.busy ? `<span title="агент пишет">🤖</span>` : "", ag.pending ? `<span title="агент просит разрешение">✋</span>` : ""].filter(Boolean).join("");
        return `<div class="kbk ${need ? "need" : ""}" style="--c:${t.color}" data-act="kbopen" data-tree="${esc(t.key)}" title="${esc(t.tag + " · " + t.title + (n.text ? "\n" + n.text : ""))}"><div class="kt">${agentIcon(t.color, agentState(t.key), 18)}${esc(t.tag)}${ic ? `<span class="ic">${ic}</span>` : ""}</div><div class="ks">${esc(t.title)}</div>${need && n.text ? `<div class="kn">${esc(n.text)}</div>` : ""}</div>`;
    };
    $("kb").style.gridTemplateColumns = cols.map((c) => by[c.id].length ? "minmax(0,1fr)" : "30px").join(" ");
    $("kb").innerHTML = cols.map((c) => {
        const n = by[c.id].length, cur = by[c.id].some((t) => ["bad", "go", "warn"].includes((t.exists ? nextStep(t) : {}).kind));
        return `<div class="kbc ${n ? "" : "empty"} ${cur ? "cur" : ""}" title="${esc(c.label)}"><div class="kbh"><span>${esc(c.label)}</span><span class="n">${n}</span></div>${by[c.id].map(card).join("")}</div>`;
    }).join("");
}

export function renderLines() {
    const host = document.getElementById("lines"), list = linesList(), keys = list.map((t) => t.key);
    Array.from(host.children).forEach((w) => {
        if (!keys.includes(w.dataset.k))
            w.remove();
    });
    let prev = null;
    for (const t of list) {
        let w = Array.from(host.children).find((x) => x.dataset.k === t.key);
        if (!w) {
            w = document.createElement("div");
            w.className = "lnw";
            w.dataset.k = t.key;
            smart(w);
            host.insertBefore(w, prev ? prev.nextSibling : host.firstChild);
        }
        w.innerHTML = t.stg ? stagingLine() : t.hdr ? t.hdr : t.focusbar ? focusBar(t.tree) : line(t);
        w.classList.toggle("sel", t.key === SELK);
        prev = w;
    }
    const cur = Array.from(host.children).map((w) => w.dataset.k);
    if (cur.join("|") !== keys.join("|"))
        for (const k of keys) {
            const w = Array.from(host.children).find((x) => x.dataset.k === k);
            if (w)
                host.appendChild(w);
        }
    try {
        animateLocos();
    }
    catch { }
}

function shardChip() {
    if (!modOn("machines"))
        return "";
    const sm = S.shard, head = String((S.pipeline || {}).staging || ""), same = sm && head && String(sm.sha || "").startsWith(head);
    let chip;
    if (!sm)
        chip = `<span class="chip" title="Полного прогона staging по машинам ещё не было">полного прогона не было</span>`;
    else if (["prep", "running"].includes(sm.status))
        chip = `<span class="chip running">${SPIN} ${sm.status === "prep" ? "машины готовятся" : "прогон: ✓ " + sm.ok + (sm.fail ? " ✗ " + sm.fail : "") + " из " + sm.total}</span>`;
    else if (sm.prepOnly)
        chip = `<span class="chip ${sm.status === "prepared" ? "ok" : "bad"}">${sm.status === "prepared" ? "машины готовы" : "подготовка: " + sm.status}</span>`;
    else
        chip = `<span class="chip ${!same ? "queued" : sm.fail || sm.notrun ? "bad" : "ok"}" title="${same ? "на нынешнем коммите staging" : "прогон был на другом коммите: staging с тех пор менялся"}">${!same ? "↻ " : ""}прогон: ✓ ${sm.ok}${sm.fail ? " ✗ " + sm.fail : ""}${sm.notrun ? " · не прошло " + sm.notrun : ""} из ${sm.total}${!same ? " · старый коммит" : ""}</span>`;
    return chip + `<button class="sm primary" data-act="shardopen" title="Полный прогон staging по машинам прогонов: общая очередь частей. Откроется страница с кнопками «Подготовить машины» и «Начать прогон».">🖧 Полный прогон</button>`;
}

function stagingLine() {
    const P = S.pipeline, sv = P.stagingVsOrigin || [0, 0], gates = gateTasks(), sec = lastJobOf("orchestrator-staging", gates), ot = S.trees.find((t) => t.kind === "orch"), sf = P.stagingFolder || {};
    const ec = ot ? (ot.dirtyTracked || 0) + (ot.dirtyUntracked || 0) : 0, up = P.upStaging || "remote", rel = modOn("release");
    const deploys = rel && S.jobs.some((x) => x.task === "deploy-staging");
    return `<div class="ln" style="--c:var(--accent)"><div class="top">
    <div class="who"><div class="n"><i></i>⎇ ${esc(branchLabel("staging"))} · основная линия</div><div class="br" title="Основная папка проекта всегда стоит на staging">staging @ ${esc(P.staging)}</div>
      <div class="chips">${sv[1] ? `<span class="chip queued" title="Локальный staging впереди ${esc(up)}">↑${sv[1]} не запушено</span>` : ""}${sv[0] ? `<span class="chip queued" title="${esc(up)} впереди локального: сначала git fetch">↓${sv[0]} ${esc(up)} впереди</span>` : ""}${!sv[0] && !sv[1] ? `<span class="chip ok">= ${esc(up)}</span>` : ""}${rel && hasMain() ? `<span class="chip" title="Волн в поезде к выкату в прод">🚂 ${P.unreleased}</span>` : ""}${sf.dirtyTracked ? `<span class="chip queued" title="Изменённых файлов в основной папке staging">✎ ${sf.dirtyTracked}</span>` : ""}${P.invariantOk || !hasMain() ? "" : '<span class="chip fail">main не предок staging!</span>'}</div></div>
    <div class="orchrow">Сюда вливаются все волны, поэтому гарды${rel ? " и выкат стенда" : ""} живут здесь. Оркестратор работает в боковой панели, отдельной линии у него нет.</div>
    <div class="acts">${gates.length ? `<span ${sec ? `data-act="log" data-id="${sec.id}" style="cursor:pointer"` : ""}>${chipOf(sec, "stg-sec")}</span><button class="sm primary ${PENDING.has("stg-sec") ? "busy" : ""}" data-act="stg-sec" title="Задачи-гейты проекта на самом staging: ${esc(gates.join(", "))}">${PENDING.has("stg-sec") ? SPIN : "▶"} Гарды</button>` : ""}${shardChip()}${rel ? `<button class="sm" data-act="pl" data-action="deploy-staging">Выкатить стенд…</button>` : ""}${deploys ? `<button class="sm" data-act="standfx" title="Станции выката и паровоз с волнами">🚂 Экран выката</button>` : ""}${ot ? `<button class="sm" data-act="changes" data-tree="${esc(ot.key)}" title="Изменения в папке эпика (планы, сводка эпика): их тоже надо коммитить">📝 Эпик${ec ? ` <span class="chip queued">${ec}</span>` : ""}</button>` : ""}<button class="sm ghost" data-act="toggle" data-tree="__staging">${OPEN.has("__staging") ? "Свернуть ▲" : "Подробнее ▼"}</button></div></div>${stagingTrack()}<div id="standfx" class="inline"></div>${OPEN.has("__staging") ? stagingBody() : ""}</div>`;
}

function stagingTrack() {
    const P = S.pipeline || {}, trains = (S.trees || []).filter((t) => t.kind === "slot" && t.train && !t.archived);
    const all = trains.flatMap((t) => (t.wagonsView || []).filter((w) => w.tone === "done" && w.id !== "prod").map((w) => ({ t, w })));
    const wait = all.filter((x) => x.w.id === "stand"), onStand = all.filter((x) => x.w.id !== "stand"), inAcc = onStand.filter((x) => x.w.id === "accept");
    if (!all.length || !modOn("release"))
        return "";
    const sec = lastJobOf("orchestrator-staging", gateTasks()), sm = S.shard, head = String(P.staging || ""), shardSame = sm && head && String(sm.sha || "").startsWith(head);
    const sj = [...S.jobs].reverse().find((j) => j.task === "deploy-staging"), deploying = sj && ["queued", "waiting", "running"].includes(sj.status);
    const st0 = [
        { id: "stg", label: "В staging · " + all.length, done: true, fixed: true, hint: "вагонов эпика в staging: " + all.length },
        { id: "guards", label: "Гарды staging", done: !!sec && sec.status === "ok", fixed: true, hint: sec ? "гарды на staging: " + sec.status + " (" + sec.id + ")" : "гарды на staging ещё не гоняли" },
        { id: "shard", label: "Полный прогон", done: !!shardSame && !sm.fail && !sm.notrun && !["prep", "running"].includes(sm.status) && !sm.prepOnly, fixed: true, hint: !sm ? "полного прогона staging не было" : shardSame ? "на нынешнем коммите: ✓ " + sm.ok + (sm.fail ? " ✗ " + sm.fail : "") : "прогон был на другом коммите staging" },
        { id: "stand", label: "Выкат на стенд", done: !wait.length && !deploying, fixed: true, hint: deploying ? "выкат идёт (" + sj.id + ")" : wait.length ? "ждут выката: " + wait.map((x) => x.w.wave).join(", ") : "все вагоны staging на стенде" },
        { id: "accept", label: "Приёмка", done: !wait.length && !inAcc.length, fixed: true, hint: inAcc.length ? "на приёмке: " + inAcc.map((x) => x.w.wave).join(", ") : "приёмка пройдена у всех вагонов на стенде" },
        { id: "prod", label: "В проде", done: false, fixed: true, hint: "выкат в прод — только по слову владельца" },
    ];
    const st = st0.filter((x) => (x.id !== "shard" || modOn("machines")) && (x.id !== "accept" || modOn("accept")) && (x.id !== "prod" || hasMain()));
    const tc = (x) => `<span class="tcar" data-act="wagonplan" data-tree="${esc(x.t.key)}" data-wave="${esc(x.w.wave)}" style="--w:${wagonColor(x.t, x.w.wave)}" title="${esc(x.w.wave + " · " + (x.w.title || "") + "\n" + x.t.tag + " · " + (x.w.label || ""))}">${esc(x.w.wave)}<i></i></span>`;
    const T = { key: "orchestrator-staging", color: "#e0663a" };
    const consist = `<span class="tcars">${wait.slice().reverse().map(tc).join("")}</span>${locoSvg(T, deploying ? "busy" : "warm")}`;
    const store = onStand.length ? `<div class="tqueue"><span class="tstg" title="Вагоны эпика, уже выкаченные на стенд: ждут приёмки или выката в прод"><span class="wgh">на стенде:</span><span class="tqrail">${onStand.map(tc).join("")}</span></span></div>` : "";
    return `<div class="trains2 stgtrain" style="--c:#e0663a;--ncars:${Math.min(wait.length, 6)}">${trackRow(T, st, { id: "main", running: !!deploying, queued: false, loco: consist, locoCls: "tloco" })}${store}</div>`;
}

/** Задачи, которые можно прогнать на коде staging: тесты, потом гарды. */
export const stgTasks = () => [...testTasks(), ...gateTasks()];

function stagingBody() {
    const opts = stgTasks().map((k) => `<option value="${k}" ${SEL.__staging === k ? "selected" : ""}>${esc(S.tasks[k].group || "")} · ${esc(S.tasks[k].label)}</option>`).join("");
    const busy = PENDING.has("stgrun"), mach = modOn("machines");
    return `<div class="more3"><div class="m3chat"><div class="chatslot" data-key="orchestrator"></div></div><div class="more m3mid">
    <div class="blk"><h4>Прогнать на коде staging</h4><div class="sub">Одна задача — без полного прогона по машинам. Идёт на снимке staging (${esc(String((S.pipeline || {}).staging || "").slice(0, 10))}).</div>
      <div class="free"><select data-sel="__staging">${opts}</select><input type="text" data-ik="__staging|__free" value="${esc(IN["__staging|__free"] || "")}" placeholder="ввод задачи, например шаблон спеки"><button class="sm primary ${busy ? "busy" : ""}" data-act="stgrun">${busy ? SPIN : "▶"}</button></div></div>
    <div class="blk"><h4>Гарды${mach ? " и полный прогон" : ""}</h4><div class="sub">Гарды — задачи-гейты проекта: без зелёных волна не вливается${mach ? "; полный прогон — все части на машинах прогонов" : ""}.</div><div class="chips"><button class="sm" data-act="stg-sec">▶ Гарды</button>${mach ? '<button class="sm" data-act="shardopen">🖧 Полный прогон / перепрогнать красные</button>' : ""}</div></div>
  </div><div class="m3runs">${runsCol({ key: "orchestrator-staging" })}</div></div>`;
}

export function chipOf(j, pendingKey) {
    if (pendingKey && PENDING.has(pendingKey))
        return `<span class="chip running">${SPIN} отправляю…</span>`;
    if (!j)
        return `<span class="chip">не запускали</span>`;
    if (j.cancelled && ["running", "waiting"].includes(j.status))
        return `<span class="chip queued" title="Стоп нажат: прогон сворачивается, на сервере — не дольше 8 с">${SPIN} останавливаю…</span>`;
    if (j.status === "fail" && j.advice && j.advice.act === "obsolete")
        return `<span class="chip" title="${esc(j.advice.text || "")}">∅ устарел · ${dur(j)}</span>`;
    if (j.status === "fail" && j.advice && j.advice.act === "inherited")
        return `<span class="chip" title="${esc(j.advice.text || "")}">≈ упало только известное · ${dur(j)}</span>`;
    const txt = j.status === "running" ? "идёт " + dur(j) : j.status === "ok" ? "зелёный · " + dur(j) : j.status === "fail" ? "упал · " + dur(j) : j.status === "queued" ? `в очереди${j.pos ? " · №" + j.pos : ""}` : j.status === "waiting" ? "ждёт память" : j.status === "cancelled" ? "отменён" : j.status === "skipped" ? "нет тестов" : "прерван";
    const fr = j.status === "ok" ? (S.fresh || {})[j.id] : null;
    if (fr && fr !== "ok") {
        const m = { stale: ["зелёный, код менялся после", "Прогон был зелёным, но файлы менялись после него или во время него: это не доказывает, что сейчас всё хорошо. Прогоните заново."], unknown: ["зелёный, код не сверен", "Прогон сделан до проверки кода: неизвестно, на каком коде он шёл. Прогоните заново."], nobuild: ["зелёный, без свежей сборки", "Тесты области берут собранный код, а сборки на этом коде не было: они могли исполнять старый код. Соберите и прогоните заново."] }[fr] || ["зелёный?", ""];
        return `<span class="chip queued" title="${esc(m[1])}">⟳ ${m[0]}</span>`;
    }
    return `<span class="chip ${j.status}" title="${esc((fr === "ok" ? "Прогон шёл на нынешнем коде. " : "") + (j.buildJob ? "Сборка: " + j.buildJob + (j.buildFp === j.fpStart ? " (на этом коде). " : " (НА ДРУГОМ коде). ") : "") + (j.waitReason || j.summary || ""))}">${ICON[j.status]} ${txt}</span>${j.buildJob && ["ok", "fail"].includes(j.status) ? `<span class="chip" style="font-size:10.5px" title="Тесты брали собранный код этой сборки">сборка ${esc(j.buildJob)}${j.buildFp === j.fpStart ? "" : " ⚠"}</span>` : ""}${["ok", "fail"].includes(j.status) ? `<span class="mute" style="font-size:10.5px">${esc(j.id)}</span>` : ""}`;
}

export const unitOf = (t) => (t && t.train ? "вагона" + (t.wagon ? " " + t.wagon : "") : "волны");

function wagonLaunchBtn(t) {
    const w = (t.wagonsView || []).find((z) => z.wave === t.head);
    if (!w)
        return "";
    if (w.tone === "wait") {
        const why = (w.waitFor || []).map((x) => {
            const [a, b] = String(x).split("@");
            return b ? b + " · " + a : a;
        }).join(", ");
        return `<button class="sm" disabled title="${esc("Вагон " + w.wave + " ждёт " + why + ": как только он вольётся в staging, вагон уйдёт агенту сам. Запустить раньше — в окне вагона (клик по вагончику)")}">⏸ ${esc(w.wave)} ждёт ${esc(why)}</button>`;
    }
    const pk = "trainwagon|" + t.key;
    return `<button class="sm primary ${PENDING.has(pk) ? "busy" : ""}" data-act="trainwagon" data-tree="${esc(t.key)}" data-wave="${esc(w.wave)}" title="${esc("Вагон " + w.wave + " — агенту поезда в его сессию (ветка сначала подтянет staging). Автопоезд делает это сам, когда прошлый вагон влит")}">${PENDING.has(pk) ? SPIN : "▶"} Запустить вагон ${esc(w.wave)}</button>`;
}

export const stagesOf = (t) => t.stages || [];

function regressBtn(t) {
    const items = t.regress || [], busy = PENDING.has("runregress|" + t.key), st = t.verdict && t.verdict.regress;
    if (!items.length)
        return "";
    const lk = stLook(jobsState(t, [...new Set(items.map((x) => x.task))]), st === "run" ? "" : st), cls = lk.cls;
    return `<button class="sm ${cls} ${busy ? "busy" : ""}" data-act="runregress" data-tree="${esc(t.key)}" title="Соседи по тронутым путям: ${esc(items.map((x) => x.label + (x.input ? " " + x.input : "") + " (" + x.why + ")").join("; "))}">${busy ? SPIN : lk.ic} Регресс ${unitOf(t)}</button>`;
}

function regressBlk(t) {
    const items = t.regress || [];
    const W = { inherited: "≈ красное унаследовано от staging, ветке не вменяется", ok: "✓ зелёный на этом коде", fail: "✗ упал", run: "… идёт", none: "не прогонялся", stale: "был на другом коде", nobuild: "без свежей сборки", unknown: "неизвестно" };
    const rows = items.map((x) => `<div class="sub" style="font-size:12px">${esc(x.label)}${x.input ? " · <span class=mono>" + esc(x.input) + "</span>" : ""} — ${W[x.status] || x.status} <span class="mute">(${esc(x.why)})</span>${x.jobId ? ` <a href="#" data-act="log" data-id="${x.jobId}">лог</a>` : ""}${x.base ? `<div class="mute" style="font-size:11px;margin-left:12px">${esc(x.base)}</div>` : ""}${x.inherited ? `<div class="mute" style="font-size:11px;margin-left:12px">упало и на staging: ${esc(x.inherited.join(", "))}</div>` : ""}${suitesHTML(t, "regress", x.task, x.input)}</div>`).join("");
    if (!items.length)
        return '<div class="blk"><h4>Регресс по тронутым путям</h4><div class="sub">Тронутые пути не задевают соседей: станция не нужна.</div></div>';
    const n = (st) => items.filter((x) => x.status === st).length, ok = n("ok") + n("inherited"), bad = n("fail"), run = n("run");
    const sum = run ? "идёт " + run : bad ? "✗ упало " + bad + " из " + items.length : ok === items.length ? "✓ все " + items.length + " зелёные" : ok + " из " + items.length + " зелёные";
    const op = OPEN.has("reg|" + t.key);
    return `<div class="blk"><h4>Регресс по тронутым путям</h4><div class="regline"><span data-act="toggle" data-tree="reg|${esc(t.key)}" style="cursor:pointer;flex:1;min-width:0" title="Показать прогоны регресса">${op ? "▾" : "▸"} ${esc(sum)} <span class="mute">· ${items.length} прогон(а)</span></span>${regressBtn(t)}</div>${op ? rows : ""}</div>`;
}

export function runRegress(tree) {
    const t = treeOf(tree), list = ((t && t.regress) || []).filter((x) => !["ok", "run", "inherited"].includes(x.status));
    if (!list.length)
        return toast("Регресс уже зелёный или идёт");
    press("runregress|" + tree, () => runMany(list.map((x) => ({ tree, task: x.task, input: x.input || "", profile: "auto" }))), manyMsg("регресс"));
}

export const readyStg = (t) => !!t.readyStg;
export const stgBtn = (t, big) => `<button class="sm primary" data-act="pl" data-action="merge" data-slot="${esc(t.key)}" title="Влить ветку ${esc(t.branch)} в staging (merge --no-ff). Перед вливом окно ещё раз проверит условия">⤴ ${big ? "Влить в staging…" : "В staging"}</button>`;
export const farOf = (t) => (t.cur == null ? stagesOf(t).length - 1 : t.cur - 1);

export function nextStep(t) {
    const n = t.next || { kind: "info", text: "" };
    return { ...n, btn: nextBtn(t, n) };
}

function nextBtn(t, n) {
    const k = esc(t.key), a = n.act;
    if (!a)
        return "";
    const soft = n.mergeSoft ? `<button class="sm" data-act="pl" data-action="merge" data-slot="${k}" title="Окно вливания: регресс, ревью и гарды можно снять своим решением">Влить…</button>` : "";
    if (a === "advice") {
        const j = S.jobs.find((x) => x.id === n.jobId) || { id: n.jobId, tree: t.key, note: n.note };
        return adviceUi({ ...j, advice: n.advice }).btn;
    }
    if (a === "report")
        return `<button class="sm primary" data-act="report" data-id="${n.jobId}" title="Причина падения уйдёт в сессию агента этой ветки">→ Агенту ветки</button><button class="sm ghost" data-act="copy" data-id="${n.jobId}">📋</button>`;
    if (a === "build")
        return `<button class="sm primary" data-act="run" data-tree="${k}" data-task="build">🔨 Сборка</button>` + soft;
    if (a === "train-wagon")
        return wagonLaunchBtn(t);
    if (a === "tests")
        return `<button class="sm primary" data-act="runall" data-tree="${k}">▶ Тесты ${unitOf(t)}</button>` + soft;
    if (a === "guards") {
        const gs = jobsState(t, gateTasks());
        return `<button class="sm ${stLook(gs, t.verdict && t.verdict.guards).cls} ${PENDING.has("rungards|" + t.key) ? "busy" : ""}" data-act="rungards" data-tree="${k}">${PENDING.has("rungards|" + t.key) ? SPIN + " Гарды " + unitOf(t) : stateLabel(gs, "Гарды " + unitOf(t), stLook(null, t.verdict && t.verdict.guards).ic + " Гарды " + unitOf(t))}</button>` + soft;
    }
    if (a === "review")
        return modOn("review") ? reviewBtn(t) + (n.mergeSoft ? soft : reviewCommitBtn(t)) : soft;
    if (a === "regress")
        return (regressBtn(t) || `<button class="sm primary" data-act="runregress" data-tree="${k}">▶ Регресс ${unitOf(t)}</button>`) + soft;
    if (a === "commit")
        return `<button class="sm primary ${commitBusy(t.key) ? "busy" : ""}" data-act="agentcommit" data-tree="${k}" title="Агент слота сам выберет файлы волны, напишет подпись и сделает коммит в своей ветке (навык slot-commit). Пуш и слияние: отдельно, по вашему слову.">${commitBusy(t.key) ? SPIN : "⎇"} Коммит силами агента</button><button class="sm" data-act="changes" data-tree="${k}">Изменения</button>`;
    if (a === "merge")
        return `<button class="sm primary" data-act="pl" data-action="merge" data-slot="${k}">Влить в staging…</button>`;
    if (a === "mergewait")
        return `<button class="sm ${PENDING.has("mwcancel|" + t.key) ? "busy" : ""}" data-act="mwcancel" data-tree="${k}" title="Снять ожидание ВЛИТЬ: диспетчерская перестанет ставить проверки и не вольёт сама; слово владельца по этому слоту гасится">✕ Отменить ожидание влива</button>`;
    if (a === "provision")
        return `<button class="sm primary" data-act="provision" data-tree="${k}">↻ Повторить подготовку</button>${n.jobId ? `<button class="sm" data-act="log" data-id="${esc(n.jobId)}">лог</button>` : ""}`;
    if (a === "slotsync")
        return `<button class="sm primary ${PENDING.has("sync|" + t.key) ? "busy" : ""}" data-act="slotsync" data-tree="${k}" title="Влить staging в ветку волны: конфликт — откат и список файлов агенту слота">⤓ Подтянуть staging</button>`;
    if (a === "accept" && modOn("accept"))
        return `<button class="sm primary" data-act="rail" data-m="accept" data-acc="${k}">✅ Приёмка</button>`;
    if (a === "stand" && modOn("release"))
        return `<button class="sm primary" data-act="pl" data-action="deploy-staging">Выкатить стенд…</button>${S.jobs.some((x) => x.task === "deploy-staging") ? `<button class="sm" data-act="standfx" title="Станции выката и паровоз с волнами">🚂 Экран выката</button>` : ""}`;
    if (a === "prod" && modOn("release") && hasMain())
        return `<button class="sm danger" data-act="pl" data-action="release">Выкат в прод…</button>`;
    return "";
}

export function attention() {
    const out = [], P = S.pipeline;
    if (S.epics && !S.epics.some((e) => e.status !== "closed")) {
        const last = S.epics.find((e) => e.id === S.activeEpic) || {}, id = last.id || "";
        out.push({ k: "info", t: `<b>Открытых эпиков нет.</b>${id ? ` Последний — «${esc(String(last.title || id).split(":")[0])}» — закрыт.` : ""} Волны, станции и оркестратор появятся с новым эпиком; staging, выкат и прод работают как обычно.`,
            b: `<button class="sm primary" data-act="epicnew">+ Новый эпик</button>${id && modOn("retro") ? `<button class="sm" data-act="epicretro" data-id="${esc(id)}">📝 Ретро «${esc(String(last.title || id).split(":")[0])}»</button>` : ""}` });
    }
    if (modOn("backlog") && S.retroTriage && (S.retroTriage.open || []).length) {
        const r = S.retroTriage;
        out.push({ k: "warn", t: `<b>Ретро «${esc(String(r.title || r.epic).split(":")[0])}»: ${r.open.length} карточ${r.open.length === 1 ? "ка ждёт" : r.open.length < 5 ? "ки ждут" : "ек ждут"} решения</b> (${esc(r.open.join(", "))}) — «берём» в эпик или «отказ» с причиной. Пока не разобраны, новый эпик не заводится.`,
            b: `<button class="sm primary" data-act="bltriage" title="Бэклог с отбором «ретро: ждут решения»; из командной строки — node scripts/dev/backlog.mjs triage">📥 Разобрать</button>` });
    }
    for (const t of S.trees) {
        const ag = (S.agents || {})[t.key];
        if (ag && ag.pending)
            out.push({ k: "warn", t: `${t.emoji} <b>${esc(t.tag)}:</b> агент просит разрешение (${ag.pending}) — ждёт вашего «Разрешить» в чате`, b: `<button class="sm primary" data-act="chat" data-tree="${esc(t.key)}" data-open="1">Открыть чат</button>` });
    }
    if (hasMain() && !P.invariantOk)
        out.push({ k: "bad", t: "<b>main не предок staging.</b> После выката в прод (или hotfix) коммит main не влит обратно: нужен merge main → staging (после выката он файлов не меняет)." });
    {
        const sv = P.stagingVsOrigin || [0, 0], up = esc(P.upStaging || "remote"), li = (a) => (a || []).map((c) => `<div class="mono" style="font-size:11.5px">${esc(c)}</div>`).join("");
        const btn = (lab) => `<button class="sm primary ${PENDING.has("syncstg") ? "busy" : ""}" data-act="syncstg">${lab}</button>`;
        if (sv[0] && sv[1])
            out.push({ k: "bad", t: `<b>staging разошёлся с ${up}:</b> локально ${sv[1]} своих коммита(ов), в ${up} ${sv[0]} чужих. git fetch этого не исправит: нужно слить ${up} в локальный staging (merge-коммит). Вливать ветки до этого нельзя.<div class="sub">только в ${up}:</div>${li(P.stgBehind)}<div class="sub">только локально:</div>${li(P.stgAhead)}`, b: btn("Слить " + up + " в локальный") });
        else if (sv[0])
            out.push({ k: "warn", t: `<b>${up} впереди локального staging на ${sv[0]}:</b> кто-то пушил. Нужно перемотать локальный staging (без коммитов).${li(P.stgBehind)}`, b: btn("Догнать " + up) });
        else if (sv[1])
            out.push({ k: "warn", t: `<b>staging не запушен:</b> локально впереди ${up} на ${sv[1]} коммит(а).${li(P.stgAhead)}` });
    }
    if (hasMain() && P.mainVsOrigin && P.mainVsOrigin[0])
        out.push({ k: "warn", t: `<b>${esc(P.upMain || "remote")} впереди локального main на ${P.mainVsOrigin[0]}.</b> Возможен hotfix.` });
    if (S.mem && S.mem.freeCommitGB < 3)
        out.push({ k: "bad", t: `<b>Мало памяти:</b> свободно ${S.mem.freeCommitGB.toFixed(1)} ГБ памяти. Тяжёлые прогоны будут ждать.` });
    for (const j of S.jobs.filter((x) => x.status === "waiting")) {
        const t = treeOf(j.tree);
        out.push({ k: "warn", t: `${t ? t.emoji + " " + esc(t.tag) : ""} <b>${esc(j.label)}</b> ждёт память. ${esc(j.waitReason || "")}`, b: `<button class="sm" data-act="force" data-id="${j.id}">всё равно</button><button class="sm ghost" data-act="cancel" data-id="${j.id}">стоп</button>` });
    }
    const stand = [];
    for (const t of S.trees.filter((x) => x.exists && x.kind === "slot")) {
        const n = nextStep(t);
        if (n.stand) {
            stand.push(t);
            continue;
        }
        if (["bad", "go", "warn"].includes(n.kind))
            out.push({ k: n.kind, t: `${t.emoji} <b>${esc(t.tag)} · ${esc(t.title)}:</b> ${esc(n.text)}`, b: n.btn || "" });
    }
    if (stand.length)
        out.push({ k: "go", t: `<b>Выкатить staging на стенд и принять</b> — один выкат на ${stand.length} ${stand.length === 1 ? "волну" : stand.length < 5 ? "волны" : "волн"}:${stand.map((t) => `<div style="margin-top:2px">${t.emoji} ${esc(t.tag)} · ${esc(t.title)}</div>`).join("")}`, b: `<button class="sm primary" data-act="pl" data-action="deploy-staging">Выкатить стенд…</button>${S.jobs.some((x) => x.task === "deploy-staging") ? `<button class="sm" data-act="standfx" title="Станции выката и паровоз с волнами">🚂 Экран выката</button>` : ""}` });
    return out.length ? out.map((x) => `<div class="it ${x.k}"><div class="tx">${x.t}</div><div class="chips">${x.b || ""}</div></div>`).join("") : '<div class="calm">Всё спокойно: ничего не упало, ничего не ждёт вашего решения.</div>';
}

function driverIcon(state, size) {
    const r = (x, y, w, h, f) => '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + f + '"/>', N = "#2b4a96", L = "#dfe7f5", D = "#1b2d5e";
    let cap = r(5, -1, 4, 1, N);
    for (let x = 4; x <= 9; x++)
        cap += r(x, 0, 1, 2, x % 2 ? L : N);
    cap += r(3, 2, 8, 1, D) + r(11, 2, 2, 1, D) + r(6, 1, 1, 1, "#f2c14e");
    const st = state === "off" || state === "sleep" ? "sleep" : state === "drowsy" ? "drowsy" : "idle";
    return agentIcon("#5b8def", st, size).replace(/<g class="fl">[\s\S]*?<\/g>/, "").replace(/<g class="pen">[\s\S]*?<\/g>/, "").replace(/<g class="code">[\s\S]*?<\/g>/, "").replace("</svg>", '<g class="cap">' + cap + "</g></svg>");
}

export function locoSvg(t, cs) {
    const c = "var(--c)", dk = "color-mix(in srgb,var(--c) 55%,#000)", px = (x, y, w, h, f) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${f}"/>`;
    const body = px(2, 7, 13, 5, c) + px(3, 6, 8, 1, c) + px(11, 3, 6, 9, dk) + px(12, 4, 4, 3, "#bfe3ff") + px(3, 3, 2, 4, dk) + px(1, 11, 17, 1, dk) + px(0, 12, 3, 1, dk);
    const wheels = `<g class="wh">${[4, 9, 14].map((x) => `<circle cx="${x}" cy="13.6" r="1.9" fill="#2b2f36" stroke="${dk}" stroke-width=".6"/><rect class="spk" x="${x - 0.25}" y="11.9" width=".5" height="3.4" fill="#9aa3ad"/>`).join("")}</g>`;
    const smoke = `<g class="sm"><circle class="p1" cx="15" cy="1.6" r="1.2" fill="#c9ced6"/><circle class="p2" cx="13.4" cy="0" r="1" fill="#dfe3e8"/></g>`;
    return `<svg class="locsvg" viewBox="-1 -2 21 18" aria-hidden="true">${smoke}<g transform="translate(19 0) scale(-1 1)">${body}${wheels}</g></svg><span class="locagi">${driverIcon(cs || agentState(t.key), 15)}</span>`;
}

const LOCO_AT = new Map();

function animateLocos() {
    for (const tr of document.querySelectorAll(".track[data-k]")) {
        const key = tr.dataset.k, sts = [...tr.querySelectorAll(":scope > .st")], k = sts.findIndex((b) => b.querySelector(".loco")), prev = LOCO_AT.get(key);
        LOCO_AT.set(key, k);
        if (prev == null || k < 0 || prev === k || prev < 0 || prev >= sts.length || !sts[k].animate)
            continue;
        const loco = sts[k].querySelector(".loco"), dx = sts[prev].getBoundingClientRect().left - sts[k].getBoundingClientRect().left;
        loco.animate([{ transform: `translateX(${dx}px)` }, { transform: "translateX(0)" }], { duration: Math.min(2400, 450 + Math.abs(prev - k) * 380), easing: "cubic-bezier(.3,.1,.25,1)" });
        loco.classList.add("arrive");
        setTimeout(() => loco.classList.remove("arrive"), 2600);
    }
}

function track(t) {
    const st = stagesOf(t), far = farOf(t), cur = far + 1;
    const running = S.jobs.some((j) => j.tree === t.key && j.status === "running"), queued = !running && S.jobs.some((j) => j.tree === t.key && ["queued", "waiting"].includes(j.status));
    return `<div class="track" data-k="${esc(t.key)}" style="--c:${t.color}">${st.map((x, k) => {
        const cls = [x.done ? "done" : "", x.q ? "q" : "", k === cur ? "cur" : "", !x.done && k < far ? "skip" : "", running && k === cur ? "run" : "", queued && k === cur ? "qd" : "", k === cur && far >= 0 ? "reach" : ""].join(" ");
        const tip = `${x.label}: ${x.hint}\nКлик: ${x.source === "manual" ? "вернуть автоматическую отметку" : x.done ? "снять отметку вручную" : "отметить пройденной вручную"}`;
        return `<button class="st ${cls}" data-act="stage" data-tree="${esc(t.key)}" data-stage="${x.id}" data-done="${x.done}" data-src="${x.source}" title="${esc(tip)}">${k === cur ? `<span class="loco ${running || ((S.agents || {})[t.key] || {}).busy ? "go" : ""}" title="${running ? "поезд едет: идёт прогон" : ((S.agents || {})[t.key] || {}).busy ? "поезд едет: агент работает" : "поезд стоит: ждёт действия"}">${locoSvg(t)}</span>` : ""}${x.source === "manual" ? '<span class="man"></span>' : ""}<span class="d">${x.done ? "✓" : x.q ? "?" : ""}</span><span>${esc(x.label)}${x.q ? " · вопрос владельцу" : !x.done && k < far ? " ?" : ""}</span></button>`;
    }).join("")}</div>`;
}

function trackRow(t, st, { id, running, queued, loco, locoCls = "" }) {
    const far = st.reduce((m, x, i) => (x.done ? i : m), -1), open = st.findIndex((x) => !x.done && !["plan", "red"].includes(x.id)), cur = open < 0 ? st.length : open, locoAt = Math.min(cur, st.length - 1);
    return `<div class="track maintrack" data-k="${esc(t.key + "|" + id)}" style="--c:${t.color}">${st.map((x, k) => {
        const cls = [x.done ? "done" : "", x.q ? "q" : "", k === cur ? "cur" : "", !x.done && k < far ? "skip" : "", running && k === cur ? "run" : "", queued && k === cur ? "qd" : "", k === cur && far >= 0 ? "reach" : ""].join(" ");
        const lc = k === locoAt && loco ? `<span class="loco ${locoCls} ${running ? "go" : ""}" title="${running ? "едет: идёт прогон или работает агент" : "стоит: ждёт действия"}">${loco}</span>` : "";
        const tip = x.fixed ? `${x.label}: ${x.hint}` : `${x.label}: ${x.hint}\nКлик: ${x.source === "manual" ? "вернуть автоматическую отметку" : x.done ? "снять отметку вручную" : "отметить пройденной вручную"}`;
        return `<button class="st ${cls}" ${x.fixed ? "" : `data-act="stage" data-tree="${esc(t.key)}" data-stage="${x.id}" data-done="${x.done}" data-src="${x.source}"`} title="${esc(tip)}">${lc}${x.source === "manual" ? '<span class="man"></span>' : ""}<span class="d">${x.done ? "✓" : x.q ? "?" : ""}</span><span>${esc(x.label)}${x.q ? " · вопрос владельцу" : !x.done && k < far ? " ?" : ""}</span></button>`;
    }).join("")}</div>`;
}

const WG_TONE = { work: "в работе у агента", check: "на проверках / ждёт влива", done: "влит в staging", depot: "в очереди", wait: "ждёт другой поезд" };

function trainQueue(t) {
    const all = t.wagonsView || [];
    if (!all.length)
        return `<div class="trains2" style="--c:${t.color}"><div class="tqueue"><span class="wgh mute">вагонов нет: волна в поезд — epic.mjs add-wagon --train ${esc(t.tag)}</span></div></div>`;
    const depLabel = (w) => {
        const wf = w.waitFor || [];
        if (!wf.length)
            return "";
        return "после " + wf.map((x) => {
            const [wv, tr] = String(x).split("@");
            return tr ? tr + " · " + wv : wv;
        }).join(", ");
    };
    const waitedBy = (w) => (S.trees || []).filter((o) => o.train && o.key !== t.key).flatMap((o) => (o.wagonsView || []).filter((z) => (z.waitFor || []).includes(w.wave + "@" + t.tag)).map((z) => o.tag + " · " + z.wave));
    const car = (w, dnd = false) => {
        const dl = depLabel(w), wb = waitedBy(w);
        return `<span class="tcar ${w.tone === "wait" ? "wait" : ""} ${dl || wb.length ? "hasdep" : ""}" data-act="wagonplan" data-tree="${esc(t.key)}" data-wave="${esc(w.wave)}" ${dnd ? `draggable="true" data-dnd="depot"` : ""} style="--w:${wagonColor(t, w.wave)}" title="${esc("Клик — план вагона" + (dnd ? ", перетаскивание — порядок очереди" : "") + "\n" + w.wave + " · " + (w.title || "") + "\n" + (WG_TONE[w.tone] || w.state) + (w.label ? " · " + w.label : "") + (w.after && w.after.length ? "\nпосле: " + w.after.join(", ") : "") + (wb.length ? "\nего ждут: " + wb.join(", ") : ""))}">${dl ? `<span class="tdep">${esc(dl)}</span>` : wb.length ? `<span class="tdep rev">ждёт ${esc(wb.join(", "))}</span>` : ""}${esc(w.wave)}<i></i></span>`;
    };
    const started = (w) => w.tone === "done" || w.commits > 0 || w.wave === t.issued;
    const done = all.filter((w) => w.tone === "done"), cur = all.find((w) => w.tone !== "done" && started(w)), queue = all.filter((w) => w.tone !== "done" && w !== cur);
    return `<div class="trains2" style="--c:${t.color}"><div class="tqueue">
    ${done.length ? `<span class="tstg" title="Вагоны, уже влитые в staging: ждут выката на стенд и приёмки, повторно не гоняются"><span class="wgh">в staging:</span><span class="tqrail stg">${done.map((w) => car(w)).join("")}</span></span>` : ""}
    ${cur ? `<span class="wgh">${esc(WG_TONE[cur.tone] || "в работе")}:</span><span class="tqrail">${car(cur)}</span>` : ""}
    ${queue.length ? `<span class="wgh">очередь:</span><span class="tqrail" data-dnd-tree="${esc(t.key)}" title="Вагоны идут строго по одному: следующий уйдёт агенту, когда вагон ветки вольётся в staging; перетащите не начатый вагон, чтобы сменить порядок">${queue.map((w) => car(w, !started(w))).join("")}</span>` : ""}
  </div></div>`;
}

export const wagonColor = (t, wave) => WAGON_COLORS[Math.max(0, ((t && t.wagonsView) || []).findIndex((x) => x.wave === wave)) % WAGON_COLORS.length];

export function expandTrainWagons(list) {
    const out = [], seen = new Set(), trees = S.trees || [], add = (o) => {
        if (!seen.has(o.key)) {
            seen.add(o.key);
            out.push(o);
        }
    };
    for (const x of list || []) {
        const k = String(x.key || "").replace(/^dev\//, "");
        const t = trees.find((z) => z.key === x.key || z.key === k || z.branch === x.key);
        const waves = t && t.train ? (t.wagonsView || []).filter((w) => w.tone === "done").map((w) => w.wave) : [];
        if (!waves.length) {
            add(x);
            continue;
        }
        for (const wv of waves) {
            const w = (t.wagonsView || []).find((z) => z.wave === wv) || {};
            add({ key: t.key + "|" + wv, tag: wv.replace(/^WV-/, ""), color: wagonColor(t, wv), title: wv + (w.title ? " · " + w.title : "") + " (" + t.tag + ")" });
        }
    }
    return out;
}

export function jobCarsHtml(t, w) {
    if (!t || !w || !(w.waves || []).length)
        return "";
    return `<span class="jobcars wagon" title="${esc("Проверка вагона " + w.waves[0])}" style="--c:${t.color}">${w.waves.map((x) => `<span class="tcar mini" style="--w:${wagonColor(t, x)}">${esc(x)}<i></i></span>`).join("")}</span>`;
}

const WAGON_COLORS = ["#16a34a", "#2563eb", "#9333ea", "#ea580c", "#ca8a04", "#db2777", "#0891b2", "#92400e"];

function autoTrainSwitch(t) {
    const all = !!(S.settings && S.settings.autoTrain), off = !!(S.settings && S.settings.autoTrainOff && S.settings.autoTrainOff[t.key]), on = all && !off;
    const tip = !all ? "Автопоезд выключен для всех веток в панели настроек" : on ? "Автопоезд этой ветки едет сам: сборка → гарды → тесты → ревью → регресс → коммит" + (t.train ? "; у поезда — и следующий вагон после влива" : "") + ". Клик — выключить" : "Автопоезд этой ветки выключен: станции, коммит" + (t.train ? " и следующий вагон" : "") + " — вручную. Клик — включить и поехать с первой непройденной станции";
    return `<button class="sm atsw ${on ? "on" : ""} ${PENDING.has("autochain|" + t.key) ? "busy" : ""}" data-act="autochain" data-tree="${esc(t.key)}" data-on="${on ? 0 : 1}" ${all ? "" : "disabled"} title="${esc(tip)}"><span class="knob"></span>Автопоезд ${on ? "вкл" : "выкл"}</button>`;
}

function testRow(t, task, preset) {
    const def = S.tasks[task];
    if (!def)
        return "";
    const pk = `run|${t.key}|${task}`, busy = PENDING.has(pk);
    const ik = def.input ? `<input type="text" data-ik="${esc(inKey(t.key, task))}" value="${esc(inVal(t, task, preset))}" placeholder="${esc(def.input.placeholder || def.input.ph || "")}" title="${esc(def.input.label)}">` : "";
    const lj = preset ? lastJobIn(t.key, task, preset.input) : lastJob(t.key, task);
    return `<div class="trow ${def.input ? "" : "noin"}"><span class="l">${esc(def.label)}</span>${ik}<span ${lj ? `data-act="log" data-id="${lj.id}" style="cursor:pointer"` : ""}>${chipOf(lj, pk)}</span><button class="sm primary ${busy ? "busy" : ""}" data-act="run" data-tree="${esc(t.key)}" data-task="${task}" title="запустить">${busy ? SPIN : "▶"}</button></div>` + suitesHTML(t, "tests", task, preset ? preset.input || "" : "");
}

const SUITE_IC = { ok: ["✓", "var(--good)", "зелёный на нынешнем коде (или правка его не задела)"], fail: ["✗", "var(--bad)", "красный"], stale: ["⟳", "var(--warn)", "правка задела — перегнать"], inherited: ["≈", "var(--text-2)", "красный и в самом staging — не вменяется"], unknown: ["?", "var(--text-2)", "результата нет"] };

function suitesHTML(t, kind, task, input) {
    const e = (t.suites || []).find((x) => x.kind === kind && x.task === task && x.input === (input || ""));
    if (!e)
        return "";
    const c = { ok: 0, fail: 0, stale: 0, inherited: 0, unknown: 0, ...(e.counts || {}) };
    if (!e.counts)
        for (const x of e.list)
            c[x.st] = (c[x.st] || 0) + 1;
    const redo = e.list.filter((x) => ["fail", "stale", "unknown"].includes(x.st)).map((x) => x.spec);
    const rows = e.list.slice().sort((x, y) => "fsuio".indexOf(x.st[0]) - "fsuio".indexOf(y.st[0])).map((x) => {
        const [ic, col, tip] = SUITE_IC[x.st] || SUITE_IC.unknown;
        return `<div class="srun"><span style="color:${col};font-weight:700" title="${esc(tip)}">${ic}</span><span class="mono" title="${esc(x.path || x.spec)}">${esc(x.spec)}</span>${x.job ? `<a data-act="log" data-id="${x.job}" class="mute" style="cursor:pointer">${x.job}</a>` : "<span></span>"}<button class="sm ghost" data-act="specrun" data-tree="${esc(t.key)}" data-fam="${esc(e.fam)}" data-specs="${esc(x.spec)}" title="Прогнать только эту спеку">▶</button></div>`;
    }).join("");
    return `<details class="suites"><summary>сьютов ${e.total || e.list.length}: <span style="color:var(--good)">✓ ${c.ok}</span>${c.fail ? ` · <span style="color:var(--bad)">✗ ${c.fail}</span>` : ""}${c.stale ? ` · <span style="color:var(--warn)">⟳ ${c.stale}</span>` : ""}${c.inherited ? ` · ≈ ${c.inherited}` : ""}${c.unknown ? ` · ? ${c.unknown}` : ""}</summary>${redo.length ? `<div style="margin:4px 0"><button class="sm primary" data-act="specrun" data-tree="${esc(t.key)}" data-fam="${esc(e.fam)}" data-specs="${esc(redo.join(","))}" title="Только красные, задетые правкой и без результата">▶ красные и устаревшие (${redo.length})</button></div>` : ""}${rows}</details>`;
}

function chatBtn(t) {
    const ag = (S.agents || {})[t.key] || {}, orch = t.kind === "orch", on = orch ? SIDEBAR : OPENCHAT.has(t.key);
    const badge = ag.pending ? ' <span class="bdg p" title="агент ждёт разрешения"></span>' : ag.busy ? ' <span class="bdg" title="агент работает"></span>' : ag.running ? ' <span class="mute">●</span>' : "";
    return `<button class="sm ${on ? "primary" : ""}" data-act="chat" data-tree="${esc(t.key)}" title="${orch ? "Чат оркестратора в левой панели" : "Чат агента этого слота под линией"}">💬 Чат${badge}</button>`;
}

function buildBtn(t) {
    if (t.kind !== "slot" || t.readOnly)
        return "";
    const pk = "run|" + t.key + "|build", busy = PENDING.has(pk), bj = lastJob(t.key, "build"), bs = jobsState(t, ["build"]);
    const bv = t.verdict && t.verdict.build;
    const state = t.buildNeeded === false ? "не нужна" : bv === "ok" ? "✓" : bv === "stale" ? "⟳" : bv === "fail" || (bj && bj.status === "fail") ? "✗" : "";
    return `<button class="sm ${stLook(bs, t.buildNeeded === false ? "notneeded" : bv || (bj && bj.status === "fail" ? "fail" : "")).cls} ${busy ? "busy" : ""}" data-act="run" data-tree="${esc(t.key)}" data-task="build" title="${esc(t.buildNeeded === false ? "В ветке нет изменений в путях областей со сборкой — собирать нечего" : "Соберёт: " + (t.buildWhat || "—") + ". Тесты области берут собранный код: без сборки они исполняют старый.")}">${busy ? SPIN + " Сборка" : bs.run || bs.q ? stateLabel(bs, "Сборка", "") : "🔨 Сборка"}${!bs.run && !bs.q && state ? ` <span class="chip ${state === "✗" ? "fail" : state === "✓" ? "ok" : state === "⟳" ? "queued" : ""}" ${state === "⟳" ? `title="${esc((t.verdict && t.verdict.bnote) || "")}"` : ""}>${state}</span>` : ""}</button>`;
}

function changesBtn(t) {
    const n = t.dirtyTracked + t.dirtyUntracked;
    return `<button class="sm" data-act="changes" data-tree="${esc(t.key)}" title="Что изменено в папке слота, дифф и коммит">📝 Изменения${n ? ` <span class="chip queued">${n}</span>` : t.ahead ? ` <span class="chip">↑${t.ahead}</span>` : ""}</button>`;
}

function runsCol(t) {
    const mine = S.jobs.filter((j) => j.tree === t.key);
    const q = mine.filter((j) => ["queued", "waiting"].includes(j.status)), done = mine.filter((j) => FIN_ST.includes(j.status)).slice(-8).reverse();
    const row = (j) => `<div class="prow" style="cursor:pointer" data-act="log" data-id="${j.id}"><div class="t"><b>${chipOf(j)} ${esc(j.label)}</b><span class="mono mute" title="${esc(j.input || "")}">${j.input ? esc(shortInput(j)) : ""}</span><span class="mute">${j.id}${runWhen(j) ? " · " + runWhen(j) : ""}</span></div><span></span></div>`;
    return `<h4>Прогоны</h4>${liveStrip(t) || '<div class="sub">Сейчас ничего не идёт.</div>'}${q.length ? `<div class="sub" style="margin-top:6px">В очереди</div>${q.map((j) => `<div class="prow"><div class="t"><b>⏳ ${esc(j.label)}</b><span class="mono mute">${j.input ? esc(shortInput(j)) : ""}</span><span class="mute">${esc(j.waitReason || (j.status === "waiting" ? "ждёт память" : "в очереди" + (j.pos ? " №" + j.pos : "")))}</span></div><button class="kill" data-act="cancel" data-id="${j.id}" title="Снять">⏹</button></div>`).join("")}` : ""}${done.length ? `<div class="sub" style="margin-top:6px">Последние</div>${done.map(row).join("")}` : ""}`;
}

const FIN_ST = ["ok", "fail", "skipped", "cancelled", "interrupted"];

function liveStrip(t) {
    const jobs = S.jobs.filter((j) => j.tree === t.key && j.status === "running");
    return jobs.map((j) => {
        const quiet = j.lastOutAt ? Math.round((Date.now() - j.lastOutAt) / 1000) : null;
        const slow = quiet != null && quiet > 20;
        const tail = (j.tailLines || []).map((l) => `<span>${esc(l)}\n</span>`).join("");
        return `<div class="live"><div class="lh"><span class="beat ${slow ? "quiet" : ""}"></span><b>${esc(j.label)}</b>${j.input ? `<span class="mono mute" title="${esc(j.input)}">${esc(shortInput(j))}</span>` : ""}<span class="chip running">${SPIN} ${dur(j)}</span>
      <span class="${slow ? "chip queued" : "sub"}" title="Тайпчек и сборка молчат подолгу: пока процесс жив и таймер идёт, всё в порядке.">${quiet == null ? "вывода ещё не было" : slow ? 'молчит <span data-ago="' + j.lastOutAt + '"></span> — процесс жив, считает' : 'вывод <span data-ago="' + j.lastOutAt + '"></span> назад'}</span>
      <span class="sp"></span><button class="sm ghost" data-act="log" data-id="${j.id}">весь лог ▸</button><button class="sm ghost" data-act="cancel" data-id="${j.id}">стоп</button></div>
      ${progBar(j)}${suiteListHTML(j)}<pre>${tail || "ждём первых строк…"}</pre></div>`;
    }).join("");
}

// Шаги подготовки слота: план приходит в прогоне (prog.plan — [[id, подпись]] по slotPrepare конфига); без плана —
// шаги, о которых прогон уже отчитался.
function slotStagesOf(j) {
    const p = (j && j.prog) || {};
    if (Array.isArray(p.plan) && p.plan.length)
        return p.plan.map((x) => (Array.isArray(x) ? x : [x.id, x.label || x.id]));
    const keys = Object.keys(p.stages || {});
    return keys.length ? keys.map((k) => [k, k === "worktree" ? "Папка и ветка" : k]) : [["worktree", "Папка и ветка"]];
}

function provLine(t) {
    const j = [...S.jobs].reverse().find((x) => x.task === "slot-up" && x.tree === t.key), active = j && ["queued", "waiting", "running"].includes(j.status), failed = j && j.status === "fail";
    const plan = slotStagesOf(j), st = (j && j.prog && j.prog.stages) || {}, cur = plan.find((x) => !st[x[0]]);
    const stages = plan.map((x) => {
        const v = st[x[0]], now = active && j.status === "running" && cur && cur[0] === x[0];
        const ic = v === "ok" ? "✓" : v === "fail" ? "✗" : v === "skip" ? "–" : now ? SPIN : "○";
        return `<div class="pst ${v === "ok" ? "ok" : v === "fail" ? "bad" : now ? "now" : ""}"><span class="pic">${ic}</span><span>${esc(x[1])}</span></div>`;
    }).join("");
    const head = failed ? `<span class="chip fail">✗ не удалось</span>` : active ? (j.status === "running" ? `<span class="chip running">${SPIN} готовится · ${dur(j)}</span>` : `<span class="chip queued">${j.status === "waiting" ? "ждёт память" : "в очереди"}</span>`) : "<span class=\"chip\">папки нет</span>";
    const act = failed ? `<button class="sm primary" data-act="provision" data-tree="${esc(t.key)}">↻ Повторить подготовку</button><button class="sm" data-act="log" data-id="${j.id}">лог</button>` : active ? `<button class="sm" data-act="log" data-id="${j.id}">лог</button><button class="sm ghost" data-act="cancel" data-id="${j.id}">стоп</button>` : `<button class="sm primary" data-act="provision" data-tree="${esc(t.key)}">▶ Подготовить слот</button>`;
    return `<div class="ln prov" style="--c:${t.color}"><div class="top">
    <div class="who"><div class="n">${agentIcon(t.color, active ? "work" : failed ? "sleep" : "warm", 24)} ${esc(t.tag)} · ${esc(t.title)}</div><div class="br" title="${esc(t.plannedBranch || "")}">${esc(t.plannedBranch || "")}</div><div class="chips">${head}</div></div>
    <div class="provtrack"><div class="pstages">${stages}</div>${j && active ? progBar(j) : ""}${failed && j.summary ? `<div class="sub" style="font-size:11px;color:var(--bad)">${esc(j.summary)}</div>` : ""}</div>
    <div class="acts">${act}</div></div></div>`;
}

function jobsState(t, tasks) {
    const js = S.jobs.filter((j) => j.tree === t.key && tasks.includes(j.task) && ["running", "queued", "waiting"].includes(j.status));
    const q = js.filter((j) => j.status !== "running"), pos = q.map((j) => j.pos).filter(Boolean).sort((a, b) => a - b)[0];
    return { run: js.length - q.length, q: q.length, pos, waiting: q.some((j) => j.status === "waiting") };
}

const stateCls = (s, base) => (s.run ? "rn" : s.q ? "qd" : base);

function stLook(s, v) {
    if (s && s.run)
        return { cls: "rn", ic: SPIN, tip: "идёт" + (s.q ? ", ещё " + s.q + " в очереди" : "") };
    if (s && s.q)
        return { cls: "qd", ic: "⏳", tip: s.waiting ? "ждёт память" : "в очереди" + (s.pos ? " №" + s.pos : "") };
    if (["green", "ok", "notneeded"].includes(v))
        return { cls: "good done", ic: "✓", tip: v === "notneeded" ? "не нужна" : "зелёный на нынешнем коде" };
    if (v === "fail")
        return { cls: "badb", ic: "✗", tip: "красный" };
    if (["stale", "nobuild", "requested", "unknown"].includes(v))
        return { cls: "warnb", ic: "↻", tip: v === "nobuild" ? "без свежей сборки — перегнать" : v === "requested" ? "агент просит перепрогнать" : "код менялся — перегнать" };
    return { cls: "primary", ic: "▶", tip: "ещё не было" };
}

const stateLabel = (s, name, idle) => (s.run ? SPIN + " " + name + " · идут" + (s.q ? ", ещё " + s.q + " в очереди" : "") : s.q ? "⏳ " + name + " · " + (s.waiting ? "ждут память" : "в очереди" + (s.pos ? " №" + s.pos : "")) : idle);

function waveState(t) {
    const tasks = new Set([...(t.presets || []).map((p) => p.task), ...((t.presets || []).length ? [] : gateTasks())]);
    const js = S.jobs.filter((j) => j.tree === t.key && tasks.has(j.task) && ["running", "queued", "waiting"].includes(j.status));
    const run = js.filter((j) => j.status === "running"), q = js.filter((j) => j.status !== "running"), pos = q.map((j) => j.pos).filter(Boolean).sort((a, b) => a - b)[0];
    return { run: run.length, q: q.length, pos, waiting: q.some((j) => j.status === "waiting") };
}

function line(t) {
    if (!t.exists || S.jobs.some((j) => j.tree === t.key && j.task === "slot-up" && ["queued", "waiting", "running"].includes(j.status)))
        return provLine(t);
    const orch = t.kind === "orch", open = OPEN.has(t.key) || (!orch && OPENCHAT.has(t.key)), n = orch ? null : nextStep(t);
    const ws = waveState(t), wv = t.verdict && t.verdict.tests, green = wv === "green", stc = stagesOf(t)[farOf(t) + 1], curId = stc ? stc.id : "";
    const stageBtn = curId === "review" ? reviewBtn(t) + reviewCommitBtn(t) : curId === "guards" ? (() => {
        const gs = jobsState(t, gateTasks());
        return `<button class="sm ${stLook(gs, t.verdict && t.verdict.guards).cls} ${PENDING.has("rungards|" + t.key) ? "busy" : ""}" data-act="rungards" data-tree="${esc(t.key)}" title="${esc("Задачи-гейты проекта: " + gateTasks().join(", "))}">${PENDING.has("rungards|" + t.key) ? SPIN + " Гарды " + unitOf(t) : stateLabel(gs, "Гарды " + unitOf(t), stLook(null, t.verdict && t.verdict.guards).ic + " Гарды " + unitOf(t))}</button>`;
    })() : curId === "commit" && t.dirtyTracked ? `<button class="sm primary ${commitBusy(t.key) ? "busy" : ""}" data-act="agentcommit" data-tree="${esc(t.key)}" title="Агент слота сам напишет подпись и сделает коммит">${commitBusy(t.key) ? SPIN : "⎇"} Коммит</button>` : curId === "regress" ? regressBtn(t) : readyStg(t) ? stgBtn(t) : "";
    const presetsBtn = (t.presets.length || curId === "tests") ? `<button class="sm ${stLook(ws, wv).cls} ${PENDING.has("runall|" + t.key) ? "busy" : ""}" data-act="runall" data-tree="${esc(t.key)}" title="${esc((green ? "Все тесты волны зелёные на нынешнем коде" + (t.buildNeeded ? ", сборка свежая" : "") + ". Перепрогнать всё равно — Shift+клик.\n" : (t.verdict && t.verdict.note ? t.verdict.note + "\n" : "")) + t.presets.map((p) => S.tasks[p.task].label + (p.input ? " " + p.input : "")).join("\n"))}">${PENDING.has("runall|" + t.key) ? SPIN + " Тесты " + unitOf(t) : ws.run ? SPIN + " Тесты " + unitOf(t) + " · идут" + (ws.q ? ", ещё " + ws.q + " в очереди" : "") : ws.q ? "⏳ Тесты " + unitOf(t) + " · " + (ws.waiting ? "ждут память" : "в очереди" + (ws.pos ? " №" + ws.pos : "")) : stLook(null, wv).ic + " Тесты " + unitOf(t)}</button>` : "";
    const presets = presetsBtn;
    const mine = S.jobs.filter((j) => j.tree === t.key).slice(-1)[0];
    const opts = Object.entries(S.tasks).map(([k, v]) => `<option value="${k}" ${SEL[t.key] === k ? "selected" : ""}>${esc(v.group)} · ${esc(v.label)}</option>`).join("");
    const body = open ? `${n ? `<div class="more next1"><div class="next">Дальше: <b>${esc(n.text)}</b>${n.btn || ""}</div></div>` : ""}<div class="more3">${orch ? "" : `<div class="m3chat"><div class="chatslot" data-key="${esc(t.key)}"></div></div>`}<div class="more m3mid">
      <div class="blk"><h4>${t.train ? "Сборка и тесты вагона " + esc(t.wagon || "") : "Сборка и тесты волны"}</h4>${orch || t.readOnly ? "" : testRow(t, "build")}${t.presets.length ? t.presets.map((p) => testRow(t, p.task, p)).join("") : '<div class="sub">Готовых тестов для слота нет — выберите в «Другом».</div>'}</div>
      <div class="blk"><h4>${t.train ? "Гарды вагона" : "Гарды перед слиянием"}</h4>${t.readOnly ? '<div class="sub">Слот только читает код (разведка): гарды перед слиянием ему не нужны, поэтому станция «Гарды» отмечена как не требуемая.</div>' : (gateTasks().map((g) => testRow(t, g)).join("") || '<div class="sub">Задач-гейтов в конфиге нет.</div>')}</div>
      ${regressBlk(t)}
      <div class="blk"><h4>Другое</h4><div class="free"><select data-sel="${esc(t.key)}">${opts}</select><input type="text" data-ik="${esc(t.key)}|__free" value="${esc(IN[t.key + "|__free"] || "")}" placeholder="ввод, если нужен"><button class="sm primary ${PENDING.has("free|" + t.key) ? "busy" : ""}" data-act="free" data-tree="${esc(t.key)}">${PENDING.has("free|" + t.key) ? SPIN : "▶"}</button></div>
        <div class="sub">последний коммит: ${t.ahead ? `<span class="mono">${esc(t.last.sha)}</span> ${esc(t.last.subject)} · ${esc(t.last.when)}` : `своих коммитов нет, база — staging <span class="mono">${esc(t.last.sha)}</span>`}</div>
        ${orch ? "" : `<div><button class="sm" data-act="pl" data-action="merge" data-slot="${esc(t.key)}" ${t.conflict && t.conflict.length ? 'disabled title="конфликт со staging: сначала «⤓ Подтянуть staging» и разрешить конфликт в слоте"' : !(t.ahead && !t.dirtyTracked) ? 'disabled title="нужны коммиты в ветке и чистое дерево"' : stagesOf(t).some((x) => ["build", "tests", "guards", "regress", "review"].includes(x.id) && !x.done) ? 'disabled title="сборка, тесты, гарды и регресс должны быть пройдены на нынешнем коде (или отмечены вручную)"' : ""}>Влить в staging…</button></div>`}</div>
    </div><div class="m3runs">${runsCol(t)}</div></div>` : "";
    return `<div class="ln" style="--c:${t.color}">
    <div class="top">
      <div class="ttl n">${agentIcon(t.color, agentState(t.key), 20)} ${esc(t.tag)} · ${esc(t.title)}</div>
      <div class="who"><div class="br" title="${esc(t.branch)}">${esc(t.branch)}</div>${summaryRow(t)}</div>
      ${orch ? `<div class="orchrow">Окно оркестратора: эпик, его план, общие файлы. Станций у него нет — это не волна.</div>` : t.train ? track(t) + trainQueue(t) : track(t)}
        <div class="lnbrk"></div><div class="chips pills">${extraChips(t)}${staleChip(t)}${t.dirtyTracked ? `<span class="chip queued" title="изменённых отслеживаемых файлов">✎ ${t.dirtyTracked}</span>` : ""}${t.dirtyUntracked ? `<span class="chip" title="новых файлов">+${t.dirtyUntracked}</span>` : ""}${mine ? `<span data-act="log" data-id="${mine.id}" style="cursor:pointer" title="${esc(mine.label)}">${chipOf(mine)}</span>` : ""}</div>
      <div class="acts">${t.hasCode === false && !orch ? (n && n.act === "train-wagon" ? wagonLaunchBtn(t) : "") : buildBtn(t) + presets + stageBtn}${changesBtn(t)}${t.verdict && t.verdict.merged && !(t.train && (t.wagonsView || []).some((w) => w.tone !== "done")) ? `<button class="sm" data-act="archive" data-tree="${esc(t.key)}" title="Ветка влита: убрать папку слота (node_modules, сборка), ветка и запись в реестре останутся">🗄 В архив</button>` : ""}${!orch && !t.readOnly && !(t.verdict && t.verdict.merged) ? autoTrainSwitch(t) : ""}${!orch && !t.readOnly && t.ahead > 0 ? `<button class="sm ghost ${PENDING.has("reset|" + t.key) ? "busy" : ""}" data-act="slotreset" data-tree="${esc(t.key)}" title="Сбросить ветку слота на staging: снять свои коммиты (тег-страховка backup/… на старый коммит), на всех машинах. Сначала покажет план; агент должен быть остановлен, прогонов и несохранённого — нет">↺ Сбросить…</button>` : ""}<button class="sm ghost" data-act="focus" data-tree="${esc(t.key)}" title="Фокус: только эта ветка (клавиша f)">⛶</button><button class="sm ghost" data-act="toggle" data-tree="${esc(t.key)}">${open ? "Свернуть ▲" : "Подробнее ▼"}</button></div>
    </div>${body}</div>`;
}

export const GROUPS = [["need", "🙋 Нужен ты"], ["work", "⚙ Работает"], ["train", "🚂 В поезде"], ["idle", "⏸ Ждёт или стоит"], ["merged", "✓ Влито"]];

export const GFOLD = new Set((() => {
    try {
        return JSON.parse(localStorage.getItem("dash.gfold") || "[]");
    }
    catch {
        return [];
    }
})());

export const slotGroup = (t) => t.group || "idle";

export function linesList() {
    const slots = S.trees.filter((t) => t.kind !== "orch");
    if (FOCUS) {
        const t = slots.find((x) => x.key === FOCUS);
        if (t) {
            OPEN.add(t.key);
            return [{ key: "__focus", focusbar: true, tree: t }, t];
        }
        setState("FOCUS", null);
    }
    const out = [{ key: "__staging", stg: true }];
    for (const [g, label] of GROUPS) {
        const m = slots.filter((t) => slotGroup(t) === g);
        if (!m.length)
            continue;
        const f = GFOLD.has(g);
        out.push({ key: "__g_" + g, hdr: `<div class="grph" data-act="grpfold" data-g="${g}" style="cursor:pointer;user-select:none" title="${f ? "Развернуть" : "Свернуть"} группу">${f ? "▸" : "▾"} ${label} <span class="chip">${m.length}</span></div>` }, ...(f ? [] : m));
    }
    return out;
}

function focusBar(t) {
    const j = S.jobs.filter((x) => x.tree === t.key).slice(-1)[0];
    return `<div class="focusbar"><b>⛶ Фокус: ${t.emoji} ${esc(t.tag)} · ${esc(t.title)}</b><span class="sp"></span><button class="sm" data-act="changes" data-tree="${esc(t.key)}">📝 Дифф</button><button class="sm" data-act="chat" data-tree="${esc(t.key)}" data-open="1">💬 Чат</button>${j ? `<button class="sm" data-act="log" data-id="${j.id}">≡ Лог</button>` : ""}<button class="sm ghost" data-act="focusexit">← все ветки (Esc)</button></div>`;
}

function summaryRow(t) {
    return t.summary && t.summary.text ? `<div class="sum2" title="${t.summary.src === "agent" ? "сводка агента слота" : "подписи последних коммитов ветки"}">📝 ${esc(t.summary.text)}</div>` : "";
}

export function extraChips(t) {
    let h = "";
    if (t.conflict && t.conflict.length)
        h += `<span class="chip fail" title="Конфликт слияния со staging: ${esc(t.conflict.join(", "))}. Влейте staging в ветку и разрешите в слоте.">⚠ конфликт со staging</span>`;
    for (const p of (S.orderHints || []).filter((x) => x.conflict && (x.a === t.key || x.b === t.key)))
        h += `<span class="chip fail" title="Ветки конфликтуют между собой: вливать по очереди, во вторую сначала влить staging">⚠ конфликт с ${esc(p.a === t.key ? p.bt : p.at)}</span>`;
    if (t.review && t.review.verdict) {
        const r = t.review, za = r.verdict === "ЗА";
        const say = za ? (r.fresh ? "ревью: ЗА" : "ревью было ЗА · код с тех пор менялся, нужно новое")
            : !r.fresh ? "ревью: были замечания · агент поправил, новое ревью после проверок"
                : reviewOwed(t) ? "ревью: замечания · не отданы агенту" : "ревью: замечания у агента, он правит";
        h += `<span class="chip ${za ? "ok" : r.verdict === "ПРОТИВ" ? "fail" : "queued"}" data-act="log" data-id="${r.jobId}" style="cursor:pointer" title="${esc("Независимый ревьюер, вердикт " + r.verdict + ". «ВОПРОСЫ» — нашёл замечания: они уходят агенту слота, тот правит или объясняет несогласие; владелец нужен, только если агент не согласен.\n\n" + (r.text || ""))}">${esc(say)}</span>`;
    }
    return h;
}

export const reviewOwed = (t) => !!(t.review && t.review.fresh && t.review.verdict && t.review.verdict !== "ЗА" && t.review.reported === false);
const reviewCommitBtn = (t) => !t.readOnly && (t.dirtyTracked || t.dirtyUntracked) ? `<button class="sm ${commitBusy(t.key) ? "busy" : ""}" data-act="agentcommit" data-tree="${esc(t.key)}" title="Агент слота сам выберет файлы волны, напишет подпись и сделает коммит в своей ветке (навык slot-commit). Пуш и слияние — отдельно, по вашему слову.">${commitBusy(t.key) ? SPIN : "⎇"} Коммит силами агента</button>` : "";

export function reviewBtn(t) {
    const s = jobsState(t, ["review"]), r = t.review;
    if (!s.run && !s.q && r && r.fresh && r.verdict) {
        const again = `<button class="sm ghost" data-act="runreview" data-tree="${esc(t.key)}" data-force="1" title="Код не менялся: повтор даст тот же вердикт и потратит лимит">↻</button>`;
        if (reviewOwed(t))
            return `<button class="sm primary" data-act="report" data-id="${r.jobId}" title="Замечания ревьюера уйдут агенту слота одним сообщением">→ Агенту замечания ревью</button>` + again;
        return `<span class="chip ${r.verdict === "ЗА" ? "ok" : "queued"}">${r.verdict === "ЗА" ? "ревью: ЗА" : "ревью: замечания у агента"}</span>` + again;
    }
    return reviewBtnRun(t, s);
}

function reviewBtnRun(t, s) {
    if (!s.run && !s.q && S.settings && S.settings.autoTrain && S.jobs.some((j) => j.tree === t.key && j.task !== "review" && ["running", "queued", "waiting"].includes(j.status)))
        return `<button class="sm qd" data-act="runreview" data-tree="${esc(t.key)}" title="Автопоезд запустит ревью сам, когда закончатся идущие проверки слота (гарды, тесты, регресс). Нажать — запустить сейчас, не дожидаясь">⏳ ${t.train ? "Ревью вагона" : "Ревью"} · после проверок</button>`;
    return `<button class="sm ${stateCls(s, "primary")}" data-act="runreview" data-tree="${esc(t.key)}" title="Отдельная сессия агента без контекста автора, только чтение: смотрит дифф ветки и даёт вердикт ЗА / ВОПРОСЫ / ПРОТИВ (клавиша v)">${stateLabel(s, (t.train ? "Ревью вагона" : "Ревью"), "▶ " + (t.train ? "Ревью вагона" : "Ревью"))}</button>`;
}

function staleChip(t) {
    const risk = t.staleRisk || [], cls = !t.behind ? "" : risk.length ? "fail" : "queued";
    const tip = !t.behind ? "коммитов впереди / позади staging" : "staging ушёл вперёд на " + t.behind + " коммит(ов)" + (risk.length ? ". Те же файлы правил и staging — близок конфликт:\n" + risk.slice(0, 15).join("\n") : "") + (t.ahead ? "\nСвои коммиты есть: подтянуть — влив staging в ветку волны (кнопкой)." : "\nСвоих коммитов нет: диспетчерская перемотает сама.");
    return `<span class="chip ${cls}" title="${esc(tip)}">↑${t.ahead} ↓${t.behind}${t.behind ? (risk.length ? " ⚠ " + risk.length : "") : ""}</span>${t.behind && (t.ahead || t.dirtyTracked) ? `<button class="sm ${PENDING.has("sync|" + t.key) ? "busy" : ""}" data-act="slotsync" data-tree="${esc(t.key)}" title="${esc("Подтянуть staging в ветку волны: " + (t.ahead ? "влив (коммит слияния только в ветке слота; staging и main не трогаются)" : "перемотка") + ". Конфликт — откат и список файлов агенту.")}">⤓ staging</button>` : ""}`;
}
