import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { formatUtcTimestamp, resolveCapturedBy } from './capture.mjs';

const SCHEMA_VERSION = 2;
const DEFAULT_LEASE_MS = 24 * 60 * 60 * 1000;
const LOCK_REL_PATH = path.join('governance', 'inbox-processing.lock.json');
const RECEIPTS_REL_DIR = path.join('governance', 'run-receipts', 'inbox-processing');
const OVERRIDES_REL_DIR = path.join(RECEIPTS_REL_DIR, 'overrides');
const INBOX_REL_PATH = '6-raw/inbox';
const INBOX_REL_PREFIX = INBOX_REL_PATH + '/';
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MUTATION_MUTEX_PREFIX = 'mole-inbox-processing-';
const MUTATION_MUTEX_STALE_MS = 5 * 60 * 1000;
const activeMutationTokens = new Set();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function toPortablePath(value) {
  return String(value).split(path.sep).join('/');
}

function relativePath(instanceRoot, absolutePath) {
  return toPortablePath(path.relative(path.resolve(instanceRoot), absolutePath));
}

function readJsonIfExists(file) {
  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8');
    return {
      exists: true,
      contents,
      value: JSON.parse(contents),
      error: null
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, value: null, error: null };
    return { exists: true, contents, value: null, error: err };
  }
}

function writeJsonExclusive(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx'
  });
}

function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const temporary = file + '.' + process.pid + '.' + randomBytes(5).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', {
      encoding: 'utf8',
      flag: 'wx'
    });
    fs.renameSync(temporary, file);
  } catch (err) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Preserve the original failure. Temporary metadata is safe to inspect later.
    }
    throw err;
  }
}

function asDate(value, fallback, label) {
  const date = value === undefined || value === null ? fallback : new Date(value);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('Invalid ' + label + '.');
  }
  return date;
}

function asLeaseMs(options = {}) {
  const value = options.leaseMs ?? options.leaseDurationMs ?? DEFAULT_LEASE_MS;
  const leaseMs = Number(value);
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new Error('Lease duration must be a positive number of milliseconds.');
  }
  return Math.floor(leaseMs);
}

function createRunId() {
  return 'run-' + formatUtcTimestamp(new Date()) + '-' + randomBytes(6).toString('hex');
}

function normalizeRunId(value) {
  const runId = String(value || '').trim();
  return runId || createRunId();
}

function getRequestedRunId(options = {}) {
  return String(options.runId || options.lockId || '').trim();
}

function isValidRunId(runId) {
  return RUN_ID_PATTERN.test(String(runId || '').trim());
}

function resolveProcessor(options = {}, explicitKey = 'processor') {
  return resolveCapturedBy(
    options[explicitKey] || options.claimedBy || options.actor || options.overrideBy
  );
}

function resolveHost(options = {}) {
  return String(options.host || process.env.MOLE_HOST || os.hostname() || 'unknown').trim() || 'unknown';
}

function invalidInboxPath(message) {
  const error = new Error(message);
  error.code = 'INVALID_INBOX_PATH';
  return error;
}

function isWindowsAbsolute(value) {
  return path.win32.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function pathContainsSymlink(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return true;

  let current = root;
  for (const part of relative.split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      return true;
    }
  }
  return false;
}

function canonicalizeInboxPath(instanceRoot, value, options = {}) {
  const allowLegacyAliases = Boolean(options.allowLegacyAliases);
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: 'Inbox paths must be nonempty strings.' };
  }

  const text = value;
  if (text !== text.trim() || text.includes('\\') || text.includes('\0')) {
    return { ok: false, error: 'Inbox paths must not contain surrounding whitespace, backslashes, or NUL characters.' };
  }

  const absoluteInput = path.isAbsolute(text) || path.posix.isAbsolute(text) || isWindowsAbsolute(text);
  if (absoluteInput && !allowLegacyAliases) {
    return { ok: false, error: 'Inbox paths must be canonical repository-relative paths; absolute paths are rejected.' };
  }

  const normalized = path.posix.normalize(text);
  const hasTraversalSegment = text.split('/').some((segment) => segment === '..');
  const onlyLegacyDotPrefix = allowLegacyAliases && text.startsWith('./')
    && !hasTraversalSegment && text.split('/').slice(1).every((segment) => segment !== '.');
  if (!absoluteInput && normalized !== text && !onlyLegacyDotPrefix) {
    return { ok: false, error: 'Inbox paths must be canonical and must not use dot, traversal, or duplicate-slash segments.' };
  }
  if (hasTraversalSegment) {
    return { ok: false, error: 'Inbox paths must not contain traversal segments.' };
  }

  const root = path.resolve(instanceRoot);
  const absolute = absoluteInput ? path.normalize(text) : path.resolve(root, text);
  const relative = toPortablePath(path.relative(root, absolute));
  if (!relative || relative === '.' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    return { ok: false, error: 'Inbox paths must resolve inside the workspace.' };
  }
  if (!relative.startsWith(INBOX_REL_PREFIX)) {
    return { ok: false, error: 'Inbox paths must resolve inside 6-raw/inbox.' };
  }

  const inboxRoot = path.join(root, INBOX_REL_PATH);
  const relativeToInbox = path.relative(inboxRoot, absolute);
  if (!relativeToInbox || relativeToInbox.startsWith('..' + path.sep)
    || path.isAbsolute(relativeToInbox) || pathContainsSymlink(root, absolute)) {
    return { ok: false, error: 'Inbox paths must resolve through non-symlinked paths inside 6-raw/inbox.' };
  }

  if (!allowLegacyAliases && relative !== text) {
    return { ok: false, error: 'Inbox paths must use their canonical repository-relative spelling.' };
  }
  return { ok: true, path: relative };
}

function normalizePathList(instanceRoot, values = [], options = {}) {
  const entries = Array.isArray(values) ? values : [values];
  if (entries.some((item) => typeof item !== 'string' || !item.trim())) {
    throw invalidInboxPath('Inbox paths must be nonempty strings.');
  }
  const normalized = [];
  for (const value of entries) {
    const result = canonicalizeInboxPath(instanceRoot, value, options);
    if (!result.ok) throw invalidInboxPath(result.error);
    if (!normalized.includes(result.path)) normalized.push(result.path);
  }
  return normalized;
}

function getRunId(record) {
  return String(record?.run_id || record?.lock_id || record?.receipt_id || '').trim();
}

function getProcessor(record) {
  return String(record?.processor || record?.claimed_by || '').trim();
}

function getExpiry(record) {
  return record?.expires_at || record?.stale_after || '';
}

