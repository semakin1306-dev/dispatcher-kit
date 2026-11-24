// retro-failures.mjs — подписи провалов прогонов и их группы для ретро эпика. Красный прогон и его лог → подписи
// (причина окружения, упавший гард, нормализованная причина теста) → группы одинаковых провалов: сколько раз, в каких
// слотах, повторял ли агент ту же ошибку после правки. Чистые функции; разбор лога — digest.mjs.
import { cleanLines, envCauses, failsOf, logKind } from "./digest.mjs";

/** Путь без корней рабочих копий (их передаёт вызывающий) и с прямыми слэшами. */
const relTo = (roots) => (s) => {
    let out = String(s || "").replace(/\\/g, "/");
    for (const r of roots)
        if (r)
            out = out.split(String(r).replace(/\\/g, "/").replace(/\/+$/, "") + "/").join("");
    return out;
};

/** Причина без частностей: числа, кавычки, хеши — заглушками; по ней группируются одинаковые ошибки разных тестов. */
export function normReason(s, rel = relTo([])) {
    return rel(s).replace(/\s+/g, " ").trim()
        .replace(/(['"`«])[^'"`»]{1,80}(['"`»])/g, "$1…$2").replace(/\b[0-9a-f]{7,40}\b/gi, "#").replace(/\d+([.,]\d+)?/g, "N")
        .replace(/\s+@.*$/, "").slice(0, 160);
}

// Общий текст матчера («expect(received).toBe(expected)», короткое «Error: x» из мока) о причине не говорит:
// такие провалы группируются по спеке, а не по тексту.
const GENERIC_MATCHER = /^(Error: )?expect\(|^AssertionError: expected |^AssertionError: promise resolved|^Expected|^Received|^Error: [\p{L}\p{N}_-]{1,12}$|^Error: спека висит/u;

/** Задачи не про код волны: из их провалов в счёт идёт только окружение. */
export const NOT_CODE_TASKS = new Set(["commit", "merge", "slot-up", "accept-ask", "deploy-staging", "release"]);
/** Причины окружения, которые относятся к машине и инфраструктуре, а не к проекту. */
export const ENV_INFRA = new Set(["disk", "git-push", "snapshot", "oom", "killed", "network", "db", "perm", "dirty-tree"]);

/** Подписи провала прогона. `roots` — корни рабочих копий: пути в причинах становятся относительными. */
export function failSignatures(job, logText, { roots = [] } = {}) {
    const rel = relTo(roots), L = cleanLines(logText), kind = logKind(L), out = [];
    const env = envCauses(L);
    for (const e of env)
        out.push({ key: "env:" + e.key, cat: ENV_INFRA.has(e.key) ? "infra" : "env", label: e.label, reason: rel(e.line).slice(0, 200) });
    const { fails, files } = failsOf(L, kind);
    if (kind === "security" || kind === "guard")
        for (const f of fails)
            out.push({ key: "guard:" + f.what.replace(/^guard:/, ""), cat: "guard", label: f.what, reason: rel(f.why).slice(0, 300), files: f.where ? f.where.split(", ") : [] });
    else if (kind === "selftest")
        for (const f of fails)
            out.push({ key: "selftest:" + f.what.replace(/\s*\(.*$/, ""), cat: "selftest", label: f.what.replace(/\s*\(.*$/, ""), reason: rel(f.why).slice(0, 300), files: [f.where] });
    else if (["jest", "vitest", "playwright", "tsc"].includes(kind)) {
        const seen = new Set(), envLines = env.map((e) => e.line);
        for (const f of fails) {
            const first = String(f.why || "").split(" · ")[0].replace(/\s*\(×\d+\)$/, ""), spec = rel((f.where || (files || [])[0] || "").split(":")[0]);
            // причина уже учтена окружением
            if (!first || envLines.some((l) => l.includes(first.slice(0, 40)) || first.includes(l.slice(0, 40))))
                continue;
            const generic = (kind !== "playwright" && GENERIC_MATCHER.test(first)) || (kind === "playwright" && /^Error: expect\(received\)|^Error: (?!expect\()[/\w]/.test(first));
            const key = kind === "tsc" ? "tsc:" + f.what.split(" ")[0] : generic ? kind + ":spec:" + spec : kind + ":" + normReason(first, rel);
            if (seen.has(key))
                continue;
            seen.add(key);
            out.push({ key, cat: generic ? "spec" : "test", kind, label: generic ? spec : kind === "tsc" ? f.what.split(" ")[0] + " " + normReason(first, rel) : normReason(first, rel), reason: rel(first).slice(0, 240), test: f.what.slice(0, 200), files: [...new Set([...(files || []), spec].filter(Boolean))].map(rel).slice(0, 5) });
        }
    }
    if (!out.length && job.status === "fail")
        out.push({ key: "other:" + job.task + ":" + normReason(job.summary || "без итога", rel).slice(0, 80), cat: "other", label: job.task, reason: rel(job.summary || "").slice(0, 200) });
    return out;
}

/**
 * Группы одинаковых провалов. entries — [{ job, sigs }]. «Агент повторял»: в одном слоте та же подпись падала на разном
 * коде. У группы — разные причины с примерами прогонов: у гарда они бывают разными, а показать надо все.
 */
export function groupFailures(entries) {
    const by = new Map();
    for (const { job, sigs } of entries)
        for (const s of sigs) {
            const g = by.get(s.key) || { ...s, n: 0, jobs: [], trees: new Set(), tasks: new Set(), files: new Set(), first: Infinity, last: 0, perTree: new Map() };
            g.n++;
            g.jobs.push(job.id);
            g.trees.add(job.tree);
            g.tasks.add(job.task);
            for (const f of s.files || [])
                g.files.add(f);
            const at = job.endedAt || job.startedAt || job.queuedAt || 0;
            g.first = Math.min(g.first, at);
            g.last = Math.max(g.last, at);
            const pt = g.perTree.get(job.tree) || [];
            pt.push({ id: job.id, fp: job.fpStart || job.fpEnd || "", at });
            g.perTree.set(job.tree, pt);
            if (s.reason) {
                const rk = normReason(s.reason).slice(0, 120), r = (g.why || (g.why = new Map())).get(rk) || { text: s.reason, n: 0, jobs: [] };
                r.n++;
                if (r.jobs.length < 3)
                    r.jobs.push(job.id);
                g.why.set(rk, r);
            }
            by.set(s.key, g);
        }
    return [...by.values()].map((g) => {
        // прогоны на самой staging (ключ оркестратора) — не агент слота
        const repeated = [...g.perTree.entries()].filter(([t, l]) => !/^orchestrator/.test(t) && new Set(l.map((x) => x.fp).filter(Boolean)).size >= 2).map(([t]) => t);
        const reasons = [...(g.why || new Map()).values()].sort((a, b) => b.n - a.n);
        return { key: g.key, cat: g.cat, kind: g.kind, label: g.label, reason: g.reason, reasons, test: g.test, n: g.n, jobs: g.jobs, trees: [...g.trees].sort(), tasks: [...g.tasks].sort(), files: [...g.files].sort(), first: g.first, last: g.last, repeated: repeated.sort() };
    }).sort((a, b) => b.n - a.n || b.trees.length - a.trees.length || a.key.localeCompare(b.key));
}
