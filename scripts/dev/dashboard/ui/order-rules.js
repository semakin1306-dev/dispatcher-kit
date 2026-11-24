// order-rules.js — порядок влива слотов в staging по зависимостям: серые — без зависимостей, в любом порядке; цветные —
// в цепочках с номером волны влива; кого можно вливать прямо сейчас. Лист без импортов — его же проверяет node --test.
const isStageDone = (t, id) => !!((t.stages || []).find((s) => s.id === id) || {}).done;
const num = (tag) => Number(/\d+/.exec(String(tag || ""))?.[0] || 1e9);

export function buildOrderMap(trees) {
    const slots = (trees || []).filter((t) => t && t.kind !== "orch" && !/^orchestrator/.test(String(t.key)) && !t.archived && (!t.readOnly || t.hasCode || t.ahead > 0 || t.dirtyTracked));
    const keys = new Set(slots.map((t) => t.key));
    const mergedOf = (t) => isStageDone(t, "staging") && isStageDone(t, "commit") && !(t.ahead > 0) && !t.dirtyTracked && !(t.train && (t.wagonsView || []).some((w) => w.tone !== "done"));
    const node = (t) => ({ key: t.key, tag: t.tag, title: t.title || "", color: t.color || "#8b929c", merged: mergedOf(t), state: mergedOf(t) ? "merged" : !(t.conflict && t.conflict.length) && (t.readyStg || (isStageDone(t, "commit") && (t.ahead > 0) && !t.dirtyTracked)) ? "ready" : "work", openDeps: [], after: [], before: [], external: [], syncing: [], wave: 0, wagons: (t.wagonsView || []).map((w) => w.wave + " — " + w.label) });
    const nodes = new Map(slots.map((t) => [t.key, node(t)]));
    for (const t of slots) {
        const n = nodes.get(t.key);
        if (n.merged)
            continue;
        for (const d of t.deps || []) {
            if (!keys.has(d.key)) {
                if (!d.merged)
                    n.external.push(d.tag || d.key);
                continue;
            }
            const dn = nodes.get(d.key);
            if (dn.merged) {
                if (!d.merged)
                    n.syncing.push(dn.tag);
                continue;
            }
            n.openDeps.push(d.key);
            n.after.push(dn.tag);
            dn.before.push(t.key);
        }
    }
    let cycle = false;
    const mark = new Map();
    const wave = (k) => {
        if (mark.get(k) === 2)
            return nodes.get(k).wave;
        if (mark.get(k) === 1) {
            cycle = true;
            return 0;
        }
        mark.set(k, 1);
        const n = nodes.get(k);
        n.wave = 1 + Math.max(0, ...n.openDeps.map(wave));
        mark.set(k, 2);
        return n.wave;
    };
    const open = [...nodes.values()].filter((n) => !n.merged);
    for (const n of open)
        wave(n.key);
    const byTag = (a, b) => num(a.tag) - num(b.tag);
    const free = open.filter((n) => !n.openDeps.length && !n.before.length).sort(byTag);
    const chained = open.filter((n) => n.openDeps.length || n.before.length);
    const maxW = Math.max(0, ...chained.map((n) => n.wave)), waves = [];
    for (let w = 1; w <= maxW; w++) {
        const m = chained.filter((n) => n.wave === w).sort(byTag);
        if (m.length)
            waves.push({ n: w, nodes: m });
    }
    const merged = [...nodes.values()].filter((n) => n.merged).sort(byTag);
    const blocked = chained.filter((n) => n.openDeps.length);
    return { merged, free, waves, blocked, cycle, counts: { all: slots.length, merged: merged.length, free: free.length, chained: chained.length, waves: waves.length, ready: open.filter((n) => n.state === "ready").length } };
}

export const mayMergeNow = (map) => [...map.free, ...(map.waves[0] ? map.waves[0].nodes : [])].filter((n) => n.state === "ready" && !n.syncing.length);
