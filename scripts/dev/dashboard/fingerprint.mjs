// fingerprint.mjs — отпечаток кода и свежесть прогонов: «зелёный» верен только на том коде, где шёл прогон. Отпечаток —
// дерево git вместе с незакоммиченными правками, без служебных путей (документы, папки агента); у каждой задачи свои
// области кода, правка чужой области её прогон не старит.
import { spawn } from "./spawner.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import { readJson, saveJson } from "./store.mjs";
import path from "node:path";
import { S } from "./state.mjs";
import { DATA } from "./config.mjs";
import { git, untrackedList } from "./git.mjs";
import { PROJECT } from "../slots.mjs";
import { globRe, matchAny } from "./tasks.mjs";

/** Пути вне отпечатка кода: зависимости, документы, служебные папки агентов. Их правка прогон не старит. */
export const FP_SKIP = /(^|\/)node_modules\/|^docs\/|^\.claude\/|^\.codex\/|\.md$/i;
export const fpHashes = new Map();
export const fpLast = new Map();
export const headEntriesCache = new Map();

export async function headEntries(cwd, sha = null) {
    const head = sha || (await git(cwd, ["rev-parse", "HEAD"])).out;
    if (!head)
        return null;
    const hit = headEntriesCache.get(head);
    if (hit)
        return hit;
    const ls = await git(cwd, ["ls-tree", "-r", "-z", head], 60000), m = new Map();
    if (!ls.ok)
        return null;
    for (const l of ls.out.split("\0")) {
        const i = l.indexOf("\t");
        if (i < 0)
            continue;
        const n = l.slice(i + 1);
        if (!FP_SKIP.test(n))
            m.set(n, l.slice(0, i).split(" ")[2]);
    }
    headEntriesCache.set(head, m);
    if (headEntriesCache.size > 60)
        headEntriesCache.delete(headEntriesCache.keys().next().value);
    return m;
}

export function hashObjects(cwd, files) {
    return new Promise((res) => {
        const p = spawn("git", ["-C", cwd, "hash-object", "--stdin-paths"], { windowsHide: true });
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.on("error", () => res(null));
        p.on("close", (c) => {
            const ls = out.split(/\r?\n/).filter(Boolean);
            res(c === 0 && ls.length === files.length ? ls : null);
        });
        p.stdin.end(files.join("\n") + "\n");
    });
}

export async function codeFp(cwd, force = false) {
    const hit = fpLast.get(cwd);
    if (!force && hit && Date.now() - hit.at < 4000)
        return hit.v;
    try {
        const head = (await git(cwd, ["rev-parse", "HEAD"])).out;
        if (!head)
            return null;
        const m = await headEntries(cwd, head);
        if (!m)
            return null;
        const [d, u] = await Promise.all([git(cwd, ["diff", "--name-only", "-z", head], 60000), untrackedList(cwd)]);
        if (!d.ok || !u.ok)
            return null;
        const names = [...new Set((d.out + "\0" + u.files.join("\0")).split("\0").map((x) => x.trim()).filter((x) => x && !FP_SKIP.test(x)))];
        const over = new Map(), miss = [];
        for (const n of names) {
            const f = path.join(cwd, n);
            let st;
            try {
                st = fs.statSync(f);
            }
            catch {
                over.set(n, null);
                continue;
            }
            if (!st.isFile()) {
                over.set(n, null);
                continue;
            }
            const k = f + "|" + st.mtimeMs + "|" + st.size, c = fpHashes.get(k);
            if (c)
                over.set(n, c);
            else
                miss.push([n, k]);
        }
        if (miss.length) {
            const hs = await hashObjects(cwd, miss.map((x) => x[0]));
            if (!hs)
                return null;
            miss.forEach(([n, k], i) => {
                fpHashes.set(k, hs[i]);
                over.set(n, hs[i]);
            });
        }
        if (fpHashes.size > 5000)
            fpHashes.clear();
        const h = crypto.createHash("sha1");
        for (const n of [...new Set([...m.keys(), ...over.keys()])].sort()) {
            const v = over.has(n) ? over.get(n) : m.get(n);
            if (v)
                h.update(n + ":" + v + "\n");
        }
        const v = h.digest("hex").slice(0, 16);
        fpLast.set(cwd, { at: Date.now(), v });
        return v;
    }
    catch {
        return null;
    }
}

