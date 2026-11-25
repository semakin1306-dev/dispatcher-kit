// retro-rules.mjs — чистые правила ретро: окно эпика по журналу, когда ретро пора, выжимки прогресса и провалов для
// агента, текст задания, разбор предложений из ответа и отбор новых (без повторов уже заведённых карточек).
import { retroOfMeta } from "./backlog-rules.mjs";
import { prompt } from "../prompts.mjs";

export const RETRO_KINDS = ["гард", "правка навыка", "правило диспетчерской"];
export const RETRO_JOURNAL_SKIP = new Set(["chain.kick", "chain.step", "chain.skip", "server.pulse", "slow.loop"]);
export const RETRO_MAX_PROPOSALS = 8;
const DAY = 24 * 3600e3;
export const ownedBy = (x, epicId, keys) => (x.epic ? x.epic === epicId : keys.has(x.tree) || keys.has(x.key));

export function epicWindow(epic, events, runs, now = Date.now()) {
    const keys = new Set([...(epic.slots || []).map((x) => x.slot), "orchestrator@" + epic.id]);
    const to = Date.parse(epic.closedAt || "") || now;
    const orch = "orchestrator@" + epic.id, isOrch = (x) => [x.key, x.tree, x.from, x.to].includes(orch);
    let from = Infinity, loose = Infinity;
    for (const e of events) {
        if (!e || !e.at || e.at > to)
            continue;
        if (e.epic === epic.id || (!e.epic && isOrch(e)))
            from = Math.min(from, e.at);
        else if (ownedBy(e, epic.id, keys))
            loose = Math.min(loose, e.at);
    }
    for (const r of runs) {
        const a = r.queuedAt || r.startedAt || 0;
        if (!a || a > to)
            continue;
        if (r.epic === epic.id)
            from = Math.min(from, a);
        else if (ownedBy(r, epic.id, keys))
            loose = Math.min(loose, a);
    }
    if (!Number.isFinite(from))
        from = loose;
    return { from: Number.isFinite(from) ? from : to - 7 * DAY, to };
}

export function retroDue(reg, done = {}, since = 0, now = Date.now()) {
    return (reg && reg.epics || []).filter((e) => {
        if (e.status !== "closed")
            return false;
        const c = Date.parse(e.closedAt || "");
        if (!c || c < since)
            return false;
        const d = done[e.id];
        if (!d)
            return true;
        if (d.status === "ok" || d.status === "collected")
            return !!d.to && d.to < c - 60e3;
        return d.status === "fail" && (d.tries || 1) < 2 && now - (d.at || 0) > 3600e3;
    }).map((e) => e.id);
}

const pad = (n) => String(n).padStart(2, "0");

/** «ДД.ММ ЧЧ:ММ» по местному времени машины диспетчерской. */
export const dm = (t) => {
    const d = new Date(t);
    return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
};

const hm = (min) => (min >= 60 ? Math.floor(min / 60) + " ч " + pad(min % 60) + " мин" : min + " мин");

