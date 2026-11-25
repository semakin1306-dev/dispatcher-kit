// auto-owner.mjs — режим «без владельца»: пока он включён, вопросы агента получают ответ вариантом, который агент сам
// отметил рекомендованным. Вопросы о деньгах, правах, персональных данных и проде ждут человека. Чистые функции.
import { ownerQuestions, recommended } from "./owner-options.mjs";

export const AUTO_OWNER_HOURS = 12;
export const AUTO_ON_RE = /ночн[а-яё]*\s+режим|без\s+меня|отвечай\s+за\s+меня|разрешай\s+вопрос/i;
export const AUTO_OFF_RE = /я\s+(тут|здесь|вернулся|проснулся)|стоп\s+автоответ|выключи\s+автоответ/i;
export const HUMAN_ONLY_RE = /деньг|денеж|ставк|комисс|выплат|оферт|персональн|согласи|юрид|права\s+доступа|роль|прод\b|в\s+прод|main\b|релиз/i;

export function autoOwnerToggle(text, now = Date.now()) {
    const s = String(text || "");
    if (AUTO_OFF_RE.test(s))
        return 0;
    if (AUTO_ON_RE.test(s))
        return now + AUTO_OWNER_HOURS * 3600e3;
    return null;
}

export function autoAnswer(q) {
    let items = ownerQuestions("Вопросы владельцу:\n" + String(q || ""));
    if (!items.length && String(q || "").trim())
        items = ownerQuestions("Вопросы владельцу:\n1. " + String(q).trim());
    const answers = [], skipped = [];
    for (const it of items) {
        const all = it.text + " " + it.options.map((o) => o.v).join(" ");
        if (HUMAN_ONLY_RE.test(all)) {
            skipped.push(it.n);
            continue;
        }
        const o = recommended(it);
        if (o) {
            answers.push("Вопрос " + it.n + ": (" + o.k + ") " + o.v);
            continue;
        }
        skipped.push(it.n);
    }
    if (!answers.length)
        return null;
    return {
        text:
            "Автоответ владельца (режим «без владельца», рекомендованные варианты): " +
            answers.join("; ") +
            "." +
            (skipped.length ? " Вопросы " + skipped.join(", ") + " ждут владельца — их не трогаю." : ""),
        skipped,
    };
}
