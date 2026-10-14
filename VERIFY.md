# Verifying the source catalog on your machine

The 2026-10 catalog expansion (SOURCES.md) was authored in a cloud session with no
outbound network, so its feed URLs were never fetched. This checks every one of them
from a machine with normal internet. Allow about 10 minutes.

## 1. Get the code

```bash
git checkout main
git pull origin main
node --version        # needs Node 22 or newer (the scripts use built-in fetch)
```

No `npm install` is needed for the verifier; it has zero dependencies.

## 2. Check the ten daily defaults first

```bash
node scripts/verify-sources.mjs --defaults
```

Every row should read `PASS`. A `FAIL` in the "FEED (direct)" column is fine when the
"FALLBACK (Google News)" column passes; the app pulls the fallback automatically.
The command exits with code 1 if any default fails outright.

## 3. Check the whole catalog and save the output

```bash
node scripts/verify-sources.mjs --concurrency=8 > verify-output.txt 2>&1
tail -3 verify-output.txt
```

The last lines summarise how many of the 319 sources pull. Send me
`verify-output.txt` (paste it or commit it) and I will fix what fails.

Optional, slower: add `--bodies` to also probe whether article bodies can be fetched
(paywalls and bot-walls show as "thin/walled"), or `--only=<text>` to test one source,
for example `--only=berita`.

## 4. How to read a failure

| Output | Meaning | Fix |
|---|---|---|
| `FAIL HTTP 404` / `HTML page, not a feed` on the feed, fallback `ok` | Guessed feed URL is wrong; app already uses the query | Delete the `feed:` part of that entry in `web/ingest.js`, or leave it |
| `FAIL` on both columns | Source is dead as specified | Remove the entry, or find the publisher's real RSS link and replace `feed:` |
| `ok 0 items` / `feed parsed but 0 items` on a Google News row | The query (or its language edition) returns nothing | Loosen the terms, or switch `lang` (zh-SG, ms, ta) to `en` with a `site:` filter |
| `HOST NOT ALLOWED` | Feed host missing from `FEED_HOST_ALLOW` in `server.mjs` | Add the host there |
| `timeout` | Slow or rate-limited publisher | Re-run once; if it persists, treat as dead |
| Reddit / HardwareZone rows failing | They block non-browser clients | Expected if it happens; those entries are pack-only |

After editing `web/ingest.js` or `server.mjs`, rebuild the served bundle:

```bash
node build-airbase.mjs
```

## 5. Optional: run the engine locally against real feeds

```bash
LLM_API_KEY=<your gateway key> node server.mjs
# then open http://localhost:3000 and watch the terminal: the first visit pulls,
# triages and clusters the ten defaults; "Engine audit" shows the issue ledger.
```

Without a key the server still pulls feeds (useful as a second feed check) but
nothing is triaged or clustered.

## 6. Optional: the no-network end-to-end test

```bash
npm install playwright && npx playwright install chromium
node scripts/e2e-mock.mjs
```

Mocks every feed and the model gateway, drives the real server and page in headless
Chromium, and asserts the issue ledger, corroboration counts, per-tester sources,
the scan's issue blocks and the confidence check. Expect `ALL PASS` with 24 checks.
