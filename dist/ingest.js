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
  var REFPUB = {};   // "L3" -> publisher group (feeds the corroboration check)
  var REFISSUE = {}; // "L3" -> issue-ledger entry the signal belongs to, if any
  var LINKCODE = {}; // url -> "L3" (one code per article, however many blocks cite it)
  var linkSeq = 0;
  var DEFAULT_NAMES = [];   // the engine's daily defaults (from /api/store)

  // Publisher grouping for the client-side corroboration check (mirrors
  // server.mjs publisherOf): SPH titles, Mediacorp channels and .gov.sg sites
  // each count as ONE publisher; otherwise the registrable domain.
  function pubOf(link, source) {
    var h = "";
    try { h = new URL(link).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) {}
    if (!h || h === "news.google.com") return source || "unknown";
    if (/(^|\.)(straitstimes\.com|businesstimes\.com\.sg|zaobao\.com\.sg|zaobao\.com|beritaharian\.sg|tamilmurasu\.com\.sg|shinmin\.sg|sph\.com\.sg|stomp\.com\.sg|tnp\.sg)$/.test(h)) return "SPH Media";
    if (/(^|\.)(channelnewsasia\.com|8world\.com|mediacorp\.sg|todayonline\.com|cna\.asia)$/.test(h)) return "Mediacorp";
    if (/\.gov\.sg$/.test(h)) return "Singapore Government";
    if (/(^|\.)(nus\.edu\.sg|ipscommons\.sg)$/.test(h)) return "NUS / IPS";
    var parts = h.split(".");
    var n = /\.(com|edu|gov|org|net|co|ac)\.[a-z]{2}$/.test(h) ? 3 : 2;
    return parts.slice(-n).join(".");
  }
  function pubsOf(t) {
    var pubs = [];
    ((t && t.sources) || []).forEach(function (s) {
      var ref = s && typeof s === "object" && s.ref ? String(s.ref).replace(/[\[\]\s]/g, "") : null;
      var p = ref && REFPUB[ref];
      if (p && pubs.indexOf(p) === -1) pubs.push(p);
    });
    return pubs;
  }

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
      var k = pubsOf(t).length;
      return parts.length ? '<span class="eml-srcs">Sources: ' + parts.join(" · ") + (k >= 2 ? " · " + k + " unconnected publishers" : "") + "</span>" : "";
    },
    text: function (t) {
      var parts = srcParts(t).map(function (p) { return p.url ? p.label + " — " + p.url : p.label; });
      var k = pubsOf(t).length;
      return parts.length ? "\n      Sources: " + parts.join("; ") + (k >= 2 ? " (" + k + " unconnected publishers)" : "") : "";
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
    "Bahasa jobs & training press":  { query: 'pelatihan vokasi keterampilan tenaga kerja', lang: "id", csf: "Different languages · Bahasa · ASEAN labour" },

    // ---- Catalog expansion (2026-10): sorted by the CSF handbook's source types (Section 3b),
    // Singapore -> Regional -> Global within each. See SOURCES.md for the why, the STEEPLE tags
    // and verification status. Entries carrying both feed and query pull feed-first and fall back
    // to the query (server.mjs). Feeds marked in SOURCES.md as unverified were never fetched live.
    // Of-record news & trade press
    "AI in the public service & governance": { query: "Singapore (GovTech OR \"public service\" OR \"civil service\" OR \"public officers\" OR \"AI Verify\" OR \"Model AI Governance\" OR \"AI Safety Institute\") (\"AI\" OR \"generative AI\" OR \"AI agents\" OR LLM) when:90d", csf: "Trade press · Singapore lens" },
    "Business Times – Opinion & Features": { query: "site:businesstimes.com.sg (productivity OR \"foreign talent\" OR meritocracy OR \"AI\" OR succession OR wages OR talent) when:90d", csf: "Trade press · Singapore lens" },
    "Business Times – Top stories": { feed: "https://www.businesstimes.com.sg/rss/top-stories", query: "site:businesstimes.com.sg (workforce OR hiring OR skills OR AI OR SME OR wages OR retrenchment) when:90d", csf: "Trade press · Singapore lens" },
    "Business Times – Working Life": { query: "site:businesstimes.com.sg (workplace OR careers OR \"work-life\" OR employees OR \"Gen Z\" OR \"hybrid work\" OR HR OR salary) when:90d", csf: "Trade press · Singapore lens" },
    "Carbon services & Climate Impact X": { query: "Singapore (\"Climate Impact X\" OR \"carbon services\" OR \"carbon credits\" OR \"carbon market\" OR \"Article 6\" OR \"carbon project\") when:90d", csf: "Trade press · Singapore lens · STEEPLE: environmental" },
    "Care-sector professional bodies: SNA & SMA": { query: "(\"Singapore Nurses Association\" OR \"Singapore Medical Association\") (nurses OR doctors OR manpower OR burnout OR AI OR workload OR attrition) when:180d", csf: "Trade press · Singapore lens" },
    "Chinese firms landing in Singapore": { query: "Singapore (BYD OR Xpeng OR Zeekr OR Shein OR ByteDance OR TikTok OR Alibaba OR Huawei OR \"Chinese companies\" OR \"Chinese firms\") (hiring OR headquarters OR \"regional HQ\" OR expansion OR \"set up\" OR jobs) when:90d", csf: "Trade press · Singapore lens" },
    "CNA – Business section": { feed: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6936", query: "site:channelnewsasia.com (hiring OR layoffs OR \"AI\" OR skills OR workforce OR SME OR bank OR manufacturing) when:90d", csf: "Trade press · Singapore lens" },
    "CNA – Singapore section": { feed: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=10416", query: "site:channelnewsasia.com Singapore (jobs OR workers OR skills OR AI OR training OR SkillsFuture OR MOM) when:90d", csf: "Trade press · Singapore lens" },
    "CNA Commentary": { query: "site:channelnewsasia.com \"Commentary:\" (jobs OR skills OR workers OR AI OR education OR careers OR gig OR retirement) when:90d", csf: "Trade press · Singapore lens" },
    "CNA TODAY Big Read & CNA Insider": { query: "site:channelnewsasia.com (\"The Big Read\" OR \"CNA Insider\" OR \"IN FOCUS\") when:90d", csf: "Trade press · Singapore lens" },
    "Construction, marine & aviation labour": { query: "Singapore (construction OR \"built environment\" OR shipyard OR \"marine and offshore\" OR aviation OR \"Changi Airport\" OR maritime) (workforce OR manpower OR \"work permit\" OR automation OR apprenticeship OR skills) when:90d", csf: "Trade press · Singapore lens" },
    "Data centres, energy & compute limits": { query: "Singapore (\"data centre\" OR \"data centres\" OR \"data center\" OR \"AI compute\" OR \"Green Data Centre\") (electricity OR power OR grid OR energy OR moratorium OR cooling OR nuclear OR jobs) when:90d", csf: "Trade press · Singapore lens · STEEPLE: environmental" },
    "EdgeProp Singapore": { query: "site:edgeprop.sg (office OR coworking OR \"flexible workspace\" OR industrial OR dormitory OR \"work from home\") when:90d", csf: "Trade press · Singapore lens" },
    "Financial-sector bodies: ABS, IBF & SFA": { query: "(\"Association of Banks in Singapore\" OR \"Institute of Banking and Finance\" OR \"Singapore FinTech Association\") (skills OR jobs OR talent OR AI OR training OR reskilling OR hiring) when:180d", csf: "Trade press · Singapore lens" },
    "Flexible work, 4-day week & RTO": { query: "Singapore (\"flexible work\" OR \"four-day\" OR \"4-day work week\" OR \"return to office\" OR \"work from home\" OR hybrid OR \"compressed work week\") (employers OR workers OR employees) when:90d", csf: "Trade press · Singapore lens" },
    "Foreign workforce passes & talent flows": { query: "Singapore (\"Employment Pass\" OR \"S Pass\" OR COMPASS OR \"work permit\" OR \"ONE Pass\" OR \"foreign talent\" OR \"foreign workers\" OR \"brain drain\") when:90d", csf: "Trade press · Singapore lens" },
    "Green jobs, carbon tax & ESG reporting": { query: "Singapore (\"green jobs\" OR \"green skills\" OR \"carbon tax\" OR \"sustainability reporting\" OR \"climate reporting\" OR \"carbon credits\" OR \"Green Plan\") when:180d", csf: "Trade press · Singapore lens · STEEPLE: environmental" },
    "Hawker & F&B automation": { query: "Singapore (hawker OR hawkers OR \"coffee shop\" OR \"food court\" OR restaurant OR \"central kitchen\") (robot OR robots OR automation OR \"self-service\" OR cashless OR \"AI\" OR \"labour shortage\") when:90d", csf: "Trade press · Singapore lens" },
    "HR professional bodies: IHRP & SHRI": { query: "(\"Institute for Human Resource Professionals\" OR IHRP OR \"Singapore Human Resources Institute\") (HR OR skills OR certification OR AI OR \"human capital\" OR workforce) when:180d", csf: "Trade press · Singapore lens" },
    "HRM Asia": { feed: "https://hrmasia.com/feed", query: "site:hrmasia.com (Singapore OR MOM OR SkillsFuture OR AI OR \"skills-based\") when:90d", csf: "Trade press · Singapore lens" },
    "Human Resources Online": { feed: "https://www.humanresourcesonline.net/rss", query: "site:humanresourcesonline.net Singapore (MOM OR TAFEP OR retrenchment OR \"four-day\" OR AI OR SkillsFuture) when:90d", csf: "Trade press · Singapore lens" },
    "Institution of Engineers, Singapore (IES)": { query: "\"Institution of Engineers\" Singapore (engineers OR talent OR skills OR \"chartered engineer\" OR AI OR salary) when:180d", csf: "Trade press · Singapore lens" },
    "ISCA (Singapore Chartered Accountants)": { query: "(ISCA OR \"Singapore Chartered Accountants\") Singapore (accountants OR audit OR AI OR talent OR skills OR CPE) when:90d", csf: "Trade press · Singapore lens" },
    "JS-SEZ & cross-border labour": { query: "(\"Johor-Singapore Special Economic Zone\" OR \"JS-SEZ\" OR \"RTS Link\" OR \"Forest City\" OR Iskandar) (workers OR jobs OR talent OR relocate OR \"cross-border\" OR companies) when:180d", csf: "Trade press · Singapore lens" },
    "Lifelong learning take-up behaviour": { query: "Singapore (\"adult learners\" OR \"mid-career\" OR \"SkillsFuture Credit\" OR \"training allowance\" OR micro-credentials OR \"training providers\" OR \"course take-up\" OR \"Jobseeker Support\") when:90d", csf: "Trade press · Singapore lens" },
    "Marketing-Interactive": { query: "site:marketing-interactive.com Singapore (AI OR agency OR layoffs OR hiring OR \"in-house\" OR creator) when:90d", csf: "Trade press · Singapore lens" },
    "Mature workers, re-employment & CPF": { query: "Singapore (\"re-employment age\" OR \"retirement age\" OR \"older workers\" OR \"senior workers\" OR \"mature workers\" OR \"Senior Employment Credit\" OR \"CPF contribution\") when:90d", csf: "Trade press · Singapore lens" },
    "Migrant worker welfare & dormitories": { query: "Singapore (\"migrant workers\" OR \"work permit holders\" OR dormitories OR \"domestic workers\" OR \"migrant domestic workers\") (welfare OR wages OR \"rest day\" OR \"recruitment fees\" OR abuse OR \"work injury\" OR housing) when:90d", csf: "Trade press · Singapore lens" },
    "Mothership": { feed: "https://mothership.sg/feed", query: "site:mothership.sg (jobs OR salary OR retrenched OR retrenchment OR boss OR intern OR \"fresh grad\" OR \"work from home\" OR SkillsFuture OR AI OR employer) when:90d", csf: "Forums · sentiment (by proxy) · Singapore lens" },
    "Platform & gig work after the PWA": { query: "Singapore (\"platform workers\" OR \"Platform Workers Act\" OR \"delivery riders\" OR \"private-hire drivers\" OR \"gig workers\" OR \"platform operators\") when:90d", csf: "Trade press · Singapore lens" },
    "Retrenchments & hiring freezes": { query: "Singapore (retrenchment OR retrenchments OR layoffs OR \"job cuts\" OR \"hiring freeze\" OR redundancies OR restructuring) (workers OR employees OR staff) when:90d", csf: "Trade press · Singapore lens" },
    "RICE Media": { feed: "https://www.ricemedia.co/feed", query: "site:ricemedia.co when:180d", csf: "Trade press · Singapore lens" },
    "Semiconductor & advanced mfg talent": { query: "Singapore (semiconductor OR semiconductors OR \"wafer fab\" OR chipmaker OR Micron OR GlobalFoundries OR \"advanced manufacturing\" OR biopharma) (jobs OR hiring OR workforce OR talent OR apprentices OR training) when:90d", csf: "Trade press · Singapore lens" },
    "SGTech & Singapore Computer Society": { query: "(SGTech OR \"Singapore Computer Society\") (talent OR skills OR hiring OR AI OR survey OR certification OR workforce) when:90d", csf: "Trade press · Singapore lens" },
    "Singapore Business Review": { query: "site:sbr.com.sg (hiring OR workforce OR HR OR AI OR skills OR SME OR retail OR F&B) when:90d", csf: "Trade press · Singapore lens" },
    "Singapore Institute of Directors (SID)": { query: "\"Singapore Institute of Directors\" (boards OR directors OR AI OR workforce OR governance OR survey) when:180d", csf: "Trade press · Singapore lens · STEEPLE: ethical" },
    "Singapore Law Watch (headlines)": { query: "site:singaporelawwatch.sg (employment OR workers OR retrenchment OR \"Workplace Fairness\" OR \"data protection\" OR AI OR workplace OR \"gig\" OR \"platform workers\") when:90d", csf: "Trade press · Singapore lens · STEEPLE: legal" },
    "SME & manufacturing bodies: SMF & ASME": { query: "(\"Singapore Manufacturing Federation\" OR \"Association of Small and Medium Enterprises\" OR ASME) Singapore (manpower OR hiring OR AI OR automation OR skills OR \"foreign workers\" OR SMEs) when:180d", csf: "Trade press · Singapore lens" },
    "SME AI & digitalisation adoption": { query: "Singapore (SMEs OR \"small businesses\" OR \"heartland enterprises\" OR \"family business\") (\"generative AI\" OR \"AI agents\" OR automation OR digitalisation OR \"Productivity Solutions Grant\" OR \"CTO-as-a-Service\") when:90d", csf: "Trade press · Singapore lens" },
    "Straits Times – Business": { feed: "https://www.straitstimes.com/news/business/rss.xml", query: "site:straitstimes.com (hiring OR layoffs OR retrenchment OR \"job cuts\" OR SME OR wages OR \"AI\") when:90d", csf: "Trade press · Singapore lens" },
    "Straits Times – Opinion": { feed: "https://www.straitstimes.com/news/opinion/rss.xml", query: "site:straitstimes.com (jobs OR skills OR workers OR AI OR education OR careers OR graduates OR meritocracy OR gig) when:90d", csf: "Trade press · Singapore lens" },
    "Straits Times – Tech": { feed: "https://www.straitstimes.com/news/tech/rss.xml", query: "site:straitstimes.com (AI OR chatbot OR automation OR \"generative\" OR robots OR scam) (jobs OR workers OR skills OR firms OR agencies) when:90d", csf: "Trade press · Singapore lens" },
    "Tertiary intake & curriculum shifts": { query: "Singapore (polytechnic OR ITE OR NUS OR NTU OR SMU OR SUSS OR SIT OR SUTD) (intake OR admissions OR curriculum OR \"new degree\" OR \"cut-off\" OR discontinue OR \"aptitude-based\") when:180d", csf: "Trade press · Singapore lens" },
    "Trade associations: RAS, SRA & SLA": { query: "(\"Restaurant Association of Singapore\" OR \"Singapore Retailers Association\" OR \"Singapore Logistics Association\") (manpower OR workers OR hiring OR automation OR AI OR costs OR closures) when:180d", csf: "Trade press · Singapore lens" },
    "Training providers & private education": { query: "Singapore (\"training providers\" OR \"private education institutions\" OR \"Singapore Association for Private Education\" OR \"adult educators\") (SkillsFuture OR courses OR funding OR closure OR audit OR quality) when:180d", csf: "Trade press · Singapore lens" },
    "Unions & worker voice (NTUC, CTCs)": { query: "Singapore (NTUC OR \"labour movement\" OR \"Company Training Committee\" OR \"trade union\" OR \"collective agreement\" OR unionised OR \"industrial relations\") (workers OR PMEs OR \"job security\" OR AI OR skills) when:90d", csf: "Trade press · Singapore lens" },
    "Vulcan Post": { feed: "https://vulcanpost.com/feed", query: "site:vulcanpost.com (jobs OR hiring OR AI OR SkillsFuture OR gig OR \"small business\") when:90d", csf: "Trade press · Singapore lens" },
    "Workplace fairness & discrimination": { query: "Singapore (\"Workplace Fairness\" OR TAFEP OR \"Tripartite Alliance for Fair\" OR \"workplace discrimination\" OR \"age discrimination\" OR \"unfair dismissal\" OR \"Employment Claims Tribunals\") when:90d", csf: "Trade press · Singapore lens · STEEPLE: legal" },
    "Workplace mental health & burnout": { query: "Singapore (workplace OR employees OR workers OR \"civil servants\") (burnout OR \"mental health\" OR \"mental well-being\" OR \"psychological safety\" OR \"long hours\" OR overwork) when:90d", csf: "Trade press · Singapore lens" },
    "Yahoo News Singapore": { query: "site:sg.news.yahoo.com (jobs OR workers OR salary OR AI OR SkillsFuture OR employers OR \"foreign talent\") when:90d", csf: "Trade press · Singapore lens" },
    "Youth, graduates & NEET sentiment": { query: "Singapore (\"fresh graduates\" OR \"young workers\" OR \"Gen Z\" OR NEET OR \"youth unemployment\" OR underemployed OR \"lying flat\" OR \"gap year\") (jobs OR work OR career OR hiring) when:90d", csf: "Trade press · Singapore lens" },
    "Asia Food Journal / FoodNavigator-Asia": { query: "(site:asiafoodjournal.com OR site:foodnavigator-asia.com) Singapore (workforce OR automation OR \"food tech\" OR \"central kitchen\" OR robot OR \"30 by 30\") when:180d", csf: "Trade press · Asia lens" },
    "Bangkok Post": { feed: "https://www.bangkokpost.com/rss/data/business.xml", query: "site:bangkokpost.com (workers OR labour OR skills OR AI OR ageing OR \"digital nomad\" OR EV) when:90d", csf: "Trade press · Asia lens" },
    "DealStreetAsia": { feed: "https://www.dealstreetasia.com/feed", query: "site:dealstreetasia.com Singapore (layoffs OR hiring OR edtech OR \"HR tech\" OR \"gig\" OR eldercare OR training) when:90d", csf: "Trade press · Asia lens" },
    "e27": { feed: "https://e27.co/index_wp.php/feed", query: "site:e27.co (hiring OR layoffs OR talent OR \"future of work\" OR AI OR remote) when:90d", csf: "Trade press · Asia lens" },
    "Eco-Business": { feed: "https://www.eco-business.com/feeds/all", query: "site:eco-business.com Singapore (\"green jobs\" OR \"green skills\" OR workforce OR \"just transition\" OR \"sustainability reporting\") when:90d", csf: "Trade press · Asia lens · STEEPLE: environmental" },
    "ET HRSEA (ETHRWorld Southeast Asia)": { feed: "https://hrsea.economictimes.indiatimes.com/rss/topstories", query: "site:hrsea.economictimes.indiatimes.com (skills OR reskilling OR learning OR AI OR hiring OR layoffs OR gig OR \"four-day\" OR Singapore) when:90d", csf: "Trade press · Asia lens" },
    "FutureCIO & FutureIoT": { query: "(site:futurecio.tech OR site:futureiot.tech) (Asia OR Singapore) (skills OR talent OR AI OR automation OR \"shadow AI\") when:90d", csf: "Trade press · Asia lens" },
    "GovInsider": { query: "site:govinsider.asia (skills OR workforce OR AI OR \"public service\" OR \"public officers\" OR GovTech) when:90d", csf: "Trade press · Asia lens" },
    "India business press (Mint & ET)": { query: "(site:livemint.com OR site:economictimes.indiatimes.com) (\"IT services\" OR \"global capability\" OR GCC OR hiring OR layoffs OR skilling OR \"AI\") when:90d", csf: "Trade press · Asia lens" },
    "Industrial Automation Asia & APMEN": { query: "(site:iaasiaonline.com OR site:equipment-news.com) (Singapore OR ASEAN) (robot OR cobot OR workforce OR skills OR \"Industry 4.0\" OR technician) when:180d", csf: "Trade press · Asia lens" },
    "Malaysia press & JS-SEZ": { query: "(site:theedgemalaysia.com OR site:thestar.com.my OR site:malaymail.com OR site:freemalaysiatoday.com) (JS-SEZ OR \"Johor-Singapore\" OR \"data centre\" OR TVET OR \"brain drain\" OR \"foreign workers\" OR \"working in Singapore\" OR talent OR skills) when:90d", csf: "Trade press · Asia lens" },
    "Maritime Fairtrade": { query: "site:maritimefairtrade.org (seafarers OR crew OR workers OR corruption OR welfare OR Singapore) when:90d", csf: "Trade press · Asia lens · STEEPLE: ethical" },
    "Mongabay (SE Asia environment)": { feed: "https://news.mongabay.com/feed/", query: "site:news.mongabay.com (Singapore OR Indonesia OR Malaysia OR \"Southeast Asia\") (\"palm oil\" OR \"carbon credits\" OR fisheries OR haze OR workers OR \"just transition\") when:90d", csf: "Trade press · Asia lens · STEEPLE: environmental" },
    "Nikkei Asia": { feed: "https://asia.nikkei.com/rss/feed/nar", query: "site:asia.nikkei.com (Singapore OR ASEAN OR \"Southeast Asia\" OR Japan) (workers OR jobs OR AI OR skills OR hiring OR ageing OR \"foreign workers\") when:90d", csf: "Trade press · Asia lens" },
    "OpenGov Asia": { feed: "https://opengovasia.com/feed", query: "site:opengovasia.com Singapore (AI OR skills OR workforce OR \"digital government\" OR \"public officers\") when:90d", csf: "Trade press · Asia lens" },
    "Payload Asia & Asian Aviation": { query: "(site:payloadasia.com OR site:asianaviation.com) (Singapore OR Changi OR CAAS) (workforce OR manpower OR automation OR training OR pilots OR MRO) when:180d", csf: "Trade press · Asia lens" },
    "Rappler": { feed: "https://www.rappler.com/feed/", query: "site:rappler.com (OFW OR workers OR BPO OR AI OR nurses OR education OR \"call center\") when:90d", csf: "Trade press · Asia lens" },
    "Retail Asia & Healthcare Asia": { query: "(site:retailasia.com OR site:healthcareasiamagazine.com) (Singapore OR \"Southeast Asia\") (staff OR workforce OR automation OR AI OR robot OR nurses OR telehealth) when:180d", csf: "Trade press · Asia lens" },
    "SCMP Tech": { query: "site:scmp.com (AI OR tech OR jobs OR graduates OR layoffs OR \"gig\" OR \"996\") China when:90d", csf: "Trade press · Asia lens" },
    "Sixth Tone": { feed: "https://www.sixthtone.com/rss", query: "site:sixthtone.com (jobs OR graduates OR vocational OR gig OR AI OR elderly OR workers) when:90d", csf: "Trade press · Asia lens" },
    "Tech in Asia": { feed: "https://www.techinasia.com/feed", query: "site:techinasia.com Singapore (jobs OR layoffs OR hiring OR AI OR talent OR edtech) when:90d", csf: "Trade press · Asia lens" },
    "The Diplomat": { feed: "https://thediplomat.com/feed/", query: "site:thediplomat.com (labour OR workers OR migration OR digital OR education OR AI OR scam) when:90d", csf: "Trade press · Asia lens" },
    "The Jakarta Post": { query: "site:thejakartapost.com (workers OR migrant OR \"minimum wage\" OR skills OR digital OR AI OR education OR layoffs) when:90d", csf: "Trade press · Asia lens" },
    "The Japan Times": { feed: "https://www.japantimes.co.jp/feed/", query: "site:japantimes.co.jp (workers OR \"foreign workers\" OR ageing OR AI OR \"labor shortage\" OR robots OR \"four-day\") when:90d", csf: "Trade press · Asia lens" },
    "The Korea Herald": { query: "site:koreaherald.com (jobs OR workers OR AI OR education OR \"birth rate\" OR ageing OR semiconductor OR hagwon) when:90d", csf: "Trade press · Asia lens" },
    "TTG Asia": { feed: "https://www.ttgasia.com/feed", query: "site:ttgasia.com Singapore (staff OR manpower OR hiring OR robot OR automation OR AI OR \"travel agents\") when:90d", csf: "Trade press · Asia lens" },
    "VnExpress International": { feed: "https://e.vnexpress.net/rss/news.rss", query: "site:e.vnexpress.net (workers OR factory OR jobs OR skills OR AI OR semiconductor OR education) when:90d", csf: "Trade press · Asia lens" },
    "Climate Home News": { feed: "https://www.climatechangenews.com/feed/", query: "site:climatechangenews.com (\"just transition\" OR \"Article 6\" OR \"carbon market\" OR Singapore OR ASEAN OR workers OR skills) when:90d", csf: "Trade press · STEEPLE: environmental" },
    "Global business press: AI & jobs": { query: "(site:reuters.com OR site:bloomberg.com OR site:ft.com OR site:economist.com) (\"white-collar\" OR layoffs OR hiring OR \"entry-level\" OR skills OR workforce OR apprenticeship) (AI OR automation) when:30d", csf: "Trade press" },
    "Harvard Business Review": { feed: "https://feeds.hbr.org/harvardbusiness", query: "site:hbr.org (AI OR skills OR hiring OR \"future of work\" OR managers OR \"Gen Z\" OR productivity OR layoffs) when:90d", csf: "Trade press" },
    "Splash247": { feed: "https://splash247.com/feed/", query: "site:splash247.com (seafarers OR crew OR autonomous OR Singapore OR MPA OR decarbonisation) when:90d", csf: "Trade press" },
    // Government & policy (of record)
    "A*STAR & NRF research-talent news": { query: "(site:a-star.edu.sg OR site:nrf.gov.sg) (talent OR scholars OR RIE2030 OR AI OR quantum OR \"deep tech\" OR scientists OR industry OR automation) when:180d", csf: "Government & policy · Singapore lens" },
    "BCA, LTA, URA & JTC built-environment news": { query: "(site:bca.gov.sg OR site:lta.gov.sg OR site:ura.gov.sg OR site:jtc.gov.sg) (robotics OR automation OR autonomous OR productivity OR manpower OR workers OR drones OR \"digital\") when:90d", csf: "Government & policy · Singapore lens" },
    "Challenge magazine (Public Service Division)": { query: "(site:psd.gov.sg OR site:challenge.gov.sg) (\"public officers\" OR Challenge) (AI OR skills OR future OR work) when:180d", csf: "Government & policy · Singapore lens" },
    "CSC ETHOS journal & CAST": { query: "(site:knowledge.csc.gov.sg OR site:csc.gov.sg OR (\"Civil Service College\" Singapore ETHOS)) (foresight OR \"public service\" OR AI OR workforce OR skills OR simulation) when:180d", csf: "Government & policy · Singapore lens" },
    "DesignSingapore Council & design futures": { query: "site:designsingapore.org OR \"DesignSingapore Council\" when:180d", csf: "Government & policy · Singapore lens" },
    "EDB, EnterpriseSG & STB media releases": { query: "(site:edb.gov.sg OR site:enterprisesg.gov.sg OR site:stb.gov.sg) (investment OR jobs OR talent OR AI OR manufacturing OR SMEs OR \"data centre\" OR semiconductor OR manpower OR robots) when:90d", csf: "Government & policy · Singapore lens" },
    "GovTech TechNews": { query: "site:tech.gov.sg (AI OR agents OR officers OR skills OR engineers OR \"digital\" OR scholarship) when:90d", csf: "Government & policy · Singapore lens" },
    "Green skills & Skills Framework watch (SG)": { query: "Singapore (\"Green Skills Committee\" OR \"Skills Framework for Sustainability\" OR \"green skills\" OR \"sustainability skills\") (training OR course OR certification OR polytechnic OR ITE OR SkillsFuture) when:90d", csf: "Government & policy · Singapore lens · STEEPLE: environmental" },
    "MAS media releases, speeches & consultations": { query: "site:mas.gov.sg (fintech OR AI OR talent OR workforce OR jobs OR \"financial sector\" OR tokenisation OR quantum OR \"consultation paper\") when:90d", csf: "Government & policy · Singapore lens" },
    "Ministry PQ replies": { query: "(site:mom.gov.sg OR site:moe.gov.sg OR site:mti.gov.sg OR site:mddi.gov.sg OR site:psd.gov.sg OR site:msf.gov.sg OR site:moh.gov.sg) (\"written answer\" OR \"oral answer\" OR \"written reply\" OR \"oral reply\" OR \"response to PQ\" OR \"parliamentary question\") when:90d", csf: "Government & policy · Singapore lens" },
    "MOE newsroom & parliamentary replies": { query: "site:moe.gov.sg (skills OR \"lifelong learning\" OR AI OR polytechnic OR ITE OR university OR adult OR curriculum OR \"work-study\" OR graduates) when:90d", csf: "Government & policy · Singapore lens" },
    "MOH, MSF & AIC care-manpower releases": { query: "(site:moh.gov.sg OR site:msf.gov.sg OR site:aic.sg) (nurses OR caregivers OR \"allied health\" OR manpower OR workforce OR eldercare OR \"Healthier SG\" OR \"Age Well\" OR AI OR robots) when:90d", csf: "Government & policy · Singapore lens" },
    "MOM newsroom (press releases & speeches)": { query: "site:mom.gov.sg (workers OR workforce OR skills OR employment OR \"job redesign\" OR AI OR retrenchment OR \"foreign\") when:90d", csf: "Government & policy · Singapore lens" },
    "MTI newsroom (Economic Survey & ITMs)": { query: "site:mti.gov.sg (economy OR productivity OR \"industry transformation\" OR manpower OR AI OR \"Economic Survey\" OR \"business costs\" OR SMEs) when:90d", csf: "Government & policy · Singapore lens" },
    "NCCS, Green Plan & MSE/NEA/EMA releases": { query: "(site:nccs.gov.sg OR site:greenplan.gov.sg OR site:mse.gov.sg OR site:nea.gov.sg OR site:ema.gov.sg) (carbon OR green OR jobs OR skills OR hydrogen OR nuclear OR solar OR circular OR \"climate\") when:90d", csf: "Government & policy · Singapore lens · STEEPLE: environmental" },
    "NTUC newsroom & LabourBeat": { query: "(site:ntuc.org.sg OR site:labourbeat.org OR site:ntuclearninghub.com) (workers OR AI OR skills OR \"Company Training Committee\" OR gig OR \"platform workers\" OR retrenchment OR wages) when:90d", csf: "Government & policy · Singapore lens" },
    "Parliament sittings via of-record press": { query: "(\"in Parliament\" OR \"parliamentary question\" OR \"written reply\" OR \"Committee of Supply\") (jobs OR workers OR skills OR training OR AI OR retrenchment OR \"platform workers\" OR \"older workers\") (site:channelnewsasia.com OR site:straitstimes.com OR site:businesstimes.com.sg) when:90d", csf: "Government & policy · Singapore lens" },
    "PDPC & AI Verify Foundation": { query: "(site:pdpc.gov.sg OR site:aiverifyfoundation.sg) (AI OR generative OR agentic OR governance OR guidelines OR sandbox OR \"testing\" OR \"assurance\") when:90d", csf: "Government & policy · Singapore lens · STEEPLE: legal" },
    "PDPC decisions & data-protection (SG)": { query: "Singapore (PDPC OR \"Personal Data Protection Commission\" OR PDPA) (decision OR fined OR directions OR breach OR employee OR \"employment data\" OR \"AI\" OR \"synthetic data\" OR guidelines) when:90d", csf: "Government & policy · Singapore lens · STEEPLE: legal" },
    "PMO & gov.sg newsroom (incl. Factually)": { query: "(site:pmo.gov.sg OR site:www.gov.sg) (jobs OR workers OR skills OR AI OR economy OR \"Forward Singapore\" OR \"cost of living\") when:90d", csf: "Government & policy · Singapore lens" },
    "PSD newsroom (Public Service HR)": { query: "site:psd.gov.sg when:180d", csf: "Government & policy · Singapore lens" },
    "SGX/ACRA climate-reporting phase-in watch": { query: "Singapore (\"climate reporting\" OR \"sustainability reporting\" OR ISSB OR \"ESG reporting\" OR \"Scope 3\") (SGX OR ACRA OR \"Sustainability Reporting Advisory Committee\" OR deadline OR delay OR defer OR assurance) when:90d", csf: "Government & policy · Singapore lens · STEEPLE: legal" },
    "SkillsFuture SG & WSG newsroom (house, flag)": { query: "(site:ssg.gov.sg OR site:skillsfuture.gov.sg OR site:wsg.gov.sg OR site:mycareersfuture.gov.sg) when:90d", csf: "Government & policy · Singapore lens" },
    "SNEF & SBF employer surveys": { query: "(site:snef.org.sg OR site:sbf.org.sg OR \"Singapore National Employers Federation\" OR SNEF OR \"Singapore Business Federation\" OR \"National Business Survey\") (survey OR wage OR hiring OR manpower OR AI OR skills OR reskilling OR \"business sentiment\") when:180d", csf: "Government & policy · Singapore lens" },
    "Tripartite Alliance (TAFEP / TADM)": { query: "(site:tal.sg OR TAFEP OR \"Tripartite Alliance\" OR \"Workplace Fairness Act\" OR \"Tripartite Guidelines\") (guidelines OR \"flexible work\" OR \"fair employment\" OR dispute OR \"older workers\" OR AI OR discrimination) when:180d", csf: "Government & policy · Singapore lens · STEEPLE: legal" },
    "ASEAN regional bodies (ERIA, ESCAP, APEC)": { query: "(site:eria.org OR site:unescap.org OR site:asean.org OR site:apec.org) (skills OR workforce OR digital OR ageing OR migration OR \"future of work\" OR AI OR qualifications) when:180d", csf: "Government & policy · Asia lens" },
    "ILO Asia-Pacific": { query: "site:ilo.org (Asia OR ASEAN OR Pacific OR Singapore) (skills OR \"platform work\" OR gig OR migration OR \"care economy\" OR \"just transition\" OR AI OR automation) when:180d", csf: "Government & policy · Asia lens" },
    "EU JRC Foresight & Megatrends Hub": { query: "(site:knowledge4policy.ec.europa.eu OR site:commission.europa.eu) (foresight OR megatrends OR \"Strategic Foresight Report\" OR \"future of work\" OR skills) when:180d", csf: "Government & policy" },
    "Future Generations Commissioner for Wales": { feed: "https://www.futuregenerations.wales/feed/", query: "(site:futuregenerations.wales OR \"Future Generations Commissioner\") (skills OR work OR AI OR \"well-being\" OR \"future generations\" OR \"long-term\") when:180d", csf: "Government & policy" },
    "ILO newsroom & research": { query: "site:ilo.org (skills OR \"future of work\" OR \"platform work\" OR gig OR \"generative AI\" OR \"just transition\" OR \"care economy\" OR apprenticeship) when:180d", csf: "Government & policy" },
    "IPCC assessment & special reports": { query: "(site:ipcc.ch OR (IPCC (\"Seventh Assessment\" OR AR7 OR \"special report\" OR \"Summary for Policymakers\"))) when:180d", csf: "Government & policy · STEEPLE: environmental" },
    "OECD.AI Policy Observatory": { query: "(site:oecd.ai OR \"OECD.AI\" OR \"AI Incidents Monitor\" OR \"OECD AI Policy Observatory\") (work OR jobs OR skills OR labour OR \"algorithmic management\" OR incidents OR policy OR generative) when:180d", csf: "Government & policy" },
    "UK GO-Science & MOD foresight (gov.uk)": { feed: "https://www.gov.uk/search/all.atom?organisations%5B%5D=government-office-for-science&order=updated-newest", query: "site:gov.uk (\"Government Office for Science\" OR \"Global Strategic Trends\" OR \"Futures Toolkit\" OR \"horizon scanning\" OR \"Foresight report\") when:180d", csf: "Government & policy" },
    "UNESCO (Futures of Education, AI in ed)": { query: "site:unesco.org (education OR \"lifelong learning\" OR skills OR AI OR teachers OR \"higher education\" OR TVET OR \"micro-credential\") when:180d", csf: "Government & policy" },
    // Think tanks & institutes
    "AI Singapore": { query: "(site:aisingapore.org OR \"AI Singapore\") (talent OR apprenticeship OR SEA-LION OR LearnAI OR \"AI Apprenticeship\") when:90d", csf: "Think tanks & institutes · Singapore lens" },
    "Asatizah & madrasah workforce (MUIS/PERGAS)": { query: "(asatizah OR madrasah OR MUIS OR PERGAS OR \"Singapore College of Islamic Studies\" OR \"Asatizah Recognition Scheme\") (training OR skills OR jobs OR career OR salary OR curriculum OR graduates OR kerjaya OR latihan) when:180d", csf: "Think tanks & institutes · Singapore lens" },
    "AWARE Singapore": { feed: "https://www.aware.org.sg/feed/", query: "site:aware.org.sg OR (AWARE Singapore (caregivers OR \"flexible work\" OR \"women workers\")) when:180d", csf: "Think tanks & institutes · Singapore lens" },
    "Centre for Liveable Cities": { query: "site:clc.gov.sg OR (\"Centre for Liveable Cities\" Singapore) when:180d", csf: "Think tanks & institutes · Singapore lens · STEEPLE: environmental" },
    "ESI, ERI@N & CNCS (energy/climate institutes)": { query: "(\"Energy Studies Institute\" OR \"ERI@N\" OR \"Energy Research Institute @ NTU\" OR \"Centre for Nature-based Climate Solutions\" OR EcoLabs) Singapore when:180d", csf: "Think tanks & institutes · Singapore lens · STEEPLE: environmental" },
    "GCNS & Singapore Sustainability Academy": { query: "(\"Global Compact Network Singapore\" OR \"Singapore Sustainability Academy\" OR \"Apex Corporate Sustainability Awards\") when:180d", csf: "Think tanks & institutes · Singapore lens · STEEPLE: environmental" },
    "IPS (LKYSPP) reports, surveys & Prism": { query: "(\"Institute of Policy Studies\" OR site:lkyspp.nus.edu.sg) Singapore (survey OR study OR report OR workers OR skills OR jobs OR AI OR attitudes) when:90d", csf: "Think tanks & institutes · Singapore lens" },
    "IPS Commons": { query: "site:ipscommons.sg OR (\"Institute of Policy Studies\" Singapore (work OR skills OR ageing OR class OR AI)) when:90d", csf: "Think tanks & institutes · Singapore lens" },
    "Lien Centre for Social Innovation (SMU)": { feed: "https://ink.library.smu.edu.sg/lien_research/recent.rss", query: "(\"Lien Centre for Social Innovation\" OR (\"Social Space\" SMU)) Singapore when:180d", csf: "Think tanks & institutes · Singapore lens" },
    "NUS Centre for Future-ready Graduates": { query: "\"Centre for Future-ready Graduates\" OR (site:nus.edu.sg \"future-ready graduates\") when:180d", csf: "Think tanks & institutes · Singapore lens" },
    "NUS IPUR (public understanding of risk)": { query: "\"Institute for the Public Understanding of Risk\" OR site:ipur.nus.edu.sg when:180d", csf: "Think tanks & institutes · Singapore lens" },
    "RSIS Commentaries & Publications": { feed: "https://www.rsis.edu.sg/feed/?post_type=rsispub", query: "site:rsis.edu.sg (workforce OR skills OR \"artificial intelligence\" OR technology OR migrant) when:90d", csf: "Think tanks & institutes · Singapore lens" },
    "SEAS & SG clean-energy workforce": { query: "Singapore (\"Sustainable Energy Association\" OR \"Asia Clean Energy Summit\" OR \"clean energy\" OR solar OR hydrogen OR \"energy transition\") (installers OR engineers OR workforce OR skills OR training OR jobs) when:90d", csf: "Think tanks & institutes · Singapore lens · STEEPLE: environmental" },
    "SG Green Finance Centre & SSFA": { query: "(\"Singapore Green Finance Centre\" OR \"Singapore Sustainable Finance Association\" OR (\"sustainable finance\" Singapore (talent OR skills OR training OR jobs OR taxonomy))) when:180d", csf: "Think tanks & institutes · Singapore lens · STEEPLE: environmental" },
    "SG social-service & ageing ecosystem": { query: "Singapore (NCSS OR NVPC OR \"Agency for Integrated Care\" OR \"Lien Foundation\" OR \"Tsao Foundation\" OR \"social service agencies\" OR \"City of Good\") (workforce OR volunteers OR caregivers OR seniors OR \"social workers\" OR eldercare OR \"community care\" OR dementia) when:90d", csf: "Think tanks & institutes · Singapore lens" },
    "SGBC & Green Mark skills": { query: "Singapore (\"Green Building Council\" OR \"Green Mark\" OR \"green building\" OR \"built environment\") (skills OR training OR workforce OR certification OR retrofit OR \"energy audit\") when:90d", csf: "Think tanks & institutes · Singapore lens · STEEPLE: environmental" },
    "SINDA newsroom & Indian-community programmes": { query: "(SINDA OR \"Singapore Indian Development Association\") (youth OR skills OR jobs OR training OR education OR tuition OR family OR income OR \"Indian community\" OR PMET) when:120d", csf: "Think tanks & institutes · Singapore lens" },
    "SUSS Centre for Applied Research": { query: "site:suss.edu.sg (\"Centre for Applied Research\" OR \"adult learners\" OR \"lifelong learning\" OR research) when:180d", csf: "Think tanks & institutes · Singapore lens" },
    "Temasek Ecosperity": { query: "site:ecosperity.sg OR (Ecosperity Temasek (jobs OR skills OR \"green economy\" OR adaptation)) when:180d", csf: "Think tanks & institutes · Singapore lens · STEEPLE: environmental" },
    "Tsao Foundation / ILC Singapore": { query: "(\"Tsao Foundation\" OR \"ILC Singapore\" OR (\"International Longevity Centre\" Singapore)) when:180d", csf: "Think tanks & institutes · Singapore lens" },
    "WWF-SG, SEC & SG Eco Fund (civic green)": { query: "(\"WWF-Singapore\" OR \"WWF Singapore\" OR \"Singapore Environment Council\" OR \"SG Eco Fund\") when:180d", csf: "Think tanks & institutes · Singapore lens · STEEPLE: environmental" },
    "Yayasan MENDAKI research & Policy Digest": { query: "(MENDAKI OR Mendaki OR \"M3@Town\" OR \"M³\") (Malay OR Melayu OR \"Malay/Muslim\") (education OR skills OR jobs OR training OR youth OR income OR PMET OR survey OR research OR \"Policy Digest\") when:180d", csf: "Think tanks & institutes · Singapore lens" },
    "Asian Development Blog (ADB & ADBI)": { query: "(site:blogs.adb.org OR site:adb.org OR site:adbi.org) (skills OR jobs OR workforce OR labour OR ageing OR education OR digital OR migration) when:180d", csf: "Think tanks & institutes · Asia lens" },
    "East Asia Forum": { feed: "https://eastasiaforum.org/feed/", query: "site:eastasiaforum.org (labour OR skills OR education OR ageing OR migration OR automation OR AI) when:90d", csf: "Think tanks & institutes · Asia lens" },
    "Hinrich Foundation": { query: "site:hinrichfoundation.com (trade OR \"supply chain\" OR digital OR services OR talent OR jobs) when:180d", csf: "Think tanks & institutes · Asia lens" },
    "ISEAS Fulcrum": { feed: "https://fulcrum.sg/feed/", query: "site:fulcrum.sg (workforce OR labour OR skills OR AI OR \"digital economy\" OR migration OR ageing OR education OR Johor) when:90d", csf: "Think tanks & institutes · Asia lens" },
    "ISEAS Perspective": { feed: "https://www.iseas.edu.sg/category/articles-commentaries/iseas-perspective/feed/", query: "site:iseas.edu.sg (\"ISEAS Perspective\" OR \"Trends in Southeast Asia\") when:180d", csf: "Think tanks & institutes · Asia lens" },
    "SIIA Insights & Commentaries": { query: "site:siiaonline.org when:180d", csf: "Think tanks & institutes · Asia lens" },
    "The HEAD Foundation": { query: "(site:headfoundation.org OR \"HEAD Foundation\") (education OR skills OR \"human capital\" OR \"higher education\") when:180d", csf: "Think tanks & institutes · Asia lens" },
    "UNDP Asia-Pacific futures & signals": { query: "site:undp.org (\"Signals Spotlight\" OR foresight OR \"future of work\" OR skills OR \"anticipatory governance\") (Asia OR Pacific OR Singapore) when:180d", csf: "Think tanks & institutes · Asia lens" },
    "Ada Lovelace Institute": { feed: "https://www.adalovelaceinstitute.org/feed/", query: "site:adalovelaceinstitute.org (workers OR workplace OR \"public attitudes\" OR foundation models OR regulation OR education) when:180d", csf: "Think tanks & institutes · STEEPLE: ethical" },
    "AlgorithmWatch": { feed: "https://algorithmwatch.org/en/feed/", query: "site:algorithmwatch.org (work OR workers OR hiring OR \"automated decision\" OR \"AI Act\" OR surveillance) when:180d", csf: "Think tanks & institutes · STEEPLE: ethical" },
    "Brookings (workforce, AI & education)": { feed: "https://www.brookings.edu/feed/", query: "site:brookings.edu (workforce OR skills OR \"future of work\" OR apprenticeship OR \"community college\" OR (AI AND jobs) OR education) when:90d", csf: "Think tanks & institutes" },
    "Data & Society": { feed: "https://datasociety.net/feed/", query: "site:datasociety.net (labor OR work OR workers OR \"AI\" OR education) when:180d", csf: "Think tanks & institutes · STEEPLE: ethical" },
    "Education International — news & research": { query: "site:ei-ie.org (AI OR \"future of\" OR teachers OR skills OR vocational OR digital OR \"teacher shortage\") when:90d", csf: "Think tanks & institutes" },
    "Finland Futures Research Centre (Turku)": { query: "(\"Finland Futures Research Centre\" OR \"Futures Conference\" OR site:utu.fi) (futures OR foresight) when:180d", csf: "Think tanks & institutes" },
    "Future of Privacy Forum": { feed: "https://fpf.org/feed/", query: "site:fpf.org (workplace OR employee OR \"Asia-Pacific\" OR Singapore OR \"AI governance\" OR youth OR education) when:180d", csf: "Think tanks & institutes · STEEPLE: legal" },
    "Nesta (Discovery Hub & Future Signals)": { query: "site:nesta.org.uk (signals OR futures OR foresight OR \"future of work\" OR skills OR AI OR \"job adverts\" OR \"net zero\" OR \"early years\" OR \"collective intelligence\") when:180d", csf: "Think tanks & institutes" },
    "Pew Research Center (work, AI & society)": { feed: "https://www.pewresearch.org/feed/", query: "site:pewresearch.org (workers OR jobs OR AI OR \"remote work\" OR teens OR education OR \"Gen Z\" OR unions) when:180d", csf: "Think tanks & institutes" },
    "RAND — labour markets, education & AI": { feed: "https://www.rand.org/topics/labor-markets.xml", query: "site:rand.org (workforce OR skills OR \"labor market\" OR \"artificial intelligence\" OR education OR training) when:90d", csf: "Think tanks & institutes" },
    "Stanford Center on Longevity": { query: "(\"Stanford Center on Longevity\" OR \"New Map of Life\" OR site:longevity.stanford.edu) (work OR career OR learning OR retirement OR \"older workers\" OR \"100-year life\") when:180d", csf: "Think tanks & institutes" },
    "The Millennium Project": { query: "\"Millennium Project\" (\"State of the Future\" OR \"future of work\" OR \"Work/Technology 2050\" OR AGI OR foresight) when:180d", csf: "Think tanks & institutes" },
    "UK labour think tanks (Resolution Fdn, TBI)": { query: "(site:resolutionfoundation.org OR site:institute.global) (jobs OR \"young people\" OR AI OR skills OR wages OR \"labour market\" OR \"future of work\" OR graduates) when:180d", csf: "Think tanks & institutes" },
    "UNU-CPR & Future Design (Osaka University)": { query: "(site:unu.edu OR \"UNU-CPR\" OR (\"Future Design\" \"imaginary future generations\")) (AI OR \"future generations\" OR governance OR work OR foresight) when:180d", csf: "Think tanks & institutes" },
    "WEF Strategic Intelligence & Global Risks": { query: "site:weforum.org (\"Global Risks\" OR \"Strategic Intelligence\" OR \"Transformation Map\" OR \"Chief Economists Outlook\" OR \"Top 10 Emerging Technologies\" OR \"Global Future Council\") when:180d", csf: "Think tanks & institutes" },
    "World Bank & IMF blogs (jobs, education, AI)": { query: "(site:blogs.worldbank.org OR site:imf.org) (jobs OR skills OR education OR \"artificial intelligence\" OR productivity OR \"labor market\" OR digital) when:180d", csf: "Think tanks & institutes" },
    // Analysts & consultancies
    "Accenture, EY & KPMG – SG workforce studies": { query: "Singapore (Accenture OR EY OR KPMG) (\"generative AI\" OR workforce OR skills OR \"work reimagined\" OR employees OR reskilling) when:120d", csf: "Analysts & consultancies · Singapore lens" },
    "McKinsey – Singapore & Southeast Asia": { query: "McKinsey (Singapore OR \"Southeast Asia\" OR ASEAN) (workforce OR jobs OR skills OR AI OR productivity OR economy) when:180d", csf: "Analysts & consultancies · Singapore lens" },
    "Robert Walters & Hays – Singapore job market": { query: "Singapore (\"Robert Walters\" OR Hays OR \"Michael Page\") (salary OR hiring OR talent OR \"job market\" OR candidates OR skills) when:90d", csf: "Analysts & consultancies · Singapore lens" },
    "SG law-firm employment & AI updates": { query: "(site:lexology.com OR site:mondaq.com) Singapore (employment OR \"Employment Act\" OR \"Workplace Fairness\" OR retrenchment OR \"non-compete\" OR PDPA OR \"AI governance\" OR \"flexible work\") when:90d", csf: "Analysts & consultancies · Singapore lens · STEEPLE: legal" },
    "Staffing & HR surveys, Singapore cuts": { query: "Singapore (ManpowerGroup OR Randstad OR Workmonitor OR Mercer OR \"Korn Ferry\" OR Aon OR WTW OR \"Robert Walters\") (hiring OR talent OR skills OR salary OR workers OR AI OR survey) when:90d", csf: "Analysts & consultancies · Singapore lens" },
    "Korn Ferry Institute & Korn Ferry Singapore": { query: "\"Korn Ferry\" (Singapore OR \"Asia Pacific\" OR APAC OR \"Workforce 2030\" OR \"talent acquisition trends\" OR \"future of work\") when:90d", csf: "Analysts & consultancies · Asia lens" },
    "SG & ASEAN bank economists": { query: "(DBS OR OCBC OR UOB OR Maybank OR CIMB) (economist OR \"research note\") (labour OR productivity OR wages OR employment OR retrenchments OR \"foreign workers\" OR ageing) Singapore (site:businesstimes.com.sg OR site:straitstimes.com OR site:channelnewsasia.com) when:90d", csf: "Analysts & consultancies · Asia lens" },
    "AI-lab work & economy research": { query: "(\"Anthropic Economic Index\" OR GDPval OR \"Work Trend Index\" OR \"Microsoft WorkLab\" OR (OpenAI (jobs OR workers OR \"economic research\"))) when:180d", csf: "Analysts & consultancies" },
    "Arup Foresight & Insights": { query: "site:arup.com (foresight OR \"future of\" OR \"drivers of change\" OR skills OR workforce OR \"net zero\" OR regenerative) when:180d", csf: "Analysts & consultancies · STEEPLE: environmental" },
    "BCG Henderson Institute & Bain": { query: "(site:bcg.com OR site:bain.com) (\"Henderson Institute\" OR \"future of work\" OR \"generative AI\" OR workforce OR skills OR \"Decoding Global Talent\" OR \"AI at Work\") when:180d", csf: "Analysts & consultancies" },
    "Big Four workforce surveys (PwC, Deloitte)": { query: "(site:pwc.com OR site:deloitte.com OR site:ey.com OR site:kpmg.com) (\"Hopes and Fears\" OR \"AI Jobs Barometer\" OR \"Human Capital Trends\" OR \"Work Reimagined\" OR workforce OR skills OR \"future of work\") when:180d", csf: "Analysts & consultancies" },
    "Future Today Strategy Group (Amy Webb)": { query: "(\"Future Today Strategy Group\" OR \"Future Today Institute\" OR \"Amy Webb\") (\"Tech Trends\" OR signals OR foresight OR AI) when:180d", csf: "Analysts & consultancies" },
    "Gallup Workplace": { query: "site:gallup.com (workplace OR engagement OR wellbeing OR managers OR \"remote work\" OR \"AI\" OR \"Southeast Asia\" OR Singapore) when:90d", csf: "Analysts & consultancies" },
    "Learning-platform skills reports": { query: "(\"Global Skills Report\" OR \"Workplace Learning Report\" OR Udemy OR Degreed OR Coursera) (skills OR learners OR \"generative AI\" OR Singapore OR \"micro-credential\" OR enrolments) when:180d", csf: "Analysts & consultancies" },
    "McKinsey – Future of Work & AI at work": { query: "site:mckinsey.com (\"future of work\" OR workforce OR skills OR reskilling OR \"generative AI\" OR \"AI agents\" OR superagency OR \"people and organizational performance\") when:90d", csf: "Analysts & consultancies" },
    // Journals & preprints · research findings
    "Institute for Adult Learning research": { query: "(site:ial.edu.sg OR \"Institute for Adult Learning\") (research OR \"adult learning\" OR training OR \"adult educators\" OR AI OR \"workplace learning\" OR \"Collaboratory\") when:180d", csf: "Journals · research findings · Singapore lens" },
    "Law Gazette (Law Society of Singapore)": { query: "site:lawgazette.com.sg (employment OR \"artificial intelligence\" OR \"legal tech\" OR \"young lawyers\" OR wellbeing OR \"data protection\" OR workplace) when:180d", csf: "Journals · research findings · Singapore lens · STEEPLE: legal" },
    "NIE SingTeach & NTU research news": { query: "(site:singteach.nie.edu.sg OR site:nie.edu.sg OR site:ntu.edu.sg) (workforce OR skills OR \"artificial intelligence\" OR learning OR ageing OR jobs OR teachers) when:90d", csf: "Journals · research findings · Singapore lens" },
    "NUS News & Thought Leadership": { query: "(site:news.nus.edu.sg OR site:nus.edu.sg) (workforce OR skills OR \"artificial intelligence\" OR jobs OR ageing OR workers) when:90d", csf: "Journals · research findings · Singapore lens" },
    "NUS Social Service Research Centre": { feed: "https://fass.nus.edu.sg/ssr/feed/", query: "(\"Social Service Research Centre\" OR \"Centre for Family and Population Research\" OR \"NUS Social Work\") Singapore when:180d", csf: "Journals · research findings · Singapore lens" },
    "SMU Research & Resilient Workforces Institute": { query: "(site:news.smu.edu.sg OR site:research.smu.edu.sg OR \"Resilient Workforces Institute\") (workforce OR skills OR AI OR ageing OR learning) when:90d", csf: "Journals · research findings · Singapore lens" },
    "SMU ROSA / Singapore Life Panel": { feed: "https://ink.library.smu.edu.sg/rosa_reports/recent.rss", query: "(\"Centre for Research on Successful Ageing\" OR \"Singapore Life Panel\" OR \"Longevity Societies and Economies\") SMU when:180d", csf: "Journals · research findings · Singapore lens" },
    "Asia Pacific Journal of Education": { feed: "https://www.tandfonline.com/feed/rss/cape20", csf: "Journals · research findings · Asia lens" },
    "Asia Pacific Journal of Human Resources": { feed: "https://onlinelibrary.wiley.com/feed/17447941/most-recent", csf: "Journals · research findings · Asia lens" },
    "RePEc NEP-SEA (Southeast Asia papers)": { feed: "https://nep.repec.org/nep-sea.rss", csf: "Journals · research findings · Asia lens" },
    "arXiv cs.HC (Human-Computer Interaction)": { feed: "https://rss.arxiv.org/rss/cs.HC", csf: "Journals · research findings" },
    "Big Data & Society": { feed: "https://journals.sagepub.com/action/showFeed?type=etoc&feed=rss&jc=bds", csf: "Journals · research findings" },
    "Business-school reviews (Wharton, LSE)": { query: "(site:knowledge.wharton.upenn.edu OR site:blogs.lse.ac.uk OR site:chicagobooth.edu) (AI OR work OR skills OR hiring OR labor OR careers OR productivity) when:180d", csf: "Journals · research findings" },
    "Computers & Education: AI (journal)": { feed: "https://rss.sciencedirect.com/publication/science/2666920X", csf: "Journals · research findings" },
    "Futures (Elsevier journal)": { feed: "https://rss.sciencedirect.com/publication/science/00163287", csf: "Journals · research findings" },
    "ILR Review": { feed: "https://journals.sagepub.com/action/showFeed?type=etoc&feed=rss&jc=ilr", query: "\"ILR Review\" when:180d", csf: "Journals · research findings" },
    "INSEAD Knowledge (Singapore campus)": { query: "site:knowledge.insead.edu (work OR careers OR AI OR skills OR talent OR \"future of work\") when:90d", csf: "Journals · research findings" },
    "Intl Journal of Training and Development": { feed: "https://onlinelibrary.wiley.com/feed/14682419/most-recent", csf: "Journals · research findings" },
    "Journal of Education and Work": { feed: "https://www.tandfonline.com/feed/rss/cjew20", csf: "Journals · research findings" },
    "Journal of Futures Studies": { feed: "https://jfsdigital.org/feed/", query: "\"Journal of Futures Studies\" when:180d", csf: "Journals · research findings" },
    "Journal of Vocational Behavior": { feed: "https://rss.sciencedirect.com/publication/science/00018791", csf: "Journals · research findings" },
    "Journal of Vocational Education & Training": { feed: "https://www.tandfonline.com/feed/rss/rjve20", csf: "Journals · research findings" },
    "Nature Human Behaviour": { feed: "https://www.nature.com/nathumbehav.rss", query: "\"Nature Human Behaviour\" (work OR workers OR \"artificial intelligence\" OR education OR skills) when:90d", csf: "Journals · research findings" },
    "NBER New Working Papers": { feed: "https://www.nber.org/rss/new.xml", query: "site:nber.org (skills OR workers OR labor OR training OR \"artificial intelligence\" OR automation) when:90d", csf: "Journals · research findings" },
    "New Technology, Work and Employment": { feed: "https://onlinelibrary.wiley.com/feed/1468005x/most-recent", csf: "Journals · research findings" },
    "Oxford Internet Institute & Oxford Martin": { query: "(site:oii.ox.ac.uk OR site:oxfordmartin.ox.ac.uk) (work OR labour OR jobs OR AI OR skills OR platform OR automation OR gig) when:180d", csf: "Journals · research findings" },
    "RePEc NEP-LAB: new labour economics papers": { feed: "https://nep.repec.org/nep-lab.rss", csf: "Journals · research findings" },
    "Stanford HAI & MIT IDE (AI-and-work)": { query: "(site:hai.stanford.edu OR site:ide.mit.edu OR site:shapingwork.mit.edu OR \"Stanford HAI\" OR (\"MIT\" \"digital economy\")) (work OR jobs OR AI OR productivity OR education OR policy OR \"entry-level\") when:180d", csf: "Journals · research findings" },
    "Technological Forecasting & Social Change": { feed: "https://rss.sciencedirect.com/publication/science/00401625", csf: "Journals · research findings" },
    "VoxEU columns (CEPR)": { query: "site:cepr.org (skills OR labour OR workers OR \"artificial intelligence\" OR training OR ageing) when:90d", csf: "Journals · research findings" },
    "Work, Employment and Society": { feed: "https://journals.sagepub.com/action/showFeed?type=etoc&feed=rss&jc=wes", csf: "Journals · research findings" },
    // Self-publishing · thinkers & newsletters
    "Academia.SG (Academic Views)": { feed: "https://www.academia.sg/feed/", query: "site:academia.sg when:180d", csf: "Self-publishing · thinkers · Singapore lens" },
    "Dollars and Sense": { feed: "https://dollarsandsense.sg/feed/", query: "site:dollarsandsense.sg (career OR salary OR jobs OR retrenchment OR \"side hustle\" OR SkillsFuture) when:90d", csf: "Self-publishing · thinkers · Singapore lens" },
    "Jom (weekly magazine)": { feed: "https://www.jom.media/rss/", query: "site:jom.media when:180d", csf: "Self-publishing · thinkers · Singapore lens" },
    "Open Government Products (Substack)": { feed: "https://opengovsg.substack.com/feed", query: "(\"Open Government Products\" OR opengovsg OR \"open.gov.sg\") when:180d", csf: "Self-publishing · thinkers · Singapore lens" },
    "Singapore foresight thinkers: op-eds & talks": { query: "(\"Peter Ho\" OR \"Aaron Maniam\" OR \"Cheryl Chung\" OR \"Devadas Krishnadas\") (futures OR foresight OR \"Centre for Strategic Futures\" OR scenarios OR \"wicked problems\") when:180d", csf: "Self-publishing · thinkers · Singapore lens" },
    "TWC2 (migrant worker stories)": { feed: "https://twc2.org.sg/feed/", query: "site:twc2.org.sg when:180d", csf: "Self-publishing · thinkers · Singapore lens" },
    "We, The Citizens (Kirsten Han)": { feed: "https://wethecitizens.net/feed", query: "site:wethecitizens.net when:90d", csf: "Self-publishing · thinkers · Singapore lens" },
    "ChinAI Newsletter": { feed: "https://chinai.substack.com/feed", query: "ChinAI OR (\"Jeffrey Ding\" AI) when:180d", csf: "Self-publishing · thinkers · Asia lens" },
    "AI Snake Oil (Narayanan & Kapoor)": { feed: "https://www.aisnakeoil.com/feed", query: "\"AI Snake Oil\" OR (\"Arvind Narayanan\" AI) when:180d", csf: "Self-publishing · thinkers" },
    "Benedict Evans": { feed: "https://www.ben-evans.com/benedictevans?format=rss", query: "\"Benedict Evans\" (AI OR tech OR smartphone) when:180d", csf: "Self-publishing · thinkers" },
    "Exponential View (Azeem Azhar)": { feed: "https://www.exponentialview.co/feed", query: "\"Exponential View\" OR \"Azeem Azhar\" when:180d", csf: "Self-publishing · thinkers" },
    "Import AI (Jack Clark)": { feed: "https://importai.substack.com/feed", query: "\"Import AI\" OR (\"Jack Clark\" Anthropic) when:180d", csf: "Self-publishing · thinkers" },
    "Pluralistic (Cory Doctorow)": { feed: "https://pluralistic.net/feed/", query: "\"Cory Doctorow\" when:180d", csf: "Self-publishing · thinkers · STEEPLE: legal" },
    "Postnormal Times / CPPFS (Ziauddin Sardar)": { query: "(\"postnormal times\" OR \"Ziauddin Sardar\" OR site:postnormaltim.es OR \"Centre for Postnormal Policy\") when:180d", csf: "Self-publishing · thinkers" },
    "Stratechery (Ben Thompson)": { feed: "https://stratechery.com/feed/", query: "Stratechery OR (\"Ben Thompson\" (AI OR platform OR Apple)) when:180d", csf: "Self-publishing · thinkers" },
    "Tech Policy Press": { feed: "https://www.techpolicy.press/feed/", query: "site:techpolicy.press (labor OR workers OR jobs OR education OR \"AI governance\" OR Asia OR Singapore) when:90d", csf: "Self-publishing · thinkers · STEEPLE: ethical" },
    "The Cynefin Company — Dave Snowden blog": { query: "((\"Cynefin\" Snowden) OR site:thecynefin.co OR SenseMaker) when:180d", csf: "Self-publishing · thinkers" },
    // Forums & social · sentiment
    "Blackbox Research – Sensing SG": { feed: "https://blackbox.com.sg/feed/", query: "(\"Blackbox Research\" OR \"Sensing SG\") Singapore when:90d", csf: "Forums · sentiment · Singapore lens" },
    "HardwareZone EDMW forum": { feed: "https://forums.hardwarezone.com.sg/forums/eat-drink-man-woman.16/index.rss", csf: "Forums · sentiment · Singapore lens" },
    "Milieu Insight": { query: "(\"Milieu Insight\" OR \"Milieu survey\") (Singapore OR Singaporeans) when:90d", csf: "Forums · sentiment · Singapore lens" },
    "REACH (government feedback unit)": { query: "(site:reach.gov.sg OR (REACH Singapore (poll OR \"listening point\" OR \"public sentiment\" OR dialogue OR feedback))) when:180d", csf: "Forums · sentiment · Singapore lens" },
    "Reddit r/askSingapore": { feed: "https://www.reddit.com/r/askSingapore/top/.rss?t=day", csf: "Forums · sentiment · Singapore lens" },
    "Reddit r/SGExams": { feed: "https://www.reddit.com/r/SGExams/top/.rss?t=day", csf: "Forums · sentiment · Singapore lens" },
    "Reddit r/singapore": { feed: "https://www.reddit.com/r/singapore/top/.rss?t=day", csf: "Forums · sentiment · Singapore lens" },
    "Reddit r/singaporefi": { feed: "https://www.reddit.com/r/singaporefi/top/.rss?t=day", csf: "Forums · sentiment · Singapore lens" },
    "Seedly blog & community": { feed: "https://blog.seedly.sg/feed/", query: "site:seedly.sg (salary OR career OR jobs OR retrenchment OR \"side hustle\" OR CPF) when:90d", csf: "Forums · sentiment · Singapore lens" },
    "SG opinion polls & surveys": { query: "Singapore (Ipsos OR YouGov OR \"Milieu Insight\" OR \"Blackbox Research\" OR \"Institute of Policy Studies\") (survey OR poll) (workers OR jobs OR \"AI\" OR \"work-life\" OR retirement OR skills OR burnout OR \"cost of living\") when:90d", csf: "Forums · sentiment · Singapore lens" },
    "Singapore Expats forum": { feed: "https://forum.singaporeexpats.com/app.php/feed", csf: "Forums · sentiment · Singapore lens" },
    "Straits Times Forum letters": { query: "site:straitstimes.com \"Forum:\" (jobs OR workers OR skills OR AI OR training OR graduates OR employers OR retirees) when:90d", csf: "Forums · sentiment · Singapore lens" },
    // Podcasts & video
    "CNA podcasts: Work It / HotM / Deep Dive": { query: "site:channelnewsasia.com (\"Work It\" OR \"Heart of the Matter\" OR \"Deep Dive\") podcast when:90d", csf: "Podcasts · practitioner voice · Singapore lens" },
    "ST podcasts: Money & Career / Usual Place": { query: "site:straitstimes.com (\"Your Money & Career\" OR \"The Usual Place\" OR \"In Your Opinion\") podcast when:90d", csf: "Podcasts · practitioner voice · Singapore lens" },
    // Different languages
    "8world 8视界新闻 (zh)": { query: "site:8world.com (就业 OR 技能 OR 人工智能 OR 裁员 OR 职场 OR 培训 OR 乐龄) when:90d", lang: "zh", csf: "Different languages · 中文 · Singapore" },
    "Berita Harian – Rencana & letters (ms)": { query: "site:beritaharian.sg (Rencana OR Pendapat OR Forum OR \"Tajuk Rencana\" OR komentar OR \"surat pembaca\") (pekerja OR kerja OR kemahiran OR latihan OR gaji OR \"kecerdasan buatan\" OR belia OR \"warga emas\" OR PMET OR SkillsFuture) when:90d", lang: "ms", csf: "Different languages · Bahasa Melayu" },
    "Berita Harian – usahawan & gig economy (ms)": { query: "site:beritaharian.sg (usahawan OR perniagaan OR PKS OR penjaja OR gerai OR penghantar OR pemandu OR \"ekonomi gig\" OR \"perniagaan dari rumah\" OR halal) when:90d", lang: "ms", csf: "Different languages · Bahasa Melayu" },
    "Berita Harian (ms)": { query: "site:beritaharian.sg (pekerjaan OR kemahiran OR pekerja OR \"kecerdasan buatan\" OR latihan OR SkillsFuture) when:90d", lang: "ms", csf: "Different languages · Bahasa Melayu" },
    "Berita Mediacorp – Malay news (ms)": { feed: "https://berita.mediacorp.sg/api/v1/rss-outbound-feed?_format=xml", query: "site:berita.mediacorp.sg (pekerja OR kerja OR kemahiran OR latihan OR gaji OR \"kecerdasan buatan\" OR SkillsFuture OR belia OR \"warga emas\" OR penjaga) when:90d", lang: "ms", csf: "Different languages · Bahasa Melayu" },
    "Lianhe Zaobao 联合早报 – Singapore news": { query: "site:zaobao.com.sg (就业 OR 技能 OR 人工智能 OR 裁员 OR 职场 OR 培训 OR 技能创前程) when:90d", lang: "zh", csf: "Different languages · 中文 · Singapore" },
    "Mainland Chinese press on Singapore (zh)": { query: "新加坡 (出海 OR 设立总部 OR 区域总部 OR 落地 OR 招聘 OR 家族办公室 OR 移民) (企业 OR 公司 OR 人才) when:180d", lang: "zh", csf: "Different languages · 中文 (mainland edition)" },
    "SCCCI 新加坡中华总商会": { query: "新加坡中华总商会 (中小企业 OR 人力 OR 调查 OR 人工智能 OR 培训) when:180d", lang: "zh", csf: "Different languages · 中文 · Singapore" },
    "Seithi – Mediacorp Tamil news (ta)": { feed: "https://seithi.mediacorp.sg/api/v1/rss-outbound-feed?_format=xml", query: "site:seithi.mediacorp.sg (வேலை OR வேலைவாய்ப்பு OR திறன் OR பயிற்சி OR தொழிலாளர் OR ஊதியம் OR \"செயற்கை நுண்ணறிவு\" OR SkillsFuture) when:90d", lang: "ta", csf: "Different languages · தமிழ்" },
    "SG Chinese press (zh)": { query: "(site:zaobao.com.sg OR site:8world.com OR site:shinmin.sg) (裁员 OR 技能培训 OR 技能创前程 OR 零工 OR 退休年龄 OR 人工智能 OR 雇主 OR 中小企业 OR 职场) when:90d", lang: "zh", csf: "Different languages · 中文 · Singapore" },
    "Shin Min Daily News 新明日报 (zh)": { query: "site:shinmin.sg (工作 OR 就业 OR 裁员 OR 送餐员 OR 小贩 OR 人工智能 OR 雇主) when:90d", lang: "zh", csf: "Different languages · 中文 · Singapore" },
    "Tamil Murasu – jobs, workers & skills (ta)": { query: "site:tamilmurasu.com.sg (வேலை OR வேலைவாய்ப்பு OR திறன் OR பயிற்சி OR தொழிலாளர் OR ஊதியம் OR பணியிடம் OR \"செயற்கை நுண்ணறிவு\" OR SkillsFuture) when:90d", lang: "ta", csf: "Different languages · தமிழ்" },
    "Zaobao 言论 commentary & 交流站 letters": { query: "site:zaobao.com.sg (评论 OR 交流站 OR 社论 OR 言论) (就业 OR 职场 OR 技能 OR 人工智能 OR 教育 OR 年轻人 OR 乐龄) when:90d", lang: "zh", csf: "Different languages · 中文 · Singapore" },
    "36氪 (36Kr)": { feed: "https://36kr.com/feed", query: "site:36kr.com (就业 OR 招聘 OR 裁员 OR 技能 OR AI智能体 OR 出海) when:90d", lang: "zh", csf: "Different languages · 中文 (mainland edition)" },
    "Kompas (Bahasa Indonesia)": { query: "site:kompas.com (\"tenaga kerja\" OR PHK OR \"kecerdasan buatan\" OR keterampilan OR \"pekerja migran\" OR vokasi) when:90d", lang: "id", csf: "Different languages · Bahasa Indonesia" },
    "Malaysian Malay press on SG jobs (ms)": { query: "(site:hmetro.com.my OR site:bharian.com.my OR site:sinarharian.com.my OR site:utusan.com.my) (Singapura) (kerja OR bekerja OR gaji OR pekerja OR RTS OR \"Johor-Singapura\" OR JS-SEZ OR \"tambak Johor\") when:90d", lang: "ms", csf: "Different languages · Bahasa Melayu" },
    "Tamil Nadu press on Singapore jobs (ta)": { query: "(சிங்கப்பூர்) (வேலை OR வேலைவாய்ப்பு OR தொழிலாளர் OR மோசடி OR \"பணி அனுமதி\" OR முகவர் OR செவிலியர்) -site:tamilmurasu.com.sg -site:seithi.mediacorp.sg when:90d", lang: "ta", csf: "Different languages · தமிழ்" },
    "澎湃新闻 (The Paper)": { query: "site:thepaper.cn (就业 OR 职业教育 OR 技能 OR 人工智能 OR 养老 OR 灵活就业) when:90d", lang: "zh", csf: "Different languages · 中文 (mainland edition)" },
    "Futuribles (fr)": { query: "site:futuribles.com when:180d", lang: "fr", csf: "Different languages · français" },
    // Foresight & futures practice
    "Centre for Strategic Futures (CSF)": { query: "(\"Centre for Strategic Futures\" OR site:csf.gov.sg OR (\"Foresight Conference\" Singapore)) (foresight OR \"driving forces\" OR scenarios OR signals OR Spotlight OR Singapore) when:180d", csf: "Foresight practice · signals · Singapore lens" },
    "CTRL+ALT+FUTURE (MDDI signals)": { query: "\"CTRL+ALT+FUTURE\" OR ((\"Smart Nation Strategy Office\" OR \"National AI Group\") (signals OR foresight OR futures OR \"emerging technology\")) when:180d", csf: "Foresight practice · signals · Singapore lens" },
    "NUS Futures Office": { query: "\"NUS Futures Office\" OR (\"Adrian Kuah\" (futures OR foresight OR university)) when:180d", csf: "Foresight practice · signals · Singapore lens" },
    "SUTD LKY Centre for Innovative Cities": { query: "(\"Lee Kuan Yew Centre for Innovative Cities\" OR site:lkycic.sutd.edu.sg OR site:sutd.edu.sg) (future OR ageing OR workers OR AI) when:180d", csf: "Foresight practice · signals · Singapore lens" },
    "Asia Pacific Futures Network (APFN)": { query: "\"Asia Pacific Futures Network\" OR (APFN foresight) when:180d", csf: "Foresight practice · signals · Asia lens" },
    "Futures Centre (Forum for the Future)": { query: "(\"Forum for the Future\" OR \"Futures Centre\") (signals OR \"signals of change\" OR Singapore OR Asia OR \"future of work\") when:180d", csf: "Foresight practice · signals · Asia lens · STEEPLE: environmental" },
    "Institute for the Future (IFTF)": { query: "(site:iftf.org OR \"Institute for the Future\") (work OR skills OR signals OR forecast OR \"future of work\" OR learning) when:180d", csf: "Foresight practice · signals" },
    "Policy Horizons Canada": { query: "(\"Policy Horizons Canada\" OR \"Policy Horizons\" OR site:horizons.service.canada.ca) (disruptions OR foresight OR \"weak signals\" OR \"future of work\" OR future) when:180d", csf: "Foresight practice · signals" },
    "Sitra (Megatrends & weak signals)": { feed: "https://www.sitra.fi/en/feed/", query: "site:sitra.fi (megatrends OR \"weak signals\" OR future OR work OR skills OR \"lifelong learning\") when:180d", csf: "Foresight practice · signals" },
    "SOIF & Next Gen Foresight Practitioners": { query: "site:soif.org.uk OR \"School of International Futures\" OR \"Next Generation Foresight Practitioners\" when:180d", csf: "Foresight practice · signals" },
    "Springwise (innovation signals)": { feed: "https://www.springwise.com/feed/", query: "site:springwise.com (work OR skills OR training OR AI OR robots OR education) when:90d", csf: "Foresight practice · signals" },
    "The Long Now Foundation — Ideas & Talks": { query: "(site:longnow.org OR \"Long Now Foundation\") when:180d", csf: "Foresight practice · signals" },
    "UNDP (Asia-Pacific & Singapore Centre)": { query: "site:undp.org (Singapore OR \"Asia-Pacific\" OR \"Asia and the Pacific\") (foresight OR \"future of work\" OR skills OR digital OR AI OR \"human development\") when:180d", csf: "Foresight practice · signals" },
    // Labour-market data & statistics
    "CPF Board statistics & annual report": { query: "(\"CPF Board\" OR \"Central Provident Fund\") (statistics OR \"annual report\" OR \"CPF Trends\" OR contributions OR \"active members\" OR \"retirement sum\" OR \"platform workers\" OR withdrawals) when:180d", csf: "Labour-market data · Singapore lens" },
    "Graduate Employment Surveys (AU/Poly/ITE)": { query: "\"Graduate Employment Survey\" (Singapore OR NUS OR NTU OR SMU OR SIT OR SUSS OR SUTD OR polytechnic OR ITE) (employment OR salary OR \"full-time\" OR \"permanent\") when:180d", csf: "Labour-market data · Singapore lens" },
    "Indeed Hiring Lab – Singapore & APAC": { query: "(\"Indeed Hiring Lab\" OR site:hiringlab.org) Singapore (\"job postings\" OR hiring OR wages OR AI OR \"postings index\") when:180d", csf: "Labour-market data · Singapore lens" },
    "JobStreet/Jobsdb by SEEK – SG hiring data": { query: "(JobStreet OR Jobsdb OR \"SEEK Asia\") Singapore (hiring OR salary OR \"job ads\" OR \"job postings\" OR \"Decoding Global Talent\" OR \"Compensation and Benefits\" OR \"Job Outlook\") when:180d", csf: "Labour-market data · Singapore lens" },
    "MAS Macroeconomic Review – labour & wages": { query: "\"Macroeconomic Review\" (MAS OR \"Monetary Authority of Singapore\") (labour OR wages OR employment OR unemployment OR productivity OR AI OR \"foreign workers\") when:180d", csf: "Labour-market data · Singapore lens" },
    "MOM Manpower Research & Statistics (MRSD)": { query: "(site:stats.mom.gov.sg OR site:mom.gov.sg) (\"labour market\" OR retrenchment OR \"job vacancies\" OR \"working conditions\" OR \"labour force\" OR \"wage\") when:180d", csf: "Labour-market data · Singapore lens" },
    "SCCB Business Optimism Index": { query: "\"Business Optimism Index\" Singapore (SCCB OR \"Singapore Commercial Credit Bureau\" OR employment OR hiring OR \"net balance\") when:120d", csf: "Labour-market data · Singapore lens" },
    "SCCCI Annual Business Survey (en)": { query: "(SCCCI OR \"Singapore Chinese Chamber of Commerce\") (\"business survey\" OR survey OR manpower OR hiring OR wages OR \"foreign workers\" OR AI OR digitalisation) when:180d", csf: "Labour-market data · Singapore lens" },
    "SG hiring, wages & vacancies data (catch-all)": { query: "Singapore (\"job postings\" OR \"job vacancies\" OR \"hiring intentions\" OR \"median salary\" OR \"employment rate\" OR \"wage growth\" OR \"salary increments\" OR \"net employment outlook\") (survey OR data OR index OR report) when:60d", csf: "Labour-market data · Singapore lens" },
    "SingStat latest releases": { query: "site:singstat.gov.sg when:180d", csf: "Labour-market data · Singapore lens" },
    "SkillsFuture Credit & training take-up": { query: "Singapore (\"SkillsFuture Credit\" OR \"SkillsFuture Level-Up\" OR \"training participation rate\" OR \"NTUC LearningHub\" OR \"Mid-Career Enhanced Subsidy\") (utilisation OR uptake OR \"taken up\" OR claims OR survey OR \"signed up\" OR \"training allowance\") when:180d", csf: "Labour-market data · Singapore lens" },
    "SSG Jobs-Skills Insights (house)": { query: "(\"Skills Demand for the Future Economy\" OR \"Jobs-Skills Insights\" OR \"Jobs-Skills Quarterly\" OR \"priority skills\" OR \"Jobs Transformation Map\") Singapore when:180d", csf: "Labour-market data · Singapore lens" },
    "Alt-data labour analytics (Revelio et al.)": { query: "(\"Revelio Labs\" OR Lightcast OR \"Glassdoor Economic Research\" OR \"ADP Research\") (jobs OR hiring OR skills OR AI OR wages OR \"job postings\" OR \"entry-level\") when:90d", csf: "Labour-market data" },
    "Burning Glass Institute": { query: "(\"Burning Glass Institute\" OR site:burningglassinstitute.org) (skills OR degree OR hiring OR AI OR jobs OR \"job postings\") when:180d", csf: "Labour-market data" },
    "LinkedIn Economic Graph (incl. Singapore)": { query: "LinkedIn (\"Economic Graph\" OR \"Work Change\" OR \"Skills on the Rise\" OR \"Jobs on the Rise\" OR \"Workforce Report\" OR \"AI literacy\") (Singapore OR APAC OR global) when:180d", csf: "Labour-market data" },
  };

  // Persona-tuned source packs: matched against the saved persona text by
  // profile.js, which offers one-click adds in the profile panel (up to 10 chips
  // across all matching packs). Every source named here must exist in FEEDS; the
  // signal budget below keeps the total prompt under the LLM gateway's ceiling
  // regardless of how many sources a tester adds.
  window.__FI_PACKS__ = [
    { name: "Singapore pulse", match: /singapore|swda|skillsfuture|heartland|local/i,
      sources: ["Straits Times Forum letters", "SG opinion polls & surveys", "Reddit r/singapore", "IPS Commons", "Ministry PQ replies", "Platform & gig work after the PWA"] },
    { name: "Workforce core", match: /skills|workforce|jobs|training|manpower|employ|labour|labor/i,
      sources: ["SNEF & SBF employer surveys", "MOM Manpower Research & Statistics (MRSD)", "Human Resources Online", "Institute for Adult Learning research", "Retrenchments & hiring freezes", "SMU Research & Resilient Workforces Institute"] },
    { name: "Retail & F&B", match: /retail|f&b|food service|restaurant|hospitality|hawker/i,
      sources: ["Restaurant Dive", "Inside Retail Asia", "Singapore retail & F&B jobs", "Hawker & F&B automation", "Shin Min Daily News 新明日报 (zh)", "Trade associations: RAS, SRA & SLA"] },
    { name: "Careers & hiring", match: /career (coach|service|health)|careersfinder|job.?seek|hiring|placement|mid-career|recruit/i,
      sources: ["Hiring practice signals", "Indeed Hiring Lab", "HR Dive", "Robert Walters & Hays – Singapore job market", "Reddit r/askSingapore", "Youth, graduates & NEET sentiment"] },
    { name: "Green economy", match: /green|climate|sustainab|energy transition|carbon|environment/i,
      sources: ["Carbon Brief", "IEA (energy & jobs)", "Eco-Business", "Green skills & Skills Framework watch (SG)", "NCCS, Green Plan & MSE/NEA/EMA releases", "Climate Home News"] },
    { name: "Care economy", match: /health|care work|nurs|eldercare|ageing|aging|community care|longevity/i,
      sources: ["Singapore care workforce", "The Conversation", "MOH, MSF & AIC care-manpower releases", "SMU ROSA / Singapore Life Panel", "Care-sector professional bodies: SNA & SMA", "Mature workers, re-employment & CPF"] },
    { name: "Digital government", match: /smart nation|digital government|public sector|public service|imda|civil service|govtech/i,
      sources: ["IMDA & Smart Nation", "GovTech TechNews", "AI in the public service & governance", "Open Government Products (Substack)", "PDPC & AI Verify Foundation", "OECD.AI Policy Observatory"] },
    { name: "Education & pipeline", match: /education|student|polytechnic|\bite\b|universit|graduate|youth|school|curricul/i,
      sources: ["MOE newsroom & parliamentary replies", "Tertiary intake & curriculum shifts", "Graduate Employment Surveys (AU/Poly/ITE)", "Reddit r/SGExams", "NIE SingTeach & NTU research news", "UNESCO (Futures of Education, AI in ed)"] },
    { name: "Different languages", match: /chinese|mandarin|malay|tamil|vernacular|bilingual|language|zaobao|berita|heartland/i,
      sources: ["Lianhe Zaobao 联合早报 – Singapore news", "8world 8视界新闻 (zh)", "Berita Harian (ms)", "Berita Mediacorp – Malay news (ms)", "Tamil Murasu – jobs, workers & skills (ta)", "Seithi – Mediacorp Tamil news (ta)", "36氪 (36Kr)"] },
    { name: "Legal & ethics", match: /legal|\blaw\b|ethic|fairness|governance|privacy|discriminat|compliance|regulat/i,
      sources: ["Workplace fairness & discrimination", "Tripartite Alliance (TAFEP / TADM)", "PDPC & AI Verify Foundation", "Singapore Law Watch (headlines)", "Ada Lovelace Institute", "AlgorithmWatch", "Big Data & Society"] },
    { name: "Regional & cross-border", match: /asean|regional|malaysia|indonesia|johor|\basia\b|china|india|vietnam|philippin|cross-border/i,
      sources: ["ISEAS Fulcrum", "Malaysia press & JS-SEZ", "JS-SEZ & cross-border labour", "East Asia Forum", "Nikkei Asia", "Sixth Tone", "Asian Development Blog (ADB & ADBI)", "Rappler"] },
    { name: "Strategy & foresight", match: /foresight|futures|strategy|horizon|environmental scan|scenario/i,
      sources: ["World Economic Forum", "arXiv (Economics)", "Policy Horizons Canada", "Sitra (Megatrends & weak signals)", "Springwise (innovation signals)", "Institute for the Future (IFTF)", "Journal of Futures Studies", "Centre for Strategic Futures (CSF)"] },
    { name: "Handbook exemplars", match: /handbook|thinking about tomorrow|\bcsf\b|centre for strategic futures|exemplar|case stud/i,
      sources: ["Centre for Strategic Futures (CSF)", "CTRL+ALT+FUTURE (MDDI signals)", "CSC ETHOS journal & CAST", "IPS (LKYSPP) reports, surveys & Prism", "WEF Strategic Intelligence & Global Risks", "UK GO-Science & MOD foresight (gov.uk)", "Policy Horizons Canada", "UNDP Asia-Pacific futures & signals"] },
  ];

  // One-click add for profile.js: drives the app's own add-source form so the
  // new card renders exactly like a hand-added one.
  window.__FI_ADD_SOURCE__ = function (name) {
    var input = document.getElementById("srcName");
    var form = document.getElementById("srcAdd");
    if (!input || !form || !name) return false;
    var existing = Array.prototype.slice.call(document.querySelectorAll("#srcList .src-name"))
      .map(function (el) { return el.textContent.replace(/↗/g, "").trim(); });
    if (existing.indexOf(name) !== -1) return false;
    input.value = name;
    if (form.requestSubmit) form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return true;
  };

  // Per-tester sources: whatever cards sit beside the defaults are saved to the
  // profile, so the engine ingests and triages them daily and they build the
  // same corroboration history as the defaults. Debounced on card changes.
  var syncTimer = null, lastSync = null;
  function syncUserSources() {
    if (!window.__FI_USER__) return;
    var list = scannedNames().filter(function (n) { return DEFAULT_NAMES.indexOf(n) === -1; }).map(function (n) {
      var s = specFor(n);
      return { name: n, feed: s.feed || "", query: s.query || "", lang: s.lang || "en" };
    });
    var key = JSON.stringify(list);
    if (key === lastSync) return;
    lastSync = key;
    fetch("/api/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sources: list }) }).catch(function () {});
  }
  window.__FI_SYNC_SOURCES__ = function () { clearTimeout(syncTimer); syncTimer = setTimeout(syncUserSources, 1500); };

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
      // Mechanical confidence check (CSF: High needs two or more UNCONNECTED
      // sources). The model is asked to follow this rule; here it is enforced:
      // a High rating whose cited signals all trace to one publisher is
      // downgraded on the card and in the briefing, and every card shows how
      // many unconnected publishers back it. Signals from the issue ledger also
      // carry their history (tracked since, signals, cycles).
      var checks = { trends: 0, high: 0, highHeld: 0, adjusted: 0 };
      (trends || []).forEach(function (t, i) {
        var refs = ((t && t.sources) || []).map(refOf).filter(Boolean);
        if (!refs.length) return;
        var pubs = pubsOf(t);
        var iss = null;
        refs.forEach(function (r) { if (!iss && REFISSUE[r]) iss = REFISSUE[r]; });
        var k = Math.max(pubs.length, iss ? iss.unconnected : 0);
        checks.trends++;
        var conf = ["High", "Medium", "Low"].indexOf(t.confidence) >= 0 ? t.confidence : "Low";
        var adjusted = false;
        if (conf === "High") {
          checks.high++;
          if (k < 2) { t.confidence = refs.length >= 2 ? "Medium" : "Low"; adjusted = true; checks.adjusted++; }
          else checks.highHeld++;
        }
        var card = document.querySelector('#columns article.card[data-idx="' + i + '"]');
        if (!card) return;
        var chip = card.querySelector(".chip");
        if (adjusted && chip) { chip.className = "chip " + t.confidence; chip.innerHTML = '<span class="cdot"></span>' + t.confidence + " confidence"; }
        var top = card.querySelector(".card-top");
        if (top) {
          var c = document.createElement("span");
          c.className = "fi-corro " + (k >= 2 ? "ok" : "warn");
          c.title = k >= 2 ? "Cited signals come from " + k + " unconnected publishers: " + (pubs.length ? pubs.join(", ") : (iss ? iss.publishers.join(", ") : ""))
                           : "Every cited signal traces to one publisher — the CSF method caps confidence until a second, unconnected source reports it.";
          c.textContent = k >= 2 ? "✓ " + k + " unconnected publishers" : (adjusted ? "⚠ single publisher · confidence adjusted" : "single publisher");
          top.appendChild(c);
        }
        if (iss) {
          var ml = card.querySelector(".metaline");
          if (!ml) { ml = document.createElement("div"); ml.className = "metaline"; var h3 = card.querySelector(".ctitle"); if (h3) h3.insertAdjacentElement("afterend", ml); }
          if (ml) {
            var b = document.createElement("span");
            b.className = "mbadge fi-issue";
            b.title = "Issue ledger: " + iss.title + (iss.summary ? " — " + iss.summary : "");
            b.textContent = "Tracked since " + shortDate(iss.firstSeen) + " · " + iss.signals + " signal" + (iss.signals === 1 ? "" : "s") + " · " + iss.cycles + " cycle" + (iss.cycles === 1 ? "" : "s");
            ml.appendChild(b);
          }
        }
      });
      fetch("/api/scorecard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sources: present, cited: cited, checks: checks })
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
      // One row per source seen by the scorecard OR the ledger's role counts
      // (a source can be first on an issue before it has ever been scanned).
      var roles = d.roles || {}, names = {};
      Object.keys(d.scorecard || {}).forEach(function (k) { names[k] = true; });
      Object.keys(roles).forEach(function (k) { names[k] = true; });
      var sc = Object.keys(names).map(function (k) { return { name: k, s: (d.scorecard || {})[k] || {}, r: roles[k] || {} }; })
        .sort(function (a, b) { return ((b.s.cited || 0) - (a.s.cited || 0)) || ((b.r.firstOn || 0) - (a.r.firstOn || 0)); });
      var html = '<h3>Engine audit</h3>';
      html += '<p class="fi-sub">Source scorecard — how often each source\'s articles are cited in scans.</p>';
      html += sc.length
        ? '<table class="fi-table">' + sc.map(function (r) {
            // Weeding hint (CSF: prune sources that never earn citations) — the
            // machine nominates, the analyst decides what to swap in.
            var weed = (r.s.scans || 0) >= 8 && !(r.s.cited || 0)
              ? ' <span class="fi-weed">never cited — consider swapping for a same-type source</span>' : '';
            // Measured role from the ledger: first to carry a development that
            // others later confirmed, or the one confirming it.
            var role = (r.r.firstOn || r.r.confirmedOn || r.r.solo)
              ? ' · first on ' + (r.r.firstOn || 0) + ', confirmed ' + (r.r.confirmedOn || 0) + (r.r.solo ? ', ' + r.r.solo + ' unconfirmed' : '') : '';
            return '<tr><td>' + esc(r.name) + '</td><td>' + (r.s.cited || 0) + ' cited / ' + (r.s.scans || 0) + ' scans' + role + weed + '</td></tr>';
          }).join('') + '</table>'
        : '<p class="fi-sub">No scans recorded yet this deployment.</p>';
      var ck = d.checks || {};
      html += '<p class="fi-sub" style="margin-top:14px">Confidence check — High ratings held against the two-unconnected-publishers rule: <b>' + (ck.highHeld || 0) + '</b> held, <b>' + (ck.adjusted || 0) + '</b> adjusted down, across ' + (ck.trends || 0) + ' trend cards.</p>';
      if (d.rotate && d.rotate.length) html += '<p class="fi-sub">Rotation candidates (scanned 3+ times, never cited): ' + d.rotate.map(esc).join(" · ") + '.</p>';
      html += '<p class="fi-sub" style="margin-top:14px">Issue ledger — developments the engine has matched across sources and cycles (unconnected publishers first).</p>';
      html += (d.issues && d.issues.length)
        ? '<ul class="fi-issues">' + d.issues.map(function (x) {
            return '<li><b>' + esc(x.title) + '</b> — ' + x.unconnected + ' unconnected publisher' + (x.unconnected === 1 ? '' : 's') + ' (' + esc((x.publishers || []).slice(0, 5).join(', ')) + '), ' + x.signals + ' signal' + (x.signals === 1 ? '' : 's') + ', ' + x.cycles + ' cycle' + (x.cycles === 1 ? '' : 's') + ', since ' + esc(shortDate(x.firstSeen)) +
              (x.summary ? '<br><span class="fi-sub">' + esc(x.summary) + '</span>' : '') +
              (x.links && x.links.length ? '<br>' + x.links.map(function (l) { return l.link ? '<a href="' + esc(l.link) + '" target="_blank" rel="noopener">' + esc(l.source) + '</a>' : esc(l.source); }).join(' · ') : '') + '</li>';
          }).join('') + '</ul>'
        : '<p class="fi-sub">No issues yet — the ledger fills as daily pulls are clustered.</p>';
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
      ".fi-corro{border-radius:9px;padding:2px 8px;font-size:11px;white-space:nowrap;cursor:help;margin-left:6px;}" +
      ".fi-corro.ok{color:#2f6b3a;background:#e6f1e8;border:1px solid #c5dccb;}" +
      ".fi-corro.warn{color:#a04b3c;background:#f7e9e4;border:1px solid #e5c8bc;}" +
      ".fi-issue{cursor:help;}" +
      ".fi-issues{font-size:12px;color:#2d3a31;padding-left:18px;max-height:260px;overflow-y:auto;margin:6px 0;}" +
      ".fi-issues li{margin:5px 0;} .fi-issues a{color:#3e5c46;}" +
      ".fi-coverage{background:#faf3e3;border:1px solid #e6d3ac;border-radius:10px;padding:10px 14px;font-size:13px;color:#6b5a33;margin:10px 0;}" +
      ".fi-model{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#5c6b5f;margin-left:auto;}" +
      ".fi-model select{border:1px solid #c9cfba;border-radius:8px;padding:5px 8px;font:inherit;font-size:12.5px;background:#fff;color:#2d3a31;cursor:pointer;max-width:250px;}" +
      ".fi-weed{color:#a04b3c;font-size:11.5px;}" +
      ".fi-steeple{font-size:11.5px;color:#5c6b5f;margin-top:3px;cursor:default;}" +
      ".fi-steeple .fi-st0{color:#a04b3c;font-weight:600;}";
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
      var storeMap = {}, lastPull = 0, issues = [];
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
        issues = sdata.issues || [];
        if (Array.isArray(sdata.defaults) && sdata.defaults.length) DEFAULT_NAMES = sdata.defaults;
        (sdata.sources || []).forEach(function (s) { if (s.items && s.items.length) storeMap[s.name] = s.items; });
        renderSteeple(sdata.domains || {});
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

      var pulled = 0, perSource = [];
      function codeFor(it, name) {
        if (!it.link) return null;
        var c = LINKCODE[it.link];
        if (!c) {
          c = "L" + (++linkSeq);
          LINKCODE[it.link] = c; LINKS[c] = it.link; REFSRC[c] = name;
          REFPUB[c] = it.publisher || pubOf(it.link, name);
        }
        return c;
      }
      function blockFor(it, name, code) {
        var detail = it.body || it.detail || it.summary;
        // CSF corroboration: recurring signals carry their track record so
        // the model can weigh multi-cycle evidence.
        var seen = it.timesSeen > 1 ? " (seen " + it.timesSeen + "× since " + shortDate(it.firstSeen) + ")" : "";
        var block = "[" + name + "] " + it.title + (detail ? " — " + detail : "") + seen + (code ? " [" + code + "]" : "");
        if (code) REFTEXT[code] = block;
        return block;
      }
      rows.forEach(function (row, i) {
        var name = cardName(row);
        var ta = row.querySelector(".src-text");
        var live = results[String(i)];
        var items = storeMap[name] || (live && live.items) || null;
        if (ta && items && items.length) {
          var blocks = items.map(function (it) { return { text: blockFor(it, name, codeFor(it, name)), link: it.link || "" }; });
          ta.value = blocks.map(function (b) { return b.text; }).join("\n\n");
          ta.dispatchEvent(new Event("input", { bubbles: true })); // update app state + item count
          pulled += items.length;
          perSource.push({ name: name, blocks: blocks });
        } else if (ta && ta.value.trim()) {
          perSource.push({ name: name, blocks: ta.value.trim().split("\n\n").map(function (x) { return { text: x, link: "" }; }) });
        }
      });

      // Issue blocks first: each is a development the engine has already matched
      // across sources and cycles, with its evidence beneath — this is where
      // corroborated (High-confidence) trends come from. Then the per-source
      // singletons that no issue carries.
      var issueBlocks = [], inIssue = {};
      issues.slice(0, 8).forEach(function (iss) {
        if (!iss.evidence || !iss.evidence.length) return;
        var ev = iss.evidence.map(function (it) {
          var code = codeFor(it, it.source);
          if (code) REFISSUE[code] = iss;
          if (it.link) inIssue[it.link] = true;
          return "  " + blockFor(it, it.source, code);
        });
        var header = "[ISSUE: " + iss.title + "] — " + iss.unconnected + " unconnected publisher" + (iss.unconnected === 1 ? "" : "s") +
          " (" + (iss.publishers || []).slice(0, 4).join(" · ") + "), " + iss.signals + " signal" + (iss.signals === 1 ? "" : "s") +
          ", tracked since " + shortDate(iss.firstSeen) + " (" + iss.cycles + " cycle" + (iss.cycles === 1 ? "" : "s") + ")" +
          (iss.summary ? "\n  " + iss.summary : "");
        issueBlocks.push({ header: header, ev: ev });
      });
      var left = perSource.map(function (s) {
        return s.blocks.filter(function (b) { return !b.link || !inIssue[b.link]; }).map(function (b) { return b.text; });
      }).filter(function (b) { return b.length; });

      // Retrieved evidence per tracked topic (server /api/retrieve: semantic +
      // keyword search over the engine's memory): the passage of each article
      // that best matches the topic, citable like any signal. Articles already
      // in the scan input are pointed to by code rather than repeated, and a
      // topic with no support is stated as such (CSF: absence is a signal).
      // Budgeted ahead of the trim below, whole topics only.
      var topicBlock = "";
      if (retrieved && retrieved.topics && retrieved.topics.length) {
        var tl = ["EVIDENCE RETRIEVED FOR TRACKED TOPICS (semantic + keyword search over the engine's memory):"];
        var tlLen = tl[0].length;
        retrieved.topics.forEach(function (t) {
          var lines = [];
          if (!t.hits || !t.hits.length) {
            lines.push("TOPIC " + t.topic + ": no supporting signal in the engine's memory this cycle \u2014 the absence may itself be a signal.");
          } else {
            lines.push("TOPIC " + t.topic + ":");
            t.hits.forEach(function (h) {
              var had = h.link && LINKCODE[h.link];
              var code = codeFor(h, h.source);
              if (had) { lines.push("  \u2022 see [" + code + "] " + h.title.slice(0, 100)); return; }
              var line = "  \u2022 [" + h.source + "] " + h.title + (h.passage ? " \u2014 " + h.passage : "") + (code ? " [" + code + "]" : "");
              if (code) REFTEXT[code] = line;
              lines.push(line);
            });
          }
          var chunk = lines.join("\n");
          if (tlLen + chunk.length > 2600) return;
          tl.push(chunk);
          tlLen += chunk.length + 1;
        });
        if (tl.length > 1) topicBlock = tl.join("\n") + "\n\n";
      }

      // Signal budget: input + generation must finish inside the GovTech
      // gateway's hard 60s proxy timeout (gpt-5.5 latency is load-dependent:
      // ~39s quiet, >60s congested). Cards keep full text; only the scan input
      // is cut. Trim order: oldest singletons from the longest source (floor 1
      // per source), then issue evidence (floor 2 per issue), then the
      // lowest-ranked issues.
      var BUDGET = 10000 - topicBlock.length;
      function render() {
        var parts = issueBlocks.map(function (ib) { return ib.header + "\n" + ib.ev.join("\n\n"); });
        left.forEach(function (b) { parts.push(b.join("\n\n")); });
        return parts.join("\n\n");
      }
      var guard = 0;
      while (render().length > BUDGET && guard++ < 600) {
        var bi = -1;
        for (var li = 0; li < left.length; li++) if (left[li].length > 1 && (bi < 0 || left[li].length > left[bi].length)) bi = li;
        if (bi >= 0) { left[bi].pop(); continue; }
        var ii = -1;
        for (var k2 = issueBlocks.length - 1; k2 >= 0; k2--) if (issueBlocks[k2].ev.length > 2) { ii = k2; break; }
        if (ii >= 0) { issueBlocks[ii].ev.pop(); continue; }
        if (issueBlocks.length > 1) { issueBlocks.pop(); continue; }
        break;
      }
      sig.value = topicBlock + render();
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

    var srcList = document.getElementById("srcList");
    if (srcList && window.MutationObserver) {
      new MutationObserver(function () { if (window.__FI_SYNC_SOURCES__) window.__FI_SYNC_SOURCES__(); }).observe(srcList, { childList: true });
    }

    // Automate the cadence: read the engine's memory on page load, so the
    // sources are populated without any clicks.
    updateCadence(null);
    if (!sig.value.trim()) setTimeout(function () { freshBtn.click(); }, 600);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
