import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-relay-start-"));
process.env.DASH_DATA = path.join(TMP, "data");
process.env.DASH_DRY = "1";
process.env.DISPATCHER_WT = path.join(TMP, "wt");
process.env.DASH_EPIC_FILE = path.join(TMP, "epics.json");
fs.mkdirSync(process.env.DASH_DATA, { recursive: true });
fs.mkdirSync(path.join(TMP, "wt"), { recursive: true });
fs.mkdirSync(path.join(TMP, "orch", ".git"), { recursive: true });
fs.writeFileSync(process.env.DASH_EPIC_FILE, JSON.stringify({ active: "e1", epics: [{ id: "e1", title: "т", status: "open", orch: { path: path.join(TMP, "orch"), branch: "orch/e1" }, slots: [{ slot: "wv9014-start", tag: "П14", branch: "dev/wv-9014", title: "старт" }] }] }));
await import("./wiring.mjs");
const { applyEpics } = await import("./trees.mjs");
const { inboxCards, loadInbox } = await import("./inbox.mjs");
const R = await import("./relay.mjs");
const { loadSessions } = await import("./agents.mjs");
const { loadJobs } = await import("./jobs.mjs");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test("папки слота ещё нет — передача ждёт подготовку (202, карточка с пометкой), а не 404", async () => {
    applyEpics();
    loadInbox();
    loadSessions();
    loadJobs([]);
    R.loadRelaySent();
    const r = await R.doRelay("orchestrator@e1", "wv9014-start", "Старт волны WV-9014: план в .claude/plans/waves");
    assert.equal(r.code, 202, JSON.stringify(r.body));
    assert.equal(r.body.waitPrep, true);
    const card = inboxCards().find((x) => x.kind === "relay" && x.to === "wv9014-start");
    assert.ok(card && card.waitPrep, "карточка с пометкой ожидания");
    assert.match(card.note, /подготов/);
    const again = await R.doRelay("orchestrator@e1", "wv9014-start", "Старт волны WV-9014: план в .claude/plans/waves");
    assert.equal(again.code, 202);
    assert.equal(inboxCards().filter((x) => x.kind === "relay" && x.to === "wv9014-start").length, 1, "вторая карточка не появилась");
});

test("просьба слота: «задача=набор», подпись задачи с фильтром и команда задачи без ввода — распознаются без оркестратора", () => {
    // демо-проект: api-test (ввод — шаблон), web-test (ввод — подстрока), lint и typecheck — гарды без ввода
    const txt = "СВОДКА: сделано.\nТесты для запуска владельцем:\n- api-test=wv-1103\n- Витрина: тесты по фильтру, фильтр «wv-1103»\n- `npm run lint` после правки\n\nДальше: жду итог.";
    assert.deepEqual(R.parseTestRequests(txt).map((r) => r.task + (r.input ? "=" + r.input : "")), ["api-test=wv-1103", "web-test=wv-1103", "lint"]);
    assert.deepEqual(R.shortTestRequests("линтер проверен, ничего запускать не надо"), [], "упоминание без команды — не просьба");
    assert.deepEqual(R.shortTestRequests("нет-такой=wv-1"), [], "неизвестная задача — не просьба");
});
