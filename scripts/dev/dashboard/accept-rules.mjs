// accept-rules.mjs — чистые правила приёмки (модуль `accept`). Без S, git, файлов и сети — всё приходит аргументами.
//
// Как устроена приёмка. Волна влита в staging и выкачена на стенд → агент её слота пишет чек-лист в строгом формате:
//   ```checklist
//   - i1 | где (адрес экрана или место) | что сделать | что должно получиться | авто
//   - i2 | … | … | … | руками
//   ```
// «авто» — пункт проверяет тест приёмки, в имени которого стоит метка [i1]; «руками» — человек. Прогон приёмки — команда
// проекта (accept.run); из её вывода строки с метками [iN] ложатся на пункты как «авто ✓/✗». Вердикт ставит человек.
// Запись приёмки одна на волну и переживает повторные вливы: новый влив с кодом продукта снимает вердикт «на разбор»,
// влив только тестов и документов приёмку не трогает.
import { PRESETS } from "./parsers.mjs";
import { normWave } from "./train-rules.mjs";

// Правила подтягивания staging раньше жили в этом файле; ядро ещё зовёт их отсюда.

/** id пункта: i0…i999, подпункт — буква («i1b»). */
export const ITEM_ID_RE = /^i\d{1,3}[a-z]?$/;
/** Метка пункта в имени теста. */
export const ITEM_TAG_RE = /\[(i\d{1,3}[a-z]?)\]/i;

// ───────────────────────────── чек-лист ─────────────────────────────

export const CHECKLIST_FORMAT = "```checklist\n- i1 | где (адрес экрана или место) | что сделать | что должно получиться | авто\n- i2 | … | … | … | руками\n```";

/**
 * Разобрать ответ агента. Берётся только блок ```checklist```; пункт — строка «- iN | где | что сделать | что должно
 * получиться | авто|руками». → { items, errors }: items — годные пункты, errors — строки, которые не разобрались.
 */
export function parseChecklist(text) {
    const m = /```checklist[^\n]*\n([\s\S]*?)```/i.exec(String(text || ""));
    if (!m)
        return { items: [], errors: ["нет блока ```checklist```"] };
    const items = [], errors = [], seen = new Set();
    for (const raw of m[1].split(/\r?\n/)) {
        const l = raw.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim();
        if (!l || l.startsWith("#"))
            continue;
        const f = l.split("|").map((x) => x.trim());
        const id = (f[0] || "").toLowerCase();
        if (!ITEM_ID_RE.test(id)) {
            errors.push("строка без id пункта (iN): " + l.slice(0, 120));
            continue;
        }
        if (f.length < 5) {
            errors.push(id + ": нужно пять полей через « | » — id, где, что сделать, что должно получиться, авто или руками");
            continue;
        }
        const howRaw = f[f.length - 1], how = /^(авто|auto)$/i.test(howRaw) ? "auto" : /^(руками|manual)$/i.test(howRaw) ? "manual" : "";
        if (!how) {
            errors.push(id + ": последнее поле — «авто» или «руками», а не «" + howRaw.slice(0, 40) + "»");
            continue;
        }
        if (seen.has(id)) {
            errors.push(id + ": такой пункт уже есть");
            continue;
        }
        seen.add(id);
        items.push({ id, where: f[1], todo: f[2], expect: f.slice(3, -1).join(" | "), how, state: "todo", comment: "" });
    }
    if (!items.length && !errors.length)
        errors.push("в блоке checklist нет пунктов");
    return { items, errors };
}

