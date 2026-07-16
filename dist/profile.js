// Pilot sign-in + persona editor (Airbase build only).
// Identity is an access code (invite token), not a password: enter once, kept in
// localStorage, sent as X-FI-Code on every /api/ call via a fetch wrapper (so the
// engine shim and ingest module need no changes). Signed-in users can edit their
// display name and analyst persona; the server merges the persona with the fixed
// CSF methodology core on every scan/draft. When the server runs in open mode
// (no PILOT_USERS), this module stays invisible.
(function () {
  if (window.__FI_PROFILE__) return;
  window.__FI_PROFILE__ = true;

  var LS_KEY = "fi_code";
  var code = "";
  try { code = localStorage.getItem(LS_KEY) || ""; } catch (e) {}
  var profile = null;
  var lastAutofill = "";   // persona text we last wrote into the mandate box

  // --- every same-origin API call carries the access code ---
  var origFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    try {
      if (code && typeof url === "string" && url.indexOf("/api/") === 0) {
        opts = opts || {};
        if (opts.headers && typeof opts.headers.set === "function") opts.headers.set("X-FI-Code", code);
        else { opts.headers = opts.headers || {}; opts.headers["X-FI-Code"] = code; }
      }
    } catch (e) {}
    return origFetch(url, opts);
  };

  var css =
    ".fi-veil{position:fixed;inset:0;z-index:2147483000;background:rgba(38,48,42,.55);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;}" +
    ".fi-card{background:#fbfaf5;border:1px solid #d8dccb;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.25);padding:26px 28px;width:min(440px,92vw);font-size:14px;color:#2d3a31;}" +
    ".fi-card h3{margin:0 0 4px;font-size:18px;}" +
    ".fi-card .fi-sub{color:#5c6b5f;font-size:12.5px;margin:0 0 16px;}" +
    ".fi-card label{display:block;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#5c6b5f;margin:12px 0 4px;}" +
    ".fi-card input,.fi-card textarea{width:100%;box-sizing:border-box;border:1px solid #c9cfba;border-radius:8px;padding:8px 10px;font:inherit;background:#fff;color:#2d3a31;}" +
    ".fi-card textarea{min-height:200px;resize:vertical;font-size:13px;line-height:1.45;}" +
    ".fi-card input:focus,.fi-card textarea:focus{outline:2px solid #7d9b86;border-color:#7d9b86;}" +
    ".fi-err{color:#a04b3c;font-size:12.5px;margin-top:8px;min-height:16px;}" +
    ".fi-row{display:flex;gap:8px;margin-top:16px;align-items:center;}" +
    ".fi-btn{border:1px solid #3e5c46;background:#3e5c46;color:#fbfaf5;border-radius:8px;padding:8px 16px;font:inherit;font-size:13.5px;cursor:pointer;}" +
    ".fi-btn:hover{background:#2f4735;}" +
    ".fi-btn.ghost{background:transparent;color:#3e5c46;border-color:#b9c2ab;}" +
    ".fi-btn.ghost:hover{background:#eef0e6;}" +
    ".fi-spacer{flex:1;}" +
    ".fi-hint{font-size:11.5px;color:#5c6b5f;margin-top:6px;line-height:1.4;}" +
    ".fi-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;}" +
    ".fi-chip{border:1px solid #b9c2ab;background:#eef0e6;color:#3e5c46;border-radius:999px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer;}" +
    ".fi-chip:hover{background:#e2e6d6;}" +
    ".fi-chip:disabled{opacity:.55;cursor:default;}" +
    ".fi-chip-all{background:#3e5c46;color:#fbfaf5;border-color:#3e5c46;}" +
    ".fi-chip-all:hover{background:#2f4735;}" +
    ".fi-pill{position:fixed;right:14px;bottom:14px;z-index:2147482000;border:1px solid #c9cfba;background:#fbfaf5;color:#2d3a31;border-radius:999px;padding:7px 14px;font:inherit;font-size:12.5px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.12);max-width:38vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
    ".fi-pill:hover{background:#eef0e6;}" +
    ".fi-toast{position:fixed;left:50%;bottom:60px;transform:translateX(-50%);z-index:2147483100;background:#2d3a31;color:#fbfaf5;border-radius:9px;padding:9px 16px;font-size:13px;opacity:0;transition:opacity .25s;pointer-events:none;}";
  var st = document.createElement("style");
  st.textContent = css;
  (document.head || document.documentElement).appendChild(st);

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }
  function toast(msg) {
    var t = el("div", "fi-toast", msg);
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.style.opacity = "1"; });
    setTimeout(function () { t.style.opacity = "0"; setTimeout(function () { t.remove(); }, 400); }, 2400);
  }

  // --- sign-in overlay ---
  function showGate(message) {
    if (document.getElementById("fiGate")) return;
    var veil = el("div", "fi-veil");
    veil.id = "fiGate";
    var card = el("div", "fi-card");
    card.appendChild(el("h3", "", "Futures Intelligence"));
    card.appendChild(el("p", "fi-sub", "Pilot access — enter the access code you were given."));
    var label = el("label", "", "Access code");
    var input = el("input");
    input.placeholder = "FI-XXXX-XXXX";
    input.autofocus = true;
    var err = el("div", "fi-err", message || "");
    var row = el("div", "fi-row");
    var btn = el("button", "fi-btn", "Sign in");
    btn.type = "button";
    row.appendChild(el("span", "fi-spacer"));
    row.appendChild(btn);
    card.appendChild(label); card.appendChild(input); card.appendChild(err); card.appendChild(row);
    veil.appendChild(card);
    document.body.appendChild(veil);
    setTimeout(function () { input.focus(); }, 50);

    function attempt() {
      var v = input.value.trim();
      if (!v) { err.textContent = "Enter your access code."; return; }
      btn.disabled = true;
      code = v;
      fetch("/api/profile").then(function (res) {
        if (!res.ok) throw new Error("bad code");
        return res.json();
      }).then(function (data) {
        try { localStorage.setItem(LS_KEY, v); } catch (e) {}
        veil.remove();
        signedIn(data);
      }).catch(function () {
        code = "";
        btn.disabled = false;
        err.textContent = "That code wasn’t recognised — check it and try again.";
        input.select();
      });
    }
    btn.addEventListener("click", attempt);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") attempt(); });
  }

  // --- signed-in UI: account pill + profile panel ---
  function signedIn(data) {
    profile = data;
    window.__FI_USER__ = { name: data.displayName };
    window.__FI_TOPICS__ = data.topics || [];
    // Keep the on-page mandate box coherent with the persona: replace it when it
    // holds the untouched built-in default OR the persona we last auto-filled
    // (so changing your persona mid-session updates it too). Hand edits are
    // never overwritten.
    var ctx = document.getElementById("context");
    if (ctx && data.persona && ctx.value !== data.persona &&
        (ctx.value.indexOf("SWDA/TED is Singapore") === 0 || ctx.value === lastAutofill)) {
      ctx.value = data.persona;
      lastAutofill = data.persona;
      ctx.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (ctx && ctx.value === data.persona) {
      lastAutofill = data.persona;
    }
    var pill = document.getElementById("fiPill") || el("button", "fi-pill");
    pill.id = "fiPill";
    pill.type = "button";
    pill.textContent = "👤 " + data.displayName;
    pill.title = "Your analyst profile (persona, display name, sign out)";
    if (!pill.parentNode) {
      pill.addEventListener("click", showPanel);
      document.body.appendChild(pill);
    }
  }

  function showPanel() {
    if (document.getElementById("fiPanel")) return;
    var veil = el("div", "fi-veil");
    veil.id = "fiPanel";
    var card = el("div", "fi-card");
    card.appendChild(el("h3", "", "Your analyst profile"));
    card.appendChild(el("p", "fi-sub", "Signed in as " + profile.user + ". The engine scans and drafts as the persona below."));

    card.appendChild(el("label", "", "Display name"));
    var nameIn = el("input");
    nameIn.value = profile.displayName || "";
    nameIn.maxLength = 60;
    card.appendChild(nameIn);

    card.appendChild(el("label", "", "Analyst persona"));
    var ta = el("textarea");
    ta.value = profile.persona || profile.personaDefault || "";
    ta.maxLength = 4000;
    card.appendChild(ta);
    card.appendChild(el("div", "fi-hint",
      "Describe who the analyst is, which organisation and readers the briefing serves, and what counts as relevant. " +
      "The CSF scanning method (weak signals, corroboration, What → So What → Now What) and output rules stay fixed."));

    card.appendChild(el("label", "", "Topics I track (one per line)"));
    var taT = el("textarea");
    taT.style.minHeight = "64px";
    taT.value = (profile.topics || []).join("\n");
    taT.placeholder = "e.g. AI resume screening\nmature worker reskilling";
    card.appendChild(taT);
    card.appendChild(el("div", "fi-hint",
      "Every scan reports which tracked topics had NO supporting signal this cycle — absence of expected change is itself a finding."));

    // Persona-tuned source packs (defined in ingest.js): sources matched to the
    // persona text, one click to add. Recomputed as the persona is edited.
    var sugWrap = el("div");
    var addedAny = false;
    function currentCards() {
      return Array.prototype.slice.call(document.querySelectorAll("#srcList .src-name"))
        .map(function (e) { return e.textContent.replace(/↗/g, "").trim(); });
    }
    function renderSuggestions() {
      sugWrap.innerHTML = "";
      var packs = window.__FI_PACKS__ || [];
      var text = ta.value || "";
      var have = currentCards();
      var names = [];
      packs.forEach(function (p) {
        if (!p.match.test(text)) return;
        p.sources.forEach(function (s) {
          if (have.indexOf(s) === -1 && names.indexOf(s) === -1) names.push(s);
        });
      });
      if (!names.length) return;
      sugWrap.appendChild(el("label", "", "Suggested sources for this persona"));
      var chips = el("div", "fi-chips");
      var chipBtns = [];
      names.slice(0, 6).forEach(function (n) {
        var c = el("button", "fi-chip", "+ " + n);
        c.type = "button";
        c.addEventListener("click", function () {
          if (window.__FI_ADD_SOURCE__ && window.__FI_ADD_SOURCE__(n)) {
            addedAny = true;
            c.disabled = true;
            c.textContent = "✓ " + n;
          }
        });
        chipBtns.push(c);
        chips.appendChild(c);
      });
      if (chipBtns.length > 1) {
        var allBtn = el("button", "fi-chip fi-chip-all", "Add all");
        allBtn.type = "button";
        allBtn.addEventListener("click", function () {
          chipBtns.forEach(function (c) { if (!c.disabled) c.click(); });
          allBtn.disabled = true;
        });
        chips.appendChild(allBtn);
      }
      sugWrap.appendChild(chips);
      sugWrap.appendChild(el("div", "fi-hint", "Added sources pull live content — the pull refreshes automatically when you close this panel."));
    }
    var sugTimer = null;
    ta.addEventListener("input", function () { clearTimeout(sugTimer); sugTimer = setTimeout(renderSuggestions, 400); });
    renderSuggestions();
    card.appendChild(sugWrap);
    function refreshIfAdded() {
      if (!addedAny) return;
      var b = document.getElementById("sampleBtn");
      if (b) setTimeout(function () { b.click(); }, 300);
    }

    var row = el("div", "fi-row");
    var out = el("button", "fi-btn ghost", "Sign out");
    var close = el("button", "fi-btn ghost", "Close");
    var save = el("button", "fi-btn", "Save");
    out.type = close.type = save.type = "button";
    row.appendChild(out);
    row.appendChild(el("span", "fi-spacer"));
    row.appendChild(close);
    row.appendChild(save);
    card.appendChild(row);
    veil.appendChild(card);
    document.body.appendChild(veil);

    close.addEventListener("click", function () { veil.remove(); refreshIfAdded(); });
    out.addEventListener("click", function () {
      try { localStorage.removeItem(LS_KEY); } catch (e) {}
      location.reload();
    });
    save.addEventListener("click", function () {
      save.disabled = true;
      // An unedited default stays "default" (empty) server-side, so future
      // improvements to the built-in persona reach users who never changed it.
      var personaOut = ta.value.trim() === (profile.personaDefault || "").trim() ? "" : ta.value;
      fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: nameIn.value,
          persona: personaOut,
          topics: taT.value.split("\n").map(function (t) { return t.trim(); }).filter(Boolean)
        })
      }).then(function (res) {
        if (!res.ok) throw new Error("save failed");
        return res.json();
      }).then(function (data) {
        signedIn(data);
        veil.remove();
        refreshIfAdded();
        toast("Saved — your next scan and draft use this persona.");
      }).catch(function () {
        save.disabled = false;
        toast("Could not save — try again.");
      });
    });
  }

  // Clear the coverage note (called at scan START via the patched scan flow, so
  // a stale note can't survive a failed or demo-mode scan that never reaches the
  // scan-done hook).
  window.__FI_COVERAGE_CLEAR__ = function () {
    var old = document.getElementById("fiCoverage");
    if (old) old.remove();
  };

  // Coverage note (called by ingest.js's post-scan audit): emptyTopics is the
  // list of tracked topics that none of the surfaced trends addressed.
  window.__FI_COVERAGE__ = function (emptyTopics) {
    window.__FI_COVERAGE_CLEAR__();
    var topics = window.__FI_TOPICS__ || [];
    if (!topics.length) return;
    // Keep only genuinely-tracked topics (defend against the model echoing junk).
    var empty = (emptyTopics || []).filter(function (t) {
      return topics.some(function (x) { return x.toLowerCase() === String(t).toLowerCase(); });
    });
    var note = document.createElement("div");
    note.id = "fiCoverage";
    note.className = "fi-coverage";
    if (!empty.length) {
      note.textContent = "Tracked topics: all " + topics.length + " were addressed by this cycle's trends.";
    } else {
      note.textContent = "No trend this cycle on: " + empty.join(" · ") +
        " — absence of expected change can itself be a signal (CSF). Consider adding sources for these topics.";
    }
    var cols = document.getElementById("columns");
    if (cols) cols.insertAdjacentElement("beforebegin", note);
  };

  // --- boot: probe the server; open mode shows nothing ---
  function boot() {
    fetch("/api/profile").then(function (res) {
      if (res.status === 401) {
        var hadSaved = !!code;
        code = "";
        showGate(hadSaved ? "Your saved code no longer works — enter a current one." : "");
        return null;
      }
      if (!res.ok) return null; // older server / endpoint missing: stay invisible
      return res.json();
    }).then(function (data) {
      if (data && data.user) signedIn(data);
      // data.user === null -> open mode (no gate configured): stay invisible
    }).catch(function () { /* offline: leave the app alone */ });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
