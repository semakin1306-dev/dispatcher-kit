// spawner.mjs — запуск процессов вне основного потока сервера. Синхронная часть создания процесса временами стоит
// секундами и держит поток, который её вызвал; поэтому процессы рождает отдельный поток-помощник, а сервер продолжает
// отвечать. Здесь же остановка дерева процессов (killTree): taskkill /T на Windows, обход потомков на Linux и macOS.
//
// Устройство. Один поток-помощник (Worker из этого же файла, workerData.dispatcherSpawner) владеет настоящими процессами;
// основной поток получает двойника Child с тем же интерфейсом, что у node:child_process (stdout/stderr — потоки, события
// spawn → exit → close, коды и поля ошибок), и общается с помощником сообщениями по id задания. execFile и spawn отсюда
// подменяют одноимённые из node:child_process во всех модулях диспетчерской.
//
// Инварианты:
// - помощник упал — все его задания получают ошибку ESPAWNER, следующий запуск поднимает новый поток (процессы не теряются
//   молча: вызывающий узнаёт об обрыве);
// - поток-помощник держит процесс node, только пока есть задания со ссылкой (счётчик refs): unref() у двойника отпускает
//   его так же, как у настоящего процесса;
// - ssh-команды проходят ворота ssh-gate.mjs (не больше DASH_SSH_MAX рукопожатий одновременно, пауза между стартами):
//   пачка одновременных подключений перегружает sshd удалённой машины;
// - DASH_SPAWN_INLINE=1 или недоступный помощник — запуск прямо в основном потоке (тот же результат, без выигрыша).
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import { Readable, Writable, finished } from "node:stream";
import { SHARE_ENV, Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createSshGate } from "./ssh-gate.mjs";
import { killPosixTree } from "./proc-tree.mjs";

// Опции, которые доходят до помощника: передаются структурным клонированием, функции и потоки туда не пройдут.
const OPT_KEYS = ["cwd", "env", "timeout", "maxBuffer", "encoding", "killSignal", "windowsHide", "windowsVerbatimArguments", "shell", "detached", "stdio", "argv0", "uid", "gid"];

const pick = (o) => {
    const r = {};
    for (const k of OPT_KEYS)
        if (o && o[k] !== undefined)
            r[k] = o[k];
    return r;
};

// Ошибка через границу потоков: сообщение, имя, стек и собственные поля (code, killed, signal, cmd — как у child_process).
const ser = (e) => ({ message: String((e && e.message) || e), name: (e && e.name) || "Error", stack: e && e.stack, props: e && typeof e === "object" ? { ...e } : {} });

const revive = (s) => {
    const e = new Error(s.message);
    e.name = s.name;
    Object.assign(e, s.props);
    if (s.stack)
        e.stack = s.stack;
    return e;
};

const buf = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