/** Шапка просьбы о чек-листе вагона поезда: агент поезда мог уйти к следующему вагону — назвать вагон и его влив. */
export function wagonAskHead(w) {
    if (!w || !w.wave)
        return "";
    const sha = ((w.merge || {}).sha || "").slice(0, 10);
    return "Чек-лист — по вагону " + w.wave + (w.title ? " («" + String(w.title).replace(/^WV-\d+\s*/, "") + "»)" : "") + ". Он уже влит в staging" + (sha ? " коммитом " + sha : "") + " и выкачен на стенд. " +
        "Это не обязательно вагон, над которым ты работаешь сейчас: опирайся на план " + w.wave + " (.claude/plans/waves/" + w.wave + "-*.md) и изменения его влива" + (sha ? " (git show --stat " + sha + ")" : "") + ", а не на текущую задачу. " +
        "Первая строка ответа — ровно «" + w.wave + "», в блоке — только пункты этого вагона.\n\n";
}

/** Ответ про вагон wave: первый номер волны в тексте — он. Без вагона (обычная волна) — всегда годится. → { ok, why } */
export function checklistForWave(txt, wave) {
    if (!wave)
        return { ok: true, why: "" };
    const first = normWave(String(txt || ""));
    if (!first)
        return { ok: false, why: "в ответе нет номера вагона " + wave + " — не видно, про какой вагон чек-лист" };
    if (first !== normWave(wave))
        return { ok: false, why: "ответ начинается с " + first + ", а спрашивали " + normWave(wave) + " — похоже, чек-лист другого вагона" };
    return { ok: true, why: "" };
}

/**
 * Просьба к агенту слота: чек-лист приёмки. w — волна ({ tag, wave, wagonOf, title, merge }); specs — файлы спек приёмки
 * этой волны (уже есть в staging); standUrl — адрес стенда; runnable — есть ли команда прогона приёмки.
 */
export function acceptAskText(w, { specs = [], standUrl = "", runnable = false } = {}) {
    return (w.wagonOf ? wagonAskHead(w) : "") +
        "Приёмка. Волна влита в staging и выкачена на стенд" + (standUrl ? " (" + standUrl + ")" : "") + ". Составь чек-лист, по которому её примут. Ничего не запускай, файлы не меняй, не коммить.\n\n" +
        "Ответ — ОДИН блок кода с языком checklist, по пункту на строку, пять полей через « | »:\n" + CHECKLIST_FORMAT + "\n" +
        "id — i1, i2, … (подпункт — i1b). «авто» — пункт проверяет тест приёмки, в имени которого стоит метка [iN] с тем же id; «руками» — проверяет человек.\n" +
        "5–15 пунктов: основной сценарий волны по шагам, граничные случаи (пусто, ошибка ввода, чужие данные, нет прав), соседние места, которые не должны сломаться. Пиши конкретно: имена экранов, кнопок, полей, ожидаемые тексты и цифры из своего кода. Вне блока — не больше двух строк.\n" +
        (!runnable ? "Команды прогона приёмки у проекта нет, поэтому все пункты — «руками»."
            : specs.length ? "В staging есть спека приёмки этой волны: " + specs.join(", ") + ". Пункты, которые она проверяет, — с теми же id, что метки [iN] в именах её тестов, и «авто»; остальные — «руками»."
                : "Спеки приёмки у этой волны пока нет: пункты, которые можно проверить тестом, пометь «авто» — тест с меткой [iN] допишут потом; остальные — «руками».");
}

