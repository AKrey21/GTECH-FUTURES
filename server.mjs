// Futures Intelligence — Airbase backend (Node, zero dependencies).
//
// Serves the static dist/ build AND exposes POST /api/complete, the same-origin
// engine the front-end calls via window.claude.complete(). The Anthropic API key
// is read from the ANTHROPIC_API_KEY env var (injected by Airbase from .env.local
// at deploy time — never in the repo or the image). Outbound HTTPS to Anthropic
// goes through Airbase's NAT egress.
//
// Contract (matches engine.js / the Cloudflare worker it replaces):
//   POST /api/complete   { messages: [{role, content}, ...] }  ->  { text }
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');

const PORT = parseInt(process.env.PORT || '3000', 10);
// GovTech AI Studio "Models" — OpenAI-compatible gateway. Overridable via env.
const LLM_URL = process.env.LLM_URL || 'https://api.ai.tech.gov.sg/platform/models/v1/chat/completions';
const MODEL = process.env.LLM_MODEL || 'gpt-5.5';
// Scan output = up to 5 enriched trends with evidence quotes. Capped so a full
// generation finishes inside the gateway's hard 60s ceiling (6000 tokens of
// 7-trend output 504'd; 4500 for 5 trends completes with margin).
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '4500', 10);
const KEY = process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY || '';

// The system prompt has two parts: an EDITABLE persona (who the analyst is, who
// reads the briefing, what "relevant" means) and a FIXED methodology core (the
// CSF handbook "Thinking About Tomorrow" scanning method + output discipline).
// Pilot users may replace the persona via /api/profile; the core never changes,
// so a persona edit can't break the app's output contract.
const PERSONA_DEFAULT = process.env.PERSONA_DEFAULT || [
  "You are a strategic foresight analyst in TED, the strategy & futures function at SWDA —",
  "Singapore's national Skills and Workforce Development Agency, formed from merging SkillsFuture",
  "Singapore (SSG) and Workforce Singapore (WSG). SWDA anticipates future skills demand; funds and",
  "shapes continuing education & training and training providers; helps workers reskill, upskill and",
  "switch careers; helps employers redesign jobs and adopt technology; and drives sectoral",
  "transformation via Skills Frameworks and Industry Transformation Maps. Your readers are agency",
  "leadership and sector planners who need decision-useful signal, not news summaries.",
].join("\n");
const METHOD_CORE = process.env.METHOD_CORE || [
  "Your practice follows the Singapore Centre for Strategic Futures approach to horizon scanning:",
  "- Hunt WEAK SIGNALS, not general trends or descriptive facts: early, ambiguous signs of change",
  "  that would surprise most people in the agency, that are discontinuities from or outliers to",
  "  established patterns, and that are concrete and observable — neither vendor hype nor speculation.",
  "- Corroboration drives confidence: signals appearing in multiple UNCONNECTED sources point to a",
  "  driving force. Confidence is High only when several independent signals converge; a claim from",
  "  a single source is Low, however striking it sounds.",
  "- Look below the surface: flag when a signal hints at deeper shifts in values, power, or systems,",
  "  not just technology. Scan across the full STEEPLE spread (social, technological, economic,",
  "  environmental, political, legal, ethical) — technology is not the only driver of change.",
  "- The absence of expected change can itself be a signal.",
  "- Structure every finding as What -> So What -> Now What. 'what' states the signal objectively.",
  "  'why' is the SO WHAT for the organisation and readers described above, specifically: name the",
  "  affected sectors, worker or citizen segments, programmes or delivery mechanisms they care",
  "  about — but only where the signals support it. 'options' are the NOW WHAT: candidate next",
  "  steps framed as options for humans to weigh, never recommendations or predictions; monitoring a",
  "  critical uncertainty is a valid option.",
  "- Foresight is not prediction. Surface plausible alternatives and say plainly what is uncertain.",
  "",
  "Rules for every response:",
  "- Use ONLY the supplied signals; paraphrase the actual claim and cite which signal supports it.",
  "- Two outlets covering the same event or announcement are ONE signal, not corroboration.",
  "- One article can carry more than one distinct signal — mine it fully rather than keeping only its dominant theme.",
  "- News about the reader's own organisation is background context, not a finding.",
  "- Never invent statistics, programme names, dates or facts. If a signal is thin, say so.",
  "- Plain English. No buzzwords, no vague 'may impact training' filler.",
  "- Follow the user's requested output format EXACTLY (including any JSON-only instruction);",
  "  add nothing outside it.",
].join("\n");
function systemPromptFor(user) {
  const p = (user && profiles[user] && profiles[user].persona || '').trim();
  return (p || PERSONA_DEFAULT) + '\n\n' + METHOD_CORE;
}

// ---------- pilot access codes (invite tokens, not passwords) ----------
// PILOT_USERS="testuser1:FI-XXXX-XXXX,..." (from .env.local, re-injected on every
// deploy). When set, the paid/stateful endpoints require a valid X-FI-Code header;
// when empty, the app runs open (local dev / pre-pilot behaviour).
const PILOT = new Map();
for (const pair of (process.env.PILOT_USERS || '').split(',')) {
  const i = pair.indexOf(':');
  if (i > 0) PILOT.set(pair.slice(i + 1).trim(), pair.slice(0, i).trim());
}
function authUser(req) {
  const code = String(req.headers['x-fi-code'] || '').trim();
  return (code && PILOT.get(code)) || null;
}

// Only allow browser calls from our own origin (defence in depth; does not stop
// non-browser callers — see rate limit + advise an account spend cap).
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://futures-intelligence.app.tc1.airbase.sg';