// ───────────────────────────── поток-помощник ─────────────────────────────
// Тот же модуль, загруженный внутри Worker: здесь живут настоящие процессы.
if (!isMainThread && workerData && workerData.dispatcherSpawner) {
    const kids = new Map(), post = (m) => parentPort.postMessage(m);
    // Снять дерево: на Windows taskkill /T /F (процесс и его потомки), на POSIX — обход таблицы процессов (proc-tree.mjs),
    // иначе дети агента или прогона (тесты, сборки) остаются сиротами после остановки.
    const tree = (c) => {
        if (!c.pid)
            return;
        if (process.platform === "win32")
            cp.execFile("taskkill", ["/PID", String(c.pid), "/T", "/F"], { windowsHide: true }, () => { });
        else
            killPosixTree(c.pid, "SIGTERM", (sig) => c.kill(sig));
    };
    const run = ({ id, mode, file, args, opts }) => {
        let c;
        const t0 = performance.now();
        try {
            c = mode === "exec"
                ? cp.execFile(file, args, opts, (e, so, se) => post({ t: "done", id, error: e ? ser(e) : null, so, se }))
                : cp.spawn(file, args, opts);
        }
        catch (e) {
            post({ t: "throw", id, error: ser(e) });
            return;
        }
        // Долгий синхронный запуск (больше секунды) — в статистику: ради таких случаев запуск и вынесен из основного потока.
        const ms = performance.now() - t0;
        if (ms > 1000)
            post({ t: "slow", id, ms: Math.round(ms), file });
        kids.set(id, c);
        c.on("spawn", () => post({ t: "spawn", id, pid: c.pid }));
        c.on("error", (e) => post({ t: "error", id, error: ser(e) }));
        c.on("exit", (code, sig) => post({ t: "exit", id, code, sig }));
        c.on("close", (code, sig) => {
            kids.delete(id);
            post({ t: "close", id, code, sig });
        });
        if (c.stdin)
            c.stdin.on("error", (e) => post({ t: "inErr", id, error: ser(e) }));
        if (mode !== "exec")
            for (const [fd, s] of [[1, c.stdout], [2, c.stderr]])
                if (s) {
                    s.on("data", (d) => post({ t: "out", id, fd, d }));
                    s.on("end", () => post({ t: "outEnd", id, fd }));
                }
    };
    parentPort.on("message", (m) => {
        // Только для теста «падение воркера»: проверить, что задания получают ESPAWNER.
        if (m.t === "crash")
            throw new Error("проверочное падение запускальщика");
        if (m.t === "run")
            return run(m);
        const c = kids.get(m.id);
        if (!c)
            return;
        try {
            if (m.t === "in") {
                if (c.stdin)
                    c.stdin.write(buf(m.d));
            }
            else if (m.t === "inEnd") {
                if (c.stdin)
                    c.stdin.end();
            }
            else if (m.t === "kill")
                c.kill(m.sig);
            else if (m.t === "tree")
                tree(c);
            else if (m.t === "unref")
                c.unref();
            else if (m.t === "prio") {
                if (c.pid)
                    os.setPriority(c.pid, m.prio);
            }
        }
        catch { }
    });
}

// ───────────────────────────── основной поток ─────────────────────────────

export const INLINE = process.env.DASH_SPAWN_INLINE === "1";
export const spawnStats = { started: 0, slow: 0, worstMs: 0, restarts: 0 };
export const isSshCommand = (file) => /(^|[\\/])ssh(\.exe)?$/i.test(String(file));
// Слот ворот ssh отпускается по первому выводу или ошибке процесса, а если их нет — через столько после запуска.
const HANDSHAKE_MS = 4000;
let sshHook = null;

export let sshGate = createSshGate({ max: Number(process.env.DASH_SSH_MAX) || 3, minGapMs: process.env.DASH_SSH_GAP_MS === undefined ? 150 : Number(process.env.DASH_SSH_GAP_MS), onSlow: (x) => {
        if (sshHook)
            sshHook(x);
    } });

export const setSshGateHook = (fn) => {
    sshHook = fn;
};

export const sshGateStats = () => sshGate.snapshot();

export const _setSshGate = (g) => {
    sshGate = g;
};

let W = null, seq = 0;

