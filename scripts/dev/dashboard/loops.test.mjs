import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    NO_GATE,
    ORCH_GATHER_MS,
    ORCH_ROTATE_TOKENS,
    SLOT_ASKS_RE,
    blockTargetTag,
    canonInput,
    deployWriteWhy,
    staleRed,
    factsDelta,
    relayDecision,
    retrySpecs,
    rotateDue,
    runGate,
    slotAsks,
    slotStatus,
} from "./loops.mjs";
import { RESET_TO_RE, backupTagName, resetSlotCmd, resetSlotPlan, carryRedSpecs, protectedFileRe } from "./loops.mjs";

const FP = "6ba8276c1c0ee27e", FP2 = "99299a2419d84b70", TREE = "wv0969-demo";
let seq = 1200;
const job = (o = {}) => ({ id: "j" + seq++, tree: TREE, task: "api-test", input: "wv-0969", status: "ok", by: "автопоезд", fpStart: FP, fpEnd: FP, ...o });
const gate = (jobs, o = {}) => runGate({ jobs, tree: TREE, task: "api-test", input: "wv-0969", fp: FP, ...o });

describe("runGate — ворота автоматического прогона", () => {
    test("пустой журнал — прогон ставится", () => {
        assert.deepEqual(gate([]), { run: true });
    });
    test("зелёный на этом же коде — повтор даст то же", () => {
        const g = job(), r = gate([g]);
        assert.equal(r.run, false);
        assert.equal(r.job, g);
        assert.equal(r.why, "зелёный на этом же коде (" + g.id + ")");
    });
    test("зелёный на другом коде или с кодом, сменившимся за прогон, — не считается", () => {
        assert.deepEqual(gate([job({ fpStart: FP2, fpEnd: FP2 })]), { run: true });
        assert.deepEqual(gate([job({ fpStart: FP, fpEnd: FP2 })]), { run: true });
        assert.deepEqual(gate([job({ fpStart: FP2, fpEnd: FP })]), { run: true });
    });
    test("из нескольких зелёных берётся последний по журналу", () => {
        const a = job(), b = job();
        assert.equal(gate([a, b]).job, b);
    });
    test("такой же прогон идёт или ждёт — второй не нужен; снимок кода для этого не нужен", () => {
        const run = job({ status: "running" });
        let r = gate([run], { fp: "" });
        assert.equal(r.run, false);
        assert.equal(r.job, run);
        assert.equal(r.why, "уже идёт (" + run.id + ")");
        const q = job({ status: "queued" });
        r = gate([q]);
        assert.equal(r.run, false);
        assert.equal(r.why, "уже в очереди (" + q.id + ")");
        const w = job({ status: "waiting" });
        r = gate([w]);
        assert.equal(r.run, false);
        assert.equal(r.why, "уже в очереди (" + w.id + ")");
        for (const status of ["ok", "fail", "cancelled", "interrupted", "skipped"])
            assert.equal(gate([job({ status, fpStart: FP2, fpEnd: FP2 })]).run, true, status);
    });
    test("идущий проверяется раньше зелёного", () => {
        const run = job({ status: "running" });
        assert.match(gate([job(), run]).why, /^уже идёт/);
    });
    test("без снимка кода (fp пуст) — ставится: ни зелёные, ни красные сверить не с чем", () => {
        assert.deepEqual(gate([job(), job({ status: "fail" }), job({ status: "fail" })], { fp: undefined }), { run: true });
    });
    test("другое дерево или другая задача — не тот же прогон", () => {
        assert.deepEqual(gate([job({ status: "running", tree: "wv0970-other" })]), { run: true });
        assert.deepEqual(gate([job({ status: "running", task: "lint" })]), { run: true });
        assert.deepEqual(gate([job({ tree: "wv0970-other" })]), { run: true });
    });
    test("шаблон спек сравнивается по канону: экранирование, суффикс, порядок ", () => {
        const g = job({ input: "wv-0969\\.test\\.ts" });
        assert.equal(gate([g]).job, g);
        const r = runGate({ jobs: [job({ input: "b\\.spec\\.ts|a", status: "running" })], tree: TREE, task: "api-test", input: "a|b", fp: FP });
        assert.match(r.why, /^уже идёт/);
        assert.equal(
            runGate({
                jobs: [job({ task: "guard-test", input: "status-quorum|mirror-manifest" })],
                tree: TREE,
                task: "guard-test",
                input: "mirror-manifest,status-quorum",
                fp: FP,
            }).run,
            false,
        );
    });
    test("дважды красный на этом же коде — третий без правки не ставится", () => {
        const a = job({ status: "fail" }), b = job({ status: "fail" }), r = gate([a, b]);
        assert.equal(r.run, false);
        assert.equal(r.job, b);
        assert.equal(r.why, "дважды красный на этом же коде (" + a.id + ", " + b.id + "): без правки повтор даст то же");
    });
    test("один красный — ещё не повтор; красные на другом коде не считаются", () => {
        assert.deepEqual(gate([job({ status: "fail" })]), { run: true });
        assert.deepEqual(gate([job({ status: "fail", fpStart: FP2, fpEnd: FP2 }), job({ status: "fail", fpStart: FP2, fpEnd: FP2 })]), { run: true });
        assert.deepEqual(gate([job({ status: "fail" }), job({ status: "fail", fpEnd: FP2 })]), { run: true });
    });
    test("красный от окружения (realFail — нет) не считается: повтор разрешён", () => {
        const realFail = (j) => !/окружение ПК|Connection timed out/.test(j.summary || "");
        const env = job({ status: "fail", summary: "окружение ПК: Connection timed out" }), real = job({ status: "fail", summary: "FAIL feature-gating" });
        assert.deepEqual(gate([env, real], { realFail }), { run: true });
        assert.deepEqual(gate([env, job({ status: "fail", summary: "Connection timed out" })], { realFail }), { run: true });
        assert.equal(gate([real, job({ status: "fail", summary: "FAIL" })], { realFail }).run, false);
        assert.deepEqual(gate([real, job({ status: "fail", summary: "FAIL" })], { realFail: () => false }), { run: true });
    });
    test("задачи NO_GATE не проверяются вовсе: у них своя логика повтора", () => {
        assert.deepEqual([...NO_GATE].sort(), ["accept-ask", "accept-run", "commit", "deploy-staging", "merge", "review", "slot-up", "train"]);
        for (const task of NO_GATE)
            assert.deepEqual(runGate({ jobs: [job({ task, status: "running" }), job({ task })], tree: TREE, task, fp: FP }), { run: true }, task);
        for (const task of ["api-test", "web-test", "web-all", "guard-test", "suite", "lint", "typecheck", "build", "docs-test"])
            assert.equal(NO_GATE.has(task), false, task);
    });
    test("covers — зелёный покрывающий прогон (шире по шаблону) считается зелёным и для этого", () => {
        const whole = job({ input: "" });
        assert.deepEqual(gate([whole]), { run: true });
        const covers = (j) => !j.input;
        const r = gate([whole], { covers });
        assert.equal(r.run, false);
        assert.equal(r.job, whole);
        assert.equal(r.why, "зелёный на этом же коде (" + whole.id + ")");
        assert.deepEqual(gate([job({ input: "", tree: "wv0970-other" })], { covers }), { run: true });
        assert.deepEqual(gate([job({ input: "", task: "web-test" })], { covers }), { run: true });
        assert.deepEqual(gate([job({ input: "", status: "fail" })], { covers }), { run: true });
        assert.deepEqual(gate([job({ input: "", fpEnd: FP2 })], { covers }), { run: true });
    });
    test("dist — для тестов бэкенда зелёный считается только с dist от этого кода или с сервера", () => {
        assert.deepEqual(gate([job()], { dist: true }), { run: true });
        assert.deepEqual(gate([job({ buildFp: FP2 })], { dist: true }), { run: true });
        assert.equal(gate([job({ buildFp: FP })], { dist: true }).run, false);
        assert.equal(gate([job({ runOn: "srv" })], { dist: true }).run, false);
        assert.equal(gate([job()], { dist: false }).run, false);
    });
    test("inherited — на этом коде упало только известное красное staging: считается, как зелёный, уже после первого красного", () => {
        const input = "feature-gating", red = job({ status: "fail", input });
        const o = { input, inherited: (j) => j.id === red.id };
        assert.deepEqual(gate([red], { input }), { run: true });
        const r = gate([red], o);
        assert.equal(r.run, false);
        assert.equal(r.job, red);
        assert.equal(r.why, "на этом коде упало только известное красное staging (" + red.id + "): повтор его не изменит");
        assert.match(gate([red, job({ status: "fail", input })], o).why, /^на этом коде упало только известное красное staging/);
        assert.deepEqual(gate([job({ status: "fail", input, fpStart: FP2, fpEnd: FP2 })], { input, inherited: () => true }), { run: true });
    });
    test("freshOk — зелёный на другом коде, после которого менялись только файлы вне области прогона", () => {
        const g = job({ fpStart: FP2, fpEnd: FP2 });
        assert.deepEqual(gate([g]), { run: true });
        const r = gate([g], { freshOk: (j) => j.id === g.id });
        assert.equal(r.run, false);
        assert.equal(r.job, g);
        assert.equal(r.why, "зелёный (" + g.id + "), и после него менялись только файлы вне его области — тесты, документы");
        assert.deepEqual(gate([job({ status: "fail", fpStart: FP2, fpEnd: FP2 })], { freshOk: () => true }), { run: true });
        assert.deepEqual(gate([job({ fpStart: FP2, fpEnd: FP2, input: "" })], { freshOk: () => true }), { run: true });
    });
});

