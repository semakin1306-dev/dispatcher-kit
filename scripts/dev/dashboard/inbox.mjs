// inbox.mjs — файл карточек «Ждут вашего действия» (S.inbox): запись и номер новой карточки.
import { readJson, saveJson } from "./store.mjs";
import path from "node:path";
import { S } from "./state.mjs";
import { DATA } from "./config.mjs";
import { bumpVer } from "./events.mjs";

export const INBOX_FILE = path.join(DATA, "inbox.json");

export const saveInbox = () => {
    bumpVer("inbox");
    saveJson(INBOX_FILE, S.inbox.slice(-60));
};

export const inboxCards = () => S.inbox;

export const addCard = (card) => {
    S.inbox.push(card);
};

export const keepCards = (pred) => {
    S.inbox = S.inbox.filter(pred);
};

export function loadInbox() {
    S.inbox = readJson(INBOX_FILE, []) || [];
}

export const ibId = () => "ib" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