const MIME = { '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.woff2':'font/woff2', '.json':'application/json',
  '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };

// --- simple in-memory per-IP rate limit for the paid endpoint ---
// Keyed by pilot username when signed in (office testers often share a NAT IP).
const WINDOW_MS = 10 * 60 * 1000, MAX_HITS = 60;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  if (hits.size > 500) {                       // prune dead IPs so the map can't grow unbounded
    for (const [k, v] of hits) if (!v.some(t => now - t < WINDOW_MS)) hits.delete(k);
  }
  const arr = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > MAX_HITS;
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function handleComplete(req, res) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const origin = req.headers.origin;
  if (origin && origin !== ALLOWED_ORIGIN) return sendJSON(res, 403, { error: 'origin not allowed' });
  const user = authUser(req);
  if (PILOT.size && !user) return sendJSON(res, 401, { error: 'sign in with your access code' });
  if (rateLimited(user || ip)) return sendJSON(res, 429, { error: 'rate limit — try again shortly' });
  if (!KEY) return sendJSON(res, 500, { error: 'LLM_API_KEY is not set on the server' });

  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) return sendJSON(res, 413, { error: 'body too large' }); }
  let messages;
  try { ({ messages } = JSON.parse(raw)); } catch { return sendJSON(res, 400, { error: 'invalid JSON body' }); }
  if (!Array.isArray(messages) || messages.length === 0) return sendJSON(res, 400, { error: 'missing messages[]' });

  // Prepend the signed-in user's persona (or the default) + the fixed CSF
  // methodology core, unless the caller already set a system message.
  const finalMessages = (messages[0] && messages[0].role === 'system')
    ? messages
    : [{ role: 'system', content: systemPromptFor(user) }, ...messages];

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let apiRes;
  try {
    apiRes = await fetch(LLM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
      body: JSON.stringify({ model: MODEL, messages: finalMessages, max_tokens: MAX_TOKENS }),
      signal: ctrl.signal,
    });
  } catch (e) {
    return sendJSON(res, 502, { error: 'could not reach model gateway: ' + (e.name === 'AbortError' ? 'timeout (is the gateway reachable from GCC?)' : e.message) });
  } finally { clearTimeout(timer); }

  const data = await apiRes.json().catch(() => null);
  if (!apiRes.ok) {
    // 502/504 from the gateway mean the model was too slow under load — give
    // testers an actionable message rather than a raw status code.
    if (apiRes.status === 504 || apiRes.status === 502) {
      return sendJSON(res, apiRes.status, { error: 'the model is busy right now — please run the scan again in a moment' });
    }
    const msg = (data && data.error && data.error.message) || ('gateway error ' + apiRes.status);
    return sendJSON(res, apiRes.status, { error: msg });
  }
  // OpenAI-compatible response shape
  const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  return sendJSON(res, 200, { text });
}

