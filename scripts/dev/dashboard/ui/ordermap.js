// ordermap.js — схема «Порядок влива в staging»: первая строка — staging с влитыми вагонами, дальше по строке на слот
// или поезд с очередью вагонов; линии зависимостей поверх строк. Не начатые вагоны перетаскиваются внутри своей строки —
// порядок уходит командой реестра.
import { S } from "./state.js";
import { esc, ls } from "./core.js";
import { buildOrderMap, mayMergeNow } from "./order-rules.js";

export const OMFOLD = (() => {
    try {
        return localStorage.getItem("dash.omfold") === "1";
    }
    catch {
        return false;
    }
})();

let fold = OMFOLD;

export const toggleOrderFold = () => {
    fold = !fold;
    ls("dash.omfold", fold ? "1" : "0");
};

export const orderFolded = () => fold;
export const PAL = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#db2777", "#ca8a04", "#4f46e5"];
const colorOf = (t, wave) => PAL[Math.max(0, ((t && t.wagonsView) || []).findIndex((x) => x.wave === wave)) % PAL.length];
const TONE = { work: "в работе у агента", check: "на проверках / ждёт влива", done: "в staging", depot: "в очереди", wait: "ждёт другой поезд" };

const depTxt = (x) => {
    const [wv, tr] = String(x).split("@");
    return tr ? tr + " · " + wv : wv;
};

const num = (wave) => String(wave).replace(/^WV-0*/, "");

function car(t, w, { staged = false, extra = "" } = {}) {
    const dnd = !staged && ["depot", "wait"].includes(w.tone) && !(w.commits > 0) && t.issued !== w.wave;
    const deps = (w.after || []).map((x) => String(x).split("@")[0]), wait = (w.waitFor || []).map((x) => String(x).split("@")[0]);
    const st = staged ? "в staging" : ["work", "check"].includes(w.tone) ? w.label || TONE[w.tone] : TONE[w.tone] || w.state || "";
    const tip = w.wave + (w.title ? " · " + w.title : "") + "\n" + t.tag + " · " + st + ((w.after || []).length ? "\nпосле: " + w.after.map(depTxt).join(", ") : "") + ((w.waitFor || []).length ? "\nещё ждёт: " + w.waitFor.map(depTxt).join(", ") : "") + "\nклик — план вагона" + (dnd ? "; перетащить — порядок депо" : "");
    return `<span class="omc ${staged ? "staged" : w.tone || ""} ${dnd ? "dnd" : ""}" data-act="wagonplan" data-tree="${esc(t.key)}" data-wave="${esc(w.wave)}" data-wv="${esc(w.wave)}" data-deps="${esc(deps.join(" "))}" data-wait="${esc(wait.join(" "))}" ${dnd ? `draggable="true" data-omrow="${esc(t.key)}"` : ""} style="--w:${colorOf(t, w.wave)}" title="${esc(tip)}"><b>${esc(num(w.wave))}</b><small>${esc(staged ? t.tag : st)}</small>${extra}<i class="cpl"></i></span>`;
}

const slotCar = (t, staged) => `<span class="omc slot ${staged ? "staged" : ""}" data-wv="${esc(t.key)}" data-deps="" data-wait="" style="--w:${esc(t.color || "#8b929c")}" title="${esc(t.tag + " · " + (t.title || ""))}"><b>${esc(t.tag)}</b><small>${staged ? "в staging" : "слот"}</small><i class="cpl"></i></span>`;

