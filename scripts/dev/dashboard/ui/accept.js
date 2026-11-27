// ui/accept.js — колонка «Приёмка»: чек-листы волн на стенде, отметки, вердикты (вынесено из ui/side.js).
// Колонка на десятки волн была экранами развёрнутых карточек — кейсы приёмки долго искать. Теперь: инструменты — строками сверху;
// липкая панель фильтров (Все / Ждут меня / Красные / Только ручные / Только авто / Принятые), поиск по номеру и тексту пункта,
// вид «этот эпик / все эпики» и группы по поезду или эпику; волны свёрнуты одной строкой со счётчиками и вердиктом (вердикт —
// из строки, если авто зелёные); в раскрытой волне ручные пункты первыми, авто — свёрнутой строкой; комментарий — по клику;
// волны без чек-листа — отдельной свёрнутой группой. Несколько эпиков: метки слотов П1/П2 не уникальны — волна подписана номером
// WV и метка показана вторично, группы и ключи — по эпику и ключу дерева. Правила — ui/accept-view.js.
import { PENDING, S } from "./state.js";
import { esc, ls, SPIN } from "./core.js";
import { loadAccept, treeOf } from "./data.js";
import { renderSide } from "./side.js";
import { FILTERS, acceptTotals, acceptView, itemShown, isManual, quickVerdict, waveNo } from "./accept-view.js";

