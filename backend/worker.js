/**
 * Futures Intelligence — live AI engine (Cloudflare Worker)
 * --------------------------------------------------------------------------
 * The ONE piece that can't live on GitHub Pages: it holds your Anthropic API
 * key and makes the model call. Your page (on GitHub Pages) POSTs the chat
 * messages here; this Worker forwards them to Anthropic and returns the text.
 *
 * Deploy: see ../SETUP.md  (paste this into the Cloudflare dashboard editor,
 * add ANTHROPIC_API_KEY as a Secret, copy the Worker URL into index.html).
 *
 * The API key is NEVER in this file or in your repo — it's read at runtime
 * from env.ANTHROPIC_API_KEY, a Cloudflare Secret.
 */

// ── Config you may want to change ──────────────────────────────────────────
// Cheap + plenty capable for this extraction/email task. Swap to
// "claude-haiku-4-5" (cheaper) or "claude-opus-4-8" (max quality) anytime.
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4096;

// Only your site may call this Worker (stops strangers spending your credits
// from a browser). Set this to YOUR GitHub Pages origin — scheme + host only,
// no path. Adjust if your username or custom domain differs.
const ALLOWED_ORIGIN = "https://aaronlbp7.github.io";
// ───────────────────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  // Echo the allowed origin back; fall back to it for non-browser callers.
  const allow = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    // Browser preflight for the cross-origin POST.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405, origin);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: "ANTHROPIC_API_KEY secret is not set on the Worker" }, 500, origin);
    }

    let messages;
    try {
      ({ messages } = await request.json());
    } catch (e) {
      return json({ error: "invalid JSON body" }, 400, origin);
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: "missing messages[]" }, 400, origin);
    }

    let apiRes;
    try {
      apiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, messages }),
      });
    } catch (e) {
      return json({ error: "could not reach Anthropic: " + e.message }, 502, origin);
    }

    const data = await apiRes.json().catch(() => null);
    if (!apiRes.ok) {
      const msg = (data && data.error && data.error.message) || ("Anthropic error " + apiRes.status);
      return json({ error: msg }, apiRes.status, origin);
    }

    // The app expects the raw model text (it parses the JSON itself).
    const text = Array.isArray(data.content)
      ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("")
      : "";

    return json({ text }, 200, origin);
  },
};
