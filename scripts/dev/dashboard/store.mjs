// store.mjs — файлы состояния: атомарная запись (временный файл → сброс на диск → переименование с повторами) и чтение.
// Повреждённый файл не затирается, а откладывается рядом как .corrupt-<время>; брошенные временные файлы прошлых
// процессов убираются при запуске.
import fs from "node:fs";
import path from "node:path";

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RETRIES = 5;
let seq = 0;
const tmpOf = (file) => file + ".tmp-" + process.pid + "-" + (++seq);
const TMP_RE = /\.tmp-(\d+)-\d+$/;

const sleepSync = (ms) => {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
    catch { }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asText = (value, space) => JSON.stringify(value, null, space || undefined);
const noBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const optsOf = (o) => (typeof o === "number" ? { space: o } : o || {});

const syncDir = (file) => {
    if (process.platform === "win32")
        return;
    try {
        const fd = fs.openSync(path.dirname(file), "r");
        try {
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch { }
};

export function writeAtomicSync(file, data, opts = {}) {
    const tmp = tmpOf(file);
    try {
        const fd = fs.openSync(tmp, "w", opts.mode);
        try {
            fs.writeFileSync(fd, data);
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        for (let i = 0;; i++) {
            try {
                fs.renameSync(tmp, file);
                break;
            }
            catch (e) {
                if (!RETRY_CODES.has(e.code) || i >= RETRIES - 1)
                    throw e;
                sleepSync(25 * (i + 1));
            }
        }
    }
    catch (e) {
        try {
            fs.unlinkSync(tmp);
        }
        catch { }
        throw e;
    }
    syncDir(file);
}

export async function writeAtomic(file, data, opts = {}) {
    const tmp = tmpOf(file);
    try {
        const fh = await fs.promises.open(tmp, "w", opts.mode);
        try {
            await fh.writeFile(data);
            await fh.sync();
        }
        finally {
            await fh.close();
        }
        for (let i = 0;; i++) {
            try {
                await fs.promises.rename(tmp, file);
                break;
            }
            catch (e) {
                if (!RETRY_CODES.has(e.code) || i >= RETRIES - 1)
                    throw e;
                await sleep(25 * (i + 1));
            }
        }
    }
    catch (e) {
        await fs.promises.unlink(tmp).catch(() => { });
        throw e;
    }
    syncDir(file);
}

const latest = new Map();
const running = new Map();
const held = new Set();

export function saveJson(file, value, opts) {
    if (held.has(file))
        return Promise.resolve();
    const o = optsOf(opts);
    latest.set(file, { data: asText(value, o.space), opts: o, done: false });
    if (!running.has(file))
        running.set(file, drain(file));
    return running.get(file);
}

async function drain(file) {
    for (;;) {
        const cur = latest.get(file);
        if (!cur || cur.done) {
            running.delete(file);
            return;
        }
        try {
            await writeAtomic(file, cur.data, cur.opts);
        }
        catch (e) {
            console.error("запись " + path.basename(file) + ":", e.message);
        }
        cur.done = true;
        cur.data = null;
    }
}

export function writeJsonSync(file, value, opts) {
    if (held.has(file))
        return;
    const o = optsOf(opts), data = asText(value, o.space);
    writeAtomicSync(file, data, o);
    latest.set(file, running.has(file) ? { data, opts: o, done: false } : { data: null, opts: o, done: true });
}

export function flushSync() {
    for (const [file, cur] of latest) {
        if (cur.done)
            continue;
        try {
            writeAtomicSync(file, cur.data, cur.opts);
            cur.done = true;
            cur.data = null;
        }
        catch (e) {
            console.error("запись " + path.basename(file) + ":", e.message);
        }
    }
}

export const settled = () => Promise.all([...running.values()]);

export function rewriteJsonl(file, rows) {
    writeAtomicSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

const corrupt = [];
let onCorrupt = null;

export function setCorruptHook(fn) {
    onCorrupt = fn;
    for (const r of corrupt) {
        try {
            fn(r);
        }
        catch { }
    }
}

export const corruptList = () => corrupt.map(({ file, movedTo, at, error, bytes, held: h }) => ({ file, movedTo, at, error, bytes, held: !!h }));
const holdOnly = () => process.env.DASH_DRY === "1" && !process.env.DASH_DATA;
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

export function readJson(file, fallback) {
    let buf = null;
    for (let i = 0;; i++) {
        try {
            buf = fs.readFileSync(file);
            break;
        }
        catch (e) {
            if (e.code === "ENOENT")
                return fallback;
            if (RETRY_CODES.has(e.code) && i < RETRIES - 1) {
                sleepSync(25 * (i + 1));
                continue;
            }
            console.error("чтение " + path.basename(file) + ":", e.message);
            return fallback;
        }
    }
    try {
        return JSON.parse(noBom(buf.toString("utf8")));
    }
    catch (e) {
        const rec = { file: path.basename(file), path: file, movedTo: "", at: Date.now(), error: String(e.message).slice(0, 200), bytes: buf.length };
        if (holdOnly()) {
            rec.held = true;
            held.add(file);
        }
        else {
            const to = file + ".corrupt-" + stamp();
            try {
                fs.renameSync(file, to);
            }
            catch {
                try {
                    fs.writeFileSync(to, buf);
                }
                catch (e2) {
                    console.error("битый " + rec.file + " не сохранён:", e2.message);
                    rec.held = true;
                    held.add(file);
                }
            }
            if (!rec.held)
                rec.movedTo = path.basename(to);
        }
        corrupt.push(rec);
        console.error("‼ битый файл состояния " + rec.file + " (" + rec.error + "): " + (rec.held ? "оставлен как есть, запись в него отключена" : "перенесён в " + rec.movedTo) + ", состояние этого файла — с нуля");
        if (onCorrupt) {
            try {
                onCorrupt(rec);
            }
            catch { }
        }
        return fallback;
    }
}

export function sweepTmp(dir, minAgeMs = 60000) {
    let n = 0;
    if (holdOnly())
        return 0;
    try {
        for (const f of fs.readdirSync(dir)) {
            const m = TMP_RE.exec(f);
            if (!m || Number(m[1]) === process.pid)
                continue;
            const p = path.join(dir, f);
            try {
                if (minAgeMs <= 0 || Date.now() - fs.statSync(p).mtimeMs >= minAgeMs) {
                    fs.unlinkSync(p);
                    n++;
                }
            }
            catch { }
        }
    }
    catch { }
    return n;
}