describe("slotStatus — статус из первой строки доклада", () => {
    test("пять статусов, в том числе в жирном", () => {
        for (const st of ["ГОТОВО", "ЖДУ", "ЧАСТИЧНО", "СТОП", "ВОПРОС"]) {
            assert.equal(slotStatus("Статус: " + st + "\nтекст"), st);
            assert.equal(slotStatus("Статус: **" + st + "**"), st);
        }
    });
    test("не статус: вторая строка, слово длиннее, жирное «Статус:», пусто", () => {
        assert.equal(slotStatus("П11\nСтатус: ГОТОВО"), "");
        assert.equal(slotStatus("Статус: ГОТОВОСТЬ 80 %"), "");
        assert.equal(slotStatus("**Статус:** **ЖДУ**"), "");
        assert.equal(slotStatus(""), "");
        assert.equal(slotStatus(undefined), "");
    });
});

describe("slotAsks — просьбы доклада без строки «Дальше»", () => {
    test("раздел берётся до конца доклада, «Дальше:» отрезается, пробелы схлопываются", () => {
        assert.equal(slotAsks("Статус: ЖДУ\n\nНужно от оркестратора: решить,\n  оставлять ли страховку\n\nДальше: жду ответа\nи ещё"), "Нужно от оркестратора: решить, оставлять ли страховку");
        assert.equal(slotAsks("Нужно от оркестратора: а\n- б\n- в\nДальше: г"), "Нужно от оркестратора: а - б - в");
    });
    test("заголовки «Нужно от оркестратора», «Вопросы владельцу», «Вопросы …», «Ответ оркестратору»; регистр и разметка не мешают", () => {
        assert.equal(slotAsks("Вопросы владельцу: оставить маршрут?"), "Вопросы владельцу: оставить маршрут?");
        assert.equal(slotAsks("Вопросы по ТЗ: один"), "Вопросы по ТЗ: один");
        assert.equal(slotAsks("x\n> ответ оркестратору: да"), "> ответ оркестратору: да");
        assert.equal(slotAsks("Статус: ЖДУ\n**Нужно от оркестратора:** решить по страховке\n\nДальше: жду"), "**Нужно от оркестратора:** решить по страховке");
    });
    test("заголовок стоит в начале строки, двоеточие — сразу за ним", () => {
        assert.equal(slotAsks("см. Нужно от оркестратора: x"), "");
        assert.equal(slotAsks("**Нужно от оркестратора**: решить"), "");
        assert.equal(slotAsks("Нужно от владельца: x"), "");
    });
    test("«Продолжу, когда: оркестратор решит/ответит/подтвердит …» — просьба без раздела; обычное ожидание — нет", () => {
        assert.equal(slotAsks("Статус: ЖДУ\n\nПродолжу, когда: оркестратор решит по страховке сборки лендинга\nДальше: жду"), "Продолжу, когда: оркестратор решит по страховке сборки лендинга");
        assert.equal(slotAsks("- Продолжу когда оркестратор подтвердит схему"), "- Продолжу когда оркестратор подтвердит схему");
        assert.equal(slotAsks("Продолжу, когда: оркестратор или владелец даст следующее указание"), "");
        assert.equal(slotAsks("Продолжу, когда: владелец решит"), "");
        assert.equal(slotAsks("Продолжу, когда: оркестратор решит\nВопросы владельцу: как?"), "Вопросы владельцу: как?");
    });
    test("пустой доклад — пустые просьбы", () => {
        assert.equal(slotAsks(""), "");
        assert.equal(slotAsks(null), "");
        assert.equal(slotAsks(undefined), "");
    });
    test("SLOT_ASKS_RE — границы шаблона", () => {
        assert.ok(SLOT_ASKS_RE.test("Нужно от оркестратора:"));
        assert.ok(SLOT_ASKS_RE.test("текст\n  ## Вопросы владельцу :"));
        assert.ok(!SLOT_ASKS_RE.test("Нужно от оркестратора"));
        assert.ok(!SLOT_ASKS_RE.test("Вопросы, которые длиннее тридцати знаков до двоеточия, не считаются:"));
    });
});

