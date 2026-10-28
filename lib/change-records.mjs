import { createHash, randomUUID } from 'node:crypto';

export const CHANGE_RECORD_VERSION = 1;
const TEXT = ['title', 'problem', 'hypothesis', 'expected_outcome', 'baseline', 'target',
  'review_window', 'observed_outcome', 'confidence', 'attribution_caveats', 'learning', 'next_decision'];
const LISTS = ['success_signals', 'guardrails', 'evidence'];
const DATES = ['planned', 'released', 'review_due', 'reviewed'];
const ENUMS = {
  delivery_status: ['planned', 'released', 'unknown'],
  review_status: ['not_due', 'review_due', 'reviewed', 'unknown'],
  outcome_status: ['not_measured', 'no_data', 'inconclusive', 'positive', 'negative', 'mixed', 'unknown']
};
const INTENT = ['problem', 'hypothesis', 'expected_outcome', 'success_signals', 'baseline', 'target', 'review_window', 'guardrails'];
export const CHANGE_RECORD_FIELDS = Object.freeze(['schema_version', 'change_id', 'release_id', 'source',
  ...TEXT, ...LISTS, 'dates', ...Object.keys(ENUMS)]);
const own = (o, k) => Object.hasOwn(o, k);
const object = o => o !== null && typeof o === 'object' && !Array.isArray(o);
const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const pointer = k => k.replace(/~/g, '~0').replace(/\//g, '~1');

function createId(prefix, identity) {
  if (identity === undefined) return `${prefix}_${randomUUID()}`;
  if (!object(identity) || !nonempty(identity.namespace) || !nonempty(identity.key)) {
    throw new TypeError('Identity needs nonempty namespace and key');
  }
  return `${prefix}_${createHash('sha256').update(JSON.stringify([identity.namespace, identity.key])).digest('hex')}`;
}
export const createChangeId = identity => createId('chg', identity);
export const createReleaseId = identity => createId('rel', identity);

function leaves(value, path = '') {
  if (value === null || typeof value !== 'object' || Object.keys(value).length === 0) return [[path, value]];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, `${path}/${pointer(key)}`));
}

