// run.js — запуск прогонов с кнопок: ворота сервера (уже зелёное на этом коде не ставится), пачка наборов, тексты итога,
// сборка запроса из полей ввода.
import { IN, S } from "./state.js";
import { call } from "./core.js";
import { inKey, inVal, treeOf } from "./data.js";

export async function runAsk(p, ask = {}) {
    const j = await call("/api/run", p);
    if (!(j && j.gated && /закоммичена/.test(j.message || "")))
        return j;
    if (ask.ok === undefined)
        ask.ok = confirm(j.message + "\n\nВсё равно запустить?");
    return ask.ok ? call("/api/run", { ...p, force: true }) : j;
}

export async function runMany(list) {
    const r = { q: 0, sk: 0, nar: 0, why: [] };
    const ask = {};
    for (const p of list) {
        const j = await runAsk(p, ask);
        if (j && j.gated) {
            r.sk++;
            r.why.push(j.message);
            if (/красн|упал|fail/i.test(String(j.message || "")))
                r.skRed = (/\bj\d+\b/.exec(String(j.message || "")) || [])[0] || "прошлый прогон";
        }
        else if (j && j.notNeeded)
            r.sk++;
        else {
            r.q++;
            if (j && j.narrowed)
                r.nar++;
        }
    }
    return r;
}

export const manyMsg = (what) => (r) => (r.q ? "В очередь: " + r.q + " прогон(а)" + (what ? " — " + what : "") + (r.nar ? " (сужено до незелёных спек: " + r.nar + ")" : "") : "Ничего не запущено") + (r.sk ? "; пропущено " + r.sk + " — " + (r.skRed ? "на этом коде уже есть красный итог (" + r.skRed + "): код не менялся, повтор ничего не даст; прогнать всё равно — Shift+клик" : "уже зелёные на этом коде") : "");
export const started = (j) => j.notNeeded || j.gated || j.narrowed ? j.message : `Запущено: ${j.label}${j.input ? " · " + j.input : ""} (${j.id})${j.status === "waiting" ? " — ждёт память" : j.pos ? " — в очереди №" + j.pos : ""}`;

export function runPayload(tree, task, preset) {
    const def = S.tasks[task], t = treeOf(tree);
    const input = def.input ? (IN[inKey(tree, task)] ?? inVal(t, task, preset)) : "";
    if (def.input && !String(input).trim())
        throw new Error("Нужен ввод: " + def.input.label);
    return { tree, task, input };
}
