// slot-rules.mjs — чистые правила подготовки и запуска слотов: когда диспетчерской самой поднимать или повторять
// подготовку папки, следующий шаг недоподготовленного слота, передача слоту, пока папка готовится, толчок оркестратору о
// готовом слоте без агента, задержка старта по плану-заготовке. Без побочных действий.
const LIVE = ["queued", "waiting", "running"];
export const PROVISION_RETRY_MS = 10 * 60e3;
export const PROVISION_MAX_FAILS = 2;
export const PROVISION_STALE_MS = 24 * 3600e3;

export function provisionDue({ archived = false, missing = false, merged = false, jobs = [], now = Date.now(), drain = null }) {
    if (archived)
        return { due: false, why: "слот в архиве" };
    if (merged && !missing)
        return { due: false, why: "ветка влита в staging: папку не достраиваю" };
    if (jobs.some((j) => LIVE.includes(j.status)))
        return { due: false, why: "подготовка уже идёт" };
    if (drain)
        return { due: false, why: "готовится перезапуск диспетчерской: подготовка — после него" };
    const last = jobs[jobs.length - 1];
    if (!missing && last && last.status !== "ok" && now - (last.endedAt || 0) > PROVISION_STALE_MS)
        return { due: false, stale: true, why: "давняя подготовка (" + last.id + "): повтор кнопкой" };
    let fails = 0;
    for (let i = jobs.length - 1; i >= 0 && jobs[i].status !== "ok"; i--)
        if (jobs[i].status === "fail" || (jobs[i].status === "interrupted" && !jobs[i].bootInterrupted))
            fails++;
    if (fails >= PROVISION_MAX_FAILS)
        return { due: false, attention: true, jobId: last.id, why: "подготовка слота не удалась " + fails + " раза подряд — сама больше не повторяю: смотрите журнал и повторите кнопкой" };
    if (!last)
        return missing ? { due: true, why: "папки нет", reuse: false } : { due: false, why: "папка есть" };
    if (last.status === "cancelled")
        return { due: false, why: "подготовку отменили: повтор кнопкой" };
    const ago = now - (last.endedAt || 0);
    if (last.status === "ok")
        return !missing
            ? { due: false, why: "слот готов" }
            : ago >= PROVISION_RETRY_MS
              ? { due: true, why: "папки нет после зелёной подготовки", reuse: false }
              : { due: false, why: "подготовка только что прошла" };
    if (last.status === "interrupted" && last.bootInterrupted)
        return { due: true, why: "подготовку оборвал перезапуск диспетчерской (" + last.id + ")", reuse: !missing };
    if (ago < PROVISION_RETRY_MS)
        return { due: false, why: "повтор не раньше чем через " + Math.ceil((PROVISION_RETRY_MS - ago) / 60e3) + " мин" };
    return { due: true, why: "последняя подготовка " + (last.status === "fail" ? "упала" : "прервана") + " (" + last.id + ") — повтор", reuse: !missing };
}

export function prepNext({ jobs = [], now = Date.now() }) {
    const last = jobs[jobs.length - 1];
    if (!last || last.status === "ok")
        return null;
    if (LIVE.includes(last.status))
        return { kind: "info", text: "подготовка слота идёт (" + last.id + ")" };
    const d = provisionDue({ missing: false, jobs, now });
    if (d.stale)
        return null;
    if (d.attention)
        return { kind: "bad", text: d.why, act: "provision", jobId: d.jobId };
    return {
        kind: "warn",
        text:
            "Подготовка слота не завершена (" +
            last.id +
            ", " +
            last.status +
            "): " +
            (d.due ? "повтор поставится сам в течение минуты" : d.why),
        act: "provision",
        jobId: last.id,
    };
}

export function relayToSlot({ folder = false, preparing = false, live = false, session = false, prompt = false }) {
    if (!folder || preparing)
        return { act: "wait", why: folder ? "подготовка слота идёт" : "папки слота ещё нет" };
    if (live || session)
        return { act: "deliver" };
    if (prompt)
        return { act: "start" };
    return { act: "deliver" };
}