/** Поднять поток-помощник (без ссылки: процесс держат задания). Ошибка или выход потока обрывают его задания ошибкой ESPAWNER. */
function newWorker() {
    const w = { jobs: new Map(), refs: 0, dead: false };
    // Флаг --input-type основного процесса (запуск из node -e / stdin) поток с файлом-модулем не принимает — убрать.
    const xa = process.execArgv.some((a) => a.startsWith("--input-type")) ? process.execArgv.filter((a) => !a.startsWith("--input-type")) : undefined;
    w.t = new Worker(new URL(import.meta.url), { workerData: { dispatcherSpawner: true }, env: SHARE_ENV, ...(xa ? { execArgv: xa } : {}) });
    w.t.unref();
    w.t.on("message", (m) => {
        if (m.t === "slow") {
            spawnStats.slow++;
            spawnStats.worstMs = Math.max(spawnStats.worstMs, m.ms);
            if (process.env.DASH_TIMING)
                console.log("[время] spawn в воркере " + m.ms + " мс: " + m.file);
            return;
        }
        const ch = w.jobs.get(m.id);
        if (ch)
            ch._msg(m);
    });
    const die = (e) => {
        if (w.dead)
            return;
        w.dead = true;
        if (W === w)
            W = null;
        spawnStats.restarts++;
        const err = Object.assign(new Error("запускальщик процессов упал: " + ((e && e.message) || "код " + e)), { code: "ESPAWNER" });
        if (w.jobs.size)
            console.error("[spawner] воркер упал, заданий оборвано:", w.jobs.size, "—", err.message);
        for (const ch of [...w.jobs.values()])
            ch._fail(err);
        w.jobs.clear();
        if (w.refs) {
            w.refs = 0;
            w.t.unref();
        }
    };
    w.t.on("error", die);
    w.t.on("exit", (code) => die(code));
    return (W = w);
}

const worker = () => W || newWorker();

// Счётчик заданий со ссылкой: поток держит процесс, пока счётчик больше нуля, как живой дочерний процесс.
const refW = (w, d) => {
    if (w.dead)
        return;
    const was = w.refs;
    w.refs += d;
    if (!was && w.refs)
        w.t.ref();
    else if (was && !w.refs)
        w.t.unref();
};

const stdioOf = (o, i) => {
    const s = o.stdio;
    const v = s == null ? "pipe" : typeof s === "string" ? s : s[i];
    return v == null ? "pipe" : v;
};

const isPipe = (v) => v === "pipe" || v === "overlapped";

/**
 * Двойник дочернего процесса в основном потоке. Пока ssh-задание стоит в очереди ворот (_hold), сообщения ему
 * (stdin, kill) копятся в _q и уходят сразу после запуска — запись в stdin до старта не теряется.
 */
