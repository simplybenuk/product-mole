import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerSource } from './source-registry.mjs';
import { registerLifecycleRecord } from './review-lifecycle.mjs';
import { TextDecoder } from 'node:util';

const DAY = 86400000;
const ID = /^src_[0-9a-f-]{36}$/;
const META = 'governance/privacy';
import { scanSensitiveText, scanCaptureFields, PRIVACY_CATEGORIES } from './privacy-policy.mjs';
export { scanSensitiveText } from './privacy-policy.mjs';
const safeError = () => new Error('Privacy operation failed; inspect local permissions, policy and recovery state.');


// Shared canonical eligibility contract for downstream readers.
export function isEligiblePrivacyPath(sourceId, relative) {
  return relative === `6-raw/inbox/${sourceId}.md`;
}

function generatedLocations(sourceId) {
  return [`6-raw/staging/${sourceId}.bin`, `6-raw/quarantine/${sourceId}.bin`, `6-raw/quarantine/${sourceId}.md`, `6-raw/inbox/${sourceId}.md`];
}

function safePath(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')) throw safeError();
  const base = path.resolve(root);
  let current = base;
  if (fs.lstatSync(base).isSymbolicLink()) throw safeError();
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw safeError(); }
    catch (err) { if (err.code !== 'ENOENT') throw safeError(); }
  }
  return current;
}
function write(root, relative, data, exclusive = false) {
  const file = safePath(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (exclusive) { fs.writeFileSync(file, data, { flag: 'wx', mode: 0o600 }); return; }
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, data, { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, file);
}
function save(root, record) { write(root, `${META}/${record.source_id}.json`, JSON.stringify(record, null, 2) + '\n'); }
export function loadPrivacyPolicy(root) {
  try {
    const file = safePath(root, 'mole.privacy.json');
    const p = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { ttl_days: 7 };
    if (!p || Object.keys(p).some(k => k !== 'ttl_days') || !Number.isInteger(p.ttl_days) || p.ttl_days < 1 || p.ttl_days > 30) throw safeError();
    return p;
  } catch { throw safeError(); }
}
export function privacyInventory(root) {
  const dir = safePath(root, META);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort().map(n => {
    try {
      const r = JSON.parse(fs.readFileSync(safePath(root, `${META}/${n}`), 'utf8'));
      if (!ID.test(r.source_id) || n !== `${r.source_id}.json` || r.schema_version !== 1 || !Number.isFinite(Date.parse(r.captured_at)) || !Number.isFinite(Date.parse(r.expires_at)) || !['active','deleted','deletion_failed'].includes(r.retention_state) || (r.current_path !== null && !generatedLocations(r.source_id).includes(r.current_path))) throw safeError();
      const fields = new Set(['schema_version','source_id','captured_at','expires_at','outcome','categories','review_state','retention_state','current_path','deleted_at']);
      const categories = new Set(PRIVACY_CATEGORIES);
      if (Object.keys(r).some(k => !fields.has(k)) || !['no_rule_match','redacted','quarantined'].includes(r.outcome) || !['pending','reviewed'].includes(r.review_state) || !r.categories || Array.isArray(r.categories) || Object.entries(r.categories).some(([k,v]) => !categories.has(k) || !Number.isSafeInteger(v) || v < 0) || Date.parse(r.expires_at) < Date.parse(r.captured_at) || (r.deleted_at && !Number.isFinite(Date.parse(r.deleted_at)))) throw safeError();
      return r;
    } catch { throw safeError(); }
  });
}

function storeCapture(root, { sourceId = `src_${randomUUID()}`, content, now = new Date(), supported = true, capturedAt } = {}, inputScan = null) {
  try {
    const policy = loadPrivacyPolicy(root);
    if (!ID.test(sourceId)) throw safeError();
    const previous = privacyInventory(root).find(r => r.source_id === sourceId);
    if (previous) return { record: previous, path: previous.current_path, outcome: previous.outcome };
    const date = new Date(capturedAt || now).toISOString();
    const result = supported ? scanSensitiveText(content) : { categories: {}, outcome: 'quarantined' };
    if (inputScan) {
      for (const [category, count] of Object.entries(inputScan.categories)) result.categories[category] = (result.categories[category] || 0) + count;
      if (inputScan.outcome === 'quarantined') result.outcome = 'quarantined';
      else if (result.outcome === 'no_rule_match' && inputScan.outcome === 'redacted') result.outcome = 'redacted';
    }
    const quarantine = result.outcome === 'quarantined';
    const staging = `6-raw/staging/${sourceId}.bin`;
    const relative = `6-raw/${quarantine ? 'quarantine' : 'inbox'}/${sourceId}.${quarantine ? 'bin' : 'md'}`;
    // Intent first: a crash leaves a safe-ID staging file covered by retention.
    const record = { schema_version: 1, source_id: sourceId, captured_at: date, expires_at: new Date(Date.parse(date) + policy.ttl_days * DAY).toISOString(), outcome: result.outcome, categories: result.categories, review_state: 'pending', retention_state: 'active', current_path: staging };
    save(root, record);
    write(root, staging, quarantine ? content : result.cleaned, true);
    const target = safePath(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.renameSync(safePath(root, staging), target);
    record.current_path = relative;
    save(root, record);
    return { record, path: relative, outcome: record.outcome };
  } catch { throw safeError(); }
}

export function ingestPrivateCapture(root, options = {}) {
  return storeCapture(root, options);
}

export function ingestCaptureFields(root, { fields, render, ...options }) {
  try {
    const scan = scanCaptureFields(fields);
    const quarantine = scan.outcome === 'quarantined';
    // Preserve the original only in quarantine; every ordinary copy uses cleaned values.
    const content = render(quarantine ? fields : scan.cleaned, quarantine);
    return storeCapture(root, { ...options, content }, scan);
  } catch { throw safeError(); }
}

function rawFiles(root, relative = '6-raw') {
  const dir = safePath(root, relative);
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${relative}/${entry.name}`;
    if (rel === '6-raw/inbox/README.md') continue;
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw safeError();
    if (entry.isDirectory()) files.push(...rawFiles(root, rel)); else files.push(rel);
  }
  return files;
}
function hasClaims(root) {
  const dir = safePath(root, 'governance');
  return fs.existsSync(dir) && fs.readdirSync(dir).some(n => /inbox-processing.*lock/i.test(n));
}

// Manual additions are never auto-published, even when a rule finds nothing.
export function scanRaw(root, { apply = false, now = new Date() } = {}) {
  loadPrivacyPolicy(root);
  const records = privacyInventory(root);
  const known = new Set(records.flatMap(r => generatedLocations(r.source_id)));
  const unknown = rawFiles(root).filter(p => !known.has(p));
  if (apply && hasClaims(root)) throw safeError();
  let scanned = 0;
  for (const rel of unknown) {
    scanned++;
    if (!apply) continue;
    const file = safePath(root, rel);
    const stat = fs.statSync(file);
    const content = fs.readFileSync(file);
    // Opaque filename and no original-path metadata: filenames can themselves contain PII.
    ingestPrivateCapture(root, { content, supported: false, now, capturedAt: new Date(Math.min(stat.birthtimeMs || stat.mtimeMs, stat.mtimeMs, +new Date(now))) });
    fs.unlinkSync(file);
  }
  return { applied: apply, unregistered_items: scanned };
}

export function auditPrivacy(root, { now = new Date() } = {}) {
  const summary = scanRaw(root);
  const records = privacyInventory(root);
  return { ...summary, policy: 'valid', records: records.length,
    expired: records.filter(r => r.retention_state !== 'deleted' && Date.parse(r.expires_at) <= +new Date(now)).length,
    quarantined: records.filter(r => r.outcome === 'quarantined' && r.retention_state !== 'deleted').length,
    deletion_failed: records.filter(r => r.retention_state === 'deletion_failed').length,
    interrupted_staging: records.filter(r => r.current_path?.startsWith('6-raw/staging/')).length,
    unsafe_permissions: records.filter(r => r.current_path && fs.existsSync(safePath(root, r.current_path)) && (fs.statSync(safePath(root, r.current_path)).mode & 0o077) !== 0).length
  };
}

export function purgeRaw(root, { apply = false, now = new Date(), unlink = fs.unlinkSync } = {}) {
  loadPrivacyPolicy(root);
  const unregistered = scanRaw(root).unregistered_items;
  const blocked = hasClaims(root) || unregistered > 0;
  const results = [];
  for (const record of privacyInventory(root)) {
    const locations = generatedLocations(record.source_id);
    if (Date.parse(record.expires_at) > +new Date(now)) continue;
    if (record.retention_state === 'deleted' && !locations.some(rel => fs.existsSync(safePath(root, rel)))) continue;
    const result = { source_id: record.source_id, status: blocked ? 'recovery_required' : apply ? 'deleted' : 'would_delete' };
    if (apply && !blocked) {
      try {
        // Cover crash between rename and manifest checkpoint, plus staging leftovers.
        for (const rel of locations) {
          try { unlink(safePath(root, rel)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
        }
        if (locations.some(rel => fs.existsSync(safePath(root, rel)))) throw safeError();
        record.current_path = null;
        record.retention_state = 'deleted';
        record.deleted_at ||= new Date(now).toISOString();
      } catch { record.retention_state = 'deletion_failed'; result.status = 'deletion_failed'; }
      save(root, record);
    }
    results.push(result);
  }
  return { applied: apply, recovery_required: blocked, unregistered_items: unregistered, items: results };
}

export function reviewQuarantine(root, sourceId, { apply = false, confirmReviewed = false } = {}) {
  if (!ID.test(sourceId) || !confirmReviewed) throw safeError();
  const record = privacyInventory(root).find(r => r.source_id === sourceId);
  if (!record || record.outcome !== 'quarantined' || record.retention_state !== 'active' || Date.parse(record.expires_at) <= Date.now() || hasClaims(root)) throw safeError();
  // Review supplies a separate UTF-8 cleaned derivative at an opaque, ignored path.
  const derivative = `6-raw/quarantine/${sourceId}.md`;
  let cleaned;
  try { cleaned = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(safePath(root, derivative))); } catch { throw safeError(); }
  const result = scanSensitiveText(cleaned);
  if (result.outcome === 'quarantined') throw safeError();
  if (apply) {
    write(root, `6-raw/inbox/${sourceId}.md`, result.cleaned, true);
    registerSource(root, { source_id: sourceId, path: `6-raw/inbox/${sourceId}.md`, source_type: 'note', captured_at: record.captured_at, captured_by: '[PERSON_NAME]', channel: 'privacy-review', visibility: 'internal' });
    registerLifecycleRecord(root, { sourceId, state: 'raw', actor: 'mole-privacy', actorType: 'automation', reason: 'Privacy reviewed derivative. Durable promotion still requires human lifecycle approval.' });
    fs.unlinkSync(safePath(root, derivative));
    record.current_path = `6-raw/inbox/${sourceId}.md`;
    record.outcome = result.outcome;
    record.review_state = 'reviewed';
    // Original remains under the same expiry. It is never a downstream input.
    save(root, record);
  }
  return { source_id: sourceId, applied: apply, review_state: apply ? 'reviewed' : 'pending' };
}

export function assertPrivacyProcessing(root, paths) {
  const records = privacyInventory(root);
  for (const p of paths) {
    const record = records.find(r => r.current_path === p);
    if (!record || record.outcome === 'quarantined' || record.retention_state !== 'active' || Date.parse(record.expires_at) <= Date.now()) throw safeError();
    try {
      const live = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(safePath(root, p)));
      const scan = scanSensitiveText(live);
      if (scan.outcome === 'quarantined' || scan.cleaned !== live) throw safeError();
    } catch { throw safeError(); }
  }
}
