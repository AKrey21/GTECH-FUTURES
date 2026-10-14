(function () {
    // Deployed Cloudflare Worker URL, e.g. "https://futures-engine.<name>.workers.dev/"
    var ENGINE_URL = "/api/complete";

    // If the host already provides the engine, or the URL is unset, do nothing.
    if (window.claude && typeof window.claude.complete === "function") return;
    if (!ENGINE_URL || ENGINE_URL.indexOf("REPLACE-WITH-YOUR-WORKER") !== -1) return;

    window.claude = {
      complete: async function (request) {
        // On a gateway timeout (502/504, or the edge's HTML error page),
        // retry ONCE as a fresh request on the fast model. Two separate
        // requests each fit the 60s limits; one long one would not.
        // `schema` asks the server to validate/repair the output against a
        // named JSON schema (lib/structured.mjs); `purpose` and `fallback`
        // label the call in the LLM telemetry.
        var FAST = "azure.claude-haiku-4-5";
        async function attempt(model, fallback) {
          var res = await fetch(ENGINE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: request.messages, model: model || undefined,
              schema: request.schema || undefined, purpose: request.purpose || undefined, fallback: fallback || undefined })
          });
          var data = null;
          try { data = await res.json(); } catch (e) { /* edge HTML page */ }
          if (!res.ok || !data || typeof data.text !== "string") {
            var err = new Error("engine " + res.status + (data && data.error ? " — " + data.error : ""));
            err.retryable = res.status === 502 || res.status === 504 || !data;
            throw err;
          }
          return data.text;
        }
        var chosen = window.__FI_MODEL__ || undefined;
        try {
          return await attempt(chosen);
        } catch (e) {
          if (!e.retryable || chosen === FAST) throw e;
          window.__FI_FELL_BACK__ = true;
          console.warn("engine: " + (e.message || "timeout") + " — retrying on the fast model");
          return await attempt(FAST, true);
        }
      }
    };
  })();
