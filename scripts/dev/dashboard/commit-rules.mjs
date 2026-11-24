// commit-rules.mjs — чистые правила коммитов агента слота: режим settings.selfCommit (station — сам после каждой станции
// плана, free — сам по усмотрению, word — только по слову человека), форма команды коммита, проверка и починка подписи
// (строка «Wave: WV-NNNN» в последнем абзаце — её ставит хук commit-msg), признак «волна закончена» для ворот заморозки и поезда.
// Без импортов: модуль грузит и хук commit-msg, которому нельзя зависеть от конфига диспетчерской.
export const SELF_COMMIT_MODES = ["station", "free", "word"];
export const SELF_COMMIT_DEFAULT = "station";
export const selfCommitMode = (s) => (s && SELF_COMMIT_MODES.includes(s.selfCommit) ? s.selfCommit : SELF_COMMIT_DEFAULT);
export const selfCommitOn = (s) => selfCommitMode(s) !== "word";

export function selfCommitRule(mode = SELF_COMMIT_DEFAULT) {
    const tail = " Подпись — по навыку slot-commit: тема «тип(область): WV-NNNN STn: суть». Строку «Wave: WV-NNNN» в последний абзац ставит хук коммита сам — номером волны (у поезда — вагона в работе) из реестра: свою можешь не писать, неверную он исправит. Только `git add <пути>` и `git commit` в своей папке: без -A, без -a, без --no-verify (без хука у коммита не будет строки Wave). Пуш, слияние, rebase, reset, чужие ветки, staging и main — нельзя: влив в staging и выкат — по слову владельца.";
    if (mode === "word")
        return "КОММИТ. Сам по своей инициативе не коммить: коммитишь, когда пришло сообщение «Владелец нажал кнопку «Коммит» в дашборде» (тот же текст присылают автопоезд и команда оркестратора «КОММИТ ПN») или владелец прямо написал «коммить»; тогда выполни навык slot-commit." + tail;
    if (mode === "free")
        return "КОММИТ. Коммить сам в своей ветке, когда работа дошла до цельного состояния; перед докладом «ГОТОВО» рабочее дерево чистое (всё своё закоммичено)." + tail;
    return "КОММИТ. Коммить сам в своей ветке, без слова владельца: после каждой законченной станции плана (ST) — отдельный коммит этой станции; перед докладом «ГОТОВО» рабочее дерево чистое (всё своё закоммичено). Промежуточный коммит волну не замораживает: проверки диспетчерская ставит до твоего доклада «ГОТОВО»." + tail;
}

export const WAVE_LINE_RE = /^Wave:\s*(WV-?\d{3,4})\s*$/i;

const normW = (w) => {
    const m = /wv-?0*(\d{1,4})/i.exec(String(w || ""));
    return m ? "WV-" + m[1].padStart(4, "0") : "";
};

export function commitMessageCheck(msg, wave = "") {
    const paras = String(msg || "").replace(/\r/g, "").trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (!paras.length)
        return { ok: false, why: "пустая подпись коммита", wave: "" };
    const last = paras[paras.length - 1].split("\n").map((l) => l.trim()), hit = last.map((l) => WAVE_LINE_RE.exec(l)).find(Boolean);
    if (!hit || paras.length < 2)
        return { ok: false, why: "в последнем абзаце подписи нет строки «Wave: " + (normW(Array.isArray(wave) ? wave[0] : wave) || "WV-NNNN") + "» — без неё диспетчерская не найдёт границы волны (вагона)", wave: "" };
    const got = normW(hit[1]), wants = (Array.isArray(wave) ? wave : [wave]).map(normW).filter(Boolean);
    if (wants.length && !wants.includes(got))
        return { ok: false, why: "строка «Wave: " + got + "», а " + (wants.length > 1 ? "вагоны этого поезда — " + wants.join(", ") : "волна этого слота — " + wants[0]), wave: got };
    return { ok: true, why: "", wave: got };
}