describe("staleRed — красное со старого кода", () => {
    test("код поменялся после падения — устарело", () => assert.equal(staleRed({ status: "fail", fpStart: "a" }, "b"), true));
    test("тот же код — живое красное", () => assert.equal(staleRed({ status: "fail", fpStart: "a" }, "a"), false));
    test("зелёный, без отпечатка или без нынешнего отпечатка — не устаревшее красное", () => {
        assert.equal(staleRed({ status: "ok", fpStart: "a" }, "b"), false);
        assert.equal(staleRed({ status: "fail" }, "b"), false);
        assert.equal(staleRed({ status: "fail", fpStart: "a" }, ""), false);
    });
});

describe("deployWriteWhy — запись в защищённые файлы из сессии агента", () => {
    const P = ["deploy*.sh", "ci.yaml"];
    const no = (c) => assert.equal(deployWriteWhy(c, P), "", c);
    const yes = (c) => assert.match(deployWriteWhy(c, P), /защищённые файлы/, c);
    test("чтение можно", () => {
        no("grep -n FRONTEND_RE deploy.sh");
        no("sed -n 870,924p deploy.sh");
        no("cat deploy.sh | head");
        no("git show 3610a6d19d:deploy.sh | head");
        no("git diff -- deploy.sh");
        no("bash -n deploy.sh");
    });
    test("без файлов выката — не наше дело", () => {
        no("git add -A && git commit -m x");
        no("python3 - <<'EOF'\nopen('a.md','w').write('x')\nEOF");
    });
    test("python heredoc с open(..., 'w') — нельзя", () => yes("cd /x; python3 - <<'EOF'\ns=open('deploy.sh').read()\nopen('deploy.sh','w').write(s)\nEOF"));
    test("перенаправление, sed -i, tee, cp — нельзя", () => {
        yes("git show 3610a6d19d:deploy.sh > deploy.sh");
        yes("sed -i 's/a/b/' deploy.sh");
        yes("echo x | tee -a deploy-staging.sh");
        yes("cp /tmp/d deploy.sh");
        yes("sed -i -e 's/x/y/' ci.yaml");
    });
    test("git add / checkout файла выката — нельзя", () => {
        yes("git add deploy.sh docs/notes.md && git commit -m x");
        yes("git checkout 3610a6d19d -- deploy.sh");
    });
    test("node writeFileSync — нельзя", () => yes("node -e \"require('fs').writeFileSync('deploy.sh', s)\""));
    test("без защищённых файлов в конфиге — проверки нет; шаблон с * не выходит за слово", () => {
        assert.equal(deployWriteWhy("sed -i 's/a/b/' deploy.sh", []), "");
        assert.equal(protectedFileRe([]), "");
        assert.ok(new RegExp(protectedFileRe(["deploy*.sh"])).test("cp x deploy-prod.sh"));
        assert.ok(!new RegExp(protectedFileRe(["deploy*.sh"])).test("deploy x.sh"));
    });
});

