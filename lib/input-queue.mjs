import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isSourceId, toWorkspaceRelativePath } from './source-registry.mjs';

/**
 * The human-input queue: what an agent needs from a person, as stable
 * records.  The ledger at `governance/input-queue/requests.json` is the
 * authority.  `governance/input-queue.md` carries a generated view of it
 * between two markers, so the queue stays readable without a command.
 */

export const INPUT_QUEUE_SCHEMA_VERSION = 1;
export const INPUT_QUEUE_SCHEMA_REL_PATH = 'schemas/input-queue-v1.schema.json';
export const INPUT_QUEUE_DIR_REL_PATH = 'governance/input-queue';
export const INPUT_QUEUE_LEDGER_REL_PATH = `${INPUT_QUEUE_DIR_REL_PATH}/requests.json`;
export const INPUT_QUEUE_LOCK_REL_PATH = `${INPUT_QUEUE_DIR_REL_PATH}/.mutation.lock`;
export const INPUT_QUEUE_LEGACY_DIR_REL_PATH = `${INPUT_QUEUE_DIR_REL_PATH}/legacy`;
export const INPUT_QUEUE_VIEW_PENDING_REL_PATH = `${INPUT_QUEUE_DIR_REL_PATH}/.view-pending`;
export const INPUT_QUEUE_VIEW_REL_PATH = 'governance/input-queue.md';
export const INPUT_QUEUE_VIEW_START = '<!-- mole:input-queue:start -->';
export const INPUT_QUEUE_VIEW_END = '<!-- mole:input-queue:end -->';

export const INPUT_ID_PATTERN = /^inq_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const INPUT_PRIORITIES = Object.freeze(['high', 'medium', 'low']);
export const INPUT_STATUSES = Object.freeze(['open', 'waiting', 'in_progress', 'deferred', 'closed']);
export const INPUT_ACTIVE_STATUSES = Object.freeze(['open', 'waiting', 'in_progress']);
export const INPUT_CLOSURE_REASONS = Object.freeze(['answered', 'duplicate', 'superseded', 'stale', 'not_needed']);
export const INPUT_ACTOR_TYPES = Object.freeze(['human', 'agent', 'automation']);
export const INPUT_ACTIONS = Object.freeze(['add', 'migrate', 'update', 'close', 'reopen']);

export const DEFAULT_REVIEW_LIMIT = 3;
export const DEFAULT_STALE_AFTER_DAYS = 14;
export const DEFAULT_DUPLICATE_THRESHOLD = 0.6;

const DEFAULT_LOCK_WAIT_MS = 5000;
const LOCK_RETRY_MS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SUGGESTIONS = 20;

const REQUEST_FIELDS = Object.freeze([
  'input_id',
  'revision',
  'request',
  'impact',
  'unblocks',
  'answer_format',
  'effort',
  'priority',
  'blocking',
  'status',
  'requester',
  'owner',
  'due',
  'next_review',
  'source_ids',
  'references',
  'duplicate_of',
  'superseded_by',
  'closure',
  'legacy',
  'created_at',
  'updated_at',
  'history'
]);
const HISTORY_FIELDS = Object.freeze(['revision', 'action', 'actor', 'actor_type', 'human_confirmed', 'at', 'reason', 'changes']);
const CLOSURE_FIELDS = Object.freeze(['reason', 'answer', 'outcome', 'closed_by', 'closed_by_type', 'human_confirmed', 'closed_at']);
const LEGACY_FIELDS = Object.freeze(['path', 'line', 'row', 'columns']);
const LEDGER_FIELDS = Object.freeze(['schema_version', 'queue_revision', 'updated_at', 'requests']);

/** Fields a caller may set with `add` or `update`, keyed by option name. */
const EDITABLE_TEXT_FIELDS = Object.freeze(['request', 'impact', 'unblocks', 'answer_format', 'effort', 'requester', 'owner']);
const NULLABLE_TEXT_FIELDS = new Set(['unblocks', 'answer_format', 'effort', 'owner']);

const PRIORITY_POINTS = Object.freeze({ high: 30, medium: 20, low: 10 });
const BLOCKING_POINTS = 40;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'which', 'when', 'where', 'who', 'whom', 'why', 'how',
  'are', 'was', 'were', 'can', 'could', 'should', 'would', 'will', 'shall', 'does', 'did', 'has', 'have', 'had',
  'our', 'your', 'their', 'its', 'you', 'please', 'need', 'needs', 'needed', 'confirm', 'provide', 'about', 'into',
  'any', 'all', 'not', 'but', 'use', 'per', 'via'
]);

export class InputQueueError extends Error {
  constructor(message, code = 'INPUT_QUEUE_ERROR', details = {}) {
    super(message);
    this.name = 'InputQueueError';
    this.code = code;
    this.details = details;
  }
}

/** Codes that describe a malformed request rather than a refused operation. */
export const INPUT_QUEUE_USAGE_ERROR_CODES = Object.freeze(new Set([
  'INVALID_ARGUMENT',
  'INVALID_INPUT_ID',
  'INVALID_ACTOR',
  'REASON_REQUIRED'
]));