/** Просьба дописать тесты приёмки по пунктам чек-листа. specGlob — где лежат спеки приёмки (конфиг accept.specGlob). */
export function acceptSpecAskText(w, items, { specGlob = "" } = {}) {
    const wave = normWave(w.wave || w.branch || w.key) || "WV-NNNN";
    const list = (items || []).map((x) => "- " + x.id + " | " + x.where + " | " + x.todo + " | " + x.expect + " | " + (x.how === "auto" ? "авто" : "руками")).join("\n");
    return "Приёмка: допиши тесты приёмки своей волны " + wave + " по её чек-листу. Волна уже влита в staging и стоит на стенде, но автоприёмка не видит её пунктов.\n\n" +
        "Файл спеки — в своей ветке" + (specGlob ? ", путь под шаблон " + specGlob + " и с номером волны в имени (" + wave.toLowerCase() + ")" : ", с номером волны в имени (" + wave.toLowerCase() + ")") + ". " +
        "Тест на каждый пункт «авто»; имя теста начинается с метки пункта ровно как в списке: «[i1] …», «[i3] …» — по меткам результат ляжет на пункт. Пункты «руками» пропусти.\n" +
        "Правила: каждый [iN] проходит сам по себе (свои данные, не из соседнего пункта; пункт можно перепрогнать один) и не зависит от порядка; ждать конкретный элемент или ответ, а не паузу; адрес стенда — переменная окружения DISPATCHER_STAND_URL, не зашивай его в код.\n" +
        "Сам ничего не запускай. Закоммить по правилу коммита своей подсказки, не пушь и не вливай. В ответе перечисли, какие id покрыты тестами, а какие остались ручными и почему.\n\n" +
        "Пункты чек-листа (id | где | что сделать | что должно получиться | как проверяется):\n" + list;
}

/** Свободный чек-лист для станции «На стенде» (текстом, без строгого формата). */
export const STAND_ASK = "Составь чек-лист проверки этой волны на стенде. Только текст, ничего не запускай, не меняй файлы и не коммить.\n\n" +
    "Формат — нумерованный список, у каждого пункта два куска: «Сделать» и «Ожидаемо». Охвати:\n" +
    "1. Под какой ролью входить и откуда начинать (адрес экрана или место).\n" +
    "2. Основной сценарий волны шаг за шагом: что открыть, что нажать, что ввести — и что именно должно произойти.\n" +
    "3. Граничные случаи: пустое состояние, ошибка ввода, чужие данные, нет прав.\n" +
    "4. Соседние места, которые не должны сломаться из-за этой волны.\n" +
    "5. Как понять, что всё в порядке, и когда отказывать в приёмке.\n" +
    "6. Как откатить, если что-то не так.\n" +
    "Пиши конкретно для этой ветки: имена экранов, кнопок, полей, путей API — из твоего кода, без общих слов.";

// ───────────────────────────── запись приёмки волны ─────────────────────────────

/** sha из ключа записи «<слот>|<sha>». */
export const accSha = (k) => String(k).split("|")[1] || "";

/**
 * Ключ записи приёмки волны. shas — вливы ветки в staging, НОВЫЕ ПЕРВЫМИ (как git log). Запись одна на волну: уже
 * заведённая (её влив или учтённые ею вливы среди shas) — она; иначе — по самому раннему вливу.
 */
export function accBaseKey(acc, tree, shas) {
    if (!shas || !shas.length)
        return tree + "|";
    for (const [k, e] of Object.entries(acc || {}))
        if (k.startsWith(tree + "|") && e && (shas.includes(accSha(k)) || (e.merges || []).some((s) => shas.includes(s))))
            return k;
    return tree + "|" + shas[shas.length - 1];
}

/** Новая запись: вливы, бывшие до неё, уже учтены — иначе первый обход счёл бы их «новым кодом». */
export const accFresh = (tree, shas) => ({ key: tree, merges: [...(shas || [])] });

const marked = (e) => (e.items || []).filter((x) => x.state && x.state !== "todo");

/** Новый влив после записи. files — файлы продукта, которые он принёс. → снят ли вердикт или отметки. */
export function accApplyMerge(e, sha, files, now = Date.now()) {
    if (!files.length)
        return false;
    e.prod = true;
    const m = marked(e), prev = e.verdict || null;
    if (!prev && !m.length)
        return false;
    if (prev) {
        e.verdict = null;
        e.sentAt = null;
        e.sendNote = "";
    }
    delete e.autoClosed;
    for (const it of m)
        if (!it.before)
            it.before = sha;
    e.reopened = { sha, at: now, prev, files: files.slice(0, 6), n: files.length, marked: m.length };
    return true;
}

