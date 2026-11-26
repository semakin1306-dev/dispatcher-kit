#!/usr/bin/env node
// epic.mjs — команда эпиков: реестр эпиков, слотов, поездов и вагонов (epics.json). Заводит эпик с папкой оркестратора,
// слот волны с веткой и заготовкой плана, поезд области и вагоны в его очередь; переносит и снимает слоты и вагоны,
// ставит тесты волны, закрывает эпик. Не коммитит, не удаляет ветки и не трогает staging.
//
// Кто зовёт: оркестратор эпика и навыки (new-epic, new-slot, wave-plan) — командой `node <EPIC_CLI> <команда> --epic <id>`;
// сервер диспетчерской — для порядка вагонов (agents.mjs epicOrderWagons); человек — из консоли. Подсказки агентам называют
// путь к этому файлу (EPIC_CLI), поэтому вывод команд — для человека и агента: короткие строки «✓/✗ что сделано».
//
// Данные: реестр эпиков epics.json (slots.mjs loadEpics/saveEpics) — эпики, слоты, поезда и вагоны; планы волн — файлы
// WV-NNNN-<слаг>.md в .claude/plans/waves папки оркестратора; trains.json в данных сервера — только чтение (выданный вагон).
// Сервер перечитывает реестр сам по таймеру, поэтому команды пишут реестр напрямую и не ждут ответа сервера. Исключение —
// reset-slot: сброс ветки слота идёт только через HTTP сервера, который знает, остановлен ли агент и нет ли прогонов.
//
// Инварианты: каждая команда сначала проверяет всё и только потом пишет (die до записи); --dry-run ничего не пишет;
// эпики другого репозитория (поле repo) — только для истории, команды к ним не применяются (noForeign);
// имена слотов уникальны во всём реестре — папка слота <WT>/<слот> общая для всех эпиков.
import "./select-project.mjs"; // первым: выбор проекта дома (--project) до загрузки slots.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { EPIC_CLI, MAIN, PROJECT, WT, fwd, loadEpics, saveEpics, isForeignEpic } from "./slots.mjs";
import { OWN, ownerOf, orchDirName, registeredDirs, slotDirName } from "./ownership.mjs";
import { areaList, areaOf, areaPresets, slotAreaFields } from "./areas.mjs";
import { DATA, PORT } from "./dashboard/config.mjs";
import { PALETTE, moveSlot, removeSlot, findSlot, waveOf } from "./dashboard/slot-move-rules.mjs";
import { listItems } from "./dashboard/backlog-store.mjs";
import { retroGateWhy, retroTriage } from "./dashboard/backlog-rules.mjs";
import { DATA as BACKLOG_CLI_DATA, DIR as BACKLOG_CLI_DIR } from "./backlog.mjs";
import { RESET_TO_RE } from "./dashboard/loops.mjs";
import { pageToken } from "./dashboard/restart-rules.mjs";
import {
    MERGE_LOG_FORMAT,
    WAVE_LOG_FORMAT,
    addWagon,
    findTrain,
    isTrain,
    moveWagon,
    newTrain,
    normWave,
    orderWagons,
    parseWaveLog,
    queueState,
    removeWagon,
    stagedMarks,
    waveArg,
} from "./dashboard/train-rules.mjs";

const USAGE = `node ${fwd(path.join(path.dirname(fileURLToPath(import.meta.url)), "epic.mjs"))} <команда>
  list                                         эпики реестра
  new --id X --title T [--activate] [--dry-run]       эпик без слотов (папка оркестратора — ветка dev/epic-X от staging)
  add --file F [--activate] [--dry-run]               эпик со слотами из файла заявки { id, title, slots: [{ slot, branch, area, title?, presets? }] }
      new и add отказывают, пока у карточек ретро последнего закрытого эпика нет решения; [--skip-retro] — обход по слову владельца
  add-slot --title T [--area A] [--epic E] [--wave NNNN|auto] [--slug s] [--after ПN,…] [--read-only] [--sparse]
           [--no-plan] [--no-worktree] [--dry-run]   волна: номер, ветка dev/wv-NNNN-…, слот, заготовка плана
  add-train --area A [--title T] [--scope a,b] [--epic E] [--sparse] [--dry-run]   поезд области (слот с очередью вагонов)
  add-wagon --train ТN --title T [--after WV-…,WV-…@ТM] [--wave NNNN|auto] [--slug s] [--no-plan] [--dry-run]   вагон в очередь поезда
  move-wagon WV-… --to ТN | remove-wagon WV-… | order-wagons ТN WV-… …  [--dry-run]   только вагоны, которые ещё не начаты
  trains [--epic E]                            поезда эпика и очередь вагонов по git
  after ПN ПM[,ПK]|-                          порядок влива слотов
  presets ПN|WV-NNNN [задача=фильтр …|-]      тесты волны (задачи из конфига проекта)
  allow-edit ПN /путь/** …|-                  снять общий запрет правки путей для слота
  move-slot ПN --to E [--from E] [--dry-run] | remove-slot ПN [--epic E] [--dry-run] [--force]
  reset-slot ПN [--epic E] [--to staging|<sha>] [--dry-run]   сброс ветки слота через диспетчерскую
  next-wave | activate <id> [--dry-run] | status <id> | close <id> [--remove-worktrees] [--force]
области проекта: ${areaList()}`;
const argv = process.argv.slice(2), cmd = argv[0], flag = (n) => argv.includes(n), val = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : null;
};

const die = (m) => {
    console.error("✗ " + m);
    process.exit(1);
};

// Нет папки или git — пустой вывод и ненулевой код, а не исключение: команды печатают «нет», а не падают.
const git = (cwd, ...a) => {
    const r = spawnSync("git", a, { cwd, encoding: "utf8" });
    return { status: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || (r.error ? r.error.message : "") };
};
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SLOT_UP = fwd(path.join(HERE, "slot-up.mjs")), SLOT_WS = fwd(path.join(HERE, "slot-workspaces.mjs")), FLEET = fwd(path.join(HERE, "fleet.mjs"));
const slotUpCmd = (s) => "node " + SLOT_UP + " " + s.slot + " --branch " + s.branch;

