import { createHash } from 'node:crypto';
import { createChangeId } from './change-records.mjs';
import { importWithPrivacy } from './import-privacy.mjs';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = v => createHash('sha256').update(v).digest('hex');
const canonical = value => JSON.stringify(value, (_, item) => object(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const requestReference = (identity, format, changeId, releaseId, bytes) => ({ kind: 'mole-analytics-import-v1',
  value: hash(canonical({ identity, format, changeId: changeId ?? null, releaseId: releaseId ?? null, content_sha256: hash(bytes) })) });
const fields = ['metric_id', 'definition', 'unit', 'segment', 'population', 'baseline_start', 'baseline_end', 'post_start', 'post_end',
  'baseline_value', 'post_value', 'baseline_sample_size', 'post_sample_size', 'baseline_complete', 'post_complete',
  'baseline_status', 'post_status', 'status', 'outcome_status', 'data_timestamp', 'query_ref', 'export_ref', 'quality_status', 'quality_notes', 'confidence_notes'];
const statuses = ['unknown', 'missing', 'invalid', 'not_measured', 'inconclusive', 'measured'];
const absent = v => v === undefined || v === null || v === '';
function text(v, name, required = false) {
  if (absent(v) && !required) return null;
  if (typeof v !== 'string' || !v.trim()) throw new TypeError(`${name} must be nonempty text`);
  return v;
}
function choice(v, allowed, fallback, name) {
  if (absent(v)) return fallback;
  if (!allowed.includes(v)) throw new TypeError(`Invalid ${name}: ${v}`);
  return v;
}
// Strict quoted CSV, including escaped quotes, CRLF, commas and multiline text.
function csv(body) {
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  body = body.replace(/^\uFEFF/, '');
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === '"' && cell === '' && !closed) quoted = true;
    else if (c === ',' || c === '\n' || c === '\r') {
      row.push(cell); cell = ''; closed = false;
      if (c !== ',') { rows.push(row); row = []; if (c === '\r' && body[i + 1] === '\n') i++; }
    } else { if (closed || c === '"') throw new TypeError('Malformed CSV quoting'); cell += c; }
  }
  if (quoted) throw new TypeError('Unclosed CSV quote');
  if (cell || row.length || closed) { row.push(cell); rows.push(row); }
  const header = rows.shift();
  if (!header || new Set(header).size !== header.length || header.some(k => !fields.includes(k))) throw new TypeError('Invalid or duplicate CSV headers');
  return rows.map(r => { if (r.length !== header.length) throw new TypeError('CSV row width differs from header'); return Object.fromEntries(header.map((k,i) => [k,r[i]])); });
}
function instant(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(v)) return null;
  const n = Date.parse(v);
  if (!Number.isFinite(n)) return null;
  const iso = new Date(n).toISOString();
  return iso.slice(0,10) === v.slice(0,10) && (!v.includes('T') || iso === v || iso === v.replace('Z','.000Z')) ? iso : null;
}
function numeric(v, sample = false) {
  if (absent(v)) return null;
  if (typeof v !== 'number' && !(typeof v === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v))) return NaN;
  const n = Number(v);
  return Number.isFinite(n) && (!sample || Number.isSafeInteger(n) && n >= 0) ? n : NaN;
}
export function parseAnalytics(body, { format = 'json', source, identity, changeId, releaseId } = {}) {
  const evidence_id = `analytics_${hash(createChangeId(identity))}`;
  if (!identity?.namespace || !identity?.key) throw new TypeError('Identity namespace and key are required');
  if (!object(source)) throw new TypeError('source is required');
  text(source.ref, 'source.ref', true); text(source.type, 'source.type', true);
  let input;
  if (format === 'csv') input = { metrics: csv(body) };
  else if (format === 'json') input = JSON.parse(body);
  else throw new TypeError('Unsupported analytics format');
  if (!object(input) || Object.keys(input).some(k => !['schema_version','change_id','release_id','metrics'].includes(k)) || input.schema_version !== undefined && input.schema_version !== 1) throw new TypeError('Invalid analytics envelope');
  for (const [key, supplied] of [['change_id',changeId],['release_id',releaseId]]) {
    if (supplied !== undefined && input[key] != null && supplied !== input[key]) throw new TypeError(`Conflicting ${key}`);
    input[key] = text(supplied ?? input[key], key);
  }
  if (!input.change_id && !input.release_id) throw new TypeError('Explicit change_id or release_id required');
  if (!Array.isArray(input.metrics) || !input.metrics.length) throw new TypeError('metrics must be a nonempty array');
  const seen = new Set();
  const metrics = input.metrics.map((m,index) => {
    if (!object(m) || Object.keys(m).some(k => !fields.includes(k))) throw new TypeError('Unknown metric fields');
    const metric_id = text(m.metric_id,'metric_id',true);
    if (seen.has(metric_id)) throw new TypeError(`Duplicate metric ID: ${metric_id}`); seen.add(metric_id);
    const issues = []; let invalid = false;
    const problem = message => { issues.push(message); invalid = true; };
    const observation = prefix => {
      const value = numeric(m[`${prefix}_value`]), sample = numeric(m[`${prefix}_sample_size`],true);
      let status = choice(m[`${prefix}_status`],statuses,value === null ? m.status === 'not_measured' ? 'not_measured' : 'missing' : 'measured',`${prefix}_status`);
      if (Number.isNaN(value) || Number.isNaN(sample)) { problem(`${prefix}: invalid finite value or nonnegative integer sample size`); status = 'invalid'; }
      if (value === null && status === 'measured') { issues.push(`${prefix}: measured value missing`); status = 'missing'; }
      if (value !== null && !['measured','inconclusive','invalid','unknown'].includes(status)) { problem(`${prefix}: value contradicts ${status}`); status = 'invalid'; }
      if (status === 'invalid') invalid = true;
      return { value: Number.isFinite(value) ? value : null, sample_size: Number.isFinite(sample) ? sample : null, status,
        invalid_value: Number.isNaN(value) ? String(m[`${prefix}_value`]) : null,
        invalid_sample_size: Number.isNaN(sample) ? String(m[`${prefix}_sample_size`]) : null };
    };
    const window = prefix => {
      const start = instant(m[`${prefix}_start`]), end = instant(m[`${prefix}_end`]);
      if (!absent(m[`${prefix}_start`]) && !start || !absent(m[`${prefix}_end`]) && !end || start && end && start >= end) problem(`${prefix}: invalid window`);
      if (!start || !end) issues.push(`${prefix}: window boundaries missing or invalid`);
      const raw = m[`${prefix}_complete`];
      const complete = absent(raw) ? null : raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : 'invalid';
      if (complete === 'invalid') problem(`${prefix}: completeness must be boolean`);
      if (complete !== true) issues.push(`${prefix}: window incomplete or completeness unknown`);
      return { start, end, complete: complete === 'invalid' ? null : complete, duration_ms: start && end && start < end ? Date.parse(end)-Date.parse(start) : null };
    };
    const baseline = observation('baseline'), post = observation('post');
    const windows = { baseline: window('baseline'), post: window('post'), boundary: '[start,end)', timezone: 'UTC' };
    if (windows.baseline.end && windows.post.start && windows.baseline.end > windows.post.start) problem('Baseline and post windows overlap');
    if (windows.baseline.duration_ms !== windows.post.duration_ms) issues.push('Window durations differ; values may not be comparable');
    const data_timestamp = instant(m.data_timestamp);
    if (!absent(m.data_timestamp) && !data_timestamp) problem('Invalid data_timestamp');
    if (!data_timestamp) issues.push('Data timestamp unknown');
    if (data_timestamp && [windows.baseline,windows.post].some(w => w.complete && w.end && data_timestamp < w.end)) problem('Complete window ends after data timestamp');
    const definition = text(m.definition,'definition');
    if (!definition) issues.push('Metric definition unknown');
    const metadata = Object.fromEntries(['unit','segment','population','query_ref','export_ref','quality_notes','confidence_notes'].map(k => [k,text(m[k],k)]));
    if (!metadata.query_ref && !metadata.export_ref) issues.push('Query/export reference unknown');
    if (m.status === 'invalid') problem('Source reports invalid measurement');
    if (m.quality_status === 'invalid') problem('Source reports invalid quality');
    let status = choice(m.status,statuses,'unknown','status');
    if (invalid || [baseline,post].some(o => o.status === 'invalid')) status = 'invalid';
    else if ([baseline,post].some(o => o.status === 'missing')) status = 'missing';
    else if ([baseline,post].some(o => o.status === 'not_measured')) status = 'not_measured';
    else if (status === 'measured' && (issues.length || [baseline,post].some(o => o.status !== 'measured'))) status = 'inconclusive';
    const canCompare = !invalid && baseline.value !== null && post.value !== null;
    let absolute = canCompare ? post.value-baseline.value : null;
    let relative = canCompare && baseline.value !== 0 ? absolute / Math.abs(baseline.value) * 100 : null;
    if (absolute !== null && !Number.isFinite(absolute) || relative !== null && !Number.isFinite(relative)) { problem('Comparison arithmetic overflow'); status = 'invalid'; absolute = relative = null; }
    const reported_outcome = choice(m.outcome_status,['unknown','success','failure'],'unknown','outcome_status');
    const provenance = Object.fromEntries(fields.map(k => [k,{ ...source, locator: format === 'csv' ? `record:${index+2}/${k}` : `/metrics/${index}/${k}`, method: absent(m[k]) ? 'defaulted' : 'copied' }]));
    return { metric_id, definition, ...metadata, baseline, post, windows, data_timestamp, status,
      reported_outcome, outcome_status: status === 'measured' ? reported_outcome : 'unknown',
      comparison: { absolute_change: absolute, relative_change_percent: relative,
        relative_status: !canCompare ? 'unavailable' : baseline.value === 0 ? 'zero_baseline' : status === 'invalid' ? 'invalid' : 'calculated', causal_claim: false },
      quality: { status: invalid ? 'invalid' : issues.length ? 'limited' : choice(m.quality_status,['unknown','good','limited','invalid'],'unknown','quality_status'), reported_status: choice(m.quality_status,['unknown','good','limited','invalid'],'unknown','quality_status'), issues }, provenance };
  });
  return { schema_version: 1, evidence_id, change_id: input.change_id, release_id: input.release_id, source,
    link_provenance: Object.fromEntries([['change_id',changeId],['release_id',releaseId]].map(([key,option]) => [key,
      { ...source, locator: option !== undefined ? `option:${key}` : `/${key}`, method: input[key] === null ? 'defaulted' : 'copied' }])),
    review_state: 'draft', comparison_method: 'descriptive_before_after', attribution_caveat: 'Before/after differences do not establish causation.', metrics };
}
/** Privacy-managed immutable import. Pure parser/fingerprint contracts are unchanged. */
export function importAnalytics(root, { file, sourceId, identity, changeId, releaseId, format } = {}) {
  return importWithPrivacy(root, { file, sourceId, identity, changeId, releaseId, format }, {
    validateOptions: () => {
      for (const value of [changeId, releaseId]) if (value !== undefined && (typeof value !== 'string' || !value.trim())) throw new TypeError('Explicit bindings must be nonempty text');
    },
    kind: 'analytics', formats: ['json','csv'], defaultFormat: 'csv',
    decodeValues: (text, format) => format === 'json' ? JSON.parse(text) : csv(text),
    parse: (text, format, source) => parseAnalytics(text, { format, source, identity, changeId, releaseId }),
    fingerprint: (format, bytes) => requestReference(identity, format, changeId, releaseId, bytes),
    outputKey: event => event.evidence_id
  });
}
