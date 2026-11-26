// train-rules.mjs — слоты-поезда: поезд — обычный слот области с очередью волн-вагонов. Чистые правила без файлов и git:
// реестр поездов и вагонов, очередь вагонов по коммитам со строкой «Wave: WV-NNNN», шаг между вагонами, подпись влива,
// станция вагона для страницы.
//
// Кто зовёт: реестр эпиков (epic.mjs add-train, add-wagon, move-wagon, remove-wagon, order-wagons), trains.mjs (очередь
// поезда по git и выдача следующего вагона агенту), trees, view, stations (станция вагона), agents.mjs (законные номера
// Wave, которые получает хук commit-msg).
// Состояние модуль не ведёт: реестр (epics.json) и отметки поездов (trains.json) читают и пишут вызывающие.
//
// Инварианты:
// - номер волны в эпике один: вагон есть ровно в одном поезде и не ведётся отдельным слотом;
// - вагоны идут строго по одному: голова очереди — первый вагон не в staging; следующий выдаётся агенту только после влива
//   прошлого (ветка поезда одна на все вагоны, невлитый код смешал бы два вагона);
// - менять очередь (перевод, снятие, порядок) можно только у вагонов в депо: у начатого уже есть коммиты со своим номером;
// - принадлежность коммита вагону — строка «Wave: WV-NNNN» в подписи; влив поезда несёт номера вагонов в теме merge-коммита.
import { EPIC_CLI, PROJECT } from "../slots.mjs";
import { TRAIN_PREFIX } from "../ownership.mjs";
import { areaList, areaPresets, slotAreaFields, trainAreasOf } from "../areas.mjs";
import { prompt } from "../prompts.mjs";

// Поезд — слот области проекта: области поездов выводятся из раздела `areas` конфига (areas.mjs).
export const TRAIN_AREAS = trainAreasOf(PROJECT);
/** Поля области для записи поезда в реестре (область и сборка) — как у слота этой области. */
export const TRAIN_AREA_DEFS = Object.fromEntries(Object.values(PROJECT.areas).map((a) => [a.id, slotAreaFields(a)]));

export const TRAIN_EMOJI = "🚂";

// Ошибки правил реестра — с кодом TRAIN: команда эпика отличает их от сбоев и печатает текст как есть.
const fail = (m) => {
    const e = new Error(m);
    e.code = "TRAIN";
    throw e;
};

/** Слот — поезд: kind «train» или (старые записи реестра) есть список wagons. */
export const isTrain = (x) => !!x && (x.kind === "train" || Array.isArray(x.wagons));

/** Номер волны в каноническом виде WV-NNNN из любой записи (wv-12, WV-0012, dev/wv-0012-…); не нашлось — пусто. */
export const normWave = (w) => {
    const m = /wv-?0*(\d{1,4})(?!\d)/i.exec(String(w || ""));
    return m ? "WV-" + m[1].padStart(4, "0") : "";
};

/** Аргумент команды: голые цифры «1122» — тоже номер волны (normWave их не узнаёт, чтобы не ловить числа в тексте). */
export const waveArg = (x) => (/^\s*\d{3,4}\s*$/.test(String(x || "")) ? "WV-" + String(x).trim().padStart(4, "0") : normWave(x));
const tagNum = (t) => Number((/\d+/.exec(String(t || "")) || [0])[0]);
const slug = (s, n) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n);
/** Имя слота поезда: tr-<область>[полоса]-<эпик>; вторая полоса той же области — с номером. Это и имя папки, и ветка dev/<имя>. */
export const trainSlotName = (area, epicId, lane = 1) => (TRAIN_PREFIX + slug(area, 12) + (lane > 1 ? String(lane) : "") + "-" + slug(epicId, 26)).replace(/-+$/, "");
export const MAX_TRAINS = 10;
/** Метка нового поезда: Т1, Т2, … — следующая после наибольшей (снятые поезда не освобождают номер в середине). */
export const nextTrainTag = (epic) => "Т" + (Math.max(0, ...(epic.slots || []).filter(isTrain).map((z) => tagNum(z.tag))) + 1);