export const STAMPS_FILE = path.join(DATA, "build-stamps.json");
export const buildStampOf = (key) => S.buildStamps[key];

export const setBuildStamp = (key, v) => {
    S.buildStamps[key] = v;
    saveJson(STAMPS_FILE, S.buildStamps);
};

export function loadBuildStamps() {
    S.buildStamps = readJson(STAMPS_FILE, {}) || {};
}

// Области конфига: продуктовый код, сборка и зона каждой задачи. Тесты и документы продуктовым кодом не считаются.

/** Спеки и тесты: файлы *.spec/*.test, *_test.go, test_*.py, *_test.py и папки __tests__, tests/e2e. */
export const SPEC_RE = /(^|\/)__tests__\/|(^|\/)tests\/e2e\/|\.(spec|test)\.[cm]?[jt]sx?$|_test\.go$|(^|\/)test_[^/]*\.py$|_test\.py$/;
export const DOC_RE = /\.md$|^\.claude\/|^\.codex\/|^docs\//;
/** Спеки приёмки — по шаблону accept.specGlob; нет шаблона — таких спек нет. */
export const ACC_SPEC_RE = PROJECT.accept.specGlob ? globRe(PROJECT.accept.specGlob) : /(?!)/;

const AREAS = Object.values(PROJECT.areas);
const AREA_PATHS = AREAS.flatMap((a) => a.paths);
/** Продуктовый файл: в путях областей конфига (без областей — любой), не спека и не документ. */
export const isProduct = (f) => !SPEC_RE.test(f) && !DOC_RE.test(f) && !FP_SKIP.test(f) && (!AREA_PATHS.length || matchAny(f, AREA_PATHS));
export const productFiles = (files) => (files || []).filter(isProduct);
export const specOnlyOf = (touched, hasCode) => !!hasCode && (touched || []).length > 0 && touched.every((f) => SPEC_RE.test(f) || DOC_RE.test(f)) && touched.some((f) => SPEC_RE.test(f));

const BUILD_PATHS = AREAS.filter((a) => a.build).flatMap((a) => a.paths);
/** Файл, от которого зависит сборка: продуктовый код областей со сборкой. */
export const buildInput = (f) => BUILD_PATHS.length > 0 && !SPEC_RE.test(f) && !DOC_RE.test(f) && matchAny(f, BUILD_PATHS);
/** Задачи, которым нужна сборка этого же кода: задачи областей со сборкой. */
export const DIST_TASKS = new Set(AREAS.filter((a) => a.build).flatMap((a) => a.tasks));

/**
 * Зона задачи — файлы, правка которых старит её прогон. Задача области — пути её областей (с тестами);
 * гард — весь продуктовый код. Задача без зоны старится от любой правки.
 */
export const TASK_AREA = {};
for (const id of Object.keys(PROJECT.tasks)) {
    const own = AREAS.filter((a) => a.tasks.includes(id)).flatMap((a) => a.paths);
    if (own.length)
        TASK_AREA[id] = { test: (f) => matchAny(f, own) };
    else if (PROJECT.stations.guards.includes(id))
        TASK_AREA[id] = { test: isProduct };
}

export const snapCache = new Map();

export function areaFresh(j, t) {
    const re = TASK_AREA[j.task], c = re && j.snap && snapCache.get(t.path);
    if (!c || c.fp !== t.fp || !c.snap)
        return false;
    return [...new Set([...Object.keys(j.snap), ...Object.keys(c.snap)])].filter((f) => re.test(f)).every((f) => (j.snap[f] || "—") === (c.snap[f] || "—"));
}

export function jobFresh(j, t) {
    if (!j || j.status !== "ok")
        return "no";
    if (!j.fpStart || !j.fpEnd)
        return "unknown";
    if (j.fpStart !== j.fpEnd || j.fpEnd !== t.fp)
        return areaFresh(j, t) && j.fpStart === j.fpEnd ? "ok" : "stale";
    if (DIST_TASKS.has(j.task) && t.buildNeeded && !j.runOn && j.buildFp !== j.fpStart)
        return "nobuild";
    return "ok";
}
