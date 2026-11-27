// deploy-stages.mjs — этапы экрана выката стенда.
// Первый этап — пуш staging, который делает сама диспетчерская (шаг 1 рецепта). Дальше — этапы из
// `release.stand.stages` ([id, подпись, регулярка]): этап становится текущим, когда в выводе команды выката
// появляется строка, подходящая под его регулярку. Не заданы этапы — один общий «Выкат стенда».
// Состояния: run — идёт, ok — пройден, skip — его метки не было (команда его пропустила).

/** stagesDef запуска: [[id, подпись, регулярка?], …] — кладётся в запуск при постановке (старые экраны — по своим). */
export function standStagesDef(stages = []) {
    const own = Array.isArray(stages) && stages.length ? stages.map((x) => [x[0], x[1], x[2]]) : [["stand", "Выкат стенда"]];
    return [["push", "Пуш staging"], ...own];
}

const reCache = new Map();
function reOf(src) {
    if (!src)
        return null;
    if (!reCache.has(src)) {
        let re = null;
        try {
            re = new RegExp(src);
        }
        catch { }
        reCache.set(src, re);
    }
    return reCache.get(src);
}

function ensure(job) {
    const p = job.prog || (job.prog = {});
    p.stages ||= {};
    p.at ||= {};
    return p;
}

/** Начало шага рецепта: шаг 1 — пуш диспетчерской, шаг 2 и дальше — команда выката (её первый этап — «идёт»). */
export function standStepStart(job, si, now = Date.now()) {
    const def = job && job.stagesDef;
    if (!Array.isArray(def) || def.length < 2 || def[0][0] !== "push")
        return;
    const p = ensure(job);
    if (si <= 1) {
        p.stages.push = "run";
        p.at.push ??= now;
        p.cur = "push";
        return;
    }
    if (p.stages.push !== "ok")
        p.stages.push = "ok";
    const nx = def[1][0];
    if (!p.stages[nx]) {
        p.stages[nx] = "run";
        p.at[nx] ??= now;
        p.cur = nx;
    }
}

/** Строка вывода: подошла под регулярку этапа — он текущий, предыдущие пройдены (или пропущены, если их метки не было). */
export function standLine(job, line, now = Date.now()) {
    const def = job && job.stagesDef;
    if (!Array.isArray(def))
        return false;
    const i = def.findIndex((x, k) => k > 0 && x[2] && (reOf(x[2]) || { test: () => false }).test(line));
    if (i < 0)
        return false;
    const p = ensure(job);
    for (let k = 0; k < i; k++) {
        const id = def[k][0], s = p.stages[id];
        p.stages[id] = s === "run" || s === "ok" ? "ok" : "skip";
    }
    const id = def[i][0];
    p.stages[id] = i === def.length - 1 ? "ok" : "run";
    p.at[id] ??= now;
    p.cur = id;
    return true;
}