class Child extends EventEmitter {
    constructor(w, id, mode, file, args, opts, cb) {
        super();
        Object.assign(this, {
            _w: w,
            _id: id,
            _mode: mode,
            _cb: cb,
            _ref: true,
            _closed: false,
            _hold: false,
            _q: [],
            _h: null,
            _relT: null,
            pid: undefined,
            exitCode: null,
            signalCode: null,
            killed: false,
            spawnfile: file,
            spawnargs: [file, ...args],
        });
        this.stdin = isPipe(stdioOf(opts, 0)) ? new Writable({
            write: (chunk, enc, done) => {
                this._post({ t: "in", d: chunk });
                done();
            },
            final: (done) => {
                this._post({ t: "inEnd" });
                done();
            },
        }) : null;
        const rd = (i) => (mode !== "exec" && isPipe(stdioOf(opts, i)) ? new Readable({ read() { } }) : null);
        this.stdout = rd(1);
        this.stderr = rd(2);
        this.stdio = [this.stdin, this.stdout, this.stderr];
    }
    _post(m) {
        if (this._hold) {
            this._q.push(m);
            return;
        }
        if (!this._w.dead && !this._closed)
            this._w.t.postMessage({ ...m, id: this._id });
    }
    _rel() {
        if (this._relT) {
            clearTimeout(this._relT);
            this._relT = null;
        }
        if (this._h)
            this._h.release();
    }
    _gate(gate, run) {
        this._hold = true;
        this._h = gate.enter(() => {
            this._hold = false;
            if (this._closed) {
                this._rel();
                return;
            }
            run();
            for (const m of this._q.splice(0))
                this._post(m);
        }, spawnSshTag(this));
    }
    // Отмена ssh, который ещё стоит в очереди ворот: процесса нет, обратный вызов получает ECANCELED, очередь идёт дальше.
    _unqueue() {
        if (!this._hold || !this._h || !this._h.cancel())
            return false;
        this._hold = false;
        this._q.length = 0;
        this.killed = true;
        const err = Object.assign(new Error("ssh отменён до запуска (стоял в очереди ворот)"), { code: "ECANCELED" });
        if (this._cb)
            this._fail(err);
        else
            this._close(null, "SIGTERM");
        return true;
    }
    // Как у child_process: ошибка без слушателя у spawn не роняет сервер, а пишется в журнал; у execFile её получает cb.
    _emitErr(e) {
        if (this.listenerCount("error"))
            this.emit("error", e);
        else if (this._mode !== "exec")
            console.error("[spawner] " + this.spawnfile + ": " + e.message);
    }
    _end() {
        if (this._closed)
            return;
        this._closed = true;
        this._w.jobs.delete(this._id);
        if (this._ref) {
            this._ref = false;
            refW(this._w, -1);
        }
    }
    _msg(m) {
        switch (m.t) {
            // Процесс запущен: если стоял в воротах ssh — слот отпустится по выводу или через HANDSHAKE_MS.
            case "spawn":
                this.pid = m.pid;
                if (this._h && !this._relT) {
                    this._relT = setTimeout(() => {
                        this._relT = null;
                        this._rel();
                    }, HANDSHAKE_MS);
                    this._relT.unref();
                }
                this.emit("spawn");
                break;
            // Первый вывод — рукопожатие ssh прошло, слот ворот больше не нужен.
            case "out": {
                this._rel();
                const s = m.fd === 1 ? this.stdout : this.stderr;
                if (s && !s.readableEnded)
                    s.push(buf(m.d));
                break;
            }
            case "outEnd": {
                const s = m.fd === 1 ? this.stdout : this.stderr;
                if (s)
                    s.push(null);
                break;
            }
            case "inErr":
                if (this.stdin && this.stdin.listenerCount("error"))
                    this.stdin.emit("error", revive(m.error));
                break;
            case "error":
                this._rel();
                this._emitErr(revive(m.error));
                break;
            case "throw":
                this._fail(revive(m.error));
                break;
            case "exit":
                this._rel();
                this.exitCode = m.code;
                this.signalCode = m.sig;
                this.emit("exit", m.code, m.sig);
                break;
            case "done": {
                this._rel();
                const cb = this._cb;
                this._cb = null;
                if (cb)
                    cb(m.error ? revive(m.error) : null, this._conv(m.so), this._conv(m.se));
                break;
            }
            case "close":
                this._close(m.code, m.sig);
                break;
        }
    }
    _conv(x) {
        return typeof x === "string" || x == null ? x : buf(x);
    }
    // close — после того как читающие потоки вывода дочитаны: иначе обработчик close увидит неполный вывод
    // (как у child_process: close приходит после конца stdout и stderr).
    _close(code, sig) {
        if (this._closed)
            return;
        this._rel();
        this._end();
        if (this.exitCode === null && this.signalCode === null) {
            this.exitCode = code;
            this.signalCode = sig;
        }
        for (const s of [this.stdout, this.stderr])
            if (s && !s.readableEnded)
                s.push(null);
        const wait = [this.stdout, this.stderr].filter((s) => s && s.readableFlowing && !s.readableEnded);
        let n = wait.length;
        const fire = () => this.emit("close", code, sig);
        if (!n)
            return fire();
        for (const s of wait)
            finished(s, () => {
                if (--n === 0)
                    fire();
            });
    }
    _fail(err) {
        if (this._closed)
            return;
        this._rel();
        const cb = this._cb;
        this._cb = null;
        if (cb) {
            this._end();
            cb(err, "", "");
            return;
        }
        this._emitErr(err);
        this._close(null, null);
    }
    kill(sig = "SIGTERM") {
        if (this._closed)
            return false;
        if (this._unqueue())
            return true;
        this._post({ t: "kill", sig });
        this.killed = true;
        return true;
    }
    // Работает и до прихода pid: сообщение встаёт в очередь задания, помощник снимет дерево, когда процесс будет.
    treeKill() {
        if (this._unqueue())
            return;
        this._post({ t: "tree" });
    }
    setPriority(prio) {
        this._post({ t: "prio", prio });
    }
    unref() {
        if (this._ref && !this._closed) {
            this._ref = false;
            refW(this._w, -1);
            this._post({ t: "unref" });
        }
        return this;
    }
    ref() {
        if (!this._ref && !this._closed) {
            this._ref = true;
            refW(this._w, 1);
        }
        return this;
    }
}