function getExpiryDate(record) {
  const expiry = getExpiry(record);
  if (!expiry) return null;
  const date = new Date(expiry);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isLeaseActive(lock, now) {
  const expiresAt = getExpiryDate(lock);
  return Boolean(expiresAt && now.getTime() < expiresAt.getTime());
}

function isLeaseStale(lock, now) {
  const expiresAt = getExpiryDate(lock);
  return Boolean(expiresAt && now.getTime() >= expiresAt.getTime());
}

function ownerMatches(record, options = {}) {
  const processor = resolveProcessor(options);
  const host = resolveHost(options);
  return getProcessor(record) === processor && String(record?.host || '') === host;
}

function sameLockOwnerIdentity(left, right) {
  return getRunId(left) === getRunId(right)
    && String(left?.started_at || '') === String(right?.started_at || '')
    && getProcessor(left) === getProcessor(right)
    && String(left?.host || '') === String(right?.host || '');
}

function getLockVersion(lock) {
  const value = Number(lock?.lock_version || 0);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function sameLockState(left, right) {
  return isDeepStrictEqual(left, right);
}

function isLegacyInboxLock(lock) {
  const schemaVersion = lock?.schema_version === undefined
    ? 1
    : Number(lock.schema_version);
  return Boolean(lock
    && typeof lock === 'object'
    && !Array.isArray(lock)
    && schemaVersion < SCHEMA_VERSION
    && lock.status === 'processing'
    && getRunId(lock)
    && getProcessor(lock)
    && lock.started_at
    && Number.isFinite(Date.parse(lock.started_at))
    && !lock.lock_version
    && !lock.host
    && !lock.heartbeat_at
    && !Array.isArray(lock.claimed_paths)
    && !Array.isArray(lock.processed_paths)
    && !Array.isArray(lock.unresolved_paths)
    && getExpiryDate(lock));
}

function validatePathArray(instanceRoot, values, field, options = {}) {
  if (!Array.isArray(values)) return 'Inbox processing ' + field + ' must be an array.';
  for (const item of values) {
    const result = canonicalizeInboxPath(instanceRoot, item, options);
    if (!result.ok) return 'Inbox processing ' + field + ' contains an invalid path: ' + result.error;
    if (!options.allowLegacyAliases && result.path !== item) {
      return 'Inbox processing ' + field + ' must contain canonical repository-relative paths.';
    }
  }
  return null;
}

function normalizeValidatedPathState(instanceRoot, claimedPaths, processedPaths, unresolvedPaths) {
  const claimed = normalizePathList(instanceRoot, claimedPaths);
  const processed = normalizePathList(instanceRoot, processedPaths);
  const unresolved = normalizePathList(instanceRoot, unresolvedPaths);
  if (claimed.length) {
    const outsideClaim = [...new Set([...processed, ...unresolved])]
      .filter((item) => !claimed.includes(item));
    if (outsideClaim.length) return {
      error: 'Processed or unresolved paths fall outside the claimed path set: ' + outsideClaim.join(', ') + '.'
    };
    const expectedUnresolved = claimed.filter((item) => !processed.includes(item));
    if (!samePathSet(unresolved, expectedUnresolved)) return {
      error: 'Unresolved paths do not match the claimed paths that remain unprocessed.'
    };
  } else if (processed.length || unresolved.length) {
    return { error: 'An empty claimed path set cannot contain processed or unresolved paths.' };
  }
  return { claimed, processed, unresolved };
}

function validateLockMetadata(lock, instanceRoot) {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
    return 'Inbox processing lock is not a JSON object.';
  }
  if (Number(lock.schema_version) !== SCHEMA_VERSION) {
    return 'Inbox processing lock must use schema_version 2; legacy locks require explicit stale recovery.';
  }
  if (lock.status !== 'processing') {
    return 'Inbox processing lock has unexpected status ' + String(lock.status || '(missing)') + '.';
  }
  if (typeof lock.run_id !== 'string' || !lock.run_id.trim()) {
    return 'Inbox processing lock is missing run_id.';
  }
  if (!isValidRunId(lock.run_id)) {
    return 'Inbox processing lock has an unsafe run_id. Use only letters, numbers, dot, underscore, and hyphen.';
  }
  if (typeof lock.lock_id !== 'string' || lock.lock_id !== lock.run_id) {
    return 'Inbox processing lock must keep lock_id equal to run_id.';
  }
  if (!getProcessor(lock)) return 'Inbox processing lock is missing processor.';
  if (!String(lock.claimed_by || '').trim() || lock.claimed_by !== lock.processor) {
    return 'Inbox processing lock must keep claimed_by equal to processor.';
  }
  if (!getLockVersion(lock)) return 'Inbox processing lock is missing lock_version.';
  if (!String(lock.host || '').trim()) return 'Inbox processing lock is missing host.';
  if (!Number.isInteger(Number(lock.lease_duration_ms)) || Number(lock.lease_duration_ms) <= 0) {
    return 'Inbox processing lock has an invalid lease_duration_ms.';
  }
  if (!lock.started_at || Number.isNaN(new Date(lock.started_at).getTime())) {
    return 'Inbox processing lock has an invalid started_at timestamp.';
  }
  if (!lock.heartbeat_at || Number.isNaN(new Date(lock.heartbeat_at).getTime())) {
    return 'Inbox processing lock has an invalid heartbeat_at timestamp.';
  }
  if (!getExpiryDate(lock)) return 'Inbox processing lock has an invalid expiry timestamp.';
  if (!lock.stale_after || Number.isNaN(new Date(lock.stale_after).getTime())) {
    return 'Inbox processing lock has an invalid stale_after timestamp.';
  }
  if (lock.stale_after !== lock.expires_at) {
    return 'Inbox processing lock must keep stale_after equal to expires_at.';
  }
  const startedAt = new Date(lock.started_at).getTime();
  const heartbeatAt = new Date(lock.heartbeat_at).getTime();
  const expiresAt = getExpiryDate(lock).getTime();
  const leaseMs = Number(lock.lease_duration_ms);
  if (heartbeatAt < startedAt) {
    return 'Inbox processing lock heartbeat_at cannot be earlier than started_at.';
  }
  if (expiresAt <= heartbeatAt) {
    return 'Inbox processing lock expires_at must be later than heartbeat_at.';
  }
  if (expiresAt - heartbeatAt !== leaseMs) {
    return 'Inbox processing lock expires_at must equal heartbeat_at plus lease_duration_ms.';
  }
  if (lock.inbox !== INBOX_REL_PATH) return 'Inbox processing lock has an invalid inbox root.';
  for (const field of ['claimed_paths', 'processed_paths', 'unresolved_paths']) {
    const error = validatePathArray(instanceRoot, lock[field], field);
    if (error) return error;
  }
  try {
    const pathState = normalizeValidatedPathState(
      instanceRoot,
      lock.claimed_paths,
      lock.processed_paths,
      lock.unresolved_paths
    );
    if (pathState.error) return 'Inbox processing lock has invalid path state: ' + pathState.error;
  } catch (err) {
    return 'Inbox processing lock has invalid path state: ' + err.message;
  }
  for (const field of ['override_id', 'resumed_from_run_id']) {
    if (lock[field] !== undefined && lock[field] !== null && !isValidRunId(lock[field])) {
      return 'Inbox processing lock has an unsafe ' + field + '.';
    }
  }
  return null;
}

function validateReceiptMetadata(receipt, instanceRoot) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return 'Receipt is not a JSON object.';
  }
  const schemaVersion = receipt.schema_version === undefined ? 1 : Number(receipt.schema_version);
  if (schemaVersion !== 1 && schemaVersion !== SCHEMA_VERSION) {
    return 'Receipt has unsupported schema_version ' + String(receipt.schema_version) + '.';
  }
  const identity = receipt.run_id || receipt.lock_id || receipt.receipt_id;
  if (typeof identity !== 'string' || !identity.trim()) {
    return 'Receipt requires a run_id, lock_id, or legacy receipt_id.';
  }
  const identities = [receipt.run_id, receipt.lock_id, receipt.receipt_id]
    .filter((value) => value !== undefined && value !== null);
  if (identities.length > 1 && identities.some((value) => value !== identity)) {
    return 'Receipt has conflicting run, lock, or receipt identities.';
  }
  if (typeof receipt.completed_at !== 'string' || !receipt.completed_at.trim()
    || !Number.isFinite(Date.parse(receipt.completed_at))) {
    return 'Receipt requires a valid completed_at timestamp.';
  }
  if (receipt.status !== undefined && receipt.status !== 'completed') {
    return 'Receipt has unexpected status ' + String(receipt.status) + '.';
  }
  if (schemaVersion === SCHEMA_VERSION) {
    if (typeof receipt.run_id !== 'string' || !isValidRunId(receipt.run_id)) {
      return 'V2 receipt requires a safe run_id.';
    }
    if (typeof receipt.receipt_id !== 'string' || receipt.receipt_id !== receipt.run_id
      || typeof receipt.lock_id !== 'string' || receipt.lock_id !== receipt.run_id) {
      return 'V2 receipt must keep receipt_id and lock_id equal to run_id.';
    }
    if (receipt.status !== 'completed') return 'V2 receipt must have completed status.';
    if (!String(receipt.processor || '').trim() || receipt.claimed_by !== receipt.processor
      || !String(receipt.host || '').trim()) {
      return 'V2 receipt requires matching processor/claimed_by and host ownership metadata.';
    }
    for (const field of ['started_at', 'heartbeat_at', 'expires_at']) {
      if (typeof receipt[field] !== 'string' || !receipt[field].trim()
        || !Number.isFinite(Date.parse(receipt[field]))) {
        return 'V2 receipt requires a valid ' + field + ' timestamp.';
      }
    }
    const completedAt = Date.parse(receipt.completed_at);
    const startedAt = Date.parse(receipt.started_at);
    const heartbeatAt = Date.parse(receipt.heartbeat_at);
    const expiresAt = Date.parse(receipt.expires_at);
    if (completedAt < startedAt) {
      return 'V2 receipt completed_at cannot be earlier than started_at.';
    }
    if (completedAt < heartbeatAt) {
      return 'V2 receipt completed_at cannot be earlier than heartbeat_at.';
    }
    if (completedAt >= expiresAt) {
      return 'V2 receipt completed_at must be before expires_at for an owned completion.';
    }
    if (typeof receipt.summary !== 'string') {
      return 'V2 receipt requires a string summary.';
    }
    if (receipt.override !== undefined) {
      const overrideError = validateOverrideMetadata(receipt.override, instanceRoot);
      if (overrideError) return 'V2 receipt override is invalid: ' + overrideError;
      if (receipt.override.replacement_run_id !== receipt.run_id) {
        return 'V2 receipt override replacement_run_id must match run_id.';
      }
    }
    for (const field of ['claimed_paths', 'processed', 'unresolved_paths']) {
      const error = validatePathArray(instanceRoot, receipt[field], field);
      if (error) return error;
    }
    try {
      const pathState = normalizeValidatedPathState(
        instanceRoot,
        receipt.claimed_paths,
        receipt.processed,
        receipt.unresolved_paths
      );
      if (pathState.error) return 'V2 receipt has invalid path state: ' + pathState.error;
      if (!receipt.lock_snapshot || typeof receipt.lock_snapshot !== 'object'
        || Array.isArray(receipt.lock_snapshot)) {
        return 'V2 receipt requires an immutable lock_snapshot object.';
      }
      const lockError = validateLockMetadata(receipt.lock_snapshot, instanceRoot);
      if (lockError) return 'V2 receipt lock_snapshot is invalid: ' + lockError;
      if (getRunId(receipt.lock_snapshot) !== receipt.run_id
        || getProcessor(receipt.lock_snapshot) !== receipt.processor
        || String(receipt.lock_snapshot.host || '') !== receipt.host
        || !samePathSet(receipt.lock_snapshot.claimed_paths, receipt.claimed_paths)) {
        return 'V2 receipt lock_snapshot does not match the terminal run identity or claim.';
      }
      const snapshotProcessed = new Set(receipt.lock_snapshot.processed_paths);
      const snapshotUnresolved = new Set(receipt.lock_snapshot.unresolved_paths);
      if ([...snapshotProcessed].some((item) => !pathState.processed.includes(item))) {
        return 'V2 receipt processed paths omit a path already checkpointed in lock_snapshot.';
      }
      if ([...pathState.unresolved].some((item) => !snapshotUnresolved.has(item))) {
        return 'V2 receipt unresolved paths are inconsistent with the checkpointed lock_snapshot.';
      }
      if (receipt.started_at !== receipt.lock_snapshot.started_at
        || receipt.heartbeat_at !== receipt.lock_snapshot.heartbeat_at
        || receipt.expires_at !== receipt.lock_snapshot.expires_at) {
        return 'V2 receipt lease timestamps do not match lock_snapshot.';
      }
      if (receipt.override) {
        if (receipt.lock_snapshot.override_id !== receipt.override.override_id) {
          return 'V2 receipt lock_snapshot override_id does not match its recovery evidence.';
        }
        const expectedResumedRunId = receipt.override.type === 'missing-lock'
          ? null
          : getRunId(receipt.override.replaced_lock);
        if ((receipt.lock_snapshot.resumed_from_run_id || null) !== expectedResumedRunId) {
          return 'V2 receipt lock_snapshot resumed_from_run_id does not match its recovery evidence.';
        }
      }
    } catch (err) {
      return 'V2 receipt has invalid terminal metadata: ' + err.message;
    }
  } else {
    for (const field of ['processed', 'claimed_paths', 'unresolved_paths']) {
      if (receipt[field] === undefined) continue;
      const error = validatePathArray(instanceRoot, receipt[field], field, { allowLegacyAliases: true });
      if (error) return error;
    }
  }
  return null;
}

function validateOverrideMetadata(override, instanceRoot = null) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return 'Override is not a JSON object.';
  }
  if (Number(override.schema_version) !== SCHEMA_VERSION) {
    return 'Override must use schema_version 2.';
  }
  if (typeof override.override_id !== 'string' || !isValidRunId(override.override_id)
    || override.override_id !== override.override_id.trim()) return 'Override has an invalid override_id.';
  if (!String(override.type || '').trim()) return 'Override is missing type.';
  if (!String(override.action || '').trim()) return 'Override is missing action.';
  if (!String(override.actor || '').trim()) return 'Override is missing actor.';
  if (!String(override.processor || '').trim() || override.processor !== override.actor) {
    return 'Override requires processor metadata matching actor.';
  }
  if (!String(override.host || '').trim()) return 'Override is missing host.';
  if (!override.overridden_at || Number.isNaN(new Date(override.overridden_at).getTime())) {
    return 'Override has an invalid overridden_at timestamp.';
  }
  if (!String(override.reason || '').trim()) return 'Override is missing reason.';
  const state = override.state || 'finalized';
  if (state !== 'prepared' && state !== 'finalized') {
    return 'Override has an unexpected state ' + String(state) + '.';
  }
  if (state === 'prepared' && override.finalized_at !== null) {
    return 'Prepared override must keep finalized_at null.';
  }
  if (override.finalized_at !== undefined
    && override.finalized_at !== null
    && Number.isNaN(new Date(override.finalized_at).getTime())) {
    return 'Override finalized_at is invalid.';
  }
  if (typeof override.replacement_run_id !== 'string'
    || !isValidRunId(override.replacement_run_id)) {
    return 'Override requires a safe replacement_run_id.';
  }
  const type = String(override.type).trim();
  if (!['missing-lock', 'stale-lock', 'legacy-stale-lock'].includes(type)) {
    return 'Override has unsupported type ' + type + '.';
  }
  if (type === 'missing-lock') {
    if (override.replaced_lock !== null) {
      return 'Missing-lock override must record replaced_lock as null.';
    }
  } else if (!override.replaced_lock
    || typeof override.replaced_lock !== 'object'
    || Array.isArray(override.replaced_lock)) {
    return type + ' override requires a replaced_lock snapshot.';
  } else if (type === 'legacy-stale-lock') {
    if (!isLegacyInboxLock(override.replaced_lock)) {
      return 'Legacy stale-lock override requires a valid legacy replaced_lock snapshot.';
    }
  } else if (instanceRoot) {
    const lockError = validateLockMetadata(override.replaced_lock, instanceRoot);
    if (lockError) return 'Stale-lock override replaced_lock is invalid: ' + lockError;
  }
  if (state === 'finalized'
    && (!override.finalized_at || Number.isNaN(new Date(override.finalized_at).getTime()))) {
    return 'Finalized override requires a valid finalized_at timestamp.';
  }
  if (state === 'finalized'
    && Date.parse(override.finalized_at) < Date.parse(override.overridden_at)) {
    return 'Finalized override cannot be finalized before it was recorded.';
  }
  return null;
}

export function looksLikeSyncConflictName(name) {
  const text = String(name || '').toLowerCase();
  return /(?:\bconflict(?:ed)?[\s_-]+copy\b|\bcopy[\s_-]+of\b|\bsync[\s_-]+conflict\b|\(\s*conflict(?:ed)?[\s_-]+copy\s*\))/.test(text);
}

function findConflictLockPaths(instanceRoot) {
  const root = path.resolve(instanceRoot);
  const governanceDir = path.join(root, 'governance');
  if (!fs.existsSync(governanceDir)) return [];

  return fs.readdirSync(governanceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => entry.name !== path.basename(LOCK_REL_PATH))
    .filter((entry) => {
      const name = entry.name.toLowerCase();
      return name.includes('inbox-processing') && name.includes('lock');
    })
    .filter((entry) => looksLikeSyncConflictName(entry.name))
    .map((entry) => path.join(governanceDir, entry.name));
}

function findInboxConflictPaths(instanceRoot) {
  const root = path.resolve(instanceRoot);
  const inbox = path.join(root, '6-raw', 'inbox');
  if (!fs.existsSync(inbox)) return [];

  const conflicts = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name === 'archive') continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile() && looksLikeSyncConflictName(entry.name)) {
        conflicts.push(relativePath(root, absolute));
      }
    }
  }

  walk(inbox);
  return conflicts.sort((left, right) => left.localeCompare(right));
}

