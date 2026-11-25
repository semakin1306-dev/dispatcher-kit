// ui-modules-check.mjs — проверка модулей страницы диспетчерской без сборки и без браузера.
//
// Всегда, без зависимостей:
//   · каждый относительный импорт в ui/*.js и index.html указывает на существующий файл (ui/ или общий из ui-shared.mjs);
//   · каждое импортированное имя есть среди экспорта своего модуля; импорт — только именованный { … } из ./x.js;
//   · state.js ничего не импортирует, core.js — только state.js (оба исполняются раньше всех);
//   · все ui/*.js достижимы из main.js; в разметке нет обработчиков on*= (модуль не кладёт имена в window);
//   · index.html грузит ровно один модуль /ui/v__UIVER__/main.js и не ходит за внешними файлами (шрифты, CDN).
// С разборщиком acorn (путь — переменная DK_ACORN, иначе пакет acorn, если он установлен рядом) — ещё и области видимости:
//   · свободные имена — только намеренные имена браузера (BROWSER): опечатка или имя из удалённой функции молча ушло бы в window;
//   · запись в импортированное имя запрещена (общее состояние пишется через setState);
//   · верхний уровень модулей (кроме main.js) трогает из чужих модулей только state.js и core.js — иначе при кольцевых
//     импортах можно попасть на ещё не исполненный модуль.
//   node scripts/dev/dashboard/ui-modules-check.mjs [--list]   — проверка; --list — опись: кто что экспортирует и кто импортирует
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Путь к acorn или пусто: переменная DK_ACORN, иначе пакет acorn, разрешённый от этой папки или текущей. */
export function acornPath() {
    if (process.env.DK_ACORN)
        return fs.existsSync(process.env.DK_ACORN) ? process.env.DK_ACORN : "";
    for (const from of [HERE, process.cwd()]) {
        try {
            return createRequire(path.join(from, "x.js")).resolve("acorn");
        }
        catch { }
    }
    return "";
}
export const acornAvailable = () => !!acornPath();

export const BROWSER = new Set(("AbortSignal Array Boolean CSS Date Element Error EventSource JSON Map Math MutationObserver NodeFilter Number Object Promise " +
    "RegExp Set String clearInterval clearTimeout confirm console document encodeURIComponent fetch innerHeight innerWidth localStorage location " +
    "matchMedia navigator prompt requestAnimationFrame scrollY setInterval setTimeout undefined window " +
    "Infinity URLSearchParams devicePixelRatio getComputedStyle performance queueMicrotask Intl").split(" "));
const LEAVES = { "state.js": [], "core.js": ["state.js"] };

