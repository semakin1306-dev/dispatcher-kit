// relay-imports.test.mjs — границы модулей протокола и оркестратора: они говорят с агентом только через функции
// agents.mjs (sendUserText, deliver…) и разовые запуски — только через runtimes/index.mjs runOnce; не собирают сообщений
// протокола рантайма, не знают имени бинарника и флагов CLI и не тянут модулей, которых в конструкторе нет.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = ["relay.mjs", "orchlog.mjs", "annot.mjs", "annot-rules.mjs", "review.mjs", "retro.mjs", "retro-rules.mjs", "retro-failures.mjs",
    "backlog.mjs", "backlog-rules.mjs", "backlog-store.mjs", "changes.mjs", "release-notes.mjs", "owner-word.mjs", "protocol.mjs", "../backlog.mjs"];
const src = (f) => fs.readFileSync(path.join(HERE, f), "utf8");

test("relay.mjs: разбор хода агента импортирован (isSyncAsk), правила слова владельца — из owner-word.mjs", () => {
    const s = src("relay.mjs");
    assert.match(s, /^import \{[^}]*\bisSyncAsk\b[^}]*\} from "\.\/sync-rules\.mjs"/m);
    assert.match(s, /^import \{[^}]*\bwordGrants\b[^}]*\} from "\.\/owner-word\.mjs"/m);
});

test("модули протокола не импортируют то, чего в конструкторе нет", () => {
    const GONE = /from "\.\/(vault|recon|learn|warm[\w-]*|usage|graph-[\w-]+|landing-preview|prodship|prod-rules|service-deploy|stand-[\w-]+|machine-relay[\w-]*|tg-rules)\.mjs"/;
    for (const f of FILES)
        assert.doesNotMatch(src(f), GONE, f);
});

test("модули протокола не собирают сообщений рантайма и не запускают CLI агента сами", () => {
    const RUNTIME =
        /type:\s*"user",\s*message|control_request|control_response|parent_tool_use_id|claudeBinary|claude\.exe|"-p"|--output-format|--allowedTools|--model"|\bagentSend\(|projectDirFor|isRemoteSlot|mirrorNow|shortCacheAt|rateLimits|saveWarm|setWarmFlag/;
    for (const f of FILES)
        assert.doesNotMatch(src(f), RUNTIME, f);
    assert.match(src("review.mjs"), /from "\.\.\/runtimes\/index\.mjs"/, "ревьюер — через runOnce");
    assert.match(src("retro.mjs"), /from "\.\.\/runtimes\/index\.mjs"/, "ретро — через runOnce");
});

test("имени модели и подписи с моделью в модулях протокола нет", () => {
    for (const f of FILES)
        assert.doesNotMatch(src(f), /claude-(opus|sonnet|haiku)|Co-Authored-By: Claude/i, f);
});
