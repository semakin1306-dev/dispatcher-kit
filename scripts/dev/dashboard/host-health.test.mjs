import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySshFailure, createHostTracker, infraFailure } from "./host-health.mjs";

test("«timed out during banner exchange» — это sshd не успел, а не сеть (kind throttle)", () => {
    const c = classifySshFailure("Connection timed out during banner exchange\nConnection to 192.0.2.10 port 22 timed out");
    assert.equal(c.kind, "throttle");
    assert.equal(c.infra, true);
    assert.match(c.line, /banner exchange/);
    assert.equal(classifySshFailure("kex_exchange_identification: read: Connection reset by peer").kind, "throttle");
    assert.equal(classifySshFailure("Connection reset by 192.0.2.10 port 22").kind, "throttle");
});

test("остальные виды: таймаут подключения, отказ, нет маршрута, ключ — и только они", () => {
    assert.equal(classifySshFailure("ssh: connect to host 192.0.2.10 port 22: Connection timed out").kind, "timeout");
    assert.equal(classifySshFailure("ssh: connect to host 198.51.100.1 port 22: Connection refused").kind, "refused");
    assert.equal(classifySshFailure("ssh: connect to host x port 22: No route to host").kind, "unreachable");
    assert.equal(classifySshFailure("ssh: Could not resolve hostname build1: Name or service not known").kind, "unreachable");
    const a = classifySshFailure("ci@build1: Permission denied (publickey).");
    assert.equal(a.kind, "auth");
    assert.equal(a.infra, false, "ключ повторами не лечится");
    assert.equal(classifySshFailure("всё хорошо, тесты прошли"), null);
});

test("«Connection refused» из вывода самих тестов не принимается за отказ машины", () => {
    const tail = "FAIL __tests__/db.spec.ts\n  Error: connect ECONNREFUSED 127.0.0.1:5432\n  Connection refused\n  Tests: 3 failed";
    assert.equal(classifySshFailure(tail), null);
    assert.equal(infraFailure(tail, { runOn: "build1", code: 1 }), null);
});

test("infraFailure: только прогон на удалённой машине и только признак в хвосте вывода", () => {
    const tail = "[build1] сборка\n✗ Connection timed out during banner exchange";
    assert.equal(infraFailure(tail, { runOn: "build1" }).kind, "throttle");
    assert.equal(infraFailure(tail, { runOn: "local" }), null, "на этой машине ssh не участвует");
    assert.equal(infraFailure(tail, { runOn: "" }), null);
    const old = "Connection timed out during banner exchange\n" + "x\n".repeat(3000) + "Tests: 1 failed";
    assert.equal(infraFailure(old, { runOn: "build1" }), null, "давняя строка в середине лога — не причина падения");
    assert.equal(infraFailure("Permission denied (publickey)", { runOn: "build1" }), null, "auth — не инфраструктурный повтор");
});

function tracker(opts) {
    const ev = [];
    let t = 1000000;
    const tr = createHostTracker({ emit: (type, d) => ev.push({ type, ...d }), now: () => t, ...opts });
    return { tr, ev, at: (ms) => {
            t += ms;
        } };
}

test("offline — после двух неудач подряд, с причиной и последней нагрузкой; возврат — с длительностью", () => {
    const { tr, ev, at } = tracker();
    tr.ok("build1");
    at(60000);
    assert.equal(tr.fail("build1", "Connection timed out during banner exchange", { last: { cpu: 20, swapUsedGB: 3 }, ssh: { active: 3, queued: 9 } }), "online", "одной неудачи мало");
    at(60000);
    assert.equal(tr.fail("build1", "Connection timed out during banner exchange", { last: { cpu: 20 } }), "offline");
    assert.equal(ev.length, 1);
    assert.equal(ev[0].type, "host.state");
    assert.equal(ev[0].state, "offline");
    assert.equal(ev[0].kind, "throttle");
    assert.equal(ev[0].fails, 2);
    assert.deepEqual(ev[0].last, { cpu: 20 });
    assert.equal(ev[0].lastOkAgoS, 120);
    at(60000);
    tr.fail("build1", "Connection timed out during banner exchange");
    assert.equal(ev.length, 1, "та же причина не шумит");
    at(540000);
    tr.ok("build1", { last: { cpu: 5 } });
    const up = ev.at(-1);
    assert.equal(up.state, "online");
    assert.equal(up.downS, 660);
    assert.equal(up.kind, "throttle");
    assert.equal(up.fails, 3);
});

test("одиночный обрыв потока без второй неудачи — host.blip, не тревога; смена причины — host.reason", () => {
    const { tr, ev, at } = tracker();
    tr.fail("build1", "");
    at(5000);
    tr.ok("build1");
    assert.deepEqual(ev.map((e) => e.type), ["host.blip"]);
    assert.equal(ev[0].fails, 1);
    tr.fail("build1", "ssh: connect to host x port 22: Connection timed out");
    tr.fail("build1", "ssh: connect to host x port 22: Connection timed out");
    tr.fail("build1", "ssh: connect to host x port 22: Connection refused");
    assert.deepEqual(ev.map((e) => e.type), ["host.blip", "host.state", "host.reason"]);
    assert.equal(ev.at(-1).kind, "refused");
});

test("флаппинг считается в окне 10 минут", () => {
    const { tr, ev, at } = tracker();
    for (let i = 0; i < 3; i++) {
        tr.fail("h", "x");
        tr.fail("h", "x");
        at(30000);
        tr.ok("h");
        at(30000);
    }
    assert.ok(ev.filter((e) => e.type === "host.state").at(-1).flaps >= 5);
    assert.equal(tr.snapshot().h.state, "online");
});

import { infraRequeueDue, INFRA_BACK_MS, INFRA_TRIES } from "./host-health.mjs";

test("возврат прогона после сбоя ssh: только infra, машина на связи ≥45 с, не больше 3 раз, без двойной постановки", () => {
    const j = { infra: "throttle", endedAt: 1000000 }, ok = { hostUp: true, now: 1000000 + INFRA_BACK_MS };
    assert.equal(infraRequeueDue(j, ok), true);
    assert.equal(infraRequeueDue(j, { ...ok, now: 1000000 + INFRA_BACK_MS - 1 }), false, "машина только что вернулась — ждём");
    assert.equal(infraRequeueDue(j, { ...ok, hostUp: false }), false);
    assert.equal(infraRequeueDue({ ...j, infraTry: INFRA_TRIES }, ok), false, "повторы исчерпаны");
    assert.equal(infraRequeueDue({ ...j, requeued: true }, ok), false);
    assert.equal(infraRequeueDue({ endedAt: 1 }, ok), false, "обычный прерванный прогон идёт другой дорогой (bootInterrupted)");
});

test("обрыв ssh посреди прогона (ServerAlive) — отказ инфраструктуры", () => {
    const c = classifySshFailure("✗ guard:referral-program-delete — Timeout, server 192.0.2.10 not responding.");
    assert.equal(c && c.kind, "dropped");
    assert.equal(c.infra, true);
});

test("машину перезагрузили посреди прогона («Connection reset by peer») — отказ инфраструктуры", () => {
    const c = classifySshFailure("Read from remote host 192.0.2.10: Connection reset by peer\nclient_loop: send disconnect: Connection reset by peer");
    assert.equal(c && c.kind, "dropped");
    assert.equal(c.infra, true);
});
