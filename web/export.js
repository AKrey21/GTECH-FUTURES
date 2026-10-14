// Outlook export for the drafted briefing (Airbase build).
// No Microsoft Graph / no auth: two zero-API handoffs that work with the
// standard gov Outlook desktop client —
//   1) "Open in Outlook" — a mailto: link (subject+body prefilled; body capped,
//      as mail clients truncate very long mailto bodies).
//   2) "Download .eml" — an RFC-822 file with "X-Unsent: 1", which Outlook
//      opens as an EDITABLE DRAFT (full text, nothing truncated).
// The app exposes the composed plain-text email as window.__FI_EMAIL_TEXT__
// ("Subject: ...\n...body...").
(function () {
  if (window.__FI_EXPORT__) return;
  window.__FI_EXPORT__ = true;

  var MAILTO_BODY_CAP = 1800;

  function emailParts() {
    var txt = window.__FI_EMAIL_TEXT__ || "";
    if (!txt) return null;
    var m = txt.match(/^Subject:\s*(.+)\n/);
    var subject = m ? m[1].trim() : "Futures briefing";
    // Body = everything after the From/To header block's blank line.
    var body = txt.replace(/^Subject:.*\n(From:.*\n)?(To:.*\n)?\n?/, "");
    return { subject: subject, body: body };
  }

  function openMailto() {
    var p = emailParts();
    if (!p) return;
    var body = p.body.length > MAILTO_BODY_CAP
      ? p.body.slice(0, MAILTO_BODY_CAP) + "\n\n[Draft truncated for the mail link — use “Download draft (.eml)” for the full text.]"
      : p.body;
    window.location.href = "mailto:?subject=" + encodeURIComponent(p.subject) + "&body=" + encodeURIComponent(body);
  }

  // ---- styled .eml: parse the plain-text draft into a Word-renderer-proof
  // HTML template (desktop Outlook renders mail with Word's engine: spacing
  // and backgrounds survive ONLY on table cells, so the layout is all tables).
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function parseDraft(body) {
    var lines = body.split("\n");
    var doc = { greeting: "", intro: [], sections: [], footer: [] };
    var cur = null, afterSections = false;
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i], line = raw.trim();
      if (!line) continue;
      if (/^Future of .{2,40}$/.test(line)) {
        cur = { name: line, lede: [], bullets: [] };
        doc.sections.push(cur);
        continue;
      }
      if (cur && /^•/.test(line)) {
        var conf = (line.match(/\((High|Medium|Low)\)\s*$/) || [])[1] || "";
        cur.bullets.push({ text: line.replace(/^•\s*/, "").replace(/\s*\((High|Medium|Low)\)\s*$/, ""), conf: conf, sources: [] });
        continue;
      }
      if (cur && /^Sources:/.test(line) && cur.bullets.length) {
        line.replace(/^Sources:\s*/, "").split(/;\s+/).forEach(function (entry) {
          var k = entry.lastIndexOf(" — ");
          if (k > 0 && /^https?:\/\//.test(entry.slice(k + 3).trim())) {
            cur.bullets[cur.bullets.length - 1].sources.push({ label: entry.slice(0, k).trim(), url: entry.slice(k + 3).trim() });
          } else if (entry.trim()) {
            cur.bullets[cur.bullets.length - 1].sources.push({ label: entry.trim(), url: "" });
          }
        });
        continue;
      }
      if (/^(Please review|This cycle|—|AI-generated)/.test(line)) { afterSections = true; doc.footer.push(line); continue; }
      if (afterSections) { doc.footer.push(line); continue; }
      if (!cur) {
        if (/^Dear\b/.test(line)) doc.greeting = line;
        else doc.intro.push(line);
      } else cur.lede.push(line);
    }
    return doc.sections.length ? doc : null;
  }
  var CONF_COLOR = { High: "#FD5000", Medium: "#6b7280", Low: "#9ca3af" };
  function draftHtml() {
    var p = emailParts();
    if (!p) return null;
    var doc = parseDraft(p.body);
    if (!doc) return null;
    var F = "font-family:Arial,Helvetica,sans-serif;";
    var now = new Date();
    var MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    var h = [];
    h.push('<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#eef0f2;">');
    h.push('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef0f2"><tr><td align="center" style="padding:24px 10px;">');
    h.push('<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:640px;">');
    h.push('<tr><td height="4" bgcolor="#1003A3" style="font-size:0;line-height:0;">&nbsp;</td></tr>');
    // Logo intentionally omitted until Comms/management blesses official
    // branding — colors stay, and the PROTOTYPE tag says what this is.
    h.push('<tr><td style="padding:22px 34px 6px;' + F + 'font-size:11px;color:#1003A3;"><b>H O R I Z O N&nbsp;&nbsp;S C A N</b><span style="color:#9ca3af;font-size:10px;">&nbsp;&nbsp;&middot;&nbsp;&nbsp;PROTOTYPE</span></td></tr>');
    h.push('<tr><td style="padding:0 34px 4px;' + F + 'font-size:22px;color:#1f2937;"><b>' + esc(p.subject) + '</b></td></tr>');
    h.push('<tr><td style="padding:0 34px 16px;' + F + 'font-size:12px;color:#6b7280;">' + MONTHS[now.getMonth()] + ' ' + now.getFullYear() + ' &middot; horizon-scanning prototype &mdash; every claim links to its source</td></tr>');
    var introText = (doc.greeting ? doc.greeting + " " : "") + doc.intro.join(" ");
    if (introText) h.push('<tr><td style="padding:2px 34px 6px;' + F + 'font-size:14px;color:#374151;">' + esc(introText) + '</td></tr>');
    doc.sections.forEach(function (s) {
      h.push('<tr><td style="padding:18px 34px 2px;' + F + 'font-size:11px;color:#1003A3;"><b>' + esc(s.name.toUpperCase()) + '</b></td></tr>');
      if (s.lede.length) h.push('<tr><td style="padding:2px 34px 8px;' + F + 'font-size:13px;color:#374151;">' + esc(s.lede.join(" ")) + '</td></tr>');
      s.bullets.forEach(function (b) {
        var confTag = b.conf ? ' &nbsp;<span style="color:' + CONF_COLOR[b.conf] + ';font-size:10px;"><b>' + b.conf.toUpperCase() + ' CONFIDENCE</b></span>' : '';
        var k = b.text.indexOf(" — ");
        var head = k > 0 ? b.text.slice(0, k) : b.text;
        var rest = k > 0 ? b.text.slice(k + 3) : "";
        h.push('<tr><td style="padding:0 34px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>');
        h.push('<td width="3" bgcolor="#1003A3" style="font-size:0;">&nbsp;</td>');
        h.push('<td bgcolor="#f6f7f8" style="padding:9px 14px;' + F + 'font-size:13px;color:#1f2937;"><b>' + esc(head) + '</b>' + confTag + (rest ? '<br>' + esc(rest) : ''));
        if (b.sources.length) {
          h.push('<br><span style="font-size:11px;color:#6b7280;">' + b.sources.map(function (src) {
            return src.url ? '<a href="' + esc(src.url) + '" style="color:#1003A3;">' + esc(src.label) + '</a>' : esc(src.label);
          }).join(' &middot; ') + '</span>');
        }
        h.push('</td></tr></table></td></tr>');
      });
    });
    if (doc.footer.length) {
      h.push('<tr><td style="padding:14px 34px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="1" bgcolor="#e2e5e8" style="font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>');
      h.push('<tr><td style="padding:12px 34px 24px;' + F + 'font-size:11px;color:#9ca3af;">' + doc.footer.map(esc).join('<br>') + '</td></tr>');
    }
    h.push('</table></td></tr></table></body></html>');
    return h.join('');
  }
  window.__FI_EML_HTML__ = draftHtml;   // exposed for tests/preview

  function downloadEml() {
    var p = emailParts();
    if (!p) return;
    var html = null;
    try { html = draftHtml(); } catch (e) { /* fall back to plain text */ }
    var eml =
      "X-Unsent: 1\r\n" +
      "Subject: " + p.subject.replace(/[\r\n]+/g, " ") + "\r\n" +
      "To: \r\n" +
      "MIME-Version: 1.0\r\n" +
      (html
        ? "Content-Type: text/html; charset=utf-8\r\n\r\n" + html
        : "Content-Type: text/plain; charset=utf-8\r\n\r\n" + p.body.replace(/\n/g, "\r\n"));
    var blob = new Blob([eml], { type: "message/rfc822" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "futures-briefing-draft.eml";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  function makeBtn(id, text, onClick) {
    var b = document.createElement("button");
    b.id = id;
    b.type = "button";
    b.className = "btn btn-ghost";      // match the app's existing button styling
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }

  function ensureButtons() {
    var copyBtn = document.getElementById("copyBtn");
    var emailWrap = document.getElementById("emailWrap");
    if (!copyBtn || !emailWrap) return;
    var drafted = !emailWrap.hidden && window.__FI_EMAIL_TEXT__;
    var existing = document.getElementById("fiOutlookBtn");
    if (drafted && !existing) {
      var outlook = makeBtn("fiOutlookBtn", "Open in Outlook", openMailto);
      var eml = makeBtn("fiEmlBtn", "Download draft (.eml)", downloadEml);
      copyBtn.parentNode.insertBefore(outlook, copyBtn.nextSibling);
      copyBtn.parentNode.insertBefore(eml, outlook.nextSibling);
    } else if (!drafted && existing) {
      existing.remove();
      var e2 = document.getElementById("fiEmlBtn");
      if (e2) e2.remove();
    }
  }

  function wire() {
    var emailWrap = document.getElementById("emailWrap");
    if (!emailWrap) return;
    new MutationObserver(ensureButtons).observe(emailWrap, { attributes: true, attributeFilter: ["hidden"], childList: true, subtree: true });
    ensureButtons();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
