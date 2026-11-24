// secrets.mjs — хранение секретов диспетчерской (токен бота и т.п.).
//
// Где ищется секрет `<имя>`, по порядку:
//   1. переменная окружения DISPATCHER_SECRET_<ИМЯ> (дефис → подчёркивание);
//   2. файл <данные>/secrets/<имя> — только с правами владельца: на POSIX файл с доступом группе или всем (не 0600)
//      или чужой файл не читается вовсе; на Windows права (ACL) не проверяются — только предупреждение;
//   3. на Windows — файл <данные>/secrets/<имя>.dpapi, зашифрованный DPAPI (ключ — учётная запись пользователя).
// Запись: на Windows — в DPAPI, иначе — в файл 0600; прежняя запись в другом месте удаляется, чтобы не затеняла новую.
// Значение секрета не печатается и не уходит в командную строку: в PowerShell оно идёт через stdin.
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA } from "./config.mjs";

export const SECRET_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const ENV_PREFIX = "DISPATCHER_SECRET_";
const checkName = (name) => {
    if (!SECRET_NAME_RE.test(String(name || "")))
        throw new Error("имя секрета — строчная латиница, цифры и дефис, с буквы: " + JSON.stringify(name));
    return name;
};
/** Имя переменной окружения секрета: tg-token → DISPATCHER_SECRET_TG_TOKEN. */
export const envName = (name) => ENV_PREFIX + checkName(name).toUpperCase().replace(/-/g, "_");
export const secretsDir = (data = DATA) => path.join(data, "secrets");

// Опции у каждой функции — для тестов и утилит: env, dir (папка секретов), platform, dpapi (подмена шифрования),
// execFile (запуск PowerShell), warn (куда писать предупреждения).
const optsOf = (o = {}) => ({ env: o.env || process.env, dir: o.dir || secretsDir(), platform: o.platform || process.platform, dpapi: o.dpapi || dpapi, execFile: o.execFile, warn: o.warn || ((s) => console.warn(s)) });
const plainFile = (o, name) => path.join(o.dir, name);
const vaultFile = (o, name) => path.join(o.dir, name + ".dpapi");
const exists = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

// ───── DPAPI (только Windows) ─────
const ENTROPY_RE = /^[a-z0-9-]+$/;
/**
 * Шифрование хранилищем Windows. op — "protect" | "unprotect", buf — Buffer → Promise<Buffer>. entropy — своя у каждого
 * секрета: файл одного не откроется ключом другого. Данные идут через stdin, не через командную строку.
 */
export function dpapi(op, buf, { entropy, execFile = cp.execFile } = {}) {
    if (!ENTROPY_RE.test(String(entropy || "")))
        return Promise.reject(new Error("хранилище Windows: нужна entropy из [a-z0-9-]"));
    const ps = "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
        "$e=[Text.Encoding]::UTF8.GetBytes('" + entropy + "'); $s=[Security.Cryptography.DataProtectionScope]::CurrentUser; " +
        "[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::" + (op === "protect" ? "Protect" : "Unprotect") + "($b,$e,$s)))";
    return new Promise((res, rej) => {
        const c = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 60000, maxBuffer: 64e6 }, (err, out, er) => err ? rej(new Error("хранилище Windows: " + String(er || err.message).trim().split("\n")[0])) : res(Buffer.from(String(out).trim(), "base64")));
        c.stdin.end(buf.toString("base64"));
    });
}
const entropyOf = (name) => "dispatcher-secret-" + name;

// ───── права файла ─────
const warned = new Set();
/** Файл секрета годится для чтения? → "" или причина отказа. На Windows ACL не проверяется (только предупреждение). */
export function fileRefusal(file, { platform = process.platform, stat = fs.statSync(file), uid = typeof process.getuid === "function" ? process.getuid() : null } = {}) {
    if (platform === "win32")
        return "";
    if ((stat.mode & 0o077) !== 0)
        return "у файла секрета " + file + " слишком широкие права (" + (stat.mode & 0o777).toString(8) + "): нужен доступ только владельцу — chmod 600 " + JSON.stringify(file);
    if (uid != null && stat.uid !== uid)
        return "файл секрета " + file + " принадлежит другому пользователю — не читаю";
    return "";
}

