// Structured-output enforcement for every JSON-producing LLM call.
//
// The engine routes across 8 models from 3 vendors through one OpenAI-compatible
// gateway, and native structured-output support differs per vendor (and the
// scan's top-level ARRAY isn't expressible in json_object mode at all). So the
// contract is enforced here, provider-agnostically, in four stages:
//   1. extract   — strip fences, parse; salvage complete elements from a
//                  truncated array (max_tokens cut mid-object)
//   2. coerce    — deterministic, lossless fixes (enum casing, "[L3]" -> "L3",
//                  bare-string citations -> {label, ref}, numeric strings)
//   3. validate  — a zero-dependency JSON-Schema subset with JSON-pointer paths;
//                  top-level arrays keep their valid elements (partial accept)
//   4. ground    — every cited [L#] ref must exist in the prompt the model was
//                  given; invented refs are nulled and counted
// Only when nothing usable survives does the caller spend a repair call
// (repairMessages), on the fast model, inside the request's time budget.

const STEEPLE = ['Social', 'Technological', 'Economic', 'Environmental', 'Political', 'Legal', 'Ethical'];

// The app's four focus areas. The client maps loosely too (dimOf); matching the
// same keywords here means the server never drops a trend the UI would render.
const DIMENSIONS = [
  ['Future of Work', /work|job|employ|labou?r|career|wage/i],
  ['Future of Tech', /tech|digital|\bai\b|automat/i],
  ['Future of Learning', /learn|skill|educat|train/i],
  ['Future of Government', /gov|policy|public|regulat|state/i],
];
function normDimension(v) {
  if (typeof v !== 'string') return v;
  const exact = DIMENSIONS.find(([k]) => k.toLowerCase() === v.trim().toLowerCase());
  if (exact) return exact[0];
  const hit = DIMENSIONS.find(([, re]) => re.test(v));
  return hit ? hit[0] : v;
}
function normRef(v) {
  if (v === '' || v === undefined) return null;
  if (typeof v !== 'string') return v;
  const m = v.replace(/[\[\]\s]/g, '').match(/^l(\d{1,4})$/i);
  return m ? 'L' + m[1] : v;
}

// Schemas are plain JSON Schema plus two hooks the validator understands:
//   normalize(v)  — value-level coercion run before checks
//   fromString    — a bare string where an object is expected becomes {[fromString]: s}
// Hooks are functions, so JSON.stringify drops them when a schema is shown to a model.
export const SCHEMAS = {
  trends: {
    type: 'array', minItems: 1, maxItems: 7,
    items: {
      type: 'object',
      required: ['title', 'dimension', 'confidence', 'what', 'why', 'options', 'sources'],
      properties: {
        title: { type: 'string', minLength: 3, maxLength: 200 },
        dimension: { enum: DIMENSIONS.map(d => d[0]), normalize: normDimension },
        confidence: { enum: ['High', 'Medium', 'Low'] },
        trajectory: { type: 'string' },
        horizon: { type: 'string' },
        what: { type: 'string', minLength: 10 },
        why: { type: 'string', minLength: 10 },
        options: { type: 'array', maxItems: 4, items: { type: 'string', minLength: 3 } },
        sources: {
          type: 'array', minItems: 1, maxItems: 4,
          items: {
            type: 'object', fromString: 'label', required: ['label'],
            properties: {
              label: { type: 'string', minLength: 1, maxLength: 120 },
              ref: { type: ['string', 'null'], pattern: '^L\\d{1,4}$', normalize: normRef },
            },
          },
        },
      },
    },
  },
  brief: {
    type: 'object', required: ['subject', 'intro', 'sections', 'closing'],
    properties: {
      subject: { type: 'string', minLength: 3, maxLength: 200 },
      intro: { type: 'string', minLength: 10 },
      sections: { type: 'object', additionalProperties: { type: 'string' } },
      closing: { type: 'string' },
    },
  },
  audit: {
    type: 'object', required: ['fits', 'emptyTopics'],
    properties: {
      fits: {
        type: 'array',
        items: {
          type: 'object', required: ['i', 'fit'],
          properties: { i: { type: 'integer', minimum: 0 }, fit: { type: 'boolean' }, note: { type: 'string' } },
        },
      },
      emptyTopics: { type: 'array', items: { type: 'string' } },
    },
  },
  triage: {
    type: 'array',
    items: {
      type: 'object', required: ['i', 'keep', 'domain', 'novelty'],
      properties: {
        i: { type: 'integer', minimum: 0 },
        keep: { type: 'boolean' },
        // "Technology" / "Environment" / "Law" are the same verdict as the enum
        // value; matching on the stem keeps them instead of dropping the item.
        domain: { enum: STEEPLE, normalize: (v) => {
          if (typeof v !== 'string') return v;
          const k = v.trim().toLowerCase();
          if (k === 'law') return 'Legal';
          return STEEPLE.find(d => d.toLowerCase().slice(0, 4) === k.slice(0, 4)) || v;
        } },
        // Clamp like the pre-schema triage did: 0 or 7 is a scale slip, not a bad verdict.
        novelty: { type: 'integer', minimum: 1, maximum: 5, normalize: (v) => {
          const n = typeof v === 'string' ? parseInt(v, 10) : v;
          return typeof n === 'number' && isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : v;
        } },
      },
    },
  },
};

