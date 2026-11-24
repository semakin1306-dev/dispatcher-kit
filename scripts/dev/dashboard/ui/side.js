// side.js — левая колонка: рейл разделов и их панели (ветки, запуски, ревью, выкат, здоровье, приёмка, модули). Разделы
// рейла фильтруются по включённым модулям установки.
import { FILTER, PENDING, S } from "./state.js";
import { $, branchLabel, agentIcon, agentState, dur, esc, gateTasks, hasMain, ls, modOn, pageScrollTop, runWhen, setHTML, SPIN } from "./core.js";
import { lastJobOf, loadAccept, treeOf } from "./data.js";
import { chipOf, extraChips, farOf, GROUPS, nextStep, reviewBtn, slotGroup } from "./lines.js";
import { failedUnresolved, flakyCards, FLY_MS, pendingCards, stgCards, taskCard, trainCard, trainStatusCard } from "./tasks.js";
import { setSidebar, SIDEBAR, sideChatKey } from "./chat.js";
import { NOTES } from "./dialogs.js";

export const ICONS = { "modules": "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path fill=\"none\" stroke=\"currentColor\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z\"/></svg>", "orch": "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193q-.51.041-1.02.072v3.091l-3-3q-2.031 0-4.02-.163a2.1 2.1 0 0 1-.825-.242m9.345-8.334a2 2 0 0 0-.476-.095a48.6 48.6 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.5 48.5 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402c-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235q.865.113 1.74.194V21l4.155-4.155\"/></svg>", "slots": "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75\"/></svg>", "runs": "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"><path d=\"M21 12a9 9 0 1 1-18 0a9 9 0 0 1 18 0\"/><path d=\"M15.91 11.672a.375.375 0 0 1 0 .656l-5.603 3.113a.375.375 0 0 1-.557-.328V8.887c0-.286.307-.466.557-.327z\"/></g></svg>", "review": "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m5.231 13.481L15 17.25m-4.5-15H5.625c-.621 0-1.125.504-1.125 1.125v16.5c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9m3.75 11.625a2.625 2.625 0 1 1-5.25 0a2.625 2.625 0 0 1 5.25 0\"/></svg>", "ship": "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M15.59 14.37q.159.666.16 1.38a6 6 0 0 1-6 6v-4.8m5.84-2.58a14.98 14.98 0 0 0 6.16-12.12A14.98 14.98 0 0 0 9.631 8.41m5.96 5.96a14.9 14.9 0 0 1-5.841 2.58m-.119-8.54a6 6 0 0 0-7.381 5.84h4.8m2.581-5.84a14.9 14.9 0 0 0-2.58 5.84m2.699 2.7q-.155.032-.311.06a15 15 0 0 1-2.448-2.448l.06-.312m-2.24 2.39a4.49 4.49 0 0 0-1.757 4.306q.341.054.696.054a4.5 4.5 0 0 0 3.61-1.812M16.5 9a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0\"/></svg>", "health": "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104q-.376.034-.75.082m.75-.082a24.3 24.3 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104q.377.034.75.082M19.8 15.3l-1.57.393A9.07 9.07 0 0 1 12 15a9.07 9.07 0 0 0-6.23-.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.3 48.3 0 0 1 12 21a48 48 0 0 1-8.135-.687c-1.718-.293-2.3-2.379-1.067-3.61L5 14.5\"/></svg>", "keys": "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M9.879 7.519c1.172-1.025 3.071-1.025 4.243 0c1.171 1.025 1.171 2.687 0 3.712q-.308.268-.67.442c-.746.361-1.452.999-1.452 1.827v.75M21 12a9 9 0 1 1-18 0a9 9 0 0 1 18 0m-9 5.25h.008v.008H12z\"/></svg>" };
const icon = (k) => ICONS[k] || "";
// Адрес стенда — из конфига приёмки (accept.standUrl); путь в пункте чек-листа открывается на нём.
const standBase = () => String((S && S.accept && S.accept.standUrl) || "").replace(/\/+$/, "");