/** Откуда сейчас берётся секрет: "env" | "file" | "dpapi" | "" (нет). Без чтения значения. */
export function secretSource(name, opts) {
    const o = optsOf(opts);
    checkName(name);
    if (o.env[envName(name)])
        return "env";
    if (exists(plainFile(o, name)))
        return "file";
    if (o.platform === "win32" && exists(vaultFile(o, name)))
        return "dpapi";
    return "";
}

/** Есть ли секрет (без чтения и расшифровки). */
export const hasSecret = (name, opts) => secretSource(name, opts) !== "";

/** Отпечаток места хранения — меняется, когда секрет переписан (для перечитывания без перезапуска). Значения не содержит. */
export function secretStamp(name, opts) {
    const o = optsOf(opts), src = secretSource(name, opts);
    const mt = (f) => { try { return String(fs.statSync(f).mtimeMs); } catch { return "-"; } };
    if (src === "env")
        return "env:" + String(o.env[envName(name)]).length;
    if (src === "file")
        return "file:" + mt(plainFile(o, name));
    if (src === "dpapi")
        return "dpapi:" + mt(vaultFile(o, name));
    return "none";
}

/**
 * Значение секрета или null, если его нигде нет. Файл с широкими правами (POSIX) — исключение с причиной: молча
 * пропускать его нельзя, иначе человек не поймёт, почему секрет «пропал».
 */
export async function getSecret(name, opts) {
    const o = optsOf(opts), src = secretSource(name, opts);
    if (src === "env")
        return String(o.env[envName(name)]);
    if (src === "file") {
        const f = plainFile(o, name), why = fileRefusal(f, { platform: o.platform });
        if (why)
            throw new Error(why);
        if (o.platform === "win32" && !warned.has(f)) {
            warned.add(f);
            o.warn("секрет «" + name + "» лежит открытым файлом " + f + ": на Windows права файла не проверяются — надёжнее хранилище Windows (node scripts/dev/tg-setup.mjs кладёт туда)");
        }
        return fs.readFileSync(f, "utf8").replace(/\r?\n$/, "");
    }
    if (src === "dpapi") {
        const buf = await o.dpapi("unprotect", fs.readFileSync(vaultFile(o, name)), { entropy: entropyOf(name), ...(o.execFile ? { execFile: o.execFile } : {}) });
        return buf.toString("utf8");
    }
    return null;
}

/**
 * Записать секрет. store — "dpapi" (умолчание на Windows) или "file" (умолчание на остальных; файл 0600).
 * → { where: "file" | "dpapi", file, shadowedByEnv } — shadowedByEnv: переменная окружения всё равно перекроет запись.
 */
export async function setSecret(name, value, opts = {}) {
    const o = optsOf(opts);
    checkName(name);
    const v = String(value == null ? "" : value);
    if (!v)
        throw new Error("пустой секрет не записываю");
    const store = opts.store || (o.platform === "win32" ? "dpapi" : "file");
    if (store === "dpapi" && o.platform !== "win32")
        throw new Error("хранилище DPAPI есть только на Windows");
    if (!["file", "dpapi"].includes(store))
        throw new Error("куда класть секрет: file или dpapi");
    fs.mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    const file = store === "dpapi" ? vaultFile(o, name) : plainFile(o, name), other = store === "dpapi" ? plainFile(o, name) : vaultFile(o, name);
    const data = store === "dpapi" ? await o.dpapi("protect", Buffer.from(v, "utf8"), { entropy: entropyOf(name), ...(o.execFile ? { execFile: o.execFile } : {}) }) : v;
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    if (o.platform !== "win32")
        fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    try { fs.unlinkSync(other); } catch { /* другой записи не было */ }
    return { where: store, file, shadowedByEnv: !!o.env[envName(name)] };
}
