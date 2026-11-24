// digest.mjs — выжимки больших текстов для агентов: лог прогона → итог, упавшие тесты и гарды с первой строкой причины,
// начало и конец; повторы схлопнуты со счётчиком. Плюс подсказка, как агенту достать полный текст. Чистые функции.
export const DIGEST_BUDGET = 2500;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const SEP = /^[\s─━═⎯=\-_~*]{8,}$/;
// Префиксы рабочих папок удалённых машин срезаются: путь от корня репозитория короче и совпадает с путём в слоте.
let dirPrefixes = [];
export const setDigestDirs = (dirs) => {
    dirPrefixes = (dirs || []).filter(Boolean).map((d) => String(d).split("\\").join("/").replace(/\/+$/, "") + "/");
};
const rel = (s) => {
    let t = String(s || "");
    for (const d of dirPrefixes)
        t = t.split(d).join("");
    return t;
};

const clip = (s, n) => {
    s = rel(s).replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

export function cleanLines(text) {
    return String(text || "").replace(ANSI, "").split("\n").map((l) => {
        l = l.replace(/\r+$/, "");
        const i = l.lastIndexOf("\r");
        return (i >= 0 ? l.slice(i + 1) : l).trimEnd();
    });
}

export function estTok(s) {
    s = String(s || "");
    let cyr = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0x400 && c <= 0x4ff)
            cyr++;
    }
    return Math.ceil(cyr / 2.6 + (s.length - cyr) / 3.6);
}

export function logKind(lines) {
    const t = lines.join("\n");
    if (/ВЕРДИКТ:\s*\**\s*(ЗА|ВОПРОСЫ|ПРОТИВ)|claude -p … \(ревьюер/.test(t))
        return "review";
    if (/^Running \d+ tests? using \d+ worker/m.test(t) || /^\s+\d+\) \[[\w-]+\] › /m.test(t))
        return "playwright";
    if (/^\s*Test Files\s+\d/m.test(t) || /^\s*FAIL\s+\S+\.(?:spec|test)\.[cm]?[jt]sx?\s+>/m.test(t))
        return "vitest";
    if (/^\s*●\s|^Tests:\s+\d|^Test Suites:\s+\d/m.test(t))
        return "jest";
    if (/^--- FAIL: \S+|^(?:ok|FAIL)\s+\S+\s+[\d.]+s$/m.test(t))
        return "go-test";
    if (/^=+ (?:FAILURES|short test summary info) =+$|^=+ .*\b(?:passed|failed)\b.* in [\d.]+s/m.test(t))
        return "pytest";
    if (/^ИТОГ: выполнено/m.test(t))
        return "slot-up";
    if (/error TS\d{3,5}:/.test(t))
        return "tsc";
    return "generic";
}

const SPEC_AT = /([\w@./\\[\]-]+\.(?:spec|test)\.[cm]?[jt]sx?):(\d+)(?::\d+)?/;

function jestFails(L) {
    const out = [];
    for (let i = 0; i < L.length; i++) {
        const m = /^\s*●\s+(.*)$/.exec(L[i]);
        if (!m || /^Console\b/.test(m[1]))
            continue;
        const what = m[1].replace(/^›\s*/, "").trim();
        let why = "", where = "", j = i + 1;
        for (; j < L.length && j < i + 60; j++) {
            const l = L[j];
            if (/^\s*●\s/.test(l) || /^(FAIL|PASS)\s/.test(l) || SEP.test(l))
                break;
            if (!why && l.trim() && !/^\s*at\s/.test(l)) {
                why = l.trim();
                const nx = (L[j + 1] || "").trim() ? "" : (L[j + 2] || "").trim();
                if (/^(Expected|Received|Received array|Expected value)/.test(nx))
                    why += " · " + nx;
            }
            if (!where) {
                const w = /^\s*at\s.*?\(?([^()\s]+\.(?:spec|test)\.[cm]?[jt]sx?:\d+(?::\d+)?)\)?/.exec(l) || /^\s*>\s*(\d+)\s*\|/.exec(l);
                if (w && w[1] && /\D/.test(w[1]))
                    where = w[1];
            }
        }
        out.push({ what: what === "Test suite failed to run" ? "сьют не запустился" : what, why, where });
    }
    if (!out.length)
        for (let i = 0; i < L.length; i++) {
            const m = /^\s*[✗✕]\s+(.*)$/.exec(L[i]);
            if (m)
                out.push({ what: m[1].trim(), why: (L[i + 1] || "").trim(), where: "" });
        }
    const files = [...new Set(L.map((l) => (/^\s*FAIL\s+(\S+\.(?:spec|test)\.[cm]?[jt]sx?)/.exec(l) || [])[1]).filter(Boolean))];
    if (files.length === 1)
        for (const f of out)
            if (!f.where)
                f.where = files[0];
    return { fails: out, files };
}

