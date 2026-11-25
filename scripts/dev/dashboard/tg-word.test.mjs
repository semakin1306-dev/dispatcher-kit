// Слово человека из бота в Telegram: ответ из бота — ответ на вопрос, коммит и влив в staging; НЕ выкат стенда и прода,
// не сброс ветки и не «принудительно». Таблица одна — owner-word.mjs; здесь проверяется, что бот и команды оркестратора
// живут по ней. Ничего не вливается и не выкатывается: очередь и условия — подменные.
//   node --test scripts/dev/dashboard/tg-word.test.mjs
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORD_ACTIONS, pipelineAction, viaNote, wordGrants } from "./owner-word.mjs";

test("ответ из бота даёт ответ, коммит и влив; не даёт выкат, прод, сброс и «принудительно»", () => {
    for (const a of ["answer", "merge", "commit"])
        assert.ok(wordGrants("tg", a), "tg → " + a);
    for (const a of ["force", "reset", "stand", "prod"])
        assert.equal(wordGrants("tg", a), false, "tg не даёт " + a);
    for (const a of WORD_ACTIONS)
        assert.ok(wordGrants("", a), "набранное человеком на странице даёт всё: " + a);
    assert.equal(wordGrants("telegram", "merge"), false, "только свой ключ источника");
});

test("кнопки конвейера из бота: влив — да; «всё равно», стенд, прод — нет", () => {
    assert.ok(wordGrants("tg", pipelineAction("merge")));
    for (const [a, f] of [["merge", true], ["deploy-staging"], ["release"], ["что-то новое"]])
        assert.equal(wordGrants("tg", pipelineAction(a, f)), false, a + (f ? " всё равно" : ""));
});

test("приписка к ответу из бота сама не становится словом влива, выката или «принудительно»", () => {
    const note = viaNote("tg");
    assert.match(note, /Telegram/);
    assert.doesNotMatch(note, /вле[йи]|влить|влива|слей|слить|мерж|merge/i);
    assert.doesNotMatch(note, /выкат|раскат|деплой|deploy/i);
    assert.doesNotMatch(note, /принудительн/i);
});