const spawnSshTag = (ch) => String((ch.spawnargs || []).slice(1).filter((a) => !a.startsWith("-")).slice(0, 2).join(" ")).slice(0, 80);

/**
 * Завести задание у помощника → двойник Child или null (помощник недоступен — вызывающий запустит в основном потоке).
 * ssh-команда сначала встаёт в ворота и уходит помощнику, когда ворота пустят.
 */
function start(mode, file, args, opts, cb) {
    let w;
    const id = ++seq, o = pick(opts), gated = isSshCommand(file);
    try {
        w = worker();
        if (!gated)
            w.t.postMessage({ t: "run", id, mode, file, args, opts: o });
    }
    catch (e) {
        console.error("[spawner] запуск в основном потоке:", e.message);
        return null;
    }
    const ch = new Child(w, id, mode, file, args, o, cb);
    w.jobs.set(id, ch);
    refW(w, 1);
    spawnStats.started++;
    if (gated)
        ch._gate(sshGate, () => {
            try {
                w.t.postMessage({ t: "run", id, mode, file, args, opts: o });
            }
            catch (e) {
                ch._fail(Object.assign(new Error("запускальщик процессов недоступен: " + e.message), { code: "ESPAWNER" }));
            }
        });
    return ch;
}

/** Как child_process.execFile (те же перегрузки аргументов), но процесс рождает поток-помощник. */
export function execFile(file, args, opts, cb) {
    if (typeof args === "function") {
        cb = args;
        args = [];
        opts = {};
    }
    else if (args != null && !Array.isArray(args)) {
        cb = opts;
        opts = args;
        args = [];
    }
    if (typeof opts === "function") {
        cb = opts;
        opts = {};
    }
    return (!INLINE && start("exec", String(file), (args || []).map(String), opts || {}, cb || (() => { }))) || cp.execFile(file, args || [], opts || {}, cb);
}

/** Как child_process.spawn, но процесс рождает поток-помощник. */
export function spawn(file, args, opts) {
    if (args != null && !Array.isArray(args)) {
        opts = args;
        args = [];
    }
    return (!INLINE && start("spawn", String(file), (args || []).map(String), opts || {}, null)) || cp.spawn(file, args || [], opts || {});
}

/** Снять процесс со всеми потомками: двойника — через помощника, обычный ChildProcess — здесь же. */
export function killTree(child) {
    if (!child)
        return;
    if (child instanceof Child)
        return child.treeKill();
    if (!child.pid)
        return;
    if (process.platform === "win32")
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => { });
    else
        killPosixTree(child.pid, "SIGTERM", typeof child.kill === "function" ? (sig) => child.kill(sig) : null);
}

/** Понизить приоритет процесса (прогоны тестов не должны отнимать процессор у сервера и агентов). */
export function lowerPriority(child, prio = os.constants.priority.PRIORITY_BELOW_NORMAL) {
    if (!child)
        return;
    if (child instanceof Child)
        return child.setPriority(prio);
    try {
        if (child.pid)
            os.setPriority(child.pid, prio);
    }
    catch { }
}

export const _crashWorkerOf = (child) => {
    if (child instanceof Child && !child._w.dead)
        child._w.t.postMessage({ t: "crash" });
};

export const _workerAlive = () => !!W;