function vitestFails(L) {
    const out = [];
    for (let i = 0; i < L.length; i++) {
        const m = /^\s*FAIL\s+(\S+\.(?:spec|test)\.[cm]?[jt]sx?)\s+(?:>\s+(.*)|\[.*\])\s*$/.exec(L[i]);
        if (!m)
            continue;
        let why = "", where = "";
        for (let j = i + 1; j < L.length && j < i + 40; j++) {
            const l = L[j];
            if (/^\s*FAIL\s/.test(l) || /⎯{3,}/.test(l))
                break;
            if (!why && /^\s*\S/.test(l) && !/^\s*❯/.test(l))
                why = l.trim();
            const w = /❯\s+(\S+\.(?:spec|test)\.[cm]?[jt]sx?:\d+:\d+)/.exec(l);
            if (w && !where)
                where = w[1];
        }
        out.push({ what: m[2] ? m[2].trim() : "файл не запустился", why, where: where || m[1] });
    }
    const files = [...new Set(out.map((f) => f.where.split(":")[0]))];
    return { fails: out, files };
}

const pwPath = (p) => String(p || "").replace(/\\/g, "/");

function playwrightFails(L) {
    const out = [];
    for (let i = 0; i < L.length; i++) {
        const m = /^\s+\d+\)\s+\[([\w-]+)\]\s+›\s+(\S+?:\d+:\d+)\s+›\s+(.*?)\s*$/.exec(L[i]);
        if (!m)
            continue;
        let why = "", loc = "", ctx = "";
        for (let j = i + 1; j < L.length && j < i + 80; j++) {
            const l = L[j];
            if (/^\s+\d+\)\s+\[/.test(l) || /^\s+\d+ (failed|passed|flaky|skipped)/.test(l))
                break;
            if (!why && /^\s*(\w*Error|expect\(|Test timeout)/.test(l))
                why = l.trim();
            if (!loc && /^\s*Locator:/.test(l))
                loc = l.trim();
            const c = /Error Context:\s*(.+)$/.exec(l);
            if (c && !ctx)
                ctx = pwPath(c[1].trim());
        }
        out.push({ what: "[" + m[1] + "] " + m[3], why: [why, loc].filter(Boolean).join(" · "), where: pwPath(m[2]), ctx });
    }
    const dirs = [...new Set(out.map((f) => f.ctx).filter(Boolean).map((c) => c.replace(/\/[^/]+\/error-context\.md$/, "")))];
    return { fails: out, files: [...new Set(out.map((f) => f.where.split(":")[0]))], note: dirs.length === 1 ? "Снимок страницы упавшего теста: " + dirs[0] + "/<папка теста>/error-context.md" : dirs.length ? "Снимки страниц: " + out.filter((f) => f.ctx).map((f) => f.ctx).slice(0, 3).join(", ") : "" };
}

