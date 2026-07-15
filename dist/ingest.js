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
    "VentureBeat AI":              { feed: "https://venturebeat.com/category/ai/feed/", csf: "Trade press" }
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
    meta.innerHTML = "Last run <b>" + last + "</b> · Next scheduled <b>" + next + "</b>";
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
      ".eml-foot{font-size:11.5px;color:#5c6b5f;margin-top:10px;}";
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
            var ref = "";
            if (it.link) {
              var code = "L" + (++linkSeq);
              LINKS[code] = it.link;
              ref = " [" + code + "]";
            }
            // CSF corroboration: recurring signals carry their track record so
            // the model can weigh multi-cycle evidence.
            var seen = it.timesSeen > 1 ? " (seen " + it.timesSeen + "× since " + shortDate(it.firstSeen) + ")" : "";
            return "[" + name + "] " + it.title + (detail ? " — " + detail : "") + seen + ref;
          }).join("\n\n");
          ta.dispatchEvent(new Event("input", { bubbles: true })); // update app state + item count
          pulled += items.length;
        }
        if (ta && ta.value.trim()) all.push(ta.value.trim());
      });

      sig.value = all.join("\n\n");
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
