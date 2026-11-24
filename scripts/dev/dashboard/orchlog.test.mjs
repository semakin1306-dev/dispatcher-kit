// orchlog.test.mjs — журнал команд оркестратора без сервера: запись до исполнения и итог, прерванное перезапуском,
// слово владельца на диске.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-orchlog-"));
process.env.DASH_DATA = TMP;
const L = await import("./orchlog.mjs");
const { settled } = await import("./store.mjs");
after(async () => {
    await settled();
    fs.rmSync(TMP, { recursive: true, force: true });
});
const disk = () => JSON.parse(fs.readFileSync(L.ORCH_LOG_FILE, "utf8"));

test("команда: запись «идёт» до исполнения, итог после; тот же ключ второй раз не начинается", () => {
    L.loadOrchLog();
    const key = L.cmdKey("msg_1", "ВЛИТЬ П3", 0);
    assert.equal(L.cmdBegin({ key, orch: "o", cmd: "ВЛИТЬ", target: "П3", line: "ВЛИТЬ П3" }), true);
    assert.equal(disk().items.find((x) => x.id === key).state, "run");
    assert.equal(L.cmdBegin({ key, orch: "o", cmd: "ВЛИТЬ", target: "П3", line: "ВЛИТЬ П3" }), false);
    L.cmdEnd(key, false, "не исполнено: нет слова");
    const x = disk().items.find((i) => i.id === key);
    assert.equal(x.state, "fail");
    assert.match(x.detail, /нет слова/);
    assert.notEqual(L.cmdKey("", "ВЛИТЬ П3", 0), L.cmdKey("", "ВЛИТЬ П7", 0), "без id хода ключ — по тексту");
});

test("перезапуск: «идущие» команды — прерванными, один раз", () => {
    L.loadOrchLog();
    L.cmdBegin({ key: "k-run", orch: "o", cmd: "КОММИТ", target: "П1", line: "КОММИТ П1" });
    const cut = L.takeInterrupted();
    assert.deepEqual(cut.map((x) => x.id), ["k-run"]);
    assert.match(disk().items.find((x) => x.id === "k-run").detail, /прервано перезапуском/);
    assert.deepEqual(L.takeInterrupted(), []);
});

test("слово владельца: последнее на диске; набранное человеком — отдельно от автоответа и бота", async () => {
    L.loadOrchLog();
    L.ownerSaid("o", "влей П3", 1000);
    L.ownerSaid("o", "коммить", 2000, "tg");
    assert.equal(L.ownerWord("o").text, "коммить");
    assert.equal(L.ownerWord("o", { real: true }).text, "влей П3");
    await settled();
    L.loadOrchLog();
    assert.equal(L.ownerWord("o", { real: true }).text, "влей П3", "переживает перезапуск");
});
