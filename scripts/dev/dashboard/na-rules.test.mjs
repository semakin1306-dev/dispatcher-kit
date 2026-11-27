// «Неприменимо» (na-rules.mjs): несуществующее имя в задаче — не красное кода.
//   node --test scripts/dev/dashboard/na-rules.test.mjs
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as R from "./na-rules.mjs";

const TASK = { naLog: "\\[parts\\] неизвестные части", naList: "^[ ·] ([a-z][\\w-]+)\\s{2,}" };
const LOG =
    "\x1b[31m\n[parts] неизвестные части: wv-9999\x1b[0m\n\nЧАСТИ ПРОГОНА ТЕСТОВ\n\nГарды\n" +
    "  guards-chain                      Вся цепочка гардов\n" +
    "  guards-selftests              30  Селф-тесты гардов\n" +
    "· be-int-orders                 12  Заказы (срез)\n" +
    "\nВсего частей: 3. Сьютов: 42\nЗапуск: --all · <id> · <id,id>\n";

describe("неприменимо: разбор лога", () => {
    test("совпало — причина и список существующих имён", () => {
        const na = R.naOfLog(LOG, TASK);
        assert.equal(na.line, "[parts] неизвестные части: wv-9999");
        assert.deepEqual(na.list, ["guards-chain", "guards-selftests", "be-int-orders"]);
    });
    test("лог без признака — обычное красное", () => {
        assert.equal(R.naOfLog("FAIL src/a.spec.ts\nTests: 1 failed", TASK), null);
    });
    test("у задачи нет naLog — не трогаем", () => {
        assert.equal(R.naOfLog(LOG, {}), null);
        assert.equal(R.naOfLog(LOG, null), null);
    });
    test("неверный регэксп в конфиге — не падаем", () => {
        assert.equal(R.naOfLog(LOG, { naLog: "([" }), null);
        assert.deepEqual(R.naOfLog(LOG, { naLog: "неизвестные части", naList: "([" }).list, []);
    });
    test("без naList — причина есть, список пуст", () => {
        assert.deepEqual(R.naOfLog(LOG, { naLog: "неизвестные части" }).list, []);
    });
});

describe("неприменимо: тексты", () => {
    test("сводка и совет агенту", () => {
        const na = R.naOfLog(LOG, TASK);
        assert.match(R.naSummary(na), /^неприменимо: \[parts\] неизвестные части: wv-9999 — тесты не запускались$/);
        const a = R.naAdvice("Тесты: часть по имени", "wv-9999", na);
        assert.match(a, /неприменимо, тесты не запускались/);
        assert.match(a, /Существующие: guards-chain, guards-selftests, be-int-orders/);
        assert.match(a, /Выбери существующее имя или не назначай этот прогон/);
    });
});
