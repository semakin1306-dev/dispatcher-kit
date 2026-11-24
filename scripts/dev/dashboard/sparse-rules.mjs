// sparse-rules.mjs — частичная выкладка (sparse-checkout, cone) новых папок слотов: чистые правила. В папку слота
// выкладываются корень, область слота и всё, что не принадлежит другим областям проекта; проверки идут по снимку,
// поэтому невыложенные файлы в прогон попадают целиком. По умолчанию выключено.
import { areaDirs } from "../areas.mjs";

/**
 * Включена ли частичная выкладка для новой папки слота. Порядок: поле реестра sparse (true/false — решает), затем DASH_SPARSE
 * ("1"/"0"), затем `repo.sparse` конфига проекта (cfg.sparse). По умолчанию — нет.
 */
export function sparseWanted(slot = {}, env = {}, cfg = {}) {
    if (slot && typeof slot.sparse === "boolean")
        return slot.sparse;
    if (env && (env.DASH_SPARSE === "1" || env.DASH_SPARSE === "0"))
        return env.DASH_SPARSE === "1";
    return !!(cfg && cfg.sparse === true);
}

/** Область слота для выкладки: запись области из `areas` или null (области нет, она неизвестна или слот только читает). */
export function sparseArea(slot = {}, areas = {}) {
    if (!slot || typeof slot !== "object" || slot.readOnly || !slot.area)
        return null;
    return Object.prototype.hasOwnProperty.call(areas || {}, slot.area) ? areas[slot.area] : null;
}

const under = (d, x) => d === x || d.startsWith(x + "/");

/**
 * Каталоги cone-выкладки слота. dirs — все каталоги дерева ветки (git ls-tree -r -d --name-only <rev>), пути через «/».
 * В выкладку идут папки области слота и всё, что не принадлежит другим областям; skip — каталоги, которые не нужны никому.
 * → отсортированный список каталогов для `git sparse-checkout set --cone`, или null — выкладывать полностью
 * (область не понять или ни одной её папки нет в дереве).
 */
export function sparseCone(slot, dirs, { areas = {}, skip = [] } = {}) {
    const area = sparseArea(slot, areas);
    if (!area)
        return null;
    const all = new Set((dirs || []).map((d) => String(d).replace(/\\/g, "/").replace(/\/+$/, "")).filter(Boolean));
    const own = areaDirs(area);
    if (!own.length || !own.some((o) => all.has(o)))
        return null;
    const others = Object.values(areas).filter((a) => a !== area).flatMap((a) => areaDirs(a));
    const kids = new Map();
    for (const d of all) {
        const i = d.lastIndexOf("/"), p = i < 0 ? "" : d.slice(0, i);
        if (!kids.has(p))
            kids.set(p, []);
        kids.get(p).push(d);
    }
    const out = [];
    // каталог целиком, без него или вглубь: вглубь — если ниже лежит граница (своя папка в чужой или чужая в общей)
    const walk = (d) => {
        if (skip.includes(d))
            return;
        if (own.some((o) => under(d, o))) {
            out.push(d);
            return;
        }
        const ownBelow = own.some((o) => o.startsWith(d + "/"));
        if (others.some((x) => under(d, x))) {
            if (ownBelow)
                for (const c of kids.get(d) || [])
                    walk(c);
            return;
        }
        if (ownBelow || others.some((x) => x.startsWith(d + "/")) || skip.some((x) => x.startsWith(d + "/"))) {
            for (const c of kids.get(d) || [])
                walk(c);
            return;
        }
        out.push(d);
    };
    for (const d of kids.get("") || [])
        walk(d);
    return out.sort();
}

export function inCone(file, cone) {
    const f = String(file).replace(/\\/g, "/"), i = f.lastIndexOf("/");
    if (i < 0)
        return true;
    const dir = f.slice(0, i);
    return (cone || []).some((c) => dir === c || dir.startsWith(c + "/") || c.startsWith(dir + "/"));
}

export const outsideCone = (files, cone) => (files || []).filter((f) => f && !inCone(f, cone));

export function sparseConfig(text) {
    const t = String(text || ""), on = /^\s*sparsecheckout\s*=\s*true\s*$/im.test(t);
    return { on, cone: on && /^\s*sparsecheckoutcone\s*=\s*true\s*$/im.test(t) };
}

export function sparseNote(cone, slot) {
    if (!cone)
        return "полная выкладка";
    return "частичная выкладка (cone): " + cone.length + " каталогов; область " + ((slot && slot.area) || "?") + "; папки других областей не выложены";
}