/**
 * Поезд эпика по метке ТN, имени слота или области. Область годится, только если поезд у неё один — иначе неоднозначно.
 * Латинская «T» в метке принимается за кириллическую «Т»: так метку набирают с латинской раскладки.
 */
export function findTrain(epic, key) {
    const k = String(key || "").trim();
    if (!k)
        fail("какой поезд: метка ТN, имя слота или область");
    const t = (epic.slots || [])
        .filter(isTrain)
        .find(
            (z) =>
                z.tag === k ||
                z.slot === k ||
                (z.trainArea === k && (epic.slots || []).filter((y) => isTrain(y) && y.trainArea === k).length === 1) ||
                z.tag === k.replace(/^T/, "Т"),
        );
    if (!t)
        fail("нет поезда " + k + " в эпике " + epic.id);
    return t;
}

/** Где вагон: { train, wagon, index } по всем поездам эпика; нет — null. */
export function findWagon(epic, wave) {
    const w = waveArg(wave);
    if (!w)
        return null;
    for (const t of (epic.slots || []).filter(isTrain)) {
        const i = (t.wagons || []).findIndex((z) => z.wave === w);
        if (i >= 0)
            return { train: t, wagon: t.wagons[i], index: i };
    }
    return null;
}

/**
 * Завести поезд области в эпике (запись реестра; папку и ветку готовит вызывающий). Поля сборки и области — как у слота этой
 * области, цвет — первый свободный из палитры. taken — занятые имена слотов вне эпика (папка уже есть).
 */
export function newTrain(epic, { area, title = "", scope = null, taken = new Set(), areas = TRAIN_AREAS, areaDefs = TRAIN_AREA_DEFS, palette = [], sparse = false }) {
    const A = Object.prototype.hasOwnProperty.call(areas, area) ? areas[area] : null;
    if (!A)
        fail("область поезда: " + (Object.keys(areas).join(" | ") || areaList()));
    const trains = (epic.slots || []).filter(isTrain);
    if (trains.length >= MAX_TRAINS)
        fail("в эпике " + epic.id + " уже " + trains.length + " поездов — больше " + MAX_TRAINS + " нельзя");
    const same = trains.filter((z) => z.trainArea === area);
    let lane = same.length + 1, name = trainSlotName(area, epic.id, lane);
    while (trains.some((z) => z.slot === name))
        name = trainSlotName(area, epic.id, ++lane);
    if (taken.has(name))
        fail("имя слота занято: " + name);
    const used = new Set((epic.slots || []).map((z) => z.color)), n = tagNum(nextTrainTag(epic));
    const [emoji, color] = palette.find(([, c]) => !used.has(c)) || palette[(n - 1) % Math.max(1, palette.length)] || ["🟩", "#16a34a"];
    const slot = {
        tag: "Т" + n,
        emoji,
        slot: name,
        kind: "train",
        trainArea: area,
        branch: "dev/" + name,
        title: title || A.title + (lane > 1 ? " · " + lane : ""),
        color,
        ...(lane > 1 ? { lane } : {}),
        ...(areaDefs[A.base] || {}),
        presets: [],
        scope: scope && scope.length ? scope : A.scope,
        wagons: [],
        ...(sparse ? { sparse: true } : {}),
    };
    (epic.slots || (epic.slots = [])).push(slot);
    return slot;
}

/** Тесты вагона по умолчанию — задачи области поезда с номером волны (areas.mjs areaPresets). */
export function wagonPresets(train, wave, project = PROJECT) {
    const base = (TRAIN_AREAS[train.trainArea] || {}).base || train.trainArea;
    return areaPresets(project.areas[base], wave, project);
}

/**
 * Зависимости вагона «после …»: вагон своего поезда — номером, чужого — «WV-NNNN@ТN». Метка чужого поезда хранится в ссылке,
 * потому что очередь своего поезда проверяет зависимость по staging, а чужого — отдельной проверкой (depOk в queueState).
 */