export function orderMapHtml(loco, seg = "") {
    const m = buildOrderMap(S.trees), c = m.counts, now = mayMergeNow(m);
    const slots = (S.trees || []).filter((t) => t.kind === "slot" && !t.archived);
    if (!slots.length)
        return "";
    const trains = slots.filter((t) => t.train), plain = slots.filter((t) => !t.train);
    const staged = [], rows = [];
    for (const t of trains) {
        const ws = t.wagonsView || [];
        for (const w of ws)
            if (w.tone === "done")
                staged.push(car(t, w, { staged: true }));
        const live = ws.filter((w) => w.tone !== "done");
        rows.push({ t, cars: live.slice().reverse().map((w) => car(t, w)).join(""), n: live.length });
    }
    for (const t of plain) {
        if (t.verdict && t.verdict.merged)
            staged.push(slotCar(t, true));
        else
            rows.push({ t, cars: slotCar(t, false), n: 1 });
    }
    const waits = trains.reduce((a, t) => a + (t.wagonsView || []).filter((w) => (w.waitFor || []).length && w.tone !== "done").length, 0);
    const head = `<div class="omh" data-act="orderfold" style="cursor:pointer;user-select:none"><b>🚂 Порядок влива в staging</b>${seg}<span class="mute">${fold ? "▸" : "▾"} строк ${rows.length} · в staging вагонов ${staged.length} · ждут другой поезд ${waits}${now.length ? ` · можно вливать сейчас: <b>${esc(now.map((n) => n.tag).join(", "))}</b>` : ""}</span></div>`;
    if (fold)
        return `<div class="omap fold">${head}</div>`;
    const row = (label, sub, color, cars, cls = "") => `<div class="omrow ${cls}"><div class="omlab" style="--c:${esc(color)}"><b>${label}</b><small>${sub}</small></div><div class="omtrack"><span class="omcars2">${cars}</span><span class="omloco2 loco" style="--c:${esc(color)}">${loco || ""}</span></div></div>`;
    const stg = row("staging", "влитые вагоны", "#e0663a", staged.length ? staged.join("") : `<span class="mute">пока пусто</span>`, "stg");
    const body = rows.map(({ t, cars, n }) => row(esc(t.tag), esc((t.title || "").slice(0, 34)) + (t.train ? " · вагонов " + n : ""), t.color || "#8b929c", cars || `<span class="mute">вагонов нет</span>`)).join("");
    return `<div class="omap omap2">${head}<div class="omwrap"><svg class="omlinks" aria-hidden="true"></svg>${stg}${body}</div>${m.cycle ? '<div class="chip fail">⚠ в зависимостях есть цикл — проверьте «после» в реестре</div>' : ""}<div class="omleg mute">Ближе к паровозу — едет раньше. Линия — зависимость: <span style="color:#f59e0b">━</span> ещё ждёт, <span style="color:#22c55e">┅</span> уже в staging. Не начатые вагоны перетаскиваются мышью внутри своей строки; клик — план вагона. Наведите на вагон — подсветятся его связи.</div></div>`;
}

export function drawOrderLinks() {
    const wrap = document.querySelector("#ordermap .omwrap"), svg = wrap && wrap.querySelector(".omlinks");
    if (!svg)
        return;
    const W = wrap.getBoundingClientRect(), at = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left - W.left, y: r.top - W.top, w: r.width, h: r.height };
    };
    const byWv = new Map([...wrap.querySelectorAll(".omc[data-wv]")].map((e) => [e.dataset.wv, e]));
    svg.setAttribute("width", W.width);
    svg.setAttribute("height", W.height);
    svg.setAttribute("viewBox", `0 0 ${W.width} ${W.height}`);
    let out = `<defs><marker id="omarr" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#f59e0b"/></marker><marker id="omarr2" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#22c55e"/></marker></defs>`;
    for (const el of byWv.values()) {
        const wait = new Set(String(el.dataset.wait || "").split(" ").filter(Boolean));
        for (const d of String(el.dataset.deps || "").split(" ").filter(Boolean)) {
            const to = byWv.get(d);
            if (!to || to === el)
                continue;
            const a = at(el), b = at(to), live = wait.has(d);
            let p;
            if (Math.abs(a.y - b.y) < 4) {
                const x1 = a.x + a.w / 2, x2 = b.x + b.w / 2, y = a.y - 2, hgt = Math.min(26, 10 + Math.abs(x2 - x1) / 8);
                p = `M${x1},${y} C${x1},${y - hgt} ${x2},${y - hgt} ${x2},${y}`;
            }
            else {
                const up = b.y < a.y, x1 = a.x + a.w / 2, y1 = up ? a.y : a.y + a.h, x2 = b.x + b.w / 2, y2 = up ? b.y + b.h : b.y, my = (y1 + y2) / 2;
                p = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
            }
            out += `<path class="oml ${live ? "live" : "ok"}" data-from="${esc(el.dataset.wv)}" data-to="${esc(d)}" d="${p}" marker-end="url(#${live ? "omarr" : "omarr2"})"/>`;
        }
    }
    svg.innerHTML = out;
}

