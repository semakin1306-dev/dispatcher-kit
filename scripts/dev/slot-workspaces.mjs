#!/usr/bin/env node
// slot-workspaces.mjs — окружение окон слотов: рабочее пространство VS Code (заголовок с веткой, цвета, только-чтение
// защищённых файлов), файлы промптов и запреты агента слота в формате его рантайма. Существующие настройки агента не
// затираются, запреты добавляются.
//
//   node scripts/dev/slot-workspaces.mjs [--dry-run] [--no-agent-settings] [--only <слот>,orchestrator] [--epic <id>]
//   без --epic — слоты всех открытых эпиков.
//
// Пишет вне репозитория проекта: <папка слотов>/_workspaces/<слот>.code-workspace и orchestrator.code-workspace,
// _workspaces/prompts/<метка>-<слот>.txt (персона инженера слота + раздел слота из брифа эпика). В папку слота —
// файл запретов агента (git его игнорирует). Запреты в настройках сессии исполняются инструментом агента, а не уговором
// в промпте; это не граница ОС и не защита от человека.
import "./select-project.mjs"; // первым: выбор проекта дома (--project) до загрузки slots.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT, WT, fwd, PERSONA_PATH, activeEpic, isForeignEpic, loadEpics, orchOf } from "./slots.mjs";
import { slotPolicy } from "./areas.mjs";
import { runtime } from "./runtimes/index.mjs";

const OUT = path.join(WT, "_workspaces");
const PERSONA_FILE = PERSONA_PATH;

/** Только-чтение в окне редактора: защищённые файлы и запрещённые к правке пути конфига; слоту «только чтение» — всё. */
const readonlyOf = (s) => s.readonly?.include ?? (s.readOnly ? { "**": true } : Object.fromEntries([...PROJECT.protected, ...PROJECT.deny.edit].map((p) => [String(p).replace(/^\/+/, ""), true])));
const args = new Set(process.argv.slice(2));
const dry = args.has("--dry-run");
const onlyIdx = process.argv.indexOf("--only");
const only = onlyIdx > 0 ? new Set(process.argv[onlyIdx + 1].split(",")) : null;
const REG = loadEpics(), ACTIVE = activeEpic(REG);
const epicIdx = process.argv.indexOf("--epic"), epicArg = epicIdx > 0 ? process.argv[epicIdx + 1] : null;
const EPICS = (epicArg ? REG.epics.filter((e) => e.id === epicArg) : REG.epics.filter((e) => e.status !== "closed")).filter((e) => !isForeignEpic(e));

if (epicArg && !EPICS.length) {
    console.error(`✖ нет эпика ${epicArg} в реестре`);
    process.exit(2);
}

// Персона инженера слота — начало каждого промпта. Её нет — промпт пишется без неё, с предупреждением.
let PERSONA = "";
try {
    PERSONA = fs.readFileSync(PERSONA_FILE, "utf8").split(/\r?\n---\r?\n/).slice(1).join("\n---\n").trim();
}
catch {
    console.log(`⚠ нет персоны инженера слота ${fwd(PERSONA_FILE)}: промпты слотов — без неё`);
}

/** Бриф слотов эпика — в папке его оркестратора: разделы «### <метка> …» с цитатой-промптом. */
function briefOf(EP) {
    const f = path.join(EP.orch.path, ".claude/plans/waves/agent-briefs", `BRIEF-${EP.id}-slots.md`);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split(/\r?\n/) : [];
}

let brief = [];

function promptOf(tag, slot) {
    const start = brief.findIndex((l) => l.startsWith(`### ${tag} `));
    if (start < 0)
        return null;
    const lines = [];
    for (let i = start + 1; i < brief.length && !/^#{2,3} /.test(brief[i]); i++) {
        if (brief[i].startsWith(">"))
            lines.push(brief[i].replace(/^>\s?/, ""));
    }
    if (!lines.length)
        throw new Error(`у ${tag} пустой промпт`);
    if (slot && !lines.join("\n").includes(slot))
        return null;
    return lines.join("\n").trim() + "\n";
}

function colors(color) {
    return {
        "titleBar.activeBackground": color,
        "titleBar.activeForeground": "#ffffff",
        "titleBar.inactiveBackground": color + "99",
        "titleBar.inactiveForeground": "#ffffffcc",
        "statusBar.background": color,
        "statusBar.foreground": "#ffffff",
        "activityBar.background": color + "33",
        "scmGraph.historyItemRefColor": color,
        "scmGraph.historyItemRemoteRefColor": color + "aa",
        "scmGraph.foreground1": color,
    };
}

