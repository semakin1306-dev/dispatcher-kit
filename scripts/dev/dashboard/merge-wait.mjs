// merge-wait.mjs — хранение ожиданий влива («ВЛИТЬ» при незелёных проверках встаёт в ожидание) и слова владельца по
// слоту до его срока: файл merge-wait.json, переживает перезапуск.
import path from "node:path";
import { S } from "./state.mjs";
import { DATA, logEvent } from "./config.mjs";
import { readJson, saveJson } from "./store.mjs";
import { MERGE_LABEL } from "./loops.mjs";

export const MERGE_WAIT_FILE = path.join(DATA, "merge-wait.json");

export function loadMergeWait() {
    const v = readJson(MERGE_WAIT_FILE, null) || {};
    S.mergeWait = { waits: v.waits || {}, words: v.words || {} };
    // Очередь прогонов перезапуск не переживает (поставленные — «прерван»), а ожидание влива переживает. Без сброса
    // «поставлено на этом коде» и счётчик попыток считали оборванные прогоны: после 2 перезапусков ожидание молча
    // висело до «застряло» (20 мин), хотя проверок не было. Ставим заново.
    for (const w of Object.values(S.mergeWait.waits)) {
        if (w && w.state === "wait") {
            delete w.queuedFp;
            delete w.queuedAt;
            w.tries = 0;
        }
    }
}

const st = () => {
    if (!S.mergeWait)
        S.mergeWait = { waits: {}, words: {} };
    return S.mergeWait;
};

const save = () => saveJson(MERGE_WAIT_FILE, st());
export const mergeWaitOf = (key) => st().waits[key] || null;
export const mergeWaits = () => Object.entries(st().waits).map(([key, w]) => ({ key, ...w }));

export function setMergeWait(key, w) {
    st().waits[key] = w;
    save();
}

export function dropMergeWait(key, { word = false, why = "", by = "" } = {}) {
    const had = !!st().waits[key], hadWord = word && !!st().words[key];
    delete st().waits[key];
    if (word)
        delete st().words[key];
    if (had || hadWord) {
        save();
        logEvent("merge.wait.off", { tree: key, why: String(why).slice(0, 200), by, word: !!hadWord });
    }
    return had;
}

export function keepMergeWord(key, word) {
    st().words[key] = word;
    save();
}

export function mergeWordOf(key, now = Date.now()) {
    const w = st().words[key];
    return w && (!w.until || now <= w.until) ? w : null;
}

const hhmm = (at) => new Date(at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

export function mergeWaitView(key) {
    const w = mergeWaitOf(key);
    if (!w)
        return null;
    const need = (w.need || []).map((id) => MERGE_LABEL[id] || id);
    const text = w.state === "red"
        ? "ВЛИТЬ на паузе (слово владельца до " + hhmm(w.until) + "): " + (w.why || "красное на этом коде") + ". Поправят код — ожидание продолжится само"
        : "ВЛИТЬ ждёт зелёного" + (need.length ? ": " + need.join(", ") : "") + (w.why ? " — " + w.why : "") + ". Вольётся само до " + hhmm(w.until);
    return { state: w.state, need, why: w.why || "", until: w.until, at: w.at, orch: w.orch, text };
}
