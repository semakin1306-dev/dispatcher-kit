import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { newItemText } from "./backlog-rules.mjs";
import { RETRO_RULES, dm, epicWindow, failuresBrief, freshProposals, parseProposals, progressBrief, proposalItem, retroDoc, retroDue, retroPrompt, retroSource } from "./retro-rules.mjs";

const H = 3600e3;
const T0 = Date.parse("2026-11-10T00:00:00Z");
const EPIC = { id: "ep", title: "Эпик", slots: [{ tag: "П1", slot: "s1", branch: "dev/wv-1010-x", title: "WV-1010 Первая" }] };

describe("окно эпика и очередь ретро", () => {
    test("начало — первый явный признак эпика (поле epic, оркестратор); без них — по ключам слотов; конец — закрытие, у открытого — сейчас", () => {
        const ev = [{ at: T0 - 5 * H, type: "agent.turn", key: "чужой" }, { at: T0 + H, type: "slot.provision", key: "s1" }, { at: T0 + 2 * H, type: "x", epic: "ep" }];
        const runs = [{ id: "j1", tree: "s1", epic: "ep", queuedAt: T0 + 30 * 60e3 }, { id: "j2", tree: "чужой", queuedAt: T0 - 9 * H }];
        assert.deepEqual(epicWindow({ ...EPIC, closedAt: new Date(T0 + 50 * H).toISOString() }, ev, runs), { from: T0 + 30 * 60e3, to: T0 + 50 * H });
        assert.deepEqual(epicWindow(EPIC, ev, [], T0 + 10 * H), { from: T0 + 2 * H, to: T0 + 10 * H });
        assert.equal(epicWindow(EPIC, [...ev, { at: T0 + 1.5 * H, type: "agent.start", key: "orchestrator@ep" }], [], T0 + 10 * H).from, T0 + 1.5 * H);
        assert.equal(epicWindow(EPIC, ev.slice(0, 2), [], T0 + 10 * H).from, T0 + H);
        assert.deepEqual(epicWindow(EPIC, [], [], T0), { from: T0 - 7 * 24 * H, to: T0 });
        assert.equal(epicWindow(EPIC, ev, [...runs, { id: "j0", tree: "s1", epic: "старый", queuedAt: T0 - 90 * H }], T0 + 10 * H).from, T0 + 30 * 60e3);
    });
    test("ретро ждут закрытые после включения автоматики; неудача — повтор через час, не больше двух попыток", () => {
        const at = (h) => new Date(T0 + h * H).toISOString();
        const reg = { epics: [{ id: "a", status: "closed", closedAt: at(1) }, { id: "b", status: "closed", closedAt: at(5) }, { id: "c", status: "open" }, { id: "d", status: "closed", closedAt: at(6) }, { id: "e", status: "closed", closedAt: at(6) }, { id: "f", status: "closed", closedAt: at(6) }] };
        const done = { d: { status: "ok" }, e: { status: "fail", tries: 1, at: T0 + 6 * H }, f: { status: "fail", tries: 2, at: T0 } };
        assert.deepEqual(retroDue(reg, done, T0 + 2 * H, T0 + 6.5 * H), ["b"]);
        assert.deepEqual(retroDue(reg, done, T0 + 2 * H, T0 + 8 * H), ["b", "e"]);
        assert.deepEqual(retroDue(reg, { ...done, d: { status: "ok", to: T0 + 3 * H } }, T0 + 2 * H, T0 + 6.5 * H), ["b", "d"]);
        assert.deepEqual(retroDue(reg, { ...done, d: { status: "ok", to: T0 + 6 * H } }, T0 + 2 * H, T0 + 6.5 * H), ["b"]);
    });
});

