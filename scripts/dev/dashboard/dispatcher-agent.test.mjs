import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJournal, readJournals, readInbox, dispatcherEnabled } from "./dispatcher-agent.mjs";

test("parseJournal: время из имени, сухой обход, значимое, без служебных комментариев", () => {
    const j = parseJournal("2026-11-27_1659.md", "<!-- обход 2026-11-27 16:59:01 DRY=0 -->\n## Обход 16:59\n**Значимое:** да — стенд выкачен\n\n<!-- конец, код 0 -->");
    assert.equal(j.title, "Обход 16:59");
    assert.equal(j.dry, false);
    assert.equal(j.significant, true);
    assert.equal(j.code, 0);
    assert.ok(!j.md.includes("<!--"));
    assert.equal(new Date(j.at).getHours(), 16);
    const d = parseJournal("2026-11-27_1655-dry.md", "**Значимое:** нет");
    assert.equal(d.dry, true);
    assert.equal(d.significant, false);
    assert.match(d.title, /сухой/);
    assert.equal(parseJournal("notes.md", "x"), null, "чужие файлы не журнал");
    assert.equal(parseJournal("2026-11-27_1700.md", "без отметки").significant, null);
});

test("readJournals: свежие первыми, лимит, только журналы", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dk-disp-"));
    for (const n of ["2026-11-27_1655-dry.md", "2026-11-27_1657.md", "2026-11-27_1659.md", "README.txt", "x.md"])
        fs.writeFileSync(path.join(dir, n), "**Значимое:** нет");
    const js = readJournals(dir, 2);
    assert.deepEqual(js.map((j) => j.file), ["2026-11-27_1659.md", "2026-11-27_1657.md"]);
    assert.equal(dispatcherEnabled(dir), true);
    assert.equal(dispatcherEnabled(path.join(dir, "нет")), false);
    assert.deepEqual(readJournals(path.join(dir, "нет")), []);
});

test("readInbox: битые строки пропускаются, пустые сообщения отброшены", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dk-inbox-")), "inbox.jsonl");
    const rows = [JSON.stringify({ id: "a", at: 1, text: "проверь П2", read: false }), "не json",
        JSON.stringify({ id: "b", at: 2, text: "" }), JSON.stringify({ id: "c", at: 3, text: "ok", read: true })];
    fs.writeFileSync(f, rows.join("\n") + "\n");
    const ms = readInbox(f);
    assert.deepEqual(ms.map((m) => m.id), ["a", "c"]);
    assert.deepEqual(readInbox(f + ".нет"), []);
});

test("parseJournal: строки предупреждений CLI отсеиваются, лимит модели и незаконченный обход помечены", () => {
    const t = "<!-- обход -->\nPermission allow rule (../x.json): Bash(ls) has a wildcard\nYou've hit your 5-hour limit · resets 8pm\n\n<!-- конец, код 0 -->";
    const j = parseJournal("2026-11-27_1941.md", t);
    assert.ok(!j.md.includes("Permission allow rule"));
    assert.equal(j.limit, true);
    assert.equal(j.running, false);
    const r = parseJournal("2026-11-27_2001.md", "<!-- обход -->\nPermission deny rule (y): z\n## Обход 20:01\nидёт");
    assert.equal(r.running, true, "нет отметки конца — обход ещё идёт");
    assert.match(r.md, /^## Обход 20:01/);
});