export function parseAfter(epic, train, list) {
    const out = [];
    for (const raw of (Array.isArray(list) ? list : String(list || "").split(",")).map((x) => String(x).trim()).filter(Boolean)) {
        const [w0, t0] = raw.split("@"), w = normWave(w0);
        if (!w)
            fail("after: не номер волны — " + raw);
        const hit = findWagon(epic, w);
        if (!hit)
            fail("after: нет вагона " + w + " в эпике " + epic.id);
        if (t0 && hit.train.tag !== t0.replace(/^T/, "Т"))
            fail("after: вагон " + w + " в поезде " + hit.train.tag + ", а не " + t0);
        out.push(hit.train === train ? w : w + "@" + hit.train.tag);
    }
    return out;
}

/** Поставить вагон в конец очереди поезда. Заголовок хранится без номера волны: номер — отдельное поле. */
export function addWagon(epic, trainKey, { wave, title, after = [], presets = null }) {
    const train = findTrain(epic, trainKey), w = waveArg(wave);
    if (!w)
        fail("номер волны: WV-NNNN");
    if (findWagon(epic, w))
        fail("вагон " + w + " уже есть в поезде " + findWagon(epic, w).train.tag);
    if ((epic.slots || []).some((z) => !isTrain(z) && normWave(z.branch) === w))
        fail("волна " + w + " уже ведётся отдельным слотом эпика");
    const t = String(title || "").replace(/^\s*WV-?\d{3,4}\s*[:—-]?\s*/i, "").trim();
    if (!t)
        fail("нужен заголовок вагона (короткое имя волны)");
    const deps = parseAfter(epic, train, after);
    const wagon = { wave: w, title: t, ...(deps.length ? { after: deps } : {}), presets: presets || wagonPresets(train, w) };
    (train.wagons || (train.wagons = [])).push(wagon);
    return { train, wagon };
}

/** Перевести вагон из депо в другой поезд. started — вагоны с коммитами или выданные агенту: их ветка уже несёт номер. */
export function moveWagon(epic, wave, toKey, { started = new Set() } = {}) {
    const hit = findWagon(epic, wave);
    if (!hit)
        fail("нет вагона " + normWave(wave) + " в эпике " + epic.id);
    const to = findTrain(epic, toKey);
    if (to === hit.train)
        fail("вагон " + hit.wagon.wave + " уже в поезде " + to.tag);
    if (started.has(hit.wagon.wave))
        fail("вагон " + hit.wagon.wave + " уже начат (есть коммиты или выдан агенту) — переводить можно только вагон в депо");
    hit.train.wagons.splice(hit.index, 1);
    to.wagons = [...(to.wagons || []), hit.wagon];
    // Ссылки after у всех вагонов пересчитываются: своя ссылка становится чужой «@ТN» и наоборот.
    for (const tr of (epic.slots || []).filter(isTrain))
        for (const z of tr.wagons || [])
            if (z.after)
                z.after = z.after.map((ref) => {
                    const x = ref.split("@")[0], h = findWagon(epic, x);
                    return !h ? ref : h.train === tr ? x : x + "@" + h.train.tag;
                });
    return { wagon: hit.wagon, from: hit.train.tag, to: to.tag };
}

/** Снять вагон из депо. Если на него ссылается after другого вагона — отказ: та зависимость не исполнилась бы никогда. */
export function removeWagon(epic, wave, { started = new Set() } = {}) {
    const hit = findWagon(epic, wave);
    if (!hit)
        fail("нет вагона " + (normWave(wave) || waveArg(wave) || wave) + " в эпике " + epic.id);
    if (started.has(hit.wagon.wave))
        fail("вагон " + hit.wagon.wave + " уже начат (есть коммиты или выдан агенту) — снять можно только вагон в депо");
    const deps = [];
    for (const tr of (epic.slots || []).filter(isTrain))
        for (const z of tr.wagons || [])
            if (z !== hit.wagon && (z.after || []).some((ref) => ref.split("@")[0] === hit.wagon.wave))
                deps.push(z.wave);
    if (deps.length)
        fail("вагон " + hit.wagon.wave + ": после него идут: " + deps.join(", ") + " — сначала уберите связь after");
    hit.train.wagons.splice(hit.index, 1);
    return { wagon: hit.wagon, from: hit.train.tag };
}

