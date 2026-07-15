(function () {
  "use strict";

  const DIMENSIONS = [
    { key: "Future of Work",       v: "work" },
    { key: "Future of Tech",       v: "tech" },
    { key: "Future of Learning",   v: "learning" },
    { key: "Future of Government", v: "gov" }
  ];

  const DEFAULT_CONTEXT =
"SWDA/TED \u2014 Skills & Workforce Development Agency, Training & Enterprise Division (formed from the 2025 SSG\u2013WSG merger). Mandate: keep Singapore's workforce competitive by funding and quality-assuring continuing education and training (CET), maintaining the national Skills Framework, running Jobs-Skills Integrators across sectors, and stewarding SkillsFuture credit and mid-career support.\n\nPriorities this cycle: AI and digital fluency across all sectors; faster skills-to-jobs matching; and lifting CET take-up among mature and lower-wage workers.\n\nJudge each external signal by whether it changes (a) what skills employers will demand, (b) how training is delivered or credentialed, or (c) how a public skills agency should operate. Ignore vendor product launches with no workforce or skills implication.";

  const WATCHED_DEFAULT = [
    { id: "analyst", name: "McKinsey Global Institute", kind: "Industry analysts", method: "Web page", url: "https://www.mckinsey.com/mgi", lastItem: "12 Jun 2026", excerpts: [
      "[McKinsey Global Institute] Agentic AI is moving from pilots to deployment in white-collar workflows, with software agents carrying out multi-step tasks rather than just answering questions \u2014 expected to reshape how routine knowledge work is staffed.",
      "[McKinsey Global Institute] Employers now report the fastest-growing skill need is working alongside AI \u2014 directing, checking and correcting model output \u2014 over producing the work unaided.",
      "[McKinsey Global Institute] Early adopters say the binding constraint on scaling agents is not the technology but a shortage of staff who can scope, supervise and audit what the agents do."
    ]},
    { id: "editorial", name: "MIT Technology Review", kind: "Trade press", method: "RSS feed", url: "https://www.technologyreview.com/", lastItem: "18 Jun 2026", excerpts: [
      "[MIT Technology Review] Smaller, cheaper, more efficient models and on-device AI are maturing fast, lowering the cost of running AI and reducing dependence on a few large providers; some governments are investing in sovereign AI compute.",
      "[MIT Technology Review] Models that handle text, image, audio and video together are becoming standard, widening where AI applies across digital services."
    ]},
    { id: "journals", name: "arXiv (Computers & Society)", kind: "Journals", method: "RSS feed", url: "https://arxiv.org/list/cs.CY/recent", excerpts: [] },
    { id: "fringe", name: "Ethan Mollick", kind: "Self-publishing", method: "RSS feed", url: "https://www.oneusefulthing.org/", excerpts: [] },
    { id: "sgpolicy", name: "Singapore skills policy", kind: "Government & policy", method: "RSS feed", url: "https://www.mom.gov.sg/", excerpts: [] },
    { id: "zh", name: "Chinese tech & jobs press", kind: "Different languages", method: "RSS feed", url: "https://news.google.com/", excerpts: [] },
    { id: "oecd", name: "OECD Education & Skills", kind: "Think tanks & gov", method: "RSS feed", url: "https://www.oecd.org/education/", excerpts: [] },
    { id: "sgnews", name: "Channel NewsAsia", kind: "Trade press", method: "RSS feed", url: "https://www.channelnewsasia.com/", excerpts: [] },
    
  ];

  let watched = WATCHED_DEFAULT.map((s) => ({ id: s.id, name: s.name, kind: s.kind, method: s.method, url: s.url, excerpts: s.excerpts.slice() }));

  const $ = (s) => document.querySelector(s);
  const ctxEl = $("#context");
  const sigEl = $("#signals");
  const scanBtn = $("#scanBtn");
  const sampleBtn = $("#sampleBtn");
  const clearBtn = $("#clearBtn");
  const srcListEl = $("#srcList");
  const srcAddForm = $("#srcAdd");
  const srcNameInput = $("#srcName");
  const srcKindSel = $("#srcKind");
  const briefSection = $("#briefSection");
  const briefSub = $("#briefSub");
  const draftBtn = $("#draftBtn");
  const copyBtn = $("#copyBtn");
  const emailWrap = $("#emailWrap");
  const emailEl = $("#email");
  const errEl = $("#err");
  const columnsEl = $("#columns");
  const pills = Array.from(document.querySelectorAll(".pill"));
  const outMeta = $("#outMeta");
  const outTitle = $("#outTitle");
  const outTitleText = $("#outTitleText");
  const demoBadge = $("#demoBadge");
  const demoChk = $("#demoChk");

  function setTitle(t) {
    outTitleText.textContent = t;
    demoBadge.hidden = !lastIsDemo;
  }

  ctxEl.value = DEFAULT_CONTEXT;

  let running = false;
  let drafting = false;
  let lastTrends = [];
  let lastEmailText = "";

  function aiAvailable() {
    return typeof window !== "undefined" && window.claude && typeof window.claude.complete === "function";
  }
  const OFFLINE_MSG =
    "The AI engine isn't reachable right now \u2014 check your connection and try again in a moment. Everything else on this page still works.";

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let demoMode = false;
  let lastIsDemo = false;

  // Canned results for demo / offline mode — illustrative, matched to the sample pull.
  const DEMO_TRENDS = [
    {
      title: "Agentic AI moving into white-collar workflows",
      dimension: "Future of Work", confidence: "High",
      trajectory: "Rising", horizon: "1\u20133 yrs", firstSeen: "Feb 2026",
      what: "Software agents are starting to carry out multi-step tasks on their own, not just answer questions, and are moving from pilots into real deployment.",
      why: "If routine knowledge work is restructured around agents, the skills employers ask for \u2014 and the training SWDA/TED funds \u2014 shift toward scoping, oversight and validating model output rather than producing the work unaided.",
      options: ["Map which sectors and roles are most exposed to agent-based automation", "Check whether existing courses cover scoping, supervising and auditing AI agents"],
      sources: ["McKinsey Global Institute", "Gartner"],
      evidence: [
        { source: "McKinsey Global Institute", quote: "Agentic AI is moving from pilots to deployment in white-collar workflows, with software agents carrying out multi-step tasks rather than just answering questions." },
        { source: "McKinsey Global Institute", quote: "The binding constraint on scaling agents is not the technology but a shortage of staff who can scope, supervise and audit what the agents do." },
        { source: "Gartner", quote: "A meaningful share of enterprise software will ship with embedded AI agents within two years, shifting many roles from 'doing the task' to 'configuring and checking the agent that does it'." }
      ]
    },
    {
      title: "AI literacy and oversight as a baseline skill",
      dimension: "Future of Work", confidence: "High",
      trajectory: "Rising", horizon: "0\u20131 yr", firstSeen: "Jan 2026",
      what: "Employers increasingly expect everyday roles \u2014 not just technical ones \u2014 to be able to direct, check and correct AI output, treating AI literacy as a basic competency.",
      why: "This points to demand for broad, cross-sector AI-literacy provision rather than niche technical courses, which bears directly on what SWDA/TED prioritises and funds.",
      options: ["Assess whether a common AI-literacy module belongs across the Skills Framework", "Watch how employers begin screening for AI oversight in non-technical hiring"],
      sources: ["Gartner", "World Economic Forum"],
      evidence: [
        { source: "Gartner", quote: "Names AI literacy and prompt/agent oversight as emerging baseline competencies it expects employers to screen for across non-technical roles, not just engineering." },
        { source: "World Economic Forum", quote: "Its latest Future of Jobs analysis flags analytical thinking, resilience and AI literacy as the skills employers expect to rise most this decade." }
      ]
    },
    {
      title: "Cheaper, smaller and on-device models",
      dimension: "Future of Tech", confidence: "High",
      trajectory: "Rising", horizon: "1\u20133 yrs", firstSeen: "Nov 2025",
      what: "Smaller, more efficient models that can run on local devices are maturing quickly, lowering the cost of using AI and reducing reliance on a handful of large providers.",
      why: "Lower-cost, locally run AI changes what is affordable to build in training and workforce services, and connects to the move toward sovereign public-sector compute.",
      options: ["Track the cost trajectory of running models locally for service delivery", "Note skills implications if more AI work shifts in-house rather than to large vendors"],
      sources: ["MIT Technology Review", "IMDA / Smart Nation Singapore"],
      evidence: [
        { source: "MIT Technology Review", quote: "Smaller, cheaper, more efficient models and on-device AI are maturing fast, lowering the cost of running AI and reducing dependence on a few large providers." },
        { source: "IMDA / Smart Nation Singapore", quote: "Expanding sovereign compute access for the public sector, with guidance that agencies build in-house capability to deploy and oversee AI rather than rely solely on external vendors." }
      ]
    },
    {
      title: "Multimodal AI becoming standard",
      dimension: "Future of Tech", confidence: "Medium",
      trajectory: "Steady", horizon: "0\u20131 yr", firstSeen: "Mar 2026",
      what: "Models that handle text, images, audio and video together are becoming the norm, widening where AI can be applied across digital services.",
      why: "As multimodal tools spread, the range of tasks and roles touched by AI broadens, which may widen the set of skills SWDA/TED needs to keep training current.",
      options: ["Scan which sectors could adopt multimodal tools first", "Watch for new skill gaps as services move beyond text-only AI"],
      sources: ["MIT Technology Review"],
      evidence: [
        { source: "MIT Technology Review", quote: "Models that handle text, image, audio and video together are becoming standard, widening where AI applies across digital services." }
      ]
    },
    {
      title: "AI tutors and verifiable digital credentials",
      dimension: "Future of Learning", confidence: "High",
      trajectory: "Rising", horizon: "1\u20133 yrs", firstSeen: "Dec 2025",
      what: "AI tutoring and adaptive learning are improving, alongside growing interest in skills-based, verifiable digital credentials that record what a person can actually do.",
      why: "Both sit close to SWDA/TED's core: adaptive learning could change how training is delivered, and verifiable credentials touch how skills are recognised across the system.",
      options: ["Explore where adaptive learning could support existing programmes", "Look into how verifiable credentials might fit current recognition frameworks"],
      sources: ["OECD Education & Skills"],
      evidence: [
        { source: "OECD Education & Skills", quote: "AI tutors and adaptive learning are improving, and interest is growing in skills-based, verifiable digital credentials that record what a person can actually do." }
      ]
    },
    {
      title: "Shorter skill half-life pushing continuous reskilling",
      dimension: "Future of Learning", confidence: "Medium",
      trajectory: "Rising", horizon: "1\u20133 yrs", firstSeen: "Apr 2026",
      what: "The skills a job requires are turning over faster, strengthening the case for short, modular, repeated reskilling over one-off qualifications.",
      why: "This is close to SWDA/TED's delivery model \u2014 it may favour stackable modules and faster refresh cycles over long programmes, and supports the push to lift CET take-up.",
      options: ["Review how quickly current programmes can refresh content", "Consider stackable, modular formats for fast-moving skill areas"],
      sources: ["OECD Education & Skills", "LinkedIn Economic Graph"],
      evidence: [
        { source: "OECD Education & Skills", quote: "The half-life of job-specific skills keeps shortening, strengthening the case for continuous, modular reskilling over one-off qualifications." },
        { source: "LinkedIn Economic Graph", quote: "The set of skills listed on the average job has churned sharply over five years, and members who add an AI-related skill see faster role mobility." }
      ]
    },
    {
      title: "AI in citizen-facing public services",
      dimension: "Future of Government", confidence: "High",
      trajectory: "Rising", horizon: "1\u20133 yrs", firstSeen: "Jan 2026",
      what: "Public-sector bodies are expanding digital public infrastructure and putting AI into citizen-facing service delivery, raising questions about trust, transparency and staff capability.",
      why: "As a public agency, SWDA/TED faces the same questions for its own services \u2014 and the capability of public servants to deploy and oversee AI well is itself a skills issue.",
      options: ["Consider what AI-readiness looks like for the agency's own workforce", "Watch how peer agencies handle transparency and trust in AI services"],
      sources: ["World Economic Forum", "IMDA / Smart Nation Singapore"],
      evidence: [
        { source: "World Economic Forum", quote: "Public-sector bodies are expanding digital public infrastructure and putting AI into citizen-facing service delivery, raising questions about trust, transparency and government workforce capability." },
        { source: "IMDA / Smart Nation Singapore", quote: "Guidance that agencies build in-house capability to deploy and oversee AI rather than rely solely on external vendors." }
      ]
    }
  ];

  const DEMO_BRIEF = {
    subject: "This cycle's signals: agentic AI, cheaper models, and AI in public services",
    intro: "This cycle's scan clustered the watched sources into emerging trends across all four focus areas, with the clearest movement around agentic AI at work and lower-cost models spreading into learning and public services. Each item below is an early read for your review, not a recommendation.",
    sections: {
      "Future of Work": "Agents are beginning to take on multi-step knowledge work, and AI oversight is becoming a baseline skill employers screen for.",
      "Future of Tech": "AI is getting cheaper to run and broader in what it can handle, widening where it can be applied.",
      "Future of Learning": "Adaptive learning and verifiable credentials are maturing in ways close to our core work.",
      "Future of Government": "AI is moving into citizen-facing services, raising trust and workforce-capability questions for public agencies."
    },
    closing: "Please review the items below and flag anything you'd like the team to look into further."
  };

  // ---------- watched sources registry ----------
  const DOC_ICON =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M6 3h8l4 4v14H6V3Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M14 3v4h4M8.5 12h7M8.5 15.5h7M8.5 8.5h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  const X_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const CHEV_ICON =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const PLUG_ICON =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0V7ZM12 16v5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const INFO_ICON =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#A39E91" stroke-width="1.6"/><path d="M12 11v5M12 7.5v.5" stroke="#A39E91" stroke-width="1.8" stroke-linecap="round"/></svg>';

  const METHODS = ["RSS feed", "Web page", "Newsletter", "API", "Manual paste"];
  function methodNote(m) {
    return ({
      "RSS feed": "a feed reader pulls each new item automatically every cycle",
      "Web page": "the page is fetched and its main text extracted every cycle",
      "Newsletter": "issues emailed to the engine's inbox are parsed every cycle",
      "API": "the provider's API is queried every cycle",
      "Manual paste": "a person drops in the latest text each cycle"
    })[m] || "the latest text is collected every cycle";
  }

  const expanded = new Set();

  function renderSources() {
    srcListEl.innerHTML = "";
    watched.forEach((s) => {
      const n = s.excerpts.length;
      const open = expanded.has(s.id);
      const row = document.createElement("div");
      row.className = "src-row" + (open ? " open" : "");
      const optsHtml = METHODS.map((m) => `<option${m === s.method ? " selected" : ""}>${m}</option>`).join("");
      row.innerHTML =
        `<div class="src-top">
           <span class="src-ico">${DOC_ICON}</span>
           <div class="src-main">
             <div class="src-name">${s.url ? `<a class="src-link" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}<span class="ext">↗</span></a>` : esc(s.name)}</div>
             <div class="src-sub">
               <span class="src-method">${PLUG_ICON}${esc(s.method)}</span><span class="sep">\u00b7</span><span class="src-kind">${esc((window.__FI_KIND__ || {})[s.name] || s.kind)}</span>
               <span class="sep">·</span>
               <span class="src-count ${n ? "" : "pending"}"><span class="ld"></span>${n ? n + " item" + (n === 1 ? "" : "s") : "no content yet"}</span>
             </div>
           </div>
           <button class="src-toggle" type="button">${CHEV_ICON}<span>${n ? "View / edit" : "Add content"}</span></button>
           <button class="src-rm" type="button" title="Stop watching this source" aria-label="Remove ${esc(s.name)}">${X_ICON}</button>
         </div>
         <div class="src-edit">
           <div class="src-conn">
             <label>Connection</label>
             <select class="src-method-sel">${optsHtml}</select>
           </div>
           <div class="src-edit-note">${INFO_ICON}<span>Live, ${methodNote(s.method)}. For this demo, paste the latest public excerpt(s) below \u2014 separate items with a blank line.</span></div>
           <textarea class="src-text" spellcheck="false" placeholder="Paste what this source published this cycle\u2026">${esc(s.excerpts.join("\n\n"))}</textarea>
         </div>`;

      row.querySelector(".src-toggle").addEventListener("click", () => {
        if (expanded.has(s.id)) expanded.delete(s.id); else expanded.add(s.id);
        renderSources();
      });
      row.querySelector(".src-rm").addEventListener("click", () => {
        watched = watched.filter((w) => w.id !== s.id);
        expanded.delete(s.id);
        renderSources();
      });
      row.querySelector(".src-method-sel").addEventListener("change", (e) => {
        s.method = e.target.value;
        renderSources();
      });
      const ta = row.querySelector(".src-text");
      ta.addEventListener("input", () => {
        s.excerpts = ta.value.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
        const cnt = row.querySelector(".src-count");
        const m = s.excerpts.length;
        cnt.classList.toggle("pending", !m);
        cnt.innerHTML = `<span class="ld"></span>${m ? m + " item" + (m === 1 ? "" : "s") : "no content yet"}`;
      });

      srcListEl.appendChild(row);
    });
  }

  function buildPull() {
    return watched.reduce((acc, s) => acc.concat(s.excerpts), []).join("\n\n");
  }

  // ---------- column scaffold ----------
  function buildColumns(emptyText) {
    const bs = $("#boardSummary");
    if (bs) bs.hidden = true; // the summary only belongs with rendered results
    columnsEl.innerHTML = "";
    columnsEl.classList.remove("placeholder-cards");
    DIMENSIONS.forEach((d) => {
      const col = document.createElement("div");
      col.className = "col";
      col.style.setProperty("--c", `var(--${d.v})`);
      col.style.setProperty("--c-tint", `var(--${d.v}-tint)`);
      col.innerHTML =
        `<div class="col-head">
           <span class="dot"></span>
           <span class="name">${d.key}</span>
           <span class="count" data-count="${d.v}">0</span>
         </div>
         <div class="col-body" data-body="${d.v}">
           <div class="empty">${emptyText}</div>
         </div>`;
      columnsEl.appendChild(col);
    });
  }

  function dimOf(name) {
    const found = DIMENSIONS.find((d) => d.key.toLowerCase() === String(name || "").toLowerCase().trim());
    return found || null;
  }

  // ---------- pipeline animation ----------
  function resetPipe() {
    pills.forEach((p) => p.classList.remove("active", "done", "lit"));
  }
  let pipeTimers = [];
  function runPipe() {
    pipeTimers.forEach(clearTimeout);
    pipeTimers = [];
    resetPipe();
    const order = [0, 1, 2, 3];
    let i = 0;
    const step = () => {
      if (i > 0) pills[i - 1].classList.replace("active", "done");
      if (i < order.length) {
        pills[i].classList.add("active");
        i++;
        pipeTimers.push(setTimeout(step, 650));
      }
    };
    step();
  }
  function finishPipe() {
    pipeTimers.forEach(clearTimeout);
    pills.forEach((p, idx) => {
      p.classList.remove("active");
      if (idx < 4) p.classList.add("done");
    });
    pills[4].classList.add("lit"); // human review now awaits
  }

  // ---------- card rendering ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // Movement of a signal over recent cycles. Glyphs are CSS-free so they render
  // the same in the cards and in the board summary.
  const TRAJECTORY = {
    Rising:   { glyph: "↗", label: "Rising" },
    Emerging: { glyph: "✦", label: "Emerging" },
    Steady:   { glyph: "→", label: "Steady" },
    Cooling:  { glyph: "↘", label: "Cooling" }
  };
  function trajOf(name) {
    const key = String(name || "").trim();
    return TRAJECTORY[key] ? key : null;
  }
  function confOf(c) {
    return ["High", "Medium", "Low"].includes(c) ? c : "Low";
  }
  // Supporting-signal count: prefer explicit evidence, fall back to source labels.
  function signalCount(it) {
    if (Array.isArray(it.evidence) && it.evidence.length) return it.evidence.length;
    if (Array.isArray(it.sources)) return it.sources.length;
    return 0;
  }

  function renderCards(items) {
    buildColumns("No signal this scan.");
    const counts = { work: 0, tech: 0, learning: 0, gov: 0 };
    let order = 0;

    items.forEach((it, i) => {
      const d = dimOf(it.dimension);
      if (!d) return;
      const body = columnsEl.querySelector(`[data-body="${d.v}"]`);
      if (counts[d.v] === 0) body.innerHTML = ""; // clear the empty note
      counts[d.v]++;

      const conf = confOf(it.confidence);
      const opts = Array.isArray(it.options) ? it.options.slice(0, 2) : [];
      const srcs = Array.isArray(it.sources) ? it.sources.slice(0, 4) : [];
      const traj = trajOf(it.trajectory);
      const horizon = typeof it.horizon === "string" ? it.horizon.trim() : "";
      const firstSeen = typeof it.firstSeen === "string" ? it.firstSeen.trim() : "";
      const evidence = Array.isArray(it.evidence) ? it.evidence.filter((e) => e && e.quote) : [];
      const sigN = signalCount(it);

      const trajBadge = traj
        ? `<span class="traj ${traj}" title="How the signal is moving across recent cycles"><span class="tg">${TRAJECTORY[traj].glyph}</span>${TRAJECTORY[traj].label}</span>`
        : "";
      const metaBadges = [
        horizon ? `<span class="mbadge" title="Rough time to relevance">Horizon · ${esc(horizon)}</span>` : "",
        firstSeen ? `<span class="mbadge" title="First surfaced by the scan">First seen ${esc(firstSeen)}</span>` : "",
        sigN ? `<span class="mbadge mbadge-sig" title="Independent signals supporting this trend">${sigN} signal${sigN === 1 ? "" : "s"}</span>` : ""
      ].filter(Boolean).join("");

      const card = document.createElement("article");
      card.className = "card";
      card.dataset.idx = i;
      card.style.animationDelay = (order * 90) + "ms";
      order++;
      card.innerHTML =
        `<div class="stamp s-acc">Accepted</div>
         <div class="stamp s-flag">Flagged</div>
         <div class="card-top">
           <span class="chip ${conf}"><span class="cdot"></span>${conf} confidence</span>
           ${trajBadge}
         </div>
         <h3 class="ctitle">${esc(it.title)}</h3>
         ${metaBadges ? `<div class="metaline">${metaBadges}</div>` : ""}
         <div class="frow">
           <div class="flabel-sm">What it is</div>
           <p>${esc(it.what)}</p>
         </div>
         <div class="frow">
           <div class="flabel-sm">Why it may matter</div>
           <p>${esc(it.why)}</p>
         </div>
         ${opts.length ? `<div class="frow">
           <div class="flabel-sm">Could consider</div>
           <ul>${opts.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>
         </div>` : ""}
         ${srcs.length ? `<div class="sources">${srcs.map((s) => (window.__FI_SRC_TAG__ ? window.__FI_SRC_TAG__(s, esc) : `<span class="src">${esc(typeof s === "string" ? s : (s && s.label) || "")}</span>`)).join("")}</div>` : ""}
         ${evidence.length ? `<div class="detail">
           <button class="ev-toggle" type="button" aria-expanded="false">
             <svg class="ev-chev" width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
             Evidence &amp; reviewer note<span class="ev-n">${evidence.length}</span>
           </button>
           <div class="ev-wrap" hidden>
             <div class="flabel-sm">Supporting signals</div>
             <ul class="ev-list">${evidence.slice(0, 4).map((e) =>
               `<li><span class="ev-src">${esc(e.source || "Source")}</span><span class="ev-q">${esc(e.quote)}</span></li>`).join("")}</ul>
             <label class="rnote">
               <span class="flabel-sm">Reviewer note</span>
               <textarea class="rnote-ta" rows="2" placeholder="Record your read — why you'd accept or flag this, or what to check next…"></textarea>
             </label>
           </div>
         </div>` : ""}
         <div class="review">
           <button class="rbtn accept" type="button">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4 4 10-10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>Accept
           </button>
           <button class="rbtn flag" type="button">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 3v11m0 4.5v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M12 3l9 16H3l9-16Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>Flag
           </button>
         </div>`;

      const evToggle = card.querySelector(".ev-toggle");
      if (evToggle) {
        const wrap = card.querySelector(".ev-wrap");
        evToggle.addEventListener("click", () => {
          const open = wrap.hasAttribute("hidden");
          if (open) wrap.removeAttribute("hidden"); else wrap.setAttribute("hidden", "");
          evToggle.setAttribute("aria-expanded", open ? "true" : "false");
          evToggle.classList.toggle("open", open);
        });
        const note = card.querySelector(".rnote-ta");
        // Keep the reviewer's note on the trend so it survives accept/flag re-renders.
        if (note) {
          if (it._note) note.value = it._note;
          note.addEventListener("input", () => { it._note = note.value; });
        }
      }

      const acc = card.querySelector(".accept");
      const flg = card.querySelector(".flag");
      acc.addEventListener("click", () => {
        const on = card.classList.toggle("accepted");
        card.classList.remove("flagged");
        flg.classList.remove("on");
        acc.classList.toggle("on", on);
        updateMeta();
      });
      flg.addEventListener("click", () => {
        const on = card.classList.toggle("flagged");
        card.classList.remove("accepted");
        acc.classList.remove("on");
        flg.classList.toggle("on", on);
        updateMeta();
      });

      body.appendChild(card);
    });

    DIMENSIONS.forEach((d) => {
      columnsEl.querySelector(`[data-count="${d.v}"]`).textContent = counts[d.v];
    });

    renderSummary(items);
    return items.length;
  }

  // At-a-glance read of the whole board: spread, confidence, momentum, sourcing.
  function renderSummary(items) {
    const board = $("#boardSummary");
    if (!board) return;
    if (!items || !items.length) { board.hidden = true; board.innerHTML = ""; return; }

    let high = 0, rising = 0, sigTotal = 0;
    items.forEach((it) => {
      if (confOf(it.confidence) === "High") high++;
      if (trajOf(it.trajectory) === "Rising") rising++;
      sigTotal += signalCount(it);
    });
    const dimsHit = DIMENSIONS.filter((d) =>
      items.some((it) => dimOf(it.dimension) && dimOf(it.dimension).key === d.key)).length;

    const stat = (num, lab) => `<div class="bs-stat"><span class="bs-num">${num}</span><span class="bs-lab">${lab}</span></div>`;
    board.innerHTML =
      stat(items.length, `trend${items.length === 1 ? "" : "s"} surfaced`) +
      stat(dimsHit + " / 4", "dimensions active") +
      stat(high, "high-confidence") +
      stat(rising, "rising") +
      stat(sigTotal, "signals cited") +
      stat(watched.length, "sources watched");
    board.hidden = false;
  }

  function updateMeta() {
    const total = columnsEl.querySelectorAll(".card").length;
    const acc = columnsEl.querySelectorAll(".card.accepted").length;
    const flg = columnsEl.querySelectorAll(".card.flagged").length;
    outMeta.innerHTML =
      `<b>${total}</b> trend${total === 1 ? "" : "s"} drafted · <b>${acc}</b> accepted · <b>${flg}</b> flagged · ${total - acc - flg} awaiting review`;
    updateBriefHint();
  }

  // ---------- the live Claude call ----------
  function buildPrompt(context, signals) {
    return (
"You are a futures-intelligence analyst. You read external public signals and surface emerging trends relevant to the team's mandate \u2014 scanning across social, technological, economic, environmental, political, legal and ethical change, not technology alone. You surface signal and draft options for a human to review \u2014 you do NOT predict the agency's decisions.\n\n" +
"=== WHAT THE TEAM CARES ABOUT (judge relevance against this; do not invent it) ===\n" + context + "\n\n" +
"=== SOURCE SIGNALS (use ONLY these) ===\n" + signals + "\n\n" +
"=== TASK ===\n" +
"1. Identify up to 7 emerging trends present in the signals. Prefer weak signals \u2014 surprising, discontinuous developments \u2014 over what informed readers already know, and spread trends across different domains where the signals allow. One article can carry more than one distinct signal \u2014 mine it fully. Two outlets covering the same event count as ONE signal. News about the reader's own organisation is background, not a finding. Ignore one-off vendor hype and sponsored content.\n" +
"2. Classify each trend into EXACTLY ONE of these four dimensions (use the exact string): \"Future of Work\", \"Future of Tech\", \"Future of Learning\", \"Future of Government\".\n" +
"3. For each trend write TIGHTLY \u2014 ONE short sentence per text field, no more than two:\n" +
"   - what: what it is, in plain language.\n" +
"   - why: why it may matter to the team specifically, grounded in the signals.\n" +
"   - options: 1\u20132 short candidate next steps, framed as options NOT recommendations. Each option must name the concrete lever it would act on (which framework, programme, review, tool or advice would change); at most ONE option per trend may be pure monitoring.\n" +
"   - sources: 1\u20132 citations for the signals that support it, each an object {\"label\": a short label (e.g. \"Analyst outlook\"), \"ref\": the [L#] code shown at the end of that signal (e.g. \"L3\"), or null if the signal has no code}. Never cite the same article for more than one trend. If a cited source is not in English, add the language to the label, e.g. \"Shanghai skill list (Chinese)\".\n" +
"   - confidence: \"High\" ONLY when two or more INDEPENDENT sources support it (different outlets reporting different events or evidence \u2014 one announcement covered twice is one source); \"Medium\" for one strong source plus a weaker echo; \"Low\" for a single source, however striking. Ratings must vary with the evidence \u2014 never give every trend the same confidence.\n" +
"   - trajectory: one of \"Rising\", \"Emerging\", \"Steady\" or \"Cooling\" \u2014 how the signal seems to be moving.\n" +
"   - horizon: rough time-to-relevance, one of \"0\u20131 yr\", \"1\u20133 yrs\" or \"3\u20135 yrs\".\n" +
"   - evidence: 1\u20133 items, each {\"source\": short source label, \"quote\": a short paraphrase of the supporting signal}. Use ONLY the supplied signals; do not fabricate quotes.\n\n" +
"=== RULES ===\n" +
"- Use ONLY the supplied signals. Do NOT invent statistics, programme names, or facts.\n" +
"- If unsure, say so and use Low confidence.\n" +
"- Plain English. No buzzwords. Keep every field brief so the whole array stays compact.\n\n" +
"=== OUTPUT ===\n" +
"Return ONLY a JSON array, nothing else. Each element: {\"title\": string, \"dimension\": string, \"confidence\": string, \"trajectory\": string, \"horizon\": string, \"what\": string, \"why\": string, \"options\": [string], \"sources\": [{\"label\": string, \"ref\": string|null}], \"evidence\": [{\"source\": string, \"quote\": string}]}. No markdown, no commentary."
    );
  }

  function extractJSON(text) {
    if (!text) throw new Error("Empty response from the model.");
    let t = String(text).trim();
    // strip code fences if present
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const start = t.indexOf("[");
    if (start === -1) throw new Error("No JSON array found in the response.");

    // First try a clean parse of the whole array (fast path).
    const end = t.lastIndexOf("]");
    if (end > start) {
      try { return JSON.parse(t.slice(start, end + 1)); } catch (_) { /* fall through to salvage */ }
    }

    // Salvage path: walk the array and collect every COMPLETE top-level
    // object, tolerating a truncated final object (output-token cap).
    const objs = [];
    let depth = 0, objStart = -1, inStr = false, escNext = false;
    for (let i = start + 1; i < t.length; i++) {
      const ch = t[i];
      if (inStr) {
        if (escNext) escNext = false;
        else if (ch === "\\") escNext = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{") { if (depth === 0) objStart = i; depth++; }
      else if (ch === "}") {
        depth--;
        if (depth === 0 && objStart !== -1) {
          try { objs.push(JSON.parse(t.slice(objStart, i + 1))); } catch (_) {}
          objStart = -1;
        }
      } else if (ch === "]" && depth === 0) { break; }
    }
    if (objs.length === 0) throw new Error("The response could not be parsed into trends.");
    return objs;
  }

  async function scan() {
    if (running) return;
    const context = ctxEl.value.trim();
    const signals = sigEl.value.trim();
    errEl.style.display = "none";

    if (!signals) {
      showError("Paste some source signals first — or click \u201cLoad sample signals\u201d.");
      return;
    }
    if (signals.length < 40) {
      showError("That looks too short to cluster. Add a few more lines of source text.");
      return;
    }

    const useDemo = demoMode || !aiAvailable();

    running = true;
    setBusy(true);
    runPipe();
    buildColumns("Interpreting…");
    lastIsDemo = false;
    setTitle("Interpreting signals…");
    outMeta.textContent = useDemo ? "Running a simulated pass (demo mode)." : "Running one live AI pass.";

    if (useDemo) {
      try {
        await wait(2650); // let the pipeline animation play through
        finishPipe();
        lastIsDemo = true;
        setTitle("Interpreted signals");
        lastTrends = DEMO_TRENDS.slice();
        renderCards(lastTrends);
        updateMeta();
        revealBrief();
      } finally {
        running = false;
        setBusy(false);
      }
      return;
    }

    try {
      const raw = await window.claude.complete({
        messages: [{ role: "user", content: buildPrompt(context, signals) }]
      });
      const data = extractJSON(raw);
      if (!Array.isArray(data) || data.length === 0) {
        throw new Error("The model returned no trends. Try richer source signals.");
      }
      const valid = data.filter((d) => dimOf(d && d.dimension));
      if (valid.length === 0) throw new Error("No trends could be sorted into the four dimensions. Try again.");

      finishPipe();
      lastIsDemo = false;
      setTitle("Interpreted signals");
      lastTrends = valid;
      renderCards(valid);
      updateMeta();
      revealBrief();
    } catch (e) {
      resetPipe();
      buildColumns("No signal this scan.");
      lastIsDemo = false;
      setTitle("Interpreted signals");
      outMeta.textContent = "Scan did not complete.";
      showError("Could not complete the scan: " + (e && e.message ? e.message : e) + " — please try again.");
    } finally {
      running = false;
      setBusy(false);
    }
  }

  function showError(msg) {
    errEl.textContent = msg;
    errEl.style.display = "block";
  }

  function setBusy(b) {
    scanBtn.disabled = b;
    const lbl = scanBtn.querySelector(".lbl");
    const icon = scanBtn.querySelector("svg");
    if (b) {
      icon.style.display = "none";
      if (!scanBtn.querySelector(".spinner")) {
        const sp = document.createElement("span");
        sp.className = "spinner";
        scanBtn.insertBefore(sp, lbl);
      }
      lbl.textContent = "Scanning…";
    } else {
      icon.style.display = "";
      const sp = scanBtn.querySelector(".spinner");
      if (sp) sp.remove();
      lbl.textContent = "Scan & interpret";
    }
  }

  // ---------- monthly briefing email ----------
  function getIncluded() {
    const cards = Array.from(columnsEl.querySelectorAll(".card"));
    if (!cards.length || !lastTrends.length) return { included: [], mode: "none" };
    const acceptedIdx = cards.filter((c) => c.classList.contains("accepted")).map((c) => +c.dataset.idx);
    const flaggedIdx = cards.filter((c) => c.classList.contains("flagged")).map((c) => +c.dataset.idx);
    if (acceptedIdx.length) {
      return { included: acceptedIdx.map((i) => lastTrends[i]).filter(Boolean), mode: "accepted" };
    }
    return { included: lastTrends.filter((_, i) => !flaggedIdx.includes(i)), mode: "all" };
  }

  function updateBriefHint() {
    if (briefSection.hidden) return;
    const { included, mode } = getIncluded();
    if (mode === "accepted") {
      briefSub.innerHTML = `Will be built from the <b>${included.length}</b> trend${included.length === 1 ? "" : "s"} you accepted. Flagged items are held out.`;
    } else if (included.length) {
      briefSub.innerHTML = `Draft will cover all <b>${included.length}</b> surfaced trend${included.length === 1 ? "" : "s"} — <b>Accept</b> the cards you want to curate a tighter briefing.`;
    } else {
      briefSub.textContent = "Every card is flagged — nothing to brief. Accept the trends you want included.";
    }
  }

  function revealBrief() {
    briefSection.hidden = false;
    emailWrap.hidden = true;
    copyBtn.hidden = true;
    lastEmailText = "";
    updateBriefHint();
  }

  function monthLabel() {
    return new Date().toLocaleDateString("en-GB", { month: "short", year: "numeric" });
  }

  function buildBriefPrompt(context, included) {
    const list = included.map((t, i) =>
      `${i + 1}. [${t.dimension}] ${t.title} — ${t.what} (relevance: ${t.why})`).join("\n");
    const dims = DIMENSIONS.map((d) => d.key).filter((k) => included.some((t) => dimOf(t.dimension) && dimOf(t.dimension).key === k));
    return (
"You are drafting a short MONTHLY FUTURES BRIEFING EMAIL for agency leadership, written by the analyst engine. Tone: calm, plain English, editorial, credible for senior government readers. No hype, no buzzwords. These are AI drafts for a person to check \u2014 not findings or predictions.\n\n" +
"=== WHAT THE TEAM CARES ABOUT ===\n" + context + "\n\n" +
"=== TRENDS TO COVER (use ONLY these; do NOT invent facts, statistics or programme names) ===\n" + list + "\n\n" +
"=== WRITE ===\n" +
"- subject: a short, specific email subject line. Do NOT put any date, month or year in it.\n" +
"- intro: 2\u20133 sentences that OPEN by naming the one or two trends that matter most this cycle and why they lead, then frame the rest.\n" +
"- sections: an object with ONE key per focus area in this exact list " + JSON.stringify(dims) + ", each value a single sentence leading into that area's trends.\n" +
"- closing: one sentence inviting the reader to review and flag what matters.\n\n" +
"Keep every field brief. Return ONLY a JSON object: {\"subject\": string, \"intro\": string, \"sections\": {<focus area>: string}, \"closing\": string}. No markdown, no commentary."
    );
  }

  function extractObject(text) {
    if (!text) throw new Error("empty");
    let t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("no object");
    return JSON.parse(t.slice(start, end + 1));
  }

  function composeBriefFallback(included) {
    const dims = DIMENSIONS.filter((d) => included.some((t) => dimOf(t.dimension) && dimOf(t.dimension).key === d.key));
    const sections = {};
    dims.forEach((d) => {
      sections[d.key] = `Signals worth watching this cycle in ${d.key.replace("Future of", "").trim().toLowerCase()}.`;
    });
    return {
      subject: `Futures briefing — ${dims.length} focus area${dims.length === 1 ? "" : "s"} this cycle`,
      intro: `This cycle's scan surfaced ${included.length} emerging trend${included.length === 1 ? "" : "s"} across ${dims.length} of the four focus areas. Each item below is an early read for your review, not a recommendation.`,
      sections: sections,
      closing: "Please review the items below and flag anything you'd like the team to look into further.",
      _fallback: true
    };
  }

  function renderEmail(brief, included) {
    const groups = DIMENSIONS.map((d) => ({
      d: d,
      items: included.filter((t) => dimOf(t.dimension) && dimOf(t.dimension).key === d.key)
    })).filter((g) => g.items.length);

    const subject = (brief && brief.subject) || `Futures briefing — ${monthLabel()}`;
    const intro = (brief && brief.intro) || "";
    const closing = (brief && brief.closing) || "Please review the items below and flag what matters.";
    const sections = (brief && brief.sections) || {};

    let secHtml = "";
    let txt = `Subject: ${subject}\nFrom: Futures Intelligence · ${(window.__FI_USER__ && window.__FI_USER__.name) || "SEED Innovation"}\nTo: Leadership & sector leads\n\nDear colleagues,\n\n${intro}\n`;

    groups.forEach((g) => {
      const lead = sections[g.d.key] || `This cycle's signals in ${g.d.key.replace("Future of", "").trim().toLowerCase()}:`;
      const lis = g.items.map((t) => {
        const conf = ["High", "Medium", "Low"].includes(t.confidence) ? t.confidence : "Low";
        return `<li><b>${esc(t.title)}</b> — ${esc(t.what)}<span class="eml-conf ${conf}">${conf}</span>${window.__FI_EMAIL_SRCS__ ? window.__FI_EMAIL_SRCS__.html(t, esc) : ""}</li>`;
      }).join("");
      secHtml +=
        `<div class="eml-sec" style="--c:var(--${g.d.v});--c-tint:var(--${g.d.v}-tint)">
           <div class="eml-sec-head"><span class="dot"></span>${g.d.key}</div>
           <p class="eml-lead">${esc(lead)}</p>
           <ul class="eml-list">${lis}</ul>
         </div>`;
      txt += `\n${g.d.key}\n${lead}\n` + g.items.map((t) => `  • ${t.title} — ${t.what} (${t.confidence || "Low"})${window.__FI_EMAIL_SRCS__ ? window.__FI_EMAIL_SRCS__.text(t) : ""}`).join("\n") + "\n";
    });

    txt += `\n${closing}\n${(window.__FI_EMAIL_SRCS__ ? window.__FI_EMAIL_SRCS__.footerText() : "") || "\n"}— Futures Intelligence (automated draft)\nAI-generated from public sources. Review before sending.`;
    lastEmailText = txt; window.__FI_EMAIL_TEXT__ = txt;

    emailEl.innerHTML =
      `<div class="eml-head">
         <div class="eml-meta">
           <div class="eml-row"><span class="eml-k">From</span><span class="eml-v">Futures Intelligence · ${esc((window.__FI_USER__ && window.__FI_USER__.name) || "SEED Innovation")}</span></div>
           <div class="eml-row"><span class="eml-k">To</span><span class="eml-v">Leadership &amp; sector leads</span></div>
           <div class="eml-row eml-subj"><span class="eml-k">Subject</span><span class="eml-v">${esc(subject)}</span></div>
         </div>
         <span class="eml-stamp">Draft · ${monthLabel()}</span>
       </div>
       <div class="eml-body">
         <p class="eml-greet">Dear colleagues,</p>
         <p class="eml-intro">${esc(intro)}</p>
         ${secHtml}
         <p class="eml-close">${esc(closing)}</p>
         ${window.__FI_EMAIL_SRCS__ ? window.__FI_EMAIL_SRCS__.footerHtml(esc) : ""}<p class="eml-sign">— Futures Intelligence (automated draft)</p>
         <div class="eml-caveat">AI-generated draft from public sources. Review and edit before sending — this is a draft for a person to check, not a finding or a prediction.</div>
       </div>`;
  }

  function setDraftBusy(b) {
    draftBtn.disabled = b;
    const lbl = draftBtn.querySelector(".lbl");
    const icon = draftBtn.querySelector("svg");
    if (b) {
      icon.style.display = "none";
      if (!draftBtn.querySelector(".spinner")) {
        const sp = document.createElement("span");
        sp.className = "spinner";
        draftBtn.insertBefore(sp, lbl);
      }
      lbl.textContent = "Drafting…";
    } else {
      icon.style.display = "";
      const sp = draftBtn.querySelector(".spinner");
      if (sp) sp.remove();
      lbl.textContent = lastEmailText ? "Re-draft email" : "Draft briefing email";
    }
  }

  async function draftBrief() {
    if (drafting) return;
    const { included } = getIncluded();
    if (!included.length) { updateBriefHint(); return; }
    drafting = true;
    setDraftBusy(true);
    let brief;
    const useDemo = demoMode || !aiAvailable();
    if (useDemo) {
      await wait(1400);
      brief = JSON.parse(JSON.stringify(DEMO_BRIEF));
    } else {
      try {
        const raw = await window.claude.complete({
          messages: [{ role: "user", content: buildBriefPrompt(ctxEl.value.trim(), included) }]
        });
        brief = extractObject(raw);
        if (!brief || typeof brief !== "object") throw new Error("bad shape");
      } catch (e) {
          brief = composeBriefFallback(included); // never show a broken state
      }
    }
    renderEmail(brief, included);
    emailWrap.hidden = false;
    copyBtn.hidden = false;
    const n = included.length;
    const tag = useDemo ? " (demo draft — illustrative, not a live AI write-up)" : (brief._fallback ? " (offline template — live draft unavailable)" : "");
    briefSub.innerHTML = `Drafted from <b>${n}</b> trend${n === 1 ? "" : "s"}${tag}. Edit the wording before sending.`;
    drafting = false;
    setDraftBusy(false);
  }

  async function copyDraft() {
    if (!lastEmailText) return;
    const clbl = copyBtn.querySelector(".clbl");
    try {
      await navigator.clipboard.writeText(lastEmailText);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = lastEmailText;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (_) {}
      ta.remove();
    }
    copyBtn.classList.add("copied");
    clbl.textContent = "Copied";
    setTimeout(() => { copyBtn.classList.remove("copied"); clbl.textContent = "Copy draft"; }, 1600);
  }

  // ---------- wiring ----------
  scanBtn.addEventListener("click", scan);
  draftBtn.addEventListener("click", draftBrief);
  copyBtn.addEventListener("click", copyDraft);

  function setDemoMode(on, persist) {
    demoMode = on;
    demoChk.checked = on;
    document.getElementById("demoToggle").classList.toggle("on", on);
    if (persist) {
      try { localStorage.setItem("fi_demo", on ? "1" : "0"); } catch (e) {}
    }
  }
  demoChk.addEventListener("change", () => setDemoMode(demoChk.checked, true));
  sampleBtn.addEventListener("click", () => {
    const pull = buildPull();
    if (!pull) {
      showError("No watched sources to pull from. Add a source above first.");
      return;
    }
    sigEl.value = pull;
    errEl.style.display = "none";
    sigEl.focus();
    sigEl.scrollTop = 0;
  });

  srcAddForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = srcNameInput.value.trim();
    if (!name) { srcNameInput.focus(); return; }
    const id = "s" + Date.now();
    watched.push({ id: id, name: name, kind: srcKindSel.value, method: "Manual paste", excerpts: [] });
    expanded.add(id); // open it so the user can paste its content right away
    srcNameInput.value = "";
    renderSources();
    const ta = srcListEl.querySelector(".src-row:last-child .src-text");
    if (ta) ta.focus();
  });
  clearBtn.addEventListener("click", () => {
    sigEl.value = "";
    errEl.style.display = "none";
    resetPipe();
    buildColumns("No signal this scan.");
    lastIsDemo = false;
    setTitle("Interpreted signals");
    outMeta.textContent = "Run a scan to populate the four dimensions.";
    briefSection.hidden = true;
    emailWrap.hidden = true;
    copyBtn.hidden = true;
    lastTrends = [];
    lastEmailText = "";
    sigEl.focus();
  });

  // Monthly cadence, derived from today rather than hard-coded: the engine is
  // modelled as running on the 1st of each month.
  function fmtDate(d) {
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }
  function updateCadence() {
    const el = $("#cadMeta");
    if (!el) return;
    const now = new Date();
    const last = new Date(now.getFullYear(), now.getMonth(), 1);
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    el.innerHTML = `Last run <b>${fmtDate(last)}</b> · Next scheduled <b>${fmtDate(next)}</b>`;
  }

  // initial placeholder state
  renderSources();
  buildColumns("No signal yet.");
  updateCadence();

  // Demo mode: respect saved choice; when no live AI is present (e.g. hosted on
  // GitHub Pages) the canned engine becomes the silent default and the toggle hides.
  (function initDemo() {
    let saved = null;
    try { saved = localStorage.getItem("fi_demo"); } catch (e) {}
    if (!aiAvailable()) {
      setDemoMode(true, false);
      demoChk.disabled = true;
      document.getElementById("demoToggle").style.display = "none";
    } else {
      setDemoMode(saved === "1", false);
    }
  })();
})();
