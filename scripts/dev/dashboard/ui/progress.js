// progress.js — окно «Ход эпика»: готово, но не влито, и что держит; простой с причиной, отказы и тупики команд,
// перезапуски, касания владельца. Подсчёт на сервере; окно опрашивает его раз в минуту, пока открыто.
import { $, call, esc } from "./core.js";
import { openRetro } from "./retro.js";

const hm = (t) => (t ? new Date(t).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const dur = (min) => (min >= 60 ? Math.floor(min / 60) + " ч " + String(min % 60).padStart(2, "0") + " мин" : min + " мин");
const kt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + " млн" : n >= 1e3 ? Math.round(n / 1e3) + " тыс." : String(n));
const HOLD_COL = { "тупик": "var(--bad)", "красное": "var(--bad)", "конфликт": "var(--bad)", "слово владельца": "var(--warn)", "ворота": "var(--warn)", "порядок": "var(--warn)", "влив в очереди": "var(--run)", "нет команды ВЛИТЬ": "var(--warn)" };

function sec(title, body, hint = "") {
    return `<div style="margin:12px 0 4px"><b>${title}</b>${hint ? ` <span class="sub" style="font-size:11px">${hint}</span>` : ""}</div>${body}`;
}

function tile(label, val, bad, hint = "") {
    return `<div class="tk ${bad ? "go" : "ok"}" style="padding:6px 10px;min-width:120px" title="${esc(hint)}"><div class="sub" style="font-size:11px">${label}</div><div style="font-size:18px;font-weight:700${bad ? ";color:var(--bad)" : ""}">${val}</div></div>`;
}

