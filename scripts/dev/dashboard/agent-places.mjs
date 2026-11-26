// agent-places.mjs — предел одновременно живых агентов слотов.
//
// Два предела, оба из конфига проекта (project.mjs):
//   · свой — `limits.slots`: живых агентов слотов этого процесса диспетчерской не больше N;
//   · общий — `limits.shared` ({ slots, dir }): один предел на несколько процессов диспетчерской на машине (проекты дома).
//     Счёт — места-файлы `slot-<n>.lock` в общей папке: файл создаётся флагом `wx` (атомарно, второй владелец получит
//     EEXIST), внутри — pid процесса, проект и ключ слота. Место процесса, которого уже нет, снимается при следующем счёте:
//     процесс, упавший с живыми агентами, не держит места вечно.
// Оркестратор и агент бэклога в предел не входят: через них идут доклады слотов, и предел, занятый слотами, остановил
// бы эпик целиком. Живой агент, который молчит (не в ходе и не ждёт разрешения), уступает место: он останавливается,
// сессия сохраняется, следующее сообщение продолжит её (так же, как остановка по простою).
import fs from "node:fs"
import path from "node:path"

/** Кто уступит место: молчащий агент (не в ходе, без вопросов разрешения), молчащий дольше всех; нет такого — null. */
export function evictable(live) {
  return live.filter((a) => !a.busy && !(a.pending && a.pending.size)).sort((x, y) => (x.lastActive || 0) - (y.lastActive || 0))[0] || null
}

const PLACE_RE = /^slot-(\d+)\.lock$/
const alive = (pid) => {
  if (!(pid > 0)) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === "EPERM" } // EPERM — процесс есть, но чужой
}
const readPlace = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return null } }
const ageMs = (file) => { try { return Date.now() - fs.statSync(file).mtimeMs } catch { return 0 } }

/** Занятые места общей папки: [{ n, pid, project, key, at }]. Места умерших процессов снимаются здесь же. */
export function placesNow(dir) {
  let names = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out = []
  for (const name of names) {
    const m = PLACE_RE.exec(name)
    if (!m) continue
    const file = path.join(dir, name), p = readPlace(file)
    // неразборчивый файл — запись ещё идёт у другого процесса (место занято); старше минуты — запись оборвалась
    if (p ? !alive(p.pid) : ageMs(file) > 60000) { try { fs.unlinkSync(file) } catch { /* снял другой процесс */ } continue }
    out.push({ n: Number(m[1]), ...(p || { pid: 0, project: "?", key: "?" }) })
  }
  return out.sort((a, b) => a.n - b.n)
}

/**
 * Занять место под агента слота. Уже держит место этот процесс с этим ключом — то же место.
 * @returns {{ok:true, n:number} | {ok:false, holders:object[]}}
 */
export function takePlace(dir, limit, { pid = process.pid, project = "", key }) {
  fs.mkdirSync(dir, { recursive: true })
  const now = placesNow(dir)
  const mine = now.find((p) => p.pid === pid && p.key === key)
  if (mine) return { ok: true, n: mine.n }
  if (now.length >= limit) return { ok: false, holders: now }
  for (let n = 1; n <= limit; n++) {
    if (now.some((p) => p.n === n)) continue
    try {
      fs.writeFileSync(path.join(dir, `slot-${n}.lock`), JSON.stringify({ pid, project, key, at: Date.now() }), { flag: "wx" })
      return { ok: true, n }
    } catch (e) { if (e.code !== "EEXIST") throw e } // место заняли между счётом и записью — следующее
  }
  return { ok: false, holders: placesNow(dir) }
}

/** Освободить места этого процесса под ключом key. → сколько снято. */
export function releasePlace(dir, { pid = process.pid, key }) {
  let n = 0
  for (const p of placesNow(dir)) {
    if (p.pid !== pid || p.key !== key) continue
    try { fs.unlinkSync(path.join(dir, `slot-${p.n}.lock`)); n++ } catch { /* уже снято */ }
  }
  return n
}

/** Текст отказа общего предела: кто держит места. */
export const holdersText = (holders) => holders.map((h) => (h.project || "?") + ": " + h.key).join(", ") || "места заняты"
