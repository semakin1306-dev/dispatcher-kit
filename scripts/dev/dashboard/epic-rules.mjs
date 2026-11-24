// epic-rules.mjs — общие правила сессий эпика против того, как устроены слоты: в файле правил эпика ищутся строки,
// которые велят агенту слота самому делать то, что делает диспетчерская (подготовка слота, станции проверок), и
// оркестратору один раз на содержимое файла поручается их переписать по шаблону.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson, saveJson } from "./store.mjs";
import { DATA, DRY, HERE, logEvent } from "./config.mjs";
import { openEpics, orchKey } from "./trees.mjs";
import { PROJECT } from "../slots.mjs";

export const RULES_REL = ".claude/plans/waves/agent-briefs/SESSIONS-common-rules.md";
export const RULES_TEMPLATE = path.join(HERE, "..", "..", "..", "agent-briefs", "SESSIONS-common-rules.md");

// Строка правил устарела, если велит агенту выполнить команду, которую делает диспетчерская: шаг подготовки слота
// (`slotPrepare`) или задачу станции (`tasks`). Строка с запретом («не …», «нельзя», «запрещено») — не находка.
const NEGATED = /(^|[^а-яё])не\s|нельзя|запрещ/i;
const cmdHead = (run) => String(run || "").split("{input}")[0].trim();

/** Правила устаревших строк по конфигу проекта: [{ cmd, why }]. */
export function staleRules(project = PROJECT) {
    const out = [], seen = new Set();
    const add = (cmd, why) => {
        if (cmd.length >= 4 && !seen.has(cmd)) {
            seen.add(cmd);
            out.push({ cmd, why });
        }
    };
    for (const st of project.slotPrepare || [])
        add(cmdHead(st.run), "выполнять шаг подготовки слота — его делает диспетчерская, когда поднимает папку");
    for (const t of Object.values(project.tasks || {}))
        add(cmdHead(t.run), "самому запускать «" + t.label + "» — это задача станции: её ставит диспетчерская или оркестратор строкой ПРОГНАТЬ");
    return out;
}

/** text — содержимое файла правил → [{ n, line, why }] (n — номер строки с 1; одна находка на строку). */
export function rulesLint(text, project = PROJECT) {
    const rules = staleRules(project), out = [];
    String(text || "").split(/\r?\n/).forEach((line, i) => {
        if (NEGATED.test(line))
            return;
        const hit = rules.find((r) => line.includes(r.cmd));
        if (hit)
            out.push({ n: i + 1, line: line.trim().slice(0, 160), why: hit.why });
    });
    return out;
}

export function rulesTask({ file, findings }) {
    return ["Диспетчерская: общие правила сессий эпика (" + file.replace(/\\/g, "/") + ") расходятся с тем, как устроены слоты: по ним агенты слотов сами готовят папку и гоняют проверки, которые делает диспетчерская, получают ложное красное и встают.",
        "Устаревшие строки:", ...findings.map((f) => "- стр. " + f.n + ": «" + f.line + "» — " + f.why),
        "Перепиши раздел «Первые шаги» и эти строки по образцу " + RULES_TEMPLATE.replace(/\\/g, "/") + " (разделы «Первые шаги» и «Проверки» — как там; своё эпика оставь). Это твой файл плана — правка твоя, слотам пересылать не нужно: они читают файл сами, а абзац «ОКРУЖЕНИЕ ПАПКИ» в их подсказке уже говорит то же.",
    ].join("\n");
}

const TOLD_FILE = path.join(DATA, "epic-rules-told.json");
let told = null;
const sha = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

export function epicRulesCheck({ epics = openEpics(), send = null, force = false } = {}) {
    if (DRY && !force)
        return [];
    if (!told)
        told = readJson(TOLD_FILE, {}) || {};
    const out = [];
    for (const e of epics || []) {
        if (!e || e.status === "closed" || !e.orch || !e.orch.path)
            continue;
        const file = path.join(e.orch.path, RULES_REL);
        let text;
        try {
            text = fs.readFileSync(file, "utf8");
        }
        catch {
            continue;
        }
        const findings = rulesLint(text), h = sha(text);
        if (!findings.length || told[e.id] === h)
            continue;
        told[e.id] = h;
        saveJson(TOLD_FILE, told);
        const msg = rulesTask({ file, findings }), key = orchKey(e.id);
        if (send)
            send(key, msg);
        else
            import("./agents.mjs").then((m) => m.sendWhenFree(key, msg)).catch((er) => console.error("правила эпика → оркестратору:", er.message));
        logEvent("epic.rules.stale", { epic: e.id, lines: findings.map((f) => f.n) });
        out.push(e.id);
    }
    return out;
}
