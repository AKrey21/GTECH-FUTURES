# Futures Intelligence — pilot testing guide

The Airbase deployment (`https://futures-intelligence.app.tc1.airbase.sg`) is gated
for pilot testing: each tester gets an **access code** and can set their own
**analyst persona**, so the same scan engine drafts briefings through their lens.

## For testers

1. Open the site. Enter the access code you were given (looks like `FI-XXXX-XXXX`).
   It's remembered on your browser; use **Sign out** in the profile panel to clear it.
   A one-minute walkthrough plays on your first visit — replay it any time with
   the **?** button (bottom-left).
2. Click the **👤 pill** (bottom-right) to open your analyst profile:
   - **Display name** — appears on the briefing email's From line.
   - **Analyst persona** — who the engine *is* when it scans and drafts for you:
     your organisation, who reads the briefing, and what counts as relevant.
     Edit freely; the CSF scanning method (weak signals, corroboration-driven
     confidence, What → So What → Now What) and output rules stay fixed, so you
     can't break the app.
   - **Suggested sources** — when your persona names a domain (retail/F&B,
     careers & hiring, green economy, care economy, digital government), the
     panel offers matching sources to add with one click; the pull refreshes
     automatically when you close the panel.
   - **Topics I track** — list the things you watch (one per line). After each
     scan you'll see which of them none of the surfaced trends touched — a gap
     worth noting, and often a cue to add a source.
4. After a scan, each card shows linked citations; a "⚠ check citations" chip
   means an AI audit thought a cited article may not fully support that claim —
   verify it before forwarding. The **Engine audit** link (under the header)
   shows what the engine filtered out and how often each source gets cited.

Note: a scan runs a government AI model with a hard 60-second limit. When the
model is busy it may time out — just click **Scan** again; it usually completes
on a second try.
3. The source cards fill automatically from the shared scan engine. **Scan &
   interpret**, review/accept/flag the cards, then **Draft briefing email** —
   the draft is written from your persona, with linked citations per trend.

Note: the shared signal pool is triaged for skills/workforce/tech relevance. A
persona far from that domain will find fewer supporting signals — add your own
sources (type a name in "Add source") to pull live content for your area.

## How a signal earns its confidence

Every daily pull is triaged, then clustered into an **issue ledger**: items that report
the same development (across sources and across days) are grouped, and each issue counts
its **unconnected publishers** (SPH titles, Mediacorp channels and .gov.sg sites each
count once). The scan reads the most-corroborated issues first, with their evidence, then
single items. After a scan the app applies the CSF rule mechanically: a **High** rating
whose cited signals all trace to one publisher is downgraded on the card and in the
briefing, and every card shows "✓ N unconnected publishers" or "single publisher", plus
"Tracked since … · N signals · N cycles" when the trend comes from the ledger. The
**Engine audit** link shows the ledger, how many High ratings held, which sources are
rotation candidates (scanned 3+ times, never cited) and the discard pile.

Sources you add to your cards are saved to your profile, pulled and triaged daily like
the defaults, and come back as cards when you sign in again (up to 12).

`node scripts/e2e-mock.mjs` runs the whole chain (pull → triage → cluster → scan →
confidence check) against mocked feeds and a mocked model, with no network.

## Sources

To check that every catalog feed actually pulls from your machine, follow **[VERIFY.md](VERIFY.md)**.

The engine pulls ten default sources daily and knows ~320 more by name — sorted by the
CSF handbook's source types (of-record press, government of record, think tanks,
consultancies, journals, self-publishing, forums, podcasts, different languages,
foresight practice, labour-market data), Singapore first. **[SOURCES.md](SOURCES.md)**
is the index: what each source is for, how it is pulled, which persona packs suggest
it, and which handbook case study it comes from. Type a name from it into
"Add source", or accept the pack chips in your profile panel.

Feeds added in the 2026-10 expansion were not fetched live (the authoring session had
no outbound network); each has a Google News fallback, and
`node scripts/verify-sources.mjs --defaults` checks the daily set from any machine
with open HTTPS.

## For the pilot owner

- Testers live in `.env.local` (gitignored, never committed — the repo is public):
  `PILOT_USERS=name:code,name:code,...`
  Add/rotate a code by editing that line and redeploying (`airbase deploy --yes`).
  Codes are invite tokens, not passwords — don't reuse real passwords.
