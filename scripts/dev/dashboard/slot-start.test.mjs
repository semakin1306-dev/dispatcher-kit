import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-slotstart-"));
process.env.DASH_DATA = TMP;
process.env.DASH_DRY = "1";
after(async () => {
    const st = await import("./store.mjs");
    await st.settled(); st.flushSync(); await st.settled();
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const { prepCap, PREP_MAX, planIsStub, slotIdleNudge, slotIdleText, SLOT_IDLE_MS } = await import("./slot-rules.mjs");

test("подготовок слотов одновременно — от свободной памяти ПК, не больше трёх и не меньше одной", () => {
    assert.equal(PREP_MAX, 3);
    assert.equal(prepCap(20), 3);
    assert.equal(prepCap(7.1), 2);
    assert.equal(prepCap(5.4), 1);
    assert.equal(prepCap(2), 1);
    assert.equal(prepCap(NaN), 1, "замера нет — по одной, как раньше");
});

const NOW = Date.parse("2026-11-09T15:00:00Z");
const okPrep = (minAgo, id = "j2066") => ({ id, status: "ok", endedAt: NOW - minAgo * 60e3 });
const base = { exists: true, agent: false, relay: false, preparing: false, now: NOW };

test("слот готов дольше 10 мин, агента и передач нет — толчок оркестратору; один раз на подготовку", () => {
    assert.equal(SLOT_IDLE_MS, 10 * 60e3);
    const n = slotIdleNudge({ ...base, lastPrep: okPrep(12) });
    assert.deepEqual(n, { jobId: "j2066", min: 12 });
    assert.equal(slotIdleNudge({ ...base, lastPrep: okPrep(9) }), null, "ещё нет 10 мин");
    assert.equal(slotIdleNudge({ ...base, lastPrep: okPrep(12), nudged: "j2066" }), null, "уже толкали по этой подготовке");
    assert.deepEqual(slotIdleNudge({ ...base, lastPrep: okPrep(12, "j2100"), nudged: "j2066" }), { jobId: "j2100", min: 12 }, "новая подготовка — новый толчок");
});

test("не толкаем — агент есть или был, к слоту идёт передача, подготовка идёт или не зелёная, влит, в архиве, давний", () => {
    const p = okPrep(30);
    for (const [why, o] of [["агент", { agent: true }], ["передача", { relay: true }], ["подготовка идёт", { preparing: true }], ["нет папки", { exists: false }],
        ["влит", { merged: true }], ["архив", { archived: true }], ["план — заготовка add-slot", { stub: true }]])
        assert.equal(slotIdleNudge({ ...base, lastPrep: p, ...o }), null, why);
    assert.equal(slotIdleNudge({ ...base, lastPrep: { id: "j1", status: "fail", endedAt: NOW - 30 * 60e3 } }), null, "упавшую подготовку ведёт Г2");
    assert.equal(slotIdleNudge({ ...base, lastPrep: null }), null, "подготовки не было — не знаем, когда готов");
    assert.equal(slotIdleNudge({ ...base, lastPrep: okPrep(25 * 60) }), null, "готов больше суток назад — не будим старое");
});

test("текст оркестратору — метка, сколько стоит, как запустить (блок slot:ПN), нет плана — сказано", () => {
    const t = slotIdleText({ tag: "П11", title: "WV-1009 лиды", min: 38, jobId: "j2066", plan: true });
    assert.match(t, /П11/);
    assert.match(t, /38 мин/);
    assert.match(t, /slot:П11/);
    assert.match(t, /j2066/);
    assert.doesNotMatch(t, /План волны .* не найден/);
    assert.match(slotIdleText({ tag: "П11", title: "x", min: 12, jobId: "j1", plan: false }), /План волны .* не найден/);
});

test("заготовка плана от add-slot — пока в нём подсказки шаблона; заполненный план — не заготовка", () => {
    assert.equal(planIsStub("# WV-1106: x\n\n**Источник.** (кто и что запросил, когда; ссылки на переписку и замеры)\n"), true);
    assert.equal(planIsStub("## Что было\n\n(как устроено сейчас, с замером или чтением кода, а не по памяти)\n"), true);
    assert.equal(planIsStub("**Источник.** Владелец в чате: админке нужен отдельный вход.\n\n## Что было\n\nМидлвар читает токен из cookie (apps/backend/src/utils/x.ts:12).\n"), false);
    assert.equal(planIsStub(""), false);
});

test("агент слота не стартует на плане-заготовке; живого агента и сохранённую сессию не держим", async () => {
    const { startHeldByStub } = await import("./slot-rules.mjs");
    assert.equal(startHeldByStub({ kind: "slot", stub: true }), true, "новый слот с заготовкой ждёт плана");
    assert.equal(startHeldByStub({ kind: "slot", stub: false }), false, "план заполнен — старт");
    assert.equal(startHeldByStub({ kind: "slot", stub: true, live: true }), false, "агент уже работает");
    assert.equal(startHeldByStub({ kind: "slot", stub: true, session: true }), false, "сессия есть — слот запускали раньше");
    assert.equal(startHeldByStub({ kind: "orch", stub: true }), false, "оркестратора правило не касается");
});

test("«ПЕРЕПРОГОН» после правок при автопоезде — через автопоезд (только красные и задетые сьюты), без него — упавшее целиком", async () => {
    const { rerunByChain } = await import("./slot-rules.mjs");
    assert.equal(rerunByChain({ autoTrain: true, off: false, todo: 3 }), true);
    assert.equal(rerunByChain({ autoTrain: true, off: true, todo: 3 }), false, "автопоезд выключен на карточке");
    assert.equal(rerunByChain({ autoTrain: false, todo: 3 }), false, "автопоезд выключен совсем");
    assert.equal(rerunByChain({ autoTrain: true, todo: 0 }), false, "перегонять нечего");
});

test("полоса подготовки в очереди берёт потолок prepCap, а не постоянную 1", () => {
    const src = fs.readFileSync(new URL("./runner.mjs", import.meta.url), "utf8");
    assert.match(src, /prepCap\(/);
    assert.match(src, /laneMax\(lane\)/);
});

test("проверка простоя слотов подключена к таймеру и помнит толчки между перезапусками", () => {
    const relay = fs.readFileSync(new URL("./relay.mjs", import.meta.url), "utf8"), boot = fs.readFileSync(new URL("./boot.mjs", import.meta.url), "utf8");
    assert.match(relay, /export function nudgeIdleSlots/);
    assert.match(relay, /slot-nudges\.json/);
    assert.match(boot, /nudgeIdleSlots\(\)/);
});
