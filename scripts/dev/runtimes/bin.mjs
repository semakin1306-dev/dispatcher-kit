// runtimes/bin.mjs — как найти бинарник агента: одно правило для всех рантаймов и для `doctor`.
//
// `agent.bin` в конфиге уже развёрнут (project.mjs, agentBinPath): путь — абсолютный, голое имя (`claude`) — имя в PATH.
// Пусто — ищется имя рантайма. На Windows обёртку npm (`.cmd`) без оболочки не запустить — тогда берётся её скрипт и node;
// файл без расширения в PATH там — сценарий оболочки для bash, а не программа.
import fs from "node:fs"
import path from "node:path"
import { isBareCommand } from "../project.mjs"
import { whichBin } from "../../../setup/detect.mjs"

/** Имя в PATH и скрипт пакета npm рядом с обёрткой `.cmd` (от её папки). */
export const AGENT_BINS = {
  claude: { name: "claude", script: ["node_modules", "@anthropic-ai", "claude-code", "cli.js"] },
  codex: { name: "codex", script: ["node_modules", "@openai", "codex", "bin", "codex.js"] },
}

/**
 * Как запускать агента рантайма rt. bin — `agent.bin` из конфига.
 * @returns {{cmd:string, pre:string[]}|null}
 */
export function findAgentBin(rt, { bin = "", env = process.env, platform = process.platform } = {}) {
  const spec = AGENT_BINS[rt]
  if (!spec) throw new Error("неизвестный рантайм агента: " + rt)
  const viaCmd = (file) => {
    const js = path.join(path.dirname(file), ...spec.script)
    return fs.existsSync(js) ? { cmd: process.execPath, pre: [js] } : null
  }
  const wrap = (file) => (platform === "win32" && /\.(cmd|bat)$/i.test(file) ? viaCmd(file) : { cmd: file, pre: [] })
  if (bin && !isBareCommand(bin)) return wrap(bin)
  const name = bin || spec.name
  if (platform !== "win32" || /\.[A-Za-z0-9]+$/.test(name)) {
    const p = whichBin(name, env, platform)
    return p ? wrap(p) : null
  }
  const exe = whichBin(name + ".exe", env, platform)
  if (exe) return { cmd: exe, pre: [] }
  const cmd = whichBin(name + ".cmd", env, platform)
  return cmd ? viaCmd(cmd) : null
}
