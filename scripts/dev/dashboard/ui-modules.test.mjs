// ui-modules.test.mjs — модули страницы: импорты сходятся с экспортами и указывают на существующие файлы, порядок исполнения
// листьев соблюдён, в разметке нет обработчиков и внешних адресов, файлов выключенных возможностей нет. Разбор —
// ui-modules-check.mjs; с acorn (DK_ACORN) проверяются ещё и свободные имена.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acornAvailable, checkUi } from "./ui-modules-check.mjs";
import { UI_SHARED } from "./ui-shared.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, "ui");
const noAcorn = acornAvailable() ? false : "нет acorn (DK_ACORN) — разбор областей видимости пропущен";

/** Копия страницы во временной папке: ui/, index.html и общие файлы — для проб с порчей. */
function copyPage() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ui-mod-"));
    fs.mkdirSync(path.join(tmp, "ui"));
    for (const f of fs.readdirSync(UI))
        fs.copyFileSync(path.join(UI, f), path.join(tmp, "ui", f));
    for (const f of ["index.html", "ui-shared.mjs", "owner-options.mjs"])
        fs.copyFileSync(path.join(HERE, f), path.join(tmp, f));
    return tmp;
}

test("ui/*.js: импорты сходятся с экспортами, листья и порядок исполнения соблюдены, страница без внешних адресов", async () => {
    const { errors, mods } = await checkUi(HERE);
    assert.deepEqual(errors, []);
    assert.ok(mods["main.js"] && mods["state.js"] && mods["core.js"], "вход и листья на месте");
});

test("каждый относительный импорт ui/** и каждая ссылка /ui/ из index.html указывают на существующий файл", () => {
    const missing = [];
    for (const f of fs.readdirSync(UI).filter((x) => x.endsWith(".js"))) {
        const src = fs.readFileSync(path.join(UI, f), "utf8");
        for (const m of src.matchAll(/(?:^|[\n;])\s*import\s[^"'`]*?["'](\.{1,2}\/[^"']+)["']/g))
            if (!fs.existsSync(path.join(UI, m[1])) && !UI_SHARED[m[1].replace(/^\.\//, "")]) missing.push(f + " → " + m[1]);
        for (const m of src.matchAll(/\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g))
            if (!fs.existsSync(path.join(UI, m[1]))) missing.push(f + " → " + m[1]);
    }
    const html = fs.readFileSync(path.join(HERE, "index.html"), "utf8");
    for (const m of html.matchAll(/\b(?:href|src)\s*=\s*["']\/ui\/(?:v__UIVER__\/)?([^"'?#]+)/g))
        if (!fs.existsSync(path.join(UI, m[1]))) missing.push("index.html → /ui/" + m[1]);
    assert.deepEqual(missing, []);
});

test("файлов выключенных возможностей в ui/ нет и никто их не зовёт", () => {
    const gone = ["warm.js", "recongraph.js", "graphpanel.js", "prodfx.js", "release.js"];
    for (const f of gone)
        assert.equal(fs.existsSync(path.join(UI, f)), false, f);
    for (const f of fs.readdirSync(UI).filter((x) => x.endsWith(".js"))) {
        const src = fs.readFileSync(path.join(UI, f), "utf8");
        for (const g of gone)
            assert.ok(!src.includes("./" + g), f + " зовёт " + g);
    }
});

test("порча ловится: импорт из несуществующего файла, имя мимо экспорта, обработчик и внешний адрес в разметке", async () => {
    const tmp = copyPage();
    try {
        fs.appendFileSync(path.join(tmp, "ui", "tasks.js"), '\nimport { zzNope } from "./core.js";\nimport { openWarm } from "./warm.js";\n');
        fs.writeFileSync(path.join(tmp, "index.html"), fs.readFileSync(path.join(tmp, "index.html"), "utf8").replace("</head>", '<link rel="stylesheet" href="https://cdn.example.com/x.css"></head>').replace("<body>", '<body onload="x()">'));
        const { errors } = await checkUi(tmp);
        const has = (re) => assert.ok(errors.some((e) => re.test(e)), re + "\n" + errors.join("\n"));
        has(/tasks\.js: импорт из несуществующего warm\.js/);
        has(/tasks\.js: «zzNope» не экспортируется из core\.js/);
        has(/index\.html: обработчик в разметке/);
        has(/index\.html: внешний адрес https:\/\/cdn\.example\.com/);
    }
    finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("с acorn: имя, которое ушло бы в window, и запись в импорт", { skip: noAcorn }, async () => {
    const tmp = copyPage();
    try {
        fs.appendFileSync(path.join(tmp, "ui", "tasks.js"), "\nfunction zzAgo(r) { return when(r.at) }\nfunction zzW() { S = null }\n");
        const { errors, deep } = await checkUi(tmp);
        assert.equal(deep, true);
        assert.ok(errors.some((e) => /tasks\.js:\d+: «when» нигде не объявлено/.test(e)), errors.join("\n"));
        assert.ok(errors.some((e) => /присваивание импортированному «S»/.test(e)), errors.join("\n"));
    }
    finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
