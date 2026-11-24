#!/usr/bin/env node
// slot-up.mjs — поднять папку слота одной командой: git worktree на ветке волны от staging (по желанию с частичной
// выкладкой), затем шаги подготовки из конфига проекта и необязательная функция slotPrepare проекта. С --list — какие
// слоты и ветки уже заняты. Не запускает тестов, не коммитит.
//
//   node scripts/dev/slot-up.mjs --list [--dirty] [--all]
//   node scripts/dev/slot-up.mjs <слот> [--branch dev/wv-NNNN-имя] [--from staging] [--area <id>] [--root <папка слотов>]
//        [--fetch] [--reuse] [--no-prepare] [--no-build] [--sparse | --no-sparse] [--dry-run]
//
// Шаги подготовки — `slotPrepare` конфига: шаг с `when: "build"` идёт, только если у области слота `build: true`
// (и не задан --no-build). Область — из записи слота в реестре эпиков или --area. Журнал шагов — вне папки слота
// (<папка слотов>/_logs/slot-up-<слот>.log), чтобы не пачкать её дерево.
//
// Функция проекта slotPrepare (dispatcher.project.mjs) зовётся после шагов конфига с { slot, dir, branch, area, main,
// fresh, record, project }. Может сделать работу сама или вернуть ещё шаги — список строк или { run } — они выполнятся
// так же. Исключение — провал шага.
//
// Код возврата: 0 — все выбранные шаги выполнены; 1 — хоть один упал; 2 — неверные аргументы, ничего не сделано.
// «Пропущено» печатается отдельно от «выполнено»: молчаливый пропуск читался бы как покрытие.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAIN, PROJECT, WT, fwd, loadEpics } from "./slots.mjs";
import { loadProjectCode } from "./project.mjs";
import { sparseCone, sparseNote, sparseWanted } from "./dashboard/sparse-rules.mjs";
import { slotPolicy } from "./areas.mjs";
import { installSlotHooks } from "./hooks/commit-msg.mjs";
import { runtime } from "./runtimes/index.mjs";

const VALUE_FLAGS = new Set(["branch", "from", "root", "area"]);
const BOOL_FLAGS = new Set(["list", "dirty", "all", "fetch", "no-prepare", "no-build", "reuse", "dry-run", "help", "sparse", "no-sparse"]);

const die = (msg) => {
    console.error(`✖ ${msg}`);
    process.exit(2);
};

function parseArgs(argv) {
    const out = { flags: new Set(), vals: {}, pos: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) {
            out.pos.push(a);
            continue;
        }
        const k = a.slice(2);
        if (VALUE_FLAGS.has(k)) {
            const v = argv[++i];
            if (!v || v.startsWith("--"))
                die(`у --${k} нет значения`);
            out.vals[k] = v;
        }
        else if (BOOL_FLAGS.has(k))
            out.flags.add(k);
        else
            die(`неизвестный аргумент --${k} (молча игнорировать нельзя; --help)`);
    }
    return out;
}

