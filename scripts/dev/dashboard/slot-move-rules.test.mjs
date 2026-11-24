import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { moveSlot, removeSlot, findSlot, nextTagAndColor, waveOf, PALETTE } from "./slot-move-rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-slotmove-"));

const regFixture = () => ({
    active: "a",
    epics: [
        { id: "a", title: "А", status: "open", orch: { path: path.join(TMP, "orch-a"), branch: "dev/epic-a" }, slots: [
                { tag: "П3", slot: "wv0948-docs", branch: "dev/wv-0948-docs", title: "WV-0948 портал", color: "#9333ea", emoji: "🟪" },
                { tag: "П26", slot: "wv0986-lead", branch: "dev/wv-0986-lead", title: "WV-0986 расчёт", color: "#16a34a", emoji: "🟩" },
                { tag: "П27", slot: "wv0985-commission", branch: "dev/wv-0985-commission", title: "WV-0985 комиссия", color: "#9333ea", emoji: "🟪", after: ["wv0986-lead"], presets: [{ task: "web-test", input: "wv-0985" }] },
                { tag: "П28", slot: "wv0990-next", branch: "dev/wv-0990-next", title: "WV-0990 следом", color: "#2563eb", emoji: "🟦", after: ["wv0985-commission", "wv0986-lead"] },
            ] },
        { id: "b", title: "Б", status: "open", orch: { path: path.join(TMP, "orch-b"), branch: "dev/epic-b" }, slots: [
                { tag: "П1", slot: "wv1009-events", branch: "dev/wv-1009-events", title: "WV-1009 события", color: "#16a34a", emoji: "🟩" },
                { tag: "П3", slot: "wv1011-ui", branch: "dev/wv-1011-ui", title: "WV-1011 интерфейс", color: "#2563eb", emoji: "🟦" },
            ] },
        { id: "z", title: "закрытый", status: "closed", orch: { path: path.join(TMP, "orch-z"), branch: "dev/epic-z" }, slots: [] },
    ],
});

test("перенос: имя, ветка и пресеты сохраняются; метка и цвет — следующие в новом эпике; след переноса записан", () => {
    const reg = regFixture();
    const rep = moveSlot(reg, { key: "П27", from: "a", to: "b", now: "2026-11-10T00:00:00Z" });
    assert.equal(rep.oldTag, "П27");
    assert.equal(rep.newTag, "П4");
    const b = reg.epics[1], moved = b.slots.at(-1);
    assert.equal(moved.slot, "wv0985-commission");
    assert.equal(moved.branch, "dev/wv-0985-commission");
    assert.deepEqual(moved.presets, [{ task: "web-test", input: "wv-0985" }]);
    assert.equal(moved.color, "#9333ea", "первый цвет палитры, не занятый в эпике b");
    assert.equal(moved.emoji, "🟪");
    assert.deepEqual(moved.movedFrom, [{ epic: "a", tag: "П27", at: "2026-11-10T00:00:00Z" }]);
    assert.ok(!reg.epics[0].slots.some((s) => s.slot === "wv0985-commission"), "из старого эпика ушёл");
});

test("перенос: зависимость на слот старого эпика снимается и называется; у соседа в старом эпике снимается ссылка на ушедший", () => {
    const reg = regFixture();
    const rep = moveSlot(reg, { key: "wv0985-commission", to: "b" });
    assert.deepEqual(rep.droppedAfter, ["wv0986-lead"]);
    assert.equal(reg.epics[1].slots.at(-1).after, undefined);
    assert.deepEqual(rep.unlinked, ["П28"]);
    assert.deepEqual(reg.epics[0].slots.find((s) => s.tag === "П28").after, ["wv0986-lead"]);
});

test("перенос: отказы — нет эпика, закрытый эпик, тот же эпик, метка в нескольких эпиках без --from, нет слота", () => {
    assert.throws(() => moveSlot(regFixture(), { key: "П27", to: "нет" }), /нет эпика нет/);
    assert.throws(() => moveSlot(regFixture(), { key: "П27", to: "z" }), /закрыт/);
    assert.throws(() => moveSlot(regFixture(), { key: "П27", from: "a", to: "a" }), /уже в эпике/);
    assert.throws(() => moveSlot(regFixture(), { key: "П3", to: "b" }), /нескольких эпиках/);
    assert.throws(() => moveSlot(regFixture(), { key: "П99", to: "b" }), /нет слота П99/);
    assert.equal(findSlot(regFixture(), "П3", "a").slot.slot, "wv0948-docs");
});