function findInboxUnsafeEntries(instanceRoot) {
  const root = path.resolve(instanceRoot);
  const inbox = path.join(root, INBOX_REL_PATH);
  if (!fs.existsSync(inbox)) return [];

  const unsafe = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name === 'archive') continue;
      const absolute = path.join(current, entry.name);
      const relative = relativePath(root, absolute);
      if (entry.isSymbolicLink()) {
        unsafe.push({ path: relative, kind: 'symlink' });
      } else if (entry.isDirectory()) {
        walk(absolute);
      } else if (!entry.isFile()) {
        unsafe.push({ path: relative, kind: 'special' });
      }
    }
  }

  walk(inbox);
  return unsafe.sort((left, right) => left.path.localeCompare(right.path));
}

function readReceiptRecords(instanceRoot, receiptsDir) {
  if (!fs.existsSync(receiptsDir)) {
    return {
      receipts: [],
      invalidReceipts: [],
      duplicateReceipts: [],
      conflictReceipts: []
    };
  }

  const receipts = [];
  const invalidReceipts = [];
  const conflictReceipts = [];

  for (const entry of fs.readdirSync(receiptsDir, { withFileTypes: true })) {
    if (!entry.isFile()
      || (!entry.name.endsWith('.json') && !looksLikeSyncConflictName(entry.name))) continue;
    const absolute = path.join(receiptsDir, entry.name);
    const parsed = readJsonIfExists(absolute);
    const receiptPath = relativePath(instanceRoot, absolute);
    const isConflictReceipt = looksLikeSyncConflictName(entry.name);
    if (parsed.error || !parsed.value || typeof parsed.value !== 'object') {
      invalidReceipts.push({
        path: receiptPath,
        error: parsed.error?.message || 'Receipt is not a JSON object.'
      });
      if (isConflictReceipt) {
        conflictReceipts.push({ path: receiptPath, absolutePath: absolute, receipt: null, runId: null });
      }
      continue;
    }

    const receipt = parsed.value;
    const validationError = validateReceiptMetadata(receipt, instanceRoot);
    if (validationError) {
      invalidReceipts.push({
        path: receiptPath,
        error: validationError
      });
      if (isConflictReceipt) {
        conflictReceipts.push({
          path: receiptPath,
          absolutePath: absolute,
          receipt,
          runId: getRunId(receipt)
        });
      }
      continue;
    }
    const runId = getRunId(receipt);

    const record = { path: receiptPath, absolutePath: absolute, receipt, runId };
    receipts.push(record);
    if (isConflictReceipt) conflictReceipts.push(record);
  }

  const byRunId = new Map();
  for (const record of receipts) {
    const records = byRunId.get(record.runId) || [];
    records.push(record);
    byRunId.set(record.runId, records);
  }

  const duplicateReceipts = [...byRunId.entries()]
    .filter(([, records]) => records.length > 1)
    .map(([runId, records]) => ({
      run_id: runId,
      paths: records.map((record) => record.path).sort((left, right) => left.localeCompare(right))
    }));

  return { receipts, invalidReceipts, duplicateReceipts, conflictReceipts };
}

function readOverrideRecords(instanceRoot, overridesDir) {
  if (!fs.existsSync(overridesDir)) {
    return { overrides: [], invalidOverrides: [], incompleteOverrides: [], conflictOverrides: [], duplicateOverrides: [] };
  }
  const overrides = [];
  const invalidOverrides = [];
  const incompleteOverrides = [];
  const conflictOverrides = [];
  for (const entry of fs.readdirSync(overridesDir, { withFileTypes: true })) {
    if (!entry.isFile()
      || (!entry.name.endsWith('.json') && !looksLikeSyncConflictName(entry.name))) continue;
    const absolute = path.join(overridesDir, entry.name);
    const parsed = readJsonIfExists(absolute);
    const overridePath = relativePath(instanceRoot, absolute);
    if (looksLikeSyncConflictName(entry.name)) conflictOverrides.push(overridePath);
    if (parsed.error || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      invalidOverrides.push({
        path: overridePath,
        error: parsed.error?.message || 'Override is not a JSON object.'
      });
      continue;
    }
    const validationError = validateOverrideMetadata(parsed.value, instanceRoot);
    if (validationError) {
      invalidOverrides.push({ path: overridePath, error: validationError });
      continue;
    }
    const record = {
      path: overridePath,
      override: parsed.value
    };
    overrides.push(record);
    if ((parsed.value.state || 'finalized') === 'prepared') incompleteOverrides.push(record);
  }
  const byId = new Map();
  for (const item of overrides) {
    const id = item.override.override_id;
    byId.set(id, [...(byId.get(id) || []), item.path]);
  }
  return {
    conflictOverrides,
    duplicateOverrides: [...byId].filter(([, paths]) => paths.length > 1)
      .map(([override_id, paths]) => ({ override_id, paths })),
    overrides: overrides.sort((left, right) => left.path.localeCompare(right.path)),
    invalidOverrides: invalidOverrides.sort((left, right) => left.path.localeCompare(right.path)),
    incompleteOverrides: incompleteOverrides.sort((left, right) => left.path.localeCompare(right.path))
  };
}

function sameOverrideIdentity(left, right) {
  const fields = [
    'override_id',
    'type',
    'action',
    'actor',
    'processor',
    'host',
    'overridden_at',
    'reason',
    'replacement_run_id'
  ];
  return fields.every((field) => String(left?.[field] ?? '') === String(right?.[field] ?? ''))
    && sameLockState(left?.replaced_lock ?? null, right?.replaced_lock ?? null);
}

function findInvalidOverrideReferences(overrideRecords, lock, receiptRecords) {
  const invalid = [];
  for (const record of overrideRecords) {
    const override = record.override;
    if ((override.state || 'finalized') === 'prepared') continue;

    if (override.type === 'missing-lock') {
      const matches = receiptRecords.filter(({ receipt }) => (
        receipt.override?.override_id === override.override_id
      ));
      if (matches.length !== 1
        || matches[0].runId !== override.replacement_run_id
        || !sameOverrideIdentity(matches[0].receipt.override, override)) {
        invalid.push({
          path: record.path,
          error: 'Finalized missing-lock override must match exactly one terminal receipt for replacement_run_id.'
        });
      }
      continue;
    }

    const lockMatches = lock?.override_id === override.override_id ? [lock] : [];
    const receiptMatches = receiptRecords
      .map(({ receipt }) => receipt.lock_snapshot)
      .filter((snapshot) => snapshot?.override_id === override.override_id);
    const references = [...lockMatches, ...receiptMatches];
    const replacedRunId = getRunId(override.replaced_lock);
    const consistent = references.length > 0 && references.every((reference) => (
      getRunId(reference) === override.replacement_run_id
      && reference.override_id === override.override_id
      && reference.resumed_from_run_id === replacedRunId
    ));
    if (!consistent) {
      invalid.push({
        path: record.path,
        error: 'Finalized stale-lock override must match the replacement lock or its terminal receipt snapshot.'
      });
    }
  }
  return invalid;
}

export function getInboxProcessingPaths(instanceRoot) {
  const root = path.resolve(instanceRoot);
  return {
    lockPath: path.join(root, LOCK_REL_PATH),
    lockRelPath: toPortablePath(LOCK_REL_PATH),
    receiptsDir: path.join(root, RECEIPTS_REL_DIR),
    receiptsRelDir: toPortablePath(RECEIPTS_REL_DIR),
    overridesDir: path.join(root, OVERRIDES_REL_DIR),
    overridesRelDir: toPortablePath(OVERRIDES_REL_DIR)
  };
}

export function inspectInboxProcessing(instanceRoot) {
  const root = path.resolve(instanceRoot);
  const paths = getInboxProcessingPaths(root);
  const lockRecord = readJsonIfExists(paths.lockPath);
  const receiptState = readReceiptRecords(root, paths.receiptsDir);
  const conflictLockPaths = findConflictLockPaths(root);
  const inboxConflictPaths = findInboxConflictPaths(root);
  const inboxUnsafeEntries = findInboxUnsafeEntries(root);
  const overrideState = readOverrideRecords(root, paths.overridesDir);
  const invalidOverrideReferences = findInvalidOverrideReferences(
    overrideState.overrides,
    lockRecord.value,
    receiptState.receipts
  );
  const processedPathConflicts = findProcessedPathConflicts(receiptState.receipts, root);

  return {
    lock: lockRecord.value,
    lockPath: lockRecord.exists ? relativePath(root, paths.lockPath) : null,
    lockError: lockRecord.error?.message || null,
    lockValidationError: (lockRecord.error || !lockRecord.exists)
      ? null
      : validateLockMetadata(lockRecord.value, root),
    conflictLockPaths: conflictLockPaths.map((file) => relativePath(root, file)),
    inboxConflictPaths,
    inboxUnsafeEntries,
    receipts: receiptState.receipts.map(({ path: receiptPath, receipt, runId }) => ({
      path: receiptPath,
      receipt,
      run_id: runId
    })),
    invalidReceipts: receiptState.invalidReceipts,
    duplicateReceipts: receiptState.duplicateReceipts,
    processedPathConflicts,
    conflictReceipts: receiptState.conflictReceipts.map(({ path: receiptPath, runId }) => ({
      path: receiptPath,
      run_id: runId
    })),
    overrides: overrideState.overrides,
    invalidOverrides: [...overrideState.invalidOverrides, ...invalidOverrideReferences]
      .sort((left, right) => left.path.localeCompare(right.path)),
    incompleteOverrides: overrideState.incompleteOverrides,
    conflictOverrides: overrideState.conflictOverrides,
    duplicateOverrides: overrideState.duplicateOverrides
  };
}

// Audit and metrics consume the same validated snapshot and ambiguity rules.
export function getCountableInboxReceipts(state, instanceRoot) {
  const ambiguousOverrideState = state.invalidOverrides?.length
    || state.incompleteOverrides?.length
    || state.conflictOverrides?.length
    || state.duplicateOverrides?.length;
  const unsafeState = state.invalidReceipts?.length
    || state.duplicateReceipts?.length
    || state.processedPathConflicts?.length
    || state.conflictReceipts?.length
    || state.conflictLockPaths?.length
    || state.inboxConflictPaths?.length
    || state.inboxUnsafeEntries?.length
    || state.lockError
    || state.lockValidationError
    || ambiguousOverrideState;
  if (unsafeState) return [];
  return state.receipts.map((item) => ({
    ...item,
    receipt: {
      ...item.receipt,
      processed: normalizePathList(instanceRoot, item.receipt.processed || [], {
        allowLegacyAliases: Number(item.receipt.schema_version || 1) < SCHEMA_VERSION
      })
    }
  }));
}

function getReceiptForRun(state, runId) {
  const matches = getReceiptsForRun(state, runId);
  if (matches.length !== 1) return null;
  return matches[0];
}

function getReceiptsForRun(state, runId) {
  return state.receipts.filter((record) => record.run_id === runId);
}

