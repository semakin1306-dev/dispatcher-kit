// loops.check.mjs — сухая проверка правил loops.mjs на настоящих журналах диспетчерской: что было бы, если бы правила
// уже стояли. Ничего не запускает и не пишет, кроме отчёта loops-check.txt в папке данных.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { runGate, retrySpecs, relayDecision, slotAsks, NO_GATE, orchTurnsReplay } from "./loops.mjs";
import { DATA as CONFIG_DATA } from "./config.mjs";
import { PROJECT } from "../slots.mjs";
import { parseTaskLog, specAware } from "./parsers.mjs";

const argv = process.argv.slice(2);

const isDir = (p) => {
    try {
        return fs.statSync(p).isDirectory();
    }
    catch {
        return false;
    }
};

const QUIET = argv.includes("--quiet");
const DATA = (argv.find((a) => a.startsWith("--data=")) || "").slice(7) || argv.find((a) => !a.startsWith("--") && isDir(a)) || process.env.DASH_DATA || CONFIG_DATA;
const ORCH = argv.filter((a) => !a.startsWith("--") && !isDir(a));
const out = [];

const say = (...a) => {
    const s = a.join(" ");
    out.push(s);
    if (!QUIET)
        console.log(s);
};

const sum = { blocked: 0, blockedMin: 0, totMin: 0, kept: 0, dropped: 0, events: 0, reports: 0, sup: 0 };

function loadRuns() {
    const jl = path.join(DATA, "runs.jsonl");
    if (fs.existsSync(jl)) {
        const byId = new Map();
        let lines = 0, bad = 0;
        for (const l of fs.readFileSync(jl, "utf8").split("\n")) {
            if (!l.trim())
                continue;
            lines++;
            try {
                const j = JSON.parse(l);
                if (j && typeof j.id === "string")
                    byId.set(j.id, j);
                else
                    bad++;
            }
            catch {
                bad++;
            }
        }
        return { jobs: [...byId.values()], src: "runs.jsonl, " + lines + " строк" + (bad ? ", битых " + bad : "") };
    }
    return { jobs: JSON.parse(fs.readFileSync(path.join(DATA, "runs.json"), "utf8")), src: "runs.json" };
}

const readJson = (f, dflt) => {
    try {
        return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));
    }
    catch (e) {
        if (e.code === "ENOENT")
            return dflt;
        throw e;
    }
};

const readLog = (id) => {
    try {
        return fs.readFileSync(path.join(DATA, "logs", id + ".log"), "utf8");
    }
    catch {
        return "";
    }
};

// Упавшие спеки прогона — тем же разбором, что у диспетчерской (поле parser задачи).
const failing = (id, task) => parseTaskLog(readLog(id), task).failed.map((p) => p.split("\\").join("/"));

// Задачи, у которых упавшее видно по именам спек; задачи областей со сборкой ждут сборку своего кода.
const testLog = (task) => task === "train" || specAware(task);
const DIST = new Set(Object.values(PROJECT.areas).filter((a) => a.build).flatMap((a) => a.tasks));
const ENV_FAIL_RE = /Connection timed out|снимок не отправился|УПЁРЛОСЬ В ПОТОЛОК|СНЯТ ПО ВРЕМЕНИ|spawn UNKNOWN|ECONNRESET|banner exchange|kex_exchange_identification/i;
const realFail = (j) => !ENV_FAIL_RE.test(j.summary || "") && (testLog(j.task) ? failing(j.id, j.task).length > 0 : true);
const min = (j) => j.startedAt && j.endedAt ? (j.endedAt - j.startedAt) / 60000 : 0;
const at = (j) => j.queuedAt || j.startedAt || 0;
const when = (t) => new Date(t).toISOString().slice(0, 16);
// метка «by» прогонов, запущенных человеком со страницы (http.mjs BY_PAGE)
const OWNER = new Set(["страница"]);