// ---------- live source ingestion: RSS (direct feeds + Google News) ----------
const FEED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
// Only these hosts may be fetched directly (SSRF guard). Custom/blocked sources
// are routed through Google News search, which is always news.google.com.
const FEED_HOST_ALLOW = new Set([
  'news.google.com',
  'www.technologyreview.com', 'technologyreview.com',
  'www.mckinsey.com', 'mckinsey.com',
  'www.weforum.org', 'weforum.org',
  'www.oecd.org', 'oecd.org',
  'www.brookings.edu', 'brookings.edu',
  'govinsider.asia', 'www.govinsider.asia',
  // readable publishers (real RSS + fetchable article bodies)
  'www.theverge.com', 'theverge.com',
  'techcrunch.com', 'www.techcrunch.com',
  'venturebeat.com', 'www.venturebeat.com',
  'joshbersin.com', 'www.joshbersin.com',
  'sloanreview.mit.edu',
  'restofworld.org', 'www.restofworld.org',
  'www.wired.com', 'wired.com',
  'theconversation.com', 'www.theconversation.com',
  'www.channelnewsasia.com', 'channelnewsasia.com',
  'www.edsurge.com', 'edsurge.com',
  'www.hrdive.com', 'hrdive.com',
  // CSF-gap sources: journals, forums, self-publishing, environment, SG
  'rss.arxiv.org', 'arxiv.org',
  'www.oneusefulthing.org', 'oneusefulthing.org',
  'hnrss.org',
  'marginalrevolution.com', 'www.marginalrevolution.com',
  'www.carbonbrief.org', 'carbonbrief.org',
  'www.straitstimes.com', 'straitstimes.com',
  // persona-pack sources (feeds verified 2026-07-15)
  'www.restaurantdive.com', 'restaurantdive.com',
  'insideretail.asia', 'www.insideretail.asia',
  'www.hiringlab.org', 'hiringlab.org',
  // Catalog expansion 2026-10 (SOURCES.md). Hosts of every direct feed in the
  // catalog; feeds that fail fall back to the entry's Google News query.
  '36kr.com',
  'algorithmwatch.org',
  'asia.nikkei.com',
  'berita.mediacorp.sg',
  'blackbox.com.sg',
  'blog.seedly.sg',
  'chinai.substack.com',
  'datasociety.net',
  'dollarsandsense.sg',
  'e.vnexpress.net',
  'e27.co',
  'eastasiaforum.org',
  'fass.nus.edu.sg',
  'feeds.hbr.org',
  'forum.singaporeexpats.com',
  'forums.hardwarezone.com.sg',
  'fpf.org',
  'fulcrum.sg',
  'hrmasia.com',
  'hrsea.economictimes.indiatimes.com',
  'importai.substack.com',
  'ink.library.smu.edu.sg',
  'jfsdigital.org',
  'journals.sagepub.com',
  'mothership.sg',
  'nep.repec.org',
  'news.mongabay.com',
  'onlinelibrary.wiley.com',
  'opengovasia.com',
  'opengovsg.substack.com',
  'pluralistic.net',
  'rss.sciencedirect.com',
  'seithi.mediacorp.sg',
  'splash247.com',
  'stratechery.com',
  'thediplomat.com',
  'twc2.org.sg',
  'vulcanpost.com',
  'wethecitizens.net',
  'www.academia.sg',
  'www.adalovelaceinstitute.org',
  'www.aisnakeoil.com',
  'www.aware.org.sg',
  'www.bangkokpost.com',
  'www.ben-evans.com',
  'www.businesstimes.com.sg',
  'www.climatechangenews.com',
  'www.dealstreetasia.com',
  'www.eco-business.com',
  'www.exponentialview.co',
  'www.futuregenerations.wales',
  'www.gov.uk',
  'www.humanresourcesonline.net',
  'www.iseas.edu.sg',
  'www.japantimes.co.jp',
  'www.jom.media',
  'www.nature.com',
  'www.nber.org',
  'www.pewresearch.org',
  'www.rand.org',
  'www.rappler.com',
  'www.reddit.com',
  'www.ricemedia.co',
  'www.rsis.edu.sg',
  'www.sitra.fi',
  'www.sixthtone.com',
  'www.springwise.com',
  'www.tandfonline.com',
  'www.techinasia.com',
  'www.techpolicy.press',
  'www.ttgasia.com',
]);
// Google News editions by catalog `lang`. 'zh' is the mainland edition the original
// Chinese beat used; 'zh-SG' is the Singapore Chinese edition (Zaobao, 8world,
// Shin Min). ms/ta/id editions index the vernacular press of MY/IN/ID — whether
// they also index Singapore's Malay and Tamil sites is unverified; run
// scripts/verify-sources.mjs and switch a source to a feed if its query is empty.
const GN_LOCALE = {
  en: 'hl=en-SG&gl=SG&ceid=SG:en',
  zh: 'hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
  'zh-SG': 'hl=zh-SG&gl=SG&ceid=SG:zh-Hans',
  ms: 'hl=ms-MY&gl=MY&ceid=MY:ms',
  ta: 'hl=ta&gl=IN&ceid=IN:ta',
  id: 'hl=id&gl=ID&ceid=ID:id',
  fr: 'hl=fr&gl=FR&ceid=FR:fr',
  ja: 'hl=ja&gl=JP&ceid=JP:ja',
};
function googleNewsUrl(q, lang) {
  const loc = GN_LOCALE[lang] || GN_LOCALE.en;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${loc}`;
}
function decodeEntities(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
          .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
          .replace(/\s+/g, ' ').trim();
}
function pickTag(block, names) {
  for (const name of names) {
    const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
    if (m) return decodeEntities(m[1]);
  }
  return '';
}
function parseFeed(xml, max) {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  const out = [];
  for (const b of blocks) {
    const title = pickTag(b, ['title']);
    if (!title) continue;
    let summary = pickTag(b, ['content:encoded', 'description', 'summary', 'content']);
    if (summary === title || /^https?:\/\//.test(summary)) summary = '';
    // Keep the full feed text up to the body cap (arXiv summaries ARE the whole
    // abstract); prompt-size limits are enforced at serving time, not here.
    if (summary.length > 900) summary = summary.slice(0, 897) + '…';
    let link = pickTag(b, ['link']);
    if (!link) { const lm = b.match(/<link[^>]*href="([^"]+)"/i); if (lm) link = lm[1]; }
    // Sponsored/advertorial posts (e.g. Industry Dive's /spons/) are vendor
    // marketing, not evidence — a briefing must never cite them.
    if (/\/spons(or(ed|s|ship)?)?\//i.test(link)) continue;
    out.push({ title, summary, link, date: pickTag(b, ['pubDate', 'published', 'updated']) });
    if (out.length >= max) break;
  }
  return out;
}
async function fetchFeed(url, max) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': FEED_UA, 'Accept': 'application/rss+xml, application/xml, text/xml, */*' }, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) return { error: 'HTTP ' + res.status, items: [] };
    return { items: parseFeed(await res.text(), max) };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message, items: [] };
  } finally { clearTimeout(t); }
}
// Google News RSS wraps every item link in an opaque news.google.com URL. Resolve
// it to the REAL article URL via Google's own redirect API (page carries a
// signature + timestamp; batchexecute returns the target). Cached; falls back to
// the wrapper (which still redirects in a browser) on any failure.
const gnCache = new Map();
async function resolveGnews(wrapperUrl) {
  if (gnCache.has(wrapperUrl)) return gnCache.get(wrapperUrl);
  if (gnCache.size > 800) gnCache.clear();
  let real = '';
  try {
    const id = (wrapperUrl.match(/articles\/([^?]+)/) || [])[1];
    if (!id) return '';
    const ctrl1 = new AbortController();
    const t1 = setTimeout(() => ctrl1.abort(), 8000);
    const html = await (await fetch(wrapperUrl, { headers: { 'User-Agent': FEED_UA }, signal: ctrl1.signal })).text().finally(() => clearTimeout(t1));
    const sig = (html.match(/data-n-a-sg="([^"]+)"/) || [])[1];
    const ts = (html.match(/data-n-a-ts="([^"]+)"/) || [])[1];
    if (!sig || !ts) return '';
    const req = [['Fbv4je', `["garturlreq",[["X","X",["X","X"],null,null,1,1,"SG:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts},"${sig}"]`, null, 'generic']];
    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort(), 8000);
    const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      headers: { 'User-Agent': FEED_UA, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'f.req=' + encodeURIComponent(JSON.stringify([req])),
      signal: ctrl2.signal,
    }).finally(() => clearTimeout(t2));
    const text = await res.text();
    const urls = (text.match(/https?:[^"\\]+/g) || []).map(u => u.replace(/\\u003d/g, '=').replace(/\\/g, ''));
    real = urls.find(u => !/google\.com|gstatic/.test(u)) || '';
  } catch { real = ''; }
  if (real) gnCache.set(wrapperUrl, real);
  return real;
}

// Best-effort article-body fetch (SSRF-guarded): only public https, never internal
// hosts or the known bot-walls/Google-News wrappers. Extracts <p> text, capped.
function isPublicHttps(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:') return false;
    const h = x.hostname;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return false;
    if (h === 'localhost' || h.endsWith('.internal') || h.endsWith('.local')) return false;
    if (/(^|\.)(google\.|mckinsey\.com|oecd\.org|hrdive\.com|restaurantdive\.com)/i.test(h)) return false; // walls / GNews wrappers (403 verified 2026-07)
    return true;
  } catch { return false; }
}
async function fetchBody(url) {
  if (!isPublicHttps(url)) return '';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': FEED_UA, 'Accept': 'text/html,*/*' }, redirect: 'follow', signal: ctrl.signal });
    if (!r.ok) return '';
    const html = await r.text();
    const ps = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(m => decodeEntities(m[1])).filter(s => s.length > 50);
    let body = ps.join(' ').replace(/\s+/g, ' ').trim();
    if (body.length > 900) body = body.slice(0, 897) + '…';
    return body;
  } catch { return ''; } finally { clearTimeout(t); }
}

async function handleFeeds(req, res) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'x';
  const user = authUser(req);
  if (PILOT.size && !user) return sendJSON(res, 401, { error: 'sign in with your access code' });
  if (rateLimited(user || ip)) return sendJSON(res, 429, { error: 'rate limit — try again shortly' });
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 200_000) return sendJSON(res, 413, { error: 'body too large' }); }
  let items;
  try { ({ items } = JSON.parse(raw)); } catch { return sendJSON(res, 400, { error: 'invalid JSON' }); }
  if (!Array.isArray(items) || !items.length) return sendJSON(res, 400, { error: 'missing items[]' });

  // Volume budgeting: the LLM gateway times out on very large prompts, so with
  // more sources each one contributes fewer items and fewer full bodies.
  const nSources = Math.min(items.length, 12);
  const perSource = nSources > 6 ? 5 : 6;
  const bodiesPer = nSources > 6 ? 1 : 2;

  const work = items.slice(0, 12).map(async (it) => {
    const id = String(it.id);
    // A catalog entry may carry BOTH a direct feed and a Google News query: the
    // feed is tried first (real article URLs, fetchable bodies) and the query is
    // the fallback when the feed errors, is empty, or its host is not allowed —
    // so a retired or unverified feed URL can never leave a card blank.
    const query = it.query ? googleNewsUrl(String(it.query).slice(0, 300), it.lang) : '';
    let url = '', feedErr = '';
    if (it.feed) {
      try {
        const u = new URL(String(it.feed));
        if (u.protocol !== 'https:' || !FEED_HOST_ALLOW.has(u.host)) feedErr = 'feed host not allowed';
        else url = u.href;
      } catch { feedErr = 'bad feed url'; }
      if (feedErr && !query) return [id, { error: feedErr, items: [] }];
    }
    if (!url && !query) return [id, { error: 'no feed/query', items: [] }];
    let r = url ? await fetchFeed(url, perSource) : { error: feedErr, items: [] };
    if ((!r.items || !r.items.length) && query && url !== query) {
      const fb = await fetchFeed(query, perSource);
      if (fb.items && fb.items.length) { fb.via = 'google-news'; fb.feedError = r.error || 'empty feed'; r = fb; }
      else if (!r.error) r = fb;
    }
    if (r.items && r.items.length) {
      // Swap Google News wrapper links for the real article URLs.
      await Promise.all(r.items.map(async (it) => {
        if (it.link && /^https:\/\/news\.google\.com\//.test(it.link)) {
          const real = await resolveGnews(it.link);
          if (real) it.link = real;
        }
      }));
      // Enrich the top items with real article paragraphs (best-effort, capped).
      // Some feeds (arXiv) already carry the full abstract as the summary — only
      // keep a fetched body when it is actually richer than what the feed gave us.
      await Promise.all(r.items.slice(0, bodiesPer).map(async (it) => {
        const body = it.link ? await fetchBody(it.link) : '';
        if (body.length > 200 && body.length > (it.summary || '').length) it.body = body;
      }));
    }
    return [id, r];
  });
  const results = {};
  for (const [id, r] of await Promise.all(work)) results[id] = r;
  return sendJSON(res, 200, { results });
}

// ---------- horizon-scan memory: file store + scheduled ingestion + triage ----------
// The scan engine's memory is a plain JSON file inside the container (no DB).
// It survives day-to-day; /api/export lets you snapshot it before a redeploy.
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');

// ---------- pilot profiles: per-user display name + persona ----------
// Lives beside the store (wiped by redeploys — /api/export snapshots it,
// /api/import restores it). Codes stay in the env, never in this file.
const PROFILES_PATH = path.join(DATA_DIR, 'profiles.json');
const PILOT_NAMES = new Set(PILOT.values());
const NAME_MAX = 60, PERSONA_MAX = 4000;
let profiles = {};
try { profiles = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8')); } catch { /* fresh */ }
function saveProfiles() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PROFILES_PATH + '.tmp', JSON.stringify(profiles));
    fs.renameSync(PROFILES_PATH + '.tmp', PROFILES_PATH);
  } catch (e) { console.error('profiles save failed:', e.message); }
}
const TOPICS_MAX = 10, TOPIC_LEN = 80;
// Per-tester sources: the cards a tester adds (from the catalog or by name) are
// saved here and ingested + triaged daily alongside the defaults, so a persona's
// own sources build the same corroboration history. Capped to keep the daily
// pull bounded; feeds must be allow-listed, otherwise only the query survives.
const USER_SOURCES_MAX = 12;
function cleanSources(arr) {
  if (!Array.isArray(arr)) return [];
  const out = []; const seen = new Set();
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    const name = String(s.name || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    if (!name || seen.has(name) || WATCHED_NAMES.has(name)) continue;
    let feed = '';
    try { const u = new URL(String(s.feed || '')); if (u.protocol === 'https:' && FEED_HOST_ALLOW.has(u.host)) feed = u.href; } catch { /* no feed */ }
    const query = String(s.query || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const lang = GN_LOCALE[s.lang] ? String(s.lang) : 'en';
    if (!feed && !query) continue;
    seen.add(name);
    out.push({ name, feed, query, lang });
    if (out.length >= USER_SOURCES_MAX) break;
  }
  return out;
}
function profileView(user) {
  const p = profiles[user] || {};
  return { user, displayName: p.displayName || user, persona: p.persona || '', topics: p.topics || [], sources: p.sources || [], personaDefault: PERSONA_DEFAULT };
}
async function handleProfile(req, res) {
  if (!PILOT.size) return sendJSON(res, 200, { user: null, displayName: '', persona: '', personaDefault: PERSONA_DEFAULT });
  const user = authUser(req);
  if (!user) return sendJSON(res, 401, { error: 'sign in with your access code' });
  if (req.method === 'GET') return sendJSON(res, 200, profileView(user));
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 40_000) return sendJSON(res, 413, { error: 'body too large' }); }
  let body;
  try { body = JSON.parse(raw); } catch { return sendJSON(res, 400, { error: 'invalid JSON' }); }
  const next = { ...(profiles[user] || {}) };
  // Collapse ALL whitespace in the name — it lands on the email's From header
  // line, where an interior newline would break the .eml header block.
  if (typeof body.displayName === 'string') next.displayName = body.displayName.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  if (typeof body.persona === 'string') next.persona = body.persona.trim().slice(0, PERSONA_MAX);
  if (Array.isArray(body.topics)) {
    next.topics = body.topics.map(t => String(t).replace(/\s+/g, ' ').trim().slice(0, TOPIC_LEN)).filter(Boolean).slice(0, TOPICS_MAX);
  }
  let newSources = [];
  if (Array.isArray(body.sources)) {
    const before = new Set((next.sources || []).map(s => s.name));
    next.sources = cleanSources(body.sources);
    newSources = next.sources.filter(s => !before.has(s.name));
  }
  next.updated = Date.now();
  profiles[user] = next;
  saveProfiles();
  // Newly added sources get pulled + triaged right away (background), so their
  // first items reach the store without waiting for the daily cycle.
  if (newSources.length) ingestSources(newSources).catch(() => {});
  return sendJSON(res, 200, profileView(user));
}
// Restore personas after a redeploy from an /api/export snapshot. Only known
// pilot usernames are accepted; the shared signal store rebuilds itself.
async function handleImport(req, res) {
  const user = authUser(req);
  if (PILOT.size && !user) return sendJSON(res, 401, { error: 'sign in with your access code' });
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 400_000) return sendJSON(res, 413, { error: 'body too large' }); }
  let body;
  try { body = JSON.parse(raw); } catch { return sendJSON(res, 400, { error: 'invalid JSON' }); }
  if (!body || typeof body.profiles !== 'object' || !body.profiles || Array.isArray(body.profiles)) {
    return sendJSON(res, 400, { error: 'missing profiles{}' });
  }
  let restored = 0;
  for (const [name, p] of Object.entries(body.profiles)) {
    if (!PILOT_NAMES.has(name)) continue;
    const ex = profiles[name];
    if (ex && (ex.persona || ex.displayName)) continue;   // restore fills gaps only — never clobbers a tester's live edits
    profiles[name] = {
      displayName: String((p && p.displayName) || name).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX),
      persona: String((p && p.persona) || '').trim().slice(0, PERSONA_MAX),
      topics: Array.isArray(p && p.topics) ? p.topics.map(t => String(t).replace(/\s+/g, ' ').trim().slice(0, TOPIC_LEN)).filter(Boolean).slice(0, TOPICS_MAX) : [],
      sources: cleanSources(p && p.sources),
      updated: Date.now(),
    };
    restored++;
  }
  saveProfiles();
  return sendJSON(res, 200, { restored });
}

