import { test } from "node:test";
import assert from "node:assert/strict";
import { verdictJob } from "./loops.mjs";

const FP = "fpNOW";
const J = (id, task, status, o = {}) => ({ id, task, status, fpStart: "x", fpEnd: "x", input: "", ...o });
const pick = (jobs, o = {}) => verdictJob({ jobs, task: "sf-typecheck", input: undefined, fp: FP, fresh: (j) => !!j.fresh, ...o });

test("П5: последний прогон устарел, а старый зелёный свежий по области (его и видят ворота) — станция зелёная по нему, цикла нет", () => {
    const jobs = [J("j2565", "sf-typecheck", "ok", { fresh: false }), J("j2500", "sf-typecheck", "ok", { fresh: true }), J("j1621", "sf-typecheck", "ok")];
    assert.equal(pick(jobs).id, "j2500");
});

test("последний прогон свежий — берётся он; свежего нет — самый последний (устаревший), как раньше", () => {
    assert.equal(pick([J("a", "sf-typecheck", "ok", { fresh: true }), J("b", "sf-typecheck", "ok", { fresh: true })]).id, "a");
    assert.equal(pick([J("a", "sf-typecheck", "ok"), J("b", "sf-typecheck", "ok")]).id, "a");
    assert.equal(pick([]), null);
});

test("красный на ЭТОМ коде побеждает любой старый зелёный; красный на другом коде — нет", () => {
    const red = J("r", "sf-typecheck", "fail", { fpEnd: FP }), green = J("g", "sf-typecheck", "ok", { fresh: true });
    assert.equal(pick([red, green]).id, "r", "нельзя прикрыть красное старым зелёным");
    assert.equal(pick([J("r2", "sf-typecheck", "fail", { fpEnd: "old" }), green]).id, "g", "красный на старом коде про нынешний ничего не говорит");
});

test("чужие задачи не подмешиваются; у пресетов с вводом разные вводы не подменяют друг друга", () => {
    assert.equal(pick([J("s", "security", "ok", { fresh: true }), J("t", "sf-typecheck", "ok")]).id, "t");
    const st = (jobs, input) => verdictJob({ jobs, task: "selftest", input, fp: FP, fresh: (j) => !!j.fresh });
    const jobs = [J("n", "selftest", "ok", { input: "landing-docs-endpoints" }), J("o", "selftest", "ok", { input: "authority-window", fresh: true })];
    assert.equal(st(jobs, "authority-window").id, "o", "свежий прогон своего ввода");
    assert.equal(st(jobs, "landing-docs-endpoints").id, "n", "свежий чужого ввода не засчитывается — остаётся последний своего, устаревший");
});
