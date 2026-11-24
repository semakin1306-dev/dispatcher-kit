// Сторожа графа импортов: модули диспетчерской не импортируют друг друга по кругу (новая зависимость «назад» — поздней
// привязкой late.mjs через wiring.mjs), каждое имя импорта есть в экспорте модуля, модулей из списка «Не входит» нет ни
// файлами, ни импортами, код — с переводами строк LF. Список циклов: node scripts/dev/dashboard/imports.test.mjs --print
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV = resolve(HERE, "..");
const ROOT = resolve(DEV, "../..");
const rel = (f) => relative(ROOT, f).replace(/\\/g, "/");
const STATIC_RE = /^\s*(?:import|export)\s+(?:[^"';]*?\s+from\s+)?["'](\.{1,2}\/[^"']+\.m?js)["']/gm;
const DYN_RE = /\bimport\(\s*["'](\.{1,2}\/[^"']+\.m?js)["']\s*\)/g;

/** Папки кода диспетчерской: сервер, команды, рантаймы, хуки, настройка, инструменты. */
export const CODE_DIRS = [HERE, DEV, join(DEV, "runtimes"), join(DEV, "hooks"), join(ROOT, "setup"), join(ROOT, "tools"), ROOT];

export function importGraph(dirs = CODE_DIRS) {
    const files = [];
    for (const d of dirs)
        for (const n of readdirSync(d))
            if (n.endsWith(".mjs"))
                files.push(join(d, n));
    const g = new Map();
    for (const f of files) {
        const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        const deps = new Set();
        for (const re of [STATIC_RE, DYN_RE]) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(src)))
                deps.add(rel(resolve(dirname(f), m[1])));
        }
        g.set(rel(f), [...deps].sort());
    }
    return g;
}

export function cycles(g) {
    let idx = 0;
    const st = [], on = new Set(), num = new Map(), low = new Map(), out = [];
    const visit = (v) => {
        num.set(v, idx);
        low.set(v, idx);
        idx++;
        st.push(v);
        on.add(v);
        for (const w of g.get(v) || []) {
            if (!g.has(w))
                continue;
            if (!num.has(w)) {
                visit(w);
                low.set(v, Math.min(low.get(v), low.get(w)));
            }
            else if (on.has(w))
                low.set(v, Math.min(low.get(v), num.get(w)));
        }
        if (low.get(v) === num.get(v)) {
            const c = [];
            let w;
            do {
                w = st.pop();
                on.delete(w);
                c.push(w);
            } while (w !== v);
            if (c.length > 1 || (g.get(v) || []).includes(v))
                out.push(c.sort());
        }
    };
    for (const v of [...g.keys()].sort())
        if (!num.has(v))
            visit(v);
    return out;
}

function describe(g, comp) {
    const inC = new Set(comp);
    return comp.map((v) => "  " + v + " → " + (g.get(v) || []).filter((w) => inC.has(w)).join(", ")).join("\n");
}

test("импорты модулей диспетчерской без циклов", () => {
    const g = importGraph();
    assert.ok(g.size > 20, "граф не построен: файлов " + g.size);
    const cs = cycles(g);
    assert.equal(cs.length, 0, "циклические импорты (" + cs.length + " компонент):\n" + cs.map((c) => describe(g, c)).join("\n\n"));
});

test("late.mjs — лист графа: сам ничего из диспетчерской не импортирует", () => {
    const g = importGraph();
    assert.deepEqual(g.get("scripts/dev/dashboard/late.mjs"), []);
});

test("все обёртки late.mjs подключены wiring.mjs и указывают на настоящие экспорты", async () => {
    process.env.DASH_DRY = "1";
    process.env.DASH_DATA = process.env.DASH_DATA || join(tmpdir(), "dash-imports-test");
    await import("./wiring.mjs");
    const L = await import("./late.mjs");
    assert.ok(L.lateList().length > 0, "обёрток нет — late.mjs не используется?");
    assert.deepEqual(L.unbound(), [], "обёртки без модуля или без такого экспорта (добавьте модуль в wiring.mjs)");
});

test("поиск циклов ловит круг и петлю", () => {
    const g = new Map([["a", ["b"]], ["b", ["c"]], ["c", ["a"]], ["d", ["d"]], ["e", ["a"]]]);
    assert.deepEqual(cycles(g), [["a", "b", "c"], ["d"]]);
});

if (process.argv.includes("--print")) {
    const g = importGraph(), cs = cycles(g);
    console.log("модулей: " + g.size + ", рёбер: " + [...g.values()].reduce((a, d) => a + d.length, 0) + ", циклических компонент: " + cs.length);
    for (const c of cs)
        console.log("\n[" + c.length + "] " + c.join(" ") + "\n" + describe(g, c));
}

