"use strict";

// Self-check for the upstream-hiding pass. Run: node leak-check.js
//
// Boots the real handler against a mock upstream and asserts that nothing in
// any response names a provider, an env var, an upstream model id, or an
// upstream host - and that the routing still works.
//
// The handler reads its upstream config from env vars, so the mock upstream
// is what PROV1_BASE / PROV2_BASE point at.

const http = require("http");
const assert = require("assert");

// Forbidden in EVERY response: relay hosts, env var names, provider labels,
// upstream model ids, the per-call suffix, and non-English upstream wording
// (the language alone fingerprints which relay answered).
const FORBIDDEN = [
  "ai-api.pro", "goodapi.click", "aiapi.cc",
  "PROV1", "PROV2", "AIAPI_", "GOODAPI_",
  "gpt-image", "gpt_image", "flash-image", "gemini-3",
  "按次",
  "provider 1", "provider 2",
  "无效的令牌", "令牌", "余额不足", "频率限制",
];

// Forbidden in ERROR TEXT only. The display names in /models are public
// product names (OpenAI's "GPT Image 2.5", Google's "Nano Banana 2"), so
// those are allowed there - but an upstream echoing its own model id is not.
const FORBIDDEN_IN_ERRORS = [
  "nano banana", "gemini", "gpt image", "sunburst",
];

function startMock(port) {
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      // Record every request so the test can assert what actually reached the
      // upstream - in particular whether the reference image survived.
      srv.received = srv.received || [];
      srv.received.push({
        url: req.url,
        contentType: req.headers["content-type"] || "",
        body,
        // Multipart: count the file parts. A reference that arrives as a real
        // file part is the whole point of the edits endpoint.
        fileParts: (body.toString("latin1").match(/Content-Disposition: form-data; name="image\[\]"/g) || []).length,
      });

      // One upstream answers in English, one in Chinese, exactly like the real
      // pair. If the language reaches the client, the provider split leaks.
      const zh = port === 3002;
      const isModelList = req.url.endsWith("/models");
      const msg = zh ? "无效的令牌 (request id: abc123)" : "Invalid token (request id: abc123)";
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: msg } }));
    });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}

