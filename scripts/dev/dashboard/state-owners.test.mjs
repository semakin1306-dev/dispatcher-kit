// Владельцы полей общего состояния S (state.mjs): только модуль-владелец пишет поле (S.x = …, S.x.push(…), delete S.x[k]…),
// остальные читают через его функции. Храповик READ_ALLOW — допуск прямых чтений чужого поля, только вниз. Новое поле —
// объявить в state.mjs и вписать владельца в OWNERS. Опись: node scripts/dev/dashboard/state-owners.test.mjs --print
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { S } from "./state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const OWNERS = {
    jobs: "jobs", seq: "jobs",
    snap: "snapshot", rebuilding: "snapshot", syncing: "snapshot",
    inbox: "inbox",
    memCache: "monitor", prevCpu: "monitor", sysNow: "monitor", topProcs: "monitor", stackNow: "monitor",
    procList: "monitor", cpuTop: "monitor", cpuTasks: "monitor", slotUsage: "monitor",
    EPICS: "trees", EPIC: "trees", epicsCache: "trees",
    agentSessions: "agents", orchHeld: "agents",
    mergeWait: "merge-wait",
    ganttEvents: "gantt",
    drainMode: "epics", autoSyncAt: "epics", syncMarks: "epics",
    manual: "stations", summaries: "stations",
    stgSpecCache: "regress", stgRed: "regress", specHist: "regress", specHistTimer: "regress",
    STG_TREE: "git", gitActive: "git",
    checklists: "accept", acc: "accept", autoCloseAt: "accept", accSyncedAt: "accept", reminders: "accept",
    orderDismissed: "pipeline", train: "pipeline",
    orchLog: "orchlog",
    relayFactsTimer: "relay", relaySent: "relay", testReqs: "relay", presetsExtra: "relay",
    buildStamps: "fingerprint",
    stateVer: "events", stateWhy: "events",
    reviewNotes: "review",
    trains: "trains",
    slotDone: "slot-done",
    retro: "retro",
    saveTimer: "runner",
    server: "boot", epicMtime: "boot",
    backlog: "backlog",
    tg: "tg",
};

export const READ_ALLOW = {};

export function codeOnly(src) {
    let out = "", i = 0, prevSig = "";
    const n = src.length, stack = [], blank = (s) => s.replace(/[^\n]/g, " ");
    while (i < n) {
        const c = src[i], d = src[i + 1];
        if (c === "/" && d === "/") {
            const e = src.indexOf("\n", i), j = e < 0 ? n : e;
            out += blank(src.slice(i, j));
            i = j;
            continue;
        }
        if (c === "/" && d === "*") {
            const e = src.indexOf("*/", i + 2), j = e < 0 ? n : e + 2;
            out += blank(src.slice(i, j));
            i = j;
            continue;
        }
        if (c === '"' || c === "'") {
            let j = i + 1;
            while (j < n && src[j] !== c && src[j] !== "\n") {
                if (src[j] === "\\")
                    j++;
                j++;
            }
            out += c + blank(src.slice(i + 1, j)) + (src[j] === c ? c : "");
            i = src[j] === c ? j + 1 : j;
            prevSig = c;
            continue;
        }
        if (c === "`" || (c === "}" && stack.length && stack[stack.length - 1] === 0)) {
            if (c === "}")
                stack.pop();
            let j = i + 1, lit = c;
            while (j < n) {
                if (src[j] === "\\") {
                    lit += "  ";
                    j += 2;
                    continue;
                }
                if (src[j] === "`") {
                    lit += "`";
                    j++;
                    break;
                }
                if (src[j] === "$" && src[j + 1] === "{") {
                    lit += "${";
                    j += 2;
                    stack.push(0);
                    break;
                }
                lit += src[j] === "\n" ? "\n" : " ";
                j++;
            }
            out += lit;
            i = j;
            prevSig = "`";
            continue;
        }
        if (c === "/" && (prevSig === "" || "(,=:[!&|?{};+-*%<>~^".includes(prevSig) || /\b(return|typeof|case|in|of|delete|void|throw|new)\s*$/.test(out.slice(-12)))) {
            let j = i + 1, cls = false;
            while (j < n && src[j] !== "\n") {
                if (src[j] === "\\") {
                    j += 2;
                    continue;
                }
                if (src[j] === "[")
                    cls = true;
                else if (src[j] === "]")
                    cls = false;
                else if (src[j] === "/" && !cls)
                    break;
                j++;
            }
            out += "/" + blank(src.slice(i + 1, j)) + "/";
            i = j + 1;
            prevSig = "/";
            continue;
        }
        if (stack.length) {
            if (c === "{")
                stack[stack.length - 1]++;
            else if (c === "}")
                stack[stack.length - 1]--;
        }
        out += c;
        if (!/\s/.test(c))
            prevSig = c;
        i++;
    }
    return out;
}

