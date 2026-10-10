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
  toWorkspaceRelativePath,
  writeSourceRecord
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
export const LIFECYCLE_LOCK_REL_PATH = path.join(LIFECYCLE_ROOT_REL_PATH, '.mutation.lock');
export const RECORD_ID_PATTERN = /^rec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const LIFECYCLE_STATES = Object.freeze([
  'raw',
  'evidence',
  'draft',
  'pending_review',
  'accepted',
  'rejected',
  'superseded',
  'unreviewed',
  'withdrawn'
]);
export const INITIAL_LIFECYCLE_STATES = Object.freeze(['raw', 'evidence', 'draft', 'unreviewed']);
export const ACTOR_TYPES = Object.freeze(['human', 'agent', 'automation']);
export const DEFAULT_RETRIEVAL_STATES = Object.freeze(['accepted']);

/**
 * Every state change a caller can request.  `human: true` means the action
 * always needs a declared human actor and an explicit confirmation.
 * `humanFrom` lists the starting states that need one.
 */
export const LIFECYCLE_TRANSITIONS = Object.freeze({
  evidence: Object.freeze({ from: Object.freeze(['raw', 'unreviewed']), to: 'evidence', human: false }),
  draft: Object.freeze({ from: Object.freeze(['raw', 'evidence', 'unreviewed']), to: 'draft', human: false }),
  submit: Object.freeze({ from: Object.freeze(['draft', 'unreviewed']), to: 'pending_review', human: false }),
  // Revising an accepted record is for a file that was edited in place.  It
  // needs a human only while the file still holds the accepted bytes; see
  // transitionLifecycleRecord.
  revise: Object.freeze({ from: Object.freeze(['pending_review', 'rejected', 'accepted']), to: 'draft', human: false }),
  approve: Object.freeze({ from: Object.freeze(['pending_review']), to: 'accepted', human: true }),
  reject: Object.freeze({ from: Object.freeze(['pending_review']), to: 'rejected', human: true }),
  supersede: Object.freeze({ from: Object.freeze(['accepted']), to: 'superseded', human: true }),
  withdraw: Object.freeze({
    from: Object.freeze(['raw', 'evidence', 'draft', 'pending_review', 'rejected', 'unreviewed', 'accepted']),
    to: 'withdrawn',
    human: false,
    humanFrom: Object.freeze(['accepted'])
  })
});
export const LIFECYCLE_ACTIONS = Object.freeze(Object.keys(LIFECYCLE_TRANSITIONS));

/**
 * States whose file may be re-pointed after it was moved and edited.  A
 * record in any other open state can be relocated only to a file that still
 * holds its bytes.
 */
export const RELOCATABLE_STATES = Object.freeze(['draft', 'unreviewed', 'rejected']);

/** Whether an action from a given state needs a confirmed human actor. */
export function transitionRequiresHuman(action, fromState, options = {}) {
  if (action === 'replace') return true;
  const rule = LIFECYCLE_TRANSITIONS[action];
  if (!rule) return false;
  // A record that a person once accepted stays theirs to close, even after
  // an edited file sent it back to draft.
  if (action === 'withdraw' && options.everApproved) return true;
  return rule.human || (rule.humanFrom || []).includes(fromState);
}

// History-only actions.  `register` opens a record, `replace` is appended to an
// accepted record when it becomes the replacement for another record, and
// `relocate` records a new path without changing the state.
const HISTORY_ACTIONS = new Set(['register', 'replace', 'relocate', ...LIFECYCLE_ACTIONS]);
const BOUND_STATES = new Set(['pending_review', 'accepted']);
// Retrieval also checks a superseded record, so a different file that now
// sits at its old path is never returned as the superseded version.
const RETRIEVAL_BOUND_STATES = new Set([...BOUND_STATES, 'superseded']);
// A record in one of these states is history.  Its file may be archived or
// deleted without that being a problem to report.
const CLOSED_STATES = new Set(['superseded', 'withdrawn']);
const UNSUPPORTIVE_STATES = new Set(['rejected', 'withdrawn']);
// A capture that was withdrawn while still raw or evidence was real evidence
// whose file was cleaned up, so it keeps counting as support.
const CAPTURE_STATES = new Set(['raw', 'evidence']);
const SOURCE_EDIT_ACTIONS = new Set(['evidence', 'draft', 'submit', 'revise']);
const SOURCE_ADD_ACTIONS = new Set([...SOURCE_EDIT_ACTIONS, 'approve']);
const RAW_MIGRATION_ROOT = '6-raw';
const DEFAULT_MIGRATION_ROOTS = ['2-summaries', '3-indexes', '4-context', '5-evidence', RAW_MIGRATION_ROOT];
const CONTENT_SEARCH_ROOTS = ['2-summaries', '3-indexes', '4-context', '5-evidence', '6-raw', 'docs'];
const CONTENT_SEARCH_EXCLUDES = ['governance/sources', 'governance/lifecycle', 'node_modules'];
const UNVERIFIED_LOCK_STALE_MS = 5 * 60 * 1000;
const DEFAULT_LOCK_WAIT_MS = 10000;
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