- With `PILOT_USERS` unset the app runs open (no sign-in) — local-dev behaviour.
- `/api/complete`, `/api/feeds`, `/api/profile`, `/api/export`, `/api/import`
  require a valid code; static files and `/api/store` (shared cached signals) stay open.
- **Redeploys wipe personas** (the container filesystem is ephemeral). Before a
  redeploy, snapshot: `curl -H "X-FI-Code: <any-valid-code>" .../api/export > snap.json`.
  After: `curl -X POST -H "X-FI-Code: <code>" -d @snap.json .../api/import`
  (restores profiles only, and only for testers who haven't saved anything since
  the redeploy — it never overwrites live edits; the signal store rebuilds itself).
- What to observe in the pilot: do different personas produce *usefully different*
  briefings from the same signal pool? Which persona edits helped? Where does the
  shared triage filter fight a tester's domain?

## Reliability & safety layer (`lib/`)

- **Structured outputs** — scan, brief, audit and triage replies are validated
  against a schema on the server. Small format slips are fixed automatically,
  any `[L#]` citation the model was never shown is removed, and if nothing usable
  comes back one repair call goes to the fast model inside the 60s limit.
- **Prompt-injection guard** — scraped article text is cleaned before any model
  sees it (hidden characters, chat-template tokens, "ignore your instructions"
  phrasing). Anything caught is listed in **Engine audit**.
- **Telemetry** — every model call is logged. **Engine audit** shows calls, error
  rate, p50/p95 scan latency, tokens, schema pass rate and citations caught.
  Dollar costs appear once the gateway's per-model rates are set in `.env.local`:
  `LLM_PRICES={"gpt-5.5":[in,out],...}` (USD per million tokens). Raw numbers:
  `GET /api/metrics?window=24h|7d|30d|all`.
- **Retrieval** — each tester's tracked topics pull matching evidence from the
  engine's memory (semantic + keyword search, `POST /api/retrieve`). A topic with
  no support is stated as a gap in the scan input. Calibrate on the live store
  with `/api/retrieve?debug=1&dense=0.3&sparse=0.03`.
- **Source map** — the **Source map** link beside Engine audit answers "why do
  we follow this source?" The briefing's purpose is to inform leadership about
  the future ahead and what it means for SWDA, so a source earns its place by
  one of three roles, and the map colours it by that role: **sees early**
  (carries developments before they are mainstream), **sees wide** (brings a
  direction the rest of the list would miss), **confirms** (of record; lets a
  finding be said with confidence). The role is *measured* from the issue
  ledger once a source has been on two or more shared developments (was it
  the first reporter or a confirmer?); until then it is the default for its
  CSF source type, and the tooltip says which. Each daily source also carries
  a one-line "why", in the reader's terms. Lines: green = the ledger matched
  both sources to the same development (confirmed corroboration), grey =
  their articles sit on the same ground (embedding similarity ≥ 0.6; each
  source's three strongest). A floating bubble that is never cited is a
  rotation candidate. The Engine audit scorecard shows the same counts
  ("first on N, confirmed N"). Data: `GET /api/graph`.
- **Backfill** — the ledger only knows what the daily pulls have read (20 items
  per source per day), so on a fresh deployment the Source map and
  corroboration are thin. Run a one-off deep pull by opening
  `/api/store?backfill=1` once (signed in, if sign-in is on): the engine reads
  60 items per source (weeks of history), keeps real publication dates, and
  triages and clusters oldest-first so first-reporter vs confirmer is judged on
  when articles were published. It runs in the background on the server
  (20–40 minutes of gateway time; the page stays usable) — watch `phase` on
  `/api/store`. Guarded: once per hour, never while a pull is running.
  To reach further back, add `&depth=100` (Google News's cap per query) and
  `&window=180d` or `&window=365d` (widens the queries' `when:` filter for
  that pass, so it returns an older set; duplicates are dropped). Successive
  passes with wider windows stack up months of history in an afternoon.
  Background model calls are paced to the gateway's ~20/min limit and retried
  once if throttled; whatever still misses is picked up by the next pull
  (every run re-triages stored signals left untriaged and re-clusters kept
  signals not yet in the ledger), so a bad gateway day delays the ledger but
  never leaves a permanent gap.
- Tests: `node --test test/*.test.mjs` (no network needed).
