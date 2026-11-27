// Правила полного прогона по частям (full-run-rules.mjs): каталог, порядок, итоги частей, повтор окружных падений, вид.
//   node --test scripts/dev/dashboard/full-run-rules.test.mjs
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lastDurations, orderParts, parseCatalog, partState, redParts, retryPlan, runView, summarize } from "./full-run-rules.mjs";

const RE = "^  ([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(?:\\s|$)";
const CATALOG = [
    "\x1b[1mЧАСТИ ПРОГОНА\x1b[0m",
    "Гарды",
    "  guards-chain                      цепочка",
    "  pkg-a                       12    пакет a",
    "· be-e2e                        36  не в --all",
    "  be-unit-x\r",
    "  pkg-a                             повтор",
    "  go-sdk                            go",
].join("\n");

const J = (id, status, extra = {}) => ({ id, status, startedAt: 1000, endedAt: status === "running" ? undefined : 61000, ...extra });
const mapOf = (...jobs) => new Map(jobs.map((j) => [j.id, j]));
const runOf = (parts) => ({
    id: "fr1", sha: "abcdef1234567", subject: "s", status: "running", startedAt: 0,
    parts: Object.fromEntries(parts.map((p) => [p.id, { only: null, note: "", ...p }])), order: parts.map((p) => p.id),
});

describe("parseCatalog", () => {
    test("id частей по регулярке: без цвета и \\r, без повторов, без исключённых и помеченных «·»", () => {
        assert.deepEqual(parseCatalog(CATALOG, RE), ["guards-chain", "pkg-a", "be-unit-x", "go-sdk"]);
        assert.deepEqual(parseCatalog(CATALOG, RE, ["go-sdk"]), ["guards-chain", "pkg-a", "be-unit-x"]);
        assert.deepEqual(parseCatalog("", RE), []);
    });
});

describe("orderParts", () => {
    test("сначала долгие по прошлому прогону, без истории — в порядке каталога в конце", () => {
        assert.deepEqual(orderParts(["a", "b", "c", "d"], { c: 300, a: 20 }), ["c", "a", "b", "d"]);
        assert.deepEqual(orderParts(["a", "b"], {}), ["a", "b"]);
    });
    test("lastDurations — только ok/fail с началом и концом", () => {
        const run = runOf([{ id: "a", jobs: ["j1"] }, { id: "b", jobs: ["j2"] }, { id: "c", jobs: [] }]);
        assert.deepEqual(lastDurations(run, mapOf(J("j1", "ok"), J("j2", "cancelled"))), { a: 60 });
    });
});

describe("итоги частей", () => {
    test("partState: последний прогон части; «неприменимо» — skipped; без записи — lost", () => {
        assert.equal(partState({ jobs: ["j1", "j2"] }, mapOf(J("j1", "fail"), J("j2", "ok"))).status, "ok");
        assert.equal(partState({ jobs: ["j1"] }, mapOf(J("j1", "skipped", { na: "нет части" }))).status, "skipped");
        assert.equal(partState({ jobs: ["j9"] }, mapOf()).status, "lost");
        assert.equal(partState({ jobs: [] }, mapOf()).status, "queued");
    });
    test("summarize: счёт и статус; идущая часть — running; отменённый прогон — cancelled", () => {
        const run = runOf([{ id: "a", jobs: ["j1"] }, { id: "b", jobs: ["j2"] }, { id: "c", jobs: ["j3"] }, { id: "d", jobs: ["j4"] }]);
        const jobs = mapOf(J("j1", "ok"), J("j2", "fail"), J("j3", "running"), J("j4", "skipped", { na: "x" }));
        const sm = summarize(run, jobs);
        assert.deepEqual([sm.status, sm.ok, sm.fail, sm.running, sm.skipped, sm.notrun, sm.total], ["running", 1, 1, 1, 1, 0, 4]);
        jobs.set("j3", J("j3", "interrupted"));
        assert.deepEqual([summarize(run, jobs).status, summarize(run, jobs).notrun], ["done", 1]);
        assert.equal(summarize({ ...run, status: "cancelled" }, jobs).status, "cancelled");
        assert.equal(summarize(null, jobs), null);
    });
    test("redParts: провал, оборванные, снятые, потерянные — но не зелёные и не «неприменимо»", () => {
        const run = runOf([{ id: "a", jobs: ["j1"] }, { id: "b", jobs: ["j2"] }, { id: "c", jobs: ["j3"] }, { id: "d", jobs: ["j4"] }, { id: "e", jobs: ["j5"] }]);
        const jobs = mapOf(J("j1", "ok"), J("j2", "fail"), J("j3", "interrupted"), J("j4", "skipped", { na: "x" }), J("j5", "cancelled"));
        assert.deepEqual(redParts(run, jobs), ["b", "c", "e"]);
    });
});

describe("retryPlan", () => {
    const env = (j) => !!j.env;
    test("окружное падение на удалённой — один повтор на этой машине", () => {
        assert.deepEqual(retryPlan({ jobs: ["j1"] }, mapOf(J("j1", "fail", { runOn: "srv", env: true })), env).only, ["local"]);
    });
    test("не повторяем: падение по коду, падение здесь, вторая попытка, не провал", () => {
        assert.equal(retryPlan({ jobs: ["j1"] }, mapOf(J("j1", "fail", { runOn: "srv" })), env), null);
        assert.equal(retryPlan({ jobs: ["j1"] }, mapOf(J("j1", "fail", { runOn: "local", env: true })), env), null);
        assert.equal(retryPlan({ jobs: ["j0", "j1"] }, mapOf(J("j1", "fail", { runOn: "srv", env: true })), env), null);
        assert.equal(retryPlan({ jobs: ["j1"] }, mapOf(J("j1", "ok", { runOn: "srv" })), env), null);
    });
});

describe("runView", () => {
    test("части с машиной и временем, разрез по машинам, хвост идущей", () => {
        const run = runOf([{ id: "a", jobs: ["j1"] }, { id: "b", jobs: ["j2"] }, { id: "c", jobs: ["j3"], note: "повтор" }]);
        const jobs = mapOf(J("j1", "ok", { runOn: "srv", summary: "всё ок" }), J("j2", "running", { runOn: "srv", tailLines: ["1", "2", "3", "4"] }), J("j3", "fail", { runOn: "local" }));
        const v = runView(run, jobs, { label: (m) => (m === "srv" ? "Сервер" : "ПК"), now: 31000 });
        assert.equal(v.parts[0].mLabel, "Сервер");
        assert.equal(v.parts[0].sec, 60);
        assert.equal(v.parts[1].sec, 30);
        assert.deepEqual(v.parts[1].tail, ["2", "3", "4"]);
        assert.equal(v.parts[2].note, "повтор");
        assert.deepEqual(v.machines.srv, { label: "Сервер", done: 1, fail: 0, running: 1, current: "b" });
        assert.deepEqual(v.machines.local, { label: "ПК", done: 1, fail: 1, running: 0, current: "" });
    });
});
