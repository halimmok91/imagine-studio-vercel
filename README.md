# Imagine Studio — Vercel build

Same UI as the desktop app, ported to run on Vercel. No build step: push the
files, import the repo, set two env vars.

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
   | `RELAY1_KEY` | your relay-one.invalid key | for Studio |
   | `RELAY2_KEY` | your relay-two.invalid key | for the Gemini rows |

   You only need the one(s) whose models you'll use. Keys can also be pasted in
   the app's Settings panel — that path stores them in the browser only.
5. Redeploy. Open the URL.

## Password gate

**Do not add a root `middleware.js`.** Vercel's current CLI treats that file
as a root proxy: it becomes the deployment's only entrypoint and suppresses
both static file serving and `api/` function discovery. The symptom is a build
that finishes in ~1s logging only `Compiling "middleware.js"`, followed by
`404 NOT_FOUND` on every URL including `/api/public/v1/models`.

To lock the deployment, check `APP_PASSWORD` inside `api/index.js` instead, or
use Vercel's built-in Password Protection (Pro plan).

## What changed from the desktop build

The desktop app is a long-running Node server with a filesystem. Vercel gives
you a stateless function with a 60-second wall, so three things had to move:

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

## Timeout ceiling

`vercel.json` sets `maxDuration: 60`, which is the Hobby maximum. The upstream
call is capped at 55s so it can return a real error instead of a bare 504.

`gpt-image-2.5-relay-one` renders in ~30s at default quality, so this is
fine. If you ever move to a quality tier that renders in ~140s you need Vercel
Pro (300s) — raise both numbers together.

## Files

```
index.html            page shell
app.js                UI + gallery + IndexedDB
styles.css
three-bg.js           animated background
revamp.js
vendor/three-0.160.0.min.js
api/index.js          the only serverless function
vercel.json           maxDuration 60, memory 1024
package.json          no dependencies
```
