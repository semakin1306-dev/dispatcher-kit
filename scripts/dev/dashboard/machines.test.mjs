// Модуль машин без настоящего ssh: скрипты для машины, места по нагрузке, и сквозной прогон, где «удалённая» машина —
// локальная папка, а поддельный ssh просто выполняет команду в ней (git push тоже идёт через него).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createMachinesApi, groupWrap, initMachines, killScript, parseProbe, pidFileOf, pruneScript, rdir, repoScript, runBody, sshOpts } from "./machines.mjs";
import { setShardApi, shardApi } from "./shard.mjs";
import { SPILL_MS } from "./slot-places.mjs";
import { FAKE_BASH, fakeSsh } from "./fixtures/fake-ssh.mjs";

const fwd = (p) => p.split("\\").join("/");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dk-machines-"));
after(() => {
    setShardApi(null);
    try {
        fs.rmSync(TMP, { recursive: true, force: true });
    }
    catch { }
});

const LOCAL = { id: "local", label: "Эта машина", ssh: "", dir: "", workers: 1, lanes: null, prepare: [], services: [] };
const box = (o = {}) => ({ id: "box", label: "Коробка", ssh: "box", dir: "~/work/repo", workers: 2, lanes: null, prepare: [], services: [], ...o });
const NOW0 = 1_000_000_000;
const ld = (at, o = {}) => ({ at, cpu: 10, cores: [10, 10, 10, 10], memTotalGB: 16, memUsedGB: 4, loadAvg: [0.2, 0.2, 0.2], ...o });
const localLoad = (at) => () => ld(at(), { memUsedGB: 2 });

// ───────────── чистые скрипты ─────────────

