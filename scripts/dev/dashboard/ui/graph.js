// graph.js — git-граф прод-ветки, staging и веток слотов.
import { GGOPEN } from "./state.js";
import { $, anchorRestore, anchorSave, call, esc } from "./core.js";

const ggCol = (c) => (c.owner === "slot" ? c.color : c.owner === "main" ? "var(--g-main)" : c.owner === "staging" ? "var(--g-staging)" : "var(--g-side)");
let GG = null, ggJson = "";

export function applyGgOpen() {
    const s = document.getElementById("ggsec");
    if (s)
        s.classList.toggle("ggc", !GGOPEN);
    const a = document.getElementById("ggarrow");
    if (a)
        a.textContent = GGOPEN ? "▾" : "▸";
}

export async function loadGraph() {
    try {
        const g = await call("/api/graph");
        const j = JSON.stringify(g);
        if (j !== ggJson) {
            ggJson = j;
            GG = g;
            const anc = anchorSave();
            try {
                renderGraph();
            }
            finally {
                anchorRestore(anc);
            }
        }
    }
    catch { }
}

function renderGraph() {
    const host = $("gg"), head = $("ggh");
    if (!host || !GG)
        return;
    const cs = GG.commits, ROW = 26, LANE = 16, idx = new Map(cs.map((c, i) => [c.sha, i])), lanes = [], lane = new Array(cs.length);
    cs.forEach((c, i) => {
        let l = lanes.indexOf(c.sha);
        if (l < 0) {
            l = lanes.indexOf(null);
            if (l < 0) {
                lanes.push(null);
                l = lanes.length - 1;
            }
        }
        lane[i] = l;
        for (let k = 0; k < lanes.length; k++)
            if (k !== l && lanes[k] === c.sha)
                lanes[k] = null;
        if (!c.parents.length)
            lanes[l] = null;
        else {
            lanes[l] = c.parents[0];
            for (const p of c.parents.slice(1))
                if (lanes.indexOf(p) < 0) {
                    const k = lanes.indexOf(null);
                    if (k < 0)
                        lanes.push(p);
                    else
                        lanes[k] = p;
                }
        }
    });
    const W = (Math.max(0, ...lane) + 1) * LANE + 8, H = cs.length * ROW, paths = [], dots = [];
    cs.forEach((c, i) => {
        const x1 = lane[i] * LANE + 10, y1 = i * ROW + ROW / 2;
        c.parents.forEach((p, pi) => {
            const j = idx.get(p), x2 = (j != null ? lane[j] : lane[i]) * LANE + 10, y2 = j != null ? j * ROW + ROW / 2 : H;
            const col = pi === 0 || j == null ? ggCol(c) : (cs[j].owner === "main" || cs[j].owner === "staging" ? "var(--g-side)" : ggCol(cs[j]));
            const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : pi === 0 ? `M${x1} ${y1}V${Math.max(y1, y2 - ROW / 2)}Q${x1} ${y2} ${x2} ${y2}` : `M${x1} ${y1}Q${x2} ${y1} ${x2} ${y1 + ROW / 2}V${Math.max(y2, y1 + ROW / 2)}`;
            paths.push(`<path d="${d}" style="stroke:${col}" stroke-width="2" fill="none" stroke-linecap="round"/>`);
        });
        const col = ggCol(c), merge = c.parents.length > 1;
        dots.push(`<circle cx="${x1}" cy="${y1}" r="${merge ? 4 : 4.5}" style="fill:${merge ? "var(--card)" : col};stroke:${col}" stroke-width="2"/>`);
    });
    const bmap = new Map((GG.branches || []).map((b) => [b.name, b]));
    const chip = (name) => {
        const b = bmap.get(name), col = b ? b.color : name === "main" ? "var(--g-main)" : name === "staging" ? "var(--g-staging)" : "var(--g-side)";
        return `<span class="rf" style="color:${col};border-color:${col}" title="${esc(name)}">${b ? esc(b.tag) + " " : ""}${esc(name.replace(/^dev\//, ""))}</span>`;
    };
    const rows = cs.map((c) => `<div class="gr" title="${esc(c.sha + " · " + c.subject)}">${c.refs.map(chip).join("")}<span class="sj">${esc(c.subject)}</span><span class="sh">${esc(c.sha)}</span><span class="wn">${esc(c.when)}</span></div>`).join("");
    host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${paths.join("")}${dots.join("")}</svg><div class="rows">${rows}</div>`;
    head.innerHTML = (GG.branches || []).map((b) => `<span class="chip" style="border-color:${b.color}"><span class="dotc" style="--c:${b.color}"></span>${esc(b.tag)} ${esc(b.name.replace(/^dev\//, ""))} · ↑${b.ahead} ↓${b.behind}</span>`).join("") + `<span class="sub">последние ${cs.length} коммитов; ↑ впереди staging, ↓ позади</span>`;
}
