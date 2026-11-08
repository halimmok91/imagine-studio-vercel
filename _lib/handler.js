"use strict";

// Serverless port of the desktop adapter. Two differences from the desktop
// build, both forced by Vercel:
//   1. No shared memory between invocations, so `generate` is SYNCHRONOUS. The
//      old POST -> generation_id -> poll dance cannot survive a cold start.
//   2. No filesystem, so the six disk endpoints are gone. Save/Export use the
//      browser's own download instead.

// Upstream hosts AND upstream model names come from env vars only. Nothing in
// this file names the relay or its model ids — those strings are searchable
// and would undo the whole point of hiding the backend.
//
//   PROV1_BASE / PROV1_KEY / PROV1_MODEL
//   PROV2_BASE / PROV2_KEY / PROV2_MODEL_1K / _2K / _4K
const PROVIDERS = {
  p1: {
    base: (process.env.PROV1_BASE || "").replace(/\/+$/, ""),
    envVar: "PROV1_KEY",
    label: "provider 1",
  },
  p2: {
    base: (process.env.PROV2_BASE || "").replace(/\/+$/, ""),
    envVar: "PROV2_KEY",
    label: "provider 2",
  },
};

const MODEL = process.env.PROV1_MODEL || "";

// Provider 1 accepts only these three pixel sizes despite OpenAI's wider docs.
const SIZES = { "1:1": "1024x1024", "16:9": "1536x864", "9:16": "864x1536" };

// Provider 2 takes 14 ratios and wants the ratio string in `size`, not pixels.
const GEMINI_RATIOS = [
  "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4",
  "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1",
];

// The public id is opaque on purpose. Upstream model names are searchable and
// lead straight to the relay, so the client only ever sees an opaque token and
// the real model id stays in the server's env vars.
const MODEL_ROWS = [
  { id: "m1", model_id: MODEL, display_name: "GPT Image 2.5", provider: "p1", ratios: Object.keys(SIZES) },
  { id: "m2", model_id: process.env.PROV2_MODEL_1K || "", display_name: "Nano Banana 2 · 1K", provider: "p2", ratios: GEMINI_RATIOS },
  { id: "m3", model_id: process.env.PROV2_MODEL_2K || "", display_name: "Nano Banana 2 · 2K", provider: "p2", ratios: GEMINI_RATIOS },
  { id: "m4", model_id: process.env.PROV2_MODEL_4K || "", display_name: "Nano Banana 2 · 4K", provider: "p2", ratios: GEMINI_RATIOS },
];

