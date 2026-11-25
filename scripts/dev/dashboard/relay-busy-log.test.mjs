// relay.mjs: просьба о коммите не уходит агенту, занятому своим ходом, и журнал автопередач не копит старые пары.
//   node --test scripts/dev/dashboard/relay-busy-log.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dk-relay-busy-"));
process.env.DASH_DATA = path.join(TMP, "data");
process.env.DASH_DRY = "1";
process.env.DISPATCHER_WT = path.join(TMP, "wt");
process.env.DASH_EPIC_FILE = path.join(TMP, "epics.json");
fs.mkdirSync(process.env.DASH_DATA, { recursive: true });
fs.writeFileSync(process.env.DASH_EPIC_FILE, JSON.stringify({ active: "", epics: [] }));
await import("./wiring.mjs");
const R = await import("./relay.mjs");
const { agents } = await import("./agents.mjs");
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

/** Ветка волны с незакоммиченной правкой: коммитить есть что. */
function slotRepo() {
    const repo = path.join(TMP, "slot");
    fs.mkdirSync(repo, { recursive: true });
    const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
    g("init", "-q", "-b", "dev/wv-9100-busy");
    g("config", "core.autocrlf", "false");
    g("config", "user.email", "t@t");
    g("config", "user.name", "t");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    g("add", ".");
    g("commit", "-qm", "init");
    fs.writeFileSync(path.join(repo, "a.txt"), "b\n");
    return { repo, head: g("rev-parse", "HEAD") };
}

test("коммит: агент занят дольше срока ожидания — просьба не уходит, задача падает с понятной причиной", async () => {
    const { repo, head } = slotRepo(), key = "wv9100-busy";
    const a = { key, busy: true, dead: false, pinging: false, rev: 0, items: [] };
    agents.set(key, a);
    const saved = { ...R.COMMIT_WAIT };
    R.COMMIT_WAIT.ms = 60;
    R.COMMIT_WAIT.step = 10;
    try {
        const out = [];
        await assert.rejects(R.commitStep({ key, tag: "П9", path: repo }, (s) => out.push(s)), /занят своим ходом.*не отправлена/);
        assert.equal(a.commitUntil, undefined, "разрешение на коммит не выдано");
        assert.equal(a.items.length, 0, "в ленту агента ничего не ушло");
        assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), head);
    }
    finally {
        Object.assign(R.COMMIT_WAIT, saved);
        agents.delete(key);
    }
});

test("журнал автопередач: запись убирает пары, у которых за окно не осталось ни одной передачи", () => {
    const now = Date.now(), W = R.AUTO_RELAY_WINDOW_MS;
    R.autoRelayLog.clear();
    R.autoRelayLog.set("old>x", [now - 2 * W]);
    R.autoRelayLog.set("mix>y", [now - 2 * W, now - W / 6]);
    R.noteAutoRelay("a>b", now);
    assert.equal(R.autoRelayLog.has("old>x"), false, "пара без свежих передач удалена");
    assert.deepEqual(R.autoRelayLog.get("mix>y"), [now - W / 6], "у живой пары остались только свежие времена");
    assert.deepEqual(R.autoRelayLog.get("a>b"), [now]);
    R.noteAutoRelay("a>b", now + 1);
    assert.deepEqual(R.autoRelayLog.get("a>b"), [now, now + 1]);
    R.autoRelayLog.clear();
});
