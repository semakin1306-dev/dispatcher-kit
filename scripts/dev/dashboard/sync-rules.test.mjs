// Правила подтягивания staging в ветку слота (sync-rules.mjs): «Дальше» при конфликте, ответ slot-sync, письма агенту.
//   node --test scripts/dev/dashboard/sync-rules.test.mjs
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { conflictNext, dirtyBlockers, inEpic, isSyncAsk, parseSync, syncConflictText, syncDirtyText } from "./sync-rules.mjs";

describe("conflictNext — «Дальше» у ветки, конфликтующей со staging", () => {
    test("конфликт в package.json — «подтянуть staging», кнопка slot-sync", () => {
        const n = conflictNext({ ahead: 3, dirtyTracked: 0, conflict: ["package.json"] });
        assert.equal(n.kind, "warn");
        assert.equal(n.act, "slotsync");
        assert.match(n.text, /^Конфликт со staging: package\.json — подтянуть staging \(slot-sync\)/);
    });
    test("чисто, ещё считается, влито, незакоммичено, без коммитов — правила нет", () => {
        for (const t of [
            { ahead: 1, conflict: [] },
            { ahead: 1, conflict: null },
            { ahead: 1, conflict: ["a"], verdict: { merged: true } },
            { ahead: 1, dirtyTracked: 2, conflict: ["a"] },
            { ahead: 0, conflict: ["a"] },
        ])
            assert.equal(conflictNext(t), null, JSON.stringify(t));
    });
    test("много файлов — первые шесть и счёт остальных", () => {
        assert.match(conflictNext({ ahead: 1, conflict: ["1", "2", "3", "4", "5", "6", "7", "8"] }).text, /6 и ещё 2 —/);
    });
    test("конфликт отдан агенту — карточка говорит «у агента», посреди слияния — «агент разбирает», давно — снова просим", () => {
        const now = 1_800_000_000_000, ask = { at: now - 60e3, files: ["a.go", "b.go"], kind: "conflict" };
        const n1 = conflictNext({ conflict: ["a.go"], ahead: 2, dirtyTracked: 0, syncAsk: ask }, now);
        assert.equal(n1.kind, "info");
        assert.match(n1.text, /отдан агенту/);
        assert.match(conflictNext({ conflict: ["a.go"], ahead: 2, dirtyTracked: 12, syncAsk: ask }, now).text, /Агент разбирает конфликт/);
        assert.equal(conflictNext({ conflict: ["a.go"], ahead: 2, dirtyTracked: 0, syncAsk: { ...ask, at: now - 7 * 3600e3 } }, now).kind, "warn");
    });
});

describe("parseSync — ответ slot-sync", () => {
    test("конфликт — список файлов", () => {
        assert.deepEqual(parseSync("CONFLICT .gitignore package.json \nWHY Automatic merge failed; fix conflicts"), { conflict: [".gitignore", "package.json"] });
    });
    test("«конфликт в 0 файлах» — отказ git, а не конфликт: причина и файлы видны", () => {
        const r = parseSync("CONFLICT \nWHY error: Your local changes to the following files would be overwritten by merge: e2e.config.ts");
        assert.equal(r.conflict, undefined);
        assert.match(r.fail, /незакоммиченные правки в файлах, которые правит и staging: e2e\.config\.ts/);
        assert.deepEqual(r.dirty, ["e2e.config.ts"]);
        assert.match(parseSync("CONFLICT").fail, /конфликтных файлов нет — влив откатан/);
    });
    test("ок, перемотка, свои коммиты, сбой", () => {
        assert.deepEqual(parseSync("OK 0 3"), { ok: true, text: "уже на staging" });
        assert.deepEqual(parseSync("OK ff 12"), { ok: true, text: "перемотано на staging" });
        assert.deepEqual(parseSync("OK merge 4"), { ok: true, text: "staging влит в ветку волны" });
        assert.ok(parseSync("SKIP own 2").skip);
        assert.match(parseSync("").fail, /нет ответа/);
    });
    test("незакоммиченные правки — файлы из сообщения git столбиком и одной строкой", () => {
        const col =
            "error: Your local changes to the following files would be overwritten by merge:\n\tdocs/a/one.md\n\tdocs/b/two.md\nPlease commit your changes or stash them before you merge.\nAborting";
        assert.deepEqual(dirtyBlockers(col), ["docs/a/one.md", "docs/b/two.md"]);
        assert.deepEqual(dirtyBlockers("error: Your local changes to the following files would be overwritten by merge: src/a.ts src/b.ts"), ["src/a.ts", "src/b.ts"]);
        assert.deepEqual(dirtyBlockers("Automatic merge failed"), []);
    });
});

describe("письма агенту", () => {
    test("ветка подставляется, а без ветки скобок нет", () => {
        assert.match(syncConflictText("dev/wv-0001-demo", ["package.json"]), /^staging ушёл вперёд, и при вливе его в твою ветку \(dev\/wv-0001-demo\) конфликт в файлах:\n- package\.json\n/);
        const t = syncConflictText(undefined, ["a"]);
        assert.ok(!/undefined|\(\)/.test(t));
        assert.match(t, /в твою ветку конфликт/);
    });
    test("ход — ответ на письмо о подтягивании (isSyncAsk): и о конфликте, и о незакоммиченных правках", () => {
        assert.equal(isSyncAsk(syncConflictText("dev/wv-1", ["package.json"])), true);
        assert.equal(isSyncAsk(syncDirtyText("dev/wv-1", ["a.ts"])), true);
        assert.equal(isSyncAsk("Влей staging в ветку, пожалуйста"), false);
    });
});

test("inEpic — состав поезда из веток своего эпика", () => {
    const trees = [{ key: "a", epic: "e1" }, { key: "b", epic: "e1" }, { key: "c", epic: "e2" }, { key: "без-эпика" }];
    assert.deepEqual(trees.filter((t) => inEpic(t, "e1")).map((t) => t.key), ["a", "b"]);
    assert.equal(trees.filter((t) => inEpic(t, null)).length, 4);
});
