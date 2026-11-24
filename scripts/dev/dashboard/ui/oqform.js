// oqform.js — форма ответа на «Вопросы владельцу»: у каждого вопроса варианты агента (выбор, а не мгновенная отправка) и
// своё поле ответа; все ответы уходят одним сообщением. Выбор и набранное переживают перерисовку и перезагрузку.
import { IN, PENDING } from "./state.js";
import { esc, SPIN } from "./core.js";
import { answerText, composeAnswers, optPrefix, questionsKey, quickOptions } from "./owner-options.js";

const selKey = (scope, n) => "oqs|" + scope + "|" + n;
const txtKey = (scope, n) => "oqa|" + scope + "|" + n;
export const oqScope = (who, qs) => who + "#" + questionsKey(qs);

export function oqFormHTML(qs, { mode, target, scope, extraKey = "", max = 90 }) {
    const busy = PENDING.has("oqsubmit|" + scope);
    const rows = qs.map((q) => {
        const sel = IN[selKey(scope, q.n)] || "", custom = IN[txtKey(scope, q.n)] || "";
        const pills = quickOptions(q).map((o) => {
            const on = !String(custom).trim() && sel === o.k;
            return `<button class="sm ${on ? "primary" : ""}" data-act="oqsel" data-scope="${esc(scope)}" data-n="${esc(q.n)}" data-k="${esc(o.k)}" data-text="${esc(answerText(q, o))}" title="${esc(o.v)}" aria-pressed="${on}">${esc(optPrefix(o))}${esc(o.v.length > max ? o.v.slice(0, max - 1) + "…" : o.v)}${o.rec ? ` <span class="mute">· рекомендую</span>` : ""}</button>`;
        }).join("");
        return `<div class="oqrow" data-n="${esc(q.n)}" style="margin:6px 0"><div style="font-size:13px;margin-bottom:4px"><b>${esc(q.n)}.</b> ${esc(q.head)}</div>`
            + (pills ? `<div class="chips" style="flex-wrap:wrap;gap:6px;margin-bottom:4px">${pills}</div>` : "")
            + `<input type="text" data-ik="${esc(txtKey(scope, q.n))}" value="${esc(custom)}" placeholder="${pills ? "или свой ответ на вопрос " + esc(q.n) : "ответ на вопрос " + esc(q.n) + " (агент не дал вариантов)"}" style="width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;padding:5px 8px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text)"></div>`;
    }).join("");
    const extra = extraKey ? `<textarea data-ik="${esc(extraKey)}" rows="2" placeholder="Комментарий ко всем ответам (необязательно)" style="width:100%;box-sizing:border-box;margin:4px 0;font:inherit;font-size:12.5px;padding:6px 8px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text);resize:vertical">${esc(IN[extraKey] || "")}</textarea>` : "";
    return `<div class="oqform" data-scope="${esc(scope)}" data-mode="${esc(mode)}" data-target="${esc(target)}" data-extra="${esc(extraKey)}">${rows}${extra}`
        + `<div class="chips" style="margin-top:6px"><button class="sm primary ${busy ? "busy" : ""}" data-act="oqsubmit">${busy ? SPIN : "➤"} Ответить${qs.length > 1 ? " на все" : ""}</button><span class="sub mute" style="align-self:center">выберите вариант или впишите свой — уйдёт одним сообщением</span></div></div>`;
}

export function oqPick(el) {
    const k = selKey(el.dataset.scope, el.dataset.n), now = IN[k] === el.dataset.k ? "" : el.dataset.k;
    IN[k] = now;
    IN[txtKey(el.dataset.scope, el.dataset.n)] = "";
    const row = el.closest(".oqrow");
    if (!row)
        return;
    for (const b of row.querySelectorAll('[data-act="oqsel"]')) {
        const on = b.dataset.k === now;
        b.classList.toggle("primary", on);
        b.setAttribute("aria-pressed", String(on));
    }
    const inp = row.querySelector("input[data-ik]");
    if (inp)
        inp.value = "";
}

export function oqCollect(form) {
    const scope = form.dataset.scope, extraKey = form.dataset.extra, rows = [], keys = [];
    for (const row of form.querySelectorAll(".oqrow")) {
        const n = row.dataset.n, sel = IN[selKey(scope, n)] || "", btn = sel ? row.querySelector(`[data-act="oqsel"][data-k="${CSS.escape(sel)}"]`) : null;
        rows.push({ n, picked: btn ? btn.dataset.text : "", custom: IN[txtKey(scope, n)] || "" });
        keys.push(selKey(scope, n), txtKey(scope, n));
    }
    if (extraKey)
        keys.push(extraKey);
    return { ...composeAnswers(rows, extraKey ? IN[extraKey] : ""), scope, mode: form.dataset.mode, target: form.dataset.target, keys };
}