function main() {
    if (!isDir(DATA))
        throw new Error("папки данных нет: " + DATA);
    const loaded = loadRuns();
    const jobsAll = loaded.jobs.sort((a, b) => at(a) - at(b));
    const specHist = readJson("spec-history.json", null);
    const period = jobsAll.length ? when(at(jobsAll[0])) + " — " + when(at(jobsAll[jobsAll.length - 1])) : "пусто";
    {
        say("═══ Один прогон на код (ворота на автоматических путях; кнопка владельца не проверяется) ═══");
        say("журнал:", jobsAll.length, "запусков (" + loaded.src + "),", period);
        const blocked = [], why = {};
        for (const j of jobsAll) {
            if (OWNER.has(j.by) || NO_GATE.has(j.task) || j.envRetryOf || j.requeuedFrom || j.baseline || j.pipeline || /^orchestrator/.test(j.tree) || !j.fpStart)
                continue;
            const known = jobsAll
                .filter((k) => k !== j && k.tree === j.tree && k.task === j.task && at(k) < at(j))
                .map((k) =>
                    k.endedAt && k.endedAt <= at(j)
                        ? k
                        : {
                              ...k,
                              status:
                                  ["ok", "fail", "skipped", "interrupted", "cancelled"].includes(k.status) &&
                                  k.endedAt > at(j)
                                      ? "running"
                                      : k.status,
                          },
                );
            const g = runGate({ jobs: known, tree: j.tree, task: j.task, input: j.input || "", fp: j.fpStart, dist: DIST.has(j.task), covers: null, realFail });
            if (!g.run) {
                blocked.push({ j, why: g.why });
                const k = g.why.replace(/\(.*?\)/g, "").trim();
                why[k] = why[k] || { n: 0, min: 0 };
                why[k].n++;
                why[k].min += min(j);
            }
        }
        const tot = jobsAll.reduce((s, j) => s + min(j), 0);
        sum.blocked = blocked.length;
        sum.blockedMin = Math.round(blocked.reduce((s, b) => s + min(b.j), 0));
        sum.totMin = Math.round(tot);
        say("не поставились бы:", blocked.length, "запусков,", sum.blockedMin, "мин из", sum.totMin, "мин машинного времени журнала");
        for (const [k, v] of Object.entries(why))
            say("  ·", k + ":", v.n, "запусков,", Math.round(v.min), "мин");
        const wouldBlockGreenAfterChange = blocked.filter((b) => b.j.status === "fail" && /зелёный на этом же коде/.test(b.why));
        say(
            "проверка от обратного — заблокированный «зелёный на этом же коде» сам оказался красным:",
            wouldBlockGreenAfterChange.length,
            wouldBlockGreenAfterChange.map((b) => b.j.id + " " + b.j.task).join(", "),
        );
        for (const b of blocked.slice(0, 40))
            say(
                "    ",
                b.j.id,
                String(b.j.tree).padEnd(26),
                String(b.j.task).padEnd(14),
                String(b.j.input || "")
                    .slice(0, 40)
                    .padEnd(40),
                (b.j.by || "-").padEnd(24),
                String(b.j.status).padEnd(11),
                "←",
                b.why,
            );
    }
    {
        say("\n═══ Автоповтор только чужих и ещё не падавших на этом коде спек ═══");
        if (!specHist)
            say("  истории спек (spec-history.json) нет — считаем, что ни одна спека раньше не падала");
        let kept = 0, dropped = 0, droppedMin = 0;
        for (const r of jobsAll.filter((j) => j.retryOf)) {
            const o = jobsAll.find((k) => k.id === r.retryOf);
            if (!o)
                continue;
            const code = o.tree + ":" + (o.fpEnd || o.treeSha || "");
            const hist = Object.fromEntries(Object.entries(specHist || {}).map(([f, h]) => [f, h.filter((x) => x.at <= (o.endedAt || 0))]));
            const f = failing(o.id, o.task), keep = retrySpecs({ failing: f, touched: Object.keys(o.snap || {}), history: hist, code, jobId: o.id });
            if (keep.length)
                kept++;
            else {
                dropped++;
                droppedMin += min(r);
            }
            say(
                "  ",
                r.id,
                "повтор",
                o.id,
                String(o.tree).padEnd(26),
                "→",
                String(r.status).padEnd(11),
                keep.length
                    ? "остался бы: " + keep.map((x) => path.basename(x)).join(", ")
                    : "НЕ ставился бы (" + f.map((x) => path.basename(x)).join(", ") + ")",
            );
        }
        sum.kept = kept;
        sum.dropped = dropped;
        say("автоповторов осталось бы:", kept, "· снято:", dropped, "(" + Math.round(droppedMin) + " мин)");
    }
    const textOf = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x.type === "text").map((x) => x.text).join("\n") : "";
    for (const file of ORCH) {
        say("\n═══ Доклады оркестратору: " + file.split(/[\\/]/).slice(-2).join("/") + " ═══");
        const turns = [];
        let cur = null;
        const seen = new Set();
        for (const l of fs.readFileSync(file, "utf8").split("\n")) {
            if (!l)
                continue;
            let e;
            try {
                e = JSON.parse(l);
            }
            catch {
                continue;
            }
            if (e.type === "user" && e.message && !(Array.isArray(e.message.content) && e.message.content.some((x) => x.type === "tool_result"))) {
                const t = textOf(e.message.content);
                if (!t.trim())
                    continue;
                cur = { at: Date.parse(e.timestamp), end: Date.parse(e.timestamp), in: t, out: "", tok: 0, act: false };
                turns.push(cur);
            }
            else if (e.type === "assistant" && cur && e.message) {
                cur.end = Date.parse(e.timestamp);
                for (const x of e.message.content || []) {
                    if (x.type === "text")
                        cur.out += x.text + "\n";
                    if (x.type === "tool_use" && /^(Edit|Write)$/.test(x.name))
                        cur.act = true;
                }
                if (!seen.has(e.message.id)) {
                    seen.add(e.message.id);
                    const u = e.message.usage || {};
                    cur.tok += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
                }
            }
        }
        for (const t of turns)
            if (/```slot:|ПРОГНАТЬ\s|ВЛИТЬ|КОММИТ\s|ПРИНЯТЬ РЕВЬЮ/.test(t.out))
                t.act = true;
        const REP = /^Ответ слота (\S+) \(([^)]+)\), передан[^\n]*\n\n([\s\S]*?)(\n\n── Справка диспетчерской[\s\S]*)?$/;
        const reports = turns.map((t) => {
            const m = REP.exec(t.in);
            return m ? { t, tag: m[1], key: m[2], body: m[3], facts: m[4] || "" } : null;
        }).filter(Boolean);
        const M = (x) => (x / 1e6).toFixed(1) + " млн";
        const codeOf = (f) => {
            const head = (/HEAD (\w+)/.exec(f) || [])[1] || "", lines = f.split("\n").filter((l) => /^(Изменено и не закоммичено|Новые файлы вне git|Впереди staging)/.test(l)).join("\n");
            return { sha: head, fp: crypto.createHash("sha1").update(head + lines).digest("hex").slice(0, 12) };
        };
        const last = new Map();
        let sup = 0, supTok = 0, supAct = 0;
        const supList = [];
        for (const r of reports) {
            const c = codeOf(r.facts), prev = last.get(r.key);
            const d = relayDecision({ body: r.body, prev, cur: r.facts ? c : null });
            if (!d.relay) {
                sup++;
                supTok += r.t.tok;
                if (r.t.act) {
                    supAct++;
                    supList.push(r);
                }
            }
            if (d.relay)
                last.set(r.key, { ...c, asks: slotAsks(r.body) });
        }
        sum.reports += reports.length;
        sum.sup += sup;
        say("докладов слотов:", reports.length, "· токенов на их ходы:", M(reports.reduce((s, r) => s + r.t.tok, 0)));
        say("доклады — не ушли бы оркестратору:", sup, "докладов,", M(supTok), "токенов; из них оркестратор что-то сделал в", supAct, "(проверить глазами ниже)");
        for (const r of supList.slice(0, 8))
            say("    ⚠", new Date(r.t.at).toISOString().slice(5, 16), r.tag, "|", r.body.replace(/\s+/g, " ").slice(0, 110), "\n       → его ответ:", r.t.out.replace(/\s+/g, " ").slice(0, 140));
        const sec = (f, a, b) => {
            const i = f.indexOf(a);
            if (i < 0)
                return "";
            const j = b ? f.indexOf(b, i + a.length) : -1;
            return f.slice(i, j < 0 ? undefined : j);
        };
        const lastF = new Map();
        let full = 0, delta = 0;
        for (const r of reports) {
            const f = r.facts;
            if (!f)
                continue;
            full += f.length;
            const p = lastF.get(r.key);
            const plan = sec(f, "ТЗ волны", "Правки ветки"),
                diff = sec(f, "Правки ветки", "Причина красного") || sec(f, "Правки ветки", "Прежде чем отвечать"),
                tail = sec(f, "Прежде чем отвечать", null);
            const reds = f.split("Причина красного").slice(1).map((x) => x.split("Прежде чем отвечать")[0]);
            let cut = 0;
            if (p) {
                if (plan && plan === p.plan)
                    cut += plan.length;
                if (diff && diff === p.diff)
                    cut += diff.length;
                for (const x of reds)
                    if (p.reds.includes(x))
                        cut += x.length;
                cut += Math.max(0, tail.length - 160);
            }
            delta += f.length - cut;
            lastF.set(r.key, { plan, diff, reds });
        }
        say(
            "справки:",
            Math.round(full / 1000),
            "тыс. знаков целиком →",
            Math.round(delta / 1000),
            "тыс. разностью (−" +
                Math.round(100 - (delta / Math.max(1, full)) * 100) +
                " %); это оседало бы в контексте оркестратора на каждом следующем ходе",
        );
        let merged = 0, mergedTok = 0;
        for (let i = 1; i < turns.length; i++) {
            const a = turns[i - 1], b = turns[i];
            if (REP.test(a.in) && REP.test(b.in) && b.at - a.end < 15000) {
                merged++;
                mergedTok += b.t ? 0 : b.tok;
            }
        }
        say("ходов «доклад сразу за докладом» (стояли в очереди, ушли бы пачкой):", merged, "· их токены:", M(mergedTok));
        const calls = [];
        {
            const ids = new Set();
            for (const l of fs.readFileSync(file, "utf8").split("\n")) {
                if (!l)
                    continue;
                let e;
                try {
                    e = JSON.parse(l);
                }
                catch {
                    continue;
                }
                if (e.type === "assistant" && e.message && !ids.has(e.message.id)) {
                    ids.add(e.message.id);
                    const u = e.message.usage || {};
                    const c = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
                    if (c)
                        calls.push(c);
                }
            }
        }
        const LIM = 300000, b0 = calls[0] || 80000;
        let sim = 0, start = 0, prevC = 0, rot = 0;
        for (const c of calls) {
            if (prevC && c < prevC * 0.6)
                start = c - b0;
            let v = c - start;
            if (v >= LIM) {
                start = c - b0 - 8000;
                v = b0 + 8000;
                rot++;
            }
            sim += Math.max(v, b0);
            prevC = c;
        }
        const real = calls.reduce((s, c) => s + c, 0);
        say(
            "контекст на вызов: было",
            M(real),
            "за",
            calls.length,
            "вызовов (макс",
            Math.round(Math.max(0, ...calls) / 1000) + " тыс.); с новой сессией на 300 тыс. —",
            M(sim),
            "(−" + Math.round(100 - (sim / Math.max(1, real)) * 100) + " %), новых сессий:",
            rot,
        );
    }
    {
        const f = path.join(DATA, "events.jsonl");
        say("\n═══ Журнал событий — events.jsonl ═══");
        if (!fs.existsSync(f))
            say("  журнала событий нет (диспетчерская ещё не писала его)");
        else {
            const by = {}, ended = new Set();
            let first = 0, last = 0, bad = 0;
            for (const l of fs.readFileSync(f, "utf8").split("\n")) {
                if (!l.trim())
                    continue;
                let e;
                try {
                    e = JSON.parse(l);
                }
                catch {
                    bad++;
                    continue;
                }
                sum.events++;
                by[e.type] = (by[e.type] || 0) + 1;
                if (e.at) {
                    first = first || e.at;
                    last = e.at;
                }
                if (e.type === "job.end" && e.id)
                    ended.add(e.id);
            }
            say("событий:", sum.events, first ? when(first) + " — " + when(last) : "", bad ? "· битых строк " + bad : "");
            say("  по типам:", Object.entries(by).sort((a, b) => b[1] - a[1]).map(([t, n]) => t + " " + n).join(", ") || "—");
            if (/runs\.jsonl/.test(loaded.src)) {
                const ids = new Set(jobsAll.map((j) => j.id)), lost = [...ended].filter((id) => !ids.has(id));
                say("  законченных по событиям, но нет в runs.jsonl:", lost.length, lost.slice(0, 20).join(", "));
            }
        }
    }
    {
        const f = path.join(DATA, "events.jsonl");
        say("\n═══ BL-0063 — пустые ходы оркестратора: повод хода и правило «будить или копить» ═══");
        if (!fs.existsSync(f))
            say("  журнала событий нет");
        else {
            const evs = [];
            for (const l of fs.readFileSync(f, "utf8").split("\n")) {
                if (!l.trim())
                    continue;
                try {
                    evs.push(JSON.parse(l));
                }
                catch { }
            }
            const r = orchTurnsReplay(evs);
            sum.orchTurns = r.turns;
            sum.orchEmpty = r.empty;
            sum.orchCut = r.cut;
            sum.orchCutEmpty = r.cutEmpty;
            say("ходов оркестраторов:", r.turns, "· пустых (act:false):", r.empty, "(" + (r.emptyCr / 1e6).toFixed(1) + " млн токенов кеша)");
            say("правило сняло бы ходов:", r.cut, "— из них пустых", r.cutEmpty, "(" + (r.cutEmptyCr / 1e6).toFixed(1) + " млн), с действием", r.cut - r.cutEmpty, "(проверить глазами ниже)");
            for (const [k, v] of Object.entries(r.byKind).sort((a, b) => b[1].empty - a[1].empty))
                say("  ·", k + ":", "ходов", v.n, "пустых", v.empty, "снято бы", v.cut);
            for (const x of r.cutActed.slice(0, 8))
                say("    ⚠", new Date(x.at).toISOString().slice(5, 16), x.key, x.kind, "|", String(x.brief || "").slice(0, 120));
        }
    }
    const summary = "loops.check: " + [
        "прогонов " + jobsAll.length + " (" + loaded.src + "; " + period + ")",
        "ворота сняли бы " + sum.blocked + " (" + sum.blockedMin + " мин из " + sum.totMin + ")",
        "автоповторов осталось " + sum.kept + ", снято " + sum.dropped,
        "событий " + sum.events,
        ORCH.length ? "докладов " + sum.reports + ", не ушло бы " + sum.sup : "",
        sum.orchTurns ? "ходов оркестратора " + sum.orchTurns + " (пустых " + sum.orchEmpty + "), сняло бы " + sum.orchCut + " (пустых " + sum.orchCutEmpty + ")" : "",
    ].filter(Boolean).join(" · ");
    out.push("", summary);
    try {
        fs.writeFileSync(path.join(DATA, "loops-check.txt"), out.join("\n") + "\n");
    }
    catch (e) {
        console.error("loops-check.txt не записан:", e.message);
    }
    if (!QUIET)
        console.log("");
    console.log(summary);
}

try {
    main();
}
catch (e) {
    console.error("loops.check: не отработала —", e && e.stack || e);
    process.exit(1);
}
