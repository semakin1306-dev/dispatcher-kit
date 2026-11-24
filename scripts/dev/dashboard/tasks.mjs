// tasks.mjs — каталог задач проверок из конфига проекта (PROJECT.tasks) и сборка ветки. Задача с вводом идёт без
// оболочки: команда разбивается на слова, ввод подставляется одним аргументом; задача без ввода — строкой в оболочку.
// Сборка — хук проекта buildSteps, иначе задача `build` из конфига.
import fs from "node:fs";
import path from "node:path";
import { PROJECT, fwd } from "../slots.mjs";
import { loadProjectCode } from "../project.mjs";
import { isOrch } from "./trees.mjs";
import { git, untrackedList } from "./git.mjs";
import { setParseHook } from "./parsers.mjs";

/** Функции из dispatcher.project.mjs (buildSteps, parseOutput, remoteCmd…). Ошибка в файле проекта не роняет сервер. */
export const PROJECT_HOOKS = await loadProjectCode().then((r) => {
    for (const w of r.warnings) console.error(w);
    return r.hooks;
}).catch((e) => {
    console.error("dispatcher.project.mjs не загружен:", e.message);
    return {};
});
if (PROJECT_HOOKS.parseOutput)
    setParseHook(PROJECT_HOOKS.parseOutput);

export const INPUT_RE = /^[^\r\n\0]{1,8000}$/;
const INPUT_MARK = "{input}";

/**
 * Команда → слова, как их понял бы sh: пробелы делят, кавычки "…" и '…' держат слово целым, `\` в кавычках "…"
 * и вне кавычек экранирует следующий знак. Переменных, подстановок и операторов оболочки нет — это просто слова.
 */
