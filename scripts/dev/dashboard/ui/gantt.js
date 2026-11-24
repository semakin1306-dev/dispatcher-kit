// gantt.js — Гант эпика в режиме канбана: переключатель «Схема ↔ Гант» над колонками. Раскладку (полосы, отметки, связи
// порядка, прогноз) присылает сервер; здесь только перевод времени в координаты и SVG.
import { S } from "./state.js";
import { esc, ls } from "./core.js";
import { orderFolded, PAL } from "./ordermap.js";

let mode = (() => {
    try {
        return localStorage.getItem("dash.ommode") === "gantt" ? "gantt" : "map";
    }
    catch {
        return "map";
    }
})();

let scale = (() => {
    try {
        return ["24h", "6h", "all"].includes(localStorage.getItem("dash.gscale")) ? localStorage.getItem("dash.gscale") : "24h";
    }
    catch {
        return "24h";
    }
})();

export const orderMode = () => mode;

export const setOrderMode = (m) => {
    mode = m === "gantt" ? "gantt" : "map";
    ls("dash.ommode", mode);
};

export const setGanttScale = (s) => {
    if (["24h", "6h", "all"].includes(s)) {
        scale = s;
        ls("dash.gscale", s);
    }
};

export const modeSeg = () => `<span class="seg omseg">${[["map", "Схема"], ["gantt", "Гант"]].map(([m, l]) => `<button class="sm ${mode === m ? "on" : ""}" data-act="ordermode" data-m="${m}">${l}</button>`).join("")}</span>`;
const H = 3600e3;
const hm = (at) => new Date(at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const dm = (at) => new Date(at).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
const when = (at) => (at ? dm(at) + " " + hm(at) : "—");

const dur = (ms) => {
    const m = Math.max(0, Math.round(ms / 60000));
    if (m < 60)
        return m + " мин";
    const h = Math.floor(m / 60);
    if (h < 24)
        return h + " ч" + (m % 60 ? " " + (m % 60) + " мин" : "");
    return Math.floor(h / 24) + " сут" + (h % 24 ? " " + (h % 24) + " ч" : "");
};

const num = (wave) => String(wave).replace(/^WV-0*/, "");
const colorOf = (r, b) => (r.train && b.ci >= 0 ? PAL[b.ci % PAL.length] : r.color || "#8b929c");
const PH = { work: "у агента", wait: "ГОТОВО, ждёт влива", done: "влит", forecast: "прогноз", queue: "в очереди" };

function tip(r, b) {
    const L = [b.wave + (b.title ? " · " + b.title : ""), r.tag + " · " + (PH[b.phase] || b.phase)];
    if (b.forecast)
        L.push("прогноз: " + when(b.start) + " → " + when(b.end) + " (" + dur(b.end - b.start) + ")");
    else {
        L.push((b.noStart ? "выдан: нет отметки" : "выдан: " + when(b.start)) + (b.doneAt ? " · ГОТОВО: " + when(b.doneAt) + " (работа " + dur(b.doneAt - b.start) + ")" : ""));
        if (b.mergedAt)
            L.push("влит: " + when(b.mergedAt) + (b.mergeSha ? " · " + String(b.mergeSha).slice(0, 10) : "") + (b.doneAt ? " (ожидание " + dur(b.mergedAt - b.doneAt) + ")" : ""));
        else if (b.doneAt)
            L.push("ждёт влива " + dur(S.gantt.now - b.doneAt));
    }
    for (const w of b.waits || [])
        L.push((w.open ? "ВЛИТЬ ждёт " : "ВЛИТЬ ждал ") + dur(w.to - w.from) + (w.need.length ? ": " + w.need.join(", ") : "") + (w.red ? " — красное" : ""));
    for (const q of b.questions || [])
        L.push("? " + when(q.at) + " " + qWait(q, S.gantt.now) + " — " + q.brief.slice(0, 120));
    if ((b.after || []).length)
        L.push("после: " + b.after.join(", "));
    L.push(r.train ? "клик — план вагона" : "клик — карточка слота");
    return L.join("\n");
}

const qWait = (q, now) => (q.answeredAt ? "ответ через " + dur(q.answeredAt - q.at) + (q.via === "tg" ? " (Telegram)" : q.via === "слово" ? " (слово в чат)" : "") : q.open ? "ждёт ответа " + dur(now - q.at) : "ответ не записан в журнал");

function qMark(q, y, cap, cx, r, room = Infinity) {
    const qa = cx(q.at), qe = q.answeredAt ? cx(q.answeredAt) : q.open ? cx(cap) : qa, st = q.answeredAt ? "" : q.open ? "open" : "lost";
    return `<g><title>${esc("? " + q.from + " " + when(q.at) + " — " + qWait(q, cap) + "\n" + q.brief)}</title>${qe - qa > 1 ? `<line class="gq ${st}" x1="${qa}" y1="${y}" x2="${qe}" y2="${y}"/>` : ""}<circle class="gqd ${st}" cx="${qa}" cy="${y}" r="${r}"/><text class="gqt" x="${qa}" y="${y + 3.2}">?</text>${qe - qa > 40 && room > 62 ? `<text class="gqlen" x="${qa + 8}" y="${y - 3}">${dur((q.answeredAt || cap) - q.at)}</text>` : ""}</g>`;
}

const shortTitle = (t) => String(t || "").replace(/^WV-\d{4}\s*/, "");

export function ganttHtml(width) {
    const g = S.gantt;
    const head = (sub) => `<div class="omh"><b data-act="orderfold" style="cursor:pointer;user-select:none">📊 Гант влива в staging</b>${modeSeg()}${orderFolded() ? "" : `<span class="seg omseg">${[["6h", "6 ч"], ["24h", "сутки"], ["all", "всё"]].map(([s, l]) => `<button class="sm ${scale === s ? "on" : ""}" data-act="gscale" data-s="${s}">${l}</button>`).join("")}</span>`}<span class="mute" data-act="orderfold" style="cursor:pointer">${orderFolded() ? "▸" : "▾"} ${sub}</span></div>`;
    if (!g || g.error)
        return `<div class="omap gantt">${head(g && g.error ? "раскладка не собралась: " + esc(g.error) : "слотов в эпике нет")}</div>`;
    const rows = g.rows, nb = rows.reduce((a, r) => a + (r.bars || []).length, 0);
    if (orderFolded())
        return `<div class="omap gantt fold">${head("строк " + rows.length + " · волн " + nb)}</div>`;
    const now = g.now;
    const [t0, t1] = scale === "all" ? [g.from, g.to] : scale === "6h" ? [now - 5 * H, now + H] : [now - 20 * H, now + 4 * H];
    const qmax = Math.max(0, ...rows.map((r) => (r.queue || []).length));
    const W = Math.max(640, width || 1100), LAB = Math.min(230, Math.max(170, Math.round((width || 1100) * 0.13))), timed = rows.some((r) => (r.bars || []).some((b) => b.phase !== "queue"));
    const GUT = qmax ? Math.min(52 * qmax + 16, timed ? 320 : Math.round((W - LAB) * 0.6)) : 0, X0 = LAB + 8, X1 = W - GUT - 8;
    const QS = qmax ? Math.min(52, (GUT - 16) / qmax) : 0, QW = Math.max(18, QS - 6);
    const RH = 36, TOP = 24, HGT = TOP + rows.length * RH + 6;
    const x = (at) => X0 + ((at - t0) / (t1 - t0)) * (X1 - X0);
    const cx = (at) => Math.max(X0 - 4, Math.min(X1 + 4, x(at)));
    const yr = (i) => TOP + i * RH;
    let o = `<defs><pattern id="ghatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="rgba(245,158,11,.18)"/><line x1="0" y1="0" x2="0" y2="6" stroke="#f59e0b" stroke-width="2.4"/></pattern>`;
    o += `<pattern id="ghatchr" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="rgba(239,68,68,.18)"/><line x1="0" y1="0" x2="0" y2="6" stroke="#ef4444" stroke-width="2.4"/></pattern>`;
    o += `<marker id="garr" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#f59e0b"/></marker><marker id="garr2" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#22c55e"/></marker>`;
    o += `<clipPath id="glabclip"><rect x="0" y="0" width="${LAB - 4}" height="${HGT}"/></clipPath><clipPath id="gclip"><rect x="${X0}" y="0" width="${X1 - X0}" height="${HGT}"/></clipPath></defs>`;
    const span = t1 - t0, step = span <= 8 * H ? H : span <= 36 * H ? 3 * H : span <= 4 * 24 * H ? 12 * H : 24 * H;
    const tz = new Date(t0).getTimezoneOffset() * 60e3;
    for (let t = Math.ceil((t0 - tz) / step) * step + tz; t <= t1; t += step) {
        const xx = x(t), midnight = new Date(t).getHours() === 0;
        o += `<line class="ggrid ${midnight ? "day" : ""}" x1="${xx}" y1="${TOP - 4}" x2="${xx}" y2="${HGT}"/><text class="gtick" x="${xx + 2}" y="${TOP - 8}">${midnight || step >= 24 * H ? dm(t) : hm(t)}</text>`;
    }
    rows.forEach((r, i) => {
        const y = yr(i);
        o += `<rect class="grow ${r.staging ? "stg" : ""}" x="0" y="${y}" width="${W}" height="${RH}"/>`;
        o += `<rect x="3" y="${y + 6}" width="4" height="${RH - 12}" rx="2" fill="${esc(r.color)}"/><g clip-path="url(#glabclip)"><title>${esc(r.tag + (r.title ? " · " + r.title : "") + (r.train ? "\nвагонов: " + (r.bars || []).length : ""))}</title><text class="glab" x="13" y="${y + 15}">${esc(r.tag)}${r.train ? `<tspan class="gcnt" dx="6">${(r.bars || []).length} ваг.</tspan>` : ""}</text><text class="gsub" x="13" y="${y + 28}">${esc(r.staging ? "вливы" : r.title || "")}</text></g>`;
    });
    const geo = new Map();
    let body = "", qbody = "";
    rows.forEach((r, i) => {
        if (r.staging)
            return;
        const y = yr(i) + 9, h = RH - 18;
        let bn = 0;
        for (const b of r.bars || []) {
            if (b.phase === "queue")
                continue;
            const c = colorOf(r, b), a = cx(b.start), e = cx(Math.max(b.end, b.start)), d = b.doneAt ? cx(b.doneAt) : e;
            const act = r.train ? `data-act="wagonplan" data-tree="${esc(r.key)}" data-wave="${esc(b.wave)}"` : `data-act="kbopen" data-tree="${esc(r.key)}"`;
            geo.set(r.key + "|" + b.wave, { x1: a, x2: e, xd: d, y: y + h / 2 });
            const cid = "gb" + i + "_" + bn++;
            body += `<g class="gbar ${b.phase}" ${act}><title>${esc(tip(r, b))}</title><clipPath id="${cid}"><rect x="${a}" y="${y - 1}" width="${Math.max(0, e - a - 3)}" height="${h + 2}"/></clipPath>`;
            if (b.forecast)
                body += `<rect class="gfc" x="${a}" y="${y}" width="${Math.max(2, e - a)}" height="${h}" rx="3" style="--c:${c}"/>`;
            else {
                if (d > a)
                    body += `<rect class="gwork" x="${a}" y="${y}" width="${d - a}" height="${h}" rx="3" fill="${c}"/>`;
                if (e > d)
                    body += `<rect class="gwait" x="${d}" y="${y}" width="${e - d}" height="${h}" rx="3" fill="${c}" stroke="${c}"/>`;
                if (e - a < 3)
                    body += `<rect x="${a - 1.5}" y="${y}" width="3" height="${h}" fill="${c}"/>`;
            }
            for (const w of b.waits || []) {
                const wa = cx(w.from), we = cx(w.to);
                if (we - wa < 1)
                    continue;
                body += `<rect x="${wa}" y="${y + 1}" width="${we - wa}" height="${h - 2}" fill="url(#${w.red ? "ghatchr" : "ghatch"})"/>`;
            }
            const lab = num(b.wave), lw = e - a;
            const room = Math.floor((lw - 10) / 6.1), full = lab + (shortTitle(b.title) ? " · " + shortTitle(b.title) : "");
            if (room >= lab.length)
                body += `<text class="gbl" clip-path="url(#${cid})" x="${a + 6}" y="${y + h / 2 + 4}">${esc(full.length > room ? full.slice(0, Math.max(lab.length, room - 1)) + (room > lab.length + 3 ? "…" : "") : full)}</text>`;
            {
                const qs = (b.questions || []).slice().sort((p, q) => p.at - q.at);
                qs.forEach((q, k) => {
                    body += qMark(q, y - 2, now, cx, 6, qs[k + 1] ? cx(qs[k + 1].at) - cx(q.at) : Infinity);
                });
            }
            body += `</g>`;
        }
        for (const s of r.syncs || []) {
            if (s.at < t0 || s.at > t1)
                continue;
            const sx = x(s.at);
            body += `<path class="gsync" d="M${sx - 4},${y + h + 7} L${sx},${y + h + 1} L${sx + 4},${y + h + 7} z"><title>${esc("подтянула staging " + when(s.at) + (s.how === "ff" ? " (перемотка)" : s.how === "merge" ? " (слияние)" : ""))}</title></path>`;
        }
        if (r.stale) {
            const sx = cx(r.stale.at);
            body += `<g class="gstale"><title>${esc("отстаёт от staging на " + r.stale.behind + " коммит(ов), пересекаются " + r.stale.n + " файл(ов):\n" + r.stale.files.join("\n") + "\nподтянуть staging до влива")}</title><line x1="${sx}" y1="${y - 5}" x2="${sx}" y2="${y + h + 5}"/><text x="${sx + 3}" y="${y - 1}">⚠ ${r.stale.n}</text></g>`;
        }
        ;
        (r.queue || []).forEach((q, k) => {
            const qx = X1 + 12 + k * QS;
            geo.set(r.key + "|" + q.wave, { x1: qx, x2: qx + QW, xd: qx, y: y + h / 2, queue: true });
            qbody += `<g class="gbar queue" ${r.train ? `data-act="wagonplan" data-tree="${esc(r.key)}" data-wave="${esc(q.wave)}"` : `data-act="kbopen" data-tree="${esc(r.key)}"`}><title>${esc(q.wave + (q.title ? " · " + q.title : "") + "\n" + r.tag + " · в очереди #" + (k + 1) + ((q.after || []).length ? "\nпосле: " + q.after.join(", ") : "") + "\nклик — " + (r.train ? "план вагона" : "карточка слота"))}</title><rect class="gqueue" x="${qx}" y="${y}" width="${QW}" height="${h}" rx="3" style="--c:${colorOf(r, q)}"/><text class="gbl q" x="${qx + QW / 2}" y="${y + h / 2 + 4}">${esc(num(q.wave))}</text></g>`;
        });
    });
    const ys = yr(0) + RH / 2, stg = rows[0];
    for (const m of stg.marks || []) {
        if (m.at < t0 || m.at > t1)
            continue;
        const mx = x(m.at), r = rows.find((z) => z.key === m.key) || {};
        const c = r.train && m.ci >= 0 ? PAL[m.ci % PAL.length] : m.color;
        body += `<g class="gmerge" ${r.train ? `data-act="wagonplan" data-tree="${esc(m.key)}" data-wave="${esc(m.wave)}"` : `data-act="kbopen" data-tree="${esc(m.key)}"`}><title>${esc("влит " + m.wave + " (" + m.tag + ") " + when(m.at) + (m.sha ? "\n" + String(m.sha).slice(0, 10) : ""))}</title><path d="M${mx},${ys - 8} L${mx + 7},${ys} L${mx},${ys + 8} L${mx - 7},${ys} z" fill="${c}"/></g>`;
    }
    for (const q of stg.questions || [])
        if (q.at <= t1 && (q.answeredAt || (q.open ? now : q.at)) >= t0)
            body += qMark(q, ys + 10, now, cx, 5);
    let links = "";
    for (const l of g.links || []) {
        const a = geo.get(l.from.key + "|" + l.from.wave), b = geo.get(l.to.key + "|" + l.to.wave);
        if (!a || !b)
            continue;
        const x1 = a.queue ? a.x2 : l.from.at ? cx(l.from.at) : a.x2, x2 = b.queue ? b.x1 : l.to.at ? cx(l.to.at) : b.x1;
        const y1 = a.y, y2 = b.y, mx = (x1 + x2) / 2;
        links += `<path class="glink ${l.live ? "live" : "ok"}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" marker-end="url(#${l.live ? "garr" : "garr2"})"><title>${esc(l.from.wave + " → " + l.to.wave + (l.live ? ": ещё не влит" : ": уже в staging"))}</title></path>`;
    }
    const nx = x(now);
    const nowLine = nx >= X0 && nx <= X1 ? `<line class="gnow" x1="${nx}" y1="${TOP - 4}" x2="${nx}" y2="${HGT}"/><text class="gnowt" ${nx > W - 90 ? `text-anchor="end" x="${nx - 4}"` : `x="${nx + 4}"`} y="${TOP - 8}">сейчас ${hm(now)}</text>` : "";
    const gut = GUT ? `<text class="gtick" x="${X1 + 12}" y="${TOP - 8}">очередь →</text><line class="ggrid day" x1="${X1 + 4}" y1="${TOP - 4}" x2="${X1 + 4}" y2="${HGT}"/>` : "";
    const svg = `<svg class="gsvg" width="${W}" height="${HGT}" viewBox="0 0 ${W} ${HGT}">${o}${gut}<g clip-path="url(#gclip)">${body}</g>${qbody}${links}${nowLine}</svg>`;
    const waitN = rows.reduce((a, r) => a + (r.bars || []).filter((b) => b.phase === "wait").length, 0), qOpen = rows.reduce((a, r) => a + [...(r.bars || []).flatMap((b) => b.questions || []), ...(r.questions || [])].filter((q) => q.open).length, 0);
    const sub = `строк ${rows.length - 1} · волн ${nb} · ждут влива ${waitN}${qOpen ? ` · <b>вопросов ждут ответа ${qOpen}</b>` : ""} · ${esc(g.forecast && g.forecast.note || "")}`;
    return `<div class="omap gantt">${head(sub)}<div class="gwrap">${svg}</div><details class="omleg gleg mute"><summary>Обозначения</summary>Полоса: <span class="glg work"></span> работа агента до «ГОТОВО», <span class="glg wait"></span> ожидание проверок и влива, <span class="glg hatch"></span> ВЛИТЬ ждёт зелёного, ◆ влив на строке staging, <span style="color:#f59e0b">?</span> вопрос владельцу (линия — сколько ждёт ответа), <span style="color:#14b8a6">▲</span> ветка подтянула staging, <span style="color:#ef4444">⚠</span> отстаёт от staging и правит те же файлы, <span style="color:#f59e0b">━</span>/<span style="color:#22c55e">┅</span> ПОРЯДОК (ждёт / уже в staging)${GUT ? ", справа — очередь без прогноза" : ""}. Наведение — подробности, клик — план вагона или карточка слота.</details></div>`;
}
