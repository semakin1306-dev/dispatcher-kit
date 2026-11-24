// backlog-rules.mjs — чистые правила бэклога: формат элемента (frontmatter, разделы), статусы и их переходы, проверка
// правок, разбор карточек ретро последнего закрытого эпика, разрешения агента бэклога (пишет только файлы элементов,
// команды — только чтение) и тексты его подсказок.
export const STATUSES = ["new", "researching", "researched", "planned", "in-wave", "done", "rejected", "dropped"];
export const STATUS_WORD = { new: "новый", researching: "исследуется", researched: "исследован", planned: "в эпике", "in-wave": "в волне", done: "готово", rejected: "отказ", dropped: "отклонён" };
export const FIELDS = ["id", "type", "status", "reason", "area", "epic", "wave", "source", "retro", "created", "research"];
export const SET_KEYS = ["status", "reason", "area", "epic", "wave", "source", "research", "title"];
export const SECTION_RESEARCH = "Исследование", SECTION_PLAN = "Предзаготовка плана", SECTION_OWNER = "Что сказал владелец";
export const ID_RE = /^BL-\d{4}$/, FILE_RE = /^(BL-\d{4})-[\w.-]+\.md$/;
export const isStatus = (s) => STATUSES.includes(s);
export const WAVE_RE = /^WV-\d{4}$/i;
const nl = (s) => String(s ?? "").replace(/\r\n?/g, "\n");

export function parseItem(text) {
    const ls = nl(text).split("\n"), meta = {}, keys = [];
    if (ls[0] !== "---")
        return { meta, keys, body: nl(text), fm: false };
    const end = ls.indexOf("---", 1);
    if (end < 0)
        return { meta, keys, body: nl(text), fm: false };
    for (const l of ls.slice(1, end)) {
        const m = /^([\w-]+):\s?(.*)$/.exec(l);
        if (m) {
            meta[m[1]] = m[2].trim();
            keys.push(m[1]);
        }
    }
    return { meta, keys, body: ls.slice(end + 1).join("\n").replace(/^\n+/, ""), fm: true };
}

export const areaList = (a) => String(a || "").split(/[,;]/).map((x) => x.trim()).filter(Boolean);