describe("blockTargetTag — адресат блока оркестратора", () => {
    const trees = [{ key: "tr-web", slot: "tr-web", tag: "Т1" }, { key: "tr-web-c", tag: "Т1 · состав #1" }, { key: "tr-api", slot: "tr-api", tag: "Т3" }];
    test("метка состава с пробелами адресует состав, а не поезд", () => assert.equal(blockTargetTag("slot: Т1 · состав #1", trees).key, "tr-web-c"));
    test("короткая метка — поезд", () => assert.equal(blockTargetTag("slot: Т1", trees).key, "tr-web"));
    test("по имени папки тоже", () => assert.equal(blockTargetTag("slot:tr-api", trees).key, "tr-api"));
    test("не slot-блок и неизвестная метка — null", () => {
        assert.equal(blockTargetTag("text", trees), null);
        assert.equal(blockTargetTag("slot: Т9", trees), null);
    });
});

describe("relayDecision — уходит ли доклад оркестратору сам", () => {
    const same = { fp: FP, sha: "b92f29997a3312e5" }, other = { fp: FP2, sha: "4ee6f60e41" };
    const prevOf = (body, code = same) => ({ ...code, asks: slotAsks(body) });
    const ASKS = { relay: true, why: "есть просьбы или ответ оркестратору" };
    test("СТОП и ВОПРОС уходят всегда — и при том же коде, и при тех же просьбах", () => {
        for (const st of ["СТОП", "ВОПРОС"]) {
            const body = "Статус: " + st + "\n\nНужно от оркестратора: решить по страховке";
            assert.deepEqual(relayDecision({ body, prev: prevOf(body), cur: same }), { relay: true, why: "статус " + st });
            assert.deepEqual(relayDecision({ body: "Статус: " + st, prev: null, cur: null }), { relay: true, why: "статус " + st });
        }
    });
    test("ЖДУ без просьб не уходит — ни в первый раз, ни потом", () => {
        const body = "Статус: ЖДУ\n\nЖду, пока владелец примет стенд.\n\nДальше: по слову владельца";
        const want = { relay: false, why: "«ЖДУ» без просьб к оркестратору" };
        assert.deepEqual(relayDecision({ body, prev: null, cur: same }), want);
        assert.deepEqual(relayDecision({ body, prev: { ...other, asks: "" }, cur: same }), want);
    });
    test("ЖДУ с просьбой уходит; те же просьбы при том же коде — нет", () => {
        const body = "Статус: ЖДУ\n\nНужно от оркестратора: решить, оставлять ли страховку сборки лендинга\n\nДальше: жду ответа";
        assert.deepEqual(relayDecision({ body, prev: null, cur: same }), ASKS);
        assert.deepEqual(relayDecision({ body, prev: prevOf(body), cur: same }), { relay: false, why: "те же просьбы при том же коде, что в прошлой передаче" });
        assert.deepEqual(relayDecision({ body, prev: prevOf(body), cur: other }), ASKS);
        assert.deepEqual(relayDecision({ body, prev: prevOf(body), cur: null }), ASKS);
        assert.deepEqual(relayDecision({ body: body.replace("лендинга", "лендинга и витрины"), prev: prevOf(body), cur: same }), ASKS);
        assert.equal(relayDecision({ body: body.replace("жду ответа", "жду решения"), prev: prevOf(body), cur: same }).relay, false);
    });
    test("ГОТОВО и ЧАСТИЧНО без просьб уходят только со сменой кода", () => {
        for (const st of ["ГОТОВО", "ЧАСТИЧНО"]) {
            const body = "Статус: " + st + "\n\nСделано: спека догнана до планов.\n\nДальше: жду ревью", prev = { ...same, asks: "" };
            assert.deepEqual(relayDecision({ body, prev, cur: same }), { relay: false, why: "«" + st + "» без просьб, а код тот же, что при прошлой передаче" });
            const yes = { relay: true, why: "код изменился с прошлой передачи" };
            assert.deepEqual(relayDecision({ body, prev, cur: other }), yes);
            assert.deepEqual(relayDecision({ body, prev, cur: { fp: FP, sha: "другой" } }), yes);
            assert.deepEqual(relayDecision({ body, prev: null, cur: same }), yes);
            assert.deepEqual(relayDecision({ body, prev, cur: null }), yes);
        }
    });
    test("разделы «Нужно от оркестратора», «Вопросы владельцу», «Ответ оркестратору» уходят и при том же коде", () => {
        for (const sec of [
            "Нужно от оркестратора: подтвердить схему",
            "Вопросы владельцу: оставить ли старый маршрут?",
            "Ответ оркестратору: да, маршрут снят",
            "> **Вопросы по ТЗ:** нужен ли лимит",
        ]) {
            const body = "Статус: ГОТОВО\n\nСделано.\n\n" + sec + "\n\nДальше: жду";
            assert.deepEqual(relayDecision({ body, prev: { ...same, asks: "" }, cur: same }), ASKS, sec);
            assert.equal(relayDecision({ body, prev: prevOf(body), cur: same }).relay, false, sec);
        }
    });
    test("«Продолжу, когда: оркестратор решит …» — просьба; «…или владелец даст указание» — обычное ожидание", () => {
        const wait = "Статус: ЖДУ\n\nПродолжу, когда: оркестратор решит по страховке сборки лендинга";
        assert.deepEqual(relayDecision({ body: wait, prev: null, cur: same }), ASKS);
        assert.equal(relayDecision({ body: wait, prev: prevOf(wait), cur: same }).relay, false);
        const idle = "Статус: ЖДУ\n\nПродолжу, когда оркестратор или владелец даст следующее указание";
        assert.deepEqual(relayDecision({ body: idle, prev: null, cur: same }), { relay: false, why: "«ЖДУ» без просьб к оркестратору" });
    });
    test("статус не распознан — уходит: пусть разбирается оркестратор", () => {
        const want = { relay: true, why: "статус доклада не распознан" };
        assert.deepEqual(relayDecision({ body: "Сделал всё, что просили.", prev: { ...same, asks: "" }, cur: same }), want);
        assert.deepEqual(relayDecision({ body: "", prev: null, cur: null }), want);
        assert.deepEqual(relayDecision({ body: "П11\nСтатус: ЖДУ", prev: null, cur: same }), want);
        assert.deepEqual(relayDecision({ body: "Статус: ГОТОВОСТЬ 80 %", prev: null, cur: same }), want);
    });
});

