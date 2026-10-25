// LLM observability: one record per model call, whatever the call site.
//
// Every gateway request — scan, brief, audit, schema repair, triage, embeddings,
// retrieval queries — reports here: model, latency, status, token usage (from
// the gateway's `usage`, else a chars/4 estimate flagged `est`), cost, schema
// outcome, grounding, injection hits and congestion fallbacks. Records live in
// a ring buffer and append to a JSONL file beside the store (same lifetime as
// the store; rotated at 5 MB), and /api/metrics serves aggregates.
//
// Cost needs the gateway's actual per-model rates, which differ from vendor list
// prices, so they come from env: LLM_PRICES='{"gpt-5.5":[in,out],...}' in USD
// per million tokens. Unpriced models report tokens only — never a guessed cost.
import fs from 'node:fs';
import path from 'node:path';

export function estimateTokens(s) {
  return Math.ceil(String(s || '').length / 4);
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

export function createTelemetry({ file, max = 5000, prices = {}, maxBytes = 5e6 } = {}) {
  const buf = [];
  if (file) {
    try {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-max);
      for (const l of lines) { try { buf.push(JSON.parse(l)); } catch { /* torn line */ } }
    } catch { /* fresh */ }
  }

  function costOf(ev) {
    const p = prices[ev.model];
    if (!Array.isArray(p) || ev.inTok == null) return null;
    return (ev.inTok * p[0] + (ev.outTok || 0) * p[1]) / 1e6;
  }

  function record(ev) {
    const rec = { ts: Date.now(), ...ev };
    const c = costOf(rec);
    if (c !== null) rec.cost = Math.round(c * 1e6) / 1e6;
    buf.push(rec);
    if (buf.length > max) buf.splice(0, buf.length - max);
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try { if (fs.statSync(file).size > maxBytes) fs.renameSync(file, file + '.1'); } catch { /* no file yet */ }
        fs.appendFile(file, JSON.stringify(rec) + '\n', () => {});
      } catch { /* telemetry must never break a request */ }
    }
    return rec;
  }

  function agg(rows) {
    const lat = rows.filter(r => r.ok).map(r => r.ms).sort((a, b) => a - b);
    const sum = (f) => rows.reduce((a, r) => a + (+r[f] || 0), 0);
    const priced = rows.filter(r => r.cost != null);
    const schemaRows = rows.filter(r => r.schema);
    const s = (f) => schemaRows.filter(r => r.schema[f]).length;
    const out = {
      calls: rows.length,
      errors: rows.filter(r => !r.ok).length,
      errorRate: rows.length ? +(rows.filter(r => !r.ok).length / rows.length).toFixed(3) : 0,
      p50ms: pct(lat, 0.5), p95ms: pct(lat, 0.95),
      inTok: sum('inTok'), outTok: sum('outTok'),
      estimatedTokens: rows.filter(r => r.est).length,
      costUsd: priced.length ? +priced.reduce((a, r) => a + r.cost, 0).toFixed(4) : null,
      unpricedCalls: rows.length - priced.length,
      truncated: rows.filter(r => r.truncated).length,
      fallbacks: rows.filter(r => r.fallback).length,
      rateLimited: rows.filter(r => r.rateLimited).length,
      budgetExceeded: rows.filter(r => r.budgetExceeded).length,
      retried: rows.filter(r => r.retried).length,
      injectionHits: sum('injectionHits'),
    };
    if (schemaRows.length) {
      out.schema = {
        checked: schemaRows.length,
        firstPassValid: s('firstPassOk'),
        firstPassRate: +(s('firstPassOk') / schemaRows.length).toFixed(3),
        coerced: schemaRows.filter(r => r.schema.coercions > 0).length,
        salvaged: s('salvaged'),
        droppedItems: schemaRows.reduce((a, r) => a + (r.schema.dropped || 0), 0),
        repaired: s('repaired'),
        repairOk: s('repairOk'),
        finalValid: s('ok'),
        finalRate: +(s('ok') / schemaRows.length).toFixed(3),
      };
      const cited = schemaRows.reduce((a, r) => a + (r.schema.citedRefs || 0), 0);
      if (cited) {
        const ung = schemaRows.reduce((a, r) => a + (r.schema.ungroundedRefs || 0), 0);
        out.grounding = { citedRefs: cited, ungroundedRefs: ung, groundedRate: +(1 - ung / cited).toFixed(3) };
      }
    }
    return out;
  }

  function groupBy(rows, key) {
    const g = {};
    for (const r of rows) (g[r[key] || 'other'] = g[r[key] || 'other'] || []).push(r);
    return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, agg(v)]));
  }

  function summary({ sinceMs = 7 * 24 * 3600e3 } = {}) {
    const from = Date.now() - sinceMs;
    const rows = buf.filter(r => r.ts >= from);
    const daily = {};
    for (const r of rows) {
      const d = new Date(r.ts).toISOString().slice(0, 10);
      const x = daily[d] = daily[d] || { day: d, calls: 0, errors: 0, inTok: 0, outTok: 0, costUsd: 0 };
      x.calls++; if (!r.ok) x.errors++;
      x.inTok += r.inTok || 0; x.outTok += r.outTok || 0; x.costUsd += r.cost || 0;
    }
    // A "scan" from the analyst's view = one scan-purpose request that came
    // back usable (a congestion fallback's failed first attempt isn't a scan).
    const scans = rows.filter(r => r.purpose === 'scan' && r.ok);
    const scanCost = scans.filter(r => r.cost != null);
    return {
      since: from, records: rows.length,
      overall: agg(rows),
      byPurpose: groupBy(rows, 'purpose'),
      byModel: groupBy(rows, 'model'),
      perScan: scans.length ? {
        scans: scans.length,
        avgMs: Math.round(scans.reduce((a, r) => a + r.ms, 0) / scans.length),
        avgInTok: Math.round(scans.reduce((a, r) => a + (r.inTok || 0), 0) / scans.length),
        avgOutTok: Math.round(scans.reduce((a, r) => a + (r.outTok || 0), 0) / scans.length),
        avgCostUsd: scanCost.length ? +(scanCost.reduce((a, r) => a + r.cost, 0) / scanCost.length).toFixed(4) : null,
      } : null,
      daily: Object.values(daily).sort((a, b) => a.day < b.day ? -1 : 1).map(d => ({ ...d, costUsd: +d.costUsd.toFixed(4) })),
    };
  }

  function recent(n = 50) {
    return buf.slice(-n).reverse();
  }

  return { record, summary, recent };
}
