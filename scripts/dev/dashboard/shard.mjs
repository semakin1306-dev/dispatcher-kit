// shard.mjs — точка подключения модуля машин: ядро зовёт shardApi(), модуль `machines` при включении ставит свою
// реализацию через setShardApi(). По умолчанию стоит реализация «удалённых машин нет»: мест не даёт, прогон удалённо
// не запускает (с причиной). Сброс слота — всегда в его здешней папке: агент слота работает только на этой машине.
import { PROJECT } from "../slots.mjs";
import { git } from "./git.mjs";

const OFF_WHY = "удалённых машин нет: модуль machines выключен или в конфиге нет машин с ssh";

const labelOf = (id) => (id === "local" ? PROJECT.machines.local.label : (PROJECT.machines[id] || {}).label || String(id || ""));

/**
 * Сброс ветки слота в его здешней папке: папка та же, что видела проверка (HEAD, ветка, чисто) → теги-страховки →
 * reset --hard на целевой коммит.
 */
export async function localSlotReset({ branch, pcPath, target, expect = {}, tags = [] }, log = () => { }) {
    const [h, sr, st] = await Promise.all([git(pcPath, ["rev-parse", "HEAD"]), git(pcPath, ["symbolic-ref", "-q", "HEAD"]), git(pcPath, ["status", "--porcelain=v1"], 120000)]);
    if (!h.ok || h.out !== expect.pcHead || sr.out !== "refs/heads/" + branch || !st.ok || st.out)
        throw new Error("папка слота изменилась с проверки — повторите сброс; ничего не тронуто");
    for (const t of tags) {
        const r = await git(pcPath, ["tag", t.name, t.sha]);
        if (!r.ok)
            throw new Error("тег-страховка " + t.name + " не поставлен: " + r.err.slice(0, 160) + " — ничего не тронуто");
        log("страховка: " + t.name + " → " + t.sha.slice(0, 10) + " (" + t.what + ")\n");
    }
    const r = await git(pcPath, ["reset", "-q", "--hard", target], 180000);
    if (!r.ok)
        throw new Error("папка слота не сброшена: " + r.err.slice(0, 160));
    log("ветка " + branch + " и папка — на " + String(target).slice(0, 10) + "\n");
    return { ok: true };
}

/** Реализация «удалённых машин нет»: каждый метод, который зовёт ядро, отвечает безопасно. */
export function noMachinesApi() {
    return {
        on: false,
        why: OFF_WHY,
        slotFree: () => false,
        slotOnline: () => false,
        slotAnyOnline: () => false,
        slotReserve: () => -1,
        slotMachineOf: () => null,
        slotWhyOf: () => OFF_WHY,
        slotRelease: () => { },
        slotRun: async () => {
            throw new Error(OFF_WHY);
        },
        slotCancel: async () => false,
        machineLabel: labelOf,
        fullRunOn: () => false,
        fullRunLeft: () => 0,
        slotRampWait: () => false,
        slotPrune: async () => ({ none: true }),
        hostHealth: () => ({}),
        load: () => ({}),
        pub: () => ({ on: false, why: OFF_WHY, run: null, machines: [] }),
        summary: () => null,
        log: async () => null,
        start: async () => ({ ok: false, error: OFF_WHY }),
        cancel: async () => ({ ok: false, error: OFF_WHY }),
        clean: async () => ({ ok: false, error: OFF_WHY }),
        check: async () => ({ ok: false, error: OFF_WHY }),
    };
}

let api = noMachinesApi();
/** Текущая реализация машин (никогда не null). */
export const shardApi = () => api;
/** Поставить реализацию машин; без аргумента — вернуть «удалённых машин нет». */
export function setShardApi(x) {
    api = x || noMachinesApi();
}