function fail(message, code, details = {}) {
  throw new InputQueueError(message, code, details);
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function isDateTime(value) {
  return typeof value === 'string'
    && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

/** A calendar date, `YYYY-MM-DD`, that exists. */
export function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function toIsoTimestamp(value) {
  const date = value === undefined || value === null ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) fail(`Invalid timestamp: ${value}`, 'INVALID_ARGUMENT');
  return date.toISOString();
}

function normalizeRoot(instanceRoot = process.cwd()) {
  return path.resolve(String(instanceRoot));
}

function absoluteOf(root, relative) {
  return path.join(root, ...relative.split('/'));
}

export function createInputId() {
  return `inq_${randomUUID()}`;
}

export function isInputId(value) {
  return typeof value === 'string' && INPUT_ID_PATTERN.test(value);
}

export function assertInputId(value) {
  if (!isInputId(value)) fail(`Invalid input request ID: ${value}`, 'INVALID_INPUT_ID', { input_id: value ?? null });
  return value;
}

export function getInputQueuePaths(instanceRoot = process.cwd()) {
  const root = normalizeRoot(instanceRoot);
  return {
    root,
    queueDir: absoluteOf(root, INPUT_QUEUE_DIR_REL_PATH),
    ledgerPath: absoluteOf(root, INPUT_QUEUE_LEDGER_REL_PATH),
    lockPath: absoluteOf(root, INPUT_QUEUE_LOCK_REL_PATH),
    viewPendingPath: absoluteOf(root, INPUT_QUEUE_VIEW_PENDING_REL_PATH),
    legacyDir: absoluteOf(root, INPUT_QUEUE_LEGACY_DIR_REL_PATH),
    viewPath: absoluteOf(root, INPUT_QUEUE_VIEW_REL_PATH)
  };
}

function emptyLedger() {
  return { schema_version: INPUT_QUEUE_SCHEMA_VERSION, queue_revision: 0, updated_at: null, requests: [] };
}

// ---------------------------------------------------------------------------
// Validation

function checkExactKeys(value, expected, label, errors) {
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) errors.push(`${label}.${key} is not a known field`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${label}.${key} is required`);
  }
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0 && value === value.trim();
}

function checkNullableText(value, label, errors) {
  if (value !== null && !isText(value)) errors.push(`${label} must be null or a non-empty trimmed string`);
}

function checkNullableDate(value, label, errors) {
  if (value !== null && !isCalendarDate(value)) errors.push(`${label} must be null or a YYYY-MM-DD date`);
}

function validateHistory(request, label, errors) {
  if (!Array.isArray(request.history) || request.history.length === 0) {
    errors.push(`${label}.history must be a non-empty array`);
    return;
  }
  request.history.forEach((entry, index) => {
    const entryLabel = `${label}.history[${index}]`;
    if (!asObject(entry)) {
      errors.push(`${entryLabel} must be an object`);
      return;
    }
    checkExactKeys(entry, HISTORY_FIELDS, entryLabel, errors);
    if (entry.revision !== index + 1) errors.push(`${entryLabel}.revision must be ${index + 1}`);
    if (!INPUT_ACTIONS.includes(entry.action)) errors.push(`${entryLabel}.action must be one of ${INPUT_ACTIONS.join(', ')}`);
    if (index === 0 && entry.action !== 'add' && entry.action !== 'migrate') errors.push(`${entryLabel}.action must be add or migrate`);
    if (index > 0 && (entry.action === 'add' || entry.action === 'migrate')) errors.push(`${entryLabel}.action cannot be ${entry.action} after the first entry`);
    if (!isText(entry.actor)) errors.push(`${entryLabel}.actor must be a non-empty trimmed string`);
    if (!INPUT_ACTOR_TYPES.includes(entry.actor_type)) errors.push(`${entryLabel}.actor_type must be one of ${INPUT_ACTOR_TYPES.join(', ')}`);
    if (typeof entry.human_confirmed !== 'boolean') errors.push(`${entryLabel}.human_confirmed must be a boolean`);
    if (entry.human_confirmed === true && entry.actor_type !== 'human') errors.push(`${entryLabel}.human_confirmed requires actor_type human`);
    if (!isDateTime(entry.at)) errors.push(`${entryLabel}.at must be an RFC 3339 UTC timestamp with milliseconds`);
    if (!isText(entry.reason)) errors.push(`${entryLabel}.reason must be a non-empty trimmed string`);
    if (!asObject(entry.changes)) {
      errors.push(`${entryLabel}.changes must be an object`);
    } else {
      for (const [field, change] of Object.entries(entry.changes)) {
        if (!asObject(change) || Object.keys(change).sort().join() !== 'from,to') {
          errors.push(`${entryLabel}.changes.${field} must hold from and to, and nothing else`);
        }
      }
    }
  });
}

function validateClosure(request, label, errors) {
  const closure = request.closure;
  if (request.status !== 'closed') {
    if (closure !== null) errors.push(`${label}.closure must be null unless the request is closed`);
    return;
  }
  if (!asObject(closure)) {
    errors.push(`${label}.closure is required for a closed request`);
    return;
  }
  checkExactKeys(closure, CLOSURE_FIELDS, `${label}.closure`, errors);
  if (!INPUT_CLOSURE_REASONS.includes(closure.reason)) errors.push(`${label}.closure.reason must be one of ${INPUT_CLOSURE_REASONS.join(', ')}`);
  checkNullableText(closure.answer, `${label}.closure.answer`, errors);
  if (!isText(closure.outcome)) errors.push(`${label}.closure.outcome must be a non-empty trimmed string`);
  if (!isText(closure.closed_by)) errors.push(`${label}.closure.closed_by must be a non-empty trimmed string`);
  if (!INPUT_ACTOR_TYPES.includes(closure.closed_by_type)) errors.push(`${label}.closure.closed_by_type must be one of ${INPUT_ACTOR_TYPES.join(', ')}`);
  if (typeof closure.human_confirmed !== 'boolean') errors.push(`${label}.closure.human_confirmed must be a boolean`);
  if (closure.human_confirmed === true && closure.closed_by_type !== 'human') errors.push(`${label}.closure.human_confirmed requires closed_by_type human`);
  if (!isDateTime(closure.closed_at)) errors.push(`${label}.closure.closed_at must be an RFC 3339 UTC timestamp with milliseconds`);
  if (closure.reason === 'duplicate' && !request.duplicate_of) errors.push(`${label}.duplicate_of is required when the closure reason is duplicate`);
  if (closure.reason === 'superseded' && !request.superseded_by) errors.push(`${label}.superseded_by is required when the closure reason is superseded`);
}

function validateLegacy(legacy, label, errors) {
  if (legacy === null) return;
  if (!asObject(legacy)) {
    errors.push(`${label}.legacy must be null or an object`);
    return;
  }
  checkExactKeys(legacy, LEGACY_FIELDS, `${label}.legacy`, errors);
  if (!isText(legacy.path)) errors.push(`${label}.legacy.path must be a non-empty trimmed string`);
  if (!Number.isInteger(legacy.line) || legacy.line < 1) errors.push(`${label}.legacy.line must be a positive integer`);
  if (typeof legacy.row !== 'string' || !legacy.row) errors.push(`${label}.legacy.row must be a non-empty string`);
  if (!asObject(legacy.columns) || Object.values(legacy.columns).some((value) => typeof value !== 'string')) {
    errors.push(`${label}.legacy.columns must map column names to strings`);
  }
}

/** Check a ledger object.  Returns `{ valid, errors }` and never throws. */
export function validateInputQueueLedger(ledger) {
  const errors = [];
  if (!asObject(ledger)) return { valid: false, errors: ['ledger must be an object'] };
  checkExactKeys(ledger, LEDGER_FIELDS, 'ledger', errors);
  if (ledger.schema_version !== INPUT_QUEUE_SCHEMA_VERSION) errors.push(`ledger.schema_version must be ${INPUT_QUEUE_SCHEMA_VERSION}`);
  if (!Number.isInteger(ledger.queue_revision) || ledger.queue_revision < 0) errors.push('ledger.queue_revision must be a non-negative integer');
  if (ledger.updated_at !== null && !isDateTime(ledger.updated_at)) errors.push('ledger.updated_at must be null or an RFC 3339 UTC timestamp with milliseconds');
  if (!Array.isArray(ledger.requests)) {
    errors.push('ledger.requests must be an array');
    return { valid: false, errors };
  }

  const ids = new Set();
  ledger.requests.forEach((request, index) => {
    const label = `requests[${index}]`;
    if (!asObject(request)) {
      errors.push(`${label} must be an object`);
      return;
    }
    checkExactKeys(request, REQUEST_FIELDS, label, errors);
    if (!isInputId(request.input_id)) errors.push(`${label}.input_id must be inq_ followed by a lowercase UUIDv4`);
    else if (ids.has(request.input_id)) errors.push(`${label}.input_id is used by more than one request`);
    else ids.add(request.input_id);
    if (!isText(request.request)) errors.push(`${label}.request must be a non-empty trimmed string`);
    if (!isText(request.impact)) errors.push(`${label}.impact must be a non-empty trimmed string`);
    if (!isText(request.requester)) errors.push(`${label}.requester must be a non-empty trimmed string`);
    for (const field of NULLABLE_TEXT_FIELDS) checkNullableText(request[field], `${label}.${field}`, errors);
    if (!INPUT_PRIORITIES.includes(request.priority)) errors.push(`${label}.priority must be one of ${INPUT_PRIORITIES.join(', ')}`);
    if (typeof request.blocking !== 'boolean') errors.push(`${label}.blocking must be a boolean`);
    if (!INPUT_STATUSES.includes(request.status)) errors.push(`${label}.status must be one of ${INPUT_STATUSES.join(', ')}`);
    checkNullableDate(request.due, `${label}.due`, errors);
    checkNullableDate(request.next_review, `${label}.next_review`, errors);
    if (!Array.isArray(request.source_ids) || request.source_ids.some((id) => !isSourceId(id)) || new Set(request.source_ids).size !== request.source_ids.length) {
      errors.push(`${label}.source_ids must be a list of unique source IDs`);
    }
    if (!Array.isArray(request.references) || request.references.some((item) => !isText(item)) || new Set(request.references).size !== request.references.length) {
      errors.push(`${label}.references must be a list of unique non-empty trimmed strings`);
    }
    for (const field of ['duplicate_of', 'superseded_by']) {
      if (request[field] !== null && !isInputId(request[field])) errors.push(`${label}.${field} must be null or an input request ID`);
      if (request[field] !== null && request[field] === request.input_id) errors.push(`${label}.${field} cannot name the request itself`);
    }
    if (!isDateTime(request.created_at)) errors.push(`${label}.created_at must be an RFC 3339 UTC timestamp with milliseconds`);
    if (!isDateTime(request.updated_at)) errors.push(`${label}.updated_at must be an RFC 3339 UTC timestamp with milliseconds`);
    validateHistory(request, label, errors);
    if (Array.isArray(request.history) && request.revision !== request.history.length) errors.push(`${label}.revision must equal the number of history entries`);
    validateClosure(request, label, errors);
    validateLegacy(request.legacy, label, errors);
  });

  ledger.requests.forEach((request, index) => {
    if (!asObject(request)) return;
    for (const field of ['duplicate_of', 'superseded_by']) {
      if (isInputId(request[field]) && !ids.has(request[field])) errors.push(`requests[${index}].${field} names a request that is not in the queue`);
    }
  });

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Reading and writing

function assertSafeQueuePaths(root) {
  for (const relative of [INPUT_QUEUE_DIR_REL_PATH, INPUT_QUEUE_LEDGER_REL_PATH, INPUT_QUEUE_LOCK_REL_PATH, INPUT_QUEUE_LEGACY_DIR_REL_PATH, INPUT_QUEUE_VIEW_PENDING_REL_PATH, INPUT_QUEUE_VIEW_REL_PATH]) {
    try {
      toWorkspaceRelativePath(root, relative);
    } catch (error) {
      fail(`The input queue path ${relative} is unsafe; nothing was read or changed: ${error.message}`, 'INVALID_QUEUE', { path: relative });
    }
  }
}

function readTextIfPresent(absolute) {
  try {
    return fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Read the ledger without throwing on bad content. */
function readLedgerState(root) {
  const paths = getInputQueuePaths(root);
  assertSafeQueuePaths(root);
  const text = readTextIfPresent(paths.ledgerPath);
  if (text === null) return { paths, exists: false, ledger: emptyLedger(), errors: [] };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { paths, exists: true, ledger: null, errors: [`${INPUT_QUEUE_LEDGER_REL_PATH} is not valid JSON: ${error.message}`] };
  }
  const validation = validateInputQueueLedger(parsed);
  return { paths, exists: true, ledger: validation.valid ? parsed : null, errors: validation.errors };
}

function loadLedger(instanceRoot) {
  const root = normalizeRoot(instanceRoot);
  const state = readLedgerState(root);
  if (!state.ledger) {
    fail(`The input queue ledger is invalid; nothing was changed. Restore ${INPUT_QUEUE_LEDGER_REL_PATH} from version control or a backup. ${state.errors.slice(0, 3).join('; ')}`, 'INVALID_QUEUE', {
      path: INPUT_QUEUE_LEDGER_REL_PATH,
      errors: state.errors
    });
  }
  return { root, paths: state.paths, ledger: state.ledger, exists: state.exists };
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readLockHolder(lockPath) {
  try {
    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return asObject(holder);
  } catch {
    return null;
  }
}

function lockHolderState(lockPath) {
  const holder = readLockHolder(lockPath);
  const local = Boolean(holder) && holder.host === os.hostname() && Number.isInteger(holder.pid);
  return { holder, foreign: Boolean(holder) && !local, stopped: local && !isProcessAlive(holder.pid) };
}

function acquireLock(paths, waitMs) {
  try {
    fs.mkdirSync(paths.queueDir, { recursive: true });
  } catch (error) {
    fail(`The input queue folder ${INPUT_QUEUE_DIR_REL_PATH} cannot be created (${error.code || error.message}). The queue was not changed.`, 'INPUT_QUEUE_UNWRITABLE', { path: INPUT_QUEUE_DIR_REL_PATH });
  }
  const token = randomUUID();
  const payload = `${JSON.stringify({ token, pid: process.pid, host: os.hostname(), acquired_at: new Date().toISOString() }, null, 2)}\n`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(paths.lockPath, payload, { encoding: 'utf8', flag: 'wx' });
      return { lockPath: paths.lockPath, token };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        fail(`The input queue folder ${INPUT_QUEUE_DIR_REL_PATH} cannot be written (${error.code || error.message}). The queue was not changed.`, 'INPUT_QUEUE_UNWRITABLE', { path: INPUT_QUEUE_DIR_REL_PATH });
      }
    }
    const state = lockHolderState(paths.lockPath);
    // A stopped holder will never release the lock, so do not wait for it.
    if (state.stopped) {
      fail('An input queue lock was left behind by a process that is no longer running. Run "mole input-queue unlock" to remove it. The queue was not changed.', 'INPUT_QUEUE_BUSY', { holder: state.holder, holder_alive: false });
    }
    if (Date.now() >= deadline) {
      fail('Another input queue change is in progress for this workspace. The queue was not changed; retry after it finishes.', 'INPUT_QUEUE_BUSY', { holder: state.holder, holder_alive: state.foreign ? null : true });
    }
    sleepSync(LOCK_RETRY_MS);
  }
}

function releaseLock(lock) {
  const holder = readLockHolder(lock.lockPath);
  if (holder && holder.token === lock.token) {
    try {
      fs.unlinkSync(lock.lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

/**
 * Remove a lock left by a process that has stopped.  A lock whose holder is
 * still running, or that came from another host, is left alone.
 */
export function unlockInputQueue(instanceRoot) {
  const paths = getInputQueuePaths(instanceRoot);
  assertSafeQueuePaths(paths.root);
  if (!fs.existsSync(paths.lockPath)) return { ok: true, removed: false, message: 'No input queue lock is present.' };
  const holder = readLockHolder(paths.lockPath);
  if (holder && holder.host === os.hostname() && Number.isInteger(holder.pid) && isProcessAlive(holder.pid)) {
    fail(`The input queue lock is held by running process ${holder.pid}. Wait for it to finish.`, 'INPUT_QUEUE_BUSY', { holder, holder_alive: true });
  }
  if (holder && holder.host !== os.hostname()) {
    fail(`The input queue lock was taken on another host (${holder.host}). Check that no command is running there, then delete ${INPUT_QUEUE_LOCK_REL_PATH} by hand.`, 'INPUT_QUEUE_BUSY', { holder, holder_alive: null });
  }
  fs.unlinkSync(paths.lockPath);
  return { ok: true, removed: true, holder, message: 'Removed the input queue lock left by a stopped process.' };
}

function writeFileAtomically(absolute, content) {
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, absolute);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary file is already gone.
    }
    throw error;
  }
}

/** Refuse a write that drops a request or changes an earlier history entry. */
function assertAppendOnly(previous, next) {
  const nextById = new Map(next.requests.map((request) => [request.input_id, request]));
  for (const request of previous.requests) {
    const updated = nextById.get(request.input_id);
    if (!updated) fail(`Refusing to drop input request ${request.input_id}.`, 'HISTORY_REWRITE');
    const kept = updated.history.slice(0, request.history.length);
    if (JSON.stringify(kept) !== JSON.stringify(request.history)) {
      fail(`Refusing to rewrite the history of input request ${request.input_id}.`, 'HISTORY_REWRITE');
    }
  }
}

/**
 * Run one change under the lock.  The operation receives a copy of the
 * ledger and returns `{ changed, at, result }`.  The ledger is validated and
 * replaced with one rename, then the Markdown view is refreshed.
 */
function withQueueLock(instanceRoot, options, callback) {
  const root = normalizeRoot(instanceRoot);
  const paths = getInputQueuePaths(root);
  assertSafeQueuePaths(root);
  const waitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  if (!Number.isFinite(waitMs) || waitMs < 0) fail('lockWaitMs must be a non-negative number.', 'INVALID_ARGUMENT');
  const lock = acquireLock(paths, waitMs);
  try {
    return callback(root, paths);
  } finally {
    releaseLock(lock);
  }
}

/**
 * The pending marker: present from just before the ledger is saved until the
 * Markdown file is rewritten.  It lists the lines Mole had generated for the
 * block before the change, so a later rewrite knows they are not hand-written.
 */
function readViewPending(root) {
  const absolute = getInputQueuePaths(root).viewPendingPath;
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    return { exists: false, usable: true, generated: [] };
  }
  if (!stat.isFile()) return { exists: true, usable: false, generated: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    const generated = Array.isArray(parsed?.generated) ? parsed.generated.filter((line) => typeof line === 'string') : [];
    return { exists: true, usable: true, generated };
  } catch {
    return { exists: true, usable: true, generated: [] };
  }
}

function removeIfPresent(absolute) {
  try {
    fs.unlinkSync(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/**
 * Write a planned view.  The ledger is the authority and is already saved,
 * so a failure here must not look like a failed change: a retry would add
 * the request twice.  The pending marker stays until the view is written, so
 * rows left in the file are known to be imported already.
 */
function applyViewPlan(root, plan) {
  const paths = getInputQueuePaths(root);
  try {
    if (plan.changed) writeFileAtomically(paths.viewPath, plan.content);
    removeIfPresent(paths.viewPendingPath);
    return { path: INPUT_QUEUE_VIEW_REL_PATH, changed: plan.changed };
  } catch (error) {
    return {
      path: INPUT_QUEUE_VIEW_REL_PATH,
      changed: false,
      stale: true,
      error: error.message,
      warning: `The change is saved, but ${INPUT_QUEUE_VIEW_REL_PATH} could not be rewritten: ${error.message} Do not repeat the command. Run "mole input-queue refresh-view" once the file can be written.`
    };
  }
}

function withQueueMutation(instanceRoot, options, operation) {
  return withQueueLock(instanceRoot, options, (root, paths) => {
    const { ledger: previous } = loadLedger(root);
    // Check the file the view goes into before anything is written.
    const file = assertViewWritable(root, previous);
    const ledger = JSON.parse(JSON.stringify(previous));
    const outcome = operation(ledger, root, file);
    if (!outcome.changed) return outcome.result;
    ledger.queue_revision = previous.queue_revision + 1;
    ledger.updated_at = outcome.at;
    const validation = validateInputQueueLedger(ledger);
    if (!validation.valid) {
      fail(`Refusing to write an invalid input queue: ${validation.errors.slice(0, 3).join('; ')}`, 'INVALID_QUEUE', { errors: validation.errors });
    }
    assertAppendOnly(previous, ledger);
    // Plan the rewrite against the new ledger.  If it would take out a line
    // the ledger does not hold, keep the file as it was first.
    const plan = planView(root, ledger, { now: outcome.at, matchImported: true, previousLedger: previous });
    const legacyCopy = file.text !== null && (outcome.keepCopy || plan.lost.length || plan.removesImportedRows) ? writeLegacyCopy(root, file.text, outcome.at) : null;
    const pending = readViewPending(root);
    const hadPending = pending.exists;
    try {
      const generated = [...new Set([...pending.generated, ...renderView(previous, outcome.at)])];
      fs.writeFileSync(paths.viewPendingPath, `${JSON.stringify({ at: outcome.at, generated })}\n`);
      writeFileAtomically(paths.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    } catch (error) {
      // Nothing was saved, so no rewrite is pending because of this change.
      if (!hadPending) {
        try {
          removeIfPresent(paths.viewPendingPath);
        } catch {
          // The marker could not be written in the first place.
        }
      }
      fail(`The input queue could not be saved (${error.code || error.message}). Check that ${INPUT_QUEUE_DIR_REL_PATH}/ holds only regular files and can be written. The queue was not changed.`, 'INPUT_QUEUE_UNWRITABLE', { path: INPUT_QUEUE_DIR_REL_PATH });
    }
    const view = applyViewPlan(root, plan);
    return { ...outcome.result, ...(legacyCopy ? { legacy_copy: legacyCopy } : {}), queue_revision: ledger.queue_revision, view };
  });
}

/**
 * Rewrite the generated table from the ledger.  Use it after a change whose
 * view update failed, or after the table was edited by hand.
 */
export function refreshInputQueueView(instanceRoot, options = {}) {
  return withQueueLock(instanceRoot, options, (root) => {
    const { ledger } = loadLedger(root);
    const file = assertViewWritable(root, ledger);
    if (file.candidates.length) failPendingRows(file);
    const at = toIsoTimestamp(options.now);
    const plan = planView(root, ledger, { now: at });
    const legacyCopy = file.text !== null && plan.changed && (plan.lost.length || plan.removesImportedRows) ? writeLegacyCopy(root, file.text, at) : null;
    const view = applyViewPlan(root, plan);
    if (view.stale) fail(`${INPUT_QUEUE_VIEW_REL_PATH} could not be rewritten: ${view.error}`, 'INPUT_QUEUE_UNWRITABLE', { path: INPUT_QUEUE_VIEW_REL_PATH });
    return { ok: true, action: 'refresh-view', ...(legacyCopy ? { legacy_copy: legacyCopy } : {}), view };
  });
}

// ---------------------------------------------------------------------------
// Markdown view and legacy table

const QUEUE_COLUMN_KEYS = new Set(['priority', 'status', 'why_this_matters', 'impact']);
/** Columns that carry a default in the starter table, so they do not make a row real. */
const STARTER_DEFAULTS = Object.freeze({
  priority: /^(high|medium|low|p[0-4])$/i,
  status: /^(open|waiting|in[ _-]progress|deferred|complete|completed|done|closed)$/i,
  blocking: /^(yes|no|true|false)$/i,
  effort: /^[\d\s–-]+\s*(min|mins|minutes|h|hr|hrs|hours?)$/i
});

/** Whether a cell holds only the default a starter table ships with. */
function isStarterDefault(key, cell) {
  return Boolean(STARTER_DEFAULTS[key]?.test(cell.replace(/[_*`]/g, '').trim()));
}

function splitTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  const cells = [];
  let current = '';
  const body = trimmed.slice(1);
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\' && body[index + 1] === '|') {
      current += '|';
      index += 1;
    } else if (char === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) cells.push(current.trim());
  return cells;
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell.replace(/\s+/g, '')));
}

function columnKey(header) {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function isPlaceholder(value) {
  const text = String(value ?? '').replace(/[_*`]/g, '').trim().toLowerCase();
  return !text || text === 'tbd' || text === 'todo' || text === 'n/a' || text === '-' || text === 'no open requests.';
}

/**
 * The generated block is the text between one start marker line and one end
 * marker line.  A marker counts only when it is the whole line, so prose that
 * mentions a marker is not mistaken for one.  Anything else, such as a start
 * with no end, is an error: rewriting the block could delete the user's text.
 */
function findViewMarkers(lines) {
  const starts = [];
  const ends = [];
  lines.forEach((line, index) => {
    if (line.trim() === INPUT_QUEUE_VIEW_START) starts.push(index);
    if (line.trim() === INPUT_QUEUE_VIEW_END) ends.push(index);
  });
  if (!starts.length && !ends.length) return { markers: null, error: null };
  if (starts.length === 1 && ends.length === 1 && starts[0] < ends[0]) return { markers: { start: starts[0], end: ends[0] }, error: null };
  const lineList = (indexes) => (indexes.length ? `line ${indexes.map((index) => index + 1).join(', ')}` : 'none');
  return {
    markers: null,
    error: `${INPUT_QUEUE_VIEW_REL_PATH} needs exactly one "${INPUT_QUEUE_VIEW_START}" line followed by one "${INPUT_QUEUE_VIEW_END}" line. Found start at ${lineList(starts)} and end at ${lineList(ends)}.`
  };
}

/**
 * Find every request table in the queue file.  A table inside the generated
 * block is one, and so is a table elsewhere that has a `Request` column and
 * at least one other queue column.  Tables in code fences are ignored.
 */
export function parseLegacyInputQueue(text) {
  const source = String(text ?? '');
  const crlf = (source.match(/\r\n/g) || []).length;
  const eol = crlf > 0 && crlf >= (source.match(/\n/g) || []).length - crlf ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const { markers, error: markerError } = findViewMarkers(lines);
  const tables = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const inView = Boolean(markers && index > markers.start && index < markers.end);
    // The generated block is never inside a fence, whatever came before it.
    if (inView || (markers && (index === markers.start || index === markers.end))) inFence = false;
    else if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const header = splitTableRow(line);
    const separator = index + 1 < lines.length ? splitTableRow(lines[index + 1]) : null;
    if (!header || !separator || !isSeparatorRow(separator)) continue;
    const keys = header.map(columnKey);
    if (!keys.includes('request') || !(inView || keys.some((key) => QUEUE_COLUMN_KEYS.has(key)))) continue;

    const rows = [];
    let end = index + 1;
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      if (markers && inView !== (rowIndex > markers.start && rowIndex < markers.end)) break;
      const cells = splitTableRow(lines[rowIndex]);
      if (!cells) break;
      end = rowIndex;
      const columns = {};
      header.forEach((name, cellIndex) => {
        columns[name] = cells[cellIndex] ?? '';
      });
      if (cells.length > header.length) columns['(extra cells)'] = cells.slice(header.length).join(' | ');
      const byKey = {};
      keys.forEach((key, cellIndex) => {
        if (!(key in byKey)) byKey[key] = cells[cellIndex] ?? '';
      });
      const id = String(byKey.id ?? '').replace(/`/g, '').trim();
      // A starter row: placeholders, plus defaults such as "High", "2–5 min", or "Open".
      const blank = cells.every((cell, cellIndex) => isPlaceholder(cell) || isStarterDefault(keys[cellIndex], cell));
      rows.push({ index: rowIndex, line: rowIndex + 1, row: lines[rowIndex], columns, byKey, inputId: isInputId(id) ? id : null, blank });
    }
    tables.push({ start: index, end, header, rows, inView });
    index = end;
  }
  return { lines, eol, markers, markerError, tables };
}