// Server-side copy of the default watched sources (names must match the cards).
const WATCHED_SOURCES = [
  // Ten daily defaults, chosen for a spread across the CSF handbook's source types
  // and STEEPLE with a Singapore-first lens (SOURCES.md explains each). The scan
  // prompt has a hard size budget, so breadth lives in the catalog and persona
  // packs, not here. Firehose feeds (Mothership, Fulcrum) are pulled by their
  // keyword query so the daily slice is on-mission; Eco-Business pulls its feed
  // first and falls back to its query.
  { name: 'McKinsey Global Institute', feed: 'https://www.mckinsey.com/insights/rss' },
  { name: 'arXiv (Computers & Society)', feed: 'https://rss.arxiv.org/rss/cs.CY' },
  { name: 'Ethan Mollick', feed: 'https://www.oneusefulthing.org/feed' },
  // Outlet-allowlisted: parliamentary/policy signals must cite forwardable,
  // of-record outlets (ST/CNA/BT/gov.sg), not aggregators like theindependent.sg.
  { name: 'Singapore skills policy', query: 'Singapore (SkillsFuture OR "Workforce Singapore" OR "Ministry of Manpower") (skills OR jobs OR training OR workforce) (site:channelnewsasia.com OR site:straitstimes.com OR site:businesstimes.com.sg OR site:gov.sg) when:90d' },
  // Singapore Chinese edition (Zaobao/8world/Shin Min) replaces the mainland
  // '人工智能 就业 技能' beat as the daily different-languages leg; the mainland
  // beat stays in the catalog as 'Chinese tech & jobs press'.
  { name: "SG Chinese press (zh)", query: "(site:zaobao.com.sg OR site:8world.com OR site:shinmin.sg) (裁员 OR 技能培训 OR 技能创前程 OR 零工 OR 退休年龄 OR 人工智能 OR 雇主 OR 中小企业 OR 职场) when:90d", lang: "zh-SG" },
  { name: 'OECD Education & Skills', query: 'site:oecd.org (skills OR "adult learning" OR "vocational" OR "future of work" OR workforce OR "AI in education") when:180d' },
  // Of-record opinion (academics/practitioners), free in full — replaces the CNA
  // firehose feed, which stays in the catalog as 'Channel NewsAsia'.
  { name: "CNA Commentary", query: "site:channelnewsasia.com \"Commentary:\" (jobs OR skills OR workers OR AI OR education OR careers OR gig OR retirement) when:90d" },
  // Youth/ground sentiment (the handbook's forum type via an outlet of record).
  { name: "Mothership", query: "site:mothership.sg (jobs OR salary OR retrenched OR retrenchment OR boss OR intern OR \"fresh grad\" OR \"work from home\" OR SkillsFuture OR AI OR employer) when:90d" },
  // Environmental STEEPLE leg, Singapore-headquartered (feed confirmed by two directories).
  { name: "Eco-Business", feed: "https://www.eco-business.com/feeds/all", query: "site:eco-business.com Singapore (\"green jobs\" OR \"green skills\" OR workforce OR \"just transition\" OR \"sustainability reporting\") when:90d" },
  // Regional think-tank leg: SEA labour flows, JS-SEZ, neighbour skills policy.
  { name: "ISEAS Fulcrum", query: "site:fulcrum.sg (workforce OR labour OR skills OR AI OR \"digital economy\" OR migration OR ageing OR education OR Johor) when:90d" },
];

