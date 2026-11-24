// Поддельный ssh для тестов модуля машин: node-скрипт во временной папке разбирает ключи ssh, пишет вызов в журнал и
// выполняет команду через bash в папке «удалённой» машины (она же её HOME). git push идёт через него же
// (GIT_SSH_COMMAND модуля машин). FAKE_SSH_FAIL=1 — машина недоступна: код 255 и строка ssh о таймауте.
import fs from "node:fs";
import path from "node:path";

const fwd = (p) => p.split("\\").join("/");

/** bash для поддельной машины: на Windows — Git Bash в обычных местах, иначе bash из PATH; "" — нет. */
export const FAKE_BASH = process.platform === "win32" ? ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe"].find((p) => fs.existsSync(p)) || "" : "bash";

const SCRIPT = `import { spawn } from "node:child_process";
import fs from "node:fs";
const a = process.argv.slice(2), val = new Set(["-o","-p","-i","-l","-F","-J","-E","-c","-m","-b","-D","-L","-R","-S","-W","-w"]);
let i = 0;
for (; i < a.length; i++) { if (a[i] === "--") { i++; break } if (a[i].startsWith("-")) { if (val.has(a[i])) i++; continue } break }
const host = a[i], cmd = a.slice(i + 1).join(" ");
fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ host, cmd, batch: a.includes("BatchMode=yes") }) + "\\n");
if (process.env.FAKE_SSH_FAIL) { process.stderr.write("ssh: connect to host " + host + " port 22: Connection timed out\\n"); process.exit(255) }
const c = spawn(process.env.FAKE_SSH_BASH, ["-c", cmd], { cwd: process.env.FAKE_SSH_HOME, env: { ...process.env, HOME: process.env.FAKE_SSH_HOME }, stdio: "inherit" });
c.on("close", (code) => process.exit(code ?? 255));
`;

/**
 * Поставить поддельный ssh в папку tmp → { ssh: { file, pre } для createMachinesApi, home — папка машины, log, calls() }.
 * Переменные FAKE_SSH_* ставятся в process.env: их наследуют и ssh модуля, и git push.
 */
export function fakeSsh(tmp) {
    const file = path.join(tmp, "fake-ssh.mjs"), home = path.join(tmp, "home"), log = path.join(tmp, "ssh.log");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, SCRIPT);
    Object.assign(process.env, { FAKE_SSH_LOG: log, FAKE_SSH_BASH: FAKE_BASH, FAKE_SSH_HOME: fwd(home) });
    const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
    return { ssh: { file: process.execPath, pre: [fwd(file)] }, home, log, calls };
}
