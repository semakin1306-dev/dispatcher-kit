// Места проверок по машинам конфига: удалённые первыми, эта машина — после ожидания и при свободной памяти.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPlace, profilesOf, SPILL_MS, TIERS, PROFILES, machineLabel } from "./slot-places.mjs";

const NOW = 1000000000;
const ld = (o = {}) => ({ at: NOW - 3000, cpu: 20, memTotalGB: 16, memUsedGB: 4, ...o });
const mach = (o = {}) => ({ online: true, off: false, ld: ld(), reserved: [], ...o });
const res = (kind, idx, ago = 999999) => ({ kind, idx, at: NOW - ago });
const two = profilesOf({ build1: { ssh: "build1", dir: "/srv/w", workers: 3, lanes: ["db", "main"] }, local: { workers: 1 } });
const ctx = (machines, o = {}) => ({ now: NOW, fullRun: false, jobAgeMs: 0, heavy: false, only: null, machines, ...two, ...o });

test("демо-проект: одна машина `local`, ждать удалённых ей незачем", () => {
    assert.deepEqual(TIERS, ["local"]);
    assert.equal(PROFILES.local.places.length, 4);
    assert.equal(PROFILES.local.spillMs, 0);
    assert.deepEqual(pickPlace("db", { now: NOW, machines: { local: mach() } }), { mk: "local", idx: 0 });
});

test("порядок — удалённые машины, затем local; имена из конфига", () => {
    assert.deepEqual(two.tiers, ["build1", "local"]);
    assert.equal(two.profiles.local.spillMs, SPILL_MS);
    assert.equal(machineLabel("build1", two.profiles), "build1");
    assert.equal(machineLabel("local", PROFILES), "Эта машина");
    assert.equal(machineLabel("nope", two.profiles), "nope");
});

test("машина вне конфига мест не получает", () => {
    assert.equal(pickPlace("db", ctx({ ghost: mach() })), null);
});

test("первой берётся удалённая, пока у неё есть место", () => {
    assert.deepEqual(pickPlace("db", ctx({ build1: mach(), local: mach() })), { mk: "build1", idx: 0 });
    assert.deepEqual(pickPlace("main", ctx({ build1: mach({ reserved: [res("db", 0)] }) })), { mk: "build1", idx: 1 });
});

test("дорожка вне lanes машины туда не идёт", () => {
    assert.equal(pickPlace("ops", ctx({ build1: mach() })), null);
    assert.deepEqual(pickPlace("ops", ctx({ build1: mach(), local: mach() }, { jobAgeMs: SPILL_MS })), { mk: "local", idx: 0 });
});

test("удалённая занята или не на связи — local только после SPILL_MS", () => {
    const full = mach({ reserved: [res("db", 0), res("db", 1), res("db", 2)] });
    assert.equal(pickPlace("db", ctx({ build1: full, local: mach() })), null);
    assert.deepEqual(pickPlace("db", ctx({ build1: full, local: mach() }, { jobAgeMs: SPILL_MS })), { mk: "local", idx: 0 });
    assert.equal(pickPlace("db", ctx({ build1: mach({ online: false }), local: mach() }, { jobAgeMs: SPILL_MS - 1 })), null);
    assert.equal(pickPlace("db", ctx({ build1: mach({ ld: ld({ at: NOW - 60000 }) }), local: mach() }, { jobAgeMs: SPILL_MS })).mk, "local", "замер устарел — не на связи");
});

test("пороги: сверх базового места — при свободной памяти, ЦП и после разгона прошлого", () => {
    assert.equal(pickPlace("db", ctx({ build1: mach({ reserved: [res("db", 0, 1000)] }) })), null, "прошлое место ещё разгоняется");
    assert.equal(pickPlace("db", ctx({ build1: mach({ reserved: [res("db", 0)], ld: ld({ memUsedGB: 13 }) }) })), null, "свободно 3 ГБ");
    assert.equal(pickPlace("db", ctx({ build1: mach({ reserved: [res("db", 0)], ld: ld({ cpu: 80 }) }) })), null, "ЦП 80 %");
    assert.equal(pickPlace("db", ctx({ build1: mach({ reserved: [res("db", 0)] }) })).idx, 1);
});

test("local: первое место — при свободных ≥4 ГБ (тяжёлой — ≥6) и ЦП <80 %", () => {
    const none = { build1: mach({ online: false }) }, o = { jobAgeMs: SPILL_MS };
    assert.equal(pickPlace("db", ctx({ ...none, local: mach({ ld: ld({ memUsedGB: 13 }) }) }, o)), null);
    assert.equal(pickPlace("db", ctx({ ...none, local: mach({ ld: ld({ memUsedGB: 11 }) }) }, { ...o, heavy: true })), null);
    assert.equal(pickPlace("db", ctx({ ...none, local: mach({ ld: ld({ memUsedGB: 11 }) }) }, o)).mk, "local");
    assert.equal(pickPlace("db", ctx({ ...none, local: mach({ ld: ld({ cpu: 85 }) }) }, o)), null);
    assert.equal(pickPlace("db", ctx({ ...none, local: mach({ reserved: [res("main", 0)] }) }, o)), null, "у local одно место");
});

test("перегрузка: hard — не берёт ничего, soft — сверх базового не берёт", () => {
    const hard = ld({ swapTotalGB: 4, swapUsedGB: 3.5, memUsedGB: 15, loadAvg: [40], cores: Array(8).fill(90) });
    assert.equal(pickPlace("db", ctx({ build1: mach({ ld: hard }) })), null);
    const soft = ld({ loadAvg: [14], cores: Array(8).fill(50) });
    assert.equal(pickPlace("db", ctx({ build1: mach({ ld: soft }) })).idx, 0);
    assert.equal(pickPlace("db", ctx({ build1: mach({ ld: soft, reserved: [res("db", 0)] }) })), null);
});

test("caps: heavy=false и needs; fullRun и only; off и без замера", () => {
    assert.equal(pickPlace("db", ctx({ build1: mach({ caps: { heavy: false } }) }, { heavy: true })), null);
    assert.equal(pickPlace("db", ctx({ build1: mach() }, { needs: ["go"] })), null);
    assert.equal(pickPlace("db", ctx({ build1: mach({ caps: { go: true } }) }, { needs: ["go"] })).mk, "build1");
    assert.equal(pickPlace("db", ctx({ build1: mach(), local: mach() }, { fullRun: true })), null);
    assert.equal(pickPlace("db", ctx({ build1: mach({ online: false }), local: mach() }, { only: ["build1"], jobAgeMs: 10 * SPILL_MS })), null);
    assert.equal(pickPlace("db", ctx({ build1: mach({ off: true }), local: mach({ ld: null }) }, { jobAgeMs: 10 * SPILL_MS })), null);
});