// ---------- 1. extract ----------
// Returns { value, salvaged } or throws. rootType picks which bracket to hunt
// for, so prose like "Here are [3] trends: [...]" can't fool the array path.
export function extractJson(text, rootType) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  if (!t) throw new Error('empty response');
  const open = rootType === 'array' ? '[' : '{', close = rootType === 'array' ? ']' : '}';
  const start = t.indexOf(open);
  if (start === -1) throw new Error(`no JSON ${rootType} in response`);
  const end = t.lastIndexOf(close);
  if (end > start) {
    try { return { value: JSON.parse(t.slice(start, end + 1)), salvaged: false }; } catch { /* salvage below */ }
  }
  if (rootType !== 'array') throw new Error('unparseable JSON object');
  // Truncated array: keep every COMPLETE top-level object.
  const objs = [];
  let depth = 0, objStart = -1, inStr = false, esc = false;
  for (let i = start + 1; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') { if (depth === 0) objStart = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        try { objs.push(JSON.parse(t.slice(objStart, i + 1))); } catch { /* skip */ }
        objStart = -1;
      }
    } else if (ch === ']' && depth === 0) break;
  }
  if (!objs.length) throw new Error('unparseable JSON array');
  return { value: objs, salvaged: true };
}

// ---------- 2. coerce ----------
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
function accepts(schema, t) {
  const want = [].concat(schema.type || []);
  return want.includes(t) || (t === 'integer' && want.includes('number'));
}
// Returns the coerced value; ctx.n counts every change made.
export function coerce(schema, v, ctx = { n: 0 }) {
  if (!schema) return v;
  if (schema.normalize) {
    const nv = schema.normalize(v);
    if (nv !== v) { ctx.n++; v = nv; }
  }
  if (schema.enum && typeof v === 'string' && !schema.enum.includes(v)) {
    const hit = schema.enum.find(e => typeof e === 'string' && e.toLowerCase() === v.trim().toLowerCase());
    if (hit) { ctx.n++; return hit; }
  }
  const t = typeOf(v);
  const want = [].concat(schema.type || []);
  if (want.includes('string') && (t === 'integer' || t === 'number')) { ctx.n++; return String(v); }
  if (want.includes('integer') && t === 'string' && /^-?\d+$/.test(v.trim())) { ctx.n++; return parseInt(v, 10); }
  if (want.includes('integer') && t === 'number') { ctx.n++; return Math.round(v); }
  if (want.includes('boolean') && t === 'string' && /^(true|false)$/i.test(v.trim())) { ctx.n++; return /^true$/i.test(v.trim()); }
  if (want.includes('array') && t !== 'array' && t !== 'null' && t !== 'undefined') { ctx.n++; v = [v]; }
  if (want.includes('object') && t === 'string' && schema.fromString) { ctx.n++; v = { [schema.fromString]: v }; }
  if (Array.isArray(v) && schema.items) return v.map(x => coerce(schema.items, x, ctx));
  if (v && typeOf(v) === 'object') {
    const out = { ...v };
    for (const [k, sub] of Object.entries(schema.properties || {})) if (k in out) out[k] = coerce(sub, out[k], ctx);
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const k of Object.keys(out)) if (!(schema.properties || {})[k]) out[k] = coerce(schema.additionalProperties, out[k], ctx);
    }
    return out;
  }
  return v;
}

