// annot-rules.mjs — чистые правила разметки: разбиение markdown на блоки, построчный дифф, нормализация замечаний и
// тексты сообщений агенту (замечания к документу, к правке, одобрение, ответ на вопрос). Без файлов и сети.
const FENCE = /^\s*(```|~~~)/, HEAD = /^(#{1,6})\s+(.*)$/, ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/, ROW = /^\s*\|.*\|\s*$/, SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/, HR = /^\s*([-*_])(\s*\1){2,}\s*$/, QUOTE = /^\s*>\s?(.*)$/;

export function mdBlocks(text) {
    const ls = String(text ?? "").replace(/\r\n?/g, "\n").split("\n"), out = [];
    const add = (kind, from, to, extra = {}) => out.push({ i: out.length, kind, line: from + 1, end: to + 1, text: ls.slice(from, to + 1).join("\n"), ...extra });
    let i = 0;
    if (ls[0] === "---") {
        const e = ls.indexOf("---", 1);
        if (e > 0) {
            add("fm", 0, e);
            i = e + 1;
        }
    }
    while (i < ls.length) {
        const l = ls[i];
        if (!l.trim()) {
            i++;
            continue;
        }
        if (FENCE.test(l)) {
            const f = FENCE.exec(l)[1];
            let j = i + 1;
            while (j < ls.length && !ls[j].trim().startsWith(f))
                j++;
            add("code", i, Math.min(j, ls.length - 1), { lang: l.trim().slice(3).trim() });
            i = j + 1;
            continue;
        }
        let m;
        if ((m = HEAD.exec(l))) {
            add("h", i, i, { level: m[1].length });
            i++;
            continue;
        }
        if (HR.test(l)) {
            add("hr", i, i);
            i++;
            continue;
        }
        if (ROW.test(l)) {
            const head = i + 1 < ls.length && SEP.test(ls[i + 1]);
            const cells = (s) => s.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
            add("tr", i, i, { cells: cells(l), head });
            i++;
            if (head)
                i++;
            while (i < ls.length && ROW.test(ls[i])) {
                if (!SEP.test(ls[i]))
                    add("tr", i, i, { cells: cells(ls[i]) });
                i++;
            }
            continue;
        }
        if ((m = ITEM.exec(l))) {
            const ind = m[1].length;
            let j = i + 1;
            while (j < ls.length && ls[j].trim() && !ITEM.test(ls[j]) && !HEAD.test(ls[j]) && !FENCE.test(ls[j]) && (/^\s/.test(ls[j]) && ls[j].search(/\S/) > ind))
                j++;
            const ck = /^\[([ xX])\]\s+/.exec(m[3]);
            add("li", i, j - 1, { depth: Math.floor(ind / 2), ordered: /\d/.test(m[2]), marker: m[2], ...(ck ? { checked: ck[1] !== " " } : {}) });
            i = j;
            continue;
        }
        if (QUOTE.test(l)) {
            let j = i + 1;
            while (j < ls.length && QUOTE.test(ls[j]))
                j++;
            add("quote", i, j - 1);
            i = j;
            continue;
        }
        let j = i + 1;
        while (j < ls.length && ls[j].trim() && !FENCE.test(ls[j]) && !HEAD.test(ls[j]) && !ITEM.test(ls[j]) && !ROW.test(ls[j]) && !QUOTE.test(ls[j]) && !HR.test(ls[j]))
            j++;
        add("p", i, j - 1);
        i = j;
    }
    return out;
}

export function fragmentLine(block, frag) {
    const f = String(frag || "").replace(/\s+/g, " ").trim();
    if (!f || !block)
        return block ? block.line : null;
    const plain = (s) => s.replace(/[*_`~]|\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ");
    const ls = block.text.split("\n"), probe = f.slice(0, 40);
    for (let k = 0; k < ls.length; k++)
        if (plain(ls[k]).includes(probe))
            return block.line + k;
    for (let k = 0; k < ls.length; k++)
        if (plain(ls[k]).includes(f.slice(0, 12)))
            return block.line + k;
    return block.line;
}

