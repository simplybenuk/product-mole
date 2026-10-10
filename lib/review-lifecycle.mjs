import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getInboxMutationProcessIdentity, looksLikeSyncConflictName } from './inbox-processing.mjs';
import {
  SOURCE_ID_PATTERN,
  correctSource,
  getSourceRegistryPaths,
  hashFileSync,
  isSourceId,
  readSourceRecord,
  registerSource,
  resolveSource,
  toWorkspaceRelativePath
} from './source-registry.mjs';

/**
 * The review lifecycle is a file-native ledger.  It records which registered
 * source files are raw material, evidence, drafts, or reviewed context, and it
 * never edits the files it describes.  Frontmatter such as `status: active`
 * stays descriptive; the ledger is the authority for review state.
 */

export const LIFECYCLE_SCHEMA_VERSION = 1;
export const LIFECYCLE_SCHEMA_REL_PATH = path.join('schemas', 'review-lifecycle-v1.schema.json');
export const LIFECYCLE_ROOT_REL_PATH = path.join('governance', 'lifecycle');
export const LIFECYCLE_LEDGER_REL_PATH = path.join(LIFECYCLE_ROOT_REL_PATH, 'records.json');
export const RECORD_ID_PATTERN = /^rec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const LIFECYCLE_STATES = Object.freeze([
  'raw',
  'evidence',
  'draft',
  'pending_review',
  'accepted',
  'rejected',
  'superseded',
  'unreviewed'
]);
export const INITIAL_LIFECYCLE_STATES = Object.freeze(['raw', 'evidence', 'draft', 'unreviewed']);
export const ACTOR_TYPES = Object.freeze(['human', 'agent', 'automation']);
export const DEFAULT_RETRIEVAL_STATES = Object.freeze(['accepted']);

/**
 * Every state change a caller can request.  `human: true` means the action
 * needs a declared human actor and an explicit confirmation.
 */
export const LIFECYCLE_TRANSITIONS = Object.freeze({
  evidence: Object.freeze({ from: Object.freeze(['raw', 'unreviewed']), to: 'evidence', human: false }),
  draft: Object.freeze({ from: Object.freeze(['raw', 'evidence', 'unreviewed']), to: 'draft', human: false }),
  submit: Object.freeze({ from: Object.freeze(['draft', 'unreviewed']), to: 'pending_review', human: false }),
  revise: Object.freeze({ from: Object.freeze(['pending_review', 'rejected']), to: 'draft', human: false }),
  approve: Object.freeze({ from: Object.freeze(['pending_review']), to: 'accepted', human: true }),
  reject: Object.freeze({ from: Object.freeze(['pending_review']), to: 'rejected', human: true }),
  supersede: Object.freeze({ from: Object.freeze(['accepted']), to: 'superseded', human: true })
});
export const LIFECYCLE_ACTIONS = Object.freeze(Object.keys(LIFECYCLE_TRANSITIONS));

// History-only actions.  `register` opens a record and `replace` is appended to
// an accepted record when it becomes the replacement for another record.
const HISTORY_ACTIONS = new Set(['register', 'replace', ...LIFECYCLE_ACTIONS]);
const HUMAN_HISTORY_ACTIONS = new Set(['approve', 'reject', 'supersede', 'replace']);
const BOUND_STATES = new Set(['pending_review', 'accepted']);
const SOURCE_EDIT_ACTIONS = new Set(['evidence', 'draft', 'submit', 'revise']);
const SOURCE_ADD_ACTIONS = new Set([...SOURCE_EDIT_ACTIONS, 'approve']);
const DEFAULT_MIGRATION_ROOTS = ['2-summaries', '3-indexes', '4-context', '5-evidence'];
const MUTATION_LOCK_PREFIX = 'mole-lifecycle-';
const UNVERIFIED_LOCK_STALE_MS = 5 * 60 * 1000;
const DEFAULT_LOCK_WAIT_MS = 2000;
const LOCK_RETRY_MS = 25;
const TEMP_FILE_PATTERN = /^\.records\.json\.[0-9a-f-]+\.tmp$/;

const LEDGER_FIELDS = ['schema_version', 'ledger_revision', 'updated_at', 'records'];
const RECORD_FIELDS = [
  'record_id',
  'source_id',
  'state',
  'revision',
  'path',
  'content_hash',
  'byte_size',
  'source_ids',
  'supersedes',
  'superseded_by',
  'decision',
  'created_at',
  'updated_at',
  'history'
];
const HISTORY_FIELDS = [
  'revision',
  'action',
  'from_state',
  'to_state',
  'actor',
  'actor_type',
  'human_confirmed',
  'at',
  'reason',
  'content_hash',
  'byte_size',
  'source_ids',
  'related_record_ids'
];
const DECISION_FIELDS = ['outcome', 'reviewer', 'decided_at', 'reason'];
const HASH_FIELDS = ['algorithm', 'value'];

export class LifecycleError extends Error {
  constructor(message, code = 'LIFECYCLE_ERROR', details = {}) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
    this.details = details;
  }
}

/** Codes that describe a malformed request rather than a refused operation. */
export const LIFECYCLE_USAGE_ERROR_CODES = Object.freeze(new Set([
  'INVALID_ARGUMENT',
  'INVALID_RECORD_ID',
  'INVALID_SOURCE_ID',
  'INVALID_STATE',
  'INVALID_ACTION',
  'INVALID_ACTOR_TYPE',
  'INVALID_OPTION',
  'INVALID_TIMESTAMP',
  'ACTOR_REQUIRED',
  'REASON_REQUIRED'
]));

function fail(message, code, details = {}) {
  throw new LifecycleError(message, code, details);
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toPortablePath(value) {
  return String(value).split(path.sep).join('/');
}

function isDateTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function toIsoTimestamp(value) {
  const candidate = value === undefined || value === null ? new Date() : value;
  const date = candidate instanceof Date ? new Date(candidate.getTime()) : new Date(candidate);
  if (Number.isNaN(date.getTime())) fail(`Invalid timestamp: ${candidate}`, 'INVALID_TIMESTAMP');
  return date.toISOString();
}

function normalizeRoot(instanceRoot = process.cwd()) {
  const root = path.resolve(String(instanceRoot));
  let stat;
  try {
    stat = fs.statSync(root);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`Workspace root does not exist: ${root}`, 'WORKSPACE_NOT_FOUND');
    throw error;
  }
  if (!stat.isDirectory()) fail(`Workspace root is not a directory: ${root}`, 'WORKSPACE_NOT_DIRECTORY');
  return root;
}

export function createRecordId() {
  return `rec_${randomUUID()}`;
}

export function isRecordId(value) {
  return typeof value === 'string' && RECORD_ID_PATTERN.test(value);
}

export function assertRecordId(value) {
  if (!isRecordId(value)) fail(`Invalid lifecycle record ID: ${value}`, 'INVALID_RECORD_ID', { record_id: value });
  return value;
}

export function getLifecyclePaths(instanceRoot = process.cwd()) {
  const root = path.resolve(String(instanceRoot));
  return {
    workspaceRoot: root,
    lifecycleRoot: path.join(root, LIFECYCLE_ROOT_REL_PATH),
    lifecycleRootRelPath: toPortablePath(LIFECYCLE_ROOT_REL_PATH),
    ledgerPath: path.join(root, LIFECYCLE_LEDGER_REL_PATH),
    ledgerRelPath: toPortablePath(LIFECYCLE_LEDGER_REL_PATH),
    schemaPath: path.join(root, LIFECYCLE_SCHEMA_REL_PATH)
  };
}

