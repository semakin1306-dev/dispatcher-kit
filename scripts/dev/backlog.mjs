#!/usr/bin/env node
// backlog.mjs — команда бэклога для оркестратора и человека: list, show, add, set (отказ — только с причиной), triage
// (карточки ретро последнего закрытого эпика без решения; есть такие — код 1), prompt.
import "./select-project.mjs"; // первым: выбор проекта дома (--project) до загрузки slots.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fwd, loadEpics } from "./slots.mjs";
import { DATA as DASH_DATA } from "./dashboard/config.mjs";
import { createItem, listItems, parseSets, readItem, updateItem } from "./dashboard/backlog-store.mjs";
import { STATUSES, STATUS_WORD, backlogBashCheck, retroGateWhy, retroTriage } from "./dashboard/backlog-rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Папка данных — та же, что у сервера диспетчерской (config.mjs); элементы — в её подпапке backlog. */
export const DATA = DASH_DATA, DIR = path.join(DATA, "backlog");
const argv = process.argv.slice(2), cmd = argv[0];

const opt = (k) => {
    const i = argv.indexOf("--" + k);
    if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--"))
        return argv[i + 1];
    const e = argv.find((a) => a.startsWith("--" + k + "="));
    return e ? e.slice(k.length + 3) : "";
};

const flag = (k) => argv.includes("--" + k);
const VAL = new Set(["--status", "--area", "--epic", "--source", "--reason", "--wave"]), pos = [];

for (let i = 1; i < argv.length; i++) {
    if (VAL.has(argv[i])) {
        i++;
        continue;
    }
    if (!argv[i].startsWith("--"))
        pos.push(argv[i]);
}

const USAGE =
    "использование: node scripts/dev/backlog.mjs list [--status S[,S]] [--area A] [--epic E] [--json] | " +
    'show BL-NNNN | add "текст" [--area a] [--source s] | set BL-NNNN поле=значение… [--status S] ' +
    '[--reason "…"] | triage [--epic E] [--json] | check-cmd "<команда>" | prompt\nстатусы: ' +
    STATUSES.join(" | ") +
    " (rejected — отказ, только с --reason)";

const die = (m, code = 1) => {
    console.error(m);
    process.exit(code);
};

const line = (it) =>
    [
        it.id,
        (STATUS_WORD[it.status] || it.status) + " (" + it.status + ")" + (it.reason ? ": " + it.reason : ""),
        it.area.length ? it.area.join(", ") : "—",
        it.epic ? "эпик " + it.epic + (it.wave ? " · " + it.wave : "") : "без эпика",
        it.title,
    ].join(" · ");

export function filterItems(items, { status = "", area = "", epic = "" } = {}) {
    const st = status ? status.split(",").map((s) => s.trim()).filter(Boolean) : null;
    return items.filter((it) => (!st || st.includes(it.status)) && (!area || it.area.some((a) => a.toLowerCase().includes(area.toLowerCase()))) && (!epic || it.epic === epic));
}

async function main() {
    if (!cmd || cmd === "help" || flag("help")) {
        console.log(USAGE);
        return;
    }
    if (cmd === "list") {
        const st = opt("status");
        if (st && st.split(",").some((s) => !STATUSES.includes(s.trim())))
            die("статус: " + STATUSES.join(" | "), 2);
        const items = filterItems(listItems(DIR), { status: st, area: opt("area"), epic: opt("epic") });
        if (flag("json")) {
            console.log(JSON.stringify(items.map(({ meta, ...x }) => ({ ...x, path: fwd(path.join(DIR, x.file)) })), null, 2));
            return;
        }
        if (!items.length) {
            console.log("пусто (" + fwd(DIR) + ")");
            return;
        }
        for (const it of items)
            console.log(line(it) + "\n   " + fwd(path.join(DIR, it.file)) + (it.planText ? "" : it.status === "researched" ? "\n   ⚠ нет раздела «Предзаготовка плана»" : ""));
        return;
    }
    if (cmd === "show") {
        const id = pos[0] || die("нужен BL-NNNN", 2);
        let r;
        try {
            r = readItem(DIR, id);
        }
        catch (e) {
            die(e.message);
        }
        if (flag("json")) {
            const { meta, ...x } = r.item;
            console.log(JSON.stringify({ ...x, path: fwd(r.path) }, null, 2));
        }
        else
            console.log(fwd(r.path) + "\n\n" + r.text);
        return;
    }
    if (cmd === "add") {
        const text = pos.join(" ").trim() || die("нужен текст", 2);
        const r = createItem(DIR, { text, area: opt("area"), source: opt("source") });
        console.log(r.item.id + " добавлен: " + fwd(r.path));
        return;
    }
    if (cmd === "triage") {
        const items = listItems(DIR), tr = retroTriage(items, loadEpics().epics, opt("epic"));
        if (flag("json")) {
            console.log(JSON.stringify(tr, null, 2));
            return;
        }
        if (!tr) {
            console.log("закрытых эпиков нет — разбирать нечего");
            return;
        }
        if (!tr.total) {
            console.log("ретро эпика «" + tr.title + "» (" + tr.epic + ") карточек не заводило");
            return;
        }
        if (!tr.open.length) {
            console.log("ретро эпика «" + tr.title + "» (" + tr.epic + "): все " + tr.total + " карточек разобраны — новый эпик можно заводить");
            return;
        }
        console.log(retroGateWhy(tr, fwd(path.join(HERE, "backlog.mjs"))) + "\n");
        for (const x of tr.open) {
            const it = items.find((y) => y.id === x.id);
            console.log(line(it) + "\n   " + fwd(path.join(DIR, it.file)));
        }
        process.exitCode = 1;
        return;
    }
    if (cmd === "set") {
        const id = pos[0] || die("нужен BL-NNNN", 2), sets = parseSets(pos.slice(1));
        for (const k of ["status", "reason", "epic", "wave", "area", "source"]) {
            const v = opt(k);
            if (v)
                sets[k] = v;
        }
        if (!Object.keys(sets).length)
            die("нужно поле=значение или --status/--reason (" + "status, reason, area, epic, wave, source, research, title)", 2);
        let r;
        try {
            r = updateItem(DIR, id, { set: sets });
        }
        catch (e) {
            die(e.message, e.code === 404 ? 1 : 2);
        }
        console.log((r.changed ? "сохранено: " : "без изменений: ") + line(r.item));
        return;
    }
    if (cmd === "check-cmd") {
        const c = pos.join(" ");
        const w = backlogBashCheck(c, { dir: fwd(DIR), data: fwd(DATA), cli: fwd(path.join(HERE, "backlog.mjs")) });
        console.log(w ? "вопрос владельцу: " + w : "можно без вопроса");
        process.exitCode = w ? 1 : 0;
        return;
    }
    if (cmd === "prompt") {
        const A = await import("./dashboard/backlog-agent.mjs");
        console.log(
            "рабочая папка агента бэклога: " +
                fwd(A.BACKLOG_WT) +
                "\n\n── постоянная подсказка агента бэклога ──\n" +
                A.backlogPrompt() +
                "\n\n── раздел оркестратора «Бэклог» ──\n" +
                A.orchBacklog(),
        );
        process.exit(0);
    }
    die("нет команды " + cmd + "\n" + USAGE, 2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main().catch((e) => die(e.message));