function declPattern(p, out) {
  if (!p) return
  if (p.type === "Identifier") out.push(p.name)
  else if (p.type === "ObjectPattern") p.properties.forEach((x) => declPattern(x.type === "RestElement" ? x.argument : x.value, out))
  else if (p.type === "ArrayPattern") p.elements.forEach((x) => declPattern(x, out))
  else if (p.type === "RestElement") declPattern(p.argument, out)
  else if (p.type === "AssignmentPattern") declPattern(p.left, out)
}
// области видимости: объявления (с подъёмом) и обращения; resolved = null — имя не объявлено в модуле
function analyze(ast) {
  const top = { names: new Map(), parent: null, fn: true }, refs = []
  let fnDepth = 0
  const hoistVar = (node, fnS) => {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) return node.forEach((n) => hoistVar(n, fnS))
    if (/Function/.test(node.type)) return
    if (node.type === "VariableDeclaration" && node.kind === "var") { const ns = []; node.declarations.forEach((d) => declPattern(d.id, ns)); ns.forEach((n) => fnS.names.set(n, "var")) }
    for (const k in node) if (k !== "type" && node[k] && typeof node[k] === "object") hoistVar(node[k], fnS)
  }
  const hoistStmt = (sc, st, fnS) => {
    if (!st) return
    if (st.type === "FunctionDeclaration" || st.type === "ClassDeclaration") sc.names.set(st.id.name, "function")
    else if (st.type === "VariableDeclaration") { const ns = []; st.declarations.forEach((d) => declPattern(d.id, ns)); ns.forEach((n) => (st.kind === "var" ? fnS : sc).names.set(n, st.kind)) }
    else if (st.type === "ExportNamedDeclaration" || st.type === "ExportDefaultDeclaration") { if (st.declaration) hoistStmt(sc, st.declaration, fnS) }
    else if (st.type === "ImportDeclaration") st.specifiers.forEach((s) => sc.names.set(s.local.name, "import"))
    else hoistVar(st, fnS)
  }
  const hoist = (sc, body, fnS) => body.forEach((st) => hoistStmt(sc, st, fnS))
  const lookup = (sc, n) => { for (let s = sc; s; s = s.parent) if (s.names.has(n)) return s; return null }
  const ref = (sc, id, write) => { const s = lookup(sc, id.name); refs.push({ name: id.name, write, topLevel: fnDepth === 0, pos: id.start, resolved: s }) }
  const fnOf = (sc) => { let s = sc; while (!s.fn) s = s.parent; return s }
  const block = (sc, body) => { const bs = { names: new Map(), parent: sc, fn: false }; hoist(bs, body, fnOf(sc)); return bs }
  const pattern = (sc, p, write, decl) => {
    if (!p) return
    if (p.type === "Identifier") {
        if (!decl) ref(sc, p, write);
    } else if (p.type === "ObjectPattern")
        p.properties.forEach((x) => {
            if (x.type === "RestElement") pattern(sc, x.argument, write, decl);
            else {
                if (x.computed) visit(sc, x.key);
                pattern(sc, x.value, write, decl);
            }
        });
    else if (p.type === "ArrayPattern") p.elements.forEach((x) => pattern(sc, x, write, decl));
    else if (p.type === "RestElement") pattern(sc, p.argument, write, decl);
    else if (p.type === "AssignmentPattern") {
        pattern(sc, p.left, write, decl);
        visit(sc, p.right);
    } else visit(sc, p);
  }
  const fn = (sc, f) => {
    const fs_ = { names: new Map(), parent: sc, fn: true }
    if (f.type === "FunctionExpression" && f.id) fs_.names.set(f.id.name, "fname")
    const ps = []; f.params.forEach((p) => declPattern(p, ps)); ps.forEach((n) => fs_.names.set(n, "param"))
    fnDepth++
    f.params.forEach((p) => pattern(fs_, p, false, true))
    if (f.body.type === "BlockStatement") { hoist(fs_, f.body.body, fs_); f.body.body.forEach((s) => visit(fs_, s)) } else visit(fs_, f.body)
    fnDepth--
  }
  function visit(sc, n) {
    if (!n || typeof n !== "object") return
    if (Array.isArray(n)) return n.forEach((x) => visit(sc, x))
    switch (n.type) {
        case "Identifier":
            return ref(sc, n, false);
        case "FunctionDeclaration":
        case "FunctionExpression":
        case "ArrowFunctionExpression":
            return fn(sc, n);
        case "ClassDeclaration":
        case "ClassExpression":
            visit(sc, n.superClass);
            n.body.body.forEach((m) => {
                if (m.computed) visit(sc, m.key);
                visit(sc, m.value);
            });
            return;
        case "VariableDeclaration":
            n.declarations.forEach((d) => {
                pattern(sc, d.id, true, true);
                visit(sc, d.init);
            });
            return;
        case "MemberExpression":
            visit(sc, n.object);
            if (n.computed) visit(sc, n.property);
            return;
        case "Property":
        case "MethodDefinition":
        case "PropertyDefinition":
            if (n.computed) visit(sc, n.key);
            visit(sc, n.value);
            return;
        case "AssignmentExpression":
            pattern(sc, n.left, true, false);
            visit(sc, n.right);
            if (n.operator !== "=" && n.left.type === "Identifier") ref(sc, n.left, false);
            return;
        case "UpdateExpression":
            if (n.argument.type === "Identifier") {
                ref(sc, n.argument, true);
                ref(sc, n.argument, false);
            } else visit(sc, n.argument);
            return;
        case "BlockStatement":
        case "StaticBlock": {
            const bs = block(sc, n.body);
            n.body.forEach((s) => visit(bs, s));
            return;
        }
        case "ForStatement":
        case "ForInStatement":
        case "ForOfStatement": {
            const bs = { names: new Map(), parent: sc, fn: false },
                init = n.init || n.left;
            if (init && init.type === "VariableDeclaration" && init.kind !== "var") {
                const ns = [];
                init.declarations.forEach((d) => declPattern(d.id, ns));
                ns.forEach((x) => bs.names.set(x, init.kind));
            }
            for (const k of ["init", "left", "test", "update", "right"])
                if (n[k]) {
                    if (k === "left" && n[k].type !== "VariableDeclaration") pattern(bs, n[k], true, false);
                    else visit(bs, n[k]);
                }
            return visit(bs, n.body);
        }
        case "CatchClause": {
            const cs = { names: new Map(), parent: sc, fn: false },
                ns = [];
            declPattern(n.param, ns);
            ns.forEach((x) => cs.names.set(x, "catch"));
            return visit(cs, n.body);
        }
        case "SwitchStatement": {
            visit(sc, n.discriminant);
            const bs = block(
                sc,
                n.cases.flatMap((c) => c.consequent),
            );
            n.cases.forEach((c) => {
                visit(bs, c.test);
                c.consequent.forEach((s) => visit(bs, s));
            });
            return;
        }
        case "LabeledStatement":
            return visit(sc, n.body);
        case "BreakStatement":
        case "ContinueStatement":
        case "ImportDeclaration":
        case "MetaProperty":
        case "TemplateElement":
        case "Literal":
            return;
        case "ExportNamedDeclaration":
            if (n.declaration) visit(sc, n.declaration);
            else if (!n.source) n.specifiers.forEach((s) => ref(sc, s.local, false));
            return;
        case "ExportDefaultDeclaration":
            return visit(sc, n.declaration);
    }
    for (const k in n) if (k !== "type" && k !== "start" && k !== "end" && n[k] && typeof n[k] === "object") visit(sc, n[k])
  }
  hoist(top, ast.body, top)
  ast.body.forEach((s) => visit(top, s))
  return { top, refs }
}

