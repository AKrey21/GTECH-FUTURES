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
3. The source cards fill automatically from the shared scan engine. **Scan &
   interpret**, review/accept/flag the cards, then **Draft briefing email** —
   the draft is written from your persona, with linked citations per trend.

Note: the shared signal pool is triaged for skills/workforce/tech relevance. A
persona far from that domain will find fewer supporting signals — add your own
sources (type a name in "Add source") to pull live content for your area.

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