export function lineDiff(a, b, CAP = 4e6) {
    const A = String(a ?? "").replace(/\r\n?/g, "\n").split("\n"), B = String(b ?? "").replace(/\r\n?/g, "\n").split("\n"), ops = [];
    let p = 0;
    while (p < A.length && p < B.length && A[p] === B[p])
        p++;
    let s = 0;
    while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s])
        s++;
    for (let k = 0; k < p; k++)
        ops.push({ t: "=", a: k + 1, b: k + 1, s: A[k] });
    const a0 = A.slice(p, A.length - s), b0 = B.slice(p, B.length - s), n = a0.length, m = b0.length;
    if (n * m > CAP) {
        a0.forEach((x, k) => ops.push({ t: "-", a: p + k + 1, s: x }));
        b0.forEach((x, k) => ops.push({ t: "+", b: p + k + 1, s: x }));
    }
    else if (n || m) {
        const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
        for (let x = n - 1; x >= 0; x--)
            for (let y = m - 1; y >= 0; y--)
                L[x][y] = a0[x] === b0[y] ? L[x + 1][y + 1] + 1 : Math.max(L[x + 1][y], L[x][y + 1]);
        let x = 0, y = 0;
        while (x < n || y < m) {
            if (x < n && y < m && a0[x] === b0[y]) {
                ops.push({ t: "=", a: p + x + 1, b: p + y + 1, s: a0[x] });
                x++;
                y++;
            }
            else if (x < n && (y >= m || L[x + 1][y] >= L[x][y + 1])) {
                ops.push({ t: "-", a: p + x + 1, s: a0[x] });
                x++;
            }
            else {
                ops.push({ t: "+", b: p + y + 1, s: b0[y] });
                y++;
            }
        }
    }
    for (let k = 0; k < s; k++)
        ops.push({ t: "=", a: A.length - s + k + 1, b: B.length - s + k + 1, s: A[A.length - s + k] });
    return ops;
}

export const diffStat = (ops) => ({ add: ops.filter((o) => o.t === "+").length, del: ops.filter((o) => o.t === "-").length });

export function diffHunks(ops, ctx = 2) {
    const keep = new Set();
    ops.forEach((o, k) => {
        if (o.t !== "=")
            for (let d = -ctx; d <= ctx; d++)
                keep.add(k + d);
    });
    const out = [];
    let gap = false;
    ops.forEach((o, k) => {
        if (keep.has(k)) {
            if (gap && out.length)
                out.push({ t: "…" });
            gap = false;
            out.push(o);
        }
        else
            gap = true;
    });
    return out;
}

export function textHash(s) {
    let h = 0x811c9dc5;
    for (const ch of String(s ?? "")) {
        h ^= ch.codePointAt(0);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36) + ":" + String(s ?? "").length;
}

export const NOTE_KINDS = { note: "замечание", question: "вопрос", delete: "удалить", replace: "заменить" };

const cap = (s, n) => {
    s = String(s ?? "");
    return s.length > n ? s.slice(0, n) + "…" : s;
};

export function normNote(n, blocks) {
    if (!n || typeof n !== "object")
        return null;
    const kind = NOTE_KINDS[n.kind] ? n.kind : "note", text = cap(String(n.text || "").trim(), 3000), repl = cap(String(n.replace || "").trim(), 3000);
    if (kind === "replace" && !repl)
        return null;
    if (!text && kind !== "delete" && kind !== "replace")
        return null;
    const out = { kind, text, at: Number(n.at) || Date.now() };
    if (kind === "replace")
        out.replace = repl;
    if (n.path !== undefined) {
        const p = String(n.path || "");
        if (!p || p.includes("\0") || /(^|[\\/])\.\.([\\/]|$)/.test(p) || /^([a-z]:|[\\/])/i.test(p))
            return null;
        const l1 = Math.max(1, Math.floor(Number(n.line) || 0)), l2 = Math.max(l1, Math.floor(Number(n.lineEnd) || l1));
        if (!Number(n.line))
            return null;
        return { ...out, path: p, line: l1, lineEnd: Math.min(l2, l1 + 400), side: n.side === "old" ? "old" : "new", code: cap(n.code, 1500) };
    }
    const bs = blocks || [], b = bs.find((x) => x.i === Number(n.block));
    if (!b)
        return null;
    const b2 = n.blockEnd != null ? bs.find((x) => x.i === Number(n.blockEnd)) : null, last = b2 && b2.i > b.i ? b2 : b;
    const sel = cap(String(n.sel || "").trim(), 1500);
    return { ...out, block: b.i, blockEnd: last.i, line: sel ? fragmentLine(b, sel) : b.line, lineEnd: last.end, sel, quote: cap(sel || bs.filter((x) => x.i >= b.i && x.i <= last.i).map((x) => x.text).join("\n"), 1500) };
}

const quoteOf = (s) => String(s || "").split("\n").slice(0, 12).map((l) => "   > " + l).join("\n") + (String(s || "").split("\n").length > 12 ? "\n   > …" : "");
const lines = (n) => (n.lineEnd && n.lineEnd !== n.line ? "строки " + n.line + "–" + n.lineEnd : "строка " + n.line);

function noteBody(n) {
    if (n.kind === "delete")
        return "   Удалить этот фрагмент." + (n.text ? " " + n.text : "");
    if (n.kind === "replace")
        return "   Заменить на:\n" + n.replace.split("\n").map((l) => "   | " + l).join("\n") + (n.text ? "\n   Почему: " + n.text : "");
    if (n.kind === "question")
        return "   Вопрос: " + n.text;
    return "   " + n.text.split("\n").join("\n   ");
}

