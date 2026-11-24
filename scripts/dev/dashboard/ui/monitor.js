// monitor.js — монитор машины справа: загрузка процессора, память, машины прогонов, процессы и агенты слотов.
import { S } from "./state.js";
import { $, dur, esc, SPIN } from "./core.js";
import { treeOf } from "./data.js";

const loadColor = (p) => (p >= 85 ? "var(--bad)" : p >= 60 ? "var(--warn)" : "var(--good)");

function spark(arr, color) {
    const a = (arr || []).filter((v) => v != null);
    if (a.length < 2)
        return '<svg class="spark"></svg>';
    const w = 260, h = 34, step = w / Math.max(1, arr.length - 1);
    const pts = arr.map((v, i) => (v == null ? null : [i * step, h - 2 - (Math.min(100, v) / 100) * (h - 4)])).filter(Boolean);
    const line = pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polygon points="0,${h} ${line} ${pts[pts.length - 1][0].toFixed(1)},${h}" fill="${color}" opacity=".16"/><polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
}

const fmtUp = (s) => (s == null ? "" : s < 90 ? s + " с" : s < 5400 ? Math.round(s / 60) + " мин" : (s / 3600).toFixed(1) + " ч");

export const hhmm = (ms) => new Date(ms).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
function cpuLoadCompact(y) {
    const tasks = y.cpuTasks || [], top = (y.topCpu || []).slice(0, 4);
    if (!tasks.length && !top.length)
        return "";
    const tSum = Math.round(tasks.reduce((a, c) => a + c.pct, 0) * 10) / 10;
    const kv = (name, pct) => `<div class="kv"><span>${esc(name)}</span><b>${pct}%</b></div>`;
    return `${kv("запущено дашбордом" + (tasks.length ? " (" + tasks.length + ")" : ""), tSum)}${top.map((c) => kv(c.name + (c.n > 1 ? " ×" + c.n : ""), c.pct)).join("")}`;
}

export const MONOPEN = new Set((() => {
    try {
        return JSON.parse(localStorage.getItem("dash.monopen") || "[]");
    }
    catch {
        return [];
    }
})());

const monFold = (id, title, html, note) => !html ? "" : `<div class="sub" data-act="monfold" data-f="${id}" style="margin-top:6px;cursor:pointer;user-select:none">${MONOPEN.has(id) ? "▾" : "▸"} ${title}${note ? ` <span class="mute">${note}</span>` : ""}</div>${MONOPEN.has(id) ? html : ""}`;