let store = { signals: {}, issues: {}, meta: { lastPull: 0 } };
try { store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); } catch { /* fresh store */ }
store.issues = store.issues || {};
function saveStore() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH + '.tmp', JSON.stringify(store));
    fs.renameSync(STORE_PATH + '.tmp', STORE_PATH);
  } catch (e) { console.error('store save failed:', e.message); }
}
function sigId(it) {
  return crypto.createHash('sha1').update(((it.link || '') + '|' + (it.title || '')).toLowerCase()).digest('hex').slice(0, 16);
}

// ---------- corroboration: publisher groups ----------
// CSF: confidence comes from UNCONNECTED sources. Two SPH titles, two Mediacorp
// channels, or two .gov.sg sites reporting the same thing are ONE publisher.
// Everything else is grouped by registrable domain; an unresolved Google News
// link falls back to the catalog source name.
const PUB_GROUPS = [
  [/(^|\.)(straitstimes\.com|businesstimes\.com\.sg|zaobao\.com\.sg|zaobao\.com|beritaharian\.sg|tamilmurasu\.com\.sg|shinmin\.sg|sph\.com\.sg|stomp\.com\.sg|tnp\.sg)$/, 'SPH Media'],
  [/(^|\.)(channelnewsasia\.com|8world\.com|mediacorp\.sg|todayonline\.com|cna\.asia)$/, 'Mediacorp'],
  [/\.gov\.sg$/, 'Singapore Government'],
  [/(^|\.)(nus\.edu\.sg|ipscommons\.sg)$/, 'NUS / IPS'],
];
function publisherOf(link, source) {
  let h = '';
  try { h = new URL(link).hostname.replace(/^www\./, '').toLowerCase(); } catch { /* no link */ }
  if (!h || h === 'news.google.com') return source || 'unknown';
  for (const [re, name] of PUB_GROUPS) if (re.test(h)) return name;
  const parts = h.split('.');
  const n = /\.(com|edu|gov|org|net|co|ac)\.[a-z]{2}$/.test(h) ? 3 : 2;
  return parts.slice(-n).join('.');
}

