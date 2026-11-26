// worktree-hygiene.mjs — уборка лишних папок слотов: слотов, поездов и оркестраторов диспетчерской, которые не нужны ни одному
// открытому эпику и не в списке «оставить». Что считать своим, решает ownership.mjs: основная папка, служебные папки
// и любые рабочие копии, заведённые не диспетчерской (вне папки слотов или не по её правилу имён), не убираются никогда —
// их план только показывает как чужие. Незакоммиченное уходит в git stash, папка — git worktree remove, ветка
// удаляется, только если целиком влита в staging.
import { execFile } from "node:child_process";
import { MAIN, WT, loadEpics } from "../slots.mjs";
import { OWN, splitWorktrees } from "../ownership.mjs";

// Папки, которые оставить всегда; человек дополняет список настройкой keepWorktrees.
const KEEP_DEFAULT = [];
const git = (args, cwd = MAIN, timeout = 120000) =>
    new Promise((res) =>
        execFile("git", args, { cwd, timeout, windowsHide: true, maxBuffer: 16e6 }, (e, so, se) =>
            res({ ok: !e, out: String(so || "").trim(), err: String(se || "").trim() }),
        ),
    );

export function parseWorktrees(text) {
    return String(text || "")
        .split(/\r?\n\r?\n/)
        .filter(Boolean)
        .map((b) => ({
            p: (/^worktree (.*)$/m.exec(b) || [])[1],
            br: (/^branch refs\/heads\/(.*)$/m.exec(b) || [])[1] || null,
        }))
        .filter((w) => w.p);
}

// Настройка keepWorktrees из файла настроек может быть чем угодно — не список значит «по умолчанию».
const keepOf = (k) => (Array.isArray(k) ? k : KEEP_DEFAULT);

/** Лишние рабочие копии (только свои слоты, см. ownership.mjs). epics — весь реестр: закрытые эпики называют свои папки. */
export function extraWorktrees(list, epics, { wtRoot = WT, keep, main = MAIN } = {}) {
    return splitWorktrees(list, epics, { wtRoot, main, keep: keepOf(keep) }).extra;
}

/** План уборки: все копии репозитория, лишние (с числом невлитых коммитов ветки) и чужие — только для показа. */
export async function hygienePlan(epics, { wtRoot = WT, main = MAIN, keep } = {}) {
    const r = await git(["worktree", "list", "--porcelain"], main);
    if (!r.ok)
        throw new Error("git worktree list: " + r.err);
    const all = parseWorktrees(r.out), { extra, foreign } = splitWorktrees(all, epics, { wtRoot, main, keep: keepOf(keep) });
    for (const w of extra) {
        w.ahead = w.br ? Number((await git(["rev-list", "--count", "staging.." + w.br], main)).out || 0) : 0;
    }
    return { total: all.length, extra, foreign, main, at: Date.now() };
}

export const hygieneNow = { total: 0, extra: 0, foreign: 0, at: 0, running: false };

/** Пересчитать план по реестру на диске (весь, с закрытыми эпиками) — одна дверь для счётчика страницы и кнопки. */
export async function hygieneRefresh({ keep, epics = loadEpics().epics } = {}) {
    const p = await hygienePlan(epics, { keep });
    Object.assign(hygieneNow, { total: p.total, extra: p.extra.length, foreign: p.foreign.length, at: p.at });
    return p;
}

/** Убрать лишние из плана hygienePlan; чужие (plan.foreign) не трогаются. */
export async function hygieneRun(plan) {
    const out = { removed: 0, branches: 0, stashed: 0, failed: 0, log: [] }, main = plan.main || MAIN;
    for (const w of plan.extra) {
        const name = w.p.split(/[\\/]/).pop();
        // Пункт плана без отметки splitWorktrees (план собран руками или в обход правила) не убираем: иначе чужая копия
        // ушла бы в stash и удаление.
        if (w.own !== OWN.SLOT) {
            out.failed++;
            out.log.push("✗ " + name + ": не папка слота диспетчерской — не трогаю");
            continue;
        }
        const st = await git(["status", "--porcelain"], w.p, 120000);
        if (st.ok && st.out) {
            const s = await git(["stash", "push", "-u", "-q", "-m", "уборка папок " + new Date().toISOString().slice(0, 10) + ": " + name + (w.br ? " (" + w.br + ")" : "")], w.p, 300000);
            if (s.ok)
                out.stashed++;
            else {
                out.failed++;
                out.log.push("✗ " + name + ": незакоммиченное не сохранилось — папка оставлена");
                continue;
            }
        }
        const rm = await git(["worktree", "remove", "--force", w.p], main, 600000);
        if (!rm.ok) {
            out.failed++;
            out.log.push("✗ " + name + ": " + rm.err.slice(0, 160));
            continue;
        }
        out.removed++;
        if (w.br && !w.ahead) {
            const b = await git(["branch", "-D", w.br], main);
            if (b.ok)
                out.branches++;
        }
        else if (w.br)
            out.log.push("ветка оставлена (невлитых коммитов " + w.ahead + "): " + w.br);
    }
    await git(["worktree", "prune"], main);
    return out;
}