describe("canonInput — один набор спек разной записью", () => {
    test("части через «,» или «|»: экранирование и суффикс спеки снимаются, порядок и пробелы не важны", () => {
        const want = "auth,feature-gating";
        assert.equal(canonInput("api-test", "feature-gating\\.test\\.ts|auth\\.test\\.ts"), want);
        assert.equal(canonInput("api-test", " auth | feature-gating "), want);
        assert.equal(canonInput("web-test", "feature-gating, auth.spec.tsx"), want);
        assert.equal(canonInput("api-test", "a||b|"), "a,b");
        assert.equal(canonInput("api-test", "a.ts|b.test.mts|c.spec.cjs"), "a.ts,b,c");
    });
    test("ввод без разделителей — как есть, без пробелов по краям и суффикса спеки; пусто — пустая строка", () => {
        assert.equal(canonInput("lint", "  apps/api "), "apps/api");
        assert.equal(canonInput("web-test", "a\\.b"), "a.b");
        assert.equal(canonInput("web-test", "cart.spec.ts"), "cart");
        assert.equal(canonInput("api-test", undefined), "");
        assert.equal(canonInput("lint", null), "");
    });
});

describe("carryRedSpecs — узкий перепрогон несёт всю красную группу", () => {
    const fails = ["a.spec.ts", "b.spec.ts", "c.spec.ts"].map((spec) => ({ spec, fam: "api-test" }));
    const join = (base, specs) => [base, ...specs].join("|");
    test("непокрытые упавшие спеки той же задачи дописываются; чужие задачи не липнут", () => {
        assert.deepEqual(carryRedSpecs({ task: "api-test", input: "b", fails, join }), { input: "b|a.spec.ts|c.spec.ts", added: ["a.spec.ts", "c.spec.ts"] });
        assert.deepEqual(carryRedSpecs({ task: "web-test", input: "b", fails, join }).added, []);
    });
    test("без способа дописать (разбор только по коду возврата) или без ввода — ввод как есть", () => {
        assert.deepEqual(carryRedSpecs({ task: "api-test", input: "b", fails }), { input: "b", added: [] });
        assert.deepEqual(carryRedSpecs({ task: "api-test", input: "", fails, join }), { input: "", added: [] });
    });
});