function goFails(L) {
    const out = [];
    for (let i = 0; i < L.length; i++) {
        const m = /^\s*--- FAIL:\s+(\S+)/.exec(L[i]);
        if (!m)
            continue;
        let why = "", where = "";
        // вывод теста go печатает до строки «--- FAIL», после «=== RUN» этого теста
        let from = i - 1;
        while (from > 0 && i - from < 60 && !/^=== (RUN|CONT|PAUSE)|^\s*--- (FAIL|PASS|SKIP)/.test(L[from]))
            from--;
        for (let j = from + 1; j < i; j++) {
            const l = L[j];
            const w = /^\s+([\w./-]+_test\.go:\d+):\s*(.*)$/.exec(l);
            if (w && !where) {
                where = w[1];
                why = w[2].trim();
            }
        }
        out.push({ what: m[1], why, where });
    }
    const pk = [...new Set(L.map((l) => (/^FAIL\s+(\S+)\s+(?:[\d.]+s|\[)/.exec(l) || [])[1]).filter(Boolean))];
    if (!out.length)
        for (const p of pk)
            out.push({ what: p, why: "пакет не прошёл (сборка или тесты)", where: "" });
    return { fails: out, files: pk };
}

function pytestFails(L) {
    const out = [];
    for (const l of L) {
        const m = /^(?:FAILED|ERROR)\s+(\S+?)(?:\s+-\s+(.*))?$/.exec(l);
        if (m)
            out.push({ what: m[1], why: (m[2] || "").trim(), where: m[1].split("::")[0] });
    }
    return { fails: out, files: [...new Set(out.map((f) => f.where))] };
}

function tscFails(L) {
    const by = new Map();
    for (const l of L) {
        const m = /^(\S.*?)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(l);
        if (!m)
            continue;
        const k = m[3] + " " + m[4];
        const g = by.get(k) || { what: m[3], why: m[4], where: m[1] + ":" + m[2], n: 0, files: [] };
        g.n++;
        g.files.push(m[1]);
        by.set(k, g);
    }
    const fails = [...by.values()].map((g) => ({ what: g.what + (g.n > 1 ? " ×" + g.n : ""), why: g.why, where: g.where + (g.n > 1 ? " (+" + (g.n - 1) + " мест)" : "") }));
    return { fails, files: [...new Set([...by.values()].flatMap((g) => g.files))] };
}

const FAIL_GENERIC = /(^\s*FAIL\s|✗|✖|\bAssertionError\b|\bTypeError\b|\bReferenceError\b|^\s*Error:|^error:|НОВЫЕ ошибки|Cannot find module|ERR_\w+)/;

function genericFails(L) {
    const out = [], seen = new Set();
    for (let i = 0; i < L.length && out.length < 12; i++) {
        const l = L[i];
        if (!FAIL_GENERIC.test(l) || /^\s*[-•]?\s*✗ красных пунктов|ELIFECYCLE/.test(l))
            continue;
        const k = normLine(l);
        if (seen.has(k))
            continue;
        seen.add(k);
        const nx = (L[i + 1] || "").trim();
        out.push({ what: l.trim().replace(/^[✗✖]\s*/, ""), why: nx && !FAIL_GENERIC.test(nx) && !/^──/.test(nx) ? nx : "", where: (SPEC_AT.exec(l) || [])[0] || "" });
    }
    return { fails: out, files: [] };
}

function mergeFails(fails) {
    const by = new Map();
    for (const f of fails) {
        const g = by.get(f.what);
        if (!g)
            by.set(f.what, { ...f, whys: f.why ? [f.why] : [] });
        else {
            if (f.why)
                g.whys.push(f.why);
            if (!g.where)
                g.where = f.where;
        }
    }
    return [...by.values()].map(({ whys, ...f }) => ({ ...f, why: collapse(whys).join(" · ") }));
}

export function failsOf(lines, kind = logKind(lines)) {
    const last = [...lines].reverse().find((l) => /^── [a-zа-яё]+ \(код/i.test(l)) || "";
    if (/^── ok \(код 0\)/.test(last))
        return { fails: [], files: [] };
    const f = { jest: jestFails, vitest: vitestFails, playwright: playwrightFails, "go-test": goFails, pytest: pytestFails, tsc: tscFails }[kind];
    const r = f ? f(lines) : { fails: [], files: [] };
    return r.fails.length ? { ...r, fails: mergeFails(r.fails) } : genericFails(lines);
}

export const ENV_CAUSES = [
    ["disk", /ENOSPC|no space left on device|inode/i, "нет места или inode на диске"],
    ["git-push", /unable to create temporary object directory|unpacker error|remote rejected|снимок не отправился/i, "снимок кода не принят удалённой машиной"],
    ["snapshot", /✗ снимок:|снимок на машине не снят/i, "снимок рабочего дерева не снят"],
    ["oom", /JavaScript heap out of memory|FATAL ERROR:.*heap|exit code 137|\bOOM\b/i, "нехватка памяти"],
    ["killed", /\bKilled\b|SIGKILL|снято по времени|timed out after|Exceeded timeout of/i, "снято по времени или убито"],
    ["network", /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|Could not resolve host|getaddrinfo/i, "сеть или служба недоступна"],
    ["pkg-missing", /Cannot find module '([^']+)'|ModuleNotFoundError: No module named/, "модуль или пакет не собран или не подключён"],
    ["pkg-manager", /ERR_PNPM_\w+|npm ERR!|yarn error/, "менеджер пакетов"],
    ["perm", /EACCES|EPERM|Permission denied/i, "нет прав на файл"],
    ["db", /could not connect to server|database "[^"]+" does not exist|too many clients/i, "база для тестов"],
    ["dirty-tree", /✖ дерево — \d+ изменённых/, "в папке слота незакоммиченные правки"],
    ["no-specs", /совпало имён 0 из|No tests found|нет тестов/i, "фильтр не нашёл ни одной спеки"],
];

export function envCauses(lines) {
    const out = [];
    for (const [key, re, label] of ENV_CAUSES) {
        const l = lines.find((x) => re.test(x));
        if (l)
            out.push({ key, label, line: clip(l, 220) });
    }
    return out;
}

export const normLine = (l) => String(l).trim().replace(/\b[0-9a-f]{7,40}\b/gi, "#").replace(/\d+([.,]\d+)?/g, "0").replace(/\s+/g, " ");

export function collapse(lines) {
    const out = [], idx = new Map();
    for (const l of lines) {
        const k = normLine(l);
        if (!k)
            continue;
        const i = idx.get(k);
        if (i == null) {
            idx.set(k, out.length);
            out.push({ l, n: 1 });
        }
        else
            out[i].n++;
    }
    return out.map((x) => x.n > 1 ? x.l + "  (×" + x.n + ")" : x.l);
}

const TOTAL_RE = /^\s*(сьюты|тесты|проверки):\s|^\s*Test Files\s+\d|^\s*Tests:?\s+\d|^\s*\d+ (failed|passed|flaky|skipped|did not run)\b|^итог:|^ИТОГ:|^=+ .*\b(?:passed|failed)\b.* in [\d.]+s|^(?:ok|FAIL)\s+\S+\s+[\d.]+s$|^── [a-zа-яё]+ \(код/i;

export function totalsOf(lines) {
    const hits = lines.filter((l) => TOTAL_RE.test(l)).map((l) => clip(l.replace(/^[─\s]+|[─\s]+$/g, ""), 160));
    return [...new Set(hits)].slice(-8);
}

const GREP_HINT = { jest: "●|^FAIL", vitest: "FAIL|Error", playwright: "Error|\\) \\[", "go-test": "--- FAIL|^FAIL", pytest: "^FAILED|^ERROR|^E ", tsc: "error TS", "slot-up": "✖|ИТОГ", review: "^- |ВЕРДИКТ", generic: "FAIL|Error|✗|✖" };

export function handleLine({ id, lines = 0, kind = "generic", logFile = "", cli = "" }) {
    const g = GREP_HINT[kind] || GREP_HINT.generic;
    return "⤷ Полный лог " + id + " (" + lines + " стр.): " + logFile + " — кусок: node " + cli + " " + id + " --grep '" + g + "' --ctx 3 (ещё --from N --max 6000)";
}

function commonSuite(names) {
    if (names.length < 2)
        return "";
    const sep = names.every((n) => n.includes(" › ")) ? " › " : " > ", parts = names.map((n) => n.split(sep)), first = parts[0];
    let k = 0;
    while (k < first.length - 1 && parts.every((p) => p.length > k + 1 && p[k] === first[k]))
        k++;
    return k ? first.slice(0, k).join(sep) : "";
}

const RUNNER_KINDS = new Set(["jest", "vitest", "playwright", "go-test", "pytest", "tsc"]);

export function digestLog(text, { budget = DIGEST_BUDGET, handle = "" } = {}) {
    const L = cleanLines(text), kind = logKind(L), raw = String(text || "").length;
    if (kind === "review" && L.some((l) => /ВЕРДИКТ:/.test(l))) {
        const r = digestReview(text, { budget, handle: typeof handle === "function" ? handle(kind, L.length) : handle });
        return { text: r.text, kind, fails: [], files: [], env: [], totals: [], lines: L.length, raw };
    }
    const { fails, files, note } = failsOf(L, kind), totals = totalsOf(L);
    const failText = fails.map((f) => f.what + " " + f.why).join("\n");
    const env = envCauses(L).filter((e, i, a) => a.findIndex((x) => x.line === e.line) === i);
    const nonEmpty = L.filter((l) => l.trim() && !SEP.test(l));
    const head = collapse(nonEmpty.filter((l) => /^(\$ |\[[\w.-]+\] |спеки|шаблон:)/.test(l)).slice(0, 4));
    const tail = collapse(nonEmpty.slice(-8)).filter((l) => !totals.some((t) => clip(l, 400).includes(t.slice(0, 40))) && !failText.includes(clip(l, 400).slice(0, 60)));
    const h = typeof handle === "function" ? handle(kind, L.length) : handle;
    const room = Math.max(400, budget - (h ? h.length + 1 : 0));
    const parts = [], used = () => parts.reduce((n, s) => n + s.length + 1, 0), add = (s) => {
        if (s && used() + s.length + 1 <= room) {
            parts.push(s);
            return true;
        }
        return false;
    };
    add("Итог: " + (totals.length ? totals.join(" · ") : "строк чисел в логе нет") + " [" + kind + ", " + L.length + " стр.]");
    if (fails.length) {
        const suite = commonSuite(fails.map((f) => f.what)), file = files.length === 1 ? files[0] : "";
        add("Упало (" + fails.length + ")" + (suite ? " в «" + clip(suite, 160) + "»" : "") + (file ? ", " + clip(file, 160) : "") + ":");
        let shown = 0;
        for (const f of fails) {
            const what = suite ? f.what.slice(suite.length).replace(/^\s*[›>]\s*/, "") : f.what, where = file && f.where.startsWith(file) ? f.where.slice(file.length).replace(/^:/, "строка ") : f.where;
            if (!add("- " + clip(what, 200) + (f.why ? " — " + clip(f.why, 260) : "") + (where ? " @ " + clip(where, 200) : "")))
                break;
            shown++;
        }
        if (shown < fails.length)
            parts.push("… ещё " + (fails.length - shown) + " — в полном логе");
        if (note)
            parts.push(note);
    }
    const envNew = env.filter((e) => !failText.includes(e.line.slice(0, 50)));
    if (env.length)
        add("Окружение: " + env.map((e) => e.label + (envNew.includes(e) ? " («" + clip(e.line, 140) + "»)" : "")).join("; "));
    if (!fails.length && head.length && (env.length || !totals.length))
        add("Начало: " + head.map((l) => clip(l, 200)).join(" | "));
    if (!(fails.length && RUNNER_KINDS.has(kind)) && (fails.length || env.length || !totals.length) && tail.length)
        add("Конец:\n" + tail.map((l) => "  " + clip(l, 220)).join("\n"));
    if (h)
        parts.push(h);
    return { text: parts.join("\n"), kind, fails, files, env, totals, lines: L.length, raw };
}

export function digestReview(text, { budget = 3000, handle = "" } = {}) {
    const L = cleanLines(text), out = [], room = Math.max(600, budget - (handle ? handle.length + 1 : 0));
    const vi = L.findIndex((l) => /ВЕРДИКТ:/.test(l)), body = vi >= 0 ? L.slice(vi) : L;
    let n = 0, inNotes = false, cut = 0;
    const size = () => out.reduce((k, s) => k + s.length + 1, 0);
    for (const l of body) {
        if (!l.trim() || /^── (ok|fail)/.test(l))
            continue;
        if (/^Заметки/.test(l)) {
            inNotes = true;
            out.push(l.trim());
            continue;
        }
        const isPt = /^\s*(-|\d+[.)])\s/.test(l), s = isPt ? clip(l, inNotes ? 200 : 900) : clip(l, 300);
        if (!isPt && n > 0 && !inNotes)
            continue;
        if (size() + s.length + 1 > room) {
            cut++;
            continue;
        }
        out.push(s);
        if (isPt && !inNotes)
            n++;
    }
    if (cut)
        out.push("… ещё " + cut + " строк(и) ревью — в полном тексте");
    if (handle)
        out.push(handle);
    return { text: out.join("\n"), points: n, raw: String(text || "").length };
}

export function digestDiff(patch, { budget = 4000, more = "" } = {}) {
    const files = String(patch || "").split(/^(?=diff --git )/m).filter((x) => x.startsWith("diff --git"));
    if (!files.length)
        return String(patch || "").slice(0, budget);
    if (patch.length <= budget)
        return patch;
    const share = Math.max(300, Math.floor((budget - more.length) / files.length)), out = [];
    let left = budget - more.length;
    for (const f of files) {
        const name = (/^diff --git a\/(\S+)/.exec(f) || [])[1] || "?", body = f.split("\n").filter((l) => /^(@@|[+-])/.test(l) && !/^(\+\+\+|---) /.test(l));
        const add = body.filter((l) => l[0] === "+").length, del = body.filter((l) => l[0] === "-").length;
        let s = "▸ " + name + " (+" + add + " −" + del + ")\n", i = 0;
        for (; i < body.length && s.length + body[i].length + 1 <= share; i++)
            s += body[i].slice(0, 200) + "\n";
        if (i < body.length)
            s += "  … ещё " + (body.length - i) + " строк диффа этого файла\n";
        if (s.length > left) {
            out.push("… файлов не показано: " + (files.length - out.length));
            break;
        }
        out.push(s.trimEnd());
        left -= s.length;
    }
    return out.join("\n") + (more ? "\n" + more : "");
}

export function sliceLog(text, { from = 1, to = 0, grep = "", ctx = 2, max = 6000 } = {}) {
    const L = cleanLines(text), n = L.length;
    let pick = [];
    if (grep) {
        let re;
        try {
            re = new RegExp(grep, "i");
        }
        catch {
            re = new RegExp(grep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        }
        const want = new Set();
        for (let i = Math.max(0, from - 1); i < (to ? Math.min(n, to) : n); i++)
            if (re.test(L[i]))
                for (let k = Math.max(0, i - ctx); k <= Math.min(n - 1, i + ctx); k++)
                    want.add(k);
        pick = [...want].sort((a, b) => a - b);
    }
    else
        for (let i = Math.max(0, from - 1); i < (to ? Math.min(n, to) : n); i++)
            pick.push(i);
    const out = [];
    let size = 0, prev = -2, last = -1;
    for (const i of pick) {
        const s = (i !== prev + 1 && out.length ? "…\n" : "") + (i + 1) + ": " + L[i];
        if (size + s.length + 1 > max) {
            out.push("… обрезано по --max " + max + ": дальше — --from " + (i + 1));
            break;
        }
        out.push(s);
        size += s.length + 1;
        prev = i;
        last = i;
    }
    return { text: out.join("\n") || "(ничего не нашлось: строк в логе " + n + ")", lines: n, next: last >= 0 && last + 1 < n ? last + 2 : 0 };
}
