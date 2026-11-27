// Экран прогонов на машине (laptop-view.mjs): HTTP только для чтения — Host, методы, страница, состояние, проба.
//   node --test scripts/dev/dashboard/laptop-view.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { bootHtml, viewHandler } from "./laptop-view.mjs";

const call = (port, { method = "GET", path = "/", host } = {}) => new Promise((res, rej) => {
    const r = http.request({ host: "127.0.0.1", port, method, path, headers: { host: host || "127.0.0.1:" + port } }, (x) => {
        let b = ""; x.on("data", (d) => { b += d; }); x.on("end", () => res({ code: x.statusCode, type: x.headers["content-type"], body: b }));
    });
    r.on("error", rej); r.end();
});

test("viewHandler: чужой Host — 403, не GET — 405; страница, состояние и проба отдаются", async () => {
    let n = 0;
    const srv = http.createServer(viewHandler({ port: 0, state: () => ({ n: ++n, state: "idle" }) }));
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    // viewHandler проверяет Host по своему порту: пересоздаём с настоящим
    srv.removeAllListeners("request");
    srv.on("request", viewHandler({ port, state: () => ({ n: ++n, state: "idle" }) }));
    try {
        assert.equal((await call(port, { host: "evil.example:" + port })).code, 403);
        assert.equal((await call(port, { method: "POST", path: "/api/laptop" })).code, 405);
        const page = await call(port);
        assert.equal(page.code, 200);
        assert.match(page.type, /text\/html/);
        const st = await call(port, { path: "/api/laptop" });
        assert.equal(st.code, 200);
        assert.equal(JSON.parse(st.body).state, "idle");
        assert.equal((await call(port, { path: "/ping.gif" })).type, "image/gif");
        assert.equal((await call(port, { path: "/no-such-page" })).code, 404);
    }
    finally { srv.close(); }
});

test("bootHtml: проба своего порта, рамка показывается только после ответа", () => {
    const h = bootHtml(4799);
    assert.match(h, /http:\/\/127\.0\.0\.1:4799\//);
    assert.match(h, /ping\.gif/);
});