test("снятие: запись уходит, зависимости соседей снимаются, метки остальных не перенумеровываются", () => {
    const reg = regFixture();
    const rep = removeSlot(reg, { key: "П27", epic: "a" });
    assert.equal(rep.slot.slot, "wv0985-commission");
    assert.deepEqual(rep.unlinked, ["П28"]);
    assert.deepEqual(reg.epics[0].slots.map((s) => s.tag), ["П3", "П26", "П28"]);
});

test("метка и цвет: П(max+1) и первый свободный цвет — то же правило, что у add-slot; номер волны — из названия или ветки", () => {
    assert.deepEqual(nextTagAndColor({ slots: [] }), { tag: "П1", emoji: PALETTE[0][0], color: PALETTE[0][1] });
    assert.equal(nextTagAndColor({ slots: [{ tag: "П7", color: PALETTE[0][1] }] }).tag, "П8");
    assert.equal(waveOf({ title: "WV-0985 комиссия" }), "0985");
    assert.equal(waveOf({ title: "x", branch: "dev/wv-0987-portal" }), "0987");
    assert.equal(waveOf({ title: "x" }), "");
});

const cli = (reg, ...args) => spawnSync(process.execPath, [path.join(HERE, "..", "epic.mjs"), ...args], { encoding: "utf8", env: { ...process.env, DASH_EPIC_FILE: reg, DISPATCHER_WT: path.join(TMP, "wt") } });

test("CLI move-slot: сухой прогон не пишет; без него — реестр переписан, план волны скопирован в папку оркестратора нового эпика", () => {
    const reg = path.join(TMP, "epics-move.json");
    fs.writeFileSync(reg, JSON.stringify(regFixture()));
    const srcPlans = path.join(TMP, "orch-a", ".claude", "plans", "waves");
    fs.mkdirSync(srcPlans, { recursive: true });
    fs.writeFileSync(path.join(srcPlans, "WV-0985-commission.md"), "# план");
    fs.writeFileSync(path.join(srcPlans, "WV-09851-chuzhoy.md"), "x");
    const before = fs.readFileSync(reg, "utf8");
    const dry = cli(reg, "move-slot", "П27", "--from", "a", "--to", "b", "--dry-run");
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.match(dry.stdout, /a П27 → b П4/);
    assert.equal(fs.readFileSync(reg, "utf8"), before);
    const r = cli(reg, "move-slot", "П27", "--from", "a", "--to", "b");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const after = JSON.parse(fs.readFileSync(reg, "utf8"));
    assert.equal(after.epics[1].slots.at(-1).slot, "wv0985-commission");
    const dstPlans = path.join(TMP, "orch-b", ".claude", "plans", "waves");
    assert.ok(fs.existsSync(path.join(dstPlans, "WV-0985-commission.md")));
    assert.ok(!fs.existsSync(path.join(dstPlans, "WV-09851-chuzhoy.md")), "чужой номер не захвачен");
    assert.ok(fs.existsSync(reg + ".prev"), "прошлый реестр — в скользящей копии");
    const no = cli(reg, "move-slot", "П27", "--from", "a", "--to", "b");
    assert.notEqual(no.status, 0);
    assert.match(no.stderr, /нет слота/);
});

test("CLI remove-slot: снимает запись и не трогает ветку и папку", () => {
    const reg = path.join(TMP, "epics-rm.json");
    fs.writeFileSync(reg, JSON.stringify(regFixture()));
    const r = cli(reg, "remove-slot", "П3", "--epic", "a");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /снят из реестра/);
    const after = JSON.parse(fs.readFileSync(reg, "utf8"));
    assert.ok(!after.epics[0].slots.some((s) => s.slot === "wv0948-docs"));
    assert.ok(after.epics[1].slots.some((s) => s.tag === "П3"), "П3 другого эпика цел");
});
