// prompts.mjs — тексты подсказок агентам из файлов scripts/dev/prompts/<имя>.md с подстановкой {{переменных}}.
//
// Длинные подсказки (правила ролей, задания, первичные сообщения) живут отдельными файлами, чтобы их можно было читать и
// править как текст, а не как строку в коде. Логика «какой кусок когда нужен» остаётся в коде модуля: файл — только текст.
//
// Договор файла: UTF-8, LF; последний перевод строки файла в текст не входит (файл кончается переводом строки, как любой текст
// в репозитории). Переменная — {{имя}} из латинских букв и цифр. Неизвестная или непереданная переменная — ошибка сразу при
// сборке подсказки: молча пустое место в подсказке агент не заметит, а человек не увидит.
//
// Без зависимостей от конфига диспетчерской: модуль грузят и хук commit-msg (через commit-rules.mjs), и сервер.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts")
const VAR_RE = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const cache = new Map()

/** Текст файла подсказки как есть (без подстановок), с кешем: файлы не меняются, пока сервер работает. */
export function promptSource(name) {
  if (!NAME_RE.test(String(name))) throw new Error("prompt: недопустимое имя подсказки «" + name + "»")
  let text = cache.get(name)
  if (text === undefined) {
    const raw = fs.readFileSync(path.join(PROMPTS_DIR, name + ".md"), "utf8")
    // CRLF — если копия репозитория получена без .gitattributes; в подсказке переводы строк всегда LF.
    text = raw.replace(/\r\n/g, "\n").replace(/\n$/, "")
    cache.set(name, text)
  }
  return text
}

/** Имена переменных подсказки по порядку первого появления. */
export const promptVars = (name) => [...new Set([...promptSource(name).matchAll(VAR_RE)].map((m) => m[1]))]

/**
 * Подсказка с подстановкой: prompt("orch-trains", { epicCli: "…" }).
 * Значение — строка или число. Переменная в тексте без значения и значение без переменной в тексте — ошибка.
 */
export function prompt(name, vars = {}) {
  const text = promptSource(name), used = promptVars(name)
  const missing = used.filter((k) => !Object.hasOwn(vars, k))
  if (missing.length) throw new Error("prompt «" + name + "»: не переданы переменные " + missing.join(", "))
  const extra = Object.keys(vars).filter((k) => !used.includes(k))
  if (extra.length) throw new Error("prompt «" + name + "»: в тексте нет переменных " + extra.join(", "))
  for (const k of used) {
    const t = typeof vars[k]
    if (t !== "string" && t !== "number") throw new Error("prompt «" + name + "»: переменная " + k + " — " + t + ", нужна строка или число")
  }
  // Одна замена по исходному тексту: значение с «{{…}}» внутри (путь, текст владельца) не раскрывается повторно.
  return text.replace(VAR_RE, (_, k) => String(vars[k]))
}
