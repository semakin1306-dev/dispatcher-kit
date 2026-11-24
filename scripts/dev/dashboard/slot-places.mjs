// slot-places.mjs — чистые правила мест проверок: на какой машине и в какое место поставить проверку. Порядок машин —
// удалённые из конфига, затем эта машина (только после ожидания и при свободной памяти); пороги памяти и ЦП — разумные
// умолчания.
//
// Место — номер воркера машины (0…workers-1), общий для всех дорожек: на одном месте идёт одна проверка. Вид места (`kind`)
// — дорожка задачи; машина берёт дорожку, если она в её `lanes` (null — любую). Эта машина при наличии удалённых —
// последняя: задача сначала ждёт удалённое место SPILL_MS, чтобы не нагружать машину, на которой работает человек.
import { PROJECT } from "../slots.mjs";

export const SPILL_MS = 120000;
export const FRESH_MS = 20000;

/** Пороги по умолчанию: удалённая машина — по рабочим местам с разгоном; эта — от первого места с запасом памяти. */
export const REMOTE_RULE = { base: 1, firstFreeGB: 0, extraFreeGB: 4, cpuMax: 75, rampMs: 30000 };
export const LOCAL_RULE = { base: 1, firstFreeGB: 4, firstCpuMax: 80, extraFreeGB: 4, cpuMax: 70, rampMs: 30000 };
/** Задаче с пометкой heavy (сборка, база) на первом месте нужно больше свободной памяти. */
export const HEAVY_EXTRA_GB = 2;

/** Профили мест по машинам конфига: { tiers, profiles }. Порядок — удалённые машины, затем `local`. */
export function profilesOf(machines) {
    const ids = Object.keys(machines || {});
    const remote = ids.filter((id) => id !== "local");
    const tiers = [...remote, ...(ids.includes("local") ? ["local"] : [])];
    const profiles = {};
    for (const id of tiers) {
        const m = machines[id], local = id === "local";
        const n = Math.max(1, Number(m.workers) || 1);
        profiles[id] = {
            label: m.label || id, lanes: m.lanes || null, places: Array.from({ length: n }, (_, i) => i),
            rule: local ? LOCAL_RULE : REMOTE_RULE, spillMs: local && remote.length ? SPILL_MS : 0,
        };
    }
    return { tiers, profiles };
}

const fromConfig = profilesOf(PROJECT.machines);
export const TIERS = fromConfig.tiers;
export const PROFILES = fromConfig.profiles;

export const machineLabel = (mk, profiles = PROFILES) => (profiles[mk] || {}).label || mk;
export const STRAIN_IO_SOFT = 256, STRAIN_IO_HARD = 1024;

/** Перегрузка машины: обмен с подкачкой, нехватка памяти при занятой подкачке, средняя нагрузка на ядро — "hard" | "soft" | "". */
export function strain(ld) {
    if (!ld)
        return "";
    const sw = ld.swapTotalGB > 0 ? (ld.swapUsedGB || 0) / ld.swapTotalGB : 0, cores = Array.isArray(ld.cores) && ld.cores.length ? ld.cores.length : 0;
    const load = Array.isArray(ld.loadAvg) ? ld.loadAvg[0] || 0 : 0, lr = cores ? load / cores : 0, io = ld.swapIOps || 0;
    const free = ld.memTotalGB > 0 ? ld.memTotalGB - (ld.memUsedGB || 0) : null, tight = (gb) => sw >= 0.5 && free !== null && free < gb;
    if (io >= STRAIN_IO_HARD || tight(1.5) || lr >= 3)
        return "hard";
    if (io >= STRAIN_IO_SOFT || tight(3) || lr >= 1.5)
        return "soft";
    return "";
}

/**
 * kind — дорожка задачи; ctx = { now, fullRun, jobAgeMs, heavy, needs, only, machines, tiers?, profiles? }
 *   machines — { <машина>: { online, off, ld: { at, cpu, memTotalGB, memUsedGB, … }, caps, reserved: [{ kind, idx, at }] } };
 *   needs — что задаче нужно от машины (caps); only — список машин, которыми задача ограничена.
 * → { mk, idx } | null
 */
export function pickPlace(kind, ctx) {
    const { now = Date.now(), fullRun = false, jobAgeMs = 0, heavy = false, needs = [], only = null, machines = {}, tiers = TIERS, profiles = PROFILES } = ctx || {};
    if (fullRun)
        return null;
    for (const mk of tiers) {
        if (only && !only.includes(mk))
            continue;
        const P = profiles[mk], m = machines[mk];
        if (!P || !m || m.off || !m.online || !P.places.length)
            continue;
        if (P.lanes && !P.lanes.includes(kind))
            continue;
        if (heavy && (m.caps || {}).heavy === false)
            continue;
        if (needs.some((n) => !(m.caps || {})[n]))
            continue;
        if (P.spillMs && jobAgeMs < P.spillMs)
            continue;
        const ld = m.ld;
        if (!ld || !ld.at || now - ld.at > FRESH_MS)
            continue;
        const rule = P.rule, free = (ld.memTotalGB || 0) - (ld.memUsedGB || 0), cpu = ld.cpu || 0;
        const res = m.reserved || [], busy = new Set(res.map((x) => x.idx));
        const idx = P.places.find((i) => !busy.has(i));
        if (idx === undefined)
            continue;
        const st = strain(ld);
        if (st === "hard")
            continue;
        if (st === "soft" && res.length >= rule.base)
            continue;
        if (res.length === 0) {
            if (free < (rule.firstFreeGB || 0) + (heavy ? HEAVY_EXTRA_GB : 0) || cpu >= (rule.firstCpuMax || 101))
                continue;
        }
        else if (res.length >= rule.base && (free < rule.extraFreeGB || cpu >= rule.cpuMax || res.some((x) => now - (x.at || 0) < rule.rampMs)))
            continue;
        return { mk, idx };
    }
    return null;
}
