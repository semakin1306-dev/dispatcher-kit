import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { RULES, scanText, parseDenylist, scanRepo, licenseAllow, ALLOW_MARK, DENYLIST_NAME } from "./publish-check.mjs"

const SCRIPT = fileURLToPath(new URL("./publish-check.mjs", import.meta.url))
const ids = (text, rules = RULES) => scanText(text, rules).map((f) => f.rule)
// Образцы собираются из кусков: целиком в исходнике они бы сами попали под ворота.
const j = (...parts) => parts.join("")

function repoWith(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dk-gate-"))
  execFileSync("git", ["init", "-q", "-b", "main", root])
  for (const [rel, text] of Object.entries(files)) { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
  return root
}
const cli = (root, ...args) => spawnSync(process.execPath, [SCRIPT, "--root=" + root, ...args], { encoding: "utf8" })

test("IP-адреса: чужие ловятся, локальные и учебные — нет", () => {
  assert.deepEqual(ids(j("host ", "8.8", ".8.8")), ["ipv4"])
  assert.deepEqual(ids(j("lan ", "192.168", ".1.20")), ["ipv4"])
  assert.deepEqual(ids("http://127.0.0.1:4777 0.0.0.0 192.0.2.10 198.51.100.7 203.0.113.9"), [])
  assert.deepEqual(ids("версия 22.11.0, шаг 1.2.3"), [], "три части — не адрес")
  assert.deepEqual(ids("1.2.3.4.5"), [], "пять частей — не адрес")
})

test("домашние папки: настоящие имена ловятся, заглушки — нет", () => {
  assert.deepEqual(ids(j("C:", "\\Users\\", "ivan\\code")), ["home-win"])
  assert.deepEqual(ids(j("c:/", "Users/", "ivan/code")), ["home-win"])
  assert.deepEqual(ids(j("/ho", "me/ivan/app")), ["home-posix"])
  assert.deepEqual(ids(j("/Us", "ers/ivan/app")), ["home-posix"])
  assert.deepEqual(ids("C:/Users/<имя>/x /home/user/x /home/$USER/x C:\\Users\\%USERNAME%\\x"), [])
})

test("почта: настоящая ловится, учебная и noreply — нет", () => {
  assert.deepEqual(ids(j("ivan", "@", "mail.org")), ["email"])
  assert.deepEqual(ids("a@example.com b@demo.invalid noreply@anthropic.com 1+x@users.noreply.github.com"), [])
})

test("ключи и токены ловятся по виду", () => {
  assert.deepEqual(ids(j("-----BEGIN RSA ", "PRIVATE KEY-----")), ["key-private"])
  assert.deepEqual(ids(j("sk-", "ant-", "a".repeat(30))), ["key-anthropic"])
  assert.deepEqual(ids(j("gh", "p_", "A".repeat(36))), ["key-github"])
  assert.deepEqual(ids(j("123456789", ":", "A".repeat(35))), ["key-telegram"])
  assert.deepEqual(ids(j("AK", "IA", "B".repeat(16))), ["key-aws"])
  assert.deepEqual(ids("sk-ant-short ghp_short 12345:abc"), [])
})

test("частные слова: подстрока без учёта регистра и регулярка; комментарии и пустые строки пропускаются", () => {
  const rules = parseDenylist("# проекты\nAcmeCorp\n\n/build-box-\\d+/\n")
  assert.equal(rules.length, 2)
  assert.deepEqual(ids("сервер acmecorp и BUILD-box-7", rules), ["private"])
  assert.deepEqual(ids("сервер build-box-7 готов", rules), ["private"])
  assert.deepEqual(ids("ничего частного", rules), [])
  assert.deepEqual(ids("a.b", parseDenylist("a.b")), ["private"])
  assert.deepEqual(ids("axb", parseDenylist("a.b")), [], "точка в подстроке — буквальная")
})

test("пометка снимает находку только со своей строки", () => {
  const sample = j("8.8", ".8.8")
  assert.deepEqual(ids(`${sample} // ${ALLOW_MARK}: пример в документации\n${sample}`), ["ipv4"])
  assert.equal(scanText(`ok\n${sample}`, RULES)[0].line, 2)
})

test("репозиторий: смотрятся отслеживаемые и новые файлы, игнорируемые и двоичные — нет; имя файла тоже проверяется", () => {
  const bad = j("8.8", ".8.8")
  const root = repoWith({
    "a.txt": "чисто\n", "b.txt": "строка\nадрес " + bad + "\n", ".gitignore": "ignored.txt\n", "ignored.txt": bad,
    "bin.dat": Buffer.from([1, 0, 2, 0]), [j("notes-ivan", "@", "mail.org", ".md")]: "текст\n",
  })
  const r = scanRepo({ root })
  assert.equal(r.files, 4)
  assert.deepEqual(r.skipped, ["bin.dat (двоичный)"])
  assert.deepEqual(r.findings.map((f) => [f.file.slice(0, 5), f.line, f.rule]), [["b.txt", 2, "ipv4"], ["notes", 0, "email"]])
})

test("запуск: чисто → 0; находка → 1 и возвращается обратно в 0 после правки", () => {
  const root = repoWith({ "a.txt": "чисто\n", [DENYLIST_NAME]: "acmecorp\n", ".gitignore": DENYLIST_NAME + "\n" })
  const clean = cli(root)
  assert.equal(clean.status, 0, clean.stderr); assert.match(clean.stdout, /чисто — файлов 2, частных слов 1/)
  fs.writeFileSync(path.join(root, "a.txt"), "проект AcmeCorp\n")
  const red = cli(root)
  assert.equal(red.status, 1); assert.match(red.stderr, /a\.txt:1: \[private\]/)
  fs.writeFileSync(path.join(root, "a.txt"), "проект\n")
  assert.equal(cli(root).status, 0)
})

test("запуск: нет списка частных слов — отказ локально, допустимо в CI; пустой список — отказ", () => {
  const root = repoWith({ "a.txt": "чисто\n" })
  const local = cli(root)
  assert.equal(local.status, 1); assert.match(local.stderr, /Нет списка частных слов/)
  const ci = cli(root, "--ci")
  assert.equal(ci.status, 0, ci.stderr); assert.match(ci.stdout, /режим CI/)
  fs.writeFileSync(path.join(root, DENYLIST_NAME), "# пусто\n")
  assert.equal(cli(root).status, 1)
})

test("запуск: пустой репозиторий не проходит — ворота без файлов ничего не проверили", () => {
  const root = repoWith({})
  const r = cli(root, "--ci")
  assert.equal(r.status, 1); assert.match(r.stderr, /ни одного файла/)
})

test("LICENSE: частное слово снимается только в строке правообладателя корневого LICENSE; в других строках и файлах ловится", () => {
  const holder = j("Ак", "ме", "корп"), deny = parseDenylist(holder.toLowerCase() + "\n")
  const lic = (copyright, extra = "") => ["MIT License", "", copyright, "", "Permission is hereby granted, free of charge…" + extra, ""].join("\n")
  const root = repoWith({
    LICENSE: lic("Copyright (c) 2026 " + holder, " " + holder),
    "README.md": "© " + holder + "\n", "docs/LICENSE": lic("Copyright (c) 2026 " + holder),
  })
  const f = scanRepo({ root, extraRules: deny }).findings.map((x) => [x.file, x.line, x.rule])
  assert.deepEqual(f, [["LICENSE", 5, "private"], ["README.md", 1, "private"], ["docs/LICENSE", 3, "private"]], "строка 3 корневого LICENSE — единственная разрешённая")
  // только первая строка правообладателя; почта в ней ловится как везде
  const two = "Copyright (c) 2026 " + holder + "\nCopyright (c) 2027 " + holder + "\n"
  assert.deepEqual(scanText("LICENSE\n" + two, deny, licenseAllow("LICENSE", "LICENSE\n" + two)).map((x) => x.line), [3])
  const mail = "LICENSE\nCopyright (c) 2026 " + holder + " " + j("ivan", "@", "mail.org") + "\n"
  assert.deepEqual(scanText(mail, [...RULES, ...deny], licenseAllow("LICENSE", mail)).map((x) => x.rule), ["email"])
  assert.equal(licenseAllow("README.md", "Copyright (c) 2026 " + holder), null, "у других файлов разрешений нет")
  assert.equal(licenseAllow("LICENSE", "LICENSE\nMIT License\n"), null, "нет строки правообладателя — нет и разрешения")
})

test("запуск: общие шаблоны работают и в CI", () => {
  const root = repoWith({ "a.txt": j("ключ sk-", "ant-", "z".repeat(40)) + "\n" })
  const r = cli(root, "--ci")
  assert.equal(r.status, 1); assert.match(r.stderr, /key-anthropic/)
})
