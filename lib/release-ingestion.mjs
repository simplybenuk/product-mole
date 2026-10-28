import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReleaseId, normalizeChangeRecord, validateChangeRecord } from './change-records.mjs';
import { registerSource, resolveSource, findSourceRecordsByPath } from './source-registry.mjs';
import { assertLifecycleWritable, listLifecycleRecords, registerLifecycleRecord } from './review-lifecycle.mjs';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = v => createHash('sha256').update(v).digest('hex');
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

// Reject every symlink component, including within registry and ledger trees.
function safe(root, relative) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Unsafe workspace path');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Unsafe symlink: ${relative}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}
function checkTree(root, relative) {
  const target = safe(root, relative);
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) for (const name of fs.readdirSync(target)) checkTree(root, `${relative}/${name}`);
}
function ensureRegistration(root, file, state, sourceIds = []) {
  const existing = findSourceRecordsByPath(root, file);
  if (existing.length > 1) throw new Error('Ambiguous registered output');
  const source = existing[0] ?? registerSource(root, { path: file, source_type: 'export', captured_by: 'release-ingestion' }).record;
  const records = listLifecycleRecords(root);
  if (!records.some(r => r.source_id === source.source_id)) registerLifecycleRecord(root, {
    sourceId: source.source_id, state, actor: 'release-ingestion', actorType: 'agent', sourceIds, newFile: true
  });
  return source;
}

/** Immutable import. Partial runs can be resumed; never delete or replace existing material. */
export function importRelease(root, { file, sourceId, identity, intents = [], format } = {}) {
  root = fs.realpathSync(root);
  if (Boolean(file) === Boolean(sourceId)) throw new Error('Supply exactly one local file or registered sourceId');
  for (const dir of ['governance/sources', 'governance/lifecycle', '6-raw/releases', '5-evidence/releases']) checkTree(root, dir);
  assertLifecycleWritable(root);
  if (sourceId) {
    const resolved = resolveSource(root, sourceId);
    if (!resolved.ok || !resolved.path) throw new Error(`Source cannot resolve uniquely: ${resolved.status}`);
    file = resolved.path;
  }
  // External local input is read-only, but symlink inputs are rejected as well.
  const absolute = path.resolve(root, file);
  const inputRoot = path.parse(absolute).root;
  safe(inputRoot, absolute.slice(inputRoot.length));
  if (!fs.statSync(absolute).isFile()) throw new Error('Input must be a regular file');
  const bytes = fs.readFileSync(absolute);
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  format ??= path.extname(absolute).toLowerCase() === '.json' ? 'json' : 'markdown';
  const initial = parseRelease(decoded, { format, source: { type: 'release', ref: absolute }, identity, intents });
  const stem = hash(initial.release_id);
  const rawPath = `6-raw/releases/${stem}.${format === 'json' ? 'json' : 'md'}`;
  const eventPath = `5-evidence/releases/${stem}.json`;
  const raw = safe(root, rawPath);
  const output = safe(root, eventPath);
  // Check every conflict before writing either file.
  if (fs.existsSync(raw) && !fs.readFileSync(raw).equals(bytes)) throw new Error('Release identity already contains different raw bytes; use a new revision identity');
  const claims = findSourceRecordsByPath(root, rawPath);
  const source = { type: 'release', ref: rawPath, ...(claims[0] ? { source_id: claims[0].source_id } : {}) };
  if (fs.existsSync(output)) {
    const stored = JSON.parse(fs.readFileSync(output, 'utf8'));
    const compared = parseRelease(decoded, { format, source: stored.source, identity, intents });
    if (JSON.stringify(stored) !== JSON.stringify(compared)) throw new Error('Release identity already contains different normalized data; use a new revision identity');
    const resolution = resolveSource(root, stored.source.source_id);
    if (!resolution.ok) throw new Error('Captured raw source is unresolved or changed');
    ensureRegistration(root, eventPath, 'draft', [stored.source.source_id]);
    return { changed: false, path: eventPath, raw_path: resolution.path, event: stored };
  }
  fs.mkdirSync(path.dirname(raw), { recursive: true });
  if (!fs.existsSync(raw)) fs.writeFileSync(raw, bytes, { flag: 'wx' });
  const registered = ensureRegistration(root, rawPath, 'raw');
  const final = parseRelease(decoded, { format, source: { ...source, source_id: registered.source_id }, identity, intents });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(final, null, 2)}\n`, { flag: 'wx' });
  ensureRegistration(root, eventPath, 'draft', [registered.source_id]);
  return { changed: true, path: eventPath, raw_path: rawPath, event: final };
}