// CSF-style triage, batched to respect the 20 req/min gateway limit. If the
// model is unreachable, signals stay untriaged (treated as keep) — never fatal.
const TRIAGE_PROMPT =
  "You are the triage stage of a CSF-style horizon scan for SWDA, Singapore's national skills and " +
  'workforce development agency. For each numbered item decide: keep=true if it could be a weak signal ' +
  'relevant to skills, jobs, training and education, AI/technology adoption at work, or the governance of ' +
  'any of these; keep=false for routine or irrelevant news (sports, crime, celebrity, deals, product ' +
  'reviews) with no such relevance. Also classify domain (one of: Social, Technological, Economic, ' +
  'Environmental, Political, Legal, Ethical) and novelty 1-5 (5 = would surprise most people at the ' +
  'agency; 1 = widely known). Reply with ONLY a JSON array like ' +
  '[{"i":0,"keep":true,"domain":"Technological","novelty":3}] covering every item, no other text.';
async function llmJSON(system, user, maxTokens, open, close) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(LLM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: ctrl.signal,
    });
    const data = await res.json();
    const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    return JSON.parse(text.slice(text.indexOf(open), text.lastIndexOf(close) + 1));
  } finally { clearTimeout(t); }
}
async function triageBatch(sigs) {
  if (!sigs.length || !KEY) return;
  const list = sigs.map((s, i) => ({ i, source: s.source, title: s.title, summary: (s.summary || '').slice(0, 200) }));
  try {
    const arr = await llmJSON(TRIAGE_PROMPT, JSON.stringify(list), 1800, '[', ']');
    for (const v of arr) {
      const s = sigs[v.i];
      if (s) s.triage = { keep: v.keep !== false, domain: v.domain || '', novelty: Math.max(1, Math.min(5, +v.novelty || 3)) };
    }
  } catch (e) { console.error('triage failed (keeping items untriaged):', e.message); }
}

// ---------- issue ledger: cross-source, cross-cycle corroboration ----------
// The handbook's test for a signal is that it is seen in several UNCONNECTED
// places. Triage judges items one at a time, so this step groups kept items
// into "issues" (the same development, policy move, practice shift or claim)
// and keeps the issue alive across daily cycles. The scan then receives issues
// with their evidence, and confidence can follow the publisher count
// mechanically instead of being a vibe.
const CLUSTER_PROMPT =
  'You maintain the issue ledger of a CSF-style horizon scan for a Singapore skills-and-workforce agency. ' +
  'OPEN ISSUES are developments already being tracked (id + title). For each numbered NEW signal decide ' +
  'whether it reports the SAME emerging issue as an open issue — the same development, policy move, ' +
  'practice shift, dataset or claim, not merely the same broad topic. If yes, return that issue id. If no, ' +
  'propose a new issue: a specific title (max 12 words, no outlet names, no dates) and a one-sentence ' +
  'summary of the development. Two or more new signals about the same new issue must share the same newKey. ' +
  'Reply with ONLY a JSON array like [{"i":0,"issue":"i3f2a1b9c0","newKey":null,"newTitle":"","newSummary":""}] ' +
  'covering every item, no other text.';
function openIssues(now) {
  return Object.values(store.issues || {}).filter(x => now - x.lastSeen < 60 * 24 * 3600e3).sort((a, b) => b.lastSeen - a.lastSeen);
}
function createIssue(title, summary, domain, now) {
  const id = 'i' + crypto.createHash('sha1').update(title.toLowerCase() + '|' + now).digest('hex').slice(0, 9);
  store.issues[id] = { id, title: title.slice(0, 120), summary: (summary || '').slice(0, 300), domain: domain || '', firstSeen: now, lastSeen: now, signals: [] };
  return store.issues[id];
}
function attachToIssue(s, issue) {
  s.issue = issue.id;
  if (!issue.signals.includes(s.id)) issue.signals.push(s.id);
  issue.lastSeen = Math.max(issue.lastSeen || 0, s.lastSeen || Date.now());
  if (!issue.domain && s.triage && s.triage.domain) issue.domain = s.triage.domain;
}
async function clusterBatch(sigs, now) {
  if (!sigs.length || !KEY) return;
  store.issues = store.issues || {};
  const open = openIssues(now).slice(0, 80).map(x => ({ id: x.id, title: x.title }));
  const list = sigs.map((s, i) => ({ i, source: s.source, title: s.title, summary: (s.body || s.summary || '').slice(0, 240) }));
  let arr;
  try { arr = await llmJSON(CLUSTER_PROMPT, JSON.stringify({ openIssues: open, newSignals: list }), 2200, '[', ']'); }
  catch (e) { console.error('clustering failed (signals stay unassigned):', e.message); return; }
  const created = {};
  for (const v of (arr || [])) {
    const s = sigs[v.i];
    if (!s) continue;
    if (v.issue && store.issues[v.issue]) { attachToIssue(s, store.issues[v.issue]); continue; }
    const title = String(v.newTitle || '').trim();
    if (!title) continue;
    const key = String(v.newKey || title).toLowerCase();
    const issue = created[key] || (created[key] = createIssue(title, v.newSummary, s.triage && s.triage.domain, now));
    attachToIssue(s, issue);
  }
}
function issueStats(issue) {
  const sigs = issue.signals.map(id => store.signals[id]).filter(Boolean);
  const pubs = [...new Set(sigs.map(s => publisherOf(s.link, s.source)))];
  const sources = [...new Set(sigs.map(s => s.source))];
  const days = new Set(sigs.map(s => Math.floor((s.firstSeen || 0) / 864e5)));
  return { sigs, pubs, sources, cycles: days.size, unconnected: pubs.length };
}