export function titleOf(body) {
    const ls = nl(body).split("\n"), h = ls.find((l) => /^#\s+\S/.test(l));
    if (h)
        return h.replace(/^#\s+/, "").trim();
    return firstLine(body);
}

export const firstLine = (s) => {
    const l = nl(s).split("\n").map((x) => x.trim()).find(Boolean) || "";
    return l.length > 140 ? l.slice(0, 137).trimEnd() + "…" : l;
};

export function setMeta(text, patch) {
    const ls = nl(text).split("\n");
    if (ls[0] !== "---" || ls.indexOf("---", 1) < 0)
        throw new Error("у элемента нет frontmatter");
    for (const [k, v0] of Object.entries(patch)) {
        if (!/^[\w-]+$/.test(k))
            throw new Error("неверное поле " + k);
        const v = v0 == null ? "" : String(v0).replace(/[\r\n]+/g, " ").trim(), end = ls.indexOf("---", 1);
        const i = ls.slice(1, end).findIndex((l) => l.startsWith(k + ":"));
        if (i >= 0) {
            if (v)
                ls[i + 1] = k + ": " + v;
            else
                ls.splice(i + 1, 1);
            continue;
        }
        if (!v)
            continue;
        const order = FIELDS.indexOf(k);
        let at = end;
        if (order >= 0) {
            let after = -1, before = -1;
            for (let j = 1; j < end; j++) {
                const x = FIELDS.indexOf((/^([\w-]+):/.exec(ls[j]) || [])[1]);
                if (x >= 0 && x < order)
                    after = j;
                if (x > order && before < 0)
                    before = j;
            }
            at = after >= 0 ? after + 1 : before >= 0 ? before : end;
        }
        ls.splice(at, 0, k + ": " + v);
    }
    return ls.join("\n");
}

export function setTitle(text, title) {
    const t = String(title || "").replace(/[\r\n]+/g, " ").trim();
    if (!t)
        return text;
    const ls = nl(text).split("\n"), end = ls[0] === "---" ? ls.indexOf("---", 1) : -1;
    const i = ls.findIndex((l, k) => k > end && /^#\s+\S/.test(l));
    if (i >= 0)
        ls[i] = "# " + t;
    else
        ls.splice(end + 1, 0, "", "# " + t);
    return ls.join("\n");
}

const H2 = (l) => /^##\s+/.test(l) && !/^###/.test(l);
const headName = (l) => l.replace(/^##\s+/, "").trim().toLowerCase();

export function getSection(text, title) {
    const ls = nl(text).split("\n"), want = title.toLowerCase();
    let fence = false, i = -1;
    for (let k = 0; k < ls.length; k++) {
        if (/^\s*```/.test(ls[k]))
            fence = !fence;
        if (!fence && H2(ls[k]) && headName(ls[k]) === want) {
            i = k;
            break;
        }
    }
    if (i < 0)
        return null;
    let j = i + 1;
    fence = false;
    for (; j < ls.length; j++) {
        if (/^\s*```/.test(ls[j]))
            fence = !fence;
        if (!fence && (H2(ls[j]) || /^#\s/.test(ls[j])))
            break;
    }
    return ls.slice(i + 1, j).join("\n").trim();
}

export function setSection(text, title, content) {
    const ls = nl(text).replace(/\n+$/, "").split("\n"), want = title.toLowerCase(), body = String(content ?? "").trim();
    let fence = false, i = -1;
    for (let k = 0; k < ls.length; k++) {
        if (/^\s*```/.test(ls[k]))
            fence = !fence;
        if (!fence && H2(ls[k]) && headName(ls[k]) === want) {
            i = k;
            break;
        }
    }
    if (i < 0)
        return ls.join("\n") + "\n\n## " + title + "\n\n" + body + "\n";
    let j = i + 1;
    fence = false;
    for (; j < ls.length; j++) {
        if (/^\s*```/.test(ls[j]))
            fence = !fence;
        if (!fence && (H2(ls[j]) || /^#\s/.test(ls[j])))
            break;
    }
    ls.splice(i + 1, j - i - 1, "", body, ...(j < ls.length ? [""] : []));
    return ls.join("\n") + "\n";
}

export function ownerPart(body) {
    const ls = nl(body).split("\n"), out = [];
    let skip = false, fence = false;
    for (const l of ls) {
        if (/^\s*```/.test(l))
            fence = !fence;
        if (!fence && H2(l))
            skip = [SECTION_RESEARCH, SECTION_PLAN].map((x) => x.toLowerCase()).includes(headName(l));
        if (!skip)
            out.push(l);
    }
    return out.join("\n").trim();
}

export function itemOf(file, text) {
    const p = parseItem(text), m = p.meta, id = m.id || (FILE_RE.exec(file) || [])[1] || "";
    return { id, file, type: m.type || "backlog", status: isStatus(m.status) ? m.status : "new", reason: m.reason || "", retro: retroOfMeta(m), area: areaList(m.area), epic: m.epic || "", wave: m.wave ? m.wave.toUpperCase() : "", source: m.source || "", created: m.created || "", research: m.research || "", title: titleOf(p.body) || id,
        owner: ownerPart(p.body).replace(/^#\s+[^\n]*\n*/, ""),
        researchText: getSection(p.body, SECTION_RESEARCH) || "", planText: getSection(p.body, SECTION_PLAN) || "", meta: m };
}

const TR = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };

export function slugOf(s, max = 48) {
    const t = String(s || "").toLowerCase().split("").map((c) => TR[c] ?? c).join("").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const cut = t.length > max ? t.slice(0, max).replace(/-[^-]*$/, "") || t.slice(0, max) : t;
    return cut || "item";
}

export function nextId(files) {
    let n = 0;
    for (const f of files) {
        const m = FILE_RE.exec(f);
        if (m)
            n = Math.max(n, Number(m[1].slice(3)));
    }
    return "BL-" + String(n + 1).padStart(4, "0");
}

export const ymd = (t = Date.now()) => {
    const d = new Date(t);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};

export const dmy = (t = Date.now()) => ymd(t).split("-").reverse().join(".");

export function newItemText({ id, text, source = "", area = "", retro = "", at = Date.now() }) {
    const body = nl(text).trim();
    if (!body)
        throw new Error("пустой текст");
    if (retro && !EPIC_ID_RE.test(retro))
        throw new Error("retro — id эпика из реестра");
    const fm = ["---", "id: " + id, "type: backlog", "status: new", ...(areaList(area).length ? ["area: " + areaList(area).join(", ")] : []), "source: " + (String(source || "").trim() || "владелец, быстрый ввод " + dmy(at)), ...(retro ? ["retro: " + retro] : []), "created: " + ymd(at), "research: needed", "---"];
    return fm.join("\n") + "\n\n# " + firstLine(body) + "\n\n## " + SECTION_OWNER + "\n\n" + body + "\n";
}

export const fileNameOf = (id, title) => id + "-" + slugOf(title) + ".md";

export function checkSet(k, v) {
    if (!SET_KEYS.includes(k))
        throw new Error("поле " + k + " менять нельзя (можно: " + SET_KEYS.join(", ") + ")");
    if (k === "status" && !isStatus(v))
        throw new Error("статус: " + STATUSES.join(" | "));
    if (k === "wave" && v && !WAVE_RE.test(v))
        throw new Error("волна — WV-NNNN");
    if (k === "epic" && v && !EPIC_ID_RE.test(v))
        throw new Error("эпик — id из реестра эпиков");
    if (k === "reason") {
        const r = String(v || "").replace(/\s+/g, " ").trim();
        if (r.length > 300)
            throw new Error("причина — одна строка до 300 знаков");
        return r;
    }
    return k === "wave" ? String(v || "").toUpperCase() : v;
}

export function checkPatch(meta, patch) {
    const status = patch.status !== undefined ? patch.status : meta.status, reason = patch.reason !== undefined ? patch.reason : meta.reason;
    if (status === "rejected" && !String(reason || "").trim())
        throw new Error("отказ (rejected) — с причиной одной строкой: --reason \"…\" (или reason=…)");
}

export const EPIC_ID_RE = /^[\w.-]{1,60}$/;
export const TRIAGE_OPEN = ["new", "researching", "researched"];

export function retroOfMeta(m) {
    const v = String((m && m.retro) || "").trim();
    if (v)
        return v;
    const s = /^ретро\s+([\w.-]{1,60})\s*$/.exec(String((m && m.source) || "").trim());
    return s ? s[1] : "";
}

export function lastClosedEpic(epics) {
    return (epics || []).filter((e) => e && e.status === "closed" && Date.parse(e.closedAt || "")).sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))[0] || null;
}

export function retroTriage(items, epics, epicId = "") {
    const e = epicId ? (epics || []).find((x) => x && x.id === epicId) || { id: epicId } : lastClosedEpic(epics);
    if (!e)
        return null;
    const mine = (items || []).filter((it) => it && !it.error && it.retro === e.id);
    return { epic: e.id, title: e.title || e.id, total: mine.length, open: mine.filter((it) => TRIAGE_OPEN.includes(it.status)).map((it) => ({ id: it.id, title: String(it.title || "").slice(0, 160), status: it.status })) };
}

export function retroGateWhy(tr, cli = "scripts/dev/backlog.mjs") {
    if (!tr || !tr.open.length)
        return "";
    return "ретро эпика «" + tr.title + "» (" + tr.epic + "): " + tr.open.length + " из " + tr.total + " карточек ждут решения — " + tr.open.map((x) => x.id).join(", ") +
        ". Разбор: node " + cli + " triage; «берём» — set BL-NNNN status=planned epic=<эпик> (или status=in-wave wave=WV-NNNN), «отказ» — set BL-NNNN --status rejected --reason \"…\". Обход — только по слову владельца: --skip-retro";
}

export function splitShell(cmd) {
    const s = String(cmd || ""), segs = [[]];
    let cur = "", has = false, q = null, bad = null;
    const word = () => {
        if (has)
            segs[segs.length - 1].push(cur);
        cur = "";
        has = false;
    };
    const cut = () => {
        word();
        segs.push([]);
    };
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (q) {
            if (c === q) {
                q = null;
                continue;
            }
            if (q === '"' && (c === "`" || (c === "$" && s[i + 1] === "(")))
                bad = bad || "подстановка команды";
            if (q === '"' && c === "\\" && i + 1 < s.length) {
                cur += s[++i];
                continue;
            }
            cur += c;
            continue;
        }
        if (c === "'" || c === '"') {
            q = c;
            has = true;
            continue;
        }
        if (c === "\\" && i + 1 < s.length) {
            cur += s[++i];
            has = true;
            continue;
        }
        if (c === "`" || (c === "$" && s[i + 1] === "(")) {
            bad = bad || "подстановка команды";
            cur += c;
            has = true;
            continue;
        }
        if (c === " " || c === "\t") {
            word();
            continue;
        }
        if (c === "\n" || c === ";") {
            cut();
            continue;
        }
        if (c === "|" || c === "&") {
            if (s[i + 1] === c)
                i++;
            else if (c === "&") {
                bad = bad || "фоновый запуск &";
            }
            cut();
            continue;
        }
        if (c === ">" || c === "<") {
            const rest = s.slice(i), m = /^(>>?|<)\s*(&[12]|\/dev\/null)/.exec(rest), pre = cur;
            if (c === ">" && m && (pre === "" || pre === "2" || pre === "1")) {
                cur = "";
                has = false;
                i += m[0].length - 1;
                continue;
            }
            bad = bad || (c === ">" ? "перенаправление в файл" : "чтение из перенаправления");
            cur += c;
            has = true;
            continue;
        }
        cur += c;
        has = true;
    }
    if (q)
        bad = bad || "незакрытая кавычка";
    word();
    return { segs: segs.filter((x) => x.length), bad };
}

const norm = (x) => String(x || "").replace(/\\/g, "/").replace(/^\/([a-z])\//i, "$1:/").toLowerCase().replace(/\/+$/, "");
/** Пути секретов: ключи, переменные окружения, хранилища паролей. Их агент бэклога не читает. */
export const SECRET_RE = /(^|[\\/])(\.ssh|\.env[\w.]*|\.npmrc|\.pgpass|\.netrc|id_[a-z0-9]+|[\w-]*\.dpapi|[\w-]*\.pem|[\w-]*\.key|accounts|credentials[\w.]*|secrets?)([\\/]|$)/i;

/** Секрет или данные диспетчерской вне папки бэклога. */
export function sensitivePath(p, { dir, data }) {
    const q = norm(p), d = norm(dir), dd = norm(data || "");
    if (SECRET_RE.test(q))
        return true;
    if (dd && (q === dd || q.startsWith(dd + "/")) && !(q === d || q.startsWith(d + "/")))
        return true;
    return /(^|\/)_dashboard(\/|$)/.test(q) && !/(^|\/)_dashboard\/backlog(\/|$)/.test(q);
}

/** Файл элемента прямо в папке бэклога (BL-NNNN-<слаг>.md, без подпапок). */
export const isBacklogFile = (p, dir) => {
    const q = norm(p), d = norm(dir);
    return q.startsWith(d + "/") && !q.slice(d.length + 1).includes("/") && /^bl-\d{4}-[\w.-]+\.md$/.test(q.slice(d.length + 1));
};

const LOCAL_RO = /^(cat|head|wc|ls|stat|file|tree|pwd|echo|basename|dirname|realpath|uniq|cut|tr|nl|du|diff|cmp)$/;
const GIT_RO = new Set(["log", "show", "diff", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "status", "shortlog", "describe", "cat-file", "rev-list", "merge-base", "name-rev", "for-each-ref"]);

/** Одна команда строки оболочки: null — можно, иначе причина отказа (она уйдёт вопросом владельцу). */
export function localSegOk(ts, ctx) {
    const c = ts[0];
    if (ts.some((t) => sensitivePath(t, ctx)))
        return "секреты и данные диспетчерской (кроме папки бэклога) — нельзя";
    if (c === "ssh" || c === "scp")
        return c + " — агент бэклога на другие машины не ходит";
    if (c === "git") {
        let i = 1;
        if (ts[1] === "-C")
            i = 3;
        else if (/^--no-pager$/.test(ts[1]))
            i = 2;
        if (ts[i] === "--no-pager")
            i++;
        const sub = ts[i];
        if (!GIT_RO.has(sub) && !(sub === "branch" && ts.slice(i + 1).every((x) => /^(--show-current|-a|-r|--list|-v|--contains|--merged|[\w./-]+)$/.test(x)) && !ts.slice(i + 1).some((x) => /^-[dDmMcC]$|^--(delete|move|copy|set-upstream)/.test(x))))
            return "git " + (sub || "") + " — только чтение (log, show, diff, blame, grep, ls-files, status…)";
        if (ts.some((t) => /^--output(=|$)|^-O|^--open-files-in-pager|^--ext-diff$/.test(t)))
            return "git с записью в файл или внешней программой";
        return null;
    }
    if (c === "node") {
        const cli = norm(ctx.cli || "");
        if (cli && norm(ts[1] || "") === cli) {
            if (["list", "show", "set", "help"].includes(ts[2]))
                return null;
            return "backlog.mjs: только list, show, set";
        }
        return "node — только команда бэклога (backlog.mjs)";
    }
    if (c === "grep" || c === "rg" || c === "egrep")
        return ts.some((t) => /^--pre(=|$)/.test(t)) ? "rg --pre" : null;
    if (c === "tail")
        return ts.some((t) => /^-(f|F)$|^--follow/.test(t)) ? "tail -f" : null;
    if (c === "sort")
        return ts.some((t) => /^-o|^--output/.test(t)) ? "sort -o" : null;
    if (c === "sed") {
        const sc = ts.filter((t, k) => k > 0 && !t.startsWith("-"));
        if (!ts.includes("-n") || ts.some((t) => /^-i|^--in-place/.test(t)))
            return "sed — только sed -n 'A,Bp'";
        return /^\d+(,\d+)?p$/.test(sc[0] || "") ? null : "sed — только sed -n 'A,Bp'";
    }
    if (c === "find")
        return ts.some((t) => /^-(exec|execdir|ok|okdir|delete|fprint\w*|fls)$/.test(t)) ? "find с действием" : null;
    if (LOCAL_RO.test(c))
        return null;
    return "команда " + c + " — вне правил агента бэклога (только чтение кода и истории)";
}

/** Строка оболочки агента бэклога: каждая команда цепочки — только чтение. */
export function backlogBashCheck(cmd, ctx) {
    const sp = splitShell(String(cmd || "").replace(/^\s*cd\s+[^&;|]+&&\s*/, ""));
    if (sp.bad)
        return sp.bad;
    if (!sp.segs.length)
        return "пустая команда";
    for (const s of sp.segs) {
        const w = localSegOk(s, ctx);
        if (w)
            return w;
    }
    return null;
}

/**
 * Решение по запросу инструмента агента бэклога. Запрос нейтральный (его собирает рантайм агента):
 * { kind: "read"|"search"|"edit"|"write"|"bash"|"todo"|<другое>, name?, path?, command? }; name — имя инструмента у рантайма, для текста.
 * d: "allow" — пропустить; null — спросить владельца с причиной why.
 */
export function backlogDecide(req, ctx) {
    const tool = String((req && req.kind) || ""), p = req && req.path;
    if (tool === "read")
        return sensitivePath(p, ctx) ? { d: null, why: "чтение данных диспетчерской или секрета" } : { d: "allow" };
    if (tool === "search")
        return p && sensitivePath(p, ctx) ? { d: null, why: "поиск в данных диспетчерской" } : { d: "allow" };
    if (tool === "todo")
        return { d: "allow" };
    if (tool === "edit" || tool === "write")
        return isBacklogFile(p, ctx.dir) ? { d: "allow" } : { d: null, why: "запись вне файлов BL-NNNN-*.md папки бэклога" };
    if (tool === "bash") {
        const w = backlogBashCheck(req.command, ctx);
        return w ? { d: null, why: w } : { d: "allow" };
    }
    return { d: null, why: "инструмент " + ((req && req.name) || tool || "?") + " — вне правил агента бэклога" };
}

/** Системная подсказка агента бэклога: постоянная, без дат и номеров (её начало кешируется рантаймом). */
export function backlogSystemPrompt({ dir, cwd, main, cli }) {
    return [
        "Ты — агент бэклога диспетчерской. Владелец между волнами записывает сюда замечания из тестирования продукта и задачи «из головы» — элементы бэклога (BL). Твоя работа по элементу: исследовать и подготовить заготовку для плана волны, чтобы оркестратор эпика мог включить элемент в волну. Код продукта ты не правишь никогда.",
        "ГДЕ. Элементы — файлы " + dir + "/BL-NNNN-<слаг>.md: frontmatter (id, type: backlog, status: new|researching|researched|planned|in-wave|done|rejected|dropped, reason, area, epic, wave, source, retro, created, research) и текст владельца под заголовком «# …». Писать можно ТОЛЬКО в эти файлы: любая другая запись станет вопросом владельцу и будет отклонена. Рабочая папка " + cwd + " — отдельное дерево проекта на коде staging (диспетчерская обновляет его перед каждым исследованием): только чтение — ничего в нём не меняй и git-команды, меняющие дерево, не запускай. Планы волн и история эпиков — " + main + "/.claude/plans/waves (только чтение), история кода — git log/show/blame в рабочей папке.",
        "ЗАДАЧА ПО ЭЛЕМЕНТУ. 1) Прочитай файл элемента целиком: текст владельца не переписывай и не сокращай; заголовок «# …» можно уточнить, если первой строкой он неудачен (смысл не меняй). 2) Собери факты: код (чтение файлов по частям, поиск), история волн (планы, git log). 3) Допиши в конец файла раздел «## Исследование»: факты со ссылками — файл:строки, даты и коммиты; что проверить не удалось — отдельным пунктом. 4) Раздел «## Предзаготовка плана»: затронутые места кода (модули, маршруты, страницы); тесты — какие есть, какой нужен первым красным; варианты решения (2–3, плюсы и минусы, рекомендация); риски (деньги, права, данные, миграции, приёмка); оценка (S/M/L, ~число файлов); в какой эпик или волну напрашивается; с какими другими BL можно объединить (BL-NNNN — почему). 5) Смени статус командой: node " + cli + " set BL-NNNN status=researched (и area=<области через запятую>, если поле пустое). Повторное исследование — те же разделы переписываются целиком, не дублируются.",
        "ИНСТРУМЕНТЫ. Чтение и поиск по файлам; из оболочки — только чтение: git log/show/diff/blame/grep, grep, ls, cat, head, tail, sed -n. Целый большой файл — последний шаг. Список элементов: node " + cli + " list [--status S] [--area A]; один — node " + cli + " show BL-NNNN. На другие машины не ходи. Секреты (пароли, токены, ключи, строки подключения, cookie) и персональные данные (почта, телефоны) в файл и ответ не переносить: заменяй на «***».",
        "ВОПРОСЫ ВЛАДЕЛЬЦУ. Что требует решения владельца (UX, деньги, права, что считать правильным поведением), пиши разделом: строка «Вопросы владельцу:», под ней нумерованные пункты с вариантами и твоей рекомендацией, после — пустая строка. Диспетчерская вынесет раздел карточкой во «Ждут вашего действия»; ответ придёт сообщением. Если без ответа исследование не закончить — запиши в файл то, что уже нашёл, задай вопрос и остановись; статус не меняй.",
        "ОТВЕТ. Коротко: что найдено, что записано в файл (разделы), новый статус. Оркестратору ничего не передавай и блоков slot: не пиши — элемент в эпик включает владелец.",
    ].join("\n\n");
}

export function orchBacklogSection({ dir, cli }) {
    return "БЭКЛОГ. Задачи владельца, записанные между волнами, лежат в " + dir + "/BL-NNNN-<слаг>.md (frontmatter: id, status new|researching|researched|planned|in-wave|done|rejected|dropped, reason, area, epic, wave, retro; разделы «Исследование» и «Предзаготовка плана» пишет агент бэклога). Читай списком: node " + cli + " list --status researched [--area …] [--epic …]; один элемент — node " + cli + " show BL-NNNN. Когда владелец при планировании волн говорит «посмотри бэклог» (или «возьми из бэклога»), возьми researched-элементы (и planned своего эпика), предложи группировку в волны: какие BL в какую волну и почему вместе, что из «Предзаготовки плана» берёшь в план. Включая элемент в волну, ставь его командой node " + cli + " set BL-NNNN epic=<id эпика> wave=WV-NNNN status=in-wave (эпик без волны — status=planned; после влива волны — status=done). Файлы бэклога руками не правь — только этой командой. Карточки ретро закрытого эпика (поле retro) разбираются до нового эпика — epic.mjs new без этого откажет: список — node " + cli + " triage; «берём» — status=planned/in-wave, «отказ» — node " + cli + " set BL-NNNN --status rejected --reason \"причина одной строкой\" (решение — владельца: предложи, не решай за него).";
}

export const RESEARCH_HEAD = "ИССЛЕДОВАНИЕ ЭЛЕМЕНТА БЭКЛОГА. Порядок и формат — в системной подсказке («Задача по элементу»). Элемент и дерево кода — в конце сообщения.";

export function researchMessage({ id, file, sha = "", notes = "" }) {
    return [RESEARCH_HEAD, "Элемент: " + id + " · файл " + file + (sha ? "\nДерево кода: staging " + sha : ""), notes ? "Замечания владельца к прошлому исследованию:\n" + notes : ""].filter(Boolean).join("\n\n");
}

export const EPIC_HEAD = "БЭКЛОГ → ЭПИК. Владелец включил элемент бэклога в твой эпик. Прочитай его разделы «Исследование» и «Предзаготовка плана» (node <backlog.mjs> show) и учти при планировании волн; если указана волна — добавь элемент в её план (источник, решения) и скажи владельцу, что поменялось. Владельцу — только решения.";

export function epicMessage({ id, title, file, epic, wave = "", status, cli }) {
    return [EPIC_HEAD.replace("<backlog.mjs>", cli), "Элемент: " + id + " «" + title + "» · файл " + file + "\nЭпик: " + epic + (wave ? " · волна " + wave : " · волна не выбрана") + " · статус " + status].join("\n\n");
}