/** Аргументы slot-up для подготовки слота диспетчерской: шаги подготовки и сборка — по области слота (slot-up.mjs); папка есть — --reuse. */
export function provisionArgs(x, missing) {
    const a = [x.slot, "--branch", x.branch];
    if (!missing)
        a.push("--reuse");
    return a;
}

// Потолок одновременных подготовок — от свободной памяти: запас PREP_RESERVE_GB, по GB_PER_PREP на подготовку, не больше PREP_MAX.
export const PREP_MAX = 3;
export const PREP_RESERVE_GB = 4;
export const GB_PER_PREP = 1.5;
export const prepCap = (freeGB) => (Number.isFinite(freeGB) ? Math.max(1, Math.min(PREP_MAX, Math.floor((freeGB - PREP_RESERVE_GB) / GB_PER_PREP))) : 1);
export const SLOT_IDLE_MS = 10 * 60e3;
// План из заготовки epic.mjs add-slot (подсказки шаблона ещё на месте) — слот не готов к старту.
export const PLAN_STUB_MARKS = ["(кто и что запросил, когда;", "(как устроено сейчас, с замером или чтением кода"];
export const planIsStub = (text) => PLAN_STUB_MARKS.some((m) => String(text || "").includes(m));

export function slotIdleNudge({ archived = false, merged = false, exists = false, agent = false, relay = false, preparing = false, stub = false, lastPrep = null, nudged = "", now = Date.now() }) {
    if (archived || merged || !exists || agent || relay || preparing || stub)
        return null;
    if (!lastPrep || lastPrep.status !== "ok" || !lastPrep.endedAt || nudged === lastPrep.id)
        return null;
    const idle = now - lastPrep.endedAt;
    if (idle < SLOT_IDLE_MS || idle > PROVISION_STALE_MS)
        return null;
    return { jobId: lastPrep.id, min: Math.round(idle / 60e3) };
}

export function slotIdleText({ tag, title = "", min, jobId, plan = true }) {
    return "Диспетчерская: слот " + tag + (title ? " (" + title + ")" : "") + " готов уже " + min + " мин (подготовка " + jobId + " зелёная), а агент не запущен и передач к нему нет — волна стоит." +
        " Если волна твоя — дай старт блоком slot:" + tag + ": диспетчерская сама запустит агента со стартовым промптом, твоя передача уйдёт следом." +
        (plan ? "" : " План волны " + tag + " в твоей папке не найден — сначала положи план, потом старт.") +
        " Если волна ждёт (чужой влив, решение владельца) — ответь одной строкой, чего ждёт. Повторно по этой подготовке не напомню.";
}

/**
 * Абзац подсказки агента слота про окружение его папки. Постоянный текст по слоту — кеш подсказки не сбивается.
 * Слот «только чтение» кода не пишет — абзац ему не нужен.
 */
export function slotEnvNote(x) {
    if (x.readOnly)
        return "";
    return (
        "ОКРУЖЕНИЕ ПАПКИ. Сборку, гарды и тесты в этой папке сам не запускай" +
        ": проверки — станции диспетчерской (сборка → гарды → тесты → регресс) на её копии кода; их ставит диспетчерская или оркестратор строкой «ПРОГНАТЬ " +
        x.tag +
        ": задача=фильтр». Если план велит прогнать проверку самому — пропусти этот шаг, продолжай по плану, а в докладе напиши «Нужно от оркестратора: ПРОГНАТЬ " +
        x.tag +
        ": …» — не СТОП."
    );
}

/** Почему задаче не место в этом слоте; "" — можно. Слоту «только чтение» сборка, тесты и гарды не нужны. */
export function areaRefusal(x, taskId) {
    if (x.readOnly)
        return x.tag + ": слот только читает код — сборка, тесты и гарды ему не нужны" + (taskId ? " (задача " + taskId + ")" : "") + ".";
    return "";
}

export function startHeldByStub({ kind = "slot", live = false, session = false, stub = false } = {}) {
    return kind === "slot" && !live && !session && !!stub;
}

export function rerunByChain({ autoTrain = false, off = false, todo = 0 } = {}) {
    return !!autoTrain && !off && todo > 0;
}
