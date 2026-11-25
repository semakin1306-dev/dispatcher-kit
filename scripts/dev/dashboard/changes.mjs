// changes.mjs — изменения слота для страницы: список изменённых файлов рабочей копии и ветки относительно staging, дифф
// одного файла (с отсечкой чувствительных путей) и граф коммитов.
import { MAIN } from "../slots.mjs";
import fs from "node:fs";
import path from "node:path";
import { snapNow } from "./snapshot.mjs";
import { git } from "./git.mjs";
import { settings } from "./config.mjs";

export const graphCaches = new Map();

export async function graphData(view) {
    const graphCache = graphCaches.get(view) || { at: 0, v: null };
    if (graphCache.v && Date.now() - graphCache.at < 8000)
        return graphCache.v;
    const slots = (snapNow() ? snapNow().trees : []).filter((t) => (!t.epic || t.epic === view) && t.exists && t.branch && !["staging", "main", "HEAD"].includes(t.branch));
    const refs = ["main", "staging", ...new Set(slots.map((t) => t.branch))];
    const r = await git(MAIN, ["log", "--topo-order", "-n", "90", "--format=%h%x09%p%x09%D%x09%s%x09%cr", ...refs], 60000);
    const commits = (r.out || "").split("\n").filter(Boolean).map((l) => {
        const [sha, ps, d, subject, when] = l.split("\t");
        return {
            sha,
            parents: ps ? ps.split(" ") : [],
            refs: (d || "")
                .split(", ")
                .map((x) => x.replace(/^HEAD -> /, "").trim())
                .filter((x) => x && x !== "HEAD" && !x.startsWith("origin/") && !x.startsWith("tag: ")),
            subject: subject || "",
            when: when || "",
        };
    });
    const lines = (r) => new Set((r.out || "").split("\n").map((x) => x.trim()).filter(Boolean));
    const [mainR, stagR, ...slotR] = await Promise.all([
        git(MAIN, ["log", "main", "--first-parent", "--format=%h", "-n", "700"], 60000),
        git(MAIN, ["log", "staging", "--first-parent", "--format=%h", "-n", "700"], 60000),
        ...slots.map((t) => git(MAIN, ["log", "staging.." + t.branch, "--format=%h", "-n", "200"], 60000)),
    ]);
    const mainS = lines(mainR), stagS = lines(stagR), slotS = slotR.map(lines);
    for (const c of commits) {
        const si = slotS.findIndex((x) => x.has(c.sha));
        if (si >= 0) {
            c.owner = "slot";
            c.color = slots[si].color;
        }
        else if (mainS.has(c.sha))
            c.owner = "main";
        else if (stagS.has(c.sha))
            c.owner = "staging";
        else
            c.owner = "other";
    }
    const v = { commits, branches: slots.map((t) => ({ name: t.branch, tag: t.tag, color: t.color, ahead: t.ahead, behind: t.behind })) };
    graphCaches.set(view, { at: Date.now(), v });
    return v;
}

export const SENSITIVE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_(rsa|ed25519)|.*\.p12|credentials.*\.json|\.git-credentials.*)$/i;
/**
 * Подпись коммита, который человек делает со страницы: строка из настроек (settings.commitTrailer, например
 * «Co-Authored-By: …»). По умолчанию пусто — коммит без подписи; имени модели в коде нет.
 */
export const commitTrailer = () => String(settings.commitTrailer || "").trim();
/** Сообщение коммита с подписью из настроек; подпись уже есть или не задана — сообщение как есть. */
export function withTrailer(msg) {
    const t = commitTrailer(), m = String(msg || "");
    return !t || m.includes(t) ? m : m.replace(/\s+$/, "") + "\n\n" + t;
}

export const STATUS_WORD = { M: "изменён", A: "добавлен", D: "удалён", R: "переименован", C: "скопирован", "?": "новый", U: "конфликт", T: "тип" };
export const safeRel = (p) => typeof p === "string" && p && !p.includes("\0") && !path.isAbsolute(p) && !p.split(/[\\/]/).includes("..");

export async function workChanges(cwd) {
    const st = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], 60000, true);
    const num = await git(cwd, ["diff", "--numstat", "-z", "HEAD"], 60000);
    const stats = new Map();
    if (num.out) {
        for (const rec of num.out.split("\0")) {
            const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(rec);
            if (m)
                stats.set(m[3], { add: m[1] === "-" ? null : +m[1], del: m[2] === "-" ? null : +m[2] });
        }
    }
    const files = [];
    const parts = st.out ? st.out.split("\0") : [];
    for (let i = 0; i < parts.length; i++) {
        const rec = parts[i];
        if (rec.length < 4)
            continue;
        const x = rec[0], y = rec[1], p = rec.slice(3);
        if (x === "R" || x === "C")
            i++;
        const code = x === "?" ? "?" : (y !== " " ? y : x);
        files.push({ path: p, code, status: STATUS_WORD[code] || code, untracked: x === "?", staged: x !== " " && x !== "?", ...(stats.get(p) || {}), sensitive: SENSITIVE.test(p) });
    }
    return files.slice(0, 600);
}

export async function branchChanges(cwd) {
    const ns = await git(cwd, ["diff", "--numstat", "-z", "staging...HEAD"], 60000);
    const stats = new Map();
    for (const rec of (ns.out || "").split("\0")) {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(rec);
        if (m)
            stats.set(m[3], { add: m[1] === "-" ? null : +m[1], del: m[2] === "-" ? null : +m[2] });
    }
    const names = await git(cwd, ["diff", "--name-status", "-z", "staging...HEAD"], 60000);
    const out = [], parts = (names.out || "").split("\0");
    for (let i = 0; i < parts.length; i++) {
        const s = parts[i];
        if (!s)
            continue;
        const code = s[0];
        let p = parts[++i];
        if (code === "R" || code === "C")
            p = parts[++i];
        out.push({ path: p, code, status: STATUS_WORD[code] || code, ...(stats.get(p) || {}) });
    }
    return out.slice(0, 600);
}

export async function fileDiff(cwd, scope, p) {
    const CAP = 200000;
    if (scope === "branch") {
        const r = await git(cwd, ["diff", "--no-color", "-U4", "staging...HEAD", "--", p], 60000);
        return r.out.length > CAP ? r.out.slice(0, CAP) + "\n… (обрезано)" : r.out || "(нет изменений)";
    }
    const files = await workChanges(cwd), f = files.find((x) => x.path === p);
    if (!f)
        return "(файл уже не числится изменённым)";
    if (f.untracked) {
        try {
            const abs = path.join(cwd, p), buf = fs.readFileSync(abs);
            if (buf.includes(0))
                return `(бинарный файл, ${buf.length} байт)`;
            const txt = buf.toString("utf8"), lines = txt.split("\n");
            return `новый файл: ${p} (${lines.length} строк)\n` + lines.slice(0, 2500).map((l) => "+" + l).join("\n") + (lines.length > 2500 ? "\n… (обрезано)" : "");
        }
        catch (e) {
            return "(не удалось прочитать: " + e.message + ")";
        }
    }
    const r = await git(cwd, ["diff", "--no-color", "-U4", "HEAD", "--", p], 60000);
    return r.out.length > CAP ? r.out.slice(0, CAP) + "\n… (обрезано)" : r.out || "(нет изменений)";
}
