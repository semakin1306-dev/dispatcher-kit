// ui/accept-view.js — чистые правила колонки «Приёмка». Лист: ничего не импортирует (node --test accept-view.test.mjs).
// Колонка на десятки волн была экранами развёрнутых карточек: кейсы приёмки долго искать. Здесь — счётчики волны, фильтр,
// поиск, сортировка «сначала требующие действия» и группы. Несколько эпиков одновременно: метки слотов «П1», «П2» и поездов
// «ТN» не уникальны между эпиками, поэтому группы и ключи — по эпику и ключу дерева, а не по метке; вид «этот эпик» показывает
// только волны эпика вкладки, «все эпики» — сгруппировано по эпику.
// Пункт чек-листа: { id, how: "auto" | "manual", state: "todo" | "ok" | "bad", auto: { st: "ok" | "flaky" | "fail" | "skip" } | undefined }.
const AUTO_OK = new Set(["ok", "flaky"]);
export const isManual = (x) => !!x && x.how !== "auto";

/** Номер волны: поле wave, иначе WV-NNNN из названия или ветки (dev/wv-9002-…). */
export function waveNo(w) {
    if (!w) return "";
    if (w.wave) return String(w.wave).toUpperCase();
    const m = /\bWV-?(\d{3,5})\b/i.exec(String(w.title || "")) || /\bwv-?(\d{3,5})\b/i.exec(String(w.branch || "")) || /\bwv-?(\d{3,5})\b/i.exec(String(w.key || ""));
    return m ? "WV-" + m[1] : "";
}

/** Счётчики волны для её строки: авто ✓ / ✗ / не проверено, ручных и отмеченных из них, отметок «не работает». */
export function waveCounts(w) {
    const items = (w && w.items) || [];
    const c = { items: items.length, auto: 0, autoOk: 0, autoBad: 0, autoNone: 0, manual: 0, manualDone: 0, marksBad: 0 };
    for (const x of items) {
        if (x.state === "bad") c.marksBad++;
        if (isManual(x)) {
            c.manual++;
            if (x.state && x.state !== "todo") c.manualDone++;
            continue;
        }
        c.auto++;
        const st = x.auto && x.auto.st;
        if (x.state === "ok" || AUTO_OK.has(st)) c.autoOk++;
        else if (x.state === "bad" || st === "fail") c.autoBad++;
        else c.autoNone++;
    }
    return c;
}
/** Волна ждёт владельца: есть пункты, вердикта нет (закрытые сами — «без кода продукта» — не ждут). */
export const waveNeedsMe = (w, c = waveCounts(w)) => c.items > 0 && !w.verdict && !w.autoClosed;
/** Красная: авто ✗, отметка «не работает» или вердикт «не принято». */
export const waveRed = (w, c = waveCounts(w)) => c.autoBad > 0 || c.marksBad > 0 || w.verdict === "rejected";
/** Вердикт можно ставить прямо из строки волны: пункты есть, красного нет, все авто-пункты зелёные. */
export const quickVerdict = (w, c = waveCounts(w)) => c.items > 0 && !w.autoClosed && c.autoBad === 0 && c.autoNone === 0 && c.marksBad === 0;
/** Насколько волна требует действия (меньше — выше в списке): красная → ждёт меня → прочее → принятая. */
export const waveRank = (w, c = waveCounts(w)) => (waveRed(w, c) ? 0 : waveNeedsMe(w, c) ? 1 : w.verdict === "accepted" ? 3 : 2);

export const FILTERS = [["all", "Все"], ["me", "Ждут меня"], ["red", "Красные"], ["manual", "Только ручные"], ["auto", "Только авто"], ["accepted", "Принятые"]];
/** Подходит ли пункт под фильтр вида пунктов (только ручные / только авто); остальные фильтры пункты не скрывают. */
export const itemShown = (x, mode) => (mode === "manual" ? isManual(x) : mode === "auto" ? !isManual(x) : true);
const low = (s) => String(s || "").toLowerCase();
/** Поиск: номер волны («9001», «WV-9001»), название, метка, поезд, эпик, текст пункта (что сделать, что ожидать, где, номер iN). */
export function waveMatches(w, q, train = "") {
    const t = low(q).trim();
    if (!t) return true;
    const words = t.split(/\s+/);
    const hay = low([waveNo(w), w.tag, w.title, w.key, w.epicTitle, w.epic, train, ...(w.items || []).map((x) => [x.id, x.todo, x.expect, x.where, x.role].join(" "))].join(" "));
    return words.every((s) => hay.includes(s.replace(/^wv-?/, "")));
}
/** Подходит ли волна под фильтр. */
export function waveFilter(w, mode, c = waveCounts(w)) {
    switch (mode) {
        case "me":
            return waveNeedsMe(w, c);
        case "red":
            return waveRed(w, c);
        case "manual":
            return c.manual > 0;
        case "auto":
            return c.auto > 0;
        case "accepted":
            return w.verdict === "accepted";
        default:
            return true;
    }
}
/** Волна в виде «этот эпик»: только волны эпика вкладки; без эпика вкладки или в виде «все эпики» — все. */
export const waveInScope = (w, scope, epic) => scope !== "epic" || !epic || w.epic === epic;

