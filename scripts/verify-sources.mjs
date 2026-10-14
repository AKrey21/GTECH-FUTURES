// Verify every catalog source actually pulls: fetches each feed (or Google News
// query) exactly the way server.mjs does and reports item counts, freshness and
// whether the feed host is on the server's allowlist. Run it from a machine with
// open outbound HTTPS (the pilot box, your laptop) before shipping catalog edits:
//
//   node scripts/verify-sources.mjs              # whole catalog (web/ingest.js)
//   node scripts/verify-sources.mjs --defaults   # only the daily watched set (server.mjs)
//   node scripts/verify-sources.mjs --only=zaobao --bodies   # name filter; also test article-body fetch
//
// Exit code 1 if any DEFAULT source fails (feed AND fallback both empty).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n) => { const a = args.find(x => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : ''; };
const ONLY = opt('only').toLowerCase();
const CONCURRENCY = parseInt(opt('concurrency') || '6', 10);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// ---- pull the catalog objects out of the source files (no bundler, no imports) ----
function extract(file, re, label) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const m = text.match(re);
  if (!m) throw new Error(label + ' not found in ' + file);
  return new Function('return (' + m[1] + ')')();
}
const FEEDS = extract('web/ingest.js', /var FEEDS = (\{[\s\S]*?\n  \});/, 'FEEDS');
const WATCHED = extract('server.mjs', /const WATCHED_SOURCES = (\[[\s\S]*?\n\]);/, 'WATCHED_SOURCES');
const ALLOW = new Set(extract('server.mjs', /const FEED_HOST_ALLOW = new Set\((\[[\s\S]*?\n\])\);/, 'FEED_HOST_ALLOW'));

const GN_LOCALE = { en: 'hl=en-SG&gl=SG&ceid=SG:en', zh: 'hl=zh-CN&gl=CN&ceid=CN:zh-Hans', 'zh-SG': 'hl=zh-SG&gl=SG&ceid=SG:zh-Hans', ms: 'hl=ms-MY&gl=MY&ceid=MY:ms', ta: 'hl=ta&gl=IN&ceid=IN:ta', id: 'hl=id&gl=ID&ceid=ID:id', fr: 'hl=fr&gl=FR&ceid=FR:fr', ja: 'hl=ja&gl=JP&ceid=JP:ja' };
function googleNewsUrl(q, lang) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${GN_LOCALE[lang] || GN_LOCALE.en}`;
}
function parseFeed(xml) {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  const pick = (b, names) => { for (const n of names) { const m = b.match(new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)<\\/${n}>`, 'i')); if (m) return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); } return ''; };
  const items = blocks.map(b => ({ title: pick(b, ['title']), date: pick(b, ['pubDate', 'published', 'updated']), link: pick(b, ['link']) || ((b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '') }));
  return items;
}
async function get(url, accept) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': accept }, redirect: 'follow', signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, text };
  } catch (e) { return { status: 0, text: '', error: e.name === 'AbortError' ? 'timeout' : e.message }; }
  finally { clearTimeout(t); }
}
async function testUrl(url) {
  const r = await get(url, 'application/rss+xml, application/xml, text/xml, */*');
  if (r.status !== 200) return { ok: false, note: r.error || ('HTTP ' + r.status) };
  const items = parseFeed(r.text);
  if (!items.length) return { ok: false, note: /<html/i.test(r.text.slice(0, 2000)) ? 'HTML page, not a feed' : 'feed parsed but 0 items' };
  const newest = items.map(i => Date.parse(i.date)).filter(n => !isNaN(n)).sort((a, b) => b - a)[0];
  const age = newest ? Math.round((Date.now() - newest) / 864e5) : null;
  return { ok: true, items: items.length, ageDays: age, sample: items[0].title.slice(0, 70), link: items[0].link };
}
function hostOf(u) { try { return new URL(u).host; } catch { return ''; } }

// ---- build the test list ----
let list;
if (flag('defaults')) list = WATCHED.map(w => ({ name: w.name, feed: w.feed, query: w.query, lang: w.lang, isDefault: true }));
else list = Object.entries(FEEDS).map(([name, s]) => ({ name, feed: s.feed, query: s.query, lang: s.lang, csf: s.csf, isDefault: WATCHED.some(w => w.name === name) }));
if (ONLY) list = list.filter(x => x.name.toLowerCase().includes(ONLY));

const rows = [];
let i = 0;
async function worker() {
  while (i < list.length) {
    const s = list[i++];
    const row = { name: s.name, default: s.isDefault ? '*' : ' ', feed: '', fallback: '', body: '', note: '' };
    let primaryOk = false;
    if (s.feed) {
      const h = hostOf(s.feed);
      if (!ALLOW.has(h)) row.feed = 'HOST NOT ALLOWED (' + h + ')';
      else {
        const r = await testUrl(s.feed);
        row.feed = r.ok ? `ok ${r.items} items, newest ${r.ageDays == null ? '?' : r.ageDays + 'd'}` : 'FAIL ' + r.note;
        primaryOk = r.ok;
        if (r.ok && flag('bodies') && r.link && /^https:/.test(r.link)) {
          const b = await get(r.link, 'text/html,*/*');
          const ps = (b.text.match(/<p\b[^>]*>([\s\S]*?)<\/p>/gi) || []).filter(p => p.replace(/<[^>]+>/g, '').length > 50).length;
          row.body = b.status === 200 ? (ps >= 3 ? `ok (${ps} paras)` : 'thin/walled') : ('HTTP ' + b.status);
        }
      }
    }
    if (s.query) {
      const r = await testUrl(googleNewsUrl(s.query, s.lang));
      row.fallback = r.ok ? `ok ${r.items} items, newest ${r.ageDays == null ? '?' : r.ageDays + 'd'}` : 'FAIL ' + r.note;
      if (r.ok) primaryOk = primaryOk || !s.feed || true;
    }
    row.ok = primaryOk || (row.fallback.startsWith('ok'));
    if (!s.feed && !s.query) { row.note = 'no feed or query'; row.ok = false; }
    rows.push(row);
    process.stderr.write(`\r${rows.length}/${list.length} ${s.name.slice(0, 40).padEnd(40)}`);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
process.stderr.write('\n');

rows.sort((a, b) => (a.default === b.default ? a.name.localeCompare(b.name) : a.default === '*' ? -1 : 1));
const w = Math.min(44, Math.max(...rows.map(r => r.name.length)));
console.log(`\n${'SOURCE'.padEnd(w)}  D  RESULT  FEED (direct)                          FALLBACK (Google News)              ${flag('bodies') ? 'BODY' : ''}`);
for (const r of rows) {
  console.log(`${r.name.slice(0, w).padEnd(w)}  ${r.default}  ${r.ok ? 'PASS ' : 'FAIL '}  ${(r.feed || '-').slice(0, 38).padEnd(38)} ${(r.fallback || '-').slice(0, 36).padEnd(36)} ${r.body || ''}${r.note ? ' ' + r.note : ''}`);
}
const failedDefaults = rows.filter(r => r.default === '*' && !r.ok);
console.log(`\n${rows.filter(r => r.ok).length}/${rows.length} sources pull. ${failedDefaults.length} DEFAULT source(s) failing${failedDefaults.length ? ': ' + failedDefaults.map(r => r.name).join(', ') : ''}.`);
console.log('* = in the daily watched set (server.mjs WATCHED_SOURCES). A FAIL on the direct feed with a passing fallback still works in the app.');
process.exit(failedDefaults.length ? 1 : 0);
