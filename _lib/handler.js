"use strict";

// Serverless port of the Studio adapter. Two differences from the desktop
// build, both forced by Vercel:
//   1. No shared memory between invocations, so `generate` is SYNCHRONOUS. The
//      old POST -> generation_id -> poll dance cannot survive a cold start.
//   2. No filesystem, so the six disk endpoints are gone. Save/Export use the
//      browser's own download instead.

const PROVIDERS = {
  relay1: {
    base: (process.env.RELAY1_BASE || "https://relay-one.invalid").replace(/\/+$/, ""),
    envVar: "RELAY1_KEY",
    label: "relay-one.invalid",
  },
  relay2: {
    base: (process.env.RELAY2_BASE || "https://relay-two.invalid").replace(/\/+$/, ""),
    envVar: "RELAY2_KEY",
    label: "relay-two.invalid",
  },
};

const MODEL = process.env.RELAY1_MODEL || "gpt-image-2.5-relay-one";

// relay-one.invalid accepts only these three pixel sizes despite OpenAI's wider docs.
const SIZES = { "1:1": "1024x1024", "16:9": "1536x864", "9:16": "864x1536" };

// Gemini takes 14 ratios and wants the ratio string in `size`, not pixels.
const GEMINI_RATIOS = [
  "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4",
  "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1",
];

const MODEL_ROWS = [
  { id: "gpt-image-2.5", model_id: "gpt-image-2.5-relay-one", display_name: "GPT Image 2.5 · Studio", provider: "relay1", price: "¥0.014", ratios: Object.keys(SIZES) },
  { id: "relay-two-image", model_id: "relay-two-image", display_name: "Relay Image · 1K", provider: "relay2", price: "$0.05", ratios: GEMINI_RATIOS },
  { id: "relay-two-image-2k", model_id: "relay-two-image-2k", display_name: "Relay Image · 2K", provider: "relay2", price: "$0.06", ratios: GEMINI_RATIOS },
  { id: "relay-two-image-4k", model_id: "relay-two-image-4k", display_name: "Relay Image · 4K", provider: "relay2", price: "$0.07", ratios: GEMINI_RATIOS },
];

const MODELS = MODEL_ROWS.map((m) => ({
  id: m.id,
  display_name: `${m.display_name}  ${m.price}`,
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
  return MODEL_ROWS.find((r) => r.id === m || r.model_id === m) || MODEL_ROWS[0];
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
function keyCandidates(req, provider) {
  const P = PROVIDERS[provider] || PROVIDERS.relay1;
  const envKey = process.env[P.envVar] || "";
  const h = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  const out = [];
  for (const [raw, src] of [[envKey, P.envVar + " env"], [h, "Settings"]]) {
    if (!raw) continue;
    if (!out.some((c) => c.key === raw)) out.push({ key: raw, src, how: "as given" });
    const c = cleanKey(raw);
    if (c && !out.some((x) => x.key === c)) out.push({ key: c, src, how: "after stripping invisible chars" });
  }
  return out;
}

function maskKey(k) {
  if (!k) return "(none)";
  return k.length <= 12 ? k.slice(0, 3) + "…" : k.slice(0, 6) + "…" + k.slice(-4);
}

const json = (res, code, obj) => res.status(code).json(obj);

module.exports = async function handler(req, res) {
  const url = req.url.split("?")[0];

  // ---- GET /api/public/v1/models --------------------------------------
  if (url === "/api/public/v1/models" && req.method === "GET") {
    const keyed = { relay1: !!process.env.RELAY1_KEY, relay2: !!process.env.RELAY2_KEY };
    return json(res, 200, {
      models: MODELS,
      keyRequired: !keyed.relay1 && !keyed.relay2,
      keyed,
      upstream: PROVIDERS.relay1.base,
      upstreams: { relay1: PROVIDERS.relay1.base, relay2: PROVIDERS.relay2.base },
      model: MODEL,
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
      for (const name of ["relay1", "relay2"]) {
        const P = PROVIDERS[name];
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
          last = { ok: false, status: r.status, error: m || t.slice(0, 160), ...hit };
        } catch (e) {
          last = { ok: false, status: 0, error: "could not reach " + P.label + ": " + e.message, ...hit };
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
    if (b.ratio && !row.ratios.includes(b.ratio)) {
      return json(res, 400, { error: "unsupported ratio for " + row.id + ": " + b.ratio });
    }

    const P = PROVIDERS[provider];
    const keys = keyCandidates(req, provider);
    if (!keys.length) {
      return json(res, 401, { error: "No key for " + P.label + ". Set " + P.envVar + " on the Vercel project, or paste a key in Settings." });
    }

    const size = provider === "relay2"
      ? (GEMINI_RATIOS.includes(b.ratio) ? b.ratio : "1:1")
      : SIZES[b.ratio];

    const refs = (Array.isArray(b.images) ? b.images : []).filter(Boolean).slice(0, 4);
    const fmt = b.output_format || "png";
    const mime = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp" }[fmt] || "image/png";

    const payload = { model: row.model_id, prompt: b.prompt, n: b.n || 1 };
    if (provider === "relay2") payload.response_format = "b64_json";
    else payload.output_format = fmt;
    if (size) payload.size = size;
    if (refs.length) payload.image = refs;

    const target = P.base + (refs.length ? "/v1/images/edits" : "/v1/images/generations");

    let lastErr = "";
    for (let ki = 0; ki < keys.length; ki++) {
      const { key, src, how } = keys[ki];
      const more = ki < keys.length - 1;
      let r, text;
      try {
        r = await fetch(target, {
          method: "POST",
          headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          // Hobby with Fluid Compute allows 300s. Keep this under vercel.json's
          // maxDuration so Vercel never kills the request before the function
          // can return the upstream error text.
          signal: AbortSignal.timeout(Number(process.env.UPSTREAM_TIMEOUT_MS) || 240000),
        });
        text = await r.text();
      } catch (e) {
        if (more) { lastErr = "invalid header: " + e.message; continue; }
        return json(res, 502, { error: "upstream unreachable: " + e.message });
      }

      let j = null;
      try { j = JSON.parse(text); } catch (e) {}

      if (!r.ok) {
        lastErr = (j && (j.error?.message || j.message)) || text.slice(0, 300);
        if (r.status === 401 && more) continue;
        // Name the key that was sent. Without this an "Invalid token" is
        // indistinguishable from a typo or the env key shadowing Settings.
        return json(res, r.status, {
          error: lastErr + "\n\nkey sent: " + maskKey(key) + " (" + key.length + " chars, " + how + ") from " + src +
            " · model: " + row.model_id + " · site: " + P.base,
        });
      }

      const urls = ((j && j.data) || [])
        .map((d) => d.b64_json ? "data:" + mime + ";base64," + d.b64_json : d.url)
        .filter(Boolean);
      if (!urls.length) return json(res, 502, { error: "upstream returned no image: " + text.slice(0, 300) });

      return json(res, 200, { status: "completed", progress: 100, result_urls: urls });
    }

    return json(res, 502, { error: lastErr || "all keys rejected" });
  }

  json(res, 404, { error: "no such endpoint: " + url });
};
