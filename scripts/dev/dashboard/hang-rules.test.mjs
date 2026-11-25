import { test } from "node:test";
import assert from "node:assert/strict";
import { HANG_QUIET_MS, hangDue, hangLogLines, hangSummary, hungSpecs, partialSpecs } from "./hang-rules.mjs";

const HEAD = "[сервер] клетка памяти: 9 ГБ без подкачки\n\x1b[33m⚠ ЧАСТИЧНЫЙ прогон витрины: фильтр «wv-1073, wv-0984» — 2 из 581 спек\x1b[0m\n" +
    "   · components/Layout/__tests__/wv-1073-plan-usage-footer.spec.ts\n   · utils/__tests__/wv-0984-help-public.spec.ts\n" +
    "  Перед коммитом обязателен «🧪 Витрина: весь vitest» — выборка не видит чужих спек, задетых общими компонентами.\n\n RUN  v2.1.9 /home/user/apps/storefront\n";

test("partialSpecs: список спек под «ЧАСТИЧНЫЙ прогон»; без него — пусто", () => {
    assert.deepEqual(partialSpecs(HEAD), ["components/Layout/__tests__/wv-1073-plan-usage-footer.spec.ts", "utils/__tests__/wv-0984-help-public.spec.ts"]);
    assert.deepEqual(partialSpecs(" RUN v2.1.9\n ✓ a.spec.ts"), []);
    assert.deepEqual(
        partialSpecs(
            "⚠ ЧАСТИЧНЫЙ прогон витрины: …\n   · pages/programs/[slug]/__tests__/wv-1068-first-step.spec.ts\n",
        ),
        ["pages/programs/[slug]/__tests__/wv-1068-first-step.spec.ts"],
        "скобки в пути",
    );
});

test("hungSpecs и hangDue: неотчитавшиеся спеки и тишина дольше порога", () => {
    const listed = partialSpecs(HEAD), done = { "wv-0984-help-public.spec.ts": "ok" }, t = 1000000000;
    assert.deepEqual(hungSpecs(listed, done), ["components/Layout/__tests__/wv-1073-plan-usage-footer.spec.ts"]);
    assert.equal(hangDue({ listed, done, lastOutAt: t, now: t + HANG_QUIET_MS }), true);
    assert.equal(hangDue({ listed, done, lastOutAt: t, now: t + HANG_QUIET_MS - 1 }), false, "тишина короче порога");
    assert.equal(hangDue({ listed, done: { ...done, "wv-1073-plan-usage-footer.spec.ts": "fail" }, lastOutAt: t, now: t + 3 * HANG_QUIET_MS }), false, "все отчитались (красная — тоже итог)");
    assert.equal(hangDue({ listed: [], done, lastOutAt: t, now: t + 3 * HANG_QUIET_MS }), false, "не частичный прогон — сторож молчит");
});

test("hangLogLines: строки FAIL, которые находит разбор упавших спек; hangSummary — без «СНЯТ ПО ВРЕМЕНИ»", () => {
    const miss = ["components/Layout/__tests__/wv-1073-plan-usage-footer.spec.ts"];
    const lines = hangLogLines(miss, 5).split("\n");
    assert.match(lines[0], /^\s*FAIL\s+components\/Layout\/__tests__\/wv-1073-plan-usage-footer\.spec\.ts\s>/);
    assert.match(lines[1], /^Error: спека висит/);
    const s = hangSummary(miss, partialSpecs(HEAD), 5);
    assert.match(s, /ВИСИТ СПЕКА: wv-1073-plan-usage-footer\.spec\.ts — нет итога 5 мин, остальные 1 из 2 отчитались/);
    assert.doesNotMatch(s, /СНЯТ ПО ВРЕМЕНИ/, "ENV_FAIL_RE не должна принять это за окружение");
    assert.match(hangSummary(["a/x.spec.ts", "b/y.spec.ts"], ["a/x.spec.ts", "b/y.spec.ts"], 5), /ВИСИТ СПЕК 2: x\.spec\.ts, y\.spec\.ts/);
});
