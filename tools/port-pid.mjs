// port-pid.mjs — кто слушает локальный порт: pid процесса или null (порт свободен). Общий помощник перезапуска и сторожа.
// Windows — netstat -ano; Linux и macOS — lsof, без него — ss (Linux). Порт занят, а владельца не узнать — -1.
import { execFileSync } from "node:child_process"
import net from "node:net"

/** Порт отвечает на подключение? */
export const portOpen = (port, ms = 1500) => new Promise((res) => {
  const s = net.connect(Number(port), "127.0.0.1"); s.setTimeout(ms)
  s.on("connect", () => { s.destroy(); res(true) }); s.on("error", () => res(false)); s.on("timeout", () => { s.destroy(); res(false) })
})

const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 8000 }) } catch (e) { return e && e.stdout ? String(e.stdout) : "" } }

/** Разбор вывода `netstat -ano -p tcp`: pid слушающего порт или null. */
export function netstatPid(out, port) {
  const re = new RegExp("TCP\\s+\\S+:" + port + "\\s+\\S+\\s+LISTENING\\s+(\\d+)")
  const m = String(out || "").split(/\r?\n/).map((l) => re.exec(l)).find(Boolean)
  return m ? Number(m[1]) : null
}

/** Разбор `ss -ltnpH`: pid слушающего порт или null. */
export function ssPid(out, port) {
  for (const l of String(out || "").split(/\r?\n/)) {
    if (!new RegExp("[:.]" + port + "\\s").test(l)) continue
    const m = /pid=(\d+)/.exec(l); if (m) return Number(m[1])
  }
  return null
}

/** pid процесса, слушающего порт на этой машине; null — порт свободен; -1 — занят, владельца не узнать. */
export async function portPid(port) {
  if (process.platform === "win32") return netstatPid(run("netstat", ["-ano", "-p", "tcp"]), port) ?? ((await portOpen(port)) ? -1 : null)
  const lsof = run("lsof", ["-nP", "-iTCP:" + port, "-sTCP:LISTEN", "-t"]).trim().split(/\s+/).filter(Boolean)[0]
  if (lsof) return Number(lsof)
  const ss = ssPid(run("ss", ["-ltnpH"]), port)
  if (ss) return ss
  return (await portOpen(port)) ? -1 : null
}
