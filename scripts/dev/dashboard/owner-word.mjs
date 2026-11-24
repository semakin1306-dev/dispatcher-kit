// owner-word.mjs — полномочия слова владельца по источнику. Команда оркестратора, которая меняет ветки или выкатывает,
// исполняется только при слове владельца, и не всякое слово годится для всякого действия: набранное человеком на странице
// даёт всё; ответ из бота и автоответ режима «без владельца» — только ответ на вопрос, коммит и влив в staging. Выкат,
// сброс ветки слота и «принудительно» — только то, что человек набрал сам.
// Источник пишется в пометку `by` сообщения агенту: "" — набрал человек, "tg" — ответ из бота, "auto-owner" — автоответ.
// Кого нет в таблице, тот слова не даёт вовсе. Чистый модуль без импортов.

export const WORD_ACTIONS = ["answer", "merge", "commit", "force", "reset", "stand", "prod"];
const ALL = new Set(WORD_ACTIONS);
const WORD_GRANTS = { "": ALL, tg: new Set(["answer", "merge", "commit"]), "auto-owner": new Set(["answer", "merge", "commit"]) };

/** Даёт ли слово из источника `by` право на действие `action` (одно из WORD_ACTIONS). */
export const wordGrants = (by, action) => {
    const k = by || "";
    return Object.hasOwn(WORD_GRANTS, k) && WORD_GRANTS[k].has(action);
};

/** Действие кнопки конвейера (влив, стенд, прод) → право из таблицы. Неизвестное действие требует самого строгого права. */
export const pipelineAction = (action, force = false) => ({ merge: force ? "force" : "merge", "deploy-staging": "stand", release: "prod" })[action] || "prod";

/**
 * Приписка к ответу, пришедшему не со страницы: агент видит источник. В приписке нет слов-ключей влива, выката и
 * «принудительно» — иначе сама приписка стала бы словом.
 */
export const VIA_NOTE = {
    tg: "\n\n(Ответ пришёл из Telegram. Для стенда, прода, возврата ветки назад и снятия проверок нужен ответ человека на странице диспетчерской.)",
};
export const viaNote = (via) => (via && Object.hasOwn(VIA_NOTE, via) ? VIA_NOTE[via] : "");
