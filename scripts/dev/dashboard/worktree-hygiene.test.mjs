import { test } from "node:test";
import assert from "node:assert/strict";
import { extraWorktrees, parseWorktrees } from "./worktree-hygiene.mjs";

// Папки условные: правила только сравнивают пути, на диск не ходят.
const MAIN = "/work/demo", WT = "/work/demo-wt";
const LIST = parseWorktrees([`worktree ${MAIN}`, "HEAD 1", "branch refs/heads/staging", "", `worktree ${WT}/wv1022-viewer-users`, "HEAD 2", "branch refs/heads/dev/wv-1022", "",
    `worktree ${WT}/epic-demo`, "HEAD 3", "branch refs/heads/dev/epic-demo", "", `worktree ${WT}/wv0933`, "HEAD 4", "branch refs/heads/dev/wv-0933", "",
    `worktree ${WT}/_main`, "HEAD 5", "branch refs/heads/main", "", `worktree ${WT}/reserve`, "HEAD 6", "branch refs/heads/dev/reserve", "", `worktree ${WT}/_stg`, "HEAD 7", "detached", ""].join("\n"));

test("разбор worktree list: путь и ветка (у отсоединённой — null)", () => {
    assert.equal(LIST.length, 7);
    assert.equal(LIST[1].br, "dev/wv-1022");
    assert.equal(LIST[6].br, null);
});

test("лишние — не слоты/оркестратор открытых эпиков, не служебные, не из «оставить»", () => {
    const epics = [{ slots: [{ slot: "wv1022-viewer-users" }], orch: { path: `${WT}/epic-demo` } }];
    const extra = (keep) => extraWorktrees(LIST, epics, { wtRoot: WT, main: MAIN, keep }).map((w) => w.p.split("/").pop());
    assert.deepEqual(extra(["reserve"]), ["wv0933"]);
    assert.deepEqual(extra([]), ["wv0933", "reserve"], "без «оставить» — и reserve");
    assert.deepEqual(extra(undefined), ["wv0933", "reserve"], "по умолчанию список «оставить» пуст");
});
