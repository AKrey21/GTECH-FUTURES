// Generate the CSP-compliant Airbase build (dist/) from the self-unpacking index.html.
//
// Airbase's edge enforces a mandatory `Content-Security-Policy: script-src 'self';`,
// which blocks the Claude-Artifacts self-unpacking bundle (inline scripts injected
// via .textContent, text/babel, blob: URLs). This script un-bundles the app into
// same-origin static files that satisfy that CSP:
//   - extracts the app's inline script           -> dist/app.js
//   - extracts the engine shim + guided tour      -> dist/engine.js, dist/tour.js
//   - decodes the 12 embedded woff2 fonts         -> dist/fonts/<uuid>.woff2
//   - rewrites @font-face url("<uuid>")           -> url("fonts/<uuid>.woff2")
//   - drops the loader/manifest/template wrappers entirely
// The repo-root index.html is left untouched (it still works on GitHub Pages, which
// enforces no CSP). Re-run this after editing index.html:  node build-airbase.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const FONTS = path.join(DIST, 'fonts');

// Airbase build = the bare demo only. Set true to also ship the guided walkthrough.
const INCLUDE_TOUR = false;
// Same-origin backend (server.mjs) holds the Anthropic key; point the engine shim at it.
const ENGINE_URL = '/api/complete';
// false = ship in Demo mode (canned Scan/Draft, NO key needed, no credit risk; real
// ingestion still works). true = live AI via the backend. Flip to true once the key is set.
const LIVE_AI = true;

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const blocks = [];
let m;
while ((m = scriptRe.exec(html)) !== null) blocks.push({ attrs: m[1].trim(), body: m[2] });

const engine = blocks.find(b => /ENGINE_URL/.test(b.body));
const tour   = blocks.find(b => /__FI_TOUR__/.test(b.body));
const tplStr = blocks.find(b => /__bundler\/template/.test(b.attrs));
const manStr = blocks.find(b => /__bundler\/manifest/.test(b.attrs));
if (!engine || !tplStr || !manStr) throw new Error('index.html: a required block (engine/template/manifest) was not found');
if (INCLUDE_TOUR && !tour) throw new Error('index.html: tour block not found but INCLUDE_TOUR is on');

const tpl = JSON.parse(tplStr.body);   // decodes < etc. back to the app HTML
const man = JSON.parse(manStr.body);

