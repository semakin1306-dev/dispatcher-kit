// backlog-store.mjs — файлы элементов бэклога BL-NNNN-<слаг>.md: список, чтение, создание с новым номером и правка полей
// и разделов с атомарной записью.
import fs from "node:fs";
import path from "node:path";
import { writeAtomicSync } from "./store.mjs";
import { FILE_RE, ID_RE, checkPatch, checkSet, fileNameOf, itemOf, newItemText, nextId, setMeta, setSection, setTitle, titleOf, parseItem } from "./backlog-rules.mjs";

const files = (dir) => {
    try {
        return fs.readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
    }
    catch {
        return [];
    }
};

export function listItems(dir) {
    const out = [];
    for (const f of files(dir)) {
        const p = path.join(dir, f);
        try {
            const st = fs.statSync(p);
            out.push({ ...itemOf(f, fs.readFileSync(p, "utf8")), mtime: st.mtimeMs });
        }
        catch (e) {
            out.push({ id: FILE_RE.exec(f)[1], file: f, status: "new", title: f, error: e.message, area: [] });
        }
    }
    return out;
}

export function fileOf(dir, id) {
    if (!ID_RE.test(String(id)))
        return null;
    return files(dir).find((f) => f.startsWith(id + "-")) || null;
}

export function readItem(dir, id) {
    const f = fileOf(dir, id);
    if (!f) {
        const e = new Error("нет элемента " + id);
        e.code = 404;
        throw e;
    }
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    return { file: f, path: path.join(dir, f), text, item: itemOf(f, text) };
}

export function createItem(dir, { text, source = "", area = "", retro = "", at = Date.now() }) {
    fs.mkdirSync(dir, { recursive: true });
    for (let k = 0; k < 20; k++) {
        const id = nextId(files(dir)), body = newItemText({ id, text, source, area, retro, at }), f = fileNameOf(id, titleOf(parseItem(body).body));
        const p = path.join(dir, f);
        try {
            fs.closeSync(fs.openSync(p, "wx"));
        }
        catch (e) {
            if (e.code !== "EEXIST")
                throw e;
            continue;
        }
        writeAtomicSync(p, body);
        return { file: f, path: p, item: itemOf(f, body) };
    }
    throw new Error("не нашлось свободного номера BL");
}

export function updateItem(dir, id, { set = {}, title = "", sections = {} } = {}) {
    const cur = readItem(dir, id);
    let text = cur.text.replace(/\r\n?/g, "\n");
    const patch = {};
    for (const [k, v] of Object.entries(set)) {
        if (k === "title") {
            title = title || v;
            continue;
        }
        patch[k] = checkSet(k, v);
    }
    checkPatch(cur.item.meta, patch);
    if (Object.keys(patch).length)
        text = setMeta(text, patch);
    if (title)
        text = setTitle(text, title);
    for (const [h, body] of Object.entries(sections))
        text = setSection(text, h, body);
    if (text !== cur.text)
        writeAtomicSync(cur.path, text);
    return { file: cur.file, path: cur.path, item: itemOf(cur.file, text), changed: text !== cur.text };
}

export function parseSets(args) {
    const out = {};
    for (const a of args) {
        const m = /^([\w-]+)=(.*)$/s.exec(a);
        if (!m)
            throw new Error("ожидалось поле=значение: " + a);
        out[m[1]] = m[2];
    }
    return out;
}
