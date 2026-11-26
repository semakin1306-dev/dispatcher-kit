#!/usr/bin/env node
// dash-log.mjs — кусок полного лога прогона диспетчерской по шаблону, номерам строк или выжимкой; с --epic — журнал
// событий эпика. Только чтение.
//   node scripts/dev/dash-log.mjs jNNN [--grep шаблон] [--ctx 2] [--from N] [--to M] [--max 6000] [--digest]
//   node scripts/dev/dash-log.mjs --epic <id> [--hours 48] [--types a,b] [--limit 300] [--json]
// Логи и журнал — в папке данных диспетчерской (DASH_DATA, иначе из конфига проекта).
import "./select-project.mjs"; // первым: выбор проекта дома (--project) до загрузки slots.mjs
import fs from "node:fs";
import path from "node:path";
import { loadEpics } from "./slots.mjs";
import { DATA } from "./dashboard/config.mjs";
import { digestLog, sliceLog } from "./dashboard/digest.mjs";
import { journalCounts, journalLine, journalOf } from "./dashboard/epic-journal.mjs";

const argv = process.argv.slice(2), id = argv.find((a) => /^j\d+$/.test(a));

const opt = (k, d) => {
    const i = argv.indexOf("--" + k);
    if (i >= 0 && argv[i + 1] !== undefined)
        return argv[i + 1];
    const e = argv.find((a) => a.startsWith("--" + k + "="));
    return e ? e.slice(k.length + 3) : d;
};

if (argv.includes("--epic")) {
    const epicId = opt("epic", ""), data = DATA;
    const reg = loadEpics();
    const ep = (reg.epics || []).find((e) => e.id === epicId);
    if (!ep) {
        console.error("нет эпика " + epicId + " в реестре");
        process.exit(1);
    }
    const from = opt("hours", "") ? Date.now() - Number(opt("hours", "0")) * 3600e3 : 0;
    const evs = fs.readFileSync(path.join(data, "events.jsonl"), "utf8").split("\n").map((l) => {
        try {
            return JSON.parse(l);
        }
        catch {
            return null;
        }
    }).filter(Boolean);
    const out = journalOf(evs, { epic: ep.id, keys: (ep.slots || []).map((x) => x.slot), from, types: opt("types", "") ? opt("types", "").split(",") : null, limit: Number(opt("limit", "0")) });
    if (argv.includes("--json"))
        console.log(JSON.stringify({ epic: ep.id, n: out.length, counts: journalCounts(out) }, null, 1));
    else {
        console.log("журнал эпика " + ep.id + ": " + out.length + " событий");
        for (const e of out)
            console.log(journalLine(e));
    }
    process.exit(0);
}

if (!id) {
    console.error("использование: node scripts/dev/dash-log.mjs jNNN [--grep шаблон] [--ctx 2] [--from N] [--to M] [--max 6000] [--digest]");
    process.exit(2);
}

const file = path.join(DATA, "logs", id + ".log");
let text;

try {
    text = fs.readFileSync(file, "utf8");
}
catch {
    console.error("нет лога " + file + " (логи старше 7 суток удаляются)");
    process.exit(1);
}

if (argv.includes("--digest")) {
    console.log(digestLog(text, { budget: Number(opt("max", 2500)) }).text);
    process.exit(0);
}

const r = sliceLog(text, { grep: opt("grep", ""), ctx: Number(opt("ctx", 2)), from: Number(opt("from", 1)), to: Number(opt("to", 0)), max: Number(opt("max", 6000)) });
console.log(r.text);
