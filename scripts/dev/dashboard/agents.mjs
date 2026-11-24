// agents.mjs — агенты диспетчерской: оркестраторы эпиков, исполнители слотов и агент бэклога. Запуск и остановка процесса агента
// через адаптер рантайма, лента событий для страницы, решения по запросам разрешений, системная подсказка роли, сессии и их
// продолжение, возобновление после перезапуска, копилка сведений оркестратору, ротация его контекста. Протокол конкретного
// рантайма здесь не собирается — только через runtimes/.
//
// Остальные модули говорят с агентом функциями отсюда: sendUserText, deliver, sendWhenFree, interruptAgent, setAgentModel,
// answerPermission, stopAgent. Изменяемое состояние — S (state.mjs): этот модуль владеет полями agentSessions и orchHeld.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ownerSaid } from "./orchlog.mjs"
import { EPIC_CLI, EPIC_FILE, HOME, MAIN, PERSONA_PATH, PROJECT, REMOTE, WT, fwd } from "../slots.mjs"
import { ORCH_ROTATE_TOKENS, orchWake, rotateDue } from "./loops.mjs"
import { execFile, killTree, spawn } from "./spawner.mjs"
import { readJson, saveJson } from "./store.mjs"
import { S } from "./state.mjs"
import { jobList } from "./jobs.mjs"
import { DATA, DRY, FINAL, HERE, logEvent, settings, short, sleep } from "./config.mjs"
import { ORCH_TRAINS_RULE, isTrain, normWave, trainCommitWaves } from "./train-rules.mjs"
import { TREES, epicById, epicOfKey, isOrch, openEpics, orchOfKey, treeByKey, trainWaveOf } from "./trees.mjs"
import { exists } from "./git.mjs"
import { late } from "./late.mjs"
import { kick, touchSnap } from "./snapshot.mjs"
import { agentChanged, bumpVer } from "./events.mjs"
import { noteFetch } from "./digest-ledger.mjs"
import { orchPrimer, toolsSection } from "./prompt.mjs"
import { brief } from "./epic-journal.mjs"
import { selfCommitMode, selfCommitOn, selfCommitRule } from "./commit-rules.mjs"
import { slotEnvNote } from "./slot-rules.mjs"
import { turnAct } from "./epic-progress-rules.mjs"
import { BACKLOG_WT, backlogAgentOpts, backlogPerm, backlogPrompt, isBacklogKey, orchBacklog, prepareBacklogTree } from "./backlog-agent.mjs"
import { bashAllowed as policyBashAllowed, bashDenyWhy as policyBashDenyWhy, decide, gitNightRe, guardedBash } from "./agent-policy.mjs"
import { enabled } from "./modules.mjs"
import { proxyEnv, runtime } from "../runtimes/index.mjs"
import { installSlotHooks, writeSlotWave } from "../hooks/commit-msg.mjs"

// Агенты — нижний слой: их импортируют почти все модули. Что агент зовёт наверх (перехват ответа, разбор хода, заметки ревью,
// память машины, снимок) — поздней привязкой: те модули сами импортируют этот.
const { captureReply } = late("accept.mjs", ["captureReply"])
const { memInfo } = late("monitor.mjs", ["memInfo"])
const { forgetRelayFacts, inboxAfterTurn } = late("relay.mjs", ["forgetRelayFacts", "inboxAfterTurn"])
const { recentNotes } = late("review.mjs", ["recentNotes"])
const { snapNow } = late("snapshot.mjs", ["snapNow"])

// Процесс агента стартует по требованию и после AGENT_IDLE_MIN минут без сообщений останавливается (сессия остаётся на диске и
// продолжается при следующем сообщении); запуск при нехватке памяти отказывает.
export const AGENTS_FILE = path.join(DATA, "agents.json")
export const AGENT_IDLE_MIN = Number(process.env.DASH_AGENT_IDLE_MIN) || 1440

/** Модели ролей из конфига проекта (`agent.models`); пусто — умолчание рантайма. */
export const DEFAULT_MODEL = { orch: PROJECT.agent.models.orch || "", slot: PROJECT.agent.models.slot || "", review: PROJECT.agent.models.review || "" }
/** Модель агента: выбор в чате → настройки страницы → конфиг проекта. Агент бэклога — как оркестратор, если не задан свой. */
export const modelFor = (key, model = "") => String(model || "").trim() || process.env.DASH_TEST_MODEL ||
  (isBacklogKey(key) ? settings.modelBacklog || settings.modelOrch || DEFAULT_MODEL.orch : isOrch(key) ? settings.modelOrch || DEFAULT_MODEL.orch : settings.modelSlot || DEFAULT_MODEL.slot)

export const PROMPTS_DIR = path.join(WT, "_workspaces", "prompts")
export const PERSONA_FILE = PERSONA_PATH
const WAVES_REL = path.join(".claude", "plans", "waves")
const readPersona = () => { try { return fs.readFileSync(PERSONA_FILE, "utf8") } catch { return "" } }
const moduleOn = (id) => { try { return enabled(id) } catch { return false } }

/**
 * Стартовое сообщение слота без готового промпта: персона инженера слота и план волны — план и есть бриф.
 * Общие правила — первыми и одинаковыми у всех слотов; метки слота, ветка и план — в конце.
 */
export function genSlotPrompt(key) {
  const x = slotOf(key); if (!x) return null
  const ot = TREES.find((t) => t.kind === "orch" && t.epic === epicOfKey(key)) || TREES.find((t) => t.kind === "orch"), orch = ot && ot.path; if (!orch) return null
  const waves = path.join(orch, WAVES_REL), num = (/wv-(\d{4})/i.exec(x.branch || "") || [])[1] || trainWaveOf(key).slice(3) // поезд — план вагона в работе
  const plan = num && fs.existsSync(waves) ? fs.readdirSync(waves).find((f) => f.startsWith("WV-" + num) && f.endsWith(".md")) : null
  const persona = readPersona().split(/\r?\n---\r?\n/).slice(1).join("\n---\n").trim()
  const planPath = plan ? fwd(path.join(waves, plan)) : null
  const task = [
    "Решения с пометкой ✅ подтверждены владельцем, по ним работай. Решения без ✅ — предложения: если у решения есть рекомендация плана или очевидный вариант, работай по нему и перечисли в докладе строкой «По умолчанию:»; если станция без ответа встаёт — вынеси вопрос в доклад и делай всё остальное в том же ходе.",
    "Работаешь только в границах «Манифеста слота». Порядок — по станциям плана подряд, в одном ходе: сверка «Что было» плана с кодом (противоречие — СТОП или ВОПРОС до правок), красный тест, код, спека приёмки. Доклад — один, в конце: когда сделано всё, что можно без чужого решения (тесты запустит диспетчерская по разделу «Тесты для запуска владельцем»), или когда заблокирован каждый оставшийся кусок. Промежуточных докладов по станциям не шли: доклад заканчивает ход, и волна ждёт очереди оркестратора.",
    selfCommitRule(selfCommitMode(settings)),
    "Общие правила сессий: `" + fwd(path.join(waves, "agent-briefs", "SESSIONS-common-rules.md")) + "` — прочитай.",
    "Ты — исполнитель слота `" + x.slot + "`" + (num ? ", волна WV-" + num : "") + ". Рабочая папка `" + fwd(path.join(WT, x.slot)) + "`, ветка `" + x.branch + "` от `staging`. Окружение поднято диспетчерской.",
    planPath ? "**Твой бриф — план волны `" + planPath + "`.** Отдельного брифа не будет: прочитай план целиком (источник, «Что было», устройство, «Решения», «Станции», «Манифест слота», «Не делаем»)." : "Плана волны в папке эпика не нашлось: ответь блоком со статусом ВОПРОС и попроси оркестратора назвать файл плана.",
  ].join("\n\n")
  return (persona ? persona + "\n\n=====\nЗАДАЧА СЛОТА\n=====\n\n" : "") + task + "\n"
}

