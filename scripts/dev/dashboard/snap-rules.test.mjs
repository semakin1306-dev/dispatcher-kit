import { test } from "node:test";
import assert from "node:assert/strict";
import { snapMaxAge, SNAP_AGE } from "./snap-rules.mjs";

test("агент пишет или идёт прогон — каждый проход; открытый эпик — минута; влитые и чужие эпики — редко", () => {
    assert.equal(snapMaxAge({ agentBusy: true, merged: true }), 0);
    assert.equal(snapMaxAge({ jobLive: true, epic: "x" }), 0);
    assert.equal(snapMaxAge({ epic: "a", viewEpic: "a" }), SNAP_AGE.view);
    assert.equal(snapMaxAge({ epic: "b", viewEpic: "a" }), SNAP_AGE.cold);
    assert.equal(snapMaxAge({ epic: "a", viewEpic: "a", merged: true }), SNAP_AGE.merged);
    assert.equal(snapMaxAge({ kind: "orch" }), SNAP_AGE.orch);
});