// ── имена импортов есть в экспорте модуля ──
const splitTop = (s) => { let depth = 0, cur = ""; const parts = []; let q = null; for (const ch of s) { if (q) { cur += ch; if (ch === q) q = null; continue } if (ch === '"' || ch === "'" || ch === "`") { q = ch; cur += ch; continue } if ("([{".includes(ch)) depth++; else if (")]}".includes(ch)) depth--; if (ch === "," && depth === 0) { parts.push(cur); cur = "" } else cur += ch } parts.push(cur); return parts };
const expCache = new Map();
/** Имена, которые модуль экспортирует (по тексту: export const/let/function/class, export { … }, export * from). */
export function exportsOf(file) {
    if (expCache.has(file)) return expCache.get(file);
    const s = new Set(); expCache.set(file, s);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/gm)) s.add(m[1]);
    for (const m of src.matchAll(/^\s*export\s+(?:const|let|var)\s+\{([^}]*)\}/gm)) for (const x of m[1].split(",")) { const n = x.split(":").pop().trim().split("=")[0].trim(); if (n) s.add(n) }
    for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) for (const x of m[1].split(",")) { const p = x.trim().split(/\s+as\s+/); const n = (p[1] || p[0]).trim(); if (n) s.add(n) }
    for (const m of src.matchAll(/^\s*export\s+\*\s+from\s*["']([^"']+)["']/gm)) for (const x of exportsOf(resolve(dirname(file), m[1]))) s.add(x);
    for (const m of src.matchAll(/^export\s+(?:const|let)\s+([^\n]+)$/gm)) for (const p of splitTop(m[1])) { const mm = /^\s*([\w$]+)\s*=/.exec(p); if (mm) s.add(mm[1]) }
    return s;
}
/** Нарушения: «файл: модуль не экспортирует имя» и «файл: нет модуля». */
export function namedImportProblems(files) {
    const out = [];
    for (const f of files) {
        const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        for (const m of src.matchAll(/^\s*(?:import|export)\s+(?:[\w$]+\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:\*\s+as\s+[\w$]+\s*)?from\s*["'](\.{1,2}\/[^"']+)["']/gm)) {
            const t = resolve(dirname(f), m[2]);
            let names;
            try { names = exportsOf(t) } catch { out.push(rel(f) + ": нет модуля " + m[2]); continue }
            if (m[1]) for (const x of m[1].split(",")) { const n = x.trim().split(/\s+as\s+/)[0].trim(); if (n && !names.has(n)) out.push(rel(f) + ": " + m[2] + " не экспортирует " + n) }
        }
    }
    return out;
}
const codeFiles = () => CODE_DIRS.flatMap((d) => readdirSync(d).filter((n) => n.endsWith(".mjs")).map((n) => join(d, n)));

test("каждое имя импорта есть в экспорте модуля (снятый экспорт не роняет сервер при запуске)", () => {
    assert.deepEqual(namedImportProblems(codeFiles()), []);
});

test("проверка имён ловит снятый экспорт и несуществующий модуль", () => {
    const dir = mkdtempSync(join(tmpdir(), "dk-imp-"));
    try {
        writeFileSync(join(dir, "a.mjs"), "export const x = 1, y = 2\nexport function f() {}\n");
        writeFileSync(join(dir, "b.mjs"), 'import { x, y, f, gone } from "./a.mjs"\nimport { z } from "./none.mjs"\n');
        assert.deepEqual(namedImportProblems([join(dir, "b.mjs")]).map((s) => s.replace(/^.*?: /, "")), ["./a.mjs не экспортирует gone", "нет модуля ./none.mjs"]);
    } finally { rmSync(dir, { recursive: true, force: true }) }
});

// ── «Не входит»: этих модулей живой диспетчерской в конструкторе нет ни файлами, ни импортами ──
export const NOT_INCLUDED = /^(warm[\w-]*|usage|token-report|graph-[\w-]+|recon|vault|landing-preview|tablet|remote|archive[\w-]*|prodship|prod-rules|service-deploy|stand-[\w-]+|viewer-rules|machine-relay[\w-]*|dpapi|screenshot|dash-shot|trace-calls|learn|learn-failures)$/;
const moduleName = (spec) => spec.split("/").pop().replace(/\.(m?js|ps1)$/, "");
/** Нарушения в тексте: импорт модуля из списка «Не входит». */
export const notIncludedImports = (src) => [...src.matchAll(/(?:from\s*|import\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)].map((m) => m[1]).filter((s) => s.startsWith(".") && NOT_INCLUDED.test(moduleName(s)));

test("модулей из списка «Не входит» нет: ни файлов, ни импортов", () => {
    const files = [], bad = [];
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name === ".git" || e.name === "node_modules" || e.name === ".import") continue; const p = join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p) } };
    walk(ROOT);
    for (const f of files) {
        if (/\.(m?js|ps1)$/.test(f) && NOT_INCLUDED.test(moduleName(f.replace(/\.test\.mjs$/, ".mjs")))) bad.push(rel(f) + ": файл модуля, который не входит");
        if (/\.m?js$/.test(f) && !/\.test\.mjs$/.test(f)) for (const s of notIncludedImports(readFileSync(f, "utf8"))) bad.push(rel(f) + ": импорт " + s);
    }
    assert.deepEqual(bad, []);
});

test("сторож «Не входит» ловит импорт вырезанного модуля", () => {
    assert.deepEqual(notIncludedImports('import { warmTick } from "./warm.mjs"\nconst u = await import("./usage.mjs")\nimport "../dashboard/prodship.mjs"\nimport { x } from "./stand-accept.mjs"'), ["./warm.mjs", "./usage.mjs", "../dashboard/prodship.mjs", "./stand-accept.mjs"]);
    assert.deepEqual(notIncludedImports('import { git } from "./git.mjs"\nimport { stations } from "./stations.mjs"'), []);
});

test("код диспетчерской — с переводами строк LF (CRLF ломает правки по образцу и диффы между ОС)", () => {
    const bad = codeFiles().concat(readdirSync(join(HERE, "ui")).filter((n) => n.endsWith(".js")).map((n) => join(HERE, "ui", n))).filter((f) => readFileSync(f, "utf8").includes("\r\n")).map(rel);
    assert.deepEqual(bad, []);
});