window.addEventListener("resize", () => drawOrderLinks());
let hot = null;

const clear = () => {
    document.querySelectorAll(".omc.me,.omc.dep,.omc.req,.oml.hot").forEach((e) => e.classList.remove("me", "dep", "req", "hot"));
    hot = null;
};

document.addEventListener("mouseover", (e) => {
    const c = e.target.closest && e.target.closest(".omap2 .omc");
    if (!c) {
        if (hot)
            clear();
        return;
    }
    if (hot === c)
        return;
    clear();
    hot = c;
    c.classList.add("me");
    const wv = c.dataset.wv, wrap = c.closest(".omwrap");
    if (!wrap)
        return;
    for (const l of wrap.querySelectorAll(".oml")) {
        if (l.dataset.from === wv) {
            l.classList.add("hot");
            const t = wrap.querySelector(`.omc[data-wv="${CSS.escape(l.dataset.to)}"]`);
            if (t)
                t.classList.add("dep");
        }
        if (l.dataset.to === wv) {
            l.classList.add("hot");
            const t = wrap.querySelector(`.omc[data-wv="${CSS.escape(l.dataset.from)}"]`);
            if (t)
                t.classList.add("req");
        }
    }
});

export function bindOrderDnd({ press, call, refresh }) {
    let drag = null;
    const D = ".omap2 .omc.dnd";
    document.addEventListener("dragstart", (e) => {
        const c = e.target.closest && e.target.closest(D);
        if (!c)
            return;
        drag = c;
        c.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", c.dataset.wave);
    });
    document.addEventListener("dragend", () => {
        if (drag)
            drag.classList.remove("dragging");
        drag = null;
        for (const x of document.querySelectorAll(".omc.dropto"))
            x.classList.remove("dropto");
    });
    document.addEventListener("dragover", (e) => {
        if (!drag)
            return;
        const c = e.target.closest && e.target.closest(D);
        if (!c || c === drag || c.dataset.omrow !== drag.dataset.omrow)
            return;
        e.preventDefault();
        for (const x of document.querySelectorAll(".omc.dropto"))
            x.classList.remove("dropto");
        c.classList.add("dropto");
    });
    document.addEventListener("drop", (e) => {
        if (!drag)
            return;
        const c = e.target.closest && e.target.closest(D);
        if (!c || c === drag || c.dataset.omrow !== drag.dataset.omrow)
            return;
        e.preventDefault();
        const tree = drag.dataset.omrow, row = c.closest(".omcars2");
        const vis = [...row.querySelectorAll(D)].map((x) => x.dataset.wave).filter((w) => w !== drag.dataset.wave);
        const r = c.getBoundingClientRect(), right = e.clientX > r.left + r.width / 2, i = vis.indexOf(c.dataset.wave);
        vis.splice(i + (right ? 1 : 0), 0, drag.dataset.wave);
        const waves = vis.reverse();
        press("orderwagons|" + tree, () => call("/api/order-wagons", { tree, waves }), (res) => {
            setTimeout(() => refresh(true), 400);
            return (res && res.message) || "Порядок вагонов обновлён";
        });
    });
}
