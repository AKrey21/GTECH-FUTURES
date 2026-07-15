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

  function downloadEml() {
    var p = emailParts();
    if (!p) return;
    var eml =
      "X-Unsent: 1\r\n" +
      "Subject: " + p.subject.replace(/[\r\n]+/g, " ") + "\r\n" +
      "To: \r\n" +
      "MIME-Version: 1.0\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      "\r\n" +
      p.body.replace(/\n/g, "\r\n");
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
