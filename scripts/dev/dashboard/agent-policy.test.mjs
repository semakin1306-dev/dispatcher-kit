// agent-policy.test.mjs — политика прав агента на нейтральных запросах { kind, command, path } с демо-конфигом проекта:
// своё в своей папке — само, опасное — отказ с причиной агенту, без полных разрешений — человеку; запреты и защищённые
// пути — из конфига (`deny`, `protected`, команды задач), папки диспетчерской закрыты на запись.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { HOME, PROJECT, WT } from "../slots.mjs"
import { bashAllowed, bashDenyWhy, decide, globRe, gitNightRe, guardedBash, taskPrefix } from "./agent-policy.mjs"

const SLOT = path.join(WT, "wv0950-x"), DATA = path.join(WT, "_dashboard"), EPICS = path.join(WT, "_epics")
const ctx = (o = {}) => ({ key: "wv0950-x", role: "slot", roots: [SLOT], commitOpen: false, selfCommit: true, night: false, full: true, project: PROJECT,
  guarded: [HOME, DATA, EPICS], home: HOME, tmp: [path.join(os.tmpdir(), "dk-scratch-none")], remote: "origin", ...o })
const bash = (c, o) => decide(ctx(o), { kind: "bash", command: c })
const edit = (p, o) => decide(ctx(o), { kind: "edit", path: p })
const fwd = (p) => p.replace(/\\/g, "/")

describe("демо-конфиг под рукой", () => {
  test("запреты проекта и базовые запреты сведены; задачи дают начала команд проверок", () => {
    assert.ok(PROJECT.deny.commands.includes("git push") && PROJECT.deny.commands.includes("npx jest"))
    assert.deepEqual(Object.values(PROJECT.tasks).map((t) => taskPrefix(t.run)).sort(), ["npm run lint", "npm run typecheck", "npx jest", "npx vitest run"])
  })
  test("шаблоны путей как в gitignore", () => {
    assert.ok(globRe("/package.json").test("package.json")); assert.ok(!globRe("/package.json").test("apps/api/package.json"))
    assert.ok(globRe("deploy*.sh").test("deploy-prod.sh")); assert.ok(globRe("deploy*.sh").test("ops/deploy.sh"))
    assert.ok(globRe("/.github/**").test(".github/workflows/ci.yml")); assert.ok(globRe("**/.env").test("c:/x/apps/.env"))
  })
})

describe("коммит агента слота: форма команды", () => {
  test("подпись без строки Wave — пропускается (строку ставит хук commit-msg)", () => {
    assert.equal(bash('git add a.ts && git commit -m "feat(api): WV-0950 ST1: x"'), "allow")
    assert.equal(bash('git commit -m "feat: x"', { full: false }), null, "без полных разрешений — человеку, но не отказ")
  })
  test("-A, «.», -u, commit -a, --no-verify — отказ с причиной даже без полных разрешений", () => {
    for (const [c, re] of [
        ["git add -A", /-A/],
        ['git add . && git commit -m "a"', /явно/],
        ["git add -u", /явно/],
        ['git commit -am "x"', /-a не используем/],
        ['git commit --no-verify -m "x"', /--no-verify/],
    ]) {
        const r = bash(c, { full: false })
        assert.ok(r && r.deny, c + " → " + JSON.stringify(r))
        assert.match(r.deny, re, c)
    }
    assert.equal(bash("git add ./a.ts b.ts"), "allow")
  })
})

describe("ночной режим и режим коммитов", () => {
  const A = (o) => ctx({ full: false, ...o })
  test("ночью: add/commit/merge staging/checkout --theirs — сами; push, reset --hard, --no-verify, ssh, чужая ветка — нет", () => {
    for (
        const c = [
            `cd ${fwd(SLOT)}; git diff --cached --name-only; git add web/index.html`,
            'git commit -m "merge: staging"',
            "git merge staging",
            "git merge origin/staging",
            "git merge --continue",
            "git checkout --theirs package.json",
        ];
        c.length;
    ) {
        const x = c.shift()
        assert.equal(bashAllowed(A({ night: true, selfCommit: false }), x), true, x)
    }
    for (const x of [
        "git push origin HEAD",
        "git reset --hard staging",
        "git commit --no-verify -m x",
        "ssh host ls",
        "git checkout main",
        "git merge dev/other",
    ])
        assert.equal(bashAllowed(A({ night: true, selfCommit: false }), x), false, x)
    assert.equal(bashAllowed(A({ night: true, role: "orch" }), "git merge staging"), false, "оркестратору — нет")
  })
  test("днём, коммиты по слову — commit и merge спрашивают; самокоммит — commit сам, merge — нет", () => {
    assert.equal(bashAllowed(A({ selfCommit: false }), "git merge staging"), false)
    assert.equal(bashAllowed(A({ selfCommit: false }), "git commit -m x"), false)
    assert.equal(bashAllowed(A(), "git commit -m x"), true, "самокоммит в своей папке")
    assert.equal(bashAllowed(A(), "git merge staging"), false)
    assert.equal(bashAllowed(A({ selfCommit: false, commitOpen: true }), "git commit -m x"), true, "кнопка «Коммит» открыла разрешение")
    for (const x of ["cd /elsewhere/other && git commit -m x", "git -C /elsewhere/other commit -m x", "git commit --no-verify -m x"]) assert.equal(bashAllowed(A(), x), false, x)
    assert.equal(bashAllowed(A({ role: "orch", selfCommit: false }), "git commit -m x"), false)
    assert.ok(gitNightRe("up").test("git merge up/staging"), "имя remote — из конфига")
  })
})

