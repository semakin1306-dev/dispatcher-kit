// claude-policy.mjs — запреты проекта в формате прав Claude Code (settings.local.json → permissions.deny / ask).
// Запреты в конфиге проекта записаны нейтрально (`deny` в dispatcher.project.json); в свой формат их переводит
// рантайм агента. Этот файл — перевод для Claude Code.
//
// Команда в `deny.commands` и `deny.ask` — начало командной строки: «git push» закрывает и `git push origin x`.
// С `=` в начале — команда целиком: «=git add .» закрывает ровно `git add .`, но не `git add .gitignore`.

const commandRule = (c) => c.startsWith("=") ? `Bash(${c.slice(1)})` : `Bash(${c}:*)`

/**
 * @param deny нормализованный раздел `deny` конфига проекта: { commands, edit, read, ask }
 * @returns {{deny:string[], ask:string[]}} правила в записи Claude Code
 */
export function toClaudeRules(deny) {
  return {
    deny: [...deny.commands.map(commandRule), ...deny.edit.map((g) => `Edit(${g})`), ...deny.read.map((g) => `Read(${g})`)],
    ask: deny.ask.map(commandRule),
  }
}