/**
 * Область слота: названная (неизвестная — отказ с перечнем областей проекта); не названа — единственная область проекта.
 * Областей несколько, а имя не дано — тоже отказ: угадывать область нельзя, от неё зависят запреты и тесты слота.
 */
function pickArea(id, what = "--area") {
    if (id) {
        const a = areaOf(id);
        if (!a)
            die("неизвестная область " + id + "; области проекта: " + areaList());
        return a;
    }
    const all = Object.values(PROJECT.areas);
    if (all.length === 1)
        return all[0];
    die("нужна область " + what + ": " + areaList());
}

// Запись эпика с полем repo пришла из реестра другого проекта: её ветки и папки здесь не существуют, любая правка была бы ложью.
const noForeign = (e) => {
    if (isForeignEpic(e))
        die("эпик " + e.id + " — запись другого репозитория (поле repo, " + e.repo.main + "): диспетчерская ведёт один проект, команда к нему не применяется");
};

const exists = (p) => fs.existsSync(p);
// Транслит названия волны в слаг ветки и файла плана: имена веток и папок — латиница.
const TR = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ё: "e",
    ж: "zh",
    з: "z",
    и: "i",
    й: "y",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "h",
    ц: "ts",
    ч: "ch",
    ш: "sh",
    щ: "sch",
    ъ: "",
    ы: "y",
    ь: "",
    э: "e",
    ю: "yu",
    я: "ya",
};
const translit = (t) => String(t).toLowerCase().split("").map((c) => (c in TR ? TR[c] : c)).join("");
const wavesDirsOf = (reg) => [...new Set([...reg.epics.map((e) => path.join(path.normalize(e.orch.path), ".claude", "plans", "waves")), path.join(MAIN, ".claude", "plans", "waves")])];

/**
 * Следующий свободный номер волны: максимум по всему, где номер мог уже появиться — слоты, ветки, названия и вагоны реестра
 * (в том числе закрытых эпиков), файлы планов всех папок оркестраторов и основной папки, локальные ветки dev/*.
 * Источников много намеренно: план или ветка волны могут существовать раньше записи в реестре, и номер не должен повториться.
 */
function nextWave(reg) {
    const used = new Set(), add = (t) => {
        for (const m of String(t).matchAll(/wv-?(\d{4})/gi))
            used.add(Number(m[1]));
    };
    for (const e of reg.epics) {
        add(e.orch.branch);
        for (const x of e.slots) {
            add(x.slot);
            add(x.branch);
            add(x.title);
            for (const w of x.wagons || [])
                add(w.wave);
        }
    }
    for (const d of wavesDirsOf(reg)) {
        try {
            fs.readdirSync(d).forEach(add);
        }
        catch { }
    }
    add(git(MAIN, "branch", "--list", "dev/*", "--format=%(refname:short)").stdout);
    return (used.size ? Math.max(...used) : 0) + 1;
}

// Заготовка плана волны: разделы, которые ждут навык wave-plan и агент слота. Подсказки в скобках — метки заготовки:
// пока они в файле, сервер не запускает агента слота (slot-rules.mjs planIsStub). Файл не коммитится — его допишет оркестратор.
const planTemplate = (num, title, epicId, area, who) => {
    const d = new Date().toISOString().slice(0, 10);
    return [
        "---",
        "id: WV-" + num,
        "title: " + title,
        "status: draft",
        "created: " + d,
        "updated: " + d,
        "author: " + who,
        "epic: " + epicId,
        "tags:",
        "  - wave",
        "---",
        "",
        "# WV-" + num + ": " + title,
        "",
        "**Источник.** (кто и что запросил, когда; ссылки на переписку и замеры)",
        "",
        "## Что было",
        "",
        "(как устроено сейчас, с замером или чтением кода, а не по памяти)",
        "",
        "## Решения (предложены, подтвердить)",
        "",
        "| # | Решение |",
        "|---|---|",
        "| Р1 | (решение владельца или оркестратора) |",
        "",
        "## Станции",
        "",
        "| ST | Что делаем | Тесты |",
        "|---|---|---|",
        "| ST1 | красный тест | |",
        "| ST2 | код | |",
        "",
        "## Манифест слота",
        "",
        "Область: " + area + ". Границы записаны в запретах слота; общие файлы правит оркестратор.",
        "",
        "## Не делаем",
        "",
        "-",
        "",
    ].join("\n");
};

/** Состояние слота по git: папка, ветка, влита ли в staging, сколько коммитов впереди и несохранённых файлов (status, close). */
const slotState = (s) => {
    const p = path.join(WT, s.slot), has = exists(p);
    const merged = git(MAIN, "merge-base", "--is-ancestor", s.branch, "staging").status === 0;
    const dirty = has ? git(p, "status", "--porcelain").stdout.split("\n").filter(Boolean).length : 0;
    const ahead = git(MAIN, "rev-list", "--count", "staging.." + s.branch).stdout.trim();
    return { has, merged, dirty, ahead: Number(ahead) || 0, branchExists: git(MAIN, "rev-parse", "--verify", "--quiet", s.branch).status === 0 };
};


/**
 * Поезда эпика по git: own — коммиты ветки поезда впереди staging, разобранные по строкам «Wave:» (вагон в работе);
 * staged — вагоны, уже влитые в staging (строки Wave в истории staging и merge-коммиты поезда); issued — какой вагон
 * сервер уже выдал агенту (trains.json). Реестр хранит только очередь, а где вагон на самом деле — знает git.
 */
function trainsGit(e) {
    const own = new Map(), staged = new Set(), issued = new Map();
    for (const t of e.slots.filter(isTrain)) {
        if (git(MAIN, "rev-parse", "--verify", "--quiet", t.branch).status !== 0)
            continue;
        own.set(t.slot, parseWaveLog(git(MAIN, "log", "staging.." + t.branch, "--format=" + WAVE_LOG_FORMAT).stdout, { bySubject: true }));
    }
    for (const w of stagedMarks(
        parseWaveLog(
            git(MAIN, "log", "staging", "-E", "--grep=^Wave: WV-", "-400", "--format=" + WAVE_LOG_FORMAT).stdout,
        ),
        git(MAIN, "log", "staging", "--merges", "--grep=поезд", "-200", "--format=" + MERGE_LOG_FORMAT).stdout,
    ).keys())
        staged.add(w);
    try {
        const tj = JSON.parse(fs.readFileSync(path.join(DATA, "trains.json"), "utf8")) || {};
        for (const [k, v] of Object.entries(tj))
            if (v && v.issued)
                issued.set(k, normWave(v.issued));
    }
    catch { }
    return { own, staged, issued };
}

