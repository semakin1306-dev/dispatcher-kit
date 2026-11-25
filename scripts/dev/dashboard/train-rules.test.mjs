import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    ORCH_TRAINS_RULE,
    TRAIN_AREAS,
    addWagon,
    removeWagon,
    findTrain,
    findWagon,
    isTrain,
    moveWagon,
    newTrain,
    nextTrainTag,
    normWave,
    orderWagons,
    parseWaveLog,
    queueState,
    stagedMarks,
    trainCommitWaves,
    trainMergeMessage,
    trainNext,
    trainNextAct,
    trainSlotName,
    wagonOfTree,
    wagonStation,
    waveTrailer,
    wavesOfMerge,
} from "./train-rules.mjs";

const PALETTE = [["🟩", "#16a34a"], ["🟦", "#2563eb"], ["🟪", "#9333ea"]];
// Тесты идут на демо-проекте (test/fixtures/project.demo.json): области api (со сборкой) и web.
const epic = () => ({ id: "rx", slots: [{ tag: "П1", slot: "wv0999-old", branch: "dev/wv-0999-old", color: "#16a34a" }] });

describe("реестр поездов", () => {
    test("области поездов — области проекта: база — сама область, заголовок и ключевые слова из конфига; слот без wagons — не поезд", () => {
        assert.deepEqual(Object.keys(TRAIN_AREAS), ["api", "web"]);
        assert.equal(TRAIN_AREAS.api.base, "api");
        assert.equal(TRAIN_AREAS.web.title, "Витрина");
        assert.deepEqual(TRAIN_AREAS.api.scope, ["api", "apps/api", "packages"]);
        assert.ok(TRAIN_AREAS.web.scope.includes("витрина"));
        assert.equal(isTrain({ slot: "x", branch: "dev/wv-1" }), false);
        assert.equal(isTrain({ kind: "train" }), true);
        assert.equal(isTrain({ wagons: [] }), true);
    });
    test("новый поезд: метка Т1, имя tr-<область>-<эпик>, ветка dev/<имя>, поля области, свободный цвет; вторая такая же область — второй поезд, больше 10 — отказ", () => {
        const e = epic();
        const t = newTrain(e, { area: "api", taken: new Set(["wv0999-old"]), palette: PALETTE });
        assert.equal(t.tag, "Т1");
        assert.equal(t.slot, "tr-api-rx");
        assert.equal(t.branch, "dev/tr-api-rx");
        assert.equal(t.kind, "train");
        assert.equal(t.color, "#2563eb");
        assert.equal(t.area, "api");
        assert.equal(t.build, true, "у области api сборка — у поезда тоже");
        assert.deepEqual(t.wagons, []);
        assert.equal("maxWagons" in t, false);
        assert.ok(t.scope.includes("apps/api"));
        const t2 = newTrain(e, { area: "api", palette: PALETTE });
        assert.equal(t2.slot, "tr-api2-rx");
        assert.equal(t2.tag, "Т2");
        assert.equal(t2.lane, 2);
        assert.notEqual(t2.color, t.color);
        assert.throws(() => findTrain(e, "api"), /нет поезда/, "область с двумя поездами — только по метке");
        assert.equal(findTrain(e, "Т2").slot, "tr-api2-rx");
        assert.throws(() => newTrain(e, { area: "nope" }), /область поезда: api \| web/);
        assert.throws(() => newTrain(e, { area: "constructor" }), /область поезда/, "имя свойства объекта — не область");
        assert.equal(nextTrainTag(e), "Т3");
        assert.throws(() => newTrain(e, { area: "web", taken: new Set([trainSlotName("web", "rx")]) }), /занято/);
        for (let i = 0; i < 8; i++)
            newTrain(e, { area: "web", palette: PALETTE });
        assert.throws(() => newTrain(e, { area: "web", palette: PALETTE }), /больше 10/);
    });
    test("правило поездов для оркестратора: путь к команде эпиков — дома диспетчерской, без дат", () => {
        assert.match(ORCH_TRAINS_RULE, /scripts\/dev\/epic\.mjs add-wagon --train ТN/);
        assert.doesNotMatch(ORCH_TRAINS_RULE, /\d{2}\.\d{2}/);
    });
    test("вагоны: номер в эпике один раз, заголовок без номера, тесты — задачи области с номером волны, after — свои и чужие через @", () => {
        const e = epic();
        newTrain(e, { area: "api", palette: PALETTE });
        newTrain(e, { area: "web", palette: PALETTE });
        const a = addWagon(e, "Т1", { wave: "1014", title: "WV-1014: Участник программы" });
        assert.deepEqual(a.wagon, { wave: "WV-1014", title: "Участник программы", presets: [{ task: "api-test", input: "wv-1014" }] });
        addWagon(e, "api", { wave: "WV-1015", title: "Артикулы", after: "WV-1014" });
        addWagon(e, "Т2", { wave: "wv-1016", title: "Витрина", after: ["WV-1015@Т1"] });
        assert.deepEqual(findWagon(e, "WV-1016").wagon.after, ["WV-1015@Т1"]);
        assert.deepEqual(findWagon(e, "WV-1016").wagon.presets, [{ task: "web-test", input: "wv-1016" }]);
        assert.throws(() => addWagon(e, "Т2", { wave: "1014", title: "x" }), /уже есть в поезде Т1/);
        assert.throws(() => addWagon(e, "Т2", { wave: "0999", title: "x" }), /отдельным слотом/);
        assert.throws(() => addWagon(e, "Т2", { wave: "1020", title: "x", after: "WV-1099" }), /нет вагона WV-1099/);
        assert.throws(() => addWagon(e, "Т2", { wave: "1020", title: "x", after: "WV-1014@Т2" }), /в поезде Т1, а не Т2/);
        assert.equal(findTrain(e, "T1").tag, "Т1", "латинская T в метке — тоже");
    });
    test("перевод вагона — только из депо; ссылки after пересчитываются", () => {
        const e = epic();
        newTrain(e, { area: "api", palette: PALETTE });
        newTrain(e, { area: "web", palette: PALETTE });
        addWagon(e, "Т1", { wave: "1014", title: "a" });
        addWagon(e, "Т1", { wave: "1015", title: "b", after: "WV-1014" });
        addWagon(e, "Т2", { wave: "1016", title: "c", after: "WV-1014@Т1" });
        assert.throws(() => moveWagon(e, "WV-1014", "Т2", { started: new Set(["WV-1014"]) }), /уже начат/);
        const r = moveWagon(e, "WV-1014", "Т2");
        assert.deepEqual([r.from, r.to], ["Т1", "Т2"]);
        assert.deepEqual(findWagon(e, "WV-1015").wagon.after, ["WV-1014@Т2"]);
        assert.deepEqual(findWagon(e, "WV-1016").wagon.after, ["WV-1014"]);
        assert.deepEqual(e.slots[2].wagons.map((z) => z.wave), ["WV-1016", "WV-1014"]);
    });
    test("снятие вагона — только из депо и без ссылок after на него", () => {
        const e = epic();
        newTrain(e, { area: "api", palette: PALETTE });
        newTrain(e, { area: "web", palette: PALETTE });
        addWagon(e, "Т1", { wave: "1014", title: "a" });
        addWagon(e, "Т1", { wave: "1015", title: "b" });
        addWagon(e, "Т2", { wave: "1016", title: "c", after: "WV-1014@Т1" });
        assert.throws(() => removeWagon(e, "WV-1099"), /нет вагона WV-1099/);
        assert.throws(() => removeWagon(e, "WV-1015", { started: new Set(["WV-1015"]) }), /уже начат/);
        assert.throws(() => removeWagon(e, "WV-1014"), /после него идут: WV-1016/);
        const r = removeWagon(e, "1015");
        assert.deepEqual([r.wagon.wave, r.from], ["WV-1015", "Т1"]);
        assert.deepEqual(e.slots[1].wagons.map((z) => z.wave), ["WV-1014"]);
        assert.equal(findWagon(e, "WV-1015"), null);
    });
    test("порядок очереди: начатые впереди, названные — по порядку, остальные следом", () => {
        const e = epic();
        newTrain(e, { area: "api", palette: PALETTE });
        for (const n of ["1001", "1002", "1003", "1004"])
            addWagon(e, "Т1", { wave: n, title: "w" + n });
        assert.deepEqual(orderWagons(e, "Т1", ["1004", "1003"], { started: new Set(["WV-1001"]) }), ["WV-1001", "WV-1004", "WV-1003", "WV-1002"]);
        assert.throws(() => orderWagons(e, "Т1", ["1001"], { started: new Set(["WV-1001"]) }), /уже начат/);
    });
});

