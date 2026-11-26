// protocol.mjs — строки текстового протокола слота, которые разбирает диспетчерская в ответе агента: решение
// «ДАЛЬШЕ: …» после итога прогонов, «СВОДКА: …» для карточки ветки, статус «ЖДУ» в заголовке доклада и сам блок доклада.
// Формат задаёт персона инженера слота (agent-briefs/SLOT-ENGINEER-persona.md). Чистый модуль без импортов:
// его проверяет тест на образце ответа из персоны.

/** Решение слота после итога прогонов. Ищется в последних строках ответа (DECISION_TAIL). */
export const DECISION_RE = /ДАЛЬШЕ:\s*\**\s*(ПЕРЕПРОГОН|ОРКЕСТРАТОРУ|СЛОТУ\s+([^\s*.»]+)|ПРИНЯЛ|ЖДУ)/i;
export const DECISION_TAIL = 6;
/** Сводка для карточки ветки: последняя строка «СВОДКА: …» ответа. */
export const SUMMARY_RE = /СВОДКА:\s*\**\s*([^\n]{5,400})/g;
/** Заголовок раздела просьб о прогонах в докладе («Тесты для запуска владельцем:» или «Тесты для запуска:»). */
export const TESTS_HEAD_RE = /Тесты для запуска(?: владельцем)?[^\n:]*:/i;
/** Статус «ЖДУ» в заголовке доклада («<волна> (слот <слот>): ЖДУ.»), но не слово, которое с него начинается. */
export const WAIT_HEAD_RE = /:\s*ЖДУ(?![А-ЯЁа-яё])/;

const tail = (text, n = DECISION_TAIL) => String(text || "").split(/\r?\n/).slice(-n).join("\n");

/** Решение в конце ответа: { word, to } или null. word — ПЕРЕПРОГОН | ОРКЕСТРАТОРУ | СЛОТУ | ПРИНЯЛ | ЖДУ. */
export function decisionOf(text) {
    const m = DECISION_RE.exec(tail(text));
    if (!m)
        return null;
    const word = m[1].toUpperCase();
    return { word: word.startsWith("СЛОТУ") ? "СЛОТУ" : word, to: m[2] || "" };
}
export const hasDecision = (text) => DECISION_RE.test(tail(text));

/** Текст последней строки «СВОДКА: …» без выделения; нет — пусто. */
export function summaryOf(text) {
    const m = [...String(text || "").matchAll(SUMMARY_RE)].pop();
    return m ? m[1].replace(/\*+$/, "").trim() : "";
}

export const FENCE = "`".repeat(3);
/** Блок кода ```язык … ```: язык «slot:П4» у оркестратора — адресат передачи, «text» у слота — доклад оркестратору. */
export const BLOCK_RE = new RegExp(FENCE + "([^\\n`]*)\\n([\\s\\S]*?)" + FENCE, "g");
/** Блок слота, который считается докладом: язык text (или без языка) и не пустая отписка. */
export const isReportBlock = (lang, body) => (lang === "text" || lang === "") && body.length > 40;

/**
 * Тело первого блока-доклада в ответе слота или "". Передаётся только оно: остальной ответ — рассуждения и пересказ
 * инструментов, которые адресату не предназначались.
 */
export function reportBlockOf(text) {
    for (const m of String(text || "").matchAll(BLOCK_RE)) {
        const body = m[2].trim();
        if (isReportBlock(m[1].trim(), body))
            return body;
    }
    return "";
}

/** Доклад слота со статусом «ЖДУ» (по первой строке). */
export const waitsHead = (text) => WAIT_HEAD_RE.test(String(text || "").split("\n")[0]);