function legacyPriority(value) {
  const text = String(value ?? '').replace(/[_*`]/g, '').trim().toLowerCase();
  if (/^(high|p0|p1|critical|urgent|blocker)\b/.test(text)) return 'high';
  if (/^(low|p3|p4|minor)\b/.test(text)) return 'low';
  return 'medium';
}

function legacyStatus(value) {
  const text = String(value ?? '').replace(/[_*`]/g, '').trim().toLowerCase();
  if (/^(complete|completed|done|closed|answered|resolved)\b/.test(text)) return 'closed';
  if (/^waiting\b/.test(text)) return 'waiting';
  if (/^in[ -_]progress\b/.test(text)) return 'in_progress';
  if (/^(deferred|parked|later)\b/.test(text)) return 'deferred';
  return 'open';
}

function cleanCell(value) {
  const text = String(value ?? '').trim();
  return isPlaceholder(text) ? null : text;
}

function readViewText(root) {
  try {
    return readTextIfPresent(getInputQueuePaths(root).viewPath);
  } catch (error) {
    fail(`${INPUT_QUEUE_VIEW_REL_PATH} cannot be read (${error.code || error.message}). It must be a regular file. Nothing was changed.`, 'INVALID_QUEUE_VIEW', { path: INPUT_QUEUE_VIEW_REL_PATH });
  }
}

/**
 * Read the queue file against the ledger and sort its table rows:
 *
 * - `known`: carries the ID of a request in the ledger;
 * - `imported`: left in the file after a migration that could not rewrite
 *   it.  Matched by row text, and only while that rewrite is pending;
 * - `blank`: a starter placeholder row;
 * - `unimportable`: has text but no request;
 * - `candidate`: a request the ledger does not hold yet.
 *
 * Nothing is written.
 */
function readQueueFile(root, ledger, options = {}) {
  const text = readViewText(root);
  const parsed = parseLegacyInputQueue(text ?? '');
  const known = new Set(ledger.requests.map((request) => request.input_id));
  const pendingMarker = readViewPending(root);
  // A marker that is not a regular file says nothing; the audit reports it.
  const matchImported = options.matchImported ?? (pendingMarker.exists && pendingMarker.usable);
  const imported = new Map();
  if (matchImported) {
    for (const request of ledger.requests) {
      if (request.legacy?.path === INPUT_QUEUE_VIEW_REL_PATH) imported.set(request.legacy.row, (imported.get(request.legacy.row) || 0) + 1);
    }
  }
  const candidates = [];
  const skipped = [];
  const shownIds = new Set();
  for (const table of parsed.tables) {
    table.pending = 0;
    table.foreign = 0;
    table.imported = 0;
    const listsKnownIds = table.rows.some((row) => row.inputId && known.has(row.inputId));
    // With no markers in the file, a table under the generated header whose
    // rows all carry queue IDs is the old generated table, not a user's own.
    table.oldView = !table.inView && !parsed.markers && listsKnownIds
      && parsed.lines[table.start].trim() === VIEW_HEADER_ROW
      && table.rows.every((row) => row.inputId && known.has(row.inputId));
    const userTable = !table.inView && listsKnownIds && !table.oldView;
    const tableCandidates = [];
    const tableSkipped = [];
    for (const row of table.rows) {
      if (row.inputId && known.has(row.inputId)) {
        row.kind = 'known';
        if (table.inView) shownIds.add(row.inputId);
        else if (userTable) table.foreign += 1;
        continue;
      }
      // A user's own table is never matched against imported rows, so its
      // rows cannot use up a match that belongs to a legacy table.
      if (!table.inView && !userTable && imported.get(row.row) > 0) {
        row.kind = 'imported';
        table.imported += 1;
        imported.set(row.row, imported.get(row.row) - 1);
        continue;
      }
      const request = cleanCell(row.byKey.request);
      if (!request) {
        row.kind = row.blank ? 'blank' : 'unimportable';
        tableSkipped.push({ line: row.line, reason: row.blank ? 'placeholder_row' : 'request_missing', row: row.row });
        continue;
      }
      row.kind = 'candidate';
      const due = cleanCell(row.byKey.due);
      tableCandidates.push({
        line: row.line,
        fields: {
          request,
          impact: cleanCell(row.byKey.why_this_matters ?? row.byKey.impact ?? row.byKey.why) ?? 'Not recorded in the legacy queue.',
          unblocks: cleanCell(row.byKey.unblocks ?? row.byKey.output),
          answer_format: cleanCell(row.byKey.quick_input_format ?? row.byKey.input_format ?? row.byKey.format),
          effort: cleanCell(row.byKey.effort),
          priority: legacyPriority(row.byKey.priority),
          blocking: /^(yes|true|y|blocking)\b/i.test(String(row.byKey.blocking ?? '').trim()),
          status: legacyStatus(row.byKey.status),
          owner: cleanCell(row.byKey.owner),
          due: due && isCalendarDate(due) ? due : null
        },
        legacy: { path: INPUT_QUEUE_VIEW_REL_PATH, line: row.line, row: row.row, columns: row.columns }
      });
    }
    // A table outside the block that lists requests by queue ID is the
    // user's own.  It stays where it is, so importing a row from it would
    // import that row again on every run.  Its rows are left alone.
    if (userTable) {
      for (const row of table.rows) {
        if (row.kind === 'candidate') skipped.push({ line: row.line, reason: 'in_user_table', row: row.row });
        if (row.kind !== 'known') row.kind = 'foreign';
      }
      continue;
    }
    table.pending = tableCandidates.length;
    candidates.push(...tableCandidates);
    skipped.push(...tableSkipped);
  }
  return { text, parsed, candidates, skipped, shownIds, viewPending: matchImported && options.matchImported === undefined };
}

const VIEW_HEADER_ROW = '| ID | Priority | Blocking | Request | Why this matters | Unblocks | Quick input format | Owner | Due | Status |';

function escapeCell(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/<!--/g, '&lt;!--');
}

/** The open and deferred requests the generated table lists, in rank order. */
function viewRequests(ledger, now) {
  const ranked = rankRequests(ledger.requests, now).map((entry) => entry.request);
  return [...ranked, ...ledger.requests.filter((request) => request.status === 'deferred' && !ranked.includes(request))];
}

function renderView(ledger, now) {
  const lines = [
    INPUT_QUEUE_VIEW_START,
    '<!-- Generated from governance/input-queue/requests.json. Change requests with "mole input-queue"; edits between these markers are overwritten. -->',
    '',
    VIEW_HEADER_ROW,
    '|---|---|---|---|---|---|---|---|---|---|'
  ];
  const shown = viewRequests(ledger, now);
  for (const request of shown) {
    lines.push(`| ${[
      `\`${request.input_id}\``,
      request.priority,
      request.blocking ? 'yes' : 'no',
      escapeCell(request.request),
      escapeCell(request.impact),
      escapeCell(request.unblocks ?? ''),
      escapeCell(request.answer_format ?? ''),
      escapeCell(request.owner ?? ''),
      request.due ?? '',
      request.status
    ].join(' | ')} |`);
  }
  if (!shown.length) lines.push('| | | | _No open requests._ | | | | | | |');
  const closed = ledger.requests.filter((request) => request.status === 'closed').length;
  lines.push('', `${shown.length} open or deferred, ${closed} closed. Run \`mole input-queue list --all\` for closed requests and their answers.`, INPUT_QUEUE_VIEW_END);
  return lines;
}

const NEW_VIEW_FILE_HEADER = [
  '# Human Input Queue (Ask the PM)',
  '',
  'Purpose: track the minimum human inputs required to unblock high-quality agent outputs.',
  '',
  'The table below is generated. Add and change requests with `mole input-queue`.',
  ''
];

