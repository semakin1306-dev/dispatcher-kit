// hang-rules.mjs — висящая спека: частичный прогон знает свой список спек, и когда он снят по времени, правило называет
// те, что не отчитались, — агент получает имя зависшей спеки, а не «снят по времени».
export const HANG_QUIET_MS = 5 * 60e3;
const SPEC_RE = /\.(?:spec|test)\.[cm]?[jt]sx?$/;
const base = (p) => String(p || "").replace(/\\/g, "/").split("/").pop();

export function partialSpecs(text) {
    const ls = String(text || "").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/), i = ls.findIndex((l) => /ЧАСТИЧНЫЙ прогон/.test(l));
    if (i < 0)
        return [];
    const out = [];
    for (const l of ls.slice(i + 1)) {
        const m = /^\s*·\s+(\S+)\s*$/.exec(l);
        if (!m)
            break;
        if (SPEC_RE.test(m[1]))
            out.push(m[1]);
    }
    return out;
}

export const hungSpecs = (listed, done = {}) => (listed || []).filter((p) => !(base(p) in (done || {})));

export function hangDue({ listed, done, lastOutAt, now = Date.now(), quietMs = HANG_QUIET_MS }) {
    if (!listed || !listed.length || !lastOutAt)
        return false;
    return hungSpecs(listed, done).length > 0 && now - lastOutAt >= quietMs;
}

export function hangLogLines(missing, quietMin) {
    return missing.map((p) => " FAIL  " + p + " > спека висит: нет итога " + quietMin + " мин\nError: спека висит — нет итога " + quietMin + " мин (незакрытый промис, таймер или цикл в спеке или компоненте)\n").join("");
}

export function hangSummary(missing, listed, quietMin) {
    const n = (listed || []).length, okN = n - missing.length;
    return "⏱ ВИСИТ " + (missing.length > 1 ? "СПЕК " + missing.length + ": " : "СПЕКА: ") + missing.map(base).join(", ") + " — нет итога " + quietMin + " мин" + (okN > 0 ? ", остальные " + okN + " из " + n + " отчитались" : "") +
        ". Прогон снят. Это код спеки или компонента (незакрытый промис, таймер, цикл), не окружение";
}