export function progressHTML(p) {
    const c = p.commands || {}, o = p.owner || {}, r = p.restarts || {}, idle = p.idle || {};
    const vl = (c.byCmd || {})["ВЛИТЬ"] || { n: 0, fail: 0 }, pg = (c.byCmd || {})["ПРОГНАТЬ"] || { n: 0, partial: 0 };
    const tiles = `<div style="display:flex;gap:8px;flex-wrap:wrap">` +
        tile("ждут влива сейчас", p.readyNow, p.ready.some((x) => x.alarm), "волны с коммитом, ещё не влитые в staging") +
        tile("готово, не влито", p.readyWaveH + " волна-ч", p.readyWaveH > 2, "сумма ожидания «коммит → влив» за окно (цель — около нуля)") +
        tile("простой", dur(idle.min || 0) + (idle.openMin ? " · " + idle.share + "%" : ""), (idle.min || 0) >= 30, "время с открытыми волнами без прогона и без хода с действием; доля — от времени с открытыми волнами") +
        tile("отказы ВЛИТЬ", vl.fail + " из " + vl.n, vl.fail > 0) +
        tile("ПРОГНАТЬ «не понял»", pg.partial + " из " + pg.n, pg.partial > 0) +
        tile("тупики", c.deadlocks || 0, (c.deadlocks || 0) > 0, "одна и та же причина отказа 3 раза подряд на том же коде (цель — 0)") +
        tile("перезапуски", (r.starts || []).length, (r.starts || []).length > 2, "запуски диспетчерской за окно") +
        tile("ходы ОРК без действия", o.orchTurns ? o.emptyTurns + " из " + o.orchTurns : "—", o.orchTurns && o.emptyTurns / o.orchTurns > 0.2, "ход без блока slot:, без строк команд и без «Вопросы владельцу:»") + `</div>`;
    const ready = p.ready.length ? p.ready.map((x) => `<div class="stf" style="grid-template-columns:44px 110px 110px 90px minmax(0,1fr);align-items:center;font-size:12.5px"><b>${esc(x.tag)}</b><span class="mono">${hm(x.readyAt)}</span><span class="mono">${x.mergedAt ? hm(x.mergedAt) : "<i>не влита</i>"}</span><span style="${x.alarm ? "color:var(--bad);font-weight:700" : ""}">${dur(x.waitMin)}</span><span>${x.hold ? `<span class="chip" style="color:${HOLD_COL[x.hold.kind] || "inherit"}">${esc(x.hold.kind)}</span> <span class="sub" style="font-size:11px">${esc(String(x.hold.text || "").slice(0, 160))}</span>` : ""}</span></div>`).join("") : '<div class="sub">за окно волн с коммитом нет</div>';
    const spans = (idle.spans || []).length ? idle.spans.map((s) => `<div class="stf" style="grid-template-columns:230px 90px minmax(0,1fr);font-size:12.5px"><span class="mono">${hm(s.from)} → ${hm(s.to)}</span><b>${dur(s.min)}</b><span class="sub">${esc(s.why)}</span></div>`).join("") : '<div class="sub">простоев дольше 15 мин нет</div>';
    const reasons = (c.topReasons || []).length ? c.topReasons.map((x) => `<div style="font-size:12.5px">${x.n}× <span class="sub">${esc(x.why)}</span></div>`).join("") : '<div class="sub">отказов нет</div>';
    const cmds = Object.entries(c.byCmd || {}).map(([k, v]) => `${esc(k)} ${v.n}${v.fail ? ` <span style="color:var(--bad)">(отказ ${v.fail})</span>` : ""}${v.partial ? ` <span style="color:var(--warn)">(«не понял» ${v.partial})</span>` : ""}`).join(" · ") || "—";
    const starts = (r.starts || []).map((s) => `<div style="font-size:12.5px"><span class="mono">${hm(s.at)}</span> <span class="mono mute">${esc(s.sha)}</span> ${esc(s.reason || "без причины")}${s.silentS != null ? ` <span class="sub">(без сервера ${s.silentS} с)</span>` : ""}</div>`).join("") || '<div class="sub">перезапусков нет</div>';
    const tok = (p.tokens || []).length ? p.tokens.map((t) => `<div class="stf" style="grid-template-columns:60px 1fr 1fr 1fr 70px;font-size:12.5px"><b>${esc(t.tag)}</b><span>ходов ${t.turns}</span><span>контекст ${kt(t.in + t.cr + t.cw)}</span><span>ответ ${kt(t.out)}</span><span>$${t.cost}</span></div>`).join("") : '<div class="sub">ходов агентов за окно не записано</div>';
    const k = p.counters;
    const base = k ? sec("Счётчики эпика", `<div style="display:flex;gap:8px;flex-wrap:wrap">` +
        tile("прогонов", k.runs + " · " + dur(k.runMin), false, "все прогоны слотов эпика за окно и их машинные минуты") +
        tile("регресс", k.regress.runs + " · " + dur(k.regress.min), false, "прогоны соседей по тронутым путям; доведено " + k.regress.done + " (" + k.regress.doneMin + " мин)") +
        tile("регресс потерян", k.regress.lost + " · " + dur(k.regress.lostMin), k.regress.lost > 0, "прерванные и отменённые запуски регресса (обрывы, перегрузка сервера, перезапуски)") +
        tile("ревью", k.review.runs + (k.review.runs ? " · с вопросами " + k.review.questions : ""), false) +
        (k.security ? tile("гарды", k.security.runs + " · " + dur(k.security.min), false) : "") +
        tile("агентов в час", "пик " + k.agents.peak + " · p50 " + k.agents.p50, k.agents.peak > 6, "разных слотов с ходом агента в одном часе (≈0,5 ГБ на агента)") +
        (k.repeats ? tile("повторы на том же коде", k.repeats.runs + " · " + dur(k.repeats.min), k.repeats.runs > 0, "та же проверка того же слота с тем же вводом на том же коде — сверх первой: " + (k.repeats.top || []).map((g) => g.task + " ×" + g.n).join(", ")) : "") +
        (k.lost ? tile("потеряно прогонов", k.lost.runs + " · " + dur(k.lost.min), k.lost.runs > 0, "все прерванные и отменённые прогоны эпика") : "") +
        (k.questions ? tile("простой на вопросах", dur(k.questions.waitMin) + (k.questions.open ? " · открыто " + k.questions.open : ""), k.questions.waitMin >= 60, "вопросов владельцу " + k.questions.n + "; от вопроса до ответа владельца, автоответа или следующего хода агента") : "") + `</div>`, "базис для сравнения слотов-поездов с эпиком без них") : "";
    return tiles + base +
        sec("Готово, но не влито", ready, "коммит → влив; тревога — ждёт дольше 30 мин") +
        sec("Простой эпика", spans, "открытые волны есть, а ни прогона, ни хода с действием нет дольше 15 мин") +
        sec("Команды оркестратора", `<div style="font-size:12.5px">${cmds}; блоков ворот ${c.gateBlocked || 0}</div>${reasons}`, "частые причины отказа") +
        sec("Перезапуски диспетчерской", starts + `<div class="sub" style="font-size:11px">прерванных прогонов эпика: ${r.interrupted || 0}; команд, оборванных перезапуском: ${r.cutCommands || 0}</div>`) +
        sec("Касания владельца", `<div style="font-size:12.5px">сообщений владельца ${o.messages || 0} · ответов на вопросы ${o.answers || 0}${o.questions != null ? " · открытых вопросов сейчас " + o.questions : ""} · толчков сторожа простоя ${o.nudges || 0}${o.orchTurns ? ` · ходов оркестратора ${o.orchTurns}, без действия ${o.emptyTurns} (${kt(o.emptyTok)} токенов)` : ""}</div>`) +
        sec("Токены агентов", tok, "из итогов ходов агентов");
}