export function progressBrief(p) {
    const k = p.counters || {}, c = p.commands || {}, o = p.owner || {}, r = p.restarts || {}, i = p.idle || {};
    const L = [
        "прогонов слотов: " + (k.runs || 0) + " (" + hm(k.runMin || 0) + " машинного времени)",
        k.regress
            ? "регресс: " +
              k.regress.runs +
              " запусков, " +
              hm(k.regress.min) +
              "; доведено " +
              k.regress.done +
              " (" +
              hm(k.regress.doneMin) +
              "), потеряно " +
              k.regress.lost +
              " (" +
              hm(k.regress.lostMin) +
              ")"
            : "",
        k.review ? "ревью: " + k.review.runs + ", с вопросами " + k.review.questions : "",
        k.security ? "гарды: " + k.security.runs + ", " + hm(k.security.min) : "",
        k.lost ? "потеряно на сбоях (прерванные и отменённые): " + k.lost.runs + ", " + hm(k.lost.min) : "",
        k.repeats
            ? "повторы на том же коде: " +
              k.repeats.runs +
              ", " +
              hm(k.repeats.min) +
              ((k.repeats.top || []).length
                  ? " — " +
                    k.repeats.top
                        .map(
                            (g) =>
                                g.tree +
                                " " +
                                g.task +
                                (g.input ? " «" + String(g.input).slice(0, 40) + "»" : "") +
                                " ×" +
                                g.n,
                        )
                        .join("; ")
                  : "")
            : "",
        k.questions
            ? "вопросов владельцу: " +
              k.questions.n +
              (k.questions.waits != null && k.questions.waits < k.questions.n
                  ? " (ожиданий ответа " + k.questions.waits + ", остальное — переспросы неотвеченного)"
                  : "") +
              ", простой на них " +
              hm(k.questions.waitMin) +
              (k.questions.open ? ", открыто " + k.questions.open : "")
            : "",
        "готово, не влито: " +
            (p.readyWaveH || 0) +
            " волна-ч; простой эпика: " +
            hm(i.min || 0) +
            " (" +
            (i.share || 0) +
            "% открытого времени)",
        "команды оркестратора: " +
            (c.total || 0) +
            ", отказов " +
            (c.failed || 0) +
            ", тупиков " +
            (c.deadlocks || 0) +
            ", блоков ворот " +
            (c.gateBlocked || 0) +
            (c.gateSaved ? " (и лишних повторов сбережено воротами " + c.gateSaved + ")" : ""),
        "перезапусков диспетчерской: " + (r.starts || []).length + ", прерванных ими прогонов " + (r.interrupted || 0),
        "сообщений владельца: " +
            (o.messages || 0) +
            ", ходов оркестратора " +
            (o.orchTurns || 0) +
            " (без действия " +
            (o.emptyTurns || 0) +
            ")",
        k.agents ? "агентов слотов в час: пик " + k.agents.peak + ", p50 " + k.agents.p50 : "",
    ];
    return L.filter(Boolean).map((l) => "- " + l).join("\n");
}

const oneLine = (s, n) => String(s || "").replace(/\s+/g, " ").slice(0, n);

export function failuresBrief(groups, max = 80) {
    if (!groups.length)
        return "Красных прогонов с логом за окно эпика нет (логи живут 7 суток: у старых эпиков их может не быть).";
    return groups.slice(0, max).map((g) => {
        const rs = (g.reasons || []).filter((r) => r.text);
        const why =
            rs.length > 1
                ? "\n  причины (разные, " +
                  rs.length +
                  "):" +
                  rs
                      .slice(0, 3)
                      .map((r) => "\n   · ×" + r.n + " " + r.jobs.join(", ") + ": " + oneLine(r.text, 200))
                      .join("") +
                  (rs.length > 3 ? "\n   · … ещё " + (rs.length - 3) : "")
                : g.reason
                  ? "\n  причина: " + oneLine(g.reason, 240)
                  : "";
        return (
            "- [" +
            g.cat +
            "] " +
            String(g.label || g.key).slice(0, 140) +
            " ×" +
            g.n +
            " · слоты " +
            g.trees.join(", ") +
            (g.repeated.length ? " · агент повторял после правки: " + g.repeated.join(", ") : "") +
            " · прогоны " +
            g.jobs.slice(-5).join(", ") +
            why
        );
    }).join("\n") + (groups.length > max ? "\n- … ещё групп: " + (groups.length - max) : "");
}

export const RETRO_RULES = prompt("retro-rules", { maxProposals: RETRO_MAX_PROPOSALS });

export function retroPrompt({ epic, from, to, waves = [], brief = "", counts = {}, files = {}, made = [] }) {
    const cnt = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([t, n]) => t + " " + n).join(", ");
    return [
        RETRO_RULES,
        "ЭПИК: " +
            epic.id +
            (epic.title ? " — " + epic.title : "") +
            "; окно " +
            dm(from) +
            " → " +
            dm(to) +
            (epic.closedAt ? " (закрыт)" : " (ещё открыт: ретро промежуточное)"),
        waves.length
            ? "ВОЛНЫ:\n" +
              waves
                  .map(
                      (w) =>
                          "- " +
                          w.tag +
                          (w.wave && !String(w.title || "").includes(w.wave) ? " " + w.wave : "") +
                          (w.title ? " " + w.title : "") +
                          (w.archived ? " (снята)" : ""),
                  )
                  .join("\n")
            : "",
        "СВОДКА (из progress.json):\n" + brief,
        cnt ? "СОБЫТИЙ В ЖУРНАЛЕ ПО ТИПАМ: " + cnt : "",
        made.length
            ? "УЖЕ ЗАВЕДЕНО ПРОШЛЫМ РЕТРО ЭТОГО ЭПИКА — не предлагай то же другими словами (новое — только новое; можно сослаться на BL в «Что нет»):\n" +
              made.map((x) => "- " + x.id + " " + x.title).join("\n")
            : "",
        "ФАЙЛЫ:\n- progress.json: " +
            files.progress +
            "\n- failures.md: " +
            files.failures +
            "\n- journal.txt: " +
            files.journal +
            "\n- логи прогонов: " +
            files.logs +
            "/jNNN.log" +
            ((files.plans || []).length ? "\n- план эпика: " + files.plans.join(", ") : "") +
            (files.plansDir ? "\n- планы волн: " + files.plansDir + " (WV-NNNN*.md)" : ""),
    ]
        .filter(Boolean)
        .join("\n\n");
}

