import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTelemetry } from '../lib/telemetry.mjs';

test('aggregates latency percentiles, schema outcomes, grounding and cost', async () => {
  const t = createTelemetry({ prices: { m1: [2, 10] } });
  for (let i = 1; i <= 20; i++) {
    t.record({ purpose: 'scan', model: 'm1', ok: true, ms: i * 1000, inTok: 1000, outTok: 100,
      schema: { ok: true, firstPassOk: i % 4 !== 0, repaired: i === 20, repairOk: i === 20, dropped: 0, citedRefs: 5, ungroundedRefs: i === 1 ? 1 : 0 } });
  }
  t.record({ purpose: 'scan', model: 'm1', ok: false, ms: 60000, inTok: 1000, outTok: 0 });
  t.record({ purpose: 'triage', model: 'unpriced-model', ok: true, ms: 500, inTok: 300, outTok: 50 });

  const s = t.summary();
  assert.equal(s.overall.calls, 22);
  assert.equal(s.byPurpose.scan.p50ms, 10000);
  assert.equal(s.byPurpose.scan.p95ms, 19000, 'p95 over successful calls only');
  assert.equal(s.byPurpose.scan.schema.firstPassRate, 0.75);
  assert.equal(s.byPurpose.scan.schema.repaired, 1);
  assert.equal(s.overall.grounding.ungroundedRefs, 1);
  assert.equal(s.overall.grounding.citedRefs, 100);
  // 21 priced scan calls: 21*1000*2/1e6 + 20*100*10/1e6 = 0.042 + 0.02
  assert.equal(s.byPurpose.scan.costUsd, 0.062);
  assert.equal(s.byPurpose.triage.costUsd, null, 'no guessed prices');
  assert.equal(s.perScan.scans, 20);
});

test('persists to JSONL and reloads on restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-tel-'));
  const file = path.join(dir, 'telemetry.jsonl');
  const a = createTelemetry({ file });
  a.record({ purpose: 'brief', model: 'm', ok: true, ms: 1200, inTok: 10, outTok: 5 });
  await new Promise(r => setTimeout(r, 50));   // appendFile is async
  const b = createTelemetry({ file });
  assert.equal(b.summary().overall.calls, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
