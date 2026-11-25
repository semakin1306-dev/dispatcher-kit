// loops.mjs — чистые правила против лишних прогонов и пустых ходов оркестратора: ворота «один прогон на код», сбор
// докладов слотов, когда будить оркестратора, разбор списка прогонов, ожидание влива, красная группа спек. Только
// решения, без побочных действий.
const STATUS_RE = /:\s*\**\s*(ГОТОВО|ЖДУ|ЧАСТИЧНО|СТОП|ВОПРОС)(?![А-ЯЁа-яё])/;
export const SLOT_ASKS_RE = /(^|\n)[\s>*_#]*(Нужно от оркестратора|Вопросы(\s+владельцу)?[^:\n]{0,30}|Ответ оркестратору)\s*:/i;
const WAITS_ORCH_RE = /(^|\n)[\s>*_#-]*Продолжу,?\s+когда:?[^\n]*оркестратор[^\n]*(реш|ответ|выбер|скажет|подтверд|соглас)[^\n]*/i;

export const slotAsks = (body) => {
    const s = String(body || ""), m = SLOT_ASKS_RE.exec(s);
    if (m)
        return s.slice(m.index).replace(/\n\s*Дальше:[\s\S]*$/, "").replace(/\s+/g, " ").trim();
    const w = WAITS_ORCH_RE.exec(s);
    return w ? w[0].replace(/\s+/g, " ").trim() : "";
};

export const slotStatus = (body) => (STATUS_RE.exec(String(body || "").split("\n")[0]) || [])[1] || "";

export function staleRed(job, fp) {
    return !!(job && job.status === "fail" && job.fpStart && fp && job.fpStart !== fp);
}

/** Шаблоны защищённых файлов (`deploy*.sh`, `.github/**`) → регулярка имени внутри командной строки. */
export function protectedFileRe(globs = []) {
    const one = (g) => String(g).replace(/\\/g, "/").replace(/^\/+/, "").split("").map((c) => c === "*" ? "[^\\s'\"|;&<>]*" : c.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("");
    const list = (globs || []).filter(Boolean).map(one);
    return list.length ? "(?:" + list.join("|") + ")" : "";
}

const writesOf = (F) => [
    String.raw `>>?\s*['"]?(?:\S*/)?` + F,
    String.raw `\b(?:sed|perl)\s+(?:-\S+\s+)*-i\S*\b[^|;&\n]*` + F,
    String.raw `\btee\b[^|;&\n]*` + F,
    String.raw `\b(?:cp|mv|install|ln|truncate)\b[^|;&\n]*` + F,
    String.raw `\bgit\s+(?:add|checkout|restore|apply|am|rm|mv)\b[^|;&\n]*` + F,
    String.raw `open\(\s*['"](?:\S*/)?` + F + String.raw `['"]\s*,\s*['"][wa+]`,
    String.raw `(?:writeFileSync|appendFileSync|writeFile|write_text)\s*\([^)]*` + F,
].map((x) => new RegExp(x));

/**
 * Пишет ли команда агента в защищённые файлы проекта (PROJECT.protected): причина отказа или "".
 * Чтение можно; запись перенаправлением, sed -i, tee, cp, git add и записью из кода — нет.
 */
export function deployWriteWhy(command, protectedGlobs = []) {
    const cmd = String(command || ""), F = protectedFileRe(protectedGlobs);
    if (!F || !new RegExp(F).test(cmd))
        return "";
    return writesOf(F).some((re) => re.test(cmd))
        ? "защищённые файлы проекта (" +
              protectedGlobs.join(", ") +
              ") из сессии агента не правят — это делает окно диспетчерской или оркестратор: опиши нужный шаг в докладе"
        : "";
}

export function blockTargetTag(lang, trees) {
    const m = /^slot:\s*(.+?)\s*$/i.exec(String(lang || ""));
    if (!m)
        return null;
    const want = m[1];
    return trees.find((x) => x.tag === want) || trees.find((x) => x.slot === want || x.key === want) || null;
}

export const reconStop = (body) => (/^[\s>#*_-]*(?:\*\*)?Разведка(?:\*\*)?\s*(?::|[—–-])\s*\**\s*(СТОП|ВОПРОС)(?![А-ЯЁа-яё])/im.exec(String(body || "")) || [])[1] || "";

export function relayDecision({ body, prev, cur, sync = false }) {
    const st = slotStatus(body);
    if (st === "СТОП" || st === "ВОПРОС")
        return { relay: true, why: "статус " + st };
    const rs = reconStop(body);
    if (rs)
        return { relay: true, why: "разведка: " + rs };
    const asks = slotAsks(body);
    const changed = !prev || !cur || prev.fp !== cur.fp || prev.sha !== cur.sha;
    if (asks)
        return asks !== ((prev && prev.asks) || "") || changed
            ? { relay: true, why: "есть просьбы или ответ оркестратору" }
            : { relay: false, why: "те же просьбы при том же коде, что в прошлой передаче" };
    if (sync)
        return { relay: false, why: "ход по «Подтянуть staging»: влив staging в ветку диспетчерская видит сама и перегоняет проверки" };
    if (st === "ЖДУ")
        return { relay: false, why: "«ЖДУ» без просьб к оркестратору" };
    if (st === "ГОТОВО" || st === "ЧАСТИЧНО")
        return changed ? { relay: true, why: "код изменился с прошлой передачи" } : { relay: false, why: "«" + st + "» без просьб, а код тот же, что при прошлой передаче" };
    return { relay: true, why: "статус доклада не распознан" };
}

/**
 * Канон ввода для сравнения прогонов: части через «,» или «|», без экранирования и суффикса спеки, по алфавиту.
 * Ввод без разделителей — как есть, без пробелов по краям. Только для сравнения: запускается ввод, как его дали.
 */
export function canonInput(task, input) {
    const s = String(input || "").trim();
    if (!/[,|]/.test(s))
        return s.replace(/\\(.)/g, "$1").replace(/\.(spec|test)\.[cm]?[jt]sx?$/, "");
    return s.split(/[,|]/).map((x) => x.trim().replace(/\\(.)/g, "$1").replace(/\.(spec|test)\.[cm]?[jt]sx?$/, "")).filter(Boolean).sort().join(",");
}

export const NO_GATE = new Set(["review", "commit", "merge", "accept-run", "accept-ask", "slot-up", "train", "deploy-staging"]);
const LIVE = ["queued", "waiting", "running"];

export function runGate({ jobs, tree, task, input = "", fp, dist = false, covers = null, realFail = () => true, inherited = () => false, freshOk = () => false }) {
    if (NO_GATE.has(task))
        return { run: true };
    const want = canonInput(task, input);
    const same = (j) => j.tree === tree && j.task === task && canonInput(task, j.input) === want;
    const live = jobs.find((j) => same(j) && LIVE.includes(j.status));
    if (live)
        return { run: false, job: live, why: (live.status === "running" ? "уже идёт" : "уже в очереди") + " (" + live.id + ")" };
    if (!fp)
        return { run: true };
    const onFp = (j) => j.fpStart === fp && j.fpEnd === fp;
    const green = jobs.filter((j) => j.tree === tree && j.task === task && j.status === "ok" && onFp(j) && (same(j) || (covers && covers(j))) && (!dist || j.runOn || j.buildFp === j.fpStart)).pop();
    if (green)
        return { run: false, job: green, why: "зелёный на этом же коде (" + green.id + ")" };
    const areaGreen = jobs.filter((j) => same(j) && j.status === "ok" && freshOk(j)).pop();
    if (areaGreen)
        return { run: false, job: areaGreen, why: "зелёный (" + areaGreen.id + "), и после него менялись только файлы вне его области — тесты, документы" };
    const inh = jobs.filter((j) => same(j) && j.status === "fail" && onFp(j) && inherited(j)).pop();
    if (inh)
        return { run: false, job: inh, why: "на этом коде упало только известное красное staging (" + inh.id + "): повтор его не изменит" };
    const reds = jobs.filter((j) => same(j) && j.status === "fail" && onFp(j) && realFail(j));
    if (reds.length >= 2)
        return { run: false, job: reds[reds.length - 1], why: "дважды красный на этом же коде (" + reds.map((j) => j.id).join(", ") + "): без правки повтор даст то же" };
    return { run: true };
}

export function verdictJob({ jobs, task, input, fp, fresh }) {
    const mine = jobs.filter((j) => j.task === task && ["ok", "fail"].includes(j.status));
    const latest = mine[0];
    if (!latest)
        return null;
    if (latest.status === "fail" && latest.fpEnd && latest.fpEnd === fp)
        return latest;
    if (latest.status === "ok" && fresh(latest))
        return latest;
    const same = (j) => input === undefined || canonInput(task, j.input) === canonInput(task, input);
    return mine.find((j) => j.status === "ok" && same(j) && fresh(j)) || latest;
}

const base = (p) => String(p || "").replace(/\\/g, "/").split("/").pop();

export function retrySpecs({ failing, touched = [], history = {}, code, jobId }) {
    const own = new Set(touched.filter((f) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(f)).map(base));
    return failing.filter((f) => !own.has(base(f))).filter((f) => !(history[f] || []).some((x) => x.code === code && !x.ok && x.job !== jobId));
}

export function factsDelta({ prev, cur }) {
    if (!prev)
        return { full: true, plan: true, diff: "all", files: [], reds: cur.reds };
    const files = prev.snap && cur.snap ? [...new Set([...Object.keys(prev.snap), ...Object.keys(cur.snap)])].filter((k) => prev.snap[k] !== cur.snap[k]) : null;
    return {
        full: false,
        plan: prev.planHash !== cur.planHash,
        diff: prev.fp === cur.fp ? "same" : files ? "files" : "all",
        files: files || [],
        reds: cur.reds.filter((id) => !(prev.reds || []).includes(id)),
    };
}

export const ORCH_GATHER_MS = Number(process.env.DASH_ORCH_GATHER_SEC || 0) * 1000;
export const ORCH_ROTATE_TOKENS = Number(process.env.DASH_ORCH_ROTATE_K || 300) * 1000;

export function rotateDue(ctxTokens) {
    return ORCH_ROTATE_TOKENS > 0 && Number(ctxTokens || 0) >= ORCH_ROTATE_TOKENS;
}

const ORCH_MSG = [
    { kind: "idle", re: /^\[Диспетчерская, сторож простоя\]/, wake: true, why: "толчок простоя: правило orchNudgeDue уже решило, что есть что решать" },
    { kind: "gate", re: /^\[Диспетчерская\] Ворота не пустили/, wake: false, why: "ворота не пустили лишний прогон: результат на этом коде уже есть (или проверит поезд) — решать нечего" },
    { kind: "merged", re: /^\[Диспетчерская\] Влито по ожиданию/, wake: false, why: "ВЛИТЬ по слову владельца исполнен сам, когда проверки позеленели — сведение" },
    { kind: "service-ok", re: /^\[Диспетчерская\] Выкат [^\n]*✓ готово/, wake: false, why: "выкат сервиса прошёл — сведение" },
    { kind: "merge-stop", re: /^\[Диспетчерская\] (Влив [ПТ]\d+ на паузе|Ожидание влива снято)/, wake: true, why: "ожидание влива остановлено: красное или помеха — нужна правка или решение" },
    { kind: "cmd-fail", re: /^\[Диспетчерская\] Команды не исполнены/, wake: true, why: "команда не исполнена — решить, что дальше" },
    { kind: "run-parse", re: /^\[Диспетчерская\] «ПРОГНАТЬ/, wake: true, why: "строка ПРОГНАТЬ понята не вся — поправить" },
    { kind: "deadlock", re: /^\[Диспетчерская\] Правила противоречат/, wake: true, why: "тупик правил" },
    { kind: "restart-cut", re: /^\[Диспетчерская\] Перезапуск диспетчерской прервал/, wake: true, why: "исполнение команд не подтверждено" },
    { kind: "relay", re: /^(Ответ слота|Доклады слотов пачкой)/, wake: true, why: "доклад слота (прошёл relayDecision или передан кнопкой)" },
    { kind: "slot-idle", re: /^Диспетчерская: слот \S+[^\n]*готов уже/, wake: true, why: "слот готов, агент не запущен — дать старт" },
    { kind: "rotate", re: /^Новая сессия оркестратора/, wake: true, why: "новая сессия с поводом внутри" },
];

export function orchWake(text) {
    const s = String(text || "").trimStart(), m = ORCH_MSG.find((x) => x.re.test(s));
    return m ? { wake: m.wake, kind: m.kind, why: m.why } : { wake: true, kind: "other", why: "сообщение владельца, окна диспетчерской или приёмки — решение оркестратора" };
}

export function orchNudgeDue({
    now,
    busy = false,
    queued = false,
    liveJobs = 0,
    lastWork = 0,
    orchSawAt = 0,
    lastNudge = 0,
    slotsWithSession = 0,
    slotsWaitingOwner = 0,
    idleMs = 20 * 60e3,
    everyMs = 60 * 60e3,
}) {
    const no = (why) => ({ due: false, why });
    if (busy) return no("агент эпика отвечает");
    if (queued) return no("передачи в очереди");
    if (liveJobs) return no("идут прогоны: их итог придёт слотам сам");
    if (!slotsWithSession) return no("слотов с сессией нет");
    if (slotsWaitingOwner >= slotsWithSession) return no("все слоты ждут владельца");
    if (!lastWork || now - lastWork < idleMs) return no("простой короче порога");
    if (lastNudge && now - lastNudge < everyMs) return no("толкали меньше часа назад");
    if (orchSawAt && orchSawAt >= lastWork)
        return no("оркестратор уже отвечал после последней работы в эпике — нового нет");
    if (lastNudge && lastNudge >= lastWork) return no("после прошлого толчка никто ничего не сделал");
    return { due: true, why: "слоты работали после последнего хода оркестратора и стоят" };
}

export function orchTurnsReplay(evs, { idleMs = 20 * 60e3, everyMs = 60 * 60e3, liveMaxMs = 6 * 3600e3 } = {}) {
    const isO = (k) => typeof k === "string" && k.startsWith("orchestrator@"), st = new Map();
    const of = (o) => {
        if (!st.has(o))
            st.set(o, { pend: [], lastWork: 0, sawAt: 0, lastNudge: 0, live: new Map() });
        return st.get(o);
    };
    const out = { turns: 0, empty: 0, emptyCr: 0, cut: 0, cutEmpty: 0, cutEmptyCr: 0, byKind: {}, cutActed: [], rows: [] };
    for (const e of [...evs].filter((x) => x && x.at).sort((a, b) => a.at - b.at)) {
        if (e.type === "restart.interrupted") {
            for (const j of e.jobs || [])
                for (const s of st.values())
                    s.live.delete(j.id);
            continue;
        }
        const orch = isO(e.key) ? e.key : e.epic ? "orchestrator@" + e.epic : "";
        if (!orch)
            continue;
        const s = of(orch);
        if (e.type === "job.queued" || e.type === "job.start")
            s.live.set(e.id, e.at);
        else if (e.type === "job.end" || e.type === "job.cancel") {
            s.live.delete(e.id);
            if (e.type === "job.end")
                s.lastWork = Math.max(s.lastWork, e.at);
        }
        else if (e.type === "agent.turn" && !isO(e.key))
            s.lastWork = Math.max(s.lastWork, e.at);
        else if (e.type === "agent.message" && e.key === orch) {
            for (const [id, at] of s.live)
                if (e.at - at > liveMaxMs)
                    s.live.delete(id);
            if (e.kind === "nudge") {
                const d = orchNudgeDue({
                    now: e.at,
                    liveJobs: s.live.size,
                    lastWork: s.lastWork,
                    orchSawAt: s.sawAt,
                    lastNudge: s.lastNudge,
                    slotsWithSession: 1,
                    slotsWaitingOwner: 0,
                    idleMs,
                    everyMs,
                });
                const later = !d.due && /короче порога|идут прогоны|меньше часа/.test(d.why);
                if (d.due || later)
                    s.lastNudge = e.at;
                s.pend.push({ kind: "idle", wake: d.due || later });
            }
            else {
                const w = orchWake(e.brief);
                s.pend.push({ kind: w.kind, wake: w.wake });
            }
        }
        else if (["owner.message", "owner.answer", "dispatcher.message"].includes(e.type) && e.key === orch)
            s.pend.push({ kind: e.type, wake: true });
        else if (e.type === "agent.turn" && e.key === orch) {
            const kinds = s.pend.map((p) => p.kind), wake = s.pend.some((p) => p.wake), cut = s.pend.length > 0 && !wake;
            const kind = (s.pend.find((p) => p.wake) || s.pend[0] || { kind: "(повода в журнале нет)" }).kind, empty = e.act === false, cr = e.cr || 0;
            const b = out.byKind[kind] || (out.byKind[kind] = { n: 0, empty: 0, cut: 0 });
            b.n++;
            if (empty)
                b.empty++;
            if (cut)
                b.cut++;
            out.turns++;
            if (empty) {
                out.empty++;
                out.emptyCr += cr;
            }
            if (cut) {
                out.cut++;
                if (empty) {
                    out.cutEmpty++;
                    out.cutEmptyCr += cr;
                }
                else
                    out.cutActed.push({ at: e.at, key: orch, kind, brief: e.brief });
            }
            out.rows.push({ at: e.at, key: orch, act: e.act, cr, kinds, cut });
            s.sawAt = e.at;
            s.pend = [];
        }
    }
    return out;
}

export const MERGE_WAITABLE = new Set(["sec", "regress", "review"]);
export const MERGE_TRANSIENT = new Set(["clean"]);
export const MERGE_LABEL = { sec: "гарды", regress: "регресс", review: "ревью" };

export function mergeArm({ fails = [], force = false, on = true }) {
    if (!on || force || !fails.length)
        return { arm: false };
    const hard = fails.filter((c) => !MERGE_WAITABLE.has(c.id));
    return hard.length ? { arm: false, hard } : { arm: true, need: fails.map((c) => c.id) };
}

export function mergeWaitStep({ w, checks = [], red = {}, live = false, busy = false, fp = "", now = Date.now(), quietMs = 5 * 60e3, stuckMs = 20 * 60e3 }) {
    if (!w)
        return { act: "none", need: [] };
    if (w.until && now > w.until)
        return { act: "expire", need: [], why: "срок слова владельца истёк" };
    const fails = checks.filter((c) => c.ok === false);
    const hard = fails.filter((c) => !MERGE_WAITABLE.has(c.id) && !MERGE_TRANSIENT.has(c.id));
    if (hard.length)
        return { act: "cancel", need: [], why: hard.map((c) => c.text + (c.detail ? " (" + c.detail + ")" : "")).join("; ") };
    if (!fails.length)
        return { act: "merge", need: [] };
    const need = fails.filter((c) => MERGE_WAITABLE.has(c.id)).map((c) => c.id);
    if (w.state === "red")
        return fp && fp !== w.redFp ? { act: "resume", need, why: "код поменялся после красного — жду зелёного снова" } : { act: "hold", need, why: w.why || "красное на этом коде" };
    if (fails.some((c) => MERGE_TRANSIENT.has(c.id)))
        return { act: "wait", need, why: "в слоте незакоммиченная правка — жду коммит" };
    const reds = need.filter((id) => red[id]);
    if (reds.length)
        return { act: "red", need, why: reds.map((id) => red[id]).join("; ") };
    if (live)
        return { act: "wait", need, why: "проверки идут" };
    if (busy)
        return { act: "wait", need, why: "агент слота отвечает" };
    if (w.queuedFp !== fp)
        return { act: "queue", need, direct: false };
    const quiet = now - (w.queuedAt || 0);
    if (quiet > quietMs && (w.tries || 0) < 2)
        return { act: "queue", need, direct: true };
    if (quiet > stuckMs)
        return {
            act: "red",
            stuck: true,
            need,
            why:
                "недостающие проверки (" +
                need.map((id) => MERGE_LABEL[id] || id).join(", ") +
                ") на этом коде не встали: ворота не пускают или станция ждёт — нужна правка или решение",
        };
    return { act: "wait", need, why: "проверки поставлены, жду начала" };
}

/**
 * Узкий перепрогон несёт всю красную группу: упавшие спеки той же задачи, не покрытые вводом, дописываются к нему.
 * fails — [{ spec, fam }] (fam — id задачи); join(base, specs) — как дописать спеки к вводу этой задачи
 * (parsers.mjs specInputOf); без него или без ввода — ввод как есть.
 */
export function carryRedSpecs({ task, input = "", fails = [], max = 40, join = null, covered = null }) {
    const s = String(input || "").trim();
    if (!join || !s)
        return { input, added: [] };
    const has = covered || ((spec) => s.split(/[,|]/).some((x) => x.trim() && spec.includes(x.trim().replace(/\\(.)/g, "$1"))));
    const added = [...new Set(fails.filter((f) => f && f.fam === task && f.spec).map((f) => f.spec))].filter((x) => !has(x)).sort().slice(0, max);
    if (!added.length)
        return { input, added: [] };
    return { input: join(s, added), added };
}

export function guardViolations(log, max = 30) {
    const out = [];
    for (const l of String(log || "").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
        const m = /^\s*(?:•|✗)\s+(\S.*)$/.exec(l);
        if (m && !out.includes(m[1].trim()))
            out.push(m[1].trim());
    }
    return out.slice(0, max);
}

export function redGroupNote({ own = [], carry = [], violations = [] }) {
    const base = (p) => String(p || "").replace(/\\/g, "/").split("/").pop();
    const mine = [...new Set(own.map(base))], prev = [...new Set(carry.map(base))].filter((x) => !mine.includes(x));
    const out = [];
    if (mine.length + prev.length > 1 || prev.length)
        out.push(
            "Все упавшие спеки группы — проверь и поправь КАЖДУЮ до перепрогона, а не только первую (следующий перепрогон диспетчерская сама соберёт из них всех и задетых правкой): " +
                mine.join(", ") +
                (prev.length ? (mine.length ? "; " : "") + "ещё красные с прошлого прогона: " + prev.join(", ") : "") +
                ".",
        );
    if (violations.length > 1)
        out.push(
            "Нарушения гардов этого прогона — все " +
                violations.length +
                ", поправь каждое до перепрогона (цепочка гардов встаёт на первом красном: шаги после него не проверялись):\n" +
                violations.map((v) => "  • " + v).join("\n"),
        );
    return out.join("\n");
}

/** Чем склеивать слова набора задачи в списке «ПРОГНАТЬ»: по умолчанию «,»; задаче с вводом-регуляркой — «|». */
export const RUN_JOIN = {};
const SET_WORD = /^[A-Za-z0-9][A-Za-z0-9._\/@|-]*$/;

export function parseRunList(list, tasks) {
    const reqs = [], bad = [];
    let cur = null;
    const body = String(list || "").replace(/[`*]/g, "").split(/\s[—–-]\s|\(|#|\/\//)[0];
    let end = 0;
    for (const mm of body.matchAll(/[^,;\s]+/g)) {
        const tight = mm.index > 0 && !/\s/.test(body.slice(end, mm.index));
        end = mm.index + mm[0].length;
        const it = mm[0].replace(/[.:]+$/, "");
        if (!it)
            continue;
        const i = it.indexOf("="), task = i < 0 ? it : it.slice(0, i), input = i < 0 ? "" : it.slice(i + 1);
        if (i < 0 && tight && cur && tasks[cur.task].input && SET_WORD.test(it)) {
            cur.input += (RUN_JOIN[cur.task] || ",") + it;
            continue;
        }
        if (i < 0 && !tasks[it]) {
            if (!SET_WORD.test(it)) {
                bad.push({ word: it, why: "не похоже на набор (латиница, цифры, - _ . /) — пояснения пишите после « — »" });
                continue;
            }
            if (cur && tasks[cur.task].input) {
                cur.input += (RUN_JOIN[cur.task] || ",") + it;
                continue;
            }
            bad.push({ word: it, why: "перед ним нет «задача=…»: это не задача и не набор" });
            continue;
        }
        if (!tasks[task]) {
            bad.push({ word: it, why: "нет задачи «" + task + "»" });
            cur = null;
            continue;
        }
        if (tasks[task].input && !input) {
            bad.push({ word: it, why: "у «" + task + "» нужен набор: " + task + "=…" });
            cur = null;
            continue;
        }
        cur = { task, input: tasks[task].input ? input : "", note: "поставил оркестратор" };
        reqs.push(cur);
    }
    return { reqs, bad };
}

export const RESET_TO_RE = /^(staging|[0-9a-f]{7,40})$/i;
const SHA_RE = /^[0-9a-f]{40}$/;
export const resetSlotCmd = (tag, epic, dry = true, cli = "scripts/dev/epic.mjs") => "node " + cli + " reset-slot " + tag + (epic ? " --epic " + epic : "") + (dry ? " --dry-run" : "");

export function backupTagName(epic, slot, at, taken = new Set()) {
    const d = new Date(at), z = (n) => String(n).padStart(2, "0");
    const base = "backup/" + epic + "/" + slot + "/" + d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()) + "-" + z(d.getHours()) + z(d.getMinutes());
    let name = base;
    for (let n = 2; taken.has(name); n++)
        name = base + "-" + n;
    return name;
}

export function resetSlotPlan(f) {
    const refuse = [], pc = f.pc || {}, rel = f.rel || {}, short = (x) => String(x || "").slice(0, 10);
    const list = (a) => a.slice(0, 4).join(", ") + (a.length > 4 ? " …" : "");
    if (!RESET_TO_RE.test(String(f.to || "")))
        refuse.push("куда сбрасывать: staging или sha коммита (7–40 знаков), а не «" + String(f.to || "") + "»");
    else if (!SHA_RE.test(f.target || ""))
        refuse.push("коммит «" + f.to + "» не найден в репозитории");
    else if (!rel.targetInStaging && !rel.targetInBranch)
        refuse.push("коммит " + short(f.target) + " не входит ни в staging, ни в ветку слота — сброс только назад по ветке или на код staging");
    if (!pc.exists)
        refuse.push("папки слота нет");
    else {
        if (pc.onBranch !== f.branch)
            refuse.push("папка слота не на ветке " + f.branch + " (сейчас " + (pc.onBranch || "отделённый HEAD") + ")");
        if ((pc.dirty || []).length)
            refuse.push("в папке слота несохранённое (" + pc.dirty.length + "): " + list(pc.dirty) + " — сначала коммит или уборка по слову владельца");
    }
    const ag = f.agent || {};
    if (ag.alive)
        refuse.push(ag.busy ? "агент слота пишет ответ — дождитесь конца хода и остановите его" : "агент слота запущен — сначала остановите его (■ в чате слота, сессия сохранится)");
    if ((f.jobs || []).length)
        refuse.push("идут прогоны слота: " + list(f.jobs));
    if (f.preparing)
        refuse.push("идёт подготовка папки слота (slot-up)");
    if (f.syncing)
        refuse.push("идёт перемотка или зеркало слота — повторите через минуту");
    const T = f.target;
    const plan = { refuse, noop: false, tags: [], text: "" };
    if (refuse.length) {
        plan.text = f.tag + ": сброс не выполнен —\n" + refuse.map((r) => "  - " + r).join("\n");
        return plan;
    }
    plan.noop = pc.head === T;
    if (plan.noop) {
        plan.text = f.tag + ": ветка " + f.branch + " уже на " + short(T) + " — сбрасывать нечего";
        return plan;
    }
    if (pc.head)
        plan.tags.push({ name: backupTagName(f.epic, f.slot, f.at, new Set(f.tagsTaken || [])), sha: pc.head, what: "здешняя ветка" });
    const lost = f.lost || [];
    plan.text = [f.tag + ": сброс ветки " + f.branch + " на " + (String(f.to).toLowerCase() === "staging" ? "staging " : "") + short(T),
        "  здесь: " + short(pc.head) + " → " + short(T) + (lost.length ? "; снимаются коммиты (" + lost.length + "): " + list(lost) : ""),
        "  страховка: " + (plan.tags.length ? plan.tags.map((t) => t.name + " → " + short(t.sha) + " (" + t.what + ")").join("; ") : "не нужна — ничего не снимается")].join("\n");
    return plan;
}