// ───── команды оркестратора и кнопки сервера (нужен собранный сервер: wiring.mjs со всеми модулями) ─────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dk-tgword-"));
process.env.DASH_DATA = path.join(TMP, "data");
process.env.DASH_DRY = "1";
process.env.DISPATCHER_WT = path.join(TMP, "wt");
process.env.DASH_EPIC_FILE = path.join(TMP, "epics.json");
process.env.DASH_ORCH_STEP_MS = "200";
fs.mkdirSync(process.env.DASH_DATA, { recursive: true });
fs.mkdirSync(path.join(TMP, "orch", ".git"), { recursive: true });
fs.mkdirSync(path.join(TMP, "wt", "wv9020-a", ".git"), { recursive: true });
fs.writeFileSync(
    process.env.DASH_EPIC_FILE,
    JSON.stringify({
        active: "e1",
        epics: [
            {
                id: "e1",
                title: "т",
                status: "open",
                orch: { path: path.join(TMP, "orch"), branch: "orch/e1" },
                slots: [{ slot: "wv9020-a", tag: "П2", branch: "dev/wv-9020", title: "волна" }],
            },
        ],
    }),
);
after(async () => {
    // отложенные записи файлов состояния (журнал команд оркестратора) — дописать до уборки папки
    const st = await import("./store.mjs");
    await new Promise((r) => setTimeout(r, 300));
    await st.settled(); st.flushSync(); await st.settled();
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
await import("./wiring.mjs");
let R, A, H;
{
    const { applyEpics } = await import("./trees.mjs");
    const { loadInbox } = await import("./inbox.mjs");
    R = await import("./relay.mjs");
    A = await import("./agents.mjs");
    H = await import("./http.mjs");
    const L = await import("./orchlog.mjs");
    const { loadJobs } = await import("./jobs.mjs");
    applyEpics();
    loadInbox();
    A.loadSessions();
    loadJobs([]);
    R.loadRelaySent();
    R.loadTestReqs();
    L.loadOrchLog();
}
const ORCH = "orchestrator@e1";
let sends = [], enq = [], resets = [], real = null;

beforeEach(() => {
    sends = [];
    enq = [];
    resets = [];
    R.orchFailSeen.clear();
    real = real || { ...R._orchSteps };
    Object.assign(R._orchSteps, real, {
        send: (key, text) => sends.push({ key, text }),
        preflight: async () => ({ checks: [{ id: "regress", ok: false, text: "регресс не пройден" }], ok: false, trees: [{ key: "wv9020-a", branch: "dev/wv-9020" }] }),
        enqueue: async (o) => { enq.push(o); return { id: "j55" }; },
        reset: async (o) => { resets.push(o); return { code: 200, body: { message: "сброшено" } }; },
    });
});

const agentWith = (items) => ({ key: ORCH, items: items.map((x, i) => ({ id: "u" + i, t: "user", owner: true, at: Date.now(), ...x })), rev: items.length });
const okChecks = () => {
    R._orchSteps.preflight = async () => ({ checks: [{ id: "conflict", ok: true, text: "ок" }], ok: true, trees: [{ key: "wv9020-a", branch: "dev/wv-9020" }] });
};

test("ВЛИТЬ: ответ из Telegram со словом «влей» — слово человека, влив в очереди", async () => {
    okChecks();
    await R.orchGitCommands(agentWith([{ text: "Вопрос 1: (а) Да, влей П2", by: "tg" }]), "ВЛИТЬ П2", "msg_t1");
    assert.equal(enq.length, 1);
    assert.equal(enq[0].taskId, "merge");
});

test("ВЛИТЬ ПРИНУДИТЕЛЬНО: ответ из Telegram не снимает проверки; набранное на странице — снимает", async () => {
    await R.orchGitCommands(agentWith([{ text: "влей П2 принудительно", by: "tg" }]), "ВЛИТЬ П2 ПРИНУДИТЕЛЬНО", "msg_t2");
    assert.equal(enq.length, 0, "из Telegram «принудительно» не в счёт");
    assert.match(sends.map((s) => s.text).join("\n"), /«ВЛИТЬ П2»: не исполнено: «принудительно»[^\n]*Telegram/);
    await R.orchGitCommands(agentWith([{ text: "влей П2 принудительно" }]), "ВЛИТЬ П2 ПРИНУДИТЕЛЬНО", "msg_t3");
    assert.equal(enq.length, 1, "сам человек на странице — проверки сняты");
    assert.match(enq[0].extra.by, /принудительно/);
    await R.orchGitCommands(agentWith([{ text: "влей П2 принудительно", by: "auto-owner" }]), "ВЛИТЬ П2 ПРИНУДИТЕЛЬНО", "msg_t4");
    assert.equal(enq.length, 1, "автоответ «без владельца» — тоже не человек");
});

test("ВЛИТЬ ждёт зелёного: слово из Telegram в ожидании помнит источник — «принудительно» через него не проходит", async () => {
    const MW = await import("./merge-wait.mjs");
    await R.orchGitCommands(agentWith([{ text: "влей П2 принудительно", by: "tg" }]), "ВЛИТЬ П2", "msg_t9");
    assert.equal(enq.length, 0, "проверки не пройдены — не влив, а ожидание");
    const kept = MW.mergeWordOf("wv9020-a");
    assert.ok(kept, "слово сохранено под ожидание");
    assert.equal(kept.by, "tg");
    await R.orchGitCommands(agentWith([{ text: "ок" }]), "ВЛИТЬ П2 ПРИНУДИТЕЛЬНО", "msg_t10");
    assert.equal(enq.length, 0, "сохранённое слово из Telegram не снимает проверки");
    MW.dropMergeWait("wv9020-a", { word: true, why: "тест" });
});

test("СБРОСИТЬ: ответ из Telegram не в счёт — и в памяти агента, и после перезапуска", async () => {
    await R.orchGitCommands(agentWith([{ text: "ок, дальше" }, { text: "Вопрос 1: (а) сбрось П2", by: "tg" }]), "СБРОСИТЬ П2", "msg_t5");
    assert.equal(resets.length, 0);
    assert.match(sends.map((s) => s.text).join("\n"), /«СБРОСИТЬ П2»: не исполнено:[^\n]*не в счёт/);
    const live = { key: ORCH, items: [], rev: 0 };
    A.push(live, { id: "a1", t: "user", owner: true, text: "ок, дальше" });
    A.push(live, { id: "a2", t: "user", owner: true, by: "tg", text: "сбрось П2" });
    const fresh = { key: ORCH, items: [], rev: 0 };
    const lw = R.ownerLastWord(fresh);
    assert.deepEqual({ text: lw.text, by: lw.by }, { text: "сбрось П2", by: "tg" }, "после перезапуска источник слова сохранён");
    assert.equal(R.ownerLastText(fresh, Date.now(), { real: true }), "ок, дальше", "«настоящее» слово — только набранное самим человеком");
});

test("кнопки из Telegram (pipelineStart via tg): «всё равно», стенд, прод — 403 до очереди", async () => {
    for (const b of [{ action: "merge", slot: "wv9020-a", force: true }, { action: "deploy-staging" }, { action: "release", confirm: "ВЫКАТ", accepted: true }]) {
        const r = await H.pipelineStart(b, { via: "tg" });
        assert.equal(r.code, 403, JSON.stringify(b));
        assert.match(r.body.error, /на странице/);
    }
});