/**
 * Порядок очереди: начатые вагоны остаются впереди как были, названные идут следом в заданном порядке, остальные — за ними.
 * Начатый вагон двигать нельзя: голова уже у агента, перестановка выдала бы ему другой номер посреди работы.
 */
export function orderWagons(epic, trainKey, waves, { started = new Set() } = {}) {
    const train = findTrain(epic, trainKey), list = train.wagons || [];
    const want = waves.map(waveArg).filter(Boolean);
    for (const w of want) {
        if (!list.some((z) => z.wave === w))
            fail("в поезде " + train.tag + " нет вагона " + w);
        if (started.has(w))
            fail("вагон " + w + " уже начат — порядок меняется только в депо");
    }
    const head = list.filter((z) => started.has(z.wave)), depot = list.filter((z) => !started.has(z.wave));
    const named = want.map((w) => depot.find((z) => z.wave === w)), rest = depot.filter((z) => !want.includes(z.wave));
    train.wagons = [...head, ...named, ...rest];
    return train.wagons.map((z) => z.wave);
}

// Формат git log для очереди: sha, время коммита, тема и значения трейлера Wave через запятую; разделители — управляющие знаки,
// которых не бывает в подписи.
export const WAVE_LOG_FORMAT = "%H%x1f%ct%x1f%s%x1f%(trailers:key=Wave,valueonly,separator=%x2C)%x1e";

/**
 * Разбор git log в формате WAVE_LOG_FORMAT → [{ sha, at, subject, waves }]. Главный источник номера — трейлер Wave.
 * bySubject — номер из темы, только для своих коммитов ветки: в чужой истории номер в теме может быть упоминанием.
 */
export function parseWaveLog(text, { bySubject = false } = {}) {
    const out = [];
    for (const rec of String(text || "").split("\x1e")) {
        const [sha, ct, subject, tr] = rec.replace(/^\s+/, "").split("\x1f");
        if (!sha || !/^[0-9a-f]{7,40}$/.test(sha.trim()))
            continue;
        let waves = String(tr || "").split(/[,\s]+/).map(normWave).filter(Boolean);
        if (!waves.length && bySubject) {
            const w = normWave(subject);
            if (w)
                waves = [w];
        }
        out.push({ sha: sha.trim(), at: Number(ct) * 1000 || 0, subject: subject || "", waves: [...new Set(waves)] });
    }
    return out;
}

export const MERGE_LOG_FORMAT = "%H%x1f%ct%x1f%s";

/**
 * Отметки времени вагонов для диаграммы: первый и последний коммит вагона и последний влив с его номером (sha и время).
 * Вливы распознаются по теме merge-коммита, поэтому читаются и вливы старых составов.
 */
export function stagedMarks(waveCommits = [], mergeText = "") {
    const out = new Map(), at = (w) => out.get(w) || out.set(w, { firstAt: 0, lastAt: 0, mergedAt: 0, mergeSha: "" }).get(w);
    for (const c of waveCommits)
        for (const w of c.waves) {
            const m = at(w);
            if (c.at && (!m.firstAt || c.at < m.firstAt))
                m.firstAt = c.at;
            if (c.at > m.lastAt)
                m.lastAt = c.at;
        }
    for (const l of String(mergeText || "").split(/\r?\n/)) {
        const [sha, ct, ...s] = l.split("\x1f");
        if (!sha || !s.length)
            continue;
        const t = Number(ct) * 1000 || 0;
        for (const w of wavesOfMerge(s.join("\x1f"))) {
            const m = at(w);
            if (t >= m.mergedAt) {
                m.mergedAt = t;
                m.mergeSha = sha.trim();
            }
        }
    }
    return out;
}