test("ssh: только BatchMode и таймаут подключения, хост — алиас", () => {
    assert.deepEqual(sshOpts(7).slice(0, 4), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=7"]);
    assert.throws(() => createMachinesApi({ machines: { local: LOCAL, x: box({ ssh: "-oProxyCommand=evil" }) } }), /алиас/);
    assert.equal(rdir("~/a b"), `"$HOME"/'a b'`);
    assert.equal(rdir("/srv/r"), "'/srv/r'");
});

test("тело прогона: папка прогона на sha → подготовка → службы (проверка, запуск, ожидание) → команда", () => {
    const m = box({ prepare: ["npm ci"], services: [{ name: "db", up: "docker compose up -d db", check: "pg_isready", down: "" }, { name: "cache", up: "redis-server --daemonize yes", check: "", down: "" }] });
    const s = runBody({ m, mk: "box", sha: "a".repeat(40), key: "slot-1", idx: 1, jobId: "j7", cmd: "cd 'apps/api' && 'npx' 'jest' 'it'\\''s'" });
    const at = (x) => {
        const i = s.indexOf(x);
        assert.ok(i >= 0, "нет: " + x);
        return i;
    };
    assert.ok(at("worktree add -q --detach") < at("== подготовка"));
    assert.ok(at("== подготовка") < at("bash -ec 'npm ci'") && at("bash -ec 'npm ci'") < at("== служба db"));
    assert.ok(at("bash -ec 'pg_isready'") < at("bash -ec 'docker compose up -d db'"), "сначала проверка: работающую службу не перезапускаем");
    assert.ok(at("== служба cache") < at("== прогон") && at("== прогон") < at("exec bash -c"));
    assert.match(s, /D="\$R-wt\/slot-1-p1"/);
    assert.match(s, /DISPATCHER_PLACE=1/);
    assert.match(s, /update-ref -d refs\/dispatcher\/slot-1-p1/);
});

test("обёртка: отдельная группа процессов и файл номера; снятие — TERM, потом KILL", () => {
    const pid = pidFileOf("demo shop", "j1");
    assert.equal(pid, "/tmp/dispatcher-demo_shop-j1.pid");
    const w = groupWrap("echo hi", pid, "x1");
    assert.match(w, /<<'DISPATCHER_EOF_x1'\necho hi\nDISPATCHER_EOF_x1\n/);
    assert.match(w, /setsid bash "\$f" <\/dev\/null &/);
    assert.match(w, /echo "\$p" > '\/tmp\/dispatcher-demo_shop-j1.pid'/);
    const k = killScript(pid);
    assert.ok(k.indexOf("kill -TERM") < k.indexOf("kill -KILL"));
    assert.match(repoScript(box()), /git init -q \./);
    assert.match(pruneScript(box(), ["s1", "s 2"]), /live=' s1 s_2 '/);
});

test("проба здоровья: память, подкачка, нагрузка, ЦП по двум замерам; без памяти — null", () => {
    const text = ["MemTotal:       16384000 kB", "MemAvailable:    8192000 kB", "SwapTotal:       2048000 kB", "SwapFree:        1024000 kB",
        "LOAD 0.50 0.40 0.30", "CORES 4", "CPU cpu 100 0 100 800 0 0 0 0", "CPU cpu 150 0 150 900 0 0 0 0"].join("\n");
    const l = parseProbe(text, 123);
    assert.equal(l.at, 123);
    assert.equal(l.cpu, 50);
    assert.equal(l.cores.length, 4);
    assert.ok(Math.abs(l.memUsedGB - 8192000 / 2 ** 20) < 1e-9);
    assert.ok(Math.abs(l.swapUsedGB - 1024000 / 2 ** 20) < 1e-9);
    assert.deepEqual(l.loadAvg, [0.5, 0.4, 0.3]);
    assert.equal(parseProbe("LOAD 1 1 1\n", 1), null);
});

// ───────────── места ─────────────

test("места: удалённая машина первой; без свежей пробы места нет; эта машина — после ожидания", () => {
    let t = NOW0;
    const now = () => t;
    const api = createMachinesApi({ machines: { local: LOCAL, box: box() }, now, localLoad: localLoad(now), emit: () => { } });
    assert.equal(api.slotAnyOnline(), false, "проб ещё не было");
    assert.equal(api.slotFree("main", { ageMs: 0 }), false, "удалённая молчит, эта ждёт SPILL_MS");
    api._noteLoad("box", ld(t));
    assert.equal(api.slotAnyOnline(), true);
    assert.equal(api.slotReserve("j1", "main", { ageMs: 0 }), 0);
    assert.equal(api.slotMachineOf("j1"), "box");
    assert.equal(api.machineLabel("box"), "Коробка");
    assert.equal(api.slotReserve("j2", "main", { ageMs: 0 }), -1, "второе место — после разгона первого");
    t += 60000;
    api._noteLoad("box", ld(t));
    assert.equal(api.slotReserve("j2", "main", { ageMs: 0 }), 1);
    assert.equal(api.slotReserve("j3", "main", { ageMs: SPILL_MS + 1 }), 0, "удалённая заполнена — эта машина после ожидания");
    assert.equal(api.slotMachineOf("j3"), "local");
    api.slotRelease("j1");
    assert.equal(api.slotMachineOf("j1"), null);
    t += FRESH_PLUS;
    assert.equal(api.slotAnyOnline(), false, "проба устарела — машина места не даёт");
    assert.equal(api.pub().machines.find((x) => x.id === "box").online, false);
});
const FRESH_PLUS = 25000;

test("дорожки машины: чужую дорожку удалённая не берёт", () => {
    const t = NOW0, now = () => t;
    const api = createMachinesApi({ machines: { local: LOCAL, box: box({ lanes: ["db"] }) }, now, localLoad: localLoad(now), emit: () => { } });
    api._noteLoad("box", ld(t));
    assert.equal(api.slotFree("db", { ageMs: 0 }), true);
    assert.equal(api.slotFree("main", { ageMs: 0 }), false);
});

// ───────────── сквозной прогон с поддельным ssh ─────────────

const BASH = FAKE_BASH;
const FAKE = fakeSsh(TMP), HOME = FAKE.home, SSHLOG = FAKE.log, sshCalls = FAKE.calls;

const g = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
function slotRepo() {
    const d = path.join(TMP, "slot-" + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(d);
    g(d, "init", "-q", "-b", "dev/x");
    g(d, "config", "user.email", "t@example.invalid");
    g(d, "config", "user.name", "t");
    fs.writeFileSync(path.join(d, "a.txt"), "committed\n");
    g(d, "add", "a.txt");
    g(d, "commit", "-qm", "one");
    return d;
}
const fakeApi = (m, o = {}) => createMachinesApi({ machines: { local: LOCAL, box: m }, project: "demo", ssh: FAKE.ssh, emit: () => { }, ...o });

test("сквозной прогон: доставка по sha (с несохранённой правкой), подготовка, службы, команда; код возврата — итог; службы остановлены", { skip: !BASH && "нет bash" }, async () => {
    const slot = slotRepo(), head = g(slot, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(slot, "a.txt"), "dirty\n");
    fs.writeFileSync(path.join(slot, "new.txt"), "fresh\n");
    fs.rmSync(SSHLOG, { force: true });
    const remote = fwd(path.join(TMP, "remote", "repo"));
    const m = box({ dir: remote, prepare: ["echo prep-ok > prep.txt"], services: [{ name: "db", up: 'touch "$HOME/db.up"', check: 'test -e "$HOME/db.up"', down: 'rm -f "$HOME/db.up"' }] });
    const api = fakeApi(m);
    let out = "", child = null;
    const code = await api.slotRun({ jobId: "j42", key: "slot-1", cwd: slot, cmd: 'cat a.txt new.txt prep.txt; test -e "$HOME/db.up" && echo db-up; echo "place=$DISPATCHER_PLACE slot=$DISPATCHER_SLOT"; exit 3' }, (s) => { out += s; }, (c) => { child = c; }, "box");
    assert.equal(code, 3, out);
    assert.ok(child, "onChild получил процесс ssh");
    const order = ["== код", "снимок ", "== подготовка", "== служба db", "запущена", "== прогон", "dirty", "fresh", "prep-ok", "db-up", "place=0 slot=slot-1", "== службы: остановка"];
    let pos = -1;
    for (const x of order) {
        const i = out.indexOf(x, pos + 1);
        assert.ok(i > pos, "порядок вывода: «" + x + "»\n" + out);
        pos = i;
    }
    assert.equal(fs.existsSync(path.join(HOME, "db.up")), false, "down после последнего прогона");
    assert.equal(g(slot, "rev-parse", "HEAD"), head, "ветка слота не тронута");
    assert.match(g(slot, "status", "--porcelain"), /new\.txt/, "индекс слота не тронут");
    const calls = sshCalls();
    assert.deepEqual(calls.map((c) => c.host), ["box", "box", "box", "box"]);
    assert.equal(calls[0].cmd, "bash -s");
    assert.match(calls[1].cmd, /git-receive-pack/);
    assert.equal(calls[2].cmd, "bash -s");
    assert.ok(calls.filter((c) => c.cmd === "bash -s").every((c) => c.batch), "ssh — только BatchMode");
    assert.ok(fs.existsSync(path.join(TMP, "remote", "repo-wt", "slot-1-p0", "prep.txt")), "своя папка прогона на машине");

    // второй прогон того же места: папка переиспользуется, служба уже работает — не перезапускается
    fs.writeFileSync(path.join(HOME, "db.up"), "");
    out = "";
    const m2 = { ...m, services: [{ ...m.services[0], down: "" }] };
    const code2 = await fakeApi(m2).slotRun({ jobId: "j43", key: "slot-1", cwd: slot, cmd: "cat a.txt" }, (s) => { out += s; }, () => { }, "box");
    assert.equal(code2, 0, out);
    assert.match(out, /уже работает/);
    assert.match(out, /dirty/);
});

test("недоступная машина: прогон — код 255 с причиной ssh, машина «не на связи», места не даёт", { skip: !BASH && "нет bash" }, async () => {
    const slot = slotRepo();
    const events = [];
    const api = fakeApi(box({ dir: fwd(path.join(TMP, "remote2")) }), { emit: (type, d) => events.push({ type, ...d }) });
    process.env.FAKE_SSH_FAIL = "1";
    try {
        let out = "";
        const code = await api.slotRun({ jobId: "j1", key: "s", cwd: slot, cmd: "true" }, (s) => { out += s; }, () => { }, "box");
        assert.equal(code, 255);
        assert.match(out, /не отвечает[\s\S]*Connection timed out/);
        await api.probeNow();
        assert.equal(api.hostHealth().box.state, "offline");
        assert.ok(events.some((e) => e.type === "host.state" && e.state === "offline" && e.kind === "timeout"));
        assert.equal(api.slotAnyOnline(), false);
        assert.equal(api.slotFree("main", { ageMs: 0 }), false);
    }
    finally {
        delete process.env.FAKE_SSH_FAIL;
    }
});

test("проба по поддельному ssh даёт нагрузку или честно «нет памяти»; отмена идёт скриптом снятия группы", { skip: !BASH && "нет bash" }, async () => {
    fs.rmSync(SSHLOG, { force: true });
    const api = fakeApi(box({ dir: fwd(path.join(TMP, "remote3")) }));
    await api.probeNow();
    const st = api.hostHealth().box || { state: "online" };
    if (st.state === "online")
        assert.ok(api.load().box.memTotalGB > 0, "на связи — значит проба вернула память");
    else
        assert.equal(api.slotAnyOnline(), false);
    assert.equal(await api.slotCancel("j9", "local"), false, "на этой машине процесс снимает раннер");
    assert.equal(await api.slotCancel("j9", "box"), true, "нет файла номера — снимать нечего, это не ошибка");
    assert.equal(sshCalls().length, 2);
});

test("initMachines ставит реализацию машин в shardApi()", () => {
    const api = initMachines({ machines: { local: LOCAL, box: box() }, watch: false, emit: () => { } });
    assert.equal(shardApi(), api);
    assert.equal(shardApi().on, true);
    setShardApi(null);
    assert.equal(shardApi().on, false);
});
