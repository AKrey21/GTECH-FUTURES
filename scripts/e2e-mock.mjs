// Run:  node scripts/e2e-mock.mjs   (needs playwright + a Chromium it can launch; no network needed)
//
import fs from 'node:fs';
// End-to-end harness: mocks every outbound fetch (feeds, article bodies, LLM
// gateway) in-process, imports server.mjs, then drives it over HTTP and in
// headless Chromium. Asserts the issue ledger, corroboration counts, per-user
// sources, the scan's issue blocks and the mechanical confidence check.
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
let chromium; try { ({ chromium } = req('playwright')); } catch { ({ chromium } = req(process.env.PLAYWRIGHT_MODULE || '/opt/node-tools/node_modules/playwright')); }
import os from 'node:os'; import path from 'node:path'; import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-e2e-'));
process.env.PORT = '3124'; process.env.DATA_DIR = S; process.env.LLM_API_KEY = 'test';
process.env.LLM_URL = 'https://llm.mock/v1/chat/completions'; process.env.PILOT_USERS = 'tester:FI-TEST-0001';
process.env.ALLOWED_ORIGIN = 'http://127.0.0.1:3124';
const CODE = 'FI-TEST-0001';
const realFetch = globalThis.fetch;
const rss = (items) => `<?xml version="1.0"?><rss><channel>` + items.map(i => `<item><title>${i.t}</title><link>${i.l}</link><description>${i.d || i.t + ' — details of the development reported here at some length so triage has text to read.'}</description><pubDate>Mon, 12 Oct 2026 08:00:00 GMT</pubDate></item>`).join('') + `</channel></rss>`;
const FD = 'Firms report a trial of a four-day work week; staff retention improved while output held steady, prompting others to consider the model.';
const FEEDS = [
  [/mckinsey\.com\/insights\/rss/, [{ t: 'Four-day week pilots spread to Asian banks', l: 'https://www.mckinsey.com/a1', d: FD }, { t: 'Agentic AI reaches back-office workflows', l: 'https://www.mckinsey.com/a2' }, { t: 'Skills half-life keeps shortening', l: 'https://www.mckinsey.com/a3' }]],
  [/rss\.arxiv\.org\/rss\/cs\.CY/, [{ t: 'Four-day workweek: evidence from 60 firms', l: 'https://arxiv.org/abs/2610.00001', d: FD }, { t: 'AI tutors and deskilling in classrooms', l: 'https://arxiv.org/abs/2610.00002' }]],
  [/oneusefulthing\.org\/feed/, [{ t: 'The cybernetic teammate', l: 'https://www.oneusefulthing.org/p/teammate' }]],
  [/eco-business\.com\/feeds\/all/, [{ t: 'ISSB reporting creates sustainability roles in Singapore', l: 'https://www.eco-business.com/news/issb' }]],
  [/vulcanpost\.com\/feed/, [{ t: 'SME adopts 4-day week after AI rollout', l: 'https://vulcanpost.com/sme-4day', d: FD }]],
  [/q=.*SkillsFuture.*Workforce/, [{ t: 'MOM to study four-day week trials', l: 'https://www.straitstimes.com/singapore/mom-four-day', d: FD }, { t: 'SkillsFuture credit top-up take-up rises', l: 'https://www.channelnewsasia.com/singapore/skillsfuture-credit' }]],
  [/q=.*zaobao/, [{ t: '新加坡企业试行四天工作制', l: 'https://www.zaobao.com.sg/news/four-day', d: FD }]],
  [/q=.*oecd\.org/, [{ t: 'OECD Skills Outlook 2026', l: 'https://www.oecd.org/skills-outlook' }]],
  [/q=.*Commentary/, [{ t: 'Commentary: Is the four-day week coming to Singapore?', l: 'https://www.channelnewsasia.com/commentary/four-day', d: FD }]],
  [/q=.*mothership/, [{ t: "S'pore firm trials 4-day week, staff react", l: 'https://mothership.sg/2026/10/four-day', d: FD }]],
  [/q=.*fulcrum/, [{ t: 'Johor SEZ draws Singapore back-office jobs', l: 'https://fulcrum.sg/jsez' }]],
];
let llmCalls = { triage: 0, cluster: 0, scan: 0, audit: 0, other: 0 };
globalThis.fetch = async (url, opts) => {
  url = String(url);
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (url.startsWith(process.env.LLM_URL)) {
    const body = JSON.parse(opts.body); const sys = body.messages[0].content; const user = body.messages[body.messages.length - 1].content;
    let text;
    if (/triage stage/.test(sys)) { llmCalls.triage++; const list = JSON.parse(user); text = JSON.stringify(list.map(x => ({ i: x.i, keep: true, domain: 'Social', novelty: 4 }))); }
    else if (/issue ledger/.test(sys)) { llmCalls.cluster++; const inp = JSON.parse(user); const fd = inp.openIssues.find(o => /four-day/i.test(o.title));
      text = JSON.stringify(inp.newSignals.map(x => /four-day|4-day|四天/i.test(x.title) ? (fd ? { i: x.i, issue: fd.id } : { i: x.i, issue: null, newKey: 'fourday', newTitle: 'Four-day work week moving from fringe to pilots', newSummary: 'Employers across sectors are trialling four-day weeks with retention gains.' }) : { i: x.i, issue: null, newKey: x.title, newTitle: x.title, newSummary: '' })); }
    else if (/citation fit/.test(user)) { llmCalls.audit++; text = '{"fits":[],"emptyTopics":[]}'; }
    else if (/=== SIGNALS ===|signals/i.test(user) && /trend/i.test(user)) { llmCalls.scan++;
      const codes = (re) => [...user.matchAll(/^\s*\[([^\]]+)\] ([^\n]*?) \[(L\d+)\]/gm)].filter(m => re.test(m[2])).map(m => m[3]);
      const fd = codes(/four-day|4-day|四天/i).slice(0, 4), sf = codes(/SkillsFuture credit/i).slice(0, 1);
      text = JSON.stringify([
        { title: 'Four-day week moves from fringe to pilots', dimension: 'Future of Work', confidence: 'High', trajectory: 'Rising', horizon: '1-2 years', what: 'Several unconnected outlets report four-day week trials.', why: 'Changes how training time is found.', options: ['Review CET scheduling guidance'], sources: fd.map((c, i) => ({ label: 'Source ' + (i + 1), ref: c })) },
        { title: 'SkillsFuture credit take-up rising', dimension: 'Future of Learning', confidence: 'High', trajectory: 'Rising', horizon: 'now', what: 'Take-up rises.', why: 'Budget pressure.', options: ['Monitor'], sources: sf.map(c => ({ label: 'CNA', ref: c })) },
      ]); }
    else { llmCalls.other++; text = '{}'; }
    return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  for (const [re, items] of FEEDS) if (re.test(decodeURIComponent(url))) return new Response(rss(items), { status: 200 });
  if (/news\.google\.com\/rss/.test(url)) return new Response(rss([]), { status: 200 });
  // article body
  return new Response('<html><body><p>' + 'Paragraph one of the article body with enough length to count as real text. '.repeat(2) + '</p><p>' + 'Second paragraph of the article, also comfortably over fifty characters long. '.repeat(2) + '</p><p>' + 'Third paragraph closes the article with more than fifty characters of prose. '.repeat(2) + '</p></body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
};
await import(pathToFileURL(path.join(ROOT, 'server.mjs')).href);   // file URL: a bare path fails on Windows
const base = 'http://127.0.0.1:3124';
const get = (p, h) => realFetch(base + p, { headers: h || {} }).then(r => r.json());
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails.push(m); };