describe("retrySpecs — какие упавшие спеки перепрогнать один раз", () => {
    const code = TREE + ":" + FP, jobId = "j1119";
    const OWN = "apps/backend/src/modules/wb/__tests__/wv-0969-wb-sub.spec.ts";
    const STG = "__tests__/integration/feature-gating.test.ts";
    const OTHER = "__tests__/integration/organization/wv-0945-api-key-label.spec.ts";
    const h = (ok, c, job) => ({ at: 1793713048691, ok, job, code: c });
    test("чужие и ещё не падавшие на этом коде — остаются все; touched и history необязательны", () => {
        assert.deepEqual(retrySpecs({ failing: [STG, OTHER], code, jobId }), [STG, OTHER]);
        assert.deepEqual(retrySpecs({ failing: [], touched: [OWN], code, jobId }), []);
    });
    test("свои спеки (заведённые или правленные веткой) не перегоняются — их красный и есть работа слота", () => {
        assert.deepEqual(retrySpecs({ failing: [OWN, STG], touched: [OWN], code, jobId }), [STG]);
        assert.deepEqual(retrySpecs({ failing: [OWN, STG], touched: ["apps\\backend\\src\\modules\\wb\\__tests__\\wv-0969-wb-sub.spec.ts"], code, jobId }), [STG]);
        assert.deepEqual(retrySpecs({ failing: [OWN], touched: ["другая/папка/wv-0969-wb-sub.spec.ts"], code, jobId }), []);
    });
    test("правка исходника не делает спеку своей", () => {
        const spec = "apps/backend/src/modules/wb/service.test.ts";
        assert.deepEqual(retrySpecs({ failing: [spec], touched: ["apps/backend/src/modules/wb/service.ts", "docs/plan.md"], code, jobId }), [spec]);
    });
    test("уже падавшая на этом же коде в другом прогоне — сломанная, не нестабильная: не перегоняется", () => {
        assert.deepEqual(retrySpecs({ failing: [STG, OTHER], history: { [STG]: [h(true, code, "j1100"), h(false, code, "j1101")] }, code, jobId }), [OTHER]);
        assert.deepEqual(retrySpecs({ failing: [STG], history: { [STG]: [h(false, code, jobId)] }, code, jobId }), [STG]);
        assert.deepEqual(retrySpecs({ failing: [STG], history: { [STG]: [h(false, TREE + ":" + FP2, "j1101")] }, code, jobId }), [STG]);
        assert.deepEqual(retrySpecs({ failing: [STG], history: { [STG]: [h(true, code, "j1101")] }, code, jobId }), [STG]);
        assert.deepEqual(retrySpecs({ failing: [STG], history: { "feature-gating.test.ts": [h(false, code, "j1101")] }, code, jobId }), [STG]);
    });
});