describe("очередь вагонов по git", () => {
    const LOG = [
        "a1b2c3d\x1f1700000100\x1ffeat(x): WV-1014 — участник\x1fWV-1014\x1e",
        "\nb2c3d4e\x1f1700000050\x1ffix WV-1014: спека\x1fWV-1014\x1e",
        "\nc3d4e5f\x1f1700000200\x1fWV-1015 артикулы без строки\x1f\x1e",
        "\nd4e5f6a\x1f1700000300\x1fchore: что-то\x1f\x1e",
    ].join("");
    test("разбор лога: строка Wave: — главная; номер из подписи — только для своих коммитов ветки; время коммита — для диаграммы", () => {
        assert.deepEqual(parseWaveLog(LOG).map((c) => c.waves), [["WV-1014"], ["WV-1014"], [], []]);
        assert.deepEqual(parseWaveLog(LOG, { bySubject: true }).map((c) => c.waves), [["WV-1014"], ["WV-1014"], ["WV-1015"], []]);
        assert.equal(parseWaveLog(LOG)[0].at, 1700000100000);
        assert.equal(normWave("dev/wv-0985-commission"), "WV-0985");
        assert.equal(normWave("нет"), "");
        assert.equal(waveTrailer("wv-1014"), "Wave: WV-1014");
    });
    const W = [{ wave: "WV-1014", title: "a" }, { wave: "WV-1015", title: "b", after: ["WV-1014"] }, { wave: "WV-1016", title: "c", after: ["WV-1020@Т3"] }, { wave: "WV-1017", title: "d" }];
    test("строго по очереди: голова — первый вагон не в staging (с коммитами станций — тот же вагон); остальные — в очереди", () => {
        const own = parseWaveLog(LOG, { bySubject: true }).slice(0, 2);
        const s = queueState({ wagons: W, own, staged: new Set() });
        assert.deepEqual(s.list.map((x) => x.state), ["work", "depot", "depot", "depot"]);
        assert.deepEqual(s.list.map((x) => x.commits), [2, 0, 0, 0]);
        assert.equal(s.list[0].firstAt, 1700000050000, "первый коммит вагона — самый ранний");
        assert.equal(s.head, "WV-1014");
        assert.equal(s.current, "WV-1014");
    });
    test("влитые пропускаются; следующий — по порядку, а не первый «свободный»; голова ждёт чужой поезд — в работу не идёт никто", () => {
        const s = queueState({ wagons: W, own: [], staged: new Set(["WV-1014"]) });
        assert.deepEqual(s.list.map((x) => x.state), ["staging", "work", "depot", "depot"]);
        assert.equal(s.current, "WV-1015", "зависимость WV-1014 в staging — готова");
        const s2 = queueState({ wagons: W, own: [], staged: new Set(["WV-1014", "WV-1015"]) });
        assert.deepEqual(s2.list.map((x) => x.state), ["staging", "staging", "wait", "depot"]);
        assert.equal(s2.head, "WV-1016");
        assert.equal(s2.current, "", "WV-1017 свободен, но очередь строгая");
        assert.deepEqual(s2.list[2].waitFor, ["WV-1020@Т3"]);
        assert.equal(queueState({ wagons: W, own: [], staged: new Set(["WV-1014", "WV-1015"]), depOk: (d) => d === "WV-1020@Т3" }).current, "WV-1016");
    });
    test("влитый вагон с новыми коммитами (правка после влива) — снова голова: его коммиты ещё не в staging", () => {
        const s = queueState({ wagons: W, own: [{ sha: "e1", at: 1, waves: ["WV-1014"] }], staged: new Set(["WV-1014"]) });
        assert.equal(s.head, "WV-1014");
        assert.equal(s.list[0].state, "work");
    });
    test("вагон дерева: голова, если агент её ведёт (выдана или есть коммиты); иначе последний влитый; ничего не влито — голова", () => {
        const merged = queueState({ wagons: W, own: [], staged: new Set(["WV-1014"]) });
        assert.equal(wagonOfTree(merged, "WV-1014"), "WV-1014", "следующий ещё не выдан — станции дерева у влитого (стенд, приёмка)");
        assert.equal(wagonOfTree(merged, "WV-1015"), "WV-1015");
        assert.equal(wagonOfTree(queueState({ wagons: W, own: [{ sha: "x", at: 1, waves: ["WV-1015"] }], staged: new Set(["WV-1014"]) }), "WV-1014"), "WV-1015", "коммиты головы — агент её ведёт");
        assert.equal(wagonOfTree(queueState({ wagons: W, own: [] }), ""), "WV-1014");
        assert.equal(wagonOfTree(queueState({ wagons: [], own: [] }), ""), "");
    });
    test("отметки staging: первый и последний коммит вагона, последний влив с его номером (sha и время); вливы старых составов тоже читаются", () => {
        const commits = [{ sha: "c1", at: 5000, waves: ["WV-1014"] }, { sha: "c2", at: 3000, waves: ["WV-1014"] }];
        const merges = ["m1\x1f10\x1fmerge: dev/tr-x — поезд Т1#1: WV-1014", "m0\x1f4\x1fmerge: dev/tr-x-c3 — поезд Т1#3: WV-1050, WV-1051", "zz\x1f9\x1fmerge: dev/wv-0001-y"].join("\n");
        const mk = stagedMarks(commits, merges);
        assert.deepEqual(mk.get("WV-1014"), { firstAt: 3000, lastAt: 5000, mergedAt: 10000, mergeSha: "m1" });
        assert.deepEqual([...mk.keys()].sort(), ["WV-1014", "WV-1050", "WV-1051"], "вагон из подписи влива без строк Wave — в staging");
    });
});

