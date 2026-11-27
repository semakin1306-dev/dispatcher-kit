// epic-journal.mjs — журнал эпика: выборка событий диспетчерской по эпику. Эпик события определяется по ключу слота или
// агента; сбой определения журнал не роняет.
export const EPIC_FIELDS = ["epic", "tree", "key", "slot", "orch", "from", "to"];

export const GLOBAL_EVENTS = new Map([
    ["dispatcher.inbox", "сообщение владельца агенту-диспетчеру — он один на установку, не эпика"],
    ["dispatcher.run", "обход агента-диспетчера вне расписания — по всем эпикам"],
    ["fullrun.start", "полный прогон по частям — на коммите staging, не эпика"],
    ["fullrun.enqueue.fail", "полный прогон: часть не встала в очередь"],
    ["fullrun.cancel", "полный прогон остановлен"],
    ["fullrun.retry", "полный прогон: повтор окружного падения на этой машине"],
    ["fullrun.done", "полный прогон закончен"],
    ["server.pulse", "пульс сервера раз в минуту"],
    ["slow.loop", "задержка цикла сервера"],
    ["server.start", "запуск диспетчерской"],
    ["restart.interrupted", "оборвано перезапуском"],
    ["drain", "подготовка к перезапуску"],
    ["pc.gap", "ПК спал"],
    ["logs.rotated", "уборка логов"],
    ["events.rotated", "уборка журнала"],
    ["jobs.infra-migrated", "перевод старых прогонов"],
    ["graph.queue", "очередь записи в граф"],
    ["graph.server", "сервер графа"],
    ["ssh.gate", "очередь ssh"],
    ["host.state", "машина прогонов"],
    ["host.reason", "машина прогонов"],
    ["settings", "настройки панели"],
    ["merge.auto.toggle", "выключатель автовлива (20.11)"],
    ["slot.sync.auto.toggle", "выключатель автоподтягивания (20.11)"],
    ["auto.owner.mode", "режим «без владельца»"],
    ["accept.synced", "чек-листы приёмки (по волнам)"],
    ["release.notes", "заметки релиза"],
    ["backlog.add", "бэклог (вне эпика)"],
    ["backlog.set", "бэклог (вне эпика)"],
    ["backlog.sent", "бэклог (вне эпика)"],
    ["backlog.tree", "дерево агента бэклога"],
    ["warm.auto", "подогрев кеша"],
    ["hawk.intake", "ошибки прода (Hawk) — бэклог"],
    ["machine.relay", "реле машин"],
    ["deadline.hit", "сроки ожиданий"],
    ["retro.start", "ретро — поле epic ставится явно"],
    ["state.corrupt", "битый файл состояния"],
    ["hygiene.run", "уборка деревьев (все слоты)"],
    ["hygiene.done", "уборка деревьев (все слоты)"],
    ["train.run", "поезд влива: несколько слотов (ключи — в keys)"],
    ["tg.status", "бот владельца в Telegram: связь (один на все эпики)"],
    ["tg.reject", "бот в Telegram: чужой отправитель"],
    ["tg.error", "бот в Telegram: отказ запроса"],
]);

export const GLOBAL_IN_JOURNAL = new Set(["server.start", "restart.interrupted", "drain", "host.state", "host.reason", "pc.gap", "auto.owner.mode"]);

export function eventEpic(data, epicOf) {
    if (!data || typeof data !== "object")
        return null;
    if (data.epic)
        return String(data.epic);
    for (const f of EPIC_FIELDS.slice(1)) {
        const v = data[f];
        if (typeof v === "string" && v) {
            const id = epicOf(v);
            if (id)
                return id;
        }
    }
    return null;
}

export function brief(text, n = 140) {
    const s = String(text || "").replace(/```[\s\S]*?```/g, " [блок] ").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function journalOf(events, { epic, keys = [], from = 0, to = Infinity, types = null, limit = 0 } = {}) {
    const ks = new Set([...keys, "orchestrator@" + epic]);
    const mine = (e) => {
        if (e.epic)
            return e.epic === epic;
        if (EPIC_FIELDS.slice(1).some((f) => typeof e[f] === "string" && ks.has(e[f])))
            return true;
        return GLOBAL_IN_JOURNAL.has(e.type);
    };
    const out = [];
    for (const e of events) {
        if (!e || !e.at || e.at < from || e.at > to)
            continue;
        if (types && !types.includes(e.type))
            continue;
        if (mine(e))
            out.push(e);
    }
    out.sort((a, b) => a.at - b.at);
    return limit > 0 ? out.slice(-limit) : out;
}

const hhmm = (at) => {
    const d = new Date(at + 3 * 3600e3);
    const iso = d.toISOString();
    return iso.slice(8, 10) + "." + iso.slice(5, 7) + " " + iso.slice(11, 16);
};

const who = (k) => (typeof k === "string" ? k.replace(/^orchestrator@.*/, "ОРК") : "");

export function journalLine(e) {
    const pair = e.from || e.to ? who(e.from || "") + " → " + who(e.to || "") : who(e.tree || e.key || e.slot || "");
    const what =
        e.brief ||
        e.detail ||
        e.why ||
        e.summary ||
        (e.cmd ? e.cmd + " " + (e.target || "") + (e.ok === false ? " — отказ" : "") : "") ||
        (e.task ? e.task + (e.status ? " " + e.status : "") : "") ||
        (e.verdict ? "вердикт " + e.verdict : "");
    const size = e.chars ? " (" + e.chars + " зн.)" : e.sec ? " (" + e.sec + " с)" : "";
    return hhmm(e.at) + " " + e.type + (pair.trim() ? " " + pair : "") + (what ? ": " + String(what).replace(/\s+/g, " ").slice(0, 200) : "") + size;
}

export function journalCounts(evs) {
    const m = {};
    for (const e of evs)
        m[e.type] = (m[e.type] || 0) + 1;
    return m;
}