function hostCards() {
    const H = S.hosts || {}, gbs = (v) => (v == null ? "?" : v.toFixed(1)) + " ГБ", mbs = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + " ГБ" : mb + " МБ");
    return Object.entries(H).map(([k, h]) => {
        const c = loadColor(h.cpu), pc = loadColor(h.phys);
        const cores = (h.cores || []).map((v) => `<i style="--h:${v}%;--c:${loadColor(v)}" title="ядро: ${v}%"></i>`).join("");
        const sw = h.swapTotalGB > 0.05 ? Math.round((100 * h.swapUsedGB) / h.swapTotalGB) : null;
        const disks = (h.disks || []).map((d) => {
            const p = Math.round((100 * d.usedGB) / d.totalGB);
            return `<div class="kv"><span>диск ${esc(d.mount)}</span><b>${d.usedGB.toFixed(0)} из ${d.totalGB.toFixed(0)} ГБ · ${p}%</b></div><div class="bar" style="--c:${loadColor(p)}"><i style="width:${p}%"></i></div>`;
        }).join("");
        const top = (h.top || []).slice(0, 6).map((p) => `<div class="kv"><span>${esc(p.name)}${p.n > 1 ? ` <span class="mute">×${p.n}</span>` : ""}</span><b>${mbs(p.mb)}</b></div>`).join("");
        const dk = (h.docker || []).map((d) => `<div class="kv"><span><span class="dot ${d.state === "running" ? "" : "bad"}"></span> ${esc(d.name)}</span><b class="mute" style="font-weight:400">${esc(d.status)}</b></div>`).join("");
        const jr = (S.jobs || []).filter((j) => j.runOn === k && j.status === "running").map((j) => {
            const t = treeOf(j.tree);
            return (t ? t.tag : j.tree) + " " + j.label;
        });
        const sr = S.shard && S.shard.status === "running" ? "полный прогон staging: идёт" : "";
        const la = h.loadAvg ? h.loadAvg.map((x) => x.toFixed(1)).join(" / ") : "?";
        const diskBad = (h.disks || []).filter((d) => d.totalGB && (100 * d.usedGB) / d.totalGB >= 85).map((d) => `<div class="kv" style="color:var(--bad)"><span>⚠ диск ${esc(d.mount)}</span><b>${Math.round((100 * d.usedGB) / d.totalGB)}% занято</b></div>`).join("");
        const store = (h.swapNote ? `<div class="kv mute" title="Linux не поднимает страницы из подкачки, пока их не тронут; без обмена это не тормозит"><span>swap</span><b style="font-weight:400">${esc(h.swapNote)}</b></div>` : "") +
            (sw != null ? `<div class="kv"><span>swap</span><b>${gbs(h.swapUsedGB)} из ${h.swapTotalGB.toFixed(0)} ГБ · ${sw}%</b></div><div class="bar" style="--c:${loadColor(sw)}"><i style="width:${sw}%"></i></div>` : "") + disks;
        const storeNote = [sw != null ? "swap " + sw + "%" : "", ...(h.disks || []).filter((d) => d.totalGB).map((d) => esc(d.mount) + " " + Math.round((100 * d.usedGB) / d.totalGB) + "%")].filter(Boolean).join(" · ");
        const work = [jr.length ? "прогоны " + jr.join(", ") : "", sr].filter(Boolean).join(" · ");
        const tip = ["нагрузка 1 / 5 / 15 мин: " + la, h.upSec ? "работает " + fmtUp(h.upSec) : "", work ? "от диспетчерской: " + work : ""].filter(Boolean).join("\n");
        return `<div class="mc mach"><h3 title="${esc(tip)}"><span>🖥 ${esc(h.label || k)}</span><span class="mute">${(h.cores || []).length} ядер${h.tempC != null ? " · " + h.tempC + " °C" : ""} · нагр. ${h.loadAvg ? h.loadAvg[0].toFixed(1) : "?"}</span></h3>
      <div class="cpurow"><div class="ring" style="--p:${h.cpu};--c:${c}"><div><span><b>${h.cpu}%</b><small>ЦП</small></span></div></div><div class="cpuside"><div class="cores">${cores}</div>${spark((h.hist || {}).cpu || [], c)}</div></div>
      <div class="kv"><span>память</span><b>${gbs(h.memUsedGB)} из ${(h.memTotalGB || 0).toFixed(0)} ГБ · ${h.phys}%</b></div><div class="bar" style="--c:${pc}"><i style="width:${h.phys}%"></i></div>
      ${h.alarm ? `<div class="kv" style="color:var(--bad)" title="Страницы ходят в подкачку и обратно, или она занята больше половины при нехватке памяти"><span>⚠ тревога</span><b>${esc(h.alarm)}</b></div>` : ""}
      ${diskBad}
      ${monFold(k + "-store", "Подкачка и диски", store, storeNote)}
      ${monFold(k + "-mem", "Больше всего памяти", top)}
      ${monFold(k + "-dk", "Контейнеры", dk, (h.docker || []).length + ((h.docker || []).some((d) => d.state !== "running") ? " · есть упавшие" : ""))}
    </div>`;
    }).join("");
}