function findProcessedPathConflicts(receipts, instanceRoot) {
  const owners = new Map();
  const receiptsByRun = new Map();
  for (const record of receipts) {
    const runReceipts = receiptsByRun.get(record.runId) || [];
    runReceipts.push(record);
    receiptsByRun.set(record.runId, runReceipts);
    for (const value of record.receipt.processed || []) {
      const canonicalized = canonicalizeInboxPath(instanceRoot, value, { allowLegacyAliases: true });
      if (!canonicalized.ok) continue;
      const canonical = canonicalized.path;
      const paths = owners.get(canonical) || new Map();
      const run = paths.get(record.runId) || {
        run_id: record.runId,
        receipt_paths: []
      };
      if (!run.receipt_paths.includes(record.path)) run.receipt_paths.push(record.path);
      paths.set(record.runId, run);
      owners.set(canonical, paths);
    }
  }

  for (const [runId, runReceipts] of receiptsByRun.entries()) {
    if (runReceipts.length < 2) continue;
    const duplicateReceiptPaths = runReceipts
      .map((record) => record.path)
      .sort((left, right) => left.localeCompare(right));
    const union = new Set();
    for (const record of runReceipts) {
      for (const value of record.receipt.processed || []) {
        const canonicalized = canonicalizeInboxPath(instanceRoot, value, { allowLegacyAliases: true });
        if (canonicalized.ok) union.add(canonicalized.path);
      }
    }
    for (const canonical of union) {
      const paths = owners.get(canonical) || new Map();
      paths.set(runId, {
        run_id: runId,
        receipt_paths: duplicateReceiptPaths
      });
      owners.set(canonical, paths);
    }
  }

  return [...owners.entries()]
    .filter(([, runs]) => runs.size > 1
      || [...runs.values()].some((run) => run.receipt_paths.length > 1))
    .map(([pathName, runs]) => ({
      path: pathName,
      runs: [...runs.values()].map((run) => ({
        run_id: run.run_id,
        receipt_paths: [...run.receipt_paths].sort((left, right) => left.localeCompare(right))
      }))
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function getProcessedPathsFromState(state, instanceRoot) {
  const processed = new Set();
  for (const record of state.receipts) {
    for (const value of record.receipt.processed || []) {
      const canonicalized = canonicalizeInboxPath(instanceRoot, value, { allowLegacyAliases: true });
      if (canonicalized.ok) processed.add(canonicalized.path);
    }
  }
  return processed;
}

function conflictMessage(state, inboxConflictPaths = []) {
  const conflicts = [
    ...state.conflictLockPaths,
    ...state.conflictReceipts.map((item) => item.path),
    ...inboxConflictPaths
  ];
  if (!conflicts.length && !state.duplicateReceipts.length && !state.processedPathConflicts?.length) return '';

  const details = [];
  if (conflicts.length) {
    details.push('sync conflict copies: ' + [...new Set(conflicts)].join(', '));
  }
  if (state.duplicateReceipts.length) {
    details.push('duplicate receipts: ' + state.duplicateReceipts
      .map((item) => item.run_id + ' (' + item.paths.join(', ') + ')')
      .join('; '));
  }
  if (state.processedPathConflicts?.length) {
    details.push('processed paths claimed by multiple runs: ' + state.processedPathConflicts
      .map((item) => item.path + ' (' + item.runs.map((run) => run.run_id).join(', ') + ')')
      .join('; '));
  }
  return 'Mole found ' + details.join('; ') + '. Preserve every copy and resolve the ambiguity before continuing.';
}

function validateProcessingState(state, options = {}, recoveringOverrideId = null) {
  if (state.conflictOverrides.length || state.duplicateOverrides.length) {
    return {
      ok: false,
      code: 'OVERRIDE_CONFLICT',
      message: 'Conflicting override copies or duplicate override IDs exist. Preserve every record and reconcile the audit history before continuing.'
    };
  }
  const inboxConflictPaths = findInboxConflictPaths(options.instanceRoot);
  if (state.processedPathConflicts?.length) {
    return {
      ok: false,
      code: 'PROCESSED_PATH_CONFLICT',
      message: conflictMessage(state, inboxConflictPaths)
        + ' Do not count or reprocess those paths until the receipts are reconciled.'
    };
  }
  const conflict = conflictMessage(state, inboxConflictPaths);
  if (conflict) {
    return {
      ok: false,
      code: 'SYNC_CONFLICT',
      message: conflict
    };
  }
  const legacyLockAllowed = options.allowLegacyLock && isLegacyInboxLock(state.lock);
  if (state.lockError || (state.lockValidationError && !legacyLockAllowed)) {
    return {
      ok: false,
      code: 'INVALID_LOCK',
      message: 'Inbox processing lock is invalid: '
        + (state.lockError || state.lockValidationError)
        + '. Do not replace it automatically; inspect the synced folder history first.'
    };
  }
  if (state.invalidReceipts.length) {
    return {
      ok: false,
      code: 'INVALID_RECEIPT',
      message: 'Inbox processing receipts are invalid: '
        + state.invalidReceipts.map((item) => item.path).join(', ')
        + '. Repair the records before continuing.'
    };
  }
  if (state.invalidOverrides?.length) {
    return {
      ok: false,
      code: 'INVALID_OVERRIDE',
      message: 'Inbox processing override records are invalid: '
        + state.invalidOverrides.map((item) => item.path).join(', ')
        + '. Repair the records before continuing.'
    };
  }
  if (state.incompleteOverrides.some((item) => item.override.override_id !== recoveringOverrideId)) {
    return {
      ok: false,
      code: 'INCOMPLETE_OVERRIDE',
      message: 'Inbox processing override records are prepared but not finalized: '
        + state.incompleteOverrides.map((item) => item.path).join(', ')
        + '. Reconcile the replacement lock and audit record before continuing.'
    };
  }
  return { ok: true };
}

function validatePostMutationState(instanceRoot, options, paths, recoveringOverrideId = null) {
  const state = inspectInboxProcessing(instanceRoot);
  const validation = validateProcessingState(state, {
    ...options,
    instanceRoot
  }, recoveringOverrideId);
  if (!validation.ok) {
    return {
      ...validation,
      state,
      lock: state.lock,
      lockPath: paths.lockRelPath
    };
  }
  return { ok: true, state };
}

function validateExpectedPostLock(postWrite, expectedLock, paths, operation) {
  if (!postWrite.ok) {
    return resultForFailure(
      postWrite.code,
      operation + ' was written, but the post-write audit found unsafe coordination state: '
        + postWrite.message + ' Preserve the lock and every conflicting record while reconciling it.',
      paths,
      { lock: postWrite.lock, state: postWrite.state }
    );
  }
  if (!postWrite.state.lock || !sameLockState(postWrite.state.lock, expectedLock)) {
    return resultForFailure(
      'LOCK_CHANGED',
      operation + ' was written, but the persisted lock no longer matches the expected snapshot. Refusing to select a winner.',
      paths,
      { lock: postWrite.state.lock || null, state: postWrite.state }
    );
  }
  return null;
}

function buildLease(instanceRoot, options, now, overrides = {}) {
  const leaseMs = asLeaseMs(options);
  const runId = normalizeRunId(options.runId || options.lockId || overrides.runId);
  const processor = resolveProcessor(options);
  const host = resolveHost(options);
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const claimedPaths = normalizePathList(instanceRoot, options.claimedPaths || options.claimed_paths || []);
  const processedPaths = normalizePathList(instanceRoot, overrides.processedPaths || []);

  const lease = {
    schema_version: SCHEMA_VERSION,
    lock_version: 1,
    run_id: runId,
    lock_id: runId,
    status: 'processing',
    processor,
    claimed_by: processor,
    host,
    started_at: (overrides.startedAt || now).toISOString(),
    heartbeat_at: now.toISOString(),
    expires_at: expiresAt,
    stale_after: expiresAt,
    lease_duration_ms: leaseMs,
    claimed_paths: claimedPaths,
    processed_paths: processedPaths,
    unresolved_paths: claimedPaths.filter((item) => !processedPaths.includes(item)),
    inbox: '6-raw/inbox',
    ...(overrides.overrideId ? {
      override_id: overrides.overrideId,
      resumed_from_run_id: overrides.resumedFromRunId || null
    } : {})
  };
  const error = validateLockMetadata(lease, instanceRoot);
  if (error) throw new Error(error);
  return lease;
}

function resultForFailure(code, message, paths, extra = {}) {
  return {
    ok: false,
    code,
    lockPath: paths.lockRelPath,
    ...extra,
    message
  };
}

function validateExplicitRecoveryIdentity(paths, options = {}) {
  const missing = [];
  if (!String(options.processor || '').trim()) missing.push('--processor');
  if (!String(options.host || '').trim()) missing.push('--host');
  if (!missing.length) return null;
  return resultForFailure(
    'RECOVERY_IDENTITY_REQUIRED',
    'Missing-lock recovery requires explicit ' + missing.join(' and ')
      + '; ambient identity defaults are not accepted. No receipt or override record was written.',
    paths
  );
}

function validateRequestedRunId(paths, requestedRunId, { required = false } = {}) {
  if (!requestedRunId) {
    if (!required) return null;
    return resultForFailure(
      'RUN_ID_REQUIRED',
      'Every mutating inbox operation requires the exact run ID returned by mole inbox claim. Refusing to operate on a newer or different run.',
      paths
    );
  }
  if (!isValidRunId(requestedRunId)) {
    return resultForFailure(
      'INVALID_RUN_ID',
      'Run ID ' + requestedRunId + ' is invalid. Use 1-128 characters beginning with a letter or number, followed only by letters, numbers, dot, underscore, or hyphen.',
      paths
    );
  }
  return null;
}

function samePathSet(left = [], right = []) {
  return isDeepStrictEqual(
    [...new Set(left)].sort((a, b) => a.localeCompare(b)),
    [...new Set(right)].sort((a, b) => a.localeCompare(b))
  );
}

function validateClaimRetryPayload(instanceRoot, record, options, paths) {
  const requestedPaths = normalizePathList(
    instanceRoot,
    options.claimedPaths || options.claimed_paths || []
  );
  if (requestedPaths.length && !samePathSet(requestedPaths, record.claimed_paths || [])) {
    return resultForFailure(
      'INCOMPATIBLE_CLAIM',
      'Run ' + getRunId(record) + ' is already associated with a different claimed-path set. Retry with the original claim or choose a new run ID.',
      paths,
      { lock: record }
    );
  }
  if (options.leaseMs !== undefined
    && Number(options.leaseMs) !== Number(record.lease_duration_ms)) {
    return resultForFailure(
      'INCOMPATIBLE_CLAIM',
      'Run ' + getRunId(record) + ' already has a different lease duration. Retry without changing the claim payload or choose a new run ID.',
      paths,
      { lock: record }
    );
  }
  return null;
}

function mutationMutexPath(paths) {
  const key = createHash('sha256').update(path.resolve(paths.lockPath)).digest('hex');
  return path.join(os.tmpdir(), MUTATION_MUTEX_PREFIX + key + '.json');
}

function mutationMutexDirectory(paths) {
  return mutationMutexPath(paths).replace(/\.json$/, '.d');
}

function isProcessAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

export function getInboxMutationProcessIdentity(pid, options = {}) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return null;
  const platform = options.platform || process.platform;
  const readFile = options.readFileSync || fs.readFileSync;
  const runFile = options.execFileSync || execFileSync;
  try {
    if (platform === 'linux') {
      const stat = readFile('/proc/' + pid + '/stat', 'utf8');
      const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      const boot = readFile('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return boot + ':' + startTicks;
    }
    if (platform !== 'win32') {
      return runFile('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore']
      }).trim() || null;
    }
  } catch {
    // Unverifiable owners use the bounded age fallback below.
  }
  return null;
}

// Rename binds the decision to the detached file, never to a later occupant of file.
function removeSnapshot(file, matches, retainedPath) {
  try {
    fs.renameSync(file, retainedPath);
  } catch (err) {
    if (err.code === 'ENOENT') return { released: false, changed: false };
    throw err;
  }
  const moved = readJsonIfExists(retainedPath);
  if (matches(moved)) {
    fs.unlinkSync(retainedPath);
    return { released: true, changed: false };
  }
  try {
    // link is exclusive: do not overwrite another lock arriving during restoration.
    fs.linkSync(retainedPath, file);
    fs.unlinkSync(retainedPath);
  } catch (err) {
    // The detached record remains visible for reconciliation if restoration fails.
    return { released: false, changed: true, retainedPath, error: err.message };
  }
  return { released: false, changed: true };
}

function mutexIsStale(current, mutexPath) {
  if (typeof current.contents !== 'string') return false;
  let age;
  try { age = Date.now() - fs.statSync(mutexPath).mtimeMs; }
  catch { return false; }
  const holder = current.value;
  if (holder?.pid === process.pid && activeMutationTokens.has(holder.token)) return false;
  if (!holder || !holder.token || !Number.isInteger(holder.pid) || holder.pid <= 0) {
    return age >= MUTATION_MUTEX_STALE_MS;
  }
  if (!isProcessAlive(holder.pid)) return true;
  const identity = getInboxMutationProcessIdentity(holder.pid);
  if (holder.process_identity && identity) return holder.process_identity !== identity;
  const acquired = Date.parse(holder.acquired_at);
  return age >= MUTATION_MUTEX_STALE_MS
    && (!Number.isFinite(acquired) || acquired > Date.now()
      || Date.now() - acquired >= MUTATION_MUTEX_STALE_MS);
}

function acquireMutationMutex(paths, options = {}) {
  const legacyMutexPath = mutationMutexPath(paths);
  const mutexDirectory = mutationMutexDirectory(paths);
  const token = randomBytes(12).toString('hex');
  const mutexPath = path.join(mutexDirectory, token + '.json');
  const record = {
    token,
    pid: process.pid,
    process_identity: getInboxMutationProcessIdentity(process.pid),
    processor: resolveProcessor(options),
    host: resolveHost(options),
    acquired_at: new Date().toISOString(),
    lock_path: paths.lockRelPath
  };

  writeJsonExclusive(mutexPath, record);
  activeMutationTokens.add(token);
  const candidates = [legacyMutexPath];
  try {
    for (const entry of fs.readdirSync(mutexDirectory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        candidates.push(path.join(mutexDirectory, entry.name));
      }
    }
    for (const candidate of candidates) {
      if (candidate === mutexPath) continue;
      const current = readJsonIfExists(candidate);
      if (!current.exists || mutexIsStale(current, candidate)) continue;
      releaseMutationMutex({ mutexPath, token });
      activeMutationTokens.delete(token);
      return { ok: false, mutexPath, holder: current.value || null };
    }
    return { ok: true, mutexPath, token };
  } catch (err) {
    releaseMutationMutex({ mutexPath, token });
    activeMutationTokens.delete(token);
    throw err;
  }
}

function releaseMutationMutex(mutex) {
  if (!mutex?.mutexPath) return;
  const current = readJsonIfExists(mutex.mutexPath);
  if (current.value?.token !== mutex.token) return;
  try {
    fs.unlinkSync(mutex.mutexPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function withInboxMutation(instanceRoot, options, operation) {
  const root = path.resolve(instanceRoot);
  const paths = getInboxProcessingPaths(root);
  const mutex = acquireMutationMutex(paths, options);
  if (!mutex.ok) {
    const holder = mutex.holder;
    return resultForFailure(
      'MUTATION_BUSY',
      'Another inbox-processing mutation is in progress for this workspace. Refusing to read and overwrite a moving lock; retry after the other operation finishes.',
      paths,
      { mutationLock: holder }
    );
  }

  try {
    return operation(root, paths);
  } catch (err) {
    if (err.code === 'INVALID_INBOX_PATH') {
      return resultForFailure('INVALID_PATH', err.message, paths);
    }
    throw err;
  } finally {
    try { releaseMutationMutex(mutex); }
    finally { activeMutationTokens.delete(mutex.token); }
  }
}

function replaceLockIfUnchanged(instanceRoot, paths, expected, replacement, operation) {
  const validationError = validateLockMetadata(replacement, instanceRoot);
  if (validationError) {
    return { ok: false, result: resultForFailure('INVALID_LOCK', validationError, paths) };
  }
  const current = readJsonIfExists(paths.lockPath);
  if (!current.value
    || !sameLockState(current.value, expected)
    || getLockVersion(current.value) !== getLockVersion(expected)) {
    return {
      ok: false,
      result: resultForFailure(
        'LOCK_CHANGED',
        'The inbox lock changed before the ' + operation + ' could be committed. Refusing to overwrite or select between lock versions.',
        paths,
        { lock: current.value || null }
      )
    };
  }

  writeJsonAtomic(paths.lockPath, replacement);
  const written = readJsonIfExists(paths.lockPath);
  if (!written.value
    || !sameLockState(written.value, replacement)
    || getLockVersion(written.value) !== getLockVersion(replacement)) {
    return {
      ok: false,
      result: resultForFailure(
        'LOCK_CHANGED',
        'The inbox lock changed while the ' + operation + ' was being committed. The new lock state was retained; inspect it before retrying.',
        paths,
        { lock: written.value || null }
      )
    };
  }

  return { ok: true, lock: written.value };
}

function verifyOwnedActiveLock(instanceRoot, options = {}) {
  const paths = getInboxProcessingPaths(instanceRoot);
  const requestedRunId = getRequestedRunId(options);
  const runIdError = validateRequestedRunId(paths, requestedRunId, { required: true });
  if (runIdError) return runIdError;

  const state = inspectInboxProcessing(instanceRoot);
  const validState = validateProcessingState(state, {
    ...options,
    instanceRoot
  });
  if (!validState.ok) return { ...validState, state, paths };

  const lock = state.lock;
  if (!lock) {
    return {
      ...resultForFailure(
        'MISSING_LOCK',
        'No active owned inbox processing claim exists. Run mole inbox claim first, or use --override-missing-lock --reason for an audited recovery.',
        paths
      ),
      state,
      paths
    };
  }

  const lockRunId = getRunId(lock);
  if (requestedRunId !== lockRunId) {
    return {
      ...resultForFailure(
        'RUN_ID_MISMATCH',
        'Inbox processing is owned by run ' + (lockRunId || 'an unknown run')
          + ', not ' + requestedRunId + '. Refusing to complete a different run.',
        paths,
        { lock }
      ),
      state,
      paths
    };
  }

  if (!ownerMatches(lock, options)) {
    return {
      ...resultForFailure(
        'FOREIGN_OWNER',
        'Inbox processing run ' + (lockRunId || 'unknown') + ' is owned by '
          + (getProcessor(lock) || 'an unknown processor') + ' on '
          + (lock.host || 'an unknown host')
          + '. The current processor is not the owner, so completion is refused.',
        paths,
        { lock }
      ),
      state,
      paths
    };
  }

  const now = asDate(options.now, new Date(), 'current time');
  if (!isLeaseActive(lock, now)) {
    const expiry = getExpiry(lock) || 'an unknown time';
    return {
      ...resultForFailure(
        'STALE_LOCK',
        'Inbox processing lease for run ' + (lockRunId || 'unknown')
          + ' expired at ' + expiry
          + '. Normal completion is refused. Inspect synced-folder history and use an explicit stale-lock override with a reason before resuming.',
        paths,
        { lock }
      ),
      state,
      paths
    };
  }

  return { ok: true, lock, state, paths, now };
}

function buildOverrideRecord(instanceRoot, options, details = {}) {
  const paths = getInboxProcessingPaths(instanceRoot);
  const now = asDate(details.overriddenAt || options.now, new Date(), 'override time');
  const actor = resolveProcessor({
    ...options,
    processor: options.overrideBy || options.processor || options.claimedBy
  });
  const host = resolveHost(options);
  const reason = String(options.reason || options.overrideReason || '').trim();
  if (!reason) throw new Error('An explicit override reason is required.');

  const overrideId = options.overrideId
    || 'override-' + formatUtcTimestamp(now) + '-' + randomBytes(5).toString('hex');
  if (typeof overrideId !== 'string' || !isValidRunId(overrideId)
    || overrideId !== overrideId.trim()) throw new Error('Invalid override ID.');
  const record = {
    schema_version: SCHEMA_VERSION,
    override_id: overrideId,
    type: details.type || 'stale-lock',
    action: details.action || 'replace-inbox-processing-state',
    actor,
    processor: actor,
    host,
    overridden_at: now.toISOString(),
    state: details.state || 'finalized',
    finalized_at: details.state === 'prepared'
      ? null
      : (details.finalizedAt || now.toISOString()),
    reason,
    replaced_lock: details.replacedLock || null,
    replacement_run_id: details.replacementRunId || null
  };

  return {
    record,
    path: path.join(paths.overridesDir, overrideId + '.json')
  };
}

function persistOverrideRecord(audit) {
  try {
    writeJsonExclusive(audit.path, audit.record);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const existing = readJsonIfExists(audit.path);
    if (existing.value && JSON.stringify(existing.value) === JSON.stringify(audit.record)) {
      return audit;
    }
    throw new Error('Override record ' + audit.record.override_id + ' already exists with different contents.');
  }

  const written = readJsonIfExists(audit.path);
  if (!written.value || !sameLockState(written.value, audit.record)) {
    throw new Error('Override record ' + audit.record.override_id + ' changed while it was being written.');
  }

  return audit;
}

function finalizeOverrideRecord(audit, finalizedAt = new Date()) {
  const current = readJsonIfExists(audit.path);
  if (!current.value || !sameLockState(current.value, audit.record)) {
    throw new Error('Prepared override record ' + audit.record.override_id + ' changed before finalization.');
  }
  const finalizedDate = asDate(finalizedAt, new Date(), 'override finalization time');
  if (finalizedDate.getTime() < Date.parse(audit.record.overridden_at)) {
    throw new Error('Override finalization time cannot be earlier than overridden_at.');
  }
  const finalized = {
    ...audit.record,
    state: 'finalized',
    finalized_at: finalizedDate.toISOString()
  };
  writeJsonAtomic(audit.path, finalized);
  const written = readJsonIfExists(audit.path);
  if (!written.value || !sameLockState(written.value, finalized)) {
    throw new Error('Override record ' + audit.record.override_id + ' could not be finalized.');
  }
  return { record: finalized, path: audit.path };
}

function pendingOverrideForReceipt(state, receipt, instanceRoot) {
  const overrideId = receipt?.override?.override_id;
  if (!overrideId) return null;
  const pending = state.incompleteOverrides.filter((item) => item.override.override_id === overrideId);
  if (pending.length !== 1) return null;
  const record = pending[0].override;
  if (record.type !== 'missing-lock' || record.replacement_run_id !== getRunId(receipt)
    || record.host !== receipt.host || record.processor !== getProcessor(receipt)
    || !sameLockState(record, receipt.override)) return null;
  return { record, path: path.resolve(instanceRoot, pending[0].path) };
}

function claimInboxProcessingUnlocked(instanceRoot, options = {}) {
  const root = path.resolve(instanceRoot);
  const paths = getInboxProcessingPaths(root);
  const requestedRunId = getRequestedRunId(options);
  const runIdError = validateRequestedRunId(paths, requestedRunId);
  if (runIdError) return runIdError;

  const now = asDate(options.now, new Date(), 'claim time');
  const state = inspectInboxProcessing(root);
  const validState = validateProcessingState(state, {
    ...options,
    instanceRoot: root
  });
  if (!validState.ok) return { ...validState, lockPath: paths.lockRelPath };

  const requestedProcessor = resolveProcessor(options);
  const existingReceipts = requestedRunId ? getReceiptsForRun(state, requestedRunId) : [];
  if (requestedRunId && existingReceipts.length > 1) {
    return resultForFailure(
      'DUPLICATE_RECEIPT',
      'Multiple receipts already exist for run ' + requestedRunId + ': '
        + existingReceipts.map((record) => record.path).join(', ')
        + '. Refusing to choose one or reuse the run ID.',
      paths,
      { duplicateReceipts: existingReceipts.map((record) => record.path) }
    );
  }
  const existingReceipt = existingReceipts[0] || null;
  if (requestedRunId && existingReceipt) {
    if (getProcessor(existingReceipt.receipt) !== requestedProcessor
      || String(existingReceipt.receipt.host || '') !== resolveHost(options)) {
      return resultForFailure(
        'FOREIGN_OWNER',
        'Run ' + requestedRunId + ' already has a receipt owned by '
          + (getProcessor(existingReceipt.receipt) || 'another processor') + ' on '
          + (existingReceipt.receipt.host || 'another host') + '.',
        paths,
        { receipt: existingReceipt.receipt, receiptPath: existingReceipt.path }
      );
    }
    const incompatible = validateClaimRetryPayload(root, existingReceipt.receipt, options, paths);
    if (incompatible) return incompatible;
    return {
      ok: true,
      idempotent: true,
      run_id: requestedRunId,
      receipt: existingReceipt.receipt,
      receiptPath: existingReceipt.path,
      lockPath: paths.lockRelPath,
      message: 'Inbox processing run ' + requestedRunId
        + ' was already completed; no new claim was created.'
    };
  }

  const runId = normalizeRunId(requestedRunId);
  const lock = state.lock;
  if (lock) {
    const existingRunId = getRunId(lock);
    if (existingRunId === runId) {
      if (!ownerMatches(lock, options)) {
        return resultForFailure(
          'FOREIGN_OWNER',
          'Inbox processing run ' + runId + ' is owned by '
            + (getProcessor(lock) || 'another processor') + ' on '
            + (lock.host || 'an unknown host')
            + '. A different processor cannot retry or replace the run.',
          paths,
          { lock }
        );
      }
      const incompatible = validateClaimRetryPayload(root, lock, options, paths);
      if (incompatible) return incompatible;
      if (isLeaseStale(lock, now)) {
        return resultForFailure(
          'STALE_LOCK',
          'Inbox processing run ' + runId
            + ' has expired. A retry cannot renew it automatically; use an explicit stale-lock override with a reason.',
          paths,
          { lock }
        );
      }
      return {
        ok: true,
        idempotent: true,
        run_id: runId,
        lock,
        lockPath: paths.lockRelPath,
        message: 'Inbox processing run ' + runId + ' is already claimed by ' + getProcessor(lock) + '.'
      };
    }

    const owner = getProcessor(lock) || 'another processor';
    const expiry = getExpiry(lock) ? ' Lease expires at ' + getExpiry(lock) + '.' : '';
    return resultForFailure(
      isLeaseStale(lock, now) ? 'STALE_LOCK' : 'CONCURRENT_CLAIM',
      'Inbox processing already belongs to run ' + (existingRunId || 'unknown')
        + ' claimed by ' + owner + ' on ' + (lock.host || 'an unknown host') + '.'
        + expiry
        + ' Do not replace it automatically; use an explicit stale-lock override only after confirming the synced-folder state.',
      paths,
      { lock }
    );
  }

  const claimedPaths = normalizePathList(root, options.claimedPaths || options.claimed_paths || []);
  const processedPaths = getProcessedPathsFromState(state, root);
  const alreadyProcessed = claimedPaths.filter((item) => processedPaths.has(item));
  if (alreadyProcessed.length) {
    return resultForFailure(
      'ALREADY_PROCESSED',
      'These claimed inbox paths already have completion receipts: ' + alreadyProcessed.join(', ')
        + '. Remove them from the new run instead of reprocessing them.',
      paths,
      { alreadyProcessedPaths: alreadyProcessed }
    );
  }

  const newLock = buildLease(root, { ...options, runId, claimedPaths }, now);
  try {
    writeJsonExclusive(paths.lockPath, newLock);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const racedState = inspectInboxProcessing(root);
    const racedLock = racedState.lock;
    if (racedLock && getRunId(racedLock) === runId) {
      if (!ownerMatches(racedLock, options)) {
        return resultForFailure(
          'FOREIGN_OWNER',
          'Inbox processing run ' + runId + ' was claimed by '
            + (getProcessor(racedLock) || 'another processor') + ' on '
            + (racedLock.host || 'an unknown host') + '.',
          paths,
          { lock: racedLock }
        );
      }
      if (!sameLockState(racedLock, newLock)) {
        return resultForFailure(
          'LOCK_CHANGED',
          'Another processor created a different lock for run ' + runId
            + ' while this claim was being written. Refusing to choose between lock snapshots.',
          paths,
          { lock: racedLock }
        );
      }
      const racedPostWrite = validatePostMutationState(root, options, paths);
      const racedPostWriteFailure = validateExpectedPostLock(
        racedPostWrite,
        newLock,
        paths,
        'The raced inbox claim'
      );
      if (racedPostWriteFailure) return racedPostWriteFailure;
      return {
        ok: true,
        idempotent: true,
        run_id: runId,
        lock: racedLock,
        lockPath: paths.lockRelPath,
        message: 'Inbox processing run ' + runId + ' is already claimed by ' + getProcessor(racedLock) + '.'
      };
    }
    return resultForFailure(
      'CONCURRENT_CLAIM',
      'Another processor created the inbox claim while this claim was being written. Read the lock and do not choose between the claims automatically.',
      paths,
      { lock: racedLock || null }
    );
  }

  const postWrite = validatePostMutationState(root, options, paths);
  const postWriteFailure = validateExpectedPostLock(postWrite, newLock, paths, 'Inbox claim');
  if (postWriteFailure) return postWriteFailure;

  return {
    ok: true,
    run_id: runId,
    lock: newLock,
    lockPath: paths.lockRelPath,
    message: 'Inbox processing claimed by ' + newLock.processor + ' on '
      + newLock.host + ' for run ' + runId + '.'
  };
}

export function claimInboxProcessing(instanceRoot, options = {}) {
  return withInboxMutation(instanceRoot, options, (root) => (
    claimInboxProcessingUnlocked(root, options)
  ));
}

function heartbeatInboxProcessingUnlocked(instanceRoot, options = {}) {
  const owned = verifyOwnedActiveLock(instanceRoot, options);
  if (!owned.ok) return owned;

  const now = owned.now;
  const leaseMs = asLeaseMs(options);
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const updated = {
    ...owned.lock,
    lock_version: getLockVersion(owned.lock) + 1,
    heartbeat_at: now.toISOString(),
    expires_at: expiresAt,
    stale_after: expiresAt,
    lease_duration_ms: leaseMs,
    status: 'processing'
  };

  const replaced = replaceLockIfUnchanged(
    instanceRoot,
    owned.paths,
    owned.lock,
    updated,
    'heartbeat'
  );
  if (!replaced.ok) return replaced.result;

  const postWrite = validatePostMutationState(instanceRoot, options, owned.paths);
  const postWriteFailure = validateExpectedPostLock(postWrite, updated, owned.paths, 'Heartbeat');
  if (postWriteFailure) return postWriteFailure;

  return {
    ok: true,
    run_id: getRunId(updated),
    lock: replaced.lock,
    lockPath: owned.paths.lockRelPath,
    message: 'Inbox processing lease renewed for run ' + getRunId(updated)
      + ' until ' + updated.expires_at + '.'
  };
}

export function heartbeatInboxProcessing(instanceRoot, options = {}) {
  return withInboxMutation(instanceRoot, options, (root) => (
    heartbeatInboxProcessingUnlocked(root, options)
  ));
}

function checkpointInboxProcessingUnlocked(instanceRoot, options = {}) {
  const owned = verifyOwnedActiveLock(instanceRoot, options);
  if (!owned.ok) return owned;

  const newPaths = normalizePathList(instanceRoot, options.processed || options.processedPaths || []);
  const existingPaths = normalizePathList(instanceRoot, owned.lock.processed_paths || []);
  const processedPaths = [...new Set([...existingPaths, ...newPaths])];
  const previouslyProcessed = getProcessedPathsFromState(owned.state, instanceRoot);
  const alreadyProcessed = processedPaths.filter((item) => previouslyProcessed.has(item));
  if (alreadyProcessed.length) {
    return resultForFailure(
      'ALREADY_PROCESSED',
      'These checkpoint paths are already covered by another completion receipt: '
        + alreadyProcessed.join(', ')
        + '. Refusing to persist a duplicate processing checkpoint.',
      owned.paths,
      { lock: owned.lock, alreadyProcessedPaths: alreadyProcessed }
    );
  }
  const claimedPaths = normalizePathList(instanceRoot, owned.lock.claimed_paths || []);
  const unclaimed = processedPaths.filter((item) => !claimedPaths.includes(item));
  if (unclaimed.length) {
    return resultForFailure(
      'UNCLAIMED_PATH',
      'The checkpoint includes paths outside this run claim: ' + unclaimed.join(', ')
        + '. Keep each path with the run that claimed it.',
      owned.paths,
      { lock: owned.lock }
    );
  }

  const now = owned.now;
  const leaseMs = asLeaseMs(options);
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const updated = {
    ...owned.lock,
    lock_version: getLockVersion(owned.lock) + 1,
    heartbeat_at: now.toISOString(),
    expires_at: expiresAt,
    stale_after: expiresAt,
    lease_duration_ms: leaseMs,
    processed_paths: processedPaths,
    unresolved_paths: claimedPaths.filter((item) => !processedPaths.includes(item)),
    last_checkpoint_at: now.toISOString(),
    status: 'processing'
  };

  const replaced = replaceLockIfUnchanged(
    instanceRoot,
    owned.paths,
    owned.lock,
    updated,
    'checkpoint'
  );
  if (!replaced.ok) return replaced.result;

  const postWrite = validatePostMutationState(instanceRoot, options, owned.paths);
  const postWriteFailure = validateExpectedPostLock(postWrite, updated, owned.paths, 'Checkpoint');
  if (postWriteFailure) return postWriteFailure;

  const added = processedPaths.filter((item) => !existingPaths.includes(item));
  return {
    ok: true,
    idempotent: added.length === 0,
    run_id: getRunId(updated),
    lock: replaced.lock,
    checkpoint: {
      run_id: getRunId(updated),
      checkpointed_at: now.toISOString(),
      processed: processedPaths,
      added
    },
    lockPath: owned.paths.lockRelPath,
    message: added.length
      ? 'Checkpoint saved for run ' + getRunId(updated) + ' with ' + added.length
        + ' newly processed path' + (added.length === 1 ? '' : 's') + '.'
      : 'Checkpoint for run ' + getRunId(updated)
        + ' was already recorded; no paths were added.'
  };
}

export function checkpointInboxProcessing(instanceRoot, options = {}) {
  return withInboxMutation(instanceRoot, options, (root) => (
    checkpointInboxProcessingUnlocked(root, options)
  ));
}

function overrideStaleInboxProcessingUnlocked(instanceRoot, options = {}) {
  const root = path.resolve(instanceRoot);
  const paths = getInboxProcessingPaths(root);
  const replacementRunId = getRequestedRunId(options);
  const runIdError = validateRequestedRunId(paths, replacementRunId, { required: true });
  if (runIdError) return runIdError;
  if (!String(options.reason || options.overrideReason || '').trim()) {
    return resultForFailure(
      'OVERRIDE_REASON_REQUIRED',
      'Stale-lock recovery requires an explicit override reason. No lock or override record was changed.',
      paths
    );
  }

  const state = inspectInboxProcessing(root);
  const legacyLock = isLegacyInboxLock(state.lock);
  const validState = validateProcessingState(state, {
    ...options,
    instanceRoot: root,
    allowLegacyLock: legacyLock
  });
  if (!validState.ok) return { ...validState, lockPath: paths.lockRelPath };
  if (!state.lock) {
    return resultForFailure(
      'MISSING_LOCK',
      'There is no stale inbox lock to override. Use an explicit missing-lock completion override only when the run history has been checked.',
      paths
    );
  }

  const now = asDate(options.now, new Date(), 'override time');
  if (!isLeaseStale(state.lock, now)) {
    return resultForFailure(
      'ACTIVE_LOCK',
      'Inbox processing run ' + getRunId(state.lock) + ' is still active until '
        + getExpiry(state.lock) + '. Do not override an active claim.',
      paths,
      { lock: state.lock }
    );
  }

  if (replacementRunId === getRunId(state.lock)) {
    return resultForFailure(
      'RUN_ID_REUSE',
      'Stale-lock recovery must use a new replacement run ID; ' + replacementRunId
        + ' belongs to the expired run. No replacement or override was written.',
      paths,
      { lock: state.lock }
    );
  }

  const existingReceipts = getReceiptsForRun(state, replacementRunId);
  if (existingReceipts.length) {
    return resultForFailure(
      'RUN_ALREADY_COMPLETED',
      'Run ' + replacementRunId + ' already has a completion receipt. Choose a new replacement run ID instead of replacing a completed run.',
      paths,
      {
        receipt: existingReceipts[0].receipt,
        receiptPath: existingReceipts[0].path,
        receipts: existingReceipts.map((record) => record.path)
      }
    );
  }

  const inheritedClaimedPaths = normalizePathList(root, state.lock.claimed_paths || []);
  const requestedClaimedPaths = normalizePathList(
    root,
    options.claimedPaths || options.claimed_paths || []
  );
  const inheritedProcessedPaths = normalizePathList(root, state.lock.processed_paths || []);
  const replacementClaimedPaths = [...new Set([
    ...inheritedClaimedPaths,
    ...requestedClaimedPaths,
    ...inheritedProcessedPaths
  ])];
  const previouslyProcessed = getProcessedPathsFromState(state, root);
  const alreadyProcessed = replacementClaimedPaths.filter((item) => previouslyProcessed.has(item));
  if (alreadyProcessed.length) {
    return resultForFailure(
      'ALREADY_PROCESSED',
      'The replacement claim includes paths already covered by completion receipts: '
        + alreadyProcessed.join(', ')
        + '. Reconcile the stale lock and receipt history before recovery. No replacement or override was written.',
      paths,
      { lock: state.lock, alreadyProcessedPaths: alreadyProcessed }
    );
  }
  const audit = buildOverrideRecord(root, options, {
    type: legacyLock ? 'legacy-stale-lock' : 'stale-lock',
    action: legacyLock ? 'migrate-legacy-stale-lock' : 'replace-stale-lock',
    state: 'prepared',
    overriddenAt: now,
    replacedLock: state.lock,
    replacementRunId
  });
  const replacement = buildLease(root, {
    ...options,
    runId: replacementRunId,
    claimedPaths: replacementClaimedPaths
  }, now, {
    overrideId: audit.record.override_id,
    resumedFromRunId: getRunId(state.lock),
    processedPaths: inheritedProcessedPaths,
    startedAt: now
  });

  const sourceConflictsBeforeRecovery = findInboxConflictPaths(root);
  if (sourceConflictsBeforeRecovery.length) {
    return resultForFailure(
      'SYNC_CONFLICT',
      'Stale-lock recovery found source conflict copies before it could write recovery state: '
        + sourceConflictsBeforeRecovery.join(', ')
        + '. Preserve every copy and reconcile the synced folder before retrying.',
      paths,
      { lock: state.lock, conflictPaths: sourceConflictsBeforeRecovery }
    );
  }

  persistOverrideRecord(audit);

  const replaced = replaceLockIfUnchanged(
    root,
    paths,
    state.lock,
    replacement,
    'stale override'
  );
  if (!replaced.ok) {
    return { ...replaced.result, override: audit.record };
  }

  let finalized;
  try {
    finalized = finalizeOverrideRecord(audit, now);
  } catch (err) {
    return {
      ok: true,
      run_id: replacementRunId,
      lock: replaced.lock,
      override: audit.record,
      overridePath: relativePath(root, audit.path),
      lockPath: paths.lockRelPath,
      warning: 'Replacement lock installed, but its override remains prepared and needs audit recovery: ' + err.message,
      message: 'Stale inbox lock ' + getRunId(state.lock) + ' was replaced by run '
        + replacementRunId + ', but the override record was not finalized.'
    };
  }

  const postWrite = validatePostMutationState(root, options, paths);
  const postWriteFailure = validateExpectedPostLock(postWrite, replacement, paths, 'Stale-lock recovery');
  if (postWriteFailure) {
    return {
      ...postWriteFailure,
      run_id: replacementRunId,
      override: finalized.record,
      overridePath: relativePath(root, finalized.path)
    };
  }
  const persistedOverride = postWrite.state.overrides
    .find((item) => item.override.override_id === finalized.record.override_id);
  if (!persistedOverride || !sameLockState(persistedOverride.override, finalized.record)) {
    return resultForFailure(
      'OVERRIDE_CHANGED',
      'Stale-lock recovery was written, but the finalized override no longer matches the expected audit snapshot. Refusing to report recovery success.',
      paths,
      {
        run_id: replacementRunId,
        lock: postWrite.state.lock,
        state: postWrite.state,
        override: persistedOverride?.override || null,
        overridePath: relativePath(root, finalized.path)
      }
    );
  }

  return {
    ok: true,
    run_id: replacementRunId,
    lock: replaced.lock,
    override: finalized.record,
    overridePath: relativePath(root, finalized.path),
    lockPath: paths.lockRelPath,
    message: 'Stale inbox lock ' + getRunId(state.lock) + ' was replaced by run '
      + replacementRunId + '. Override ' + audit.record.override_id
      + ' recorded ' + audit.record.reason + '.'
  };
}

export function overrideStaleInboxProcessing(instanceRoot, options = {}) {
  return withInboxMutation(instanceRoot, options, (root) => (
    overrideStaleInboxProcessingUnlocked(root, options)
  ));
}

function prepareMissingLockClaim(instanceRoot, options, now) {
  const paths = getInboxProcessingPaths(instanceRoot);
  const runId = normalizeRunId(options.runId || options.lockId);
  const audit = buildOverrideRecord(instanceRoot, options, {
    type: 'missing-lock',
    action: 'complete-without-active-lock',
    state: 'prepared',
    overriddenAt: now,
    replacedLock: null,
    replacementRunId: runId
  });
  const claim = buildLease(instanceRoot, {
    ...options,
    runId,
    claimedPaths: options.claimedPaths || options.processed || options.processedPaths || []
  }, now, {
    overrideId: audit.record.override_id,
    startedAt: asDate(options.startedAt, now, 'run start time')
  });
  return { claim, audit, paths };
}

function buildReceipt(instanceRoot, lock, options, now, override = null) {
  const claimedPaths = normalizePathList(instanceRoot, lock.claimed_paths || []);
  const processedPaths = normalizePathList(instanceRoot, [
    ...(lock.processed_paths || []),
    ...(options.processed || options.processedPaths || [])
  ]);
  const unclaimed = processedPaths.filter((item) => !claimedPaths.includes(item));
  if (unclaimed.length) {
    return {
      error: 'Completion includes paths outside this run claim: ' + unclaimed.join(', ') + '.',
      unclaimed
    };
  }
  const startedAt = Date.parse(lock.started_at);
  const heartbeatAt = Date.parse(lock.heartbeat_at);
  const expiresAt = Date.parse(getExpiry(lock));
  if (now.getTime() < startedAt || now.getTime() < heartbeatAt) {
    return {
      code: 'INVALID_COMPLETION_TIME',
      error: 'Completion time cannot be earlier than the run start or latest heartbeat.',
    };
  }
  if (now.getTime() >= expiresAt) {
    return {
      code: 'STALE_LOCK',
      error: 'Completion time is at or after the lease expiry; normal completion is refused.',
    };
  }

  return {
    receipt: {
      schema_version: SCHEMA_VERSION,
      receipt_id: getRunId(lock),
      run_id: getRunId(lock),
      lock_id: getRunId(lock),
      status: 'completed',
      processor: getProcessor(lock),
      claimed_by: getProcessor(lock),
      host: lock.host || null,
      started_at: lock.started_at,
      heartbeat_at: lock.heartbeat_at || null,
      expires_at: getExpiry(lock) || null,
      completed_at: now.toISOString(),
      claimed_paths: claimedPaths,
      processed: processedPaths,
      unresolved_paths: claimedPaths.filter((item) => !processedPaths.includes(item)),
      summary: options.summary || 'Inbox processing completed.',
      lock_snapshot: lock,
      ...(override ? { override } : {})
    },
    processedPaths
  };
}

function validateReceiptRetryPayload(instanceRoot, receipt, options, paths) {
  const requestedProcessed = options.processed || options.processedPaths || [];
  if (Array.isArray(requestedProcessed) && requestedProcessed.length) {
    const normalizedRequested = normalizePathList(instanceRoot, requestedProcessed);
    const normalizedCheckpointed = normalizePathList(
      instanceRoot,
      receipt.lock_snapshot?.processed_paths || [],
      { allowLegacyAliases: Number(receipt.schema_version || 1) < SCHEMA_VERSION }
    );
    const normalizedExisting = normalizePathList(instanceRoot, receipt.processed || [], {
      allowLegacyAliases: Number(receipt.schema_version || 1) < SCHEMA_VERSION
    });
    if (!samePathSet(
      [...new Set([...normalizedCheckpointed, ...normalizedRequested])],
      normalizedExisting
    )) {
      return resultForFailure(
        'RETRY_MISMATCH',
        'Run ' + getRunId(receipt) + ' already has a different terminal processed-path set. Retry with the original terminal state or reconcile it explicitly.',
        paths,
        { receipt }
      );
    }
  }
  if (options.summary !== undefined && String(options.summary).trim()
    && String(options.summary) !== String(receipt.summary || '')) {
    return resultForFailure(
      'RETRY_MISMATCH',
      'Run ' + getRunId(receipt) + ' already has a different terminal summary. Retry with the original terminal state or reconcile it explicitly.',
      paths,
      { receipt }
    );
  }
  return null;
}

function writeOrReadReceipt(paths, receipt) {
  const runId = getRunId(receipt);
  if (!isValidRunId(runId)) {
    throw new Error('Cannot write a receipt for unsafe run ID ' + runId + '.');
  }
  const receiptSuffix = createHash('sha256').update(runId).digest('hex').slice(0, 16);
  const receiptFile = runId + '-' + receiptSuffix + '.json';
  const receiptPath = path.join(paths.receiptsDir, receiptFile);
  const receiptRelPath = toPortablePath(path.join(paths.receiptsRelDir, receiptFile));
  try {
    writeJsonExclusive(receiptPath, receipt);
    const written = readJsonIfExists(receiptPath);
    if (!written.value || !sameLockState(written.value, receipt)) {
      throw new Error('Receipt file ' + receiptRelPath + ' changed while it was being written.');
    }
    return { created: true, receipt: written.value, receiptPath: receiptRelPath };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const parsed = readJsonIfExists(receiptPath);
    if (parsed.value && isDeepStrictEqual(parsed.value, receipt)) {
      return { created: false, receipt: parsed.value, receiptPath: receiptRelPath };
    }
    throw new Error('Receipt file ' + receiptRelPath + ' already exists with different contents.');
  }
}

function releaseOwnedLock(paths, lock) {
  const current = readJsonIfExists(paths.lockPath);
  if (!current.exists) return { released: false, changed: false };
  if (current.error) return { released: false, changed: true };
  if (!sameLockState(current.value, lock)) return { released: false, changed: true };
  const retainedPath = path.join(path.dirname(paths.lockPath),
    'inbox-processing.lock (conflicted copy release-' + randomBytes(12).toString('hex') + ').json');
  return removeSnapshot(paths.lockPath,
    (moved) => !moved.error && sameLockState(moved.value, lock), retainedPath);
}

function completeInboxProcessingUnlocked(instanceRoot, options = {}) {
  const root = path.resolve(instanceRoot);
  const paths = getInboxProcessingPaths(root);
  const requestedRunId = getRequestedRunId(options);
  const runIdError = validateRequestedRunId(paths, requestedRunId, { required: true });
  if (runIdError) return runIdError;

  const now = asDate(options.completedAt || options.now, new Date(), 'completion time');
  const state = inspectInboxProcessing(root);
  const existingReceiptForValidation = getReceiptForRun(state, requestedRunId);
  const recoveringOverride = existingReceiptForValidation
    && pendingOverrideForReceipt(state, existingReceiptForValidation.receipt, root);
  const validState = validateProcessingState(state, {
    ...options,
    instanceRoot: root
  }, recoveringOverride?.record.override_id);
  if (!validState.ok) return { ...validState, lockPath: paths.lockRelPath };

  let lock = state.lock;
  let override = null;
  let pendingOverride = null;

  if (requestedRunId) {
    const existingReceipt = getReceiptForRun(state, requestedRunId);
    if (existingReceipt) {
      if (getProcessor(existingReceipt.receipt) !== resolveProcessor(options)
        || String(existingReceipt.receipt.host || '') !== resolveHost(options)) {
        return resultForFailure(
          'FOREIGN_OWNER',
          'Run ' + requestedRunId + ' already has a receipt owned by '
            + (getProcessor(existingReceipt.receipt) || 'another processor') + ' on '
            + (existingReceipt.receipt.host || 'another host') + '.',
          paths,
          { receipt: existingReceipt.receipt, receiptPath: existingReceipt.path }
        );
      }
      if (lock && getRunId(lock) !== requestedRunId) {
        return resultForFailure(
          'CONCURRENT_CLAIM',
          'Run ' + requestedRunId + ' is complete, but the active lock belongs to run '
            + getRunId(lock) + '. Refusing to remove the active lock.',
          paths,
          { receipt: existingReceipt.receipt, lock }
        );
      }
      const incompatible = validateReceiptRetryPayload(root, existingReceipt.receipt, options, paths);
      if (incompatible) return incompatible;
      let releaseWarning = '';
      if (lock) {
        const expectedLock = existingReceipt.receipt.lock_snapshot || existingReceipt.receipt;
        if (!sameLockOwnerIdentity(lock, expectedLock)) {
          return resultForFailure(
            'LOCK_CHANGED',
            'Receipt for run ' + requestedRunId
              + ' exists, but the active lock does not match its recorded owner and start time. Refusing to remove it.',
            paths,
          { receipt: existingReceipt.receipt, lock }
          );
        }
        const release = releaseOwnedLock(paths, expectedLock);
        if (release.changed) {
          releaseWarning = 'Receipt for run ' + requestedRunId
            + ' already exists, but the lock changed before it could be released. The receipt is retained; inspect the lock before continuing.';
        }
      }
      const pendingOverride = pendingOverrideForReceipt(state, existingReceipt.receipt, root);
      let reconciledOverride = null;
      let reconciliationWarning = '';
      if (pendingOverride) {
        try {
          reconciledOverride = finalizeOverrideRecord(pendingOverride, now).record;
        } catch (err) {
          reconciliationWarning = ' The completion receipt exists, but its override remains prepared and needs audit recovery: ' + err.message;
        }
      }
      const postRelease = validatePostMutationState(
        root,
        options,
        paths,
        pendingOverride?.record.override_id
      );
      if (!postRelease.ok) {
        return resultForFailure(
          releaseWarning ? 'LOCK_CHANGED' : postRelease.code,
          (releaseWarning
            ? releaseWarning + ' '
            : 'Completion retry reconciliation found unsafe coordination state: ')
            + postRelease.message + ' Preserve the receipt and every conflicting record while reconciling it.',
          paths,
          {
            run_id: requestedRunId,
            lock: postRelease.lock,
            state: postRelease.state,
            receipt: existingReceipt.receipt,
            receiptPath: existingReceipt.path,
            ...(releaseWarning ? { warning: releaseWarning } : {}),
            ...(reconciliationWarning ? { finalizationWarning: reconciliationWarning.trim() } : {})
          }
        );
      }
      const persistedRetryReceipt = postRelease.state.receipts
        .find((record) => record.run_id === requestedRunId);
      if (!persistedRetryReceipt || !sameLockState(persistedRetryReceipt.receipt, existingReceipt.receipt)) {
        return resultForFailure(
          'RECEIPT_CHANGED',
          'Completion retry found a terminal receipt that no longer matches the expected immutable snapshot. Refusing to report success.',
          paths,
          {
            run_id: requestedRunId,
            lock: postRelease.lock,
            state: postRelease.state,
            receipt: persistedRetryReceipt?.receipt || null,
            receiptPath: existingReceipt.path
          }
        );
      }
      if (pendingOverride) {
        const expectedOverride = reconciledOverride || pendingOverride.record;
        const persistedRetryOverride = postRelease.state.overrides
          .find((record) => record.override.override_id === expectedOverride.override_id);
        if (!persistedRetryOverride || !sameLockState(persistedRetryOverride.override, expectedOverride)) {
          return resultForFailure(
            'OVERRIDE_CHANGED',
            'Completion retry found recovery evidence that no longer matches the expected immutable override snapshot. Refusing to report success.',
            paths,
            {
              run_id: requestedRunId,
              lock: postRelease.lock,
              state: postRelease.state,
              receipt: existingReceipt.receipt,
              receiptPath: existingReceipt.path,
              override: persistedRetryOverride?.override || null
            }
          );
        }
      }
      if (!releaseWarning && postRelease.state.lock) {
        return resultForFailure(
          'LOCK_CHANGED',
          'Completion retry retained the receipt, but an active lock appeared after release. Refusing to select a lock owner automatically.',
          paths,
          {
            run_id: requestedRunId,
            lock: postRelease.state.lock,
            state: postRelease.state,
            receipt: existingReceipt.receipt,
            receiptPath: existingReceipt.path
          }
        );
      }
      if (releaseWarning) {
        return resultForFailure(
          'LOCK_CHANGED',
          releaseWarning + ' The receipt is retained; inspect the lock before continuing.',
          paths,
          {
            receipt: existingReceipt.receipt,
            receiptPath: existingReceipt.path,
            lock: postRelease.lock,
            state: postRelease.state
          }
        );
      }
      return {
        ok: true,
        idempotent: true,
        run_id: requestedRunId,
        receipt: existingReceipt.receipt,
        receiptPath: existingReceipt.path,
        lockPath: paths.lockRelPath,
        ...(releaseWarning || reconciliationWarning
          ? { warning: (releaseWarning + reconciliationWarning).trim() }
          : {}),
        message: 'Inbox processing receipt for run ' + requestedRunId
          + ' already exists; no duplicate receipt or processing event was created.'
          + (releaseWarning || reconciliationWarning)
      };
    }
  }

  if (!lock) {
    if (!options.overrideMissingLock) {
      return resultForFailure(
        'MISSING_LOCK',
        'No active owned inbox processing claim exists. Run mole inbox claim first, or use --override-missing-lock --reason for an audited recovery.',
        paths
      );
    }
    if (!String(options.reason || options.overrideReason || '').trim()) {
      return resultForFailure(
        'OVERRIDE_REASON_REQUIRED',
        'Missing-lock completion requires an explicit override reason. No receipt was written.',
        paths
      );
    }
    const identityError = validateExplicitRecoveryIdentity(paths, options);
    if (identityError) return identityError;
    const created = prepareMissingLockClaim(root, options, now);
    lock = created.claim;
    override = created.audit.record;
    pendingOverride = created.audit;
  } else {
    const owned = verifyOwnedActiveLock(root, { ...options, now });
    if (!owned.ok) return owned;
    lock = owned.lock;
  }

  const built = buildReceipt(root, lock, options, now, override);
  if (built.error) {
    return resultForFailure(built.code || 'UNCLAIMED_PATH', built.error, paths, { lock });
  }

  const previouslyProcessed = getProcessedPathsFromState(state, root);
  const alreadyProcessed = built.processedPaths.filter((item) => previouslyProcessed.has(item));
  if (alreadyProcessed.length) {
    return resultForFailure(
      'ALREADY_PROCESSED',
      'These paths are already covered by another completion receipt: '
        + alreadyProcessed.join(', ')
        + '. Refusing to create a second processing event.',
      paths,
      { lock, alreadyProcessedPaths: alreadyProcessed }
    );
  }

  const receiptState = inspectInboxProcessing(root);
  const duplicate = receiptState.duplicateReceipts.find((item) => item.run_id === getRunId(lock));
  if (duplicate) {
    return resultForFailure(
      'DUPLICATE_RECEIPT',
      'Multiple receipts already exist for run ' + getRunId(lock) + ': '
        + duplicate.paths.join(', ') + '. Refusing to choose one.',
      paths,
      { lock, duplicateReceipts: [duplicate] }
    );
  }

  if (pendingOverride) persistOverrideRecord(pendingOverride);

  const written = writeOrReadReceipt(paths, built.receipt);

  let finalizedOverride = override;
  let finalizationWarning = '';
  if (pendingOverride) {
    try {
      finalizedOverride = finalizeOverrideRecord(pendingOverride, now).record;
    } catch (err) {
      finalizationWarning = ' Override remains prepared and needs audit recovery: ' + err.message;
    }
  }

  const postWrite = validatePostMutationState(
    root,
    options,
    paths,
    pendingOverride?.record.override_id
  );
  if (!postWrite.ok) {
    return resultForFailure(
      postWrite.code,
      'Completion receipt was written, but the post-write audit found unsafe coordination state: '
        + postWrite.message + ' Preserve the receipt, lock, and every conflicting record while reconciling it.',
      paths,
      {
        run_id: getRunId(lock),
        lock: postWrite.lock,
        state: postWrite.state,
        receipt: written.receipt,
        receiptPath: written.receiptPath,
        override: finalizedOverride,
        ...(finalizationWarning ? { warning: finalizationWarning.trim() } : {})
      }
    );
  }
  const persistedReceipt = postWrite.state.receipts
    .find((record) => record.run_id === getRunId(lock));
  if (!persistedReceipt || !sameLockState(persistedReceipt.receipt, written.receipt)) {
    return resultForFailure(
      'RECEIPT_CHANGED',
      'Completion receipt was written, but the persisted terminal record no longer matches the expected immutable snapshot. Refusing to report success.',
      paths,
      {
        run_id: getRunId(lock),
        lock: postWrite.lock,
        state: postWrite.state,
        receipt: persistedReceipt?.receipt || null,
        receiptPath: written.receiptPath,
        override: finalizedOverride
      }
    );
  }
  if (pendingOverride) {
    const persistedOverride = postWrite.state.overrides
      .find((item) => item.override.override_id === finalizedOverride?.override_id);
    if (!persistedOverride || !sameLockState(persistedOverride.override, finalizedOverride)) {
      return resultForFailure(
        'OVERRIDE_CHANGED',
        'Completion receipt was written, but the recovery evidence no longer matches the expected immutable override snapshot. Refusing to report success.',
        paths,
        {
          run_id: getRunId(lock),
          lock: postWrite.lock,
          state: postWrite.state,
          receipt: written.receipt,
          receiptPath: written.receiptPath,
          override: persistedOverride?.override || null
        }
      );
    }
  }

  let releaseWarning = '';
  if (state.lock) {
    const release = releaseOwnedLock(paths, state.lock);
    if (release.changed) {
      releaseWarning = 'Receipt was written, but the lock changed before release. Inspect the active lock before continuing.';
    }
  }

  const postRelease = validatePostMutationState(
    root,
    options,
    paths,
    pendingOverride?.record.override_id
  );
  if (!postRelease.ok) {
    return resultForFailure(
      postRelease.code,
      'Completion reconciliation found unsafe coordination state after lock release: '
        + postRelease.message + ' Preserve the receipt and every conflicting record while reconciling it.',
      paths,
      {
        run_id: getRunId(lock),
        lock: postRelease.lock,
        state: postRelease.state,
        receipt: written.receipt,
        receiptPath: written.receiptPath,
        override: finalizedOverride,
        ...(releaseWarning ? { warning: releaseWarning } : {}),
        ...(finalizationWarning ? { finalizationWarning: finalizationWarning.trim() } : {})
      }
    );
  }
  const postReleaseReceipt = postRelease.state.receipts
    .find((record) => record.run_id === getRunId(lock));
  if (!postReleaseReceipt || !sameLockState(postReleaseReceipt.receipt, written.receipt)) {
    return resultForFailure(
      'RECEIPT_CHANGED',
      'Completion release finished, but the terminal receipt no longer matches the expected immutable snapshot. Refusing to report success.',
      paths,
      {
        run_id: getRunId(lock),
        lock: postRelease.state.lock,
        state: postRelease.state,
        receipt: postReleaseReceipt?.receipt || null,
        receiptPath: written.receiptPath,
        override: finalizedOverride,
        ...(releaseWarning ? { warning: releaseWarning } : {})
      }
    );
  }
  if (pendingOverride) {
    const postReleaseOverride = postRelease.state.overrides
      .find((item) => item.override.override_id === finalizedOverride?.override_id);
    if (!postReleaseOverride || !sameLockState(postReleaseOverride.override, finalizedOverride)) {
      return resultForFailure(
        'OVERRIDE_CHANGED',
        'Completion release finished, but the recovery evidence no longer matches the expected immutable override snapshot. Refusing to report success.',
        paths,
        {
          run_id: getRunId(lock),
          lock: postRelease.state.lock,
          state: postRelease.state,
          receipt: written.receipt,
          receiptPath: written.receiptPath,
          override: postReleaseOverride?.override || null,
          ...(releaseWarning ? { warning: releaseWarning } : {})
        }
      );
    }
  }
  if (!releaseWarning && postRelease.state.lock) {
    return resultForFailure(
      'LOCK_CHANGED',
      'Completion receipt was written, but an active lock appeared after release. Refusing to select a lock owner automatically.',
      paths,
      {
        run_id: getRunId(lock),
        lock: postRelease.state.lock,
        state: postRelease.state,
        receipt: written.receipt,
        receiptPath: written.receiptPath,
        override: finalizedOverride
      }
    );
  }

  if (releaseWarning) {
    return {
      ok: true,
      idempotent: !written.created,
      run_id: getRunId(lock),
      receipt: written.receipt,
      receiptPath: written.receiptPath,
      lockPath: paths.lockRelPath,
      warning: releaseWarning,
      message: 'Inbox processing receipt written to ' + written.receiptPath
        + ', but the lock was not removed because it changed.'
    };
  }

  return {
    ok: true,
    idempotent: !written.created,
    run_id: getRunId(lock),
    receipt: written.receipt,
    receiptPath: written.receiptPath,
    lockPath: paths.lockRelPath,
    override: finalizedOverride,
    ...(finalizationWarning ? { warning: finalizationWarning.trim() } : {}),
    message: (written.created
      ? 'Inbox processing receipt written to ' + written.receiptPath + '.'
      : 'Inbox processing receipt for run ' + getRunId(lock)
        + ' already exists; no duplicate receipt or processing event was created.') + finalizationWarning
  };
}

export function completeInboxProcessing(instanceRoot, options = {}) {
  return withInboxMutation(instanceRoot, options, (root) => (
    completeInboxProcessingUnlocked(root, options)
  ));
}