// ---------- ingestion ----------
const WATCHED_NAMES = new Set(WATCHED_SOURCES.map(s => s.name));
// Defaults plus every signed-in tester's own sources (deduped by name).
function allSources() {
  const seen = new Set(WATCHED_NAMES); const out = [...WATCHED_SOURCES];
  for (const p of Object.values(profiles)) for (const s of (p.sources || [])) if (s && s.name && !seen.has(s.name)) { seen.add(s.name); out.push(s); }
  return out;
}
let ingesting = null;
// Pull, enrich, triage and cluster the given sources into the store. Serialised
// behind `ingesting` so the daily run and a tester's new-source pull never
// interleave their store writes.
function ingestSources(list) {
  const run = async () => {
    const now = Date.now();
    const fresh = [];
    await Promise.all(list.map(async (src) => {
      let r = await fetchFeed(src.feed || googleNewsUrl(src.query, src.lang), 20);
      // Feed first, Google News query as the fallback (see handleFeeds).
      if ((!r.items || !r.items.length) && src.feed && src.query) r = await fetchFeed(googleNewsUrl(src.query, src.lang), 20);
      if (!r.items || !r.items.length) return;
      await Promise.all(r.items.map(async (it) => {
        if (it.link && /^https:\/\/news\.google\.com\//.test(it.link)) {
          const real = await resolveGnews(it.link);
          if (real) it.link = real;
        }
      }));
      // Enrich EVERY item with the full article text (the store is the scan's
      // memory — it should hold the whole thing, not a teaser). Items already in
      // the store with a body are skipped, so daily pulls stay cheap. A fetched
      // body only replaces the feed summary when it is actually richer (arXiv
      // summaries ARE the full abstract; the landing page is thinner).
      await Promise.all(r.items.map(async (it) => {
        const ex = store.signals[sigId(it)];
        if (ex && ex.body) return;
        const body = it.link ? await fetchBody(it.link) : '';
        if (body.length > 200 && body.length > (it.summary || '').length) it.body = body;
      }));
      for (const it of r.items) {
        if (!it.title) continue;
        const id = sigId(it);
        const ex = store.signals[id];
        if (ex) {
          ex.lastSeen = now;
          // count corroboration per pull-cycle, not per fetch
          if (now - (ex.lastBump || 0) > 12 * 3600e3) { ex.timesSeen++; ex.lastBump = now; }
          if (it.body && !ex.body) ex.body = it.body;
        } else {
          const s = { id, source: src.name, title: it.title, summary: it.summary || '', body: it.body || '',
            link: it.link || '', firstSeen: now, lastSeen: now, lastBump: now, timesSeen: 1, triage: null, issue: null };
          store.signals[id] = s;
          fresh.push(s);
        }
      }
    }));
    for (let i = 0; i < fresh.length; i += 12) await triageBatch(fresh.slice(i, i + 12));
    const kept = fresh.filter(s => !s.triage || s.triage.keep !== false);
    for (let i = 0; i < kept.length; i += 15) await clusterBatch(kept.slice(i, i + 15), now);
    saveStore();
    console.log(`ingested ${list.length} source(s): ${fresh.length} new signals, ${kept.length} kept, ${Object.keys(store.signals).length} in store, ${Object.keys(store.issues || {}).length} issues`);
  };
  const p = (ingesting || Promise.resolve()).then(run, run).finally(() => { if (ingesting === p) ingesting = null; });
  ingesting = p;
  return p;
}
function runIngestion(force) {
  if (ingesting) return ingesting;
  if (!force && Date.now() - (store.meta.lastPull || 0) < 20 * 3600e3) return Promise.resolve();
  return ingestSources(allSources()).then(() => {
    const now = Date.now();
    store.issues = store.issues || {};
    for (const [id, s] of Object.entries(store.signals)) {
      if (now - s.lastSeen > 60 * 24 * 3600e3) delete store.signals[id];   // forget after 60 quiet days
    }
    for (const [id, iss] of Object.entries(store.issues)) {
      iss.signals = iss.signals.filter(sid => store.signals[sid]);
      if (!iss.signals.length) delete store.issues[id];
    }
    store.meta.lastPull = now;
    saveStore();
  });
}
// pull on boot (5s grace), then check every 30 min whether the daily pull is due
setTimeout(() => { runIngestion().catch(() => {}); }, 5000);
setInterval(() => { runIngestion().catch(() => {}); }, 30 * 60e3);