const KIND_RE = new RegExp("^\\s*[-*•]\\s*\\**\\s*(" + RETRO_KINDS.join("|") + ")\\s*\\**\\s*:\\s*(.+?)\\s*$", "i");

export function parseProposals(text) {
    const ls = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    const i = ls.findLastIndex((l) => /^\s*(#+\s*|\*\*)?ПРЕДЛОЖЕНИЯ\s*:?\s*(\*\*)?\s*:?\s*$/i.test(l));
    if (i < 0)
        return [];
    const out = [], seen = new Set();
    for (const l of ls.slice(i + 1)) {
        if (/^\s*#/.test(l))
            break;
        const m = KIND_RE.exec(l);
        if (!m)
            continue;
        const [what, eps = ""] = m[2].split(/\s*\|\s*эпизод[а-я]*\s*:\s*/i);
        const title = what.replace(/^«([^«»]*)»$|^"([^"]*)"$/, "$1$2").replace(/\s+/g, " ").trim().slice(0, 300);
        if (!title)
            continue;
        const k = m[1].toLowerCase() + "|" + normTitle(title);
        if (seen.has(k))
            continue;
        seen.add(k);
        out.push({ kind: m[1].toLowerCase(), title, episodes: eps.split(/\s*[,;]\s*/).map((x) => x.trim()).filter(Boolean).slice(0, 12) });
        if (out.length >= RETRO_MAX_PROPOSALS)
            break;
    }
    return out;
}

export const normTitle = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 120);
const AREA = { "гард": "guards", "правка навыка": "skills", "правило диспетчерской": "dispatcher" };
export const retroSource = (epicId) => "ретро " + epicId;

export function proposalItem(p, { epic, doc }) {
    const head = p.kind[0].toUpperCase() + p.kind.slice(1);
    const text = [head + ": " + p.title, "",
        "Из ретроспективы эпика «" + epic + "»: " + doc, "",
        "Эпизоды: " + (p.episodes.length ? p.episodes.join(", ") : "—"), "",
        "Вид: " + p.kind + ". " + (p.kind === "правило диспетчерской" ? "Правку диспетчерской берёт сессия диспетчерской." : "Правки навыков и гардов — по слову владельца.")].join("\n");
    return { text, source: retroSource(epic), area: AREA[p.kind] || "", retro: epic };
}

export function freshProposals(props, items, epicId) {
    const have = new Set(items.filter((it) => retroOfMeta(it) === epicId).map((it) => normTitle(String(it.title || "").replace(/^[^:]{1,30}:\s*/, ""))));
    return props.filter((p) => !have.has(normTitle(p.title)));
}

export function retroDoc({ epic, from, to, at, text, items = [], model = "", input = "" }) {
    return [
        "# Ретроспектива эпика «" + (epic.title || epic.id) + "» (" + epic.id + ")",
        "",
        "Окно " +
            dm(from) +
            " → " +
            dm(to) +
            (epic.closedAt ? "" : " (эпик ещё открыт — промежуточное ретро)") +
            ". Собрано " +
            dm(at) +
            " ретро-агентом диспетчерской" +
            (model ? " (" + model + ")" : "") +
            " по журналу эпика, прогонам, логам красного и плану." +
            (input ? " Вход агента: `" + input + "`." : ""),
        "",
        String(text || "").trim(),
        "",
        "## Карточки бэклога",
        "",
        items.length
            ? items.map((x) => "- " + x.id + " — " + x.kind + ": " + x.title).join("\n")
            : "Новых карточек нет (предложений нет или такие уже заведены прошлым ретро).",
        "",
    ].join("\n");
}
