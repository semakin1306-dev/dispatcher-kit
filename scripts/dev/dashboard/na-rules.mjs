// «Неприменимо»: прогон завершился не-нулём, но тестов не было вовсе — задаче дали несуществующее имя
// (части, пакета, набора). Такое красное не говорит о коде: прогон получает статус `skipped` с флагом `na`,
// в «дважды красный», тупики и вердикт станции не идёт, агент получает подсказку, что выбрать вместо.
//
// Задача включает распознавание полями конфига:
//   naLog  — регэксп по логу прогона; первая совпавшая строка — причина («[parts] неизвестные части: x»);
//   naList — регэксп построчно (флаг m) с группой 1: существующие имена из каталога, который печатает команда.

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Компиляция регэкспа из конфига; неверный — null (конфиг проверяет project.mjs, здесь — без падений). */
export function naRe(src, flags = "") {
    if (typeof src !== "string" || !src)
        return null;
    try {
        return new RegExp(src, flags);
    }
    catch {
        return null;
    }
}

/**
 * Разбор лога прогона: { line, list } — неприменимо; null — обычное красное.
 * task: { naLog?, naList? }; log — текст (цвета терминала вычищаются).
 */
export function naOfLog(log, task) {
    const re = naRe(task && task.naLog);
    if (!re)
        return null;
    const text = String(log || "").replace(ANSI, "");
    const lines = text.split(/\r?\n/);
    const hit = lines.find((l) => re.test(l));
    if (!hit)
        return null;
    const list = [];
    const lre = naRe(task.naList);
    if (lre)
        for (const l of lines) {
            const m = l.match(lre);
            if (m && m[1] && !list.includes(m[1]))
                list.push(m[1]);
        }
    return { line: hit.trim().slice(0, 200), list: list.slice(0, 80) };
}

/** Сводка прогона для страницы и журнала. */
export function naSummary(na) {
    return "неприменимо: " + na.line + " — тесты не запускались";
}

/** Текст агенту слота: что не так и что выбрать. */
export function naAdvice(label, input, na) {
    return (
        "── " + label + (input ? " — " + input : "") + ": неприменимо, тесты не запускались ──\n" +
        na.line +
        (na.list && na.list.length ? "\nСуществующие: " + na.list.join(", ") : "") +
        "\nВыбери существующее имя или не назначай этот прогон. Это не падение кода — разбирать нечего."
    );
}