export function renderMon() {
    const el = $("mon");
    if (!el || !S || !S.sys)
        return;
    const y = S.sys, c = loadColor(y.cpu), pc = loadColor(y.phys), cm = y.commit == null ? "var(--text-3)" : loadColor(y.commit);
    const cores = (y.cores || []).map((v) => `<i style="--h:${v}%;--c:${loadColor(v)}" title="ядро: ${v}%"></i>`).join("");
    const top = (y.top || []).slice(0, 6).map((p) => `<div class="kv"><span>${esc(p.name)}${p.n > 1 ? ` <span class="mute">×${p.n}</span>` : ""}</span><b>${p.mb >= 1024 ? (p.mb / 1024).toFixed(1) + " ГБ" : p.mb + " МБ"}</b></div>`).join("");
    const stack = (S.stack || []).map((x) => {
        const bad = !x.ok, cls = bad ? (x.need ? "bad" : "warn") : "";
        const sub = esc(x.note) + (x.kind !== "key" && x.ok && x.need && x.ms != null ? " · " + x.ms + " мс" : "") + (x.kind !== "key" && x.pid && x.ok && x.need ? " · pid " + x.pid : "");
        const label = x.kind === "key" ? (x.ok ? "ок" : x.unlock ? "не введён" : "проблема") : x.invert ? (x.ok ? "свободен" : "занят") : x.ok ? "ок" : "НЕ ОТВЕЧАЕТ";
        const btn = x.unlock ? `<button class="sm primary" data-act="unlock" data-key="${esc(x.keyId)}" title="Откроется окно, фразу вы вводите там: дашборд её не видит">Ввести фразу</button>` : "";
        return `<div class="srow"><span class="dot ${cls}"></span><span class="n">${esc(x.name)}<small>${sub}</small>${btn ? `<div style="margin-top:4px">${btn}</div>` : ""}</span><span class="chip ${bad ? (x.need ? "fail" : "queued") : "ok"}">${label}</span></div>`;
    }).join("");
    const stackBad = (S.stack || []).filter((x) => x.need && !x.ok).length;
    const jr = S.jobs.filter((j) => ["running", "waiting", "queued"].includes(j.status)), jd = S.jobs.filter((j) => ["ok", "fail"].includes(j.status)).slice(-4).reverse();
    const who = (j) => {
        const t = treeOf(j.tree);
        return t ? t.emoji + " " + esc(t.tag) : j.tree === "orchestrator-staging" ? "staging" : j.tree === "orchestrator-main" ? "main" : esc(j.tree);
    };
    const jrows = [
        ...jr.map((j) => `<div class="prow"><div class="t"><b>${j.status === "running" ? SPIN : "⏸"} ${who(j)} <span class="tag t1">${esc(j.label)}</span></b><span>${j.status === "running" ? "идёт " + dur(j) : j.status === "waiting" ? "ждёт память" : "в очереди"}${j.input ? " · " + esc(j.input) : ""}</span></div><button class="kill" data-act="cancel" data-id="${j.id}" title="Остановить">⏹</button></div>`),
        ...jd.map((j) => `<div class="prow" style="cursor:pointer" data-act="log" data-id="${j.id}"><div class="t"><b><span class="chip ${j.status}">${j.status === "ok" ? "✓ ок" : "✗ упал"}</span> ${who(j)}</b><span>${esc(j.label)} · ${dur(j)}</span></div><span></span></div>`),
    ].join("");
    el.innerHTML = `
  <div class="mc mach" id="mc-pc"><h3 title="${esc((y.model || "").replace(/\s+/g, " "))}"><span>💻 Эта машина</span><span class="mute">${(y.cores || []).length} ядер</span></h3>
    <div class="cpurow"><div class="ring" style="--p:${y.cpu};--c:${c}"><div><span><b>${y.cpu}%</b><small>ЦП</small></span></div></div><div class="cpuside"><div class="cores">${cores}</div>${spark(y.load.cpu, c)}</div></div>
    <div class="kv"><span>память</span><b>${y.physUsedGB.toFixed(1)} из ${y.physTotalGB.toFixed(0)} ГБ · ${y.phys}%</b></div><div class="bar" style="--c:${pc}"><i style="width:${y.phys}%"></i></div>
    ${y.commit != null ? `<div class="kv"><span title="Сколько памяти система ещё даст процессам. Кончается именно он.">лимит выделения</span><b>свободно ${y.commitFreeGB.toFixed(1)} из ${y.commitTotalGB.toFixed(0)} ГБ</b></div><div class="bar" style="--c:${cm}"><i style="width:${y.commit}%"></i></div>` : ""}
    ${monFold("pc-cpu", "Кто грузит процессор", cpuLoadCompact(y))}
    ${monFold("pc-mem", "Больше всего памяти", top)}</div>
  ${hostCards()}
  ${stack ? `<div class="mc"><h3><span>Службы</span><span class="chip ${stackBad ? "fail" : "ok"}">${stackBad ? stackBad + " не отвечает" : "всё ок"}</span></h3>${stack}</div>` : ""}
  <div class="mc"><h3><span>Запуски дашборда</span><span class="mute">${jr.length} идёт/ждёт</span></h3><div>${jrows || '<div class="sub">Сейчас ничего не запущено.</div>'}</div></div>`;
}