export function splitWords(cmd) {
    const out = [];
    let cur = "", has = false, q = "";
    const s = String(cmd);
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (q) {
            if (c === q)
                q = "";
            else if (c === "\\" && q === '"' && i + 1 < s.length && /["\\]/.test(s[i + 1]))
                cur += s[++i];
            else
                cur += c;
            continue;
        }
        if (c === '"' || c === "'") {
            q = c;
            has = true;
        }
        else if (/\s/.test(c)) {
            if (has)
                out.push(cur);
            cur = "";
            has = false;
        }
        else if (c === "\\" && i + 1 < s.length) {
            cur += s[++i];
            has = true;
        }
        else {
            cur += c;
            has = true;
        }
    }
    if (q)
        throw new Error("незакрытая кавычка в команде: " + cmd);
    if (has)
        out.push(cur);
    return out;
}

/** Слова команды с подставленным вводом: ввод входит в слово целиком и остаётся одним аргументом. */
export function argvOf(run, input) {
    const words = splitWords(run);
    if (!words.length)
        throw new Error("пустая команда задачи");
    return words.map((w) => w.split(INPUT_MARK).join(String(input)));
}

/** Описание задачи из нормализованного конфига → запись каталога. */
function taskOf(t) {
    const base = {
        id: t.id, label: t.label, group: t.group, lane: t.lane, gate: t.gate, parser: t.parser, timeoutMin: t.timeoutMin,
        run: t.run, sub: t.cwd || "",
    };
    if (!t.input)
        return { ...base, input: null, text: t.run };
    argvOf(t.run, "");
    return { ...base, input: { label: t.input.label, ph: t.input.placeholder || "" }, argv: (i) => argvOf(t.run, i) };
}

/** Каталог задач: id → запись. Задача `build` без хука сборки — из конфига; с хуком — шаги считает хук по диффу ветки. */
export const TASKS = Object.fromEntries(Object.values(PROJECT.tasks).map((t) => [t.id, taskOf(t)]));
if (PROJECT_HOOKS.buildSteps) {
    const b = TASKS.build || {};
    TASKS.build = { id: "build", label: b.label || "Сборка ветки", group: b.group || "Сборка", lane: b.lane || "main", gate: false, parser: "exit-code",
        timeoutMin: b.timeoutMin || 30, run: "", sub: "", input: null, dynamic: buildSteps };
}

/** Предел времени задачи, минуты. */
export const timeLimitMin = (taskId) => (TASKS[taskId] && TASKS[taskId].timeoutMin) || 0;

/** Шаг прогона задачи: без ввода — строка для оболочки; с вводом — команда и аргументы, без оболочки. */
export function stepOfTask(task, cwdRoot, input) {
    const cwd = task.sub ? path.join(cwdRoot, task.sub) : cwdRoot;
    if (task.argv) {
        const inp = String(input ?? "");
        if (!INPUT_RE.test(inp))
            throw new Error("«" + task.label + "»: ввод пустой, слишком длинный или с переводом строки");
        const [cmd, ...args] = task.argv(inp);
        return { cmd, args, show: [cmd, ...args].join(" "), cwd };
    }
    if (task.text)
        return { text: task.text, show: task.text, cwd };
    return { show: task.label, cwd, js: async () => {
            throw new Error("«" + task.label + "»: у задачи нет своей команды — её шаги считает сборка ветки");
        } };
}

// ───────────────────────────── сборка ветки ─────────────────────────────

/** Файлы, которые ветка меняет против точки ответвления от staging, вместе с неотслеживаемыми. */
export async function changedFiles(cwd) {
    const mb = (await git(cwd, ["merge-base", "staging", "HEAD"])).out || "staging";
    const [diff, untr] = await Promise.all([git(cwd, ["diff", "--name-only", mb], 60000), untrackedList(cwd)]);
    return [...new Set([...diff.out.split("\n"), ...untr.files].map((x) => fwd(x.trim())).filter(Boolean))];
}

/** Шаблон пути области (`apps/api/**`, `src/*.ts`, `README.md`) → регулярка. */
export function globRe(glob) {
    let g = fwd(glob).replace(/^\/+/, ""), re = "";
    for (let i = 0; i < g.length; i++) {
        const c = g[i];
        if (c === "*" && g[i + 1] === "*") {
            i++;
            if (g[i + 1] === "/") {
                i++;
                re += "(?:.*/)?";
            }
            else
                re += ".*";
        }
        else if (c === "*")
            re += "[^/]*";
        else if (c === "?")
            re += "[^/]";
        else
            re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp("^" + re + "$");
}
const globCache = new Map();
/** Подходит ли путь под один из шаблонов. */
export function matchAny(file, globs) {
    return globs.some((g) => {
        let re = globCache.get(g);
        if (!re)
            globCache.set(g, (re = globRe(g)));
        return re.test(file);
    });
}

/** Области проекта со сборкой (`build: true`), которых касаются файлы. */
export const buildAreasOf = (files) => Object.values(PROJECT.areas).filter((a) => a.build && files.some((f) => matchAny(f, a.paths)));

/** Шаг из ответа хука: строка — команда для оболочки; объект { run, cwd? } — то же в своей папке. */
function hookStep(s, cwd) {
    if (typeof s === "string")
        return { text: s, show: s, cwd };
    if (s && typeof s.run === "string") {
        const sub = s.cwd ? path.join(cwd, s.cwd) : cwd;
        return { text: s.run, show: s.run, cwd: sub };
    }
    throw new Error("buildSteps проекта: шаг — строка или { run, cwd? }");
}

/** Шаги сборки ветки: хук проекта по списку изменённых файлов, иначе задача `build` из конфига; null — собирать нечего. */
export async function buildSteps(cwd) {
    const changed = await changedFiles(cwd);
    if (PROJECT_HOOKS.buildSteps) {
        const r = await PROJECT_HOOKS.buildSteps(fwd(cwd), changed);
        return Array.isArray(r) && r.length ? r.map((s) => hookStep(s, cwd)) : null;
    }
    if (!PROJECT.tasks.build || !buildAreasOf(changed).length)
        return null;
    return [stepOfTask(TASKS.build, cwd, "")];
}

export const buildCache = new Map();

/** Нужна ли слоту сборка и что собирается. Кешируется по состоянию рабочей копии. */
export async function buildNeed(t) {
    if (!t.exists || isOrch(t.key) || t.readOnly || !TASKS.build)
        return { needed: false, what: "" };
    const key = `${t.key}|${t.tree}|${t.dirtyTracked}|${t.dirtyUntracked}|${t.ahead}`;
    const hit = buildCache.get(t.key);
    if (hit && hit.key === key)
        return hit.v;
    let v;
    if (PROJECT_HOOKS.buildSteps) {
        const steps = await buildSteps(t.path).catch(() => null);
        v = { needed: !!steps, what: steps ? steps.map((s) => s.show).join(", ") : "" };
    }
    else {
        const areas = buildAreasOf(await changedFiles(t.path));
        v = { needed: areas.length > 0, what: areas.map((a) => a.title).join(", ") };
    }
    buildCache.set(t.key, { key, v });
    return v;
}

/** Как собирается ветка — строка для страницы. */
export const buildHow = () => PROJECT_HOOKS.buildSteps ? "шаги считает buildSteps из dispatcher.project.mjs по изменённым файлам ветки"
    : TASKS.build ? "задача «" + TASKS.build.label + "» (" + TASKS.build.run + "), когда правка касается областей со сборкой"
        : "сборки нет: в конфиге нет задачи `build` и хука buildSteps";

// ───────────────────────────── запуск шага с вводом на Windows ─────────────────────────────
// Без оболочки Windows запускает только .exe и .com; пускатели .cmd и .bat (npx, npm, jest из node_modules/.bin) Node
// без оболочки не запускает вовсе, а через cmd.exe ввод стал бы командой. Поэтому такой шаг идёт через bash (Git Bash)
// с каждым словом в одинарных кавычках: внутри них sh ничего не толкует, ввод остаётся одним аргументом.

/** Слово в одинарных кавычках sh. */
export const shQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

/** Найти исполняемый файл по PATH с расширениями PATHEXT (только Windows). */
export function whichWin(cmd, env = process.env) {
    if (/[\\/]/.test(cmd))
        return fs.existsSync(cmd) ? cmd : "";
    const exts = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    const hasExt = /\.[A-Za-z0-9]+$/.test(cmd);
    for (const dir of String(env.PATH || env.Path || "").split(";").filter(Boolean)) {
        for (const e of hasExt ? [""] : exts) {
            const p = path.join(dir, cmd + e);
            if (fs.existsSync(p))
                return p;
        }
    }
    return "";
}

/** Путь к bash на Windows: DISPATCHER_BASH, иначе Git for Windows в обычных местах. */
export function findBash(env = process.env) {
    const c = [env.DISPATCHER_BASH, "C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe", path.join(env.LOCALAPPDATA || "", "Programs/Git/bin/bash.exe")];
    return c.find((p) => p && fs.existsSync(p)) || "";
}

/**
 * Как запустить шаг { cmd, args } без оболочки: { file, args }. На Windows пускатель .cmd/.bat идёт через bash с
 * кавычками sh; bash не найден — ошибка с подсказкой, а не запуск через cmd.exe.
 */
export function launchOf(step, { platform = process.platform, env = process.env, which = whichWin, bash = findBash } = {}) {
    if (platform !== "win32")
        return { file: step.cmd, args: step.args };
    const exe = which(step.cmd, env);
    if (!exe || !/\.(bat|cmd)$/i.test(exe))
        return { file: step.cmd, args: step.args };
    const sh = bash(env);
    if (!sh)
        throw new Error("«" + step.cmd + "» на Windows — пускатель " + path.extname(exe) + ": его ввод можно передать только через bash. Поставьте Git for Windows или задайте DISPATCHER_BASH.");
    return { file: sh, args: ["-c", [step.cmd, ...step.args].map(shQuote).join(" ")] };
}
