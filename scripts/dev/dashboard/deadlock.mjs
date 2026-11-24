// deadlock.mjs — детектор тупиков правил: одна и та же просьба с одной и той же причиной отказа несколько раз подряд на
// том же коде — замкнутый круг. Каждый отказ по отдельности верен, вместе они стоят на месте; такой круг поднимается
// человеку карточкой, а не повторяется молча.
export const DEADLOCK_STREAK = 3;
const KEEP = 400;
export const normWhy = (why) => String(why || "").replace(/\s*\([^)]*\)/g, "").replace(/\bj\d+\b/g, "j").replace(/\s+/g, " ").trim().slice(0, 300);

export function streakNote(map, scope, sig, now = Date.now()) {
    let s = map.get(scope);
    if (!s || s.sig !== sig) {
        s = { sig, n: 0, first: now, fired: false };
        map.delete(scope);
    }
    s.n++;
    s.last = now;
    map.set(scope, s);
    if (map.size > KEEP)
        map.delete(map.keys().next().value);
    const fire = s.n >= DEADLOCK_STREAK && !s.fired;
    if (fire)
        s.fired = true;
    return { n: s.n, fire, since: s.first };
}

export const streakClear = (map, scope) => map.delete(scope);
export const DEADLOCK_HINT = "Повтор той же просьбы ничего не даст: каждое правило по отдельности отказывает верно, вместе они не пускают. Реши, что меняется — код (правка в слоте), порядок (сначала другая ветка), путь (поезд влива вместо прогона, «принудительно» по слову владельца) — или вынеси владельцу одним пунктом в «Вопросы владельцу».";

export function deadlockText({ what, why, n, since, now = Date.now() }) {
    const min = Math.max(1, Math.round((now - since) / 60000));
    return "[Диспетчерская] Правила противоречат: «" + what + "» отклонено " + n + " раза подряд на том же коде с одной причиной (за " + min + " мин): " + why + ". " + DEADLOCK_HINT;
}
