// ui-shared.mjs — файлы страницы, которые живут в других модулях диспетчерской: сервер отдаёт их под /ui/ рядом с
// ui/*.js, проверка модулей страницы видит их экспорт. Лист: ничего из диспетчерской не импортирует.
import { fileURLToPath } from "node:url";

const at = (rel) => fileURLToPath(new URL(rel, import.meta.url));
/** имя под /ui/ → абсолютный путь файла. owner-options.js — разбор «Вопросов владельцу» в варианты: один на страницу и на автоответ сервера. */
export const UI_SHARED = { "owner-options.js": at("./owner-options.mjs") };