/**
 * Довести запись волны до последнего влива. pf(sha) — файлы продукта влива или undefined, пока git не ответил (тогда
 * обход ждёт: порядок вливов важен). Идемпотентна. → { key, changed }
 */
export function accAdvance(acc, tree, shas, pf, now = Date.now()) {
    const key = accBaseKey(acc, tree, shas), e = acc[key];
    if (!e || !shas || !shas.length)
        return { key, changed: false };
    let changed = false;
    if (!Array.isArray(e.merges)) {
        e.merges = [accSha(key)].filter(Boolean);
        changed = true;
    }
    for (const s of [...shas].reverse()) {
        if (e.merges.includes(s))
            continue;
        const files = pf(s);
        if (!Array.isArray(files))
            break;
        accApplyMerge(e, s, files, now);
        e.merges.push(s);
        changed = true;
    }
    return { key, changed };
}

/** Закрыть волну «принято» самой можно, только если НИ ОДИН её влив не трогал код продукта и вердикта не было. */
export function accAutoCloseDue(e, shas, pf) {
    if (e && (e.verdict || e.prod || e.reopened || e.autoClosed))
        return false;
    if (!shas || !shas.length)
        return false;
    return shas.every((s) => {
        const f = pf(s);
        return Array.isArray(f) && !f.length;
    });
}
export const AUTO_CLOSE_TEXT = "волна не меняет код продукта ни одним вливом (только тесты, документы, служебное): её приёмка — зелёные проверки";

// ───────────────────────────── вывод прогона приёмки ─────────────────────────────

const FAIL_LEAD = /^\s*(?:\d+\s+)?(?:[✘✗×✕]|FAIL(?:ED)?\b|ERROR\b|--- FAIL\b|not ok\b)/i;
const SKIP_LEAD = /^\s*(?:\d+\s+)?(?:[-○↓]\s|SKIP(?:PED)?\b|--- SKIP\b)/i;
const OK_LEAD = /^\s*(?:\d+\s+)?(?:[✓✔√]|PASS(?:ED)?\b|ok\b|--- PASS\b)/i;
const FAIL_TAIL = /\s(?:FAILED|ERROR)\b/, SKIP_TAIL = /\s(?:SKIPPED|XFAIL)\b/, OK_TAIL = /\s(?:PASSED|XPASS)\b/;
// Строки подробностей упавшего теста в заготовках разбора (jest «● …», vitest «FAIL файл > тест»): они тоже «✗».
const FAIL_DETAIL = Object.values(PRESETS).filter(Boolean).flatMap((p) => p.names || []);
const RANK = { bad: 3, flaky: 2, skip: 1, ok: 0 };