export function docMessage(doc, notes, general = "") {
    const ns = [...notes].sort((a, b) => (a.line || 0) - (b.line || 0)), q = ns.filter((n) => n.kind === "question").length;
    const what = doc.kind === "checklist" ? "чек-листу приёмки " + (doc.wave || "") : doc.kind === "plan" ? "плану волны " + (doc.wave || "") : "документу " + (doc.title || "");
    const head = "Замечания владельца к " + what.trim() + (doc.file ? " (файл " + doc.file + ")" : "") + " — " + ns.length + " шт., разметка в диспетчерской." +
        (doc.kind === "checklist" ? " Поправь чек-лист по каждому пункту и пришли его заново блоком ```checklist```." : " Внеси правки в файл по каждому пункту; номера строк — по версии, которую читал владелец.") +
        (q ? " На вопросы (" + q + ") ответь в начале ответа, по номерам." : "");
    const body = ns.map((n, k) => (k + 1) + ". [" + NOTE_KINDS[n.kind] + "] " + (doc.kind === "checklist" && n.item ? "пункт " + n.item + ", " : "") + lines(n) + "\n" + quoteOf(n.quote) + "\n" + noteBody(n)).join("\n\n");
    return [head, body, general ? "Общее замечание владельца: " + general : "", doc.kind === "checklist" ? "" : "Когда закончишь — коротко: что поменял по каждому номеру (план владелец перечитает с подсветкой изменений)."].filter(Boolean).join("\n\n");
}

export function diffMessage(ctx, notes, general = "") {
    const ns = [...notes].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    const head = "Ревью владельца по диффу ветки " + (ctx.branch || "") + " против staging — " + ns.length + " замечани" + (ns.length === 1 ? "е" : ns.length < 5 ? "я" : "й") + ". Исправь в коде по каждому пункту (тесты гоняет владелец; коммит — по правилу КОММИТ твоей подсказки, строка Wave:); на вопросы ответь в начале ответа.";
    const body = ns.map((n, k) => (k + 1) + ". " + n.path + ":" + n.line + (n.lineEnd > n.line ? "–" + n.lineEnd : "") + (n.side === "old" ? " (удалённая строка, по staging)" : "") + " [" + NOTE_KINDS[n.kind] + "]\n" + (n.code ? n.code.split("\n").slice(0, 12).map((l) => "   │ " + l).join("\n") + "\n" : "") + noteBody(n)).join("\n\n");
    return [head, body, general ? "Общее: " + general : "", "Ответ — одним блоком: что исправил по каждому номеру (файл:строка), что не стал и почему."].filter(Boolean).join("\n\n");
}

export function approveMessage(doc, general = "") {
    return "Владелец одобрил " + (doc.kind === "plan" ? "план волны " + (doc.wave || "") : "документ " + (doc.title || "")) + (doc.file ? " (" + doc.file + ")" : "") + ": план одобрен, работай по нему." + (general ? "\nКомментарий владельца: " + general : "") + "\nЕсли в плане остались открытые вопросы владельцу — они считаются снятыми этим одобрением, кроме явно названных в комментарии.";
}

export function answerRoute(itemSid, liveSid) {
    return itemSid && liveSid && itemSid === liveSid ? "same" : "other";
}

export function answerText(item, answer, route, ctx = {}) {
    const ans = String(answer || "").trim();
    if (route === "same")
        return "Ответ владельца на твои «Вопросы владельцу»:\n\n" + ans + "\n\nПродолжай работу с учётом ответа.";
    const when = item.at ? new Date(item.at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "?";
    return ["Ответ владельца на вопросы, которые задала прошлая сессия этого " + (ctx.orch ? "оркестратора" : "слота") + " (" + (item.sid ? "сессия " + String(item.sid).slice(0, 8) : "сессия не записана") + ", " + when + "). Сессия с тех пор сменилась" + (ctx.why ? " (" + ctx.why + ")" : "") + " — вот вопрос целиком:",
        String(item.text || "").split("\n").map((l) => "> " + l).join("\n"),
        "Ответ владельца:\n\n" + ans,
        [ctx.tag || ctx.wave ? "Волна: " + [ctx.tag, ctx.wave].filter(Boolean).join(" · ") : "", ctx.branch ? "Ветка: " + ctx.branch : "", ctx.plan ? "План: " + ctx.plan : ""].filter(Boolean).join("\n"),
        "Прочитай план и своё последнее состояние в ветке, затем продолжай работу с учётом ответа."].filter(Boolean).join("\n\n");
}