describe("шаг между вагонами", () => {
    test("следующий вагон — только когда прошлый влит: ветка чиста, впереди staging пусто; первый — стартовым промптом", () => {
        assert.equal(trainNextAct({ current: "WV-2", issued: "WV-1" }).act, "issue");
        assert.equal(trainNextAct({ current: "WV-2", issued: "WV-1", ahead: 1 }).act, "", "в ветке невлитый код");
        assert.equal(trainNextAct({ current: "WV-2", issued: "WV-1", dirty: true }).act, "");
        assert.match(trainNextAct({ current: "WV-1", issued: "WV-1" }).why, /у агента/);
        assert.match(trainNextAct({ current: "WV-1", issued: "" }).why, /стартовым промптом/);
        assert.match(trainNextAct({ current: "", head: "WV-3", waitFor: ["WV-9@Т2"] }).why, /ждёт WV-9@Т2/);
        assert.match(trainNextAct({}).why, /все влиты/);
    });
    test("trainNext по дереву из снимка: голова, её ожидание, вагон у агента; не поезд — пусто", () => {
        const t = { train: true, head: "WV-2", current: "WV-2", issued: "WV-1", ahead: 0, dirtyTracked: 0, wagons: [{ wave: "WV-1", state: "staging" }, { wave: "WV-2", state: "work", waitFor: [] }] };
        assert.equal(trainNext(t).act, "issue");
        assert.equal(trainNext({ ...t, dirtyUntracked: 2 }).act, "");
        assert.deepEqual(trainNext({ key: "wv1" }), { act: "", why: "" });
    });
});

