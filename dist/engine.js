(function () {
    // Deployed Cloudflare Worker URL, e.g. "https://futures-engine.<name>.workers.dev/"
    var ENGINE_URL = "/api/complete";

    // If the host already provides the engine, or the URL is unset, do nothing.
    if (window.claude && typeof window.claude.complete === "function") return;
    if (!ENGINE_URL || ENGINE_URL.indexOf("REPLACE-WITH-YOUR-WORKER") !== -1) return;

    window.claude = {
      complete: async function (request) {
        var res = await fetch(ENGINE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: request.messages })
        });
        if (!res.ok) {
          var detail = "";
          try { detail = (await res.json()).error || ""; } catch (e) {}
          throw new Error("engine " + res.status + (detail ? " — " + detail : ""));
        }
        return (await res.json()).text;
      }
    };
  })();
