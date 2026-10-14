// Live source ingestion (Airbase build only).
// Repurposes the "Load this month's pull" button so it fetches REAL current
// content via the backend /api/feeds (direct RSS where available, Google News
// RSS otherwise) and fills each watched-source card. Falls back to whatever is
// already in the cards if the fetch returns nothing.
(function () {
  if (window.__FI_INGEST__) return;
  window.__FI_INGEST__ = true;

  // Registry of pulled-article links: "L3" -> URL. Signals carry [L#] codes so
  // the model can cite which article supports a claim without bloating the
  // prompt with long URLs; cards resolve the code back to the real link here.
  var LINKS = window.__FI_LINKS__ = {};
  var REFSRC = {};   // "L3" -> source display name (feeds the scorecard)
  var LINKCODE = {}; // article URL -> "L3" (lets thread headers cite members)
  var REFTEXT = {};  // "L3" -> the signal block text (feeds the citation-fit check)
  var linkSeq = 0;

  // Called by the (patched) card renderer for each source tag. `s` is either a
  // plain string (demo mode) or {label, ref} from a live scan.
  window.__FI_SRC_TAG__ = function (s, esc) {
    var label = typeof s === "string" ? s : (s && s.label) || "";
    var ref = s && typeof s === "object" ? s.ref : null;
    var url = ref && LINKS[String(ref).replace(/[\[\]\s]/g, "")];
    if (!label) return "";
    if (url) {
      return '<a class="src" href="' + esc(url) + '" target="_blank" rel="noopener" title="Open the supporting article">' + esc(label) + ' ↗</a>';
    }
    return '<span class="src">' + esc(label) + "</span>";
  };

  // Briefing-email citations (used by the patched renderEmail). Each trend's
  // sources become clickable links in the HTML preview and "label — URL" lines
  // in the plain-text email (so Copy / Outlook / .eml all carry the evidence).
  function srcParts(t) {
    var out = [];
    ((t && t.sources) || []).forEach(function (s) {
      var label = typeof s === "string" ? s : (s && s.label) || "";
      if (!label) return;
      var ref = s && typeof s === "object" ? s.ref : null;
      var url = ref && LINKS[String(ref).replace(/[\[\]\s]/g, "")];
      out.push({ label: label, url: url || "" });
    });
    return out;
  }
  function scannedNames() {
    return Array.prototype.slice.call(document.querySelectorAll("#srcList .src-name"))
      .map(function (el) { return el.textContent.replace(/↗/g, "").trim(); })
      .filter(Boolean);
  }
  window.__FI_EMAIL_SRCS__ = {
    html: function (t, esc) {
      var parts = srcParts(t).map(function (p) {
        return p.url
          ? '<a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.label) + " ↗</a>"
          : "<span>" + esc(p.label) + "</span>";
      });
      return parts.length ? '<span class="eml-srcs">Sources: ' + parts.join(" · ") + "</span>" : "";
    },
    text: function (t) {
      var parts = srcParts(t).map(function (p) { return p.url ? p.label + " — " + p.url : p.label; });
      return parts.length ? "\n      Sources: " + parts.join("; ") : "";
    },
    footerHtml: function (esc) {
      var names = scannedNames();
      return names.length
        ? '<p class="eml-foot">This cycle’s scan drew on: ' + names.map(esc).join(" · ") + ".</p>"
        : "";
    },
    footerText: function () {
      var names = scannedNames();
      return names.length ? "\nThis cycle’s scan drew on: " + names.join(", ") + ".\n" : "";
    }
  };

  // Curated feeds for the default watched sources, keyed by display name.
  // feed = direct RSS (real article URLs; bodies fetched where the publisher allows).
  // query = Google News search (links are resolved server-side to the real article).
  // csf = the CSF handbook source type this source covers (shown on the card).
  var FEEDS = {
    // Default watched sources — a deliberate spread across CSF source types
    "MIT Technology Review":       { feed: "https://www.technologyreview.com/feed/", csf: "Trade press" },
    "McKinsey Global Institute":   { feed: "https://www.mckinsey.com/insights/rss", csf: "Analysts & consultancies" },
    "arXiv (Computers & Society)": { feed: "https://rss.arxiv.org/rss/cs.CY", csf: "Journals · research findings" },
    "Ethan Mollick":               { feed: "https://www.oneusefulthing.org/feed", csf: "Self-publishing · fringe thinkers" },
    "Singapore skills policy":     { query: 'Singapore (SkillsFuture OR "Workforce Singapore" OR "Ministry of Manpower") (skills OR jobs OR training OR workforce) (site:channelnewsasia.com OR site:straitstimes.com OR site:businesstimes.com.sg OR site:gov.sg) when:90d', csf: "Government & policy · STEEPLE: political" },
    "Chinese tech & jobs press":   { query: '就业 技能 培训', lang: "zh", csf: "Different languages · 中文" },
    "Josh Bersin":                 { feed: "https://joshbersin.com/feed/", csf: "Analysts & consultancies" },
    "Channel NewsAsia":            { feed: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml", csf: "Trade press · Singapore lens" },
    // Curated catalog — add any of these by name and it pulls real content.
    // when:180d keeps Google News from surfacing evergreen year-old reports.
    "OECD Education & Skills":     { query: 'site:oecd.org (skills OR "adult learning" OR "vocational" OR "future of work" OR workforce OR "AI in education") when:180d', csf: "Think tanks & gov" },
    "World Economic Forum":        { query: 'site:weforum.org ("future of jobs" OR reskilling OR "skills gap" OR "jobs of tomorrow" OR "lifelong learning") when:180d', csf: "Think tanks & gov" },
    "arXiv (Economics)":           { feed: "https://rss.arxiv.org/rss/econ.GN", csf: "Journals · research findings" },
    "Hacker News":                 { feed: "https://hnrss.org/frontpage", csf: "Forums · sentiment" },
    "Marginal Revolution":         { feed: "https://marginalrevolution.com/feed", csf: "Self-publishing · fringe thinkers" },
    "Carbon Brief":                { feed: "https://www.carbonbrief.org/feed/", csf: "Trade press · STEEPLE: environmental" },
    "Straits Times":               { feed: "https://www.straitstimes.com/news/singapore/rss.xml", csf: "Trade press · Singapore lens" },
    "MIT Sloan Management Review": { feed: "https://sloanreview.mit.edu/feed/", csf: "Journals · management research" },
    "The Conversation":            { feed: "https://theconversation.com/articles.atom", csf: "Journals · academic commentary" },
    "EdSurge":                     { feed: "https://www.edsurge.com/articles_rss", csf: "Trade press · learning & edtech" },
    "Rest of World":               { feed: "https://restofworld.org/feed/latest/", csf: "Trade press · non-Western lens" },
    "HR Dive":                     { feed: "https://www.hrdive.com/feeds/news/", csf: "Trade press · HR & workforce" },
    "Wired":                       { feed: "https://www.wired.com/feed/rss", csf: "Trade press" },
    "The Verge":                   { feed: "https://www.theverge.com/rss/index.xml", csf: "Trade press" },
    "TechCrunch":                  { feed: "https://techcrunch.com/feed/", csf: "Trade press" },
    "VentureBeat AI":              { feed: "https://venturebeat.com/category/ai/feed/", csf: "Trade press" },
    // Persona-pack sources (feeds/queries verified 2026-07-15)
    "Restaurant Dive":             { feed: "https://www.restaurantdive.com/feeds/news/", csf: "Trade press · F&B" },
    "Inside Retail Asia":          { feed: "https://insideretail.asia/feed/", csf: "Trade press · APAC retail" },
    "Indeed Hiring Lab":           { feed: "https://www.hiringlab.org/feed/", csf: "Analysts · labour-market data" },
    "IMDA & Smart Nation":         { query: '(IMDA OR "Smart Nation") Singapore (AI OR digital OR workforce OR technology) when:90d', csf: "Government & policy · digital" },
    "Hiring practice signals":     { query: '"skills-based hiring" OR "AI interview" OR "resume screening" OR "AI recruiting" when:90d', csf: "Trade press · hiring & HR tech" },
    "Singapore care workforce":    { query: 'Singapore (nurses OR "healthcare workforce" OR eldercare OR "community care") (manpower OR skills OR training OR jobs) when:90d', csf: "Government & policy · care economy" },
    "Singapore retail & F&B jobs": { query: 'Singapore (retail OR "food services" OR "F&B") (manpower OR hiring OR automation OR "self-checkout" OR robots OR wages) when:90d', csf: "Trade press · Singapore sectors" },
    "IEA (energy & jobs)":         { query: 'site:iea.org (jobs OR skills OR workforce OR employment OR "energy transition") when:180d', csf: "Think tanks & gov · STEEPLE: environmental" },
    // Phase-1 defensible watchlist additions (2026-10-05, feeds verified)
    "Straits Times (Singapore)":     { feed: "https://www.straitstimes.com/news/singapore/rss.xml", csf: "Press · Singapore" },
    "Nikkei Asia":                   { feed: "https://asia.nikkei.com/rss/feed/nar", csf: "Press · East Asia (English)" },
    "UK Government Office for Science": { feed: "https://www.gov.uk/government/organisations/government-office-for-science.atom", csf: "Government foresight" },
    "ILO":                           { query: 'site:ilo.org (employment OR skills OR "future of work" OR labour) when:180d', csf: "Multilateral · labour" },
    "MOM (Singapore)":               { query: 'site:mom.gov.sg (employment OR workforce OR skills OR retrenchment OR wages) when:90d', csf: "Government & policy" },
    "Institute for Adult Learning":  { query: '"Institute for Adult Learning" Singapore', csf: "Research institute · CET" },
    "Centre for Strategic Futures":  { query: '"Centre for Strategic Futures" OR site:csf.gov.sg', csf: "Government foresight · PMO" },
    // Language lenses (CSF p.136: "look up your topic in different languages")
    "Japanese work & ageing press":  { query: 'リスキリング 高齢者 雇用', lang: "ja", csf: "Different languages · 日本語 · ageing workforce" },
    "Korean skills & ageing press":  { query: '직업훈련 고령화 일자리', lang: "ko", csf: "Different languages · 한국어 · ageing workforce" },
    "German vocational press":       { query: 'Ausbildung Fachkräftemangel Weiterbildung', lang: "de", csf: "Different languages · Deutsch · vocational systems" },
    "Bahasa jobs & training press":  { query: 'pelatihan vokasi keterampilan tenaga kerja', lang: "id", csf: "Different languages · Bahasa · ASEAN labour" }
  };

  // Persona-tuned source packs: matched against the saved persona text by
  // profile.js, which offers one-click adds in the profile panel. Every source
  // named here must exist in FEEDS. Packs are capped small — the signal budget
  // below keeps the total prompt under the LLM gateway's ceiling regardless.
  window.__FI_PACKS__ = [
    { name: "Retail & F&B",           match: /retail|f&b|food service|restaurant|hospitality/i,
      sources: ["Restaurant Dive", "Inside Retail Asia", "Singapore retail & F&B jobs"] },
    { name: "Careers & hiring",       match: /career (coach|service|health)|careersfinder|job.?seek|hiring|placement|mid-career|recruit/i,
      sources: ["Hiring practice signals", "Indeed Hiring Lab", "HR Dive"] },
    { name: "Green economy",          match: /green|climate|sustainab|energy transition|carbon|environment/i,
      sources: ["Carbon Brief", "IEA (energy & jobs)", "arXiv (Economics)"] },
    { name: "Care economy",           match: /health|care work|nurs|eldercare|ageing|aging|community care/i,
      sources: ["Singapore care workforce", "HR Dive", "The Conversation"] },
    { name: "Digital government",     match: /smart nation|digital government|public sector|imda|civil service|govtech/i,
      sources: ["IMDA & Smart Nation", "World Economic Forum"] },
    { name: "Strategy & foresight",   match: /foresight|futures|strategy|horizon|environmental scan/i,
      sources: ["World Economic Forum", "arXiv (Economics)", "Straits Times"] }
  ];

  // One-click add for profile.js: drives the app's own add-source form so the
  // new card renders exactly like a hand-added one.
  window.__FI_ADD_SOURCE__ = function (name) {
    var input = document.getElementById("srcName");
    var form = document.getElementById("srcAdd");
    if (!input || !form || !FEEDS[name]) return false;
    var existing = Array.prototype.slice.call(document.querySelectorAll("#srcList .src-name"))
      .map(function (el) { return el.textContent.replace(/↗/g, "").trim(); });
    if (existing.indexOf(name) !== -1) return false;
    input.value = name;
    if (form.requestSubmit) form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return true;
  };

  // CSF source-type labels for the card badges (read by the patched renderer).
  var KINDS = window.__FI_KIND__ = {};
  for (var fk in FEEDS) { if (FEEDS[fk].csf) KINDS[fk] = FEEDS[fk].csf; }

  function specFor(name) {
    if (FEEDS[name]) return FEEDS[name];
    // Anything the user adds: search Google News for the name + the demo's themes.
    return { query: '"' + name + '" (skills OR "future of work" OR AI OR technology OR government) when:90d' };
  }
  function cardName(row) {
    var el = row.querySelector(".src-name");
    return el ? el.textContent.replace(/↗/g, "").trim() : "";
  }

  // ---- post-scan hook: coverage note, source scorecard, citation-fit audit ----
  function refOf(s) {
    return s && typeof s === "object" && s.ref ? String(s.ref).replace(/[\[\]\s]/g, "") : null;
  }
  window.__FI_SCAN_DONE__ = function (trends, raw) {
    // Scorecard: which watched sources actually CONTRIBUTED text to this scan
    // (a source whose pull returned nothing must not count as "scanned but never
    // cited" — that would wrongly read as a low-value source).
    try {
      var present = Array.prototype.slice.call(document.querySelectorAll("#srcList .src-row"))
        .filter(function (row) { var ta = row.querySelector(".src-text"); return ta && ta.value.trim(); })
        .map(function (row) { var el = row.querySelector(".src-name"); return el ? el.textContent.replace(/↗/g, "").trim() : ""; })
        .filter(Boolean);
      var cited = [];
      (trends || []).forEach(function (t) {
        ((t && t.sources) || []).forEach(function (s) {
          var src = REFSRC[refOf(s)];
          if (src && cited.indexOf(src) === -1) cited.push(src);
        });
      });
      fetch("/api/scorecard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sources: present, cited: cited })
      }).catch(function () {});
    } catch (e) {}
    auditScan(trends);
  };

  // Post-scan audit (ONE compact call, off the critical scan path). Does two
  // CSF jobs at once: (a) citation-claim fit — does each card's cited signal
  // actually support its claim; (b) topic coverage — which of the analyst's
  // tracked topics did none of the surfaced trends address (absence is itself a
  // finding). Judged from the compact trend cards, so it stays fast.
  function auditScan(trends) {
    if (!window.claude || typeof window.claude.complete !== "function") return;
    var items = [];
    (trends || []).forEach(function (t, i) {
      var evid = [];
      ((t && t.sources) || []).forEach(function (s) {
        var ref = refOf(s);
        if (ref && REFTEXT[ref]) evid.push(REFTEXT[ref].slice(0, 700));
      });
      if (evid.length) items.push({ i: i, claim: (t.title || "") + " — " + (t.what || ""), signals: evid });
    });
    var topics = window.__FI_TOPICS__ || [];
    if (!items.length && !topics.length) return;

    var cardList = (trends || []).map(function (t) { return (t.title || "") + " — " + (t.what || ""); });
    var prompt =
      "You are auditing a horizon-scan for a Singapore skills-and-workforce analyst. Return ONLY a JSON object.\n\n" +
      "PART A — citation fit. For each numbered item, does the cited signal genuinely support that specific claim? " +
      "fit=false if the claim overreaches or the signal is about something else; add a short note. Judge support, not importance.\n" +
      "items: " + JSON.stringify(items) + "\n\n" +
      "PART B — topic coverage. Here are the analyst's tracked topics and the titles of the trends this scan surfaced. " +
      "List the tracked topics that NONE of the surfaced trends meaningfully address.\n" +
      "topics: " + JSON.stringify(topics) + "\n" +
      "surfacedTrends: " + JSON.stringify(cardList) + "\n\n" +
      'Reply with ONLY: {"fits":[{"i":0,"fit":true,"note":""}],"emptyTopics":[<tracked topics not addressed>]}. No other text.';

    window.claude.complete({ messages: [{ role: "user", content: prompt }], schema: "audit", purpose: "audit" }).then(function (raw) {
      var obj = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      (obj.fits || []).forEach(function (v) {
        if (!v || v.fit !== false) return;
        var card = document.querySelector('#columns article.card[data-idx="' + v.i + '"]');
        var host = card && card.querySelector(".sources");
        if (host && !host.querySelector(".fi-misfit")) {
          var w = document.createElement("span");
          w.className = "fi-misfit";
          w.title = (v.note || "A cited article may not support this claim") + " — verify before forwarding.";
          w.textContent = "⚠ check citations";
          host.appendChild(w);
        }
      });
      if (topics.length && window.__FI_COVERAGE__) window.__FI_COVERAGE__(obj.emptyTopics || []);
    }).catch(function () { /* audit is best-effort */ });
  }

  // ---- engine audit modal: source scorecard + the triage discard pile ----
  function showAudit() {
    var veil = document.createElement("div");
    veil.className = "fi-veil";
    var card = document.createElement("div");
    card.className = "fi-card";
    card.style.maxHeight = "80vh";
    card.style.overflowY = "auto";
    card.innerHTML = '<h3>Engine audit</h3><p class="fi-sub">Loading…</p>';
    veil.appendChild(card);
    veil.addEventListener("click", function (e) { if (e.target === veil) veil.remove(); });
    document.body.appendChild(veil);
    var metricsP = fetch("/api/metrics?window=7d").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    Promise.all([fetch("/api/store?audit=1").then(function (r) { return r.json(); }), metricsP]).then(function (both) {
      var d = both[0], mx = both[1];
      var esc = function (s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); };
      var sc = Object.keys(d.scorecard || {}).map(function (k) { return { name: k, s: d.scorecard[k] }; })
        .sort(function (a, b) { return (b.s.cited || 0) - (a.s.cited || 0); });
      var html = '<h3>Engine audit</h3>';
      html += '<p class="fi-sub">Source scorecard — how often each source\'s articles are cited in scans.</p>';
      html += sc.length
        ? '<table class="fi-table">' + sc.map(function (r) {
            // Weeding hint (CSF: prune sources that never earn citations) — the
            // machine nominates, the analyst decides what to swap in.
            var weed = (r.s.scans || 0) >= 8 && !(r.s.cited || 0)
              ? ' <span class="fi-weed">never cited — consider swapping for a same-type source</span>' : '';
            return '<tr><td>' + esc(r.name) + '</td><td>' + (r.s.cited || 0) + ' cited / ' + (r.s.scans || 0) + ' scans' + weed + '</td></tr>';
          }).join('') + '</table>'
        : '<p class="fi-sub">No scans recorded yet this deployment.</p>';
      if (d.reviews && d.reviews.length) {
        html += '<p class="fi-sub" style="margin-top:14px">Recent analyst verdicts (Accept / Flag, recorded).</p>';
        html += '<table class="fi-table">' + d.reviews.map(function (r) {
          var when = new Date(r.t);
          return '<tr><td>' + (r.verdict === 'accept' ? '✓' : '⚠') + ' ' + esc(r.verdict) + '</td><td>' + esc(r.title) + '</td><td>' + when.getDate() + '/' + (when.getMonth() + 1) + '</td></tr>';
        }).join('') + '</table>';
      }
      html += '<p class="fi-sub" style="margin-top:14px">Filtered out by triage — rejected as routine or off-mission (CSF: the discard pile stays auditable).</p>';
      html += (d.discards && d.discards.length)
        ? '<ul class="fi-discards">' + d.discards.map(function (x) {
            return '<li>[' + esc(x.source) + '] ' + (x.link ? '<a href="' + esc(x.link) + '" target="_blank" rel="noopener">' + esc(x.title) + '</a>' : esc(x.title)) + '</li>';
          }).join('') + '</ul>'
        : '<p class="fi-sub">Nothing rejected yet.</p>';
      // Injection quarantine: scraped text the guard neutralised before it
      // could reach a prompt. The signal stays in the scan minus the payload.
      if (d.quarantine && d.quarantine.length) {
        html += '<p class="fi-sub" style="margin-top:14px">Prompt-injection guard — instruction-like text neutralised in these articles before any model saw it.</p>';
        html += '<ul class="fi-discards">' + d.quarantine.map(function (x) {
          return '<li>[' + esc(x.source) + '] ' + (x.link ? '<a href="' + esc(x.link) + '" target="_blank" rel="noopener">' + esc(x.title) + '</a>' : esc(x.title)) +
            ' <span class="fi-weed">' + esc(x.kinds.join(", ")) + '</span></li>';
        }).join('') + '</ul>';
      }
      if (mx && mx.overall) html += metricsHtml(mx, esc);
      html += '<div class="fi-row"><span class="fi-spacer"></span><button class="fi-btn ghost" id="fiAuditClose" type="button">Close</button></div>';
      card.innerHTML = html;
      card.querySelector("#fiAuditClose").addEventListener("click", function () { veil.remove(); });
    }).catch(function () {
      card.innerHTML = '<h3>Engine audit</h3><p class="fi-sub">Could not load the audit view.</p>';
    });
  }

  // LLM telemetry panel (server: /api/metrics). Answers the operational
  // questions — what a scan costs, how slow p95 is, how often the model's JSON
  // holds its schema, how many invented citations were caught.
  function metricsHtml(mx, esc) {
    var o = mx.overall, bp = mx.byPurpose || {};
    var pctS = function (x) { return x == null ? "—" : Math.round(x * 1000) / 10 + "%"; };
    var secs = function (ms) { return ms == null ? "—" : (ms / 1000).toFixed(1) + "s"; };
    var tok = function (n) { return n == null ? "—" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n); };
    var usd = function (x) { return x == null ? "unpriced" : "$" + x.toFixed(x < 1 ? 4 : 2); };
    var rows = [];
    rows.push(["Model calls", o.calls + " (" + pctS(o.errorRate) + " errors" + (o.fallbacks ? ", " + o.fallbacks + " congestion fallbacks" : "") + ")"]);
    if (bp.scan) rows.push(["Scan latency", "p50 " + secs(bp.scan.p50ms) + " · p95 " + secs(bp.scan.p95ms) + " (gateway limit 60s)"]);
    if (mx.perScan) rows.push(["Per scan", tok(mx.perScan.avgInTok) + " in / " + tok(mx.perScan.avgOutTok) + " out tokens · " + usd(mx.perScan.avgCostUsd)]);
    rows.push(["Tokens (7 days)", tok(o.inTok) + " in / " + tok(o.outTok) + " out · " + usd(o.costUsd) + (o.estimatedTokens ? " · " + o.estimatedTokens + " calls estimated" : "")]);
    if (o.schema) {
      rows.push(["Schema conformance", pctS(o.schema.firstPassRate) + " first pass → " + pctS(o.schema.finalRate) + " after coercion/repair" +
        " (" + o.schema.repaired + " repairs, " + o.schema.repairOk + " succeeded; " + o.schema.droppedItems + " malformed items dropped)"]);
    }
    if (o.grounding) rows.push(["Citation grounding", o.grounding.ungroundedRefs + " invented [L#] codes caught of " + o.grounding.citedRefs + " cited (" + pctS(o.grounding.groundedRate) + " grounded)"]);
    rows.push(["Injection guard", (o.injectionHits || 0) + " hits in prompts sent"]);
    if (o.truncated) rows.push(["Truncated outputs", o.truncated + " hit the token cap (salvaged where possible)"]);
    var html = '<p class="fi-sub" style="margin-top:14px">LLM telemetry — last 7 days.</p>';
    html += '<table class="fi-table">' + rows.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>';
    var keys = Object.keys(bp).sort(function (a, b) { return bp[b].calls - bp[a].calls; });
    if (keys.length) {
      html += '<table class="fi-table" style="margin-top:8px"><tr><td><b>Call</b></td><td><b>Calls</b></td><td><b>Err</b></td><td><b>p50 / p95</b></td><td><b>Tokens in/out</b></td><td><b>Cost</b></td></tr>' +
        keys.map(function (k) {
          var x = bp[k];
          return '<tr><td>' + esc(k) + '</td><td>' + x.calls + '</td><td>' + pctS(x.errorRate) + '</td><td>' + secs(x.p50ms) + ' / ' + secs(x.p95ms) +
            '</td><td>' + tok(x.inTok) + ' / ' + tok(x.outTok) + '</td><td>' + usd(x.costUsd) + '</td></tr>';
        }).join('') + '</table>';
    }
    if (!mx.priced || !mx.priced.length) html += '<p class="fi-sub">Costs show once the gateway\'s per-model rates are set (LLM_PRICES).</p>';
    return html;
  }

  // Persist Accept/Flag verdicts (CSF: the review step should leave a record).
  // Delegated listener so the app's own card buttons keep working untouched;
  // fire-and-forget — a failed save never blocks the analyst's flow.
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest("button") : null;
    if (!btn || !btn.closest("#columns")) return;
    var txt = (btn.textContent || "").trim();
    var verdict = /Accept/.test(txt) ? "accept" : /Flag/.test(txt) ? "flag" : "";
    if (!verdict) return;
    var card = btn.closest(".card");
    var h = card && card.querySelector("h1,h2,h3,h4,.ttl,.card-title");
    var title = h && h.textContent ? h.textContent.trim() : "";
    if (!title) return;
    fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title, verdict: verdict })
    }).catch(function () {});
  });

  // The header's cadence line ("Last run … · Next scheduled …") reflects the
  // scan engine's real schedule: it ingests server-side daily; the page just
  // reads the engine's memory.
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDate(d) { return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear(); }
  function updateCadence(lastPullMs) {
    var meta = document.querySelector(".cad-meta");
    if (!meta) return;
    var last = lastPullMs ? fmtDate(new Date(lastPullMs)) : "—";
    var next = fmtDate(new Date((lastPullMs || Date.now()) + 24 * 3600e3));
    meta.innerHTML = "Last run <b>" + last + "</b> · Next scheduled <b>" + next + "</b> · ";
    var a = document.createElement("a");
    a.href = "#";
    a.className = "fi-audit";
    a.textContent = "Engine audit";
    a.title = "What the engine filtered out, and how each source performs in scans";
    a.addEventListener("click", function (e) { e.preventDefault(); showAudit(); });
    meta.appendChild(a);
  }
  function shortDate(ms) { var d = new Date(ms); return d.getDate() + " " + MONTHS[d.getMonth()]; }

  // STEEPLE coverage strip (CSF breadth check): share of this cycle's kept
  // signals per domain, from the engine's triage tags. Empty categories are
  // scanning blind spots and are called out, not hidden.
  var STEEPLE = ["Social", "Technological", "Economic", "Environmental", "Political", "Legal", "Ethical"];
  function renderSteeple(domains) {
    var total = 0;
    STEEPLE.forEach(function (c) { total += domains[c] || 0; });
    var meta = document.querySelector(".cad-meta");
    if (!meta || !total) return;
    var el = document.getElementById("fiSteeple");
    if (!el) {
      el = document.createElement("div");
      el.id = "fiSteeple";
      el.className = "fi-steeple";
      meta.insertAdjacentElement("afterend", el);
    }
    var missing = [];
    el.innerHTML = "Coverage " + STEEPLE.map(function (c) {
      var n = domains[c] || 0;
      var pct = Math.round(100 * n / total);
      if (!n) missing.push(c);
      return '<span class="' + (n ? "" : "fi-st0") + '" title="' + c + ': ' + n + ' kept signal' + (n === 1 ? '' : 's') + ' this fortnight">' + c.slice(0, 4) + " " + pct + "%</span>";
    }).join(" · ");
    el.title = missing.length
      ? "No kept signals this fortnight in: " + missing.join(", ") + " — a blind spot to scan for (STEEPLE breadth check)"
      : "All seven STEEPLE domains have signals this fortnight";
  }

  // Corroborated-story threads (CSF: a signal strengthens as observations
  // accumulate around an issue). The engine groups related articles server-side;
  // this panel makes each group inspectable — click a story to see the articles
  // and outlets behind it.
  function renderThreads(threads) {
    var meta = document.querySelector(".cad-meta");
    if (!meta) return;
    var el = document.getElementById("fiThreads");
    if (!threads || !threads.length) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("div");
      el.id = "fiThreads";
      el.className = "fi-threads";
      (document.getElementById("fiSteeple") || meta).insertAdjacentElement("afterend", el);
    }
    el.innerHTML = "";
    var head = document.createElement("div");
    head.className = "fi-threads-head";
    head.textContent = "Corroborated stories — related articles the engine reads as one developing signal:";
    el.appendChild(head);
    threads.forEach(function (t) {
      var d = document.createElement("details");
      d.className = "fi-thread";
      var s = document.createElement("summary");
      s.textContent = t.label + " — " + t.count + " articles · " + t.outlets + " outlet" + (t.outlets === 1 ? "" : "s") + " · since " + shortDate(t.since);
      d.appendChild(s);
      var ul = document.createElement("ul");
      (t.items || []).forEach(function (m) {
        var li = document.createElement("li");
        if (m.link) {
          var a = document.createElement("a");
          a.href = m.link; a.target = "_blank"; a.rel = "noopener";
          a.textContent = m.title;
          li.appendChild(a);
        } else li.textContent = m.title;
        ul.appendChild(li);
      });
      d.appendChild(ul);
      el.appendChild(d);
    });
  }

  function wire() {
    var btn = document.getElementById("sampleBtn");
    var sig = document.getElementById("signals");
    var err = document.getElementById("err");
    if (!btn || !sig) return;

    // Styling for the CSF source-type badge on each card (style-src is not
    // restricted by the platform CSP — only script-src is).
    var st = document.createElement("style");
    st.textContent =
      ".src-kind{color:#5c6b5f;background:#edefe6;padding:1px 8px;border-radius:9px;font-size:11px;white-space:nowrap;}" +
      ".eml-srcs{display:block;margin-top:3px;font-size:11.5px;color:#5c6b5f;}" +
      ".eml-srcs a{color:#3e5c46;text-decoration:none;border-bottom:1px dotted #9db3a2;}" +
      ".eml-srcs a:hover{border-bottom-style:solid;}" +
      ".eml-foot{font-size:11.5px;color:#5c6b5f;margin-top:10px;}" +
      ".fi-audit{color:#3e5c46;text-decoration:none;border-bottom:1px dotted #9db3a2;cursor:pointer;}" +
      ".fi-audit:hover{border-bottom-style:solid;}" +
      ".fi-misfit{color:#a04b3c;background:#f7e9e4;border:1px solid #e5c8bc;border-radius:9px;padding:1px 8px;font-size:11px;margin-left:6px;white-space:nowrap;cursor:help;}" +
      ".fi-table{width:100%;border-collapse:collapse;font-size:12.5px;}" +
      ".fi-table td{padding:4px 6px;border-bottom:1px solid #e4e7da;}" +
      ".fi-discards{font-size:12px;color:#5c6b5f;padding-left:18px;max-height:220px;overflow-y:auto;margin:6px 0;}" +
      ".fi-discards a{color:#3e5c46;}" +
      ".fi-coverage{background:#faf3e3;border:1px solid #e6d3ac;border-radius:10px;padding:10px 14px;font-size:13px;color:#6b5a33;margin:10px 0;}" +
      ".fi-model{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#5c6b5f;margin-left:auto;}" +
      ".fi-model select{border:1px solid #c9cfba;border-radius:8px;padding:5px 8px;font:inherit;font-size:12.5px;background:#fff;color:#2d3a31;cursor:pointer;max-width:250px;}" +
      ".fi-steeple{font-size:11.5px;color:#5c6b5f;margin-top:3px;cursor:default;}" +
      ".fi-steeple .fi-st0{color:#a04b3c;font-weight:600;}" +
      ".fi-weed{color:#a04b3c;font-size:11.5px;}" +
      ".fi-threads{font-size:12px;color:#5c6b5f;margin-top:6px;text-align:left;}" +
      ".fi-threads-head{margin-bottom:2px;}" +
      ".fi-thread{margin:1px 0;}" +
      ".fi-thread summary{cursor:pointer;color:#3e5c46;}" +
      ".fi-thread summary:hover{text-decoration:underline;}" +
      ".fi-thread ul{margin:3px 0 7px 20px;padding:0;}" +
      ".fi-thread a{color:#3e5c46;}";
    document.head.appendChild(st);

    // --- model picker: which AI model runs scans/drafts, user-selectable ---
    // Options come from /api/models (the server's curated catalog); the choice
    // persists per-browser and rides every engine call via window.__FI_MODEL__
    // ("" = follow the server default, mirroring how personas track the default).
    try { window.__FI_MODEL__ = localStorage.getItem("fi_model") || ""; } catch (e) { window.__FI_MODEL__ = ""; }
    fetch("/api/models").then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
      if (!data || !data.models || !data.models.length) return;
      var actions = document.querySelector(".actions");
      if (!actions || document.getElementById("fiModel")) return;
      if (!data.models.some(function (m) { return m.id === window.__FI_MODEL__; })) window.__FI_MODEL__ = "";
      var wrap = document.createElement("label");
      wrap.className = "fi-model";
      wrap.title = "Which AI model runs your scans and drafts. Every model works from the same signals and method; faster ones are less likely to hit the 60-second limit when the service is busy.";
      wrap.appendChild(document.createTextNode("Model"));
      var sel = document.createElement("select");
      sel.id = "fiModel";
      data.models.forEach(function (m) {
        var o = document.createElement("option");
        o.value = m.id;
        o.textContent = m.label + (m.hint ? " — " + m.hint : "");
        if (m.id === (window.__FI_MODEL__ || data["default"])) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", function () {
        window.__FI_MODEL__ = sel.value === data["default"] ? "" : sel.value;
        try { localStorage.setItem("fi_model", window.__FI_MODEL__); } catch (e) {}
      });
      wrap.appendChild(sel);
      actions.appendChild(wrap);
    }).catch(function () { /* older server: no picker */ });

    // Clone to drop the app's original (paste-only) click handler, then own it.
    var freshBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(freshBtn, btn);
    var label = freshBtn.textContent;

    freshBtn.addEventListener("click", async function () {
      var rows = Array.prototype.slice.call(document.querySelectorAll("#srcList .src-row"));
      if (!rows.length) { if (err) { err.textContent = "Add a source first."; err.style.display = ""; } return; }

      freshBtn.disabled = true;
      freshBtn.textContent = "Reading the scan engine…";
      if (err) err.style.display = "none";

      // 1) Default sources come from the engine's memory (server-side daily
      //    ingestion + triage) — instant on a warm store.
      var storeMap = {}, lastPull = 0, storeThreads = [], storeMore = [];
      try {
        var sres = await fetch("/api/store");
        var sdata = await sres.json();
        // Idle-wiped engine + a snapshot in this browser -> restore its memory,
        // then re-read (weeks of thread history survive a platform eviction).
        if (!sdata.total || !sdata.lastPull) {
          try {
            var snap = JSON.parse(localStorage.getItem("fi_snapshot") || "null");
            if (snap && snap.signals && Object.keys(snap.signals).length) {
              await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ signals: snap.signals, lastPull: snap.lastPull }) });
              sres = await fetch("/api/store");
              sdata = await sres.json();
            }
          } catch (e2) { /* no snapshot / restore refused — engine rebuilds itself */ }
        }
        lastPull = sdata.lastPull || 0;
        (sdata.sources || []).forEach(function (s) { if (s.items && s.items.length) storeMap[s.name] = s.items; });
        renderSteeple(sdata.domains || {});
        storeThreads = sdata.threads || [];
        renderThreads(storeThreads);
        storeMore = sdata.more || [];
        // Snapshot the engine's memory into this browser (bodies stripped) so a
        // future idle wipe can be healed by the restore above.
        if (sdata.total) {
          fetch("/api/export").then(function (r) { return r.json(); }).then(function (ex) {
            var sigs = {};
            Object.keys(ex.signals || {}).forEach(function (k) {
              var s = ex.signals[k];
              sigs[k] = { id: s.id, source: s.source, title: s.title, summary: (s.summary || "").slice(0, 400),
                link: s.link, firstSeen: s.firstSeen, lastSeen: s.lastSeen, lastBump: s.lastBump,
                timesSeen: s.timesSeen, triage: s.triage };
            });
            var payload = JSON.stringify({ savedAt: lastPull, lastPull: (ex.meta && ex.meta.lastPull) || lastPull, signals: sigs });
            try { if (payload.length < 3000000) localStorage.setItem("fi_snapshot", payload); } catch (e3) {}
          }).catch(function () {});
        }
      } catch (e) { /* engine unreachable — fall through to live fetch below */ }

      // 1b) Retrieval: ask the engine which signals in its memory bear on each
      //     tracked topic and on the team's mandate (hybrid semantic + keyword
      //     search, server-side). Best-effort — without it the pull is exactly
      //     what it was before.
      var retrieved = null;
      try {
        var ctxBox = document.getElementById("context");
        var rres = await fetch("/api/retrieve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topics: window.__FI_TOPICS__ || [], mandate: ctxBox ? ctxBox.value.trim() : "", k: 3 })
        });
        if (rres.ok) retrieved = await rres.json();
      } catch (e) { /* older server / offline: no retrieval */ }

      // 2) Sources the engine doesn't watch (user-added) are fetched live.
      var results = {};
      var liveItems = [];
      rows.forEach(function (row, i) {
        var name = cardName(row);
        if (!storeMap[name]) {
          var s = specFor(name);
          liveItems.push({ id: String(i), feed: s.feed, query: s.query, lang: s.lang });
        }
      });
      var liveErr = "";
      if (liveItems.length) {
        freshBtn.textContent = "Fetching added sources live…";
        try {
          var res = await fetch("/api/feeds", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items: liveItems })
          });
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
          results = data.results || {};
        } catch (e) { liveErr = e.message || "fetch failed"; /* keep whatever's already in the cards */ }
      }

      var pulled = 0, all = [];
      rows.forEach(function (row, i) {
        var name = cardName(row);
        var ta = row.querySelector(".src-text");
        var live = results[String(i)];
        var items = storeMap[name] || (live && live.items) || null;
        if (ta && items && items.length) {
          var parts = items.map(function (it) {
            var detail = it.body || it.detail || it.summary;
            var ref = "", code = null;
            if (it.link) {
              code = "L" + (++linkSeq);
              LINKS[code] = it.link;
              REFSRC[code] = name;
              LINKCODE[it.link] = code;
              ref = " [" + code + "]";
            }
            // CSF corroboration: recurring signals carry their track record so
            // the model can weigh multi-cycle evidence.
            var seen = it.timesSeen > 1 ? " (seen " + it.timesSeen + "× since " + shortDate(it.firstSeen) + ")" : "";
            var block = "[" + name + "] " + it.title + (detail ? " — " + detail : "") + seen + ref;
            if (code) REFTEXT[code] = block;
            return block;
          });
          ta.value = parts.join("\n\n");
          ta.dispatchEvent(new Event("input", { bubbles: true })); // update app state + item count
          pulled += items.length;
          // Keep items as whole units with their STEEPLE domain, so the budget
          // trimmer below can cut domain-aware and never split an item.
          all.push({ parts: parts, domains: items.map(function (it) { return it.domain || ""; }) });
        } else if (ta && ta.value.trim()) {
          var ps = ta.value.trim().split("\n\n");
          all.push({ parts: ps, domains: ps.map(function () { return ""; }) });
        }
      });

      // Engine sources with no card on this page (the STEEPLE-breadth watchlist
      // additions) still join the scan as full-text blocks — widening the
      // watchlist server-side needs no UI surgery. Their evidence shows up in
      // the threads panel and in citations like any other source.
      var cardNames = {};
      rows.forEach(function (row) { cardNames[cardName(row)] = true; });
      Object.keys(storeMap).forEach(function (name) {
        if (cardNames[name]) return;
        var parts = [], doms = [];
        storeMap[name].forEach(function (it) {
          var detail = it.body || it.detail || it.summary;
          var ref = "", code = null;
          if (it.link) {
            code = "L" + (++linkSeq);
            LINKS[code] = it.link; REFSRC[code] = name; LINKCODE[it.link] = code;
            ref = " [" + code + "]";
          }
          var seen = it.timesSeen > 1 ? " (seen " + it.timesSeen + "× since " + shortDate(it.firstSeen) + ")" : "";
          var block = "[" + name + "] " + it.title + (detail ? " — " + detail : "") + seen + ref;
          if (code) REFTEXT[code] = block;
          parts.push(block);
          doms.push(it.domain || "");
        });
        if (parts.length) all.push({ parts: parts, domains: doms });
      });

      // Signal budget: input + generation must finish inside the GovTech
      // gateway's hard 60s proxy timeout. gpt-5.5 latency is highly variable and
      // load-dependent (same task measured 39s when the gateway is quiet, >60s
      // when congested), so keep a margin here; when the gateway is congested no
      // budget beats 60s and the app asks for a retry. Trim the longest sources'
      // oldest items until the pull fits; cards keep full text, only the scan
      // input is cut.
      // Full coverage: kept signals beyond the per-source top-5 (and the
      // deepening pass's web-search finds) join as headline-only lines, so the
      // scan is aware of EVERYTHING the engine read — with citable links.
      // With retrieval, the headline list leads with what is most relevant to
      // the team's mandate, then fills with the engine's novelty-ranked rest.
      if (retrieved && retrieved.mandate && retrieved.mandate.length) {
        var seenLinks = {};
        storeMore = retrieved.mandate.concat(storeMore).filter(function (m) {
          if (!m.link) return true;
          if (seenLinks[m.link]) return false;
          seenLinks[m.link] = true;
          return true;
        }).slice(0, 25);
      }
      if (storeMore.length) {
        var moreParts = ["ALSO NOTED THIS CYCLE (headline-only; full articles behind the links):"];
        var moreDoms = [""];
        storeMore.forEach(function (m) {
          if (m.link && LINKCODE[m.link]) return;   // already in a source block above
          var code = null, ref = "";
          if (m.link) {
            code = "L" + (++linkSeq);
            LINKS[code] = m.link; REFSRC[code] = m.source; LINKCODE[m.link] = code;
            ref = " [" + code + "]";
          }
          var line = "• [" + m.source + "] " + m.title + ref;
          if (code) REFTEXT[code] = line;
          moreParts.push(line);
          moreDoms.push(m.domain || "");
        });
        all.push({ parts: moreParts, domains: moreDoms });
      }

      // Corroborated-thread header: tells the model which articles are ONE
      // developing story and how many independent outlets back it (CSF
      // corroboration made explicit); budgeted ahead of the source trim below.
      var threadLines = (storeThreads || []).map(function (t) {
        var refs = (t.items || []).map(function (m) { return LINKCODE[m.link]; }).filter(Boolean).slice(0, 4);
        return "THREAD: " + t.label + " — " + t.count + " articles from " + t.outlets +
          " independent outlet" + (t.outlets === 1 ? "" : "s") + " since " + shortDate(t.since) +
          (refs.length ? " [" + refs.join(", ") + "]" : "");
      });
      var threadBlock = threadLines.length
        ? "CORROBORATED STORY THREADS (the engine grouped these articles as single developing signals):\n" + threadLines.join("\n") + "\n\n"
        : "";
      // Retrieved evidence per tracked topic: the passage of each article that
      // best matches the topic, citable like any signal. Articles already in a
      // source block are pointed to by code rather than repeated. A topic with
      // no retrieved support is stated as such (CSF: absence is a signal).
      // Budgeted ahead of the source trim, like the thread header.
      var topicBlock = "";
      if (retrieved && retrieved.topics && retrieved.topics.length) {
        var tl = ["EVIDENCE RETRIEVED FOR TRACKED TOPICS (semantic + keyword search over the engine's memory):"];
        var tlLen = tl[0].length;
        retrieved.topics.forEach(function (t) {
          var lines = [];
          if (!t.hits || !t.hits.length) {
            lines.push("TOPIC " + t.topic + ": no supporting signal in the engine's memory this cycle — the absence may itself be a signal.");
          } else {
            lines.push("TOPIC " + t.topic + ":");
            t.hits.forEach(function (h) {
              var code = h.link ? LINKCODE[h.link] : null;
              if (code) { lines.push("  • see [" + code + "] " + h.title.slice(0, 100)); return; }
              if (h.link) {
                code = "L" + (++linkSeq);
                LINKS[code] = h.link; REFSRC[code] = h.source; LINKCODE[h.link] = code;
              }
              var line = "  • [" + h.source + "] " + h.title + (h.passage ? " — " + h.passage : "") + (code ? " [" + code + "]" : "");
              if (code) REFTEXT[code] = line;
              lines.push(line);
            });
          }
          var chunk = lines.join("\n");
          if (tlLen + chunk.length > 2600) return;   // whole topics only, never a cut line
          tl.push(chunk);
          tlLen += chunk.length + 1;
        });
        if (tl.length > 1) topicBlock = tl.join("\n") + "\n\n";
      }
      var BUDGET = 10000 - threadBlock.length - topicBlock.length;
      function totalLen() { return all.reduce(function (a, b) { return a + b.parts.join("\n\n").length + 2; }, 0); }
      while (totalLen() > BUDGET) {
        // STEEPLE-aware cut (CSF breadth check): drop the oldest item of the
        // most over-represented domain first, so fitting the gateway budget
        // costs depth in the dominant domain rather than breadth across
        // domains. Sources never go below 2 items; items with no domain tag
        // (user-added live sources) fall back to the longest-source rule.
        var counts = {};
        all.forEach(function (b) {
          if (b.parts.length <= 2) return;   // protected sources don't nominate cuts
          b.domains.forEach(function (d) { if (d) counts[d] = (counts[d] || 0) + 1; });
        });
        var top = null;
        Object.keys(counts).forEach(function (d) { if (top === null || counts[d] > counts[top]) top = d; });
        var bi = -1, pi = -1;
        if (top) {
          var bestCount = 0;
          all.forEach(function (b, i) {
            if (b.parts.length <= 2) return;
            var c = 0;
            b.domains.forEach(function (d) { if (d === top) c++; });
            if (c > bestCount) { bestCount = c; bi = i; }
          });
          if (bi !== -1) for (var j = all[bi].parts.length - 1; j >= 0; j--) if (all[bi].domains[j] === top) { pi = j; break; }
        }
        if (pi === -1) {
          bi = 0;
          for (var i2 = 1; i2 < all.length; i2++) if (all[i2].parts.length > all[bi].parts.length) bi = i2;
          if (all[bi].parts.length <= 2) break;   // nothing left to trim anywhere
          pi = all[bi].parts.length - 1;
        }
        all[bi].parts.splice(pi, 1);
        all[bi].domains.splice(pi, 1);
      }
      sig.value = threadBlock + topicBlock + all.map(function (b) { return b.parts.join("\n\n"); }).join("\n\n");
      sig.dispatchEvent(new Event("input", { bubbles: true }));

      freshBtn.disabled = false;
      freshBtn.textContent = label;
      if (err) {
        if (liveErr) { err.textContent = "Added sources could not be fetched (" + liveErr + ")" + (pulled ? " — engine sources loaded." : "."); err.style.display = ""; }
        else if (pulled) { err.style.display = "none"; }
        else { err.textContent = "The scan engine returned nothing — you can paste excerpts manually."; err.style.display = ""; }
      }
      if (lastPull) updateCadence(lastPull);
      sig.focus();
      sig.scrollTop = 0;
    });

    // Automate the cadence: read the engine's memory on page load, so the
    // sources are populated without any clicks.
    updateCadence(null);
    if (!sig.value.trim()) setTimeout(function () { freshBtn.click(); }, 600);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
