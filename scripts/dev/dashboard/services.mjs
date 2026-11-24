// services.mjs — службы для тестов (`machines.<id>.services`: { name, up, down?, check? }). Одна реализация на все машины:
// скрипт подъёма и остановки строится здесь, а выполняет его та машина, на которой идёт прогон. Удалённая машина (модуль
// machines) вставляет те же строки в свой скрипт прогона и шлёт его по ssh; эта машина выполняет их здесь, через bash
// (на Windows — Git Bash, как пускатели задач с вводом), перед прогоном, которому нужны службы. Это ядро: службы этой
// машины поднимаются и при выключенном модуле machines.
//
// Порядок для каждой службы: `check` прошёл — служба уже работает, `up` не запускается; не прошёл — `up`, затем `check`
// до N раз с паузой; так и не ответила — прогон красный с понятной строкой. Без `check` — `up` при каждом прогоне.
// `down` — когда на машине не осталось прогонов, которым нужны службы. Каждая команда — отдельный `bash -ec`.
import { PROJECT } from "../slots.mjs";
import { findBash } from "./tasks.mjs";
import { killTree, spawn } from "./spawner.mjs";

export const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
/** Остановить скрипт с понятной строкой и кодом (по умолчанию 1). */
export const FAIL_FN = 'fail() { echo "✗ $1"; exit "${2:-1}"; }';
/** Команда пользователя: отдельный bash -ec без ввода (скрипт сам идёт через stdin — команда его не съест). */
const cmdOf = (c) => `bash -ec ${shq(c)} </dev/null`;

/** Строки подъёма служб (нужна функция fail из FAIL_FN). tries — сколько раз проверять после `up`, pauseS — пауза. */
export function upLines(services, { tries = 15, pauseS = 2 } = {}) {
    const L = [];
    for (const s of services || []) {
        L.push(`echo ${shq("== служба " + s.name)}`);
        const up = `${cmdOf(s.up)} || fail ${shq("служба " + s.name + ": запуск не прошёл")} $?`;
        if (s.check) {
            const ck = `${cmdOf(s.check)} >/dev/null 2>&1`;
            L.push(`if ${ck}; then echo "уже работает"; else ${up}; n=0; until ${ck}; do n=$((n+1)); [ "$n" -ge ${Math.max(1, Number(tries) || 1)} ] && fail ${shq("служба " + s.name + " не отвечает после запуска: проверка «" + s.check + "» не проходит")}; sleep ${Number(pauseS) || 0}; done; echo "запущена"; fi`);
        }
        else
            L.push(up);
    }
    return L;
}

/** Строки остановки служб, у которых есть `down`; упавшая остановка не останавливает остальные. */
export function downLines(services) {
    const L = [];
    for (const s of (services || []).filter((x) => x.down))
        L.push(`echo ${shq("служба " + s.name + ": остановка")}`, `${cmdOf(s.down)} || echo ${shq("✗ служба " + s.name + ": остановка не прошла")}`);
    return L;
}

/** Процесс → { code, out, err }; onOut получает вывод потоком (тогда копится только хвост). Общий для этой и удалённых машин. */
export function runProcess(file, args, { spawnFn = spawn, cwd, env, input, timeoutMs = 0, onOut, onChild } = {}) {
    return new Promise((resolve) => {
        let out = "", err = "", done = false, t = null, child;
        const end = (code) => {
            if (done)
                return;
            done = true;
            if (t)
                clearTimeout(t);
            resolve({ code, out, err });
        };
        try {
            child = spawnFn(file, args, { cwd, env: env ? { ...process.env, ...env } : process.env, windowsHide: true });
        }
        catch (e) {
            err = e.message;
            return end(127);
        }
        if (onChild)
            onChild(child);
        const take = (cur, d) => (onOut ? (cur + d).slice(-6000) : cur + d);
        child.stdout.on("data", (d) => {
            out = take(out, String(d));
            if (onOut)
                onOut(String(d));
        });
        child.stderr.on("data", (d) => {
            err = take(err, String(d));
            if (onOut)
                onOut(String(d));
        });
        child.on("error", (e) => {
            err += e.message;
            end(127);
        });
        child.on("close", (code) => end(code === null ? 130 : code));
        if (timeoutMs)
            t = setTimeout(() => {
                err += "\nнет ответа за " + Math.round(timeoutMs / 1000) + " с — снят";
                try {
                    killTree(child);
                }
                catch { }
                end(124);
            }, timeoutMs);
        if (child.stdin) {
            child.stdin.on("error", () => { });
            child.stdin.end(input === undefined ? "" : input);
        }
    });
}

