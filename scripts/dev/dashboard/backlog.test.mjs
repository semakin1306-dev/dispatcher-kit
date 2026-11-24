import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STATUSES, SECTION_PLAN, SECTION_RESEARCH, backlogBashCheck, backlogDecide, backlogSystemPrompt, checkSet, getSection, itemOf, newItemText, nextId, orchBacklogSection, ownerPart, parseItem, researchMessage, RESEARCH_HEAD, setMeta, setSection, setTitle, slugOf, splitShell, } from "./backlog-rules.mjs";
import { createItem, listItems, readItem, updateItem } from "./backlog-store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)), CLI = path.resolve(HERE, "..", "backlog.mjs");

const BL1 = `---
id: BL-0001
type: backlog
status: new
area: web, moderation, notifications
source: владелец, тестирование продукта 06.11.2026
created: 2026-11-06
research: needed
---

# Клиент не видит, что его предложение не прошло модерацию — открывает и получает 404

## Что увидел владелец
- Добавил товар (предложение) «Синий чайник».

## Исследовать (агент бэклога)
- В логах (прод/стенд): найти случай.
`;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bl-test-"));

test("разбор элемента: поля, области, заголовок, текст владельца", () => {
    const it = itemOf("BL-0001-moderation-status-for-client.md", BL1);
    assert.equal(it.id, "BL-0001");
    assert.equal(it.status, "new");
    assert.deepEqual(it.area, ["web", "moderation", "notifications"]);
    assert.equal(it.title, "Клиент не видит, что его предложение не прошло модерацию — открывает и получает 404");
    assert.match(it.owner, /Синий чайник/);
    assert.equal(it.researchText, "");
    assert.equal(it.planText, "");
    assert.equal(parseItem("без frontmatter").fm, false);
    assert.equal(itemOf("BL-0002-x.md", BL1.replace("status: new", "status: чепуха")).status, "new");
});

