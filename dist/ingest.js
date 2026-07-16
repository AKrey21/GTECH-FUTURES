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
    "Chinese tech & jobs press":   { query: '人工智能 就业 技能', lang: "zh", csf: "Different languages · 中文" },
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
    "IEA (energy & jobs)":         { query: 'site:iea.org (jobs OR skills OR workforce OR employment OR "energy transition") when:180d', csf: "Think tanks & gov · STEEPLE: environmental" }
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

    window.claude.complete({ messages: [{ role: "user", content: prompt }] }).then(function (raw) {
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
    fetch("/api/store?audit=1").then(function (r) { return r.json(); }).then(function (d) {
      var esc = function (s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); };
      var sc = Object.keys(d.scorecard || {}).map(function (k) { return { name: k, s: d.scorecard[k] }; })
        .sort(function (a, b) { return (b.s.cited || 0) - (a.s.cited || 0); });
      var html = '<h3>Engine audit</h3>';
      html += '<p class="fi-sub">Source scorecard — how often each source\'s articles are cited in scans.</p>';
      html += sc.length
        ? '<table class="fi-table">' + sc.map(function (r) {
            return '<tr><td>' + esc(r.name) + '</td><td>' + (r.s.cited || 0) + ' cited / ' + (r.s.scans || 0) + ' scans</td></tr>';
          }).join('') + '</table>'
        : '<p class="fi-sub">No scans recorded yet this deployment.</p>';
      html += '<p class="fi-sub" style="margin-top:14px">Filtered out by triage — rejected as routine or off-mission (CSF: the discard pile stays auditable).</p>';
      html += (d.discards && d.discards.length)
        ? '<ul class="fi-discards">' + d.discards.map(function (x) {
            return '<li>[' + esc(x.source) + '] ' + (x.link ? '<a href="' + esc(x.link) + '" target="_blank" rel="noopener">' + esc(x.title) + '</a>' : esc(x.title)) + '</li>';
          }).join('') + '</ul>'
        : '<p class="fi-sub">Nothing rejected yet.</p>';
      html += '<div class="fi-row"><span class="fi-spacer"></span><button class="fi-btn ghost" id="fiAuditClose" type="button">Close</button></div>';
      card.innerHTML = html;
      card.querySelector("#fiAuditClose").addEventListener("click", function () { veil.remove(); });
    }).catch(function () {
      card.innerHTML = '<h3>Engine audit</h3><p class="fi-sub">Could not load the audit view.</p>';
    });
  }

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
      ".fi-coverage{background:#faf3e3;border:1px solid #e6d3ac;border-radius:10px;padding:10px 14px;font-size:13px;color:#6b5a33;margin:10px 0;}";
    document.head.appendChild(st);

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
      var storeMap = {}, lastPull = 0;
      try {
        var sres = await fetch("/api/store");
        var sdata = await sres.json();
        lastPull = sdata.lastPull || 0;
        (sdata.sources || []).forEach(function (s) { if (s.items && s.items.length) storeMap[s.name] = s.items; });
      } catch (e) { /* engine unreachable — fall through to live fetch below */ }

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
          ta.value = items.map(function (it) {
            var detail = it.body || it.detail || it.summary;
            var ref = "", code = null;
            if (it.link) {
              code = "L" + (++linkSeq);
              LINKS[code] = it.link;
              REFSRC[code] = name;
              ref = " [" + code + "]";
            }
            // CSF corroboration: recurring signals carry their track record so
            // the model can weigh multi-cycle evidence.
            var seen = it.timesSeen > 1 ? " (seen " + it.timesSeen + "× since " + shortDate(it.firstSeen) + ")" : "";
            var block = "[" + name + "] " + it.title + (detail ? " — " + detail : "") + seen + ref;
            if (code) REFTEXT[code] = block;
            return block;
          }).join("\n\n");
          ta.dispatchEvent(new Event("input", { bubbles: true })); // update app state + item count
          pulled += items.length;
        }
        if (ta && ta.value.trim()) all.push(ta.value.trim());
      });

      // Signal budget: input + generation must finish inside the GovTech
      // gateway's hard 60s proxy timeout. gpt-5.5 latency is highly variable and
      // load-dependent (same task measured 39s when the gateway is quiet, >60s
      // when congested), so keep a margin here; when the gateway is congested no
      // budget beats 60s and the app asks for a retry. Trim the longest sources'
      // oldest items until the pull fits; cards keep full text, only the scan
      // input is cut.
      var BUDGET = 10000;
      var blocks = all.map(function (t) { return t.split("\n\n"); });
      function totalLen() { return blocks.reduce(function (a, b) { return a + b.join("\n\n").length + 2; }, 0); }
      while (totalLen() > BUDGET) {
        var bi = 0;
        for (var i = 1; i < blocks.length; i++) if (blocks[i].length > blocks[bi].length) bi = i;
        if (blocks[bi].length <= 2) break;   // never trim a source below 2 items
        blocks[bi].pop();
      }
      sig.value = blocks.map(function (b) { return b.join("\n\n"); }).join("\n\n");
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
