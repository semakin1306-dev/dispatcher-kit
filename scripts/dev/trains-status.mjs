#!/usr/bin/env node
// trains-status.mjs — состояние поездов, слотов, вливов и приёмки одним отчётом: только читает API диспетчерской и её
// журнал событий. Навык trains-status зовёт этот скрипт и пересказывает, что едет, что стоит и почему, что ждёт
// человека.
//   node scripts/dev/trains-status.mjs [--epic <id>] [--json] [--since 60]   (since — минут журнала, по умолчанию 90)
import fs from "node:fs";
import path from "node:path";
import { DATA, PORT } from "./dashboard/config.mjs";

const argv = process.argv.slice(2), val = (k, d) => {
    const i = argv.indexOf(k);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const B = process.env.DASH_URL || "http://127.0.0.1:" + PORT, EPIC = val("--epic", ""), SINCE = Number(val("--since", "90")) * 60e3, JSON_OUT = argv.includes("--json");
const DASH = DATA;
const hdr = EPIC ? { "x-dash-epic": EPIC } : {};

const get = async (p) => {
    const r = await fetch(B + p, { headers: hdr, signal: AbortSignal.timeout(20000) });
    if (!r.ok)
        throw new Error(p + ": " + r.status);
    return r.json();
};

const hm = (ms) => ms ? new Date(ms).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "—";

const cut = (s, n = 160) => {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

let state, acc;

try {
    state = await get("/api/state");
    acc = await get("/api/accept-state").catch(() => null);
}
catch (e) {
    console.log("Дашборд не отвечает (" + B + "): " + e.message);
    process.exit(2);
}

const trees = (Array.isArray(state.trees) ? state.trees : Object.values(state.trees || {})).filter((t) => t.kind !== "orch");
const jobs = state.jobs || [];
const live = jobs.filter((j) => ["running", "queued", "waiting"].includes(j.status));
const recentEnd = jobs.filter((j) => ["ok", "fail", "skipped", "interrupted"].includes(j.status) && j.endedAt && Date.now() - j.endedAt < SINCE);

const events = (() => {
    try {
        return fs.readFileSync(path.join(DASH, "events.jsonl"), "utf8").trim().split("\n").slice(-6000).map((l) => {
            try {
                return JSON.parse(l);
            }
            catch {
                return null;
            }
        }).filter((e) => e && Date.now() - e.at < SINCE);
    }
    catch {
        return [];
    }
})();

const settings = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(DASH, "settings.json"), "utf8"));
    }
    catch {
        return {};
    }
})();

const inbox = (() => {
    try {
        const x = JSON.parse(fs.readFileSync(path.join(DASH, "inbox.json"), "utf8"));
        return Array.isArray(x) ? x : x.cards || [];
    }
    catch {
        return [];
    }
})();

const keys = new Set(trees.map((t) => t.key));
const report = { at: new Date().toISOString(), epic: EPIC || null, night: (settings.autoOwnerUntil || 0) > Date.now() ? hm(settings.autoOwnerUntil) : null, trains: [], slots: [], live: [], deploys: [], accept: [], ownerq: [], errors: [] };

for (const t of trees) {
    const jl = (k) => live.filter((j) => j.tree === k).map((j) => j.id + " " + j.task + (j.input ? " " + cut(j.input, 40) : "") + " · " + j.status + (j.waitReason ? " (" + cut(j.waitReason, 60) + ")" : ""));
    const base = { key: t.key, tag: t.tag, group: t.group, next: t.next ? cut((t.next.kind ? t.next.kind + ": " : "") + t.next.text, 220) : "", running: jl(t.key), ahead: t.ahead, behind: t.behind, dirty: (t.dirtyTracked || 0) + (t.dirtyUntracked || 0) };
    if (t.train)
        report.trains.push({ ...base, wagon: t.wagon || "", head: t.head || "", issued: t.issued || "",
            wagons: (t.wagonsView || []).map((w) => w.wave + " " + w.state + (w.label ? " «" + w.label + "»" : "") + (w.waitFor && w.waitFor.length ? " ждёт " + w.waitFor.join(",") : "") + (w.times && w.times.mergedAt ? " · влит " + hm(w.times.mergedAt) : "")) });
    else
        report.slots.push({ ...base, branch: t.branch, verdict: t.verdict || {} });
}