describe("factsDelta — справка диспетчерской разностью", () => {
    const snap = { "apps/backend/src/api/middlewares.ts": "31760e5a6aed", "apps/backend/package.json": "ca20768aa428", "docs/plan.md": "0a1b2c3d4e5f" };
    const cur = { planHash: "p1", fp: FP, snap, reds: ["j1101", "j1119"] };
    test("первая передача — всё целиком", () => {
        assert.deepEqual(factsDelta({ prev: null, cur }), { full: true, plan: true, diff: "all", files: [], reds: ["j1101", "j1119"] });
        assert.deepEqual(factsDelta({ prev: undefined, cur: { ...cur, reds: [] } }).reds, []);
    });
    test("тот же код и план — ничего нового, кроме новых красных", () => {
        assert.deepEqual(factsDelta({ prev: { ...cur, reds: ["j1101"] }, cur }), { full: false, plan: false, diff: "same", files: [], reds: ["j1119"] });
        assert.deepEqual(factsDelta({ prev: cur, cur }).reds, []);
        assert.deepEqual(factsDelta({ prev: { planHash: "p1", fp: FP }, cur }).reds, ["j1101", "j1119"]);
    });
    test("сменился план — plan: true", () => {
        assert.equal(factsDelta({ prev: { ...cur, planHash: "p0" }, cur }).plan, true);
    });
    test("сменился код, снимки есть — список файлов: изменённые, исчезнувшие, новые; порядок — по прошлому снимку, потом новые", () => {
        const prev = { ...cur, fp: FP2, snap: { "apps/backend/src/api/middlewares.ts": "31760e5a6aed", "apps/backend/package.json": "старый", "apps/backend/src/old.ts": "x" } };
        const d = factsDelta({ prev, cur });
        assert.equal(d.full, false);
        assert.equal(d.diff, "files");
        assert.deepEqual(d.files, ["apps/backend/package.json", "apps/backend/src/old.ts", "docs/plan.md"]);
    });
    test("сменился код, снимка нет хотя бы с одной стороны — дифф целиком", () => {
        assert.deepEqual(factsDelta({ prev: { ...cur, fp: FP2, snap: null }, cur }), { full: false, plan: false, diff: "all", files: [], reds: [] });
        assert.equal(factsDelta({ prev: { ...cur, fp: FP2 }, cur: { ...cur, snap: undefined } }).diff, "all");
    });
});

describe("rotateDue — порог контекста оркестратора", () => {
    test("порог включительно; пусто и нечисло — не пора", () => {
        assert.ok(ORCH_ROTATE_TOKENS > 0 && ORCH_GATHER_MS >= 0);
        assert.equal(rotateDue(ORCH_ROTATE_TOKENS - 1), false);
        assert.equal(rotateDue(ORCH_ROTATE_TOKENS), true);
        assert.equal(rotateDue(ORCH_ROTATE_TOKENS * 2), true);
        assert.equal(rotateDue(String(ORCH_ROTATE_TOKENS)), true);
        assert.equal(rotateDue(undefined), false);
        assert.equal(rotateDue(null), false);
        assert.equal(rotateDue(0), false);
        assert.equal(rotateDue("нет"), false);
    });
    test("по умолчанию 300 тыс. токенов и без окна сбора ; DASH_ORCH_ROTATE_K и DASH_ORCH_GATHER_SEC меняют; 0 — ротация выключена", () => {
        const env = { ...process.env };
        delete env.DASH_ORCH_ROTATE_K;
        delete env.DASH_ORCH_GATHER_SEC;
        const src =
            `import { ORCH_GATHER_MS, ORCH_ROTATE_TOKENS, rotateDue } ` +
            `from ${JSON.stringify(new URL("./loops.mjs", import.meta.url).href)}; ` +
            `console.log(JSON.stringify([ORCH_GATHER_MS, ORCH_ROTATE_TOKENS, rotateDue(299999), ` +
            `rotateDue(300000), rotateDue(1e9)]))`;
        const probe = (extra) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8", env: { ...env, ...extra }, windowsHide: true }));
        assert.deepEqual(probe({}), [0, 300000, false, true, true]);
        assert.deepEqual(probe({ DASH_ORCH_ROTATE_K: "150", DASH_ORCH_GATHER_SEC: "10" }), [10000, 150000, true, true, true]);
        assert.deepEqual(probe({ DASH_ORCH_ROTATE_K: "0" }), [0, 0, false, false, false]);
    });
});

test("доклад по ходу «Подтянуть staging» без просьб оркестратору не уходит; с просьбой или СТОП — уходит", () => {
    const prev = { fp: "a", sha: "1" }, cur = { fp: "b", sha: "2" };
    assert.equal(relayDecision({ body: "WV-1016 (слот x): ГОТОВО.\n\nВторой влив staging сделан.", prev, cur, sync: true }).relay, false);
    assert.equal(relayDecision({ body: "WV-1016 (слот x): ГОТОВО.\n\nВторой влив staging сделан.", prev, cur, sync: false }).relay, true, "обычный ход с новым кодом — уходит");
    assert.equal(relayDecision({ body: "WV-1016 (слот x): СТОП.\n\nКонфликт не решить.", prev, cur, sync: true }).relay, true);
});