describe("влив и страница", () => {
    test("подпись влива несёт ветку, место вагона и номер; разбор обратно (и вливы старых составов)", () => {
        const m = trainMergeMessage("dev/tr-orgs-rx", "Т2", 3, ["WV-1016"]);
        assert.equal(m, "merge: dev/tr-orgs-rx — поезд Т2#3: WV-1016");
        assert.ok(m.includes("dev/tr-orgs-rx"), "станции находят влив по имени ветки в подписи");
        assert.deepEqual(wavesOfMerge(m), ["WV-1016"]);
        assert.deepEqual(wavesOfMerge("merge: dev/tr-orgs-rx-c4 — поезд Т2#4: WV-1014, WV-1015"), ["WV-1014", "WV-1015"]);
        assert.deepEqual(wavesOfMerge("merge: dev/wv-1014-x"), []);
    });
    test("станция вагона: очередь, ждёт, следующий (не выдан), в работе, на проверках или ждёт влива, после влива", () => {
        const st = (ids) => ["stand", "accept", "prod"].map((id) => ({ id, done: ids.includes(id) }));
        assert.deepEqual(wagonStation({ wave: "WV-3", state: "depot" }), { id: "depot", label: "в очереди", tone: "depot" });
        assert.equal(wagonStation({ wave: "WV-3", state: "wait", waitFor: ["WV-1020@Т3"] }).label, "ждёт WV-1020@Т3");
        assert.equal(wagonStation({ wave: "WV-2", state: "work", commits: 0 }, { tree: "WV-1", issued: "WV-1" }).tone, "depot", "голова ещё не выдана — следующий");
        assert.deepEqual(wagonStation({ wave: "WV-2", state: "work", commits: 0 }, { tree: "WV-2", issued: "WV-2", cur: { id: "impl", label: "Код" } }), { id: "impl", label: "Код", tone: "work" });
        assert.deepEqual(
            wagonStation(
                { wave: "WV-2", state: "work", commits: 2 },
                { tree: "WV-2", issued: "WV-2", cur: { id: "review", label: "Ревью" }, committed: true },
            ),
            { id: "review", label: "Ревью", tone: "check" },
        );
        assert.deepEqual(
            wagonStation(
                { wave: "WV-2", state: "work", commits: 2 },
                { tree: "WV-2", issued: "WV-2", cur: { id: "staging", label: "В staging" }, committed: true },
            ),
            { id: "staging", label: "ждёт влива", tone: "check" },
        );
        assert.equal(
            wagonStation(
                { wave: "WV-2", state: "work", commits: 2 },
                { tree: "WV-2", issued: "WV-2", cur: { id: "tests", label: "Тесты" }, committed: false },
            ).tone,
            "work",
            "правки в папке — ещё работа",
        );
        assert.equal(wagonStation({ wave: "WV-1", state: "staging" }, { tree: "WV-1", stages: st(["stand"]) }).label, "Приёмка");
        assert.deepEqual(wagonStation({ wave: "WV-1", state: "staging" }, { tree: "WV-1", stages: st(["prod"]) }), { id: "prod", label: "В проде", tone: "done" });
        assert.equal(wagonStation({ wave: "WV-1", state: "staging" }, { tree: "WV-1", stages: st([]) }).label, "В staging → стенд");
        assert.equal(wagonStation({ wave: "WV-0", state: "staging" }, { tree: "WV-1" }).label, "В staging");
        assert.equal(wagonStation({ wave: "WV-0", state: "staging" }, { tree: "WV-1", stand: true }).label, "На стенде · приёмка");
        assert.equal(wagonStation({ wave: "WV-0", state: "staging" }, { tree: "WV-1", prod: true }).label, "В проде");
    });
});