/**
 * Очередь поезда по git. own — коммиты ветки поезда впереди staging, staged — номера, которые уже есть в staging.
 * Вагон «в staging», только если в ветке нет его невлитых коммитов: правка после влива снова делает его головой.
 * Голова — первый вагон не в staging, даже если ждёт зависимость (тогда «wait», и в работу не идёт никто: строго по очереди).
 * → { list, head, current } — current пусто, если голова ждёт.
 */
export function queueState({ wagons = [], own = [], staged = new Set(), depOk = () => false }) {
    const commits = new Map();
    for (const c of own)
        for (const w of c.waves)
            (commits.get(w) || commits.set(w, []).get(w)).push(c);
    const inStaging = (w) => staged.has(w) && !commits.has(w);
    const waitOf = (z) => (z.after || []).filter((d) => (d.includes("@") ? !depOk(d) : !inStaging(d)));
    const list = [];
    let head = "";
    for (const z of wagons) {
        const mine = commits.get(z.wave) || [], firstAt = mine.reduce((m, c) => (c.at && (!m || c.at < m) ? c.at : m), 0);
        let state = "depot", waitFor = [];
        if (inStaging(z.wave))
            state = "staging";
        else if (!head) {
            head = z.wave;
            waitFor = waitOf(z);
            state = waitFor.length ? "wait" : "work";
        }
        list.push({ wave: z.wave, title: z.title || "", state, commits: mine.length, firstAt, waitFor });
    }
    const h = list.find((x) => x.wave === head);
    return { list, head, current: h && h.state === "work" ? head : "" };
}

/**
 * Вагон, которым сейчас живёт дерево поезда: голова, если агент её уже ведёт (выдана или есть коммиты); иначе последний
 * влитый — у дерева до выдачи следующего вагона его код, стенд и приёмка; ничего не влито — голова.
 */
export function wagonOfTree(qs, issued = "") {
    const h = (qs.list || []).find((x) => x.wave === qs.head);
    if (h && (issued === h.wave || h.commits > 0))
        return h.wave;
    const lastStaged = [...(qs.list || [])].reverse().find((x) => x.state === "staging");
    return (lastStaged && lastStaged.wave) || qs.head || (((qs.list || [])[0] || {}).wave || "");
}

/**
 * Номер для строки Wave и номера, под которыми коммит законен → { cur, allowed }.
 * Если вагон дерева уже влит, а голова в работе, новый код идёт под номером головы: иначе голова осталась бы без коммитов.
 * Законны и вагоны с коммитами впереди staging: красный влитый вагон чинится своим номером. Номер вагона из депо не законен.
 */
export function trainCommitWaves(wave = "", wagons = []) {
    const w0 = normWave(wave), self = wagons.find((z) => z.wave === w0), head = wagons.find((z) => z.state === "work" || z.state === "wait");
    const cur = self && self.state === "staging" && head ? head.wave : w0;
    return { cur, allowed: [...new Set([cur, head && head.wave, ...wagons.filter((z) => z.commits > 0).map((z) => z.wave)].filter(Boolean))] };
}

/**
 * Шаг поезда между вагонами → { act: "issue" | "", why }. Выдавать следующий вагон можно, только когда прошлый влит:
 * впереди staging пусто и дерево чистое. Первый вагон уходит не здесь, а стартовым промптом слота.
 */
export function trainNextAct({ current = "", head = "", waitFor = [], issued = "", ahead = 0, dirty = false }) {
    if (!current)
        return { act: "", why: head ? "вагон " + head + " ждёт " + waitFor.join(", ") : "в очереди нет вагонов — все влиты в staging" };
    if (issued === current)
        return { act: "", why: "вагон " + current + " у агента" };
    if (!issued)
        return { act: "", why: "первый вагон " + current + " уходит стартовым промптом слота" };
    if (ahead > 0 || dirty)
        return { act: "", why: "в ветке невлитый код — следующий вагон после влива в staging" };
    return { act: "issue", why: "вагон " + issued + " в staging — следующий вагон " + current };
}