function assertViewWritable(root, ledger) {
  const file = readQueueFile(root, ledger);
  if (file.parsed.markerError) {
    fail(`${file.parsed.markerError} Rewriting the table could delete text, so nothing was changed. Fix the marker lines, or delete them all and run the command again.`, 'INVALID_QUEUE_VIEW', {
      path: INPUT_QUEUE_VIEW_REL_PATH
    });
  }
  return file;
}

const VIEW_PLACEHOLDER_ROW = '| | | | _No open requests._ | | | | | | |';

/**
 * Work out the next content of `governance/input-queue.md` without writing
 * it.  The generated block is replaced.  A request table outside the block
 * is removed once the ledger holds every row in it.  Text outside the block
 * and outside those tables is kept, with the file's line endings.
 *
 * `lost` lists the lines the rewrite would take out that the ledger does not
 * account for.  Inside the block that is any line Mole would not have
 * generated from the ledger, before or after this change: a note, an extra
 * column, a row edited by hand.  A caller keeps a copy of the file before
 * applying a plan that loses anything.
 */
function planView(root, ledger, options = {}) {
  const now = options.now ?? new Date();
  const block = renderView(ledger, now);
  const file = readQueueFile(root, ledger, { matchImported: options.matchImported });
  if (file.parsed.markerError) fail(file.parsed.markerError, 'INVALID_QUEUE_VIEW', { path: INPUT_QUEUE_VIEW_REL_PATH });
  if (file.text === null) {
    return { content: [...NEW_VIEW_FILE_HEADER, ...block, ''].join('\n'), changed: true, lost: [], removesImportedRows: false, foreignTables: [] };
  }
  const { parsed } = file;
  const generated = new Set([...block, ...renderView(options.previousLedger ?? ledger, now), ...readViewPending(root).generated, VIEW_PLACEHOLDER_ROW, '']);
  const lost = [];
  const noteBlockLine = (index) => {
    if (!generated.has(parsed.lines[index].trim())) lost.push({ line: index + 1, text: parsed.lines[index] });
  };
  const accountedFor = new Set();
  for (const table of parsed.tables) {
    if (table.inView) continue;
    accountedFor.add(table.start);
    accountedFor.add(table.start + 1);
    for (const row of table.rows) if (row.kind === 'blank' || row.kind === 'imported') accountedFor.add(row.index);
  }

  const lines = [...parsed.lines];
  let { markers } = parsed;
  if (markers) for (let index = markers.start; index <= markers.end; index += 1) noteBlockLine(index);
  const removable = parsed.tables.filter((table) => !table.inView && table.pending === 0 && table.foreign === 0);
  // Later tables first, so earlier line numbers stay valid.
  for (const table of [...removable].reverse()) {
    for (let index = table.start; index <= table.end; index += 1) {
      // The old generated table is held to the same rule as the block.
      const safe = table.oldView ? generated.has(parsed.lines[index].trim()) || accountedFor.has(index) : accountedFor.has(index);
      if (!safe) lost.push({ line: index + 1, text: parsed.lines[index] });
    }
    const placeView = !markers && table === removable[0];
    const removed = table.end - table.start + 1;
    lines.splice(table.start, removed, ...(placeView ? block : []));
    if (markers && table.start < markers.start) markers = { start: markers.start - removed, end: markers.end - removed };
    if (placeView) markers = { start: table.start, end: table.start + block.length - 1 };
  }
  if (markers) {
    lines.splice(markers.start, markers.end - markers.start + 1, ...block);
  } else {
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push('', ...block, '');
  }
  const content = lines.join(parsed.eol);
  return {
    content,
    changed: content !== file.text,
    lost: lost.sort((left, right) => left.line - right.line),
    // Rows matched to imported requests by their text alone: keep a copy.
    removesImportedRows: removable.some((table) => table.imported > 0),
    foreignTables: parsed.tables.filter((table) => table.foreign > 0).map((table) => table.start + 1)
  };
}

/** Keep the queue file as it is now, before a change removes rows from it. */
function writeLegacyCopy(root, text, at) {
  const paths = getInputQueuePaths(root);
  try {
    fs.mkdirSync(paths.legacyDir, { recursive: true });
  } catch (error) {
    fail(`${INPUT_QUEUE_LEGACY_DIR_REL_PATH} cannot be used to keep a copy of the queue file (${error.code || error.message}). It must be a folder. Nothing was changed.`, 'INPUT_QUEUE_UNWRITABLE', { path: INPUT_QUEUE_LEGACY_DIR_REL_PATH });
  }
  const stamp = at.replace(/[-:.]/g, '');
  for (let attempt = 0; ; attempt += 1) {
    const relative = `${INPUT_QUEUE_LEGACY_DIR_REL_PATH}/input-queue-${stamp}${attempt ? `-${attempt}` : ''}.md`;
    try {
      fs.writeFileSync(absoluteOf(root, relative), text, { encoding: 'utf8', flag: 'wx' });
      return relative;
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt >= 100) {
        fail(`A copy of the queue file could not be written to ${INPUT_QUEUE_LEGACY_DIR_REL_PATH} (${error.code || error.message}). Nothing was changed.`, 'INPUT_QUEUE_UNWRITABLE', { path: INPUT_QUEUE_LEGACY_DIR_REL_PATH });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Mutations

function normalizeActor(options = {}) {
  const actor = String(options.actor ?? '').trim();
  if (!actor) fail('An actor name is required.', 'INVALID_ACTOR');
  const actorType = options.actorType ?? options.actor_type;
  if (!INPUT_ACTOR_TYPES.includes(actorType)) {
    fail(`An actor type is required: one of ${INPUT_ACTOR_TYPES.join(', ')}.`, 'INVALID_ACTOR', { actor_type: actorType ?? null });
  }
  const humanConfirmed = (options.humanConfirmed ?? options.human_confirmed) === true;
  if (humanConfirmed && actorType !== 'human') {
    fail('Human confirmation can only be given by a human actor.', 'INVALID_ACTOR', { actor_type: actorType });
  }
  return { actor, actorType, humanConfirmed };
}

function assertHumanConfirmed(actor, what) {
  if (actor.actorType !== 'human' || !actor.humanConfirmed) {
    fail(`Only a person can ${what}. Ask the person who owns the decision to run this with --actor-type human --confirm-human.`, 'HUMAN_CONFIRMATION_REQUIRED', {
      actor_type: actor.actorType,
      human_confirmed: actor.humanConfirmed
    });
  }
}

function normalizeText(value, label, nullable) {
  if (value === null && nullable) return null;
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) {
    if (nullable) return null;
    fail(`${label} cannot be empty.`, 'INVALID_ARGUMENT', { field: label });
  }
  return text;
}

function normalizeDate(value, label) {
  if (value === null || value === '' || value === 'none') return null;
  if (!isCalendarDate(value)) fail(`${label} must be a YYYY-MM-DD date, or "none" to clear it.`, 'INVALID_ARGUMENT', { field: label, value });
  return value;
}

function normalizeList(value, label, check) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) fail(`${label} must be a list.`, 'INVALID_ARGUMENT', { field: label });
  const items = [];
  for (const raw of value) {
    const item = String(raw ?? '').trim();
    if (!item || (check && !check(item))) fail(`Invalid ${label} entry: ${raw}`, 'INVALID_ARGUMENT', { field: label, value: raw });
    if (!items.includes(item)) items.push(item);
  }
  return items;
}

/** Pick the fields a caller supplied and normalize them. */
function normalizeFields(options, { forAdd }) {
  const fields = {};
  for (const field of EDITABLE_TEXT_FIELDS) {
    const camel = field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = options[field] ?? options[camel];
    if (value === undefined) continue;
    fields[field] = normalizeText(value, field, NULLABLE_TEXT_FIELDS.has(field));
  }
  if (options.priority !== undefined) {
    if (!INPUT_PRIORITIES.includes(options.priority)) fail(`Priority must be one of ${INPUT_PRIORITIES.join(', ')}.`, 'INVALID_ARGUMENT', { priority: options.priority });
    fields.priority = options.priority;
  }
  if (options.blocking !== undefined) {
    if (typeof options.blocking !== 'boolean') fail('blocking must be true or false.', 'INVALID_ARGUMENT');
    fields.blocking = options.blocking;
  }
  if (options.due !== undefined) fields.due = normalizeDate(options.due, 'due');
  const nextReview = options.nextReview ?? options.next_review;
  if (nextReview !== undefined) fields.next_review = normalizeDate(nextReview, 'next review');
  const sourceIds = normalizeList(options.sourceIds ?? options.source_ids, 'source ID', isSourceId);
  if (sourceIds) fields.source_ids = sourceIds;
  const references = normalizeList(options.references, 'reference');
  if (references) fields.references = references;
  if (!forAdd && options.status !== undefined) {
    if (!INPUT_STATUSES.includes(options.status) || options.status === 'closed') {
      fail(`Status must be one of ${INPUT_STATUSES.filter((status) => status !== 'closed').join(', ')}. Use "mole input-queue close" to close a request.`, 'INVALID_ARGUMENT', { status: options.status });
    }
    fields.status = options.status;
  }
  return fields;
}

function findRequest(ledger, inputId) {
  const request = ledger.requests.find((item) => item.input_id === inputId);
  if (!request) fail(`Input request not found: ${inputId}`, 'REQUEST_NOT_FOUND', { input_id: inputId });
  return request;
}

function appendHistory(request, entry) {
  request.history.push({
    revision: request.history.length + 1,
    action: entry.action,
    actor: entry.actor.actor,
    actor_type: entry.actor.actorType,
    human_confirmed: entry.actor.humanConfirmed,
    at: entry.at,
    reason: entry.reason,
    changes: entry.changes ?? {}
  });
  request.revision = request.history.length;
  request.updated_at = entry.at;
}