const AFTER_DEPLOY = "ПОСЛЕ ВЫКАТА. Если после выката staging на стенд нужно выполнить скрипт (наполнение данными, перенос данных, уборка), напиши отдельной строкой «ПОСЛЕ ВЫКАТА: что и зачем :: <команда>» — у владельца появится карточка-напоминание с кнопкой запуска на стенде; просить его «не забыть» словами не нужно."

/** Правила оркестратора: постоянные — первыми; эпик и список слотов (меняются с новыми волнами) — последним абзацем. */
function orchSystemPrompt(key) {
  const EPIC = epicById(epicOfKey(key)) || { id: epicOfKey(key), slots: [] }
  const live = EPIC.slots.filter((x) => !x.archived), slots = live.map((x) => x.tag + " = слот " + x.slot + " (" + x.title + ", ветка " + x.branch + ")").join("; ")
  return [
    "Ты оркестратор эпика и работаешь внутри диспетчерской владельца; эпик и его слоты-исполнители — в последнем абзаце.",
    "ПЕРЕДАЧА СЛОТАМ. Владелец не должен переписывать твои указания слотам вручную. Всё, что адресовано слоту, пиши ОТДЕЛЬНЫМ блоком кода, а в первой строке открывающих кавычек укажи язык «slot:П4» (или «slot:П2» и т. д.). Пример: три обратные кавычки и сразу slot:П4, затем текст указания, затем три обратные кавычки. Диспетчерская САМА отправит блок слоту (автопоезд), а если слот занят — поставит в очередь. Кнопка «→ П4» над блоком — только запасной путь, когда автопередача выключена; владельца нажимать её не проси и не упоминай. Один блок на слот. Внутри блока пиши только то, что должен узнать и сделать слот: без обращений к владельцу, без пересказа процесса, без секретов.",
    "Блок для слота должен быть самодостаточным: что изменилось и почему слот может продолжать, что именно делать, что НЕ делать, чего ждать от тебя дальше. Не требуй от слота ждать «волшебной фразы»: если снято часть блокеров, прямо скажи, с чего начинать.",
    "КОНФЛИКТЫ ВЕТОК ПО ОБЩИМ ФАЙЛАМ решаешь ты, а не владелец. Диспетчерская сама находит пары веток эпика, которые трогают одни файлы, и показывает карточку «Порядок: ПN и ПM» (конфликт слияния или общий код). Порядок ставишь ТЫ отдельной строкой: «ПОРЯДОК ПM ПОСЛЕ ПN» (ПM вливается после ПN; диспетчерская запишет в реестр, как кнопка карточки) или «ПОРЯДОК ПN ПM НЕ СВЯЗАНЫ» (общий код без столкновения правок). Как выбирать: 1) первой идёт ветка, которая дальше по станциям и ближе к влитию (ревью «ЗА», регресс зелёный), вторая — после; при равенстве первой — меньшая по объёму правок в общих файлах. 2) Порядок проверяй на циклы: если ПN уже после ПM, обратное не пиши. 3) Сразу после строки ПОРЯДОК дай второй ветке блок slot:ПM: «после влива ПN: git merge staging в свою ветку, разреши конфликт, перегенерируй общие файлы, прогони гарды». ПРАВИЛА ПО ВИДАМ ОБЩИХ ФАЙЛОВ: • базовые линии и списки допусков гардов (заморозки долга, «baseline»-файлы) руками не сливать: вторая ветка после влива первой берёт файл из staging и пересобирает его командой гарда, допуск только вниз — убедись, что гард зелёный; • манифесты зависимостей и lock-файлы, общие реестры и точки подключения — вторая ветка после merge staging оставляет обе правки, lock пересобирается менеджером пакетов, а не руками; • код в одном файле — вторая ветка сливает staging и сохраняет обе правки; если правки противоречат по смыслу — решаешь ты, если это вопрос продукта (как работает для пользователя, деньги, права) — «Вопросы владельцу:». Конфликт не повод останавливать обе волны: первая идёт дальше к влитию, вторая продолжает свою работу и сливает staging, когда первая влита. Владельца по порядку влива не спрашивай.",
    "СНАЧАЛА ПЛАНЫ И КОНТРАКТЫ. До первого блока slot:… новому эпику или новой пачке волн сделай три вещи подряд, в одном ходе: (1) заполни планы ВСЕХ волн пачки (навык wave-plan, если он есть) — слот с планом-заготовкой диспетчерская не запустит, передача ему будет ждать плана; (2) общее между волнами запиши контрактами в планах обеих сторон одинаковым текстом: имена полей и таблиц, заголовки и их значения, коды ошибок, кто какой общий файл правит и в каком порядке вливаются ветки (строки «ПОРЯДОК: ПN после ПM»); (3) все вопросы владельцу по этим планам задай ОДНИМ разделом «Вопросы владельцу:», а не по мере написания каждого плана. Слот, стартовавший до контракта, строит на устаревшей основе и переделывает. Контракт меняешь после старта — в том же ходе сообщи блоком slot:… каждому слоту, кого он касается, что изменилось.",
    "ТЕМП СЛОТОВ. Слот проходит станции плана подряд в одном ходе и докладывает один раз: когда сделано всё, что можно без чужого решения, или когда заблокирован каждый оставшийся кусок. Поэтому НЕ проси промежуточных докладов («пришли доклад после ST0», «доложи после разведки»): каждый доклад заканчивает ход слота, и волна стоит в твоей очереди. Вопросы слота в пределах его манифеста и решения с очевидным вариантом не держи: ответь одной строкой «по умолчанию — <вариант>, продолжай». Доклады из очереди разбирай коротко и первыми: пока ты пишешь длинный ответ, слоты стоят. Фоновых команд с ожиданием («подожду, пока соберётся») не запускай: ход кончается раньше них, а ротация сессии их теряет — ты повиснешь. Состояние слотов бери из справки диспетчерской, которая приходит с докладом, а не обходом её API.",
    "ОТВЕТЫ СЛОТОВ приходят тебе сообщением «Ответ слота …». Разбирай по порядку: что слот сделал, чего не смог, что просит. Решай сам всё, что в твоей власти (общие файлы, планы, эпик), и сообщай слоту результат блоком slot:…; владельцу пиши только то, что требует его решения, одним коротким списком вопросов.",
    "ВЛАДЕЛЬЦУ ОТДЕЛЬНЫМ ПУНКТОМ выноси всё юридически и денежно значимое, даже если слот дал рекомендацию и тебе она кажется очевидной: хранение и удаление персональных данных и согласий, тексты договоров, политик и согласий, цены и деньги, права доступа. Формулируй как вопрос с твоей рекомендацией и вариантами, не пиши «владельцу решать нечего», пока такой пункт есть.",
    "ФОРМА ВОПРОСОВ ВЛАДЕЛЬЦУ. Всё, что ждёт решения владельца, пиши отдельным разделом: строка «Вопросы владельцу:», под ней нумерованные пункты, после — пустая строка. Диспетчерская сразу вынесет раздел карточкой в «Ждут вашего действия» и снимет её, когда владелец ответит. В раздел — ТОЛЬКО то, на что владелец должен ответить решением: вопрос с вариантами и твоей рекомендацией. Форма (по ней диспетчерская рисует кнопки ответа, своих заготовок у неё нет): номер и вопрос одной строкой, под ним каждый вариант СВОЕЙ строкой с отступом — «(а) …», «(б) …», «(в) …» — сколько вариантов нужно по смыслу, не обязательно два; у рекомендованного в конце строки «— рекомендую»; пустых строк внутри раздела нет; подробности, что войдёт в вариант, — в тексте самого варианта, а не отдельным нумерованным списком (вложенная нумерация превращается в лишние вопросы). Пример: «1. Заводить ли четвёртую волну после влива П1–П3?» / «   (а) Одна волна: гард и автоприёмка — рекомендую» / «   (б) Сейчас только гард, автоприёмку — в бэклог» / «   (в) Не заводить». Владелец отвечает нажатием: придёт «Вопрос 1: (б) …». Вопрос без вариантов получит только поле «свой ответ», а в режиме «без владельца» останется ждать человека. Не клади туда «нажмите…» (передачи идут сами), «решений нет» и напоминания на будущее: это пиши обычным текстом под заголовком «На потом владельцу:». Нет решений — раздела нет. Вопрос, который решаешь сам, туда не клади. Слот тоже может прислать раздел «Вопросы владельцу:» — это вопросы о продукте, владелец их уже видит; не пересказывай их, а добавь своё мнение, если оно есть.",
    "Основная папка staging — " + fwd(MAIN) + ": читай её файлы по абсолютному пути или через git -C " + fwd(MAIN) + " show staging:<путь>. Рабочей папкой она тебе не добавлена намеренно (иначе навыки грузятся дважды); файлы там руками не правь и git-команды, меняющие её, сам не запускай. Твоя папка эпика сама держится на коде staging: после каждого влива диспетчерская перематывает её вперёд, твои незакоммиченные планы остаются. Отслеживаемые файлы кода в ней не правь — это остановит перемотку; правки кода делают слоты.",
    "ВЛИВАНИЕ И КОММИТ ПО СЛОВУ ВЛАДЕЛЬЦА. Если владелец в своём сообщении просит влить ветку слота в staging («влей», «вливай»), напиши отдельной строкой «ВЛИТЬ ПN» (например «ВЛИТЬ П2») — диспетчерская сама проверит условия, как у кнопки «Влить в staging», и вольёт merge --no-ff. Если владелец сказал «принудительно», пиши «ВЛИТЬ ПN ПРИНУДИТЕЛЬНО»: это снимает только регресс, ревью и гарды; конфликт, незакоммиченное в слоте и порядок волн не снимаются. Если на нынешнем коде не хватает только зелёных гардов, регресса или ревью, «ВЛИТЬ ПN» не отказ: команда ждёт зелёного — диспетчерская сама ставит недостающие проверки и вливает, когда всё позеленело, в пределах 12 ч от слова владельца; не спрашивай владельца второй раз и не пиши «ВЛИТЬ» повторно. Красное — придёт «Влив ПN на паузе» с причиной: отдай правку слоту; после правки ожидание продолжится само, слово владельца в силе до срока. Снять ожидание — строкой «ОТМЕНИТЬ ВЛИТЬ ПN». Слоты коммитят сами в своих ветках (после каждой станции плана, со строкой «Wave: WV-NNNN»), просить их об этом не нужно. Если владелец просит закоммитить остаток работы слота («коммить»), напиши «КОММИТ ПN» — диспетчерская отправит слоту задачу коммита, подпись слот напишет сам. Без слова владельца в его последнем сообщении строки не исполняются, поэтому не пиши их по своей инициативе и не отсылай владельца к кнопкам, когда он уже сказал слово. Итог диспетчерская допишет в чат строкой статуса; если условия не выполнены, перескажи владельцу, что мешает.",
    "СБРОС ВЕТКИ СЛОТА ПО СЛОВУ ВЛАДЕЛЬЦА. Если владелец САМ просит снять лишние коммиты слота или сбросить его ветку («сбрось П2 на staging»), напиши отдельной строкой «СБРОСИТЬ ПN» (на staging) или «СБРОСИТЬ ПN НА <sha>»: диспетчерская проверит, что агент слота остановлен, прогонов и несохранённого нет, поставит тег-страховку backup/… на старый коммит и сбросит ветку. Ветку слота руками (git reset, merge --ff-only в папке слота) не двигай. План без изменений — node " + EPIC_CLI + " reset-slot ПN --epic <id> --dry-run.",
    "Пуш, выкат и запуск тестов делает владелец кнопками диспетчерской; тесты в ветку слота ты ставишь строкой «ПРОГНАТЬ ПN: задача=фильтр». Команды эпика (план, слоты, тесты волны) — node " + EPIC_CLI + " <команда> --epic <id>.",
    "РЕВЬЮ. Если ревью вернулось с замечаниями, а ты проверил по коду, что они не блокируют или уже исправлены, прими волну строкой «ПРИНЯТЬ РЕВЬЮ ПN»: диспетчерская отметит станцию «Ревью», и автопоезд сам поставит коммит силами агента. Владельца отмечать станцию руками не проси.",
    ...(moduleOn("release") ? [AFTER_DEPLOY] : []),
    toolsSection(),
    ...(live.some(isTrain) ? [ORCH_TRAINS_RULE] : []),
    ...(moduleOn("backlog") ? [orchBacklog()] : []),
    "ЭПИК «" + (EPIC.title || EPIC.id) + "». Исполнителей-слотов у тебя " + live.length + ": " + slots + ".",
  ].join("\n\n")
}