describe("промпт", () => {
    test("постоянные правила — первыми (общий префикс кеша); эпик, волны, сводка и пути — после", () => {
        const p = retroPrompt({ epic: EPIC, from: T0, to: T0 + H, waves: [{ tag: "П1", wave: "WV-1010", title: "Первая" }], brief: "- прогонов: 3", counts: { "job.end": 5 }, files: { progress: "D/progress.json", failures: "D/failures.md", journal: "D/journal.txt", logs: "L", plans: ["P/_EPIC-ep.md"], plansDir: "P" } });
        assert.ok(p.startsWith(RETRO_RULES));
        for (const s of ["ЭПИК: ep — Эпик", "ещё открыт", "П1 WV-1010 Первая", "- прогонов: 3", "job.end 5", "D/journal.txt", "L/jNNN.log", "P/_EPIC-ep.md"])
            assert.ok(p.includes(s), s);
        assert.doesNotMatch(p, /УЖЕ ЗАВЕДЕНО/);
        const p2 = retroPrompt({ epic: EPIC, from: T0, to: T0 + H, files: {}, made: [{ id: "BL-0012", title: "Правка навыка: go-test вызывать с каталогом services/<имя>" }] });
        assert.match(p2, /УЖЕ ЗАВЕДЕНО ПРОШЛЫМ РЕТРО[^\n]*\n- BL-0012 Правка навыка: go-test/);
        assert.match(RETRO_RULES, /ТОЛЬКО ЧТЕНИЕ/);
        assert.match(RETRO_RULES, /^ПРЕДЛОЖЕНИЯ:$/m);
    });
    test("сводка «Ход эпика» коротко: метрики в ней есть", () => {
        const b = progressBrief({ readyWaveH: 2.5, counters: { runs: 10, runMin: 125, lost: { runs: 2, min: 30 }, repeats: { runs: 3, min: 12, top: [{ tree: "s1", task: "review", n: 3 }] }, questions: { n: 4, waitMin: 95, open: 1 } } });
        assert.match(b, /прогонов слотов: 10 \(2 ч 05 мин/);
        assert.match(b, /потеряно на сбоях.*2, 30 мин/);
        assert.match(b, /повторы на том же коде: 3, 12 мин — s1 review ×3/);
        assert.match(b, /простой на них 1 ч 35 мин, открыто 1/);
    });
});

describe("ответ агента → карточки бэклога", () => {
    const ANSWER = ["## Итог", "Эпик прошёл.", "", "## Что нет", "- гард: это не предложение — раздел выше", "",
        "**ПРЕДЛОЖЕНИЯ:**",
        "- гард: каждый getByTestId спеки приёмки есть в коде staging | эпизоды: j2101, 11.11 14:20",
        "- **правка навыка**: slot-commit — напоминать строку Wave: | эпизоды: j2200",
        "* правило диспетчерской: не ставить регресс после «ЗА» без правок",
        "- совет: что-то иное | эпизоды: j1",
        "- гард: Каждый getByTestId спеки приёмки есть в коде staging! | эпизоды: j9"].join("\n");
    test("только раздел «ПРЕДЛОЖЕНИЯ:», три вида, эпизоды списком; неизвестный вид и дубль — мимо", () => {
        assert.deepEqual(parseProposals(ANSWER), [
            { kind: "гард", title: "каждый getByTestId спеки приёмки есть в коде staging", episodes: ["j2101", "11.11 14:20"] },
            { kind: "правка навыка", title: "slot-commit — напоминать строку Wave:", episodes: ["j2200"] },
            { kind: "правило диспетчерской", title: "не ставить регресс после «ЗА» без правок", episodes: [] },
        ]);
        assert.deepEqual(parseProposals("## Итог\nничего\n\nПРЕДЛОЖЕНИЯ:\n- нет"), []);
        assert.deepEqual(parseProposals("без раздела\n- гард: x"), []);
        assert.deepEqual(parseProposals("ПРЕДЛОЖЕНИЯ:\n- гард: «весь текст»\n- гард: помечать «перезапущены», а не «прерваны» | эпизоды: j1").map((p) => p.title), ["весь текст", "помечать «перезапущены», а не «прерваны»"]);
    });
    test("не больше восьми", () => {
        const t = "ПРЕДЛОЖЕНИЯ:\n" + Array.from({ length: 12 }, (_, i) => "- гард: гард номер " + "абвгдежзиклм"[i]).join("\n");
        assert.equal(parseProposals(t).length, 8);
    });
    test("карточка: заголовок «Вид: что», ссылка на ретро, эпизоды, источник и область", () => {
        const it = proposalItem({ kind: "правка навыка", title: "slot-commit — Wave", episodes: ["j1", "j2"] }, { epic: "ep", doc: "docs/retro/ep.md" });
        assert.match(it.text, /^Правка навыка: slot-commit — Wave\n/);
        assert.match(newItemText({ id: "BL-0001", text: it.text, source: it.source, area: it.area, at: 0 }), /\n# Правка навыка: slot-commit — Wave\n/);
        assert.doesNotMatch(newItemText({ id: "BL-0001", text: it.text, at: 0 }), /# # /);
        assert.match(it.text, /docs\/retro\/ep\.md/);
        assert.match(it.text, /Эпизоды: j1, j2/);
        assert.equal(it.source, retroSource("ep"));
        assert.equal(it.area, "skills");
    });
    test("повторное ретро не заводит то же второй раз (по заголовку без вида, только карточки этого эпика)", () => {
        const props = parseProposals(ANSWER);
        const items = [{ source: "ретро ep", title: "Гард: каждый getByTestId спеки приёмки есть в коде staging" }, { source: "ретро другой", title: "Правка навыка: slot-commit — напоминать строку Wave:" }];
        assert.deepEqual(freshProposals(props, items, "ep").map((p) => p.kind), ["правка навыка", "правило диспетчерской"]);
    });
    test("файл ретро: шапка с окном, ответ агента, список карточек", () => {
        const d = retroDoc({ epic: { ...EPIC, closedAt: "x" }, from: T0, to: T0 + H, at: T0 + 2 * H, text: "## Итог\nок", items: [{ id: "BL-0042", kind: "гард", title: "x" }], model: "m" });
        assert.match(d, /^# Ретроспектива эпика «Эпик» \(ep\)/);
        // время — местное время машины: ожидание считается тем же dm, что и в коде
        assert.ok(d.includes("Окно " + dm(T0) + " → " + dm(T0 + H) + ". Собрано " + dm(T0 + 2 * H)));
        assert.match(dm(T0), /^\d\d\.\d\d \d\d:\d\d$/);
        assert.match(d, /## Итог\nок/);
        assert.match(d, /- BL-0042 — гард: x/);
    });
});

test("failuresBrief — все группы и разные причины группы с прогонами (у гарда причин бывает несколько)", () => {
    const g = (i, o = {}) => ({ key: "k" + i, cat: "guard", label: "guard:g" + i, n: 1, trees: ["t"], repeated: [], jobs: ["j" + i], reason: "r" + i, ...o });
    const groups = [g(0, { n: 5, reasons: [{ text: "accept.spec.ts: Cannot find name 'test'", n: 4, jobs: ["j1", "j2", "j3"] }, { text: "new.vue: Declaration expected", n: 1, jobs: ["j4"] }] }),
        ...Array.from({ length: 47 }, (_, i) => g(i + 1))];
    const t = failuresBrief(groups);
    assert.match(t, /причины \(разные, 2\):\n   · ×4 j1, j2, j3: accept\.spec\.ts/);
    assert.match(t, /· ×1 j4: new\.vue/);
    assert.match(t, /guard:g47/);
    assert.doesNotMatch(t, /ещё групп/, "48 групп — все в файле");
    assert.match(failuresBrief([g(1, { reasons: [{ text: "одна", n: 1, jobs: ["j1"] }] })]), /\n  причина: r1$/, "одна причина — как раньше");
});

test("progressBrief — переспросы отдельно от ожиданий, сбережённые воротами повторы — не блоки", () => {
    const b = progressBrief({ counters: { questions: { n: 31, waits: 9, waitMin: 846, open: 1 } }, commands: { total: 80, failed: 4, deadlocks: 0, gateBlocked: 1, gateSaved: 36 }, idle: {}, restarts: {}, owner: {} });
    assert.match(b, /вопросов владельцу: 31 \(ожиданий ответа 9, остальное — переспросы неотвеченного\), простой на них 14 ч 06 мин, открыто 1/);
    assert.match(b, /блоков ворот 1 \(и лишних повторов сбережено воротами 36\)/);
});