function buildRequest(fields, actor, at, action, reason, legacy = null) {
  const request = {
    input_id: createInputId(),
    revision: 0,
    request: fields.request,
    impact: fields.impact,
    unblocks: fields.unblocks ?? null,
    answer_format: fields.answer_format ?? null,
    effort: fields.effort ?? null,
    priority: fields.priority ?? 'medium',
    blocking: fields.blocking ?? false,
    status: fields.status ?? 'open',
    requester: fields.requester ?? actor.actor,
    owner: fields.owner ?? null,
    due: fields.due ?? null,
    next_review: fields.next_review ?? null,
    source_ids: fields.source_ids ?? [],
    references: fields.references ?? [],
    duplicate_of: null,
    superseded_by: null,
    closure: null,
    legacy,
    created_at: at,
    updated_at: at,
    history: []
  };
  appendHistory(request, { action, actor, at, reason });
  return request;
}

function failPendingRows(file) {
  const count = file.candidates.length;
  fail(`${INPUT_QUEUE_VIEW_REL_PATH} holds ${count} request ${count === 1 ? 'row' : 'rows'} that ${count === 1 ? 'is' : 'are'} not in the queue yet (line ${file.candidates.map((candidate) => candidate.line).join(', ')}). Run "mole input-queue migrate --apply --actor <name> --actor-type <type>" first, so ${count === 1 ? 'it gets a stable ID and is' : 'they get stable IDs and are'} not lost when the table is rewritten.`, 'MIGRATION_REQUIRED', {
    path: INPUT_QUEUE_VIEW_REL_PATH,
    pending_rows: count,
    lines: file.candidates.map((candidate) => candidate.line)
  });
}

/** Add a request.  The request, its impact, and what it unblocks are required. */
export function addInputRequest(instanceRoot, options = {}) {
  const actor = normalizeActor(options);
  const fields = normalizeFields(options, { forAdd: true });
  for (const field of ['request', 'impact', 'unblocks']) {
    if (!fields[field]) fail(`A new request needs ${field === 'unblocks' ? 'the output it unblocks' : `its ${field}`}.`, 'INVALID_ARGUMENT', { field });
  }
  const at = toIsoTimestamp(options.now);
  const reason = normalizeText(options.reason ?? 'Requested.', 'reason', false);
  return withQueueMutation(instanceRoot, options, (ledger, _root, file) => {
    if (file.candidates.length) failPendingRows(file);
    const request = buildRequest(fields, actor, at, 'add', reason);
    ledger.requests.push(request);
    return {
      changed: true,
      at,
      result: { ok: true, action: 'add', input_id: request.input_id, request }
    };
  });
}

/**
 * Change fields of an open request.  Changing the owner of a request that
 * already has one needs a confirmed human.
 */
export function updateInputRequest(instanceRoot, inputId, options = {}) {
  assertInputId(inputId);
  const actor = normalizeActor(options);
  const fields = normalizeFields(options, { forAdd: false });
  const addSources = normalizeList(options.addSourceIds ?? options.add_source_ids, 'source ID', isSourceId) ?? [];
  const addReferences = normalizeList(options.addReferences ?? options.add_references, 'reference') ?? [];
  const reason = normalizeText(options.reason, 'reason', true);
  if (!reason) fail('A reason is required to update a request.', 'REASON_REQUIRED');
  const at = toIsoTimestamp(options.now);

  return withQueueMutation(instanceRoot, options, (ledger, _root, file) => {
    if (file.candidates.length) failPendingRows(file);
    const request = findRequest(ledger, inputId);
    if (request.status === 'closed') {
      fail(`Request ${inputId} is closed. Run "mole input-queue reopen ${inputId}" before changing it.`, 'REQUEST_CLOSED', { input_id: inputId });
    }
    const next = { ...fields };
    if (addSources.length) next.source_ids = [...new Set([...(next.source_ids ?? request.source_ids), ...addSources])];
    if (addReferences.length) next.references = [...new Set([...(next.references ?? request.references), ...addReferences])];
    for (const field of ['request', 'impact', 'requester']) {
      if (Object.prototype.hasOwnProperty.call(next, field) && !next[field]) fail(`${field} cannot be empty.`, 'INVALID_ARGUMENT', { field });
    }

    const changes = {};
    for (const [field, value] of Object.entries(next)) {
      if (JSON.stringify(request[field]) === JSON.stringify(value)) continue;
      changes[field] = { from: request[field], to: value };
    }
    if (!Object.keys(changes).length) {
      fail(`Nothing to change on ${inputId}: every value given matches the request.`, 'NO_CHANGE', { input_id: inputId });
    }
    if (changes.owner && changes.owner.from !== null) assertHumanConfirmed(actor, 'change the owner of a request');
    const nextStatus = changes.status ? changes.status.to : request.status;
    const nextReviewDate = changes.next_review ? changes.next_review.to : request.next_review;
    if (nextStatus === 'deferred' && nextReviewDate === null && (changes.status || changes.next_review)
      && !(actor.actorType === 'human' && actor.humanConfirmed)) {
      fail('A deferred request needs a review date so it comes back. Pass --next-review <YYYY-MM-DD>. Only a person can defer a request with no date, with --actor-type human --confirm-human.', 'NEXT_REVIEW_REQUIRED', {
        input_id: inputId
      });
    }
    for (const [field, change] of Object.entries(changes)) request[field] = change.to;
    appendHistory(request, { action: 'update', actor, at, reason, changes });
    return { changed: true, at, result: { ok: true, action: 'update', input_id: inputId, changed_fields: Object.keys(changes), request } };
  });
}

/**
 * Close a request and keep who closed it, when, why, and what changed.  An
 * answered request needs the answer.  Any other closure is a judgement that
 * the request no longer matters, so it needs a confirmed human.
 */
export function closeInputRequest(instanceRoot, inputId, options = {}) {
  assertInputId(inputId);
  const actor = normalizeActor(options);
  const closureReason = options.closureReason ?? options.closure_reason ?? 'answered';
  if (!INPUT_CLOSURE_REASONS.includes(closureReason)) {
    fail(`The closure reason must be one of ${INPUT_CLOSURE_REASONS.join(', ')}.`, 'INVALID_ARGUMENT', { closure_reason: closureReason });
  }
  const answer = normalizeText(options.answer ?? null, 'answer', true);
  const outcome = normalizeText(options.outcome ?? null, 'outcome', true);
  const reason = normalizeText(options.reason ?? null, 'reason', true);
  const duplicateOf = options.duplicateOf ?? options.duplicate_of ?? null;
  const supersededBy = options.supersededBy ?? options.superseded_by ?? null;
  if (duplicateOf !== null) assertInputId(duplicateOf);
  if (supersededBy !== null) assertInputId(supersededBy);
  if (closureReason === 'answered' && !answer) fail('An answered request needs the answer. Pass --answer with what the person said or decided.', 'INVALID_ARGUMENT', { field: 'answer' });
  if (!outcome) fail('Say what the closure changed. Pass --outcome with the resulting decision or the work it unblocked.', 'INVALID_ARGUMENT', { field: 'outcome' });
  if (closureReason === 'duplicate' && !duplicateOf) fail('Closing a duplicate needs --duplicate-of with the request that stays open.', 'INVALID_ARGUMENT', { field: 'duplicate_of' });
  if (closureReason === 'superseded' && !supersededBy) fail('Closing a superseded request needs --superseded-by with the request that replaces it.', 'INVALID_ARGUMENT', { field: 'superseded_by' });
  if (duplicateOf && closureReason !== 'duplicate') fail('--duplicate-of goes with the closure reason "duplicate".', 'INVALID_ARGUMENT', { field: 'duplicate_of' });
  if (supersededBy && closureReason !== 'superseded') fail('--superseded-by goes with the closure reason "superseded".', 'INVALID_ARGUMENT', { field: 'superseded_by' });
  if (closureReason !== 'answered') {
    if (!reason) fail('A reason is required to close a request that was not answered.', 'REASON_REQUIRED');
    assertHumanConfirmed(actor, `close a request as ${closureReason.replace('_', ' ')}`);
  }
  const at = toIsoTimestamp(options.now);

  return withQueueMutation(instanceRoot, options, (ledger, _root, file) => {
    if (file.candidates.length) failPendingRows(file);
    const request = findRequest(ledger, inputId);
    if (request.status === 'closed') {
      fail(`Request ${inputId} is already closed (${request.closure.reason}).`, 'REQUEST_CLOSED', { input_id: inputId });
    }
    for (const [field, linked] of [['duplicate_of', duplicateOf], ['superseded_by', supersededBy]]) {
      if (!linked) continue;
      if (linked === inputId) fail('A request cannot be linked to itself.', 'INVALID_ARGUMENT', { field });
      const target = findRequest(ledger, linked);
      if (target.status === 'closed') {
        fail(`Request ${linked} is closed, so it cannot stand in for ${inputId}. Link to a request that is still open, or reopen ${linked} first.`, 'INVALID_LINK', { field, input_id: linked });
      }
    }
    const changes = { status: { from: request.status, to: 'closed' } };
    if (duplicateOf) changes.duplicate_of = { from: request.duplicate_of, to: duplicateOf };
    if (supersededBy) changes.superseded_by = { from: request.superseded_by, to: supersededBy };
    request.status = 'closed';
    request.duplicate_of = duplicateOf ?? request.duplicate_of;
    request.superseded_by = supersededBy ?? request.superseded_by;
    request.closure = {
      reason: closureReason,
      answer,
      outcome,
      closed_by: actor.actor,
      closed_by_type: actor.actorType,
      human_confirmed: actor.humanConfirmed,
      closed_at: at
    };
    changes.closure = { from: null, to: { ...request.closure } };
    appendHistory(request, { action: 'close', actor, at, reason: reason ?? `Answered: ${answer}`, changes });
    return { changed: true, at, result: { ok: true, action: 'close', input_id: inputId, request } };
  });
}

