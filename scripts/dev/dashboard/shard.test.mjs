// Точка подключения машин: по умолчанию «удалённых машин нет» — мест нет, удалённый прогон отказывает с причиной.
// Сброс слота идёт только в здешней папке.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { localSlotReset, noMachinesApi, setShardApi, shardApi } from "./shard.mjs";

test("по умолчанию: удалённых машин нет, каждый метод отвечает безопасно", async () => {
    const a = shardApi();
    assert.ok(a, "shardApi() никогда не null");
    assert.equal(a.on, false);
    assert.equal(a.slotFree("main", {}), false);
    assert.equal(a.slotAnyOnline(), false);
    assert.equal(a.slotReserve("j1", "main", {}), -1);
    assert.equal(a.slotMachineOf("j1"), null);
    assert.doesNotThrow(() => a.slotRelease("j1"));
    assert.equal(a.machineLabel("local"), "Эта машина");
    assert.equal(a.fullRunOn(), false);
    assert.equal(a.fullRunLeft(), 0);
    assert.equal(await a.slotCancel("j1", "x"), false);
    await assert.rejects(a.slotRun({ jobId: "j1" }, () => { }, () => { }, "x"), /удалённых машин нет/);
    assert.equal(a.summary(), null);
    assert.deepEqual(a.load(), {});
    assert.equal(await a.log("x.log"), null);
    assert.deepEqual(await a.slotPrune(["s1"]), { none: true });
    assert.equal((await a.start({})).ok, false);
});

test("setShardApi: своя реализация и возврат к умолчанию", () => {
    const mine = { on: true };
    setShardApi(mine);
    assert.equal(shardApi(), mine);
    setShardApi(null);
    assert.equal(shardApi().on, false);
    assert.equal(typeof noMachinesApi().slotRun, "function");
});

const g = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
function repo() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "dk-shard-"));
    g(d, "init", "-q", "-b", "dev/x");
    g(d, "config", "user.email", "t@example.invalid");
    g(d, "config", "user.name", "t");
    g(d, "config", "core.autocrlf", "false");
    fs.writeFileSync(path.join(d, "a.txt"), "1");
    g(d, "add", "a.txt");
    g(d, "commit", "-qm", "one");
    const one = g(d, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(d, "a.txt"), "2");
    g(d, "commit", "-qam", "two");
    return { d, one, two: g(d, "rev-parse", "HEAD") };
}

test("сброс в здешней папке: страховочный тег и reset --hard на цель", async () => {
    const { d, one, two } = repo();
    let log = "";
    const r = await localSlotReset(
        {
            key: "slot1",
            branch: "dev/x",
            pcPath: d,
            target: one,
            expect: { pcHead: two },
            tags: [{ name: "backup/e1/slot1/t", sha: two, what: "здешняя ветка" }],
        },
        (s) => {
            log += s;
        },
    );
    assert.deepEqual(r, { ok: true });
    assert.equal(g(d, "rev-parse", "HEAD"), one);
    assert.equal(g(d, "rev-parse", "backup/e1/slot1/t"), two);
    assert.match(log, /страховка: backup\/e1\/slot1\/t/);
    fs.rmSync(d, { recursive: true, force: true });
});

test("сброс отказывает, если папка изменилась с проверки — ничего не тронуто", async () => {
    const { d, one, two } = repo();
    await assert.rejects(localSlotReset({ branch: "dev/x", pcPath: d, target: one, expect: { pcHead: one } }), /изменилась с проверки/);
    fs.writeFileSync(path.join(d, "b.txt"), "x");
    await assert.rejects(localSlotReset({ branch: "dev/x", pcPath: d, target: one, expect: { pcHead: two } }), /изменилась с проверки/);
    assert.equal(g(d, "rev-parse", "HEAD"), two);
    fs.rmSync(d, { recursive: true, force: true });
});
