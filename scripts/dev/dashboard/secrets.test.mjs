// Хранение секретов (secrets.mjs): порядок «окружение → файл владельца → DPAPI», права файла, запись без теней.
//   node --test scripts/dev/dashboard/secrets.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dpapi, envName, fileRefusal, getSecret, hasSecret, secretSource, secretStamp, setSecret } from "./secrets.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dk-secrets-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const box = (extra = {}) => ({ dir: path.join(TMP, "s" + ++n), env: {}, warn: () => { }, ...extra });
const POSIX = process.platform !== "win32";
// Подменное «шифрование» для проверки ветки DPAPI вне Windows: переворот байтов с меткой entropy.
const fakeDpapi = (calls) => async (op, buf, { entropy }) => {
    calls.push({ op, entropy });
    if (op === "protect")
        return Buffer.concat([Buffer.from(entropy + ":"), Buffer.from(buf).reverse()]);
    const s = buf.toString("latin1"), i = s.indexOf(":");
    if (s.slice(0, i) !== entropy)
        throw new Error("хранилище Windows: чужой ключ");
    return Buffer.from(buf.subarray(i + 1)).reverse();
};

test("имя переменной окружения и проверка имени секрета", () => {
    assert.equal(envName("tg-token"), "DISPATCHER_SECRET_TG_TOKEN");
    for (const bad of ["", "Tg", "../x", "a b", "1x", "x".repeat(41)])
        assert.throws(() => envName(bad), /имя секрета/, JSON.stringify(bad));
});

test("нет нигде — null и hasSecret false", async () => {
    const o = box();
    assert.equal(await getSecret("tg-token", o), null);
    assert.equal(hasSecret("tg-token", o), false);
    assert.equal(secretSource("tg-token", o), "");
    assert.equal(secretStamp("tg-token", o), "none");
});

test("переменная окружения сильнее файла", async () => {
    const o = box();
    await setSecret("tg-token", "из-файла", { ...o, store: "file" });
    assert.equal(await getSecret("tg-token", o), "из-файла");
    const e = { ...o, env: { DISPATCHER_SECRET_TG_TOKEN: "из-окружения" } };
    assert.equal(secretSource("tg-token", e), "env");
    assert.equal(await getSecret("tg-token", e), "из-окружения");
    const w = await setSecret("tg-token", "новый", { ...e, store: "file" });
    assert.equal(w.shadowedByEnv, true, "запись предупреждает, что окружение её перекроет");
});

test("файл: туда и обратно, перевод строки в конце не входит в значение; отпечаток меняется при перезаписи", async () => {
    const o = box();
    const w = await setSecret("api-key", "123:abc", { ...o, store: "file" });
    assert.equal(w.where, "file");
    assert.equal(await getSecret("api-key", o), "123:abc");
    fs.writeFileSync(w.file, "123:abc\n", { mode: 0o600 });
    assert.equal(await getSecret("api-key", o), "123:abc");
    const s1 = secretStamp("api-key", o);
    assert.ok(!s1.includes("123:abc"), "отпечаток без значения");
    await new Promise((r) => setTimeout(r, 20));
    await setSecret("api-key", "456:def", { ...o, store: "file" });
    assert.notEqual(secretStamp("api-key", o), s1);
    await assert.rejects(setSecret("api-key", "", { ...o, store: "file" }), /пустой/);
});

test("POSIX: файл пишется 0600, файл с широкими правами не читается", { skip: !POSIX && "права файла проверяются только на POSIX" }, async () => {
    const o = box();
    const w = await setSecret("tg-token", "секрет", { ...o, store: "file" });
    assert.equal(fs.statSync(w.file).mode & 0o777, 0o600);
    fs.chmodSync(w.file, 0o644);
    await assert.rejects(getSecret("tg-token", o), /слишком широкие права.*chmod 600/);
    fs.chmodSync(w.file, 0o600);
    assert.equal(await getSecret("tg-token", o), "секрет");
});

test("правило прав без файловой системы: широкие права и чужой владелец — отказ; Windows — без проверки", () => {
    assert.match(fileRefusal("f", { platform: "linux", stat: { mode: 0o100640, uid: 1 }, uid: 1 }), /слишком широкие права \(640\)/);
    assert.match(fileRefusal("f", { platform: "linux", stat: { mode: 0o100600, uid: 2 }, uid: 1 }), /другому пользователю/);
    assert.equal(fileRefusal("f", { platform: "linux", stat: { mode: 0o100600, uid: 1 }, uid: 1 }), "");
    assert.equal(fileRefusal("f", { platform: "win32", stat: { mode: 0o100666, uid: 0 }, uid: 1 }), "");
});

test("Windows и открытый файл: читается, но с предупреждением один раз", async () => {
    const warns = [], calls = [];
    const o = box({ platform: "win32", dpapi: fakeDpapi(calls), warn: (s) => warns.push(s) });
    await setSecret("tg-token", "открыто", { ...o, store: "file" });
    assert.equal(await getSecret("tg-token", o), "открыто");
    assert.equal(await getSecret("tg-token", o), "открыто");
    assert.equal(warns.length, 1);
    assert.match(warns[0], /права файла не проверяются/);
    assert.ok(!warns[0].includes("открыто"), "в предупреждении нет значения");
});

test("ветка DPAPI: на Windows запись идёт в хранилище, открытый файл убирается; вне Windows DPAPI не берётся", async () => {
    const calls = [];
    const o = box({ platform: "win32", dpapi: fakeDpapi(calls) });
    await setSecret("tg-token", "старое", { ...o, store: "file" });
    const w = await setSecret("tg-token", "123:tok", o);
    assert.equal(w.where, "dpapi", "на Windows умолчание — хранилище");
    assert.ok(w.file.endsWith("tg-token.dpapi"));
    assert.equal(fs.existsSync(path.join(o.dir, "tg-token")), false, "открытый файл не затеняет новую запись");
    assert.ok(!fs.readFileSync(w.file, "latin1").includes("123:tok"), "на диске не открытым текстом");
    assert.equal(secretSource("tg-token", o), "dpapi");
    assert.equal(await getSecret("tg-token", o), "123:tok");
    assert.deepEqual(calls.map((c) => c.op), ["protect", "unprotect"]);
    assert.equal(calls[0].entropy, "dispatcher-secret-tg-token", "своя entropy у каждого секрета");
    const lin = { ...o, platform: "linux" };
    assert.equal(secretSource("tg-token", lin), "", "вне Windows файл .dpapi не читается");
    await assert.rejects(setSecret("tg-token", "x", { ...lin, store: "dpapi" }), /только на Windows/);
    await setSecret("tg-token", "файлом", { ...o, store: "file" });
    assert.equal(fs.existsSync(w.file), false, "запись файлом убирает прежнюю запись хранилища");
});

test("DPAPI вживую: туда и обратно, чужая entropy не открывает, entropy не подставляется в команду как попало", { skip: process.platform !== "win32" && "только Windows" }, async () => {
    const enc = await dpapi("protect", Buffer.from("1:x", "utf8"), { entropy: "dispatcher-secret-probe" });
    assert.ok(!enc.toString("latin1").includes("1:x"));
    assert.equal((await dpapi("unprotect", enc, { entropy: "dispatcher-secret-probe" })).toString("utf8"), "1:x");
    await assert.rejects(dpapi("unprotect", enc, { entropy: "dispatcher-secret-other" }), /хранилище Windows/);
    await assert.rejects(dpapi("protect", Buffer.from("x"), { entropy: "a'; calc" }), /entropy/);
});