/** Reopen a closed request.  Its closure stays in the history. */
export function reopenInputRequest(instanceRoot, inputId, options = {}) {
  assertInputId(inputId);
  const actor = normalizeActor(options);
  const reason = normalizeText(options.reason ?? null, 'reason', true);
  if (!reason) fail('A reason is required to reopen a request.', 'REASON_REQUIRED');
  const at = toIsoTimestamp(options.now);
  return withQueueMutation(instanceRoot, options, (ledger, _root, file) => {
    if (file.candidates.length) failPendingRows(file);
    const request = findRequest(ledger, inputId);
    if (request.status !== 'closed') fail(`Request ${inputId} is ${request.status}, not closed.`, 'REQUEST_NOT_CLOSED', { input_id: inputId, status: request.status });
    // A closure a person confirmed is that person's decision to undo.
    if (request.closure.human_confirmed) assertHumanConfirmed(actor, 'reopen a request that a person closed');
    const changes = {
      status: { from: 'closed', to: 'open' },
      closure: { from: { ...request.closure }, to: null }
    };
    if (request.duplicate_of) changes.duplicate_of = { from: request.duplicate_of, to: null };
    if (request.superseded_by) changes.superseded_by = { from: request.superseded_by, to: null };
    request.status = 'open';
    request.closure = null;
    request.duplicate_of = null;
    request.superseded_by = null;
    appendHistory(request, { action: 'reopen', actor, at, reason, changes });
    return { changed: true, at, result: { ok: true, action: 'reopen', input_id: inputId, request } };
  });
}

/**
 * Import request rows from the Markdown table.  A dry run reports what would
 * be imported.  Applying keeps a copy of the file as it was, gives each row
 * a stable ID with its original text, and replaces the table with the
 * generated view.  Rows that already carry an ID are left alone, so running
 * it again imports only rows added by hand since.
 */
export function migrateInputQueue(instanceRoot, options = {}) {
  const root = normalizeRoot(instanceRoot);
  const apply = options.apply === true;
  const describe = (candidate) => ({
    line: candidate.line,
    request: candidate.fields.request,
    priority: candidate.fields.priority,
    status: candidate.fields.status,
    due: candidate.fields.due
  });

  if (!apply) {
    assertSafeQueuePaths(root);
    const file = readQueueFile(root, loadLedger(root).ledger);
    return {
      ok: true,
      applied: false,
      path: INPUT_QUEUE_VIEW_REL_PATH,
      candidates: file.candidates.map(describe),
      skipped: file.skipped,
      migrated: [],
      legacy_copy: null
    };
  }

  const actor = normalizeActor(options);
  const at = toIsoTimestamp(options.now);
  return withQueueMutation(root, options, (ledger, _root, file) => {
    const base = { ok: true, applied: true, path: INPUT_QUEUE_VIEW_REL_PATH, candidates: [], skipped: file.skipped, migrated: [], legacy_copy: null };
    if (!file.candidates.length) return { changed: false, result: base };

    const migrated = [];
    for (const candidate of file.candidates) {
      const request = buildRequest({ ...candidate.fields, status: 'open', requester: 'legacy queue' }, actor, at, 'migrate',
        `Migrated from ${INPUT_QUEUE_VIEW_REL_PATH} line ${candidate.line}.`, candidate.legacy);
      if (candidate.fields.status === 'closed') {
        request.status = 'closed';
        request.closure = {
          reason: 'answered',
          answer: null,
          outcome: 'Marked complete in the legacy queue before migration. The answer was not recorded there.',
          closed_by: actor.actor,
          closed_by_type: actor.actorType,
          human_confirmed: actor.humanConfirmed,
          closed_at: at
        };
      } else {
        request.status = candidate.fields.status;
        // A deferred request needs a date to come back on.  The legacy table
        // had none, so it comes up for review straight away.
        if (request.status === 'deferred') request.next_review = at.slice(0, 10);
      }
      ledger.requests.push(request);
      migrated.push({ input_id: request.input_id, ...describe(candidate) });
    }
    return {
      changed: true,
      at,
      keepCopy: true,
      result: { ...base, migrated }
    };
  });
}

// ---------------------------------------------------------------------------
// Reading, ranking, and suggestions

function dayNumber(dateText) {
  return Math.floor(Date.parse(`${dateText}T00:00:00.000Z`) / DAY_MS);
}

function todayNumber(now) {
  return Math.floor(new Date(now).getTime() / DAY_MS);
}

function isReviewable(request, now) {
  if (INPUT_ACTIVE_STATUSES.includes(request.status)) return true;
  // A deferred request comes back when its review date arrives.
  return request.status === 'deferred' && request.next_review !== null && dayNumber(request.next_review) <= todayNumber(now);
}

function scoreRequest(request, now, staleAfterDays) {
  const reasons = [];
  let score = 0;
  if (request.blocking) {
    score += BLOCKING_POINTS;
    reasons.push('blocks work');
  }
  score += PRIORITY_POINTS[request.priority];
  reasons.push(`${request.priority} priority`);
  if (request.due) {
    const days = dayNumber(request.due) - todayNumber(now);
    if (days < 0) {
      score += 30;
      reasons.push(`overdue by ${-days} ${days === -1 ? 'day' : 'days'}`);
    } else if (days <= 3) {
      score += 20;
      reasons.push(days === 0 ? 'due today' : `due in ${days} ${days === 1 ? 'day' : 'days'}`);
    } else if (days <= 7) {
      score += 10;
      reasons.push(`due in ${days} days`);
    }
  }
  if (request.status === 'deferred') reasons.push('deferred, review date reached');
  const idleDays = Math.floor((new Date(now).getTime() - Date.parse(request.updated_at)) / DAY_MS);
  if (idleDays >= staleAfterDays) {
    score += 5;
    reasons.push(`untouched for ${idleDays} days`);
  }
  return { score, reasons };
}

/** Requests a person could act on now, highest value first. */
function rankRequests(requests, now, staleAfterDays = DEFAULT_STALE_AFTER_DAYS) {
  return requests
    .filter((request) => isReviewable(request, now))
    .map((request, index) => ({ request, index, ...scoreRequest(request, now, staleAfterDays) }))
    .sort((left, right) => right.score - left.score
      || (left.request.due ?? '9999-12-31').localeCompare(right.request.due ?? '9999-12-31')
      || left.request.created_at.localeCompare(right.request.created_at)
      || left.index - right.index);
}

function requestTerms(request) {
  const terms = new Set();
  for (const word of request.request.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length > 2 && !STOPWORDS.has(word)) terms.add(word);
  }
  return terms;
}

function findDuplicateCandidates(requests, threshold) {
  const entries = requests.map((request, index) => ({ request, index, terms: requestTerms(request) })).filter((entry) => entry.terms.size >= 2);
  // Only requests that share a term can be similar, so count shared terms
  // through an index instead of comparing every pair.
  const byTerm = new Map();
  entries.forEach((entry, position) => {
    for (const term of entry.terms) {
      if (!byTerm.has(term)) byTerm.set(term, []);
      byTerm.get(term).push(position);
    }
  });
  let best = [];
  let count = 0;
  const order = (left, right) => right.similarity - left.similarity || left.first - right.first || left.second - right.second;
  entries.forEach((entry, position) => {
    const sharedCounts = new Map();
    for (const term of entry.terms) {
      for (const other of byTerm.get(term)) {
        if (other > position) sharedCounts.set(other, (sharedCounts.get(other) || 0) + 1);
      }
    }
    for (const [other, sharedCount] of sharedCounts) {
      const similarity = sharedCount / (entry.terms.size + entries[other].terms.size - sharedCount);
      if (similarity < threshold) continue;
      count += 1;
      best.push({ similarity, first: position, second: other });
      // Keep only the strongest pairs, so a queue of near-identical requests
      // cannot exhaust memory.
      if (best.length > MAX_SUGGESTIONS * 50) best = best.sort(order).slice(0, MAX_SUGGESTIONS);
    }
  });
  const pairs = best.sort(order).slice(0, MAX_SUGGESTIONS).map(({ similarity, first, second }) => {
    const [older, newer] = [entries[first], entries[second]]
      .sort((a, b) => a.request.created_at.localeCompare(b.request.created_at) || a.index - b.index)
      .map((item) => item.request);
    return {
      input_ids: [older.input_id, newer.input_id],
      requests: [older.request, newer.request],
      similarity: Math.round(similarity * 100) / 100,
      shared_terms: [...entries[first].terms].filter((term) => entries[second].terms.has(term)).sort(),
      suggestion: `If these ask for the same thing, a person can run "mole input-queue close ${newer.input_id} --closure-reason duplicate --duplicate-of ${older.input_id}". Nothing was closed.`
    };
  });
  return { pairs, count };
}

function findStaleCandidates(requests, now, staleAfterDays) {
  const stale = [];
  for (const request of requests) {
    const reasons = [];
    const idleDays = Math.floor((new Date(now).getTime() - Date.parse(request.updated_at)) / DAY_MS);
    if (idleDays >= staleAfterDays) reasons.push(`not updated for ${idleDays} days`);
    if (request.next_review && dayNumber(request.next_review) <= todayNumber(now)) reasons.push(`review date ${request.next_review} has arrived`);
    if (request.due && dayNumber(request.due) < todayNumber(now)) reasons.push(`due date ${request.due} has passed`);
    if (!reasons.length) continue;
    stale.push({
      input_id: request.input_id,
      request: request.request,
      status: request.status,
      updated_at: request.updated_at,
      reasons,
      suggestion: `Ask whether this is still needed. A person can answer it, set a new date with "mole input-queue update ${request.input_id}", or close it with "--closure-reason stale". Nothing was closed.`
    });
  }
  return stale;
}

function legacyAsRequests(file, now) {
  return file.candidates
    .filter((candidate) => candidate.fields.status !== 'closed')
    .map((candidate) => ({
      input_id: `legacy:${candidate.line}`,
      revision: 0,
      request: candidate.fields.request,
      impact: candidate.fields.impact,
      unblocks: candidate.fields.unblocks,
      answer_format: candidate.fields.answer_format,
      effort: candidate.fields.effort,
      priority: candidate.fields.priority,
      blocking: candidate.fields.blocking,
      status: candidate.fields.status,
      requester: 'legacy queue',
      owner: candidate.fields.owner,
      due: candidate.fields.due,
      next_review: null,
      source_ids: [],
      references: [],
      duplicate_of: null,
      superseded_by: null,
      closure: null,
      legacy: candidate.legacy,
      // A legacy row carries no dates, so it is never reported as stale.
      created_at: now,
      updated_at: now,
      history: []
    }));
}

function summarize(entry, rank) {
  const { request } = entry;
  return {
    rank,
    input_id: request.input_id,
    score: entry.score,
    reasons: entry.reasons,
    request: request.request,
    impact: request.impact,
    unblocks: request.unblocks,
    answer_format: request.answer_format,
    effort: request.effort,
    priority: request.priority,
    blocking: request.blocking,
    status: request.status,
    owner: request.owner,
    due: request.due,
    source_ids: request.source_ids,
    references: request.references
  };
}