function emptyLedger() {
  return {
    schema_version: LIFECYCLE_SCHEMA_VERSION,
    ledger_revision: 0,
    updated_at: null,
    records: []
  };
}

function checkExactKeys(value, expected, label, errors) {
  if (!asObject(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${label}.${key} is required`);
  }
  return true;
}

function checkHash(value, byteSize, label, errors) {
  if (!checkExactKeys(value, HASH_FIELDS, `${label}.content_hash`, errors)) return;
  if (value.algorithm !== 'sha256') errors.push(`${label}.content_hash.algorithm must be sha256`);
  if (typeof value.value !== 'string' || !/^[0-9a-f]{64}$/.test(value.value)) {
    errors.push(`${label}.content_hash.value must be a lowercase SHA-256 digest`);
  }
  if (!Number.isInteger(byteSize) || byteSize < 0) errors.push(`${label}.byte_size must be a non-negative integer`);
}

function checkIdList(value, isValid, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return [];
  }
  const seen = new Set();
  for (const item of value) {
    if (!isValid(item)) errors.push(`${label} contains an invalid ID`);
    else if (seen.has(item)) errors.push(`${label} contains a duplicate ID`);
    seen.add(item);
  }
  return value;
}

function checkPath(value, label, errors) {
  if (typeof value !== 'string' || !value) {
    errors.push(`${label} must be a non-empty workspace-relative path`);
    return;
  }
  const hasTraversal = value.split('/').some((part) => part === '..');
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value) || hasTraversal
    || path.posix.normalize(value) !== value || value === '.') {
    errors.push(`${label} must use a normalized workspace-relative path`);
  }
}

function validateHistory(record, label, errors) {
  if (!Array.isArray(record.history) || record.history.length === 0) {
    errors.push(`${label}.history must be a non-empty array`);
    return;
  }
  let previous = null;
  for (let index = 0; index < record.history.length; index += 1) {
    const entry = record.history[index];
    const entryLabel = `${label}.history[${index}]`;
    if (!checkExactKeys(entry, HISTORY_FIELDS, entryLabel, errors)) {
      previous = null;
      continue;
    }
    if (entry.revision !== index + 1) errors.push(`${entryLabel}.revision must equal ${index + 1}`);
    if (!HISTORY_ACTIONS.has(entry.action)) errors.push(`${entryLabel}.action is not a lifecycle action`);
    if (!LIFECYCLE_STATES.includes(entry.to_state)) errors.push(`${entryLabel}.to_state is not a lifecycle state`);
    if (typeof entry.actor !== 'string' || !entry.actor.trim()) errors.push(`${entryLabel}.actor must be a non-empty string`);
    if (!ACTOR_TYPES.includes(entry.actor_type)) errors.push(`${entryLabel}.actor_type is invalid`);
    if (typeof entry.human_confirmed !== 'boolean') errors.push(`${entryLabel}.human_confirmed must be a boolean`);
    if (!isDateTime(entry.at)) errors.push(`${entryLabel}.at must be an RFC 3339 UTC timestamp with millisecond precision`);
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) errors.push(`${entryLabel}.reason must be a non-empty string`);
    checkHash(entry.content_hash, entry.byte_size, entryLabel, errors);
    checkIdList(entry.source_ids, isSourceId, `${entryLabel}.source_ids`, errors);
    checkIdList(entry.related_record_ids, isRecordId, `${entryLabel}.related_record_ids`, errors);

    if (index === 0) {
      if (entry.action !== 'register') errors.push(`${entryLabel}.action must be register`);
      if (entry.from_state !== null) errors.push(`${entryLabel}.from_state must be null`);
      if (!INITIAL_LIFECYCLE_STATES.includes(entry.to_state)) {
        errors.push(`${entryLabel}.to_state must be an initial state; registration cannot create ${entry.to_state}`);
      }
    } else if (entry.action === 'register') {
      errors.push(`${entryLabel}.action register is only valid as the first entry`);
    } else if (entry.action === 'replace') {
      if (entry.from_state !== 'accepted' || entry.to_state !== 'accepted') {
        errors.push(`${entryLabel} replace must keep the record accepted`);
      }
    } else {
      const rule = LIFECYCLE_TRANSITIONS[entry.action];
      if (rule && (!rule.from.includes(entry.from_state) || rule.to !== entry.to_state)) {
        errors.push(`${entryLabel} is not a valid ${entry.action} transition (${entry.from_state} -> ${entry.to_state})`);
      }
    }
    if (previous && entry.from_state !== previous.to_state) {
      errors.push(`${entryLabel}.from_state must equal the previous to_state`);
    }
    if (HUMAN_HISTORY_ACTIONS.has(entry.action) && (entry.actor_type !== 'human' || entry.human_confirmed !== true)) {
      errors.push(`${entryLabel} records ${entry.action} without a confirmed human actor`);
    }
    previous = entry;
  }

  const latest = record.history[record.history.length - 1];
  if (asObject(latest)) {
    if (record.revision !== record.history.length) errors.push(`${label}.revision must equal the history length`);
    if (latest.to_state !== record.state) errors.push(`${label}.state must equal the latest history to_state`);
    if (latest.at !== record.updated_at) errors.push(`${label}.updated_at must equal the latest history timestamp`);
  }
  if (asObject(record.history[0]) && record.history[0].at !== record.created_at) {
    errors.push(`${label}.created_at must equal the first history timestamp`);
  }
}

function validateDecision(record, label, errors) {
  const expected = record.state === 'accepted' || record.state === 'superseded'
    ? 'accepted'
    : (record.state === 'rejected' ? 'rejected' : null);
  if (expected === null) {
    if (record.decision !== null) errors.push(`${label}.decision must be null while the record is ${record.state}`);
    return;
  }
  if (!checkExactKeys(record.decision, DECISION_FIELDS, `${label}.decision`, errors)) return;
  if (record.decision.outcome !== expected) errors.push(`${label}.decision.outcome must be ${expected}`);
  if (typeof record.decision.reviewer !== 'string' || !record.decision.reviewer.trim()) errors.push(`${label}.decision.reviewer is required`);
  if (!isDateTime(record.decision.decided_at)) errors.push(`${label}.decision.decided_at must be a UTC timestamp`);
  if (typeof record.decision.reason !== 'string' || !record.decision.reason.trim()) errors.push(`${label}.decision.reason is required`);

  const action = expected === 'accepted' ? 'approve' : 'reject';
  const entries = Array.isArray(record.history) ? record.history.filter((entry) => asObject(entry) && entry.action === action) : [];
  const entry = entries[entries.length - 1];
  if (!entry) {
    errors.push(`${label}.decision has no matching ${action} entry in history`);
  } else if (entry.actor !== record.decision.reviewer || entry.at !== record.decision.decided_at || entry.reason !== record.decision.reason) {
    errors.push(`${label}.decision must match the latest ${action} entry in history`);
  }
}

/**
 * Validate a ledger without a third-party JSON-schema package.  The checks
 * cover the schema and the rules a schema cannot express: history continuity,
 * human-only decisions, and reciprocal supersession links.
 */
export function validateLifecycleLedger(ledger) {
  const errors = [];
  if (!checkExactKeys(ledger, LEDGER_FIELDS, 'ledger', errors)) return { valid: false, errors };
  if (ledger.schema_version !== LIFECYCLE_SCHEMA_VERSION) errors.push('ledger.schema_version must be 1');
  if (!Number.isInteger(ledger.ledger_revision) || ledger.ledger_revision < 0) errors.push('ledger.ledger_revision must be a non-negative integer');
  if (!(ledger.updated_at === null || isDateTime(ledger.updated_at))) errors.push('ledger.updated_at must be a UTC timestamp or null');
  if (!Array.isArray(ledger.records)) {
    errors.push('ledger.records must be an array');
    return { valid: false, errors };
  }

  const byId = new Map();
  const sourceOwners = new Map();
  for (let index = 0; index < ledger.records.length; index += 1) {
    const record = ledger.records[index];
    const label = `records[${index}]`;
    if (!checkExactKeys(record, RECORD_FIELDS, label, errors)) continue;
    if (!isRecordId(record.record_id)) errors.push(`${label}.record_id must be a lowercase rec_ UUIDv4`);
    else if (byId.has(record.record_id)) errors.push(`${label}.record_id is duplicated`);
    else byId.set(record.record_id, record);
    if (!isSourceId(record.source_id)) errors.push(`${label}.source_id must be a source ID`);
    else if (sourceOwners.has(record.source_id)) errors.push(`${label}.source_id already has a lifecycle record`);
    else sourceOwners.set(record.source_id, record.record_id);
    if (!LIFECYCLE_STATES.includes(record.state)) errors.push(`${label}.state is not a lifecycle state`);
    if (!Number.isInteger(record.revision) || record.revision < 1) errors.push(`${label}.revision must be a positive integer`);
    checkPath(record.path, `${label}.path`, errors);
    checkHash(record.content_hash, record.byte_size, label, errors);
    const sourceIds = checkIdList(record.source_ids, isSourceId, `${label}.source_ids`, errors);
    if (sourceIds.includes(record.source_id)) errors.push(`${label}.source_ids cannot cite the record's own source`);
    checkIdList(record.supersedes, isRecordId, `${label}.supersedes`, errors);
    if (!(record.superseded_by === null || isRecordId(record.superseded_by))) errors.push(`${label}.superseded_by must be a record ID or null`);
    if (!isDateTime(record.created_at)) errors.push(`${label}.created_at must be a UTC timestamp`);
    if (!isDateTime(record.updated_at)) errors.push(`${label}.updated_at must be a UTC timestamp`);
    validateHistory(record, label, errors);
    validateDecision(record, label, errors);
    if ((record.state === 'accepted' || record.state === 'superseded') && sourceIds.length === 0) {
      errors.push(`${label} is ${record.state} without a supporting source ID`);
    }
    if ((record.state === 'superseded') !== (record.superseded_by !== null)) {
      errors.push(`${label}.superseded_by must be set only while the record is superseded`);
    }
    if (Array.isArray(record.supersedes) && record.supersedes.length > 0
      && record.state !== 'accepted' && record.state !== 'superseded') {
      errors.push(`${label}.supersedes requires an accepted or superseded record`);
    }
  }

  for (const record of byId.values()) {
    if (record.superseded_by !== null && isRecordId(record.superseded_by)) {
      const replacement = byId.get(record.superseded_by);
      if (record.superseded_by === record.record_id) errors.push(`${record.record_id} cannot supersede itself`);
      else if (!replacement) errors.push(`${record.record_id}.superseded_by names a missing record`);
      else if (!Array.isArray(replacement.supersedes) || !replacement.supersedes.includes(record.record_id)) {
        errors.push(`${record.record_id}.superseded_by is not reciprocated by ${replacement.record_id}.supersedes`);
      }
    }
    for (const supersededId of Array.isArray(record.supersedes) ? record.supersedes : []) {
      const superseded = byId.get(supersededId);
      if (!superseded) errors.push(`${record.record_id}.supersedes names a missing record`);
      else if (superseded.superseded_by !== record.record_id) {
        errors.push(`${record.record_id}.supersedes is not reciprocated by ${supersededId}.superseded_by`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function assertValidLedger(ledger, paths) {
  const validation = validateLifecycleLedger(ledger);
  if (!validation.valid) {
    fail(`Invalid lifecycle ledger: ${validation.errors.join('; ')}`, 'INVALID_LEDGER', {
      path: paths.ledgerRelPath,
      errors: validation.errors
    });
  }
  return ledger;
}

function scanLifecycleDirectory(paths) {
  const result = { conflictCopies: [], tempFiles: [], unexpected: [] };
  let entries;
  try {
    entries = fs.readdirSync(paths.lifecycleRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return result;
    throw error;
  }
  const ledgerName = path.basename(paths.ledgerPath);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = `${paths.lifecycleRootRelPath}/${entry.name}`;
    if (entry.name === ledgerName || entry.name === 'README.md') continue;
    if (TEMP_FILE_PATTERN.test(entry.name)) result.tempFiles.push(relative);
    else if (entry.name.startsWith('.')) continue;
    else if (looksLikeSyncConflictName(entry.name) || entry.name.toLowerCase().includes('records')) result.conflictCopies.push(relative);
    else result.unexpected.push(relative);
  }
  return result;
}

/**
 * Read the ledger without throwing on bad content.  Callers decide whether a
 * problem is a refusal (mutations, retrieval) or a finding (audit).
 */
function readLedgerState(root) {
  const paths = getLifecyclePaths(root);
  const state = { paths, exists: false, raw: null, ledger: null, errors: [], directory: null };
  try {
    toWorkspaceRelativePath(root, paths.ledgerPath);
  } catch (error) {
    state.errors.push(`Lifecycle ledger path is unsafe: ${error.message}`);
    state.directory = { conflictCopies: [], tempFiles: [], unexpected: [] };
    return state;
  }
  state.directory = scanLifecycleDirectory(paths);

  let stat;
  try {
    stat = fs.statSync(paths.ledgerPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state.ledger = emptyLedger();
    return state;
  }
  state.exists = true;
  if (!stat.isFile()) {
    state.errors.push('Lifecycle ledger is not a regular file.');
    return state;
  }
  state.raw = fs.readFileSync(paths.ledgerPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(state.raw);
  } catch (error) {
    state.errors.push(`Lifecycle ledger is not valid JSON: ${error.message}`);
    return state;
  }
  const validation = validateLifecycleLedger(parsed);
  if (!validation.valid) {
    state.errors.push(...validation.errors);
    return state;
  }
  state.ledger = parsed;
  return state;
}

function loadLedger(instanceRoot) {
  const root = normalizeRoot(instanceRoot);
  const state = readLedgerState(root);
  if (state.errors.length) {
    fail(`Lifecycle ledger is invalid; run "mole lifecycle audit" and repair it before continuing: ${state.errors.join('; ')}`, 'INVALID_LEDGER', {
      path: state.paths.ledgerRelPath,
      errors: state.errors
    });
  }
  if (state.directory.conflictCopies.length) {
    fail(`Lifecycle ledger has competing copies; preserve them and reconcile before continuing: ${state.directory.conflictCopies.join(', ')}`, 'LEDGER_CONFLICT', {
      path: state.paths.ledgerRelPath,
      conflict_copies: state.directory.conflictCopies
    });
  }
  return { root, ...state };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function mutationLockPath(root) {
  let real = root;
  try {
    real = fs.realpathSync.native(root);
  } catch {
    // An unresolvable root fails later with a clearer workspace error.
  }
  const key = createHash('sha256').update(path.join(real, LIFECYCLE_LEDGER_REL_PATH)).digest('hex');
  return path.join(os.tmpdir(), `${MUTATION_LOCK_PREFIX}${key}.lock.json`);
}

function readLockHolder(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let holder = null;
  try {
    const parsed = JSON.parse(raw);
    if (asObject(parsed)) holder = parsed;
  } catch {
    // An unreadable lock is still a lock; liveness falls back to file age.
  }
  let ageMs = null;
  try {
    ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    // The lock vanished between reads; report what was seen.
  }

  let alive;
  if (!holder || !Number.isInteger(holder.pid) || holder.pid <= 0) {
    alive = ageMs === null ? true : ageMs < UNVERIFIED_LOCK_STALE_MS;
  } else if (!isProcessAlive(holder.pid)) {
    alive = false;
  } else {
    const identity = getInboxMutationProcessIdentity(holder.pid);
    if (holder.process_identity && identity) alive = holder.process_identity === identity;
    else alive = ageMs === null ? true : ageMs < UNVERIFIED_LOCK_STALE_MS;
  }
  return { holder, alive, lock_path: lockPath };
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function lockWaitMs(options = {}) {
  const value = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  if (!Number.isFinite(value) || value < 0) fail('lockWaitMs must be a non-negative number.', 'INVALID_ARGUMENT');
  return value;
}

/**
 * Take the local mutation lock.  A running holder is waited for briefly so
 * near-simultaneous captures do not fail; a lock left by a stopped process is
 * never removed here.
 */
function acquireMutationLock(root, waitMs) {
  const lockPath = mutationLockPath(root);
  const token = randomUUID();
  const record = {
    token,
    pid: process.pid,
    process_identity: getInboxMutationProcessIdentity(process.pid),
    host: os.hostname(),
    acquired_at: new Date().toISOString(),
    workspace: root
  };
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      return { lockPath, token };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const current = readLockHolder(lockPath);
    if (!current) continue;
    if (current.alive && Date.now() < deadline) {
      sleepSync(LOCK_RETRY_MS);
      continue;
    }
    fail(current.alive
      ? 'Another lifecycle mutation is in progress for this workspace. Nothing was changed; retry after it finishes.'
      : 'A lifecycle mutation lock was left behind by a process that is no longer running. Run "mole lifecycle audit", then "mole lifecycle unlock" to remove it. Nothing was changed.',
    'LIFECYCLE_BUSY', {
      holder: current.holder,
      holder_alive: current.alive
    });
  }
}

function releaseMutationLock(lock) {
  let holder = null;
  try {
    holder = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8'));
  } catch {
    return;
  }
  if (holder?.token !== lock.token) return;
  try {
    fs.unlinkSync(lock.lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/**
 * Remove a mutation lock left by a stopped process.  Recovery is explicit: a
 * mutation never removes another process's lock by itself.
 */
export function unlockLifecycle(instanceRoot) {
  const root = normalizeRoot(instanceRoot);
  const lockPath = mutationLockPath(root);
  const current = readLockHolder(lockPath);
  if (!current) return { ok: true, removed: false, holder: null };
  if (current.alive) {
    fail('The lifecycle mutation lock belongs to a process that still appears to be running. Nothing was changed.', 'LOCK_HELD', {
      holder: current.holder
    });
  }
  const detached = `${lockPath}.${randomUUID()}.removed`;
  try {
    fs.renameSync(lockPath, detached);
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, removed: false, holder: null };
    throw error;
  }
  fs.unlinkSync(detached);
  return { ok: true, removed: true, holder: current.holder };
}

function writeLedgerAtomically(paths, ledger) {
  const payload = `${JSON.stringify(ledger, null, 2)}\n`;
  fs.mkdirSync(paths.lifecycleRoot, { recursive: true });
  const temporary = path.join(paths.lifecycleRoot, `.${path.basename(paths.ledgerPath)}.${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temporary, 'wx');
    try {
      fs.writeSync(fd, payload, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, paths.ledgerPath);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function isDeepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertAppendOnly(previous, next) {
  const nextById = new Map(next.records.map((record) => [record.record_id, record]));
  for (const record of previous.records) {
    const updated = nextById.get(record.record_id);
    if (!updated) fail(`Refusing to drop lifecycle record ${record.record_id}.`, 'HISTORY_REWRITE');
    if (updated.source_id !== record.source_id || updated.created_at !== record.created_at
      || !isDeepEqual(updated.history.slice(0, record.history.length), record.history)) {
      fail(`Refusing to rewrite the history of lifecycle record ${record.record_id}.`, 'HISTORY_REWRITE');
    }
  }
}

/**
 * Run one ledger mutation under the local lock.  The operation edits a copy;
 * the copy is validated, checked against the previous history, and written in
 * one atomic rename only if the file on disk is still the one that was read.
 */
function withLedgerMutation(instanceRoot, options, operation) {
  const root = normalizeRoot(instanceRoot);
  const lock = acquireMutationLock(root, lockWaitMs(options));
  try {
    const state = loadLedger(root);
    const next = structuredClone(state.ledger);
    const outcome = operation(next, root);
    if (!outcome.changed) return outcome.result;

    next.ledger_revision = state.ledger.ledger_revision + 1;
    next.updated_at = outcome.at;
    assertAppendOnly(state.ledger, next);
    assertValidLedger(next, state.paths);

    let current = null;
    try {
      current = fs.readFileSync(state.paths.ledgerPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current !== state.raw) {
      fail('The lifecycle ledger changed while this operation was running. Nothing was written; review the ledger and retry.', 'LEDGER_CHANGED', {
        path: state.paths.ledgerRelPath
      });
    }
    writeLedgerAtomically(state.paths, next);
    return outcome.result;
  } finally {
    releaseMutationLock(lock);
  }
}

function normalizeActor(options) {
  const actor = String(options.actor ?? '').trim();
  if (!actor) fail('An actor name is required.', 'ACTOR_REQUIRED');
  const actorType = options.actorType ?? options.actor_type;
  if (!ACTOR_TYPES.includes(actorType)) {
    fail(`Actor type must be one of ${ACTOR_TYPES.join(', ')}.`, 'INVALID_ACTOR_TYPE', { actor_type: actorType ?? null });
  }
  return { actor, actorType };
}

function normalizeIdList(value, isValid, code, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${label} must be an array.`, 'INVALID_ARGUMENT');
  const ids = [];
  for (const item of value) {
    if (!isValid(item)) fail(`Invalid ${label} entry: ${item}`, code, { value: item });
    if (!ids.includes(item)) ids.push(item);
  }
  return ids;
}

function normalizeStates(value, label = 'states') {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${label} must be an array.`, 'INVALID_ARGUMENT');
  const states = [];
  for (const item of value) {
    if (!LIFECYCLE_STATES.includes(item)) {
      fail(`Unknown lifecycle state: ${item}. Use one of ${LIFECYCLE_STATES.join(', ')}.`, 'INVALID_STATE', { state: item });
    }
    if (!states.includes(item)) states.push(item);
  }
  return states;
}

function assertSupportingSources(root, sourceIds, ownSourceId) {
  for (const sourceId of sourceIds) {
    if (sourceId === ownSourceId) {
      fail('A record cannot cite its own source as supporting evidence.', 'INVALID_SUPPORTING_SOURCE', { source_id: sourceId });
    }
    let source;
    try {
      source = readSourceRecord(root, sourceId);
    } catch (error) {
      fail(`Supporting source record is invalid: ${sourceId}`, 'INVALID_SUPPORTING_SOURCE', { source_id: sourceId, error: error.message });
    }
    if (!source) {
      fail(`Supporting source is not registered: ${sourceId}`, 'SUPPORTING_SOURCE_NOT_REGISTERED', { source_id: sourceId });
    }
  }
}

function digestOf(absolute) {
  const digest = hashFileSync(absolute);
  return { content_hash: { algorithm: 'sha256', value: digest.value }, byte_size: digest.byte_size };
}

function sameContent(left, right) {
  return left.content_hash.value === right.content_hash.value && left.byte_size === right.byte_size;
}

/**
 * Find the file a record describes.  The source registry owns paths: the
 * registered current path is used when it still holds a file, and the
 * registry's hash-based resolution finds the file after an unreconciled move.
 */
function locateRecordFile(root, record) {
  let source;
  try {
    source = readSourceRecord(root, record.source_id);
  } catch (error) {
    return { ok: false, issue: 'source_record_invalid', error: error.message };
  }
  if (!source) return { ok: false, issue: 'source_record_missing' };

  if (source.current_path) {
    try {
      const relative = toWorkspaceRelativePath(root, source.current_path, { requireExisting: true });
      const absolute = path.resolve(root, ...relative.split('/'));
      return { ok: true, path: relative, absolute, source, ...digestOf(absolute) };
    } catch (error) {
      if (error.code !== 'SOURCE_NOT_FOUND') return { ok: false, issue: 'unsafe_path', error: error.message, source };
    }
  }

  let resolved;
  try {
    resolved = resolveSource(root, record.source_id);
  } catch (error) {
    return { ok: false, issue: 'source_unresolved', error: error.message, source };
  }
  if (!resolved.ok || !resolved.path) {
    return { ok: false, issue: resolved.ok ? 'no_local_file' : 'source_unresolved', status: resolved.status, source };
  }
  const absolute = path.resolve(root, ...resolved.path.split('/'));
  return { ok: true, path: resolved.path, absolute, source, moved: true, ...digestOf(absolute) };
}

/** Explain why a record's file cannot be used, or return null when it can. */
function integrityIssue(record, located) {
  if (!located.ok) return located.issue;
  if (BOUND_STATES.has(record.state) && !sameContent(located, record)) return 'content_changed';
  return null;
}

function describeIssue(issue) {
  return {
    content_changed: 'the file changed after it was submitted for review',
    source_record_missing: 'its source record is missing',
    source_record_invalid: 'its source record is invalid',
    source_unresolved: 'its source file cannot be resolved',
    unsafe_path: 'its source path is unsafe or is not a regular file',
    no_local_file: 'its source has no local file'
  }[issue] || issue;
}

function historyEntry(record, fields) {
  return {
    revision: record.history.length + 1,
    action: fields.action,
    from_state: fields.fromState,
    to_state: fields.toState,
    actor: fields.actor,
    actor_type: fields.actorType,
    human_confirmed: fields.humanConfirmed === true,
    at: fields.at,
    reason: fields.reason,
    content_hash: { ...record.content_hash },
    byte_size: record.byte_size,
    source_ids: [...record.source_ids],
    related_record_ids: [...(fields.relatedRecordIds || [])]
  };
}

function appendHistory(record, fields) {
  record.history.push(historyEntry(record, fields));
  record.state = fields.toState;
  record.revision = record.history.length;
  record.updated_at = fields.at;
}

function findRecord(ledger, recordId) {
  return ledger.records.find((record) => record.record_id === recordId) || null;
}

function registerInLedger(root, ledger, input) {
  const existing = ledger.records.find((record) => record.source_id === input.sourceId);
  if (existing) {
    fail(`Source ${input.sourceId} already has lifecycle record ${existing.record_id}.`, 'RECORD_EXISTS', {
      source_id: input.sourceId,
      record_id: existing.record_id,
      state: existing.state
    });
  }
  const probe = { source_id: input.sourceId, state: input.state };
  const located = locateRecordFile(root, probe);
  if (!located.ok) {
    fail(`Cannot register ${input.sourceId}: ${describeIssue(located.issue)}.`, 'SOURCE_NOT_AVAILABLE', {
      source_id: input.sourceId,
      issue: located.issue
    });
  }
  assertSupportingSources(root, input.sourceIds, input.sourceId);

  const record = {
    record_id: createRecordId(),
    source_id: input.sourceId,
    state: input.state,
    revision: 0,
    path: located.path,
    content_hash: located.content_hash,
    byte_size: located.byte_size,
    source_ids: [...input.sourceIds],
    supersedes: [],
    superseded_by: null,
    decision: null,
    created_at: input.at,
    updated_at: input.at,
    history: []
  };
  appendHistory(record, {
    action: 'register',
    fromState: null,
    toState: input.state,
    actor: input.actor,
    actorType: input.actorType,
    humanConfirmed: false,
    at: input.at,
    reason: input.reason
  });
  ledger.records.push(record);
  return record;
}

function normalizeRegistration(options = {}) {
  const sourceId = options.sourceId ?? options.source_id;
  if (!isSourceId(sourceId)) fail(`Invalid source ID: ${sourceId}`, 'INVALID_SOURCE_ID', { source_id: sourceId ?? null });
  const state = options.state ?? 'draft';
  if (!LIFECYCLE_STATES.includes(state)) {
    fail(`Unknown lifecycle state: ${state}. Use one of ${LIFECYCLE_STATES.join(', ')}.`, 'INVALID_STATE', { state });
  }
  if (!INITIAL_LIFECYCLE_STATES.includes(state)) {
    fail(`A record cannot be registered as ${state}. Register it as ${INITIAL_LIFECYCLE_STATES.join(', ')} and move it through review.`, 'INVALID_INITIAL_STATE', { state });
  }
  const { actor, actorType } = normalizeActor(options);
  return {
    sourceId,
    state,
    actor,
    actorType,
    sourceIds: normalizeIdList(options.sourceIds ?? options.source_ids, isSourceId, 'INVALID_SOURCE_ID', 'supporting source'),
    reason: String(options.reason ?? '').trim() || `Registered as ${state}.`,
    at: toIsoTimestamp(options.now)
  };
}

/**
 * Open a lifecycle record for a registered source file.  Registration can
 * only create raw, evidence, draft, or unreviewed records.
 */
export function registerLifecycleRecord(instanceRoot, options = {}) {
  const input = normalizeRegistration(options);
  return withLedgerMutation(instanceRoot, options, (ledger, root) => {
    const record = registerInLedger(root, ledger, input);
    return {
      changed: true,
      at: input.at,
      result: { ok: true, record_id: record.record_id, source_id: record.source_id, state: record.state, record }
    };
  });
}

function normalizeTransition(recordId, options = {}) {
  assertRecordId(recordId);
  const action = options.action;
  const rule = LIFECYCLE_TRANSITIONS[action];
  if (!rule) fail(`Unknown lifecycle action: ${action}. Use one of ${LIFECYCLE_ACTIONS.join(', ')}.`, 'INVALID_ACTION', { action: action ?? null });
  const { actor, actorType } = normalizeActor(options);
  const reason = String(options.reason ?? '').trim();
  if (!reason) fail(`A reason is required to ${action} a record.`, 'REASON_REQUIRED');

  const sourceIds = normalizeIdList(options.sourceIds ?? options.source_ids, isSourceId, 'INVALID_SOURCE_ID', 'supporting source');
  const removeSourceIds = normalizeIdList(options.removeSourceIds ?? options.remove_source_ids, isSourceId, 'INVALID_SOURCE_ID', 'removed source');
  const supersedes = normalizeIdList(options.supersedes, isRecordId, 'INVALID_RECORD_ID', 'superseded record');
  const replacementId = options.replacementId ?? options.replacement_id ?? null;
  if (sourceIds.length && !SOURCE_ADD_ACTIONS.has(action)) fail(`Supporting sources cannot be added by ${action}.`, 'INVALID_OPTION');
  if (removeSourceIds.length && !SOURCE_EDIT_ACTIONS.has(action)) fail(`Supporting sources cannot be removed by ${action}.`, 'INVALID_OPTION');
  if (supersedes.length && action !== 'approve') fail('Only approve can name records that the new record supersedes.', 'INVALID_OPTION');
  if (action === 'supersede') {
    if (replacementId === null) fail('Supersede requires the accepted record that replaces this one.', 'INVALID_OPTION');
    assertRecordId(replacementId);
  } else if (replacementId !== null) {
    fail('Only supersede can name a replacement record.', 'INVALID_OPTION');
  }
  const expectedRevision = options.expectedRevision ?? options.expected_revision ?? null;
  if (expectedRevision !== null && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) {
    fail('Expected revision must be a positive integer.', 'INVALID_ARGUMENT');
  }

  return {
    recordId,
    action,
    rule,
    actor,
    actorType,
    humanConfirmed: (options.humanConfirmed ?? options.human_confirmed) === true,
    reason,
    sourceIds,
    removeSourceIds,
    supersedes,
    replacementId,
    expectedRevision,
    at: toIsoTimestamp(options.now)
  };
}

function assertAcceptedPeer(ledger, record, peerId, role) {
  if (peerId === record.record_id) fail('A record cannot supersede itself.', 'INVALID_SUPERSESSION', { record_id: peerId });
  const peer = findRecord(ledger, peerId);
  if (!peer) fail(`The ${role} record does not exist: ${peerId}`, 'INVALID_SUPERSESSION', { record_id: peerId });
  if (peer.state !== 'accepted') {
    fail(`The ${role} record ${peerId} is ${peer.state}; only an accepted record can be ${role === 'replacement' ? 'a replacement' : 'superseded'}.`, 'INVALID_SUPERSESSION', {
      record_id: peerId,
      state: peer.state
    });
  }
  return peer;
}

/**
 * Move one record through the transition table.  Approve, reject, and
 * supersede need a declared human actor with an explicit confirmation; an
 * agent or automation actor is refused and the record keeps its state.
 */
export function transitionLifecycleRecord(instanceRoot, recordId, options = {}) {
  const input = normalizeTransition(recordId, options);
  return withLedgerMutation(instanceRoot, options, (ledger, root) => {
    const record = findRecord(ledger, input.recordId);
    if (!record) fail(`Lifecycle record not found: ${input.recordId}`, 'RECORD_NOT_FOUND', { record_id: input.recordId });
    if (input.expectedRevision !== null && record.revision !== input.expectedRevision) {
      fail(`Record ${record.record_id} is at revision ${record.revision}, not ${input.expectedRevision}. Review the current record before retrying.`, 'REVISION_CONFLICT', {
        record_id: record.record_id,
        revision: record.revision,
        expected_revision: input.expectedRevision
      });
    }
    if (!input.rule.from.includes(record.state)) {
      fail(`Cannot ${input.action} a record that is ${record.state}. Allowed from: ${input.rule.from.join(', ')}.`, 'INVALID_TRANSITION', {
        record_id: record.record_id,
        action: input.action,
        state: record.state,
        allowed_from: [...input.rule.from]
      });
    }
    if (input.rule.human) {
      if (input.actorType !== 'human') {
        fail(`Only a human can ${input.action} a record. The record stays ${record.state}.`, 'HUMAN_REQUIRED', {
          record_id: record.record_id,
          actor_type: input.actorType,
          state: record.state
        });
      }
      if (!input.humanConfirmed) {
        fail(`A human must confirm the decision explicitly to ${input.action} a record. The record stays ${record.state}.`, 'HUMAN_CONFIRMATION_REQUIRED', {
          record_id: record.record_id,
          state: record.state
        });
      }
    }

    const sourceIds = record.source_ids.filter((sourceId) => !input.removeSourceIds.includes(sourceId));
    for (const sourceId of input.removeSourceIds) {
      if (!record.source_ids.includes(sourceId)) {
        fail(`Supporting source ${sourceId} is not linked to this record.`, 'INVALID_SUPPORTING_SOURCE', { source_id: sourceId });
      }
    }
    for (const sourceId of input.sourceIds) {
      if (!sourceIds.includes(sourceId)) sourceIds.push(sourceId);
    }
    assertSupportingSources(root, input.action === 'approve' ? sourceIds : input.sourceIds, record.source_id);

    const changed = [record];
    const relatedRecordIds = [];
    let located = null;
    let sourceCorrection = false;

    if (input.action === 'submit' || input.action === 'approve') {
      located = locateRecordFile(root, record);
      if (!located.ok) {
        fail(`Cannot ${input.action} ${record.record_id}: ${describeIssue(located.issue)}.`, 'SOURCE_NOT_AVAILABLE', {
          record_id: record.record_id,
          issue: located.issue
        });
      }
    }
    if (input.action === 'approve') {
      if (!sameContent(located, record)) {
        fail(`The file for ${record.record_id} changed after it was submitted. Revise and resubmit it so the review covers the current bytes. The record stays pending_review.`, 'CONTENT_CHANGED', {
          record_id: record.record_id,
          path: located.path,
          submitted_hash: record.content_hash,
          actual_hash: located.content_hash
        });
      }
      if (sourceIds.length === 0) {
        fail('Acceptance needs at least one registered supporting source ID.', 'SUPPORTING_SOURCE_REQUIRED', { record_id: record.record_id });
      }
      for (const supersededId of input.supersedes) {
        assertAcceptedPeer(ledger, record, supersededId, 'superseded');
        relatedRecordIds.push(supersededId);
      }
    }
    const replacement = input.action === 'supersede'
      ? assertAcceptedPeer(ledger, record, input.replacementId, 'replacement')
      : null;

    if (input.action === 'submit') {
      const registered = located.source.content_hash;
      if (!registered || registered.value !== located.content_hash.value || located.source.byte_size !== located.byte_size) {
        // Drafts are edited after registration.  Submission records the new
        // bytes as an explicit registry correction so the source still
        // resolves by hash after a later archive move.
        correctSource(root, record.source_id, {
          reason: `Lifecycle submission of ${record.record_id} by ${input.actor}: ${input.reason}`,
          now: input.at
        });
        sourceCorrection = true;
      }
      record.content_hash = located.content_hash;
      record.byte_size = located.byte_size;
      record.path = located.path;
    }

    record.source_ids = sourceIds;
    if (input.action === 'approve' || input.action === 'reject') {
      record.decision = {
        outcome: input.action === 'approve' ? 'accepted' : 'rejected',
        reviewer: input.actor,
        decided_at: input.at,
        reason: input.reason
      };
    } else if (input.action === 'revise') {
      record.decision = null;
    }
    if (replacement) {
      record.superseded_by = replacement.record_id;
      relatedRecordIds.push(replacement.record_id);
    }
    if (input.action === 'approve') record.supersedes = [...record.supersedes, ...input.supersedes];

    const actorFields = {
      actor: input.actor,
      actorType: input.actorType,
      humanConfirmed: input.humanConfirmed,
      at: input.at,
      reason: input.reason
    };
    appendHistory(record, {
      ...actorFields,
      action: input.action,
      fromState: record.state,
      toState: input.rule.to,
      relatedRecordIds
    });

    for (const supersededId of input.action === 'approve' ? input.supersedes : []) {
      const superseded = findRecord(ledger, supersededId);
      superseded.superseded_by = record.record_id;
      appendHistory(superseded, {
        ...actorFields,
        action: 'supersede',
        fromState: 'accepted',
        toState: 'superseded',
        relatedRecordIds: [record.record_id]
      });
      changed.push(superseded);
    }
    if (replacement) {
      replacement.supersedes = [...replacement.supersedes, record.record_id];
      appendHistory(replacement, {
        ...actorFields,
        action: 'replace',
        fromState: 'accepted',
        toState: 'accepted',
        relatedRecordIds: [record.record_id]
      });
      changed.push(replacement);
    }

    return {
      changed: true,
      at: input.at,
      result: {
        ok: true,
        action: input.action,
        record_id: record.record_id,
        state: record.state,
        record,
        changed_record_ids: changed.map((item) => item.record_id),
        source_correction: sourceCorrection
      }
    };
  });
}

export function readLifecycleRecord(instanceRoot, recordId) {
  assertRecordId(recordId);
  return findRecord(loadLedger(instanceRoot).ledger, recordId);
}

export function listLifecycleRecords(instanceRoot, options = {}) {
  const states = normalizeStates(options.states);
  const { ledger } = loadLedger(instanceRoot);
  return states.length ? ledger.records.filter((record) => states.includes(record.state)) : ledger.records;
}

function countStates(records) {
  const counts = Object.fromEntries(LIFECYCLE_STATES.map((state) => [state, 0]));
  for (const record of records) {
    if (Object.prototype.hasOwnProperty.call(counts, record.state)) counts[record.state] += 1;
  }
  return counts;
}

function finding(type, details = {}) {
  return { type, finding_type: type, ...details };
}

/**
 * Report ledger and record problems without changing anything.  The audit
 * never throws on bad ledger content, so it stays usable for recovery.
 */
export function auditLifecycle(instanceRoot) {
  const root = normalizeRoot(instanceRoot);
  const state = readLedgerState(root);
  const findings = [];
  const lock = readLockHolder(mutationLockPath(root));

  if (state.errors.length) {
    findings.push(finding('invalid_ledger', {
      path: state.paths.ledgerRelPath,
      errors: state.errors,
      action: 'Repair the ledger from a retained copy. Until then mutations and retrieval are refused.'
    }));
  }
  for (const copy of state.directory.conflictCopies) {
    findings.push(finding('ledger_conflict_copy', {
      path: copy,
      action: 'Preserve every copy, compare the histories, and keep one ledger before continuing.'
    }));
  }
  for (const temporary of state.directory.tempFiles) {
    findings.push(finding('stale_temp_file', {
      path: temporary,
      action: 'An interrupted write left this file. Remove it after confirming no mutation is running.'
    }));
  }
  for (const entry of state.directory.unexpected) {
    findings.push(finding('unexpected_entry', {
      path: entry,
      action: 'Move unrelated files out of the lifecycle folder.'
    }));
  }
  if (lock && !lock.alive) {
    findings.push(finding('stale_mutation_lock', {
      holder: lock.holder,
      action: 'Run "mole lifecycle unlock" to remove the lock left by a stopped process.'
    }));
  }

  const records = state.ledger ? state.ledger.records : [];
  for (const record of records) {
    const located = locateRecordFile(root, record);
    if (!located.ok) {
      findings.push(finding(located.issue, {
        record_id: record.record_id,
        source_id: record.source_id,
        state: record.state,
        path: record.path,
        ...(located.error ? { error: located.error } : {}),
        action: 'Recover or reconcile the source with "mole source resolve" before relying on this record.'
      }));
    } else if (BOUND_STATES.has(record.state) && !sameContent(located, record)) {
      findings.push(finding(record.state === 'accepted' ? 'accepted_content_changed' : 'pending_content_changed', {
        record_id: record.record_id,
        source_id: record.source_id,
        state: record.state,
        path: located.path,
        expected_hash: record.content_hash,
        actual_hash: located.content_hash,
        action: record.state === 'accepted'
          ? 'Restore the accepted bytes, or register the new version as a draft and supersede this record after review. It is excluded from normal retrieval until then.'
          : 'Revise and resubmit the record so the review covers the current bytes.'
      }));
    }
    if (record.state === 'accepted') {
      for (const sourceId of record.source_ids) {
        let source = null;
        try {
          source = readSourceRecord(root, sourceId);
        } catch {
          source = null;
        }
        if (!source) {
          findings.push(finding('supporting_source_missing', {
            record_id: record.record_id,
            source_id: sourceId,
            action: 'Recover the supporting source record; the acceptance cites it as evidence.'
          }));
        }
      }
    }
  }

  return {
    ok: findings.length === 0,
    read_only: true,
    ledger_path: state.paths.ledgerRelPath,
    ledger_exists: state.exists,
    ledger_revision: state.ledger ? state.ledger.ledger_revision : null,
    record_count: records.length,
    state_counts: countStates(records),
    mutation_lock: lock ? { holder: lock.holder, holder_alive: lock.alive } : null,
    findings
  };
}

function retrievalStates(options = {}) {
  const extra = normalizeStates(options.includeStates ?? options.include_states, 'includeStates');
  return [...new Set([...DEFAULT_RETRIEVAL_STATES, ...extra])];
}

function retrievalSummary(record, located) {
  return {
    record_id: record.record_id,
    source_id: record.source_id,
    state: record.state,
    revision: record.revision,
    path: located.path,
    content_hash: record.content_hash,
    byte_size: record.byte_size,
    source_ids: record.source_ids,
    supersedes: record.supersedes,
    superseded_by: record.superseded_by,
    decision: record.decision,
    updated_at: record.updated_at
  };
}

/**
 * List the records a workflow may read.  Only accepted records are returned
 * unless the caller names more states.  An accepted or pending record whose
 * file no longer matches its reviewed bytes is listed under `excluded`.
 */
export function retrieveLifecycleRecords(instanceRoot, options = {}) {
  const includeStates = retrievalStates(options);
  const { root, ledger } = loadLedger(instanceRoot);
  const records = [];
  const excluded = [];
  for (const record of ledger.records) {
    if (!includeStates.includes(record.state)) continue;
    const located = locateRecordFile(root, record);
    const issue = integrityIssue(record, located);
    if (issue) {
      excluded.push({ record_id: record.record_id, source_id: record.source_id, state: record.state, path: record.path, reason: issue });
    } else {
      records.push(retrievalSummary(record, located));
    }
  }
  return {
    ok: true,
    include_states: includeStates,
    records,
    excluded,
    state_counts: countStates(ledger.records)
  };
}

/**
 * Return one record with its file content.  A record outside the requested
 * states is refused even when it is asked for by ID.
 */
export function retrieveLifecycleRecord(instanceRoot, recordId, options = {}) {
  assertRecordId(recordId);
  const includeStates = retrievalStates(options);
  const { root, ledger } = loadLedger(instanceRoot);
  const record = findRecord(ledger, recordId);
  if (!record) fail(`Lifecycle record not found: ${recordId}`, 'RECORD_NOT_FOUND', { record_id: recordId });
  if (!includeStates.includes(record.state)) {
    fail(`Record ${recordId} is ${record.state} and is excluded from normal retrieval. Include that state explicitly to read it.`, 'NOT_ELIGIBLE', {
      record_id: recordId,
      state: record.state,
      include_states: includeStates
    });
  }
  const located = locateRecordFile(root, record);
  if (!located.ok) {
    fail(`Record ${recordId} cannot be retrieved: ${describeIssue(located.issue)}.`, 'SOURCE_NOT_AVAILABLE', {
      record_id: recordId,
      issue: located.issue
    });
  }
  // Hash the bytes that are returned, not an earlier read of the same path.
  const bytes = fs.readFileSync(located.absolute);
  const actual = {
    content_hash: { algorithm: 'sha256', value: createHash('sha256').update(bytes).digest('hex') },
    byte_size: bytes.length
  };
  if (BOUND_STATES.has(record.state) && !sameContent(actual, record)) {
    fail(`Record ${recordId} cannot be retrieved: ${describeIssue('content_changed')}.`, 'CONTENT_CHANGED', {
      record_id: recordId,
      state: record.state,
      path: located.path,
      expected_hash: record.content_hash,
      actual_hash: actual.content_hash
    });
  }
  const binary = bytes.includes(0);
  return {
    ok: true,
    record,
    path: located.path,
    absolute_path: located.absolute,
    content: binary ? null : bytes.toString('utf8'),
    content_encoding: binary ? 'binary' : 'utf8'
  };
}

function walkMigrationFiles(root, roots) {
  const files = [];
  const skipped = [];
  const queue = [];
  for (const value of roots) {
    const relative = toWorkspaceRelativePath(root, value);
    queue.push(relative);
  }
  while (queue.length) {
    const currentRelative = queue.shift();
    const current = path.resolve(root, ...currentRelative.split('/'));
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = `${currentRelative}/${entry.name}`;
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) skipped.push({ path: relative, reason: 'symlink' });
      else if (entry.isDirectory()) queue.push(relative);
      else if (!entry.isFile()) continue;
      else if (entry.name.toLowerCase() === 'readme.md') skipped.push({ path: relative, reason: 'guidance_file' });
      else if (looksLikeSyncConflictName(entry.name)) skipped.push({ path: relative, reason: 'sync_conflict_copy' });
      else files.push(relative);
    }
  }
  return { files: files.sort((left, right) => left.localeCompare(right)), skipped };
}

function indexSourcesByPath(root) {
  const byPath = new Map();
  const recordsDir = getSourceRegistryPaths(root).recordsDir;
  let entries;
  try {
    entries = fs.readdirSync(recordsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return byPath;
    throw error;
  }
  for (const entry of entries) {
    const sourceId = entry.name.replace(/\.json$/, '');
    if (!entry.isFile() || !entry.name.endsWith('.json') || !SOURCE_ID_PATTERN.test(sourceId)) continue;
    let source;
    try {
      source = readSourceRecord(root, sourceId);
    } catch {
      continue;
    }
    if (!source?.current_path) continue;
    const ids = byPath.get(source.current_path) || [];
    ids.push(source.source_id);
    byPath.set(source.current_path, ids);
  }
  return byPath;
}

function readLegacyFrontmatter(absolute) {
  const legacy = { status: null, source_id: null };
  let prefix;
  try {
    const fd = fs.openSync(absolute, 'r');
    try {
      const buffer = Buffer.alloc(16 * 1024);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      prefix = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return legacy;
  }
  if (!/^---\r?\n/.test(prefix)) return legacy;
  const end = prefix.indexOf('\n---', 3);
  const frontmatter = end < 0 ? prefix : prefix.slice(0, end);
  legacy.status = frontmatter.match(/^status:\s*["']?([A-Za-z_-]+)["']?\s*(?:#.*)?$/m)?.[1] ?? null;
  legacy.source_id = frontmatter.match(/^source_id:\s*["']?(src_[0-9a-f-]+)["']?\s*(?:#.*)?$/m)?.[1] ?? null;
  return legacy;
}

/**
 * Find workspace files that have no lifecycle record.  The default mode only
 * reports.  Apply mode registers each file as `unreviewed`; a legacy
 * `status: active` field or approving prose never becomes an acceptance.
 */
export function migrateLifecycleRecords(instanceRoot, options = {}) {
  const apply = options.apply === true;
  const roots = options.roots ?? DEFAULT_MIGRATION_ROOTS;
  if (!Array.isArray(roots)) fail('roots must be an array.', 'INVALID_ARGUMENT');
  const identity = apply ? normalizeActor(options) : null;
  const at = toIsoTimestamp(options.now);

  const plan = (root, ledger) => {
    const { files, skipped } = walkMigrationFiles(root, roots);
    const sourcesByPath = indexSourcesByPath(root);
    const tracked = new Set(ledger.records.map((record) => record.source_id));
    const candidates = [];
    const findings = [];
    let trackedCount = 0;
    for (const relative of files) {
      const sourceIds = sourcesByPath.get(relative) || [];
      if (sourceIds.length > 1) {
        skipped.push({ path: relative, reason: 'ambiguous_source' });
        findings.push(finding('ambiguous_source', {
          path: relative,
          source_ids: sourceIds,
          action: 'Resolve the competing source records before registering a lifecycle record.'
        }));
        continue;
      }
      if (sourceIds.length === 1 && tracked.has(sourceIds[0])) {
        trackedCount += 1;
        continue;
      }
      const legacy = readLegacyFrontmatter(path.resolve(root, ...relative.split('/')));
      if (legacy.source_id && legacy.source_id !== sourceIds[0]) {
        // The file names a source the registry does not place here.  A new
        // source ID would give one file two identities, so leave it alone.
        skipped.push({ path: relative, reason: 'source_id_mismatch' });
        findings.push(finding('source_id_mismatch', {
          path: relative,
          source_id: legacy.source_id,
          action: 'Register, recover, or reconcile that source with the "mole source" commands, then run the migration again.'
        }));
        continue;
      }
      candidates.push({
        path: relative,
        source_id: sourceIds[0] ?? null,
        legacy_status: legacy.status,
        proposed_state: 'unreviewed'
      });
    }
    return { scanned: files.length, tracked: trackedCount, candidates, skipped, findings };
  };

  if (!apply) {
    const { root, ledger } = loadLedger(instanceRoot);
    const result = plan(root, ledger);
    return { ok: result.findings.length === 0, apply: false, ...result, registered: [] };
  }

  return withLedgerMutation(instanceRoot, options, (ledger, root) => {
    const result = plan(root, ledger);
    const registered = [];
    for (const candidate of result.candidates) {
      try {
        const sourceId = candidate.source_id ?? registerSource(root, {
          path: candidate.path,
          source_type: 'file',
          captured_at: at,
          captured_by: identity.actor,
          channel: 'lifecycle-migration',
          path_reason: 'registered',
          content_change_type: 'registered'
        }).source_id;
        const record = registerInLedger(root, ledger, {
          sourceId,
          state: 'unreviewed',
          actor: identity.actor,
          actorType: identity.actorType,
          sourceIds: [],
          reason: candidate.legacy_status
            ? `Legacy file registered without review; frontmatter status "${candidate.legacy_status}" is not an approval.`
            : 'Legacy file registered without review.',
          at
        });
        registered.push({ path: candidate.path, source_id: sourceId, record_id: record.record_id, state: record.state });
      } catch (error) {
        result.skipped.push({ path: candidate.path, reason: 'registration_failed' });
        result.findings.push(finding('registration_failed', {
          path: candidate.path,
          error: error.message,
          action: 'Fix the reported problem and run the migration again.'
        }));
      }
    }
    return {
      changed: registered.length > 0,
      at,
      result: { ok: result.findings.length === 0, apply: true, ...result, registered }
    };
  });
}