/** trainNextAct по дереву из снимка; не поезд — пустой шаг. */
export function trainNext(t) {
    if (!t || !t.train)
        return { act: "", why: "" };
    const h = (t.wagons || []).find((x) => x.wave === t.head) || {};
    return trainNextAct({
        current: t.current || "",
        head: t.head || "",
        waitFor: h.waitFor || [],
        issued: t.issued || "",
        ahead: t.ahead || 0,
        dirty: (t.dirtyTracked || 0) + (t.dirtyUntracked || 0) > 0,
    });
}

export const ORCH_TRAINS_RULE = prompt("orch-trains", { epicCli: EPIC_CLI });
// Тема merge-коммита поезда: ветка, место влива в очереди (#n) и номера вагонов. wavesOfMerge разбирает её обратно —
// по ней очередь узнаёт влитые вагоны.
export const trainMergeMessage = (branch, tag, n, waves) => "merge: " + branch + " — поезд " + tag + "#" + n + ": " + waves.join(", ");

export const wavesOfMerge = (subject) => {
    const m = /поезд\s+\S+?#\d+:\s*(.+)$/.exec(String(subject || ""));
    return m ? m[1].split(/[,\s]+/).map(normWave).filter(Boolean) : [];
};

/**
 * Ветка, которую влил merge-коммит, по его теме → имя ветки или "". Темы, которые пишет сама диспетчерская:
 * «merge: <ветка>» (влив слота, pipeline.recipe и кнопка «влить всё»), «merge: <ветка> — поезд Т1#3: WV-…»
 * (trainMergeMessage), «train: <ветка>» (состав проверки поезда, в staging не попадает); и тема git по умолчанию
 * «Merge branch '<ветка>' into staging» (влив руками). Сравнивать ветку надо целиком: поиск подстроки находил
 * dev/wv-0001-a внутри dev/wv-0001-ab.
 */
export const branchOfMerge = (subject) => {
    const s = String(subject || ""), m = /^(?:merge|train): (\S+)/.exec(s) || /^Merge branch '([^']+)'/.exec(s);
    return m ? m[1] : "";
};

export const waveTrailer = (wave) => "Wave: " + normWave(wave);

/**
 * Станция вагона для страницы: в очереди, ждёт, следующий (ещё не выдан), в работе (станция линии поезда), после влива —
 * стенд, приёмка, прод. Отметки станций у поезда одни на ветку, поэтому после влива они относятся к вагону дерева,
 * а более ранние влитые вагоны показываются по признакам stand и prod.
 */
export function wagonStation(w, { tree = "", issued = "", cur = null, committed = false, stages = [], stand = false, prod = false } = {}) {
    const done = (id) => !!(stages.find((s) => s.id === id) || {}).done;
    if (w.state === "depot")
        return { id: "depot", label: "в очереди", tone: "depot" };
    if (w.state === "wait")
        return { id: "wait", label: "ждёт " + w.waitFor.join(", "), tone: "wait" };
    if (w.state === "work") {
        if (w.wave !== tree || (issued !== w.wave && !w.commits))
            return { id: "next", label: "следующий — уйдёт агенту после влива", tone: "depot" };
        const id = (cur && cur.id) || "plan", label = id === "staging" ? "ждёт влива" : (cur && cur.label) || "План";
        return { id, label, tone: committed && ["build", "tests", "guards", "review", "regress", "commit", "staging"].includes(id) ? "check" : "work" };
    }
    if (w.wave === tree) {
        if (done("prod"))
            return { id: "prod", label: "В проде", tone: "done" };
        const after = ["stand", "accept", "prod"].find((id) => !done(id));
        return after ? { id: after, label: { stand: "В staging → стенд", accept: "Приёмка", prod: "В прод" }[after], tone: "done" } : { id: "prod", label: "В проде", tone: "done" };
    }
    return prod ? { id: "prod", label: "В проде", tone: "done" } : stand ? { id: "accept", label: "На стенде · приёмка", tone: "done" } : { id: "staging", label: "В staging", tone: "done" };
}
