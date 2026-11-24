import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DASH_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dash-chain-"));
after(() => fs.rmSync(process.env.DASH_DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
const { testsDue } = await import("./autochain.mjs");

test("зелёный вердикт или нет пресетов — тесты не ставятся", () => {
    assert.equal(testsDue("green", [false]), false);
    assert.equal(testsDue("none", []), false);
    assert.equal(testsDue("notneeded", []), false);
});

test("вердикт notneeded, тесты волны зелёные на этом коде — станция пройдена, цепочка идёт к ревью, регрессу и коммиту", () => {
    assert.equal(testsDue("notneeded", [true]), false, "раньше здесь цепочка вставала навсегда («станцию уже ставил»)");
    assert.equal(testsDue("notneeded", [true, true]), false);
});

test("notneeded, а тесты волны на этом коде не прошли (нет прогона, красный, устарел) — ставятся как раньше", () => {
    assert.equal(testsDue("notneeded", [false]), true);
    assert.equal(testsDue("notneeded", [true, false]), true);
});

test("обычные вердикты (stale, none, fail) — тесты ставятся независимо от прошлых прогонов", () => {
    for (const v of ["stale", "none", "fail", "partial"])
        assert.equal(testsDue(v, [true]), true, v);
});
