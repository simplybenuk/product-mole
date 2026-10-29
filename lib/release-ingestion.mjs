import { createHash } from 'node:crypto';
import { createReleaseId, normalizeChangeRecord, validateChangeRecord } from './change-records.mjs';
import { importWithPrivacy } from './import-privacy.mjs';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = v => createHash('sha256').update(v).digest('hex');
// Sort object keys so equivalent parsed options do not depend on JSON property order.
const canonical = value => JSON.stringify(value, (_, item) => object(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const requestReference = (identity, format, intents, bytes) => ({ kind: 'mole-release-import-v1',
  value: hash(canonical({ identity: { namespace: identity.namespace, key: identity.key }, format, intents, content_sha256: hash(bytes) })) });
function text(v, label, nullable = true) {
  if (nullable && v == null) return null;
  if (typeof v !== 'string' || !v.trim()) throw new TypeError(`${label} must be nonempty text`);
  return v;
}
function links(v = []) {
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim())) throw new TypeError('source_links must be text array');
  return v;
}
function markdown(body) {
  const result = { title: null, released_at: null, changes: [], source_links: [] };
  let fence = null;
  for (const [i, line] of body.split(/\r?\n/).entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) { fence = { char: marker[1][0], length: marker[1].length }; continue; }
    if (/^# /.test(line) && !result.title) result.title = line.slice(2).trim();
    const date = /^Release date:\s*(\S+)\s*$/i.exec(line);
    if (date) { if (result.released_at) throw new TypeError('Duplicate release date'); result.released_at = date[1]; }
    const id = /^Release ID:\s*(.+)$/i.exec(line);
    if (id) { if (result.release_id) throw new TypeError('Duplicate release ID'); result.release_id = id[1].trim(); }
    const bullet = /^[-*] (.+)$/.exec(line);
    if (bullet) {
      const markers = [...bullet[1].matchAll(/\[intent:([^\]]*)\]/g)];
      if (markers.length > 1) throw new TypeError('Multiple intent IDs in one change');
      result.changes.push({ title: bullet[1].replace(/\[intent:[^\]]*\]/g, '').trim(),
        ...(markers.length ? { intent_id: text(markers[0][1], 'intent_id', false) } : {}), locator: `line:${i + 1}` });
    }
    for (const match of line.matchAll(/\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g)) result.source_links.push(match[1]);
  }
  return result;
}

function matchIntent(change, intents) {
  const id = change.intent_id;
  const candidates = intents.filter(r => id ? r.change_id === id : change.title && r.title?.toLowerCase().trim() === change.title.toLowerCase().trim());
  const status = id ? candidates.length === 1 ? 'explicit' : candidates.length ? 'ambiguous_id' : 'unresolved_id'
    : candidates.length === 1 ? 'suggested' : candidates.length ? 'ambiguous' : 'missing';
  return { status, requested_id: id ?? null, intent_id: status === 'explicit' ? id : null,
    candidates: candidates.map(r => ({ change_id: r.change_id, source: r.source, title: r.title })) };
}

