# Linux: страница как служба systemd

На Linux пускателей нет: сервер запускается командой `node scripts/dev/dashboard/server.mjs`. Чтобы страница поднималась сама после входа и перезагрузки и вставала после падения, удобна пользовательская служба systemd — без `sudo`.

## Служба

`~/.config/systemd/user/dispatcher-dashboard.service`:

```ini
[Unit]
Description=Dispatcher Kit — страница диспетчерской
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/code/dispatcher-kit
# У службы нет окружения вашей оболочки (nvm, ~/.profile): node, npm/pnpm, агент (claude/codex) и инструменты
# проверок проекта должны найтись по этому PATH. Node через nvm — полный путь к версии; обновили Node — поправьте.
Environment=PATH=%h/.nvm/versions/node/v22.0.0/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=DASH_PORT=4777
ExecStart=%h/.nvm/versions/node/v22.0.0/bin/node scripts/dev/dashboard/server.mjs
# По SIGINT сервер снимает деревья прогонов и агентов и дописывает журналы.
KillSignal=SIGINT
TimeoutStopSec=30
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```
systemctl --user daemon-reload
systemctl --user enable --now dispatcher-dashboard
loginctl enable-linger "$USER"     # служба живёт и без открытого сеанса (один раз; может спросить пароль)
journalctl --user -u dispatcher-dashboard -f
```

## Перезапуск

`node tools/restart-dashboard.mjs` по умолчанию поднимает новый сервер отдельным процессом — под службой так нельзя: сервер окажется вне службы. Скажите ему, как перезапускать службу:

```
DASH_PORT=4777 DASH_SERVICE_RESTART="systemctl --user restart dispatcher-dashboard" node tools/restart-dashboard.mjs
```

Он, как обычно, дождётся тишины (прогоны закончатся) и прогонит проверки, а перезапуск сделает командой службы.

## Подводные камни

- **Прокси агента.** Если агент ходит в сеть через прокси, задайте его в настройках агента (для Claude Code — блок `env` в `~/.claude/settings.json`), а не в `Environment=` службы: прокси службы получат и проверки проекта (`npm`, `git`).
- **Окна слотов.** `fleet.mjs open` открывает окна командой `code` — на Linux она есть, если VS Code поставлен из пакета. Агентам терминал не нужен: сервер держит их процессы сам.
