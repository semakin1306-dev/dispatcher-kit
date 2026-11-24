// state.js — общее изменяемое состояние страницы: то, что пишут несколько модулей, и общие наборы вида. Привязки импорта
// живые; присвоить импортированное имя модуль не может — запись только через setState("ИМЯ", значение). Модуль-лист: сам
// ничего не импортирует.
export const TOKEN = (document.querySelector('meta[name="dash-token"]') || {}).content || "";
export let S = null;

export let VIEW = (() => {
    try {
        return localStorage.getItem("dash.view") === "kanban" ? "kanban" : "dash";
    }
    catch {
        return "dash";
    }
})();

export let FILTER = "all";

export let VIEW_EPIC = (() => {
    try {
        return localStorage.getItem("dash.epic") || "";
    }
    catch {
        return "";
    }
})();

export let IN = {};

try {
    IN = JSON.parse(localStorage.getItem("dash.inputs") || "{}");
}
catch { }

export const OPEN = new Set((() => {
    try {
        return JSON.parse(localStorage.getItem("dash.open") || "[]");
    }
    catch {
        return [];
    }
})());

export const OPENCHAT = new Set((() => {
    try {
        return JSON.parse(localStorage.getItem("dash.chats") || "[]");
    }
    catch {
        return [];
    }
})());

export const SEL = {};
export const PENDING = new Set();
export const BTN_BUSY = new Set();
export let CUR_BTN = null;
export let drawer = null, logPos = 0, logFinal = false, logAt = 0;
export let SELK = null, FOCUS = null;

export let SFX_OPEN = null, SFX_HIDE = (() => {
    try {
        return localStorage.getItem("dash.sfxhide") || null;
    }
    catch {
        return null;
    }
})();

export let REM_ADD_OPEN = false;

export let GGOPEN = (() => {
    try {
        return localStorage.getItem("dash.ggopen") === "1";
    }
    catch {
        return false;
    }
})();

export let ACC_HEADED = (() => {
    try {
        return localStorage.getItem("dash.accheaded") === "1";
    }
    catch {
        return false;
    }
})();

const W = {
    S: (v) => (S = v), VIEW: (v) => (VIEW = v), FILTER: (v) => (FILTER = v), VIEW_EPIC: (v) => (VIEW_EPIC = v), IN: (v) => (IN = v),
    CUR_BTN: (v) => (CUR_BTN = v), drawer: (v) => (drawer = v), logPos: (v) => (logPos = v), logFinal: (v) => (logFinal = v), logAt: (v) => (logAt = v),
    SELK: (v) => (SELK = v), FOCUS: (v) => (FOCUS = v), SFX_OPEN: (v) => (SFX_OPEN = v), SFX_HIDE: (v) => {
        SFX_HIDE = v;
        try {
            v ? localStorage.setItem("dash.sfxhide", v) : localStorage.removeItem("dash.sfxhide");
        }
        catch { }
        return v;
    },
    REM_ADD_OPEN: (v) => (REM_ADD_OPEN = v), GGOPEN: (v) => (GGOPEN = v), ACC_HEADED: (v) => (ACC_HEADED = v),
};

export function setState(name, v) {
    const w = W[name];
    if (!w)
        throw new Error("setState: нет такого имени — " + name);
    return w(v);
}
