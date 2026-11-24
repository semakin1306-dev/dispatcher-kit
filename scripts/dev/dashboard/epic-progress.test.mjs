import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a8-"));
process.env.DASH_DRY = "1";
process.env.DASH_DATA = dir;
const { S } = await import("./state.mjs");
const { readEventsSince, epicProgressOp } = await import("./epic-progress.mjs");
const H = 3600e3, NOW = Date.parse("2026-11-09T12:00:00Z"), ORCH = "orchestrator@ep";
const file = path.join(dir, "ev.jsonl");

fs.writeFileSync(file, [
    "битая строка",
    JSON.stringify({ at: NOW - 200 * H, type: "owner.message", key: ORCH }),
    JSON.stringify({ at: NOW - 2 * H, type: "orch.command", tree: ORCH, cmd: "ВЛИТЬ", target: "П1", ok: false, detail: "нет слова «влей»" }),
    JSON.stringify({ at: NOW - H, type: "agent.turn", key: "wv1", in: 1, out: 2, cr: 3, cw: 4, cost: 0.1 }),
].join("\n") + "\n");

test("хвост журнала: только не старше since, битые строки и обрезанная первая строка пропускаются", async () => {
    assert.equal((await readEventsSince(file, NOW - 100 * H)).length, 2);
    const cut = await readEventsSince(file, 0, 120);
    assert.ok(cut.length >= 1 && cut.every((e) => e.type));
});

test("сводка по эпику: нет эпика — 404; вопросы владельцу из карточек; токены слота на сервере; кеш 30 с", async () => {
    S.EPICS = [{ id: "ep", slots: [{ tag: "П1", slot: "wv1", branch: "dev/wv-1" }] }];
    S.jobs = [{ id: "j1", epic: "ep", tree: "wv1", task: "commit", status: "ok", queuedAt: NOW - 3 * H, startedAt: NOW - 3 * H, endedAt: NOW - 3 * H }];
    S.inbox = [{ id: "i1", kind: "ownerq", tree: ORCH, text: "влить?" }, { id: "i2", kind: "ownerq", tree: "чужой", text: "?" }];
    assert.equal((await epicProgressOp("нет", 24, { now: NOW, file })).code, 404);
    const r = await epicProgressOp("ep", 24, { now: NOW, file });
    assert.equal(r.code, 200);
    assert.equal(r.body.owner.questions, 1);
    assert.equal(r.body.readyNow, 1);
    assert.equal(r.body.ready[0].hold.kind, "слово владельца");
    assert.deepEqual(r.body.tokens.map((t) => [t.tag, t.turns]), [["П1", 1]]);
    S.inbox = [];
    assert.equal((await epicProgressOp("ep", 24, { now: NOW + 10e3, file })).body.owner.questions, 1, "из кеша");
    assert.equal((await epicProgressOp("ep", 24, { now: NOW + 31e3, file })).body.owner.questions, 0, "кеш истёк");
});
