import { test, describe } from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile, spawn, killTree, lowerPriority, _crashWorkerOf, _workerAlive, spawnStats } from "./spawner.mjs";

const NODE = process.execPath, HERE = path.dirname(fileURLToPath(import.meta.url));
const ex = (f, a, o = {}, lib = execFile) => new Promise((r) => lib(f, a, o, (e, so, se) => r({ e, so, se })));
const closeOf = (c) => new Promise((r) => c.on("close", (code, sig) => r({ code, sig })));

const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
};

const until = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (fn())
            return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    return fn();
};

const LONG = ["-e", "setTimeout(() => {}, 60000)"];

describe("execFile — как у node:child_process", () => {
    test("код 0, stdout и stderr строками", async () => {
        const r = await ex(NODE, ["-e", "process.stdout.write('привет'); process.stderr.write('ошибка')"]);
        assert.equal(r.e, null);
        assert.equal(r.so, "привет");
        assert.equal(r.se, "ошибка");
    });
    test("ненулевой код: те же поля ошибки, что у child_process", async () => {
        const a = ["-e", "console.error('плохо'); process.exit(3)"];
        const m = await ex(NODE, a), o = await ex(NODE, a, {}, cp.execFile);
        assert.equal(m.e.code, 3);
        assert.equal(m.e.killed, false);
        assert.equal(m.e.signal, null);
        assert.equal(m.e.code, o.e.code);
        assert.equal(m.e.cmd, o.e.cmd);
        assert.equal(m.se, o.se);
        assert.equal(m.e.message, o.e.message);
    });
    test("таймаут: процесс снят, killed и сигнал — как у child_process", async () => {
        const t0 = Date.now(), r = await ex(NODE, LONG, { timeout: 400 });
        assert.ok(Date.now() - t0 < 8000);
        assert.equal(r.e.killed, true);
        assert.equal(r.e.signal, "SIGTERM");
        assert.equal(r.e.code, null);
    });
    test("большой вывод целиком (20 МБ) и обрезка по maxBuffer", async () => {
        const big = ["-e", "const s = 'x'.repeat(1 << 20); for (let i = 0; i < 20; i++) process.stdout.write(s)"];
        const r = await ex(NODE, big, { maxBuffer: 64e6 });
        assert.equal(r.e, null);
        assert.equal(r.so.length, 20 << 20);
        const s = await ex(NODE, big, { maxBuffer: 1 << 20 });
        assert.equal(s.e.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    });
    test("кодировка buffer — Buffer, cwd и env доходят", async () => {
        const r = await ex(NODE, ["-e", "process.stdout.write(process.cwd() + '|' + process.env.R4_X)"], { encoding: "buffer", cwd: HERE, env: { ...process.env, R4_X: "да" } });
        assert.ok(Buffer.isBuffer(r.so));
        assert.equal(r.so.toString("utf8"), HERE + "|да");
    });
    test("без env — окружение основного потока на момент вызова (SHARE_ENV)", async () => {
        process.env.R4_LATE = "позже";
        const r = await ex(NODE, ["-e", "process.stdout.write(process.env.R4_LATE || '')"]);
        delete process.env.R4_LATE;
        assert.equal(r.so, "позже");
    });
    test("ENOENT: нет программы, нет папки — та же ошибка, что у child_process", async () => {
        const m = await ex("нет-такой-программы-r4", []), o = await ex("нет-такой-программы-r4", [], {}, cp.execFile);
        assert.equal(m.e.code, "ENOENT");
        assert.equal(m.e.code, o.e.code);
        assert.equal(m.e.syscall, o.e.syscall);
        assert.equal(m.e.path, o.e.path);
        const d = await ex(NODE, ["-v"], { cwd: path.join(HERE, "нет-такой-папки") });
        assert.equal(d.e.code, "ENOENT");
    });
    test("stdin у execFile: c.stdin.end(данные)", async () => {
        const r = await new Promise((res) => {
            const c = execFile(NODE, ["-e", "let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => process.stdout.write(s.toUpperCase()))"], (e, so) => res({ e, so }));
            c.stdin.end("abc");
        });
        assert.equal(r.e, null);
        assert.equal(r.so, "ABC");
    });
    test("параллельно 40 запусков — каждому свой вывод", async () => {
        const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => ex(NODE, ["-e", `process.stdout.write('n${i}')`])));
        rs.forEach((r, i) => {
            assert.equal(r.e, null);
            assert.equal(r.so, "n" + i);
        });
        assert.ok(_workerAlive());
    });
});

