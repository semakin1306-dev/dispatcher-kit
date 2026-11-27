// laptop-view.mjs — экран прогонов на удалённой машине (машина с `view: true` в конфиге machines): тонкий клиент, который
// показывает, что делает эта машина — её прогоны, долю в полном прогоне по частям, очередь диспетчерской, загрузку.
// Устройство (перенесено из внутренней диспетчерской):
//   • HTTP 127.0.0.1:VIEW_PORT (4779), только GET/HEAD, без токена и без действий: / — страница (laptop-view.html),
//     /api/laptop — состояние (laptop-view-rules.mjs), /ping.gif — проба клиента. Host только 127.0.0.1/localhost;
//   • обратный ssh-туннель сюда → машина (-R 127.0.0.1:4779:127.0.0.1:4779), держится с переподключением: машина выключена —
//     проба раз в минуту без шума; порт на машине держит осиротевший сеанс прошлого запуска — он снимается;
//   • клиент на машине: Chromium в режиме приложения открывает локальную страницу-пробу (раз в 5 с ping.gif; есть ответ —
//     рамка с http://127.0.0.1:4779/, нет — «Жду связи»), автозапуск в ~/.config/autostart. Ставит installViewer().
// Дашборд (4777) в сеть не открывается: на машину попадает только этот порт и только для чтения.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { laptopView } from "./laptop-view-rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VIEW_PORT = Number(process.env.DASH_LAPTOP_VIEW_PORT || 4779);
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ControlMaster=no", "-o", "ControlPath=none"];
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

// ── HTTP только для чтения ──
export function viewHandler({ port = VIEW_PORT, state }) {
    let cache = { at: 0, body: "" };
    return (req, res) => {
        const send = (code, body, type = "text/plain; charset=utf-8") => {
            res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
            res.end(req.method === "HEAD" ? undefined : body);
        };
        if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host || ""))
            return send(403, "неверный Host");
        if (req.method !== "GET" && req.method !== "HEAD")
            return send(405, "только чтение");
        const u = new URL(req.url, "http://x");
        try {
            if (u.pathname === "/ping.gif")
                return send(200, GIF, "image/gif");
            if (u.pathname === "/" || u.pathname === "/index.html")
                return send(200, fs.readFileSync(path.join(HERE, "laptop-view.html"), "utf8"), "text/html; charset=utf-8");
            if (u.pathname === "/api/laptop") {
                if (Date.now() - cache.at > 1000)
                    cache = { at: Date.now(), body: JSON.stringify(state()) };
                return send(200, cache.body, "application/json; charset=utf-8");
            }
        }
        catch (e) {
            return send(500, String((e && e.message) || e));
        }
        send(404, "нет такой страницы");
    };
}

// ── обратный туннель: порт на машине ведёт сюда ──
export function keepTunnel({ port = VIEW_PORT, host, log = console } = {}) {
    const st = { up: false, since: 0, err: "", stopped: false, child: null };
    (function keep() {
        if (st.stopped)
            return;
        const t0 = Date.now();
        const c = (st.child = spawn("ssh", [...SSH_OPTS, "-N", "-o", "ExitOnForwardFailure=yes", "-R", `127.0.0.1:${port}:127.0.0.1:${port}`, host], { stdio: ["ignore", "ignore", "pipe"] }));
        let err = "";
        c.stderr.on("data", (d) => { err = (err + d).slice(-300); });
        const ok = setTimeout(() => { st.up = true; st.since = Date.now(); st.err = ""; log.log("экран " + host + ": туннель поднят"); }, 6000);
        let gone = false;
        const again = () => {
            if (gone)
                return;
            gone = true;
            clearTimeout(ok);
            if (st.up)
                log.log("экран " + host + ": туннель упал — переподключаюсь");
            st.up = false;
            st.err = err.trim();
            st.child = null;
            if (st.stopped)
                return;
            // порт на машине держит осиротевший сеанс прошлого запуска: снимаем тот sshd, у которого открыт слушающий сокет порта
            if (/remote port forwarding failed/i.test(err)) {
                const hex = port.toString(16).toUpperCase().padStart(4, "0");
                const sh = [
                    `ino=$(awk '$2 ~ /:${hex}$/ && $4 == "0A" {print $10}' /proc/net/tcp | head -1); [ -n "$ino" ] || exit 0`,
                    `for p in $(pgrep -u "$(id -u)" -f 'sshd'); do ls -l /proc/$p/fd 2>/dev/null | grep -q "socket:.$ino." && kill $p && echo "снят $p"; done; true`,
                ].join("; ");
                execFile("ssh", [...SSH_OPTS, host, sh], { timeout: 20000 }, (_e, out) => {
                    if (out && String(out).trim())
                        st.err += " · " + String(out).trim().replace(/\n/g, ", ");
                    setTimeout(keep, 3000);
                });
                return;
            }
            setTimeout(keep, Date.now() - t0 < 15000 ? 60000 : 5000);
        };
        c.on("error", again);
        c.on("close", again);
    })();
    return {
        state: () => ({ up: st.up, since: st.since, err: st.err }),
        stop: () => { st.stopped = true; try { if (st.child) st.child.kill(); } catch { /* уже нет */ } },
    };
}

