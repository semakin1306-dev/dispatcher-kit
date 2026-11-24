// backlog-agent.mjs — запуск агента бэклога: постоянная сессия со своей рабочей папкой (отдельное дерево проекта на коде staging,
// только чтение), своей подсказкой и узкими правами. Правила бэклога — backlog-rules.mjs; здесь только процесс агента, его дерево
// и перевод запроса разрешения в нейтральный вид.
//
// Запускается тем же путём, что оркестратор и слоты (agents.mjs startAgent), но:
//  · рабочая папка — дерево <папка слотов>/_backlog (DASH_BACKLOG_WT) на коде staging без ветки: создаётся при первом запуске,
//    перед каждым исследованием перематывается на staging; агент в нём ничего не правит;
//  · запись — только файлы BL-NNNN-*.md папки <данные>/backlog (backlog-rules.mjs решает по каждому запросу);
//  · правки не принимаются рантаймом сами и пользовательские настройки рантайма не действуют — иначе общие разрешения
//    пользователя пропускали бы запись мимо правил бэклога.
// Импортирует только нижние модули (agents.mjs зовёт его).
import { MAIN, WT, fwd } from "../slots.mjs"
import path from "node:path"
import { DATA, DRY, HERE, logEvent } from "./config.mjs"
import { exists, git } from "./git.mjs"
import { backlogDecide, backlogSystemPrompt, orchBacklogSection } from "./backlog-rules.mjs"

export const BACKLOG_KEY = "backlog"
export const isBacklogKey = (k) => k === BACKLOG_KEY
export const BACKLOG_DIR = path.join(DATA, "backlog")
export const BACKLOG_WT = path.resolve(process.env.DASH_BACKLOG_WT || path.join(WT, "_backlog"))
export const BL_CLI = fwd(path.resolve(HERE, "..", "backlog.mjs"))
export const backlogCtx = () => ({ dir: fwd(BACKLOG_DIR), data: fwd(DATA), cli: BL_CLI })
export const backlogPrompt = () => backlogSystemPrompt({ dir: fwd(BACKLOG_DIR), cwd: fwd(BACKLOG_WT), main: fwd(MAIN), cli: BL_CLI })
export const orchBacklog = () => orchBacklogSection({ dir: fwd(BACKLOG_DIR), cli: BL_CLI })

/** Особые параметры процесса агента бэклога для адаптера рантайма (runtimes/index.mjs, start). */
export const backlogAgentOpts = () => ({ acceptEdits: false, userSettings: false, addDirs: [BACKLOG_DIR] })

/**
 * Решение по запросу разрешения: "allow" или null (карточка человеку); отказ — в журнал событий.
 * req — нейтральный запрос { kind, name, command, path, input } (agents.mjs); правила — backlogDecide.
 */
export function backlogPerm(req) {
  const r = backlogDecide(req, backlogCtx())
  if (!r.d) logEvent("perm.ask", { key: BACKLOG_KEY, tool: req.kind, why: String(r.why || "").slice(0, 200), what: String(req.command || req.path || "").slice(0, 200) })
  return r.d
}

let preparing = null
/** Дерево кода агента: нет — git worktree add --detach … staging; есть — перемотать на staging. Возвращает { sha, created }. */
export function prepareBacklogTree() {
  if (DRY) return Promise.resolve({ sha: "", dry: true })
  if (preparing) return preparing
  preparing = (async () => {
    let created = false
    if (!exists(BACKLOG_WT)) {
      const r = await git(MAIN, ["worktree", "add", "--detach", BACKLOG_WT, "staging"], 300000)
      if (!r.ok) throw new Error("дерево агента бэклога не создалось: " + (r.err || r.out).split("\n").slice(-2).join(" "))
      created = true
    } else {
      const r = await git(BACKLOG_WT, ["checkout", "--detach", "--force", "staging"], 120000) // агент дерево не правит: случайные правки снимаются
      if (!r.ok) throw new Error("дерево агента бэклога не перемоталось на staging: " + (r.err || r.out).split("\n").slice(-2).join(" "))
    }
    const sha = (await git(BACKLOG_WT, ["rev-parse", "--short=10", "HEAD"])).out
    logEvent("backlog.tree", { sha, created })
    return { sha, created }
  })().finally(() => { preparing = null })
  return preparing
}
