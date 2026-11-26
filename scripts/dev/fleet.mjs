#!/usr/bin/env node
// fleet.mjs — поднять все слоты эпика одной командой и открыть их окна: состояние слотов, подготовка недостающих через
// slot-up.mjs (с ограничением параллельности), окна и запреты через slot-workspaces.mjs, открытие окон редактора.
//
//   node scripts/dev/fleet.mjs status                         состояние слотов активного эпика (ветка, впереди staging, правки)
//   node scripts/dev/fleet.mjs up [--slots П1,<слот>] [--parallel 2] [--open] [--dry-run]
//   node scripts/dev/fleet.mjs open [--slots …] [--orch]      открыть окна редактора (и файл промпта слота);
//                                                             open --orch без --slots — только окно оркестратора
// Слот можно назвать «П4», «P4» или «4» (кириллица в консоли теряется). Окна открывает команда `code` редактора.
// Не запускает тестов и агентов, не коммитит. Код возврата: 0 — всё в порядке; 1 — шаг упал; 2 — неверные аргументы.
import "./select-project.mjs"; // первым: выбор проекта дома (--project) до загрузки slots.mjs
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { SLOTS, ORCH, WT, fwd, ansi } from "./slots.mjs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(WT, "_workspaces");
const LOGS = path.join(WT, "_logs");
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "status";
const rest = cmd === argv[0] ? argv.slice(1) : argv;
const has = (f) => rest.includes(f);

const val = (f, d) => {
    const i = rest.indexOf(f);
    return i >= 0 ? rest[i + 1] : d;
};

const die = (m) => {
    console.error(`✖ ${m}`);
    process.exit(2);
};

const KNOWN = new Set(["--slots", "--parallel", "--open", "--dry-run", "--orch"]);

for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--") && !KNOWN.has(rest[i]))
        die(`неизвестный аргумент ${rest[i]}`);
}

if (!["status", "up", "open"].includes(cmd))
    die(`неизвестная команда ${cmd} (status | up | open)`);

function pick() {
    const want = val("--slots");
    if (!want)
        return SLOTS;
    const names = want.split(",").map((s) => s.trim());
    const digit = (n) => (/^[пp]?(\d)$/i.test(n) ? n.match(/(\d)$/)[1] : null);
    const out = names.map((n) => SLOTS.find((s) => s.tag === n || s.slot === n || (digit(n) && s.tag.endsWith(digit(n)))));
    const bad = names.filter((_, i) => !out[i]);
    if (bad.length)
        die(`нет таких слотов: ${bad.join(", ")} (есть: ${SLOTS.map((s) => `${s.tag}=${s.slot}`).join(", ")})`);
    return out;
}

const label = (s) => ansi(s.color, `${s.emoji} ${s.tag} ${s.slot}`);
const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });
const exists = (s) => fs.existsSync(path.join(WT, s.slot, ".git"));

function status() {
    for (const s of pick()) {
        const dir = path.join(WT, s.slot);
        if (!exists(s)) {
            console.log(`${label(s)}  не поднят (ветка ${s.branch})`);
            continue;
        }
        const branch = git(["branch", "--show-current"], dir).stdout.trim();
        const ahead = git(["rev-list", "--count", `staging..${branch}`], dir).stdout.trim();
        const dirty = git(["status", "--short"], dir).stdout.split("\n").filter(Boolean).length;
        const ws = fs.existsSync(path.join(OUT, `${s.slot}.code-workspace`)) ? "окно: есть файл" : "окно: нет файла";
        console.log(`${label(s)}  ${branch}  впереди ${ahead}  изменённых ${dirty}  ${ws}${branch === s.branch ? "" : `  ⚠ ожидалась ${s.branch}`}`);
    }
    if (ORCH)
        console.log(`${ansi(ORCH.color, `${ORCH.emoji} ${ORCH.tag} orchestrator`)}  ${fs.existsSync(path.join(OUT, "orchestrator.code-workspace")) ? "файл окна есть" : "файла окна нет"}`);
    else
        console.log("открытых эпиков нет — заведите: node " + fwd(path.join(HERE, "epic.mjs")) + " new --id <id> --title <название>");
}

function runSlot(s) {
    return new Promise((resolve) => {
        const args = [path.join(HERE, "slot-up.mjs"), s.slot, "--branch", s.branch];
        fs.mkdirSync(LOGS, { recursive: true });
        const log = fs.createWriteStream(path.join(LOGS, `fleet-${s.slot}.log`));
        const p = spawn(process.execPath, args, { cwd: HERE });
        let tail = "";
        const feed = (chunk) => {
            log.write(chunk);
            tail += chunk.toString();
            const lines = tail.split(/\r?\n/);
            tail = lines.pop();
            for (const l of lines)
                if (l.trim())
                    console.log(`${label(s)}  ${l}`);
        };
        p.stdout.on("data", feed);
        p.stderr.on("data", feed);
        p.on("close", (code) => {
            log.end();
            resolve({ s, code });
        });
    });
}

async function up() {
    const slots = pick();
    const parallel = Math.max(1, Number(val("--parallel", 2)) || 2);
    const todo = slots.filter((s) => !exists(s));
    for (const s of slots)
        if (exists(s))
            console.log(`${label(s)}  уже поднят, пропускаю`);
    if (has("--dry-run")) {
        for (const s of todo)
            console.log(`${label(s)}  [dry-run] slot-up ${s.slot} --branch ${s.branch}`);
        console.log(`[dry-run] параллельно ${parallel}; затем окна и запреты${has("--open") ? "; открыть окна" : ""}`);
        return 0;
    }
    const results = [];
    const queue = [...todo];
    await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => {
        while (queue.length)
            results.push(await runSlot(queue.shift()));
    }));
    const failed = results.filter((r) => r.code !== 0);
    console.log(`\nслотов поднято: ${results.length - failed.length}, провалено: ${failed.length}, уже было: ${slots.length - todo.length}`);
    for (const f of failed)
        console.log(`  ✖ ${label(f.s)} код ${f.code}, журнал ${fwd(path.join(LOGS, `fleet-${f.s.slot}.log`))}`);
    spawnSync(process.execPath, [path.join(HERE, "slot-workspaces.mjs"), "--only", [...(ORCH ? [ORCH.slot] : []), ...slots.map((s) => s.slot)].join(",")], { stdio: "inherit" });
    if (has("--open"))
        openWindows(slots.filter((s) => exists(s)));
    return failed.length ? 1 : 0;
}

function openWindows(slots) {
    const code = (args) => spawn("code", args, { shell: true, detached: true, stdio: "ignore" }).unref();
    if (ORCH && (has("--orch") || cmd === "up"))
        code(["-n", `"${fwd(path.join(OUT, "orchestrator.code-workspace"))}"`]);
    for (const s of slots) {
        let prompt = null;
        try {
            prompt = fs.readdirSync(path.join(OUT, "prompts")).find((f) => f === `${s.tag}-${s.slot}.txt`) || null;
        }
        catch { }
        code(["-n", `"${fwd(path.join(OUT, `${s.slot}.code-workspace`))}"`, ...(prompt ? [`"${fwd(path.join(OUT, "prompts", prompt))}"`] : [])]);
        console.log(`${label(s)}  окно запрошено`);
    }
}

if (cmd === "status")
    status();
else if (cmd === "up")
    process.exit(await up());
else if (cmd === "open") {
    const orchOnly = has("--orch") && !val("--slots");
    openWindows(orchOnly ? [] : pick().filter((s) => exists(s)));
}