function slotWorkspace(s) {
    return {
        folders: [{ path: fwd(path.join(WT, s.slot)) }],
        settings: {
            "window.title": `[${s.tag} ${s.title}] \${activeRepositoryBranchName}\${separator}\${activeEditorShort}`,
            "git.openRepositoryInParentFolders": "never",
            "workbench.startupEditor": "none",
            ...s.settings,
            ...(s.hide ? { "files.exclude": s.hide, "search.exclude": s.hide } : {}),
            "files.readonlyInclude": readonlyOf(s),
            ...(s.readonly?.exclude ? { "files.readonlyExclude": s.readonly.exclude } : {}),
            "workbench.colorCustomizations": colors(s.color),
        },
    };
}

function orchestratorWorkspace(ORCH) {
    return {
        folders: ORCH.folders,
        settings: {
            "window.title": `[${ORCH.tag} ${ORCH.title}] \${activeRepositoryBranchName}\${separator}\${rootName}\${separator}\${activeEditorShort}`,
            "git.openRepositoryInParentFolders": "never",
            "workbench.startupEditor": "none",
            "workbench.colorCustomizations": colors(ORCH.color),
        },
    };
}

function write(file, text) {
    if (dry)
        return console.log(`  [dry-run] ${fwd(file)} (${text.length} симв.)`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

if (epicArg ? EPICS[0] : ACTIVE) {
    const ORCH = orchOf(epicArg ? EPICS[0] : ACTIVE);
    if (!only || only.has(ORCH.slot)) {
        console.log(`${ORCH.emoji} ${ORCH.tag} ${ORCH.slot}`);
        write(path.join(OUT, `${ORCH.slot}.code-workspace`), JSON.stringify(orchestratorWorkspace(ORCH), null, 2) + "\n");
    }
}

for (const EP of EPICS) {
    brief = briefOf(EP);
    if (EPICS.length > 1)
        console.log(`\n── эпик ${EP.id}${ACTIVE && EP.id === ACTIVE.id ? " (активный)" : ""}`);
    for (const s of EP.slots) {
        if (s.archived)
            continue;
        if (only && !only.has(s.slot))
            continue;
        const slotDir = path.join(WT, s.slot);
        console.log(`${s.emoji} ${s.tag} ${s.slot}`);
        write(path.join(OUT, `${s.slot}.code-workspace`), JSON.stringify(slotWorkspace(s), null, 2) + "\n");
        {
            const pf = path.join(OUT, "prompts", `${s.tag}-${s.slot}.txt`), pr = promptOf(s.tag, s.slot);
            if (pr)
                write(pf, `${PERSONA ? PERSONA + "\n\n" : ""}=====\nЗАДАЧА СЛОТА\n=====\n\n${pr}`);
            else {
                if (!dry && fs.existsSync(pf))
                    fs.rmSync(pf);
                console.log("  промпт: в брифе эпика нет раздела слота — дашборд соберёт его из плана волны");
            }
        }
        if (args.has("--no-agent-settings"))
            continue;
        if (!fs.existsSync(slotDir)) {
            console.log(`  ⚠ слота ${fwd(slotDir)} нет: запреты не записаны`);
            continue;
        }
        // запреты — в формате рантайма агента (Claude Code: .claude/settings.local.json; Codex: AGENTS.override.md);
        // прежние настройки файла сохраняются, файл вносится в info/exclude — слот не выглядит изменённым
        if (dry) {
            console.log(`  [dry-run] запреты агента (${PROJECT.agent.runtime})`);
            continue;
        }
        const r = runtime().writeSlotPolicy(slotDir, slotPolicy(s));
        console.log(r ? `  запретов: ${r.deny}${r.merged ? " (добавлены к существующим настройкам)" : ""}` : "  ⚠ файл запретов рантайма лежит в git проекта или не разобран: не трогаю");
    }
}

console.log(dry ? "\n(dry-run: ничего не записано)" : "\nГотово. Окна открывать: node " + fwd(path.join(path.dirname(fileURLToPath(import.meta.url)), "fleet.mjs")) + " open");
