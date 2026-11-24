import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DASH_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dash-snap-"));
process.env.DASH_DRY = "1";
const N = await import("./snapshot.mjs");
const tr = (key, o = {}) => ({ key, exists: true, fp: "f-" + key, ...o });

describe("holdShaken — ветка в движении берётся из прошлого снимка", () => {
    const old = [tr("a", { ahead: 1 }), tr("b")];
    test("поколение не сменилось, перемотки нет — свежее состояние", () => {
        const fresh = [tr("a", { ahead: 2 }), tr("b")], g0 = new Map([["a", 3]]);
        const h = N.holdShaken(fresh, old, g0, (k) => (k === "a" ? 3 : 0), () => false);
        assert.deepEqual(h.held, []);
        assert.equal(h.again, false);
        assert.equal(h.trees[0], fresh[0]);
    });
    test("зеркало прошло посреди чтения (поколение сменилось) — прошлое состояние и повторная сборка", () => {
        const fresh = [tr("a", { ahead: 0, dirtyTracked: 11, fp: "смесь" }), tr("b")];
        const h = N.holdShaken(fresh, old, new Map([["a", 3]]), (k) => (k === "a" ? 5 : 0), () => false);
        assert.deepEqual(h.held, ["a"]);
        assert.equal(h.again, true);
        assert.equal(h.trees[0], old[0]);
        assert.equal(h.trees[1], fresh[1]);
    });
    test("перемотка идёт сейчас — прошлое состояние", () => {
        const h = N.holdShaken([tr("a"), tr("b")], old, new Map(), () => 0, (k) => k === "b");
        assert.deepEqual(h.held, ["b"]);
        assert.equal(h.again, true);
    });
    test("отпечаток не снялся — прошлое, но не дольше FP_HOLD_MS и без повторной сборки", () => {
        const o = [tr("a")], now = 1000000;
        let h = N.holdShaken([tr("a", { fp: null })], o, new Map(), () => 0, () => false, now);
        assert.deepEqual(h.held, ["a"]);
        assert.equal(h.again, false);
        h = N.holdShaken([tr("a", { fp: null })], o, new Map(), () => 0, () => false, now + N.FP_HOLD_MS + 1);
        assert.deepEqual(h.held, [], "держим не дольше FP_HOLD_MS — дальше правда снимка");
    });
    test("ветки не было в прошлом снимке — держать нечего", () => {
        const h = N.holdShaken([tr("c", { fp: null })], old, new Map([["c", 1]]), () => 2, () => true);
        assert.deepEqual(h.held, []);
    });
});

describe("отметки перемотки вложенные (перемотка серверного слота зовёт зеркало)", () => {
    test("снимает последняя, поколение растёт на каждой", () => {
        const g = N.syncGen("x");
        N.markSyncing("x");
        N.markSyncing("x");
        N.unmarkSyncing("x");
        assert.equal(N.isSyncing("x"), true, "внешняя отметка ещё стоит");
        N.unmarkSyncing("x");
        assert.equal(N.isSyncing("x"), false);
        assert.equal(N.syncGen("x"), g + 4);
    });
});
