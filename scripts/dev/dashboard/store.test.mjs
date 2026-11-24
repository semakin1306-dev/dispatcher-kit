import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { corruptList, readJson, rewriteJsonl, saveJson, setCorruptHook, settled, sweepTmp, writeAtomic, writeAtomicSync, writeJsonSync } from "./store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let dir;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-store-"));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

const leftovers = () => fs.readdirSync(dir).filter((f) => /\.tmp-/.test(f));

describe("атомарная запись", () => {
    test("writeJsonSync: файл целиком, временных не остаётся, старое заменяется", () => {
        const f = path.join(dir, "a.json");
        fs.writeFileSync(f, '{"old":true}');
        writeJsonSync(f, { a: 1, b: [1, 2] }, 1);
        assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { a: 1, b: [1, 2] });
        assert.equal(fs.readFileSync(f, "utf8"), JSON.stringify({ a: 1, b: [1, 2] }, null, 1));
        assert.deepEqual(leftovers(), []);
    });
    test("writeAtomic: Buffer как есть", async () => {
        const f = path.join(dir, "v.bin"), buf = Buffer.from([0, 1, 2, 250, 255]);
        await writeAtomic(f, buf);
        assert.deepEqual(fs.readFileSync(f), buf);
        assert.deepEqual(leftovers(), []);
    });
    test("saveJson: записи одного файла слипаются, на диске — последняя", async () => {
        const f = path.join(dir, "inbox.json");
        for (let i = 0; i < 50; i++)
            saveJson(f, { n: i });
        await settled();
        assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { n: 49 });
        assert.deepEqual(leftovers(), []);
    });
    test("saveJson снимает значение в момент вызова", async () => {
        const f = path.join(dir, "s.json"), v = { x: 1 };
        const p = saveJson(f, v);
        v.x = 2;
        await p;
        assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { x: 1 });
    });
    test("синхронная запись во время фоновой: на диске остаётся более новая", async () => {
        const f = path.join(dir, "stages.json");
        saveJson(f, { v: "фон" });
        writeJsonSync(f, { v: "сразу" });
        await settled();
        assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { v: "сразу" });
    });
    test("rename занят (EPERM) — повтор, запись проходит", () => {
        const f = path.join(dir, "r.json"), orig = fs.renameSync;
        let n = 0;
        fs.renameSync = (a, b) => {
            if (++n < 3) {
                const e = new Error("EPERM: operation not permitted");
                e.code = "EPERM";
                throw e;
            }
            return orig(a, b);
        };
        try {
            writeJsonSync(f, { ok: 1 });
        }
        finally {
            fs.renameSync = orig;
        }
        assert.equal(n, 3);
        assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { ok: 1 });
    });
    test("сбой записи временного файла: прежний файл цел, временный убран", () => {
        const f = path.join(dir, "acc.json"), before = '{"keep":"me"}', orig = fs.fsyncSync;
        fs.writeFileSync(f, before);
        fs.fsyncSync = () => {
            const e = new Error("ENOSPC: no space left on device");
            e.code = "ENOSPC";
            throw e;
        };
        try {
            assert.throws(() => writeJsonSync(f, { lost: true }), /ENOSPC/);
        }
        finally {
            fs.fsyncSync = orig;
        }
        assert.equal(fs.readFileSync(f, "utf8"), before);
        assert.deepEqual(leftovers(), []);
    });
});

