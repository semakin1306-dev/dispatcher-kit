// orchlog.mjs — журнал команд оркестратора: команда записывается до исполнения и закрывается итогом. После перезапуска
// сервера прерванные команды возвращаются оркестратору отказом, а законченный, но не разобранный ход перечитывается из
// файла сессии. Здесь же последнее слово владельца каждому оркестратору — основание для команд, которые меняют ветки.
import crypto from "node:crypto";
import path from "node:path";
import { S } from "./state.mjs";
import { readJson, saveJson, writeJsonSync } from "./store.mjs";
import { DATA, DRY } from "./config.mjs";

export const ORCH_LOG_FILE = path.join(DATA, "orch-commands.json");
const KEEP = 400, KEEP_MS = 14 * 86400e3;
const canWrite = () => !DRY || !!process.env.DASH_DATA;
const log = () => S.orchLog || loadOrchLog();

function trim(now = Date.now()) {
    const L = S.orchLog;
    L.items = L.items.filter((x) => x.state === "run" || now - (x.at || 0) < KEEP_MS).slice(-KEEP);
}

const persistSync = () => {
    if (!canWrite())
        return;
    trim();
    writeJsonSync(ORCH_LOG_FILE, S.orchLog);
};

const persist = () => {
    if (!canWrite())
        return;
    trim();
    saveJson(ORCH_LOG_FILE, S.orchLog);
};

export const cmdKey = (turn, text, index) => (turn ? String(turn) : crypto.createHash("sha1").update(String(text || "")).digest("hex").slice(0, 12)) + "@" + index;

export function loadOrchLog(now = Date.now()) {
    const v = readJson(ORCH_LOG_FILE, null);
    S.orchLog = v && Array.isArray(v.items) ? { since: v.since || now, items: v.items, turns: v.turns || {}, owner: v.owner || {}, real: v.real || {} } : { since: now, items: [], turns: {}, owner: {}, real: {} };
    if (!v)
        persistSync();
    return S.orchLog;
}

export const orchLogSince = () => log().since;
export const orchLogItems = () => log().items;

export function cmdBegin({ key, orch, cmd, target, line }, now = Date.now()) {
    const L = log();
    if (L.items.some((x) => x.id === key))
        return false;
    L.items.push({ id: key, at: now, orch, cmd, target, line: String(line || "").slice(0, 200), state: "run" });
    persistSync();
    return true;
}

export function cmdEnd(key, ok, detail, now = Date.now()) {
    const x = log().items.find((i) => i.id === key);
    if (!x || x.state !== "run")
        return;
    x.state = ok ? "ok" : "fail";
    x.detail = String(detail || "").slice(0, 300);
    x.endAt = now;
    persistSync();
}

export function takeInterrupted(now = Date.now()) {
    const cut = log().items.filter((x) => x.state === "run");
    for (const x of cut) {
        x.state = "fail";
        x.detail = "прервано перезапуском диспетчерской: исполнение не подтверждено";
        x.endAt = now;
    }
    if (cut.length)
        persistSync();
    return cut.map((x) => ({ ...x }));
}

export const lastTurnSeen = (orch) => log().turns[orch] || 0;

export function turnSeen(orch, at = Date.now()) {
    const L = log();
    if ((L.turns[orch] || 0) >= at)
        return;
    L.turns[orch] = at;
    persist();
}

export function ownerSaid(orch, text, at = Date.now(), by = "") {
    const L = log(), v = { text: String(text || "").slice(0, 2000), at, ...(by ? { by } : {}) };
    L.owner[orch] = v;
    if (!by)
        (L.real ||= {})[orch] = v;
    persist();
}

export const ownerWord = (orch, { real = false } = {}) => (real ? (log().real || {})[orch] : log().owner[orch]) || null;