const RETRO_WORD = { running: "идёт", ok: "готово", fail: "не удалось", collected: "вход собран (сухой режим)" };

export function retroLine(r) {
    if (!r)
        return "ретро ещё не было";
    return "ретро: " + (RETRO_WORD[r.status] || r.status) + " · " + hm(r.at) + (r.file ? " · " + r.file : "") + ((r.items || []).length ? " · карточки " + r.items.join(", ") : "") + (r.error ? " · " + r.error : "");
}

export function openEpicProgress(id) {
    let hours = 24, timer = null;
    const open = () => $("modal").classList.contains("on");
    async function draw() {
        clearTimeout(timer);
        let body;
        try {
            const p = await call("/api/epic-progress?epic=" + encodeURIComponent(id) + "&hours=" + hours);
            body = progressHTML(p) + `<div class="sub" style="font-size:11px;margin-top:8px">Окно: ${hm(p.from)} → ${hm(p.to)}</div>`;
        }
        catch (e) {
            body = `<div class="sub" style="color:var(--bad)">${esc(e.message)}</div>`;
        }
        if (!open() || !$("epgBody"))
            return;
        $("epgBody").innerHTML = body;
        timer = setTimeout(() => {
            if (open() && $("epgBody"))
                draw();
        }, 60e3);
    }
    $("mb").innerHTML = `<h3>Ход эпика · ${esc(id)}</h3><div style="display:flex;gap:6px;align-items:center;margin-bottom:6px"><span class="sub">окно:</span>${[24, 48, 96].map((h) => `<button class="sm ${h === hours ? "on" : ""}" id="epgH${h}">${h} ч</button>`).join("")}<span style="flex:1"></span><span class="sub" id="epgRetroSt" style="font-size:11px;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span><button class="sm" id="epgRetro" title="Ретро-агент читает журнал эпика, прогоны, логи красного и план; пишет docs/retro/<эпик>.md и заводит карточки бэклога по предложениям">Ретроспектива</button><button class="ghost" data-act="mclose">Закрыть</button></div><div id="epgBody" style="max-height:70vh;overflow:auto">загрузка…</div>`;
    $("modal").classList.add("on");
    for (const h of [24, 48, 96])
        $("epgH" + h).onclick = () => {
            hours = h;
            for (const x of [24, 48, 96])
                $("epgH" + x).classList.toggle("on", x === h);
            $("epgBody").innerHTML = "загрузка…";
            draw();
        };
    const retroSt = async () => {
        try {
            const r = await call("/api/retro?epic=" + encodeURIComponent(id));
            if ($("epgRetroSt")) {
                $("epgRetroSt").textContent = retroLine(r.retro);
                $("epgRetroSt").title = retroLine(r.retro);
            }
        }
        catch { }
    };
    $("epgRetro").onclick = () => openRetro(id);
    retroSt();
    draw();
}
