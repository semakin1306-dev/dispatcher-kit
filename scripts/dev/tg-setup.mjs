#!/usr/bin/env node
// tg-setup.mjs — подключение бота в Telegram к диспетчерской (модуль `tg`).
// Запускает человек в обычном терминале из папки диспетчерской:   node scripts/dev/tg-setup.mjs
//   1. спрашивает токен бота скрытым вводом (токен выдаёт @BotFather);
//   2. просит написать боту /start и берёт chat_id и user id из getUpdates — бот будет принимать нажатия ТОЛЬКО от них;
//   3. шлёт в этот чат проверочное сообщение;
//   4. кладёт токен в хранилище секретов (secrets.mjs: на Windows — DPAPI, иначе файл с правами 0600), открытое — в tg.meta.json.
// Токен не печатается, не пишется в журналы и не уходит в командную строку. Работающая диспетчерская подхватывает его сама.
// Ключи: --data <папка данных> (по умолчанию — из конфига проекта или DASH_DATA), --proxy <http://хост:порт> (как DASH_TG_PROXY),
// --wait <сек> (сколько ждать /start, 300), --store file|dpapi (куда класть токен).
// Пока бот диспетчерской включён (settings.tgBot), getUpdates читает он — утилита увидит 409: выключите «Telegram» на странице.
import fs from "node:fs";
import path from "node:path";

const arg = (k, d) => {
    const i = process.argv.indexOf(k);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    process.exit(0);
}
const WAIT_S = Number(arg("--wait", "300")) || 300;
if (arg("--proxy", ""))
    process.env.DASH_TG_PROXY = arg("--proxy", "");
// config.mjs читает DASH_DATA при загрузке — пути берём из него же, чтобы не разойтись с сервером
if (arg("--data", ""))
    process.env.DASH_DATA = path.resolve(arg("--data", ""));
const { DATA } = await import("./dashboard/config.mjs");
const { writeAtomicSync } = await import("./dashboard/store.mjs");
const { BOT_ABOUT, redact } = await import("./dashboard/tg-rules.mjs");
const { TG_META, TG_SECRET, tgProxy, tgRequest } = await import("./dashboard/tg.mjs");
const { envName, setSecret } = await import("./dashboard/secrets.mjs");

/** Скрытый ввод: в терминале — без эха (звёздочки), из канала — строка stdin. */
function askHidden(prompt) {
    return new Promise((res, rej) => {
        process.stdout.write(prompt);
        const inp = process.stdin;
        if (!inp.isTTY) {
            let s = "";
            inp.setEncoding("utf8");
            inp.on("data", (c) => { s += c; });
            inp.on("end", () => res(s.trim()));
            return;
        }
        let s = "";
        inp.setRawMode(true);
        inp.resume();
        inp.setEncoding("utf8");
        const done = (v) => {
            inp.setRawMode(false);
            inp.pause();
            inp.removeListener("data", on);
            process.stdout.write("\n");
            v === null ? rej(new Error("прервано")) : res(v.trim());
        };
        const on = (c) => {
            for (const ch of c) {
                if (ch === "\r" || ch === "\n")
                    return done(s);
                if (ch === "\u0003")
                    return done(null);
                if (ch === "\u007f" || ch === "\b") {
                    if (s) {
                        s = s.slice(0, -1);
                        process.stdout.write("\b \b");
                    }
                    continue;
                }
                if (ch >= " ") {
                    s += ch;
                    process.stdout.write("*");
                }
            }
        };
        inp.on("data", on);
    });
}

let tok = null; // для вычистки из текста ошибки (tgRequest вычищает и сам)
const main = async () => {
    console.log("Подключение бота в Telegram к диспетчерской. Данные: " + DATA);
    const token = await askHidden("Токен бота (ввод скрыт): ");
    tok = token;
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token))
        throw new Error("это не похоже на токен бота (вид 123456789:AA…)");
    const proxy = tgProxy();
    console.log("Связь с api.telegram.org: " + (proxy ? "через прокси " + proxy : "напрямую") + " (DASH_TG_PROXY / --proxy)");
    const call = (method, params = {}, timeoutMs = 20000) => tgRequest({ token, method, params, proxy, timeoutMs });
    // старые обновления (прошлые /start) пропускаем: offset = последний + 1; неверный токен — отказ уже здесь
    let offset = 0, found = null;
    const old = await call("getUpdates", { timeout: 0, allowed_updates: ["message"] });
    if (old.length)
        offset = old[old.length - 1].update_id + 1;
    console.log("Токен принят. Напишите боту в Telegram /start с того аккаунта, с которого будете отвечать (жду " + WAIT_S + " с)…");
    const until = Date.now() + WAIT_S * 1000;
    while (!found && Date.now() < until) {
        const ups = await call("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }, 40000);
        for (const u of ups) {
            offset = u.update_id + 1;
            const m = u.message;
            if (m && /^\/start\b/.test(String(m.text || "")) && m.chat && m.from && !m.from.is_bot)
                found = m;
        }
    }
    if (!found)
        throw new Error("за " + WAIT_S + " с /start не пришёл");
    if (found.chat.type !== "private")
        console.log("⚠ /start пришёл из группового чата «" + (found.chat.title || found.chat.id) + "»: бот будет принимать нажатия только от вас и только в этом чате.");
    await call("getUpdates", { offset, timeout: 0 }); // подтвердить прочитанное: диспетчерская не увидит этот /start заново
    const meta = {
        chatId: found.chat.id,
        userId: found.from.id,
        user: found.from.username
            ? "@" + found.from.username
            : [found.from.first_name, found.from.last_name].filter(Boolean).join(" "),
        chatType: found.chat.type,
        at: new Date().toISOString(),
    };
    fs.mkdirSync(DATA, { recursive: true });
    const w = await setSecret(TG_SECRET, token, arg("--store", "") ? { store: arg("--store", "") } : {});
    writeAtomicSync(TG_META, JSON.stringify(meta, null, 1));
    await call("sendMessage", { chat_id: meta.chatId, text: "✅ Диспетчерская подключена. " + BOT_ABOUT });
    console.log(
        "Готово: chat_id " +
            meta.chatId +
            ", user id " +
            meta.userId +
            " (" +
            meta.user +
            "). Токен — " +
            (w.where === "dpapi" ? "в хранилище Windows (DPAPI)" : "в файле с правами владельца") +
            ": " +
            w.file +
            "; открытое — в " +
            TG_META +
            ".",
    );
    if (w.shadowedByEnv)
        console.log("⚠ Задана переменная " + envName(TG_SECRET) + ": диспетчерская возьмёт токен из неё, а не из записи.");
    console.log("Дальше: включите «Telegram» на странице (settings.tgBot); модуль `tg` должен быть включён в dispatcher.project.json.");
};
main().then(() => process.exit(0)).catch((e) => {
    console.error(
        "✗ " +
            redact(e.message, tok) +
            (e.tgCode === 409
                ? " — getUpdates сейчас читает кто-то ещё (бот диспетчерской включён?): выключите «Telegram» на странице и повторите"
                : e.tgCode === 401 || e.tgCode === 404
                  ? " — токен не принят Telegram"
                  : ""),
    );
    process.exit(1);
});
