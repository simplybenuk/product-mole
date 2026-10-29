import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerSource, readUniqueSourceMetadata, findSourceRecordsByPath, hashFileSync, reconcileSource } from './source-registry.mjs';
import { registerLifecycleRecord } from './review-lifecycle.mjs';
import { TextDecoder } from 'node:util';

import { privacyEligibleLocations, generatedPrivacyLocations } from './privacy-locations.mjs';

const DAY = 86400000;
const ID = /^src_[0-9a-f-]{36}$/;
const META = 'governance/privacy';
import { scanSensitiveText, scanCaptureFields, PRIVACY_CATEGORIES } from './privacy-policy.mjs';
export { scanSensitiveText } from './privacy-policy.mjs';
const safeError = () => new Error('Privacy operation failed; inspect local permissions, policy and recovery state.');


const generatedLocations = generatedPrivacyLocations;


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
  if (apply && (hasClaims(root) || privacyMoveInventory(root).some(r => r.state === 'prepared'))) throw safeError();
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
    pending_moves: privacyMoveInventory(root).filter(m => m.state === 'prepared').map(m => m.source_id),
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
  const blocked = hasClaims(root) || unregistered > 0 || privacyMoveInventory(root).some(r => r.state === 'prepared');
  const results = [];
  for (const record of privacyInventory(root)) {
    const locations = generatedLocations(record.source_id);
    if (Date.parse(record.expires_at) > +new Date(now)) continue;
    if (record.retention_state === 'deleted' && !locations.some(rel => fs.existsSync(safePath(root, rel)))) continue;
    const result = { source_id: record.source_id, status: blocked ? 'recovery_required' : apply ? 'deleted' : 'would_delete' };
    if (apply && !blocked) {
      try {
        const archive = privacyEligibleLocations(record.source_id)[1];
        if (fs.existsSync(safePath(root, archive))) {
          const owners = findSourceRecordsByPath(root, archive);
          if (owners.length !== 1 || owners[0].source_id !== record.source_id) throw safeError();
        }
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

function assertCleanPrivacyPath(root, record, p) {
  if (!record || !privacyEligibleLocations(record.source_id).includes(p) || record.outcome === 'quarantined' || record.retention_state !== 'active' || Date.parse(record.expires_at) <= Date.now()) throw safeError();
  try {
    const live = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(safePath(root, p)));
    const scan = scanSensitiveText(live);
    if (scan.outcome === 'quarantined' || scan.cleaned !== live) throw safeError();
  } catch { throw safeError(); }
}
// Metadata-only gate shared with immutable import readers. No byte discovery.
export function assertPrivacySourceMetadata(root, sourceId) {
  const record = privacyInventory(root).find(r => r.source_id === sourceId);
  const moves = privacyMoveInventory(root);
  if (!record || record.outcome === 'quarantined' || record.retention_state !== 'active' || Date.parse(record.expires_at) <= Date.now()
    || !privacyEligibleLocations(sourceId).includes(record.current_path)
    || moves.some(m => m.source_id === sourceId && m.state === 'prepared')) throw safeError();
  const [inbox, archive] = privacyEligibleLocations(sourceId);
  if (record.current_path === archive) {
    assertArchiveDirectory(root);
    if (!moves.some(m => m.source_id === sourceId && m.state === 'completed') || fs.existsSync(safePath(root, inbox))) throw safeError();
  }
  return record;
}
export function assertPrivacyProcessing(root, paths) {
  const records = privacyInventory(root);
  for (const p of paths) {
    const record = records.find(r => r.current_path === p);
    if (!record) throw safeError();
    assertPrivacySourceMetadata(root, record.source_id);
    assertCleanPrivacyPath(root, record, p);
  }
}

// Move intents contain generated locators and state only, never source content.
export function privacyMoveInventory(root) {
  const dir = safePath(root, 'governance/privacy/moves');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().map(name => {
    try {
      const move = JSON.parse(fs.readFileSync(safePath(root, `governance/privacy/moves/${name}`), 'utf8'));
      const fields = ['schema_version','source_id','from','to','state','started_at','completed_at'];
      const [from, to] = privacyEligibleLocations(move.source_id);
      if (Object.keys(move).sort().join() !== fields.sort().join() || !ID.test(move.source_id) || name !== `${move.source_id}.json` || move.schema_version !== 1 || move.from !== from || move.to !== to || !['prepared','completed'].includes(move.state) || !Number.isFinite(Date.parse(move.started_at)) || (move.state === 'prepared' ? move.completed_at !== null : !Number.isFinite(Date.parse(move.completed_at)))) throw safeError();
      return move;
    } catch { throw safeError(); }
  });
}
function assertArchiveDirectory(root) {
  const dir = safePath(root, '6-raw/inbox/archive');
  if (fs.existsSync(dir) && fs.readdirSync(dir, { withFileTypes: true }).some(e => e.isSymbolicLink() || /conflict(?:ed)?[ _-]+copy|copy[ _-]+of|sync[ _-]+conflict/i.test(e.name))) throw safeError();
}
function assertMoveCoordination(root) {
  assertArchiveDirectory(root);
  if (hasClaims(root)) throw safeError();
  const lifecycle = safePath(root, 'governance/lifecycle');
  if (fs.existsSync(lifecycle) && fs.readdirSync(lifecycle).some(n => /lock|conflict(?:ed)?[ _-]+copy/i.test(n))) throw safeError();
}
// A local multi-step operation, not a filesystem or cross-ledger transaction.
// Every partial state keeps a prepared intent and requires explicit recovery.
export function archiveManagedRaw(root, sourceId, { apply = false, recover = false } = {}) {
  try {
    loadPrivacyPolicy(root);
    if (!ID.test(sourceId)) throw safeError();
    assertMoveCoordination(root);
    const record = privacyInventory(root).find(r => r.source_id === sourceId);
    const source = readUniqueSourceMetadata(root, sourceId);
    const [from, to] = privacyEligibleLocations(sourceId);
    const sourceFile = safePath(root, from), targetFile = safePath(root, to);
    const intents = privacyMoveInventory(root);
    let intent = intents.find(m => m.source_id === sourceId);
    if (!record || ![from, to].includes(record.current_path) || ![from, to].includes(source.current_path)) throw safeError();
    if (intent?.state === 'prepared' && !recover) throw safeError();
    const sourceExists = fs.existsSync(sourceFile), targetExists = fs.existsSync(targetFile);
    if (findSourceRecordsByPath(root, from).some(r => r.source_id !== sourceId)) throw safeError();
    const targetOwners = findSourceRecordsByPath(root, to);
    if (targetOwners.some(r => r.source_id !== sourceId)) throw safeError();
    if (!intent) {
      if (record.current_path !== from || source.current_path !== from || !sourceExists || targetExists) throw safeError();
    } else if (intent.state === 'completed') {
      if (sourceExists || !targetExists || record.current_path !== to || source.current_path !== to) throw safeError();
    } else {
      if (!sourceExists && !targetExists) throw safeError();
      if (sourceExists && targetExists) {
        const left = fs.statSync(sourceFile), right = fs.statSync(targetFile);
        if (left.dev !== right.dev || left.ino !== right.ino) throw safeError();
      } else if (sourceExists && (record.current_path !== from || source.current_path !== from)) throw safeError();
      else if (!sourceExists && (record.current_path !== to || source.current_path !== to)) throw safeError();
    }
    const livePath = sourceExists ? from : to;
    assertCleanPrivacyPath(root, record, livePath);
    const digest = hashFileSync(safePath(root, livePath));
    if (digest.value !== source.content_hash?.value || digest.byte_size !== source.byte_size) throw safeError();
    if (!apply) return { source_id: sourceId, path: to, applied: false, recovery: intent?.state === 'prepared' };
    if (intent?.state === 'completed') return { source_id: sourceId, path: to, applied: true, idempotent: true };
    if (!intent) {
      intent = { schema_version: 1, source_id: sourceId, from, to, state: 'prepared', started_at: new Date().toISOString(), completed_at: null };
      write(root, `governance/privacy/moves/${sourceId}.json`, JSON.stringify(intent, null, 2) + '\n', true);
    }
    if (!targetExists) {
      fs.mkdirSync(path.dirname(targetFile), { recursive: true, mode: 0o700 });
      // link is exclusive; rename could silently overwrite a raced destination.
      fs.linkSync(sourceFile, targetFile);
    }
    assertMoveCoordination(root);
    assertCleanPrivacyPath(root, record, to);
    record.current_path = to;
    save(root, record);
    reconcileSource(root, sourceId, { path: to, reason: 'Managed privacy archive.' });
    assertMoveCoordination(root);
    if (fs.existsSync(sourceFile)) {
      const left = fs.statSync(safePath(root, from)), right = fs.statSync(safePath(root, to));
      if (left.dev !== right.dev || left.ino !== right.ino) throw safeError();
      fs.unlinkSync(sourceFile);
    }
    intent.state = 'completed'; intent.completed_at = new Date().toISOString();
    write(root, `governance/privacy/moves/${sourceId}.json`, JSON.stringify(intent, null, 2) + '\n');
    return { source_id: sourceId, path: to, applied: true, recovered: recover };
  } catch { throw safeError(); }
}