// Адрес стенда — из конфига приёмки (accept.standUrl); путь в пункте чек-листа открывается на нём.
const standBase = () => String((S && S.accept && S.accept.standUrl) || "").replace(/\/+$/, "");
const accHref = (w) => {
    const m = /(https?:\/\/\S+|\/[\w\-./:?=&%#]+)/.exec(w || "");
    return m ? (m[1].startsWith("/") ? (standBase() ? standBase() + m[1] : "") : m[1]) : "";
};
const fmt = (t) => (t ? new Date(t).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const live = (j) => j && ["queued", "waiting", "running"].includes(j.status);

// Что раскрыто — помнится в браузере: ключ волны, «ключ|auto» (авто-пункты волны), «__empty» (волны без чек-листа). По умолчанию свёрнуто.
export const ACC_OPEN = new Set(
    (() => {
        try {
            return JSON.parse(localStorage.getItem("dash.accopen") || "[]");
        } catch {
            return [];
        }
    })(),
);
const saveOpen = () => ls("dash.accopen", [...ACC_OPEN].slice(-300));
// фильтр, поиск, группировка и вид («этот эпик» — только волны эпика вкладки, «все эпики» — сгруппировано по эпику)
export const ACCF = (() => {
    const d = { mode: "all", q: "", group: "train", scope: "epic" };
    try {
        return { ...d, ...JSON.parse(localStorage.getItem("dash.accf") || "{}") };
    } catch {
        return d;
    }
})();
const saveF = () => ls("dash.accf", ACCF);
const CM_OPEN = new Set(); // поля комментария, открытые кликом (до перезагрузки)
// Поезд волны-вагона: ключ дерева поезда — часть ключа до «#». Волна слота — без поезда (null).
const trainOf = (w) => {
    const k = String(w.key || "");
    if (!k.includes("#")) return null;
    const tk = k.split("#")[0], t = treeOf(tk);
    return { key: tk, tag: (t && t.tag) || "", title: (t && t.title) || "", color: (t && t.color) || w.color };
};
const viewOpts = () => ({ mode: ACCF.mode, q: ACCF.q, group: ACCF.group, scope: ACCF.scope, epic: S.activeEpic || "", trainOf });
const accReopenText = (r) =>
    r.why
        ? r.why + " — вердикт «принято» снят"
        : "После " +
          (r.prev === "accepted" ? "вердикта «принято»" : r.prev === "rejected" ? "вердикта «не принято»" : "отметок пунктов") +
          " влит новый код продукта (" +
          String(r.sha || "").slice(0, 10) +
          (r.n ? ", файлов " + r.n + ": " + (r.files || []).join(", ") : "") +
          ")" +
          (r.prev ? ": вердикт снят, волна на разборе" : "") +
          (r.marked ? "; отметки " + r.marked + " пункт(ов) — до этого кода" : "");
// название без повтора номера: «WV-9001 Оракул…» → «Оракул…» (номер уже в строке)
const shortTitle = (w) => {
    const n = waveNo(w), t = String(w.title || "");
    return (n && t.toUpperCase().startsWith(n) ? t.slice(n.length).replace(/^[\s:·—-]+/, "") : t) || t;
};
// подпись волны: номер WV (уникален между эпиками), если его нет — метка слота
const waveLabel = (w) => waveNo(w) || w.tag || w.key;

// ── инструменты приёмки: строки со статусом и кнопками ──
function toolsHTML(A) {
    const st = A.stand, sm = A.shard, rn = A.run;
    const stand = `<div class="acc-tl"><b>🖥 Стенд</b><span class="sub" title="${esc(st ? "выкат " + st.job : "")}">${st ? "выкачен " + fmt(st.at) : "не выкатывали из дашборда"}${sm ? " · полный прогон: " + (sm.status === "done" && !sm.fail && !sm.notrun ? "✓ зелёный" : sm.status === "running" ? "идёт" : "✗ " + sm.fail + " красных") : ""}</span><span class="sp"></span>
    <button class="sm ${PENDING.has("accask") ? "busy" : ""}" data-act="accask" title="Попросить чек-листы у агентов всех волн, у которых его ещё нет. После выката на стенд это происходит само">${PENDING.has("accask") ? SPIN : "📋"} Опросить</button><button class="sm ${PENDING.has("accspecall") ? "busy" : ""}" data-act="accspecall" title="Всем волнам, которые ждут вердикта и у которых есть чек-лист: агент волны заново пишет спеку приёмки. Ветки без своих коммитов перематываются на staging">🧪 Спеки всем</button><button class="sm ${PENDING.has("accsend") ? "busy" : ""}" data-act="accsend" title="Отправить вердикты: «не принято» — агенту его пункты на доделку, «принято» — короткое подтверждение; оркестратору — сводка">${PENDING.has("accsend") ? SPIN : "📨"} Итоги</button></div>`;
    const auto = `<div class="acc-tl"><b>🤖 Автоприёмка</b><span class="sub" title="${esc(A.runnable ? "команда приёмки из конфига" + (A.specGlob ? " · спеки " + A.specGlob : "") + (A.standUrl ? " · против " + A.standUrl : "") : "команда приёмки не задана (accept.run) — пункты проверяются руками")}">${live(rn) ? SPIN + " " + (rn.live ? "тест " + rn.live.n + " из " + rn.live.of + " · " + esc(rn.live.wave || "") + (rn.live.title ? " · " + esc(rn.live.title) : "") : "готовлю прогон…") : A.runnable ? "команда из конфига" + (A.standUrl ? " · " + esc(A.standUrl) : "") : "команда не задана (accept.run)"}</span><span class="sp"></span>
    <button class="sm ${live(rn) || PENDING.has("accrun|") ? "busy" : ""}" data-act="accrun" ${A.runnable ? "" : "disabled"} title="Прогнать приёмку всех ждущих волн. Итог ляжет на пункты чек-листа как «авто ✓/✗» по меткам [iN]; вердикт — ваш">${live(rn) ? SPIN : "🤖"} Прогнать</button>${rn ? `<button class="sm ghost" data-act="log" data-id="${esc(rn.id)}" title="${esc(rn.summary || "")}">${rn.status === "ok" ? "✓" : rn.status === "fail" ? "✗" : "…"} ${fmt(rn.at)}</button>` : ""}</div>`;
    return `<div class="acc-tools">${stand}${auto}</div>`;
}

// ── липкая панель: фильтр, поиск, вид эпиков, группировка ──
function barHTML(ws) {
    const o = viewOpts(), T = acceptTotals(ws, { scope: o.scope, epic: o.epic }), n = { all: T.waves - T.empty, me: T.need, red: T.red, accepted: T.accepted };
    const epics = new Set(ws.map((w) => w.epic || "")).size, other = ws.filter((w) => o.epic && w.epic !== o.epic).length;
    const scope =
        epics > 1 || other
            ? `<span class="seg acc-gr"><button class="${ACCF.scope === "epic" ? "on" : ""}" data-act="accscope" data-s="epic" title="Только волны эпика этой вкладки">этот эпик</button><button class="${ACCF.scope === "all" ? "on" : ""}" data-act="accscope" data-s="all" title="Волны всех эпиков — сгруппированы по эпику">все эпики${other && ACCF.scope === "epic" ? " +" + other : ""}</button></span>`
            : "";
    return `<div class="acc-bar"><div class="acc-fs">${FILTERS.map(([m, l]) => `<button class="sm ${ACCF.mode === m ? "on" : ""}" data-act="accf" data-m="${m}">${esc(l)}${n[m] != null ? ` <i>${n[m]}</i>` : ""}</button>`).join("")}</div>
    <div class="acc-sr"><input type="search" data-accq placeholder="Поиск: номер волны или текст пункта" value="${esc(ACCF.q)}" spellcheck="false">${scope}<span class="seg acc-gr"><button class="${ACCF.group === "train" ? "on" : ""}" data-act="accgroup" data-g="train" title="Группы по поездам внутри эпика">поезда</button><button class="${ACCF.group === "epic" ? "on" : ""}" data-act="accgroup" data-g="epic" title="Группы по эпикам">эпики</button></span>${[...ACC_OPEN].some((k) => !k.startsWith("__")) ? `<button class="sm ghost" data-act="accall" title="Свернуть все волны">свернуть</button>` : ""}</div></div>`;
}

// Итог автоприёмки по пункту: метка [iN] в выводе команды приёмки → ✓/✗.
function accAuto(a, w, x) {
    const one = w && x && (w.specs || []).length ? `<button class="lnk" data-act="accrun1" data-key="${esc(w.key)}" data-id="${esc(x.id)}" title="Перепрогнать только этот пункт (${esc(x.id)}) — тест [${esc(x.id)}] спеки волны">↻ ${esc(x.id)}</button>` : "";
    if (!a) return one && x.how === "auto" ? `<div class="acc-auto">${one}</div>` : "";
    const chip = a.st === "ok" ? '<span class="chip ok">авто ✓</span>' : a.st === "skip" ? '<span class="chip">авто: пропущен</span>' : a.st === "flaky" ? '<span class="chip queued" title="со второй попытки">авто ✓²</span>' : '<span class="chip fail">авто ✗</span>';
    return `<div class="acc-auto">${chip}<span class="mute">${esc(a.job || "")}${a.ms ? " · " + (a.ms / 1000).toFixed(1) + " с" : ""}</span>${one}${a.err ? `<div class="err">${esc(a.err)}</div>` : ""}</div>`;
}
function itemHTML(w, x) {
    const h = accHref(x.where), ck = w.key + "|" + x.id, cmOpen = !!x.comment || CM_OPEN.has(ck);
    const where = h ? `<a href="${esc(h)}" target="_blank" rel="noopener">${esc(x.where)}</a>` : esc(x.where || "");
    return `<div class="acc-it ${x.state}"><div class="acc-btns"><button class="sm ${x.state === "ok" ? "good" : ""}" data-act="accitem" data-key="${esc(w.key)}" data-id="${x.id}" data-st="${x.state === "ok" ? "todo" : "ok"}" title="Работает">✓</button><button class="sm ${x.state === "bad" ? "badb" : ""}" data-act="accitem" data-key="${esc(w.key)}" data-id="${x.id}" data-st="${x.state === "bad" ? "todo" : "bad"}" title="Не работает">✗</button></div>
    <div class="acc-tx"><div class="acc-ih"><span class="accid" title="номер пункта чек-листа">${esc(x.id || "")}</span>${x.before && x.state !== "todo" ? `<span class="chip" title="Отмечено до влива ${esc(String(x.before).slice(0, 10))} с новым кодом продукта: проверьте заново и отметьте">до нового кода</span>` : ""}${x.role ? `<span class="chip">${esc(x.role)}</span>` : ""}<span class="acc-wh2">${where}</span>${cmOpen ? "" : `<button class="lnk acc-cmb" data-act="acccmo" data-k="${esc(ck)}" title="Комментарий к пункту">💬</button>`}</div>
      <div>${esc(x.todo || "")}</div><div class="mute">→ ${esc(x.expect || "")}</div>${accAuto(x.auto, w, x)}
      ${cmOpen ? `<input type="text" class="acc-cm" data-acccm="${esc(ck)}" value="${esc(x.comment || "")}" placeholder="комментарий">` : ""}</div></div>`;
}
function waveBody(A, w, c) {
    const items = w.items || [], mode = ACCF.mode, rr = A.run, running = rr && live(rr) && (rr.waves || []).includes(w.key);
    const spec = (w.specs || []).length
        ? `<div class="acc-auto"><span class="chip queued" title="${w.specsLocal ? "Спека взята из папки слота: в staging её ещё нет или в слоте она изменена позже. Прогон возьмёт её оттуда; чтобы она жила как регрессия — коммит и влив." : "Спека в staging"}">🤖 ${esc(w.specs.join(", "))}${w.specsLocal ? " · из папки слота" : ""}</span>${w.autoRun ? `<span class="mute">прогон ${esc(w.autoRun.job || "")}</span>` : ""}${running ? `<span class="chip queued">${SPIN} идёт прогон ${esc(rr.id)}${rr.live && rr.live.n ? " · тест " + rr.live.n + "/" + rr.live.of : ""}</span>` : `<button class="sm" data-act="accrun" data-key="${esc(w.key)}" title="Прогнать спеку приёмки только этой волны">🤖 прогнать</button>`}</div>`
        : !w.autoClosed && items.length
          ? `<div class="acc-auto"><span class="mute">спеки приёмки нет${w.specAskedAt ? " · заказана " + fmt(w.specAskedAt) : ""}</span><button class="sm" data-act="accaskspec" data-key="${esc(w.key)}" title="Агент волны напишет спеку приёмки в своей ветке: тесты [iN] по пунктам этого чек-листа. После коммита и влива «🤖 прогнать» закроет «авто»-пункты">🧪 ${w.specAskedAt ? "заказать снова" : "заказать спеку"}</button></div>`
          : "";
    const stray = (w.autoStray || []).length ? `<div class="sub">Тесты спеки без пункта в чек-листе: ${w.autoStray.map((a) => (a.st === "ok" ? "✓ " : "✗ ") + esc(a.title)).join("; ")}</div>` : "";
    const wait = w.asking ? `<div class="sub">${SPIN} агент составляет чек-лист…</div>` : "";
    const man = items.filter(isManual).filter((x) => itemShown(x, mode)), au = items.filter((x) => !isManual(x)).filter((x) => itemShown(x, mode));
    // авто-пункты — свёрнутой строкой; есть красные — раскрыты, пока их не свернули (ключ «|auto» переключает от умолчания)
    const autoOpen = ACC_OPEN.has(w.key + "|auto") !== c.autoBad > 0;
    const autoLine = au.length ? `<button class="acc-al ${c.autoBad ? "bad" : c.autoNone ? "" : "ok"}" data-act="accopenk" data-k="${esc(w.key + "|auto")}" title="Пункты, которые проверяет спека приёмки">${autoOpen ? "▾" : "▸"} 🤖 авто ✓ ${c.autoOk} · ✗ ${c.autoBad}${c.autoNone ? " · не проверено " + c.autoNone : ""}</button>${autoOpen ? au.map((x) => itemHTML(w, x)).join("") : ""}` : "";
    const vcOpen = !!w.comment || CM_OPEN.has(w.key + "|__vc");
    return `<div class="acc-wb">${w.reopened ? `<div class="sub">⚠ ${esc(accReopenText(w.reopened))}</div>` : ""}<div class="mute" style="font-size:11px">${esc(w.epicTitle || w.epic || "")}${w.tag ? " · " + esc(w.tag) : ""} · влив ${esc(w.mergeSha || "")}${w.merges > 1 ? " · вливов волны: " + w.merges + " (приёмка одна на волну)" : ""}${w.onStand ? " · на стенде" : " · ещё НЕ выкачено на стенд"}${w.archived ? " · слот в архиве" : ""}${w.gotAt ? " · чек-лист " + fmt(w.gotAt) : ""}</div>
    ${w.autoClosed ? `<div class="sub">🤖 ${esc(w.autoClosed)}</div>` : ""}${spec}${stray}${wait}
    ${man.length ? `<div class="acc-sec">✋ Ручные · ${c.manualDone}/${c.manual} отмечено</div>` + man.map((x) => itemHTML(w, x)).join("") : ""}${autoLine}
    ${vcOpen ? `<textarea class="acc-vc" data-accvc="${esc(w.key)}" rows="2" placeholder="Общий комментарий по волне">${esc(w.comment || "")}</textarea>` : ""}
    <div class="acc-acts">${items.length ? `<button class="sm" data-annot="checklist" data-tree="${esc(w.key)}" title="Разметить чек-лист по пунктам: замечания агенту волны одним сообщением">✎ Разметить</button>` : ""}<button class="sm ${w.verdict === "accepted" ? "good" : ""}" data-act="accverdict" data-key="${esc(w.key)}" data-v="accepted">✓ Принято</button><button class="sm ${w.verdict === "rejected" ? "badb" : ""}" data-act="accverdict" data-key="${esc(w.key)}" data-v="rejected">✗ Не принято</button>${vcOpen ? "" : `<button class="sm ghost" data-act="acccmo" data-k="${esc(w.key + "|__vc")}" title="Общий комментарий по волне">💬</button>`}${items.length ? `<button class="sm ghost" data-act="accaskone" data-key="${esc(w.key)}" title="Спросить чек-лист заново (отметки сбросятся)">↻ чек-лист заново</button>` : ""}${w.sendNote ? `<span class="sub">${esc(w.sendNote)}</span>` : ""}</div></div>`;
}
function waveHTML(A, w, c) {
    const open = ACC_OPEN.has(w.key);
    const vchip = w.verdict === "accepted" ? `<span class="chip ok" ${w.autoClosed ? `title="${esc(w.autoClosed)}"` : ""}>${w.autoClosed ? "🤖 принято" : "принято"}</span>` : w.verdict === "rejected" ? '<span class="chip fail">не принято</span>' : w.reopened ? `<span class="chip queued" title="${esc(accReopenText(w.reopened))}">на разборе</span>` : "";
    const sent = w.autoClosed ? "" : w.sentAt ? '<span class="chip" title="итог отправлен агенту">📨</span>' : w.verdict ? '<span class="chip queued" title="итог ещё не отправлен агенту — «Итоги» сверху">не отправлено</span>' : "";
    const auto = c.auto ? `<span class="acc-c ${c.autoBad ? "bad" : c.autoNone ? "" : "ok"}" title="авто-пункты: ✓ зелёных, ✗ красных, не проверено">🤖 ✓${c.autoOk}${c.autoBad ? " ✗" + c.autoBad : ""}${c.autoNone ? " ·" + c.autoNone : ""}</span>` : "";
    const man = c.manual ? `<span class="acc-c ${c.manualDone === c.manual ? "ok" : "todo"}" title="ручных пунктов: отмечено / всего">✋ ${c.manualDone}/${c.manual}</span>` : "";
    // вердикт прямо из строки, когда раскрывать незачем: красного нет, авто зелёные (ручные владелец смотрит на стенде сам)
    const quick = !w.verdict && quickVerdict(w, c) ? `<span class="acc-q"><button class="sm" data-act="accverdict" data-key="${esc(w.key)}" data-v="accepted" title="Принять волну (авто зелёные${c.manual ? ", ручные " + c.manualDone + "/" + c.manual : ""})">✓</button><button class="sm" data-act="accverdict" data-key="${esc(w.key)}" data-v="rejected" title="Не принять волну">✗</button></span>` : "";
    const tag = waveNo(w) && w.tag ? `<span class="chip" title="метка слота в эпике «${esc(w.epicTitle || w.epic || "")}»">${esc(w.tag)}</span>` : "";
    return `<div class="acc-w ${open ? "open" : ""}" data-acckey="${esc(w.key)}" style="--c:${esc(w.color || "var(--line)")}">
    <div class="acc-wh" data-act="accfold" data-key="${esc(w.key)}"><span class="acc-car">${open ? "▾" : "▸"}</span><b class="acc-n">${w.emoji ? esc(w.emoji) + " " : ""}${esc(waveLabel(w))}</b>${tag}<span class="acc-t" title="${esc(w.title || "")}">${esc(shortTitle(w))}</span><span class="sp"></span>${auto}${man}${w.onStand ? "" : '<span class="chip queued" title="ещё не выкачено на стенд">не на стенде</span>'}${vchip}${sent}${quick}</div>
    ${open ? waveBody(A, w, c) : ""}</div>`;
}
function emptyHTML(list) {
    if (!list.length) return "";
    const open = ACC_OPEN.has("__empty");
    return (
        `<div class="acc-g acc-ge"><button class="lnk acc-tg" data-act="accopenk" data-k="__empty">${open ? "▾" : "▸"} <b>Без чек-листа</b></button><span class="sub">${list.length}</span></div>` +
        (open
            ? list
                  .map(({ w }) => `<div class="acc-er" style="--c:${esc(w.color || "var(--line)")}"><b class="acc-n">${esc(waveLabel(w))}</b><span class="acc-t">${esc((w.epicTitle ? w.epicTitle + " · " : "") + shortTitle(w))}</span><span class="sp"></span>${w.asking ? `<span class="sub">${SPIN} составляет…</span>` : `<button class="sm" data-act="accaskone" data-key="${esc(w.key)}">📋 Спросить</button>`}</div>`)
                  .join("")
            : "")
    );
}
/** Список волн (без шапки и панели): его же перерисовывает поиск, не трогая поле ввода. */
export function accListHTML() {
    const A = S.accept || {}, ws = A.waves || [];
    const v = acceptView(ws, viewOpts());
    // заголовки: несколько эпиков — заголовок эпика над его группами; поезда внутри — подзаголовками
    let lastEpic = null;
    const body = v.groups
        .map((g) => {
            const epHead = v.epics > 1 && g.epic !== lastEpic ? `<div class="acc-g ep"><b>📁 ${esc((g.waves[0] && (g.waves[0].w.epicTitle || g.waves[0].w.epic)) || "без эпика")}</b>${g.epic === (S.activeEpic || "") ? '<span class="chip">эта вкладка</span>' : ""}</div>` : "";
            lastEpic = g.epic;
            // подзаголовок — у поезда (его метка и название; эпик уже в заголовке выше); волны слотов эпика — без подзаголовка
            const tr = g.train ? trainOf(g.waves[0].w) : null;
            const sub = tr ? `<div class="acc-g" style="--c:${esc(g.color || "var(--line)")}"><span class="dotc" style="background:${esc(g.color || "var(--line)")}"></span><b>${esc(tr.tag + (tr.title ? " · " + tr.title : ""))}</b><span class="sub">${g.waves.length}${g.need ? " · ждут " + g.need : ""}</span></div>` : "";
            return epHead + sub + g.waves.map(({ w, c }) => waveHTML(A, w, c)).join("");
        })
        .join("");
    const hidden = ACCF.scope === "epic" && S.activeEpic ? ws.filter((w) => w.epic !== S.activeEpic).length : 0;
    const more = hidden ? `<div class="sub" style="margin:10px 2px">Ещё ${hidden} волн(ы) других эпиков — «все эпики» в панели сверху.</div>` : "";
    return (body || `<div class="sub" style="margin:10px 2px">${ACCF.q ? "Ничего не нашлось по «" + esc(ACCF.q) + "»." : "Под этот фильтр волн нет."}</div>`) + emptyHTML(v.empty) + more;
}
export function acceptPanel() {
    const A = S.accept;
    if (!A) return '<div class="sub">Нет данных о приёмке.</div>';
    if (A.brief) {
        loadAccept();
        return '<div class="sub">Загружаю чек-листы приёмки…</div>';
    }
    const ws = A.waves || [];
    if (A.syncing)
        return `<div class="calm acc-sync">${SPIN} Сводятся записи приёмки… После запуска сервера git считает файлы вливов волн (обычно 1–3 мин): до этого чек-листы и вердикты не показываются, отметки ставить нельзя.</div>` + toolsHTML(A);
    if (!ws.length) return toolsHTML(A) + '<div class="sub" style="margin-top:8px">Волн, которые ждут приёмки, нет: всё, что в staging, уже в проде.</div>';
    return toolsHTML(A) + barHTML(ws) + `<div id="acclist">${accListHTML()}</div>`;
}
// ── действия колонки (main.js) ──
export const ACC_ACTS = new Set(["accf", "accgroup", "accscope", "accfold", "accopenk", "accall", "acccmo"]);
export function accAct(a, el) {
    if (a === "accf") {
        ACCF.mode = el.dataset.m;
        saveF();
    } else if (a === "accgroup") {
        ACCF.group = el.dataset.g;
        saveF();
    } else if (a === "accscope") {
        ACCF.scope = el.dataset.s === "all" ? "all" : "epic";
        saveF();
    } else if (a === "accfold" || a === "accopenk") {
        const k = el.dataset.key || el.dataset.k;
        ACC_OPEN.has(k) ? ACC_OPEN.delete(k) : ACC_OPEN.add(k);
        saveOpen();
    } else if (a === "accall") {
        for (const k of [...ACC_OPEN]) if (!k.startsWith("__")) ACC_OPEN.delete(k);
        saveOpen();
    } else if (a === "acccmo") {
        const k = el.dataset.k;
        CM_OPEN.add(k);
        renderSide();
        requestAnimationFrame(() => {
            const f = document.querySelector(k.endsWith("|__vc") ? `[data-accvc="${CSS.escape(k.slice(0, -5))}"]` : `[data-acccm="${CSS.escape(k)}"]`);
            if (f) f.focus();
        });
        return;
    }
    renderSide();
}
/** Поиск по мере набора: перерисовывается только список, поле ввода и фокус остаются. */
export function accSearch(q) {
    ACCF.q = q;
    saveF();
    const el = document.getElementById("acclist");
    if (el) el.innerHTML = accListHTML();
}
// «Приёмка» в ленте задач ведёт к своей волне — раскрыть её карточку, плавно докрутить и подсветить. Фильтр, поиск и вид эпика,
// под которые волна не попала бы, сбрасываются.
export function accJump(key) {
    ACC_OPEN.add(key);
    saveOpen();
    const w = ((S.accept && S.accept.waves) || []).find((x) => x.key === key);
    if (ACCF.mode !== "all" || ACCF.q || (w && ACCF.scope === "epic" && S.activeEpic && w.epic !== S.activeEpic)) {
        ACCF.mode = "all";
        ACCF.q = "";
        if (w && S.activeEpic && w.epic !== S.activeEpic) ACCF.scope = "all";
        saveF();
    }
    renderSide();
    requestAnimationFrame(() => {
        const el = document.querySelector(`.acc-w[data-acckey="${CSS.escape(key)}"]`);
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        el.classList.remove("accflash");
        void el.offsetWidth;
        el.classList.add("accflash");
    });
}
