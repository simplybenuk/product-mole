import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isSourceId, readUniqueSourceMetadata, findSourceRecordsByPath, toWorkspaceRelativePath } from './source-registry.mjs';

import { assertPrivacyProcessing, privacyInventory, loadPrivacyPolicy } from './privacy.mjs';
import { assertSafeMetadata, scanSensitiveText } from './privacy-policy.mjs';

const DIR = 'governance/inbox-duplicates';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error('Duplicate review required: ' + message); };
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

// Versioned normalization deliberately preserves punctuation, numbers and word order.
export function normalizeDuplicateText(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    .replace(/^---\n[\s\S]*?\n---(?=\n)/, block => block.replace(/^(source_id|captured_by|created_at|captured_at):[^\n]*\n/gm, ''))
    .normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function safePath(root, relative) {
  toWorkspaceRelativePath(root, relative);
  let current = path.resolve(root);
  if (fs.lstatSync(current).isSymbolicLink()) fail('symlink workspace');
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('symlink metadata or source');
  }
  return current;
}
function readLedgerJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { fail('unreadable or malformed duplicate ledger'); }
}
function ledger(root, kind) {
  const dir = safePath(root, `${DIR}/${kind}`);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().map(name => {
    if (!name.endsWith('.json')) fail('unexpected ledger file');
    const value = readLedgerJson(safePath(root, `${DIR}/${kind}/${name}`));
    if (kind === 'records') {
      if (Object.keys(value).sort().join(',') !== 'attachments,byte_hash,captured_at,channel_hash,fingerprint,reference_hash,registered_at,source_id,version'
        || name !== `${value.source_id}.json` || !isSourceId(value.source_id)
        || value.version !== 2 || !hex(value.fingerprint) || !hex(value.byte_hash)
        || !Array.isArray(value.attachments) || !value.attachments.every(hex)
        || !date(value.registered_at) || !date(value.captured_at)
        || !hex(value.channel_hash) || !hex(value.reference_hash)) fail('invalid or conflicting fingerprint record');
    } else {
      if (!validDecision(value)) fail('invalid or conflicting decision');
      assertSafeMetadata(value);
      if (name !== `${hash(JSON.stringify(value))}.json`) fail('invalid or conflicting decision');
    }
    return value;
  });
}
function write(root, kind, name, value) {
  const file = safePath(root, `${DIR}/${kind}/${name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST' || !isDeepStrictEqual(readLedgerJson(file), value)) throw error;
  }
}
// No general resolver here: it can hash unrelated registry files before gating.
function eligibleSource(root, id) {
  loadPrivacyPolicy(root);
  const privacy = privacyInventory(root).find(r => r.source_id === id);
  if (!privacy || !privacy.current_path || !privacy.current_path.startsWith('6-raw/inbox/')) fail('privacy eligibility required');
  assertPrivacyProcessing(root, [privacy.current_path]);
  const record = readUniqueSourceMetadata(root, id);
  if (record.current_path !== privacy.current_path) fail('source move requires privacy-aware reconciliation');
  assertSafeMetadata(record);
  const owners = findSourceRecordsByPath(root, record.current_path);
  if (owners.length !== 1 || owners[0].source_id !== id) fail('ambiguous source path');
  return record;
}
function live(root, id) {
  const record = eligibleSource(root, id);
  const file = safePath(root, record.current_path);
  if (fs.statSync(file).size > 2 * 1024 * 1024) fail('source exceeds local comparison limit');
  assertPrivacyProcessing(root, [record.current_path]);
  const bytes = fs.readFileSync(file);
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const scanned = scanSensitiveText(decoded);
  if (scanned.outcome === 'quarantined' || scanned.cleaned !== decoded) fail('privacy changed during comparison');
  if (hash(bytes) !== record.content_hash?.value) fail('source changed during comparison');
  return { record, bytes };
}
function snapshot(root, id) {
  const metadata = eligibleSource(root, id);
  for (const item of metadata.attachments) eligibleSource(root, item.source_id);
  const { record, bytes } = live(root, id);
  const attachments = record.attachments.map(item => {
    const attachment = live(root, typeof item === 'string' ? item : item.source_id);
    return hash(attachment.bytes);
  }).sort();
  const isText = record.media_type?.startsWith('text/') || record.media_type === 'application/json';
  let text = null;
  if (isText) {
    try { text = normalizeDuplicateText(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('text source is not valid UTF-8'); }
  }
  return { text, metadata: {
    version: 2, source_id: id,
    fingerprint: hash(JSON.stringify(['mole-normalized-v1', text ?? hash(bytes), attachments])),
    byte_hash: hash(bytes), attachments,
    captured_at: record.captured_at, channel_hash: hash(record.channel || ''), reference_hash: hash(record.source_reference || ''),
    registered_at: new Date().toISOString()
  } };
}
function decisionFor(decisions, a, b) {
  const found = decisions.filter(d => d.source_id === a && d.target_id === b || d.source_id === b && d.target_id === a);
  if (found.length > 1) fail('multiple decisions for a source pair');
  return found[0];
}
export function compareDuplicateText(a, b) {
  const tokens = text => normalizeDuplicateText(text).match(/[\p{L}\p{N}]+/gu) || [];
  const left = tokens(a), right = tokens(b);
  const x = new Set(left), y = new Set(right);
  const shared = [...x].filter(t => y.has(t)).length;
  const score = shared / Math.max(1, new Set([...x, ...y]).size);
  return { score, shared_tokens: shared, left_tokens: left.length, right_tokens: right.length, method: 'token-jaccard-v1' };
}
export function inspectInboxDuplicates(root, sourceId, options = {}) {
  if (!isSourceId(sourceId)) fail('invalid source ID');
  const threshold = options.threshold ?? 0.8;
  if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 1) fail('threshold must be between 0.5 and 1');
  const records = options.stagedRecords || ledger(root, 'records'), decisions = ledger(root, 'decisions');
  if (!options.stagedRecords) prepareBatch(root, [sourceId]);
  const current = snapshot(root, sourceId);
  const existing = records.find(r => r.source_id === sourceId);
  if (existing && !isDeepStrictEqual({ ...existing, registered_at: null }, { ...current.metadata, registered_at: null })) fail('indexed source changed; reconcile explicitly');

  const candidates = [];
  for (const record of records.filter(r => r.source_id !== sourceId)) {
    const decision = decisionFor(decisions, sourceId, record.source_id);
    const conflicts = ['captured_at', 'channel_hash', 'reference_hash'].filter(k => record[k] !== current.metadata[k]);
    const privacy = privacyInventory(root);
    if ([sourceId, record.source_id].some(id => privacy.find(r => r.source_id === id)?.outcome === 'redacted')) conflicts.push('privacy_redaction');
    if (record.fingerprint === current.metadata.fingerprint) {
      candidates.push({ source_id: record.source_id, match: 'exact', conflicts, decision: decision || null });
    } else if (options.near !== false && current.text) {
      // Deleted raw text is never reconstructed from durable hashes.
      let previous;
      const retained = privacyInventory(root).find(r => r.source_id === record.source_id);
      if (retained?.retention_state === 'deleted') continue;
      previous = snapshot(root, record.source_id);
      if (previous.metadata.fingerprint !== record.fingerprint || !previous.text) continue;
      const explanation = compareDuplicateText(current.text, previous.text);
      if (explanation.score >= threshold && explanation.shared_tokens >= 5) candidates.push({ source_id: record.source_id, match: 'near', conflicts, explanation, attachments_equal: isDeepStrictEqual(record.attachments, current.metadata.attachments), decision: decision || null });
    } else if (decision) candidates.push({ source_id: record.source_id, match: 'decision', conflicts, decision });
  }
  if (!existing && options.persist !== false) write(root, 'records', sourceId, current.metadata);
  return { source_id: sourceId, fingerprint: current.metadata.fingerprint, threshold, candidates };
}
// Validate the whole batch, including all indexed live candidates, before writes.
// Retained tombstones participate through cleaned fingerprints only.
function prepareBatch(root, ids) {
  const records = ledger(root, 'records');
  const retained = privacyInventory(root);
  for (const record of records) {
    if (retained.find(r => r.source_id === record.source_id)?.retention_state === 'deleted') continue;
    const current = snapshot(root, record.source_id).metadata;
    if (!isDeepStrictEqual({ ...record, registered_at: null }, { ...current, registered_at: null })) fail('indexed source changed; reconcile explicitly');
  }
  const pending = [];
  for (const id of new Set(ids)) {
    const current = snapshot(root, id).metadata;
    const old = records.find(r => r.source_id === id);
    if (!old) pending.push(current);
    else if (!isDeepStrictEqual({ ...old, registered_at: null }, { ...current, registered_at: null })) fail('indexed source changed; reconcile explicitly');
  }
  return { records: [...records, ...pending], pending };
}
export function inspectInboxDuplicateBatch(root, ids, options = {}) {
  const staged = prepareBatch(root, ids);
  const reports = ids.map(id => inspectInboxDuplicates(root, id, { ...options, stagedRecords: staged.records, persist: false }));
  for (const record of staged.pending) write(root, 'records', record.source_id, record);
  return reports;
}
const REASONS = new Set(['retry', 'sync-copy', 'same-observation', 'related-observation', 'newer-observation', 'separate-event']);
function validDecision(d) {
  return Object.keys(d).sort().join(',') === 'actor,reason,source_id,status,target_id,timestamp,version' && d.version === 1 && isSourceId(d.source_id) && isSourceId(d.target_id) && d.source_id !== d.target_id
    && ['duplicate', 'linked', 'superseded', 'distinct'].includes(d.status)
    && /^[A-Za-z0-9_.-]{1,64}$/.test(d.actor) && date(d.timestamp) && REASONS.has(d.reason);
}
export function recordDuplicateDecision(root, options) {
  if (options.confirmHuman !== true) fail('human confirmation required');
  const d = { version: 1, source_id: options.sourceId, target_id: options.targetId, status: options.status, actor: options.actor, timestamp: options.timestamp || new Date().toISOString(), reason: options.reason };
  assertSafeMetadata(d);
  if (!validDecision(d)) fail('invalid decision; use a local actor ID and documented reason code');
  const records = ledger(root, 'records');
  if (![d.source_id, d.target_id].every(id => records.some(r => r.source_id === id))) fail('check both sources before deciding');
  const old = decisionFor(ledger(root, 'decisions'), d.source_id, d.target_id);
  if (old) {
    if (!isDeepStrictEqual({ ...old, timestamp: null }, { ...d, timestamp: null })) fail('pair already has a different immutable decision');
    return old;
  }
  prepareBatch(root, []);
  write(root, 'decisions', hash(JSON.stringify(d)), d);
  return d;
}

// Called under the inbox mutation mutex. Privacy eligibility is mandatory,
// including legacy paths; registration alone is not privacy review.
export function assertInboxDuplicateProcessing(root, paths, receipts = []) {
  assertPrivacyProcessing(root, paths);
  if (!paths.length) return;
  const sourceIds = paths.map(file => {
    const owners = findSourceRecordsByPath(root, file);
    if (owners.length !== 1) fail('source registration and unique privacy identity required');
    return owners[0].source_id;
  });
  const staged = prepareBatch(root, sourceIds);
  const seen = new Set();
  const processedIds = new Set(receipts.flatMap(r => (r.receipt || r).processed_sources || []).map(s => s.source_id));
  for (const file of paths) {
    const records = findSourceRecordsByPath(root, file);
    if (records.length > 1) fail('multiple source IDs claim a path');
    if (!records.length) fail('source registration and privacy eligibility required');
    const id = records[0].source_id;
    if (seen.has(id)) fail('one source appears at multiple paths');
    const report = inspectInboxDuplicates(root, id, { near: false, stagedRecords: staged.records, persist: false });
    if (processedIds.has(id)) fail('source already processed ' + id);
    for (const candidate of report.candidates) {
      const d = candidate.decision;
      if (d && ['duplicate', 'superseded'].includes(d.status) && d.source_id === id) fail('source marked ' + d.status + '; reuse target ' + d.target_id);
      if (candidate.match === 'exact' && !d) {
        if (candidate.conflicts.length) fail('exact content has conflicting capture metadata; human decision required');
        if (seen.has(candidate.source_id) || processedIds.has(candidate.source_id)) fail('exact content already processed; reuse source ' + candidate.source_id);
      }
    }
    seen.add(id);
  }
  for (const record of staged.pending) write(root, 'records', record.source_id, record);
}
