import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "retro-"));
process.env.DASH_DRY = "1";
process.env.DASH_DATA = DATA;
// Ретро — необязательный модуль (выключен по умолчанию): тест идёт на демо-проекте с включёнными бэклогом и ретро,
// папки проекта и слотов — во временной папке.
{
    const demo = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "test", "fixtures", "project.demo.json"), "utf8"));
    const file = path.join(DATA, "project.json");
    fs.writeFileSync(file, JSON.stringify({ ...demo, modules: { ...(demo.modules || {}), backlog: true, retro: true } }));
    process.env.DISPATCHER_PROJECT = file;
    process.env.DISPATCHER_MAIN = path.join(DATA, "main");
    process.env.DISPATCHER_WT = path.join(DATA, "wt");
}
let M, S;

before(async () => {
    M = await import("./retro.mjs");
    ({ S } = await import("./state.mjs"));
});

const H = 3600e3, T0 = Date.parse("2026-11-10T09:00:00Z");
const EPIC = { id: "ep-retro", title: "Учебный", slots: [{ tag: "П1", slot: "s1", branch: "dev/wv-1010-x", title: "WV-1010 Первая" }, { tag: "П2", slot: "s2", branch: "dev/wv-1011-y" }] };
const ORCH = "orchestrator@ep-retro";

function journal() {
    const events = [
        { at: T0, type: "slot.provision", key: "s1", epic: "ep-retro" },
        { at: T0 + 0.5 * H, type: "owner.question", tree: "s1", epic: "ep-retro", brief: "какой порт?" },
        { at: T0 + 1.5 * H, type: "owner.answer", key: "s1", epic: "ep-retro" },
        { at: T0 + 2 * H, type: "orch.command", tree: ORCH, cmd: "ВЛИТЬ", target: "П1", ok: false, detail: "нет слова «влей»" },
        { at: T0 + 3 * H, type: "agent.turn", key: "чужой" },
        { at: T0 + 3 * H, type: "chain.kick", tree: "s1", epic: "ep-retro" },
    ];
    const r = (id, task, status, h, min, extra = {}) => ({
        id,
        epic: "ep-retro",
        tree: "s1",
        task,
        status,
        input: "",
        queuedAt: T0 + h * H,
        startedAt: T0 + h * H,
        endedAt: T0 + h * H + min * 60e3,
        ...extra,
    });
    const runs = [r("j1", "review", "fail", 1, 5, { fpStart: "f" }), r("j2", "review", "fail", 1.2, 5, { fpStart: "f" }), r("j3", "api-test", "interrupted", 2, 20), r("j4", "commit", "ok", 2.5, 1),
        { id: "j9", tree: "чужой", task: "api-test", status: "fail", queuedAt: T0 }];
    return { events, runs };
}

test("вход агента: окно эпика, сводка с метриками, группы провалов по логам, журнал и промпт — файлами", async () => {
    fs.mkdirSync(path.join(DATA, "logs"), { recursive: true });
    fs.writeFileSync(path.join(DATA, "logs", "j1.log"), "ВЕРДИКТ: ВОПРОСЫ\n");
    const { events, runs } = journal();
    const inp = await M.retroInput(EPIC, { now: T0 + 5 * H, events, runs });
    assert.equal(inp.from, T0);
    assert.equal(inp.to, T0 + 5 * H);
    const k = inp.progress.counters;
    assert.deepEqual([k.repeats.runs, k.lost.runs, k.questions.n, k.questions.waitMin], [1, 1, 1, 60]);
    assert.equal(inp.groups.length, 1);
    const dir = path.join(DATA, "retro", "ep-retro");
    for (const f of ["progress.json", "failures.md", "journal.txt", "prompt.txt"])
        assert.ok(fs.existsSync(path.join(dir, f)), f);
    const jt = fs.readFileSync(path.join(dir, "journal.txt"), "utf8");
    assert.match(jt, /owner\.question s1: какой порт\?/);
    assert.doesNotMatch(jt, /чужой|chain\.kick/);
    assert.match(inp.prompt, /chain\.kick 1/);
    assert.match(inp.prompt, /повторы на том же коде: 1/);
    assert.match(inp.prompt, /journal\.txt/);
});

test("итог агента → файл ретро и карточки бэклога; заведённое прошлым ретро — не второй раз", async () => {
    const text = "## Итог\nок\n\nПРЕДЛОЖЕНИЯ:\n- гард: проверять порт до прогона | эпизоды: j1\n- правило диспетчерской: не повторять ревью на том же коде | эпизоды: j2";
    const added = [];
    const addItem = async (b) => {
        added.push(b);
        return { body: { item: { id: "BL-00" + (40 + added.length) } } };
    };
    const items = () => [{ source: "ретро ep-retro", title: "Гард: проверять порт до прогона" }];
    const r = await M.retroFinish(EPIC, { text, model: "m", from: T0, to: T0 + H }, { now: T0 + 2 * H, addItem, items });
    assert.equal(added.length, 1);
    assert.equal(added[0].source, "ретро ep-retro");
    assert.match(added[0].text, /^Правило диспетчерской: не повторять ревью/);
    assert.deepEqual(r.items, [{ id: "BL-0041", kind: "правило диспетчерской", title: "не повторять ревью на том же коде" }]);
    const doc = fs.readFileSync(path.join(DATA, "retro", "docs", "ep-retro.md"), "utf8");
    assert.match(doc, /^# Ретроспектива эпика «Учебный»/);
    assert.match(doc, /- BL-0041 — правило диспетчерской/);
});

test("сухой запуск: только вход, агент не идёт; нет эпика — 404; автоматика в сухом режиме молчит", async () => {
    S.EPICS = [EPIC];
    const r = await M.retroStart("ep-retro");
    assert.equal(r.code, 200);
    assert.equal(r.body.retro.status, "collected");
    assert.match(r.body.message, /агент не запускался/);
    assert.equal(M.retroOf("ep-retro").status, "collected");
    assert.equal((await M.retroStart("нет-такого")).code, 404);
    assert.equal(await M.retroAuto(), null);
    assert.equal(M.retroGet("ep-retro").body.sink, "log");
    assert.equal(M.retroGet("ep-retro").body.enabled, true);
});

test("модуль ретро выключен в конфиге — ретро не запускается", () => {
    const demo = { schema: 1, repo: { main: "/x", upstream: { staging: "develop" } } };
    assert.equal(M.retroEnabled({ ...demo, modules: {} }), false);
    assert.equal(M.retroEnabled({ ...demo, modules: { retro: true, backlog: false } }), false, "ретро без бэклога не работает");
    assert.equal(M.retroEnabled({ ...demo, modules: { retro: true } }), true);
});
