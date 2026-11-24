// retro.js — окно «Ретроспектива эпика» и кнопка «Закрыть эпик»: после закрытия сервер ставит агента ретро, окно
// показывает его ход и ответ и само обновляется, пока агент работает.
import { $, call, esc, mdDoc, toast } from "./core.js";

const hm = (t) => (t ? new Date(t).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const WORD = { running: "ретро-агент работает…", ok: "готово", fail: "не удалось", collected: "вход собран (сухой режим: агент не запускался)" };

export function openRetro(id, note = "") {
    let timer = null;
    const open = () => $("modal").classList.contains("on") && $("rtBody");
    $("mb").innerHTML = `<h3 id="rtHead">Ретроспектива · ${esc(id)}</h3><div style="display:flex;gap:6px;align-items:center;margin-bottom:6px"><span class="sub" id="rtSt" style="font-size:12px">загрузка…</span><span style="flex:1"></span><button class="sm" id="rtRun" title="Собрать ретро заново: агент читает журнал эпика, прогоны, логи красного и план">Собрать заново</button><button class="ghost" data-act="mclose">Закрыть</button></div>${note ? `<div class="sub" style="font-size:12px;margin-bottom:6px;white-space:pre-wrap">${esc(note)}</div>` : ""}<div id="rtBody" style="max-height:70vh;overflow:auto">…</div>`;
    $("modal").classList.add("on");
    async function draw() {
        clearTimeout(timer);
        let r;
        try {
            r = await call("/api/retro?epic=" + encodeURIComponent(id));
        }
        catch (e) {
            if (open())
                $("rtSt").textContent = e.message;
            return;
        }
        if (!open())
            return;
        const x = r.retro;
        $("rtHead").textContent = "Ретроспектива · " + (r.title || id);
        $("rtSt").textContent = !x ? "ретро ещё не было" + (r.auto ? " · у закрытого эпика оно запускается само" : "") : WORD[x.status] + " · " + hm(x.at) + (x.status === "running" ? " (обычно 1–3 мин)" : "") + ((x.items || []).length ? " · карточки бэклога: " + x.items.join(", ") : "") + (x.error ? " · " + x.error : "");
        $("rtRun").disabled = !!(x && x.status === "running");
        $("rtBody").innerHTML = r.text ? `<div class="sub" style="font-size:11px;margin-bottom:6px">${esc(x.file || "")}</div><div class="md">${mdDoc(r.text)}</div>` : x && x.status === "running" ? '<div class="sub">агент читает журнал эпика, прогоны, логи красного и план — окно обновится само</div>' : x && x.input ? `<div class="sub">вход агента: ${esc(x.input)}</div>` : '<div class="sub">нажмите «Собрать заново», чтобы запустить ретро-агента</div>';
        if (x && x.status === "running")
            timer = setTimeout(draw, 5000);
    }
    $("rtRun").onclick = async () => {
        $("rtRun").disabled = true;
        try {
            await call("/api/retro", { epic: id, force: true });
        }
        catch (e) {
            $("rtSt").textContent = e.message;
        }
        draw();
    };
    draw();
}

export async function closeEpic(id, title) {
    if (!confirm("Закрыть эпик «" + (title || id) + "»?\n\nПроверки — как у навыка close-epic: ветка оркестратора влита в staging, нет несохранённых файлов и невлитых веток слотов. Папки и ветки не удаляются. После закрытия сразу запустится ретро-агент."))
        return;
    let r;
    try {
        r = await call("/api/epic", { op: "close", id });
    }
    catch (e) {
        const pr = (e.data && e.data.problems) || [];
        if (!pr.length || !confirm("Эпик нельзя закрыть:\n- " + pr.join("\n- ") + "\n\nЗакрыть всё равно (--force)?")) {
            toast(e.message);
            return;
        }
        try {
            r = await call("/api/epic", { op: "close", id, force: true });
        }
        catch (e2) {
            toast(e2.message);
            return;
        }
    }
    openRetro(id, "Эпик закрыт. " + (r.retroMsg || "") + "\n" + (r.out || "").split("\n").filter((l) => /ветка осталась|закрыт/.test(l)).slice(0, 4).join("\n"));
}
