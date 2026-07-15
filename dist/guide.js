// First-run walkthrough + "?" help button (Airbase build only).
// Coach-marks, not a modal maze: each step outlines the real control and says
// what an analyst does with it. Auto-plays once per browser after sign-in;
// replayable any time from the ? button. Steps whose target is missing are
// skipped, so it degrades cleanly.
(function () {
  if (window.__FI_GUIDE__) return;
  window.__FI_GUIDE__ = true;

  var DONE_KEY = "fi_guide_done";

  var st = document.createElement("style");
  st.textContent =
    ".fi-spot{outline:3px solid #7d9b86;outline-offset:4px;border-radius:10px;}" +
    ".fi-coach{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147481000;" +
      "background:#2d3a31;color:#fbfaf5;border-radius:14px;box-shadow:0 16px 44px rgba(0,0,0,.35);" +
      "padding:16px 18px;width:min(540px,94vw);font-size:13.5px;line-height:1.5;}" +
    ".fi-coach .fc-step{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:#a8bfae;margin-bottom:4px;}" +
    ".fi-coach .fc-title{font-weight:700;font-size:15px;margin-bottom:4px;}" +
    ".fi-coach .fc-body{color:#dfe6db;}" +
    ".fi-coach .fc-row{display:flex;gap:8px;margin-top:12px;align-items:center;}" +
    ".fi-coach .fc-spacer{flex:1;}" +
    ".fi-coach button{border:1px solid #55705d;background:transparent;color:#fbfaf5;border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer;}" +
    ".fi-coach button:hover{background:#3a4c40;}" +
    ".fi-coach button.primary{background:#7d9b86;border-color:#7d9b86;color:#1d2620;font-weight:600;}" +
    ".fi-coach button.primary:hover{background:#8fac97;}" +
    ".fi-coach .fc-x{border:none;padding:2px 8px;font-size:16px;color:#a8bfae;}" +
    ".fi-help{position:fixed;left:14px;bottom:14px;z-index:2147480000;width:34px;height:34px;border-radius:50%;" +
      "border:1px solid #c9cfba;background:#fbfaf5;color:#3e5c46;font-size:17px;font-weight:700;cursor:pointer;" +
      "box-shadow:0 4px 14px rgba(0,0,0,.12);line-height:1;}" +
    ".fi-help:hover{background:#eef0e6;}";
  (document.head || document.documentElement).appendChild(st);

  var STEPS = [
    { title: "Welcome to Futures Intelligence",
      body: "Your horizon-scanning assistant. The engine reads your watched sources every day; you review what it finds and send a briefing when it matters. This one-minute tour shows the loop." },
    { sel: ".sources-panel", title: "1 · Watched sources",
      body: "Pulled and triaged by the engine today — no clicking needed. Each card shows its CSF source type; open one to read this cycle's items, and add sources your team trusts at the bottom." },
    { sel: "#fiPill", title: "2 · Make it yours",
      body: "Your analyst profile lives here: your name and your persona — which organisation you scan for, who reads your briefing, what counts as relevant. Scans and drafts are written from that lens." },
    { sel: "#context", title: "3 · The mandate",
      body: "The engine judges relevance against this box. It follows your persona; refine it any time before a scan." },
    { sel: "#scanBtn", title: "4 · Scan & interpret",
      body: "Clusters this cycle's signals into emerging trends across the four futures dimensions. Every card carries linked citations, so you can open the underlying articles.",
      when: function () { var b = document.getElementById("briefSection"); return b && !b.hidden; } },
    { sel: "#columns", title: "5 · Review like an analyst",
      body: "The engine drafts; you decide. Check the sources on each card, then Accept what deserves attention and Flag what doesn't — only accepted trends go into the brief." },
    { sel: "#draftBtn", title: "6 · Draft the briefing",
      body: "Writes the monthly email from your accepted trends, citations included. Copy it, open it in Outlook, or download an editable .eml — always review before sending." },
    { title: "That's the loop",
      body: "Sources → scan → accept/flag → brief, on top of an engine that rescans daily. Replay this tour with the ? button (bottom-left); edit your persona from the 👤 pill." }
  ];

  var card = null, idx = 0, timer = null, spotted = null;

  function unspot() {
    if (spotted) { spotted.classList.remove("fi-spot"); spotted = null; }
    if (timer) { clearInterval(timer); timer = null; }
  }
  function close(markDone) {
    unspot();
    if (card) { card.remove(); card = null; }
    if (markDone) { try { localStorage.setItem(DONE_KEY, "1"); } catch (e) {} }
  }
  function visibleSteps() {
    return STEPS.filter(function (s) { return !s.sel || document.querySelector(s.sel); });
  }
  function show(steps, i) {
    unspot();
    idx = Math.max(0, Math.min(i, steps.length - 1));
    var s = steps[idx];
    if (s.sel) {
      var t = document.querySelector(s.sel);
      if (t) {
        spotted = t;
        t.classList.add("fi-spot");
        try { t.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { t.scrollIntoView(); }
      }
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    card.innerHTML = "";
    var step = document.createElement("div"); step.className = "fc-step";
    step.textContent = (idx + 1) + " / " + steps.length;
    var title = document.createElement("div"); title.className = "fc-title"; title.textContent = s.title;
    var body = document.createElement("div"); body.className = "fc-body"; body.textContent = s.body;
    var row = document.createElement("div"); row.className = "fc-row";
    var x = document.createElement("button"); x.className = "fc-x"; x.textContent = "✕"; x.title = "Close the tour";
    x.addEventListener("click", function () { close(true); });
    var back = document.createElement("button"); back.textContent = "Back";
    back.disabled = idx === 0;
    back.addEventListener("click", function () { show(steps, idx - 1); });
    var next = document.createElement("button"); next.className = "primary";
    next.textContent = idx === steps.length - 1 ? "Done" : "Next";
    next.addEventListener("click", function () {
      if (idx === steps.length - 1) close(true); else show(steps, idx + 1);
    });
    row.appendChild(x);
    row.appendChild(document.createElement("span")).className = "fc-spacer";
    row.appendChild(back);
    row.appendChild(next);
    card.appendChild(step); card.appendChild(title); card.appendChild(body); card.appendChild(row);
    // Auto-advance when the step's outcome is observable (e.g. a scan finished).
    if (s.when && !s.when()) {
      var me = idx;
      timer = setInterval(function () {
        if (s.when() && card && idx === me) show(steps, idx + 1);
      }, 700);
    }
  }
  function start() {
    close(false);
    card = document.createElement("div");
    card.className = "fi-coach";
    document.body.appendChild(card);
    show(visibleSteps(), 0);
  }

  function boot() {
    var help = document.createElement("button");
    help.id = "fiHelp";
    help.className = "fi-help";
    help.type = "button";
    help.textContent = "?";
    help.title = "How to use this — replay the walkthrough";
    help.addEventListener("click", start);
    document.body.appendChild(help);

    var done = false;
    try { done = !!localStorage.getItem(DONE_KEY); } catch (e) {}
    if (done) return;
    // First visit: wait for the sign-in gate to clear (and the pill to exist),
    // then play once. Gives up quietly after ~60s.
    var waited = 0;
    var t = setInterval(function () {
      waited += 500;
      var gate = document.getElementById("fiGate");
      if (!gate && waited >= 1500) { clearInterval(t); start(); }
      else if (waited > 60000) clearInterval(t);
    }, 500);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
