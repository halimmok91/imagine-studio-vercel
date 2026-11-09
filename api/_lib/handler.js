"use strict";

// Serverless port of the desktop adapter. Two differences from the desktop
// build, both forced by Vercel:
//   1. No shared memory between invocations, so `generate` is SYNCHRONOUS. The
//      old POST -> generation_id -> poll dance cannot survive a cold start.
//   2. No filesystem, so the six disk endpoints are gone. Save/Export use the
//      browser's own download instead.

// Provider hosts and model names come from AIAPI_*/GOODAPI_* variables.
//
// This file lives under api/_lib because Vercel ignores underscore-prefixed
// files inside api/, so the implementation is not exposed as a public route.
const PROVIDERS = {
  aiapi: {
    base: (process.env.AIAPI_BASE || "").replace(/\/+$/, ""),
    envVar: "AIAPI_KEY",
    label: "ai-api.pro",
  },
  goodapi: {
    base: (process.env.GOODAPI_BASE || "").replace(/\/+$/, ""),
    envVar: "GOODAPI_KEY",
    label: "goodapi.click",
  },
};

// Provider 1 accepts only these three pixel sizes despite OpenAI's wider docs.
const SIZES = { "1:1": "1024x1024", "16:9": "1536x864", "9:16": "864x1536" };

// Provider 2 takes 14 ratios and wants the ratio string in `size`, not pixels.
const GEMINI_RATIOS = [
  "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4",
  "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1",
];

const MODEL_ROWS = [
  { id: "gpt-image-2.5-sunburst", model_id: process.env.AIAPI_MODEL || "", display_name: "GPT Image 2.5 · Sunburst", provider: "aiapi", ratios: Object.keys(SIZES) },
  { id: "gemini-nano-banana-2.1", model_id: process.env.GOODAPI_MODEL_1K || "", display_name: "Nano Banana 2.1 · 1K", provider: "goodapi", ratios: GEMINI_RATIOS },
  { id: "gemini-nano-banana-2.1-2k", model_id: process.env.GOODAPI_MODEL_2K || "", display_name: "Nano Banana 2.1 · 2K", provider: "goodapi", ratios: GEMINI_RATIOS },
  { id: "gemini-nano-banana-2.1-4k", model_id: process.env.GOODAPI_MODEL_4K || "", display_name: "Nano Banana 2.1 · 4K", provider: "goodapi", ratios: GEMINI_RATIOS },
];

// Temporarily take models offline by listing their real public ids here.
// Disabled models are hidden from /models and refused by /generate.
const DISABLED_MODELS = new Set([]);

// Public metadata includes the provider so clients can inspect routing.
const MODELS = MODEL_ROWS.filter((m) => !DISABLED_MODELS.has(m.id)).map((m) => ({
  id: m.id,
  display_name: m.display_name,
  provider: m.provider,
  enabled: true,
  supports_reference_images: true,
  max_reference_images: 4,
  qualities: [],
  ratios: m.ratios,
  styles: [],
}));

function pickModel(raw) {
  const m = String(raw || "").trim();
  const found = MODEL_ROWS.find((r) => r.id === m || r.model_id === m);
  // Fall back to the first ENABLED model, never to a disabled one - otherwise
  // a missing/unknown model id would silently route to an offline provider.
  if (found) return found;
  return MODEL_ROWS.find((r) => !DISABLED_MODELS.has(r.id)) || MODEL_ROWS[0];
}

// A key pasted from a web page carries zero-width / nbsp characters often
// enough that new-api answers "Invalid token" for a key that is otherwise fine.
function cleanKey(raw) {
  return String(raw || "")
    .replace(/[​-‍﻿ \u0000-\u001F\u007F-\u009F]/g, "")
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
}

// Every plausible form of the key, in order. Raw beats cleaned: a sanitizer
// that eats one byte of a valid token looks exactly like a wrong key.
//
// Settings keys are tried first, then the server's configured provider key.
function keyCandidates(req, provider) {
  const P = PROVIDERS[provider] || PROVIDERS.aiapi;
  const envKey = process.env[P.envVar] || "";
  const h = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  const out = [];
  // Settings key first — the customer's own quota.
  for (const [raw, src] of [[h, "Settings"]]) {
    if (!raw) continue;
    if (!out.some((c) => c.key === raw)) out.push({ key: raw, src, how: "as given" });
    const c = cleanKey(raw);
    if (c && !out.some((x) => x.key === c)) out.push({ key: c, src, how: "after stripping invisible chars" });
  }
  if (envKey && !out.some((c) => c.key === envKey)) {
    out.push({ key: envKey, src: "env", how: "as given" });
  }
  return out;
}