// 1) cold store: first /api/store warms it via ingestion of the 10 defaults
let st = await get('/api/store');
ok(st.defaults && st.defaults.length === 10, 'store reports 10 defaults');
ok(st.sources.filter(s => s.items.length).length >= 8, 'items served for most default sources (' + st.sources.filter(s => s.items.length).length + ')');
const fd = (st.issues || []).find(i => /four-day/i.test(i.title));
ok(!!fd, 'four-day issue exists in the ledger');
ok(fd && fd.unconnected >= 4, 'four-day issue corroborated by >=4 unconnected publishers (' + (fd && fd.publishers.join(', ')) + ')');
ok(fd && fd.evidence.length >= 3 && new Set(fd.evidence.map(e => e.publisher)).size === fd.evidence.length, 'issue evidence drawn from distinct publishers');
ok(st.sources.every(s => s.items.every(i => i.publisher)), 'every served item carries a publisher');
ok(llmCalls.triage > 0 && llmCalls.cluster > 0, 'triage and clustering were called (' + JSON.stringify(llmCalls) + ')');

// 2) per-user sources
let r = await realFetch(base + '/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-FI-Code': CODE }, body: JSON.stringify({ sources: [{ name: 'Vulcan Post', feed: 'https://vulcanpost.com/feed', query: '', lang: 'en' }, { name: 'Bad host', feed: 'https://evil.example/feed', query: '' }, { name: 'McKinsey Global Institute', feed: 'https://www.mckinsey.com/insights/rss' }] }) });
let prof = await r.json();
ok(r.status === 200 && prof.sources.length === 1 && prof.sources[0].name === 'Vulcan Post', 'profile keeps the allow-listed user source, drops bad host and default duplicate');
await new Promise(res => setTimeout(res, 1500));
st = await get('/api/store', { 'X-FI-Code': CODE });
const vp = st.sources.find(s => s.name === 'Vulcan Post');
ok(vp && vp.items.length === 1, 'user source ingested and served to its owner');
const st2 = await get('/api/store');
ok(!st2.sources.find(s => s.name === 'Vulcan Post'), 'user source not served to anonymous/other users');
const fd2 = st.issues.find(i => /four-day/i.test(i.title));
ok(fd2 && fd2.publishers.includes('vulcanpost.com'), 'user source signal joined the existing issue (publishers now ' + fd2.unconnected + ')');