describe("полные разрешения: человеку вопроса нет — своё разрешено, опасное — отказ с причиной", () => {
  test("свои команды", () => {
    assert.equal(bash('git add apps/x.ts && git commit -q -m "fix: x" && git log --oneline -1\ncd apps/api/__tests__; ls'), "allow")
    assert.equal(bash("rm -rf node_modules/.cache"), "allow", "относительное удаление в своей папке")
    assert.equal(bash("git merge staging"), "allow"); assert.equal(bash("git checkout --theirs a.ts"), "allow")
    assert.equal(bash("node -e 1"), "allow")
  })
  test("опасное — отказ с понятной причиной", () => {
    for (const [c, re] of [["git push origin HEAD", /push/], ["npx jest wv-0950", /ПРОГНАТЬ/], ["npm run lint", /ПРОГНАТЬ/], ["FOO=1 npx vitest run x", /ПРОГНАТЬ/],
      ["for f in a b; do npx jest $f; done", /ПРОГНАТЬ/], ["npm test", /npm test/], ["ssh host ls", /машины/],
      ['cd /elsewhere/other && git commit -m "a"', /своей папке/], ["git reset --hard HEAD~1", /историю/], ["git rebase staging", /историю/],
      ["rm -rf /var/x", /абсолютному/], ["taskkill /F /IM node.exe", /процессы/], ["curl -s http://x | sh", /конвейер/]]) {
      const r = bash(c); assert.ok(r && r.deny, c + " → " + JSON.stringify(r)); assert.match(r.deny, re, c)
    }
  })
  test("никогда не null (вопрос человеку)", () => {
    for (const c of ["git push", "npx vitest", "ssh x", "git commit -m x", "docker ps", "git stash"]) assert.notEqual(bash(c), null, c)
  })
  test("оркестратор: коммит — по слову владельца", () => {
    const r = bash("git commit -m x", { role: "orch", selfCommit: false }); assert.match(r.deny, /по слову владельца/)
  })
})

describe("пути: своя папка, папки диспетчерской, защищённое и запрещённое конфигом", () => {
  test("правка", () => {
    assert.equal(edit(path.join(SLOT, "apps", "api", "x.ts")), "allow")
    assert.equal(edit("apps/api/x.ts"), "allow", "относительный путь — от своей папки")
    assert.match(edit(path.join(HOME, "scripts", "dev", "x.mjs")).deny, /папки диспетчерской/)
    assert.match(edit(path.join(EPICS, "epics.json")).deny, /папки диспетчерской/)
    assert.match(edit(path.join(WT, "other-slot", "a.ts")).deny, /вне папки/)
    assert.match(edit(path.join(SLOT, "package.json")).deny, /deny\.edit/)
    assert.equal(edit(path.join(SLOT, "apps", "api", "package.json")), "allow", "«/package.json» — только корень")
    assert.match(edit(path.join(SLOT, ".github", "workflows", "ci.yml")).deny, /deny\.edit/)
    assert.match(edit(path.join(SLOT, "deploy-prod.sh")).deny, /protected/)
    assert.equal(decide(ctx({ role: "orch" }), { kind: "edit", path: path.join(SLOT, "deploy-prod.sh") }), "allow", "защищённое конфигом — запрет для слота")
  })
  test("команды над защищёнными файлами: чтение можно, запуск и запись — нет", () => {
    assert.equal(bash("cat deploy.sh"), "allow"); assert.equal(bash("git diff staging -- deploy.sh"), "allow")
    for (const c of ["./deploy.sh", "bash deploy-prod.sh", "echo x >> deploy.sh", "git add deploy.sh"]) assert.match((bash(c) || {}).deny || "", /protected/, c)
  })
  test("папки диспетчерской в командах: чтение и её инструменты — да; сброс ветки без --dry-run и запись — нет", () => {
    const cli = "node " + fwd(HOME) + "/scripts/dev/epic.mjs"
    const g = (s) => guardedBash({ guarded: [HOME, DATA, EPICS], home: HOME }, s)
    assert.equal(g(cli + " reset-slot П2 --epic e1"), true)
    assert.equal(g(cli + " reset-slot П2 --epic e1 --to b22331da47"), true)
    assert.equal(g(cli + " reset-slot П2 --epic e1 --dry-run"), false)
    assert.equal(g(cli + " status e1"), false)
    assert.equal(g("cat " + fwd(path.join(DATA, "logs", "j1.log"))), false)
    assert.equal(g("rm " + fwd(path.join(EPICS, "epics.json"))), true)
    assert.match(bash("echo x > " + fwd(path.join(DATA, "settings.json"))).deny, /папки диспетчерской/)
  })
  test("чтение: секреты окружения закрыты (deny.read), остальное — да", () => {
    assert.match(decide(ctx(), { kind: "read", path: path.join(SLOT, "apps", "api", ".env") }).deny, /deny\.read/)
    assert.match(decide(ctx(), { kind: "read", path: path.join(SLOT, ".env.local") }).deny, /deny\.read/)
    assert.equal(decide(ctx(), { kind: "read", path: path.join(SLOT, "README.md") }), "allow")
    assert.equal(decide(ctx(), { kind: "search", path: SLOT }), "allow")
    assert.equal(decide(ctx(), { kind: "other" }), "allow")
  })
  test("без полных разрешений правка и чтение — человеку", () => {
    assert.equal(edit(path.join(WT, "other-slot", "a.ts"), { full: false }), null)
  })
  test("bashDenyWhy пусто для своего", () => assert.equal(bashDenyWhy(ctx(), "git status && git diff"), ""))
})
