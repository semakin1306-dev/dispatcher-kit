// Приёмка (accept.mjs): прогон с поддельной командой приёмки (настоящий процесс, без сети), окружение команды,
// итоги на пункты записей волн, ответ агента с чек-листом, спеки по шаблону, напоминания «ПОСЛЕ ВЫКАТА».
//   node --test scripts/dev/dashboard/accept.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dk-accept-"));
process.env.DASH_DATA = path.join(TMP, "data");
fs.mkdirSync(process.env.DASH_DATA, { recursive: true });
after(async () => { const st = await import("./store.mjs"); await st.settled(); st.flushSync(); await st.settled(); fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const A = await import("./accept.mjs");
const { S } = await import("./state.mjs");
const { settled } = await import("./store.mjs");
A.loadAcceptance();
A.loadReminders();

// Запуск шага как у раннера: строка — в оболочку, окружение — поверх своего.
const run = (step, write) => new Promise((res) => {
    const c = cp.spawn(step.text, { cwd: step.cwd, shell: true, env: { ...process.env, ...(step.env || {}) }, windowsHide: true });
    c.stdout.on("data", (d) => write(String(d)));
    c.stderr.on("data", (d) => write(String(d)));
    c.on("close", (code) => res(code));
});
const fakeCmd = (body) => {
    const f = path.join(TMP, "fake-accept-" + Math.random().toString(36).slice(2) + ".mjs");
    fs.writeFileSync(f, body);
    return "node \"" + f.replace(/\\/g, "/") + "\"";
};

test("прогон с поддельной командой: окружение доходит до команды, метки [iN] из вывода — на пункты, код возврата сохраняется", async () => {
    const cmd = fakeCmd(`
const e = process.env;
console.log("stand=" + e.DISPATCHER_STAND_URL + " waves=" + e.DISPATCHER_ACCEPT_WAVES + " items=" + (e.DISPATCHER_ACCEPT_ITEMS || "-"));
console.log("  ✓  1 › e2e/wv-0001.accept.spec.ts:3:1 › [i1] список (1.0s)");
console.log("  ✘  2 › e2e/wv-0001.accept.spec.ts:7:1 › [i2] форма (2.0s)");
console.log("  ✓  3 › e2e/wv-0002.accept.spec.ts:3:1 › [i1] поиск (0.5s)");
process.exit(1);
`);
    let log = "";
    const env = { DISPATCHER_STAND_URL: "https://stand.example.com", DISPATCHER_ACCEPT_WAVES: "WV-0001 WV-0002" };
    const r = await A.runAcceptCommand({ cmd, cwd: TMP, env, waves: ["WV-0001", "WV-0002"], write: (s) => { log += s; }, run });
    assert.equal(r.code, 1);
    assert.match(log, /stand=https:\/\/stand\.example\.com waves=WV-0001 WV-0002 items=-/);
    assert.deepEqual(r.results.map((x) => [x.wave, x.id, x.st]), [["WV-0001", "i1", "ok"], ["WV-0001", "i2", "bad"], ["WV-0002", "i1", "ok"]]);

    S.acc["wv0001-a|s1"] = { key: "wv0001-a", merges: ["s1"], items: [{ id: "i1", where: "/", todo: "a", expect: "b", how: "auto", state: "todo", comment: "" }, { id: "i2", where: "/", todo: "c", expect: "d", how: "auto", state: "todo", comment: "" }] };
    const sum = A.applyAcceptRun({ id: "j7" }, r.results, { "0001": "wv0001-a|s1", "0002": "wv0002-b|s2" });
    assert.deepEqual(sum, { ok: 2, bad: 1, skip: 0, stray: 1, lost: 0 }, "у второй волны чек-листа нет — итог «без пункта»");
    assert.equal(S.acc["wv0001-a|s1"].items[0].auto.st, "ok");
    assert.equal(S.acc["wv0001-a|s1"].items[1].auto.st, "bad");
    assert.equal(S.acc["wv0001-a|s1"].items[1].auto.job, "j7");
    assert.deepEqual(S.acc["wv0002-b|s2"].autoStray.map((a) => a.title), ["[i1] поиск"]);
    await settled();
    assert.ok(fs.existsSync(A.ACC_FILE), "записи сохранены в папке данных");
});

test("перепрогон одного пункта: прежние итоги остальных пунктов остаются", () => {
    const e = S.acc["wv0001-a|s1"];
    A.applyAcceptRun({ id: "j8", accItem: "i2" }, [{ wave: "WV-0001", id: "i2", st: "ok", title: "[i2] форма" }], { "0001": "wv0001-a|s1" });
    assert.equal(e.items[1].auto.st, "ok");
    assert.equal(e.items[0].auto.job, "j7");
});

test("окружение команды: адрес стенда, волны, метки пунктов; спеки — только когда задан accept.specGlob", () => {
    const ws = [{ key: "wv0001-a", wave: "WV-0001" }, { key: "tr-x#WV-0002", wave: "WV-0002" }];
    const env = A.acceptEnv(ws, { items: "\\[i2\\]", standUrl: "https://stand.example.com", specs: () => ["e2e/x.spec.ts"] });
    assert.equal(env.DISPATCHER_STAND_URL, "https://stand.example.com");
    assert.equal(env.DISPATCHER_ACCEPT_WAVES, "WV-0001 WV-0002");
    assert.equal(env.DISPATCHER_ACCEPT_ITEMS, "\\[i2\\]");
    assert.equal("DISPATCHER_ACCEPT_SPEC" in env, false, "у демо-проекта нет accept.specGlob");
    assert.equal("DISPATCHER_ACCEPT_ITEMS" in A.acceptEnv(ws, { standUrl: "" }), false);
});

test("спеки приёмки по шаблону: обход от неизменной части пути, служебные папки пропускаются", () => {
    const root = path.join(TMP, "repo");
    for (const f of ["e2e/accept/wv-0001.accept.spec.ts", "e2e/accept/sub/wv-0002.accept.spec.ts", "e2e/accept/helpers.ts", "e2e/other/wv-0003.accept.spec.ts", "node_modules/e2e/accept/wv-0004.accept.spec.ts"]) {
        fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
        fs.writeFileSync(path.join(root, f), "");
    }
    assert.deepEqual(A.acceptSpecFiles(root, "e2e/accept/**/*.accept.spec.ts"), ["e2e/accept/sub/wv-0002.accept.spec.ts", "e2e/accept/wv-0001.accept.spec.ts"]);
    assert.deepEqual(A.acceptSpecFiles(root, ""), []);
});

test("ответ агента: чек-лист принят — пункты и ранние итоги на них; без блока — «не принят», пункты прежние", () => {
    S.acc["wv0005-c|s5"] = { key: "wv0005-c", autoStray: [{ st: "ok", title: "[i1] главная", job: "j1", at: 1 }] };
    const a = { capture: { kind: "accept", tree: "wv0005-c", accKey: "wv0005-c|s5", startRev: 1, wave: "" },
        items: [{ rev: 1, t: "user", text: "просьба" }, { rev: 2, t: "assistant", text: "сейчас посмотрю" }, { rev: 3, t: "tool" }, { rev: 4, t: "assistant", text: "```checklist\n- i1 | / | открыть | видна главная | авто\n- i2 | /x | нажать | ок | руками\n```" }] };
    A.captureReply(a);
    const e = S.acc["wv0005-c|s5"];
    assert.equal(a.capture, null);
    assert.deepEqual(e.items.map((x) => x.id), ["i1", "i2"]);
    assert.equal(e.items[0].auto.st, "ok", "итог, пришедший раньше чек-листа, лёг на пункт");
    assert.ok(e.gotAt);
    const gotAt = e.gotAt;
    A.acceptGot({ tree: "wv0005-c", accKey: "wv0005-c|s5", wave: "" }, "чек-лист такой: открыть главную");
    assert.match(e.raw, /^Ответ не принят: нет блока/);
    assert.equal(e.items.length, 2);
    assert.equal(e.gotAt, gotAt);
    A.acceptGot({ tree: "tr#WV-0006", accKey: "tr#WV-0006|s6", wave: "WV-0006" }, "WV-0007\n```checklist\n- i1 | / | a | b | авто\n```");
    assert.match(S.acc["tr#WV-0006|s6"].raw, /спрашивали WV-0006/, "чек-лист чужого вагона не принимается");
});

test("свободный чек-лист станции «На стенде» — по ключу слот|ветка", () => {
    const a = { capture: { kind: "stand-checklist", tree: "wv0001-a", branch: "dev/wv-0001", startRev: 0 }, items: [{ rev: 1, t: "assistant", text: "1. Сделать: … Ожидаемо: …" }] };
    A.captureReply(a);
    assert.match(A.checklistOf(A.chkKey("wv0001-a", "dev/wv-0001")).text, /Ожидаемо/);
});

test("напоминания: строки «ПОСЛЕ ВЫКАТА» из ответа агента; с кнопки — только задача проекта без ввода; без повторов", async () => {
    const n = A.remAddFromText("wv0001-a", "ПОСЛЕ ВЫКАТА: прогнать линтер на стенде :: lint\nПОСЛЕ ВЫКАТА: почистить кеш :: rm -rf /tmp/x\nПОСЛЕ ВЫКАТА: нет");
    assert.equal(n, 2);
    const [r1, r2] = A.remindersList();
    assert.deepEqual([r1.cmd, r1.cmdRaw], ["lint", ""]);
    assert.deepEqual([r2.cmd, r2.cmdRaw], ["", "rm -rf /tmp/x"], "произвольная команда — только текстом");
    assert.equal(A.remAddFromText("wv0001-a", "ПОСЛЕ ВЫКАТА: прогнать линтер на стенде :: lint"), 0);
    assert.ok(A.REM_CMD.test("typecheck"));
    assert.equal(A.REM_CMD.test("api-test"), false, "задача с вводом с кнопки не запускается");
    await assert.rejects(A.remRun(r2), /только задача проекта без ввода/);
    assert.equal((await A.remindersOp({ op: "add", text: "проверить", cmd: "curl x" })).code, 400);
    assert.equal((await A.remindersOp({ op: "done", id: r1.id })).code, 200);
    assert.equal(r1.status, "done");
});

test("модуль выключен (у демо-проекта нет accept.run) — действия панели отвечают 404, опрос агентов не идёт", async () => {
    assert.equal(A.acceptEnabled(), false);
    assert.equal((await A.acceptOp({ op: "ask" })).code, 404);
    assert.deepEqual(await A.acceptAsk(null), []);
    await assert.rejects(A.acceptRunJob(null, false, null, null), /accept\.run/);
});
