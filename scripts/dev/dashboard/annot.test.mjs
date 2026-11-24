import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-annot-"));
process.env.DASH_DATA = TMP;
process.env.DASH_ANNOT_SINK = "log";

const { S } = await import("./state.mjs");
const { agents } = await import("./agents.mjs");
const { ownerAnswer, liveIds, OUTBOX } = await import("./annot.mjs");
const { settled } = await import("./store.mjs");

after(async () => {
    await settled();
    fs.rmSync(TMP, { recursive: true, force: true });
});

S.agentSessions = S.agentSessions || {};
S.inbox = S.inbox || [];

describe("ответ на «Вопросы владельцу» — в ту сессию, что спросила", () => {
    test("продолжение сессии с новым id — та же беседа: прежние id из записи сессии входят в liveIds; новая сессия — нет", () => {
        S.agentSessions["slot-x"] = { id: "new-2", at: 1, prev: ["old-1"] };
        assert.deepEqual(liveIds("slot-x", { key: "slot-x", sessionId: "new-2" }), ["new-2", "old-1"]);
        S.agentSessions["slot-y"] = { id: "fresh-3", at: 1 };
        assert.deepEqual(liveIds("slot-y", { key: "slot-y", sessionId: "fresh-3" }), ["fresh-3"]);
        assert.deepEqual(liveIds("slot-z", { key: "slot-z", sessionId: null }), []);
    });
    test("ownerAnswer (отладка, журнал вместо агента): живая сессия = спросившая — коротко; ротация — цитата; карточка снята; ответ из бота — с припиской об источнике", async () => {
        S.inbox = [{ id: "ib1", kind: "ownerq", tree: "slot-q", text: "Брать период из имени файла?", at: Date.now(), sid: "s-ask" }];
        agents.set("slot-q", { key: "slot-q", sessionId: "s-ask", dead: false, items: [], rev: 0, pending: new Map() });
        const r1 = await ownerAnswer("slot-q", "да", "");
        assert.equal(r1.code, 200);
        assert.equal(r1.body.route, "same");
        assert.equal(S.inbox.length, 0);
        S.inbox = [{ id: "ib2", kind: "ownerq", tree: "slot-q", text: "Лист один?", at: Date.now(), sid: "s-ask" }];
        agents.get("slot-q").sessionId = "s-rotated";
        const r2 = await ownerAnswer("slot-q", "один", "");
        assert.equal(r2.body.route, "other");
        const out = fs.readFileSync(OUTBOX, "utf8").trim().split("\n").map((l) => JSON.parse(l));
        assert.match(out[0].text, /^Ответ владельца на твои/);
        assert.match(out[1].text, /> Лист один\?/);
        assert.equal(out[1].sid, "s-ask");
        assert.equal((await ownerAnswer("slot-q", "ещё", "")).code, 404);
        assert.doesNotMatch(out[0].text, /Telegram/);
        S.inbox = [{ id: "ib3", kind: "ownerq", tree: "slot-q", text: "Колонок три?", at: Date.now(), sid: "s-rotated" }];
        const r3 = await ownerAnswer("slot-q", "три", "", { via: "tg" });
        assert.equal(r3.code, 200);
        const last = fs.readFileSync(OUTBOX, "utf8").trim().split("\n").map((l) => JSON.parse(l)).pop();
        assert.match(last.text, /Ответ пришёл из Telegram/);
    });
});
