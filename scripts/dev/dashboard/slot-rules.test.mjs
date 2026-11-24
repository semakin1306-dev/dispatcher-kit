import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PROVISION_RETRY_MS, areaRefusal, prepNext, provisionArgs, provisionDue, relayToSlot, slotEnvNote } from "./slot-rules.mjs";

const NOW = 1794231000000, MIN = 60000;
let seq = 1;
const up = (status, o = {}) => ({ id: "j" + seq++, task: "slot-up", tree: "wv1009", status, endedAt: NOW - 30 * MIN, ...o });
const due = (o) => provisionDue({ archived: false, missing: false, jobs: [], now: NOW, drain: null, ...o });

describe("provisionDue — папки нет", () => {
    test("ни одной подготовки — поднять", () => {
        assert.equal(due({ missing: true }).due, true);
    });
    test("в архиве — не поднимать", () => {
        assert.equal(due({ missing: true, archived: true }).due, false);
    });
    test("готовится перезапуск (drain) — не ставить, подготовка тоже ждёт", () => {
        const r = due({ missing: true, drain: { since: NOW, by: "restart-dashboard" } });
        assert.equal(r.due, false);
        assert.match(r.why, /перезапуск/);
    });
    test("уже идёт или в очереди — второй не нужен", () => {
        for (const s of ["queued", "waiting", "running"])
            assert.equal(due({ missing: true, jobs: [up(s, { endedAt: undefined })] }).due, false, s);
    });
    test("недавно прошла — не повторять 10 мин (папку видно не сразу)", () => {
        assert.equal(due({ missing: true, jobs: [up("ok", { endedAt: NOW - 2 * MIN })] }).due, false);
        assert.equal(due({ missing: true, jobs: [up("ok", { endedAt: NOW - 11 * MIN })] }).due, true);
    });
});

describe("provisionDue — папка есть, последняя подготовка не прошла", () => {
    test("последняя зелёная — слот готов", () => {
        assert.equal(due({ jobs: [up("fail"), up("ok")] }).due, false);
    });
    test("никогда не готовили (слот заведён руками) — не трогать", () => {
        assert.equal(due({ jobs: [] }).due, false);
    });
    test("оборвана перезапуском — повторить сразу, с --reuse", () => {
        const r = due({ jobs: [up("interrupted", { bootInterrupted: true, endedAt: NOW - 1 * MIN })] });
        assert.equal(r.due, true);
        assert.equal(r.reuse, true);
    });
    test("упала или прервана — не чаще раза в 10 мин", () => {
        for (const s of ["fail", "interrupted"]) {
            assert.equal(due({ jobs: [up(s, { endedAt: NOW - 3 * MIN })] }).due, false, s);
            assert.equal(due({ jobs: [up(s, { endedAt: NOW - PROVISION_RETRY_MS - 1 })] }).due, true, s);
        }
    });
    test("отменена владельцем — сама не повторяется", () => {
        assert.equal(due({ jobs: [up("cancelled", { endedAt: NOW - 60 * MIN })] }).due, false);
    });
    test("две неудачи подряд после последней зелёной — не повторять, а «Требует внимания» с журналом последней", () => {
        const last = up("fail", { endedAt: NOW - 60 * MIN });
        const r = due({ jobs: [up("ok"), up("fail", { endedAt: NOW - 90 * MIN }), last] });
        assert.equal(r.due, false);
        assert.equal(r.attention, true);
        assert.equal(r.jobId, last.id);
        assert.match(r.why, /2 раза/);
    });
    test("ветка уже влита в staging — папку не достраивать", () => {
        assert.equal(due({ merged: true, jobs: [up("interrupted", { bootInterrupted: true, endedAt: NOW - 1 * MIN })] }).due, false);
    });
    test("обрыв перезапуском неудачей не считается", () => {
        const r = due({ jobs: [up("fail", { endedAt: NOW - 90 * MIN }), up("interrupted", { bootInterrupted: true, endedAt: NOW - 1 * MIN })] });
        assert.equal(r.due, true);
        assert.ok(!r.attention);
    });
    test("давняя неудача (больше суток) у папки, что есть, — не трогать: волна живёт дальше или давно влита", () => {
        assert.equal(due({ jobs: [up("fail", { endedAt: NOW - 25 * 60 * MIN })] }).due, false);
        assert.equal(due({ jobs: [up("fail", { endedAt: NOW - 50 * 60 * MIN }), up("fail", { endedAt: NOW - 49 * 60 * MIN })] }).attention, undefined);
        assert.equal(prepNext({ jobs: [up("interrupted", { bootInterrupted: true, endedAt: NOW - 26 * 60 * MIN })], now: NOW }), null);
    });
    test("папки нет и две неудачи подряд — тоже внимание, а не круг", () => {
        const r = due({ missing: true, jobs: [up("fail", { endedAt: NOW - 90 * MIN }), up("fail", { endedAt: NOW - 60 * MIN })] });
        assert.equal(r.due, false);
        assert.equal(r.attention, true);
    });
});

