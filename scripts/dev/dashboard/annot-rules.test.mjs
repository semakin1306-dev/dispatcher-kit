// annot-rules.test.mjs — чистые правила разметки: блоки markdown, замечания → сообщение агенту, дифф версий плана, текст ответа владельца.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
const R = await import("./annot-rules.mjs");

const PLAN = ["---", "id: WV-0969", "title: MP подменные артикулы", "---", "", "# WV-0969: MP подменные артикулы — загрузка выгрузки", "",
    "**Источник.** Владелец: продавец делает выгрузку", "и шлёт её блогеру.", "", "## Формат выгрузки", "",
    "- xlsx, сделан `Go Excelize` (MP), один лист", "  продолжение пункта про лист", "- Период — **только в имени файла**", "",
    "| Колонка | Пример | Заметка |", "|---|---|---|", "| Артикул MP | 1464609668 | `nmId` оригинала |", "| Подменный артикул | WW1275513 | ключ блогера |", "",
    "```ts", "const x = 1", "```", "> цитата владельца"].join("\n");

describe("mdBlocks — блоки плана со строками файла", () => {
    const b = R.mdBlocks(PLAN);
    test("frontmatter, заголовки, абзац в две строки, пункт с продолжением, строки таблицы без разделителя, код, цитата", () => {
        assert.deepEqual(b.map((x) => [x.kind, x.line, x.end]), [["fm", 1, 4], ["h", 6, 6], ["p", 8, 9], ["h", 11, 11], ["li", 13, 14], ["li", 15, 15], ["tr", 17, 17], ["tr", 19, 19], ["tr", 20, 20], ["code", 22, 24], ["quote", 25, 25]]);
        assert.equal(b[1].level, 1);
        assert.equal(b[6].head, true);
        assert.deepEqual(b[7].cells, ["Артикул MP", "1464609668", "`nmId` оригинала"]);
    });
    test("fragmentLine: фрагмент во второй строке блока — строка файла этой строки; разметка ** и ` не мешает", () => {
        assert.equal(R.fragmentLine(b[2], "и шлёт её блогеру"), 9);
        assert.equal(R.fragmentLine(b[4], "сделан Go Excelize (MP)"), 13);
        assert.equal(R.fragmentLine(b[4], "продолжение пункта"), 14);
        assert.equal(R.fragmentLine(b[5], "только в имени файла"), 15);
    });
});

