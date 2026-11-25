// Красная группа: узкий перепрогон несёт все упавшие спеки, сводка агенту называет все падения, а не первое.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-redgrp-"));
process.env.DASH_DATA = TMP;
process.env.DASH_DRY = "1";
fs.mkdirSync(path.join(TMP, "logs"), { recursive: true });
const L = await import("./loops.mjs");
const G = await import("./regress.mjs");
const P = await import("./parsers.mjs");
const { loadJobs } = await import("./jobs.mjs");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const E = "\u001b";

const RED = [
    E + "[31mFAIL" + E + "[39m __tests__/orders/a-total.spec.ts",
    "  ● total › со скидкой",
    "FAIL __tests__/orders/b-tax.spec.ts",
    "FAIL __tests__/users/c-login.spec.ts",
    "FAIL __tests__/users/d-name.spec.ts",
    "PASS __tests__/users/e-ok.spec.ts",
    "Tests: 4 failed, 9 passed, 13 total",
].join("\n");

const GUARD_RED =
    "[guard:imports] РАСХОЖДЕНИЙ: 3\n  • И1: импорт через границу модуля — src/a.ts :: '../b/internal'\n " +
    " • И1: импорт через границу модуля — src/a.ts :: '../b/internal'\n  • И5: мёртвое исключение — " +
    "src/c.ts\nCommand failed with exit code 1.";

describe("carryRedSpecs — узкий перепрогон несёт всю красную группу", () => {
    const si = P.specInput("api-test");
    const fails = ["a-total.spec.ts", "b-tax.spec.ts", "c-login.spec.ts", "d-name.spec.ts"].map((spec) => ({ spec, fam: "api-test" }));
    const join = (base, specs) => si.add(base, specs), covered = (inp) => (spec) => G.regexCovers(inp, spec);
    test("к набору с одной поправленной спекой добавляются остальные красные, имена экранированы", () => {
        const r = L.carryRedSpecs({ task: "api-test", input: "d-name", fails, join, covered: covered("d-name") });
        assert.deepEqual(r.added, ["a-total.spec.ts", "b-tax.spec.ts", "c-login.spec.ts"]);
        assert.equal(r.input, "d-name|a-total\\.spec\\.ts|b-tax\\.spec\\.ts|c-login\\.spec\\.ts");
    });
    test("набор, уже покрывающий все, — без изменений; чужая задача и задача без ввода из спек — тоже", () => {
        assert.deepEqual(L.carryRedSpecs({ task: "api-test", input: "total|tax|login|name", fails, join, covered: covered("total|tax|login|name") }).added, []);
        assert.deepEqual(L.carryRedSpecs({ task: "web-test", input: "x", fails, join }).added, []);
        assert.equal(P.specInput("web-test"), null, "vitest: фильтр — подстрока, список спек одним аргументом не построить");
    });
});

describe("сводка красного агенту — все упавшие, а не первое", () => {
    test("гард: все нарушения из лога, повторы схлопнуты", () => {
        const v = L.guardViolations(GUARD_RED);
        assert.equal(v.length, 2);
        assert.match(v[0], /^И1: импорт через границу/);
        assert.match(v[1], /^И5: мёртвое исключение/);
        assert.match(L.redGroupNote({ violations: v }), /все 2, поправь каждое до перепрогона/);
    });
    test("спеки: этого прогона и ещё красные с прошлого — одним списком", () => {
        const n = L.redGroupNote({ own: ["apps/api/__tests__/a-total.spec.ts", "b-tax.spec.ts"], carry: ["c-login.spec.ts", "a-total.spec.ts"] });
        assert.match(n, /проверь и поправь КАЖДУЮ до перепрогона/);
        assert.match(n, /a-total\.spec\.ts, b-tax\.spec\.ts; ещё красные с прошлого прогона: c-login\.spec\.ts\.$/);
        assert.equal(L.redGroupNote({ own: ["a.spec.ts"] }), "", "одна упавшая и ничего с прошлого — без лишней строки");
    });
});

describe("redCarryOf — красные с прошлого кода, ещё не прошедшие", () => {
    test("красный прогон на старом коде, потом зелёной прошла одна — несутся три; на том же коде и старше суток — нет", () => {
        fs.writeFileSync(path.join(TMP, "logs", "j1.log"), RED);
        fs.writeFileSync(path.join(TMP, "logs", "j2.log"), "PASS __tests__/users/d-name.spec.ts\nTests: 1 passed, 1 total\n");
        const now = Date.now();
        loadJobs([{ id: "j1", tree: "tr1", task: "api-test", input: "orders|users", status: "fail", fpStart: "fA", fpEnd: "fA", endedAt: now - 3600e3 },
            { id: "j2", tree: "tr1", task: "api-test", input: "d-name", status: "ok", fpStart: "fB", fpEnd: "fB", endedAt: now - 1800e3 }]);
        G.loadStgRed();
        G.loadSpecHist();
        assert.deepEqual(G.failingSpecs("j1"), ["__tests__/orders/a-total.spec.ts", "__tests__/orders/b-tax.spec.ts", "__tests__/users/c-login.spec.ts", "__tests__/users/d-name.spec.ts"]);
        assert.deepEqual(G.redCarryOf("tr1", "fC").map((x) => x.spec).sort(), ["a-total.spec.ts", "b-tax.spec.ts", "c-login.spec.ts"]);
        assert.deepEqual(G.redCarryOf("tr1", "fA"), [], "красное на нынешнем коде повтор без правки не изменит");
        assert.deepEqual(G.redCarryOf("tr1", "fC", { now: now + 2 * 86400e3 }), [], "старше суток — не несём");
        assert.deepEqual(G.redCarryOf("tr1", "", { exceptJob: "j1" }), [], "для сводки самого j1 — не дублировать его же спеки");
    });
    test("перепрогон слота (runTaskNow) расширяет набор правилом carryRedSpecs до ворот", () => {
        const src = fs.readFileSync(new URL("./autochain.mjs", import.meta.url), "utf8"), i = src.indexOf("export async function runTaskNow"), body = src.slice(i, src.indexOf("\n}\n", i));
        assert.ok(body.indexOf("carryRedSpecs({ task: taskId, input: inp, fails: redCarryOf(key, fp), ...carryJoin(taskId, inp) })") > 0, "расширение в runTaskNow");
        assert.ok(body.indexOf("carryRedSpecs(") < body.indexOf("runGate("), "до ворот: ворота видят уже расширенный набор");
    });
});