// Начатые вагоны (есть коммиты, влиты или выданы агенту) переносить, снимать и переставлять нельзя: агент уже ведёт их в ветке.
const startedWaves = (e) => {
    const g = trainsGit(e), s = new Set(g.staged);
    for (const l of g.own.values())
        for (const c of l)
            c.waves.forEach((w) => s.add(w));
    for (const w of g.issued.values())
        s.add(w);
    return s;
};

let epicWhy = "";

/**
 * Эпик команды: --epic → эпик, в папке оркестратора которого запущена команда → активный эпик страницы.
 * Оркестратор зовёт команды из своей папки: без этого правила волна могла бы лечь в чужой (активный) эпик.
 * epicWhy — причина выбора, команды печатают её, чтобы ошибка выбора была видна сразу.
 */
function epicFor(reg) {
    const v = val("--epic");
    if (v) {
        epicWhy = "задан --epic";
        return v;
    }
    const norm = (p) => path.resolve(String(p || "")).split(path.sep).join("/").toLowerCase().replace(/\/+$/, "");
    const cwd = norm(process.cwd()), hit = reg.epics.find((x) => x.status !== "closed" && x.orch && x.orch.path && (cwd === norm(x.orch.path) || cwd.startsWith(norm(x.orch.path) + "/")));
    if (hit) {
        epicWhy = "по папке оркестратора " + hit.orch.path;
        return hit.id;
    }
    epicWhy = "активный эпик дашборда";
    return reg.active;
}