const ASSIGN = /^\s*(?:=(?![=>])|[-+*/%&|^]=|\*\*=|<<=|>>>?=|\|\|=|&&=|\?\?=|\+\+|--)/;
const MUT_CALL = /^\s*\.(?:push|pop|shift|unshift|splice|sort|reverse|fill|set|delete|clear|add)\s*\(/;

function tailOf(code, k) {
    for (;;) {
        if (MUT_CALL.test(code.slice(k)))
            return { k, mutCall: true };
        const m = /^(?:\?\.|\.)[A-Za-z_$][\w$]*/.exec(code.slice(k));
        if (m) {
            k += m[0].length;
            continue;
        }
        if (code[k] === "[" || code.startsWith("?.[", k)) {
            let depth = 0, p = k;
            for (; p < code.length; p++) {
                if (code[p] === "[")
                    depth++;
                else if (code[p] === "]" && !--depth)
                    break;
            }
            k = p + 1;
            continue;
        }
        return { k, mutCall: false };
    }
}

export function scanState(src) {
    const code = codeOnly(src), hits = [], bare = [];
    const lineOf = (at) => code.slice(0, at).split("\n").length;
    const re = /(?<![\w$])(?<![^.]\.)S\.([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(code))) {
        const at = m.index, end = at + m[0].length, before = code.slice(Math.max(0, at - 8), at), rest = code.slice(end);
        const { k, mutCall } = tailOf(code, end), pre = /(\+\+|--)\s*$/.test(before) || /\bdelete\s+$/.test(before);
        let kind = "read";
        if (!mutCall && k === end && (ASSIGN.test(rest) || pre))
            kind = "write";
        else if (mutCall || (k > end && (ASSIGN.test(code.slice(k)) || pre)) || /Object\.assign\(\s*$/.test(code.slice(Math.max(0, at - 20), at)))
            kind = "mutate";
        hits.push({ field: m[1], line: lineOf(at), kind });
    }
    const bareRe = /(?<![\w$.])S(?![\w$]|\s*\.\s*[A-Za-z_$])/g;
    const noImport = code.replace(/^import \{ S \} from " *"/m, "");
    while ((m = bareRe.exec(noImport)))
        bare.push(lineOf(m.index));
    return { hits, bare };
}

export function inventory(dir = HERE) {
    const rows = [];
    for (const f of readdirSync(dir).sort()) {
        if (!f.endsWith(".mjs") || f.endsWith(".test.mjs") || f === "state.mjs")
            continue;
        const src = readFileSync(join(dir, f), "utf8");
        if (!/\bS\b/.test(src))
            continue;
        const { hits, bare } = scanState(src), mod = f.replace(/\.mjs$/, "");
        for (const h of hits)
            rows.push({ mod, ...h });
        for (const line of bare)
            rows.push({ mod, field: "", line, kind: "bare" });
    }
    return rows;
}

function foreign(rows) {
    const reads = {}, writes = [], unknown = [], bare = [];
    for (const r of rows) {
        if (r.kind === "bare") {
            bare.push(r.mod + ".mjs:" + r.line);
            continue;
        }
        const o = OWNERS[r.field];
        if (!o) {
            unknown.push(r.mod + ".mjs:" + r.line + " S." + r.field);
            continue;
        }
        if (o === r.mod)
            continue;
        if (r.kind === "read") {
            const k = r.mod + "→" + r.field;
            (reads[k] ||= []).push(r.line);
        }
        else
            writes.push(r.mod + ".mjs:" + r.line + " S." + r.field + " (" + r.kind + ", владелец " + o + ".mjs)");
    }
    return { reads, writes, unknown, bare };
}

test("у каждого поля S (state.mjs) есть владелец, и владельцы — только поля S", () => {
    const fields = Object.keys(S);
    assert.deepEqual(fields.filter((f) => !OWNERS[f]), [], "поля без владельца: вписать в OWNERS");
    assert.deepEqual(Object.keys(OWNERS).filter((f) => !fields.includes(f)), [], "в OWNERS поля, которых нет в state.mjs");
    for (const m of new Set(Object.values(OWNERS)))
        assert.ok(readdirSync(HERE).includes(m + ".mjs"), "владелец " + m + ".mjs — нет такого модуля");
});

test("в чужое поле S модули не пишут; поля — только объявленные в state.mjs; S — только как S.поле", () => {
    const rows = inventory();
    assert.ok(rows.length > 50, "опись не собралась: обращений " + rows.length);
    const { writes, unknown, bare } = foreign(rows);
    assert.deepEqual(unknown, [], "поля нет в state.mjs (объявить и назначить владельца)");
    assert.deepEqual(writes, [], "запись в чужое поле S — через действие модуля-владельца");
    assert.deepEqual(bare, [], "S не как S.поле (S[x], разбор, передача) — владельца не проверить");
});

test("чтения чужих полей S — не больше допуска READ_ALLOW (храповик: допуск только вниз)", () => {
    const { reads } = foreign(inventory());
    const over = [], under = [];
    for (const [k, lines] of Object.entries(reads))
        if (lines.length > (READ_ALLOW[k] || 0))
            over.push(k + ": " + lines.length + " (допуск " + (READ_ALLOW[k] || 0) + "), строки " + lines.join(","));
    for (const [k, n] of Object.entries(READ_ALLOW))
        if ((reads[k] || []).length < n)
            under.push(k + ": " + (reads[k] || []).length + " < допуска " + n);
    assert.deepEqual(over, [], "прямое чтение чужого поля S — через функцию модуля-владельца (jobList(), snapNow()…)");
    assert.deepEqual(under, [], "чтений стало меньше — опустите READ_ALLOW до нового числа");
});

test("разбор: комментарии и строки не в счёт, ${…} и разворот — в счёт; запись, правка внутри и чтение различаются", () => {
    const src = [
        "// S.jobs = []", "const t = `${S.snap.at} S.inbox`, s = 'S.acc'", "S.train = null", "S.manual[k] = 1", "S.inbox.push(x)",
        "const a = [...S.jobs]", "if (S.x === 1) S.y++", "delete S.acc[k]", "x.S.z = 1", "const re = /S.q/; f(S)",
    ].join("\n");
    const { hits, bare } = scanState(src);
    assert.deepEqual(
        hits.map((h) => h.field + ":" + h.kind + ":" + h.line),
        [
            "snap:read:2",
            "train:write:3",
            "manual:mutate:4",
            "inbox:mutate:5",
            "jobs:read:6",
            "x:read:7",
            "y:write:7",
            "acc:mutate:8",
        ],
    );
    assert.deepEqual(bare, [10]);
});

if (process.argv.includes("--print")) {
    const rows = inventory(), by = {};
    for (const r of rows)
        if (r.field)
            ((by[r.field] ||= {})[r.mod] ||= []).push(r.line + (r.kind === "read" ? "" : r.kind === "write" ? "w" : "m"));
    const f = foreign(rows);
    console.log(
        "обращений к S: " +
            rows.length +
            "; чужих чтений: " +
            Object.values(f.reads).reduce((a, l) => a + l.length, 0) +
            ", чужих записей: " +
            f.writes.length +
            ", полей без объявления: " +
            f.unknown.length,
    );
    console.log("поле | владелец | кто обращается (модуль:строки; w — запись, m — правка внутри)");
    for (const fld of Object.keys(S))
        console.log(fld + " | " + (OWNERS[fld] || "?") + " | " + Object.entries(by[fld] || {}).map(([m, l]) => (m === OWNERS[fld] ? "*" : "") + m + ":" + l.join(",")).join("; "));
}
