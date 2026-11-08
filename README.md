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
   | `APP_PASSWORD` | site password | to lock the site |
   | `ADMIN_TOKEN` | admin secret | lets you use the server key |

   Everything else — the relay base URLs and upstream model ids — also comes
   from env vars. The full set is in `.env.local`:

   | Name | Value |
   |---|---|
   | `PROV1_BASE` / `PROV1_KEY` / `PROV1_MODEL` | provider 1 |
   | `PROV2_BASE` / `PROV2_KEY` | provider 2 |
   | `PROV2_MODEL_1K` / `_2K` / `_4K` | provider 2 model ids |

   Some of the model ids contain non-ASCII characters, so use `push-env.ps1`
   rather than pasting them into the dashboard by hand — it reads and writes
   UTF-8 and keeps them intact.

   Customers can also paste their own key in the app's Settings panel — that
   path stores it in the browser only and spends their relay quota, not yours.
   The server-side key is only reachable with the admin token.
5. Redeploy. Open the URL.

## Upstream identity is deliberately hidden

The client never sees which relay is behind the app. The public model ids are
opaque (`m1`–`m4`), the models response carries no host, provider, or upstream
model field, upstream error text is scrubbed of host names and model ids before
it reaches the browser, and any CDN image URL the relay returns is fetched
server-side and inlined as a data URL — so the relay's hostname never appears
in the network tab.

The base URLs and model ids live in env vars, not in the source. Keep it that
way if you share this repo — a hostname in the source, the README, or a
client-visible id undoes the whole thing.

## The handler is not a static file

The shared handler lives at `api/_lib/handler.js`. Vercel ignores files that
start with an underscore inside `api/`, so it is never routed and never served
as source.

**Do not move it to the repo root.** At `_lib/handler.js` in the root it WAS
served — `https://your-site/_lib/handler.js` returned the whole server code.
The `_lib` name is only safe because it sits inside `api/`.

## Password gate

**Do not add a root `middleware.js`.** Vercel's current CLI treats that file
as a root proxy: it becomes the deployment's only entrypoint and suppresses
both static file serving and `api/` function discovery. The symptom is a build
that finishes in ~1s logging only `Compiling "middleware.js"`, followed by
`404 NOT_FOUND` on every URL including `/api/public/v1/models`.

The check lives in `api/_lib/handler.js` instead. `APP_PASSWORD` unset = gate off.

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

each `module.exports = require("../../_lib/handler.js")`. The leading
underscore keeps Vercel from turning `_lib/handler.js` into a route.

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
api/_lib/handler.js  shared handler logic (never served: _ prefix inside api/)
api/public/v1/*.js    one function per route
vercel.json           maxDuration 300, memory 1024
package.json          no dependencies
```
