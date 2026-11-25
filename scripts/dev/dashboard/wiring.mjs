// wiring.mjs — сборка модулей сервера: нижние слои зовут верхние через обёртки late.mjs, здесь им подставляются
// настоящие модули. boot.mjs импортирует этот файл первым — к первому таймеру и запросу всё подключено; тесты, которым
// нужны вызовы вверх, импортируют его же. Список — те, на кого есть late(…): imports.test.mjs проверяет, что ни одна
// обёртка не висит.
import { provide } from "./late.mjs"
import * as accept from "./accept.mjs"
import * as agentsMod from "./agents.mjs"
import * as autochain from "./autochain.mjs"
import * as monitor from "./monitor.mjs"
import * as pipeline from "./pipeline.mjs"
import * as relay from "./relay.mjs"
import * as review from "./review.mjs"
import * as runner from "./runner.mjs"
import * as stations from "./stations.mjs"
import * as snapshot from "./snapshot.mjs"

provide({
  "accept.mjs": accept,
  "agents.mjs": agentsMod,
  "autochain.mjs": autochain,
  "monitor.mjs": monitor,
  "pipeline.mjs": pipeline,
  "relay.mjs": relay,
  "review.mjs": review,
  "runner.mjs": runner,
  "stations.mjs": stations,
  "snapshot.mjs": snapshot,
})