/** File-native bounded adapter. Delivery descriptions never become intent or outcome claims. */
export function parseRelease(body, { format = 'markdown', source, identity, intents = [] } = {}) {
  if (!identity) throw new TypeError('Release identity namespace and key are required');
  createReleaseId(identity); // Validate even when the artifact supplies an ID.
  if (!Array.isArray(intents) || intents.some(r => !validateChangeRecord(r).valid)) throw new TypeError('intents must be normalized change records');
  let input;
  let adapter = format;
  if (format === 'markdown') input = markdown(body);
  else if (format === 'json') {
    input = JSON.parse(body);
    // gh pr list/view exports: explicit exported IDs are delivery identities, not intent IDs.
    if (Array.isArray(input) || object(input) && input.number !== undefined && input.title) {
      adapter = Array.isArray(input) ? 'pr_array' : 'pr';
      const rows = Array.isArray(input) ? input : [input];
      input = { changes: rows.map(row => {
        if (!object(row) || row.number === undefined || typeof row.title !== 'string') throw new TypeError('Invalid GitHub PR export');
        return { key: String(row.number), title: row.title, description: row.body ?? null,
          evidence: [row.url ?? row.html_url].filter(Boolean) };
      }) };
    }
    // Jira JSON exports with issues[].fields.summary; richer exports use the canonical format.
    if (object(input) && Array.isArray(input.issues)) {
      adapter = 'jira';
      input = { changes: input.issues.map(row => ({
        key: text(row.key, 'Jira issue key', false), title: text(row.fields?.summary, 'Jira summary', false),
        description: typeof row.fields?.description === 'string' ? row.fields.description : null
      })) };
    }
    // GitHub release exports preserve their body as delivery scope only.
    if (object(input) && typeof input.tag_name === 'string' && typeof input.body === 'string') {
      adapter = 'github_release';
      const mapped = markdown(input.body);
      input = { ...mapped, title: input.name || input.tag_name,
        released_at: input.published_at ? input.published_at.slice(0, 10) : null,
        source_links: [...mapped.source_links, ...[input.html_url].filter(Boolean)] };
    }
  } else throw new TypeError(`Unsupported format: ${format}`);
  if (!object(input)) throw new TypeError('Release must be an object');
  for (const key of Object.keys(input)) if (!['release_id', 'title', 'released_at', 'source_links', 'changes'].includes(key)) throw new TypeError(`Unknown release field: ${key}`);
  if (!Array.isArray(input.changes) || !input.changes.length) throw new TypeError('Release requires at least one change candidate; use the manual JSON format for prose summaries');
  const release_id = input.release_id === undefined ? createReleaseId(identity) : text(input.release_id, 'release_id', false);
  const released_at = text(input.released_at, 'released_at');
  // Delegate calendar validation to #11.
  normalizeChangeRecord({ dates: { released: released_at } }, { source });
  const seen = new Set();
  const changes = input.changes.map((item, index) => {
    if (!object(item)) throw new TypeError('Change must be an object');
    const { key, intent_id, description, locator, ...fields } = item;
    if (intent_id !== undefined) text(intent_id, 'intent_id', false);
    if (key !== undefined) text(key, 'key', false);
    if (fields.release_id !== undefined && fields.release_id !== release_id) throw new TypeError('Conflicting change release_id');
    if (fields.dates !== undefined && !object(fields.dates)) throw new TypeError('Invalid dates');
    if (locator !== undefined) text(locator, 'locator', false);
    const record = normalizeChangeRecord({ ...fields, release_id, dates: { ...fields.dates, released: fields.dates?.released ?? released_at } }, {
      source, identity: { namespace: release_id, key: key ?? `position:${index + 1}` }
    });
    if (seen.has(record.change_id)) throw new TypeError(`Duplicate change ID: ${record.change_id}`);
    seen.add(record.change_id);
    const location = adapter === 'github_release' ? `/body#${locator}`
      : adapter === 'pr_array' ? `/${index}` : adapter === 'pr' ? '/'
      : adapter === 'jira' ? `/issues/${index}` : locator ?? `/changes/${index}`;
    // Container locators for export adapters identify the source candidate without inventing fields.
    for (const [pointer, refs] of Object.entries(record.provenance)) for (const ref of refs) {
      if (ref.ref !== source.ref) continue;
      if (pointer.startsWith('/source/')) { ref.method = 'generated'; ref.locator = 'artifact'; }
      else if (pointer === '/release_id') {
        ref.method = input.release_id === undefined ? 'generated' : 'copied';
        ref.locator = '/release_id';
      } else if (pointer === '/dates/released' && !fields.dates?.released) {
        ref.locator = adapter === 'github_release' ? '/published_at' : '/released_at';
        ref.method = released_at === null ? 'defaulted' : 'copied';
      } else ref.locator = adapter === 'json' ? `${location}${ref.locator}` : location;
    }
    return { record, description: text(description, 'description'), locator: location, intent_link: matchIntent(item, intents) };
  });
  return { schema_version: 1, release_id, title: text(input.title, 'title'), released_at,
    source, source_links: links(input.source_links), changes, review_state: 'draft' };
}

/** Privacy-managed immutable import. Pure parser/fingerprint contracts are unchanged. */
export function importRelease(root, { file, sourceId, identity, intents = [], format } = {}) {
  return importWithPrivacy(root, { file, sourceId, identity, intents, format }, {
    validateOptions: () => {
      if (!Array.isArray(intents) || intents.some(r => !validateChangeRecord(r).valid)) throw new TypeError('intents must be normalized change records');
    },
    kind: 'release', formats: ['markdown','json'], defaultFormat: 'markdown',
    decodeValues: (text, format) => format === 'json' ? JSON.parse(text) : text,
    parse: (text, format, source) => parseRelease(text, { format, source, identity, intents }),
    fingerprint: (format, bytes) => requestReference(identity, format, intents, bytes),
    outputKey: event => event.release_id
  });
}