describe("spawn — поток вывода, stdin, kill", () => {
    test("stdout/stderr потоками, события spawn → exit → close, pid", async () => {
        const c = spawn(NODE, ["-e", "process.stdout.write('a'); setTimeout(() => { process.stdout.write('b'); process.stderr.write('e'); process.exit(5) }, 50)"]);
        const seen = [];
        let out = "", err = "";
        c.on("spawn", () => seen.push("spawn"));
        c.on("exit", (code) => seen.push("exit:" + code));
        c.stdout.on("data", (d) => {
            assert.ok(Buffer.isBuffer(d));
            out += d;
        });
        c.stderr.on("data", (d) => (err += d));
        const r = await closeOf(c);
        seen.push("close");
        assert.deepEqual(seen, ["spawn", "exit:5", "close"]);
        assert.equal(r.code, 5);
        assert.equal(out, "ab");
        assert.equal(err, "e");
        assert.ok(c.pid > 0);
        assert.equal(c.exitCode, 5);
    });
    test("stdin: write и end доходят, ответ строками (setEncoding)", async () => {
        const c = spawn(NODE, ["-e", "process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase()))"]);
        c.stdout.setEncoding("utf8");
        let out = "";
        c.stdout.on("data", (d) => {
            assert.equal(typeof d, "string");
            out += d;
        });
        c.stdin.write("при");
        c.stdin.end("вет");
        await closeOf(c);
        assert.equal(out, "ПРИВЕТ");
    });
    test("весь большой вывод доходит до close (поток 20 МБ)", async () => {
        const c = spawn(NODE, ["-e", "const s = 'y'.repeat(1 << 20); for (let i = 0; i < 20; i++) process.stdout.write(s)"]);
        let n = 0;
        c.stdout.on("data", (d) => (n += d.length));
        await closeOf(c);
        assert.equal(n, 20 << 20);
    });
    test("pipe из одного двойника в другой (как git archive | tar)", async () => {
        const a = spawn(NODE, ["-e", "process.stdout.write('z'.repeat(300000))"]), b = spawn(NODE, ["-e", "let n = 0; process.stdin.on('data', (d) => n += d.length).on('end', () => process.stdout.write(String(n)))"]);
        let out = "";
        b.stdout.on("data", (d) => (out += d));
        a.stdout.pipe(b.stdin);
        await Promise.all([closeOf(a), closeOf(b)]);
        assert.equal(out, "300000");
    });
    test("kill(): close с сигналом, как у child_process", async () => {
        const m = spawn(NODE, LONG);
        await new Promise((r) => m.once("spawn", r));
        const o = cp.spawn(NODE, LONG);
        await new Promise((r) => o.once("spawn", r));
        m.kill();
        o.kill();
        const [rm, ro] = await Promise.all([closeOf(m), closeOf(o)]);
        assert.deepEqual(rm, ro);
        assert.equal(m.killed, true);
    });
    test("killTree снимает и внука (taskkill /T), даже вызванный до прихода pid", async () => {
        const c = spawn(NODE, ["-e", `const k = require('child_process').spawn(process.execPath, ${JSON.stringify(LONG)}, { stdio: 'ignore' }); console.log(k.pid); setTimeout(() => {}, 60000)`]);
        let out = "";
        c.stdout.on("data", (d) => (out += d));
        await until(() => /\d+\n/.test(out));
        const grand = Number(out.trim());
        assert.ok(alive(grand));
        killTree(c);
        await closeOf(c);
        assert.ok(await until(() => !alive(grand)), "внук остался жив");
        const d = spawn(NODE, LONG);
        assert.equal(d.pid, undefined);
        killTree(d);
        const r = await closeOf(d);
        assert.notEqual(r.code, 0);
    });
    test("пониженный приоритет ставится в воркере", async () => {
        const c = spawn(NODE, ["-e", "setTimeout(() => {}, 1500)"]);
        lowerPriority(c);
        await new Promise((r) => c.once("spawn", r));
        await new Promise((r) => setTimeout(r, 200));
        if (process.platform === "win32")
            assert.equal(await import("node:os").then((os) => os.getPriority(c.pid)), 10);
        killTree(c);
        await closeOf(c);
    });
    test("ENOENT: error и close, как у child_process", async () => {
        const seen = [], c = spawn("нет-такой-программы-r4", ["x"]);
        c.on("error", (e) => seen.push("error:" + e.code));
        const r = await closeOf(c);
        seen.push("close");
        assert.deepEqual(seen, ["error:ENOENT", "close"]);
        assert.equal(c.pid, undefined);
        assert.equal(typeof r.code, "number");
    });
    test("stdio ignore/массив: ненужных потоков нет", () => {
        const a = spawn(NODE, ["-v"], { stdio: "ignore" }), b = spawn(NODE, ["-v"], { stdio: ["ignore", "ignore", "pipe"] });
        assert.equal(a.stdin, null);
        assert.equal(a.stdout, null);
        assert.equal(b.stdin, null);
        assert.equal(b.stdout, null);
        assert.ok(b.stderr);
        return Promise.all([closeOf(a), closeOf(b)]);
    });
    test("shell: строка команды без массива аргументов", async () => {
        const c = spawn(`"${NODE}" -e "process.stdout.write('ok')"`, { shell: true });
        let out = "";
        c.stdout.on("data", (d) => (out += d));
        assert.equal((await closeOf(c)).code, 0);
        assert.equal(out, "ok");
    });
});

