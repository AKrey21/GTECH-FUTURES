# Getting the live AI engine working — keeping your GitHub Pages link

Your page stays exactly where it is (same `github.io` link, same repo, same
auto-deploy-on-push). The only new piece is a tiny **Cloudflare Worker** that
holds your Anthropic API key and makes the model call. Nothing here puts your
key in the repo or in the page.

**Until you finish step 3, the app runs in Demo mode (canned results) — so it
never looks broken while you set this up.**

---

## What requires AI (so you know what you're switching on)

Only two buttons call the model:

- **Scan & interpret** — clusters your pasted excerpts into trends across the
  four dimensions. *This is the core engine.*
- **Draft briefing email** — writes the leadership email from the trends.
  (Has a plain-template fallback, so it still produces *something* without AI.)

Everything else — watched sources, editing, the pipeline animation, the cards,
accept/flag, copy — is plain front-end and already works with no AI.

---

## Step 1 — Create the Cloudflare Worker (≈3 min, free, no install)

1. Sign in at <https://dash.cloudflare.com> (free account is fine).
2. **Workers & Pages → Create → Workers → Create Worker.**
3. Give it a name, e.g. `futures-engine`, click **Deploy** (deploys a stub).
4. Click **Edit code**. Delete the sample, paste the entire contents of
   [`backend/worker.js`](backend/worker.js), then **Deploy**.
5. Copy the Worker URL shown at the top — looks like
   `https://futures-engine.YOURNAME.workers.dev`. You'll need it in step 3.

## Step 2 — Add your API key as a Secret (so it's never in any file)

1. On the Worker page: **Settings → Variables and Secrets → Add**.
2. Type **Secret**, name **exactly** `ANTHROPIC_API_KEY`, value = your key
   (starts with `sk-ant-`). Save.

> Get a key at <https://console.anthropic.com> → API Keys, if you haven't.
> Keep a little credit on the account; a scan costs well under a cent.

## Step 3 — Point your page at the Worker (this is the only repo edit)

1. Open [`index.html`](index.html), find this line near the top:

   ```js
   var ENGINE_URL = "https://REPLACE-WITH-YOUR-WORKER.workers.dev/";
   ```

2. Replace it with your real Worker URL from step 1, e.g.

   ```js
   var ENGINE_URL = "https://futures-engine.YOURNAME.workers.dev/";
   ```

3. Commit and push. GitHub Pages redeploys automatically — **same link.**

That's it. Open your site, leave the **Demo mode** toggle off, and click
**Scan & interpret** — you're now running the live engine.

---

## One thing to check: the origin lock

`backend/worker.js` only accepts requests from your site, set here:

```js
const ALLOWED_ORIGIN = "https://aaronlbp7.github.io";
```

This is pre-filled for `aaronlbp7.github.io`. If your GitHub username is
different, or you use a custom domain, change it to **your** Pages origin
(scheme + host only, no `/repo` path) and re-deploy the Worker. This stops other
people's browsers from spending your credits.

> It's an origin check, not full auth — fine for a concept demo. If this ever
> becomes public-facing, add rate-limiting or a login in front of the Worker.

## Changing the model or cost

In `backend/worker.js`:

```js
const MODEL = "claude-sonnet-4-6";   // cheap + capable (default)
// "claude-haiku-4-5"  → cheapest, fastest
// "claude-opus-4-8"   → highest quality, priciest
```

Re-deploy the Worker after changing it. No page change needed.

## If something goes wrong

- **App stays in Demo mode / toggle hidden** → `ENGINE_URL` still has the
  placeholder, or you didn't push. Re-check step 3.
- **"Could not complete the scan: engine 401"** → key missing/typo'd. Re-check
  the `ANTHROPIC_API_KEY` secret name and value (step 2).
- **"engine 403" / blocked in browser console** → `ALLOWED_ORIGIN` doesn't
  match your real Pages origin. Fix it in `backend/worker.js`, re-deploy.
- **GitHub Pages not turned on?** Repo **Settings → Pages → Source: Deploy from
  branch → `main` / root**. (Skip if your link already works.)
