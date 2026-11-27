import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-epicrules-"));
process.env.DASH_DATA = TMP;
process.env.DASH_DRY = "1";
after(async () => {
    const st = await import("./store.mjs");
    await st.settled(); st.flushSync(); await st.settled();
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const { rulesLint, rulesTask, staleRules, RULES_REL, RULES_TEMPLATE } = await import("./epic-rules.mjs");

// Демо-проект: подготовка слота — `npm ci --prefer-offline` и `npm run build --workspaces --if-present`,
// задачи — `npx jest {input}`, `npx vitest run {input}`, `npm run lint`, `npm run typecheck`.
const OLD = [
    "## Первые шаги (один раз)", "",
    "1. `git status` и `git branch --show-current` — убедись, что это твоя ветка.",
    "2. `npm ci --prefer-offline` в корне своей папки.",
    "3. Перед правками API: `npm run build --workspaces --if-present`.",
    "## Что делать нельзя",
    "- Тесты `npx jest` не запускай — их ставит диспетчерская.",
    "- Перед готовностью прогони `npm run lint` сам.",
    "- Общие файлы — `package.json` — только оркестратор.",
].join("\n");

test("правила устаревших строк — из конфига проекта: шаги подготовки слота и задачи станций", () => {
    const cmds = staleRules().map((r) => r.cmd);
    assert.deepEqual(cmds, ["npm ci --prefer-offline", "npm run build --workspaces --if-present", "npx jest", "npx vitest run", "npm run lint", "npm run typecheck"]);
});

test("устаревшие строки: подготовка слота и свой прогон проверки; запрет («не запускай») и общие файлы — не находка", () => {
    const f = rulesLint(OLD);
    assert.deepEqual(f.map((x) => x.n), [4, 5, 8]);
    assert.match(f[0].why, /подготовки слота/);
    assert.match(f[2].why, /Линтер/);
    assert.ok(!f.some((x) => /package\.json/.test(x.line)));
});

test("шаблон диспетчерской лежит там, куда указывает навык new-epic", () => {
    assert.ok(fs.existsSync(RULES_TEMPLATE), RULES_TEMPLATE);
    assert.match(fs.readFileSync(RULES_TEMPLATE, "utf8"), /## Первые шаги/);
    const skill = fs.readFileSync(new URL("../../../skills/new-epic/SKILL.md", import.meta.url), "utf8");
    assert.match(skill, /agent-briefs\/SESSIONS-common-rules\.md/);
    assert.equal(RULES_REL, ".claude/plans/waves/agent-briefs/SESSIONS-common-rules.md");
});

test("поручение оркестратору — путь файла, строки с причинами, образец; без «владельцу»", () => {
    const t = rulesTask({ file: "/work/epic-x/" + RULES_REL, findings: rulesLint(OLD) });
    assert.match(t, /SESSIONS-common-rules\.md/);
    assert.match(t, /стр\. 4/);
    assert.ok(t.includes(RULES_TEMPLATE.replace(/\\/g, "/")));
    assert.match(t, /Первые шаги/);
    assert.doesNotMatch(t, /Вопросы владельцу/);
});

test("проверка правил открытых эпиков — один раз на содержимое файла, память между перезапусками", async () => {
    const { epicRulesCheck } = await import("./epic-rules.mjs");
    const orch = path.join(TMP, "orch");
    fs.mkdirSync(path.join(orch, path.dirname(RULES_REL)), { recursive: true });
    fs.writeFileSync(path.join(orch, RULES_REL), OLD);
    const sent = [], epics = [{ id: "e1", status: "open", orch: { path: orch } }, { id: "e2", status: "open", orch: { path: path.join(TMP, "нет") } }];
    const send = (key, text) => sent.push({ key, text });
    assert.deepEqual(epicRulesCheck({ epics, send, force: true }), ["e1"]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].key, "orchestrator@e1");
    assert.deepEqual(epicRulesCheck({ epics, send, force: true }), [], "то же содержимое — второй раз не поручаем");
    fs.writeFileSync(path.join(orch, RULES_REL), OLD + "\n- ещё строка");
    assert.deepEqual(epicRulesCheck({ epics, send, force: true }), ["e1"], "файл изменился, а строки остались — поручаем снова");
    fs.writeFileSync(path.join(orch, RULES_REL), "## Первые шаги\n\nНичего не ставь и не собирай: это делает диспетчерская.\n");
    assert.deepEqual(epicRulesCheck({ epics, send, force: true }), [], "переписан — тихо");
});

test("запуск сервера проверяет правила открытых эпиков по таймеру (boot.mjs зовёт epicRulesCheck)", () => {
    const boot = fs.readFileSync(new URL("./boot.mjs", import.meta.url), "utf8");
    assert.match(boot, /epicRulesCheck\(\)/);
});

test("новый эпик не затирает базу правил проекта: шаблон кладётся, только если файла нет; иначе — дописать «Правила эпика»", async () => {
    const { RULES_TEMPLATE } = await import("./epic-rules.mjs");
    const root = path.resolve(path.dirname(RULES_TEMPLATE), "..");
    const skill = fs.readFileSync(path.join(root, "skills", "new-epic", "SKILL.md"), "utf8");
    assert.match(skill, /уже есть в репозитории проекта/);
    assert.match(skill, /НЕ заменяй его шаблоном/);
    assert.match(fs.readFileSync(RULES_TEMPLATE, "utf8"), /только если такого файла в репозитории проекта ещё нет/);
    assert.match(fs.readFileSync(path.join(root, "scripts", "dev", "prompts", "epic-rules-fix.md"), "utf8"), /целиком шаблоном не заменяй/);
});