describe("воркер", () => {
    test("падение воркера: задания получают ошибку ESPAWNER, следующий запуск — на новом воркере", async () => {
        const c = spawn(NODE, LONG);
        await new Promise((r) => c.once("spawn", r));
        const pid = c.pid;
        const errP = new Promise((r) => c.once("error", r)), clP = closeOf(c), before = spawnStats.restarts;
        _crashWorkerOf(c);
        const e = await errP;
        assert.equal(e.code, "ESPAWNER");
        await clP;
        assert.equal(spawnStats.restarts, before + 1);
        const r = await ex(NODE, ["-e", "process.stdout.write('снова')"]);
        assert.equal(r.so, "снова");
        cp.execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    });
    test("процесс с ожидающим execFile не выходит раньше ответа; unref() не держит процесс", async () => {
        const url = pathToFileURL(path.join(HERE, "spawner.mjs")).href;
        const src = `import { execFile, spawn } from ${JSON.stringify(url)}; const d = spawn(process.execPath, ${JSON.stringify(LONG)}, { detached: true, stdio: "ignore" }); d.unref(); d.on("spawn", () => console.log("pid " + d.pid)); execFile(process.execPath, ["-e", "setTimeout(() => process.stdout.write('ждал'), 300)"], (e, so) => console.log(so))`;
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const t0 = Date.now(), r = await ex(NODE, ["--input-type=module", "-e", src], { env }, cp.execFile), pid = Number((/pid (\d+)/.exec(r.so) || [])[1]);
        if (pid)
            try {
                process.kill(pid);
            }
            catch { }
        assert.equal(r.e, null);
        assert.match(r.so, /ждал/);
        assert.ok(Date.now() - t0 < 40000, "отцепленный процесс держал выход");
    });
});

describe("ворота на ssh (ssh-gate.mjs)", async () => {
    const { isSshCommand, _setSshGate } = await import("./spawner.mjs");
    const { createSshGate } = await import("./ssh-gate.mjs");
    const fs = await import("node:fs"), os = await import("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-sshgate-")), FAKE = path.join(dir, process.platform === "win32" ? "ssh.exe" : "ssh");
    fs.copyFileSync(process.execPath, FAKE);
    if (process.platform !== "win32")
        fs.chmodSync(FAKE, 0o755);
    test("имя ssh распознаётся с путём Windows и без него; sshd и чужие — нет", () => {
        for (const f of ["ssh", "ssh.exe", String.raw `C:\Windows\System32\OpenSSH\ssh.exe`, "/usr/bin/ssh", "C:/x/ssh"])
            assert.equal(isSshCommand(f), true, f);
        for (const f of ["node", "sshd", "myssh.exe", "sshexe", "git"])
            assert.equal(isSshCommand(f), false, f);
    });
    test("не больше max ssh одновременно: остальные ждут, результат у всех обычный", async () => {
        const g = createSshGate({ max: 1, minGapMs: 0 });
        _setSshGate(g);
        const t0 = Date.now(), run = (n) => ex(FAKE, ["-e", `setTimeout(() => { console.log(${n}) }, 300)`]);
        const rs = await Promise.all([run(1), run(2), run(3)]);
        assert.deepEqual(rs.map((r) => String(r.so).trim()), ["1", "2", "3"]);
        assert.ok(rs.every((r) => r.e === null));
        assert.ok(Date.now() - t0 >= 650, "три по 300 мс идут по очереди, а не разом");
        assert.equal(g.snapshot().started, 3);
        assert.ok(g.snapshot().maxQueue >= 2);
    });
    test("stdin, записанный в очереди, не теряется: уходит процессу сразу после запуска", async () => {
        _setSshGate(createSshGate({ max: 1, minGapMs: 0 }));
        const busy = spawn(FAKE, LONG, { stdio: "ignore" });
        const c = spawn(FAKE, ["-e", "process.stdin.on('data', (d) => process.stdout.write('эхо:' + d))"], { stdio: ["pipe", "pipe", "ignore"] });
        let out = "";
        c.stdout.on("data", (d) => {
            out += d;
        });
        c.stdin.write("привет\n");
        c.stdin.end();
        killTree(busy);
        await closeOf(c);
        assert.match(out, /эхо:привет/);
    });
    test("отмена до запуска: процесса нет, обратный вызов получает ECANCELED, очередь идёт дальше", async () => {
        _setSshGate(createSshGate({ max: 1, minGapMs: 0 }));
        const busy = spawn(FAKE, LONG, { stdio: "ignore" });
        const r = await new Promise((res) => {
            const c = execFile(FAKE, ["-e", "1"], {}, (e) => res(e));
            c.kill();
        });
        assert.equal(r && r.code, "ECANCELED");
        killTree(busy);
        const after = await ex(FAKE, ["-e", "console.log('жив')"]);
        assert.match(String(after.so), /жив/, "очередь не встала после отмены");
    });
});