/** Системная подсказка роли: оркестратор, агент бэклога или исполнитель слота (персона + правила передачи и коммита). */
export function agentSystemPrompt(key) {
  if (isBacklogKey(key)) return backlogPrompt()
  if (isOrch(key)) return orchSystemPrompt(key)
  const persona = readPersona()
  return [persona,
    selfCommitRule(selfCommitMode(settings)),
    "ПЕРЕДАЧА. Диспетчерская сама доставляет твой ответ оркестратору, поэтому оформляй ответ строго по формату выше: один блок кода text. Оркестратору уходит сам только доклад, в котором для него есть дело: статус СТОП или ВОПРОС, раздел «Нужно от оркестратора:», «Вопросы владельцу:» или «Ответ оркестратору:» (так отвечай на его вопрос), либо ГОТОВО/ЧАСТИЧНО с новыми правками кода. «ЖДУ» и «Принял» без такого раздела остаются в твоём чате — не повторяй их ради передачи.",
    "СВОДКА. Когда в волне что-то сделано, держи на карточке ветки свежую сводку: отдельной строкой «СВОДКА: что уже сделано и что осталось, 1–2 предложения». Диспетчерская показывает последнюю такую строку владельцу без открытия чата.",
    toolsSection({ slot: true }),
    ...(moduleOn("release") ? [AFTER_DEPLOY] : []),
    envNoteFor(key)].filter(Boolean).join("\n\n")
}

