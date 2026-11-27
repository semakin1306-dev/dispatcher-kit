// dispatcher-agent.mjs — агент-диспетчер в списке чатов: лента его обходов (журналы-файлы), входящие от владельца,
// запуск обхода вне расписания. Сам агент живёт вне дашборда (разовая сессия по таймеру systemd --user); здесь — только
// чтение его журналов и две ручки. Пути и имя юнита — из окружения службы дашборда, по умолчанию:
//   DASH_DISPATCHER_JOURNALS = <DATA>/night-watch      — журналы обходов <ГГГГ-ММ-ДД>_<ЧЧММ>[-dry].md
//   DASH_DISPATCHER_UNIT     = dispatcher-night-watch  — <юнит>.service (обход) и <юнит>.timer (расписание)
// Каталога журналов нет — агента нет: список чатов его не показывает.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { DATA, logEvent } from "./config.mjs";
import { saveJson } from "./store.mjs";

export const DISPATCHER_DIR = process.env.DASH_DISPATCHER_JOURNALS || path.join(DATA, "night-watch");
export const DISPATCHER_UNIT = process.env.DASH_DISPATCHER_UNIT || "dispatcher-night-watch";
export const DISPATCHER_INBOX = path.join(DATA, "dispatcher-inbox.jsonl");
const FORCE_FLAG = () => path.join(DISPATCHER_DIR, ".force-once");
const MAX_MD = 24000;

export const dispatcherEnabled = (dir = DISPATCHER_DIR) => {
    try {
        return fs.statSync(dir).isDirectory();
    }
    catch {
        return false;
    }
};

/** Журнал обхода по имени файла: время из имени, «сухой», «значимое» из текста, разметка без служебных комментариев. */
export function parseJournal(name, text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(-dry)?\.md$/.exec(name);
    if (!m)
        return null;
    const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
    // до первого заголовка «## » — служебный вывод CLI (предупреждения о правилах разрешений и т.п.), не отчёт
    const clean = String(text || "").replace(/<!--[\s\S]*?-->/g, "").split("\n")
        .filter((l) => !/^Permission (allow|deny|ask) rule \(/.test(l)).join("\n").trim();
    const h = clean.search(/^## /m);
    const body = (h > 0 ? clean.slice(h) : clean).trim();
    const sig = /\*\*Значимое:?\*\*:?\s*(да|нет)/i.exec(body);
    const code = /<!--\s*конец,\s*код\s*(\d+)\s*-->/.exec(String(text || ""));
    return {
        file: name,
        at,
        dry: !!m[6],
        title: "Обход " + m[4] + ":" + m[5] + (m[6] ? " (сухой)" : ""),
        significant: sig ? sig[1].toLowerCase() === "да" : null,
        code: code ? +code[1] : null,
        running: !code,
        limit: /hit your .{0,20}limit|usage limit|лимит токенов/i.test(body),
        md: body.length > MAX_MD ? body.slice(0, MAX_MD) + "\n\n…(журнал обрезан, полный — в файле " + name + ")" : body,
    };
}

export function readJournals(dir = DISPATCHER_DIR, limit = 40) {
    let names = [];
    try {
        names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}_\d{4}(-dry)?\.md$/.test(n)).sort().reverse().slice(0, limit);
    }
    catch {
        return [];
    }
    const out = [];
    for (const n of names) {
        let t = "";
        try {
            t = fs.readFileSync(path.join(dir, n), "utf8");
        }
        catch {
            continue;
        }
        const j = parseJournal(n, t);
        if (j)
            out.push(j);
    }
    return out;
}

export function readInbox(file = DISPATCHER_INBOX) {
    let raw = "";
    try {
        raw = fs.readFileSync(file, "utf8");
    }
    catch {
        return [];
    }
    return raw.split("\n").filter(Boolean).map((l) => {
        try {
            return JSON.parse(l);
        }
        catch {
            return null;
        }
    }).filter((x) => x && x.text);
}

const sh = (args) => new Promise((res) => execFile("systemctl", ["--user", ...args], { timeout: 8000 }, (err, out) => res(String(out || ""))));
let unitCache = { at: 0, v: null };