// Ranking for the daily slice: corroborated items first, then novelty, then recency.
function itemScore(s) {
  const iss = s.issue && store.issues && store.issues[s.issue];
  const corro = iss ? Math.min(3, issueStats(iss).unconnected) : 0;
  const nov = s.triage ? s.triage.novelty : 3;
  const ageDays = (Date.now() - (s.lastSeen || 0)) / 864e5;
  return corro * 2 + nov - Math.min(5, ageDays) * 0.4;
}
function itemView(s, i) {
  return { title: s.title, detail: (s.body || s.summary || '').slice(0, i < 2 ? 650 : 280), link: s.link,
    timesSeen: s.timesSeen, firstSeen: s.firstSeen, domain: s.triage ? s.triage.domain : '', novelty: s.triage ? s.triage.novelty : null,
    publisher: publisherOf(s.link, s.source), issue: s.issue || null };
}
function storeView(user) {
  const bySource = {};
  for (const s of Object.values(store.signals)) {
    if (s.triage && s.triage.keep === false) continue;
    (bySource[s.source] = bySource[s.source] || []).push(s);
  }
  const mine = (user && profiles[user] && profiles[user].sources) || [];
  const list = [...WATCHED_SOURCES, ...mine.filter(s => !WATCHED_NAMES.has(s.name))];
  const sources = list.map((src) => ({
    name: src.name,
    items: (bySource[src.name] || [])
      .sort((a, b) => itemScore(b) - itemScore(a))
      .slice(0, 5)
      // Detail budget: the LLM gateway 504s past ~26k chars of signals, so the
      // two best items per source carry full detail and the rest are kept
      // short — still enough for the model to see corroboration.
      .map(itemView),
  }));
  // Issue ledger slice: the developments seen in the most unconnected places,
  // each with evidence from distinct publishers where possible.
  const servedNames = new Set(list.map(s => s.name));
  const now = Date.now();
  const issues = openIssues(now).map(iss => ({ iss, st: issueStats(iss) }))
    .filter(x => x.st.sigs.some(s => servedNames.has(s.source)))
    .sort((a, b) => (b.st.unconnected - a.st.unconnected) || (b.st.sigs.length - a.st.sigs.length) || (b.iss.lastSeen - a.iss.lastSeen))
    .slice(0, 12)
    .map(({ iss, st }) => {
      const seenPub = new Set(); const evidence = [];
      for (const s of st.sigs.sort((a, b) => b.lastSeen - a.lastSeen)) {
        const pub = publisherOf(s.link, s.source);
        if (seenPub.has(pub) && evidence.length < st.pubs.length) continue;
        seenPub.add(pub); evidence.push({ source: s.source, ...itemView(s, evidence.length) });
        if (evidence.length >= 4) break;
      }
      return { id: iss.id, title: iss.title, summary: iss.summary, domain: iss.domain, firstSeen: iss.firstSeen, lastSeen: iss.lastSeen,
        signals: st.sigs.length, unconnected: st.unconnected, publishers: st.pubs, sources: st.sources, cycles: st.cycles, evidence };
    });
  return { lastPull: store.meta.lastPull, total: Object.keys(store.signals).length, defaults: [...WATCHED_NAMES], sources, issues };
}
// CSF: scanning must be auditable. The audit view exposes what triage rejected
// (the discard pile), the issue ledger, how each source performs at scan time
// (the scorecard, fed by POST /api/scorecard after every scan), which sources
// are candidates for rotation, and how often the model's High ratings survived
// the mechanical corroboration check.
function auditView() {
  const now = Date.now();
  const discards = Object.values(store.signals)
    .filter(s => s.triage && s.triage.keep === false)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, 50)
    .map(s => ({ source: s.source, title: s.title, link: s.link, domain: s.triage.domain, novelty: s.triage.novelty }));
  const issues = openIssues(now).map(iss => ({ iss, st: issueStats(iss) }))
    .sort((a, b) => (b.st.unconnected - a.st.unconnected) || (b.iss.lastSeen - a.iss.lastSeen))
    .slice(0, 60)
    .map(({ iss, st }) => ({ id: iss.id, title: iss.title, summary: iss.summary, domain: iss.domain, firstSeen: iss.firstSeen, lastSeen: iss.lastSeen,
      signals: st.sigs.length, unconnected: st.unconnected, publishers: st.pubs, sources: st.sources, cycles: st.cycles,
      links: st.sigs.slice(0, 6).map(s => ({ source: s.source, title: s.title, link: s.link })) }));
  const sc = store.meta.scorecard || {};
  const rotate = Object.entries(sc).filter(([, r]) => (r.scans || 0) >= 3 && !(r.cited || 0)).map(([n]) => n);
  return { discards, issues, scorecard: sc, rotate, checks: store.meta.checks || { trends: 0, high: 0, highHeld: 0, adjusted: 0 } };
}
async function handleScorecard(req, res) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'x';
  const user = authUser(req);
  if (PILOT.size && !user) return sendJSON(res, 401, { error: 'sign in with your access code' });
  if (rateLimited(user || ip)) return sendJSON(res, 429, { error: 'rate limit — try again shortly' });
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 20_000) return sendJSON(res, 413, { error: 'body too large' }); }
  let body;
  try { body = JSON.parse(raw); } catch { return sendJSON(res, 400, { error: 'invalid JSON' }); }
  const sc = store.meta.scorecard = store.meta.scorecard || {};
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const bump = (name, field) => {
    name = String(name).slice(0, 60);
    // hasOwnProperty (not truthiness) so "__proto__"/"constructor" can't reach
    // Object.prototype — bare `sc[name]` on those keys pollutes every object.
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') return;
    if (!has(sc, name)) {
      if (Object.keys(sc).length > 100) return;   // bounded map; fixed the old !sc[name] cap bug
      sc[name] = { scans: 0, cited: 0 };
    }
    const row = sc[name];
    row[field]++;
    if (field === 'cited') row.lastCited = Date.now();
  };
  (Array.isArray(body.sources) ? body.sources.slice(0, 30) : []).forEach(n => bump(n, 'scans'));
  (Array.isArray(body.cited) ? body.cited.slice(0, 30) : []).forEach(n => bump(n, 'cited'));
  if (body.checks && typeof body.checks === 'object') {
    const c = store.meta.checks = store.meta.checks || { trends: 0, high: 0, highHeld: 0, adjusted: 0 };
    for (const k of ['trends', 'high', 'highHeld', 'adjusted']) c[k] += Math.max(0, Math.min(20, +body.checks[k] || 0));
  }
  saveStore();
  return sendJSON(res, 200, { ok: true });
}

async function handleStore(req, res, qs) {
  if (/(^|&)audit=1/.test(qs)) return sendJSON(res, 200, auditView());
  if (/(^|&)refresh=1/.test(qs) && Date.now() - (store.meta.lastPull || 0) > 10 * 60e3) await runIngestion(true);
  else if (!store.meta.lastPull) await runIngestion(true);   // cold store: first visit warms it
  else if (ingesting) await ingesting;                        // mid-ingestion: wait for fresh data
  // The platform can idle the container, so the 30-min timer may never fire.
  // Serve what we have now, but let a visit top up a stale store in the
  // background (runIngestion self-gates on the 20h staleness check).
  else runIngestion().catch(() => {});
  return sendJSON(res, 200, storeView(authUser(req)));
}

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch { res.writeHead(400); return res.end('bad request'); }   // malformed %-escape must not crash the process
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(DIST, urlPath));
  if (!filePath.startsWith(DIST)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

// A rejected handler promise must never kill the shared process (e.g. the body
// stream throws 'aborted' when a client drops the socket mid-upload — Node's
// default turns that unhandled rejection into a crash).
function safely(promise, res) {
  return promise.catch((e) => {
    console.error('handler error:', e && e.message);
    try { if (!res.headersSent) sendJSON(res, 500, { error: 'internal error' }); else res.end(); } catch { /* socket gone */ }
  });
}

const server = http.createServer((req, res) => {
  const route = (req.url || '').split('?')[0];
  if (route === '/api/complete') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'POST only' });
    return safely(handleComplete(req, res), res);
  }
  if (route === '/api/feeds') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'POST only' });
    return safely(handleFeeds(req, res), res);
  }
  if (route === '/api/store') {
    if (req.method !== 'GET') return sendJSON(res, 405, { error: 'GET only' });
    return safely(handleStore(req, res, (req.url || '').split('?')[1] || ''), res);
  }
  if (route === '/api/profile') {
    if (req.method !== 'GET' && req.method !== 'PUT') return sendJSON(res, 405, { error: 'GET or PUT' });
    return safely(handleProfile(req, res), res);
  }
  if (route === '/api/import') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'POST only' });
    return safely(handleImport(req, res), res);
  }
  if (route === '/api/scorecard') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'POST only' });
    return safely(handleScorecard(req, res), res);
  }
  if (route === '/api/export') {
    if (req.method !== 'GET') return sendJSON(res, 405, { error: 'GET only' });
    if (PILOT.size && !authUser(req)) return sendJSON(res, 401, { error: 'sign in with your access code' });
    return sendJSON(res, 200, { ...store, profiles });
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405); res.end('method not allowed');
});

server.listen(PORT, () => console.log(`Futures Intelligence backend on :${PORT} (model ${MODEL}, key ${KEY ? 'set' : 'MISSING'})`));