// Лёгкий разбор без acorn: комментарии вырезаются, чтобы «import» в тексте комментария не сбивал.
function stripCode(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}
function scanImports(src) {
    const out = [];
    const re = /(?:^|[\n;])\s*import\s*(\{[^}]*\}|[\w$]+|\*\s*as\s+[\w$]+)?\s*(?:from\s*)?["']([^"']+)["']/g;
    for (const m of stripCode(src).matchAll(re)) {
        const spec = m[1] || "";
        const named = spec.startsWith("{");
        const names = named ? spec.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.split(/\s+as\s+/)[0].trim()) : [];
        out.push({ from: m[2], named, names });
    }
    for (const m of stripCode(src).matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g))
        out.push({ from: m[1], named: false, dynamic: true, names: [] });
    return out;
}
function scanExports(src) {
    const out = new Set();
    const code = stripCode(src);
    for (const m of code.matchAll(/\bexport\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([\w$]+)/g))
        out.add(m[1]);
    // export let a = 1, b = (() => {…})(): следующие имена — после запятых на нулевой глубине скобок, до конца оператора
    for (const m of code.matchAll(/\bexport\s+(?:const|let|var)\s+/g)) {
        let depth = 0, q = "";
        for (let i = m.index + m[0].length; i < code.length; i++) {
            const c = code[i];
            if (q) { if (c === "\\") i++; else if (c === q) q = ""; continue; }
            if (c === '"' || c === "'" || c === "`") q = c;
            else if ("([{".includes(c)) depth++;
            else if (")]}".includes(c)) depth--;
            else if (depth === 0 && (c === ";" || c === "\n")) break;
            else if (depth === 0 && c === ",") { const n = /^\s*([\w$]+)\s*=/.exec(code.slice(i + 1, i + 80)); if (n) out.add(n[1]); }
        }
    }
    for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}/g))
        for (const s of m[1].split(",").map((x) => x.trim()).filter(Boolean))
            out.add(s.split(/\s+as\s+/).pop().trim());
    return out;
}

