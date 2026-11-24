# Рецепты

Рецепт — описание того, как подогнать диспетчерскую под свой проект, когда стартовой настройки мало: когда нужен, что сделать, какие ключи `dispatcher.project.json` или какие функции `dispatcher.project.mjs` за это отвечают, где подводные камни.

Код-надстройка `dispatcher.project.mjs` лежит рядом с конфигом и экспортирует только функции из закрытого списка: `buildSteps`, `slotPrepare`, `remoteCmd`, `parseOutput`. Другой экспорт диспетчерская не использует и предупреждает о нём в `node setup.mjs doctor`. Файл читается при старте сервера: после правки сервер нужно перезапустить (`node tools/restart-dashboard.mjs`).

Примеры конфига в рецептах — для вымышленного проекта `demo-shop` (областей две: `api` и `web`), как в `test/fixtures/project.demo.json`. После любой правки конфига — `node setup.mjs doctor`.

| Рецепт | Ключи и функции |
|---|---|
| [Свой разбор вывода тестов](parse-output.md) | `tasks.*.parser`, `parseOutput` |
| [Подготовка слота и сборка ветки](slot-prepare.md) | `slotPrepare`, `areas.*.build`, задача `build`, `slotPrepare()`, `buildSteps()` |
| [Службы для тестов: БД, Redis](test-services.md) | `machines.*.services` |
| [Удалённая машина прогонов](remote-machine.md) | `machines.*`, `tasks.*.lane`, `remoteCmd()` |
| [Приёмка на стенде](stand-acceptance.md) | `accept.run`, `accept.specGlob`, `accept.standUrl` |
| [Выкат стенда и прода, проверка после выката](release.md) | `release.stand`, `release.prod`, папка `_main` |
| [Агент на удалённой машине](remote-agent.md) | — (не входит в ядро) |
| [Граф знаний и разведка перед волной](knowledge-graph.md) | — (идея) |
| [Телеграм-бот](telegram.md) | `modules.tg`, `scripts/dev/tg-setup.mjs` |
| [Codex вместо Claude Code](codex.md) | `agent.runtime`, `agent.network`, `agent.bin` |
