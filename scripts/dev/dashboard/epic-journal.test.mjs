import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EPIC_FIELDS, GLOBAL_EVENTS, brief, eventEpic, journalCounts, journalLine, journalOf } from "./epic-journal.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function argsAt(src, i) {
    let depth = 0, q = null, start = i + 1, out = [];
    for (let j = i; j < src.length; j++) {
        const c = src[j];
        if (q) {
            if (c === "\\") {
                j++;
                continue;
            }
            if (c === q)
                q = null;
            continue;
        }
        if (c === '"' || c === "'" || c === "`") {
            q = c;
            continue;
        }
        if ("([{".includes(c))
            depth++;
        else if (")]}".includes(c)) {
            depth--;
            if (depth === 0) {
                out.push(src.slice(start, j));
                return out.map((s) => s.trim());
            }
        }
        else if (c === "," && depth === 1) {
            out.push(src.slice(start, j));
            start = j + 1;
        }
    }
    return out;
}

function calls() {
    const files = [...fs.readdirSync(HERE).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs")).map((f) => path.join(HERE, f)),
        ...fs.readdirSync(path.join(HERE, "..")).filter((f) => f.endsWith(".mjs")).map((f) => path.join(HERE, "..", f))];
    const out = [];
    for (const f of files) {
        const src = fs.readFileSync(f, "utf8");
        for (const m of src.matchAll(/\blogEvent\(/g)) {
            if (/function\s+$/.test(src.slice(Math.max(0, m.index - 10), m.index)))
                continue;
            const [a0 = "", a1 = ""] = argsAt(src, m.index + m[0].length - 1);
            const types = [...a0.matchAll(/"([\w.-]+)"/g)].map((x) => x[1]);
            const line = src.slice(0, m.index).split("\n").length;
            out.push({ file: path.basename(f), line, types, data: a1 });
        }
    }
    return out;
}

const hasEpicKey = (data) => EPIC_FIELDS.some((k) => new RegExp("(^|[{,\\s])" + k + "\\s*(:|,|\\})").test(data));

test("храповик: каждый logEvent — с ключом слота/агента (поле epic) или общий с причиной", () => {
    const cs = calls();
    assert.ok(cs.length > 80, "вызовов нашлось " + cs.length);
    const DYNAMIC_OK = { "shard.mjs": 1 }, dyn = {};
    const bad = cs.filter((c) => {
        if (hasEpicKey(c.data) || (c.types.length && c.types.every((t) => GLOBAL_EVENTS.has(t))))
            return false;
        if (!c.types.length && (dyn[c.file] = (dyn[c.file] || 0) + 1) <= (DYNAMIC_OK[c.file] || 0))
            return false;
        return true;
    });
    assert.deepEqual(bad.map((c) => c.file + ":" + c.line + " " + c.types.join("|")), [], "logEvent без ключа эпика: добавь tree/key/epic или впиши тип в GLOBAL_EVENTS с причиной");
});

test("храповик: команды оркестратора (cmdEnd) и сообщения агентам (deliver) — в журнале", () => {
    // код разложен по строкам: событие orch.command должно идти в той же ветке — не дальше нескольких строк после cmdEnd
    const relay = fs.readFileSync(path.join(HERE, "relay.mjs"), "utf8").split("\n");
    const ends = relay.map((l, i) => [l, i]).filter(([l]) => /\bcmdEnd\(/.test(l) && !/^import/.test(l) && !/function cmdEnd|const cmdEnd/.test(l));
    assert.ok(ends.length >= 5);
    for (const [l, i] of ends)
        assert.match(relay.slice(i, i + 6).join("\n"), /logEvent\("orch\.command"/, "cmdEnd без события orch.command: " + l.trim().slice(0, 120));
    const ag = fs.readFileSync(path.join(HERE, "agents.mjs"), "utf8"), d = /export function deliver\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(ag);
    assert.ok(d && /logEvent\("agent\.message"/.test(d[0]), "deliver пишет agent.message (кто, кому, длина, суть)");
});

test("eventEpic: поле epic, ключ слота, оркестратор; общее — null", () => {
    const of = (k) => ({ "wv1-a": "ep1", "orchestrator@ep2": "ep2" })[k] || null;
    assert.equal(eventEpic({ epic: "x", tree: "wv1-a" }, of), "x");
    assert.equal(eventEpic({ tree: "wv1-a" }, of), "ep1");
    assert.equal(eventEpic({ from: "nobody", to: "orchestrator@ep2" }, of), "ep2");
    assert.equal(eventEpic({ lagMs: 5 }, of), null);
});

test("journalOf: своё по полю, старое без поля — по ключам, общее — по окну; порядок по времени; типы и предел", () => {
    const ev = [
        { at: 30, type: "relay.sent", epic: "ep1", from: "wv1-a", to: "orchestrator@ep1", chars: 400 },
        { at: 10, type: "job.end", tree: "wv1-a", task: "api-test", status: "fail" },
        { at: 20, type: "job.end", epic: "ep2", tree: "wv2-b" },
        { at: 25, type: "server.start", reason: "перезапуск" },
        { at: 26, type: "server.pulse" },
        { at: 40, type: "orch.command", tree: "orchestrator@ep1", cmd: "ВЛИТЬ", target: "П1", ok: false, detail: "нет слова" },
    ];
    assert.deepEqual(journalOf(ev, { epic: "ep1", keys: ["wv1-a"] }).map((e) => e.at), [10, 25, 30, 40]);
    assert.deepEqual(journalOf(ev, { epic: "ep1", keys: ["wv1-a"], from: 15, to: 35 }).map((e) => e.at), [25, 30]);
    assert.deepEqual(journalOf(ev, { epic: "ep1", keys: ["wv1-a"], types: ["orch.command"] }).map((e) => e.at), [40]);
    assert.deepEqual(journalOf(ev, { epic: "ep1", keys: ["wv1-a"], limit: 2 }).map((e) => e.at), [30, 40]);
    assert.deepEqual(journalCounts(journalOf(ev, { epic: "ep1", keys: ["wv1-a"] })), { "job.end": 1, "server.start": 1, "relay.sent": 1, "orch.command": 1 });
    assert.match(journalLine(ev[0]), /relay\.sent wv1-a → ОРК.*\(400 зн\.\)$/);
    assert.match(journalLine(ev[5]), /orch\.command ОРК: нет слова/);
});

test("brief: одна строка, блоки кода свёрнуты, обрезка", () => {
    assert.equal(brief("Привет\n\n```text\nдлинный\nблок\n```\nдальше"), "Привет [блок] дальше");
    assert.equal(brief("а".repeat(200), 10).length, 10);
});

test("logEvent ставит поле epic сам (по ключу дерева) и не падает без реестра", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-journal-"));
    process.env.DASH_DATA = dir;
    delete process.env.DASH_DRY;
    const C = await import("./config.mjs");
    C.setEventEpicOf((k) => (k === "wv1-a" ? "ep1" : null));
    C.logEvent("job.end", { tree: "wv1-a", status: "ok" });
    C.logEvent("server.pulse", { lagMs: 1 });
    C.logEvent("x", { tree: "чужой", epic: "явный" });
    await new Promise((r) => setTimeout(r, 200));
    const lines = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const by = Object.fromEntries(lines.map((e) => [e.type, e.epic || null]));
    assert.deepEqual(by, { "job.end": "ep1", "server.pulse": null, x: "явный" });
    C.setEventEpicOf(() => {
        throw new Error("реестр не прочитан");
    });
    C.logEvent("job.end", { tree: "wv1-a" });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").length, 4, "сбой определения эпика журнал не роняет");
    C.setEventEpicOf(null);
    fs.rmSync(dir, { recursive: true, force: true });
});

test("уборка журнала: события эпика живут дольше общих (журнал эпика не теряется через 7 суток)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-trim-")), f = path.join(dir, "e.jsonl");
    const { trimJsonl } = await import("./config.mjs");
    fs.writeFileSync(f, [{ at: 1, type: "server.pulse" }, { at: 1, type: "job.end", epic: "ep1" }, { at: 100, type: "server.pulse" }].map((x) => JSON.stringify(x)).join("\n") + "\n");
    const r = trimJsonl(f, 50, { epicCut: 0 });
    assert.deepEqual(r, { dropped: 1, kept: 2 });
    assert.deepEqual(fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l).at), [1, 100]);
    fs.rmSync(dir, { recursive: true, force: true });
});