/** dash — папка scripts/dev/dashboard. Возвращает { errors, mods: { "x.js": { exports, imports: { "y.js": [имена] }, readers } }, deep } */
export async function checkUi(dash = HERE) {
    const ui = path.join(dash, "ui"), errors = [], mods = {};
    const files = fs.readdirSync(ui).filter((f) => f.endsWith(".js")).sort();
    const sharedMod = path.join(dash, "ui-shared.mjs");
    const { UI_SHARED } = fs.existsSync(sharedMod) ? await import(pathToFileURL(sharedMod).href) : { UI_SHARED: {} };
    const ap = acornPath();
    const acorn = ap ? await import(pathToFileURL(ap).href) : null;
    for (const f of files) {
        const src = fs.readFileSync(path.join(ui, f), "utf8");
        const imports = {};
        if (!acorn) {
            for (const im of scanImports(src)) {
                if (!/^\.\/[\w.-]+\.js$/.test(im.from)) { errors.push(`${f}: импорт «${im.from}» — только ./x.js из ui/`); continue; }
                if (!im.named) { errors.push(`${f}: импорт из ${im.from} — только именованный { … }`); continue; }
                (imports[im.from.slice(2)] ||= []).push(...im.names);
            }
            mods[f] = { exports: scanExports(src), imports, readers: {} };
            continue;
        }
        let ast;
        try { ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module", locations: true }); }
        catch (e) { errors.push(`${f}: не разбирается как модуль — ${e.message}`); continue; }
        const { top, refs } = analyze(ast), local = new Map(), exports = new Set();
        for (const st of ast.body) {
            if (st.type === "ImportDeclaration") {
                const from = st.source.value;
                if (!/^\.\/[\w.-]+\.js$/.test(from)) { errors.push(`${f}: импорт «${from}» — только ./x.js из ui/`); continue; }
                if (!st.specifiers.length) errors.push(`${f}: импорт из ${from} — только именованный { … }`);
                for (const s of st.specifiers) {
                    if (s.type !== "ImportSpecifier") errors.push(`${f}: импорт из ${from} — только именованный { … }`);
                    else { (imports[from.slice(2)] ||= []).push(s.imported.name); local.set(s.local.name, from.slice(2)); }
                }
            }
            if (st.type === "ExportNamedDeclaration") {
                if (st.declaration && st.declaration.id) exports.add(st.declaration.id.name);
                else if (st.declaration) st.declaration.declarations.forEach((d) => { const ns = []; declPattern(d.id, ns); ns.forEach((n) => exports.add(n)); });
                st.specifiers.forEach((s) => exports.add(s.exported.name));
            }
            if (st.type === "ExportDefaultDeclaration" || st.type === "ExportAllDeclaration") errors.push(`${f}: export default / export * — не принято, только именованные`);
        }
        for (const r of refs) {
            const line = src.slice(0, r.pos).split("\n").length;
            if (!r.resolved) {
                if (!BROWSER.has(r.name)) errors.push(`${f}:${line}: «${r.name}» нигде не объявлено — в модуле это window.${r.name} (если имя браузера нужно намеренно — добавьте в BROWSER)`);
                continue;
            }
            const from = r.resolved === top && local.get(r.name);
            if (from && r.write) errors.push(`${f}:${line}: присваивание импортированному «${r.name}» — запись общего состояния только setState("${r.name}", …)`);
            if (from && r.topLevel && f !== "main.js" && !["state.js", "core.js"].includes(from))
                errors.push(
                    `${f}:${line}: «${r.name}» из ${from} на верхнем уровне — при кольцевых импортах модуль может быть ещё не исполнен; перенесите в функцию`,
                );
        }
        mods[f] = { exports, imports, readers: {} };
    }
    // Общие файлы других модулей под /ui/: только экспорт и то, что сами они ничего не импортируют.
    for (const [f, abs] of Object.entries(UI_SHARED)) {
        if (mods[f]) { errors.push(`${f}: есть и в ui/, и в ui-shared.mjs — сервер отдаёт общий`); continue; }
        if (!fs.existsSync(abs)) { errors.push(`${f}: общий файл ${path.relative(dash, abs)} не найден`); continue; }
        const src = fs.readFileSync(abs, "utf8");
        for (const im of scanImports(src)) errors.push(`${f} (общий): импортирует ${im.from} — под /ui/ его не найти`);
        mods[f] = { exports: scanExports(src), imports: {}, readers: {}, shared: abs };
    }
    for (const [f, m] of Object.entries(mods)) for (const [from, names] of Object.entries(m.imports)) {
        const t = mods[from];
        if (!t) { errors.push(`${f}: импорт из несуществующего ${from}`); continue; }
        for (const n of names) { if (!t.exports.has(n)) errors.push(`${f}: «${n}» не экспортируется из ${from}`); (t.readers[n] ||= []).push(f); }
    }
    for (const [f, allow] of Object.entries(LEAVES)) if (mods[f]) {
        const bad = Object.keys(mods[f].imports).filter((x) => !allow.includes(x));
        if (bad.length) errors.push(`${f}: модуль-лист импортирует ${bad.join(", ")} (можно только: ${allow.join(", ") || "ничего"})`);
    }
    const seen = new Set(), go = (f) => { if (seen.has(f) || !mods[f]) return; seen.add(f); Object.keys(mods[f].imports).forEach(go); };
    go("main.js");
    for (const f of Object.keys(mods)) if (!seen.has(f)) errors.push(`${f}: не достижим из main.js — страница его не загрузит`);
    for (const f of ["index.html", ...files.map((x) => "ui/" + x)]) {
        const src = fs.readFileSync(path.join(dash, f), "utf8"), m = src.match(/\son[a-z]+\s*=\s*["'`]/g);
        if (m) errors.push(`${f}: обработчик в разметке (${[...new Set(m.map((x) => x.trim()))].join(", ")}) — модуль не кладёт имена в window; data-act и делегирование в main.js`);
    }
    const html = fs.readFileSync(path.join(dash, "index.html"), "utf8"), scripts = html.match(/<script\b[^>]*\bsrc=[^>]*>/g) || [];
    if (scripts.length !== 1 || !/type="module"/.test(scripts[0]) || !scripts[0].includes('src="/ui/v__UIVER__/main.js"'))
        errors.push(`index.html: ожидается один <script type="module" src="/ui/v__UIVER__/main.js"> (отметка в пути доходит до вложенных import), есть: ${scripts.join(" ")}`);
    // Страница работает без сети: всё, на что ссылаются разметка и стили, лежит в ui/.
    const css = fs.readdirSync(ui).filter((f) => f.endsWith(".css"));
    for (const f of ["index.html", ...css.map((x) => "ui/" + x)]) {
        const src = fs.readFileSync(path.join(dash, f), "utf8");
        for (const m of src.matchAll(
            /(?:\b(?:href|src)\s*=\s*["']|url\(\s*["']?|@import\s+["'])((?:https?:)?\/\/[^"')\s]+)/g,
        ))
            errors.push(`${f}: внешний адрес ${m[1]} — страница должна работать без сети`);
        for (const m of src.matchAll(/\b(?:href|src)\s*=\s*["']\/ui\/(?:v__UIVER__\/)?([^"'?#]+)/g))
            if (!fs.existsSync(path.join(ui, m[1])) && !UI_SHARED[m[1]])
                errors.push(`${f}: ссылка на /ui/${m[1]} — такого файла в ui/ нет`);
        for (const m of src.matchAll(/url\(\s*["']?(?!data:|#|https?:|\/\/)([^"')]+)["']?\s*\)/g))
            if (!fs.existsSync(path.join(ui, m[1].replace(/^\/ui\//, "").replace(/[?#].*$/, ""))))
                errors.push(`${f}: url(${m[1]}) — такого файла в ui/ нет`);
    }
    return { errors, mods, deep: !!acorn };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { errors, mods, deep } = await checkUi(HERE);
    if (process.argv.includes("--list")) for (const [f, m] of Object.entries(mods)) {
        console.log(`\n${f}: экспорт ${m.exports.size}`);
        for (const n of [...m.exports].sort((a, b) => a.localeCompare(b))) console.log(`  ${n} ← ${(m.readers[n] || []).map((x) => x.replace(/\.js$/, "")).join(", ") || "—"}`);
    }
    if (!deep) console.log("(без acorn: области видимости не проверены — задайте DK_ACORN=<путь к acorn.mjs>)");
    console.log(errors.length ? "ОШИБКИ:\n" + errors.join("\n") : "проверка: ок");
    process.exit(errors.length ? 1 : 0);
}