export function getChangeRecordGaps(record) {
  return INTENT.filter(key => record[key] == null || record[key] === '' ||
    (Array.isArray(record[key]) && record[key].length === 0));
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

/** Validate v1 without coercion. This checks structure and provenance coverage, not factual truth. */
export function validateChangeRecord(record) {
  const errors = [];
  if (!object(record)) return { valid: false, errors: ['record must be an object'] };
  const allowed = [...CHANGE_RECORD_FIELDS, 'provenance', 'gaps'];
  for (const key of Object.keys(record)) if (!allowed.includes(key)) errors.push(`Unknown field: ${key}`);
  for (const key of allowed) if (!own(record, key)) errors.push(`Missing field: ${key}`);
  if (record.schema_version !== 1) errors.push('Unsupported schema_version');
  if (!nonempty(record.change_id)) errors.push('change_id must be nonempty');
  if (record.release_id !== null && !nonempty(record.release_id)) errors.push('release_id must be null or nonempty');
  if (!object(record.source) || !nonempty(record.source.type) || !nonempty(record.source.ref) ||
      Object.keys(record.source).some(k => !['type', 'ref', 'source_id'].includes(k)) ||
      (own(record.source, 'source_id') && !nonempty(record.source.source_id))) errors.push('Invalid source');
  for (const key of TEXT) if (record[key] !== null && !nonempty(record[key])) errors.push(`${key} must be null or nonempty text`);
  for (const key of LISTS) if (!Array.isArray(record[key]) || !record[key].every(nonempty)) errors.push(`${key} must be an array of nonempty strings`);
  if (!object(record.dates) || Object.keys(record.dates).some(k => !DATES.includes(k)) ||
      DATES.some(k => !own(record.dates, k) || (record.dates[k] !== null && !validDate(record.dates[k])))) errors.push('dates must contain valid YYYY-MM-DD dates or null');
  for (const [key, values] of Object.entries(ENUMS)) if (!values.includes(record[key])) errors.push(`Invalid ${key}`);
  const expected = leaves(Object.fromEntries(CHANGE_RECORD_FIELDS.filter(k => own(record, k)).map(k => [k, record[k]]))).map(([p]) => p);
  if (!object(record.provenance)) errors.push('provenance must be an object');
  else {
    for (const path of expected) {
      const refs = record.provenance[path];
      if (!Array.isArray(refs) || refs.length === 0 || refs.some(ref => !object(ref) ||
          !nonempty(ref.ref) || !nonempty(ref.locator) || !['copied', 'generated', 'defaulted'].includes(ref.method) ||
          (own(ref, 'source_id') && !nonempty(ref.source_id)) ||
          Object.keys(ref).some(k => !['ref', 'locator', 'method', 'source_id'].includes(k)))) errors.push(`Invalid provenance: ${path}`);
    }
    for (const path of Object.keys(record.provenance)) if (!expected.includes(path)) errors.push(`Unknown provenance pointer: ${path}`);
  }
  if (!Array.isArray(record.gaps) || JSON.stringify(record.gaps) !== JSON.stringify(getChangeRecordGaps(record))) errors.push('gaps must match missing intent fields');
  return { valid: errors.length === 0, errors };
}

/** Normalize sparse mapped values. Persist the returned ID before subsequent edits/imports. */
export function normalizeChangeRecord(input, { source = input?.source, identity, provenance = {} } = {}) {
  if (!object(input)) throw new TypeError('Input must be an object');
  if (own(input, 'schema_version') && input.schema_version !== 1) throw new TypeError('Unsupported schema_version');
  for (const key of Object.keys(input)) if (![...CHANGE_RECORD_FIELDS, 'provenance', 'gaps'].includes(key)) throw new TypeError(`Unknown field: ${key}`);
  if (!object(source)) throw new TypeError('A source with type and ref is required');
  const record = { schema_version: 1, change_id: own(input, 'change_id') ? input.change_id : createChangeId(identity),
    release_id: own(input, 'release_id') ? input.release_id : null, source: structuredClone(source) };
  for (const key of TEXT) record[key] = own(input, key) ? (typeof input[key] === 'string' ? input[key].trim() || null : input[key]) : null;
  for (const key of LISTS) record[key] = own(input, key) ? structuredClone(input[key]) : [];
  if (own(input, 'dates') && (!object(input.dates) || Object.keys(input.dates).some(k => !DATES.includes(k)))) throw new TypeError('Invalid dates');
  record.dates = Object.fromEntries(DATES.map(k => [k, input.dates && own(input.dates, k) ? input.dates[k] : null]));
  for (const key of Object.keys(ENUMS)) record[key] = own(input, key) ? input[key] : 'unknown';
  if (!object(provenance) || (own(input, 'provenance') && !object(input.provenance))) throw new TypeError('Invalid provenance');
  const overrides = { ...input.provenance, ...provenance };
  record.provenance = Object.fromEntries(leaves(record).map(([path]) => {
    const [key, child] = path.slice(1).split('/');
    const supplied = key === 'source' || (own(input, key) && (key !== 'dates' || own(input.dates, child)));
    const method = (key === 'change_id' && !own(input, key)) || key === 'schema_version' ? 'generated' : supplied ? 'copied' : 'defaulted';
    return [path, structuredClone(overrides[path] ?? [{ ref: source.ref, ...(source.source_id ? { source_id: source.source_id } : {}), locator: path, method }])];
  }));
  for (const path of Object.keys(overrides)) if (!own(record.provenance, path)) throw new TypeError(`Unknown provenance pointer: ${path}`);
  record.gaps = getChangeRecordGaps(record);
  const result = validateChangeRecord(record);
  if (!result.valid) throw new TypeError(result.errors.join('; '));
  return record;
}

/** Bounded heading adapter. No inference, YAML, remote reads, or OpenSpec dependency. */
export function parseChangeRecord(text, { format = 'json', source, identity } = {}) {
  if (typeof text !== 'string') throw new TypeError('Text must be a string');
  if (format === 'json') return normalizeChangeRecord(JSON.parse(text), { source, identity });
  if (format !== 'markdown') throw new TypeError(`Unsupported format: ${format}`);
  const input = {};
  const provenance = {};
  const aliases = { why: 'problem', what_changes: 'expected_outcome' };
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let section = null;
  let start = 0;
  let body = [];
  let fenced = false;
  function save() {
    if (!section) return;
    if (own(input, section)) throw new TypeError(`Duplicate Markdown field: ${section}`);
    const value = body.join('\n').trim();
    input[section] = LISTS.includes(section) ? value.split('\n').filter(l => l.trim()).map(l => {
      if (!/^\s*-\s+/.test(l)) throw new TypeError(`Expected list item in ${section}`);
      return l.replace(/^\s*-\s+/, '').trim();
    }) : section === 'dates' ? JSON.parse(value) : value || null;
    for (const [path] of leaves(input[section], `/${section}`)) provenance[path] = [{ ref: source?.ref, ...(source?.source_id ? { source_id: source.source_id } : {}), locator: `line:${start}`, method: 'copied' }];
  }
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
    const heading = !fenced && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (heading) {
      save(); section = null; body = [];
      if (heading[1].length === 1 && !own(input, 'title')) {
        input.title = heading[2];
        provenance['/title'] = [{ ref: source?.ref, ...(source?.source_id ? { source_id: source.source_id } : {}), locator: `line:${i + 1}`, method: 'copied' }];
      } else {
        const key = heading[2].toLowerCase().replace(/\s+/g, '_');
        const mapped = aliases[key] || key;
        if ([...TEXT, ...LISTS, 'dates', ...Object.keys(ENUMS), 'change_id', 'release_id'].includes(mapped)) section = mapped;
      }
      start = i + 1;
    } else if (section) body.push(lines[i]);
  }
  save();
  return normalizeChangeRecord(input, { source, identity, provenance });
}
