// relay-context.test.mjs — агенту при передаче приходит только намеренное: подпись происхождения по правде, блок доклада
// и справка диспетчерской. Ни рассуждений из ответа, ни обрывков посреди строки без пометки «…».
//   node --test scripts/dev/dashboard/relay-context.test.mjs
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dk-relay-ctx-"));
process.env.DASH_DATA = path.join(TMP, "data");
process.env.DASH_DRY = "1";
process.env.DISPATCHER_WT = path.join(TMP, "wt");
process.env.DASH_EPIC_FILE = path.join(TMP, "epics.json");
const ORCH = "orchestrator@e1", A = "wv9201-a", B = "wv9202-b", C = "wv9203-c";
fs.mkdirSync(process.env.DASH_DATA, { recursive: true });
// папка дерева «есть», когда в ней есть .git (git.mjs exists)
for (const d of [path.join(TMP, "orch"), path.join(TMP, "wt", A), path.join(TMP, "wt", B)])
    fs.mkdirSync(path.join(d, ".git"), { recursive: true });
fs.writeFileSync(process.env.DASH_EPIC_FILE, JSON.stringify({
    active: "e1",
    epics: [{
        id: "e1", title: "т", status: "open", orch: { path: path.join(TMP, "orch"), branch: "orch/e1" },
        slots: [
            { slot: A, tag: "П1", branch: "dev/wv-9201-a", title: "а" },
            { slot: B, tag: "П2", branch: "dev/wv-9202-b", title: "б" },
            // папки нет — передача ждёт подготовку
            { slot: C, tag: "П3", branch: "dev/wv-9203-c", title: "в" },
        ],
    }],
}));
await import("./wiring.mjs");
const { applyEpics, treeByKey } = await import("./trees.mjs");
const { inboxCards, loadInbox } = await import("./inbox.mjs");
const { S } = await import("./state.mjs");
const R = await import("./relay.mjs");
const AG = await import("./agents.mjs");
const { loadJobs } = await import("./jobs.mjs");
const { short } = await import("./config.mjs");
const { prompt } = await import("../prompts.mjs");
const P = await import("./prompt.mjs");
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const FENCE = "`".repeat(3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Поддельный живой агент: сообщения ему видны в ленте записями t:"user". */
function fake(key) {
    const a = { key, items: [], rev: 0, busy: false, dead: false, pinging: false, pending: new Map(), ready: true, rt: { send() { } } };
    AG.agents.set(key, a);
    return a;
}
const got = (a) => a.items.filter((x) => x.t === "user").map((x) => x.text);
const notes = (a) => a.items.filter((x) => x.t === "status").map((x) => x.text).join("\n");

let sends = [], real = null;
beforeEach(() => {
    applyEpics();
    loadInbox();
    loadJobs([]);
    R.loadRelaySent();
    S.inbox.length = 0;
    S.relaySent = [];
    S.orchHeld = {};
    // Справка о слоте собирается по снимку: без снимка она пустая, и сообщение видно целиком без git.
    S.snap = null;
    S.rebuilding = Promise.resolve();
    AG.agents.clear();
    real = real || { ...R._orchSteps };
    sends = [];
    Object.assign(R._orchSteps, real, { send: (key, text, about) => sends.push({ key, text, about }) });
});

// Ответ агента слота как он бывает: рассуждения, пересказ инструментов, блок доклада и решение.
const THINK = "Сначала посмотрю логи. Запустил grep по src, нашёл три места — РАССУЖДЕНИЕ-НЕ-ДЛЯ-ОРКЕСТРАТОРА. ".repeat(80);
const BLOCK = "WV-9201 (слот П1): ЖДУ.\nСделано: правка разбора.\nПродолжу, когда придёт итог прогона.";
const answer = (block = BLOCK, decision = "ДАЛЬШЕ: ОРКЕСТРАТОРУ") => THINK + "\n\n" + (block ? FENCE + "text\n" + block + "\n" + FENCE + "\n" : "") + decision;

// ── 1. передача без блока ──

test("решение «ДАЛЬШЕ: ОРКЕСТРАТОРУ» без блока ```text: оркестратору ничего, слоту — просьба оформить блоком", async () => {
    const slot = fake(A), orch = fake(ORCH);
    await R.applyDecision(slot, answer(""));
    assert.deepEqual(got(orch), [], "сырой ответ не ушёл оркестратору");
    assert.equal(inboxCards().filter((x) => x.kind === "relay").length, 0, "карточки с сырым ответом нет");
    const mine = sends.filter((x) => x.key === A);
    assert.equal(mine.length, 1, "слоту одно сообщение диспетчерской");
    assert.equal(mine[0].text, prompt("relay-no-block", { to: treeByKey(ORCH).tag }));
    assert.match(notes(slot), /не передан/);
    await R.applyDecision(slot, answer(""));
    assert.equal(sends.filter((x) => x.key === A).length, 1, "повтор той же ошибки подряд не порождает вторую просьбу (без пинг-понга)");
});

test("блок отсеян relayDecision («ЖДУ» без просьб), но слот явно решил «ОРКЕСТРАТОРУ»: уходит ровно блок, без рассуждений", async () => {
    const slot = fake(A), orch = fake(ORCH);
    await R.applyDecision(slot, answer());
    const m = got(orch);
    assert.equal(m.length, 1);
    assert.equal(m[0], R.relayMessage({ via: "agent", from: treeByKey(A), to: treeByKey(ORCH), body: BLOCK }));
    assert.doesNotMatch(m[0], /РАССУЖДЕНИЕ/);
});

test("блок уже передан: повтор решения не шлёт вместо него весь ответ", async () => {
    const slot = fake(A), orch = fake(ORCH);
    await R.applyDecision(slot, answer());
    orch.busy = false;
    await R.applyDecision(slot, answer());
    assert.equal(got(orch).length, 1, "второго сообщения нет");
    assert.match(notes(slot), /уже передан/);
});

test("решение «ДАЛЬШЕ: СЛОТУ П2»: соседу — заголовок, блок и ничего больше", async () => {
    const slot = fake(A), peer = fake(B);
    await R.applyDecision(slot, answer(BLOCK, "ДАЛЬШЕ: СЛОТУ П2"));
    assert.deepEqual(got(peer), [R.relayMessage({ via: "agent", from: treeByKey(A), to: treeByKey(B), body: BLOCK })]);
});

// ── 2. подпись происхождения ──

test("состав сообщения передачи: заголовок происхождения + блок + справка, и ничего больше", () => {
    const from = treeByKey(A), to = treeByKey(ORCH), facts = "── Справка диспетчерской о слоте ──\nфакт";
    for (const via of Object.keys(R.RELAY_VIA)) {
        const head = R.relayHead(via, { from, to });
        assert.equal(R.relayMessage({ via, from, to, body: BLOCK, facts }), head + "\n\n" + BLOCK + "\n\n" + facts);
        assert.equal(R.relayMessage({ via, from, to, body: BLOCK }), head + "\n\n" + BLOCK, "без справки — без хвоста");
        assert.ok(head.includes(R.RELAY_VIA[via]), via);
    }
    assert.throws(() => R.relayHead("кнопка", { from, to }), /происхождени/);
});

test("подпись по факту: кнопка — «кнопкой владельца», без признака — автоматика диспетчерской, а не кнопка", async () => {
    const orch = fake(ORCH), slot = fake(A);
    assert.equal((await R.doRelay(A, ORCH, BLOCK, false, false, "owner")).code, 200);
    assert.ok(got(orch)[0].startsWith(R.relayHead("owner", { from: treeByKey(A), to: treeByKey(ORCH) }) + "\n\n"));
    orch.busy = false;
    assert.equal((await R.doRelay(A, ORCH, BLOCK + "\nещё строка")).code, 200);
    assert.doesNotMatch(got(orch)[1], /кнопк/);
    assert.ok(got(orch)[1].startsWith(R.relayHead("auto", { from: treeByKey(A), to: treeByKey(ORCH) })));
    assert.equal((await R.doRelay(ORCH, A, "Сделай вот это и доложи.")).code, 200);
    assert.equal(got(slot)[0], R.relayMessage({ via: "auto", from: treeByKey(ORCH), to: treeByKey(A), body: "Сделай вот это и доложи." }));
    assert.doesNotMatch(got(slot)[0], /кнопк/);
});

test("начало сообщения узнаётся правилом orchWake при любом происхождении", async () => {
    const { orchWake } = await import("./loops.mjs");
    for (const via of Object.keys(R.RELAY_VIA))
        assert.equal(orchWake(R.relayMessage({ via, from: treeByKey(A), to: treeByKey(ORCH), body: BLOCK })).kind, "relay", via);
});

test("очередь: решение слота, отложенное занятым адресатом, уходит с подписью «по решению», а не кнопкой", async () => {
    const peer = fake(B);
    fake(A);
    peer.busy = true;
    const r = await R.doRelay(A, B, BLOCK, false, false, "agent");
    assert.equal(r.code, 202);
    const card = inboxCards().find((x) => x.kind === "relay" && x.to === B);
    assert.equal(card.via, "agent", "происхождение записано в карточку очереди");
    peer.busy = false;
    R.drainQueued(B);
    for (let i = 0; i < 50 && !got(peer).length; i++)
        await sleep(20);
    assert.deepEqual(got(peer), [R.relayMessage({ via: "agent", from: treeByKey(A), to: treeByKey(B), body: BLOCK })]);
});

test("пачка оркестратору: у каждого доклада своя подпись", async () => {
    const orch = fake(ORCH);
    const c1 = { id: "c1", kind: "relay", tree: A, to: ORCH, toTag: "ОРК", text: BLOCK, at: 1, queued: 1, via: "owner" };
    const c2 = { id: "c2", kind: "relay", tree: B, to: ORCH, toTag: "ОРК", text: "WV-9202 (слот П2): ГОТОВО.\nСделано всё.", at: 2, queued: 2, via: "agent" };
    S.inbox.push(c1, c2);
    await R.deliverOrchBatch(ORCH, [c1, c2]);
    const m = got(orch)[0];
    assert.match(m, /^Доклады слотов пачкой \(2\)/);
    assert.ok(m.includes(R.relayMessage({ via: "owner", from: treeByKey(A), to: treeByKey(ORCH), body: c1.text })));
    assert.ok(m.includes(R.relayMessage({ via: "agent", from: treeByKey(B), to: treeByKey(ORCH), body: c2.text })));
});

test("ожидание подготовки слота хранит происхождение в карточке", async () => {
    fake(ORCH);
    const r = await R.doRelay(ORCH, C, "Старт волны: план в папке эпика.", false, false, "owner");
    assert.equal(r.code, 202);
    assert.equal(inboxCards().find((x) => x.to === C).via, "owner");
});

// ── ревью: ответ автора ревьюеру — его доклад, а не весь ход ──

test("второй круг ревью: ревьюеру уходит блок доклада автора, а не хвост всего его хода", async () => {
    const { reviewContext } = await import("./review.mjs");
    const slot = fake(A);
    loadJobs([{ id: "j9", tree: A, task: "review", status: "fail", review: { verdict: "ВОПРОСЫ", text: "1. Нет теста на пустой ввод." } }]);
    slot.items.push({ t: "user", text: "── Ревью: замечания независимого ревьюера ──\n1. Нет теста на пустой ввод." },
        { t: "assistant", text: answer("WV-9201 (слот П1): ГОТОВО.\nПо ревью: 1 — согласен, тест на пустой ввод добавлен.", "ДАЛЬШЕ: ПЕРЕПРОГОН") });
    const { prev } = reviewContext(treeByKey(A));
    assert.match(prev, /тест на пустой ввод добавлен/);
    assert.doesNotMatch(prev, /РАССУЖДЕНИЕ/, "рассуждений автора ревьюер не получает");
    assert.deepEqual(bareCuts(prev), []);
});

// ── 3. вводная новой сессии оркестратора ──

test("вводная новой сессии: факты диспетчерской без обрывков старых ответов; вопрос и неотвеченное слово владельца — целиком", async () => {
    const { setMergeWait, dropMergeWait } = await import("./merge-wait.mjs");
    const orch = fake(ORCH);
    const SAID = "Решил: П2 переделывает разбор — СТАРЫЙ-ОТВЕТ. ".repeat(60), Q = "Брать период из имени файла? " + "уточнение ".repeat(200).trim();
    const LATE = "НОВОЕ-СЛОВО " + "подробность ".repeat(300).trim();
    orch.items.push({ t: "user", owner: true, text: "старое слово владельца, уже отвеченное" }, { t: "assistant", text: SAID }, { t: "user", owner: true, text: LATE });
    S.inbox.push({ id: "q1", kind: "ownerq", tree: B, text: Q, at: 1 });
    S.snap = { trees: [
        { key: A, tag: "П1", branch: "dev/wv-9201-a", exists: true, ahead: 0, verdict: { merged: true } },
        { key: B, tag: "П2", branch: "dev/wv-9202-b", exists: true, ahead: 2, verdict: { build: "ok", tests: "fail", guards: "green" } },
    ] };
    setMergeWait(B, { orch: ORCH, tag: "П2", at: 1, until: Date.now() + 3600e3, state: "wait", need: ["regress"], why: "" });
    try {
        const text = P.orchPrimer({ ep: "e1", orchDir: "/o", prevId: "p", ctx: 1, ...R.orchPrimerFacts(ORCH, orch) });
        assert.doesNotMatch(text, /СТАРЫЙ-ОТВЕТ/, "ответов прошлой сессии нет");
        assert.doesNotMatch(text, /уже отвеченное/, "отвеченное слово владельца не повторяется");
        assert.ok(text.includes(Q), "открытый вопрос владельцу — целиком");
        assert.ok(text.includes(LATE), "неотвеченное слово владельца — целиком");
        assert.match(text, /П1 wv9201-a[^\n]*влита в staging/);
        assert.match(text, /П2 wv9202-b[^\n]*впереди staging 2[^\n]*тесты волны — КРАСНЫЕ/);
        assert.match(text, /П3 wv9203-c[^\n]*папки слота нет/);
        assert.match(text, /ВЛИТЬ П2[^\n]*регресс/);
        const { orchWake } = await import("./loops.mjs");
        assert.equal(orchWake(text).kind, "rotate", "начало вводной узнаётся правилом orchWake");
    }
    finally {
        dropMergeWait(B, { word: true });
    }
});

// ── сторож: усечение посреди строки — только с пометкой «…» ──

// Исходный текст — строки «§NNNN … ¶». Обрезанная посреди строки без пометки видна по куску без одного из краёв.
const SRC = (n, w = 14) => Array.from({ length: n }, (_, i) => "§" + String(i).padStart(4, "0") + " " + "слово ".repeat(w) + "¶").join("\n");

/** Строки сообщения, где исходная строка обрезана посреди, а пометки «…» на месте обреза нет. */
function bareCuts(msg) {
    const ls = String(msg).split("\n"), bad = [];
    for (let i = 0; i < ls.length; i++) {
        const l = ls[i];
        if (!/[§¶]/.test(l))
            continue;
        const parts = l.split("§");
        // хвост чужой строки в начале (обрез с начала): ¶ до первого § без «…» перед ним
        if (parts[0].includes("¶") && !parts[0].includes("…"))
            bad.push(i + 1 + ": начало обрезано без «…»: " + l.slice(0, 50));
        for (let k = 1; k < parts.length; k++) {
            if (parts[k].includes("¶"))
                continue;
            const lastSeg = k === parts.length - 1, marked = lastSeg && (parts[k].includes("…") || /^\s*…/.test(ls[i + 1] || ""));
            if (!marked)
                bad.push(i + 1 + ": конец обрезан без «…»: §" + parts[k].slice(-50));
        }
    }
    return bad;
}

test("сторож обреза ловит обрез с начала и с конца без пометки и пропускает помеченный", () => {
    const s = SRC(60);
    assert.deepEqual(bareCuts(s), []);
    assert.ok(bareCuts(s.slice(0, 777)).length, "обрез конца без пометки");
    assert.ok(bareCuts(s.slice(-777)).length, "обрез начала без пометки");
    assert.deepEqual(bareCuts(short(s, 777)), [], "short() ставит пометку");
});

test("сборка сообщений агентам не режет строку посреди без «…»", async () => {
    const long = SRC(400);
    const from = treeByKey(A), to = treeByKey(ORCH);
    const cases = {
        "передача (все происхождения)": Object.keys(R.RELAY_VIA).map((via) => R.relayMessage({ via, from, to, body: long, facts: long })).join("\n"),
        "передача соседу": R.relayMessage({ via: "agent", from, to: treeByKey(B), body: long }),
        "доклад без блока": prompt("relay-no-block", { to: "ОРК" }),
        "выжимка лога": R.failureExcerpt("Error: упало\n" + long),
        "выжимка лога в справку": R.failureExcerpt("Error: упало\n" + long, 1800),
        "вводная новой сессии": P.orchPrimer({ ep: "e1", orchDir: "/o", prevId: "x", ctx: 1, slots: [long], questions: [{ who: "П1", text: long }], waits: [long], owner: [long] }),
        "красное для ожидания влива": Object.values(R.mergeRedOf(A, { fp: "f", verdict: { regress: "fail" }, stages: [{ id: "regress", hint: long }] })).join("\n"),
    };
    // копилка «Попутно»: длинное сведение и выдача следующим сообщением
    AG.holdForOrch(ORCH, "[Диспетчерская] Ворота не пустили прогон " + long, { kind: "gate", tree: A, what: "lint|" });
    cases["копилка «Попутно»"] = AG.withPrimer({ key: ORCH, primer: "" }, "Ответ слота П1 (x), передан диспетчерской автоматически:\n\nтекст");
    for (const [name, msg] of Object.entries(cases))
        assert.deepEqual(bareCuts(msg), [], name);
});