// «Т2» < «Т10», «П1» — после поездов Т; без метки — в конце
const tagKey = (s) => {
    const m = /^(\D*)(\d+)/.exec(String(s || ""));
    return m ? [m[1] === "Т" ? 0 : m[1] ? 1 : 2, m[1], Number(m[2])] : [3, String(s || ""), 0];
};
export function tagCmp(a, b) {
    const x = tagKey(a), y = tagKey(b);
    return x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) || x[2] - y[2] || String(a).localeCompare(String(b));
}
const noCmp = (a, b) => {
    const x = Number((waveNo(a).match(/\d+/) || [0])[0]), y = Number((waveNo(b).match(/\d+/) || [0])[0]);
    return x - y || tagCmp(a.tag, b.tag);
};
const epicKey = (w) => String(w.epic || "");
const epicLabel = (w) => w.epicTitle || w.epic || "без эпика";

/** Колонка целиком: эпик вкладки, отбор, порядок, группы. trainOf(w) → { key, tag, title, color } поезда волны или null (слот).
 *  scope: "epic" — только волны эпика `epic`, "all" — все. group: "train" — поезд внутри эпика (волны слотов — группой «слоты»
 *  эпика), "epic" — эпик целиком. Ключ группы всегда начинается с эпика: одинаковые «П1»/«Т2» разных эпиков не смешиваются.
 *  Возвращает { groups: [{ key, epic, label, color, waves: [{ w, c }], need }], empty: [волны без пунктов], shown, total, epics }. */
export function acceptView(waves, { mode = "all", q = "", group = "train", scope = "all", epic = "", trainOf = () => null } = {}) {
    const inScope = (waves || []).filter((w) => waveInScope(w, scope, epic));
    const all = inScope.map((w) => ({ w, c: waveCounts(w), t: trainOf(w) || null }));
    const epics = new Set(all.map((x) => epicKey(x.w)));
    const multi = epics.size > 1;
    const empty = all.filter((x) => x.c.items === 0 && !x.w.verdict && waveMatches(x.w, q, x.t ? x.t.tag : ""));
    const list = all.filter((x) => !(x.c.items === 0 && !x.w.verdict) && waveFilter(x.w, mode, x.c) && waveMatches(x.w, q, x.t ? x.t.tag : ""));
    const by = new Map();
    for (const x of list) {
        const ek = epicKey(x.w);
        const sub = group === "epic" ? "" : x.t ? "t:" + x.t.key : "s";
        const key = "e:" + ek + "|" + sub;
        if (!by.has(key)) {
            const tl = x.t ? x.t.tag + (x.t.title ? " · " + x.t.title : "") : "";
            const label = group === "epic" || !x.t ? epicLabel(x.w) : multi ? epicLabel(x.w) + " · " + tl : tl;
            by.set(key, { key, epic: ek, label, tag: x.t ? x.t.tag : "", color: x.t ? x.t.color : x.w.color, train: !!x.t, waves: [] });
        }
        by.get(key).waves.push(x);
    }
    const wcmp = (a, b) => waveRank(a.w, a.c) - waveRank(b.w, b.c) || noCmp(a.w, b.w);
    const groups = [...by.values()].map((g) => {
        g.waves.sort(wcmp);
        g.need = g.waves.filter((x) => waveRank(x.w, x.c) < 2).length;
        g.rank = Math.min(...g.waves.map((x) => waveRank(x.w, x.c)));
        return g;
    });
    // эпик вкладки — первым; дальше по срочности, эпики по названию, поезда по метке
    const epFirst = (g) => (epic && g.epic === epic ? 0 : 1);
    groups.sort((a, b) => epFirst(a) - epFirst(b) || a.rank - b.rank || String(a.epic).localeCompare(String(b.epic)) || (a.train === b.train ? tagCmp(a.tag, b.tag) : a.train ? -1 : 1));
    return { groups, empty, shown: list.length, total: all.length, epics: epics.size };
}
/** Итог по колонке для шапки: волн, принято, не принято, ждут, красных (по видимому эпику). */
export function acceptTotals(waves, { scope = "all", epic = "" } = {}) {
    const t = { waves: 0, accepted: 0, rejected: 0, need: 0, red: 0, empty: 0 };
    for (const w of (waves || []).filter((x) => waveInScope(x, scope, epic))) {
        const c = waveCounts(w);
        t.waves++;
        if (w.verdict === "accepted") t.accepted++;
        if (w.verdict === "rejected") t.rejected++;
        if (waveNeedsMe(w, c)) t.need++;
        if (waveRed(w, c)) t.red++;
        if (!c.items && !w.verdict) t.empty++;
    }
    return t;
}