// source() → { jobs, shard: shardApi().pub(), tagOf? }
export function startLaptopView({ machine, host, source, port = VIEW_PORT, tunnel = true, log = console } = {}) {
    const tun = tunnel && host ? keepTunnel({ port, host, log }) : null;
    const state = () => ({ ...laptopView({ machine, ...source(), now: Date.now() }), tunnel: tun ? tun.state() : null });
    const srv = http.createServer(viewHandler({ port, state }));
    srv.on("error", (e) => {
        if (e.code !== "EADDRINUSE")
            return log.error("экран " + machine + ":", e.message);
        log.error("экран " + machine + ": порт " + port + " занят — пробую снова через 15 с");
        setTimeout(() => srv.listen(port, "127.0.0.1"), 15000);
    });
    srv.listen(port, "127.0.0.1");
    return { server: srv, tunnel: tun, state, close: () => { if (tun) tun.stop(); srv.close(); } };
}

// ── клиент на машине: страница-проба и автозапуск ──
// snap-Chromium видит файлы только вне скрытых папок, а свою папку common — всегда
const VIEW_BOOT = "snap/chromium/common/dispatcher-machine-view.html";
const AUTOSTART = ".config/autostart/dispatcher-machine-view.desktop";
export const bootHtml = (port = VIEW_PORT) => [
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<title>Прогоны диспетчерской</title>`,
    `<style>:root{--bg:#f3f4f6;--fg:#5b616b}@media (prefers-color-scheme:dark){:root{--bg:#0c0d10;--fg:#9aa0aa}}`,
    `html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:15px system-ui,sans-serif}`,
    `iframe{border:0;width:100%;height:100%;display:none}`,
    `#off{display:flex;flex-direction:column;gap:6px;align-items:center;justify-content:center;height:100%;text-align:center;padding:16px;box-sizing:border-box}</style></head>`,
    `<body><div id="off"><b>Жду связи с диспетчерской</b><small>Окно покажет прогоны, как только основная машина будет на связи.</small></div>`,
    `<iframe id="f" title="Прогоны диспетчерской"></iframe>`,
    `<script>const U="http://127.0.0.1:${port}/",f=document.getElementById("f"),off=document.getElementById("off");let up=false`,
    `function probe(){const i=new Image();`,
    `i.onload=()=>{if(!up){up=true;f.src=U+"?t="+Date.now();f.style.display="block";off.style.display="none"}};`,
    `i.onerror=()=>{if(up){up=false;f.style.display="none";off.style.display="flex"}};i.src=U+"ping.gif?t="+Date.now()}`,
    `probe();setInterval(probe,5000)</script></body></html>`,
    ``,
].join("\n");

/** Положить клиента и автозапуск на машину по ssh и открыть окно в её сеансе. cb(code, вывод). */
export function installViewer(host, cb, { browser = "/snap/bin/chromium", size = "760,820", open = true } = {}) {
    const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
    const exec = `${browser} --app=file://__HOME__/${VIEW_BOOT} --window-size=${size}`;
    const desk = ["[Desktop Entry]", "Type=Application", "Name=Диспетчерская — прогоны", "Comment=Прогоны и очередь диспетчерской на этой машине (только чтение)",
        "Exec=" + exec, "X-GNOME-Autostart-enabled=true", "X-GNOME-Autostart-Delay=8", ""].join("\n");
    const body = ["set -e", `mkdir -p "$HOME/${path.posix.dirname(VIEW_BOOT)}" "$HOME/.config/autostart"`,
        `echo '${b64(bootHtml())}' | base64 -d > "$HOME/${VIEW_BOOT}"`,
        `echo '${b64(desk)}' | base64 -d | sed "s#__HOME__#$HOME#" > "$HOME/${AUTOSTART}"`,
        `echo "файлы: ~/${VIEW_BOOT}, ~/${AUTOSTART}"`,
        ...(open ? [
            // [d] — чтобы pgrep не нашёл сам этот скрипт (строка с именем файла есть в его тексте)
            "pgrep -f '[d]ispatcher-machine-view.html' >/dev/null && { echo 'окно уже открыто'; exit 0; }",
            'export XDG_RUNTIME_DIR=/run/user/$(id -u)',
            `systemd-run --user --collect --quiet ${browser} --app=file://$HOME/${VIEW_BOOT} --window-size=${size} && echo "окно открыто"`,
        ] : [])].join("\n");
    const c = spawn("ssh", [...SSH_OPTS, host, "bash -s"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => cb(code, out.trim()));
    c.stdin.end(body);
}

// node scripts/dev/dashboard/laptop-view.mjs --install-viewer <ssh-хост> — заново положить клиента и автозапуск на машину
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes("--install-viewer")) {
    const host = process.argv[process.argv.indexOf("--install-viewer") + 1];
    if (!host || host.startsWith("-")) {
        console.error("нужен ssh-хост машины: --install-viewer <хост>");
        process.exit(2);
    }
    installViewer(host, (code, out) => { console.log(out); process.exit(code || 0); });
}