/** Расписание и состояние юнита (кэш 20 с): идёт ли обход сейчас, когда следующий и прошлый. */
export async function unitState(unit = DISPATCHER_UNIT) {
    if (unitCache.v && Date.now() - unitCache.at < 20e3)
        return unitCache.v;
    const [svc, tim] = await Promise.all([
        sh(["show", unit + ".service", "-p", "ActiveState", "-p", "ExecMainStartTimestamp"]),
        sh(["show", unit + ".timer", "-p", "ActiveState", "-p", "NextElapseUSecRealtime", "-p", "LastTriggerUSec"]),
    ]);
    const kv = (s) => Object.fromEntries(s.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    const a = kv(svc), b = kv(tim);
    const ts = (v) => {
        const t = Date.parse(String(v || "").replace(/^\w{2,3}\s/, "").replace(/\s[A-Z]{2,5}$/, ""));
        return Number.isFinite(t) ? t : null;
    };
    let next = ts(b.NextElapseUSecRealtime);
    if (!next && b.ActiveState === "active") {
        // таймер «от прошлого запуска» (OnUnitActiveSec): абсолютного времени в свойствах нет — берём из list-timers
        const lt = (await sh(["list-timers", "--no-legend", "--all", unit + ".timer"])).trim().split(/\s+/);
        if (lt.length > 3 && /^\d{4}-\d{2}-\d{2}$/.test(lt[1]))
            next = ts(lt.slice(0, 4).join(" "));
    }
    const v = {
        running: a.ActiveState === "activating" || a.ActiveState === "active",
        timer: b.ActiveState === "active",
        next,
        last: ts(b.LastTriggerUSec),
    };
    unitCache = { at: Date.now(), v };
    return v;
}

export async function dispatcherState({ limit = 40 } = {}) {
    if (!dispatcherEnabled())
        return { enabled: false };
    const inbox = readInbox();
    return {
        enabled: true,
        unit: DISPATCHER_UNIT,
        journals: readJournals(DISPATCHER_DIR, limit),
        inbox: inbox.filter((m) => !m.read).map(({ id, at, text }) => ({ id, at, text })),
        replied: inbox.filter((m) => m.read).slice(-20).map(({ id, at, text, readAt }) => ({ id, at, text, readAt })),
        forceQueued: fs.existsSync(FORCE_FLAG()),
        ...(await unitState()),
    };
}

/** Сообщение владельца → входящие диспетчера: обход читает их первым пунктом и помечает прочитанными. */
export function dispatcherSend(text, { file = DISPATCHER_INBOX, by = "страница" } = {}) {
    const t = String(text || "").trim();
    if (!t)
        return { code: 400, body: { error: "пустое сообщение" } };
    if (t.length > 4000)
        return { code: 400, body: { error: "слишком длинно (больше 4000 знаков)" } };
    const m = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), text: t, read: false, by };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(m) + "\n", { mode: 0o600 });
    logEvent("dispatcher.inbox", { id: m.id, chars: t.length, by });
    return { code: 200, body: { ok: true, id: m.id } };
}

/** Обход вне расписания. force — и при выключенном ночном режиме (флаг на один запуск; обёртка его читает и удаляет). */
export async function dispatcherRunNow({ force = false, by = "страница" } = {}) {
    if (!dispatcherEnabled())
        return { code: 404, body: { error: "агента-диспетчера нет (нет каталога журналов " + DISPATCHER_DIR + ")" } };
    const st = await unitState();
    if (st.running)
        return { code: 409, body: { error: "обход уже идёт" } };
    if (force)
        saveJson(FORCE_FLAG(), { at: Date.now(), by });
    const args = ["--user", "start", "--no-block", DISPATCHER_UNIT + ".service"];
    const r = await new Promise((res) => execFile("systemctl", args, { timeout: 10000 }, (err, out, er) => {
        res({ ok: !err, err: String(er || (err && err.message) || "").trim() });
    }));
    unitCache = { at: 0, v: null };
    logEvent("dispatcher.run", { force, by, ok: r.ok });
    if (!r.ok)
        return { code: 500, body: { error: "не запустился: " + r.err } };
    return { code: 200, body: { ok: true, message: "обход запущен" + (force ? " (без проверки ночного режима)" : "") } };
}
