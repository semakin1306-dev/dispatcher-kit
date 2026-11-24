// owner-options.mjs — раздел «Вопросы владельцу» из ответа агента → вопросы с вариантами-кнопками. Один разбор и для
// страницы, и для режима «без владельца»: варианты берутся из текста агента, а не зашиты.
const KEY = "[а-яёa-z]";
const HEAD_RE = /^[\s*_#>]*Вопрос(?:ы)?\s+владельцу[^:\n]{0,40}:?[\s*_]*$/i;
const NUM_RE = /^\s*(\d+)[.)]\s+(.*)$/;
const OPT_LINE_RE = new RegExp("^\\s*(?:[-*•]\\s*)?\\((" + KEY + ")\\)\\s+(.+?)\\s*$", "i");
const OPT_INLINE_RE = new RegExp("\\((" + KEY + ")\\)\\s*([^;()]*?[^;().\\s][^;()]*?)(?=\\s*;|\\s*\\(" + KEY + "\\)|\\.\\s*(?:$|[А-ЯЁA-Z])|$)", "gi");
const REC_TAIL_RE = /\s*(?:[—–-]\s*|\(\s*)?(?:рекоменд[а-яё]*|★)\s*\)?\s*\.?\s*$/i;
const REC_HEAD_RE = new RegExp("рекоменд[а-яё]*\\s*[:—-]?\\s*\\(?(" + KEY + ")\\)", "i");
const isKey = (k) => new RegExp("^" + KEY + "$", "i").test(String(k || ""));

function optionOf(k, raw) {
    let v = String(raw || "").trim(), rec = false;
    if (/^★\s*/.test(v)) {
        rec = true;
        v = v.replace(/^★\s*/, "");
    }
    if (REC_TAIL_RE.test(v)) {
        rec = true;
        v = v.replace(REC_TAIL_RE, "").trim();
    }
    return { k: k.toLowerCase(), v, rec };
}

export function ownerQuestions(text) {
    const ls = String(text || "").split(/\r?\n/), out = [];
    const i = ls.findIndex((l) => HEAD_RE.test(l));
    if (i < 0)
        return out;
    let cur = null;
    const nextFilled = (k) => ls.slice(k + 1).find((x) => x.trim());
    for (let k = i + 1; k < ls.length; k++) {
        const l = ls[k], m = NUM_RE.exec(l);
        if (m) {
            cur = { n: m[1], text: m[2], lines: [] };
            out.push(cur);
            continue;
        }
        if (!l.trim()) {
            const nx = nextFilled(k);
            if (cur && nx && (NUM_RE.test(nx) || OPT_LINE_RE.test(nx)))
                continue;
            break;
        }
        const o = cur && OPT_LINE_RE.exec(l);
        if (o) {
            cur.lines.push(optionOf(o[1], o[2]));
            continue;
        }
        if (cur && /^\s+\S/.test(l)) {
            cur.text += " " + l.trim();
            continue;
        }
        break;
    }
    for (const q of out) {
        let opts = q.lines;
        if (!opts.length) {
            const m = new Map();
            for (const x of q.text.replace(REC_HEAD_RE, " ").matchAll(OPT_INLINE_RE)) {
                const k = x[1].toLowerCase(), v = x[2].trim();
                if (v.length > 2 && (!m.has(k) || m.get(k).length < v.length))
                    m.set(k, v);
            }
            opts = [...m].map(([k, v]) => optionOf(k, v));
        }
        const seen = new Set();
        opts = opts.filter((o) => o.v && !seen.has(o.k) && seen.add(o.k));
        const rh = REC_HEAD_RE.exec(q.text);
        if (rh && !opts.some((o) => o.rec))
            for (const o of opts)
                if (o.k === rh[1].toLowerCase())
                    o.rec = true;
        q.options = opts;
        q.head = q.text.split(/\s*(?:Рекоменд[а-яё]*|Варианты\s*:)/i)[0].split(new RegExp("\\s*\\(" + KEY + "\\)\\s"))[0].trim() || q.text;
        delete q.lines;
    }
    return out;
}

export const quickOptions = (q) => (q && Array.isArray(q.options) ? q.options : []);
export const recommended = (q) => quickOptions(q).find((o) => o.rec) || null;
export const optPrefix = (o) => (isKey(o && o.k) ? "(" + o.k + ") " : "");
export const answerText = (q, o) => "Вопрос " + q.n + ": " + optPrefix(o) + o.v;

export function composeAnswers(rows, extra = "") {
    const lines = [], answered = [], missing = [];
    for (const r of rows || []) {
        const custom = String(r.custom || "").trim(), picked = String(r.picked || "").trim();
        if (custom) {
            lines.push("Вопрос " + r.n + ": " + custom);
            answered.push(String(r.n));
        }
        else if (picked) {
            lines.push(picked);
            answered.push(String(r.n));
        }
        else
            missing.push(String(r.n));
    }
    const x = String(extra || "").trim();
    if (x)
        lines.push((lines.length ? "\n" : "") + x);
    return { text: lines.join("\n"), answered, missing };
}

export function questionsKey(qs) {
    let h = 0;
    for (const c of (qs || []).map((q) => q.n + ":" + q.head).join("|"))
        h = (h * 31 + c.charCodeAt(0)) | 0;
    return (h >>> 0).toString(36);
}