const accHref = (w) => {
    const m = /(https?:\/\/\S+|\/[\w\-./:?=&%#]+)/.exec(w || "");
    return m ? (m[1].startsWith("/") ? (standBase() ? standBase() + m[1] : "") : m[1]) : "";
};

function acceptPanel() {
    const A = S.accept;
    if (!A)
        return '<div class="sub">Нет данных о приёмке.</div>';
    if (A.brief) {
        loadAccept();
        return '<div class="sub">Загружаю чек-листы приёмки…</div>';
    }
    const ws = A.waves || [];
    const sm = A.shard, st = A.stand;
    const syncing = A.syncing ? `<div class="calm acc-sync">${SPIN} Сводятся записи приёмки… После запуска сервера git считает файлы вливов волн (обычно 1–3 мин): до этого чек-листы и вердикты не показываются, отметки ставить нельзя.</div>` : "";
    const head = `<div class="acc-head">
    <div class="sub">${st ? "Стенд выкачен " + new Date(st.at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + " (" + esc(st.job) + ")" : "Стенд ещё не выкатывали из диспетчерской"}${sm ? " · полный прогон: " + (sm.status === "done" && !sm.fail && !sm.notrun ? "✓ зелёный" : sm.status === "running" ? "идёт" : "✗ " + sm.fail + " красных") : ""}</div>
    <div class="acts" style="gap:6px;display:flex;flex-wrap:wrap"><button class="sm primary ${PENDING.has("accask") ? "busy" : ""}" data-act="accask" title="Попросить чек-листы у агентов всех волн, у которых его ещё нет. После выката на стенд это происходит само">${PENDING.has("accask") ? SPIN : "📋"} Опросить ветки</button>
    <button class="sm ${PENDING.has("accspecall") ? "busy" : ""}" data-act="accspecall" title="Всем волнам, которые ждут вердикта и у которых есть чек-лист: агент волны заново пишет спеку приёмки. Ветки без своих коммитов перематываются на staging">🧪 Спеки всем</button><button class="sm ${PENDING.has("accsend") ? "busy" : ""}" data-act="accsend" title="Отправить вердикты: «не принято» — агенту его пункты на доделку, «принято» — короткое подтверждение; оркестратору — сводка">${PENDING.has("accsend") ? SPIN : "📨"} Отправить итоги</button></div></div>`;
    const fmt = (t) => t ? new Date(t).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
    const rn = A.run, live = (j) => j && ["queued", "waiting", "running"].includes(j.status);
    const pers = `<div class="acc-ps">
    <div class="row"><b>🤖 Автоприёмка</b><span class="sub">${A.runnable ? "команда приёмки из конфига" + (A.specGlob ? " · спеки " + esc(A.specGlob) : "") + (A.standUrl ? " · против " + esc(A.standUrl) : "") : "команда приёмки не задана (accept.run) — пункты проверяются руками"}</span>
      <span class="sp"></span>
      ${live(rn) ? `<span class="sub" style="flex-basis:100%">${SPIN} ${rn.live ? "тест " + rn.live.n + " из " + rn.live.of + " · " + esc(rn.live.wave) + " · " + esc(rn.live.title) : "готовлю прогон…"}</span>` : ""}
      <button class="sm ${live(rn) || PENDING.has("accrun|") ? "busy" : ""}" data-act="accrun" ${A.runnable ? "" : "disabled"} title="Прогнать приёмку всех ждущих волн. Итог ляжет на пункты чек-листа как «авто ✓/✗» по меткам [iN]; вердикт — ваш">${live(rn) ? SPIN : "🤖"} Прогнать приёмку</button>${rn ? `<button class="sm ghost" data-act="log" data-id="${esc(rn.id)}" title="${esc(rn.summary)}">${rn.status === "ok" ? "✓" : rn.status === "fail" ? "✗" : "…"} ${fmt(rn.at)}</button>` : ""}</div></div>`;
    if (A.syncing)
        return syncing + pers;
    if (!ws.length)
        return head + pers + '<div class="sub" style="margin-top:8px">Волн, которые ждут приёмки, нет.</div>';
    const okN = ws.filter((w) => w.verdict === "accepted").length, badN = ws.filter((w) => w.verdict === "rejected").length;
    const sum = `<div class="sub" style="margin:6px 0">Волн: ${ws.length} · принято ${okN} · не принято ${badN} · без вердикта ${ws.length - okN - badN}</div>`;
    const multi = new Set(ws.map((w) => w.epic)).size > 1;
    let lastEp = null;
    return head + pers + sum + ws.map((w) => {
        const epHead = multi && w.epic !== lastEp ? `<div class="stt" style="margin:12px 0 2px;font-weight:600">📁 ${esc(w.epicTitle || w.epic || "")}${w.epic === S.activeEpic ? ' <span class="chip">эта вкладка</span>' : ""}</div>` : "";
        lastEp = w.epic;
        const items = w.items || [], done = items.filter((x) => x.state !== "todo").length, open = w.autoClosed ? ACC_FOLD.has(w.key) : !ACC_FOLD.has(w.key);
        const vchip = w.verdict === "accepted" ? `<span class="chip ok" ${w.autoClosed ? `title="${esc(w.autoClosed)}"` : ""}>${w.autoClosed ? "🤖 принято: без кода продукта" : "принято"}</span>` : w.verdict === "rejected" ? '<span class="chip fail">не принято</span>' : w.reopened ? `<span class="chip queued" title="${esc(accReopenText(w.reopened))}">на разборе: новый код</span>` : "";
        const sent = w.autoClosed ? "" : w.sentAt ? '<span class="chip">отправлено</span>' : w.verdict ? '<span class="chip queued">не отправлено</span>' : "";
        const rows = items.map((x) => {
            const h = accHref(x.where);
            return `<div class="acc-it ${x.state}"><div class="acc-btns"><button class="sm ${x.state === "ok" ? "good" : ""}" data-act="accitem" data-key="${esc(w.key)}" data-id="${x.id}" data-st="${x.state === "ok" ? "todo" : "ok"}" title="Работает">✓</button><button class="sm ${x.state === "bad" ? "badb" : ""}" data-act="accitem" data-key="${esc(w.key)}" data-id="${x.id}" data-st="${x.state === "bad" ? "todo" : "bad"}" title="Не работает">✗</button></div>
        <div class="acc-tx"><div><span class="accid" title="номер пункта чек-листа">${esc(x.id || "")}</span>${x.before && x.state !== "todo" ? `<span class="chip" title="Отмечено до влива ${esc(String(x.before).slice(0, 10))} с новым кодом продукта: проверьте заново и отметьте">до нового кода</span> ` : ""}${x.role ? `<span class="chip">${esc(x.role)}</span> ` : ""}${x.how ? `<span class="chip ${x.how === "auto" ? "queued" : ""}">${x.how === "auto" ? "авто" : "руками"}</span> ` : ""}${h ? `<a href="${esc(h)}" target="_blank" rel="noopener">${esc(x.where)}</a>` : esc(x.where)}</div><div>${esc(x.todo)}</div><div class="mute">→ ${esc(x.expect)}</div>${accAuto(x.auto, w, x)}
        <input type="text" class="acc-cm" data-acccm="${esc(w.key)}|${x.id}" value="${esc(x.comment || "")}" placeholder="комментарий"></div></div>`;
        }).join("");
        const auto = `${w.autoClosed ? `<div class="sub">🤖 ${esc(w.autoClosed)}</div>` : ""}${(w.specs || []).length ? `<div class="acc-auto"><span class="chip queued" title="${w.specsLocal ? "Спека взята из папки слота: в staging её ещё нет или в слоте она изменена позже. Прогон возьмёт её оттуда; чтобы она жила как регрессия — коммит и влив." : "Спека в staging"}">🤖 спека: ${esc(w.specs.join(", "))}${w.specsLocal ? " · из папки слота" : ""}</span>${w.autoRun ? `<span class="mute">прогон ${esc(w.autoRun.job)}</span>` : ""}${(() => {
            const rr = A.run;
            const on = rr && ["queued", "waiting", "running"].includes(rr.status) && (rr.waves || []).includes(w.key);
            return on ? `<span class="chip queued">${SPIN} идёт прогон ${esc(rr.id)}${rr.live && rr.live.wave && w.specs.some((f) => f.startsWith(rr.live.wave)) ? " · тест " + rr.live.n + "/" + rr.live.of : ""}</span>` : `<button class="sm" data-act="accrun" data-key="${esc(w.key)}" title="Прогнать спеку приёмки только этой волны">🤖 прогнать</button>`;
        })()}</div>` : ""}${!(w.specs || []).length && !w.autoClosed && (w.items || []).length ? `<div class="acc-auto"><span class="mute">спеки приёмки нет${w.specAskedAt ? " · заказана " + new Date(w.specAskedAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""}</span><button class="sm" data-act="accaskspec" data-key="${esc(w.key)}" title="Агент волны напишет спеку приёмки в своей ветке: тесты [iN] по пунктам этого чек-листа. После коммита и влива «🤖 прогнать» закроет «авто»-пункты">🧪 ${w.specAskedAt ? "заказать снова" : "заказать спеку"}</button></div>` : ""}${(w.autoStray || []).length ? `<div class="sub">Тесты спеки без пункта в чек-листе: ${w.autoStray.map((a) => (a.st === "ok" ? "✓ " : "✗ ") + esc(a.title)).join("; ")}</div>` : ""}`;
        const wait = w.asking ? `<div class="sub">${SPIN} агент составляет чек-лист…</div>` : !items.length ? `<div class="sub">${w.raw ? esc(w.raw).replace(/\n/g, "<br>") : "Чек-листа ещё нет."}</div><button class="sm" data-act="accaskone" data-key="${esc(w.key)}">📋 Спросить чек-лист</button>` : "";
        return epHead + `<div class="acc-w" data-acckey="${esc(w.key)}" style="--c:${w.color}">
      <div class="acc-wh" data-act="accfold" data-key="${esc(w.key)}"><span>${open ? "▾" : "▸"}</span><b>${w.emoji} ${esc(w.tag)} · ${esc(w.title)}</b><span class="sp"></span>${items.length ? `<span class="mute">${done}/${items.length}</span>` : ""}${vchip}${sent}</div>
      ${open ? `<div class="acc-wb">${w.reopened ? `<div class="sub">⚠ ${esc(accReopenText(w.reopened))}</div>` : ""}<div class="mute" style="font-size:11px">влив ${esc(w.mergeSha)}${w.merges > 1 ? " · вливов волны: " + w.merges + " (приёмка одна на волну)" : ""}${w.onStand ? " · на стенде" : " · ещё НЕ выкачено на стенд"}${w.archived ? " · слот в архиве" : ""}</div>${auto}${wait}${rows}
        <textarea class="acc-vc" data-accvc="${esc(w.key)}" rows="2" placeholder="Общий комментарий по волне">${esc(w.comment || "")}</textarea>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${items.length ? `<button class="sm" data-annot="checklist" data-tree="${esc(w.key)}" title="Разметить чек-лист по пунктам: замечания агенту волны одним сообщением">✎ Разметить</button>` : ""}<button class="sm ${w.verdict === "accepted" ? "good" : ""}" data-act="accverdict" data-key="${esc(w.key)}" data-v="accepted">✓ Принято</button><button class="sm ${w.verdict === "rejected" ? "badb" : ""}" data-act="accverdict" data-key="${esc(w.key)}" data-v="rejected">✗ Не принято</button>${items.length ? `<button class="sm ghost" data-act="accaskone" data-key="${esc(w.key)}" title="Спросить чек-лист заново (отметки сбросятся)">↻ чек-лист заново</button>` : ""}${w.sendNote ? `<span class="sub">${esc(w.sendNote)}</span>` : ""}</div></div>` : ""}
    </div>`;
    }).join("");
}

const accReopenText = (r) => r.why ? r.why + " — вердикт «принято» снят" : "После " + (r.prev === "accepted" ? "вердикта «принято»" : r.prev === "rejected" ? "вердикта «не принято»" : "отметок пунктов") + " влит новый код продукта (" + String(r.sha || "").slice(0, 10) + (r.n ? ", файлов " + r.n + ": " + (r.files || []).join(", ") : "") + ")" + (r.prev ? ": вердикт снят, волна на разборе" : "") + (r.marked ? "; отметки " + r.marked + " пункт(ов) — до этого кода" : "");

// Итог автоприёмки по пункту: метка [iN] в выводе команды приёмки → ✓/✗.
function accAuto(a, w, x) {
    const one = w && x && (w.specs || []).length ? `<button class="lnk" data-act="accrun1" data-key="${esc(w.key)}" data-id="${esc(x.id)}" title="Перепрогнать только этот пункт (${esc(x.id)}) — тест [${esc(x.id)}] спеки волны">↻ только ${esc(x.id)}</button>` : "";
    if (!a)
        return one && x.how === "auto" ? `<div class="acc-auto">${one}</div>` : "";
    const chip = a.st === "ok" ? '<span class="chip ok">авто ✓</span>' : a.st === "skip" ? '<span class="chip">авто: пропущен</span>' : a.st === "flaky" ? '<span class="chip queued">авто ✓ со второй попытки</span>' : '<span class="chip fail">авто ✗</span>';
    return `<div class="acc-auto">${chip}<span class="mute">${esc(a.job)}${a.ms ? " · " + (a.ms / 1000).toFixed(1) + " с" : ""}</span>${one}${a.err ? `<div class="err">${esc(a.err)}</div>` : ""}</div>`;
}


export function accJump(key) {
    const w = ((S.accept && S.accept.waves) || []).find((x) => x.key === key);
    if (w) {
        if (w.autoClosed)
            ACC_FOLD.add(key);
        else
            ACC_FOLD.delete(key);
        ls("dash.accfold", [...ACC_FOLD]);
    }
    renderSide();
    requestAnimationFrame(() => {
        const el = document.querySelector(`.acc-w[data-acckey="${CSS.escape(key)}"]`);
        if (!el)
            return;
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        el.classList.remove("accflash");
        void el.offsetWidth;
        el.classList.add("accflash");
    });
}

function orchBranchChip() {
    const t = (S.trees || []).find((x) => x.key === "orchestrator");
    if (!t || !t.exists)
        return "";
    const dirty = (t.dirtyTracked || 0) + (t.dirtyUntracked || 0);
    const tip = "Папка оркестратора: " + (t.path || "") + "\nВетка " + t.branch + (t.ahead ? " · своих коммитов впереди staging: " + t.ahead : "") + (t.behind ? " · отстаёт от staging на " + t.behind : " · на уровне staging") + (dirty ? "\nНезакоммичено: " + (t.dirtyTracked || 0) + " изменённых, " + (t.dirtyUntracked || 0) + " новых (планы волн)" : "");
    return `<span class="chip ${t.behind ? "queued" : ""}" style="font-weight:400;font-family:ui-monospace,monospace;font-size:11px" title="${esc(tip)}">⎇ ${esc(t.branch)}${dirty ? "*" : ""}${t.ahead || t.behind ? " ↑" + (t.ahead || 0) + " ↓" + (t.behind || 0) : ""}</span> `;
}

export const ACC_FOLD = new Set((() => {
    try {
        return JSON.parse(localStorage.getItem("dash.accfold") || "[]");
    }
    catch {
        return [];
    }
})());

// Разделы рейла: [id, значок, название, подсказка, модуль]. Раздел с модулем виден, только когда модуль включён.
export const RAIL = [
    ["orch", "💬", "Оркестратор", "чат эпика"],
    ["slots", "🌿", "Ветки", "все слоты по группам: сводка, следующий шаг, переход в фокус"],
    ["runs", "▶", "Запуски", "что идёт, ждёт, упало, и все запуски с фильтром"],
    ["review", "🔍", "Ревью", "вердикты ревьюера, конфликты, замечания к диффу", "review"],
    ["ship", "🚂", "Выкат", "поезд, staging ↔ remote, стенд и прод", "release"],
    ["health", "🩺", "Здоровье", "красное в самом staging, карантин, последние сверки"],
    ["accept", "✅", "Приёмка", "чек-листы волн на стенде: отметки, вердикты, итоги агентам", "accept"],
    ["modules", "🧩", "Модули", "что включено в этой установке и почему остальное выключено"],
];

/** Разделы рейла, видимые при нынешних модулях; «Модули» — всегда последним. */
export function railList() {
    const vis = RAIL.filter((x) => !x[4] || modOn(x[4]));
    return [...vis.filter((x) => x[0] !== "modules"), ...vis.filter((x) => x[0] === "modules")];
}

export const RAIL_PANELS = {};

export let RAILM = (() => {
    try {
        const m = localStorage.getItem("dash.rail");
        return RAIL.some((x) => x[0] === m) ? m : "orch";
    }
    catch {
        return "orch";
    }
})();

export function setRail(m) {
    if (RAILM === m && SIDEBAR && !document.body.classList.contains("pm")) {
        setSidebar(false);
        renderRail();
        return;
    }
    RAILM = m;
    ls("dash.rail", m);
    if (!SIDEBAR)
        setSidebar(true);
    renderRail();
    renderSide();
}

function railBadge(m) {
    if (RAIL_PANELS[m])
        return RAIL_PANELS[m].badge ? RAIL_PANELS[m].badge() : 0;
    if (m === "orch") {
        const a = (S.agents || {}).orchestrator || {};
        return (S.inbox || []).filter((x) => x.tree === "orchestrator" && x.kind === "ownerq").length + (a.pending ? 1 : 0);
    }
    if (m === "slots")
        return S.trees.filter((t) => t.kind !== "orch" && slotGroup(t) === "need").length;
    if (m === "runs")
        return failedUnresolved().filter((j) => !j.advice || !["wait", "busy", "agent", "inherited"].includes(j.advice.act)).length;
    if (m === "review")
        return S.trees.filter((t) => t.review && t.review.fresh && t.review.verdict && t.review.verdict !== "ЗА").length + Object.values(NOTES).reduce((a, n) => a + n.length, 0);
    if (m === "ship")
        return S.train && S.train.cur && S.train.cur.status === "green" ? 1 : 0;
    if (m === "health")
        return Object.keys(S.stagingRed || {}).length;
    if (m === "modules")
        return 0;
    if (m === "accept")
        return S.accept && S.accept.brief ? S.accept.waiting || 0 : ((S.accept && S.accept.waves) || []).filter((w) => !w.verdict && (w.items || []).length).length;
    return 0;
}

export function renderRail() {
    const el = $("rail");
    if (!el || !S)
        return;
    const html = railList().map(([m, ic, lab, hint], i) => {
        const b = railBadge(m);
        return `<button class="${RAILM === m && SIDEBAR ? "on" : ""}" data-act="rail" data-m="${m}" title="${esc(lab)}: ${esc(hint)} (клавиша ${i + 1})" aria-label="${esc(lab)}">${icon(m)}${b ? `<span class="rb">${b}</span>` : ""}</button>`;
    }).join("") + `<span class="rsp"></span>${railAgents()}<button data-act="keyhelp" title="Клавиши (?)" aria-label="Клавиши">${icon("keys")}</button>`;
    if (el.__h !== html) {
        el.__h = html;
        el.innerHTML = html;
    }
}

export const AGENT_WORD = { work: "работает", wait: "ждёт разрешения", warm: "на связи", drowsy: "давно без сообщений, процесс жив", sleep: "спит" };

function railAgents() {
    const list = S.trees.filter((t) => (t.kind === "orch" || t.kind === "slot") && !t.archived).map((t) => ({ t, st: agentState(t.key) })).filter((x) => x.st !== "off");
    if (!list.length)
        return "";
    return '<div class="agis">' + list.map(({ t, st }) => {
        const ag = S.agents[t.key] || {};
        return `<button class="cb ${st}" data-act="focuschat" data-tree="${esc(t.key)}" title="${esc(t.tag + " · " + t.title + "\n" + AGENT_WORD[st] + (ag.activity ? "\n" + ag.activity : ""))}" aria-label="${esc(t.tag + ": " + AGENT_WORD[st])}">${agentIcon(t.color, st, 17)}<span>${esc(t.kind === "orch" ? "ОРК" : t.tag)}</span></button>`;
    }).join("") + "</div>";
}

export function renderSide() {
    const side = $("side"), head = $("sidehead"), panel = $("sidepanel");
    if (!side || !S)
        return;
    if (!railList().some((x) => x[0] === RAILM))
        RAILM = "orch";
    const orch = RAILM === "orch";
    side.classList.toggle("mode-panel", !orch);
    const noEpic = !!(S.epics && !S.epics.some((e) => e.status !== "closed"));
    side.classList.toggle("noepic", orch && noEpic);
    const r = RAIL.find((x) => x[0] === RAILM) || RAIL[0];
    const hh = orch && noEpic ? `🟥 Оркестратор <span class="sub" style="font-weight:400">открытых эпиков нет — у нового эпика будет свой оркестратор («+ новый эпик» вверху)</span>`
        : orch && sideChatKey() !== "orchestrator" ? (() => {
            const t = S.trees.find((x) => x.key === sideChatKey());
            return `<span class="dotc" style="background:${esc(t.color || "var(--accent)")}"></span>${esc(t.tag)} · ${esc(t.title)}<span class="sub" style="font-weight:400">${esc(t.branch || "")}${t.wagon ? " · вагон " + esc(t.wagon) : ""}</span>`;
        })()
            : orch ? `🟥 Оркестратор ${orchBranchChip()}<span class="sub" style="font-weight:400">чат прямо здесь · папка эпика + staging для чтения</span>` : `<span class="shic">${icon(r[0])}</span>${esc(r[2])} <span class="sub" style="font-weight:400">${esc(r[3])}</span>`;
    if (head.__h !== hh) {
        head.__h = hh;
        head.innerHTML = hh;
    }
    if (orch)
        return;
    if (RAIL_PANELS[RAILM]) {
        RAIL_PANELS[RAILM].render(panel);
        return;
    }
    if (RAILM === "accept" && panel.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && document.activeElement.type !== "checkbox")
        return;
    setHTML(panel, RAILM === "slots" ? slotsPanel() : RAILM === "runs" ? runsPanel() : RAILM === "review" ? reviewPanel() : RAILM === "ship" ? shipPanel() : RAILM === "accept" ? acceptPanel() : RAILM === "modules" ? modulesPanel() : healthPanel());
}

function segBar(t) {
    const st = t.stages || [];
    if (!st.length)
        return "";
    const far = farOf(t), done = st.filter((x) => x.done).length;
    return '<div class="segbar" title="' + esc(st.map((x) => (x.done ? "✓ " : "· ") + x.label).join("\n")) + '">' + st.map((x, i) => '<i class="' + (x.done ? "d" : i === far + 1 ? "c" : "") + '" style="--c:' + t.color + '"></i>').join("") + '<span>' + done + "/" + st.length + (st[far + 1] ? " · " + esc(st[far + 1].label) : "") + "</span></div>";
}

function slotsPanel() {
    return GROUPS.map(([g, label]) => {
        const m = S.trees.filter((t) => t.kind !== "orch" && slotGroup(t) === g);
        if (!m.length)
            return "";
        return `<div class="grph">${label} <span class="chip">${m.length}</span></div>` + m.map((t) => {
            const n = t.exists ? nextStep(t) : { text: "папка слота готовится" };
            return `<div class="srow" data-act="slotgo" data-tree="${esc(t.key)}" title="Открыть в фокусе"><span class="dotc" style="--c:${t.color}"></span><div><div class="t">${t.emoji} ${esc(t.tag)} · ${esc(t.title)}</div>${segBar(t)}${t.summary && t.summary.text ? `<div class="d">📝 ${esc(t.summary.text)}</div>` : ""}<div class="d">→ ${esc(n.text || "")}</div>${extraChips(t) ? `<div class="chips" style="margin-top:3px">${extraChips(t)}</div>` : ""}</div><span></span></div>`;
        }).join("");
    }).join("");
}

function runsPanel() {
    const run = S.jobs.filter((j) => j.status === "running"), wait = S.jobs.filter((j) => j.status === "queued" || j.status === "waiting"), bad = failedUnresolved(), now = Date.now();
    const pend = pendingCards(run, wait), pendN = (pend.match(/class="tk run"/g) || []).length, done = S.jobs.filter((j) => j.status === "ok" && j.endedAt && now - j.endedAt < FLY_MS + 800);
    const sec = (title, n, body) => body ? `<div class="sp-h">${title} <span class="chip">${n}</span></div><div class="tklist">${body}</div>` : "";
    return sec("Требуют внимания", bad.length + (bad.length ? ` <button class="sm ghost" data-act="dismissall">убрать все</button>` : ""), bad.map((j) => taskCard(j, "bad")).join("")) +
        sec("Выполняются", run.length + pendN, pend + run.map((j) => taskCard(j, "run")).join("")) +
        sec("Ждут", wait.length, wait.map((j) => taskCard(j, "wait")).join("")) +
        sec("Только что завершились", done.length, done.map((j) => taskCard(j, "ok")).join("")) +
        `<div class="sp-h" style="margin-top:12px">Все запуски</div><div class="filters">${filters()}</div><div style="overflow:auto">${jobsTable()}</div>`;
}

function reviewPanel() {
    const ts = S.trees.filter((t) => t.kind === "slot" && t.exists && !t.readOnly && (t.ahead > 0 || t.review));
    if (!ts.length)
        return '<div class="calm">Здесь появятся ветки с коммитами.</div>';
    return '<div class="tklist">' + ts.map((t) => {
        const r = t.review, nn = (NOTES[t.key] || []).length;
        return `<div class="tk ${r && r.verdict === "ПРОТИВ" ? "bad" : r && r.verdict === "ЗА" && r.fresh ? "ok" : "go"}"><div class="tkh"><b><span class="dotc" style="--c:${t.color}"></span>${esc(t.tag)}</b><span class="chips">${extraChips(t)}</span></div><div class="tkt">${esc(t.title)}</div>${r && r.text ? `<pre class="sub" style="white-space:pre-wrap;font-size:11.5px;max-height:240px;overflow:auto;margin:6px 0">${esc(r.text)}</pre>` : '<div class="sub">Ревью ещё не было.</div>'}<div class="chips">${reviewBtn(t)}<button class="sm" data-act="changes" data-tree="${esc(t.key)}">Дифф${nn ? " · замечаний " + nn : ""}</button></div></div>`;
    }).join("") + "</div>";
}

function shipPanel() {
    const P = S.pipeline, sv = P.stagingVsOrigin || [0, 0], gates = gateTasks(), sec = lastJobOf("orchestrator-staging", gates), ot = S.trees.find((t) => t.kind === "orch"), ec = ot ? (ot.dirtyTracked || 0) + (ot.dirtyUntracked || 0) : 0;
    const up = esc(P.upStaging || "remote"), upM = esc(P.upMain || "remote"), main = hasMain();
    const row = (c) => `<div class="cmrow"><span class="mono">${esc(c.sha)}</span><span class="d">${esc(c.subject)}</span><span class="mute">${esc(c.when)}</span></div>`;
    const chips = (sv[1] ? `<span class="chip queued">не запушено: ${sv[1]}</span>` : "") + (sv[0] ? `<span class="chip queued">${up} впереди: ${sv[0]}</span>` : "") + (!sv[0] && !sv[1] ? `<span class="chip ok">совпадает с ${up}</span>` : "") + (!main || P.invariantOk ? "" : '<span class="chip fail">main не предок staging</span>');
    const top = (trainCard() || trainStatusCard()) + stgCards();
    return (top ? `<div class="tklist">${top}</div>` : "") +
        `<div class="sp-sec"><div class="sp-h">${esc(branchLabel("staging"))} <span class="mono mute" style="font-weight:400">@ ${esc(P.staging)}</span></div><div class="chips">${chips}</div>
      ${gates.length ? `<div class="kv"><span>гарды на staging</span><span ${sec ? `data-act="log" data-id="${sec.id}" style="cursor:pointer"` : ""}>${chipOf(sec, "stg-sec")}</span><button class="sm" data-act="stg-sec" title="Задачи-гейты проекта на самом staging">▶</button></div>` : ""}
      <div class="chips"><button class="sm primary" data-act="pl" data-action="deploy-staging">Выкатить стенд…</button>${S.jobs.some((x) => x.task === "deploy-staging") ? `<button class="sm" data-act="standfx" title="Станции выката и паровоз с волнами">🚂 Экран выката</button>` : ""}${ot ? `<button class="sm" data-act="changes" data-tree="${esc(ot.key)}" title="Планы в папке эпика">Изменения эпика${ec ? ` <span class="chip queued">${ec}</span>` : ""}</button>` : ""}</div>
      <div class="sub">Стенд принимаете вы${main ? "; без приёмки выкат в прод не нужен" : ""}.</div></div>
    ${main ? `<div class="sp-sec"><div class="sp-h">${esc(branchLabel("main"))} · прод <span class="mono mute" style="font-weight:400">@ ${esc(P.main)}</span></div><div class="chips">${P.mainVsOrigin && P.mainVsOrigin[0] ? `<span class="chip queued">${upM} впереди: ${P.mainVsOrigin[0]} (возможен hotfix)</span>` : `<span class="chip ok">совпадает с ${upM}</span>`}</div><div class="sub">последнее: ${esc(((P.lastMain || [])[0] || {}).subject || "")} · ${esc(((P.lastMain || [])[0] || {}).when || "")}</div></div>
    <div class="sp-sec"><div class="sp-h">В прод <span class="chip">${P.unreleased}</span></div>${(P.cars || []).map(row).join("") || '<div class="sub">Пусто: staging совпадает с main.</div>'}
      <div class="chips"><button class="sm danger" data-act="pl" data-action="release" ${P.unreleased ? "" : "disabled"}>Выкат в прод…</button></div>
      ${P.pushDeploys ? `<div class="sub">Пуш в ${upM} сам выкатывает прод.</div>` : ""}
      <details><summary class="sub" style="cursor:pointer">Последнее в проде</summary>${(P.lastMain || []).map(row).join("")}</details></div>` : '<div class="sp-sec"><div class="sub">Отдельной прод-ветки у проекта нет: выкат в прод не ведётся.</div></div>'}`;
}

// Модули установки: включается конфигом, со страницы не переключается.
function modulesPanel() {
    const list = Array.isArray(S.modules) ? S.modules : [];
    if (!list.length)
        return '<div class="calm">Сервер не прислал список модулей.</div>';
    const rows = list.map((m) => `<div class="tk ${m.on ? "ok" : ""}"><div class="tkh"><b>${esc(m.title || m.id)}</b> <span class="mono mute">${esc(m.id)}</span><span class="sp"></span><span class="chip ${m.on ? "ok" : ""}">${m.on ? "включён" : "выключен"}</span></div><div class="tkt">${esc(m.about || "")}</div>${!m.on && m.why ? `<div class="sub" style="font-size:11.5px">Почему выключен: ${esc(m.why)}</div>` : ""}</div>`).join("");
    return `<div class="sub" style="margin-bottom:8px">Включить или выключить модуль — ключ <code>modules</code> в dispatcher.project.json и <code>node setup.mjs doctor</code>. Со страницы модули не переключаются.</div><div class="tklist">${rows}</div>`;
}

function healthPanel() {
    const red = Object.entries(S.stagingRed || {}), fl = S.flaky || [], base = S.jobs.filter((j) => j.tree === "orchestrator-staging" && (j.baseline || j.train)).slice(-8).reverse();
    return `<div class="sp-h">Красное в самом staging <span class="chip ${red.length ? "fail" : "ok"}">${red.length}</span></div>${red.map(([f, e]) => `<div class="srow" data-act="log" data-id="${esc(e.jobId)}"><span>✗</span><div class="d mono">${esc(f)}</div><span class="mute">${esc(e.jobId)}</span></div>`).join("") || '<div class="sub">Нет.</div>'}
    <div class="sp-h" style="margin-top:12px">Карантин <span class="chip">${fl.length}</span></div>${flakyCards() || '<div class="sub">Нестабильных спек нет: то, что падает в staging, падает стабильно.</div>'}
    <div class="sp-h" style="margin-top:12px">Последние сверки и поезда</div>${base.map((j) => `<div class="srow" data-act="log" data-id="${j.id}"><span>${j.status === "ok" ? "✓" : j.status === "fail" ? "✗" : "⏳"}</span><div><div class="t">${esc(j.label)}</div><div class="d">${esc((j.input || "").slice(0, 90))}</div></div><span class="mute">${j.id}</span></div>`).join("") || '<div class="sub">Нет.</div>'}`;
}

const KEYS = [["n", "к следующей ветке, где нужен ты"], ["j / k", "следующая / предыдущая ветка"], ["o, Enter", "раскрыть или свернуть ветку"], ["f", "фокус на ветке; Esc — назад ко всем"], ["c", "чат агента ветки"], ["d", "дифф ветки (клик по строке — замечание агенту)"], ["t", "тесты волны"], ["g", "гарды"], ["r", "регресс"], ["v", "ревью"], ["m", "влить в staging…"], ["a", "в архив (влитая ветка)"], ["1–9", "разделы левой колонки по порядку в рейле"], ["?", "эта подсказка"]];

export function openKeyHelp() {
    $("mb").innerHTML = `<h3>Клавиши</h3><div id="keyhelp"><table>${KEYS.map(([k, d]) => `<tr><td>${k.split(/(, | \/ |–)/).map((x) => /^(, | \/ |–)$/.test(x) ? esc(x) : `<kbd>${esc(x)}</kbd>`).join("")}</td><td>${esc(d)}</td></tr>`).join("")}</table></div><div class="sub">Работают, когда курсор не в поле ввода.</div><div style="display:flex;justify-content:flex-end"><button class="primary" data-act="mclose">Понятно</button></div>`;
    $("modal").classList.add("on");
}

export function actBtn(act, tree) {
    const b = document.createElement("button");
    b.dataset.act = act;
    b.dataset.tree = tree;
    b.style.display = "none";
    document.body.appendChild(b);
    b.click();
    b.remove();
}

function filters() {
    const items = [["all", "Все", ""], ...S.trees.filter((t) => t.exists).map((t) => [t.key, `${t.emoji} ${t.tag}`, t.color]), ["orchestrator-staging", "staging", ""], ...(hasMain() ? [["orchestrator-main", "main", ""]] : [])];
    return items.map(([k, l]) => `<button class="sm ${FILTER === k ? "on" : ""}" data-act="filter" data-k="${esc(k)}">${esc(l)}</button>`).join("");
}

function jobsTable() {
    const rows = [...S.jobs].reverse().filter((j) => FILTER === "all" || j.tree === FILTER).slice(0, 30).map((j) => {
        const t = treeOf(j.tree);
        const who = t ? `<span class="dotc" style="--c:${t.color}"></span>${esc(t.tag)}` : j.tree === "orchestrator-staging" ? "staging" : j.tree === "orchestrator-main" ? "main" : esc(j.tree);
        const ctl = (j.status === "waiting" ? `<button class="sm" data-act="force" data-id="${j.id}">всё равно</button> ` : "") + (["queued", "running", "waiting"].includes(j.status) ? `<button class="sm ghost" data-act="cancel" data-id="${j.id}">стоп</button>` : "") + (["fail", "interrupted"].includes(j.status) ? `<button class="sm" data-act="report" data-id="${j.id}" title="Отправить причину падения агенту этой ветки">→ агенту</button> ` : "") + (["ok", "fail", "interrupted"].includes(j.status) ? `<button class="sm ghost" data-act="copy" data-id="${j.id}" title="скопировать итог и хвост лога, чтобы вставить агенту">📋</button>` : "");
        return `<tr class="j" data-act="log" data-id="${j.id}"><td class="mono mute">${j.id}<div class="jwhen" title="начало прогона">${runWhen(j)}</div></td><td>${who}</td><td>${esc(j.label)}${j.input ? ` <span class="mono mute">${esc(j.input)}</span>` : ""}</td><td>${chipOf(j)}</td><td class="mute">${dur(j)}${j.peakMB ? `<div style="font-size:11px">пик ${j.peakMB} МБ</div>` : ""}</td><td class="sum" title="${esc(j.waitReason || j.summary || "")}">${esc(j.waitReason || j.summary || "")}</td><td style="text-align:right;white-space:nowrap">${ctl}</td></tr>`;
    }).join("");
    return rows ? `<table><thead><tr><th>#</th><th>слот</th><th>что</th><th>итог</th><th>время</th><th>выжимка</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="sub">Запусков нет.</div>';
}

export const PM_Q = matchMedia("(max-width:1199px), (pointer:coarse)");

let PV = (() => {
    try {
        return localStorage.getItem("dash.pv") || "lines";
    }
    catch {
        return "lines";
    }
})();

export function setPv(v) {
    PV = v;
    document.body.dataset.pv = v;
    try {
        localStorage.setItem("dash.pv", v);
    }
    catch { }
    for (const b of document.querySelectorAll("#bnav button"))
        b.classList.toggle("on", b.dataset.pv === v);
    if (v === "orch") {
        RAILM = "orch";
        if (!SIDEBAR)
            setSidebar(true);
    }
    if (v === "runs") {
        RAILM = "runs";
        if (!SIDEBAR)
            setSidebar(true);
    }
    if (S) {
        renderRail();
        renderSide();
    }
    pageScrollTop();
}

export function applyPm() {
    const on = PM_Q.matches;
    document.body.classList.toggle("pm", on);
    if (on)
        setPv(PV);
}

export function bnavBadges() {
    if (!document.body.classList.contains("pm") || !S || !S.jobs)
        return;
    const set = (id, n, cls) => {
        const el = $(id);
        if (!el)
            return;
        el.hidden = !n;
        el.textContent = n > 99 ? "99+" : n;
        el.className = "bd " + (cls || "");
    };
    const run = S.jobs.filter((j) => ["running", "queued", "waiting"].includes(j.status)).length, fail = failedUnresolved().length, you = (S.inbox || []).length;
    set("bd-tasks", fail || you || run, fail ? "bad" : you ? "warn" : "");
    const att = document.querySelectorAll("#att > .it").length;
    set("bd-lines", att, "warn");
}
