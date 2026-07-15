# Futures Intelligence — Airbase deploy with live AI (same-origin backend)
#
# A tiny zero-dependency Node server (server.mjs) serves the CSP-compliant dist/
# build AND exposes POST /api/complete, which forwards to the Anthropic API using
# ANTHROPIC_API_KEY (injected by Airbase from .env.local at deploy — never baked
# into this image). Rebuild dist/ first:  node build-airbase.mjs
#
# The Airbase-managed node image runs as non-root `app`, workdir /app, and the
# server listens on $PORT (Airbase sets it; falls back to 3000 = airbase.json port).
FROM gdssingapore/airbase:node-22
WORKDIR /app
COPY --chown=app:app server.mjs /app/server.mjs
COPY --chown=app:app dist/ /app/dist/
# The scan engine's memory (data/store.json) lives here. Ephemeral across
# redeploys — snapshot via GET /api/export before shipping code changes.
RUN mkdir -p /app/data && chown app:app /app/data
USER app
CMD ["node", "server.mjs"]
