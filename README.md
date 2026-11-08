# Imagine Studio — Vercel build

Same UI as the desktop app, ported to run on Vercel. No build step: push the
files, import the repo, set env vars.

## Deploy

1. Create a **new** GitHub repo (don't reuse `halimmok91/imagine-studio` — that
   one is the desktop build with `server.js` and `pkg.config.json` in it).
2. Upload every file in this folder to the repo root, keeping `api/` and
   `vendor/` as folders.
3. In Vercel: **Add New → Project → Import** that repo. Framework preset
   **Other**. No build command, no output directory.
4. **Settings → Environment Variables**, add:

   | Name | Value | Needed |
   |---|---|---|
   | `PROV1_KEY` | key for provider 1 | model m1 |
   | `PROV1_BASE` | provider 1 base URL | model m1 |
   | `PROV2_KEY` | key for provider 2 | models m2–m4 |
   | `PROV2_BASE` | provider 2 base URL | models m2–m4 |
   | `APP_PASSWORD` | site password | to lock the site |
   | `ADMIN_TOKEN` | admin secret | lets you use the server key |

   Keys can also be pasted in the app's Settings panel — that path stores them
   in the browser only, and the customer pays for their own quota.
5. Redeploy. Open the URL.

## Upstream identity is deliberately hidden

Nothing in this repo names the upstream relay. The provider base URLs come from
env vars, model ids are opaque (`m1`–`m4`), and the models response carries no
host or provider field. Keep it that way if you share this repo — a hostname in
the source, the README, or a client-visible id undoes the whole thing.

## Password gate

**Do not add a root `middleware.js`.** Vercel's current CLI treats that file
as a root proxy: it becomes the deployment's only entrypoint and suppresses
both static file serving and `api/` function discovery. The symptom is a build
that finishes in ~1s logging only `Compiling "middleware.js"`, followed by
`404 NOT_FOUND` on every URL including `/api/public/v1/models`.

The check lives in `_lib/handler.js` instead. `APP_PASSWORD` unset = gate off.

## Routing

Vercel zero-config maps files to URLs literally, and dynamic segments match
one path segment only (`[^/]+`). So `api/[...path].js` catches `/api/abc` but
not `/api/public/v1/models`. Real catch-alls are a Next.js feature. Hence one
file per route:

```
api/public/v1/models.js
api/public/v1/generate.js
api/public/v1/verify.js
```

each `module.exports = require("../../../_lib/handler.js")`. `_lib` is not a
route directory, so shared logic there is safe.

## What changed from the desktop build

The desktop app is a long-running Node server with a filesystem. Vercel gives
you a stateless function with a 300-second wall, so three things had to move:

**Generate is synchronous.** The old flow was `POST → generation_id → poll`.
Job state lived in a `Map` in memory, which a serverless function cannot keep
between invocations. One request now waits for the image and returns it.

**Reference images are data URLs, not uploads.** There is nowhere to park an
upload between requests, so the browser downscales each reference to 1024px and
sends it inline. Four 4000×3000 photos compress to ~0.1 MB total, well under
Vercel's 4.5 MB body cap. If you ever raise `REF_MAX_PX`, re-check that cap.

**The disk layer is gone.** `save-image`, `list-saved`, `scan-saved`,
`open-folder`, `import-image`, `delete-saved` and `img-proxy` no longer exist.
"Save" now downloads through the browser; the folder picker and Re-import
button are removed. The gallery still persists — it lives in IndexedDB.

## Timeout

`vercel.json` sets `maxDuration: 300` (Hobby's limit with Fluid Compute). The
upstream call is capped below that so it returns a real error instead of a bare
504. A slow quality tier may need more headroom than the default upstream
timeout allows — raise both together.

## Files

```
index.html            page shell
app.js                UI + gallery + IndexedDB
styles.css
three-bg.js           animated background
revamp.js
vendor/three-0.160.0.min.js
_lib/handler.js       shared handler logic
api/public/v1/*.js    one function per route
vercel.json           maxDuration 300, memory 1024
package.json          no dependencies
```
