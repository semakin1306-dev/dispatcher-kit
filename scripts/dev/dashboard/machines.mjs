// machines.mjs — модуль `machines`: проверки слотов идут не только на этой машине, но и на удалённых по ssh.
// Место выбирает slot-places.mjs (удалённые машины первыми, эта — последней); код доставляется по sha: снимок папки слота
// (с несохранёнными правками, ветка и индекс слота не трогаются) → git push в служебную ссылку репозитория машины →
// своя рабочая папка прогона (git worktree) → подготовка (`prepare`) → службы (`services`) → команда задачи. Вывод идёт
// потоком в лог прогона, код возврата удалённой команды — итог. Здоровье машин — короткая проба памяти и нагрузки по ssh.
//
// Ssh — только алиасы из ~/.ssh/config, без паролей (BatchMode), с таймаутом подключения; одновременные подключения
// ограничивают ворота ssh (spawner.mjs: сам ssh; git push — явно через те же ворота).
//
// Кто зовёт: initMachines() включает модуль и ставит реализацию в shardApi() (shard.mjs); дальше очередь прогонов
// (runner.mjs) спрашивает места (slotFree/slotReserve), запускает задачу (slotRun), отменяет (slotCancel) и освобождает
// место (slotRelease). Состояние — только в памяти: брони мест (res: jobId → машина, дорожка, номер места, слот),
// последняя нагрузка машин (ld) и счётчик здоровья (host-health.mjs). Файлов данных модуль не ведёт.
//
// Инварианты:
// - удалённая машина даёт места, только если она «на связи» по счётчику здоровья И её нагрузка свежая (FRESH_MS):
//   по устаревшей нагрузке нельзя решить, хватит ли памяти на ещё один прогон;
// - код машины видит только по sha: рабочая папка слота, его ветка и индекс не меняются;
// - папка прогона своя у каждого слота и места (<repo>-wt/<слот>-p<место>), два прогона в одну папку не попадают.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT } from "../slots.mjs";
import { logEvent } from "./config.mjs";
import { setDigestDirs } from "./digest.mjs";
import { createHostTracker } from "./host-health.mjs";
import { availMem } from "./free-mem.mjs";
import { noMachinesApi, setShardApi } from "./shard.mjs";
import { FAIL_FN, downLines, runProcess, shq, upLines } from "./services.mjs";
import { FRESH_MS, pickPlace, profilesOf } from "./slot-places.mjs";
import { spawn, sshGate } from "./spawner.mjs";

const NO_FULL_RUN = "полного прогона по частям у модуля машин нет — задачи идут по одной через места машин";

// ───────────────────────────── чистые помощники: скрипты для удалённой машины ─────────────────────────────

