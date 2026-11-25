// modules-catalog.mjs — каталог необязательных модулей диспетчерской: одно место, откуда их знают
// загрузчик конфига (проверка ключа `modules`), настройка (`setup.mjs doctor`) и сервер (кто стартует, чьи маршруты
// открыты, какие панели видны).
//
// Два уровня переключателей, не путать:
//   • `modules` в dispatcher.project.json — что вообще есть у этой установки (ставит стартовая настройка);
//   • settings.json в папке данных — поведение на ходу (автокоммит, автовлив…), меняется со страницы.
//
// Модуль включён, когда его хотят (`modules.<id>` или умолчание), платформа подходит и конфигу хватает ключей.
// Выключенный модуль не стартует, его маршруты отвечают 404, панели не видно.

/** Есть ли в конфиге непустое значение по пути "a.b.c". */
const has = (project, dotted) => {
  let v = project
  for (const k of dotted.split(".")) { if (v == null) return false; v = v[k] }
  return Array.isArray(v) ? v.length > 0 : v != null && v !== "" && v !== false
}

export const MODULES = [
    {
        id: "review",
        title: "Независимое ревью",
        about: "Разовый агент-ревьюер читает правку слота перед вливом и выносит вердикт: ЗА, ВОПРОСЫ или ПРОТИВ.",
        default: true,
        missing: () => [],
    },
    {
        id: "backlog",
        title: "Бэклог",
        about: "Карточки идей и находок, которые не входят в текущий эпик, и их разбор.",
        default: true,
        missing: () => [],
    },
    {
        id: "retro",
        title: "Ретро эпика",
        about: "После закрытия эпика разовый агент разбирает журнал событий и предлагает правки процесса карточками бэклога.",
        default: false,
        after: ["backlog"],
        missing: () => [],
    },
    {
        id: "machines",
        title: "Машины прогонов",
        about: "Проверки идут не только на этой машине, но и на других по ssh: код доставляется по sha, место выбирается по памяти.",
        default: false,
        missing: (p) =>
            Object.values(p.machines || {}).some((m) => m.ssh)
                ? []
                : ["в `machines` нет ни одной машины с полем `ssh`"],
    },
    {
        id: "release",
        title: "Выкат",
        about: "Выкат стенда и прода командами из конфига; влив интеграционной ветки в прод-ветку — только кнопкой человека.",
        default: false,
        missing: (p) =>
            has(p, "release.stand.run") || has(p, "release.prod.run") || has(p, "release.prod.pushDeploys")
                ? []
                : ["не задано ни `release.stand.run`, ни `release.prod.run`, ни `release.prod.pushDeploys`"],
    },
    {
        id: "accept",
        title: "Приёмка на стенде",
        about: "Агент слота пишет чек-лист приёмки, прогон идёт командой из конфига, вердикт ставит человек.",
        default: false,
        missing: (p) => (has(p, "accept.run") ? [] : ["не задано `accept.run` — команда прогона приёмки"]),
    },
    {
        id: "tg",
        title: "Телеграм-бот вопросов",
        about: "Вопросы агентов приходят в Телеграм с кнопками вариантов; ответ из бота равен ответу со страницы.",
        default: false,
        missing: () => [],
    },
    {
        id: "win-desktop",
        title: "Рабочий стол Windows",
        about: "Монитор машины, раскладка окон редактора по слотам, ярлыки запуска.",
        default: false,
        platform: "win32",
        missing: () => [],
    },
]

export const MODULE_IDS = MODULES.map((m) => m.id)
export const moduleById = (id) => MODULES.find((m) => m.id === id) || null

/**
 * Состояние каждого модуля для нормализованного конфига проекта.
 * @returns {{id:string,title:string,about:string,wanted:boolean,on:boolean,why:string}[]}
 *   `why` пусто у включённого; у выключенного — человеческая причина.
 */
export function moduleStates(project, { platform = process.platform } = {}) {
  const wantedOf = (m) => project.modules && m.id in project.modules ? !!project.modules[m.id] : !!m.default
  const states = new Map()
  for (const m of MODULES) {
    const wanted = wantedOf(m)
    const reasons = []
    if (!wanted) reasons.push(m.id in (project.modules || {}) ? "выключен в `modules`" : "выключен по умолчанию")
    if (m.platform && m.platform !== platform) reasons.push(`только для ${m.platform}, здесь ${platform}`)
    if (wanted) reasons.push(...m.missing(project))
    states.set(m.id, { id: m.id, title: m.title, about: m.about, wanted, on: reasons.length === 0, why: reasons.join("; ") })
  }
  // Зависимость: модуль не работает без тех, после кого он идёт.
  for (const m of MODULES) {
    const st = states.get(m.id)
    if (!st.on) continue
    const off = (m.after || []).filter((id) => !states.get(id).on)
    if (off.length) { st.on = false; st.why = "нужен модуль " + off.map((id) => "`" + id + "`").join(", ") }
  }
  return [...states.values()]
}