/**
 * The highest-value requests to answer now, with the reason for each rank,
 * and suggestions for stale and likely duplicate requests.  Read-only.
 * Rows still in the legacy Markdown table are ranked too, under a
 * `legacy:<line>` ID, until they are migrated.
 */
export function reviewInputQueue(instanceRoot, options = {}) {
  const { root, ledger } = loadLedger(instanceRoot);
  const limit = options.limit ?? DEFAULT_REVIEW_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail('The limit must be a whole number from 1 to 50.', 'INVALID_ARGUMENT', { limit });
  const staleAfterDays = options.staleAfterDays ?? options.stale_after_days ?? DEFAULT_STALE_AFTER_DAYS;
  if (!Number.isInteger(staleAfterDays) || staleAfterDays < 1) fail('The stale threshold must be a whole number of days, at least 1.', 'INVALID_ARGUMENT', { stale_after_days: staleAfterDays });
  const threshold = options.duplicateThreshold ?? options.duplicate_threshold ?? DEFAULT_DUPLICATE_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) fail('The duplicate threshold must be above 0 and at most 1.', 'INVALID_ARGUMENT', { duplicate_threshold: threshold });
  const now = toIsoTimestamp(options.now);

  const file = readQueueFile(root, ledger);
  const legacy = legacyAsRequests(file, now);
  const dated = ledger.requests.filter((request) => request.status !== 'closed');
  const everything = [...ledger.requests, ...legacy];
  const ranked = rankRequests(everything, now, staleAfterDays);
  const reviewable = ranked.map((entry) => entry.request);
  const duplicates = findDuplicateCandidates(everything.filter((request) => request.status !== 'closed'), threshold);
  const stale = findStaleCandidates(dated, now, staleAfterDays);

  const counts = Object.fromEntries(INPUT_STATUSES.map((status) => [status, 0]));
  for (const request of ledger.requests) counts[request.status] += 1;

  return {
    ok: true,
    read_only: true,
    generated_at: now,
    limit,
    top: ranked.slice(0, limit).map((entry, index) => summarize(entry, index + 1)),
    reviewable_count: reviewable.length,
    not_shown: Math.max(0, reviewable.length - limit),
    status_counts: counts,
    legacy_rows: file.candidates.length,
    stale_candidates: stale.slice(0, MAX_SUGGESTIONS),
    stale_candidate_count: stale.length,
    duplicate_candidates: duplicates.pairs,
    duplicate_candidate_count: duplicates.count,
    ranking: {
      rule: 'score = 40 if blocking + priority (high 30, medium 20, low 10) + due date (overdue 30, within 3 days 20, within 7 days 10) + 5 if untouched for the stale threshold. Ties go to the earlier due date, then the older request.',
      stale_after_days: staleAfterDays,
      duplicate_threshold: threshold
    },
    ...(file.viewPending ? { view_pending: true } : {}),
    ...(file.candidates.length ? { notice: `${file.candidates.length} ${file.candidates.length === 1 ? 'row' : 'rows'} in ${INPUT_QUEUE_VIEW_REL_PATH} ${file.candidates.length === 1 ? 'has' : 'have'} no stable ID yet. Run "mole input-queue migrate --apply --actor <name> --actor-type <type>".` } : {})
  };
}

export function readInputRequest(instanceRoot, inputId) {
  assertInputId(inputId);
  return findRequest(loadLedger(instanceRoot).ledger, inputId);
}

/** List requests.  Closed requests are left out unless asked for. */
export function listInputRequests(instanceRoot, options = {}) {
  const { ledger } = loadLedger(instanceRoot);
  const statuses = options.statuses ?? [];
  for (const status of statuses) {
    if (!INPUT_STATUSES.includes(status)) fail(`Unknown status: ${status}. Use one of ${INPUT_STATUSES.join(', ')}.`, 'INVALID_ARGUMENT', { status });
  }
  if (statuses.length) return ledger.requests.filter((request) => statuses.includes(request.status));
  return options.all === true ? ledger.requests : ledger.requests.filter((request) => request.status !== 'closed');
}

/** Report queue problems without changing anything. */
export function auditInputQueue(instanceRoot) {
  const root = normalizeRoot(instanceRoot);
  const state = readLedgerState(root);
  const findings = [];
  if (state.errors.length) {
    findings.push({ type: 'invalid_queue', path: INPUT_QUEUE_LEDGER_REL_PATH, errors: state.errors, action: 'Restore the ledger from version control or a backup. Until then the queue commands refuse to run.' });
  }
  const ledger = state.ledger ?? emptyLedger();
  let file = null;
  try {
    file = readQueueFile(root, ledger);
  } catch (error) {
    findings.push({ type: 'view_unreadable', path: INPUT_QUEUE_VIEW_REL_PATH, errors: [error.message], action: `Make ${INPUT_QUEUE_VIEW_REL_PATH} a regular, readable file. Queue changes are refused until then.` });
  }
  if (file?.parsed.markerError) {
    findings.push({
      type: 'view_markers_invalid',
      path: INPUT_QUEUE_VIEW_REL_PATH,
      errors: [file.parsed.markerError],
      action: 'Fix the marker lines, or delete them all. Queue changes are refused until then, because rewriting the table could delete text.'
    });
  }
  if (file && state.ledger && file.candidates.length) {
    findings.push({
      type: 'legacy_rows_pending',
      path: INPUT_QUEUE_VIEW_REL_PATH,
      lines: file.candidates.map((candidate) => candidate.line),
      action: 'Run "mole input-queue migrate --apply --actor <name> --actor-type <type>" to give these rows stable IDs. Queue changes are refused until then.'
    });
  }
  const unimportable = (file?.skipped || []).filter((item) => item.reason === 'request_missing');
  if (unimportable.length) {
    findings.push({
      type: 'legacy_rows_without_request',
      path: INPUT_QUEUE_VIEW_REL_PATH,
      lines: unimportable.map((item) => item.line),
      action: 'These rows have text but no request, so they cannot be imported. Fill in the Request cell, or move the text out of the table. A copy of the file is kept if a command removes the table.'
    });
  }
  if (file && state.ledger && state.exists && !file.parsed.markerError && !file.candidates.length) {
    const expected = viewRequests(ledger, new Date()).map((request) => request.input_id);
    const missing = expected.filter((inputId) => !file.shownIds.has(inputId));
    const extra = [...file.shownIds].filter((inputId) => !expected.includes(inputId));
    if (file.viewPending || (!file.parsed.markers ? ledger.requests.length > 0 : missing.length || extra.length)) {
      findings.push({
        type: 'view_stale',
        path: INPUT_QUEUE_VIEW_REL_PATH,
        missing_input_ids: missing,
        extra_input_ids: extra,
        action: 'The generated table does not match the queue. Run "mole input-queue refresh-view".'
      });
    }
    const plan = planView(root, ledger, {});
    // A stale table differs from the queue for a reason already reported.
    const stale = findings.some((item) => item.type === 'view_stale');
    const unmanaged = stale ? [] : plan.lost.filter((item) => !unimportable.some((row) => row.line === item.line));
    if (unmanaged.length) {
      findings.push({
        type: 'unmanaged_text_in_view',
        path: INPUT_QUEUE_VIEW_REL_PATH,
        lines: unmanaged.map((item) => item.line),
        action: 'These lines sit inside the generated block and are not what Mole generates from the queue: a note, an extra column, or a row edited by hand. The next queue change replaces the block, after keeping a copy of the file under governance/input-queue/legacy/. Move the text outside the marker lines to keep it in place, and change requests with "mole input-queue update".'
      });
    }
    if (plan.foreignTables.length) {
      findings.push({
        type: 'request_table_outside_view',
        advisory: true,
        path: INPUT_QUEUE_VIEW_REL_PATH,
        lines: plan.foreignTables,
        action: 'A table outside the generated block lists requests by their queue ID. Mole leaves it alone: it does not keep it current and does not import rows added to it. Add requests with "mole input-queue add". Delete the table if it is a stale copy of the generated one.'
      });
    }
  }
  if (!readViewPending(root).usable) {
    findings.push({
      type: 'view_pending_unusable',
      path: INPUT_QUEUE_VIEW_PENDING_REL_PATH,
      action: `${INPUT_QUEUE_VIEW_PENDING_REL_PATH} must be a regular file or absent. Remove it. Queue changes are refused until then.`
    });
  }
  const leftovers = [];
  for (const [directory, prefix] of [[state.paths.queueDir, ''], [path.dirname(state.paths.viewPath), `${path.basename(state.paths.viewPath)}.`]]) {
    let names = [];
    try {
      names = fs.readdirSync(directory);
    } catch {
      // The folder does not exist yet.
    }
    for (const name of names) {
      if (name.endsWith('.tmp') && name.startsWith(prefix)) leftovers.push(path.relative(root, path.join(directory, name)).split(path.sep).join('/'));
    }
  }
  if (leftovers.length) {
    findings.push({ type: 'stale_temp_file', paths: leftovers.sort(), action: 'An interrupted write left these files. Delete them once no queue command is running.' });
  }
  if (fs.existsSync(state.paths.lockPath)) {
    const lock = lockHolderState(state.paths.lockPath);
    if (lock.stopped || !lock.holder) {
      findings.push({ type: 'stale_lock', holder: lock.holder, action: 'Run "mole input-queue unlock" to remove the lock left by a stopped process.' });
    } else if (lock.foreign) {
      findings.push({ type: 'foreign_lock', holder: lock.holder, action: `The lock was taken on another host (${lock.holder.host}). If no command is running there, delete ${INPUT_QUEUE_LOCK_REL_PATH}. Queue changes are refused while it exists.` });
    }
  }
  return {
    // An advisory finding is worth knowing and needs no action.
    ok: findings.every((item) => item.advisory === true),
    read_only: true,
    ledger_path: INPUT_QUEUE_LEDGER_REL_PATH,
    ledger_exists: state.exists,
    queue_revision: state.ledger ? state.ledger.queue_revision : null,
    request_count: state.ledger ? state.ledger.requests.length : null,
    findings
  };
}