// ---------- 3. validate ----------
export function validate(schema, v, path = '', errors = []) {
  if (!schema) return errors;
  const t = typeOf(v);
  if (schema.enum && !schema.enum.includes(v)) {
    errors.push({ path: path || '/', msg: `must be one of ${schema.enum.join(' | ')}` });
    return errors;
  }
  if (schema.type && !accepts(schema, t)) {
    errors.push({ path: path || '/', msg: `expected ${[].concat(schema.type).join('|')}, got ${t}` });
    return errors;
  }
  if (t === 'string') {
    if (schema.minLength && v.trim().length < schema.minLength) errors.push({ path, msg: `shorter than ${schema.minLength}` });
    if (schema.maxLength && v.length > schema.maxLength) errors.push({ path, msg: `longer than ${schema.maxLength}` });
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) errors.push({ path, msg: `does not match ${schema.pattern}` });
  }
  if (t === 'integer' || t === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) errors.push({ path, msg: `below ${schema.minimum}` });
    if (schema.maximum !== undefined && v > schema.maximum) errors.push({ path, msg: `above ${schema.maximum}` });
  }
  if (t === 'array') {
    if (schema.minItems && v.length < schema.minItems) errors.push({ path: path || '/', msg: `needs at least ${schema.minItems} items` });
    if (schema.maxItems && v.length > schema.maxItems) errors.push({ path: path || '/', msg: `more than ${schema.maxItems} items` });
    if (schema.items) v.forEach((x, i) => validate(schema.items, x, `${path}/${i}`, errors));
  }
  if (t === 'object') {
    for (const k of schema.required || []) if (!(k in v) || v[k] === undefined) errors.push({ path: `${path}/${k}`, msg: 'required' });
    for (const [k, sub] of Object.entries(schema.properties || {})) if (k in v) validate(sub, v[k], `${path}/${k}`, errors);
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const k of Object.keys(v)) if (!(schema.properties || {})[k]) validate(schema.additionalProperties, v[k], `${path}/${k}`, errors);
    }
  }
  return errors;
}

// ---------- 4. ground ----------
// The set of [L#] citation codes the model was actually shown.
export function refsInPrompt(messages) {
  const refs = new Set();
  for (const m of messages || []) {
    if (!m || m.role === 'system' || typeof m.content !== 'string') continue;
    for (const br of m.content.match(/\[[^\]]{1,80}\]/g) || []) {
      for (const code of br.match(/\bL\d{1,4}\b/g) || []) refs.add(code);
    }
  }
  return refs;
}

// Full pipeline: text in, verdict out. Never throws.
//   { ok, value, stats: { parsed, salvaged, coercions, dropped, errors[], citedRefs, ungroundedRefs } }
export function enforce(name, text, { messages } = {}) {
  const schema = SCHEMAS[name];
  const stats = { parsed: false, salvaged: false, coercions: 0, dropped: 0, errors: [], citedRefs: 0, ungroundedRefs: 0 };
  if (!schema) return { ok: false, value: null, stats: { ...stats, errors: [{ path: '/', msg: `unknown schema ${name}` }] } };
  let value;
  try {
    const ex = extractJson(text, schema.type);
    value = ex.value; stats.parsed = true; stats.salvaged = ex.salvaged;
  } catch (e) {
    stats.errors.push({ path: '/', msg: e.message });
    return { ok: false, value: null, stats };
  }
  const ctx = { n: 0 };
  value = coerce(schema, value, ctx);
  stats.coercions = ctx.n;

  // Partial acceptance for top-level arrays: one malformed trend shouldn't cost
  // the other four. Element-level errors are kept for telemetry.
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    const keep = [];
    value.forEach((x, i) => {
      const errs = validate(schema.items, x, `/${i}`);
      if (errs.length) { stats.dropped++; stats.errors.push(...errs); } else keep.push(x);
    });
    value = schema.maxItems ? keep.slice(0, schema.maxItems) : keep;
  }
  const rootErrs = validate(schema, value);
  stats.errors.push(...rootErrs);

  if (name === 'trends' && Array.isArray(value)) {
    const allowed = refsInPrompt(messages);
    for (const t of value) {
      for (const s of t.sources || []) {
        if (!s || !s.ref) continue;
        stats.citedRefs++;
        if (allowed.size && !allowed.has(s.ref)) { s.ref = null; stats.ungroundedRefs++; }
      }
    }
  }
  return { ok: rootErrs.length === 0, value, stats };
}

// A repair turn: reformat, don't rethink. Sent to the fast model.
export function repairMessages(name, badText, errors) {
  const shown = errors.slice(0, 12).map(e => `- ${e.path}: ${e.msg}`).join('\n');
  return [
    { role: 'system', content:
      'You repair malformed JSON produced by another model. Output ONLY valid JSON that matches the JSON Schema given. ' +
      'Preserve the original content and wording; fix structure, field names, types and enum values only. ' +
      'Never add facts, trends, sources or citation codes that are not already in the malformed output. ' +
      'If an element cannot be repaired without inventing content, omit it.' },
    { role: 'user', content:
      `JSON Schema:\n${JSON.stringify(SCHEMAS[name])}\n\nValidation errors:\n${shown || '- unparseable'}\n\n` +
      `Malformed output:\n${String(badText || '').slice(0, 14000)}` },
  ];
}
