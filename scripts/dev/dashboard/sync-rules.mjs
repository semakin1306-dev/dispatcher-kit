// sync-rules.mjs — чистые правила подтягивания staging в ветку слота: «Дальше» у ветки с конфликтом, разбор ответа
// slot-sync, письма агенту о конфликте и о незакоммиченных правках, состав поезда по эпику. Без S, git и файлов —
// всё приходит аргументами.

/** Письмо о конфликте уже отдано агенту — столько оно считается свежим (потом карточка снова просит подтянуть). */
export const SYNC_ASK_TTL_MS = 6 * 3600e3;
const hhmm = (at) => new Date(at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const head = (files, n) => files.slice(0, n).join(", ") + (files.length > n ? " …" : "");

/**
 * «Дальше» у ветки, конфликтующей со staging. t.conflict: [] — чисто, [файлы] — конфликт, null — ещё считается.
 * t.syncAsk — { at, files, kind } письмо агенту. → { kind, text, act, conflict, asked? } или null.
 */
export function conflictNext(t, now = Date.now()) {
    const c = t && t.conflict, ask = t && t.syncAsk && now - t.syncAsk.at < SYNC_ASK_TTL_MS ? t.syncAsk : null;
    if (ask && t.dirtyTracked && !(t.verdict && t.verdict.merged))
        return { kind: "info", text: "Агент разбирает " + (ask.kind === "conflict" ? "конфликт со staging" : "правки, мешающие вливу staging") + " (отдан в " + hhmm(ask.at) + ": " + head(ask.files, 3) + ") — ждём его коммит слияния", act: "slotsync", conflict: ask.files, asked: true };
    if (ask && Array.isArray(c) && c.length && t.ahead && !t.dirtyTracked)
        return { kind: "info", text: "Конфликт со staging отдан агенту в " + hhmm(ask.at) + " (" + head(c, 3) + ") — ждём его коммит слияния. Повторить — кнопкой", act: "slotsync", conflict: c, asked: true };
    if (!Array.isArray(c) || !c.length || !t.ahead || t.dirtyTracked || (t.verdict && t.verdict.merged))
        return null;
    return { kind: "warn", text: "Конфликт со staging: " + c.slice(0, 6).join(", ") + (c.length > 6 ? " и ещё " + (c.length - 6) : "") + " — подтянуть staging (slot-sync), разрешить в слоте, потом вливать", act: "slotsync", conflict: c };
}

/**
 * git отказал ДО влива: в слоте незакоммиченные правки в файлах, которые правит и staging. Это не конфликт — агенту
 * нужно закоммитить правки. → файлы из сообщения git (одной строкой или столбиком); [] — причина другая.
 */
export function dirtyBlockers(text) {
    const m = /would be overwritten by (?:merge|checkout)\s*:?\s*([\s\S]*?)(?:Please commit|Please, commit|Aborting|$)/i.exec(String(text || ""));
    if (!m)
        return [];
    return m[1].split(/\s+/).map((x) => x.replace(/^["']|["']$/g, "")).filter((x) => x && /[/.]/.test(x) && !/^error:?$/i.test(x));
}

/**
 * Ответ slot-sync: первая строка «OK 0|ff|merge …», «SKIP …» или «CONFLICT <файлы>», со второй — «WHY <что сказал git>».
 * Пустой список конфликта — не конфликт: git отказал по другой причине, это сбой влива, а не список агенту.
 */
export function parseSync(out) {
    const s = String(out || ""), first = s.split(/\r?\n/)[0], why = ((/^WHY\s*(.*)$/m.exec(s) || [])[1] || "").trim();
    if (/^OK 0/.test(first))
        return { ok: true, text: "уже на staging" };
    if (/^OK ff/.test(first))
        return { ok: true, text: "перемотано на staging" };
    if (/^OK merge/.test(first))
        return { ok: true, text: "staging влит в ветку волны" };
    if (/^SKIP/.test(first))
        return { skip: "у ветки свои коммиты — только кнопкой владельца" };
    if (/^CONFLICT/.test(first)) {
        const files = first.replace(/^CONFLICT\s*/, "").split(/\s+/).filter(Boolean);
        const dirty = files.length ? [] : dirtyBlockers(why);
        if (dirty.length)
            return { fail: "в слоте незакоммиченные правки в файлах, которые правит и staging: " + head(dirty, 4) + " — влив не начат", dirty };
        return files.length ? { conflict: files } : { fail: "влив staging не прошёл, конфликтных файлов нет" + (why ? ": " + why.slice(0, 200) : "") + " — влив откатан" };
    }
    return { fail: "на сервере: " + (s || "нет ответа").slice(0, 200) };
}

/** Метка письма агенту о подтягивании staging: по ней ход агента узнаётся как ответ на это письмо. */
export const SYNC_ASK_MARK = "кнопкой «Подтянуть staging»";

/** Письмо агенту: staging не вливается, пока в слоте лежат незакоммиченные правки тех же файлов. */
export function syncDirtyText(branch, files) {
    return "staging ушёл вперёд, и влить его в твою ветку" + (branch ? " (" + branch + ")" : "") + " git отказался: в слоте незакоммиченные правки в файлах, которые правит и staging:\n" + files.slice(0, 20).map((f) => "- " + f).join("\n") +
        "\nВлив не начат, ничего не потеряно. Закоммить свои правки, затем влей staging сам (git merge staging), конфликты разреши по смыслу обеих сторон, прогоны назови владельцу. Разрешение на этот влив дал владелец " + SYNC_ASK_MARK + ".";
}

/** Письмо агенту о конфликте при вливе staging в его ветку. */
export function syncConflictText(branch, files) {
    return "staging ушёл вперёд, и при вливе его в твою ветку" + (branch ? " (" + branch + ")" : "") + " конфликт в файлах:\n" + files.map((f) => "- " + f).join("\n") +
        "\nВлив откатан, ветка как была. Влей staging сам (git merge staging), разреши конфликты по смыслу обеих сторон, прогоны назови владельцу. Разрешение на этот влив дал владелец " + SYNC_ASK_MARK + ".";
}

/** Ход агента — ответ на письмо о подтягивании staging (его последнее входящее — это письмо). */
export const isSyncAsk = (text) => String(text || "").includes(SYNC_ASK_MARK) && /staging ушёл вперёд/.test(String(text || ""));

/** Ветка входит в состав поезда эпика: снимок держит ветки всех эпиков. Эпик не задан — любая. */
export const inEpic = (t, epic) => !epic || (!!t && t.epic === epic);
