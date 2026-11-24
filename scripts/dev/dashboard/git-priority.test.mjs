import { test } from "node:test";
import assert from "node:assert/strict";
import { gitSlot, withGitPriority, gitLoad, GIT_MAX, GIT_PRIO_EXTRA, gitWait } from "./git.mjs";

test("фоновые вызовы ограничены GIT_MAX, приоритетный берёт место сверх и обгоняет очередь", async () => {
    const held = [];
    for (let i = 0; i < GIT_MAX; i++)
        held.push(await gitSlot());
    assert.equal(gitLoad().active, GIT_MAX);
    let bg = false;
    const bgP = gitSlot().then((r) => {
        bg = true;
        return r;
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(bg, false, "фоновый ждёт");
    const prio = await withGitPriority(() => gitSlot());
    assert.equal(gitLoad().active, GIT_MAX + 1);
    prio();
    held.shift()();
    await bgP.then((r) => r());
    assert.equal(bg, true);
    held.forEach((r) => r());
    assert.equal(gitLoad().active, 0);
    assert.equal(gitWait.length, 0);
});

test("при занятых и обычных, и сверхмест приоритетный встаёт в начало очереди", async () => {
    const held = [];
    for (let i = 0; i < GIT_MAX; i++)
        held.push(await gitSlot());
    const extra = [];
    for (let i = 0; i < GIT_PRIO_EXTRA; i++)
        extra.push(await withGitPriority(() => gitSlot()));
    const order = [];
    const bg = gitSlot().then((r) => {
        order.push("bg");
        return r;
    }), pr = withGitPriority(() => gitSlot()).then((r) => {
        order.push("prio");
        return r;
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(order.length, 0);
    extra.shift()();
    const pr1 = await pr;
    assert.deepEqual(order, ["prio"], "приоритетный раньше фонового, хотя встал позже");
    pr1();
    extra.shift()();
    held.forEach((r) => r());
    const bg1 = await bg;
    bg1();
    assert.equal(gitLoad().active, 0);
});