describe("битый файл при чтении", () => {
    test("нет файла — значение по умолчанию, без записи в список", () => {
        const n = corruptList().length;
        assert.deepEqual(readJson(path.join(dir, "nope.json"), { d: 1 }), { d: 1 });
        assert.equal(corruptList().length, n);
    });
    test("битый JSON → <имя>.corrupt-<время> с исходными байтами, событие, пустое состояние", () => {
        const f = path.join(dir, "acceptance.json"), bytes = Buffer.from('{"wave":"П7","items":[1,2', "utf8"), seen = [];
        fs.writeFileSync(f, bytes);
        setCorruptHook((r) => seen.push(r));
        const v = readJson(f, {});
        setCorruptHook(null);
        assert.deepEqual(v, {});
        assert.equal(fs.existsSync(f), false, "битый файл убран с места: следующая запись не смешается с ним");
        const moved = fs.readdirSync(dir).filter((x) => x.startsWith("acceptance.json.corrupt-"));
        assert.equal(moved.length, 1);
        assert.deepEqual(fs.readFileSync(path.join(dir, moved[0])), bytes);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].file, "acceptance.json");
        assert.equal(seen[0].movedTo, moved[0]);
        const rec = corruptList().find((x) => x.movedTo === moved[0]);
        assert.ok(rec && rec.bytes === bytes.length && rec.error);
    });
    test("пустой файл (обрыв прежней записи) — тоже битый, не {} молча", () => {
        const f = path.join(dir, "inbox.json");
        fs.writeFileSync(f, "");
        assert.deepEqual(readJson(f, []), []);
        assert.equal(fs.readdirSync(dir).filter((x) => x.startsWith("inbox.json.corrupt-")).length, 1);
    });
    test("JSON с BOM читается, не считается битым", () => {
        const f = path.join(dir, "settings.json");
        fs.writeFileSync(f, "\uFEFF" + JSON.stringify({ a: 1 }));
        assert.deepEqual(readJson(f, {}), { a: 1 });
        assert.equal(fs.existsSync(f), true);
    });
    test("пробный экземпляр на живых данных: битый файл не трогается и не перезаписывается", () => {
        const f = path.join(dir, "agents.json"), env = { dry: process.env.DASH_DRY, data: process.env.DASH_DATA };
        fs.writeFileSync(f, "{oops");
        process.env.DASH_DRY = "1";
        delete process.env.DASH_DATA;
        try {
            assert.deepEqual(readJson(f, {}), {});
            writeJsonSync(f, { overwritten: true });
        }
        finally {
            if (env.dry === undefined)
                delete process.env.DASH_DRY;
            else
                process.env.DASH_DRY = env.dry;
            if (env.data !== undefined)
                process.env.DASH_DATA = env.data;
        }
        assert.equal(fs.readFileSync(f, "utf8"), "{oops");
        assert.ok(corruptList().some((x) => x.file === "agents.json" && x.held));
    });
});

describe("уплотнение runs.jsonl", () => {
    const journal = (n) => Array.from({ length: n }, (_, i) => JSON.stringify({ id: "j" + (i % 10), status: i < n - 10 ? "running" : "ok", i })).join("\n") + "\n";
    test("rewriteJsonl: строка на запись, порядок сохранён", () => {
        const f = path.join(dir, "runs.jsonl");
        fs.writeFileSync(f, journal(300));
        rewriteJsonl(f, [{ id: "j1" }, { id: "j2" }]);
        assert.equal(fs.readFileSync(f, "utf8"), '{"id":"j1"}\n{"id":"j2"}\n');
    });
    test("процесс умер посреди уплотнения — прежний журнал цел байт в байт, брошенный временный убирается при старте", () => {
        const f = path.join(dir, "runs.jsonl"), before = journal(500);
        fs.writeFileSync(f, before);
        const code = `import fs from "node:fs"; import { rewriteJsonl } from ${JSON.stringify("file:///" + path.join(HERE, "store.mjs").replace(/\\/g, "/"))};
      fs.fsyncSync = () => process.exit(9); rewriteJsonl(${JSON.stringify(f)}, [{ id: "j1", status: "ok" }])`;
        const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
        assert.equal(r.status, 9, r.stderr);
        assert.equal(fs.readFileSync(f, "utf8"), before);
        assert.equal(leftovers().length, 1, "временный файл остался от умершего процесса");
        assert.equal(sweepTmp(dir, 0), 1);
        assert.deepEqual(leftovers(), []);
        assert.equal(fs.readFileSync(f, "utf8"), before);
    });
    test("уборка не трогает временные файлы своего процесса и свежие чужие", () => {
        fs.writeFileSync(path.join(dir, "x.json.tmp-" + process.pid + "-1"), "");
        fs.writeFileSync(path.join(dir, "x.json.tmp-1-1"), "");
        assert.equal(sweepTmp(dir), 0);
        assert.equal(sweepTmp(dir, 0), 1);
        assert.deepEqual(leftovers(), ["x.json.tmp-" + process.pid + "-1"]);
    });
});

test("вне store.mjs нет прямой записи JSON файлов состояния", () => {
    // исключения: сухая проверка журналов пишет свой отчёт; файл секрета пишется с правами 0600 (store.mjs прав не ставит)
    const allowed = [/^loops\.check\.mjs:/, /^secrets\.mjs:.*mode: 0o600/];
    const bad = [];
    for (const f of fs.readdirSync(HERE).filter((x) => x.endsWith(".mjs") && x !== "store.mjs" && !x.endsWith(".test.mjs"))) {
        fs.readFileSync(path.join(HERE, f), "utf8").split("\n").forEach((l, i) => {
            if (/\bfs\.(promises\.)?writeFile(Sync)?\(/.test(l)) {
                const at = f + ":" + (i + 1) + ": " + l.trim().slice(0, 120);
                if (!allowed.some((re) => re.test(at)))
                    bad.push(at);
            }
        });
    }
    assert.deepEqual(bad, []);
});
