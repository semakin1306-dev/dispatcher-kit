import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPrevStop, exitRecord, pcGap, PC_GAP_MS, refineStop, winStopArgs, winStopEvents } from "./lifecycle-rules.mjs";

const prev = { pid: 40460, at: 1000000 };
test("первый запуск: прошлого пульса нет", () => assert.equal(classifyPrevStop({ prev: null, prevExit: null, bootAt: 5e6 }).kind, "first"));

test("исключение — crash с текстом; запись другого pid не относится к прошлому процессу", () => {
    const e = exitRecord({ pid: 40460, now: 1000500, err: new Error("boom"), origin: "unhandledRejection" });
    const v = classifyPrevStop({ prev, prevExit: e, bootAt: 1020000 });
    assert.equal(v.kind, "crash");
    assert.match(v.why, /boom/);
    assert.match(v.why, /unhandledRejection/);
    assert.notEqual(classifyPrevStop({ prev, prevExit: { ...e, pid: 1 }, bootAt: 1020000 }).kind, "crash", "чужая запись не считается");
});

test("сигнал: закрыто окно консоли (SIGBREAK/SIGHUP) называется прямо", () => {
    const v = classifyPrevStop({ prev, prevExit: exitRecord({ pid: 40460, now: 1001000, signal: "SIGBREAK" }), bootAt: 1100000 });
    assert.equal(v.kind, "signal");
    assert.match(v.why, /закрыто окно консоли/);
    assert.match(classifyPrevStop({ prev, prevExit: exitRecord({ pid: 40460, now: 1, signal: "SIGTERM" }), bootAt: 1100000 }).why, /снаружи/);
});

test("перезапуск скриптом: причина из окружения; запись о выходе без сигнала и ошибки — clean", () => {
    assert.equal(classifyPrevStop({ prev, prevExit: null, bootAt: 1060000, envReason: "restart-dashboard: код слота" }).kind, "restart-script");
    assert.equal(classifyPrevStop({ prev, prevExit: exitRecord({ pid: 40460, now: 1, code: 0 }), bootAt: 1060000 }).kind, "clean");
});

test("без записи о выходе: долгое молчание — gap (kill, питание, сон), короткое — quick", () => {
    const g = classifyPrevStop({ prev, prevExit: null, bootAt: 1000000 + 1303e3 });
    assert.equal(g.kind, "gap");
    assert.match(g.why, /1303 с/);
    assert.equal(classifyPrevStop({ prev, prevExit: null, bootAt: 1000000 + 40e3 }).kind, "quick");
});

test("лаг цикла событий ≥ 45 с — событие pc.gap (сон ПК или заморозка); меньший — нет", () => {
    assert.equal(pcGap(PC_GAP_MS - 1), null);
    const g = pcGap(120000);
    assert.equal(g.lagMs, 120000);
    assert.match(g.hint, /120 с/);
});

const ev = (id, iso, p1 = "") =>
    "<Event xmlns='x'><System><EventID" +
    (id === 1074 ? " Qualifiers='32768'" : "") +
    ">" +
    id +
    "</EventID><TimeCreated SystemTime='" +
    iso +
    "'/></System><EventData><Data Name='param1'>" +
    p1 +
    "</Data></EventData></Event>";

test("winStopEvents: id, время и кто выключил — без зависимости от языка Windows", () => {
    const e = winStopEvents(ev(41, "2026-11-12T11:13:08.3Z") + "\n" + ev(1074, "2026-11-13T21:32:58.3Z", "C:\\Windows\\System32\\RuntimeBroker.exe (DESKTOP-X)"));
    assert.deepEqual(e.map((x) => x.id), [41, 1074]);
    assert.equal(e[1].proc, "RuntimeBroker.exe");
    assert.equal(e[0].at, Date.parse("2026-11-12T11:13:08.3Z"));
    assert.deepEqual(winStopEvents(""), []);
    assert.deepEqual(winStopEvents("мусор"), []);
});

test("refineStop: 1074 в окне — pc-off с меню «Пуск»; 41 — pc-crash; вне окна и не gap — как было", () => {
    const prevAt = Date.parse("2026-11-13T21:30:00Z"), bootAt = Date.parse("2026-11-14T08:16:00Z"), gap = { kind: "gap", why: "молчал 38655 с" };
    const off = refineStop(gap, winStopEvents(ev(1074, "2026-11-13T21:32:58Z", "C:\\Windows\\System32\\RuntimeBroker.exe (PC)")), { prevAt, bootAt });
    assert.equal(off.kind, "pc-off");
    assert.match(off.why, /меню «Пуск»/);
    assert.match(off.why, /молчал 38655 с/);
    const cr = refineStop(gap, winStopEvents(ev(41, "2026-11-14T08:10:00Z")), { prevAt, bootAt });
    assert.equal(cr.kind, "pc-crash");
    assert.match(cr.why, /Kernel-Power 41/);
    assert.equal(refineStop(gap, winStopEvents(ev(41, "2026-11-10T08:10:00Z")), { prevAt, bootAt }), gap, "старое событие не в счёт");
    const rs = { kind: "restart-script", why: "x" };
    assert.equal(refineStop(rs, winStopEvents(ev(41, "2026-11-14T08:10:00Z")), { prevAt, bootAt }), rs);
});

test("winStopArgs: запрос с минутой запаса до прошлого пульса", () => {
    const a = winStopArgs(Date.parse("2026-11-13T21:30:00Z"));
    assert.equal(a[0], "qe");
    assert.match(a[2], /EventID=1074 or EventID=41 or EventID=6008/);
    assert.match(a[2], /2026-11-13T21:29:00/);
});