describe("prepNext — следующий шаг слота с недоделанной подготовкой (view.mjs)", () => {
    test("последняя подготовка зелёная или её не было — своего шага нет", () => {
        assert.equal(prepNext({ jobs: [up("ok")], now: NOW }), null);
        assert.equal(prepNext({ jobs: [], now: NOW }), null);
    });
    test("идёт — справка, без кнопки", () => {
        const n = prepNext({ jobs: [up("running")], now: NOW });
        assert.equal(n.kind, "info");
        assert.equal(n.act, undefined);
    });
    test("оборвана — предупреждение с кнопкой повтора и журналом", () => {
        const j = up("interrupted", { endedAt: NOW - 3 * MIN }), n = prepNext({ jobs: [j], now: NOW });
        assert.equal(n.kind, "warn");
        assert.equal(n.act, "provision");
        assert.equal(n.jobId, j.id);
        assert.match(n.text, /не завершена/);
    });
    test("две неудачи подряд — красное «Требует внимания»", () => {
        const n = prepNext({ jobs: [up("fail"), up("fail")], now: NOW });
        assert.equal(n.kind, "bad");
        assert.equal(n.act, "provision");
        assert.match(n.text, /2 раза подряд/);
    });
});

describe("relayToSlot — передача оркестратора слоту", () => {
    const base = { folder: true, preparing: false, live: false, session: false, prompt: true };
    test("папки нет или подготовка идёт — ждать, уйдёт сама", () => {
        assert.equal(relayToSlot({ ...base, folder: false }).act, "wait");
        assert.equal(relayToSlot({ ...base, preparing: true }).act, "wait");
    });
    test("папка готова, агента и сессии нет, стартовый промпт есть — запустить: промпт, передача следом", () => {
        assert.equal(relayToSlot(base).act, "start");
    });
    test("агент жив или сессия была — обычная передача", () => {
        assert.equal(relayToSlot({ ...base, live: true }).act, "deliver");
        assert.equal(relayToSlot({ ...base, session: true }).act, "deliver");
    });
    test("стартового промпта нет (нет плана) — обычная передача, без запуска «с пустого»", () => {
        assert.equal(relayToSlot({ ...base, prompt: false }).act, "deliver");
    });
});

describe("подготовка и окружение слота", () => {
    test("аргументы slot-up: слот и ветка; папка есть — --reuse; шаги и сборку slot-up берёт из области слота", () => {
        assert.deepEqual(provisionArgs({ slot: "wv1-a", branch: "dev/wv-0001-a" }, true), ["wv1-a", "--branch", "dev/wv-0001-a"]);
        assert.deepEqual(provisionArgs({ slot: "wv1-a", branch: "dev/wv-0001-a", area: "api" }, false), ["wv1-a", "--branch", "dev/wv-0001-a", "--reuse"]);
    });
    test("абзац окружения: проверки — станции диспетчерской, метка слота в строке ПРОГНАТЬ; слоту «только чтение» — пусто", () => {
        const t = slotEnvNote({ tag: "П3", area: "api" });
        assert.match(t, /^ОКРУЖЕНИЕ ПАПКИ\./);
        assert.match(t, /ПРОГНАТЬ П3: задача=фильтр/);
        assert.equal(slotEnvNote({ tag: "П4", readOnly: true }), "");
    });
    test("отказ задаче: слоту «только чтение» — с меткой и причиной; остальным — можно", () => {
        assert.match(areaRefusal({ tag: "П4", readOnly: true }, "api-test"), /П4: слот только читает код/);
        assert.equal(areaRefusal({ tag: "П1", area: "api" }, "api-test"), "");
    });
});
