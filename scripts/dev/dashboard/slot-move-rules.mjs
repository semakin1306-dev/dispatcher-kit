// slot-move-rules.mjs — чистые правила над реестром эпиков: перенос слота в другой эпик (имя и ветка сохраняются,
// меняются метка и цвет) и снятие слота из реестра со снятием зависимостей соседей. Без файлов и git — команды epic.mjs
// только читают реестр, зовут эти функции и сохраняют.
export const PALETTE = [["🟩", "#16a34a"], ["🟦", "#2563eb"], ["🟪", "#9333ea"], ["🟧", "#ea580c"], ["🟨", "#ca8a04"], ["🟫", "#92400e"], ["⬜", "#64748b"], ["🩷", "#db2777"]];

const fail = (m) => {
    const e = new Error(m);
    e.code = "SLOT_MOVE";
    throw e;
};

const tagNum = (t) => Number((/\d+/.exec(String(t || "")) || [0])[0]);

export function nextTagAndColor(epic) {
    const n = Math.max(0, ...epic.slots.map((z) => tagNum(z.tag))) + 1;
    const used = new Set(epic.slots.map((z) => z.color));
    const [emoji, color] = PALETTE.find(([, c]) => !used.has(c)) || PALETTE[(n - 1) % PALETTE.length];
    return { tag: "П" + n, emoji, color };
}

export function findSlot(reg, key, epicId = null) {
    const k = String(key || "").trim();
    if (!k)
        fail("какой слот: метка ПN или имя слота");
    const pool = epicId ? reg.epics.filter((e) => e.id === epicId) : reg.epics;
    if (epicId && !pool.length)
        fail("нет эпика " + epicId);
    const hits = [];
    for (const epic of pool)
        epic.slots.forEach((slot, index) => {
            if (slot.slot === k || slot.tag === k)
                hits.push({ epic, slot, index });
        });
    if (!hits.length)
        fail("нет слота " + k + (epicId ? " в эпике " + epicId : ""));
    if (hits.length > 1)
        fail("метка " + k + " есть в нескольких эпиках (" + hits.map((h) => h.epic.id).join(", ") + "): укажите --from <эпик> или имя слота");
    return hits[0];
}

function unlinkAfter(epic, slotName) {
    const unlinked = [];
    for (const s of epic.slots) {
        if (!Array.isArray(s.after) || !s.after.includes(slotName))
            continue;
        s.after = s.after.filter((x) => x !== slotName);
        if (!s.after.length)
            delete s.after;
        unlinked.push(s.tag);
    }
    return unlinked;
}

export function moveSlot(reg, { key, from = null, to, now = new Date().toISOString() }) {
    const dst = reg.epics.find((e) => e.id === to);
    if (!dst)
        fail("нет эпика " + to);
    if (dst.status === "closed")
        fail("эпик " + to + " закрыт: в закрытый эпик слоты не переносятся");
    const { epic: src, slot, index } = findSlot(reg, key, from);
    if (src.id === dst.id)
        fail("слот " + slot.tag + " уже в эпике " + to);
    if (dst.slots.some((z) => z.slot === slot.slot))
        fail("в эпике " + to + " уже есть слот " + slot.slot);
    const oldTag = slot.tag;
    src.slots.splice(index, 1);
    const unlinked = unlinkAfter(src, slot.slot);
    const keep = new Set(dst.slots.map((z) => z.slot)), droppedAfter = [];
    if (Array.isArray(slot.after)) {
        for (const a of slot.after)
            if (!keep.has(a))
                droppedAfter.push(a);
        slot.after = slot.after.filter((a) => keep.has(a));
        if (!slot.after.length)
            delete slot.after;
    }
    const { tag, emoji, color } = nextTagAndColor(dst);
    Object.assign(slot, { tag, emoji, color });
    slot.movedFrom = [...(Array.isArray(slot.movedFrom) ? slot.movedFrom : []), { epic: src.id, tag: oldTag, at: now }];
    dst.slots.push(slot);
    return { slot, from: src.id, to: dst.id, oldTag, newTag: tag, droppedAfter, unlinked };
}

export function removeSlot(reg, { key, epic = null }) {
    const { epic: src, slot, index } = findSlot(reg, key, epic);
    src.slots.splice(index, 1);
    return { slot, from: src.id, unlinked: unlinkAfter(src, slot.slot) };
}

export function waveOf(slot) {
    for (const t of [slot.title, slot.branch, slot.slot]) {
        const m = /wv-?(\d{4})/i.exec(String(t || ""));
        if (m)
            return m[1];
    }
    return "";
}
