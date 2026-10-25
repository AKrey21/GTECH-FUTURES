// Source map — a network graph of the watched sources (Airbase build only).
//
// Answers "why is this source on the list?" visually, twitchmap-style:
//   bubble  = a source, sized by the usable signals it contributed
//   colour  = its CSF handbook source type (press, journals, think tanks,
//             government, different languages, forums, self-publishing…)
//   line    = a relationship: GREEN when the issue ledger matched the two
//             sources' signals to the same development (confirmed
//             corroboration); GREY when their articles sit on the same ground
//             (embedding overlap, from /api/graph), thicker for more.
// Reading it: a central, well-connected source confirms what others report; a
// source at the edge that still gets cited is a unique lens worth keeping for
// breadth; a floating bubble that is never cited is a rotation candidate.
// Zero dependencies (the Airbase CSP allows only same-origin scripts): a small
// force layout on a canvas.
(function () {
  if (window.__FI_GRAPH__) return;
  window.__FI_GRAPH__ = true;

  // Colour = the ROLE a source plays for the briefing's purpose (inform
  // leadership about the future ahead and what it means for SWDA):
  //   Sees early   — carries developments before they are mainstream
  //   Sees wide    — brings a direction the rest of the list would miss
  //   Confirms     — of record, lets a finding be said with confidence
  // The role is MEASURED from the issue ledger once a source has been on two
  // or more shared issues (first-reporter vs confirmer); until then it is the
  // default for its CSF source type, and the tooltip says which.
  var ROLES = {
    early: ["Sees early", "#c95c6a"],
    wide: ["Sees wide", "#c0893a"],
    confirms: ["Confirms", "#3e8e6a"],
  };
  // Two tiers, one rule each: tier 1 is OF RECORD (what a briefing would cite
  // anyway); tier 2 is EARLY WARNING and keeps its place only by measurably
  // being first — the server grades it earned / on probation / at risk.
  var TIERS = {
    "of record": ["Tier 1 · of record", "#3e8e6a"],
    "earned": ["Tier 2 · early warning, earned", "#c95c6a"],
    "probation": ["Tier 2 · on probation", "#d2a640"],
    "at risk": ["Tier 2 · at risk", "#9aa39b"],
    "tester-added": ["Added by a tester", "#5b7fb5"],
  };
  var FAMILIES = [
    [/^(Trade press|Press)/i, "Press", "confirms"],
    [/^(Journals|Research)/i, "Journals & research", "early"],
    [/^(Think tanks|Analysts)/i, "Think tanks & analysts", "confirms"],
    [/^(Government|Foresight)/i, "Government & foresight", "confirms"],
    [/^Different languages/i, "Different languages", "wide"],
    [/^(Forums|Self-publishing|Commentary)/i, "Forums & self-publishing", "early"],
    [/^Labour-market data/i, "Labour-market data", "confirms"],
  ];
  function familyOf(name) {
    var kinds = window.__FI_KIND__ || {};
    var full = kinds[name] || "";
    var label = full.split("·")[0].trim();
    // The catalog marks regional / environmental lenses in the label's detail
    // ("· Singapore lens", "· East Asia", "· care economy"): those widen the view.
    var wide = /regional|east asia|asean|environment|climate|care economy|green/i.test(full);
    for (var i = 0; i < FAMILIES.length; i++) if (FAMILIES[i][0].test(label)) return { family: FAMILIES[i][1], role: wide && FAMILIES[i][2] !== "early" ? "wide" : FAMILIES[i][2], label: label };
    return { family: "Other", role: "confirms", label: label || "uncategorised" };
  }
  function roleOf(n, f) {
    var shared = (n.firstOn || 0) + (n.confirmedOn || 0);
    if (shared >= 2) return { role: n.firstOn > n.confirmedOn ? "early" : "confirms", measured: true };
    return { role: f.role, measured: false };
  }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  function showGraph() {
    var veil = document.createElement("div");
    veil.className = "fi-veil";
    var card = document.createElement("div");
    card.className = "fi-card fi-graph-card";
    card.innerHTML = '<h3>Source map</h3><p class="fi-sub">Loading…</p>';
    veil.appendChild(card);
    veil.addEventListener("click", function (e) { if (e.target === veil) veil.remove(); });
    document.body.appendChild(veil);

    fetch("/api/graph").then(function (r) { return r.json(); }).then(function (g) {
      render(card, g, function () { veil.remove(); });
    }).catch(function () {
      card.innerHTML = '<h3>Source map</h3><p class="fi-sub">Could not load the source map.</p>';
    });
  }

  function render(card, g, close) {
    var nodes = (g.nodes || []).filter(function (n) { return n.kept > 0 || n.isDefault; });
    if (!nodes.length) {
      card.innerHTML = '<h3>Source map</h3><p class="fi-sub">No signals yet — the map fills after the first daily pull.</p>';
      return;
    }
    var byName = {};
    var colourByType = {};
    nodes.forEach(function (n) {
      var f = familyOf(n.name), r = roleOf(n, f);
      n.family = f.family; n.label = f.label; n.roleKey = r.role; n.measured = r.measured;
      n.roleName = ROLES[r.role][0];
      var t = TIERS[n.status] || TIERS["tester-added"];
      n.type = t[0]; n.colour = t[1];
      colourByType[n.type] = n.colour;
      n.r = 10 + Math.sqrt(n.kept) * 4.2;
      n.deg = 0; n.corro = 0;
      byName[n.name] = n;
    });
    var all = (g.edges || []).filter(function (e) { return byName[e.a] && byName[e.b]; });
    all.forEach(function (e) { e.A = byName[e.a]; e.B = byName[e.b]; });
    // Keep the map readable: every confirmed corroboration, plus each source's
    // three strongest overlaps. Weak ties that are nobody's top three are not
    // drawn (the tooltip still lists a source's strongest relations).
    var keep = {};
    nodes.forEach(function (n) {
      all.filter(function (e) { return (e.A === n || e.B === n) && e.pairs > 0; })
        .sort(function (x, y) { return y.overlap - x.overlap; }).slice(0, 3)
        .forEach(function (e) { keep[e.a + "\u0000" + e.b] = true; });
    });
    var edges = all.filter(function (e) { return e.corroborated || keep[e.a + "\u0000" + e.b]; });
    edges.forEach(function (e) {
      e.A.deg++; e.B.deg++;
      if (e.corroborated) { e.A.corro++; e.B.corro++; }
    });
    var types = [];
    nodes.forEach(function (n) { if (types.indexOf(n.type) === -1) types.push(n.type); });
    var isolated = nodes.filter(function (n) { return !n.deg; });

    var W = Math.min(900, Math.max(560, window.innerWidth - 80)), H = Math.min(560, Math.max(400, window.innerHeight - 260));
    card.innerHTML =
      '<h3>Source map</h3>' +
      '<p class="fi-sub">Why each source is followed. <b>Inner ring, tier 1:</b> of record — what a briefing would cite anyway, read systematically. ' +
      '<b>Outer ring, tier 2:</b> early warning — on the list only while the ledger shows it reports developments before tier 1 confirms them ' +
      '(earned = first on 2+ developments or cited in a scan; 30 days of probation first). Bubble size = usable signals. ' +
      '<span class="fi-g-key"><i style="background:#2f6b3a"></i>same issue in the ledger (confirmed corroboration)</span> ' +
      '<span class="fi-g-key"><i style="background:#b9bfb4"></i>articles on the same ground (embedding similarity ≥ ' + g.sim + ')</span>. ' +
      'Hover a bubble for its record; click to pin its neighbours.</p>' +
      '<div class="fi-g-wrap"><canvas class="fi-g-canvas" width="' + W + '" height="' + H + '"></canvas><div class="fi-g-tip" hidden></div></div>' +
      '<div class="fi-g-legend">' + types.map(function (t) {
        return '<span><i style="background:' + colourByType[t] + '"></i>' + esc(t) + '</span>';
      }).join("") + '</div>' +
      (function () {
        // Tier 1 is closed, so an unlinked of-record source is just one with no
        // shared development yet; the rotation warning applies to tier 2 and
        // tester-added sources only.
        var t1 = isolated.filter(function (n) { return n.tier === 1; }), rest = isolated.filter(function (n) { return n.tier !== 1; });
        var html = '';
        if (t1.length) html += '<p class="fi-sub" style="margin-top:10px">Of record, no shared development yet: <b>' + t1.map(function (n) { return esc(n.name); }).join("</b>, <b>") + '</b>.</p>';
        if (rest.length) html += '<p class="fi-sub" style="margin-top:' + (t1.length ? 4 : 10) + 'px">No relationship found yet: <b>' + rest.map(function (n) { return esc(n.name); }).join("</b>, <b>") +
          '</b> — keeps its place only if it is first on developments or earns citations.</p>';
        return html;
      })() +
      '<div class="fi-row"><span class="fi-sub" style="margin:0">' + nodes.length + ' sources · ' + edges.filter(function (e) { return e.corroborated; }).length +
        ' corroborating pair' + (edges.filter(function (e) { return e.corroborated; }).length === 1 ? '' : 's') + ' · ' + edges.length + ' related pair' + (edges.length === 1 ? '' : 's') +
        '</span><span class="fi-spacer"></span><button class="fi-btn ghost" id="fiGraphClose" type="button">Close</button></div>';
    card.querySelector("#fiGraphClose").addEventListener("click", close);

    var canvas = card.querySelector(".fi-g-canvas"), ctx = canvas.getContext("2d"), tip = card.querySelector(".fi-g-tip");
    var dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.scale(dpr, dpr);

    // ---- force layout: repulsion between all bubbles, springs along edges,
    //      gentle pull to the centre; related sources settle together ----
    // ---- two rings: tier 1 (of record) inside, tier 2 and tester-added
    //      outside. A tier-2 source sits at the angle of the tier-1 source it
    //      relates to most, so its lines are short and its place on the list
    //      is visibly about who confirms it. ----
    var cx = W / 2, cy = H / 2 - 6;
    var inner = nodes.filter(function (n) { return n.tier === 1; }), outer = nodes.filter(function (n) { return n.tier !== 1; });
    var R1 = Math.min(W * 0.3, H * 0.25), R2 = Math.min(W * 0.45, H * 0.42);
    if (!inner.length) { inner = outer; outer = []; R1 = R2; }
    inner.forEach(function (n, i) {
      var a = -Math.PI / 2 + (i / inner.length) * Math.PI * 2;
      n.a = a; n.x = cx + Math.cos(a) * R1; n.y = cy + Math.sin(a) * R1;
    });
    function partnerAngle(n) {
      var best = null, score = -1;
      edges.forEach(function (e) {
        var o = e.A === n ? e.B : e.B === n ? e.A : null;
        if (!o || o.tier !== 1) return;
        var sc = e.corroborated * 10 + e.pairs;
        if (sc > score) { score = sc; best = o; }
      });
      return best ? best.a : null;
    }
    // Place by partner angle, then spread anything closer than ~one bubble apart.
    outer.forEach(function (n, i) { var pa = partnerAngle(n); n.a = pa === null ? -Math.PI / 2 + ((i + 0.5) / outer.length) * Math.PI * 2 : pa; });
    outer.sort(function (p, q) { return p.a - q.a; });
    var minGap = outer.length ? Math.max(0.35, (Math.PI * 2) / outer.length * 0.85) : 0;
    for (var pass = 0; pass < 6; pass++) {
      for (var i2 = 1; i2 < outer.length; i2++) if (outer[i2].a - outer[i2 - 1].a < minGap) outer[i2].a = outer[i2 - 1].a + minGap;
      if (outer.length > 1 && outer[0].a + Math.PI * 2 - outer[outer.length - 1].a < minGap) { var shift = (minGap - (outer[0].a + Math.PI * 2 - outer[outer.length - 1].a)) / 2; outer.forEach(function (n, k2) { n.a -= shift * (k2 / outer.length); }); }
    }
    outer.forEach(function (n) { n.x = cx + Math.cos(n.a) * R2 * 1.0; n.y = cy + Math.sin(n.a) * R2; });
    nodes.forEach(function (n) { n.x = Math.max(n.r + 8, Math.min(W - n.r - 8, n.x)); n.y = Math.max(n.r + 8, Math.min(H - n.r - 22, n.y)); });
    // faint ring guides
    function rings() {
      ctx.save(); ctx.strokeStyle = "rgba(140,148,140,.22)"; ctx.setLineDash([4, 6]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(cx, cy, R1, R1, 0, 0, Math.PI * 2); ctx.stroke();
      if (outer.length) { ctx.beginPath(); ctx.ellipse(cx, cy, R2, R2, 0, 0, Math.PI * 2); ctx.stroke(); }
      ctx.restore();
    }

    var hover = null, pinned = null;
    function neighbours(n) {
      var set = {}; set[n.name] = true;
      edges.forEach(function (e) { if (e.A === n) set[e.B.name] = true; if (e.B === n) set[e.A.name] = true; });
      return set;
    }
    function draw() {
      ctx.clearRect(0, 0, W, H);
      rings();
      var focus = pinned || hover, near = focus ? neighbours(focus) : null;
      edges.forEach(function (e) {
        var dim = near && !(near[e.A.name] && near[e.B.name] && (e.A === focus || e.B === focus));
        ctx.beginPath(); ctx.moveTo(e.A.x, e.A.y); ctx.lineTo(e.B.x, e.B.y);
        if (e.corroborated) { ctx.strokeStyle = dim ? "rgba(47,107,58,.12)" : "rgba(47,107,58,.75)"; ctx.lineWidth = 1.5 + Math.min(4, e.corroborated) * 1.2; }
        else { ctx.strokeStyle = dim ? "rgba(140,148,140,.10)" : "rgba(140,148,140,.5)"; ctx.lineWidth = 1 + Math.min(6, e.pairs) * 0.7; }
        ctx.stroke();
      });
      nodes.forEach(function (n) {
        var dim = near && !near[n.name];
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = n.colour; ctx.globalAlpha = dim ? 0.18 : 0.92; ctx.fill();
        ctx.globalAlpha = dim ? 0.2 : 1; ctx.lineWidth = n === focus ? 3 : 1.2; ctx.strokeStyle = n === focus ? "#2d3a31" : "rgba(255,255,255,.9)"; ctx.stroke();
        ctx.globalAlpha = dim ? 0.25 : 1;
        ctx.fillStyle = "#2d3a31"; ctx.font = "11.5px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
        var label = n.name.length > 26 ? n.name.slice(0, 25) + "…" : n.name;
        var half = ctx.measureText(label).width / 2;   // keep the label inside the canvas
        ctx.fillText(label, Math.max(half + 4, Math.min(W - half - 4, n.x)), n.y + n.r + 3);
        ctx.globalAlpha = 1;
      });
    }
    draw();

    function at(x, y) {
      for (var i = nodes.length - 1; i >= 0; i--) { var n = nodes[i], dx = x - n.x, dy = y - n.y; if (dx * dx + dy * dy <= n.r * n.r) return n; }
      return null;
    }
    function tipFor(n) {
      var rel = edges.filter(function (e) { return e.A === n || e.B === n; })
        .sort(function (a, b) { return (b.corroborated - a.corroborated) || (b.overlap - a.overlap); }).slice(0, 4);
      var dom = Object.keys(n.domains || {}).sort(function (a, b) { return n.domains[b] - n.domains[a]; }).slice(0, 3)
        .map(function (d) { return d + " " + n.domains[d]; }).join(", ");
      var shared = (n.firstOn || 0) + (n.confirmedOn || 0);
      var record = shared || n.solo
        ? 'First to carry ' + (n.firstOn || 0) + ' development' + (n.firstOn === 1 ? '' : 's') + ' others later confirmed · confirmed ' + (n.confirmedOn || 0) +
          (n.solo ? ' · ' + n.solo + ' only it has reported' : '') +
          (n.firstExamples && n.firstExamples.length ? ' — e.g. “' + esc(n.firstExamples[0].slice(0, 70)) + '”' : '')
        : 'No shared development in the ledger yet';
      var rule = n.tier === 2
        ? (n.status === 'earned' ? 'Keeps its place: ' : n.status === 'probation' ? 'On probation (30 days to show it): ' : 'At risk of rotating out: ') +
          'the rule is first on 2+ developments others confirm, or cited in a scan.'
        : n.tier === 1 ? 'Closed tier: on the list because a briefing would cite it anyway.' : '';
      var html = '<b>' + esc(n.name) + '</b><br><span class="fi-g-type" style="color:' + n.colour + '">' + esc(n.type) + '</span>' +
        (n.why ? '<div class="fi-g-row fi-g-why">' + esc(n.why) + '</div>' : '') +
        (rule ? '<div class="fi-g-row">' + esc(rule) + '</div>' : '') +
        '<div class="fi-g-row">Role: ' + esc(n.roleName) + (n.measured ? ' (measured)' : ' (by source type: ' + esc(n.label || n.family) + ')') + '</div>' +
        '<div class="fi-g-row">' + esc(record) + '</div>' +
        '<div class="fi-g-row">' + n.kept + ' usable signal' + (n.kept === 1 ? '' : 's') + (n.discarded ? ' (' + n.discarded + ' filtered out)' : '') +
        ' · in ' + n.issues + ' tracked issue' + (n.issues === 1 ? '' : 's') + ' · cited in ' + n.cited + ' of ' + n.scans + ' scan' + (n.scans === 1 ? '' : 's') + '</div>' +
        (dom ? '<div class="fi-g-row">STEEPLE: ' + esc(dom) + '</div>' : '');
      if (rel.length) {
        html += '<div class="fi-g-row" style="margin-top:6px"><b>Related to</b></div>' + rel.map(function (e) {
          var other = e.A === n ? e.B : e.A;
          var why = e.corroborated ? '<span style="color:#2f6b3a">✓ ' + e.corroborated + ' shared issue' + (e.corroborated === 1 ? '' : 's') + (e.issues && e.issues[0] ? ': ' + esc(e.issues[0]) : '') + '</span>'
            : e.pairs + ' related article pair' + (e.pairs === 1 ? '' : 's') + (e.example ? ' — e.g. “' + esc(e.example.a.slice(0, 60)) + '” ↔ “' + esc(e.example.b.slice(0, 60)) + '”' : '');
          return '<div class="fi-g-row">· <b>' + esc(other.name) + '</b> — ' + why + '</div>';
        }).join("");
      } else {
        html += '<div class="fi-g-row" style="margin-top:6px">No related source yet — ' + (n.cited ? 'a unique lens the scans cite.' : 'watch whether scans ever cite it.') + '</div>';
      }
      return html;
    }
    // Tooltip beside the bubble, flipped left near the right edge and clamped
    // to the canvas after measuring, so a long record never runs off it.
    function placeTip(n) {
      tip.innerHTML = tipFor(n); tip.hidden = false;
      var tw = tip.offsetWidth || 330, th = tip.offsetHeight || 160;
      var tx = n.x + n.r + 12, ty = n.y - 10;
      if (tx + tw > W - 4) tx = n.x - n.r - tw - 12;
      tip.style.left = Math.max(4, tx) + "px";
      tip.style.top = Math.max(4, Math.min(H - th - 4, ty)) + "px";
    }
    canvas.addEventListener("mousemove", function (ev) {
      var rect = canvas.getBoundingClientRect(), n = at(ev.clientX - rect.left, ev.clientY - rect.top);
      if (n !== hover) { hover = n; draw(); }
      if (n) {
        if (!pinned || n === pinned) placeTip(n);
        canvas.style.cursor = "pointer";
      } else if (!pinned) { tip.hidden = true; canvas.style.cursor = "default"; }
    });
    canvas.addEventListener("mouseleave", function () { hover = null; if (!pinned) tip.hidden = true; draw(); });
    canvas.addEventListener("click", function (ev) {
      var rect = canvas.getBoundingClientRect(), n = at(ev.clientX - rect.left, ev.clientY - rect.top);
      pinned = (n && n !== pinned) ? n : null;
      if (pinned) placeTip(pinned); else tip.hidden = true;
      draw();
    });
  }

  // Entry point: a "Source map" link beside "Engine audit" in the cadence line.
  // ingest.js rewrites that line on each pull, so re-attach whenever it changes.
  function attach() {
    var meta = document.querySelector(".cad-meta");
    if (!meta || meta.querySelector(".fi-graph-link")) return;
    var audit = meta.querySelector(".fi-audit");
    if (!audit) return;
    var sep = document.createTextNode(" · ");
    var a = document.createElement("a");
    a.href = "#"; a.className = "fi-audit fi-graph-link"; a.textContent = "Source map";
    a.title = "How the watched sources corroborate and overlap";
    a.addEventListener("click", function (e) { e.preventDefault(); showGraph(); });
    audit.parentNode.insertBefore(sep, audit.nextSibling);
    audit.parentNode.insertBefore(a, sep.nextSibling);
  }
  var style = document.createElement("style");
  style.textContent =
    ".fi-graph-card{max-width:960px;width:calc(100vw - 48px);}" +
    ".fi-g-wrap{position:relative;border:1px solid #d8dccb;border-radius:12px;background:#fff;overflow:hidden;}" +
    ".fi-g-canvas{display:block;}" +
    ".fi-g-tip{position:absolute;max-width:330px;background:#fbfaf5;border:1px solid #c9cfba;border-radius:10px;padding:9px 11px;font-size:12px;color:#2d3a31;box-shadow:0 8px 24px rgba(0,0,0,.14);pointer-events:none;line-height:1.4;}" +
    ".fi-g-tip[hidden]{display:none;}" +
    ".fi-g-type{font-size:11px;letter-spacing:.04em;text-transform:uppercase;}" +
    ".fi-g-row{margin-top:3px;color:#3c4a40;}" +
    ".fi-g-why{font-style:italic;color:#2d3a31;margin:5px 0 4px;}" +
    ".fi-g-legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin:10px 0 2px;font-size:12px;color:#3c4a40;}" +
    ".fi-g-legend i,.fi-g-key i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px;}" +
    ".fi-g-key i{border-radius:2px;height:4px;width:18px;vertical-align:2px;}" +
    ".fi-g-key{white-space:nowrap;}";
  document.head.appendChild(style);

  function wire() {
    attach();
    var meta = document.querySelector(".cad-meta");
    if (meta && window.MutationObserver) new MutationObserver(attach).observe(meta, { childList: true });
    setTimeout(attach, 1200);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
