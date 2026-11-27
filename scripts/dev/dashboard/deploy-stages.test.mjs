// Этапы экрана выката стенда (deploy-stages.mjs): пуш диспетчерской + этапы по меткам вывода команды выката.
//   node --test scripts/dev/dashboard/deploy-stages.test.mjs
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { standLine, standStagesDef, standStepStart } from "./deploy-stages.mjs";

const STAGES = [
    ["home", "Сборка", "^\\[1/3\\]"],
    ["migr", "Миграции", "^\\[2/3\\]"],
    ["pm2", "Перезапуск", "^\\[3/3\\]"],
    ["done", "Стенд", "^=== complete"],
];
const job = () => ({ stagesDef: standStagesDef(STAGES), prog: { kind: "marks", stages: {}, at: {} } });

describe("stand-stages", () => {
    test("без этапов в конфиге — пуш и один общий этап", () => {
        assert.deepEqual(standStagesDef([]), [["push", "Пуш staging"], ["stand", "Выкат стенда"]]);
        assert.equal(standStagesDef(STAGES).length, 5);
    });
    test("шаг 1 — пуш идёт; шаг 2 — пуш пройден, первый этап команды идёт", () => {
        const j = job();
        standStepStart(j, 1, 100);
        assert.equal(j.prog.cur, "push");
        assert.equal(j.prog.stages.push, "run");
        standStepStart(j, 2, 200);
        assert.equal(j.prog.stages.push, "ok");
        assert.equal(j.prog.cur, "home");
        assert.equal(j.prog.at.home, 200);
    });
    test("метки двигают текущий этап; пропущенная метка — skip; последний этап — ok", () => {
        const j = job();
        standStepStart(j, 1);
        standStepStart(j, 2);
        assert.equal(standLine(j, "[1/3] Building…", 300), true);
        assert.equal(j.prog.cur, "home");
        assert.equal(standLine(j, "просто вывод"), false);
        standLine(j, "[3/3] Restarting…", 400);
        assert.deepEqual(j.prog.stages, { push: "ok", home: "ok", migr: "skip", pm2: "run" });
        standLine(j, "=== complete ===", 500);
        assert.equal(j.prog.stages.pm2, "ok");
        assert.equal(j.prog.stages.done, "ok");
        assert.equal(j.prog.cur, "done");
    });
    test("старый запуск без регулярок (две станции) не трогается разбором строк", () => {
        const j = { stagesDef: [["push", "Пуш staging"], ["stand", "Выкат стенда"]], prog: { stages: {}, at: {} } };
        assert.equal(standLine(j, "[1/7] Pushing"), false);
        standStepStart(j, 2);
        assert.equal(j.prog.cur, "stand");
    });
});
