// commit-rules.test.mjs — правила коммитов агента слота: режим самокоммита, проверка подписи (строка Wave в последнем абзаце),
// форма команды коммита, починка подписи для хука commit-msg, признак «волна закончена». Чистые функции, без сервера.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import * as R from "./commit-rules.mjs"

describe("подпись коммита: строка Wave в последнем абзаце", () => {
  test("есть — да; нет, другая волна, одна строка без абзаца, не последний абзац — отказ с причиной", () => {
    assert.equal(R.commitMessageCheck("feat(api): WV-1035 ST2: ручка\n\nтело\n\nWave: WV-1035\nCo-Authored-By: x <x@example.com>", "wv-1035").ok, true)
    assert.equal(R.commitMessageCheck("feat: WV-1035 ST2: x\n\nWave: WV-1035").wave, "WV-1035")
    const no = R.commitMessageCheck("feat(api): WV-1035 ST2: ручка\n\nтело", "WV-1035"); assert.equal(no.ok, false); assert.match(no.why, /Wave: WV-1035/)
    assert.equal(R.commitMessageCheck("feat: x\n\nWave: WV-1036", "WV-1035").ok, false, "чужая волна")
    assert.match(R.commitMessageCheck("feat: x\n\nWave: WV-1036", ["WV-1035", "WV-1034"]).why, /вагоны этого поезда/)
    assert.equal(R.commitMessageCheck("Wave: WV-1035", "WV-1035").ok, false, "только трейлер без темы")
    assert.equal(R.commitMessageCheck("feat: x\n\nWave: WV-1035\n\nещё абзац").ok, false, "Wave не в последнем абзаце — git её трейлером не считает")
  })
})

describe("форма команды коммита", () => {
  test("файлы явно; -A, «.», -u, -a, --no-verify — нет; прочее — не коммит", () => {
    for (const c of ["git add -A", "git add --all", "git add . && git commit -m x", "git add -u", 'git commit -am "x"', "git commit --all -m x", "git commit --no-verify -m x", "git commit -n -m x"]) assert.equal(R.commitCmdShape(c).ok, false, c)
    for (const c of ["git add a.ts ./b.ts", 'git commit -q -m "fix: --all в тексте не флаг"', 'git commit --trailer "Wave: WV-0001" -m x', "git commit --amend --no-edit", "git status"]) assert.equal(R.commitCmdShape(c).ok, true, c)
    assert.match(R.commitCmdShape("git commit --no-verify -m x").why, /хук/)
  })
})

describe("починка подписи для хука", () => {
  test("нет строки — абзацем; блок трейлеров — внутрь; чужой номер — номер слота; разрешённый — остаётся", () => {
    assert.equal(R.fixWaveMessage("feat: x", { cur: "WV-0044" }).text, "feat: x\n\nWave: WV-0044\n")
    assert.equal(R.fixWaveMessage("feat: x\n\nтело", { cur: "WV-0044" }).text, "feat: x\n\nтело\n\nWave: WV-0044\n")
    const moved = R.fixWaveMessage("fix: x\n\nтело\n\nWave: WV-0087\n\nCo-Authored-By: c <c@example.com>", { cur: "WV-0087" })
    assert.equal(moved.text, "fix: x\n\nтело\n\nCo-Authored-By: c <c@example.com>\nWave: WV-0087\n"); assert.equal(moved.how, "moved")
    const ren = R.fixWaveMessage("feat: x\n\nWave: WV-0042", { cur: "WV-0044" }); assert.deepEqual([ren.from, ren.to, ren.how], [["WV-0042"], "WV-0044", "renumbered"])
    assert.equal(R.fixWaveMessage("fix: y\n\nWave: WV-0093", { cur: "WV-0099", allowed: ["WV-0093"] }), null, "починка влитого вагона под его номером — верно")
    const keep = R.fixWaveMessage("fix: y\nWave: WV-0093", { cur: "WV-0099", allowed: ["WV-0093"] }); assert.equal(keep.to, "WV-0093", "разрешённый номер агента сохраняется при переносе")
    for (const out of [ren.text, moved.text, keep.text]) assert.equal(R.commitMessageCheck(out, ["WV-0044", "WV-0087", "WV-0093"]).ok, true, out)
  })
})

describe("режим коммитов (settings.selfCommit)", () => {
  test("по умолчанию — после станции; неизвестное — по умолчанию; word — только по слову", () => {
    assert.equal(R.selfCommitMode({}), "station"); assert.equal(R.selfCommitMode({ selfCommit: "чушь" }), "station"); assert.equal(R.selfCommitMode({ selfCommit: "free" }), "free")
    assert.equal(R.selfCommitOn({ selfCommit: "word" }), false); assert.equal(R.selfCommitOn({}), true)
  })
  test("правило в подсказке: сам, после станции, Wave ставит хук, без пуша и --no-verify; в режиме word — только по слову", () => {
    const st = R.selfCommitRule("station")
    for (const re of [/после каждой законченной станции/, /Wave: WV-NNNN/, /хук/, /без --no-verify/, /без слова владельца/, /Пуш, слияние/, /рабочее дерево чистое/]) assert.match(st, re)
    assert.match(R.selfCommitRule("word"), /Сам по своей инициативе не коммить/)
    assert.doesNotMatch(st, /\d{2}\.\d{2}|П\d/, "постоянная часть без дат и меток слота")
  })
  test("волна закончена: по слову — всегда; иначе — коммит по слову на этом коде, старый коммит или «ГОТОВО» на этом коде", () => {
    assert.equal(R.waveFinal({ mode: "word" }), true)
    assert.equal(R.waveFinal({ mode: "station", fp: "" }), false)
    assert.equal(R.waveFinal({ mode: "station", fp: "a", done: { fp: "a" } }), true)
    assert.equal(R.waveFinal({ mode: "station", fp: "a", done: { fp: "b" } }), false)
    assert.equal(R.waveFinal({ mode: "station", fp: "a", commitOk: true }), true)
  })
})
