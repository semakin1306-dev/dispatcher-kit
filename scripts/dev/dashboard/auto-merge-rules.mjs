// auto-merge-rules.mjs — чистые правила автовлива: когда ветку можно влить в staging без слова человека (станции зелёные
// на нынешнем коде, ревью «ЗА», агент доложил «ГОТОВО», конфликта нет) и когда подтянуть staging в ветку при конфликте.
export const MERGE_STATIONS = ["build", "tests", "guards", "review", "regress"];

export function mergePin({ head = "", snapSha = "" } = {}) {
    const h = String(head || "").trim(), s = String(snapSha || "").trim();
    if (!/^[0-9a-f]{40}$/.test(h))
        return { ok: false, sha: "", why: "не удалось прочитать коммит ветки — влив отложен" };
    if (!s)
        return { ok: false, sha: "", why: "в снимке нет коммита ветки — влив отложен до следующего снимка" };
    if (!h.startsWith(s))
        return { ok: false, sha: "", why: "ветка ушла вперёд после снимка (" + s + " → " + h.slice(0, 10) + "): новый код ещё не проверен — решу на следующем снимке" };
    return { ok: true, sha: h, why: "" };
}

export const NOT_DONE_WHY = "агент ещё не доложил «ГОТОВО»";

export function autoMergeAct({ on = true, drain = false, t, final = false, mergeLive = false } = {}) {
    if (!on)
        return { act: "", why: "автовлив выключен" };
    if (drain)
        return { act: "", why: "диспетчерская готовится к перезапуску" };
    if (!t || t.kind !== "slot" || !t.exists || t.readOnly)
        return { act: "", why: "не ветка волны" };
    if (t.verdict && t.verdict.merged)
        return { act: "", why: "уже в staging" };
    if (!(t.ahead > 0))
        return { act: "", why: "вливать нечего" };
    if (t.dirtyTracked)
        return { act: "", why: "в папке незакоммиченные правки" };
    if (t.conflict == null)
        return { act: "", why: "конфликт со staging ещё считается" };
    if (Array.isArray(t.conflict) && t.conflict.length)
        return { act: "", why: "конфликт со staging: " + t.conflict.slice(0, 3).join(", ") };
    const open = (t.stages || []).filter((s) => MERGE_STATIONS.includes(s.id) && !s.done);
    if (open.length)
        return { act: "", why: "не пройдены: " + open.map((s) => s.label || s.id).join(", ") };
    const dep = (t.deps || []).find((d) => !d.merged);
    if (dep)
        return { act: "", why: "сначала влить " + (dep.tag || dep.key) };
    if (!final && !wagonDone(t))
        return { act: "", why: NOT_DONE_WHY };
    if (mergeLive)
        return { act: "", why: "идёт другой влив — после него" };
    return { act: "merge", why: "станции зелёные, ревью «ЗА», агент доложил «ГОТОВО» — вливаю в staging" };
}

export function wagonDone(t) {
    if (!t || !t.train || !t.wagon)
        return false;
    const w = (t.wagons || []).find((x) => x.wave === t.wagon);
    return !!(w && w.times && w.times.doneAt);
}

export function askDoneAct({ d, t, busy = false, asked = "" } = {}) {
    if (!d || d.act === "merge" || d.why !== NOT_DONE_WHY)
        return { act: "", why: "" };
    if (!t || !t.fp)
        return { act: "", why: "нет отпечатка кода ветки" };
    if (busy)
        return { act: "", why: "агент или прогоны слота заняты — спрошу после" };
    if (asked === t.fp)
        return { act: "", why: "на этом коде агента уже спрашивали" };
    return { act: "ask", why: "станции зелёные, «ГОТОВО» нет — спрашиваю агента" };
}

export function askDoneText(t) {
    const w = (t && (t.wagon || t.wave)) || "волна", key = (t && t.key) || "";
    return "[Диспетчерская] Станции " + (t && t.train ? "вагона " : "") + w + " зелёные на нынешнем коде (сборка, гарды, тесты, ревью, регресс), " +
        "конфликта со staging нет, но доклада «ГОТОВО» по нему нет — поэтому автовлив стоит.\n" +
        "Если работа по плану закончена целиком — ответь докладом «" + w + " (слот " + key + "): ГОТОВО» и коротко, что сделано. " +
        "Если нет — продолжай со следующего шага плана; зелёные прогоны тогда не повод вливать.";
}

export function wagonUnfinished(t, final = false) {
    return !!(t && t.train && t.wagon && !final && !wagonDone(t));
}

export function autoSyncAct({ on = true, t, busy = false, tried = false, red = false } = {}) {
    if (!on)
        return { act: "", why: "автоподтягивание выключено" };
    if (!t || t.kind !== "slot" || !t.exists || t.readOnly)
        return { act: "", why: "не ветка волны" };
    if (t.verdict && t.verdict.merged)
        return { act: "", why: "уже в staging" };
    if (!(t.ahead > 0) || !(t.behind > 0))
        return { act: "", why: "своих коммитов нет или staging не ушёл вперёд" };
    const conflict = Array.isArray(t.conflict) && t.conflict.length > 0;
    if (!conflict && !(red && Array.isArray(t.conflict)))
        return { act: "", why: red ? "конфликт со staging ещё считается" : "конфликта нет" };
    if (t.dirtyTracked)
        return { act: "", why: "в папке незакоммиченные правки (агент разбирает?)" };
    if (busy)
        return { act: "", why: "агент или прогоны заняты" };
    if (tried)
        return { act: "", why: "на этом staging уже подтягивали — конфликт у агента" };
    if (!conflict)
        return { act: "sync", why: "станция красная на этом коде, а staging ушёл вперёд на " + t.behind + " — подтягиваю staging и перепрогоняю" };
    return { act: "sync", why: "конфликт со staging: " + t.conflict.slice(0, 3).join(", ") + " — подтягиваю staging, конфликт агенту" };
}