function absoluteOf(root, relative) {
  return path.resolve(root, ...relative.split('/'));
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
    lockPath: path.join(root, LIFECYCLE_LOCK_REL_PATH),
    lockRelPath: toPortablePath(LIFECYCLE_LOCK_REL_PATH),
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
  let everApproved = false;
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
    } else if (entry.action === 'relocate') {
      if (entry.from_state !== entry.to_state || CLOSED_STATES.has(entry.to_state)) {
        errors.push(`${entryLabel} relocate must keep an open record in its state`);
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
    if (transitionRequiresHuman(entry.action, entry.from_state, { everApproved })
      && (entry.actor_type !== 'human' || entry.human_confirmed !== true)) {
      errors.push(`${entryLabel} records ${entry.action} without a confirmed human actor`);
    }
    if (entry.action === 'approve') everApproved = true;
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
      && !(Array.isArray(record.history) && record.history.some((entry) => asObject(entry) && entry.action === 'approve'))) {
      errors.push(`${label}.supersedes requires a record that was accepted`);
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

/** Explain why the lifecycle folder cannot be used, or return null. */
function unsafeLifecyclePath(root, paths) {
  try {
    toWorkspaceRelativePath(root, paths.ledgerPath);
    return null;
  } catch (error) {
    return `Lifecycle ledger path is unsafe: ${error.message}`;
  }
}

/**
 * Read the ledger without throwing on bad content.  Callers decide whether a
 * problem is a refusal (mutations, retrieval) or a finding (audit).
 */
function readLedgerState(root) {
  const paths = getLifecyclePaths(root);
  const state = { paths, exists: false, raw: null, ledger: null, errors: [], directory: null };
  const unsafe = unsafeLifecyclePath(root, paths);
  if (unsafe) {
    state.errors.push(unsafe);
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

/**
 * Describe the current lock holder.  A holder on this host is checked by
 * process identity.  A lock written on another host, which a sync tool or a
 * network drive can deliver, cannot be checked, so it counts as live until it
 * is older than any real mutation could be.
 */
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
  const youngEnough = ageMs === null ? true : ageMs < UNVERIFIED_LOCK_STALE_MS;
  const foreign = Boolean(holder && typeof holder.host === 'string' && holder.host && holder.host !== os.hostname());

  let alive;
  if (!holder || foreign || !Number.isInteger(holder.pid) || holder.pid <= 0) {
    alive = youngEnough;
  } else if (!isProcessAlive(holder.pid)) {
    alive = false;
  } else {
    const identity = getInboxMutationProcessIdentity(holder.pid);
    if (holder.process_identity && identity) alive = holder.process_identity === identity;
    else alive = youngEnough;
  }
  return { holder, alive, foreign, lock_path: lockPath };
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function lockWaitMs(options = {}) {
  const value = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  if (!Number.isFinite(value) || value < 0) fail('lockWaitMs must be a non-negative number.', 'INVALID_ARGUMENT');
  return value;
}

function unlinkIfPresent(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function staleLockMessage() {
  return 'A lifecycle mutation lock was left behind by a process that is no longer running. Run "mole lifecycle audit", then "mole lifecycle unlock" to remove it. The ledger was not changed.';
}

/**
 * Take the mutation lock.  The lock file lives beside the ledger so every
 * process that can write the ledger sees the same lock, whatever its
 * temporary folder is.  A running holder is waited for briefly so
 * near-simultaneous captures do not fail.  A lock left by a stopped process
 * is never removed here.
 */
function acquireMutationLock(root, waitMs) {
  const paths = getLifecyclePaths(root);
  const unsafe = unsafeLifecyclePath(root, paths);
  if (unsafe) fail(`Lifecycle ledger is invalid; nothing was changed: ${unsafe}`, 'INVALID_LEDGER', { path: paths.ledgerRelPath, errors: [unsafe] });
  fs.mkdirSync(paths.lifecycleRoot, { recursive: true });

  const lockPath = paths.lockPath;
  const token = randomUUID();
  const payload = `${JSON.stringify({
    token,
    pid: process.pid,
    process_identity: getInboxMutationProcessIdentity(process.pid),
    host: os.hostname(),
    acquired_at: new Date().toISOString()
  }, null, 2)}\n`;
  // Publish a complete file with one exclusive link, so no reader can see a
  // half-written lock.  Filesystems without hard links use an exclusive write.
  const staged = `${lockPath}.${token}.tmp`;
  fs.writeFileSync(staged, payload, { encoding: 'utf8', flag: 'wx' });
  let canLink = true;
  let misses = 0;
  const deadline = Date.now() + waitMs;
  try {
    for (;;) {
      try {
        if (canLink) fs.linkSync(staged, lockPath);
        else fs.writeFileSync(lockPath, payload, { encoding: 'utf8', flag: 'wx' });
        return { lockPath, token };
      } catch (error) {
        if (error.code !== 'EEXIST') {
          if (!canLink) throw error;
          canLink = false;
          continue;
        }
      }
      const current = readLockHolder(lockPath);
      if (!current) {
        // The lock vanished between the two calls, so try again at once.  A
        // path that keeps existing without being readable, such as a broken
        // link, must not spin for ever.
        misses += 1;
        if (misses <= 3) continue;
        if (Date.now() < deadline) {
          sleepSync(LOCK_RETRY_MS);
          continue;
        }
        fail(`The lifecycle lock path ${paths.lockRelPath} exists but is not a readable lock file. Inspect and remove it. The ledger was not changed.`, 'LIFECYCLE_BUSY', {
          holder: null,
          holder_alive: null
        });
      }
      if (current.alive && Date.now() < deadline) {
        sleepSync(LOCK_RETRY_MS);
        continue;
      }
      fail(current.alive
        ? 'Another lifecycle mutation is in progress for this workspace. The ledger was not changed; retry after it finishes.'
        : staleLockMessage(),
      'LIFECYCLE_BUSY', {
        holder: current.holder,
        holder_alive: current.alive
      });
    }
  } finally {
    unlinkIfPresent(staged);
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
  unlinkIfPresent(lock.lockPath);
}

/**
 * Remove a mutation lock left by a stopped process.  Recovery is explicit: a
 * mutation never removes another process's lock by itself.
 */
export function unlockLifecycle(instanceRoot) {
  const root = normalizeRoot(instanceRoot);
  const lockPath = getLifecyclePaths(root).lockPath;
  const current = readLockHolder(lockPath);
  if (!current) return { ok: true, removed: false, holder: null };
  if (current.alive) {
    fail(current.foreign
      ? 'The lifecycle mutation lock was written on another machine less than five minutes ago and may still be in use. Nothing was changed.'
      : 'The lifecycle mutation lock belongs to a process that still appears to be running. Nothing was changed.', 'LOCK_HELD', {
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

/**
 * Throw when a lifecycle write could not succeed right now.  Callers that
 * create files before registering them use this to refuse early instead of
 * leaving an untracked file behind.
 */
export function assertLifecycleWritable(instanceRoot) {
  const { root, paths } = loadLedger(instanceRoot);
  const lock = readLockHolder(paths.lockPath);
  if (lock && !lock.alive) fail(staleLockMessage(), 'LIFECYCLE_BUSY', { holder: lock.holder, holder_alive: false });
  return { ok: true, workspace_root: root };
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
    unlinkIfPresent(temporary);
  }
}

function isDeepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Refuse a ledger that drops a record or changes an earlier history entry of
 * the previous ledger.  Every write goes through this check.
 */
export function assertAppendOnly(previous, next) {
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
 * Run one ledger mutation under the lock.  The operation edits a copy; the
 * copy is validated, checked against the previous history, and written in one
 * atomic rename only if the file on disk is still the one that was read.
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

function normalizeExpectedRevision(options) {
  const expectedRevision = options.expectedRevision ?? options.expected_revision ?? null;
  if (expectedRevision !== null && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) {
    fail('Expected revision must be a positive integer.', 'INVALID_ARGUMENT');
  }
  return expectedRevision;
}

function assertExpectedRevision(record, expectedRevision) {
  if (expectedRevision !== null && record.revision !== expectedRevision) {
    fail(`Record ${record.record_id} is at revision ${record.revision}, not ${expectedRevision}. Review the current record before retrying.`, 'REVISION_CONFLICT', {
      record_id: record.record_id,
      revision: record.revision,
      expected_revision: expectedRevision
    });
  }
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

function digestOf(absolute) {
  const digest = hashFileSync(absolute);
  return { content_hash: { algorithm: 'sha256', value: digest.value }, byte_size: digest.byte_size };
}

function sameContent(left, right) {
  return left.content_hash.value === right.content_hash.value && left.byte_size === right.byte_size;
}

function walkRegularFiles(root, roots, excludes = []) {
  const files = [];
  const symlinks = [];
  const queue = [];
  for (const value of roots) queue.push(toWorkspaceRelativePath(root, value));
  const seen = new Set();
  while (queue.length) {
    const currentRelative = queue.shift();
    if (seen.has(currentRelative)) continue;
    seen.add(currentRelative);
    let entries;
    try {
      entries = fs.readdirSync(absoluteOf(root, currentRelative), { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = `${currentRelative}/${entry.name}`;
      if (entry.name.startsWith('.')) continue;
      if (excludes.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))) continue;
      if (entry.isSymbolicLink()) symlinks.push(relative);
      else if (entry.isDirectory()) queue.push(relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  return { files: files.sort((left, right) => left.localeCompare(right)), symlinks };
}

/**
 * Per-operation view of the source registry and the workspace files.
 *
 * The source registry owns paths.  A record's file is the one at its source's
 * registered path.  When that path holds no file, the file is found by its
 * registered hash, which covers an archive move that nobody reconciled.  The
 * registry is read once and files are hashed at most once per operation, so an
 * audit of many moved records stays linear.
 *
 * A path belongs to one live source.  The source of a superseded or withdrawn
 * record is history: it does not hold its path against a new file.
 */
function createLocator(root, ledger = null) {
  const sources = new Map();
  const knownIds = new Set();
  const recordBySource = new Map((ledger?.records || []).map((record) => [record.source_id, record]));
  const isClosed = (sourceId) => CLOSED_STATES.has(recordBySource.get(sourceId)?.state);
  const isLive = (sourceId) => recordBySource.has(sourceId) && !isClosed(sourceId);
  let claims = null;
  let sizes = null;
  const digests = new Map();

  function source(sourceId) {
    if (!sources.has(sourceId)) {
      let entry;
      try {
        const record = readSourceRecord(root, sourceId);
        entry = record ? { record } : { issue: 'source_record_missing' };
      } catch (error) {
        entry = { issue: 'source_record_invalid', error: error.message };
      }
      sources.set(sourceId, entry);
    }
    return sources.get(sourceId);
  }

  function claim(sourceId, currentPath) {
    knownIds.add(sourceId);
    if (typeof currentPath !== 'string' || !currentPath) return;
    const ids = claims.get(currentPath) || [];
    if (!ids.includes(sourceId)) ids.push(sourceId);
    claims.set(currentPath, ids);
  }

  /**
   * Which source claims which path, for every record file in the registry.
   * Registration and submission run this on every call, so it only parses
   * each file for its path.  A record is validated in full when it is used.
   */
  function loadClaims() {
    if (claims) return claims;
    claims = new Map();
    const recordsDir = getSourceRegistryPaths(root).recordsDir;
    let entries = [];
    try {
      entries = fs.readdirSync(recordsDir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const entry of entries) {
      const sourceId = entry.name.replace(/\.json$/, '');
      if (!entry.isFile() || !entry.name.endsWith('.json') || !SOURCE_ID_PATTERN.test(sourceId)) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(recordsDir, entry.name), 'utf8'));
      } catch {
        // An unreadable record claims nothing here; using it reports it.
      }
      claim(sourceId, asObject(parsed) ? parsed.current_path : null);
    }
    return claims;
  }

  function registeredAt(relativePath, exceptSourceId = null) {
    return (loadClaims().get(relativePath) || []).filter((sourceId) => sourceId !== exceptSourceId);
  }

  /**
   * Other sources that own this path for review purposes: the ones with a
   * live lifecycle record.  A source that was registered a second time by
   * mistake and has no record owns nothing, so it cannot block the record
   * that does.
   */
  function claimants(relativePath, exceptSourceId = null) {
    return registeredAt(relativePath, exceptSourceId).filter(isLive);
  }

  /** Sources of closed records that are still registered at this path. */
  function closedClaimants(relativePath, exceptSourceId = null) {
    return registeredAt(relativePath, exceptSourceId).filter(isClosed);
  }

  /** Sources registered at this path that have no lifecycle record. */
  function unrecordedClaimants(relativePath, exceptSourceId = null) {
    return registeredAt(relativePath, exceptSourceId).filter((sourceId) => !recordBySource.has(sourceId));
  }

  /** The lifecycle record of a source, as the ledger stood when this operation began or since `track`. */
  function recordFor(sourceId) {
    return recordBySource.get(sourceId) || null;
  }

  /** Tell the locator about a lifecycle record opened during this operation. */
  function track(record) {
    recordBySource.set(record.source_id, record);
  }

  /**
   * Clear the registered path of closed records' sources at a path that a
   * live source is taking over, so the registry never shows two sources at
   * one path.  The closed record keeps its history and its last known path.
   */
  function releaseClosedClaims(relativePath, exceptSourceId, at) {
    for (const sourceId of closedClaimants(relativePath, exceptSourceId)) {
      const entry = source(sourceId);
      if (entry.record) {
        const released = {
          ...entry.record,
          record_revision: entry.record.record_revision + 1,
          current_path: null,
          path_history: entry.record.path_history.map((item) => (item.valid_to === null ? { ...item, valid_to: at } : { ...item })),
          updated_at: at
        };
        writeSourceRecord(root, released);
        sources.set(sourceId, { record: released });
      }
      claims.set(relativePath, (claims.get(relativePath) || []).filter((id) => id !== sourceId));
    }
  }

  /** Every valid source record.  Used by migration, which is rare. */
  function allSources() {
    loadClaims();
    return [...knownIds].map((sourceId) => source(sourceId).record).filter(Boolean);
  }

  /** Tell the locator about a source record written during this operation. */
  function remember(record) {
    sources.set(record.source_id, { record });
    if (claims) claim(record.source_id, record.current_path);
  }

  function digest(relativePath) {
    if (!digests.has(relativePath)) digests.set(relativePath, digestOf(absoluteOf(root, relativePath)));
    return digests.get(relativePath);
  }

  function loadSizes() {
    if (sizes) return sizes;
    sizes = new Map();
    const roots = new Set(CONTENT_SEARCH_ROOTS);
    for (const claimed of loadClaims().keys()) {
      const parts = claimed.split('/');
      if (parts.length > 1 && !parts[0].startsWith('.')) roots.add(parts[0]);
    }
    for (const relative of walkRegularFiles(root, [...roots], CONTENT_SEARCH_EXCLUDES).files) {
      let size;
      try {
        size = fs.statSync(absoluteOf(root, relative)).size;
      } catch {
        continue;
      }
      const paths = sizes.get(size) || [];
      paths.push(relative);
      sizes.set(size, paths);
    }
    return sizes;
  }

  /** Workspace files holding exactly these bytes.  Only same-size files are hashed. */
  function findByContent(content) {
    const matches = [];
    for (const relative of loadSizes().get(content.byte_size) || []) {
      try {
        if (sameContent(digest(relative), content)) matches.push(relative);
      } catch {
        // A file that vanished or cannot be read is not a candidate.
      }
    }
    return matches;
  }

  function fileExists(relativePath) {
    try {
      return fs.statSync(absoluteOf(root, relativePath)).isFile();
    } catch {
      return false;
    }
  }

  function locate(record) {
    const entry = source(record.source_id);
    if (!entry.record) return { ok: false, issue: entry.issue, ...(entry.error ? { error: entry.error } : {}) };
    const registered = entry.record;

    if (registered.current_path) {
      try {
        const relative = toWorkspaceRelativePath(root, registered.current_path, { requireExisting: true });
        return { ok: true, path: relative, absolute: absoluteOf(root, relative), source: registered, ...digest(relative) };
      } catch (error) {
        if (error.code !== 'SOURCE_NOT_FOUND') return { ok: false, issue: 'unsafe_path', error: error.message, source: registered };
      }
    }
    if (!registered.content_hash) return { ok: false, issue: 'no_local_file', source: registered };

    // The registered path holds no file.  Accept one unclaimed file with the
    // registered bytes; anything else needs a person to say which file it is.
    const candidates = findByContent(registered)
      .filter((relative) => relative !== registered.current_path && claimants(relative, registered.source_id).length === 0);
    if (candidates.length !== 1) {
      return { ok: false, issue: 'source_unresolved', candidates, source: registered };
    }
    try {
      const relative = toWorkspaceRelativePath(root, candidates[0], { requireExisting: true });
      return { ok: true, path: relative, absolute: absoluteOf(root, relative), source: registered, moved: true, ...digest(relative) };
    } catch (error) {
      return { ok: false, issue: 'unsafe_path', error: error.message, source: registered };
    }
  }

  return {
    source,
    claimants,
    closedClaimants,
    unrecordedClaimants,
    releaseClosedClaims,
    recordFor,
    track,
    allSources,
    remember,
    digest,
    fileExists,
    locate
  };
}

/** Explain why a record's file cannot be used, or return null when it can. */
function integrityIssue(record, located) {
  if (!located.ok) return located.issue;
  if (RETRIEVAL_BOUND_STATES.has(record.state) && !sameContent(located, record)) return 'content_changed';
  return null;
}

function describeIssue(issue) {
  return {
    content_changed: 'the file changed after it was submitted for review',
    source_record_missing: 'its source record is missing',
    source_record_invalid: 'its source record is invalid',
    source_unresolved: 'its source file was moved and changed, or deleted',
    unsafe_path: 'its source path is unsafe or is not a regular file',
    no_local_file: 'its source has no local file'
  }[issue] || issue;
}

/** What someone can do about a record whose file is missing or untrusted. */
function recoveryAdvice(record) {
  const id = record.record_id;
  if (CLOSED_STATES.has(record.state)) {
    return 'This record is closed and nothing more can be done to it. Register the file as a new source if it should be tracked.';
  }
  if (RELOCATABLE_STATES.includes(record.state)) {
    return `If the file was renamed, run "mole lifecycle relocate ${id} --path <new path>". If it is gone, run "mole lifecycle withdraw ${id}".`;
  }
  if (record.state === 'pending_review') {
    return `If the file was renamed and edited, run "mole lifecycle revise ${id}", then "mole lifecycle relocate ${id} --path <new path>". If it is gone, run "mole lifecycle withdraw ${id}".`;
  }
  if (record.state === 'accepted') {
    return `Restore the accepted file at ${record.path}, or run "mole lifecycle relocate ${id} --path <new path>" if an unchanged copy lives elsewhere. If it is gone, or was renamed and edited on purpose, have a person run "mole lifecycle withdraw ${id}" and register any new version as a draft.`;
  }
  return `If an unchanged copy lives elsewhere, run "mole lifecycle relocate ${id} --path <new path>". If the file is gone or was changed, run "mole lifecycle withdraw ${id}".`;
}

function assertPathUnclaimed(locator, relativePath, sourceId) {
  const others = locator.claimants(relativePath, sourceId);
  if (others.length) {
    const owner = locator.recordFor(others[0]);
    fail(`Path ${relativePath} already belongs to ${owner.state} lifecycle record ${owner.record_id}. One file backs one record, so use that record. If its file now lives somewhere else, run "mole lifecycle relocate ${owner.record_id} --path <new path>". If its file is gone, run "mole lifecycle withdraw ${owner.record_id}".`, 'PATH_CLAIM_CONFLICT', {
      path: relativePath,
      source_id: sourceId,
      conflicting_source_ids: others,
      conflicting_record_ids: others.map((id) => locator.recordFor(id).record_id)
    });
  }
}

/** Whether the source of a record can no longer back an acceptance. */
function isUnsupportive(record) {
  if (!UNSUPPORTIVE_STATES.has(record.state)) return false;
  if (record.state !== 'withdrawn') return true;
  const closing = record.history[record.history.length - 1];
  return !CAPTURE_STATES.has(closing.from_state);
}

function assertSupportingSources(locator, ledger, sourceIds, ownSourceId, options = {}) {
  const unsupportive = [];
  for (const sourceId of sourceIds) {
    if (sourceId === ownSourceId) {
      fail('A record cannot cite its own source as supporting evidence.', 'INVALID_SUPPORTING_SOURCE', { source_id: sourceId });
    }
    const entry = locator.source(sourceId);
    if (entry.issue === 'source_record_invalid') {
      fail(`Supporting source record is invalid: ${sourceId}`, 'INVALID_SUPPORTING_SOURCE', { source_id: sourceId, error: entry.error });
    }
    if (!entry.record) {
      fail(`Supporting source is not registered: ${sourceId}`, 'SUPPORTING_SOURCE_NOT_REGISTERED', { source_id: sourceId });
    }
    if (options.forApproval) {
      const cited = ledger.records.find((record) => record.source_id === sourceId);
      if (cited && isUnsupportive(cited)) {
        unsupportive.push({ source_id: sourceId, record_id: cited.record_id, state: cited.state });
      }
    }
  }
  if (unsupportive.length) {
    const named = unsupportive.map((entry) => `${entry.source_id} (${entry.state} record ${entry.record_id})`).join(', ');
    const linked = unsupportive.filter((entry) => options.linkedSourceIds.includes(entry.source_id));
    const offered = unsupportive.length - linked.length;
    const steps = [];
    if (linked.length) {
      const flags = linked.map((entry) => `--remove-source ${entry.source_id}`).join(' ');
      steps.push(`Run "mole lifecycle revise ${options.recordId} ${flags}", then "mole lifecycle submit ${options.recordId}", and approve with a source that still counts.`);
    }
    if (offered) steps.push(`${linked.length ? 'Also leave' : 'Leave'} the ${offered === 1 ? 'source' : 'sources'} passed to this approval out of "--source".`);
    fail(`${unsupportive.length === 1 ? 'This supporting source' : 'These supporting sources'} cannot support an acceptance: ${named}. ${steps.join(' ')} The record stays pending_review.`, 'INVALID_SUPPORTING_SOURCE', {
      ...unsupportive[0],
      sources: unsupportive
    });
  }
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

function registerInLedger(locator, ledger, input) {
  const existing = ledger.records.find((record) => record.source_id === input.sourceId);
  if (existing) {
    fail(`Source ${input.sourceId} already has lifecycle record ${existing.record_id}.`, 'RECORD_EXISTS', {
      source_id: input.sourceId,
      record_id: existing.record_id,
      state: existing.state
    });
  }
  const located = locator.locate({ source_id: input.sourceId, state: input.state });
  if (!located.ok) {
    fail(`Cannot register ${input.sourceId}: ${describeIssue(located.issue)}.`, 'SOURCE_NOT_AVAILABLE', {
      source_id: input.sourceId,
      issue: located.issue
    });
  }
  assertPathUnclaimed(locator, located.path, input.sourceId);
  assertSupportingSources(locator, ledger, input.sourceIds, input.sourceId);
  // A superseded or withdrawn record does not hold its old path.
  locator.releaseClosedClaims(located.path, input.sourceId, input.at);

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
  locator.track(record);
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
    const record = registerInLedger(createLocator(root, ledger), ledger, input);
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
    expectedRevision: normalizeExpectedRevision(options),
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
 * supersede need a declared human actor with an explicit confirmation, and so
 * does withdrawing an accepted record.  An agent or automation actor is
 * refused and the record keeps its state.
 */
export function transitionLifecycleRecord(instanceRoot, recordId, options = {}) {
  const input = normalizeTransition(recordId, options);
  return withLedgerMutation(instanceRoot, options, (ledger, root) => {
    const record = findRecord(ledger, input.recordId);
    if (!record) fail(`Lifecycle record not found: ${input.recordId}`, 'RECORD_NOT_FOUND', { record_id: input.recordId });
    assertExpectedRevision(record, input.expectedRevision);
    if (!input.rule.from.includes(record.state)) {
      fail(`Cannot ${input.action} a record that is ${record.state}. Allowed from: ${input.rule.from.join(', ')}.`, 'INVALID_TRANSITION', {
        record_id: record.record_id,
        action: input.action,
        state: record.state,
        allowed_from: [...input.rule.from]
      });
    }
    const locator = createLocator(root, ledger);
    const everApproved = record.history.some((entry) => entry.action === 'approve');
    let needsHuman = transitionRequiresHuman(input.action, record.state, { everApproved });
    let subject = `${input.action} a record`;
    if (input.action === 'withdraw') {
      subject = record.state === 'accepted' ? 'withdraw an accepted record' : 'withdraw a record that was accepted before';
    }
    if (input.action === 'revise' && record.state === 'accepted') {
      // An accepted file that was edited in place has already dropped out of
      // retrieval, so anyone may send the new version back through review.
      // Reopening context whose file still holds the accepted bytes takes it
      // away from readers, and that is a human decision.
      const current = locator.locate(record);
      if (!current.ok) {
        fail(`Cannot revise ${record.record_id}: ${describeIssue(current.issue)}. ${recoveryAdvice(record)}`, 'SOURCE_NOT_AVAILABLE', {
          record_id: record.record_id,
          issue: current.issue
        });
      }
      if (sameContent(current, record)) {
        needsHuman = true;
        subject = 'reopen accepted context whose file has not changed';
      }
    }
    if (needsHuman) {
      if (input.actorType !== 'human') {
        fail(`Only a human can ${subject}. The record stays ${record.state}.`, 'HUMAN_REQUIRED', {
          record_id: record.record_id,
          actor_type: input.actorType,
          state: record.state
        });
      }
      if (!input.humanConfirmed) {
        fail(`A human must confirm the decision explicitly to ${subject}. The record stays ${record.state}.`, 'HUMAN_CONFIRMATION_REQUIRED', {
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
    assertSupportingSources(locator, ledger, input.action === 'approve' ? sourceIds : input.sourceIds, record.source_id, {
      forApproval: input.action === 'approve',
      recordId: record.record_id,
      linkedSourceIds: record.source_ids
    });

    const changed = [record];
    const relatedRecordIds = [];
    let located = null;
    let sourceCorrection = false;

    if (input.action === 'submit' || input.action === 'approve') {
      located = locator.locate(record);
      if (!located.ok) {
        fail(`Cannot ${input.action} ${record.record_id}: ${describeIssue(located.issue)}. ${recoveryAdvice(record)}`, 'SOURCE_NOT_AVAILABLE', {
          record_id: record.record_id,
          issue: located.issue
        });
      }
    }
    // Submission binds the record to whatever bytes sit at the path, so the
    // path must belong to this source alone.
    const notices = [];
    if (input.action === 'submit') {
      assertPathUnclaimed(locator, located.path, record.source_id);
      const strays = locator.unrecordedClaimants(located.path, record.source_id);
      if (strays.length) {
        // Not an error: the file may simply have been registered twice.  It
        // can also mean a different file now sits at this record's path.
        notices.push(`Source ${strays.join(', ')} is also registered at ${located.path} and has no lifecycle record. Check that the submitted file is the one this record describes.`);
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
    let replacement = null;
    if (input.action === 'supersede') {
      replacement = assertAcceptedPeer(ledger, record, input.replacementId, 'replacement');
      const issue = integrityIssue(replacement, locator.locate(replacement));
      if (issue) {
        fail(`The replacement record ${replacement.record_id} cannot be used: ${describeIssue(issue)}.`, 'INVALID_SUPERSESSION', {
          record_id: replacement.record_id,
          issue
        });
      }
    }

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
    } else if (input.action === 'revise' || input.action === 'withdraw') {
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
        source_correction: sourceCorrection,
        notices
      }
    };
  });
}

/**
 * Point a record at the file it now lives in and record that path in the
 * source registry.  A draft, unreviewed, or rejected record may point at a
 * file that was also edited; its new bytes are recorded too.  A raw,
 * evidence, pending, or accepted record may only follow a file that still
 * holds its bytes.  The file is not touched.
 */
export function relocateLifecycleRecord(instanceRoot, recordId, options = {}) {
  assertRecordId(recordId);
  const { actor, actorType } = normalizeActor(options);
  const reason = String(options.reason ?? '').trim();
  if (!reason) fail('A reason is required to relocate a record.', 'REASON_REQUIRED');
  const pathInput = String(options.path ?? '').trim();
  if (!pathInput) fail('The new path is required to relocate a record.', 'INVALID_ARGUMENT');
  const expectedRevision = normalizeExpectedRevision(options);
  const at = toIsoTimestamp(options.now);

  return withLedgerMutation(instanceRoot, options, (ledger, root) => {
    const record = findRecord(ledger, recordId);
    if (!record) fail(`Lifecycle record not found: ${recordId}`, 'RECORD_NOT_FOUND', { record_id: recordId });
    assertExpectedRevision(record, expectedRevision);
    if (CLOSED_STATES.has(record.state)) {
      fail(`Cannot relocate a record that is ${record.state}. ${recoveryAdvice(record)}`, 'INVALID_TRANSITION', {
        record_id: record.record_id,
        action: 'relocate',
        state: record.state,
        allowed_from: LIFECYCLE_STATES.filter((state) => !CLOSED_STATES.has(state))
      });
    }
    let relative;
    try {
      relative = toWorkspaceRelativePath(root, pathInput, { requireExisting: true });
    } catch (error) {
      fail(`Cannot relocate ${record.record_id} to ${pathInput}: ${error.message}`, 'INVALID_PATH', { path: pathInput });
    }
    const locator = createLocator(root, ledger);
    const entry = locator.source(record.source_id);
    if (!entry.record) {
      fail(`Cannot relocate ${record.record_id}: ${describeIssue(entry.issue)}.`, 'SOURCE_NOT_AVAILABLE', {
        record_id: record.record_id,
        issue: entry.issue
      });
    }
    const source = entry.record;
    if (source.current_path === relative) {
      fail(`Record ${record.record_id} is already registered at ${relative}. Edit the file in place and submit it.`, 'RELOCATE_NOOP', {
        record_id: record.record_id,
        path: relative
      });
    }
    assertPathUnclaimed(locator, relative, record.source_id);

    const actual = locator.digest(relative);
    if (!RELOCATABLE_STATES.includes(record.state)) {
      // Raw, evidence, pending, and accepted material may move but not
      // change.  The file must hold the bytes that were reviewed or captured.
      const expected = BOUND_STATES.has(record.state) || !source.content_hash ? record : source;
      if (!sameContent(actual, expected)) {
        const next = record.state === 'pending_review'
          ? `Run "mole lifecycle revise ${record.record_id}" first.`
          : (record.state === 'accepted'
            ? `Restore the accepted file, or have a person run "mole lifecycle withdraw ${record.record_id}" and register the new version as a draft.`
            : `Run "mole lifecycle withdraw ${record.record_id}" and register the changed file as a new source.`);
        fail(`Cannot relocate ${record.state} record ${record.record_id} to ${relative}: the file there does not hold the record's bytes. A ${record.state} record can move but not change. ${next}`, 'CONTENT_CHANGED', {
          record_id: record.record_id,
          state: record.state,
          path: relative,
          expected_hash: expected.content_hash,
          actual_hash: actual.content_hash
        });
      }
    }
    locator.releaseClosedClaims(relative, record.source_id, at);
    const contentChanged = !source.content_hash || !sameContent(actual, source);
    const note = `Lifecycle relocation of ${record.record_id} by ${actor}: ${reason}`;
    const nextSource = {
      ...source,
      record_revision: source.record_revision + 1,
      current_path: relative,
      path_history: [
        ...source.path_history.map((item) => (item.valid_to === null ? { ...item, valid_to: at } : { ...item })),
        { path: relative, valid_from: at, valid_to: null, reason: 'relocated' }
      ],
      updated_at: at
    };
    if (contentChanged) {
      nextSource.content_hash = actual.content_hash;
      nextSource.byte_size = actual.byte_size;
      nextSource.content_history = [...source.content_history, {
        recorded_at: at,
        hash: actual.content_hash,
        byte_size: actual.byte_size,
        change_type: 'corrected',
        reason: note
      }];
    }
    writeSourceRecord(root, nextSource);

    record.path = relative;
    record.content_hash = actual.content_hash;
    record.byte_size = actual.byte_size;
    appendHistory(record, {
      action: 'relocate',
      fromState: record.state,
      toState: record.state,
      actor,
      actorType,
      humanConfirmed: (options.humanConfirmed ?? options.human_confirmed) === true,
      at,
      reason
    });
    return {
      changed: true,
      at,
      result: {
        ok: true,
        action: 'relocate',
        record_id: record.record_id,
        state: record.state,
        record,
        changed_record_ids: [record.record_id],
        source_correction: contentChanged
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
  const { root, ledger } = loadLedger(instanceRoot);
  let records = states.length ? ledger.records.filter((record) => states.includes(record.state)) : ledger.records;
  if (options.path !== undefined && options.path !== null) {
    // Match the path the registry holds now, or the one the record last saw.
    let relative;
    try {
      relative = toWorkspaceRelativePath(root, options.path);
    } catch (error) {
      fail(`Invalid path: ${error.message}`, 'INVALID_ARGUMENT', { path: String(options.path) });
    }
    const locator = createLocator(root, ledger);
    records = records.filter((record) => {
      if (record.path === relative || locator.source(record.source_id).record?.current_path === relative) return true;
      // A file that moved without a reconcile is still this record's file.
      const located = CLOSED_STATES.has(record.state) ? null : locator.locate(record);
      return Boolean(located?.ok && located.path === relative);
    });
  }
  return records;
}

/**
 * Sources whose registered path is this path, with their lifecycle record
 * when one exists.  A caller about to create a file uses this to avoid giving
 * one path to two sources.
 */
export function findPathClaims(instanceRoot, targetPath) {
  const { root, ledger } = loadLedger(instanceRoot);
  const relative = toWorkspaceRelativePath(root, targetPath);
  return createLocator(root, ledger).claimants(relative).map((sourceId) => {
    const record = ledger.records.find((item) => item.source_id === sourceId);
    return { source_id: sourceId, record_id: record?.record_id ?? null, state: record?.state ?? null };
  });
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
  const lock = readLockHolder(state.paths.lockPath);

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
  const locator = createLocator(root, state.ledger);
  const contested = new Map();
  for (const record of records) {
    // A superseded or withdrawn record is history; its file may be gone.
    if (CLOSED_STATES.has(record.state)) continue;
    const located = locator.locate(record);
    if (!located.ok) {
      findings.push(finding(located.issue, {
        record_id: record.record_id,
        source_id: record.source_id,
        state: record.state,
        path: record.path,
        ...(located.error ? { error: located.error } : {}),
        ...(located.candidates?.length ? { candidate_paths: located.candidates } : {}),
        action: recoveryAdvice(record)
      }));
    } else {
      if (BOUND_STATES.has(record.state) && !sameContent(located, record)) {
        findings.push(finding(record.state === 'accepted' ? 'accepted_content_changed' : 'pending_content_changed', {
          record_id: record.record_id,
          source_id: record.source_id,
          state: record.state,
          path: located.path,
          expected_hash: record.content_hash,
          actual_hash: located.content_hash,
          action: record.state === 'accepted'
            ? `Restore the accepted bytes, or run "mole lifecycle revise ${record.record_id}" and submit the new version for review. The record is excluded from normal retrieval until then.`
            : 'Revise and resubmit the record so the review covers the current bytes.'
        }));
      }
      const others = locator.claimants(located.path, record.source_id);
      if (others.length) {
        const entry = contested.get(located.path) || { source_ids: new Set(), record_ids: [] };
        for (const sourceId of [record.source_id, ...others]) entry.source_ids.add(sourceId);
        entry.record_ids.push(record.record_id);
        contested.set(located.path, entry);
      }
    }
    if (record.state === 'accepted') {
      for (const sourceId of record.source_ids) {
        if (!locator.source(sourceId).record) {
          findings.push(finding('supporting_source_missing', {
            record_id: record.record_id,
            source_id: sourceId,
            action: 'Recover the supporting source record; the acceptance cites it as evidence.'
          }));
        }
      }
    }
  }
  for (const [contestedPath, entry] of contested) {
    findings.push(finding('path_claim_conflict', {
      path: contestedPath,
      source_ids: [...entry.source_ids],
      record_ids: entry.record_ids,
      action: 'Two open records point at this file. Run "mole lifecycle relocate" on the one whose file moved, or "mole lifecycle withdraw" on the one that should not own it. Submission is refused until then.'
    }));
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
  const locator = createLocator(root, ledger);
  const records = [];
  const excluded = [];
  for (const record of ledger.records) {
    if (!includeStates.includes(record.state)) continue;
    const located = locator.locate(record);
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
  const located = createLocator(root, ledger).locate(record);
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
  if (RETRIEVAL_BOUND_STATES.has(record.state) && !sameContent(actual, record)) {
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

function contentKey(content) {
  return `${content.content_hash.value}:${content.byte_size}`;
}

/**
 * Work out, for every scanned file, which source it belongs to and whether
 * that source already has a lifecycle record.  Nothing is written.
 */
function planMigration(root, ledger, locator, roots) {
  const walked = walkRegularFiles(root, roots);
  const skipped = walked.symlinks.map((relative) => ({ path: relative, reason: 'symlink' }));
  const findings = [];
  const tracked = new Set(ledger.records.map((record) => record.source_id));

  // Sources whose registered path holds no file may be files that moved.
  const movedSources = new Map();
  for (const source of locator.allSources()) {
    if (!source.current_path || !source.content_hash || locator.fileExists(source.current_path)) continue;
    const key = contentKey(source);
    movedSources.set(key, [...(movedSources.get(key) || []), source.source_id]);
  }

  const skip = (relative, reason, details) => {
    skipped.push({ path: relative, reason });
    if (details) findings.push(finding(reason, { path: relative, ...details }));
  };

  const resolved = [];
  for (const relative of walked.files) {
    const name = path.posix.basename(relative).toLowerCase();
    if (name === 'readme.md') {
      skip(relative, 'guidance_file');
      continue;
    }
    if (looksLikeSyncConflictName(name)) {
      skip(relative, 'sync_conflict_copy');
      continue;
    }
    const claimants = locator.claimants(relative);
    if (claimants.length > 1) {
      skip(relative, 'ambiguous_source', {
        source_ids: claimants,
        action: 'Two open records point at this file. Withdraw the one that should not own it.'
      });
      continue;
    }
    const legacy = readLegacyFrontmatter(absoluteOf(root, relative));
    const item = { path: relative, source_id: claimants[0] ?? null, legacy_status: legacy.status, moved: false };
    if (item.source_id) {
      // An open record owns this path.  The ledger decides what the file is,
      // whatever source its frontmatter still names.
      resolved.push(item);
      continue;
    }

    let content;
    try {
      content = locator.digest(relative);
    } catch {
      skip(relative, 'unreadable_file');
      continue;
    }
    // A superseded or withdrawn record still tracks its own file.  A
    // different file that now sits at that path is untracked.
    const closedOwner = locator.closedClaimants(relative).find((sourceId) => {
      const closed = ledger.records.find((record) => record.source_id === sourceId);
      return closed && sameContent(content, closed);
    });
    if (closedOwner) {
      item.source_id = closedOwner;
      resolved.push(item);
      continue;
    }

    // No open record owns the path.  In order of preference the file belongs
    // to: the source its frontmatter names, a tracked source whose file is
    // missing from its path and whose bytes are these bytes, a source that is
    // registered here without a record, or an untracked moved source.  A moved
    // file keeps its identity instead of getting a second one.  Frontmatter
    // that names a source which is not this file is settled further down.
    const unrecorded = locator.unrecordedClaimants(relative);
    const moved = movedSources.get(contentKey(content)) || [];
    const movedTracked = moved.filter((sourceId) => tracked.has(sourceId));
    let choice;
    let viaMove = false;
    if (unrecorded.includes(legacy.source_id)) {
      choice = [legacy.source_id];
    } else if (moved.includes(legacy.source_id)) {
      choice = [legacy.source_id];
      viaMove = true;
    } else if (movedTracked.length) {
      choice = movedTracked;
      viaMove = true;
    } else if (unrecorded.length) {
      choice = unrecorded;
    } else {
      choice = moved;
      viaMove = true;
    }
    if (legacy.source_id && choice[0] !== legacy.source_id) item.named_source_id = legacy.source_id;
    if (choice.length > 1) {
      skip(relative, 'ambiguous_source', {
        source_ids: choice,
        action: viaMove
          ? 'Several moved sources hold these bytes. Run "mole lifecycle relocate" or "mole source reconcile" on the one this file belongs to, then run the migration again.'
          : 'Several sources are registered at this path and none has a lifecycle record. Choose one and run "mole lifecycle register <source_id> --state <state>".'
      });
      continue;
    }
    if (choice.length === 1) {
      item.source_id = choice[0];
      item.moved = viaMove;
    }
    resolved.push(item);
  }

  // One moved source can match only one file.
  const movedTargets = new Map();
  for (const item of resolved.filter((entry) => entry.moved)) {
    movedTargets.set(item.source_id, [...(movedTargets.get(item.source_id) || []), item.path]);
  }

  // A file that names another file's source is a copy that kept the
  // original's frontmatter.  The original is accounted for when it sits at
  // its registered path or was matched above as a moved file.
  const sourcesById = new Map(locator.allSources().map((source) => [source.source_id, source]));
  const heldElsewhere = (sourceId, relative) => {
    const registered = sourcesById.get(sourceId)?.current_path;
    if (registered && registered !== relative && locator.fileExists(registered)) return true;
    return (movedTargets.get(sourceId) || []).some((target) => target !== relative);
  };

  const candidates = [];
  let trackedCount = 0;
  for (const item of resolved) {
    // A source the registry gives this file, by its path or as a moved file
    // with these bytes, outranks the frontmatter.
    if (item.named_source_id && !item.source_id && !heldElsewhere(item.named_source_id, item.path)) {
      skip(item.path, 'source_id_mismatch', {
        source_id: item.named_source_id,
        action: `The file names a source that the registry does not match to this file and that no other file holds. To track the file as its own source, run "mole source register ${item.path}", then run the migration again.`
      });
      continue;
    }
    if (item.moved && movedTargets.get(item.source_id).length > 1) {
      skip(item.path, 'ambiguous_source', {
        source_ids: [item.source_id],
        candidate_paths: movedTargets.get(item.source_id),
        action: 'Several files hold the bytes of this moved source. Reconcile it with "mole source reconcile" before running the migration again.'
      });
      continue;
    }
    if (item.source_id && tracked.has(item.source_id)) {
      trackedCount += 1;
      continue;
    }
    candidates.push({
      path: item.path,
      source_id: item.source_id,
      ...(item.named_source_id ? { named_source_id: item.named_source_id } : {}),
      legacy_status: item.legacy_status,
      proposed_state: item.path.startsWith(`${RAW_MIGRATION_ROOT}/`) ? 'raw' : 'unreviewed'
    });
  }
  return { scanned: walked.files.length, tracked: trackedCount, candidates, skipped, findings };
}

/**
 * Find workspace files that have no lifecycle record.  The default mode only
 * reports.  Apply mode registers files under `6-raw/` as `raw` and every other
 * file as `unreviewed`; a legacy `status: active` field or approving prose
 * never becomes an acceptance.
 */
export function migrateLifecycleRecords(instanceRoot, options = {}) {
  const apply = options.apply === true;
  const roots = options.roots ?? DEFAULT_MIGRATION_ROOTS;
  if (!Array.isArray(roots)) fail('roots must be an array.', 'INVALID_ARGUMENT');
  const identity = apply ? normalizeActor(options) : null;
  const at = toIsoTimestamp(options.now);

  if (!apply) {
    const { root, ledger } = loadLedger(instanceRoot);
    const result = planMigration(root, ledger, createLocator(root, ledger), roots);
    return { ok: result.findings.length === 0, apply: false, ...result, registered: [] };
  }

  return withLedgerMutation(instanceRoot, options, (ledger, root) => {
    const locator = createLocator(root, ledger);
    const result = planMigration(root, ledger, locator, roots);
    const registered = [];
    for (const candidate of result.candidates) {
      try {
        let sourceId = candidate.source_id;
        if (!sourceId) {
          const registration = registerSource(root, {
            path: candidate.path,
            source_type: 'file',
            captured_at: at,
            captured_by: identity.actor,
            channel: 'lifecycle-migration',
            path_reason: 'registered',
            content_change_type: 'registered'
          });
          locator.remember(registration.record);
          sourceId = registration.source_id;
        }
        const record = registerInLedger(locator, ledger, {
          sourceId,
          state: candidate.proposed_state,
          actor: identity.actor,
          actorType: identity.actorType,
          sourceIds: [],
          reason: [
            candidate.legacy_status
              ? `Legacy file registered without review; frontmatter status "${candidate.legacy_status}" is not an approval.`
              : 'Legacy file registered without review.',
            candidate.named_source_id ? `Its frontmatter names ${candidate.named_source_id}, which is not this file's source.` : null
          ].filter(Boolean).join(' '),
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
