// release-notes.mjs — заметки к выпуску: раздел CHANGELOG проекта для новой версии и одобрение текста человеком перед
// выкатом. Всё читается из git основной папки (staging и main), без рабочей копии. Одобрение привязано к хешу текста:
// правка раздела после одобрения снимает его.
import crypto from "node:crypto";
import path from "node:path";
import { MAIN } from "../slots.mjs";
import { DATA, logEvent } from "./config.mjs";
import { TREES } from "./trees.mjs";
import { git } from "./git.mjs";
import { readJson, saveJson } from "./store.mjs";

const APPROVALS = path.join(DATA, "release-approvals.json");
/** Где проекты держат журнал изменений; берётся первый, который есть на staging. */
export const CHANGELOG_PATHS = ["CHANGELOG.md", "docs/CHANGELOG.md", "docs/releases/CHANGELOG.md", "CHANGES.md"];
let approvals = null;
const load = () => approvals || (approvals = readJson(APPROVALS, {}) || {});

export function changelogSection(text, version) {
    const lines = String(text || "").split(/\r?\n/), esc = String(version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const head = new RegExp("^##\\s+\\[?v?" + esc + "\\]?(\\s|$)");
    const i = lines.findIndex((l) => head.test(l));
    if (i < 0)
        return null;
    let j = i + 1;
    while (j < lines.length && !/^##\s/.test(lines[j]))
        j++;
    return { heading: lines[i].replace(/^##\s+/, "").trim(), body: lines.slice(i + 1, j).join("\n").trim() };
}

export const textHash = (s) => crypto.createHash("sha1").update(String(s || "")).digest("hex").slice(0, 16);

const show = async (ref, file) => {
    const r = await git(MAIN, ["show", ref + ":" + file]);
    return r.ok ? r.out : null;
};

/** Верхняя версия журнала: первый заголовок «## X.Y.Z» (или «## [X.Y.Z]», «## vX.Y.Z»). */
export function topVersion(text) {
    const m = /^##\s+\[?v?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)\]?(\s|$)/m.exec(String(text || ""));
    return m ? m[1] : null;
}

const changelogAt = async (ref) => {
    for (const f of CHANGELOG_PATHS) {
        const t = await show(ref, f);
        if (t != null)
            return { file: f, text: t };
    }
    return { file: CHANGELOG_PATHS[0], text: null };
};

/** Версия на ветке: поле version в package.json, иначе верхняя версия журнала изменений. */
const versionAt = async (ref, log) => {
    try {
        const v = JSON.parse(await show(ref, "package.json") || "{}").version;
        if (v)
            return v;
    }
    catch { }
    return topVersion(log);
};

export async function releaseNotes() {
    const [cl, clMain] = await Promise.all([changelogAt("staging"), changelogAt("main")]), log = cl.text, CHANGELOG = cl.file;
    const [version, prodVersion, stg, main, merges] = await Promise.all([
        versionAt("staging", log), versionAt("main", clMain.text),
        git(MAIN, ["rev-parse", "--short=10", "staging"]), git(MAIN, ["rev-parse", "--short=10", "main"]),
        git(MAIN, ["log", "main..staging", "--merges", "--first-parent", "--format=%h%x09%s"]),
    ]);
    const sec = version && log ? changelogSection(log, version) : null;
    const hash = sec ? textHash(sec.heading + "\n" + sec.body) : null;
    const seen = new Set(), waves = [];
    for (const l of String(merges.out || "").split("\n").filter(Boolean)) {
        const [sha, subj] = l.split("\t"), br = (/merge:\s*(\S+)/.exec(subj || "") || [])[1];
        if (!br || seen.has(br) || /^(main|staging)$/.test(br))
            continue;
        seen.add(br);
        const t = TREES.find((x) => x.branch === br || (x.branch && br.endsWith(x.branch)));
        waves.push({ branch: br, sha, tag: t ? t.tag || "" : "", title: t ? t.title || "" : "", epic: t ? t.epic || "" : "", color: t ? t.color || "" : "" });
    }
    const a = version ? load()[version] : null;
    return { version, prodVersion, staging: stg.out.trim(), main: main.out.trim(), file: CHANGELOG,
        heading: sec ? sec.heading : null, body: sec ? sec.body : null, hash, waves: waves.reverse(),
        approved: !!(a && hash && a.hash === hash), approvedAt: a && hash && a.hash === hash ? a.at : null, staleApproval: !!(a && hash && a.hash !== hash) };
}

export async function releaseNotesOp(op, version, hash) {
    const cur = await releaseNotes();
    if (!cur.version || cur.version !== version)
        return { code: 409, body: { error: `версия изменилась: сейчас ${cur.version || "—"}` } };
    if (op === "approve") {
        if (!cur.body)
            return { code: 409, body: { error: `в ${cur.file} нет раздела «## ${version}» или он пуст` } };
        if (cur.hash !== hash)
            return { code: 409, body: { error: "текст раздела изменился, пока вы читали — откройте карточку заново" } };
        load()[version] = { hash, at: Date.now() };
    }
    else if (op === "revoke")
        delete load()[version];
    else
        return { code: 400, body: { error: "op: approve | revoke" } };
    saveJson(APPROVALS, approvals, 1);
    logEvent("release.notes", { op, version, hash });
    return { code: 200, body: { ok: true, ...(await releaseNotes()) } };
}

export function versionGreater(a, b) {
    const pa = String(a || "").split(/[.-]/).map((x) => Number(x)), pb = String(b || "").split(/[.-]/).map((x) => Number(x));
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = Number.isFinite(pa[i]) ? pa[i] : 0, y = Number.isFinite(pb[i]) ? pb[i] : 0;
        if (x !== y)
            return x > y;
    }
    return false;
}