test("setMeta: поле на месте, новое — по порядку полей, пустое — убрать; прочие строки как были", () => {
    const a = setMeta(BL1, { status: "researched" });
    assert.equal(a.split("\n").length, BL1.split("\n").length);
    assert.match(a, /^status: researched$/m);
    assert.ok(a.includes("# Клиент не видит"));
    const b = setMeta(a, { epic: "demo", wave: "WV-0990" }), fm = b.split("---")[1].trim().split("\n").map((l) => l.split(":")[0]);
    assert.deepEqual(fm, ["id", "type", "status", "area", "epic", "wave", "source", "created", "research"]);
    const c = setMeta(b, { wave: "" });
    assert.doesNotMatch(c, /^wave:/m);
    assert.match(c, /^epic: demo$/m);
    assert.throws(() => setMeta("нет frontmatter", { status: "new" }), /frontmatter/);
    assert.match(setTitle(BL1, "Новый заголовок"), /^# Новый заголовок$/m);
});

test("разделы агента: дописать, переписать целиком, не задеть текст владельца", () => {
    let t = setSection(BL1, SECTION_RESEARCH, "- факт 1: src/api/offers/route.ts:40");
    t = setSection(t, SECTION_PLAN, "- вариант А");
    assert.equal(getSection(t, SECTION_RESEARCH), "- факт 1: src/api/offers/route.ts:40");
    t = setSection(t, SECTION_RESEARCH, "- факт 2");
    assert.equal(getSection(t, SECTION_RESEARCH), "- факт 2");
    assert.equal(getSection(t, SECTION_PLAN), "- вариант А");
    assert.equal((t.match(/## Исследование/g) || []).length, 1);
    const it = itemOf("BL-0001-x.md", t);
    assert.doesNotMatch(it.owner, /факт 2|вариант А/);
    assert.match(it.owner, /Синий чайник/);
    assert.equal(ownerPart("# З\n\n## Исследование\n\nx\n\n## Своё\n\ny").includes("## Своё"), true);
});

test("новый элемент: статус new, текст как есть, заголовок — первой строкой; номер и слаг", () => {
    const t = newItemText({ id: "BL-0007", text: "Кнопка «Сохранить» не реагирует\nвторая строка", at: Date.UTC(2026, 10, 6, 12) });
    const it = itemOf("BL-0007-x.md", t);
    assert.equal(it.status, "new");
    assert.equal(it.title, "Кнопка «Сохранить» не реагирует");
    assert.match(it.owner, /вторая строка/);
    assert.match(t, /^source: владелец, быстрый ввод 06\.11\.2026$/m);
    assert.equal(nextId(["BL-0001-a.md", "BL-0009-b.md", "README.md"]), "BL-0010");
    assert.equal(nextId([]), "BL-0001");
    assert.equal(slugOf("Клиент не видит статус модерации"), "klient-ne-vidit-status-moderacii");
    assert.equal(slugOf("!!!"), "item");
    assert.throws(() => newItemText({ id: "BL-0001", text: "  " }), /пустой/);
});

test("статусы и правки: только известные поля и значения", () => {
    assert.deepEqual(STATUSES, ["new", "researching", "researched", "planned", "in-wave", "done", "rejected", "dropped"]);
    assert.throws(() => checkSet("status", "closed"), /статус/);
    assert.throws(() => checkSet("id", "BL-9"), /менять нельзя/);
    assert.throws(() => checkSet("wave", "0990"), /WV-NNNN/);
    assert.equal(checkSet("wave", "wv-0990"), "WV-0990");
});

test("файлы: создать, прочитать, поправить, список; CLI list с отбором", () => {
    const data = tmp(), dir = path.join(data, "backlog");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "BL-0001-moderation-status-for-client.md"), BL1);
    const r = createItem(dir, { text: "Тест: падает /org/x", area: "web" });
    assert.equal(r.item.id, "BL-0002");
    assert.ok(fs.existsSync(r.path));
    const u = updateItem(dir, "BL-0002", { set: { status: "researched", epic: "ep1", wave: "wv-0101" } });
    assert.equal(u.item.status, "researched");
    assert.equal(u.item.wave, "WV-0101");
    assert.throws(() => updateItem(dir, "BL-0002", { set: { status: "x" } }));
    assert.throws(() => readItem(dir, "BL-0099"), /нет элемента/);
    assert.deepEqual(listItems(dir).map((x) => x.id), ["BL-0001", "BL-0002"]);
    const env = { ...process.env, DASH_DATA: data };
    const out = execFileSync(process.execPath, [CLI, "list", "--status", "researched"], { env, encoding: "utf8" });
    assert.match(out, /BL-0002/);
    assert.doesNotMatch(out, /BL-0001/);
    const js = JSON.parse(execFileSync(process.execPath, [CLI, "list", "--area", "moder", "--json"], { env, encoding: "utf8" }));
    assert.deepEqual(js.map((x) => x.id), ["BL-0001"]);
    execFileSync(process.execPath, [CLI, "set", "BL-0001", "status=in-wave", "epic=ep1", "wave=WV-0102"], { env, encoding: "utf8" });
    assert.equal(readItem(dir, "BL-0001").item.status, "in-wave");
    assert.match(readItem(dir, "BL-0001").text, /Синий чайник/);
    assert.throws(() => execFileSync(process.execPath, [CLI, "list", "--status", "закрыт"], { env, encoding: "utf8", stdio: "pipe" }));
    fs.rmSync(data, { recursive: true, force: true });
});

test("разбор строки оболочки: перенаправление в файл — отказ, 2>&1 — можно", () => {
    assert.equal(splitShell("a 2>&1 | b").bad, null);
    assert.ok(splitShell("a > f").bad);
    assert.deepEqual(splitShell("git log --oneline | head -n 5").segs, [["git", "log", "--oneline"], ["head", "-n", "5"]]);
});

test("разрешения агента бэклога: чтение — да, запись — только BL-*.md, git и node — только чтение, секреты и другие машины — нет", () => {
    const ctx = { dir: "/srv/wt/_dashboard/backlog", data: "/srv/wt/_dashboard", cli: "/srv/dk/scripts/dev/backlog.mjs" };
    const d = (kind, extra) => backlogDecide({ kind, ...extra }, ctx).d;
    assert.equal(d("read", { path: "/srv/wt/_backlog/src/x.ts" }), "allow");
    assert.equal(d("read", { path: "/srv/wt/_dashboard/settings.json" }), null);
    assert.equal(d("read", { path: "/srv/wt/_backlog/.env.local" }), null);
    assert.equal(d("read", { path: "/srv/wt/_dashboard/backlog/BL-0001-a.md" }), "allow");
    assert.equal(d("edit", { path: "\\srv\\wt\\_dashboard\\backlog\\BL-0001-moderation-status-for-client.md" }), "allow");
    assert.equal(d("write", { path: "/srv/wt/_dashboard/backlog/notes.txt" }), null);
    assert.equal(d("write", { path: "/srv/wt/_dashboard/backlog/sub/BL-0001-a.md" }), null);
    assert.equal(d("edit", { path: "/srv/wt/_backlog/src/x.ts" }), null);
    assert.equal(d("edit", { path: "/srv/wt/_dashboard/settings.json" }), null);
    assert.equal(d("other", { name: "WebFetch" }), null);
    assert.match(backlogDecide({ kind: "other", name: "WebFetch" }, ctx).why, /WebFetch/);
    assert.equal(d("search", { path: "/srv/wt/_backlog" }), "allow");
    assert.equal(d("todo", {}), "allow");
    assert.equal(d("bash", { command: "git log --oneline -5" }), "allow");
    assert.equal(d("bash", { command: "git push" }), null);
    const ok = (c) => assert.equal(backlogBashCheck(c, ctx), null, c), no = (c) => assert.ok(backlogBashCheck(c, ctx), "нужен вопрос: " + c);
    ok("git -C /srv/wt/_backlog log --oneline -20 -- src/web");
    ok("git log -S 'moderation_status' --oneline | head -20");
    ok("grep -rn 'moderation' src | head -50");
    ok("node /srv/dk/scripts/dev/backlog.mjs set BL-0001 status=researched");
    ok("cd /srv/wt/_backlog && git show staging:src/pages/x.vue | sed -n '1,80p'");
    no("git checkout -b x");
    no("git -C /srv/wt/_backlog reset --hard");
    no("git diff --output=/tmp/x");
    no("node -e 'require(\"fs\").writeFileSync(\"x\",\"y\")'");
    no("node /srv/dk/scripts/dev/epic.mjs new x");
    no("echo x > /srv/wt/_backlog/a.ts");
    no("rm -rf /srv/wt/_backlog");
    no("cat /srv/wt/_dashboard/settings.json");
    no("cat ~/.ssh/id_ed25519");
    no("sed -i 's/a/b/' x.ts");
    no("find . -delete");
    no("curl https://example.com");
    no("npm test");
    no("ssh build-box 'ls'");
    no("grep x a | ssh build-box 'ls'");
});

test("подсказка агента бэклога и раздел оркестратора: постоянные, без дат и меток", () => {
    const a = { dir: "/srv/wt/_dashboard/backlog", cwd: "/srv/wt/_backlog", main: "/srv/code/demo", cli: "/srv/dk/scripts/dev/backlog.mjs" };
    const p = backlogSystemPrompt(a);
    assert.equal(p, backlogSystemPrompt({ ...a }));
    for (const s of ["Исследование", "Предзаготовка плана", "status=researched", "Вопросы владельцу:", a.dir, a.cwd, a.cli])
        assert.ok(p.includes(s), s);
    assert.doesNotMatch(p, /\d{2}\.\d{2}\.\d{4}|\bП\d+\b|\bBL-\d{4}\b|undefined/);
    const o = orchBacklogSection(a);
    assert.match(o, /list --status researched/);
    assert.match(o, /status=in-wave/);
    assert.match(o, /посмотри бэклог/);
    assert.doesNotMatch(o, /\d{2}\.\d{2}\.\d{4}/);
    const m = researchMessage({ id: "BL-0001", file: "/x/BL-0001-a.md", sha: "abc" });
    assert.ok(m.startsWith(RESEARCH_HEAD));
    assert.match(m.slice(RESEARCH_HEAD.length), /BL-0001/);
    assert.match(m, /staging abc/);
});