// Empty dist/ contents rather than removing the dir itself — OneDrive holds a
// sync lock on the watched folder, so rmdir on DIST throws EBUSY. Retry children
// to ride out transient locks.
fs.mkdirSync(DIST, { recursive: true });
for (const entry of fs.readdirSync(DIST)) {
  fs.rmSync(path.join(DIST, entry), { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
fs.mkdirSync(FONTS, { recursive: true });

let appHtml = tpl;
let fontCount = 0;
for (const [key, asset] of Object.entries(man)) {
  if (asset.compressed) throw new Error('compressed asset not handled: ' + key);
  const ext = asset.mime === 'font/woff2' ? 'woff2' : (asset.mime.split('/')[1] || 'bin');
  fs.writeFileSync(path.join(FONTS, `${key}.${ext}`), Buffer.from(asset.data, 'base64'));
  appHtml = appHtml.replace(new RegExp(`url\\((["']?)${key}\\1\\)`, 'g'), `url("fonts/${key}.${ext}")`);
  fontCount++;
}

const appScript = appHtml.match(/<script\b([^>]*)>([\s\S]*?)<\/script>/i);
if (!appScript) throw new Error('no inline app script found in the template');

// ---- verified patches on the extracted app script ----------------------------
// Each patch must match exactly once; the build fails loudly if the bundle text
// ever drifts, so we can never silently ship an unpatched app.
let appJs = appScript[2].trim();
function patch(name, oldStr, newStr) {
  const i = appJs.indexOf(oldStr);
  if (i === -1) throw new Error('app.js patch failed (no match): ' + name);
  if (appJs.indexOf(oldStr, i + 1) !== -1) throw new Error('app.js patch ambiguous (multiple matches): ' + name);
  appJs = appJs.slice(0, i) + newStr + appJs.slice(i + oldStr.length);
}

// 1) Scan prompt: cite sources as {label, ref} where ref is the [L#] code that
//    ingest.js appends to each pulled signal (resolved to a real URL at render).
patch('prompt-sources-instruction',
  '"   - sources: 1\\u20132 short labels for the signals that support it (e.g. \\"Analyst outlook\\", \\"Policy institute\\").\\n" +',
  '"   - sources: 1\\u20132 citations for the signals that support it, each an object {\\"label\\": a short label (e.g. \\"Analyst outlook\\"), \\"ref\\": the [L#] code shown at the end of that signal (e.g. \\"L3\\"), or null if the signal has no code}.\\n" +'
);
patch('prompt-sources-format',
  '\\"sources\\": [string], \\"evidence\\"',
  '\\"sources\\": [{\\"label\\": string, \\"ref\\": string|null}], \\"evidence\\"'
);
// 2) Card renderer: delegate source tags to ingest.js\'s linkifier (falls back to
//    a plain span for demo mode / plain-string sources).
patch('card-source-linkify',
  'srcs.map((s) => `<span class="src">${esc(s)}</span>`)',
  'srcs.map((s) => (window.__FI_SRC_TAG__ ? window.__FI_SRC_TAG__(s, esc) : `<span class="src">${esc(typeof s === "string" ? s : (s && s.label) || "")}</span>`))'
);
// 3) Expose the composed plain-text email for the Outlook export module.
patch('expose-email-text',
  'lastEmailText = txt;',
  'lastEmailText = txt; window.__FI_EMAIL_TEXT__ = txt;'
);
// 4) CSF-spread default sources. Per the CSF handbook (Section 3b), a scan should
//    draw on different SOURCE TYPES — journals, forums, self-publishing, other
//    languages, government — not just trade press. OECD/WEF move to the type-to-add
//    catalog; new defaults have empty excerpts (the live pull fills them).
patch('csf-defaults-a',
  '{ id: "research", name: "OECD Education & Skills", kind: "Academic & EdTech", method: "Web page", url: "https://www.oecd.org/education/", lastItem: "3 Jun 2026", excerpts: [\n' +
  '      "[OECD] AI tutors and adaptive learning are improving, and interest is growing in skills-based, verifiable digital credentials that record what a person can actually do.",\n' +
  '      "[OECD] Reports that the half-life of job-specific skills keeps shortening, strengthening the case for continuous, modular reskilling over one-off qualifications."\n' +
  '    ]},',
  '{ id: "journals", name: "arXiv (Computers & Society)", kind: "Journals", method: "RSS feed", url: "https://arxiv.org/list/cs.CY/recent", excerpts: [] },\n' +
  '    { id: "fringe", name: "Ethan Mollick", kind: "Self-publishing", method: "RSS feed", url: "https://www.oneusefulthing.org/", excerpts: [] },\n' +
  '    { id: "sgpolicy", name: "Singapore skills policy", kind: "Government & policy", method: "RSS feed", url: "https://www.mom.gov.sg/", excerpts: [] },\n' +
  '    { id: "zh", name: "Chinese tech & jobs press", kind: "Different languages", method: "RSS feed", url: "https://news.google.com/", excerpts: [] },'
);
patch('csf-defaults-b',
  '{ id: "policy", name: "World Economic Forum", kind: "Think tanks & gov", method: "RSS feed", url: "https://www.weforum.org/", lastItem: "15 Jun 2026", excerpts: [\n' +
  '      "[World Economic Forum] Public-sector bodies are expanding digital public infrastructure and putting AI into citizen-facing service delivery, raising questions about trust, transparency and government workforce capability.",\n' +
  '      "[World Economic Forum] Its latest Future of Jobs analysis flags analytical thinking, resilience and AI literacy as the skills employers expect to rise most this decade."\n' +
  '    ]},',
  '{ id: "oecd", name: "OECD Education & Skills", kind: "Think tanks & gov", method: "RSS feed", url: "https://www.oecd.org/education/", excerpts: [] },\n' +
  '    { id: "sgnews", name: "Channel NewsAsia", kind: "Trade press", method: "RSS feed", url: "https://www.channelnewsasia.com/", excerpts: [] },'
);
// The pilot's cards must mirror the server engine's 8 watched sources, so the
// demo-only extras go. (IMDA/Smart Nation and LinkedIn Economic Graph are good
// candidates to ADD to the engine later — tracked in the Phase 2 backlog.)
patch('csf-defaults-drop-gartner',
  '{ id: "gartner", name: "Gartner", kind: "Industry analysts", method: "API", url: "https://www.gartner.com/", lastItem: "9 Jun 2026", excerpts: [\n' +
  '      "[Gartner] Forecasts that a meaningful share of enterprise software will ship with embedded AI agents within two years, shifting many roles from \'doing the task\' to \'configuring and checking the agent that does it\'.",\n' +
  '      "[Gartner] Names AI literacy and prompt/agent oversight as emerging baseline competencies it expects employers to screen for across non-technical roles, not just engineering."\n' +
  '    ]},\n    ',
  ''
);
patch('csf-defaults-drop-imda',
  '{ id: "imda", name: "IMDA / Smart Nation Singapore", kind: "Think tanks & gov", method: "Web page", url: "https://www.imda.gov.sg/", lastItem: "11 Jun 2026", excerpts: [\n' +
  '      "[IMDA Singapore] Expanding national AI playbooks and sovereign compute access for the public sector, with guidance that agencies build in-house capability to deploy and oversee AI rather than rely solely on external vendors."\n' +
  '    ]},\n    ',
  ''
);
patch('csf-defaults-drop-linkedin',
  '{ id: "linkedin", name: "LinkedIn Economic Graph", kind: "Industry analysts", method: "API", url: "https://economicgraph.linkedin.com/", lastItem: "10 Jun 2026", excerpts: [\n' +
  '      "[LinkedIn Economic Graph] The set of skills listed on the average job has churned sharply over five years, and members who add an AI-related skill see faster role mobility than peers who do not."\n' +
  '    ]}',
  ''
);
// 5) Show each source's CSF source-type on its card (ingest.js supplies the labels
//    via window.__FI_KIND__; falls back to the entry's own kind).
patch('source-kind-badge',
  '<span class="src-method">${PLUG_ICON}${esc(s.method)}</span>',
  '<span class="src-method">${PLUG_ICON}${esc(s.method)}</span><span class="sep">\\u00b7</span><span class="src-kind">${esc((window.__FI_KIND__ || {})[s.name] || s.kind)}</span>'
);
// 6) Briefing email: each trend bullet carries its source citations — clickable
//    links in the HTML preview, "label — URL" lines in the plain text (so Copy /
//    Open in Outlook / .eml all keep the evidence trail). ingest.js provides
//    window.__FI_EMAIL_SRCS__; without it (demo strings) nothing changes.
patch('email-cite-html',
  'return `<li><b>${esc(t.title)}</b> — ${esc(t.what)}<span class="eml-conf ${conf}">${conf}</span></li>`;',
  'return `<li><b>${esc(t.title)}</b> — ${esc(t.what)}<span class="eml-conf ${conf}">${conf}</span>${window.__FI_EMAIL_SRCS__ ? window.__FI_EMAIL_SRCS__.html(t, esc) : ""}</li>`;'
);
patch('email-cite-text',
  'g.items.map((t) => `  • ${t.title} — ${t.what} (${t.confidence || "Low"})`).join("\\n")',
  'g.items.map((t) => `  • ${t.title} — ${t.what} (${t.confidence || "Low"})${window.__FI_EMAIL_SRCS__ ? window.__FI_EMAIL_SRCS__.text(t) : ""}`).join("\\n")'
);
// 7) Briefing email: close with the list of sources this scan actually drew on.
patch('email-footer-text',
  'txt += `\\n${closing}\\n\\n— Futures Intelligence (automated draft)',
  'txt += `\\n${closing}\\n${(window.__FI_EMAIL_SRCS__ ? window.__FI_EMAIL_SRCS__.footerText() : "") || "\\n"}— Futures Intelligence (automated draft)'
);
patch('email-footer-html',
  '<p class="eml-sign">— Futures Intelligence (automated draft)</p>',
  '${window.__FI_EMAIL_SRCS__ ? window.__FI_EMAIL_SRCS__.footerHtml(esc) : ""}<p class="eml-sign">— Futures Intelligence (automated draft)</p>'
);
// 8) Pilot accounts: the briefing email's From line names the signed-in tester
//    (profile.js sets window.__FI_USER__); falls back to the demo byline.
patch('email-from-text',
  'From: Futures Intelligence · SEED Innovation\\nTo:',
  'From: Futures Intelligence · ${(window.__FI_USER__ && window.__FI_USER__.name) || "SEED Innovation"}\\nTo:'
);
patch('email-from-html',
  '<span class="eml-v">Futures Intelligence · SEED Innovation</span>',
  '<span class="eml-v">Futures Intelligence · ${esc((window.__FI_USER__ && window.__FI_USER__.name) || "SEED Innovation")}</span>'
);
// 9) Working prototype, not a demo: prompts and labels stop hard-coding SWDA/TED
//    (the signed-in user's persona defines the organisation now), and the
//    "concept demo" framing goes.
patch('scan-prompt-persona-neutral',
  '"You are a futures-intelligence analyst for SWDA/TED, Singapore\'s skills and workforce development agency. You read external public signals',
  '"You are a futures-intelligence analyst. You read external public signals'
);
patch('scan-prompt-context-header',
  '"=== WHAT SWDA/TED CARES ABOUT (judge relevance against this; do not invent it) ===\\n" + context +',
  '"=== WHAT THE TEAM CARES ABOUT (judge relevance against this; do not invent it) ===\\n" + context +'
);
patch('scan-prompt-why-neutral',
  '"   - why: why it may matter to SWDA/TED specifically, grounded in the signals.\\n" +',
  '"   - why: why it may matter to the team specifically, grounded in the signals.\\n" +'
);
patch('card-why-label',
  '<div class="flabel-sm">Why it may matter for SWDA/TED</div>',
  '<div class="flabel-sm">Why it may matter</div>'
);
patch('brief-prompt-neutral',
  'MONTHLY FUTURES BRIEFING EMAIL for SWDA/TED leadership, written by the analyst engine.',
  'MONTHLY FUTURES BRIEFING EMAIL for agency leadership, written by the analyst engine.'
);
patch('brief-prompt-context-header',
  '"=== WHAT SWDA/TED CARES ABOUT ===\\n" + context +',
  '"=== WHAT THE TEAM CARES ABOUT ===\\n" + context +'
);
patch('email-to-text',
  'To: SWDA/TED — Leadership & sector leads',
  'To: Leadership & sector leads'
);
patch('email-to-html',
  '<span class="eml-v">SWDA/TED — Leadership &amp; sector leads</span>',
  '<span class="eml-v">Leadership &amp; sector leads</span>'
);
patch('email-caveat-text',
  'Concept demo · AI-generated from public sources. Review before sending.',
  'AI-generated from public sources. Review before sending.'
);
patch('email-caveat-html',
  '<div class="eml-caveat">Concept demo · AI-generated draft from public sources.',
  '<div class="eml-caveat">AI-generated draft from public sources.'
);
patch('offline-error-copy',
  '"The live AI engine isn\'t reachable here. This is the concept demo\'s one live part \\u2014 it runs inside the SEED/Claude environment, not in a downloaded or offline copy of this file. Open the original prototype in that environment to run a scan; everything else on this page still works."',
  '"The AI engine isn\'t reachable right now \\u2014 check your connection and try again in a moment. Everything else on this page still works."'
);
// 10) CSF evidence discipline in the scan prompt (pilot findings, 2026-07-15):
//     the old prompt literally asked for "IT/technology trends" (instructed
//     monoculture), let confidence labels be vibes, and produced monitor-only
//     options. These rules move the CSF handbook from prose into mechanics.
patch('scan-role-steeple',
  '"You are a futures-intelligence analyst. You read external public signals and surface emerging IT/technology trends that may be relevant.',
  '"You are a futures-intelligence analyst. You read external public signals and surface emerging trends relevant to the team\'s mandate \\u2014 scanning across social, technological, economic, environmental, political, legal and ethical change, not technology alone.'
);
patch('scan-weak-signals',
  '"1. Identify up to 7 emerging trends present in the signals. Prefer themes supported by more than one signal. Ignore one-off vendor hype.\\n" +',
  // Cap at 5 trends: the enriched per-trend schema (trajectory/horizon/evidence
  // quotes) at 7 trends pushes generation past the LLM gateway's hard 60s ceiling
  // and 504s. 5 well-evidenced trends render reliably and read better than 7 thin
  // ones. (Signal budget + MAX_TOKENS in server.mjs tuned to match.)
  '"1. Identify the 5 STRONGEST emerging trends in the signals (fewer if the signals are thin). Prefer weak signals \\u2014 surprising, discontinuous developments \\u2014 over what informed readers already know, and spread trends across different domains where the signals allow. One article can carry more than one distinct signal \\u2014 mine it fully. Two outlets covering the same event count as ONE signal. News about the reader\'s own organisation is background, not a finding. Ignore one-off vendor hype and sponsored content.\\n" +'
);
patch('scan-options-levers',
  '"   - options: 1\\u20132 short candidate next steps, framed as options NOT recommendations.\\n" +',
  '"   - options: 1\\u20132 short candidate next steps, framed as options NOT recommendations. Each option must name the concrete lever it would act on (which framework, programme, review, tool or advice would change); at most ONE option per trend may be pure monitoring.\\n" +'
);
patch('scan-source-language',
  'or null if the signal has no code}.\\n" +',
  'or null if the signal has no code}. Never cite the same article for more than one trend. If a cited source is not in English, add the language to the label, e.g. \\"Shanghai skill list (Chinese)\\".\\n" +'
);
patch('scan-confidence-rubric',
  '"   - confidence: \\"High\\", \\"Medium\\" or \\"Low\\", based on how many independent signals support it.\\n" +',
  '"   - confidence: \\"High\\" ONLY when two or more INDEPENDENT sources support it (different outlets reporting different events or evidence \\u2014 one announcement covered twice is one source); \\"Medium\\" for one strong source plus a weaker echo; \\"Low\\" for a single source, however striking. Ratings must vary with the evidence \\u2014 never give every trend the same confidence.\\n" +'
);
// 11) Briefing email opens with priorities, not a survey (testers: "my director
//     expects me to prioritise, not to ask her to").
patch('brief-intro-priorities',
  '"- intro: exactly 2 sentences framing this month\'s read across the focus areas.\\n" +',
  '"- intro: 2\\u20133 sentences that OPEN by naming the one or two trends that matter most this cycle and why they lead, then frame the rest.\\n" +'
);
// 12) Phase 3 — tracked topics (CSF: absence of expected change is a signal).
//     When the profile declares topics, gently steer the scan to prefer them
//     where the signals support it. Coverage (which tracked topics the scan did
//     NOT surface) is computed OFF the critical path by the post-scan audit call
//     in ingest.js — keeping it out of the scan keeps generation under the
//     gateway's 60s ceiling.
patch('scan-tracked-topics',
  '"=== RULES ===\\n" +',
  '(window.__FI_TOPICS__ && window.__FI_TOPICS__.length ? "=== TRACKED TOPICS ===\\nThe analyst explicitly tracks: " + window.__FI_TOPICS__.join("; ") + ". Where the signals genuinely support a tracked topic, prefer it as a trend; never invent coverage that the signals do not support.\\n\\n" : "") +\n"=== RULES ===\\n" +'
);
// 13) Phase 3 — post-scan hook (ingest.js): source scorecard, citation-claim
//     fit audit, and the tracked-topics coverage note.
patch('scan-done-hook',
  '      lastTrends = valid;\n      renderCards(valid);\n      updateMeta();\n      revealBrief();',
  '      lastTrends = valid;\n      renderCards(valid);\n      updateMeta();\n      revealBrief();\n      if (window.__FI_SCAN_DONE__) { try { window.__FI_SCAN_DONE__(valid, raw); } catch (e) {} }'
);
// 13b) Clear the last scan's coverage note at the START of every scan, so a
//      stale "no signal on X" note can't outlive a failed or demo-mode scan
//      (the success-only scan-done hook never runs on those paths).
patch('scan-start-clear',
  '  async function scan() {\n    if (running) return;',
  '  async function scan() {\n    if (running) return;\n    if (window.__FI_COVERAGE_CLEAR__) { try { window.__FI_COVERAGE_CLEAR__(); } catch (e) {} }'
);
// 14) Drop the per-trend `evidence` quotes from the LIVE scan. gpt-5.5 on the
//     GovTech gateway must finish generation inside a hard 60s proxy timeout;
//     paraphrasing evidence quotes for every trend pushed dense-signal scans
//     past it (verified: with-evidence → 504 at 60s; without → ~39s). The
//     clickable `sources` citations remain the evidence trail, and the card's
//     evidence detail is guarded so it simply doesn't render. (Runs after
//     prompt-sources-format, so it matches the {label,ref} schema text.)
patch('drop-evidence-instruction',
  '"   - evidence: 1\\u20133 items, each {\\"source\\": short source label, \\"quote\\": a short paraphrase of the supporting signal}. Use ONLY the supplied signals; do not fabricate quotes.\\n\\n" +',
  '"" +'
);
patch('drop-evidence-schema',
  '\\"ref\\": string|null}], \\"evidence\\": [{\\"source\\": string, \\"quote\\": string}]}. No markdown',
  '\\"ref\\": string|null}]}. No markdown'
);

fs.writeFileSync(path.join(DIST, 'app.js'), appJs + '\n');
appHtml = appHtml.replace(appScript[0], '<script src="app.js"></script>');

// When LIVE_AI is off, leave the shim's placeholder URL so engine.js stays inert →
// window.claude is undefined → the app auto-forces Demo mode (canned, no key).
const engineUrlValue = LIVE_AI ? ENGINE_URL : 'https://REPLACE-WITH-YOUR-WORKER.workers.dev/';
const engineBody = engine.body.trim().replace(/var ENGINE_URL = "[^"]*";/, `var ENGINE_URL = "${engineUrlValue}";`);
fs.writeFileSync(path.join(DIST, 'engine.js'), engineBody + '\n');
appHtml = appHtml.replace(/<\/head>/i, '  <script src="engine.js"></script>\n</head>');

if (INCLUDE_TOUR) {
  fs.writeFileSync(path.join(DIST, 'tour.js'), tour.body.trim() + '\n');
  appHtml = appHtml.replace(/<\/body>/i, '  <script src="tour.js"></script>\n</body>');
}

// The engine now ingests server-side daily (briefs stay a monthly human step).
appHtml = appHtml.replace('>Runs monthly<', '>Scans daily · briefs monthly<');

// ---- de-demo the page chrome (Airbase build is the working prototype; the
// GitHub Pages bundle keeps its concept-demo framing untouched) ----------------
function htmlPatch(name, oldStr, newStr) {
  const i = appHtml.indexOf(oldStr);
  if (i === -1) throw new Error('index.html patch failed (no match): ' + name);
  if (appHtml.indexOf(oldStr, i + 1) !== -1) throw new Error('index.html patch ambiguous: ' + name);
  appHtml = appHtml.slice(0, i) + newStr + appHtml.slice(i + oldStr.length);
}
htmlPatch('page-title',
  '<title>Futures Intelligence — Concept Demo</title>',
  '<title>Futures Intelligence — Horizon Scanning</title>');
htmlPatch('banner-tag',
  '<span class="tag">Concept demo</span>',
  '<span class="tag">Pilot</span>');
htmlPatch('banner-copy',
  '<p><strong>Not the live deployment.</strong> Public AI, public text only — nothing internal or sensitive. Outputs are AI drafts for a person to check, not findings.</p>',
  '<p><strong>Working prototype.</strong> Public sources and gov-hosted AI — nothing internal or sensitive goes in. Outputs are AI drafts for a person to check, not findings.</p>');
htmlPatch('sources-foot-note',
  '<span>Live, each source is fetched automatically every month. In this demo, open a source to paste its latest public text — or just load this month\'s pull below.</span>',
  '<span>The engine pulls these sources daily and triages what it finds. Open a source to see this cycle\'s items, or add one your team trusts.</span>');
htmlPatch('context-label',
  '<label class="flabel" for="context">What SWDA/TED cares about</label>',
  '<label class="flabel" for="context">What your team cares about</label>');
htmlPatch('signals-placeholder',
  'placeholder="Click “Load this month\'s pull” to gather excerpts from your watched sources — or paste public report and news excerpts here…"',
  'placeholder="Fills automatically from your watched sources — edit freely before scanning, or paste extra public excerpts here…"');
htmlPatch('pull-button-label',
  '<button class="btn btn-ghost" id="sampleBtn">Load this month\'s pull</button>',
  '<button class="btn btn-ghost" id="sampleBtn">Refresh this cycle\'s pull</button>');
htmlPatch('hide-demo-toggle',
  '<label class="demo-toggle" id="demoToggle"',
  '<label class="demo-toggle" id="demoToggle" style="display:none"');
// The badge's own display beats the UA's [hidden] rule, so it showed even when
// the app set hidden — make the attribute actually win.
htmlPatch('demo-badge-hidden-css',
  '  .demo-badge {',
  '  .demo-badge[hidden] { display: none; }\n  .demo-badge {');

// Pilot sign-in/persona + live ingestion + Outlook export modules (hand-authored
// in web/) — after app.js. profile.js loads FIRST so its fetch wrapper (which
// adds the access-code header) is installed before any module calls the API.
fs.copyFileSync(path.join(ROOT, 'web', 'profile.js'), path.join(DIST, 'profile.js'));
fs.copyFileSync(path.join(ROOT, 'web', 'ingest.js'), path.join(DIST, 'ingest.js'));
fs.copyFileSync(path.join(ROOT, 'web', 'export.js'), path.join(DIST, 'export.js'));
fs.copyFileSync(path.join(ROOT, 'web', 'guide.js'), path.join(DIST, 'guide.js'));
appHtml = appHtml.replace(/<\/body>/i, '  <script src="profile.js"></script>\n  <script src="ingest.js"></script>\n  <script src="export.js"></script>\n  <script src="guide.js"></script>\n</body>');

fs.writeFileSync(path.join(DIST, 'index.html'), appHtml);

console.log(`dist/ built: index.html, app.js, engine.js, profile.js, ingest.js, export.js${INCLUDE_TOUR ? ', tour.js' : ''}, fonts/ (${fontCount} woff2)`);
