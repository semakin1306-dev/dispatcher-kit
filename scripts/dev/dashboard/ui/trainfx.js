// trainfx.js — паровозик экранов выката: путь со станциями, поезд с вагонами волн, авария и салют, перерисовка без
// сброса анимации. Зовут экран выката стенда и экран выката прода.
import { esc } from "./core.js";
import { locoSvg } from "./lines.js";

export const plural = (k, one, few, many) => (k % 10 === 1 && k % 100 !== 11 ? one : k % 10 >= 2 && k % 10 <= 4 && (k % 100 < 10 || k % 100 >= 20) ? few : many);

export function fireworks(x, W) {
    const cols = (W.length ? W.map((w) => w.color) : ["#f4511e", "#3fcf7d", "#6ea0ff", "#f5b343"]);
    const bursts = [[-150, 40, 0], [-60, 22, 0.45], [-215, 66, 0.85], [-20, 58, 1.2], [-110, 76, 1.55]];
    return `<div class="fw" style="left:${x}%">${bursts.map(([dx, y, d], k) => `<span class="b" style="left:${dx}px;top:${y}px"><u style="--d:${d}s"></u>${Array.from({ length: 14 }, (_, i) => `<i style="--a:${Math.round(i * 360 / 14 + k * 9)}deg;--c:${cols[(i + k * 3) % cols.length]};--d:${(d + 0.33).toFixed(2)}s;--r:${36 + (i % 3) * 9}px"></i>`).join("")}</span>`).join("")}</div>`;
}

export const railX = (n) => (i) => 7 + (i * 86) / (n - 1);

export function railHtml(o) {
    const { def, st, curI, going, ok, bad, wagons: W } = o, n = def.length, X = railX(n);
    const stations = def.map(([id, label], i) => {
        const v = st[id] || "";
        const ic = v === "ok" ? "✓" : v === "bad" ? "✗" : v === "skip" ? "–" : v === "run" && going ? '<span class="spin" style="width:10px;height:10px;border-width:2px"></span>' : i + 1;
        return `<div class="sst ${v} ${o.cls ? o.cls(id, i) : ""}" style="left:${X(i)}%"><span class="pole"></span><span class="ic">${ic}</span><br>${esc(label)}<span class="tm${o.tmCls ? " " + o.tmCls(id, i) : ""}">${o.tm ? o.tm(id, i) : ""}</span></div>`;
    }).join("");
    const agentSt = going ? "work" : ok ? "warm" : bad ? "sleep" : "warm";
    const wagons = W.slice().reverse().map((w) => `<span class="wagon" style="--w:${w.color}" title="${esc(w.tag + " · " + w.title)}">${esc(w.tag)}<i></i></span>`).join("");
    return `<div class="rail"><div class="ties"></div><div class="rl1"></div><div class="rl2"></div><div class="done" style="width:${X(curI)}%"></div>${stations}
      <div class="sfxtrain ${going ? "go" : ""} ${bad ? "crash" : ""} ${ok ? "fin" : ""}" style="left:calc(${X(curI)}% + 42px)">${wagons}<span class="loco ${going ? "go" : ""}">${locoSvg({ key: o.key || "standfx" }, agentSt)}</span></div>
      ${bad ? `<div class="boom" style="left:calc(${X(curI)}% + 30px)">💥</div>${[0, 0.9, 1.7].map((d, i) => `<span class="crsm" style="left:calc(${X(curI)}% + ${18 + i * 12}px);animation-delay:${d + 0.8}s"></span>`).join("")}` : ""}${ok ? fireworks(X(n - 1), W) : ""}</div>`;
}

export function cargoHtml(W, { ok, bad, dest }) {
    return ok ? `<div class="cargo"><b>Сдано ${esc(dest)}: ${W.length} ${plural(W.length, "вагон", "вагона", "вагонов")}</b>${W.map((w, i) => `<span class="wc in" style="--w:${w.color};animation-delay:${(i * 0.08).toFixed(2)}s"><i></i>${esc(w.tag)} · ${esc(w.title)}</span>`).join("")}</div>`
        : `<div class="cargo"><b>${bad ? "Не доехали" : "Везёт"} ${W.length} ${plural(W.length, "волну", "волны", "волн")}:</b>${W.map((w) => `<span class="wc" style="--w:${w.color}"><i></i>${esc(w.tag)}</span>`).join("")}</div>`;
}

export function paintFx(el, body) {
    if (el.dataset.sig === body)
        return false;
    const tr0 = el.querySelector(".sfxtrain"), oldLeft = tr0 && tr0.style.left;
    el.innerHTML = body;
    el.dataset.sig = body;
    const tr = el.querySelector(".sfxtrain");
    if (tr && oldLeft && oldLeft !== tr.style.left) {
        const to = tr.style.left;
        tr.style.transition = "none";
        tr.style.left = oldLeft;
        tr.getBoundingClientRect();
        tr.style.transition = "";
        tr.style.left = to;
    }
    return true;
}