// 3) audit + scorecard checks
let au = await get('/api/store?audit=1');
ok(au.issues && au.issues.length >= 3 && au.issues[0].unconnected >= 4, 'audit ledger lists issues, most corroborated first');
await realFetch(base + '/api/scorecard', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FI-Code': CODE }, body: JSON.stringify({ sources: ['Mothership'], cited: [], checks: { trends: 3, high: 2, highHeld: 1, adjusted: 1 } }) });
au = await get('/api/store?audit=1');
ok(au.checks.high === 2 && au.checks.adjusted === 1, 'confidence-check tallies persisted');

// 4) browser: pull assembles ISSUE blocks; scan renders cards; confidence check adjusts single-publisher High
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });
await page.addInitScript((c) => { try { localStorage.setItem('fi_code', c); } catch (e) {} }, CODE);
await page.goto(base + '/', { waitUntil: 'load' });
await page.waitForFunction(() => (document.getElementById('signals') || {}).value && document.getElementById('signals').value.indexOf('[ISSUE:') >= 0, null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);
const pulled = await page.evaluate(() => ({ sig: document.getElementById('signals').value, cards: Array.from(document.querySelectorAll('#srcList .src-name')).map(e => e.textContent.replace('↗', '').trim()) }));
ok(/^\[ISSUE: Four-day/m.test(pulled.sig), 'scan input opens with the four-day ISSUE block');
ok(/unconnected publishers \(/.test(pulled.sig) && /tracked since/.test(pulled.sig), 'issue header carries publisher count and history');
ok(pulled.sig.length <= 10200, 'scan input within budget (' + pulled.sig.length + ' chars)');
ok(pulled.cards.includes('Vulcan Post'), 'tester\'s saved source restored as a card on sign-in');
await page.click('#scanBtn');
await page.waitForSelector('#columns article.card', { timeout: 20000 });
await page.waitForTimeout(800);
const cards = await page.evaluate(() => Array.from(document.querySelectorAll('#columns article.card')).map(c => ({ title: c.querySelector('.ctitle').textContent, chip: c.querySelector('.chip').textContent.trim(), corro: (c.querySelector('.fi-corro') || {}).textContent, issue: (c.querySelector('.fi-issue') || {}).textContent, cites: c.querySelectorAll('a.src').length })));
console.log(JSON.stringify(cards, null, 1));
const c1 = cards.find(c => /Four-day/.test(c.title)), c2 = cards.find(c => /SkillsFuture/.test(c.title));
ok(c1 && /High/.test(c1.chip) && /✓ \d+ unconnected/.test(c1.corro || ''), 'corroborated trend keeps High and shows unconnected-publisher chip');
ok(c1 && /Tracked since/.test(c1.issue || ''), 'corroborated trend shows issue-ledger history badge');
ok(c2 && !/High/.test(c2.chip) && /adjusted/.test(c2.corro || ''), 'single-publisher High downgraded and flagged');
await page.waitForTimeout(1200);
au = await get('/api/store?audit=1');
ok(au.checks.high === 4 && au.checks.adjusted === 2 && au.checks.highHeld === 2, 'browser scan posted its confidence-check tallies (' + JSON.stringify(au.checks) + ')');
ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
console.log('\n' + (fails.length ? fails.length + ' FAILURE(S)' : 'ALL PASS') + ' · llm calls ' + JSON.stringify(llmCalls));
process.exit(fails.length ? 1 : 0);