if (cmd === "list") {
    const reg = loadEpics();
    for (const e of reg.epics)
        console.log(`${e.id === reg.active ? "▶" : " "} ${e.id}  [${e.status}]  ${e.title}  · слотов ${e.slots.length} · оркестратор ${e.orch.branch}`);
}
else if (cmd === "activate") {
    const reg = loadEpics(), id = argv[1], e = reg.epics.find((x) => x.id === id && x.status !== "closed");
    if (!e)
        die("нет открытого эпика " + id);
    noForeign(e);
    if (flag("--dry-run")) {
        console.log("(dry-run) активный эпик стал бы:", id, "· сейчас:", reg.active || "—");
        process.exit(0);
    }
    reg.active = id;
    saveEpics(reg);
    console.log("активный эпик:", id, "(дашборд подхватит после переключения вкладки или перезапуска)");
}
else if (cmd === "status") {
    const reg = loadEpics(), e = reg.epics.find((x) => x.id === argv[1]);
    if (!e)
        die("нет эпика " + argv[1]);
    console.log(`${e.id} [${e.status}] ${e.title}`);
    if (isForeignEpic(e)) {
        console.log(`  другой репозиторий ${e.repo.main}: запись только для истории — ветки и папки не проверяются (слотов в записи: ${e.slots.length})`);
        process.exit(0);
    }
    const o = { slot: "orchestrator", branch: e.orch.branch }, op = path.normalize(e.orch.path);
    console.log(
        `  оркестратор: папка ${exists(op) ? "есть" : "НЕТ"} · ветка влита в ` +
            `staging: ${git(MAIN, "merge-base", "--is-ancestor", o.branch, "staging").status === 0 ? "да" : "нет"} ` +
            `· несохранённых файлов: ${exists(op) ? git(op, "status", "--porcelain").stdout.split("\n").filter(Boolean).length : "-"}`,
    );
    for (const s of e.slots) {
        const st = slotState(s);
        console.log(
            `  ${s.tag} ${s.slot}: папка ${st.has ? "есть" : "нет"} · ветка ${st.branchExists ? "есть" : "НЕТ"} ` +
                `· влита: ${st.merged ? "да" : "нет"} · впереди staging: ${st.ahead} · несохранённых: ${st.dirty}`,
        );
    }
}
else if (cmd === "reset-slot") {
    const reg = loadEpics(), epicId = epicFor(reg), e = reg.epics.find((x) => x.id === epicId && x.status !== "closed");
    if (!e)
        die("нет открытого эпика " + epicId);
    noForeign(e);
    const s0 = e.slots.find((z) => z.tag === argv[1] || z.slot === argv[1]);
    if (!s0)
        die("нет слота " + (argv[1] || "") + " в эпике " + e.id + " (пример: reset-slot П2 --epic " + e.id + " --dry-run)");
    const to = val("--to") || "staging";
    if (!RESET_TO_RE.test(to))
        die("--to: staging или sha коммита (7–40 знаков)");
    // Токен записи берётся со страницы сервера (как у браузера): без него /api/slot-reset отказывает.
    const B = "http://127.0.0.1:" + PORT;
    let token = "";
    try {
        token = pageToken(await (await fetch(B + "/", { signal: AbortSignal.timeout(8000) })).text());
    }
    catch { }
    if (!token)
        die("диспетчерская не отвечает на " + B + ": сброс идёт только через неё (она ведёт ветки слотов и их копии) — запустите её и повторите");
    console.log("эпик:", e.id, "(" + epicWhy + ") · слот", s0.tag, s0.slot, "(" + s0.branch + ") → " + to + (flag("--dry-run") ? " · сухой прогон" : ""));
    let r, j = {};
    try {
        r = await fetch(B + "/api/slot-reset", {
            method: "POST",
            headers: { "content-type": "application/json", "x-dash-token": token },
            body: JSON.stringify({ tree: s0.slot, to, dry: flag("--dry-run"), by: "epic.mjs" }),
            signal: AbortSignal.timeout(15 * 60000),
        });
        j = await r.json().catch(() => ({}));
    }
    catch (err) {
        die("запрос к диспетчерской оборвался: " + err.message);
    }
    if (!r.ok) {
        console.log("✗ " + (j.error || "код " + r.status));
        // 409 — сейчас нельзя (агент работает, идут прогоны): отдельный код, чтобы вызывающий отличил «подожди» от ошибки.
        process.exit(r.status === 409 ? 2 : 1);
    }
    console.log(j.message);
}
else if (cmd === "next-wave") {
    console.log("WV-" + String(nextWave(loadEpics())).padStart(4, "0"));
}
else if (cmd === "add" || cmd === "new") {
    const file = val("--file");
    if (cmd === "add" && (!file || !exists(file)))
        die("нужен --file с заявкой эпика");
    if (flag("--repo"))
        die("--repo: эпики других репозиториев не ведутся — диспетчерская ведёт один проект (dispatcher.project.json)");
    const req = cmd === "new" ? { id: val("--id"), title: val("--title"), orchBranch: val("--orch-branch") || undefined, slots: [] } : JSON.parse(fs.readFileSync(file, "utf8")), reg = loadEpics();
    if (req.repo)
        die("поле repo в заявке: эпики других репозиториев не ведутся — диспетчерская ведёт один проект (dispatcher.project.json)");
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(req.id || ""))
        die("id эпика: латиница, цифры, дефис");
    if (reg.epics.some((e) => e.id === req.id))
        die("эпик с id " + req.id + " уже есть");
    // Ворота ретро: карточки бэклога из ретро последнего закрытого эпика разбираются до нового эпика, иначе выводы ретро
    // теряются. Обход --skip-retro — по слову владельца, и он оставляет след событием retro.skip в журнале бэклога.
    {
        const tr = retroTriage(listItems(BACKLOG_CLI_DIR), reg.epics), why = retroGateWhy(tr, fwd(path.join(HERE, "backlog.mjs")));
        if (why && !flag("--skip-retro"))
            die("новый эпик не заводится: " + why);
        if (why && !flag("--dry-run")) {
            fs.appendFileSync(
                path.join(BACKLOG_CLI_DATA, "events.jsonl"),
                JSON.stringify({
                    at: Date.now(),
                    type: "retro.skip",
                    epic: req.id,
                    retro: tr.epic,
                    open: tr.open.map((x) => x.id),
                    by: "epic.mjs " + cmd + " --skip-retro",
                }) + "\n",
            );
            console.log("⚠ --skip-retro: ретро «" + tr.epic + "» не разобрано (" + tr.open.map((x) => x.id).join(", ") + ") — записано событием retro.skip");
        }
    }
    if (!req.title || !Array.isArray(req.slots) || (cmd === "add" && !req.slots.length))
        die("нужны title и хотя бы один слот");
    // Имя слота — это и папка <WT>/<слот>: занятое любым эпиком (даже закрытым) имя дало бы два слота на одной папке.
    const taken = new Set(reg.epics.flatMap((e) => e.slots.map((s) => s.slot)));
    const slots = req.slots.map((s, i) => {
        if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(s.slot || ""))
            die("слот: латиница, цифры, дефис: " + s.slot);
        if (taken.has(s.slot))
            die("имя слота занято другим эпиком: " + s.slot + " (папка " + fwd(path.join(WT, s.slot)) + ")");
        if (!/^dev\//.test(s.branch || ""))
            die("ветка слота должна начинаться с dev/: " + s.branch);
        const area = pickArea(s.area, "слота " + s.slot + " (поле area)");
        const [emoji, color] = PALETTE[i % PALETTE.length];
        return {
            tag: s.tag || "П" + (i + 1),
            emoji: s.emoji || emoji,
            slot: s.slot,
            branch: s.branch,
            title: s.title || s.slot,
            color: s.color || color,
            ...slotAreaFields(area),
            ...(s.presets ? { presets: s.presets } : {}),
        };
    });
    const orchBranch = req.orchBranch || "dev/epic-" + req.id, orchPath = fwd(req.orchPath || path.join(WT, orchDirName(req.id)));
    const epic = { id: req.id, title: req.title, status: "open", orch: { branch: orchBranch, path: orchPath }, slots };
    if (flag("--dry-run")) {
        console.log(JSON.stringify(epic, null, 2));
        process.exit(0);
    }
    // Папка оркестратора — до записи в реестр: эпик без папки сервер показал бы, но оркестратору негде было бы работать.
    // Ветка уже есть (эпик заводят повторно) — папка на ней, иначе новая ветка от staging.
    if (!exists(path.normalize(orchPath))) {
        const has = git(MAIN, "rev-parse", "--verify", "--quiet", orchBranch).status === 0;
        const r = has ? git(MAIN, "worktree", "add", path.normalize(orchPath), orchBranch) : git(MAIN, "worktree", "add", "-b", orchBranch, path.normalize(orchPath), "staging");
        if (r.status !== 0)
            die("worktree оркестратора не создан: " + (r.stderr || "").trim());
        console.log("✓ папка оркестратора:", orchPath, "(ветка", orchBranch + ", от staging)");
    }
    reg.epics.push(epic);
    if (flag("--activate"))
        reg.active = epic.id;
    saveEpics(reg);
    console.log("✓ эпик занесён в реестр:", epic.id, flag("--activate") ? "(активный)" : "(не активный: node " + EPIC_CLI + " activate " + epic.id + ")");
    if (!slots.length)
        console.log("\nСлотов пока нет: волна — node " + EPIC_CLI + " add-slot --title \"...\" --area <область>, поезд области — add-train --area <область> (области: " + areaList() + ")");
    else {
        console.log("\nПапки слотов поднимет дашборд сам; без него — по одной:");
        for (const s of slots)
            console.log("  " + slotUpCmd(s));
    }
    console.log("  node " + SLOT_WS + "   # окна редактора и запреты слотов");
}
else if (cmd === "add-slot") {
    const reg = loadEpics(), epicId = epicFor(reg), e = reg.epics.find((x) => x.id === epicId && x.status !== "closed");
    if (!e)
        die("нет открытого эпика " + epicId);
    // Номер волны в названии срезается: его ставит команда сама (title слота — «WV-NNNN <название>»), иначе он задвоится.
    const title = String(val("--title") || "").replace(/^\s*WV-?\d{3,4}\s*[:—-]?\s*/i, "");
    if (!title)
        die("нужен --title (короткое имя волны)");
    noForeign(e);
    const readOnly = flag("--read-only"), areaDef = readOnly && !val("--area") ? null : pickArea(val("--area")), area = areaDef ? areaDef.id : "только чтение";
    const w = val("--wave"), wave = w && w !== "auto" ? Number(String(w).replace(/\D/g, "")) : nextWave(reg);
    if (!wave)
        die("не удалось определить номер волны");
    const num = String(wave).padStart(4, "0"), slug = (val("--slug") || translit(title)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "wave";
    const slotName = val("--slot") || slotDirName(num, slug), branch = val("--branch") || "dev/wv-" + num + "-" + slug;
    const taken = new Set(reg.epics.flatMap((x) => x.slots.map((z) => z.slot)));
    if (taken.has(slotName))
        die("имя слота занято: " + slotName);
    if (exists(path.join(WT, slotName)))
        die("папка уже есть: " + path.join(WT, slotName));
    if (git(MAIN, "rev-parse", "--verify", "--quiet", branch).status === 0)
        die("ветка уже есть: " + branch);
    // Метка ПN — следующая после наибольшей у обычных слотов эпика (у поездов свои метки ТN); цвет — первый незанятый в эпике.
    const n = Math.max(0, ...e.slots.filter((z) => !isTrain(z)).map((z) => Number((/\d+/.exec(z.tag) || [0])[0]))) + 1;
    const used = new Set(e.slots.map((z) => z.color)), [emoji, color] = PALETTE.find(([, c]) => !used.has(c)) || PALETTE[(n - 1) % PALETTE.length];
    // Слот только для чтения (разведка) не собирает, не тестирует и не вливает — тестов волны у него нет.
    const presets = readOnly ? [] : areaPresets(areaDef, "WV-" + num);
    const slot = {
        tag: "П" + n,
        emoji,
        slot: slotName,
        branch,
        title: "WV-" + num + " " + title,
        color,
        ...(areaDef ? (readOnly ? { area: areaDef.id } : slotAreaFields(areaDef)) : {}),
        ...(readOnly ? { readOnly: true } : {}),
        presets,
        ...(flag("--sparse") ? { sparse: true } : {}),
    };
    {
        const af = val("--after");
        if (af) {
            const keys = af.split(",").map((x) => x.trim()).filter(Boolean).map((k) => (e.slots.find((z) => z.tag === k || z.slot === k) || {}).slot || die("--after: нет слота " + k + " в эпике"));
            slot.after = keys;
        }
    }
    const planDir = path.join(path.normalize(e.orch.path), ".claude", "plans", "waves"), planFile = path.join(planDir, "WV-" + num + "-" + slug + ".md");
    const who = git(MAIN, "config", "user.name").stdout.trim() || "owner";
    console.log("эпик:", e.id, "(" + epicWhy + ")" + (e.id !== reg.active ? " — не активный во вкладке дашборда; волна ляжет в него" : ""));
    if (flag("--dry-run")) {
        console.log(JSON.stringify(slot, null, 2));
        console.log("план:", planFile, flag("--no-plan") ? "(не создаётся)" : exists(planFile) ? "(уже есть)" : "(будет создан)");
        console.log("команды после записи: " + slotUpCmd(slot));
        process.exit(0);
    }
    if (!flag("--no-plan") && !exists(planFile)) {
        fs.mkdirSync(planDir, { recursive: true });
        fs.writeFileSync(planFile, planTemplate(num, title, e.id, area, who));
        console.log("✓ план волны:", planFile, "(не закоммичен; допишите источник и решения)");
    }
    e.slots.push(slot);
    saveEpics(reg);
    console.log("✓ слот в реестре:", slot.emoji, slot.tag, slotName, "→", branch, "(дашборд подхватит сам в течение нескольких секунд)");
    // Сервер запущен — папку слота и её подготовку он делает сам (и показывает шаги на странице); второй slot-up отсюда
    // столкнулся бы с ним на одной папке. Сервера нет — папку поднимаем здесь же. Проверка — просто соединение с портом.
    const dashUp = await new Promise((res) => {
        const sk = net.connect(PORT, "127.0.0.1");
        sk.setTimeout(700);
        sk.on("connect", () => {
            sk.destroy();
            res(true);
        });
        sk.on("error", () => res(false));
        sk.on("timeout", () => {
            sk.destroy();
            res(false);
        });
    });
    if (dashUp && !flag("--worktree") && !flag("--no-worktree"))
        console.log(e.id === reg.active ? "✓ дашборд запущен: папку слота и её подготовку он сделает сам (статусы подготовки видны на его странице)"
            : "✓ дашборд запущен, но эпик «" + e.id + "» не активный: дашборд ведёт только активный эпик — папка слота поднимется, когда владелец откроет вкладку этого эпика");
    else if (!flag("--no-worktree")) {
        const upArgs = [SLOT_UP, slotName, "--branch", branch];
        const r = spawnSync(process.execPath, upArgs, { stdio: "inherit" });
        if (r.status !== 0) {
            // Запись в реестре не откатывается: повтор slot-up на той же ветке продолжит подготовку с места сбоя.
            console.log("✗ папка слота не создана (код " + r.status + "). Слот остаётся в реестре; повторите: " + slotUpCmd(slot));
            process.exit(3);
        }
    }
    console.log("\nДальше: " + (dashUp && !flag("--worktree") ? "дашборд подготовит слот сам; " : "") + "окно слота: node " + SLOT_WS + ", затем node " + FLEET + " open.");
}
else if (cmd === "add-train") {
    const reg = loadEpics(), epicId = epicFor(reg), e = reg.epics.find((x) => x.id === epicId && x.status !== "closed");
    if (!e)
        die("нет открытого эпика " + epicId);
    noForeign(e);
    const area = pickArea(val("--area")).id;
    const taken = new Set(reg.epics.flatMap((x) => x.slots.map((z) => z.slot)));
    let t;
    try {
        t = newTrain(e, {
            area,
            title: val("--title") || "",
            scope: val("--scope")
                ? val("--scope")
                      .split(",")
                      .map((x) => x.trim())
                      .filter(Boolean)
                : null,
            taken,
            palette: PALETTE,
            sparse: flag("--sparse"),
        });
    }
    catch (err) {
        die(err.message);
    }
    if (exists(path.join(WT, t.slot)))
        die("папка уже есть: " + path.join(WT, t.slot));
    if (git(MAIN, "rev-parse", "--verify", "--quiet", t.branch).status === 0)
        die("ветка уже есть: " + t.branch);
    console.log("эпик:", e.id, "(" + epicWhy + ")");
    if (flag("--dry-run")) {
        console.log(JSON.stringify(t, null, 2));
        console.log("(сухой прогон: реестр не изменён)");
        process.exit(0);
    }
    saveEpics(reg);
    console.log("✓ поезд в реестре:", t.emoji, t.tag, t.slot, "→", t.branch, "·", t.title, "(вагонов пока нет: add-wagon --train " + t.tag + " --title …)");
    console.log("  папку поезда поднимет дашборд (вкладка эпика); без дашборда: " + slotUpCmd(t));
}
else if (cmd === "add-wagon") {
    const reg = loadEpics(), epicId = epicFor(reg), e = reg.epics.find((x) => x.id === epicId && x.status !== "closed");
    if (!e)
        die("нет открытого эпика " + epicId);
    noForeign(e);
    const title = String(val("--title") || "").replace(/^\s*WV-?\d{3,4}\s*[:—-]?\s*/i, "");
    if (!title)
        die("нужен --title (короткое имя волны)");
    const w = val("--wave"), wave = w && w !== "auto" ? waveArg(w) : "WV-" + String(nextWave(reg)).padStart(4, "0");
    if (!wave)
        die("не удалось определить номер волны");
    let r;
    try {
        r = addWagon(e, val("--train") || "", { wave, title, after: val("--after") || [] });
    }
    catch (err) {
        die(err.message);
    }
    const num = wave.slice(3), slug = (val("--slug") || translit(title)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "wave";
    const planDir = path.join(path.normalize(e.orch.path), ".claude", "plans", "waves"), planFile = path.join(planDir, "WV-" + num + "-" + slug + ".md");
    const who = git(MAIN, "config", "user.name").stdout.trim() || "owner", base = (areaOf(r.train.trainArea) || {}).title || r.train.trainArea;
    console.log("эпик:", e.id, "(" + epicWhy + ") · поезд", r.train.tag, r.train.slot, "· вагонов в очереди:", r.train.wagons.length);
    if (flag("--dry-run")) {
        console.log(JSON.stringify(r.wagon, null, 2));
        console.log("план:", planFile, flag("--no-plan") ? "(не создаётся)" : exists(planFile) ? "(уже есть)" : "(будет создан)");
        process.exit(0);
    }
    if (!flag("--no-plan") && !exists(planFile)) {
        fs.mkdirSync(planDir, { recursive: true });
        fs.writeFileSync(planFile, planTemplate(num, title, e.id, base + " · поезд " + r.train.tag + " (" + r.train.title + ")", who));
        console.log("✓ план волны:", planFile, "(не закоммичен; допишите источник и решения)");
    }
    saveEpics(reg);
    console.log(
        "✓ вагон",
        wave,
        "«" + title + "» — в очередь поезда",
        r.train.tag +
            (r.wagon.after ? " (после " + r.wagon.after.join(", ") + ")" : "") +
            "; тесты вагона: " +
            (r.wagon.presets.map((p) => p.task + (p.input ? "=" + p.input : "")).join(" ") || "—"),
    );
    console.log("  агенту поезда вагон отдаст дашборд в ту же сессию, когда прошлый вагон вольётся в staging (вагоны идут по очереди)");
}
else if (cmd === "move-wagon" || cmd === "order-wagons" || cmd === "remove-wagon") {
    const reg = loadEpics(), epicId = epicFor(reg), e = reg.epics.find((x) => x.id === epicId && x.status !== "closed");
    if (!e)
        die("нет открытого эпика " + epicId);
    noForeign(e);
    const started = startedWaves(e);
    let out;
    try {
        if (cmd === "move-wagon") {
            const r = moveWagon(e, argv[1], val("--to") || "", { started });
            out = "вагон " + r.wagon.wave + ": поезд " + r.from + " → " + r.to;
        }
        else if (cmd === "remove-wagon") {
            const r = removeWagon(e, argv[1], { started });
            out = "вагон " + r.wagon.wave + " «" + r.wagon.title + "» снят из очереди поезда " + r.from;
        }
        else {
            const keyT = argv[1], list = argv.slice(2).filter((x) => !x.startsWith("--") && x !== val("--epic"));
            out = "очередь " + findTrain(e, keyT).tag + ": " + orderWagons(e, keyT, list, { started }).join(" → ");
        }
    }
    catch (err) {
        die(err.message);
    }
    console.log(out + (started.size ? " (начаты: " + [...started].join(", ") + ")" : ""));
    if (flag("--dry-run")) {
        console.log("(сухой прогон: реестр не изменён)");
        process.exit(0);
    }
    saveEpics(reg);
    console.log("✓ записано (дашборд подхватит сам через несколько секунд)");
}
else if (cmd === "trains") {
    const reg = loadEpics(), e = reg.epics.find((x) => x.id === epicFor(reg));
    if (!e)
        die("нет эпика");
    const ts = e.slots.filter(isTrain);
    if (!ts.length) {
        console.log(e.id + ": поездов нет (слоты по-старому)");
        process.exit(0);
    }
    // Очередь вагонов — по реестру, состояние каждого — по git (trainsGit): так видно расхождение реестра и веток.
    const g = trainsGit(e);
    for (const t of ts) {
        console.log(`${t.tag} ${t.slot} (${t.branch}) · ${t.title}`);
        const q = queueState({ wagons: t.wagons || [], own: g.own.get(t.slot) || [], staged: g.staged, depOk: (d) => g.staged.has(d.split("@")[0]) });
        for (const z of q.list) {
            const reg = (t.wagons || []).find((w) => w.wave === z.wave) || {}, at = z.wave === q.head;
            const st = z.state === "staging" ? "в staging"
                : z.state === "wait" ? "голова очереди, ждёт " + z.waitFor.join(", ")
                    : at ? (z.commits ? "в работе (" + z.commits + " комм. впереди staging)" : g.issued.get(t.slot) === z.wave ? "выдан агенту" : "следующий")
                        : "в очереди";
            console.log(`   ${z.wave} ${z.title}: ${st}${reg.after ? " · после " + reg.after.join(", ") : ""}`);
        }
    }
}
else if (cmd === "after") {
    const reg = loadEpics(), e = reg.epics.find((x) => x.id === epicFor(reg));
    if (!e)
        die("нет активного эпика");
    noForeign(e);
    const find = (k) => e.slots.find((z) => z.tag === k || z.slot === k), s0 = find(argv[1] || "");
    if (!s0)
        die("нет слота " + argv[1]);
    const list = String(argv[2] || "").trim();
    if (!list)
        die("кого ждать: after ПN ПM[,ПK] (или «-», чтобы снять)");
    if (list === "-")
        delete s0.after;
    else
        s0.after = list.split(",").map((k) => (find(k.trim()) || die("нет слота " + k)).slot);
    saveEpics(reg);
    console.log("✓ " + s0.tag + " вливается после: " + (s0.after ? s0.after.map((k) => find(k).tag).join(", ") : "—"));
}
else if (cmd === "presets") {
    const reg = loadEpics(), e = reg.epics.find((x) => x.id === epicFor(reg));
    if (!e)
        die("нет активного эпика");
    noForeign(e);
    const wv = /^wv-?\d{3,4}$/i.test(argv[1] || "") ? "WV-" + String(argv[1]).replace(/\D/g, "").padStart(4, "0") : "";
    // Тесты поезда живут у каждого вагона: для вагона — обёртка с presets на запись вагона, дальше код общий со слотом.
    const wagonOf = wv ? e.slots.flatMap((z) => (z.wagons || []).map((w) => ({ w, z }))).find((x) => x.w.wave === wv) : null;
    if (wv && !wagonOf)
        die("нет вагона " + wv + " ни в одном поезде эпика");
    const s0 = wagonOf ? { tag: wagonOf.z.tag + " · " + wv, get presets() {
            return wagonOf.w.presets;
        }, set presets(v) {
            wagonOf.w.presets = v;
        } } : e.slots.find((z) => z.tag === argv[1] || z.slot === argv[1]);
    if (!s0)
        die(
            "нет слота " +
                (argv[1] || "") +
                " (пример: presets П1 <задача>=<фильтр>; вагон поезда — presets WV-NNNN <задача>=<фильтр>; задачи: " +
                (Object.keys(PROJECT.tasks).join(", ") || "в конфиге нет") +
                ")",
        );
    if (!wagonOf && (s0.kind === "train" || Array.isArray(s0.wagons)))
        die(s0.tag + " — поезд: тесты задаются вагону (presets WV-NNNN задача=фильтр …)");
    const show = (l) => (l && l.length ? l.map((p) => p.task + (p.input ? "=" + p.input : "")).join("  ") : "—");
    const items = argv.slice(2).filter((x) => !x.startsWith("--") && x !== val("--epic"));
    if (!items.length) {
        console.log(s0.tag + " тесты волны: " + show(s0.presets));
        process.exit(0);
    }
    // Белый список — задачи конфига проекта: тест волны запускает команду из конфига, произвольная строка сюда не попадает.
    const TASKS_OK = Object.keys(PROJECT.tasks);
    const list = items[0] === "-" ? [] : items.map((x) => {
        const i = x.indexOf("="), task = i < 0 ? x : x.slice(0, i), input = i < 0 ? "" : x.slice(i + 1).trim();
        if (!TASKS_OK.includes(task))
            die("неизвестная задача " + task + " (есть: " + TASKS_OK.join(", ") + ")");
        return input ? { task, input } : { task };
    });
    s0.presets = list;
    saveEpics(reg);
    console.log("✓ " + s0.tag + " тесты волны: " + show(list) + " (дашборд подхватит сам через несколько секунд)");
}
else if (cmd === "allow-edit") {
    const reg = loadEpics(), e = reg.epics.find((x) => x.id === epicFor(reg));
    if (!e)
        die("нет активного эпика");
    noForeign(e);
    const s0 = e.slots.find((z) => z.tag === argv[1] || z.slot === argv[1]);
    if (!s0)
        die("нет слота " + (argv[1] || "") + " (пример: allow-edit Т1 /scripts/**)");
    const items = argv.slice(2).filter((x) => !x.startsWith("--") && x !== val("--epic"));
    if (!items.length) {
        console.log(s0.tag + " разрешено править сверх общих запретов: " + ((s0.allowEdit || []).join(" ") || "—"));
        process.exit(0);
    }
    if (items[0] === "-")
        delete s0.allowEdit;
    else
        s0.allowEdit = [...new Set([...(s0.allowEdit || []), ...items])];
    const dry = flag("--dry-run");
    if (!dry)
        saveEpics(reg);
    console.log(
        (dry ? "(dry-run) " : "✓ ") +
            s0.tag +
            " разрешено править: " +
            ((s0.allowEdit || []).join(" ") || "—") +
            "; запреты слота перепишет slot-workspaces --epic " +
            e.id +
            " --only " +
            s0.slot,
    );
}
else if (cmd === "move-slot") {
    const reg = loadEpics(), to = val("--to");
    if (!to)
        die("куда: --to <эпик> (пример: move-slot П2 --from <эпик> --to <эпик>)");
    {
        let f;
        try {
            f = findSlot(reg, argv[1], val("--from"));
        }
        catch (err) {
            die(err.message);
        }
        noForeign(f.epic);
        noForeign(reg.epics.find((x) => x.id === to));
    }
    let rep;
    try {
        rep = moveSlot(reg, { key: argv[1], from: val("--from"), to });
    }
    catch (err) {
        die(err.message);
    }
    const src = reg.epics.find((x) => x.id === rep.from), dst = reg.epics.find((x) => x.id === rep.to);
    // План волны копируется в папку оркестратора нового эпика (не переносится): в старой он мог быть уже закоммичен.
    const wave = waveOf(rep.slot), srcDir = path.join(path.normalize(src.orch.path), ".claude", "plans", "waves"), dstDir = path.join(path.normalize(dst.orch.path), ".claude", "plans", "waves");
    const plans = wave && exists(srcDir) ? fs.readdirSync(srcDir).filter((f) => new RegExp("^WV-" + wave + "\\b").test(f) && f.endsWith(".md")) : [];
    console.log(`слот ${rep.slot.slot} (${rep.slot.branch}): ${rep.from} ${rep.oldTag} → ${rep.to} ${rep.newTag}`);
    if (rep.droppedAfter.length)
        console.log("  снят порядок влива после слотов старого эпика: " + rep.droppedAfter.join(", "));
    if (rep.unlinked.length)
        console.log("  в эпике " + rep.from + " у " + rep.unlinked.join(", ") + " снята зависимость от переносимого слота");
    console.log(
        "  план волны: " +
            (plans.length
                ? plans
                      .map(
                          (f) =>
                              f +
                              (exists(path.join(dstDir, f))
                                  ? " (в новом эпике уже есть — не копируется)"
                                  : " → " + dstDir),
                      )
                      .join("; ")
                : "в папке оркестратора " + rep.from + " не найден (WV-" + (wave || "?") + ")"),
    );
    if (flag("--dry-run")) {
        console.log("(сухой прогон: реестр не изменён)");
        process.exit(0);
    }
    if (plans.length)
        fs.mkdirSync(dstDir, { recursive: true });
    for (const f of plans)
        if (!exists(path.join(dstDir, f)))
            fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
    saveEpics(reg);
    console.log("✓ перенесён (дашборд подхватит сам через несколько секунд; ветка и папка слота прежние, план — не закоммичен)");
}
else if (cmd === "remove-slot") {
    const reg = loadEpics(), ep = val("--epic");
    let found;
    try {
        found = findSlot(reg, argv[1], ep);
    }
    catch (err) {
        die(err.message);
    }
    noForeign(found.epic);
    const st = slotState(found.slot);
    console.log(`слот ${found.epic.id} ${found.slot.tag} ${found.slot.slot} (${found.slot.branch})`);
    console.log(
        "  ветка: " +
            (!st.branchExists ? "нет" : st.merged ? "влита в staging" : "НЕ влита в staging, впереди на " + st.ahead) +
            " · папка: " +
            (!st.has ? "нет" : st.dirty ? "есть, несохранённых файлов " + st.dirty : "есть, чистая"),
    );
    // Снимается только запись реестра; ветка и папка остаются — их удаление необратимо и делается руками по слову владельца.
    if (st.dirty && !flag("--force"))
        die("в папке слота несохранённая работа — сначала коммит по слову владельца (или --force: запись снимется, папка останется)");
    if (flag("--dry-run")) {
        console.log("(сухой прогон: реестр не изменён)");
        process.exit(0);
    }
    const rep = removeSlot(reg, { key: found.slot.slot, epic: found.epic.id });
    saveEpics(reg);
    if (rep.unlinked.length)
        console.log("  у " + rep.unlinked.join(", ") + " снята зависимость от снятого слота");
    console.log(
        "✓ снят из реестра. Ветка и папка остались" +
            (st.has ? ": папку убрать — git worktree remove " + fwd(path.join(WT, found.slot.slot)) : "") +
            (st.branchExists ? "; ветку — git branch -D " + found.slot.branch + " (только по слову владельца)" : ""),
    );
}
else if (cmd === "close") {
    const reg = loadEpics(), e = reg.epics.find((x) => x.id === argv[1]);
    if (!e)
        die("нет эпика " + argv[1]);
    noForeign(e);
    // Закрытие держат невлитая работа и несохранённые файлы оркестратора и слотов: закрытый эпик сервер больше не ведёт,
    // и такая работа осталась бы без присмотра. --force закрывает всё равно (ветки при этом не удаляются).
    const problems = [];
    const op = path.normalize(e.orch.path);
    if (exists(op)) {
        const d = git(op, "status", "--porcelain").stdout.split("\n").filter(Boolean).length;
        if (d)
            problems.push(`оркестратор: несохранённых файлов ${d}`);
    }
    if (git(MAIN, "merge-base", "--is-ancestor", e.orch.branch, "staging").status !== 0)
        problems.push("оркестратор: ветка " + e.orch.branch + " не влита в staging");
    for (const s of e.slots) {
        const st = slotState(s);
        if (st.dirty)
            problems.push(`${s.tag} ${s.slot}: несохранённых файлов ${st.dirty}`);
        if (st.branchExists && !st.merged)
            problems.push(`${s.tag} ${s.slot}: ветка не влита в staging (впереди на ${st.ahead})`);
    }
    if (problems.length && !flag("--force")) {
        console.log("✗ эпик нельзя закрыть:");
        problems.forEach((p) => console.log("  - " + p));
        console.log("Влейте и закоммитьте (по слову владельца) или закройте с --force.");
        process.exit(2);
    }
    if (flag("--remove-worktrees")) {
        // То же правило «что моё», что у уборки папок (ownership.mjs): папка оркестратора, заданная вне папки слотов
        // (orchPath), или основная папка проекта не снимаются — их мог завести не эпик.
        const own = { wtRoot: WT, main: MAIN, known: registeredDirs(reg.epics, WT) };
        for (const [name, p] of [...e.slots.map((s) => [s.slot, path.join(WT, s.slot)]), ["orchestrator", op]]) {
            if (!exists(p))
                continue;
            if (ownerOf(p, own) !== OWN.SLOT) {
                console.log("· папка не из папки слотов диспетчерской — оставлена (" + name + "): " + p);
                continue;
            }
            const r = git(MAIN, "worktree", "remove", p);
            console.log(r.status === 0 ? "✓ папка убрана: " + p : "✗ папка осталась (" + (r.stderr || "").trim().split("\n")[0] + "): " + p);
        }
    }
    // closedAt — граница окна ретро эпика; активным становится следующий открытый эпик, чтобы страница не осталась пустой.
    e.status = "closed";
    e.closedAt = new Date().toISOString();
    if (reg.active === e.id) {
        const next = reg.epics.find((x) => x.status !== "closed");
        if (next)
            reg.active = next.id;
    }
    saveEpics(reg);
    console.log("✓ эпик закрыт:", e.id, "· ветки НЕ удалены (git branch -D только по слову владельца)");
    for (const b of [e.orch.branch, ...e.slots.map((s) => s.branch)])
        console.log("   ветка осталась:", b);
}
else {
    console.log(USAGE);
}