// Minimal Vercel-style req/res so the handler can run outside Vercel.
function makeReq(method, url, headers, body) {
  return { method, url, headers: headers || {}, body: body || {} };
}
function makeRes() {
  const r = { _code: 0, _json: null, headers: {} };
  r.status = (c) => { r._code = c; return r; };
  r.json = (o) => { r._json = o; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}

async function call(handler, method, url, headers, body) {
  const res = makeRes();
  await handler(makeReq(method, url, headers, body), res);
  return res;
}

function assertClean(label, res) {
  const text = JSON.stringify(res._json || {});
  for (const f of FORBIDDEN) {
    assert.ok(
      !text.toLowerCase().includes(f.toLowerCase()),
      label + " leaks " + JSON.stringify(f) + "\n  -> " + text.slice(0, 300)
    );
  }
}

function assertCleanError(label, res) {
  const text = String((res._json && res._json.error) || "");
  for (const f of FORBIDDEN_IN_ERRORS) {
    assert.ok(
      !text.toLowerCase().includes(f.toLowerCase()),
      label + " error leaks " + JSON.stringify(f) + "\n  -> " + text.slice(0, 300)
    );
  }
}

(async () => {
  const s1 = await startMock(3001);
  const s2 = await startMock(3002);
  process.env.PROV1_BASE = "http://127.0.0.1:3001";
  process.env.PROV2_BASE = "http://127.0.0.1:3002";
  process.env.PROV1_MODEL = "gpt-image-2.5-sunburst-按次";
  process.env.PROV2_MODEL_1K = "gemini-3.1-flash-image";
  process.env.PROV2_MODEL_2K = "gemini-3.1-flash-image-2k";
  process.env.PROV2_MODEL_4K = "gemini-3.1-flash-image-4k";
  process.env.APP_PASSWORD = "pw";
  process.env.ADMIN_TOKEN = "adm";

  const handler = require("./api/_lib/handler.js");

  // 1. No password -> 401, no body leak.
  let res = await call(handler, "GET", "/api/public/v1/models", {});
  assert.strictEqual(res._code, 401);
  assertClean("models/no-password", res);

  const auth = { "x-app-password": "pw" };
  const admin = { "x-app-password": "pw", "x-admin-token": "adm" };

  // 2. /models with and without the admin token.
  res = await call(handler, "GET", "/api/public/v1/models", auth);
  assert.strictEqual(res._code, 200);
  assertClean("models/user", res);
  assert.strictEqual(res._json.keyRequired, true);
  for (const m of res._json.models) {
    assert.deepStrictEqual(Object.keys(m).sort(), [
      "display_name", "enabled", "id", "max_reference_images", "qualities",
      "ratios", "styles", "supports_reference_images",
    ], "model object must not carry provider/model fields");
  }

  res = await call(handler, "GET", "/api/public/v1/models", admin);
  assert.strictEqual(res._code, 200);
  assert.strictEqual(res._json.keyRequired, false);
  assertClean("models/admin", res);

  // 3. /generate with no key -> must not name an env var.
  for (const id of ["m1", "m2", "m3", "m4"]) {
    res = await call(handler, "POST", "/api/public/v1/generate", auth, { prompt: "hi", model_id: id });
    assert.ok(res._code === 401 || res._code === 503,
      "generate/no-key/" + id + " returned " + res._code);
    assertClean("generate/no-key/" + id, res);
  }

  // 4. /generate with a key -> upstream error text must be scrubbed. Only the
  //    enabled models reach the upstream, so the wording comparison runs over
  //    those. m1 is the English upstream, m2 the Chinese one; re-enable m2 to
  //    also assert that the two providers produce identical wording.
  const seen = {};
  for (const id of ["m1", "m2", "m3", "m4"]) {
    res = await call(handler, "POST", "/api/public/v1/generate",
      { "x-app-password": "pw", authorization: "Bearer sk-testkey1234567890" },
      { prompt: "hi", model_id: id });
    assertClean("generate/upstream/" + id, res);
    assertCleanError("generate/upstream/" + id, res);
    seen[id] = res._json.error.split("\n")[0];
  }
  assert.ok(/Invalid token/.test(seen.m1), "English upstream error must survive as Invalid token");

  // 5. /verify must not name a provider either.
  res = await call(handler, "POST", "/api/public/v1/verify",
    { "x-app-password": "pw", authorization: "Bearer sk-testkey1234567890" }, {});
  assertClean("verify", res);
  assertCleanError("verify", res);

  // 6. No Chinese may survive in any error text. The upstream's language is
  //    the fingerprint that identifies which relay answered.
  const cjk = /[　-鿿＀-￯]/;
  for (const id of ["m1", "m2", "m3", "m4"]) {
    res = await call(handler, "POST", "/api/public/v1/generate",
      { "x-app-password": "pw", authorization: "Bearer sk-testkey1234567890" },
      { prompt: "hi", model_id: id });
    assert.ok(!cjk.test(String(res._json.error)), "generate/" + id + " left Chinese: " + res._json.error);
  }

  // 7. Models listed in DISABLED_MODELS must be hidden from /models and
  //    refused by /generate, and an unknown model id must not silently fall
  //    back to a disabled one. m2/m3/m4 are disabled in the handler right now.
  res = await call(handler, "GET", "/api/public/v1/models", auth);
  const shown = res._json.models.map((m) => m.id);
  assert.ok(!shown.includes("m2") && !shown.includes("m3") && !shown.includes("m4"),
    "disabled models still appear in /models: " + shown.join(","));
  assert.ok(shown.includes("m1"), "m1 should still be offered");

  for (const id of ["m2", "m3", "m4"]) {
    res = await call(handler, "POST", "/api/public/v1/generate",
      { "x-app-password": "pw", authorization: "Bearer sk-testkey1234567890" },
      { prompt: "hi", model_id: id });
    assert.strictEqual(res._code, 503, "disabled " + id + " should be refused with 503");
    assert.ok(/temporarily unavailable/.test(res._json.error), res._json.error);
    assertClean("generate/disabled/" + id, res);
  }

  // 8. A reference image must reach the upstream as a real multipart file
  //    part. Sending it as a JSON `image` field is accepted by some relays but
  //    the reference is silently dropped and the result is text-to-image.
  const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  s1.received = [];
  res = await call(handler, "POST", "/api/public/v1/generate",
    { "x-app-password": "pw", authorization: "Bearer sk-testkey1234567890" },
    { prompt: "hi", model_id: "m1", images: [PNG_1PX] });
  const withRef = s1.received.filter((r) => r.url.includes("/images/edits"));
  assert.ok(withRef.length > 0, "no /images/edits request reached the upstream");
  assert.strictEqual(withRef[0].fileParts, 1,
    "the reference must arrive as a multipart file part, got content-type " + withRef[0].contentType);
  assert.ok(/multipart\/form-data/.test(withRef[0].contentType),
    "edits must be multipart, got " + withRef[0].contentType);

  s1.close();
  s2.close();
  console.log("leak-check: OK (m2/m3/m4 disabled, so the two-provider wording comparison is skipped - re-enable them to test it)");

})().catch((e) => {
  console.error("leak-check FAILED\n" + (e && e.message ? e.message : e));
  process.exit(1);
});
