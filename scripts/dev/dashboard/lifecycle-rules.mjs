// lifecycle-rules.mjs — почему остановился прошлый экземпляр сервера: при выходе процесс синхронно пишет причину (код,
// сигнал, исключение), следующий запуск сводит её с последним пульсом и называет причину остановки в событии старта.
export const GAP_SILENT_S = 120;

export function exitRecord({ pid, now, code = null, signal = "", err = null, origin = "" }) {
    return { pid, at: now, code, signal, ...(err ? { error: String(err && err.stack || err).split("\n").slice(0, 4).join(" | ").slice(0, 500), origin } : {}) };
}

export function classifyPrevStop({ prev, prevExit, bootAt, envReason = "" }) {
    if (!prev || !prev.at)
        return { kind: "first", why: "первый запуск (прошлого пульса нет)" };
    const silentS = Math.round((bootAt - prev.at) / 1000);
    if (prevExit && prevExit.pid === prev.pid) {
        if (prevExit.error)
            return { kind: "crash", why: "прошлый процесс упал: " + prevExit.error.slice(0, 200) + (prevExit.origin ? " (" + prevExit.origin + ")" : "") };
        if (prevExit.signal)
            return {
                kind: "signal",
                why:
                    "прошлый процесс получил " +
                    prevExit.signal +
                    (/SIGBREAK|SIGHUP/.test(prevExit.signal)
                        ? " — закрыто окно консоли или выход из сеанса Windows"
                        : prevExit.signal === "SIGTERM"
                          ? " — его остановили снаружи"
                          : prevExit.signal === "SIGINT"
                            ? " — Ctrl+C"
                            : ""),
            };
        if (envReason)
            return { kind: "restart-script", why: envReason };
        return { kind: "clean", why: "прошлый процесс вышел сам (код " + prevExit.code + ")" };
    }
    if (envReason)
        return { kind: "restart-script", why: envReason + (silentS > GAP_SILENT_S ? "; прошлый процесс молчал " + silentS + " с" : "") };
    if (silentS > GAP_SILENT_S)
        return { kind: "gap", why: "прошлый процесс пропал без записи о выходе и молчал " + silentS + " с: убит снаружи (kill, перезагрузка), выключили питание или ПК спал" };
    return { kind: "quick", why: "прошлый процесс замолчал " + silentS + " с назад без записи о выходе (быстрый перезапуск или kill)" };
}

export const PC_GAP_MS = 45000;
export const pcGap = (lagMs) => lagMs >= PC_GAP_MS ? { lagMs, hint: "цикл событий стоял " + Math.round(lagMs / 1000) + " с: сон ПК, заморозка процесса или полная загрузка диска" } : null;
export const WIN_STOP_IDS = [1074, 41, 6008];

export function winStopArgs(fromMs) {
    const iso = new Date(Math.max(0, fromMs - 60e3)).toISOString();
    return ["qe", "System", "/q:*[System[(" + WIN_STOP_IDS.map((id) => "EventID=" + id).join(" or ") + ") and TimeCreated[@SystemTime>='" + iso + "']]]", "/c:20", "/rd:true", "/f:xml"];
}

export function winStopEvents(xml) {
    const out = [];
    for (const part of String(xml || "").split("<Event ").slice(1)) {
        const id = Number((/<EventID[^>]*>(\d+)<\/EventID>/.exec(part) || [])[1]), at = Date.parse((/SystemTime='([^']+)'/.exec(part) || [])[1] || "");
        if (!id || !Number.isFinite(at))
            continue;
        const proc = id === 1074 ? String((/<Data Name='param1'>([^<]*)<\/Data>/.exec(part) || [])[1] || "").replace(/\s*\([^)]*\)\s*$/, "").split(/[\\/]/).pop() : "";
        out.push({ id, at, proc });
    }
    return out.sort((a, b) => a.at - b.at);
}

const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);

export function refineStop(stop, events, { prevAt, bootAt }) {
    if (!stop || !["gap", "quick"].includes(stop.kind) || !prevAt)
        return stop;
    const win = (events || []).filter((e) => e.at >= prevAt - 60e3 && e.at <= bootAt);
    const off = win.find((e) => e.id === 1074), crash = win.find((e) => e.id === 41 || e.id === 6008);
    if (off && (!crash || off.at <= crash.at))
        return {
            kind: "pc-off",
            why:
                "ПК выключили или перезагрузили штатно в " +
                hhmm(off.at) +
                (off.proc ? " (" + off.proc + (off.proc === "RuntimeBroker.exe" ? " — меню «Пуск»" : "") + ")" : "") +
                ", слива перед этим не было; прежде: " +
                stop.why,
            winAt: off.at,
        };
    if (crash)
        return {
            kind: "pc-crash",
            why:
                "ПК перезагрузился аварийно (Kernel-Power " +
                crash.id +
                " при загрузке в " +
                hhmm(crash.at) +
                "): зависание, сброс кнопкой или питание; журналы последних минут могли получить нули; прежде: " +
                stop.why,
            winAt: crash.at,
        };
    return stop;
}