describe("trainCommitWaves: номер строки Wave у агента поезда", () => {
    const wagons = [
        { wave: "WV-1109", state: "staging", commits: 0 },
        { wave: "WV-1110", state: "staging", commits: 0 },
        { wave: "WV-1122", state: "work", commits: 0 },
        { wave: "WV-1112", state: "depot", commits: 0 },
    ];
    test("вагон дерева уже влит — новый код голове: WV-1122 агента не переписывается на WV-1110", () => {
        const r = trainCommitWaves("wv-1110", wagons);
        assert.equal(r.cur, "WV-1122");
        assert.ok(r.allowed.includes("WV-1122"));
        assert.ok(!r.allowed.includes("WV-1110"));
    });
    test("номер вагона из депо не законен: подставится голова, иначе голова снова останется без коммитов", () => {
        assert.ok(!trainCommitWaves("WV-1110", wagons).allowed.includes("WV-1112"));
    });
    test("красный влитый вагон чинится своим номером (Р6): его коммиты впереди staging — номер законен", () => {
        const w2 = wagons.map((z) => (z.wave === "WV-1110" ? { ...z, commits: 1 } : z));
        assert.ok(trainCommitWaves("WV-1110", w2).allowed.includes("WV-1110"));
    });
    test("голова в работе — она и есть вагон дерева; очередь пуста — номер вагона дерева", () => {
        assert.equal(trainCommitWaves("WV-1122", wagons).cur, "WV-1122");
        assert.equal(trainCommitWaves("WV-1110", wagons.slice(0, 2)).cur, "WV-1110");
    });
});

test("автопоезд: смена тестов волны меняет ключ «один раз на код» станции «Тесты», у других станций — нет", async () => {
    const { presetSig } = await import("./autochain.mjs");
    const a = { presets: [{ task: "api-test", input: "wv-1072" }] }, b = { presets: [{ task: "web-test", input: "wv-1072" }] };
    assert.notEqual(presetSig(a, "tests"), presetSig(b, "tests"));
    assert.equal(presetSig(a, "guards"), "");
});