function git(args, cwd) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64e6 });
    return { status: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

function listWorktrees(main) {
    const r = git(["worktree", "list", "--porcelain"], main);
    const rows = [];
    let cur = null;
    for (const line of r.out.split(/\r?\n/)) {
        if (line.startsWith("worktree ")) {
            cur = { path: fwd(line.slice(9)), branch: "(detached)" };
            rows.push(cur);
        }
        else if (line.startsWith("branch ") && cur)
            cur.branch = line.slice(7).replace("refs/heads/", "");
    }
    return rows;
}

function cmdList(main, root, o) {
    let rows = listWorktrees(main);
    if (!o.flags.has("all"))
        rows = rows.filter((w) => w.path.toLowerCase() === fwd(main).toLowerCase() || w.path.toLowerCase().startsWith(fwd(root).toLowerCase() + "/"));
    console.log(`Слоты (${rows.length}); «впереди» — коммитов сверх staging${o.flags.has("dirty") ? "; «грязных» — изменённых файлов" : ""}\n`);
    for (const w of rows) {
        const ahead = w.branch === "(detached)" ? "?" : git(["rev-list", "--count", `staging..${w.branch}`], main).out || "?";
        const dirty = o.flags.has("dirty") ? git(["status", "--short"], w.path).out.split("\n").filter(Boolean).length : "-";
        console.log(`${w.path.padEnd(52)} ${w.branch.padEnd(48)} впереди ${String(ahead).padEnd(4)} грязных ${dirty}`);
    }
    if (!o.flags.has("dirty"))
        console.log("\n(--dirty покажет несохранённые файлы; медленно при десятках слотов)");
}

function runLogged(cmd, cwd, logFile) {
    fs.appendFileSync(logFile, `\n=== ${new Date().toISOString()} · ${cmd}\n`);
    const fd = fs.openSync(logFile, "a");
    const r = spawnSync(cmd, { cwd, shell: true, stdio: ["ignore", fd, fd] });
    fs.closeSync(fd);
    return r.status ?? 1;
}

/** Запись слота в реестре эпиков (область, sparse) или null. */
function slotRecord(slot) {
    for (const e of loadEpics().epics || []) {
        const s = (e.slots || []).find((z) => z.slot === slot);
        if (s)
            return s;
    }
    return null;
}

/** Каталоги cone-выкладки для новой папки слота или null (полная): флаги, реестр, DASH_SPARSE, `repo.sparse` конфига. */
function sparsePlan(o, rec, mainRepo, rev) {
    if (o.flags.has("no-sparse") || (!o.flags.has("sparse") && !sparseWanted(rec, process.env, { sparse: PROJECT.repo.sparse })))
        return { cone: null, why: "выключено" };
    const ls = git(["ls-tree", "-r", "-d", "--name-only", rev], mainRepo);
    if (ls.status !== 0)
        return { cone: null, why: "ls-tree " + rev + ": " + ls.err.split("\n")[0] };
    const cone = sparseCone(rec, ls.out.split("\n"), { areas: PROJECT.areas });
    return cone ? { cone, why: sparseNote(cone, rec) } : { cone: null, why: "область слота не понять (нет записи в реестре или слот только читает) — полная выкладка" };
}

/** Шаги подготовки из конфига для области: `when: "build"` — только при сборке. */
export const prepareSteps = (steps, { build = false } = {}) => (steps || []).filter((s) => s.when !== "build" || build);

async function main() {
    const o = parseArgs(process.argv.slice(2));
    if (o.flags.has("help")) {
        console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split(/\nimport /)[0].replace(/^#!.*\n/, "").replace(/^\/\/ ?/gm, ""));
        return;
    }
    const mainRepo = MAIN;
    if (git(["rev-parse", "--git-dir"], mainRepo).status !== 0)
        die(`${fwd(mainRepo)} — не git-репозиторий: проверьте \`repo.main\` в конфиге проекта (node setup.mjs doctor)`);
    const root = path.resolve(o.vals.root ?? WT);
    if (o.flags.has("list"))
        return cmdList(mainRepo, root, o);
    const slot = o.pos[0];
    if (!slot)
        die("укажите имя слота или --list (--help)");
    if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(slot))
        die("имя слота: строчные латиница/цифры/._-, до 41 символа");
    const branch = o.vals.branch ?? `dev/${slot}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/.test(branch) || branch.includes(".."))
        die("недопустимое имя ветки");
    const from = o.vals.from ?? "staging";
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/.test(from))
        die("недопустимое значение --from");
    const slotDir = path.join(root, slot);
    if (path.resolve(slotDir) === path.resolve(mainRepo))
        die("слот не может быть основной папкой");
    const rec = slotRecord(slot) || {};
    const areaId = o.vals.area ?? rec.area ?? "";
    if (areaId && !PROJECT.areas[areaId])
        die(`неизвестная область ${areaId}; области проекта: ${Object.keys(PROJECT.areas).join(" | ") || "(нет)"}`);
    const area = areaId ? PROJECT.areas[areaId] : null;
    const build = !o.flags.has("no-build") && !rec.readOnly && !!(area && area.build);
    const steps = o.flags.has("no-prepare") || rec.readOnly ? [] : prepareSteps(PROJECT.slotPrepare, { build });
    const plan = [];
    const result = (name, status, note = "") => {
        plan.push({ name, status, note });
        console.log(`${status === "ok" ? "✔" : status === "fail" ? "✖" : "–"} ${name}${note ? ` — ${note}` : ""}`);
    };
    const dry = o.flags.has("dry-run");
    if (!/^(dev|fix)\//.test(branch))
        console.warn(`⚠ ветка ${branch} не dev/* и не fix/* — принято: dev/wv-NNNN-имя`);
    if (from !== "staging")
        console.warn(`⚠ ветка режется от ${from}, а не от staging: ветки волн режутся от staging`);

    // 1. worktree
    const exists = fs.existsSync(slotDir) && fs.readdirSync(slotDir).length > 0;
    const wtRow = listWorktrees(mainRepo).find((w) => w.path.toLowerCase() === fwd(slotDir).toLowerCase()), registered = !!wtRow;
    // Папка — зарегистрированный worktree на этой же ветке: это тот же слот, повторная подготовка идёт как с --reuse.
    if (exists && registered && !o.flags.has("reuse") && wtRow.branch === branch) {
        o.flags.add("reuse");
        console.log(`папка ${fwd(slotDir)} — уже worktree на ${branch}: подготовка как с --reuse`);
    }
    if (exists && !(registered && o.flags.has("reuse")))
        die(`${fwd(slotDir)} уже занят (для уже созданного слота — --reuse)`);
    if (o.flags.has("fetch") && !dry) {
        const f = git(["fetch", PROJECT.repo.remote, from], mainRepo);
        if (f.status !== 0)
            console.warn(`⚠ fetch не удался: ${f.err.split("\n")[0]}; работаем от локального ${from}`);
    }
    if (git(["rev-parse", "--verify", "--quiet", `${from}^{commit}`], mainRepo).status !== 0)
        die(`нет ссылки ${from}`);
    const branchExists = git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], mainRepo).status === 0;
    const fresh = !(exists && o.flags.has("reuse"));
    const sp = fresh ? sparsePlan(o, rec, mainRepo, branchExists ? branch : from) : { cone: null, why: "папка уже есть — выкладку не трогаю" };
    const addArgs = [...(sp.cone ? ["worktree", "add", "--no-checkout"] : ["worktree", "add"]), ...(branchExists ? [slotDir, branch] : ["-b", branch, slotDir, from])];
    if (dry) {
        console.log(`\nПЛАН (dry-run, ничего не создано):\n  слот     ${fwd(slotDir)}\n  ветка    ${branch} (${branchExists ? "есть — откроем" : `новая от ${from}`})\n  git      ${addArgs.join(" ")}`);
        console.log(`  выкладка ${sp.why}${sp.cone ? `\n           ${sp.cone.join(" ")}` : ""}`);
        console.log(`  область  ${area ? area.id + (build ? " (со сборкой)" : "") : "не задана"}`);
        console.log(`  шаги     ${steps.map((s) => s.run).join(" → ") || "только worktree"}`);
        return;
    }
    if (fresh) {
        const w = git(addArgs, mainRepo);
        if (w.status !== 0) {
            result("worktree", "fail", w.err.split("\n").pop());
            return summarize(plan);
        }
        if (sp.cone) {
            // sparse-checkout в worktree пишет настройку в его config.worktree; выкладка — git checkout: после --no-checkout индекс пуст.
            const s = spawnSync("git", ["sparse-checkout", "set", "--cone", "--stdin"], { cwd: slotDir, encoding: "utf8", input: sp.cone.join("\n") + "\n" });
            const c = s.status === 0 ? git(["checkout", "-q"], slotDir) : null;
            if (s.status !== 0 || !c || c.status !== 0) {
                // не вышло — папка не должна остаться пустой (повтор пошёл бы с --reuse): выкладываем полностью
                const why = String((s.status !== 0 ? s.stderr : c && c.err) || "").trim().split("\n").pop();
                git(["sparse-checkout", "disable"], slotDir);
                const f = git(["checkout", "-q"], slotDir);
                if (f.status !== 0) {
                    result("worktree", "fail", `частичная выкладка не удалась (${why}), полная тоже (${f.err.split("\n").pop()}): git worktree remove --force ${fwd(slotDir)} и повтор с --no-sparse`);
                    return summarize(plan);
                }
                result("worktree", "ok", `${fwd(slotDir)} @ ${branch}; частичная выкладка не удалась (${why}) — выложена полностью`);
            }
            else
                result("worktree", "ok", `${fwd(slotDir)} @ ${branch}; ${sp.why}`);
        }
        else
            result("worktree", "ok", `${fwd(slotDir)} @ ${branch}${sp.why === "выключено" ? "" : `; полная выкладка: ${sp.why}`}`);
    }
    else
        result("worktree", "ok", "уже есть (--reuse)");

    // 2. шаги подготовки из конфига, затем функция проекта
    const logDir = path.join(root, "_logs");
    fs.mkdirSync(logDir, { recursive: true });
    const log = path.join(logDir, `slot-up-${slot}.log`);
    const runSteps = (list, label) => {
        for (const st of list) {
            const code = runLogged(st.run, slotDir, log);
            result(`${label}: ${st.run}`, code === 0 ? "ok" : "fail", code === 0 ? "" : `код ${code}; журнал ${fwd(log)}`);
            if (code !== 0)
                return false;
        }
        return true;
    };
    let ok = true;
    if (o.flags.has("no-prepare"))
        result("подготовка", "skip", "--no-prepare");
    else if (rec.readOnly)
        result("подготовка", "skip", "слот только читает код");
    else if (!steps.length && PROJECT.slotPrepare.length)
        result("подготовка", "skip", "шаги только для сборки, а у области сборки нет");
    else
        ok = runSteps(steps, "подготовка");
    if (ok && !o.flags.has("no-prepare") && !rec.readOnly) {
        const { hooks } = await loadProjectCode({ file: PROJECT.file || undefined });
        if (hooks.slotPrepare) {
            try {
                const more = await hooks.slotPrepare({ slot, dir: fwd(slotDir), branch, area, main: fwd(mainRepo), fresh, record: rec, project: PROJECT });
                const list = (Array.isArray(more) ? more : []).map((x) => (typeof x === "string" ? { run: x } : x)).filter((x) => x && typeof x.run === "string" && x.run.trim());
                result("slotPrepare проекта", "ok", list.length ? `шагов ещё ${list.length}` : "");
                runSteps(list, "slotPrepare");
            }
            catch (e) {
                result("slotPrepare проекта", "fail", String(e && e.message || e).split("\n")[0]);
            }
        }
    }

    // 3. агент слота: хук commit-msg (строка «Wave:» в коммитах) и запреты в формате рантайма; файл запретов — в info/exclude
    try {
        const m = /wv-?0*(\d{1,4})/i.exec(branch);
        installSlotHooks(slotDir, { wave: m ? "WV-" + m[1].padStart(4, "0") : null });
        result("хук commit-msg", "ok");
    }
    catch (e) {
        result("хук commit-msg", "fail", String(e && e.message || e).split("\n")[0]);
    }
    try {
        const r = runtime().writeSlotPolicy(slotDir, slotPolicy({ ...rec, area: areaId || rec.area }));
        result("запреты агента", r ? "ok" : "skip", r ? `${PROJECT.agent.runtime}: ${r.deny} правил` : "файл запретов рантайма проект держит в git — не трогаю");
    }
    catch (e) {
        result("запреты агента", "fail", String(e && e.message || e).split("\n")[0]);
    }

    // 4. дерево: подготовка не должна оставлять правок в отслеживаемых файлах
    const dirty = git(["status", "--short"], slotDir).out.split("\n").filter(Boolean);
    // --reuse — папка в работе: незакоммиченное слота нормально, не провал
    if (o.flags.has("reuse") && dirty.length)
        result("дерево", "ok", `в работе: ${dirty.length} изменённых файлов слота (--reuse)`);
    else
        result("дерево", dirty.length === 0 ? "ok" : "fail", dirty.length === 0 ? "чистое" : `${dirty.length} изменённых файлов после подготовки: ${dirty.slice(0, 3).join("; ")} — добавьте их в .gitignore проекта или поправьте шаг`);
    summarize(plan, slotDir, branch);
}

function summarize(plan, slotDir, branch) {
    const failed = plan.filter((p) => p.status === "fail").length;
    const skipped = plan.filter((p) => p.status === "skip").length;
    // пропуск, заказанный флагом или устройством слота, — не повод говорить «готов не полностью»
    const ordered = plan.filter((p) => p.status === "skip" && /^--no-|только читает|сборки нет/.test(p.note)).length;
    console.log(`\nИТОГ: выполнено ${plan.filter((p) => p.status === "ok").length}, провалено ${failed}, пропущено ${skipped}${ordered ? ` (заказано ${ordered})` : ""}`);
    if (skipped > ordered)
        console.log("  ⚠ пропущенное НЕ проверено: слот готов не полностью");
    console.log("  НЕ запускалось: тесты и гарды (их запускает диспетчерская станциями)");
    if (slotDir)
        console.log(`  дальше: открыть ${fwd(slotDir)} как отдельную папку; ветка ${branch}; коммит и пуш — только по слову владельца`);
    process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    await main();