describe("замечания → одно сообщение агенту", () => {
    const b = R.mdBlocks(PLAN);
    test("normNote: строка — по блоку или фрагменту; «заменить» без текста замены и пустое замечание — отказ", () => {
        const n = R.normNote({ block: 2, sel: "и шлёт её блогеру", kind: "question", text: "кто шлёт?" }, b);
        assert.equal(n.line, 9);
        assert.equal(n.quote, "и шлёт её блогеру");
        assert.equal(n.kind, "question");
        const all = R.normNote({ block: 7, blockEnd: 8, kind: "delete" }, b);
        assert.equal(all.line, 19);
        assert.equal(all.lineEnd, 20);
        assert.match(all.quote, /Артикул MP[\s\S]*Подменный/);
        assert.equal(R.normNote({ block: 1, kind: "replace", text: "x" }, b), null);
        assert.equal(R.normNote({ block: 1, kind: "note", text: "  " }, b), null);
        assert.equal(R.normNote({ block: 99, kind: "note", text: "x" }, b), null);
    });
    test("docMessage: цитата строки, номер строки файла, вид, текст; по порядку строк; вопросы — отдельной просьбой", () => {
        const ns = [R.normNote({ block: 5, kind: "replace", replace: "Период — в имени файла и в листе", text: "лист тоже" }, b), R.normNote({ block: 2, sel: "и шлёт её блогеру", kind: "question", text: "кто шлёт?" }, b), R.normNote({ block: 7, kind: "delete" }, b)];
        const m = R.docMessage({ kind: "plan", wave: "WV-0969", file: "/srv/wt/epic-demo/.claude/plans/waves/WV-0969-mp.md" }, ns);
        assert.match(m, /плану волны WV-0969 \(файл \/srv\/wt\/epic-demo/);
        assert.match(m, /3 шт\./);
        assert.match(m, /На вопросы \(1\)/);
        const i1 = m.indexOf("1. [вопрос] строка 9"), i2 = m.indexOf("2. [заменить] строка 15"), i3 = m.indexOf("3. [удалить] строка 19");
        assert.ok(i1 > 0 && i2 > i1 && i3 > i2, m);
        assert.match(m, /> и шлёт её блогеру/);
        assert.match(m, /Заменить на:\n {3}\| Период — в имени файла и в листе\n {3}Почему: лист тоже/);
    });
    test("diffMessage: файл:строка–строка, фрагмент кода, удалённая строка помечена; диапазон не длиннее 400 строк; путь вне репозитория — отказ", () => {
        const a = R.normNote({ path: "apps/backend/src/x.ts", line: 12, lineEnd: 14, code: "const a = 1\nconst b = 2", kind: "note", text: "вынести в константу" });
        const d = R.normNote({ path: "apps/backend/src/a.ts", line: 3, side: "old", code: "old()", kind: "question", text: "зачем убрали?" });
        assert.equal(R.normNote({ path: "../etc/passwd", line: 1, text: "x" }), null);
        assert.equal(R.normNote({ path: "C:/x", line: 1, text: "x" }), null);
        assert.equal(R.normNote({ path: "a.ts", line: 1, lineEnd: 9999, text: "x" }).lineEnd, 401);
        const m = R.diffMessage({ branch: "dev/wv-0969-mp-sub-articles" }, [a, d]);
        assert.match(m, /dev\/wv-0969-mp-sub-articles против staging — 2 замечания/);
        assert.ok(m.indexOf("1. apps/backend/src/a.ts:3 (удалённая строка, по staging) [вопрос]") > 0 && m.indexOf("2. apps/backend/src/x.ts:12–14 [замечание]") > 0, m);
        assert.match(m, /│ const a = 1\n {3}│ const b = 2/);
    });
});

describe("дифф версий плана — что поменял агент", () => {
    test("правка в середине: одна строка ушла, две пришли; общее не трогается; хеш версии разный", () => {
        const a = "a\nb\nc\nd", b2 = "a\nb\nC1\nC2\nd", ops = R.lineDiff(a, b2);
        assert.deepEqual(R.diffStat(ops), { add: 2, del: 1 });
        assert.deepEqual(ops.filter((o) => o.t === "+").map((o) => o.b), [3, 4]);
        assert.deepEqual(ops.filter((o) => o.t === "-").map((o) => o.a), [3]);
        assert.deepEqual(R.diffStat(R.lineDiff(a, a)), { add: 0, del: 0 });
        assert.notEqual(R.textHash(a), R.textHash(b2));
        assert.equal(R.textHash(a), R.textHash("a\nb\nc\nd"));
    });
    test("diffHunks: вокруг правки по 2 строки, разрывы — «…»", () => {
        const a = Array.from({ length: 20 }, (_, i) => "l" + i).join("\n"), b2 = a.replace("l10", "L10"), h = R.diffHunks(R.lineDiff(a, b2));
        assert.deepEqual(h.map((o) => o.t), ["=", "=", "-", "+", "=", "="]);
        assert.equal(h[0].s, "l8");
        const b3 = b2.replace("l1\n", "L1\n");
        assert.ok(R.diffHunks(R.lineDiff(a, b3)).some((o) => o.t === "…"));
    });
});

describe("ответ на «Вопросы владельцу» — в ту сессию, что спросила", () => {
    test("answerRoute: та же сессия — same; другая, нет живой, вопрос без sid — other", () => {
        assert.equal(R.answerRoute("s1", "s1"), "same");
        assert.equal(R.answerRoute("s1", "s2"), "other");
        assert.equal(R.answerRoute("s1", null), "other");
        assert.equal(R.answerRoute(null, "s1"), "other");
        assert.equal(R.answerRoute(undefined, undefined), "other");
    });
    test("answerText: same — коротко; other — цитата вопроса целиком, сессия-автор, причина, волна, ветка, план", () => {
        const it = { text: "1. Колонку «Период» брать из имени файла?\n2. Лист один?", sid: "abcdef1234567890", at: Date.UTC(2026, 10, 6, 12, 30) };
        const s = R.answerText(it, "да, из имени", "same");
        assert.match(s, /^Ответ владельца на твои «Вопросы владельцу»:\n\nда, из имени/);
        assert.doesNotMatch(s, /> 1\./);
        const o = R.answerText(it, "да, из имени", "other", { tag: "П2", wave: "WV-0969", branch: "dev/wv-0969-mp-sub-articles", plan: "/srv/wt/x/WV-0969.md", why: "начата новая сессия" });
        assert.match(o, /сессия abcdef12/);
        assert.match(o, /начата новая сессия/);
        assert.match(o, /> 1\. Колонку «Период» брать из имени файла\?\n> 2\. Лист один\?/);
        assert.match(o, /Ответ владельца:\n\nда, из имени/);
        assert.match(o, /Волна: П2 · WV-0969/);
        assert.match(o, /Ветка: dev\/wv-0969-mp-sub-articles/);
        assert.match(o, /План: \/srv\/wt\/x\/WV-0969\.md/);
        assert.match(R.answerText({ text: "q" }, "a", "other", { orch: true }), /оркестратора \(сессия не записана/);
    });
});
