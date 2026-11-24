import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DASH_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dash-wake-"));
process.env.DASH_DRY = "1";
const L = await import("./loops.mjs");
const A = await import("./agents.mjs");
const { deadlockText } = await import("./deadlock.mjs");
const { slotIdleText } = await import("./slot-rules.mjs");
const { S } = await import("./state.mjs");
const MIN = 60e3;

describe("orchWake — будить или копить (на настоящих текстах)", () => {
    const wake = (t) => L.orchWake(t);
    test("сведения не будят: ворота не пустили лишний прогон, влито по ожиданию", () => {
        assert.deepEqual(wake("[Диспетчерская] Ворота не пустили прогон, который ты поставил строкой ПРОГНАТЬ: «Линтер» у П2 — зелёный (j4614), и после него менялись только файлы вне его области — тесты, документы. Результат на этом коде уже есть (справка слота) — повтор не нужен.").wake, false);
        assert.equal(wake("[Диспетчерская] Влито по ожиданию: «ВЛИТЬ П2» — проверки позеленели, dev/wv-1104 вливается в staging (j4700).").wake, false);
    });
    test("требует решения — будит: доклад слота, пачка, отказ команды, тупик, перезапуск, слот без агента, пауза влива, новая сессия", () => {
        for (const t of ["Ответ слота П5 (wv1107-demo), передан кнопкой дашборда: WV-1107 (слот wv1107-demo): ГОТОВО",
            "Доклады слотов пачкой (3): диспетчерская собрала их в одно сообщение, чтобы не тратить ход на каждый.",
            "[Диспетчерская] Команды не исполнены:\n- «ВЛИТЬ П2»: не исполнено: в ветке есть что вливать",
            deadlockText({ what: "ВЛИТЬ П4", why: "конфликт", n: 3, since: 0, now: 5 * MIN }),
            "[Диспетчерская] Перезапуск диспетчерской прервал исполнение твоих команд — исполнение НЕ подтверждено:\n- «ВЛИТЬ П3»",
            slotIdleText({ tag: "П4", title: "демо", min: 10, jobId: "j1" }),
            "[Диспетчерская] Влив П2 на паузе: регресс красный на этом коде. Слово владельца в силе до 22:28",
            "[Диспетчерская] Ожидание влива снято: П2 — ветка вливается в staging без конфликтов (конфликтуют со staging (1): a.ts)",
            "Новая сессия оркестратора эпика «demo-epic»: прошлая разрослась",
            "[Диспетчерская] «ПРОГНАТЬ П4»: поставлено: lint; не понял: api-test (у «api-test» нужен набор: api-test=…)",
            A.IDLE_NUDGE_TEXT])
            assert.equal(wake(t).wake, true, t.slice(0, 60));
    });
    test("незнакомое (слово владельца, окно диспетчерской, итоги приёмки) — будит", () => {
        assert.equal(wake("п2 почему застрял, тест не поичнились или что там?").wake, true);
        assert.equal(wake("[Диспетчерская] Итоги автоприёмки demo-epic на стенде 18.11 (прогон j4643)").wake, true);
    });
});

describe("сведение копится и уезжает попутно с настоящим поводом", () => {
    test("sendWhenFree: отказ ворот оркестратору — в копилку, не ходом; следующее сообщение несёт его в начале; слоту — как раньше", () => {
        S.orchHeld = {};
        const ORCH = "orchestrator@e9", gate = "[Диспетчерская] Ворота не пустили прогон, который ты поставил строкой ПРОГНАТЬ: «Линтер» у П2 — зелёный (j1).";
        A.sendWhenFree(ORCH, gate);
        A.sendWhenFree(ORCH, gate);
        assert.equal(S.orchHeld[ORCH].length, 1, "одно и то же — один раз");
        const a = { key: ORCH, primer: "" }, msg = A.withPrimer(a, "Ответ слота П2 (wv1): ГОТОВО");
        assert.match(msg, /^── Попутно: сведения диспетчерской/);
        assert.match(msg, /Ворота не пустили прогон/);
        assert.match(msg, /Ответ слота П2 \(wv1\): ГОТОВО$/);
        assert.equal(S.orchHeld[ORCH], undefined, "уехало — копилка пуста");
        assert.equal(A.withPrimer(a, "второе"), "второе", "второй раз не повторяется");
        assert.equal(A.withPrimer({ key: "wv1", primer: "" }, "слоту"), "слоту", "у слота копилки нет");
    });
});

describe("orchNudgeDue — толчок простоя только с новым для оркестратора", () => {
    const now = 10000 * MIN, base = { now, lastWork: now - 30 * MIN, orchSawAt: now - 40 * MIN, lastNudge: 0, slotsWithSession: 3, slotsWaitingOwner: 0 };
    test("слоты работали после его хода и стоят 20+ мин — толкаем", () => assert.equal(L.orchNudgeDue(base).due, true));
    test("он уже ответил после последней работы («ждём: …») — не толкаем, хоть час, хоть пять", () => {
        for (const h of [1, 2, 5])
            assert.equal(L.orchNudgeDue({ ...base, orchSawAt: now - 25 * MIN, lastNudge: now - h * 60 * MIN }).due, false, h + " ч");
        assert.match(L.orchNudgeDue({ ...base, orchSawAt: now - 25 * MIN }).why, /уже отвечал/);
    });
    test("идут прогоны — толчок откладывается", () => assert.match(L.orchNudgeDue({ ...base, liveJobs: 2 }).why, /идут прогоны/));
});

describe("журнал эпика: что будило оркестратора и что снимает правило", () => {
    const evs = fs.readFileSync(new URL("./fixtures/events-demo-epic-evening.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const r = L.orchTurnsReplay(evs);
    const hhmm = (at) => new Date(at + 3 * 3600e3).toISOString().slice(11, 16);
    test("толчки 18:26 и 19:26 после «ждём: …» в 17:26 сняты (пустые ходы по 0,27 млн); 17:26 — был (после 17:13 работали прогоны)", () => {
        const rows = r.rows.map((x) => hhmm(x.at) + (x.cut ? " снят" : "") + (x.act === false ? " пустой" : ""));
        assert.deepEqual(rows.filter((x) => /снят/.test(x)), ["18:26 снят пустой", "19:26 снят пустой"]);
        assert.ok(rows.includes("17:26 пустой"), rows.join(", "));
        assert.equal(r.cutActed.length, 0, "ни одного хода с действием правило не сняло");
        assert.ok(r.cutEmptyCr > 500e3);
    });
    test("ходы по докладам слотов, слову владельца и окну диспетчерской — не трогаются", () => {
        assert.equal(r.byKind.relay.cut, 0);
        assert.equal(r.byKind["owner.answer"].cut, 0);
        assert.equal(r.byKind["dispatcher.message"].cut, 0);
    });
});