/** Итог одной строки вывода с меткой [iN]: "ok" | "bad" | "skip" | "" (строка без итога). */
export function lineStatus(line) {
    const l = String(line || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    const tag = ITEM_TAG_RE.exec(l);
    if (!tag)
        return "";
    const lead = l.slice(0, tag.index), tail = l.slice(tag.index + tag[0].length);
    if (FAIL_LEAD.test(lead) || FAIL_TAIL.test(tail))
        return "bad";
    if (SKIP_LEAD.test(lead) || SKIP_TAIL.test(tail))
        return "skip";
    if (OK_LEAD.test(lead) || OK_TAIL.test(tail))
        return "ok";
    if (FAIL_DETAIL.some((re) => re.test(l)))
        return "bad";
    return "";
}

/**
 * Разобрать вывод команды приёмки. waves — волны прогона (WV-NNNN). Волна строки — номер волны в ней (имя файла спеки),
 * а если волна в прогоне одна — она. → [{ wave, id, st, title }]: по одной записи на пункт, итог — худший из строк;
 * «✗», а потом «✓» в строке повтора (retry) — "flaky".
 */
export function parseAcceptOutput(text, waves = []) {
    const norm = waves.map(normWave).filter(Boolean), byKey = new Map();
    for (const raw of String(text || "").split(/\r?\n/)) {
        const st = lineStatus(raw);
        if (!st)
            continue;
        const l = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
        const id = ITEM_TAG_RE.exec(l)[1].toLowerCase(), inLine = normWave(l);
        const wave = inLine && (!norm.length || norm.includes(inLine)) ? inLine : norm.length === 1 ? norm[0] : inLine || "";
        const title = l.slice(l.search(ITEM_TAG_RE)).replace(/\s+\(\d[\d.]*\s*m?s\)\s*$/, "").slice(0, 200);
        const k = wave + "|" + id, cur = byKey.get(k);
        if (!cur) {
            byKey.set(k, { wave, id, st, title });
            continue;
        }
        if (cur.st === "bad" && st === "ok" && /retry/i.test(l))
            cur.st = "flaky";
        else if (RANK[st] > RANK[cur.st])
            Object.assign(cur, { st, title });
    }
    return [...byKey.values()];
}

/** Метки для перепрогона только этих пунктов: «\[i1\]|\[i3\]» (для --grep / -t / -k команды приёмки). */
export const itemsGrep = (ids) => [...new Set(ids)].map((id) => "\\[" + id + "\\]").join("|");

/**
 * Результаты прогона → на пункты записи. results — [{ id, st, title }] этой волны; job — id прогона; only — id пунктов,
 * которые гонялись (остальным прежний итог оставить). Пункт без метки в чек-листе — в e.autoStray.
 */
export function applyResults(e, results, { job, at = Date.now(), only = null } = {}) {
    const items = e.items || [];
    if (only)
        for (const it of items) {
            if (only.includes(it.id))
                delete it.auto;
        }
    else {
        for (const it of items)
            delete it.auto;
        e.autoStray = [];
    }
    e.autoStray ||= [];
    const sum = { ok: 0, bad: 0, skip: 0, stray: 0 };
    for (const r of results) {
        const a = { st: r.st, job, at, title: r.title, err: r.err || "" };
        const it = items.find((x) => x.id === r.id);
        if (it) {
            if (!it.auto || RANK[a.st] > RANK[it.auto.st] || it.auto.job !== job)
                it.auto = a;
        }
        else {
            sum.stray++;
            e.autoStray = e.autoStray.filter((x) => x.title !== a.title).concat(a);
        }
        if (r.st === "ok" || r.st === "flaky")
            sum.ok++;
        else if (r.st === "skip")
            sum.skip++;
        else
            sum.bad++;
    }
    e.autoRun = { job, at };
    return sum;
}

/** Результаты, пришедшие раньше чек-листа (лежат «без пункта»), — на пункты по метке [iN]. */
export function accRestray(e) {
    if (!(e.autoStray || []).length || !(e.items || []).length)
        return false;
    const left = [];
    let n = 0;
    for (const a of e.autoStray) {
        const id = ((ITEM_TAG_RE.exec(a.title || "") || [])[1] || "").toLowerCase(), it = id && e.items.find((x) => x.id === id);
        if (!it) {
            left.push(a);
            continue;
        }
        if (!it.auto || (it.auto.job !== a.job ? (a.at || 0) >= (it.auto.at || 0) : RANK[a.st] > RANK[it.auto.st]))
            it.auto = a;
        n++;
    }
    e.autoStray = left;
    return n > 0;
}

/** Файлы спек приёмки волны: из файлов под accept.specGlob — те, в пути которых есть номер волны (wv-0001, wv0001). */
export function specsForWave(files, wave) {
    const w = normWave(wave);
    if (!w)
        return [];
    return (files || []).filter((f) => normWave(String(f).replace(/\\/g, "/")) === w);
}

// ───────────────────────────── итоги агентам ─────────────────────────────

const itemLine = (x) => "- [" + x.id + "] " + x.where + " — " + x.todo + " → ожидалось: " + x.expect + (x.comment ? "\n  Человек: " + x.comment : "");

/** Письмо агенту волны с вердиктом. w — { tag, merge: { sha } }, e — запись приёмки. */
export function verdictText(w, e) {
    const bad = (e.items || []).filter((x) => x.state === "bad"), notes = (e.items || []).filter((x) => x.comment && x.state !== "bad");
    const sha = ((w.merge || {}).sha || "").slice(0, 10);
    if (e.verdict === "accepted")
        return "Приёмка: ПРИНЯТО (" + w.tag + (sha ? ", влив " + sha : "") + ")." + (e.comment ? "\nКомментарий: " + e.comment : "") + (notes.length ? "\nЗаметки по пунктам (не блокируют):\n" + notes.map(itemLine).join("\n") : "") + "\nНичего не делай, если не просят: волна ждёт выката в прод.";
    return "Приёмка: НЕ ПРИНЯТО (" + w.tag + (sha ? ", влив " + sha : "") + ")." + (e.comment ? "\nКомментарий: " + e.comment : "") + (bad.length ? "\nНе прошли:\n" + bad.map(itemLine).join("\n") : "") + (notes.length ? "\nЕщё заметки:\n" + notes.map(itemLine).join("\n") : "") +
        "\nПочини в своей ветке. Дальше как обычно: проверки, коммит, влив в staging по слову владельца, выкат на стенд — и новая приёмка только этой волны. Доложи оркестратору, что берёшь и как.";
}

/** Сводка оркестратору эпика. accepted, rejected — [{ tag, title, comment }]. */
export function summaryText(accepted, rejected) {
    return "Приёмка — итоги человека (передано диспетчерской):\n" +
        (accepted.length ? "Принято: " + accepted.map((w) => w.tag + (w.title ? " " + w.title : "")).join("; ") + "\n" : "") +
        (rejected.length ? "НЕ принято, ушло на доделку агентам: " + rejected.map((w) => w.tag + " — " + (w.comment || "см. пункты")).join("; ") + "\n" : "") +
        "Слоты получили свои пункты. Веди дальше: доделки, повторный выкат на стенд, выкат в прод — когда приняты все волны.";
}

// ───────────────────────────── напоминания «ПОСЛЕ ВЫКАТА» ─────────────────────────────
// Агент пишет строку «ПОСЛЕ ВЫКАТА: что сделать :: задача» — она становится карточкой, которая висит, пока не сделано.
// С кнопки запускается только задача проекта без ввода (id из tasks конфига); прочие команды — только текстом.

export const REM_LINE = /^[\s>*_-]*ПОСЛЕ\s+ВЫКАТА(?:\s+СТЕНДА)?\s*:\s*(.+)$/gim;
const NOTHING_TO_DO = /^\s*(нет|ничего|не\s+нужн|не\s+требу|без\s)|\bне\s+нужн|\bне\s+требуется|обычн\w+\s+выкат\w*\s+(хватит|достаточно)/i;

/** Строки «ПОСЛЕ ВЫКАТА» из текста агента → [{ what, cmd }]. «Делать нечего» без команды напоминанием не становится. */
export function reminderLines(text) {
    const out = [];
    for (const m of String(text || "").matchAll(REM_LINE)) {
        const [what, cmdRaw] = m[1].split(/\s*::\s*/), cmd = String(cmdRaw || "").replace(/^`+|`+$/g, "").trim();
        if (!what || what.trim().length < 4)
            continue;
        if (!cmd && NOTHING_TO_DO.test(what))
            continue;
        out.push({ what: what.trim().slice(0, 500), cmd: cmd.slice(0, 300) });
    }
    return out;
}

/** Какие команды напоминания запускаются с кнопки: id задач проекта без ввода. → RegExp (ничего — не совпадает ни с чем). */
export function remCmdRe(tasks) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ids = Object.values(tasks || {}).filter((t) => !t.input).map((t) => esc(t.id));
    return ids.length ? new RegExp("^(?:" + ids.join("|") + ")$") : /(?!)/;
}