/** bash этой машины: на Windows — Git Bash (findBash, DISPATCHER_BASH), иначе bash из PATH. "" — не найден. */
export const localBash = (platform = process.platform, env = process.env) => (platform === "win32" ? findBash(env) : "bash");
export const NO_BASH = "службы этой машины запускаются через bash, а он не найден: поставьте Git for Windows или задайте DISPATCHER_BASH";

/** Прогону нужны службы: задача проекта или прогон, который сам гоняет задачи проекта здесь (поезд без машин). */
export const usesServices = (job, tasks) => !!(job && (tasks[job.task] || job.services));

/**
 * Службы этой машины. up() — перед прогоном: бронь + подъём, → код (0 — всё работает). release() — после прогона:
 * снять бронь, последний — `down`. Подъём и остановка идут по одной: второй прогон ждёт первый и видит его службы.
 * check() — одна проверка службы для монитора.
 */
export function createLocalServices({ services = (PROJECT.machines.local || {}).services || [], bash = () => localBash(), spawnFn = spawn, tries = 15, pauseS = 2, downTimeoutMs = 180000 } = {}) {
    const active = new Set();
    let chain = Promise.resolve();
    const serial = (fn) => {
        const p = chain.then(fn, fn);
        chain = p.catch(() => { });
        return p;
    };
    const envOf = ({ jobId = "", key = "" } = {}) => ({ FORCE_COLOR: "0", DISPATCHER_MACHINE: "local", DISPATCHER_SLOT: String(key || ""), DISPATCHER_JOB: String(jobId || "") });
    async function script(lines, run, o = {}) {
        const sh = bash();
        if (!sh) {
            if (o.onOut)
                o.onOut("✗ " + NO_BASH + "\n");
            return { code: 127, out: "", err: NO_BASH };
        }
        return runProcess(sh, ["-s"], { spawnFn, cwd: run.cwd, env: envOf(run), input: ["set -e", FAIL_FN, ...lines, ""].join("\n"), ...o });
    }
    return {
        list: services,
        active: () => [...active],
        async up(run, write = () => { }, onChild) {
            active.add(run.jobId);
            if (!services.length)
                return 0;
            return serial(async () => {
                write("\n== службы этой машины\n");
                return (await script(upLines(services, { tries, pauseS }), run, { onOut: write, onChild })).code;
            });
        },
        async release(run, write = () => { }) {
            if (!active.delete(run.jobId) || !services.some((s) => s.down))
                return null;
            return serial(async () => {
                if (active.size)
                    return null;
                write("\n== службы этой машины: остановка (прогонов, которым они нужны, больше нет)\n");
                return (await script(downLines(services), run, { onOut: write, timeoutMs: downTimeoutMs })).code;
            });
        },
        async check(s, cwd, timeoutMs = 10000) {
            const t0 = Date.now(), r = await script([cmdOf(s.check)], { cwd }, { timeoutMs });
            return { ok: r.code === 0, ms: Date.now() - t0, why: r.code === 127 && !bash() ? NO_BASH : "" };
        },
    };
}

let local = null;
/** Службы этой машины из конфига (одни на процесс). */
export const localServices = () => local || (local = createLocalServices());
/** Подменить службы этой машины (тесты); без аргумента — вернуть службы из конфига. */
export function setLocalServices(x) {
    local = x || null;
}
