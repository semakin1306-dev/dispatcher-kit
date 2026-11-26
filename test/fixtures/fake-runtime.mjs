// fake-runtime.mjs — общие помощники сквозных тестов: поддельный Claude Code во временной папке и свободный порт.
// Не тест: node --test берёт только *.test.mjs.
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Поддельный claude в папке bin: на Windows — claude.cmd с cli.js рядом (так адаптер запускает обёртку npm), иначе — исполняемый скрипт. */
export function installFakeClaude(bin) {
  fs.mkdirSync(bin, { recursive: true })
  const src = fs.readFileSync(path.join(HERE, "fake-claude.mjs.tpl"), "utf8")
  if (process.platform === "win32") {
    const cli = path.join(bin, "node_modules", "@anthropic-ai", "claude-code", "cli.js")
    fs.mkdirSync(path.dirname(cli), { recursive: true })
    fs.writeFileSync(path.join(bin, "package.json"), '{"type":"module"}\n')
    fs.writeFileSync(path.join(path.dirname(cli), "package.json"), '{"type":"module"}\n')
    fs.writeFileSync(cli, src)
    const cmd = path.join(bin, "claude.cmd")
    fs.writeFileSync(cmd, "@echo off\r\nnode \"%~dp0node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n")
    return cmd
  }
  const f = path.join(bin, "claude")
  fs.writeFileSync(f, src.replace(/^#!.*\n/, "#!" + process.execPath + "\n"))
  fs.chmodSync(f, 0o755)
  return f
}

/** Свободный локальный порт (порт 4777 тесты не трогают). */
export const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)) }) })
