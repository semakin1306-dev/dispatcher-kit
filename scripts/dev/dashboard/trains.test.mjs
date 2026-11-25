import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trains-"));
process.env.DASH_DRY = "1";
process.env.DASH_DATA = path.join(dir, "data");
fs.mkdirSync(process.env.DASH_DATA);
await import("./wiring.mjs");
const { S } = await import("./state.mjs");
const { settings } = await import("./config.mjs");
// «ГОТОВО» отмечается только в режиме самокоммита по станциям: при коммитах по слову коммит и есть конец волны
settings.selfCommit = "station";
const { TRAINS_FILE, applyTrain, issueWagon, loadTrains, markIssued, markLanded, nextWagonText, normTrainRec, trainOf } = await import("./trains.mjs");
const { trainNext } = await import("./train-rules.mjs");
const repo = path.join(dir, "repo");
const g = (...a) =>
    execFileSync("git", a, {
        cwd: repo,
        encoding: "utf8",
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
        },
    }).trim();

const commit = (file, msg) => {
    fs.writeFileSync(path.join(repo, file), msg + Math.random());
    g("add", file);
    g("commit", "-q", "-m", msg);
};

fs.mkdirSync(repo);
g("init", "-q", "-b", "staging");
commit("base.txt", "base");
g("switch", "-q", "-c", "dev/tr-orgs-ep");
commit("old.txt", "feat(a): WV-0901 — старый вагон\n\nWave: WV-0901");
g("switch", "-q", "staging");
g("merge", "-q", "--no-ff", "dev/tr-orgs-ep", "-m", "merge: dev/tr-orgs-ep — поезд Т1#1: WV-0901");
g("switch", "-q", "dev/tr-orgs-ep");
g("merge", "-q", "--ff-only", "staging");
commit("a.txt", "feat(a): WV-0902 — первый\n\nWave: WV-0902\nCo-Authored-By: x <x@x>");
commit("a2.txt", "fix(a): WV-0902 — правка по ревью\n\nWave: WV-0902");
const WAGONS = [
    { wave: "WV-0901", title: "старый" },
    { wave: "WV-0902", title: "первый", presets: [{ task: "api-test", input: "wv-0902" }] },
    { wave: "WV-0903", title: "второй", after: ["WV-0902"] },
    { wave: "WV-0904", title: "третий" },
    { wave: "WV-0905", title: "ждёт", after: ["WV-0999@Т2"] },
];
const KEY = "tr-orgs-ep";
const tree = (over = {}) => ({
    key: KEY,
    tag: "Т1",
    train: true,
    exists: true,
    path: repo,
    wagons: WAGONS,
    ahead: Number(g("rev-list", "--count", "staging..HEAD")),
    behind: Number(g("rev-list", "--count", "HEAD..staging")),
    dirtyTracked: 0,
    dirtyUntracked: 0,
    fp: "f0",
    last: { sha: g("rev-parse", "HEAD"), ct: Date.now() },
    ...over,
});

test("очередь по git: влитый, голова с коммитами станций (правка — тот же вагон), за ней — очередь; голова с коммитами — «выдан» сама", async () => {
    loadTrains();
    S.slotDone = { since: 0, slots: {} };
    const t = await applyTrain(tree());
    assert.deepEqual(t.wagons.map((w) => [w.wave, w.state, w.commits]), [["WV-0901", "staging", 0], ["WV-0902", "work", 2], ["WV-0903", "depot", 0], ["WV-0904", "depot", 0], ["WV-0905", "depot", 0]]);
    assert.equal(t.head, "WV-0902");
    assert.equal(t.current, "WV-0902");
    assert.equal(t.wagon, "WV-0902");
    assert.equal(t.wave, "wv-0902");
    assert.equal(trainOf(KEY).issued, "WV-0902", "первый вагон ушёл стартовым промптом — его коммиты и есть отметка «выдан»");
    assert.deepEqual(t.wagons[1].after, []);
    assert.deepEqual(t.wagons[2].after, ["WV-0902"]);
    const t901 = t.wagons[0].times, t902 = t.wagons[1].times;
    assert.match(t901.mergeSha, /^[0-9a-f]{40}$/);
    assert.ok(t901.mergedAt > 0 && t901.firstCommitAt > 0, "влитый вагон: влив и первый коммит — по staging");
    assert.ok(t902.firstCommitAt > 0 && t902.issuedAt === t902.firstCommitAt && !t902.mergedAt, "голова: первый коммит, «выдан» = он же, не влит");
    assert.deepEqual(trainNext(t), { act: "", why: "вагон WV-0902 у агента" });
});

test("«ГОТОВО» по вагону на этом коде — отметка вагона (время доклада и коммит), один раз", async () => {
    const at = Date.now() - 5000;
    S.slotDone = { since: 0, slots: { [KEY]: { fp: "f1", at } } };
    const t = await applyTrain(tree({ fp: "f1" }));
    assert.equal(t.wagons[1].times.doneAt, at);
    assert.equal(t.wagons[1].times.doneSha, g("rev-parse", "HEAD"));
    S.slotDone = { since: 0, slots: { [KEY]: { fp: "f2", at: at + 1 } } };
    assert.equal((await applyTrain(tree({ fp: "f2" }))).wagons[1].times.doneAt, at, "повторный доклад первую отметку не переписывает");
});