/** Что агенту слота знать об окружении его папки (зависимости, сборка) — правило области, slot-rules.mjs. */
function envNoteFor(key) { const x = slotOf(key); return x ? slotEnvNote(x) || "" : "" }

// ───────────────────────────── сессии, возобновление, копилка оркестратора ─────────────────────────────

export const saveSessions = () => saveJson(AGENTS_FILE, S.agentSessions || {}, 1)
const sessions = () => S.agentSessions || (S.agentSessions = {})

/** mid — агент на середине хода (время начала). Ставится при отправке сообщения, снимается итогом хода и остановкой человеком;
 *  перезапуск диспетчерской процесс убивает, а отметка остаётся — после старта такие агенты продолжают сами (resumeInterrupted). */
export function markMid(key, at) {
  const s = S.agentSessions && S.agentSessions[key]; if (!s || DRY) return
  if (at) { if (s.mid === at) return; s.mid = at } else { if (!s.mid) return; delete s.mid }
  saveSessions()
}
export const RESUME_TEXT = "Диспетчерская перезапускалась посреди твоего хода — процесс агента был остановлен. Продолжай с того же места: сначала `git status` и диф (запись файла могла оборваться), потом доделай начатое. С нуля не начинай."

/** Прерванные перезапуском агенты эпика: оркестратор первым, потом слоты. keys — ключи деревьев, которые можно будить. */
export function interruptedKeys(keys, list = sessions()) {
  return keys.filter((k) => list[k] && list[k].mid).sort((x, y) => (isOrch(y) ? 1 : 0) - (isOrch(x) ? 1 : 0))
}
export async function resumeInterrupted(keys, { gapMs = 4000 } = {}) {
  const done = []
  for (const k of interruptedKeys(keys)) {
    try { const a = await ensureAgent(k); if (a.busy) continue; deliver(a, RESUME_TEXT, "resume"); logEvent("agent.resume", { key: k }); done.push(k) } catch (e) { console.error("возобновление " + k + ":", e.message) }
    await sleep(gapMs)
  }
  return done
}

// Сторож простоя: в эпике никто не работает IDLE_NUDGE_MIN минут, очередей передач нет, не все слоты ждут владельца —
// оркестратору одно короткое сообщение, не чаще раза в IDLE_NUDGE_EVERY_MIN (решение — loops.mjs orchNudgeDue).
export const IDLE_NUDGE_MIN = Number(process.env.DASH_IDLE_NUDGE_MIN) || 20, IDLE_NUDGE_EVERY_MIN = 60
export const IDLE_NUDGE_TEXT = "[Диспетчерская, сторож простоя] В эпике больше " + IDLE_NUDGE_MIN + " минут никто не работает, передач в очереди нет. Пройди по слотам: кто может продолжать без владельца — дай ему продолжение блоком slot:…; если всё ждёт владельца, вливов или чужих волн — ответь одной строкой «ждём: …» и больше ничего не делай."

