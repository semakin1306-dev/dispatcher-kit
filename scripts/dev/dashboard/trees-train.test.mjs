import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trees-train-"));
process.env.DASH_EPIC_FILE = path.join(dir, "epics.json");
process.env.DASH_DATA = dir;
process.env.DASH_DRY = "1";
const OLD = { tag: "П1", slot: "wv0999-old", branch: "dev/wv-0999-old", title: "WV-0999 старый", color: "#16a34a", area: "api", presets: [{ task: "api-test", input: "wv-0999" }] };
const TR = { tag: "Т1", slot: "tr-api-ep", kind: "train", trainArea: "api", area: "api", branch: "dev/tr-api-ep", title: "API", color: "#2563eb", build: true, maxWagons: 4,
    wagons: [{ wave: "WV-1014", title: "a", presets: [{ task: "api-test", input: "wv-1014" }] }, { wave: "WV-1015", title: "b", presets: [{ task: "web-test", input: "wv-1015" }] }] };
const RO = { tag: "П2", slot: "wv1001-look", branch: "dev/wv-1001-look", title: "WV-1001 разведка", color: "#9333ea", readOnly: true, presets: [] };
fs.writeFileSync(process.env.DASH_EPIC_FILE, JSON.stringify({ active: "ep", epics: [{ id: "ep", title: "э", status: "open", orch: { branch: "dev/epic-ep", path: path.join(dir, "epic-ep") }, slots: [OLD, TR, RO] }] }));
const { TREES, PRESETS, applyEpics, setTrainPresets } = await import("./trees.mjs");
after(async () => {
    const st = await import("./store.mjs");
    await st.settled(); st.flushSync(); await st.settled();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("слот без wagons — дерево и тесты как в реестре; поезд — вагоны, область и тесты первого вагона до снимка", () => {
    applyEpics();
    const old = TREES.find((t) => t.key === OLD.slot), tr = TREES.find((t) => t.key === TR.slot);
    assert.deepEqual(Object.keys(old).sort(), ["area", "color", "emoji", "epic", "key", "kind", "path", "plannedBranch", "readOnly", "tag", "title"]);
    assert.equal(old.area, "api");
    assert.deepEqual(PRESETS[OLD.slot], OLD.presets);
    assert.equal(tr.train, true);
    assert.equal(tr.kind, "slot");
    assert.equal(tr.trainArea, "api");
    assert.deepEqual(tr.wagons.map((w) => w.wave), ["WV-1014", "WV-1015"]);
    assert.deepEqual(PRESETS[TR.slot], [{ task: "api-test", input: "wv-1014" }]);
});

test("слот «только чтение» — по полю readOnly реестра; у обычного слота и поезда — нет", () => {
    applyEpics();
    assert.equal(TREES.find((t) => t.key === RO.slot).readOnly, true);
    assert.equal(TREES.find((t) => t.key === OLD.slot).readOnly, false);
    assert.equal(TREES.find((t) => t.key === TR.slot).readOnly, false);
});

test("тесты поезда (вагона дерева) переживают перечитывание реестра", () => {
    setTrainPresets(TR.slot, [{ task: "web-test", input: "wv-1015" }]);
    assert.deepEqual(PRESETS[TR.slot], [{ task: "web-test", input: "wv-1015" }]);
    applyEpics();
    assert.deepEqual(PRESETS[TR.slot], [{ task: "web-test", input: "wv-1015" }]);
});

test("поле maxWagons старого реестра не читается", () => {
    applyEpics();
    assert.equal("maxWagons" in TREES.find((t) => t.key === TR.slot), false);
});

test("ручные отметки станций поезда — по вагону дерева (ветка одна на все вагоны); у слота — по ветке", async () => {
    applyEpics();
    const { manualKeyOf } = await import("./stations.mjs");
    setTrainPresets(TR.slot, [], "WV-1015");
    assert.equal(manualKeyOf(TR.slot + "|" + TR.branch), TR.slot + "|" + TR.branch + "#WV-1015");
    assert.equal(manualKeyOf(OLD.slot + "|" + OLD.branch), OLD.slot + "|" + OLD.branch, "у слота — как раньше");
});