test("вагон влит: следующий по очереди — голова; дерево до выдачи — на влитом (его стенд и приёмка); шаг поезда — выдать", async () => {
    g("switch", "-q", "staging");
    g("merge", "-q", "--no-ff", "dev/tr-orgs-ep", "-m", "merge: dev/tr-orgs-ep — поезд Т1#2: WV-0902");
    g("switch", "-q", "dev/tr-orgs-ep");
    const t = await applyTrain(tree());
    assert.deepEqual(t.wagons.map((w) => w.state), ["staging", "staging", "work", "depot", "depot"]);
    assert.equal(t.head, "WV-0903");
    assert.equal(t.current, "WV-0903", "зависимость WV-0902 в staging");
    assert.equal(t.wagon, "WV-0902");
    assert.ok(t.wagons[1].times.mergedAt > 0 && /^[0-9a-f]{40}$/.test(t.wagons[1].times.mergeSha));
    assert.equal(trainNext(t).act, "issue");
});

test("выдача следующего вагона: не при прогонах и не при невлитом коде; сухой режим — отметка «выдан», вагон дерева — новый", async () => {
    S.jobs = [{ id: "j1", tree: KEY, task: "api-test", status: "running" }];
    assert.match((await issueWagon(await applyTrain(tree()), "WV-0903")).why, /идут прогоны/);
    S.jobs = [];
    assert.match((await issueWagon(await applyTrain(tree({ dirtyTracked: 1 })), "WV-0903")).why, /невлитый код/);
    const r = await issueWagon(await applyTrain(tree()), "WV-0903", { by: "кнопка владельца" });
    assert.equal(r.ok, true, r.why);
    assert.equal(trainOf(KEY).issued, "WV-0903");
    assert.ok(trainOf(KEY).times["WV-0903"].issuedAt > 0);
    const t = await applyTrain(tree());
    assert.equal(t.wagon, "WV-0903");
    assert.equal(t.issued, "WV-0903");
    assert.equal(trainNext(t).act, "");
    assert.ok(t.wagons[2].times.issuedAt > 0, "отметка «выдан» — в виде вагона");
});

test("сообщение о следующем вагоне — в ту же сессию: прошлый влит, план, строка Wave, тесты вагона", () => {
    const m = nextWagonText({ tag: "Т1", prev: "WV-0902", wave: "WV-0903", title: "второй", plan: "/tmp/epic-x/.claude/plans/waves/WV-0903-x.md", presets: [{ task: "api-test", input: "wv-0903" }] });
    for (const re of [/Вагон WV-0902 влит в staging/, /WV-0903 «второй»/, /WV-0903-x\.md/, /Wave: WV-0903/, /api-test wv-0903/])
        assert.match(m, re);
    assert.match(nextWagonText({ tag: "Т1", wave: "WV-0903" }), /спроси оркестратора/);
});

test("старые записи trains.json (составы, «держать», сессии вагонов, папки -c) читаются: при загрузке остаётся только «выдан» и отметки", () => {
    const old = {
        issued: "WV-1043",
        issuedAt: 5,
        dispatched: true,
        n: 6,
        waves: ["WV-1042", "WV-1043"],
        sha: "a".repeat(40),
        log: [{ n: 6 }],
        sessions: { "WV-1043": "s" },
        hold: ["WV-1044"],
        recalledAt: 1,
        arrivedAt: 2,
        check: { key: "tr-x-c", path: "/tmp/wt/tr-x-c", branch: "dev/tr-x-c6", sha: "b".repeat(40), n: 6, picked: [] },
    };
    assert.deepEqual(normTrainRec(old), { issued: "WV-1043", issuedAt: 5 });
    assert.deepEqual(normTrainRec({ dispatched: false, check: null }), {});
    assert.deepEqual(normTrainRec(null), {});
    assert.deepEqual(normTrainRec({ issued: "WV-1", times: { "WV-1": { issuedAt: 1 } } }), { issued: "WV-1", times: { "WV-1": { issuedAt: 1 } } });
    fs.writeFileSync(TRAINS_FILE, JSON.stringify({ "tr-x": old, "tr-y": { dispatched: false } }));
    loadTrains();
    assert.deepEqual(S.trains, { "tr-x": { issued: "WV-1043", issuedAt: 5 }, "tr-y": {} });
    markIssued("tr-x", "WV-1044", 9);
    assert.deepEqual(S.trains["tr-x"], { issued: "WV-1044", issuedAt: 9, times: { "WV-1044": { issuedAt: 9 } } });
});

test("вагон влит под чужим номером: отметка landed — очередь считает его влитым, голова идёт дальше", async () => {
    const t0 = await applyTrain(tree()), head = t0.head;
    assert.ok(head, "у учебного поезда есть голова");
    const sha = g("rev-parse", "staging");
    markLanded(KEY, head, sha, 12345);
    const t = await applyTrain(tree());
    const w = t.wagons.find((z) => z.wave === head);
    assert.equal(w.state, "staging", "отмеченный вагон — в staging");
    assert.equal(w.times.mergeSha, sha);
    assert.equal(w.times.mergedAt, 12345);
    assert.notEqual(t.head, head, "голова очереди — следующий вагон");
    assert.deepEqual(normTrainRec({ issued: "WV-1", landed: { "WV-2": { sha, at: 1 } } }).landed, { "WV-2": { sha, at: 1 } }, "отметка переживает загрузку trains.json");
});