// Сведения оркестратору, которые его решения не требуют (loops.mjs orchWake), не будят его отдельным ходом: копятся и уезжают
// попутно в начале следующего настоящего сообщения (withPrimer). Файл переживает перезапуск.
export const ORCH_HELD_FILE = path.join(DATA, "orch-held.json")
const HELD_MAX = 20
export function loadOrchHeld() { S.orchHeld = readJson(ORCH_HELD_FILE, {}) || {} }
const saveHeld = () => { if (!DRY) saveJson(ORCH_HELD_FILE, S.orchHeld || {}) }
export function holdForOrch(key, text, why = "") {
  if (!S.orchHeld) S.orchHeld = {}
  const list = S.orchHeld[key] || (S.orchHeld[key] = []), t = String(text || "").trim()
  if (!t || list.some((x) => x.text === t)) return
  list.push({ at: Date.now(), text: t.length > 1500 ? t.slice(0, 1500) + " …" : t }); if (list.length > HELD_MAX) list.splice(0, list.length - HELD_MAX)
  logEvent("orch.held", { key, kind: why, chars: t.length, brief: brief(t) }); saveHeld()
}
function takeHeld(key) {
  const list = S.orchHeld && S.orchHeld[key]; if (!list || !list.length) return ""
  delete S.orchHeld[key]; saveHeld()
  const hhmm = (at) => new Date(at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
  return "── Попутно: сведения диспетчерской, накопленные без отдельного хода (решения не требовали) ──\n" + list.map((x) => "- " + hhmm(x.at) + " " + x.text.replace(/\n+/g, " ")).join("\n")
}

export const agentSession = (key) => sessions()[key]
export function loadSessions() { S.agentSessions = readJson(AGENTS_FILE, {}) || {} }
export const agents = new Map() // ключ → агент

/** Последняя сессия рантайма для папки (продолжение, когда своей записи в agents.json нет). */
export const latestSession = (cwd) => cwd ? runtime().latestSession(cwd) : null
export const agentCwd = (key) => { if (isBacklogKey(key)) return BACKLOG_WT; const t = treeByKey(key); return t && exists(t.path) ? t.path : null }

// ───────────────────────────── лента агента ─────────────────────────────

export function push(a, item) {
  item.rev = ++a.rev; if (!item.at) item.at = Date.now()
  if (item.t === "user" && item.owner && isOrch(a.key)) ownerSaid(a.key, item.text, item.at, item.by || "") // слово владельца переживает перезапуск
  a.items.push(item); if (a.items.length > 600) a.items.splice(0, a.items.length - 600)
  a.lastActive = Date.now(); agentChanged(a.key, a.rev); if (item.t !== "assistant" && item.t !== "tool") bumpVer("agent:" + item.t)
  return item
}
export function touch(a, item) { item.rev = ++a.rev; a.lastActive = Date.now(); agentChanged(a.key, a.rev); return item }
export const itemById = (a, id) => a.items.find((x) => x.id === id)

/** Строка ленты по виду инструмента и нейтральному вводу (runtimes/index.mjs, NeutralInput). */
export function toolSummary(kind, input) {
  const i = input || {}
  switch (kind) {
    case "bash": return { line: short(i.command, 400), kind, desc: i.description ? short(i.description, 140) : "" }
    case "read": return { line: i.path || "", kind }
    case "write": return { line: i.path || "", kind, body: short(i.content, 800) }
    case "edit": return { line: i.path || "", kind, old: short(i.old, 700), neu: short(i.neu, 700) }
    case "search": return { line: `${i.pattern || ""}${i.path ? "  в " + i.path : ""}`, kind }
    default: return { line: i.text != null ? String(i.text) : short(JSON.stringify(i.raw ?? i), 300), kind: "other" }
  }
}

// ───────────────────────────── права ─────────────────────────────

/** Пока открыто разрешение коммита (кнопка «Коммит»), агент слота может add/commit в своей ветке без вопроса. */
export const COMMIT_GRANT_MS = 15 * 60e3
/** Папки диспетчерской: её код, данные и реестр эпиков. Агентам — только чтение и её собственные инструменты. */
export const GUARDED_DIRS = [HOME, DATA, path.dirname(EPIC_FILE)].map(fwd)
export const GIT_NIGHT_OK = gitNightRe(REMOTE)
export const nightOn = () => (settings.autoOwnerUntil || 0) > Date.now()
/** Агент слота (не оркестратор и не агент бэклога). */
export const slotAgentKey = (key) => !!key && !isOrch(key) && !isBacklogKey(key)
/** Команда трогает папки диспетчерской не чтением и не её инструментом. */
export const protectedBash = (seg) => guardedBash({ guarded: GUARDED_DIRS, home: HOME }, seg)

/** Всё, что политике прав нужно знать об агенте сейчас (agent-policy.mjs). */
export function policyCtx(a) {
  return {
    key: a.key, role: isOrch(a.key) ? "orch" : "slot",
    roots: [agentCwd(a.key), a.cwd, a.key ? path.join(WT, a.key) : null].filter(Boolean),
    commitOpen: !!(a.commitUntil && a.commitUntil > Date.now()), selfCommit: slotAgentKey(a.key) && selfCommitOn(settings),
    night: nightOn(), full: !!settings.fullPermissions, project: PROJECT, guarded: GUARDED_DIRS, home: HOME,
    tmp: [os.tmpdir(), "/tmp"], remote: REMOTE,
  }
}
export const bashAllowed = (a, command) => policyBashAllowed(policyCtx(a), command)
export const bashDenyWhy = (a, command) => policyBashDenyWhy(policyCtx(a), command)

/** Нейтральный запрос разрешения: { kind, name?, command?, path?, input? } (событие `permission` годится как есть). */
const neutralReq = (req) => { const i = (req && req.input) || {}; return { kind: req.kind, name: req.name || "", command: req.command ?? i.command, path: req.path ?? i.path, input: i } }

/** Решение диспетчерской по запросу разрешения: "allow", { deny } (отказ с причиной агенту) или null (карточка человеку). */
export function autoDecide(a, req) {
  const r = neutralReq(req)
  if (isBacklogKey(a.key)) return backlogPerm(r)
  const d = decide(policyCtx(a), r)
  if (d && d.deny) logEvent("perm.deny", { key: a.key, tool: r.kind, why: String(d.deny).slice(0, 200), ...(r.command ? { cmd: String(r.command).slice(0, 160) } : {}) })
  return d
}

/** Номер волны агента слота: вагон в работе у поезда, иначе из ветки (пусто — номер неизвестен). */
export function waveOfAgent(key) {
  try { const tw = trainWaveOf(key); if (tw) return tw } catch { /* не поезд */ }
  const x = slotOf(key); return x ? normWave(x.branch || "") : ""
}
/** Номер для строки Wave и номера, под которыми коммит законен → { cur, allowed } (поезд — train-rules.mjs trainCommitWaves). */
export function commitWavesOf(key) {
  const w = waveOfAgent(key); let t = null
  try { const snap = snapNow(); t = snap && (snap.trees || []).find((x) => x.key === key) } catch { /* снимка нет (тест, старт) — только текущий вагон */ }
  if (t && t.train && Array.isArray(t.wagons)) return trainCommitWaves(t.wagon || w, t.wagons)
  return { cur: w, allowed: w ? [w] : [] }
}
export const wavesOfAgent = (key) => commitWavesOf(key).allowed

// Хук commit-msg ставит строку Wave в коммиты агента слота: хук — один раз за жизнь сервера на папку, номер — перед каждым сообщением.
const hooked = new Set()
function ensureSlotHooks(a) {
  if (DRY || hooked.has(a.key)) return
  try { installSlotHooks(a.cwd); hooked.add(a.key) } catch (e) { push(a, { id: "hook-" + a.rev, t: "status", text: "Хук подписи коммита не поставлен: " + e.message + " — строку «Wave:» агенту придётся писать самому.", bad: true }) }
}
function syncSlotWave(a) {
  if (DRY) return
  try { writeSlotWave(a.cwd, commitWavesOf(a.key)) } catch (e) { logEvent("slot.wave.error", { key: a.key, error: String(e.message || e).slice(0, 160) }) }
}

// ───────────────────────────── события рантайма ─────────────────────────────

/** Нормализованное событие рантайма (runtimes/index.mjs) → лента агента, сессии, разрешения, итог хода. */
export function onAgentMsg(a, ev) {
  if (!ev) return
  switch (ev.type) {
    case "session": {
      // Ответ — в ту сессию, что спросила: prev — прежние id той же беседы, если процесс её продолжил под новым id.
      const o = sessions()[a.key], prev = o && o.id !== ev.id && a.sessionId === o.id ? [o.id, ...(o.prev || [])].slice(0, 6) : o && o.id === ev.id ? o.prev || [] : []
      a.sessionId = ev.id; if (ev.model) a.model = ev.model
      sessions()[a.key] = { id: ev.id, at: Date.now(), ...(prev.length ? { prev } : {}), ...(a.busy && a.turnAt ? { mid: a.turnAt } : {}) }
      saveSessions()
      push(a, { id: "init-" + a.rev, t: "status", text: `Сессия ${String(ev.id).slice(0, 8)}${a.model ? " · модель " + a.model : ""}` })
      return
    }
    case "text.delta":
      if (!ev.text) { a.live = push(a, { id: ev.msgId, t: "assistant", text: "", live: true }); return }
      if (a.live && a.live.id === ev.msgId) { a.live.text += ev.text; touch(a, a.live) }
      return
    case "text": {
      const it = itemById(a, ev.msgId)
      if (it) { if (ev.text) it.text = ev.text; it.live = false; touch(a, it) } else if (ev.text) push(a, { id: ev.msgId, t: "assistant", text: ev.text })
      return
    }
    case "tool.start":
      if (itemById(a, ev.id)) return
      push(a, { id: ev.id, t: "tool", name: ev.name, ...toolSummary(ev.kind, ev.input), status: "run" })
      try { noteFetch(a.key, ev.kind, ev.input) } catch { /* учёт выжимок не должен ронять агента */ }
      return
    case "tool.end": {
      const it = itemById(a, ev.id)
      if (it) { it.status = ev.ok ? "ok" : "err"; it.result = short(ev.result, 700); touch(a, it) }
      return
    }
    case "turn.end": return turnEnded(a, ev)
    // рантайм начал ход сам (очередь сообщений у рантайма без постоянного процесса): агент снова занят
    case "turn.start": a.busy = true; a.turnAt = Date.now(); markMid(a.key, a.turnAt); return
    case "permission": {
      const dec = autoDecide(a, ev)
      if (dec && dec.deny) { try { a.rt.answerPermission(ev.id, { allow: false, message: dec.deny }) } catch { /* агент уже закрыт */ } push(a, { id: "deny-" + ev.id, t: "status", text: dec.deny }); return }
      if (dec === "allow") { try { a.rt.answerPermission(ev.id, { allow: true }) } catch { /* агент уже закрыт */ } return }
      a.pending.set(ev.id, ev); a.permAt = Date.now() // с какого момента агент ждёт разрешения
      push(a, { id: "perm-" + ev.id, t: "perm", reqId: ev.id, name: ev.name, ...toolSummary(ev.kind, ev.input), status: "wait" })
      return
    }
    case "limits": a.limits = { limit: ev.limit, util: ev.util, status: ev.status, resetsAt: ev.resetsAt, at: Date.now() }; return
    case "stderr": a.lastErr = short(ev.text, 300); return
    case "error": a.dead = true; a.busy = false; push(a, { id: "err-" + a.rev, t: "status", text: "Не удалось запустить агента: " + ev.message, bad: true }); return
    case "exit": {
      a.dead = true; a.busy = false; a.pending.clear()
      if (a.stopping) markMid(a.key, 0) // остановил человек или простой — не возобновлять; при перезапуске диспетчерской событие не доходит, отметка остаётся
      logEvent("agent.end", { key: a.key, code: ev.code ?? null, stopping: !!a.stopping })
      const ok = ev.code === 0 || a.stopping
      push(a, { id: "end-" + a.rev, t: "status", text: ok ? "Агент остановлен. Сессия сохранена — следующее сообщение продолжит её." : `Агент завершился (код ${ev.code})${a.lastErr ? ": " + a.lastErr : ""}`, bad: !ok })
      return
    }
  }
}

function turnEnded(a, ev) {
  touchSnap(a.key); kick() // ход закончен — следующий снимок берёт слот заново
  a.busy = false; a.live = null; a.realEndAt = Date.now(); markMid(a.key, 0)
  if (ev.ctxTokens) a.ctxTok = ev.ctxTokens
  const sec = a.turnAt ? Math.round((Date.now() - a.turnAt) / 1000) : Math.round((ev.ms || 0) / 1000)
  a.lastTurn = { at: Date.now(), sec, ok: !!ev.ok, why: ev.why || "" }
  try { // итог хода — в журнал эпика: токены и (у оркестратора) было ли в ходе действие
    let text = ""; for (let i = a.items.length - 1; i >= 0; i--) { const x = a.items[i]; if (x.t === "user") break; if (x.t === "assistant" && x.text) { text = x.text; break } }
    const u = ev.usage || {}
    logEvent("agent.turn", { key: a.key, sec, ok: !!ev.ok, in: u.in || 0, out: u.out || 0, cr: u.cacheRead || 0, cw: u.cacheWrite || 0, cost: Math.round((ev.cost || 0) * 1e4) / 1e4, ...(isOrch(a.key) ? { act: turnAct(text) } : {}), chars: String(text || "").length, brief: brief(text) })
  } catch { /* журнал не должен ронять агента */ }
  try { captureReply(a) } catch { /* перехват не должен ронять агента */ }
  if (isOrch(a.key) && !a.rotateDue && settings.orchRotate !== false && rotateDue(a.ctxTok)) { a.rotateDue = true; push(a, { id: "rot-" + a.rev, t: "status", text: "Контекст оркестратора — " + Math.round(a.ctxTok / 1000) + " тыс. токенов (порог " + Math.round(ORCH_ROTATE_TOKENS / 1000) + " тыс.): каждый ход перечитывает его целиком. Следующее сообщение начнёт новую сессию — с памятью из файлов плана эпика и последних ответов." }) }
  try { inboxAfterTurn(a) } catch (e) { console.error("разбор хода агента", a.key, e && e.stack || e); try { logEvent("turn.after.error", { key: a.key, error: String((e && e.message) || e).slice(0, 300) }) } catch { /* журнал */ } }
  push(a, { id: "res-" + a.rev, t: "result", ok: !!ev.ok, sec: Math.round((ev.ms || 0) / 1000), cost: ev.cost || 0, text: ev.why || "" })
  for (const it of a.items) if (it.t === "tool" && it.status === "run") { it.status = "ok"; touch(a, it) }
}

// ───────────────────────────── слоты ─────────────────────────────

export const slotOf = (key) => { for (const e of openEpics()) { const x = e.slots.find((z) => z.slot === key); if (x) return x } return null }
export const epicOfSlot = (key) => openEpics().find((e) => e.slots.some((z) => z.slot === key)) || null
/** Папка слота готовится (slot-up): агенту в неё пока рано. */
export const slotPreparing = (key) => jobList().some((j) => j.tree === key && j.task === "slot-up" && !FINAL.includes(j.status))

// ───────────────────────────── запуск и остановка ─────────────────────────────

/** Параметры процесса по роли: агент бэклога — без автоприёма правок и без пользовательских настроек рантайма. */
const roleOpts = (key) => isBacklogKey(key) ? backlogAgentOpts() : { acceptEdits: true, userSettings: true }

export async function startAgent(key, { resume = false, model = "" } = {}) {
  const old = agents.get(key); if (old && !old.dead && (old.rt || old.ready)) return old // живой или ещё запускается
  if (DRY) throw new Error("сухой режим: агенты не запускаются")
  if (isBacklogKey(key)) await prepareBacklogTree() // дерево кода агента бэклога — до запуска
  const cwd = agentCwd(key); if (!cwd) throw new Error("у слота нет папки")
  const rt = runtime()
  let mem = null; try { mem = await memInfo() } catch { /* монитора машины нет — без проверки памяти */ }
  if (mem && mem.freeCommitGB < 1.5) throw new Error(`мало памяти для агента: свободно ${mem.freeCommitGB.toFixed(1)} ГБ лимита выделения (нужно ~1,5)`)
  const prevS = sessions()[key]
  const sid = resume && !process.env.DASH_TEST_NO_RESUME ? (prevS && prevS.id) || (rt.latestSession(cwd) || {}).id || null : null // DASH_TEST_NO_RESUME — пробы не трогают настоящие сессии
  model = modelFor(key, model)
  const a = { key, cwd, rt: null, proc: null, items: old ? old.items : [], rev: old ? old.rev : 0, pending: new Map(), busy: false, live: null, dead: false, lastActive: Date.now(), sessionId: sid || null, model, startedAt: Date.now() }
  agents.set(key, a)
  if (!old) { try { for (const n of recentNotes(key)) push(a, { ...n }) } catch { /* ревью выключено */ } } // свежие ответы ревьюера видны и в новой сессии
  // Пока процесса нет, агент уже в списке: сообщения встают в очередь до запуска и не теряются.
  let ready; a.ready = new Promise((r) => { ready = r }); a.sendQ = a.ready
  try {
    if (slotAgentKey(key)) ensureSlotHooks(a)
    a.rt = rt.start({ cwd, model, resume: sid, systemPrompt: agentSystemPrompt(key), ...roleOpts(key), env: proxyEnv() }, { spawn, kill: killTree, onEvent: (ev) => onAgentMsg(a, ev) })
    a.proc = a.rt.proc || null
  } catch (e) { a.dead = true; a.busy = false; a.lastErr = e.message; push(a, { id: "err-" + a.rev, t: "status", text: "Не удалось запустить агента: " + e.message, bad: true }); ready(); throw e }
  push(a, { id: "start-" + a.rev, t: "status", text: (sid ? `Продолжаю сессию ${sid.slice(0, 8)}…` : "Новая сессия…") + " " + (rt.label || rt.name) + (model ? ", модель " + model : "") + (PROJECT.agent.proxy ? ", выход к модели — через прокси из конфига." : ".") })
  logEvent("agent.start", { key, runtime: rt.name, resume: !!sid, model })
  ready(); return a
}

/** Агент для ключа: живой — как есть; иначе поднять, продолжив сессию. Не продолжилась — новая сессия и строка об этом в чате. */
export async function ensureAgent(key, model = "") {
  if (DRY) throw new Error("сухой режим: агенты не запускаются")
  let a = agents.get(key)
  if (a && !a.dead) return a
  const hadSession = !!sessions()[key] || !!latestSession(agentCwd(key))
  a = await startAgent(key, { resume: hadSession, model })
  if (hadSession && !process.env.DASH_TEST_NO_RESUME) {
    await sleep(2500)
    if (a.dead) {
      const why = a.lastErr ? " (" + a.lastErr.slice(0, 120) + ")" : ""
      a = await startAgent(key, { resume: false, model })
      push(a, { id: "fresh-" + a.rev, t: "status", text: "Прошлую сессию продолжить не удалось" + why + " — возможно, она открыта в другом окне. Начата новая сессия: отчёт содержит всё нужное.", bad: true })
    }
  }
  return a
}

/**
 * Отправить агенту текст как ход. Низкий уровень: ленту и «занят» ставит вызывающий (deliver, sendUserText).
 * Пока процесс запускается, сообщение ждёт в очереди; порядок сообщений сохраняется.
 */
export function agentSend(a, text) {
  if (a.dead || (!a.rt && !a.ready)) throw new Error("агент не запущен")
  const now = Date.now(), t = String(text)
  a.turnAt = now; a.lastTurn = null; a.lastReal = now
  markMid(a.key, now)
  a.sendQ = (a.sendQ || Promise.resolve()).then(() => {
    if (a.dead || !a.rt) return
    if (slotAgentKey(a.key)) syncSlotWave(a)
    a.rt.send(t)
  }).catch((e) => { push(a, { id: "snd-" + a.rev, t: "status", text: "Сообщение агенту не ушло: " + e.message, bad: true }) })
}

export function stopAgent(a) {
  a.stopping = true
  try { if (a.rt) a.rt.interrupt() } catch { /* уже мёртв */ }
  setTimeout(() => { try { if (a.rt && a.rt.kill) a.rt.kill(); else killTree(a.proc) } catch { /* уже остановлен */ } }, 300)
}

/** Сообщение агенту от человека (или от окна диспетчерской: owner:false, by:"dispatcher"). Агент поднимается при надобности. */
export async function sendUserText(key, text, { by = "", owner = true, model = "" } = {}) {
  let a = agents.get(key)
  if (!a || a.dead) a = await ensureAgent(key, model)
  a = await rotateOrchIfDue(a)
  deliver(a, text, owner ? "owner" : "user", { owner, by })
  return a
}

/** Прервать текущий ход агента. → прерван ли (false — агент не запущен). */
export function interruptAgent(key) {
  const a = agents.get(key); if (!a || a.dead || !a.rt) return false
  a.rt.interrupt(); logEvent("agent.interrupt", { key })
  return true
}

/** Сменить модель агента: со следующего сообщения, сессия та же. Агент не запущен — модель возьмётся при запуске. */
export function setAgentModel(key, model = "") {
  const m = modelFor(key, model), a = agents.get(key)
  if (!a || a.dead || !a.rt) return { live: false, model: m }
  a.rt.setModel(m); a.model = m
  push(a, { id: "mdl-" + a.rev, t: "status", text: "Модель: " + m + " — со следующего сообщения, сессия та же." })
  return { live: true, model: m }
}

/** Ответ человека на запрос разрешения. → закрыт ли запрос (false — запроса уже нет). */
export function answerPermission(key, requestId, { allow, input, message = "" } = {}) {
  const a = agents.get(key); if (!a || a.dead || !a.rt || !a.pending.has(requestId)) return false
  a.rt.answerPermission(requestId, { allow: !!allow, input, message: message || "Отклонено владельцем в дашборде" })
  a.pending.delete(requestId)
  const item = itemById(a, "perm-" + requestId); if (item) { item.status = allow ? "allowed" : "denied"; touch(a, item) }
  return true
}

// ───────────────────────────── передачи и реестр ─────────────────────────────

/** Переключатель передачи агентов между машинами (модуль машин); по умолчанию включён. */
export const relayOn = () => settings.relayAgents !== false
export const relays = [] // последние передачи — страница рисует по ним анимацию
export function recordRelay(from, to, chars, kind) { const r = { id: "r" + Date.now().toString(36), from, to, at: Date.now(), chars, kind: kind || "mail" }; relays.push(r); if (relays.length > 30) relays.shift(); return r }

/** Порядок депо поезда — командой реестра epic.mjs order-wagons. → { status, stdout, stderr } */
export const epicOrderWagons = (tag, waves, epicId) => new Promise((res) => execFile(process.execPath, [path.join(HERE, "..", "epic.mjs"), "order-wagons", tag, ...waves, "--epic", epicId || ""], { encoding: "utf8", windowsHide: true, timeout: 120000 }, (e, so, se) => res({ status: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout: so || "", stderr: se || "" })))

// ───────────────────────────── история ─────────────────────────────

/** Прошлые реплики сессии — чтобы при продолжении было видно, о чём шла речь. */
export async function readHistory(cwd, sessionId) {
  if (!cwd || !sessionId) return []
  let list = []; try { list = await runtime().readHistory(cwd, sessionId) } catch { return [] }
  return list.map((h, i) => h.t === "tool" ? { id: "h" + i, t: "tool", name: h.name, ...toolSummary(h.kind, h.input), status: "ok", old: undefined, neu: undefined }
    : { id: "h" + i, t: h.t, text: short(h.text, h.t === "user" ? 1500 : 3000) })
}
/** Хвост записи сессии агента как есть (для разбора хода, который прошлый сервер не успел разобрать). */
export async function readSessionTail(key, bytes = 3e6) {
  const s = agentSession(key), cwd = agentCwd(key); if (!s || !s.id || !cwd) return ""
  return runtime().readTail(cwd, s.id, bytes)
}
/** Последний законченный ответ в хвосте записи сессии → { text, at, id } | null. */
export const lastAnswerOf = (tail) => runtime().lastAnswer(tail)

/** Правки файлов за текущий ход агента. */
export function turnEdits(a) { let n = 0; for (let i = a.items.length - 1; i >= 0; i--) { const x = a.items[i]; if (x.t === "user") break; if (x.t === "tool" && (x.kind === "write" || x.kind === "edit")) n++ } return n }

export function agentActivity(a) {
  if (!a || a.dead) return ""
  if (a.pending.size) { const p = a.items.filter((x) => x.t === "perm" && x.status === "wait").slice(-1)[0]; return "ждёт вашего разрешения" + (p ? ": " + p.name + " " + String(p.line || "").split("\n")[0].slice(0, 70) : "") }
  const run = a.items.filter((x) => x.t === "tool" && x.status === "run").slice(-1)[0]
  if (run) return run.name + " " + String(run.line || "").split("\n")[0].slice(0, 80)
  const last = a.items[a.items.length - 1]
  if (last && last.t === "assistant" && last.live) return "пишет ответ…"
  return "думает…"
}

export const agentPublic = (key) => {
  const a = agents.get(key), cwd = agentCwd(key), last = cwd ? (sessions()[key] || latestSession(cwd)) : null, live = !!a && !a.dead
  const committing = live && a.busy && !!a.commitUntil && a.commitUntil > Date.now()
  let caps = null; try { caps = runtime().caps } catch { /* рантайм не настроен */ }
  return { running: live, busy: live && a.busy, pending: live ? a.pending.size : 0, model: a ? a.model : "", rev: a ? a.rev : 0, hasLast: !!last, lastAt: last ? last.at : null,
    idleSec: live ? Math.round((Date.now() - a.lastActive) / 1000) : null, idleStopMin: AGENT_IDLE_MIN, turnAt: a && a.busy ? a.turnAt || null : null, last: a && a.lastTurn ? a.lastTurn : null,
    activity: a && a.busy ? agentActivity(a) : "", dead: !!a && a.dead, committing, coding: live && a.busy && !committing && turnEdits(a) > 0, caps } // committing — агент выполняет «коммит силами агента»
}

// ───────────────────────────── оркестратор: ротация и сообщения ─────────────────────────────

// Контекст оркестратора растёт, и каждый ход перечитывает его целиком. Перешёл порог ORCH_ROTATE_TOKENS — перед следующим
// сообщением старая сессия закрывается (она сохранена), новая получает вводную: память — файлы плана эпика и последние ответы.
export async function rotateOrchIfDue(a) {
  if (DRY || !a || !isOrch(a.key) || !a.rotateDue || a.busy) return a
  const key = a.key, prevId = a.sessionId, ctx = a.ctxTok, model = a.model
  const said = a.items.filter((x) => x.t === "assistant" && x.text && !x.live).slice(-3).map((x) => x.text.slice(0, 1500))
  const asked = a.items.filter((x) => x.t === "user" && x.owner && x.text).slice(-2).map((x) => x.text.slice(0, 800))
  stopAgent(a)
  for (let i = 0; i < 50 && !a.dead; i++) await sleep(100)
  if (!a.dead) { a.rotateDue = false; return a } // не остановился — продолжаем старую сессию, попробуем на следующем пороге
  const b = await startAgent(key, { resume: false, model })
  b.ctxTok = 0; b.rotateDue = false; logEvent("orch.rotate", { key, ctxTok: ctx || 0, prevId: prevId || null })
  try { forgetRelayFacts(epicOfKey(key)) } catch { /* справки сбросятся сами */ }
  b.primer = orchPrimer({ ep: epicOfKey(key), orchDir: fwd(agentCwd(key) || ""), prevId, ctx, asked, said })
  push(b, { id: "rotd-" + b.rev, t: "status", text: "Новая сессия оркестратора вместо " + String(prevId || "?").slice(0, 8) + " (" + Math.round((ctx || 0) / 1000) + " тыс. токенов): вводная уйдёт вместе со следующим сообщением." })
  return b
}

/** Сообщение с вводной сессии и (у оркестратора) накопленными сведениями — в начале. */
export const withPrimer = (a, msg) => { const held = isOrch(a.key) ? takeHeld(a.key) : "", p = a.primer || ""; a.primer = null; return [p, held, msg].filter(Boolean).join("\n\n────────\n\n") }

/** Сообщение диспетчерской агенту: в ленту, в журнал эпика и ходом агенту. opt.owner — от имени владельца (по умолчанию — автоответ). */
export function deliver(a, msg, kind = "msg", opt = {}) {
  msg = withPrimer(a, msg)
  const by = opt.by !== undefined ? opt.by : opt.owner ? "auto-owner" : ""
  logEvent("agent.message", { key: a.key, kind, chars: msg.length, brief: brief(msg), ...(by ? { by } : {}) })
  push(a, { id: "u-" + a.rev, t: "user", text: msg, ...(opt.owner ? { owner: true } : {}), ...(by ? { by } : {}) })
  a.turnKind = kind; a.busy = true
  try { agentSend(a, msg) } catch (e) { a.busy = false; throw e }
}

/** Сообщение агенту, когда он освободится. Оркестратору сведения, не требующие решения, — попутно со следующим сообщением. */
export function sendWhenFree(key, text, tries = 0) {
  if (!tries && isOrch(key)) { const w = orchWake(text); if (!w.wake) return holdForOrch(key, text, w.kind) }
  const a = agents.get(key)
  if (a && !a.dead && a.busy) { if (tries < 480) setTimeout(() => sendWhenFree(key, text, tries + 1), 15000); return }
  ensureAgent(key).then((ag) => deliver(ag, text)).catch((e) => console.error("сообщение → " + key + ":", e.message))
}
