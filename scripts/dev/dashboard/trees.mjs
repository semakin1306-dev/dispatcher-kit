// trees.mjs — реестр эпиков и деревьев (слотов) в памяти сервера: TREES, наборы проверок PRESETS и поиск по ключу.
// Только чтение реестра — без подготовки слотов и запуска агентов, чтобы не замыкать импорты.
import { WT, isForeignEpic, loadEpics, orchOf } from "../slots.mjs";
import path from "node:path";
import { S } from "./state.mjs";
import { isTrain } from "./train-rules.mjs";

export const TREES = [];
export const treeByKey = (k) => TREES.find((t) => t.key === k);
export const orchKey = (id) => "orchestrator@" + id;
export const isOrch = (k) => typeof k === "string" && k.startsWith("orchestrator@");
export const epicById = (id) => S.EPICS.find((e) => e.id === id) || null;
export const openEpics = () => S.EPICS;
export const viewEpic = () => S.EPIC;

export const setViewEpic = (e) => {
    S.EPIC = e;
};

export const PRESETS = {};
/** Слот только читает код (разведка, add-slot --read-only): ему не нужны сборка, тесты, гарды и влив. */
export const isReconSlot = (x) => x.readOnly === true;

export function applyEpics() {
    const reg = loadEpics();
    S.EPICS = reg.epics.filter((e) => e.status !== "closed" && !isForeignEpic(e));
    S.EPIC = epicById(reg.active) || S.EPICS[0] || null;
    TREES.length = 0;
    for (const k of Object.keys(PRESETS))
        delete PRESETS[k];
    for (const epic of S.EPICS) {
        const orch = orchOf(epic);
        TREES.push({ key: orchKey(epic.id), kind: "orch", epic: epic.id, tag: orch.tag, emoji: orch.emoji, title: orch.title, color: orch.color, path: path.normalize(epic.orch.path), readOnly: false }, ...epic.slots.filter((x) => !x.archived).map((x) => ({ key: x.slot, kind: "slot", epic: epic.id, tag: x.tag, emoji: x.emoji, title: x.title, color: x.color, path: path.join(WT, x.slot), plannedBranch: x.branch, area: x.area || null, readOnly: isReconSlot(x),
            ...(isTrain(x) ? { train: true, trainArea: x.trainArea || null, wagons: JSON.parse(JSON.stringify(x.wagons || [])) } : {}) })));
        PRESETS[orchKey(epic.id)] = [];
        for (const x of epic.slots)
            PRESETS[x.slot] = JSON.parse(JSON.stringify(isTrain(x) ? trainCur.get(x.slot) || ((x.wagons || [])[0] || {}).presets || [] : x.presets || []));
    }
}

const trainCur = new Map(), trainWave = new Map();

export function setTrainPresets(key, list, wave = "") {
    const v = JSON.parse(JSON.stringify(list || []));
    trainCur.set(key, v);
    if (wave)
        trainWave.set(key, wave);
    if (key in PRESETS)
        PRESETS[key] = v;
}

export const trainWaveOf = (key) => trainWave.get(key) || "";
export const applyEpic = () => applyEpics();
export const epicSlots = () => S.EPICS.flatMap((e) => e.slots.map((x) => Object.assign(x, { __epic: e.id })));

export const orchOfKey = (key) => {
    const id = epicOfKey(key);
    return id ? orchKey(id) : S.EPIC ? orchKey(S.EPIC.id) : null;
};

export const epicsReg = () => {
    if (!S.epicsCache.v || Date.now() - S.epicsCache.at > 5000)
        S.epicsCache = { at: Date.now(), v: loadEpics() };
    return S.epicsCache.v;
};

export function epicOfKey(key) {
    if (!key || /^orchestrator-/.test(key))
        return null;
    if (isOrch(key))
        return key.slice("orchestrator@".length);
    if (key === "orchestrator")
        return S.EPIC ? S.EPIC.id : null;
    const tt = TREES.find((t) => t.key === key);
    if (tt && tt.epic)
        return tt.epic;
    const e = epicsReg().epics.find((x) => x.slots.some((z) => z.slot === key));
    return e ? e.id : null;
}
