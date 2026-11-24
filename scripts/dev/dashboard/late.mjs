// late.mjs — поздняя привязка между модулями сервера. Модуль нижнего слоя зовёт модуль выше, не импортируя его: берёт
// обёртку late("<модуль>", [...]), а сами модули подставляет wiring.mjs при запуске. Так разорваны циклы импортов.
const mods = new Map();
const wanted = new Set();

function need(mod, name) {
    const ns = mods.get(mod);
    if (!ns)
        throw new Error("late.mjs: модуль " + mod + " не подключён (wiring.mjs), нужен " + name);
    return ns[name];
}

export function late(mod, names) {
    const out = {};
    for (const n of names) {
        wanted.add(mod + ":" + n);
        out[n] = (...a) => need(mod, n)(...a);
    }
    return out;
}

export function lateObject(mod, name) {
    wanted.add(mod + ":" + name);
    return new Proxy({}, { get(_, p) {
            const o = need(mod, name), v = Reflect.get(o, p, o);
            return typeof v === "function" ? v.bind(o) : v;
        } });
}

export function provide(map) {
    for (const [k, ns] of Object.entries(map))
        mods.set(k, ns);
}

export const unbound = () => [...wanted].filter((k) => {
    const [m, n] = k.split(":"), ns = mods.get(m);
    return !ns || !(n in ns);
}).sort();

export const lateList = () => [...wanted].sort();