// provider is server-side routing info only — never sent to the client, so
// the public models response can't reveal which relay backs each model.
const MODELS = MODEL_ROWS.map((m) => ({
  id: m.id,
  display_name: m.display_name,
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
//
// The env key is NOT a default. A paying customer pastes the key they bought
// (Settings), and that is tried first — their relay quota, their spend. The
// baked-in env key is appended only when the request also carries the admin
// token, so a random visitor with the site password cannot spend your balance.
// ADMIN_TOKEN unset = env key unreachable from the API at all.
function keyCandidates(req, provider) {
  const P = PROVIDERS[provider] || PROVIDERS.p1;
  const envKey = process.env[P.envVar] || "";
  const adminTok = process.env.ADMIN_TOKEN || "";
  const isAdmin = adminTok && req.headers["x-admin-token"] === adminTok;
  const h = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  const out = [];
  // Settings key first — the customer's own quota.
  for (const [raw, src] of [[h, "Settings"]]) {
    if (!raw) continue;
    if (!out.some((c) => c.key === raw)) out.push({ key: raw, src, how: "as given" });
    const c = cleanKey(raw);
    if (c && !out.some((x) => x.key === c)) out.push({ key: c, src, how: "after stripping invisible chars" });
  }
  if (isAdmin && envKey && !out.some((c) => c.key === envKey)) {
    out.push({ key: envKey, src: P.envVar + " env", how: "as given" });
  }
  return out;
}

function maskKey(k) {
  if (!k) return "(none)";
  return k.length <= 12 ? k.slice(0, 3) + "…" : k.slice(0, 6) + "…" + k.slice(-4);
}

const json = (res, code, obj) => res.status(code).json(obj);

// Upstream error text can echo the host name or the upstream model id. Scrub it
// before it reaches the client: users only need to know the key worked or not.
const SECRETS = [
  ...Object.values(PROVIDERS).map((p) => p.base),
  ...MODEL_ROWS.map((m) => m.model_id),
].filter(Boolean);
const scrub = (s) => String(s || "")
  .replace(/https?:\/\/[^\s"'<>)]+/gi, "[upstream]")
  .replace(/[a-z0-9-]+\.(?:pro|click|com|net|io|cn)\b/gi, "[upstream]")
  .replace(new RegExp(SECRETS.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi"), "[upstream]");

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
    // Customers must supply their own key. The env key is admin-only, so a
    // non-admin caller needs a key regardless of what's configured server-side.
    const adminTok = process.env.ADMIN_TOKEN || "";
    const isAdmin = adminTok && req.headers["x-admin-token"] === adminTok;
    return json(res, 200, {
      models: MODELS,
      keyRequired: !isAdmin,
      // Deliberately no upstream/base URLs and no model field: this endpoint is
      // public and must not reveal which relay is behind the app.
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
      for (const name of ["p1", "p2"]) {
        const P = PROVIDERS[name];
        if (!P.base) continue;
        const hit = { key: maskKey(key), len: key.length, source: src, how, provider: name };
        try {
          const r = await fetch(P.base + "/v1/models", {
            headers: { Authorization: "Bearer " + key },
            signal: AbortSignal.timeout(12000),
          });
          if (r.ok) return json(res, 200, { ok: true, ...hit });
          const t = await r.text();
          let m = "";
          try { m = JSON.parse(t).error?.message || ""; } catch (e) {}
          last = { ok: false, status: r.status, error: scrub(m || t.slice(0, 160)), ...hit };
        } catch (e) {
          last = { ok: false, status: 0, error: "could not reach the upstream: " + scrub(e.message), ...hit };
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
    if (!P.base) {
      return json(res, 500, { error: "Server is missing the " + P.envVar.replace(/_KEY$/, "_BASE") + " setting." });
    }
    const keys = keyCandidates(req, provider);
    if (!keys.length) {
      return json(res, 401, { error: "No API key configured for this model. Set " + P.envVar + " on the server, or paste a key in Settings." });
    }

    const size = provider === "p2"
      ? (GEMINI_RATIOS.includes(b.ratio) ? b.ratio : "1:1")
      : SIZES[b.ratio];

    const refs = (Array.isArray(b.images) ? b.images : []).filter(Boolean).slice(0, 4);
    const fmt = b.output_format || "png";
    const mime = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp" }[fmt] || "image/png";

    const payload = { model: row.model_id, prompt: b.prompt, n: b.n || 1 };
    if (provider === "p2") payload.response_format = "b64_json";
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
        if (more) { lastErr = "invalid header: " + scrub(e.message); continue; }
        return json(res, 502, { error: "upstream unreachable: " + scrub(e.message) });
      }

      let j = null;
      try { j = JSON.parse(text); } catch (e) {}

      if (!r.ok) {
        lastErr = scrub((j && (j.error?.message || j.message)) || text.slice(0, 300));
        if (r.status === 401 && more) continue;
        // Name the key that was sent. Without this an "Invalid token" is
        // indistinguishable from a typo or the env key shadowing Settings.
        // The upstream model id is deliberately left out — it is searchable and
        // would name the relay.
        return json(res, r.status, {
          error: lastErr + "\n\nkey sent: " + maskKey(key) + " (" + key.length + " chars, " + how + ") from " + src +
            " · model: " + row.id,
        });
      }

      const urls = ((j && j.data) || [])
        .map((d) => d.b64_json ? "data:" + mime + ";base64," + d.b64_json : d.url)
        .filter(Boolean);
      if (!urls.length) return json(res, 502, { error: "upstream returned no image: " + scrub(text.slice(0, 300)) });

      return json(res, 200, { status: "completed", progress: 100, result_urls: urls });
    }

    return json(res, 502, { error: lastErr || "all keys rejected" });
  }

  json(res, 404, { error: "no such endpoint: " + url });
};
