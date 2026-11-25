import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-jobepic-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
process.env.DASH_DATA = TMP;
process.env.DASH_DRY = "1";
process.env.DASH_EPIC_FILE = path.join(TMP, "epics.json");
fs.writeFileSync(
    process.env.DASH_EPIC_FILE,
    JSON.stringify({
        active: "e1",
        epics: [
            {
                id: "e1",
                title: "эпик",
                status: "open",
                orch: { path: TMP, branch: "dev/epic-e1" },
                slots: [{ slot: "wv0001-a", tag: "П1", branch: "dev/wv-0001-a", area: "api" }],
            },
        ],
    }),
);
const { jobEpic } = await import("./runner.mjs");
const { loadEpics } = await import("../slots.mjs");

test("метка эпика на выкате главнее вагонов", () => {
    assert.equal(jobEpic({ task: "deploy-staging", tree: "orchestrator-staging", epic: "new-epic", wagons: [{ key: "x" }] }), "new-epic");
});

test("старый выкат без метки берёт эпик по вагонам, а не светится во всех", () => {
    const e = loadEpics().epics.find((x) => x.slots.length);
    assert.ok(e, "в реестре теста есть эпик со слотом");
    const j = { task: "deploy-staging", tree: "orchestrator-staging", epic: null, wagons: [{ key: "нет-такой" }, { key: e.slots[0].slot }] };
    assert.equal(jobEpic(j), e.id);
});

test("без вагонов и без метки остаётся общим; другие задачи staging не трогаем", () => {
    assert.equal(jobEpic({ task: "deploy-staging", tree: "orchestrator-staging", epic: null, wagons: [] }), null);
    assert.equal(jobEpic({ task: "deploy-staging", tree: "orchestrator-staging", epic: null, wagons: [{ key: "нет-такой" }] }), null);
    assert.equal(jobEpic({ task: "lint", tree: "orchestrator-staging", epic: null, wagons: [{ key: "x" }] }), null);
});
