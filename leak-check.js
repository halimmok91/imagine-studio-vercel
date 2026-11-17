"use strict";

// Routing and request-shape self-check. Run: node leak-check.js
// Uses the real handler with two local mock upstreams; no live keys required.
const http = require("http");
const assert = require("assert");

const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function startMock(port, provider) {
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      srv.received = srv.received || [];
      srv.received.push({ url: req.url, contentType: req.headers["content-type"] || "", body });
      const isVerify = req.url.endsWith("/models");
      const invalid = req.headers.authorization === "Bearer sk-invalid";
      if (invalid) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: provider === "goodapi" ? "无效的令牌 (request id: abc123)" : "Invalid token (request id: abc123)" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(isVerify ? { data: [] } : { data: [{ url: "https://cdn.example/image.png" }] }));
    });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}

function makeRes() {
  return {
    _code: 0, _json: null, _headers: {},
    setHeader(k, v) { this._headers[k.toLowerCase()] = v; return this; },
    end() { return this; },
    status(code) { this._code = code; return this; },
    json(obj) { this._json = obj; return this; },
  };
}
async function call(handler, method, url, headers, body) {
  const res = makeRes();
  await handler({ method, url, headers: headers || {}, body: body || {} }, res);
  return res;
}

(async () => {
  const s1 = await startMock(3001, "aiapi");
  const s2 = await startMock(3002, "goodapi");
  try {
    Object.assign(process.env, {
      AIAPI_BASE: "http://127.0.0.1:3001",
      GOODAPI_BASE: "http://127.0.0.1:3002",
      AIAPI_MODEL: "gpt-image-2.5-sunburst-按次",
      GOODAPI_MODEL_1K: "gemini-nano-banana-2.1",
      GOODAPI_MODEL_2K: "gemini-nano-banana-2.1-2k",
      GOODAPI_MODEL_4K: "gemini-nano-banana-2.1-4k",
      AIAPI_KEY: "", GOODAPI_KEY: "",
    });
    delete require.cache[require.resolve("./api/_lib/handler.js")];
    const handler = require("./api/_lib/handler.js");
    const auth = { authorization: "Bearer sk-testkey1234567890", "x-requested-with": "fetch" };

    let res = await call(handler, "GET", "/api/public/v1/models", {});
    assert.strictEqual(res._code, 200, "site opens without a password");

    // A browser opening the URL directly gets sent home; the app's fetches
    // carry X-Requested-With so they still receive JSON.
    res = await call(handler, "GET", "/api/public/v1/models", { accept: "text/html,application/xhtml+xml" });
    assert.strictEqual(res._code, 302, "browser nav redirects");
    assert.strictEqual(res._headers["location"], "/");

    res = await call(handler, "GET", "/api/public/v1/models", auth);
    assert.strictEqual(res._code, 200);
    assert.strictEqual(res._json.keyRequired, true);
    // Provider identity and upstream URLs must not be exposed.
    const modelsRaw = JSON.stringify(res._json);
    for (const bad of ["upstreams", "upstream", "keyed", "ai-api.pro", "goodapi.click", "127.0.0.1", "按次"]) {
      assert.ok(!modelsRaw.includes(bad), "models response leaks " + bad);
    }
    assert.ok(res._json.models.every(m => m.provider === undefined), "models hide provider");
    assert.deepStrictEqual(res._json.models.map(m => m.id), [
      "gpt-image-2.5-sunburst",
      "gemini-nano-banana-2.1",
      "gemini-nano-banana-2.1-2k",
      "gemini-nano-banana-2.1-4k",
    ]);

    // Reference images use edits and arrive as multipart image[] on first try.
    s1.received = [];
    res = await call(handler, "POST", "/api/public/v1/generate", auth,
      { prompt: "use this reference", model_id: "gpt-image-2.5-sunburst", images: [PNG_1PX] });
    assert.strictEqual(res._code, 200, JSON.stringify(res._json));
    assert.strictEqual(res._json.result_urls[0], "https://cdn.example/image.png");
    assert.strictEqual(s1.received.length, 1);
    assert.strictEqual(s1.received[0].url, "/v1/images/edits");
    assert.match(s1.received[0].contentType, /multipart\/form-data/);
    assert.match(s1.received[0].body.toString("latin1"), /name="image\[\]"/);
    assert.match(s1.received[0].body.toString("utf8"), /gpt-image-2\.5-sunburst-按次/);

    // Nano Banana routes to GoodAPI with its real model id and ratio.
    s2.received = [];
    res = await call(handler, "POST", "/api/public/v1/generate", auth,
      { prompt: "banana", model_id: "gemini-nano-banana-2.1-2k", ratio: "16:9" });
    assert.strictEqual(res._code, 200, JSON.stringify(res._json));
    assert.strictEqual(s2.received.length, 1);
    assert.strictEqual(s2.received[0].url, "/v1/images/generations");
    const payload = JSON.parse(s2.received[0].body.toString("utf8"));
    assert.strictEqual(payload.model, "gemini-nano-banana-2.1-2k");
    assert.strictEqual(payload.size, "16:9");
    assert.strictEqual(payload.response_format, "b64_json");

    // Upstream errors keep the real message but hide provider host and model id.
    res = await call(handler, "POST", "/api/public/v1/generate",
      { authorization: "Bearer sk-invalid" },
      { prompt: "hi", model_id: "gemini-nano-banana-2.1" });
    assert.strictEqual(res._code, 401);
    assert.match(res._json.error, /无效的令牌/);
    assert.match(res._json.error, /gemini-nano-banana-2\.1/);
    assert.ok(!/127\.0\.0\.1|goodapi\.click/.test(res._json.error), "error hides upstream host");

    // Server keys must never authorize a request without a Settings key.
    process.env.AIAPI_KEY = "sk-server";
    res = await call(handler, "POST", "/api/public/v1/generate",
      {}, { prompt: "server key", model_id: "gpt-image-2.5-sunburst" });
    assert.strictEqual(res._code, 401, "keyless generation must be rejected");
    assert.ok(!/AIAPI_KEY|ai-api\.pro/.test(res._json.error), "keyless error hides provider and env var");
    delete process.env.AIAPI_KEY;

    res = await call(handler, "POST", "/api/public/v1/verify", auth, {});
    assert.strictEqual(res._code, 200);
    assert.strictEqual(res._json.ok, true);
    assert.strictEqual(res._json.provider, "aiapi");
    assert.strictEqual(res._json.site, undefined, "verify hides the site name");
    assert.strictEqual(res._json.base, undefined, "verify hides the base URL");

    console.log("self-check: OK (hidden metadata, raw upstream messages, Nano Banana routing, multipart references)");
  } finally {
    await Promise.all([new Promise((r) => s1.close(r)), new Promise((r) => s2.close(r))]);
  }
})().catch((e) => {
  console.error("self-check FAILED\n" + (e && e.stack ? e.stack : e));
  process.exit(1);
});