function maskKey(k) {
  if (!k) return "(none)";
  return k.length <= 12 ? k.slice(0, 3) + "…" : k.slice(0, 6) + "…" + k.slice(-4);
}

const SRC_LABEL = { Settings: "Settings", env: "Vercel env" };

const json = (res, code, obj) => res.status(code).json(obj);

module.exports = async function handler(req, res) {
  const url = req.url.split("?")[0];

  // Password gate. Root middleware.js cannot be used — Vercel CLI 65 treats it
  // as a root proxy that suppresses static files and api/ discovery, 404ing the
  // whole deployment. So the check lives here. APP_PASSWORD unset = gate off.
  // The client sends the password in x-app-password; never exposed to the page
  // source or to visitors who only have the URL.
  const APP_PW = process.env.APP_PASSWORD || "";
  if (APP_PW) {
    const sent = req.headers["x-app-password"] || "";
    if (sent !== APP_PW) return json(res, 401, { error: "password required", auth: true });
  }

  // ---- GET /api/public/v1/models --------------------------------------
  if (url === "/api/public/v1/models" && req.method === "GET") {
    const keyed = {
      aiapi: !!process.env.AIAPI_KEY,
      goodapi: !!process.env.GOODAPI_KEY,
    };
    return json(res, 200, {
      models: MODELS,
      keyRequired: !keyed.aiapi && !keyed.goodapi,
      keyed,
      upstream: PROVIDERS.aiapi.base,
      upstreams: { aiapi: PROVIDERS.aiapi.base, goodapi: PROVIDERS.goodapi.base },
      model: MODEL_ROWS[0].model_id,
    });
  }

  // ---- POST /api/public/v1/verify -------------------------------------
  // A key belongs to exactly one site and that is not knowable from the key,
  // so probe both. This also tells the user their key still works before they
  // spend a generation finding out.
  if (url === "/api/public/v1/verify" && req.method === "POST") {
    const keys = keyCandidates(req);
    if (!keys.length) return json(res, 400, { error: "no key" });
    let last = null;
    for (const { key, src, how } of keys) {
      for (const name of ["aiapi", "goodapi"]) {
        const P = PROVIDERS[name];
        if (!P.base) continue;
        const hit = { key: maskKey(key), len: key.length, source: src, how, provider: name, site: P.label, base: P.base };
        try {
          const r = await fetch(P.base + "/v1/models", {
            headers: { Authorization: "Bearer " + key },
            signal: AbortSignal.timeout(12000),
          });
          if (r.ok) return json(res, 200, { ok: true, ...hit });
          const t = await r.text();
          let m = "";
          try { m = JSON.parse(t).error?.message || ""; } catch (e) {}
          last = { ok: false, status: r.status, error: String(m || t.slice(0, 160)), ...hit };
        } catch (e) {
          last = { ok: false, status: 0, error: "could not reach the upstream: " + String(e.message), ...hit };
        }
      }
    }
    return json(res, 200, last);
  }

  // ---- POST /api/public/v1/generate -----------------------------------
  // Synchronous. The body carries reference images as data URLs directly —
  // there is no upload endpoint because there is nowhere to keep the bytes.
  if (url === "/api/public/v1/generate" && req.method === "POST") {
    const b = req.body || {};
    if (!b.prompt || !String(b.prompt).trim()) return json(res, 400, { error: "prompt is empty" });

    const row = pickModel(b.model_id || b.model);
    const provider = row.provider;
    if (DISABLED_MODELS.has(row.id)) {
      return json(res, 503, { error: "This model is temporarily unavailable. Pick another model." });
    }
    if (b.ratio && !row.ratios.includes(b.ratio)) {
      return json(res, 400, { error: "unsupported ratio for " + row.id + ": " + b.ratio });
    }

    const P = PROVIDERS[provider];
    if (!P.base) {
      return json(res, 500, { error: "This model is not available right now." });
    }
    const keys = keyCandidates(req, provider);
    if (!keys.length) {
      return json(res, 401, { error: "No key for " + P.label + ". Set " + P.envVar + " on the Vercel project, or paste a key in Settings." });
    }

    const size = provider === "goodapi"
      ? (GEMINI_RATIOS.includes(b.ratio) ? b.ratio : "1:1")
      : SIZES[b.ratio];

    const refs = (Array.isArray(b.images) ? b.images : []).filter(Boolean).slice(0, 4);
    const fmt = b.output_format || "png";
    const mime = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp" }[fmt] || "image/png";

    const payload = { model: row.model_id, prompt: b.prompt, n: b.n || 1 };
    if (provider === "goodapi") payload.response_format = "b64_json";
    else payload.output_format = fmt;
    if (size) payload.size = size;
    if (refs.length) payload.image = refs;

    const target = P.base + (refs.length ? "/v1/images/edits" : "/v1/images/generations");

    function jsonBody(key) {
      return {
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      };
    }

    // Build the multipart body the OpenAI edits endpoint expects. The refs are
    // data URLs, so decode each into a real file part.
    // OpenAI uses image[] for multiple files; a few relays only read `image`.
    // Both are tried before falling back to JSON.
    function multipartBody(key, fieldName) {
      const form = new FormData();
      form.append("model", payload.model);
      form.append("prompt", payload.prompt);
      form.append("n", String(payload.n));
      if (payload.size) form.append("size", payload.size);
      if (payload.output_format) form.append("output_format", payload.output_format);
      if (payload.response_format) form.append("response_format", payload.response_format);
      refs.forEach((ref) => {
        const m = /^data:([^;]+);base64,(.*)$/s.exec(ref);
        const bytes = Buffer.from(m ? m[2] : ref, "base64");
        form.append(fieldName, new Blob([bytes], { type: m ? m[1] : "image/png" }), "reference.png");
      });
      return { headers: { Authorization: "Bearer " + key }, body: form };
    }

    let lastErr = "";
    for (let ki = 0; ki < keys.length; ki++) {
      const { key, src, how } = keys[ki];
      const more = ki < keys.length - 1;
      // multipart with image[], then image, then JSON. One fallback chain per
      // key: a relay may reject the field name or the whole encoding.
      const attempts = refs.length ? ["multipart[]", "multipart", "json"] : ["json"];
      let r = null, text = "", j = null;
      for (const shape of attempts) {
        try {
          const opts = shape === "json" ? jsonBody(key)
            : multipartBody(key, shape === "multipart[]" ? "image[]" : "image");
          r = await fetch(target, {
            method: "POST",
            ...opts,
            // Hobby with Fluid Compute allows 300s. Keep this under vercel.json's
            // maxDuration so Vercel never kills the request before the function
            // can return the upstream error text.
            signal: AbortSignal.timeout(Number(process.env.UPSTREAM_TIMEOUT_MS) || 240000),
          });
          text = await r.text();
        } catch (e) {
          if (more) { lastErr = "invalid header: " + String(e.message); r = null; break; }
          return json(res, 502, { error: "upstream unreachable: " + String(e.message) });
        }

        j = null;
        try { j = JSON.parse(text); } catch (e) {}

        if (r.ok) break;
        lastErr = String((j && (j.error?.message || j.message)) || text.slice(0, 300));
        // Only retry the other body shape when the rejection looks like a
        // request-format problem. A 401 is the key, not the shape, so stop.
        if (r.status === 401) break;
      }
      if (!r) continue;

      if (!r.ok) {
        lastErr = String((j && (j.error?.message || j.message)) || text.slice(0, 300));
        if (r.status === 401 && more) continue;
        // Identify the attempted key, model and upstream for troubleshooting.
        return json(res, r.status, {
          error: lastErr + "\n\nkey sent: " + maskKey(key) + " (" + key.length + " chars, " + how + ") from " +
            (SRC_LABEL[src] || "your key") + " · model: " + row.model_id + " · site: " + P.base,
        });
      }

      const urls = ((j && j.data) || [])
        .map((d) => d.b64_json ? "data:" + mime + ";base64," + d.b64_json : d.url)
        .filter(Boolean);
      if (!urls.length) return json(res, 502, { error: "upstream returned no image: " + String(text.slice(0, 300)) });

      return json(res, 200, { status: "completed", progress: 100, result_urls: urls });
    }

    return json(res, 502, { error: lastErr || "all keys rejected" });
  }

  json(res, 404, { error: "no such endpoint: " + url });
};