report.live = live.filter((j) => !keys.has(j.tree)).map((j) => j.id + " " + j.tree + " " + j.task + " · " + j.status);

report.deploys = recentEnd.filter((j) => ["deploy-staging", "merge", "release", "accept-run"].includes(j.task)).concat(live.filter((j) => ["deploy-staging", "merge", "release", "accept-run"].includes(j.task)))
    .map((j) => hm(j.startedAt || j.queuedAt) + " " + j.id + " " + j.task + " · " + j.status + (j.summary ? " — " + cut(j.summary, 120) : ""));

if (acc && acc.waves)
    report.accept = acc.waves.map((w) => w.key + ": " + (w.verdict || "без вердикта") + " · пунктов " + ((w.items || []).length) + " · авто ✓" + (w.items || []).filter((i) => i.auto && i.auto.st === "ok").length + " ✗" + (w.items || []).filter((i) => i.auto && i.auto.st === "fail").length + (w.specs && w.specs.length ? "" : " · спеки нет"));

report.ownerq = inbox.filter((c) => c.kind === "ownerq" && (!EPIC || String(c.tree || "").includes(EPIC) || keys.has(c.tree))).map((c) => c.tree + ": " + cut(c.text || c.q, 200))
    .concat(events.filter((e) => e.type === "owner.question" && (!EPIC || e.epic === EPIC) && !events.some((a) => /^owner\.(answer|message)$/.test(a.type) && a.at > e.at && (a.key || a.tree) === e.tree)).slice(-5).map((e) => hm(e.at) + " " + (e.tree || "") + ": " + cut(e.brief, 160)));

report.errors = events.filter((e) => /turn\.after\.error|train\.issue\.held|perm\.deny|merge\.auto\.refused|slot\.sync\.auto/.test(e.type) && (!EPIC || !e.epic || e.epic === EPIC)).slice(-12)
    .map((e) => hm(e.at) + " " + e.type + " " + (e.tree || e.key || e.to || "") + " " + cut(e.why || e.error || e.wave || "", 120));

if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 1));
    process.exit(0);
}

const P = (s) => console.log(s);
P("СОСТОЯНИЕ " + (EPIC || "всех эпиков") + " · " + hm(Date.now()) + (report.night ? " · ночной режим до " + report.night : " · ночной режим выкл"));

for (const t of report.trains) {
    P("\n🚂 " + t.tag + " " + t.key + " · группа " + t.group + (t.dirty ? " · правок в папке " + t.dirty : "") + " · ↑" + (t.ahead || 0) + " ↓" + (t.behind || 0));
    P("   вагон ветки: " + (t.wagon || "—") + " · голова очереди: " + (t.head || "—") + " · у агента: " + (t.issued || "—"));
    for (const w of t.wagons)
        P("   · " + w);
    if (t.next)
        P("   дальше: " + t.next);
    for (const j of t.running)
        P("   ⏳ " + j);
}

for (const s of report.slots) {
    P("\n▫ " + s.tag + " " + s.key + " (" + (s.branch || "") + ") · группа " + s.group);
    if (s.next)
        P("   дальше: " + s.next);
    for (const j of s.running)
        P("   ⏳ " + j);
}

if (report.live.length) {
    P("\nОчередь вне веток:");
    for (const j of report.live)
        P("   ⏳ " + j);
}

if (report.deploys.length) {
    P("\nВыкаты, вливы, приёмка (за " + Math.round(SINCE / 60e3) + " мин):");
    for (const d of report.deploys)
        P("   " + d);
}

if (report.accept.length) {
    P("\nАвтоприёмка по вагонам:");
    for (const a of report.accept)
        P("   " + a);
}

if (report.ownerq.length) {
    P("\nВопросы владельцу:");
    for (const q of report.ownerq)
        P("   ❓ " + q);
}

if (report.errors.length) {
    P("\nСобытия, на которые смотреть:");
    for (const e of report.errors)
        P("   ⚠ " + e);
}