const H = (c) => c.repeat(40), PCT = H("a"), STG = H("c");

const facts = (o = {}) => ({ epic: "demo-epic", tag: "П2", slot: "wv1104-x", branch: "dev/wv-1104-x", to: "staging", target: STG, at: new Date(2026, 10, 19, 15, 7).getTime(),
    pc: { exists: true, head: PCT, onBranch: "dev/wv-1104-x", dirty: [] }, rel: { targetInStaging: true, targetInBranch: true }, lost: ["fa56dab лишний коммит"],
    agent: { alive: false, busy: false }, jobs: [], preparing: false, syncing: false, tagsTaken: [], ...o });

describe("resetSlotPlan — когда отказать и что сбросить", () => {
    test("здесь лишний коммит — тег-страховка на старую верхушку, ветка — на цель", () => {
        const p = resetSlotPlan(facts());
        assert.deepEqual(p.refuse, []);
        assert.equal(p.noop, false);
        assert.deepEqual(p.tags, [{ name: "backup/demo-epic/wv1104-x/2026-11-19-1507", sha: PCT, what: "здешняя ветка" }]);
        assert.match(p.text, /снимаются коммиты \(1\): fa56dab/);
        assert.match(p.text, /здесь: aaaaaaaaaa → cccccccccc/);
    });
    test("уже на цели — сбрасывать нечего; занятое имя тега — с номером", () => {
        const p = resetSlotPlan(facts({ pc: { exists: true, head: STG, onBranch: "dev/wv-1104-x", dirty: [] } }));
        assert.equal(p.noop, true);
        assert.deepEqual(p.tags, []);
        assert.match(p.text, /сбрасывать нечего/);
        assert.equal(resetSlotPlan(facts({ tagsTaken: ["backup/demo-epic/wv1104-x/2026-11-19-1507"] })).tags[0].name, "backup/demo-epic/wv1104-x/2026-11-19-1507-2");
    });
    test("отказы — каждый с причиной, ничего не трогается", () => {
        const why = (o) => resetSlotPlan(facts(o)).refuse.join(" | ");
        assert.match(why({ agent: { alive: true, busy: false } }), /агент слота запущен — сначала остановите/);
        assert.match(why({ agent: { alive: true, busy: true } }), /пишет ответ/);
        assert.match(why({ jobs: ["j4680"] }), /идут прогоны слота: j4680/);
        assert.match(why({ pc: { exists: true, head: PCT, onBranch: "dev/wv-1104-x", dirty: ["apps/a.ts", "b.ts"] } }), /в папке слота несохранённое \(2\): apps\/a\.ts, b\.ts/);
        assert.match(why({ pc: { exists: true, head: PCT, onBranch: "", dirty: [] } }), /папка слота не на ветке/);
        assert.match(why({ pc: { exists: false } }), /папки слота нет/);
        assert.match(why({ preparing: true }), /slot-up/);
        assert.match(why({ syncing: true }), /перемотка или зеркало/);
        assert.match(why({ to: "HEAD~1" }), /staging или sha/);
        assert.match(why({ to: "deadbeef", target: "" }), /не найден/);
        assert.match(why({ rel: { targetInStaging: false, targetInBranch: false } }), /ни в staging, ни в ветку слота/);
        const p = resetSlotPlan(facts({ jobs: ["j1"], agent: { alive: true } }));
        assert.deepEqual(p.tags, []);
        assert.match(p.text, /^П2: сброс не выполнен —\n {2}- /);
    });
    test("куда: staging или sha; имя тега и команда подсказки", () => {
        assert.ok(RESET_TO_RE.test("staging") && RESET_TO_RE.test("fa56dab") && RESET_TO_RE.test(H("f")));
        assert.ok(!RESET_TO_RE.test("main") && !RESET_TO_RE.test("fa56") && !RESET_TO_RE.test("x; rm"));
        assert.equal(backupTagName("e", "s", new Date(2026, 0, 2, 3, 4).getTime()), "backup/e/s/2026-01-02-0304");
        assert.equal(resetSlotCmd("П2", "demo-epic"), "node scripts/dev/epic.mjs reset-slot П2 --epic demo-epic --dry-run");
        assert.equal(resetSlotCmd("П2", "", false, "/kit/scripts/dev/epic.mjs"), "node /kit/scripts/dev/epic.mjs reset-slot П2");
    });
});