/**
 * Форма команды коммита агента: файлы — явно, без -a и без --no-verify (хук commit-msg ставит строку Wave).
 * Саму подпись здесь не проверяем — её чинит хук. → { ok, why }
 */
export function commitCmdShape(cmd) {
    const c = String(cmd || "");
    if (/\bgit\s+add\s+(?:[^&|;\n]*\s)?(-A|--all|-u|--update|\.)(?=\s|$|[&|;])/.test(c))
        return { ok: false, why: "git add -A / . / -u не используем: добавляй файлы своей волны явно (git add <пути>)" };
    if (!/\bgit\s+commit\b/.test(c))
        return { ok: true, why: "" };
    const tail = c.slice(c.search(/\bgit\s+commit\b/)).split(/&&|\|\||;|\n/)[0].replace(/(["'])(?:\\.|(?!\1).)*\1/g, "");
    if (/(^|\s)(--all|-[a-zA-Z]*a[a-zA-Z]*)(\s|$)/.test(tail))
        return { ok: false, why: "git commit -a не используем: добавляй файлы явно (git add <пути>)" };
    if (/(^|\s)(--no-verify|-[a-zA-Z]*n[a-zA-Z]*)(\s|$)/.test(tail))
        return { ok: false, why: "git commit --no-verify не используем: хук коммита ставит строку «Wave: WV-NNNN», без него волна теряет границы" };
    return { ok: true, why: "" };
}

const TRAILER_LINE = /^[A-Za-z][\w-]*:\s+\S/;

/**
 * Починить подпись коммита: строка «Wave: <номер>» — в последнем абзаце, номер — волна слота (у поезда — вагон в работе) или
 * один из разрешённых. Строки Wave в других местах убираются; разрешённый номер агента сохраняется (починка влитого вагона).
 * Комментарии git (#…) в конце сообщения остаются как были.
 * @returns {{text:string, from:string[], to:string, how:"added"|"moved"|"renumbered"}|null} null — чинить нечего или номер неизвестен
 */
export function fixWaveMessage(text, { cur = "", allowed = [] } = {}) {
    const okList = [...new Set([cur, ...allowed].map(normW).filter(Boolean))];
    if (!okList.length)
        return null;
    const lines = String(text || "").replace(/\r/g, "").split("\n");
    let end = lines.length;
    while (end > 0 && (lines[end - 1].startsWith("#") || !lines[end - 1].trim()))
        end--;
    const body = lines.slice(0, end), comments = lines.slice(end).filter((l) => l.startsWith("#"));
    if (!body.join("").trim() || commitMessageCheck(body.join("\n"), okList).ok)
        return null;
    const from = body.map((l) => WAVE_LINE_RE.exec(l.trim())).filter(Boolean).map((m) => normW(m[1]));
    const to = from.find((w) => okList.includes(w)) || normW(cur) || okList[0];
    const rest = body.filter((l) => !WAVE_LINE_RE.test(l.trim())).join("\n").replace(/\n[ \t]*(\n[ \t]*)+\n/g, "\n\n").replace(/\s+$/, "");
    if (!rest.trim())
        return null;
    const paras = rest.split(/\n\s*\n/), last = paras[paras.length - 1].split("\n");
    // Последний абзац — блок трейлеров (Co-Authored-By: …): строка Wave идёт в него, иначе git не сочтёт её трейлером.
    const out = paras.length >= 2 && last.every((l) => TRAILER_LINE.test(l.trim())) ? rest + "\nWave: " + to : rest + "\n\nWave: " + to;
    return { text: out + "\n" + (comments.length ? "\n" + comments.join("\n") + "\n" : ""), from, to, how: !from.length ? "added" : from.some((w) => w !== to) ? "renumbered" : "moved" };
}

export function waveFinal({ mode = SELF_COMMIT_DEFAULT, fp = "", done = null, commitOk = false, legacy = false } = {}) {
    if (mode === "word")
        return true;
    if (!fp)
        return false;
    return !!(commitOk || legacy || (done && done.fp === fp));
}
