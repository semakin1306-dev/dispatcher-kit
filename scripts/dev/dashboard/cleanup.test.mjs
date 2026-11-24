// Уборка папки данных и задачи конфига: ротация events.jsonl и логов прогонов, задачи областей (сборка, папка запуска,
// предел времени), зоны задач (что старит зелёный прогон) и регресс по тронутым путям. Всё — на временных папках.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// папка данных — временная, ДО импорта модулей (config.mjs читает DASH_DATA при загрузке); DASH_DRY не ставим:
// rotateLogs в сухом экземпляре ничего не делает, а здесь её и проверяем
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-cleanup-"));
process.env.DASH_DATA = TMP;
const { EVENTS_JSONL, LOGS, LOCAL_PORTS, rotateLogs, trimJsonl } = await import("./config.mjs");
const { TASKS, stepOfTask, timeLimitMin } = await import("./tasks.mjs");
const { regressPlan } = await import("./regress.mjs");
const { TASK_AREA } = await import("./fingerprint.mjs");
const { NEED_PKGS } = await import("./epics.mjs");

const DAY = 86400e3, NOW = Date.UTC(2026, 0, 15, 12);
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe("trimJsonl и rotateLogs — events.jsonl по 7 суток, как логи", () => {
    const line = (age, type = "x") => JSON.stringify({ at: Date.now() - age * DAY, type });
    test("старые строки уходят, свежие и строки без at остаются в прежнем порядке", () => {
        const f = path.join(TMP, "t1.jsonl"), cut = Date.now() - 7 * DAY;
        fs.writeFileSync(f, [line(9, "a"), line(8, "b"), "не json", line(1, "c"), JSON.stringify({ type: "без at" }), line(0, "d")].join("\n") + "\n");
        assert.deepEqual(trimJsonl(f, cut), { dropped: 2, kept: 4 });
        const ls = fs.readFileSync(f, "utf8").split("\n");
        assert.equal(ls.length, 5);
        assert.equal(ls[4], "");
        assert.equal(ls[0], "не json");
        assert.equal(JSON.parse(ls[1]).type, "c");
        assert.equal(JSON.parse(ls[3]).type, "d");
        assert.deepEqual(fs.readdirSync(TMP).filter((x) => x.includes(".tmp-")), [], "временный файл не остался");
    });
    test("старых строк нет — файл не переписывается; файла нет — ноль", () => {
        const f = path.join(TMP, "t2.jsonl");
        fs.writeFileSync(f, line(1) + "\n");
        const t = new Date(NOW - DAY);
        fs.utimesSync(f, t, t);
        assert.deepEqual(trimJsonl(f, Date.now() - 7 * DAY), { dropped: 0, kept: 1 });
        assert.equal(fs.statSync(f).mtimeMs, t.getTime());
        assert.deepEqual(trimJsonl(path.join(TMP, "нет.jsonl"), 0), { dropped: 0, kept: 0 });
    });
    test("rotateLogs: логи и события старше 7 суток — прочь, свежее — на месте", () => {
        assert.equal(EVENTS_JSONL, path.join(TMP, "events.jsonl"));
        fs.mkdirSync(LOGS, { recursive: true });
        for (const [n, age] of [["j1", 10], ["j2", 1]]) {
            const p = path.join(LOGS, n + ".log");
            fs.writeFileSync(p, "лог");
            const t = new Date(Date.now() - age * DAY);
            fs.utimesSync(p, t, t);
        }
        fs.writeFileSync(EVENTS_JSONL, [line(10, "old"), line(8, "old"), line(2, "new")].join("\n") + "\n");
        rotateLogs();
        assert.deepEqual(fs.readdirSync(LOGS), ["j2.log"]);
        const ev = fs.readFileSync(EVENTS_JSONL, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
        assert.deepEqual(ev.map((e) => e.type).filter((x) => x !== "logs.rotated" && x !== "events.rotated"), ["new"]);
    });
});

describe("задачи областей из конфига проекта (демо: api со сборкой, web без)", () => {
    test("сборка нужна задачам областей с build: true; папка запуска — cwd задачи; предел — timeoutMin или 30 мин", () => {
        assert.deepEqual([...NEED_PKGS], ["api-test"]);
        const st = stepOfTask(TASKS["api-test"], "/slots/wv0001-a", "wv-0001");
        assert.equal(st.cwd, path.join("/slots/wv0001-a", "apps/api"));
        assert.deepEqual(st.args, ["jest", "wv-0001"]);
        assert.equal(stepOfTask(TASKS.lint, "/slots/wv0001-a").cwd, "/slots/wv0001-a", "без cwd — корень слота");
        assert.equal(timeLimitMin("api-test"), 30);
        assert.equal(timeLimitMin("нет-такой"), 0);
    });
    test("зона задачи: тесты области старятся от путей своей области; гард — от любого продуктового кода, но не от документов", () => {
        const api = TASK_AREA["api-test"], lint = TASK_AREA.lint;
        assert.ok(api.test("apps/api/src/a.ts"));
        assert.ok(api.test("packages/core/x.ts"));
        assert.equal(api.test("apps/web/x.vue"), false);
        assert.ok(lint.test("apps/web/x.vue"));
        assert.equal(lint.test("docs/a.md"), false);
        assert.equal(lint.test("README.md"), false);
    });
    test("регресс: правка кода области — спеки области, где упомянут тронутый файл; задача без разбора имён спек — нет", () => {
        const dir = fs.mkdtempSync(path.join(TMP, "repo-"));
        const put = (rel, text) => {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            fs.writeFileSync(path.join(dir, rel), text);
        };
        put("apps/api/src/orders.ts", "export const x = 1\n");
        put("apps/api/__tests__/orders.spec.ts", "import { x } from '../src/orders'\n");
        put("apps/api/__tests__/users.spec.ts", "import { y } from '../src/users'\n");
        put("apps/web/src/cart.vue", "<template/>\n");
        put("apps/web/__tests__/cart.spec.ts", "import Cart from '../src/cart.vue'\n");
        const plan = regressPlan(["apps/api/src/orders.ts"], dir);
        assert.deepEqual(plan.map((x) => x.task), ["api-test"]);
        assert.match(plan[0].input, /orders/);
        assert.doesNotMatch(plan[0].input, /users/);
        assert.deepEqual(regressPlan(["apps/web/src/cart.vue"], dir), [], "vitest не принимает список спек вводом — регресс по именам выключен сам");
        assert.deepEqual(regressPlan(["docs/a.md"], dir), [], "вне областей — регресса нет");
    });
});

test("занятые локальные порты — одно место: диспетчерская и пробный экземпляр", () => {
    assert.match(LOCAL_PORTS[4777], /диспетчерская/);
    assert.match(LOCAL_PORTS[4786], /пробный экземпляр/);
});