export { shq };
/** Имя для пути и ссылки: латиница, цифры, точка, дефис, подчёркивание. */
export const safeId = (s) => String(s || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "_";
/** Папка машины для оболочки: `~/x` — от домашней папки, остальное как есть (в кавычках). */
export const rdir = (d) => {
    const s = String(d || "").split("\\").join("/");
    if (s === "~")
        return '"$HOME"';
    return s.startsWith("~/") ? '"$HOME"/' + shq(s.slice(2)) : shq(s);
};
/** Ssh-хост — только алиас (или user@алиас): ничего, что ssh примет за ключ. */
export const SSH_HOST_RE = /^[A-Za-z0-9_][A-Za-z0-9._@-]*$/;
/**
 * Флаги ssh: без вопросов (BatchMode — пароль или новый ключ хоста не повесят прогон), с таймаутом подключения и
 * проверкой живости соединения (долгий прогон без вывода не обрывается, мёртвое соединение замечается).
 */
export function sshOpts(connectTimeoutS = 10) {
    return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=" + connectTimeoutS, "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4"];
}
export const runDirOf = (key, idx) => safeId(key) + "-p" + idx;
// Служебная ссылка доставки: push идёт в refs/dispatcher/…, а не в ветку — ветки репозитория машины не трогаются.
export const runRefOf = (key, idx) => "refs/dispatcher/" + runDirOf(key, idx);
// Номер группы процессов прогона на машине — по нему отмена снимает прогон (killScript).
export const pidFileOf = (project, jobId) => "/tmp/dispatcher-" + safeId(project) + "-" + safeId(jobId) + ".pid";

/** Репозиторий машины: создать при первом прогоне, вернуть общую папку git (куда пушить) и корень. */
export function repoScript(m) {
    const d = rdir(m.dir);
    return ["set -e", `mkdir -p ${d}`, `cd ${d}`, "[ -e .git ] || git init -q .",
        'echo "COMMON $(git rev-parse --path-format=absolute --git-common-dir)"', 'echo "TOP $(git rev-parse --show-toplevel)"', ""].join("\n");
}

/** Начало скрипта в папке прогона: R — репозиторий машины, D — папка прогона этого слота и места. */
const runDirLines = (m, key, idx) => [`mkdir -p ${rdir(m.dir)}`, `R=$(cd ${rdir(m.dir)} && pwd)`, `D="$R-wt/${runDirOf(key, idx)}"`];

/**
 * Тело прогона: папка прогона на sha → подготовка → службы → команда задачи. Каждая команда пользователя идёт отдельным
 * `bash -ec`: её код не теряется, а провал подготовки или службы останавливает прогон с понятной строкой.
 */
export function runBody({ m, mk, sha, key, idx, jobId, cmd, serviceTries = 15 }) {
    const L = [
        "set -e",
        ...runDirLines(m, key, idx),
        'mkdir -p "$R-wt"',
        // Папка прогона переиспользуется (зависимости и сборка остаются между прогонами): checkout -f и clean убирают
        // следы прошлого прогона; нет папки — новый worktree. Служебная ссылка после этого не нужна: коммит держит HEAD папки.
        `if [ -e "$D/.git" ]; then git -C "$D" checkout -q --detach -f ${sha}; git -C "$D" clean -fdq; else ` +
            `rm -rf "$D"; git -C "$R" worktree prune; git -C "$R" worktree add -q --detach "$D" ${sha}; fi`,
        `git -C "$R" update-ref -d ${runRefOf(key, idx)} 2>/dev/null || true`,
        'cd "$D"',
        `export DISPATCHER_MACHINE=${shq(mk)} DISPATCHER_PLACE=${Number(idx) || 0} DISPATCHER_SLOT=${shq(key)} DISPATCHER_JOB=${shq(jobId)} FORCE_COLOR=0`,
        FAIL_FN,
        `echo ${shq("папка прогона на " + String(sha).slice(0, 10))}`,
    ];
    if ((m.prepare || []).length) {
        L.push('echo "== подготовка"');
        for (const c of m.prepare)
            L.push(`echo ${shq("$ " + c)}`, `bash -ec ${shq(c)} || fail ${shq("подготовка не прошла: " + c)} $?`);
    }
    // службы — общий скрипт ядра (services.mjs): тот же, что поднимает службы на этой машине
    L.push(...upLines(m.services, { tries: serviceTries }), 'echo "== прогон"', `exec bash -c ${shq(cmd)}`);
    return L.join("\n");
}

/** Остановка служб (`down`) в папке прогона — когда на машине больше нет прогонов. */
export function downScript({ m, key, idx, services }) {
    return [...runDirLines(m, key, idx), 'cd "$D" 2>/dev/null || cd "$R"', ...downLines(services), ""].join("\n");
}

/**
 * Обёртка: тело — во временный файл и отдельной группой процессов (setsid, если есть) с записанным номером. Отмена
 * снимает всю группу на машине: без терминала обрыв ssh удалённую команду не остановит.
 */
export function groupWrap(body, pidFile, tag = crypto.randomBytes(6).toString("hex")) {
    const eof = "DISPATCHER_EOF_" + tag;
    return ['f=$(mktemp "${TMPDIR:-/tmp}/dispatcher-run.XXXXXX")', `cat > "$f" <<'${eof}'`, body, eof,
        'if command -v setsid >/dev/null 2>&1; then setsid bash "$f" </dev/null & else bash "$f" </dev/null & fi',
        "p=$!", `echo "$p" > ${shq(pidFile)}`, 'wait "$p"; c=$?', `rm -f "$f" ${shq(pidFile)}`, 'exit "$c"', ""].join("\n");
}

/** Снять прогон на машине по номеру группы: TERM, через 8 с KILL. */
export function killScript(pidFile) {
    return [`P=${shq(pidFile)}`, 'p=$(cat "$P" 2>/dev/null) || exit 0', '[ -n "$p" ] || exit 0',
        'kill -TERM -- -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null',
        'i=0; while [ "$i" -lt 8 ] && kill -0 "$p" 2>/dev/null; do sleep 1; i=$((i+1)); done',
        'kill -KILL -- -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null', 'rm -f "$P"', "true", ""].join("\n");
}

/** Уборка папок прогонов слотов, которых больше нет (папки ещё живых слотов не трогаются). */
export function pruneScript(m, liveKeys) {
    const live = " " + [...new Set(liveKeys.map(safeId))].join(" ") + " ";
    return [
        "set -e",
        `mkdir -p ${rdir(m.dir)}`,
        `R=$(cd ${rdir(m.dir)} && pwd)`,
        'W="$R-wt"',
        '[ -d "$W" ] || { echo "PRUNED 0"; exit 0; }',
        `live=${shq(live)}`,
        "n=0",
        'for d in "$W"/*; do [ -d "$d" ] || continue; b=$(basename "$d"); k=${b%-p*}; case "$live" in *" $k ' +
            '"*) continue;; esac; git -C "$R" worktree remove --force "$d" 2>/dev/null || rm -rf "$d"; ' +
            "n=$((n+1)); done",
        'git -C "$R" worktree prune',
        'echo "PRUNED $n"',
        "",
    ].join("\n");
}

/** Проба здоровья: память, подкачка, нагрузка, ядра и два замера /proc/stat через секунду (загрузка ЦП). */
export const PROBE_SH = ["grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null",
    "echo LOAD $(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)", "echo CORES $(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)",
    "echo CPU $(head -1 /proc/stat 2>/dev/null)", "sleep 1", "echo CPU $(head -1 /proc/stat 2>/dev/null)", "true", ""].join("\n");

/** Вывод пробы → нагрузка машины в форме slot-places.mjs; нет памяти в выводе — null (машина места не даёт). */
// Простой ЦП — поля idle и iowait строки cpu из /proc/stat; доступная память — MemAvailable (ядра без неё — MemTotal).
export function parseProbe(text, at = Date.now()) {
    const kb = {}, cpu = [];
    let load = null, cores = 0;
    for (const raw of String(text || "").split(/\r?\n/)) {
        const f = raw.trim().split(/\s+/);
        if (/^(MemTotal|MemAvailable|SwapTotal|SwapFree):$/.test(f[0]))
            kb[f[0].slice(0, -1)] = Number(f[1]) || 0;
        else if (f[0] === "LOAD" && f.length >= 4)
            load = f.slice(1, 4).map(Number);
        else if (f[0] === "CORES")
            cores = Number(f[1]) || 0;
        else if (f[0] === "CPU" && f[1] === "cpu") {
            const v = f.slice(2).map(Number);
            cpu.push({ tot: v.reduce((a, b) => a + (b || 0), 0), idle: (v[3] || 0) + (v[4] || 0) });
        }
    }
    if (!kb.MemTotal)
        return null;
    let pct = 0;
    if (cpu.length >= 2 && cpu[1].tot > cpu[0].tot)
        pct = Math.max(0, Math.min(100, Math.round(100 * (1 - (cpu[1].idle - cpu[0].idle) / (cpu[1].tot - cpu[0].tot)))));
    const GB = 2 ** 20, avail = kb.MemAvailable ?? kb.MemTotal;
    return { at, cpu: pct, cores: Array.from({ length: Math.max(1, cores) }, () => pct), memTotalGB: kb.MemTotal / GB, memUsedGB: (kb.MemTotal - avail) / GB,
        swapTotalGB: (kb.SwapTotal || 0) / GB, swapUsedGB: ((kb.SwapTotal || 0) - (kb.SwapFree || 0)) / GB, loadAvg: load };
}

/** Нагрузка этой машины: ЦП — по разности os.cpus() (не чаще раза в секунду), память — доступная по free-mem.mjs. */
// Окно замера ЦП — не меньше секунды: на коротком отрезке разность счётчиков os.cpus() — шум.
export function makeLocalLoad(now = Date.now) {
    let prev = null, prevAt = 0, cpu = 0;
    return () => {
        const cs = os.cpus(), t = now();
        const s = cs.reduce((a, c) => {
            a.tot += Object.values(c.times).reduce((x, y) => x + y, 0);
            a.idle += c.times.idle;
            return a;
        }, { tot: 0, idle: 0 });
        if (!prev || t - prevAt >= 1000) {
            if (prev && s.tot > prev.tot)
                cpu = Math.max(0, Math.min(100, Math.round(100 * (1 - (s.idle - prev.idle) / (s.tot - prev.tot)))));
            prev = s;
            prevAt = t;
        }
        const tot = os.totalmem() / 2 ** 30;
        return { at: t, cpu, cores: cs.map(() => cpu), memTotalGB: tot, memUsedGB: tot - availMem(t) / 2 ** 30, loadAvg: process.platform === "win32" ? null : os.loadavg() };
    };
}

const tailOf = (s, n = 1500) => String(s || "").trim().slice(-n);

// ───────────────────────────── модуль ─────────────────────────────

/**
 * Реализация shardApi() для машин из конфига.
 * ssh — чем ходить: { file, pre } (тесты подставляют поддельный ssh); spawnFn — запуск процессов (как spawner.spawn);
 * gate — ворота ssh для git push; watch — запускать пробы здоровья по таймеру.
 */
export function createMachinesApi({ machines = PROJECT.machines, project = PROJECT.name, ssh = { file: "ssh", pre: [] }, connectTimeoutS = 10, spawnFn = spawn,
    gate = () => sshGate, now = Date.now, emit = logEvent, localLoad = makeLocalLoad(now), probeEveryMs = 8000, watch = false, serviceTries = 15 } = {}) {
    const ids = Object.keys(machines).filter((id) => id !== "local" && machines[id] && machines[id].ssh);
    for (const id of ids)
        if (!SSH_HOST_RE.test(machines[id].ssh))
            throw new Error("machines." + id + ".ssh: нужен алиас из ~/.ssh/config, а не «" + machines[id].ssh + "»");
    const { tiers, profiles } = profilesOf(Object.fromEntries([...ids, "local"].map((id) => [id, machines[id] || {}])));
    const tracker = createHostTracker({ emit: (type, d) => emit(type, d), now });
    const ld = {}, res = new Map(), probing = new Set(), digestDirs = new Set(), timers = [];
    // git push ходит тем же ssh с теми же флагами, что и прогоны (в тестах — поддельный ssh из параметра ssh).
    const gitSshEnv = { GIT_SSH_VARIANT: "ssh", GIT_SSH_COMMAND: [ssh.file, ...(ssh.pre || [])].map((x) => shq(String(x).split("\\").join("/"))).join(" ") + " " + sshOpts(connectTimeoutS).join(" ") };

    /** Процесс → { code, out, err } — общий запуск ядра (services.mjs) с подменяемым spawn. */
    const run = (file, args, o = {}) => runProcess(file, args, { ...o, spawnFn });
    const sshRun = (mk, script, o = {}) => run(ssh.file, [...(ssh.pre || []), ...sshOpts(connectTimeoutS), machines[mk].ssh, "bash -s"], { ...o, input: script });
    /** git push сам открывает ssh — пропускаем его через те же ворота, что и ssh. */
    const gated = (fn) => new Promise((resolve) => {
        const h = gate().enter(() => {
            fn().then((r) => {
                h.release();
                resolve(r);
            }, (e) => {
                h.release();
                resolve({ code: 1, out: "", err: e.message });
            });
        }, "git push");
    });
    // В счётчик здоровья идёт только недоступность машины (код 255 у ssh): упавшая команда задачи — не сбой машины.
    const hostFail = (mk, r) => tracker.fail(mk, r.err || r.out || "код " + r.code);
    const online = (mk) => tracker.state(mk) === "online" && !!ld[mk] && !!ld[mk].at && now() - ld[mk].at <= FRESH_MS;

    // Вход правила мест (slot-places.mjs): состояние машин, брони и требования задачи.
    function ctx(opts = {}) {
        const ms = {};
        for (const mk of tiers) {
            const local = mk === "local";
            ms[mk] = { online: local || online(mk), off: false, ld: local ? localLoad() : ld[mk], caps: {}, reserved: [...res.values()].filter((x) => x.mk === mk) };
        }
        return { now: now(), fullRun: false, jobAgeMs: opts.ageMs || 0, heavy: !!opts.heavy, needs: opts.needs || [], only: opts.only || null, machines: ms, tiers, profiles };
    }

    /** Снимок папки слота коммитом через временный индекс (копия настоящего — с битами sparse): ветка и индекс не трогаются. */
    async function snapshot(cwd) {
        const g = (args, env) => run("git", ["-C", cwd, ...args], { env, timeoutMs: 600000 });
        const fail = (what, r) => new Error("снимок папки слота: " + what + " — " + tailOf(r.err || r.out, 300));
        const ip = await g(["rev-parse", "--path-format=absolute", "--git-path", "index"]);
        if (ip.code)
            throw fail("git rev-parse", ip);
        const tmp = path.join(os.tmpdir(), "dk-snap-" + crypto.randomBytes(6).toString("hex"));
        // Временный индекс — копия настоящего (с битами sparse-checkout), поэтому add -A не тащит файлы вне выборки слота.
        // GIT_OPTIONAL_LOCKS=0: снимок не берёт блокировку индекса слота, пока агент в нём работает; автор — служебный.
        const env = {
            GIT_INDEX_FILE: tmp,
            GIT_OPTIONAL_LOCKS: "0",
            GIT_AUTHOR_NAME: "dispatcher",
            GIT_AUTHOR_EMAIL: "dispatcher@localhost",
            GIT_COMMITTER_NAME: "dispatcher",
            GIT_COMMITTER_EMAIL: "dispatcher@localhost",
        };
        try {
            try {
                fs.copyFileSync(ip.out.trim(), tmp);
            }
            catch {
                const r = await g(["read-tree", "HEAD"], env);
                if (r.code)
                    throw fail("read-tree", r);
            }
            const a = await g(["add", "-A"], env);
            if (a.code)
                throw fail("git add", a);
            const [tree, head, headTree] = [await g(["write-tree"], env), await g(["rev-parse", "HEAD"]), await g(["rev-parse", "HEAD^{tree}"])];
            if (tree.code || head.code)
                throw fail("write-tree", tree.code ? tree : head);
            // Правок нет — доставляется сам HEAD, без лишнего коммита-снимка.
            if (tree.out.trim() === headTree.out.trim())
                return { sha: head.out.trim(), dirty: false };
            const c = await g(["commit-tree", tree.out.trim(), "-p", head.out.trim(), "-m", "снимок рабочей папки слота для прогона на машине"], env);
            if (c.code || !/^[0-9a-f]{40}$/.test(c.out.trim()))
                throw fail("commit-tree", c);
            return { sha: c.out.trim(), dirty: true };
        }
        finally {
            try {
                fs.rmSync(tmp, { force: true });
            }
            catch { }
        }
    }

    // Службы машины общие для её прогонов: останавливать их можно только после последнего прогона на этой машине.
    async function servicesDownIfLast(mk, jobId, key, idx, write) {
        const m = machines[mk], downs = (m.services || []).filter((s) => s.down);
        if (!downs.length || [...res].some(([id, x]) => id !== jobId && x.mk === mk))
            return;
        write("== службы: остановка (на машине больше нет прогонов)\n");
        await sshRun(mk, downScript({ m, key, idx, services: downs }), { onOut: write, timeoutMs: 180000 });
    }

    /** Прогон задачи на удалённой машине → код возврата удалённой команды (255 — ssh не дошёл). */
    async function slotRun({ jobId, key, cwd, cmd }, write, onChild, mk) {
        const m = machines[mk];
        if (!m || !m.ssh || mk === "local")
            throw new Error("машина «" + mk + "» не описана в machines или у неё нет ssh");
        if (!cwd)
            throw new Error("у прогона нет папки слота — доставлять нечего");
        const own = res.get(jobId), idx = own ? own.idx : 0, label = m.label || mk;
        if (own)
            own.key = key; // уборка папок прогонов не трогает слот, у которого идёт прогон
        write(`[${label}] место ${idx}: снимок папки слота → доставка по sha → подготовка → службы → прогон\n== код\n`);
        const snap = await snapshot(cwd);
        write("снимок " + snap.sha.slice(0, 10) + (snap.dirty ? " — с несохранёнными правками; ветка и индекс слота не тронуты" : "") + "\n");
        const repo = await sshRun(mk, repoScript(m), { timeoutMs: 60000 });
        const common = (/^COMMON (\S.*)$/m.exec(repo.out) || [])[1], top = (/^TOP (\S.*)$/m.exec(repo.out) || [])[1];
        if (repo.code || !common) {
            if (repo.code === 255)
                hostFail(mk, repo);
            write("✗ репозиторий на машине «" + label + "» не отвечает:\n" + tailOf(repo.err || repo.out) + "\n");
            return repo.code || 1;
        }
        tracker.ok(mk);
        if (top) {
            digestDirs.add(top.trim() + "-wt/" + runDirOf(key, idx));
            setDigestDirs([...digestDirs]);
        }
        const p = await gated(() =>
            run(
                "git",
                [
                    "-C",
                    cwd,
                    "push",
                    "--quiet",
                    // хуки слота (commit-msg и др.) к доставке отношения не имеют
                    "--no-verify",
                    m.ssh + ":" + common.trim(),
                    "+" + snap.sha + ":" + runRefOf(key, idx),
                ],
                { env: gitSshEnv, timeoutMs: 600000 },
            ),
        );
        if (p.code) {
            write("✗ код не доставлен на машину (git push, код " + p.code + "):\n" + tailOf(p.err || p.out) + "\n");
            return p.code;
        }
        // Прогон — отдельной группой процессов на машине: обрыв ssh её не остановит, отмена снимает по номеру группы.
        const r = await sshRun(mk, groupWrap(runBody({ m, mk, sha: snap.sha, key, idx, jobId, cmd, serviceTries }), pidFileOf(project, jobId)), { onOut: write, onChild });
        if (r.code === 255)
            hostFail(mk, r);
        await servicesDownIfLast(mk, jobId, key, idx, write);
        return r.code;
    }

    /** Отменить прогон на машине: снять его группу процессов. → true, если скрипт отработал. */
    async function slotCancel(jobId, mk) {
        if (!mk || mk === "local" || !machines[mk] || !machines[mk].ssh)
            return false;
        const r = await sshRun(mk, killScript(pidFileOf(project, jobId)), { timeoutMs: 30000 });
        return r.code === 0;
    }

    /** Убрать папки прогонов ушедших слотов на машинах на связи; слоты с идущими прогонами считаются живыми. */
    async function slotPrune(liveKeys = []) {
        const out = {};
        for (const mk of ids) {
            if (!online(mk))
                continue;
            const live = [...liveKeys, ...[...res.values()].filter((x) => x.mk === mk && x.key).map((x) => x.key)];
            const r = await sshRun(mk, pruneScript(machines[mk], live), { timeoutMs: 300000 });
            out[mk] = r.code ? "✗ " + tailOf(r.err || r.out, 160) : Number((/PRUNED (\d+)/.exec(r.out) || [])[1] || 0);
        }
        return out;
    }

    // Проба здоровья. Одна за раз на машину: медленный ssh не копит очередь проб от таймера.
    async function probe(mk) {
        if (probing.has(mk))
            return;
        probing.add(mk);
        try {
            const r = await sshRun(mk, PROBE_SH, { timeoutMs: 20000 });
            const l = r.code === 0 ? parseProbe(r.out, now()) : null;
            if (l) {
                ld[mk] = l;
                tracker.ok(mk);
            }
            else {
                // нагрузка больше не свежая: машина не даёт мест, пока следующая проба не удастся
                if (ld[mk])
                    ld[mk].at = 0;
                tracker.fail(mk, r.code === 0 ? "проба не вернула память машины (нет /proc/meminfo)" : r.err || r.out || "код " + r.code);
            }
        }
        finally {
            probing.delete(mk);
        }
    }

    if (watch)
        for (const mk of ids) {
            probe(mk).catch(() => { });
            const t = setInterval(() => probe(mk).catch(() => { }), probeEveryMs);
            if (t.unref)
                t.unref();
            timers.push(t);
        }

    const label = (mk) => (profiles[mk] || {}).label || String(mk || "");
    return {
        ...noMachinesApi(),
        on: true,
        why: "",
        machineIds: ids,
        slotFree: (lane, opts) => !!pickPlace(lane, ctx(opts)),
        slotReserve(jobId, lane, opts) {
            const p = pickPlace(lane, ctx(opts));
            if (!p) return -1;
            res.set(jobId, { mk: p.mk, kind: lane, idx: p.idx, at: now(), key: "" });
            return p.idx;
        },
        slotMachineOf: (jobId) => (res.get(jobId) || {}).mk || null,
        // Пояснение в карточке прогона: удалённые машины есть, а прогон ушёл на эту.
        slotWhyOf: (jobId) =>
            (res.get(jobId) || {}).mk === "local" && ids.length ? "удалённые машины места не дали" : "",
        slotRelease: (jobId) => {
            res.delete(jobId);
        },
        slotOnline: (mk) => (mk ? mk === "local" || online(mk) : ids.some(online)),
        slotAnyOnline: () => ids.some(online),
        machineLabel: label,
        slotRun,
        slotCancel,
        slotPrune,
        hostHealth: () => tracker.snapshot(),
        load: () => Object.fromEntries([["local", localLoad()], ...ids.filter(online).map((mk) => [mk, ld[mk]])]),
        pub: () => ({
            on: true,
            why: "",
            run: null,
            machines: tiers.map((mk) => ({
                id: mk,
                label: label(mk),
                online: mk === "local" || online(mk),
                workers: profiles[mk].places.length,
                lanes: profiles[mk].lanes,
                reserved: [...res.values()].filter((x) => x.mk === mk).length,
                ld: mk === "local" ? localLoad() : ld[mk] || null,
                health: mk === "local" ? null : tracker.snapshot()[mk] || null,
            })),
        }),
        start: async () => ({ ok: false, error: NO_FULL_RUN }),
        cancel: async () => ({ ok: false, error: NO_FULL_RUN }),
        clean: async () => ({ ok: false, error: NO_FULL_RUN }),
        check: async () => ({ ok: false, error: NO_FULL_RUN }),
        probeNow: () => Promise.all(ids.map(probe)),
        _noteLoad(mk, l) {
            ld[mk] = l;
            tracker.ok(mk);
        },
        stop() {
            timers.forEach(clearInterval);
            timers.length = 0;
        },
    };
}

/** Включить модуль: реализация машин из конфига ставится в shardApi(), пробы здоровья — по таймеру. */
export function initMachines(opts = {}) {
    const api = createMachinesApi({ watch: true, ...opts });
    setShardApi(api);
    return api;
}
