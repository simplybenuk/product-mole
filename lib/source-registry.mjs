import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/**
 * The source registry is deliberately file-native.  A record is the only
 * mutable provenance document for a source; source bytes remain wherever the
 * workspace stores them.
 */

export const SOURCE_SCHEMA_VERSION = 1;
export const SOURCE_SCHEMA_REL_PATH = path.join('schemas', 'source-record-v1.schema.json');
export const SOURCE_ROOT_REL_PATH = path.join('governance', 'sources');
export const SOURCE_RECORDS_REL_PATH = path.join(SOURCE_ROOT_REL_PATH, 'records');
export const SOURCE_ID_PATTERN = /^src_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SOURCE_TYPES = new Set(['note', 'file', 'attachment', 'export', 'external', 'other']);
export const RETENTION_MODES = new Set(['retain', 'archive', 'review']);

const RECORD_FIELDS = [
  'schema_version',
  'record_revision',
  'source_id',
  'source_type',
  'media_type',
  'original_date',
  'captured_at',
  'captured_by',
  'channel',
  'source_reference',
  'original_path',
  'current_path',
  'path_history',
  'content_hash',
  'byte_size',
  'content_history',
  'attachments',
  'parent_source_id',
  'visibility',
  'retention',
  'created_at',
  'updated_at'
];

const PATH_HISTORY_FIELDS = new Set(['path', 'valid_from', 'valid_to', 'reason']);
const CONTENT_HISTORY_FIELDS = new Set(['recorded_at', 'hash', 'byte_size', 'change_type', 'reason']);
const HASH_FIELDS = new Set(['algorithm', 'value']);
const ATTACHMENT_FIELDS = new Set(['source_id', 'relationship', 'label']);
const RETENTION_FIELDS = new Set(['mode', 'review_after', 'expires_at']);
const SOURCE_REFERENCE_FIELDS = new Set(['kind', 'value']);

export class SourceRegistryError extends Error {
  constructor(message, code = 'SOURCE_REGISTRY_ERROR', details = {}) {
    super(message);
    this.name = 'SourceRegistryError';
    this.code = code;
    this.details = details;
  }
}

function fail(message, code, details = {}) {
  throw new SourceRegistryError(message, code, details);
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toPortablePath(value) {
  return String(value).split(path.sep).join('/');
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isDateTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function isDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function toIsoTimestamp(value, fallback = new Date()) {
  const candidate = value === undefined || value === null ? fallback : value;
  const date = candidate instanceof Date ? new Date(candidate.getTime()) : new Date(candidate);
  if (Number.isNaN(date.getTime())) fail(`Invalid timestamp: ${candidate}`, 'INVALID_TIMESTAMP');
  return date.toISOString();
}

function normalizeInstanceRoot(instanceRoot = process.cwd()) {
  const root = path.resolve(String(instanceRoot));
  if (!fs.existsSync(root)) fail(`Workspace root does not exist: ${root}`, 'WORKSPACE_NOT_FOUND');
  if (!fs.statSync(root).isDirectory()) fail(`Workspace root is not a directory: ${root}`, 'WORKSPACE_NOT_DIRECTORY');
  return root;
}

function assertNoExternalSymlink(root, target) {
  const rootAbsolute = path.resolve(root);
  const targetAbsolute = path.resolve(target);
  if (!isWithin(rootAbsolute, targetAbsolute)) {
    fail(`Path escapes the workspace: ${targetAbsolute}`, 'WORKSPACE_ESCAPE', { path: targetAbsolute });
  }

  const rootReal = fs.realpathSync.native(rootAbsolute);
  const relative = path.relative(rootAbsolute, targetAbsolute);
  let current = rootAbsolute;
  for (const component of relative ? relative.split(path.sep) : []) {
    current = path.join(current, component);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (!stat.isSymbolicLink()) continue;
    const resolved = fs.realpathSync.native(current);
    if (!isWithin(rootReal, resolved)) {
      fail(`Symlink resolves outside the workspace: ${toPortablePath(path.relative(rootAbsolute, current))}`, 'SYMLINK_ESCAPE', {
        path: toPortablePath(path.relative(rootAbsolute, current)),
        resolved
      });
    }
  }
}

function hasTraversalSegments(value) {
  const portable = String(value).replaceAll('\\', '/');
  return portable.split('/').some((part) => part === '..');
}

/**
 * Convert a user path to portable workspace-relative metadata.  Absolute paths
 * are accepted as input convenience, but never persisted as metadata.
 */
export function toWorkspaceRelativePath(instanceRoot, value, options = {}) {
  const root = normalizeInstanceRoot(instanceRoot);
  if (value === null || value === undefined || value === '') {
    if (options.allowNull) return null;
    fail('A workspace-relative path is required.', 'INVALID_PATH');
  }

  const text = String(value).trim();
  if (!text || text.includes('\0')) fail('Path is empty or contains a NUL byte.', 'INVALID_PATH');

  let absolute;
  if (path.isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text)) {
    absolute = path.resolve(text);
  } else {
    const portableInput = text.replaceAll('\\', '/');
    if (portableInput.startsWith('/') || hasTraversalSegments(portableInput)) {
      fail(`Path must remain within the workspace: ${text}`, 'WORKSPACE_ESCAPE', { path: text });
    }
    absolute = path.resolve(root, ...portableInput.split('/'));
  }

  if (!isWithin(root, absolute)) {
    fail(`Path escapes the workspace: ${text}`, 'WORKSPACE_ESCAPE', { path: text });
  }
  assertNoExternalSymlink(root, absolute);

  const relative = toPortablePath(path.relative(root, absolute));
  if (!relative || relative === '.') fail('The workspace root is not a source file path.', 'INVALID_PATH');

  if (options.requireExisting) {
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') fail(`Source path does not exist: ${relative}`, 'SOURCE_NOT_FOUND', { path: relative });
      throw error;
    }
    if (!stat.isFile()) fail(`Source path is not a regular file: ${relative}`, 'SOURCE_NOT_FILE', { path: relative });
  }

  return relative;
}

function absoluteWorkspacePath(instanceRoot, relativePath, options = {}) {
  const root = normalizeInstanceRoot(instanceRoot);
  const relative = toWorkspaceRelativePath(root, relativePath, options);
  const absolute = path.resolve(root, ...relative.split('/'));
  assertNoExternalSymlink(root, absolute);
  return { root, relative, absolute };
}

export function createSourceId() {
  return `src_${randomUUID()}`;
}

export const generateSourceId = createSourceId;

export function isSourceId(value) {
  return typeof value === 'string' && SOURCE_ID_PATTERN.test(value);
}

export function assertSourceId(value) {
  if (!isSourceId(value)) fail(`Invalid source ID: ${value}`, 'INVALID_SOURCE_ID', { source_id: value });
  return value;
}

function normalizeHash(value) {
  if (!asObject(value) || value.algorithm !== 'sha256' || typeof value.value !== 'string' || !/^[0-9a-f]{64}$/.test(value.value)) {
    fail('Content hashes must use lowercase SHA-256 values.', 'INVALID_HASH', { hash: value });
  }
  return { algorithm: 'sha256', value: value.value };
}

function hashFileFromHandle(filePath) {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let byteSize = 0;
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
        byteSize += bytesRead;
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return { algorithm: 'sha256', value: hash.digest('hex'), byte_size: byteSize };
}

/** Synchronous, chunked hashing for the synchronous registry API. */
export function hashFileSync(filePath) {
  const absolute = path.resolve(String(filePath));
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) fail(`Cannot hash a non-file path: ${absolute}`, 'SOURCE_NOT_FILE');
  return hashFileFromHandle(absolute);
}

/**
 * Asynchronous streaming hashing for callers that do not want to block the
 * event loop while registering a large export.
 */
export async function hashFile(filePath) {
  const absolute = path.resolve(String(filePath));
  const stat = await fs.promises.stat(absolute);
  if (!stat.isFile()) fail(`Cannot hash a non-file path: ${absolute}`, 'SOURCE_NOT_FILE');

  const hash = createHash('sha256');
  let byteSize = 0;
  const stream = fs.createReadStream(absolute);
  for await (const chunk of stream) {
    hash.update(chunk);
    byteSize += chunk.length;
  }
  return { algorithm: 'sha256', value: hash.digest('hex'), byte_size: byteSize };
}

export const hashSourceFile = hashFile;
export const hashSourceFileSync = hashFileSync;

export function getSourceRegistryPaths(instanceRoot = process.cwd()) {
  const root = path.resolve(String(instanceRoot));
  const sourceRoot = path.join(root, SOURCE_ROOT_REL_PATH);
  const recordsDir = path.join(root, SOURCE_RECORDS_REL_PATH);
  return {
    workspaceRoot: root,
    sourceRoot,
    sourceRootPath: sourceRoot,
    sourceRootRelPath: toPortablePath(SOURCE_ROOT_REL_PATH),
    recordsDir,
    recordsPath: recordsDir,
    recordsRelPath: toPortablePath(SOURCE_RECORDS_REL_PATH),
    schemaPath: path.join(root, SOURCE_SCHEMA_REL_PATH)
  };
}

export function ensureSourceRegistry(instanceRoot = process.cwd()) {
  const root = normalizeInstanceRoot(instanceRoot);
  const paths = getSourceRegistryPaths(root);
  assertNoExternalSymlink(root, paths.sourceRoot);
  assertNoExternalSymlink(root, paths.recordsDir);
  fs.mkdirSync(paths.recordsDir, { recursive: true });
  assertNoExternalSymlink(root, paths.recordsDir);
  return paths;
}

export const ensureSourceRegistryDirectories = ensureSourceRegistry;

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SourceRegistryError(`Invalid JSON in source record: ${filePath}`, 'INVALID_RECORD_JSON', { path: filePath, cause: error });
    }
    throw error;
  }
}

function writeJsonAtomically(filePath, data, options = {}) {
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });

  if (options.exclusive) {
    try {
      fs.writeFileSync(filePath, payload, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new SourceRegistryError(`Source record already exists: ${filePath}`, 'SOURCE_RECORD_EXISTS', { path: filePath });
      }
      throw error;
    }
    return;
  }

  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, payload, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function keysOnly(value) {
  return Object.keys(value).sort();
}

function checkExactKeys(value, expected, label, errors) {
  if (!asObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const allowed = expected instanceof Set ? expected : new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
  }
}

function checkHash(value, label, errors) {
  if (!asObject(value)) {
    errors.push(`${label} must be an object or null`);
    return;
  }
  checkExactKeys(value, HASH_FIELDS, label, errors);
  if (value.algorithm !== 'sha256') errors.push(`${label}.algorithm must be sha256`);
  if (typeof value.value !== 'string' || !/^[0-9a-f]{64}$/.test(value.value)) errors.push(`${label}.value must be a lowercase SHA-256 digest`);
}

function checkPathMetadata(value, label, errors, options = {}) {
  if (value === null && options.allowNull) return;
  if (typeof value !== 'string' || !value) {
    errors.push(`${label} must be a non-empty workspace-relative path or null`);
    return;
  }
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value) || hasTraversalSegments(value) || path.posix.normalize(value) !== value || value === '.') {
    errors.push(`${label} must use a normalized workspace-relative path`);
  }
}

function checkIso(value, label, errors, options = {}) {
  if (value === null && options.allowNull) return;
  if (!isDateTime(value)) errors.push(`${label} must be an RFC 3339 UTC timestamp with millisecond precision`);
}

/**
 * Validate a source record without requiring a third-party JSON-schema
 * package.  The returned object is stable for agents and tests; callers that
 * need fail-fast behaviour can use assertValidSourceRecord.
 */
export function validateSourceRecord(record, options = {}) {
  const errors = [];
  if (!asObject(record)) return { valid: false, errors: ['record must be an object'] };

  checkExactKeys(record, RECORD_FIELDS, 'record', errors);
  for (const field of RECORD_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) errors.push(`record.${field} is required`);
  }

  if (record.schema_version !== SOURCE_SCHEMA_VERSION) errors.push('record.schema_version must be 1');
  if (!Number.isInteger(record.record_revision) || record.record_revision < 1) errors.push('record.record_revision must be a positive integer');
  if (!isSourceId(record.source_id)) errors.push('record.source_id must be a lowercase src_ UUIDv4');
  if (!SOURCE_TYPES.has(record.source_type)) errors.push(`record.source_type must be one of ${[...SOURCE_TYPES].join(', ')}`);
  if (!(record.media_type === null || typeof record.media_type === 'string')) errors.push('record.media_type must be a string or null');
  if (!(record.original_date === null || isDateOnly(record.original_date))) errors.push('record.original_date must be YYYY-MM-DD or null');
  checkIso(record.captured_at, 'record.captured_at', errors);
  if (typeof record.captured_by !== 'string' || !record.captured_by.trim()) errors.push('record.captured_by must be a non-empty string');
  if (!(record.channel === null || (typeof record.channel === 'string' && record.channel.trim()))) errors.push('record.channel must be a non-empty string or null');

  if (record.source_reference !== null) {
    checkExactKeys(record.source_reference, SOURCE_REFERENCE_FIELDS, 'record.source_reference', errors);
    if (!asObject(record.source_reference) || typeof record.source_reference.kind !== 'string' || !record.source_reference.kind.trim()) errors.push('record.source_reference.kind is required');
    if (!asObject(record.source_reference) || typeof record.source_reference.value !== 'string' || !record.source_reference.value.trim()) errors.push('record.source_reference.value is required');
  }

  checkPathMetadata(record.original_path, 'record.original_path', errors, { allowNull: true });
  checkPathMetadata(record.current_path, 'record.current_path', errors, { allowNull: true });

  if (!Array.isArray(record.path_history)) {
    errors.push('record.path_history must be an array');
  } else {
    let openCount = 0;
    for (let index = 0; index < record.path_history.length; index += 1) {
      const item = record.path_history[index];
      const label = `record.path_history[${index}]`;
      checkExactKeys(item, PATH_HISTORY_FIELDS, label, errors);
      if (!asObject(item) || typeof item.path !== 'string' || !item.path) errors.push(`${label}.path is required`);
      else checkPathMetadata(item.path, `${label}.path`, errors);
      checkIso(item?.valid_from, `${label}.valid_from`, errors);
      checkIso(item?.valid_to, `${label}.valid_to`, errors, { allowNull: true });
      if (typeof item?.reason !== 'string' || !item.reason.trim()) errors.push(`${label}.reason is required`);
      if (item?.valid_to === null) openCount += 1;
      if (item?.valid_to && item?.valid_from && Date.parse(item.valid_to) < Date.parse(item.valid_from)) errors.push(`${label}.valid_to cannot precede valid_from`);
      if (index > 0 && item?.valid_from && record.path_history[index - 1]?.valid_from && Date.parse(item.valid_from) < Date.parse(record.path_history[index - 1].valid_from)) errors.push('record.path_history must be ordered by valid_from');
    }
    if (openCount > 1) errors.push('record.path_history may contain only one open interval');
    if (record.current_path === null && openCount > 0) errors.push('record.current_path must be set when path history is open');
    if (record.current_path !== null && openCount !== 1) errors.push('record.current_path requires one open path-history interval');
    const current = [...record.path_history].reverse().find((item) => item?.valid_to === null);
    if (current && current.path !== record.current_path) errors.push('record.current_path must equal the open path-history path');
    if (record.original_path !== null && record.path_history[0]?.path !== record.original_path) errors.push('record.original_path must equal the first path-history path');
  }

  if (record.content_hash === null) {
    if (record.byte_size !== null) errors.push('record.byte_size must be null when content_hash is null');
  } else {
    checkHash(record.content_hash, 'record.content_hash', errors);
    if (!Number.isInteger(record.byte_size) || record.byte_size < 0) errors.push('record.byte_size must be a non-negative integer when content_hash is present');
  }

  if (!Array.isArray(record.content_history)) {
    errors.push('record.content_history must be an array');
  } else {
    for (let index = 0; index < record.content_history.length; index += 1) {
      const item = record.content_history[index];
      const label = `record.content_history[${index}]`;
      checkExactKeys(item, CONTENT_HISTORY_FIELDS, label, errors);
      checkIso(item?.recorded_at, `${label}.recorded_at`, errors);
      checkHash(item?.hash, `${label}.hash`, errors);
      if (!Number.isInteger(item?.byte_size) || item.byte_size < 0) errors.push(`${label}.byte_size must be a non-negative integer`);
      if (typeof item?.change_type !== 'string' || !item.change_type.trim()) errors.push(`${label}.change_type is required`);
      if (!(item?.reason === null || typeof item?.reason === 'string')) errors.push(`${label}.reason must be a string or null`);
      if (index > 0 && item?.recorded_at && record.content_history[index - 1]?.recorded_at && Date.parse(item.recorded_at) < Date.parse(record.content_history[index - 1].recorded_at)) errors.push('record.content_history must be ordered by recorded_at');
    }
    const latest = record.content_history[record.content_history.length - 1];
    if (record.content_hash === null && record.content_history.length > 0) errors.push('record.content_history must be empty when content_hash is null');
    if (record.content_hash && latest && (latest.hash?.value !== record.content_hash.value || latest.byte_size !== record.byte_size)) errors.push('record.content_hash must match the latest content-history entry');
  }

  if (!Array.isArray(record.attachments)) {
    errors.push('record.attachments must be an array');
  } else {
    const attachmentIds = new Set();
    for (let index = 0; index < record.attachments.length; index += 1) {
      const item = record.attachments[index];
      const label = `record.attachments[${index}]`;
      checkExactKeys(item, ATTACHMENT_FIELDS, label, errors);
      if (!isSourceId(item?.source_id)) errors.push(`${label}.source_id must be a source ID`);
      if (attachmentIds.has(item?.source_id)) errors.push(`${label}.source_id is duplicated`);
      attachmentIds.add(item?.source_id);
      if (typeof item?.relationship !== 'string' || !item.relationship.trim()) errors.push(`${label}.relationship is required`);
      if (typeof item?.label !== 'string' || !item.label.trim()) errors.push(`${label}.label is required`);
    }
  }

  if (!(record.parent_source_id === null || isSourceId(record.parent_source_id))) errors.push('record.parent_source_id must be a source ID or null');
  if (record.parent_source_id === record.source_id) errors.push('record.parent_source_id cannot equal source_id');
  if (typeof record.visibility !== 'string' || !record.visibility.trim()) errors.push('record.visibility must be a non-empty string');
  if (!asObject(record.retention)) {
    errors.push('record.retention must be an object');
  } else {
    checkExactKeys(record.retention, RETENTION_FIELDS, 'record.retention', errors);
    if (!RETENTION_MODES.has(record.retention.mode)) errors.push('record.retention.mode is invalid');
    checkIso(record.retention.review_after, 'record.retention.review_after', errors, { allowNull: true });
    checkIso(record.retention.expires_at, 'record.retention.expires_at', errors, { allowNull: true });
  }
  checkIso(record.created_at, 'record.created_at', errors);
  checkIso(record.updated_at, 'record.updated_at', errors);
  if (isDateTime(record.created_at) && isDateTime(record.updated_at) && Date.parse(record.updated_at) < Date.parse(record.created_at)) errors.push('record.updated_at cannot precede created_at');
  if (isDateTime(record.captured_at) && isDateTime(record.created_at) && Date.parse(record.created_at) < Date.parse(record.captured_at)) errors.push('record.created_at cannot precede captured_at');

  if (options.instanceRoot) {
    for (const [label, value] of [['original_path', record.original_path], ['current_path', record.current_path]]) {
      if (value !== null) {
        try {
          toWorkspaceRelativePath(options.instanceRoot, value);
        } catch (error) {
          errors.push(`${label}: ${error.message}`);
        }
      }
    }
    for (const item of record.path_history || []) {
      try {
        toWorkspaceRelativePath(options.instanceRoot, item.path);
      } catch (error) {
        errors.push(`path_history.path: ${error.message}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function isValidSourceRecord(record, options = {}) {
  return validateSourceRecord(record, options).valid;
}

export function assertValidSourceRecord(record, options = {}) {
  const result = validateSourceRecord(record, options);
  if (!result.valid) {
    throw new SourceRegistryError(`Invalid source record: ${result.errors.join('; ')}`, 'INVALID_SOURCE_RECORD', { errors: result.errors, record });
  }
  return record;
}

function parseSourceCall(first, second, third) {
  if (typeof first === 'string' && typeof second === 'string') {
    return { root: normalizeInstanceRoot(first), sourceId: second, options: third || {} };
  }
  const options = (first && typeof first === 'object') ? first : {};
  const root = normalizeInstanceRoot(options.instanceRoot || first || process.cwd());
  return { root, sourceId: options.sourceId || options.id, options };
}

function sourceRecordPath(instanceRoot, sourceId) {
  const root = normalizeInstanceRoot(instanceRoot);
  assertSourceId(sourceId);
  const recordsDir = getSourceRegistryPaths(root).recordsDir;
  assertNoExternalSymlink(root, recordsDir);
  return path.join(recordsDir, `${sourceId}.json`);
}

export function getSourceRecordPath(instanceRoot, sourceId) {
  return sourceRecordPath(instanceRoot, sourceId);
}

function scanRecordFiles(instanceRoot) {
  const root = normalizeInstanceRoot(instanceRoot);
  const recordsDir = getSourceRegistryPaths(root).recordsDir;
  if (!fs.existsSync(recordsDir)) return [];
  assertNoExternalSymlink(root, recordsDir);
  const files = [];
  const queue = [recordsDir];
  while (queue.length) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          assertNoExternalSymlink(root, absolute);
        } catch {
          continue;
        }
        continue;
      }
      if (entry.isDirectory()) queue.push(absolute);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(absolute);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function readRecordFile(instanceRoot, filePath) {
  const root = normalizeInstanceRoot(instanceRoot);
  assertNoExternalSymlink(root, filePath);
  const record = readJsonFile(filePath);
  const validation = validateSourceRecord(record, { instanceRoot: root });
  return { filePath, record, validation };
}

export function readSourceRecord(instanceRoot, sourceId) {
  const root = normalizeInstanceRoot(instanceRoot);
  assertSourceId(sourceId);
  const filePath = sourceRecordPath(root, sourceId);
  if (!fs.existsSync(filePath)) return null;
  const result = readRecordFile(root, filePath);
  if (!result.validation.valid) {
    throw new SourceRegistryError(`Invalid source record: ${filePath}`, 'INVALID_SOURCE_RECORD', { errors: result.validation.errors, path: filePath });
  }
  return result.record;
}

export const loadSourceRecord = readSourceRecord;
export const getSourceRecord = readSourceRecord;

export function writeSourceRecord(instanceRoot, record, options = {}) {
  const root = normalizeInstanceRoot(instanceRoot);
  assertValidSourceRecord(record, { instanceRoot: root });
  const filePath = sourceRecordPath(root, record.source_id);
  const paths = ensureSourceRegistry(root);
  assertNoExternalSymlink(root, filePath);
  writeJsonAtomically(filePath, record, { exclusive: options.exclusive === true });
  return {
    record,
    source_id: record.source_id,
    sourceId: record.source_id,
    record_path: toPortablePath(path.relative(root, filePath)),
    recordPath: filePath,
    paths
  };
}

export const persistSourceRecord = writeSourceRecord;

function normalizeRegistrationArgs(first, second) {
  if (typeof first === 'string') return { root: normalizeInstanceRoot(first), options: second || {} };
  const options = first && typeof first === 'object' ? first : {};
  return { root: normalizeInstanceRoot(options.instanceRoot || process.cwd()), options };
}

function inferMediaType(filePath, explicit) {
  if (explicit !== undefined) return explicit;
  if (!filePath) return null;
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.md' || extension === '.markdown') return 'text/markdown';
  if (extension === '.txt') return 'text/plain';
  if (extension === '.json') return 'application/json';
  if (extension === '.csv') return 'text/csv';
  return null;
}

function normalizeRetention(value) {
  const retention = value || {};
  return {
    mode: retention.mode || 'retain',
    review_after: retention.review_after ?? retention.reviewAfter ?? null,
    expires_at: retention.expires_at ?? retention.expiresAt ?? null
  };
}

function buildSourceRecord(root, options = {}) {
  const capturedAt = toIsoTimestamp(options.captured_at ?? options.capturedAt ?? options.now);
  const sourceType = options.source_type ?? options.sourceType ?? (options.external ? 'external' : 'file');
  if (!SOURCE_TYPES.has(sourceType)) fail(`Unsupported source type: ${sourceType}`, 'INVALID_SOURCE_TYPE');

  const pathInput = options.path ?? options.filePath ?? options.file_path ?? options.current_path ?? options.currentPath ?? null;
  const localPath = pathInput === null || pathInput === undefined || pathInput === '' ? null : toWorkspaceRelativePath(root, pathInput, { requireExisting: true });
  const originalPath = options.original_path ?? options.originalPath ?? localPath;
  const normalizedOriginalPath = originalPath === null || originalPath === undefined || originalPath === '' ? null : toWorkspaceRelativePath(root, originalPath);
  const sourceId = options.source_id ?? options.sourceId ?? options.id ?? createSourceId();
  assertSourceId(sourceId);
  const localAbsolute = localPath ? path.resolve(root, ...localPath.split('/')) : null;
  const fileHash = localAbsolute ? hashFileSync(localAbsolute) : null;
  const hash = fileHash ? { algorithm: 'sha256', value: fileHash.value } : (options.content_hash ?? options.contentHash ?? null);
  const byteSize = fileHash ? fileHash.byte_size : (hash ? options.byte_size ?? options.byteSize ?? null : null);
  if (hash) normalizeHash(hash);
  if (hash && !Number.isInteger(byteSize)) fail('byte_size is required when registering externally supplied content hash.', 'INVALID_BYTE_SIZE');

  const channel = options.channel ?? null;
  const capturedBy = String(options.captured_by ?? options.capturedBy ?? process.env.MOLE_CAPTURED_BY ?? process.env.USER ?? process.env.USERNAME ?? 'unknown').trim() || 'unknown';
  const originalDate = options.original_date ?? options.originalDate ?? null;
  const sourceReference = options.source_reference ?? options.sourceReference ?? null;
  const visibility = String(options.visibility ?? 'internal').trim() || 'internal';
  const retention = normalizeRetention(options.retention);
  const pathReason = options.path_reason ?? options.pathReason ?? (sourceType === 'note' ? 'captured' : 'registered');
  const contentChangeType = options.content_change_type ?? options.contentChangeType ?? pathReason;
  const pathHistory = localPath ? [{ path: localPath, valid_from: capturedAt, valid_to: null, reason: pathReason }] : [];
  const contentHistory = hash ? [{
    recorded_at: capturedAt,
    hash: normalizeHash(hash),
    byte_size: byteSize,
    change_type: contentChangeType,
    reason: options.reason ?? null
  }] : [];

  return {
    schema_version: SOURCE_SCHEMA_VERSION,
    record_revision: Number.isInteger(options.record_revision ?? options.recordRevision) ? (options.record_revision ?? options.recordRevision) : 1,
    source_id: sourceId,
    source_type: sourceType,
    media_type: inferMediaType(localPath, options.media_type ?? options.mediaType),
    original_date: originalDate,
    captured_at: capturedAt,
    captured_by: capturedBy,
    channel,
    source_reference: sourceReference,
    original_path: normalizedOriginalPath,
    current_path: localPath,
    path_history: pathHistory,
    content_hash: hash ? normalizeHash(hash) : null,
    byte_size: hash ? byteSize : null,
    content_history: contentHistory,
    attachments: Array.isArray(options.attachments) ? options.attachments : [],
    parent_source_id: options.parent_source_id ?? options.parentSourceId ?? null,
    visibility,
    retention,
    created_at: options.created_at ?? options.createdAt ?? capturedAt,
    updated_at: options.updated_at ?? options.updatedAt ?? capturedAt
  };
}

export function buildSourceRecordForRegistration(instanceRoot, options = {}) {
  const { root, options: registrationOptions } = normalizeRegistrationArgs(instanceRoot, options);
  return buildSourceRecord(root, registrationOptions);
}

export const createSourceRecordData = buildSourceRecordForRegistration;

export function registerSource(instanceRoot, options = {}, maybeOptions = {}) {
  const normalizedOptions = typeof options === 'string'
    ? { ...(maybeOptions || {}), path: options }
    : options;
  const { root, options: registrationOptions } = normalizeRegistrationArgs(instanceRoot, normalizedOptions);
  const record = buildSourceRecord(root, registrationOptions);
  const result = writeSourceRecord(root, record, { exclusive: true });
  return {
    ok: true,
    source_id: record.source_id,
    sourceId: record.source_id,
    path: record.current_path,
    current_path: record.current_path,
    record,
    record_path: result.record_path,
    recordPath: result.recordPath,
    content_hash: record.content_hash,
    byte_size: record.byte_size
  };
}

export const registerSourceFile = registerSource;
export const createSourceRecord = registerSource;

function walkWorkspaceFiles(root, roots, options = {}) {
  const files = [];
  const visitedDirectories = new Set();
  const queue = roots.map((value) => {
    const normalized = toWorkspaceRelativePath(root, value);
    return path.resolve(root, ...normalized.split('/'));
  });
  while (queue.length) {
    const current = queue.pop();
    if (visitedDirectories.has(current)) continue;
    visitedDirectories.add(current);
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = toPortablePath(path.relative(root, absolute));
      if (options.exclude?.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))) continue;
      if (entry.isSymbolicLink()) {
        try {
          assertNoExternalSymlink(root, absolute);
          const stat = fs.statSync(absolute);
          if (stat.isDirectory()) {
            const real = fs.realpathSync.native(absolute);
            if (!visitedDirectories.has(real)) queue.push(absolute);
          } else if (stat.isFile()) files.push({ absolute, relative });
        } catch {
          // External links are reported by the caller when they are referenced;
          // archive discovery simply does not follow them.
        }
      } else if (entry.isDirectory()) {
        queue.push(absolute);
      } else if (entry.isFile()) {
        files.push({ absolute, relative });
      }
    }
  }
  return files;
}

function sourceRoots(root, options = {}) {
  const configured = options.sourceRoots ?? options.roots;
  if (configured && !Array.isArray(configured)) fail('sourceRoots must be an array.', 'INVALID_SOURCE_ROOTS');
  return configured?.length ? configured : ['6-raw', '5-evidence/source-docs'];
}

function loadAllRecordEntries(root) {
  return scanRecordFiles(root).map((filePath) => {
    try {
      return readRecordFile(root, filePath);
    } catch (error) {
      return {
        filePath,
        record: null,
        validation: { valid: false, errors: [error.message] },
        error
      };
    }
  });
}

function finding(type, details = {}) {
  return { type, finding_type: type, ...details };
}

function fileRelative(root, absolute) {
  return toPortablePath(path.relative(root, absolute));
}

/**
 * Scan records and source files for actionable integrity findings.  The scan
 * is intentionally report-only: it never merges, deletes, or rewrites data.
 */
export function findRegistryFindings(instanceRoot = process.cwd(), options = {}) {
  const root = normalizeInstanceRoot(instanceRoot);
  const entries = loadAllRecordEntries(root);
  const findings = [];
  const byId = new Map();
  const byHash = new Map();
  const byPath = new Map();

  for (const entry of entries) {
    if (!entry.record) {
      findings.push(finding('invalid_record', { record_path: fileRelative(root, entry.filePath), errors: entry.validation.errors }));
      continue;
    }
    const record = entry.record;
    if (!entry.validation.valid) {
      findings.push(finding('invalid_record', {
        source_id: record.source_id,
        record_path: fileRelative(root, entry.filePath),
        errors: entry.validation.errors
      }));
    }
    const idEntries = byId.get(record.source_id) || [];
    idEntries.push(entry);
    byId.set(record.source_id, idEntries);
    const expectedName = `${record.source_id}.json`;
    if (path.basename(entry.filePath) !== expectedName) {
      findings.push(finding('record_filename_conflict', {
        source_id: record.source_id,
        record_path: fileRelative(root, entry.filePath),
        expected_record_path: toPortablePath(path.join(SOURCE_RECORDS_REL_PATH, expectedName)),
        action: 'Rename or recover the record after reviewing the duplicate-safe registry findings.'
      }));
    }
    if (record.content_hash?.value) {
      const hashEntries = byHash.get(record.content_hash.value) || [];
      hashEntries.push(entry);
      byHash.set(record.content_hash.value, hashEntries);
    }
    if (record.current_path) {
      const pathEntries = byPath.get(record.current_path) || [];
      pathEntries.push(entry);
      byPath.set(record.current_path, pathEntries);
    }
    if (record.current_path) {
      try {
        const { absolute } = absoluteWorkspacePath(root, record.current_path);
        if (!fs.existsSync(absolute)) {
          findings.push(finding('orphan_record', {
            source_id: record.source_id,
            record_path: fileRelative(root, entry.filePath),
            current_path: record.current_path,
            action: 'Locate the source, reconcile its path, or mark the source unresolved.'
          }));
        } else if (record.content_hash) {
          const actual = hashFileSync(absolute);
          if (actual.value !== record.content_hash.value || actual.byte_size !== record.byte_size) {
            findings.push(finding('content_conflict', {
              source_id: record.source_id,
              current_path: record.current_path,
              expected_hash: record.content_hash,
              actual_hash: { algorithm: 'sha256', value: actual.value },
              expected_byte_size: record.byte_size,
              actual_byte_size: actual.byte_size,
              action: 'Use explicit correction for the same logical source or register a new source.'
            }));
          }
        }
      } catch (error) {
        findings.push(finding(error.code === 'SYMLINK_ESCAPE' ? 'symlink_escape' : 'workspace_escape', {
          source_id: record.source_id,
          current_path: record.current_path,
          error: error.message,
          action: 'Keep the record and source inside the workspace before resolving it.'
        }));
      }
    }
  }

  for (const [sourceId, idEntries] of byId) {
    if (idEntries.length > 1) {
      findings.push(finding('duplicate_record', {
        source_id: sourceId,
        record_paths: idEntries.map((entry) => fileRelative(root, entry.filePath)),
        revisions: idEntries.map((entry) => entry.record.record_revision),
        action: 'Preserve both records and require review; Mole never merges duplicate records automatically.'
      }));
      const revisions = new Map();
      for (const entry of idEntries) {
        const revisionEntries = revisions.get(entry.record.record_revision) || [];
        revisionEntries.push(entry);
        revisions.set(entry.record.record_revision, revisionEntries);
      }
      for (const [revision, revisionEntries] of revisions) {
        if (revisionEntries.length > 1) {
          const serialized = new Set(revisionEntries.map((entry) => JSON.stringify(entry.record)));
          if (serialized.size > 1) {
            findings.push(finding('revision_conflict', {
              source_id: sourceId,
              record_revision: revision,
              record_paths: revisionEntries.map((entry) => fileRelative(root, entry.filePath)),
              action: 'Preserve divergent copies and require manual review.'
            }));
          }
        }
      }
    }
  }

  for (const [hash, hashEntries] of byHash) {
    const ids = [...new Set(hashEntries.map((entry) => entry.record.source_id))];
    if (ids.length > 1) {
      findings.push(finding('duplicate_content', {
        source_ids: ids,
        content_hash: { algorithm: 'sha256', value: hash },
        record_paths: hashEntries.map((entry) => fileRelative(root, entry.filePath)),
        action: 'Keep both identities unless a human confirms they represent one source.'
      }));
    }
  }

  for (const [claimedPath, pathEntries] of byPath) {
    const ids = [...new Set(pathEntries.map((entry) => entry.record.source_id))];
    if (ids.length > 1) {
      findings.push(finding('path_claim_conflict', {
        current_path: claimedPath,
        source_ids: ids,
        action: 'Resolve the competing path claims manually before reconciling either source.'
      }));
    }
  }

  const knownIds = new Set(byId.keys());
  const sourceFiles = walkWorkspaceFiles(root, sourceRoots(root, options), {
    exclude: [toPortablePath(SOURCE_RECORDS_REL_PATH)]
  });
  for (const file of sourceFiles) {
    let prefix;
    try {
      prefix = fs.readFileSync(file.absolute, { encoding: 'utf8', flag: 'r' }).slice(0, 64 * 1024);
    } catch {
      continue;
    }
    const matches = new Set();
    for (const match of prefix.matchAll(/^\s*source_id\s*:\s*([^\s#]+)\s*$/gim)) matches.add(match[1]);
    for (const match of prefix.matchAll(/"source_id"\s*:\s*"([^"]+)"/g)) matches.add(match[1]);
    for (const sourceId of matches) {
      if (isSourceId(sourceId) && !knownIds.has(sourceId)) {
        findings.push(finding('orphan_source', {
          source_id: sourceId,
          path: file.relative,
          action: 'Register or recover the missing source record.'
        }));
      }
    }
  }

  for (const entry of entries) {
    if (!entry.record) continue;
    const parent = entry.record;
    for (const attachment of parent.attachments || []) {
      const matches = byId.get(attachment.source_id) || [];
      if (!matches.length) {
        findings.push(finding('missing_attachment_record', {
          source_id: parent.source_id,
          attachment_source_id: attachment.source_id,
          action: 'Recover the attachment record or remove the link after human review.'
        }));
        continue;
      }
      for (const match of matches) {
        if (match.record.source_type !== 'attachment' || match.record.parent_source_id !== parent.source_id) {
          findings.push(finding('attachment_link_conflict', {
            source_id: parent.source_id,
            attachment_source_id: attachment.source_id,
            record_path: fileRelative(root, match.filePath),
            action: 'Repair both sides of the attachment relationship explicitly.'
          }));
        }
      }
    }
    if (parent.parent_source_id) {
      const parentEntries = byId.get(parent.parent_source_id) || [];
      if (!parentEntries.length || !parentEntries.some((candidate) => (candidate.record.attachments || []).some((item) => item.source_id === parent.source_id))) {
        findings.push(finding('attachment_link_conflict', {
          source_id: parent.source_id,
          parent_source_id: parent.parent_source_id,
          action: 'Add the reciprocal parent attachment link or review the attachment relationship.'
        }));
      }
    }
  }

  return findings;
}

export const scanRegistryFindings = findRegistryFindings;
export const validateSourceRegistry = findRegistryFindings;

function sourceCall(instanceRoot, sourceId, options) {
  if (typeof instanceRoot === 'string' && typeof sourceId === 'string') return { root: normalizeInstanceRoot(instanceRoot), sourceId: assertSourceId(sourceId), options: options || {} };
  if (typeof instanceRoot === 'string' && sourceId && typeof sourceId === 'object') {
    const opts = sourceId;
    return {
      root: normalizeInstanceRoot(instanceRoot),
      sourceId: assertSourceId(opts.source_id || opts.sourceId || opts.id),
      options: options || opts
    };
  }
  if (instanceRoot && typeof instanceRoot === 'object') {
    const opts = instanceRoot;
    return { root: normalizeInstanceRoot(opts.instanceRoot || process.cwd()), sourceId: assertSourceId(opts.source_id || opts.sourceId || opts.id), options: opts };
  }
  fail('A workspace root and source ID are required.', 'INVALID_SOURCE_CALL');
}

function entriesForSource(root, sourceId) {
  return loadAllRecordEntries(root).filter((entry) => entry.record?.source_id === sourceId);
}

function loadUniqueRecord(root, sourceId) {
  const entries = entriesForSource(root, sourceId);
  if (!entries.length) return { record: null, entries, findings: [] };
  const findings = [];
  if (entries.length > 1) findings.push(finding('duplicate_record', { source_id: sourceId, record_paths: entries.map((entry) => fileRelative(root, entry.filePath)) }));
  const direct = entries.find((entry) => path.basename(entry.filePath) === `${sourceId}.json`);
  const selected = direct || entries[0];
  if (!selected.validation.valid) findings.push(finding('invalid_record', { source_id: sourceId, record_path: fileRelative(root, selected.filePath), errors: selected.validation.errors }));
  if (!direct) findings.push(finding('record_filename_conflict', { source_id: sourceId, action: 'Restore the record under its source-ID filename.' }));
  return { record: selected.validation.valid ? selected.record : null, entries, findings };
}

function candidateRootsForResolve(root, options = {}) {
  return sourceRoots(root, options);
}

export function resolveSource(instanceRoot, sourceId, options = {}) {
  const { root, sourceId: id, options: resolveOptions } = sourceCall(instanceRoot, sourceId, options);
  const loaded = loadUniqueRecord(root, id);
  if (!loaded.record) {
    return {
      ok: false,
      status: 'unresolved',
      source_id: id,
      sourceId: id,
      path: null,
      candidates: [],
      evidence: [],
      findings: loaded.findings.length ? loaded.findings : [finding('missing_record', { source_id: id, action: 'Recover or register the source record.' })],
      read_only: true
    };
  }

  const record = loaded.record;
  let findings = [...loaded.findings];
  const allFindings = findRegistryFindings(root, resolveOptions);
  findings.push(...allFindings.filter((item) => item.source_id === id || item.current_path === record.current_path || item.type === 'path_claim_conflict' && item.source_ids?.includes(id)));
  let status = 'unresolved';
  let resolvedPath = null;
  let evidence = [];
  let candidates = [];
  let currentPathMismatch = null;

  if (record.current_path && record.content_hash) {
    try {
      const current = absoluteWorkspacePath(root, record.current_path, { requireExisting: false });
      if (fs.existsSync(current.absolute)) {
        const actual = hashFileSync(current.absolute);
        if (actual.value !== record.content_hash.value || actual.byte_size !== record.byte_size) {
          currentPathMismatch = finding('content_conflict', {
            source_id: id,
            path: record.current_path,
            expected_hash: record.content_hash,
            actual_hash: { algorithm: 'sha256', value: actual.value },
            expected_byte_size: record.byte_size,
            actual_byte_size: actual.byte_size,
            action: 'Use explicit correction for the same logical source or register a new source.'
          });
        } else {
          candidates.push({ path: record.current_path, evidence: ['current_path', 'exact_content_hash'] });
          evidence = ['current_path', 'exact_content_hash'];
        }
      }
    } catch (error) {
      findings.push(finding(error.code === 'SYMLINK_ESCAPE' ? 'symlink_escape' : 'workspace_escape', { source_id: id, path: record.current_path, error: error.message }));
      status = 'conflict';
    }
  }

  if (currentPathMismatch) {
    findings.push(currentPathMismatch);
    return {
      ok: false,
      status: 'conflict',
      source_id: id,
      sourceId: id,
      record,
      path: null,
      candidates,
      evidence: [],
      findings,
      read_only: true
    };
  }

  if (!candidates.length && record.content_hash) {
    const files = walkWorkspaceFiles(root, candidateRootsForResolve(root, resolveOptions), {
      exclude: [toPortablePath(SOURCE_RECORDS_REL_PATH)]
    });
    const historicalPaths = new Set((record.path_history || []).map((item) => item.path));
    for (const file of files) {
      const relative = file.relative;
      if (relative === record.current_path) continue;
      let digest;
      try {
        digest = hashFileSync(file.absolute);
      } catch {
        continue;
      }
      if (digest.value === record.content_hash.value && digest.byte_size === record.byte_size) {
        candidates.push({ path: relative, evidence: [historicalPaths.has(relative) ? 'path_history' : 'exact_content_hash'] });
      }
    }
    const unique = new Map(candidates.map((candidate) => [candidate.path, candidate]));
    candidates = [...unique.values()].sort((left, right) => left.path.localeCompare(right.path));
    if (candidates.length === 1) {
      resolvedPath = candidates[0].path;
      evidence = candidates[0].evidence;
      status = 'resolved';
    } else if (candidates.length > 1) {
      status = 'ambiguous';
      findings.push(finding('duplicate_candidate', {
        source_id: id,
        candidate_paths: candidates.map((candidate) => candidate.path),
        action: 'Reconcile the source explicitly after human review.'
      }));
    }
  } else if (candidates.length === 1) {
    resolvedPath = candidates[0].path;
    status = 'resolved';
  } else if (!record.current_path && !record.content_hash) {
    status = 'resolved';
    evidence = ['external_source_reference'];
  }

  // A stale current_path is expected after a move until reconciliation.  Once
  // the exact hash has located the source elsewhere, it is no longer an
  // orphan; keep only findings that still describe an actionable conflict.
  if (candidates.length > 0) {
    findings = findings.filter((item) => !(item.type === 'orphan_record' && item.source_id === id));
  }

  if (findings.some((item) => item.type === 'path_claim_conflict' || item.type === 'duplicate_record' || item.type === 'revision_conflict' || item.type === 'invalid_record')) status = 'conflict';
  if (status === 'unresolved' && record.current_path && allFindings.some((item) => item.type === 'orphan_record' && item.source_id === id)) {
    findings.push(finding('orphan_record', { source_id: id, current_path: record.current_path, action: 'Locate the source or reconcile a new path.' }));
  }

  return {
    ok: status === 'resolved',
    status,
    source_id: id,
    sourceId: id,
    record,
    path: resolvedPath || (status === 'resolved' && candidates[0]?.path) || null,
    candidates,
    evidence,
    findings,
    read_only: true
  };
}

export const resolveSourceById = resolveSource;

function updateRecord(root, record, options = {}) {
  const next = { ...record, ...options };
  assertValidSourceRecord(next, { instanceRoot: root });
  return writeSourceRecord(root, next, { exclusive: false });
}

function recordNow(options) {
  return toIsoTimestamp(options.now ?? options.at ?? options.timestamp);
}

function pathClaimedByOther(root, relativePath, sourceId) {
  return loadAllRecordEntries(root)
    .filter((entry) => entry.record?.current_path === relativePath && entry.record.source_id !== sourceId)
    .map((entry) => entry.record.source_id);
}

export function reconcileSource(instanceRoot, sourceId, pathOrOptions, maybeOptions = {}) {
  const call = sourceCall(instanceRoot, sourceId, typeof pathOrOptions === 'object' ? pathOrOptions : maybeOptions);
  const options = typeof pathOrOptions === 'string' ? { ...maybeOptions, path: pathOrOptions } : { ...call.options, ...(pathOrOptions || {}) };
  const { root, sourceId: id } = call;
  const loaded = loadUniqueRecord(root, id);
  if (!loaded.record) fail(`Source record not found: ${id}`, 'SOURCE_RECORD_NOT_FOUND', { source_id: id });
  if (loaded.entries.length > 1) fail(`Cannot reconcile a duplicate source record: ${id}`, 'DUPLICATE_RECORD', { source_id: id });

  const candidateInput = options.path ?? options.current_path ?? options.currentPath;
  if (!candidateInput) fail('A path is required to reconcile a source.', 'INVALID_PATH');
  const candidate = absoluteWorkspacePath(root, candidateInput, { requireExisting: true });
  const claimedBy = pathClaimedByOther(root, candidate.relative, id);
  if (claimedBy.length) fail(`Path is already claimed by another source: ${candidate.relative}`, 'PATH_CLAIM_CONFLICT', { source_id: id, path: candidate.relative, conflicting_source_ids: claimedBy });
  const digest = hashFileSync(candidate.absolute);
  const expected = loaded.record.content_hash;
  if (expected && (digest.value !== expected.value || digest.byte_size !== loaded.record.byte_size)) {
    fail(`Content hash does not match source ${id}.`, 'CONTENT_CONFLICT', {
      source_id: id,
      path: candidate.relative,
      expected_hash: expected,
      actual_hash: { algorithm: 'sha256', value: digest.value },
      actual_byte_size: digest.byte_size
    });
  }
  if (loaded.record.current_path === candidate.relative) return { ok: true, changed: false, source_id: id, sourceId: id, path: candidate.relative, record: loaded.record };

  const now = recordNow(options);
  const pathHistory = (loaded.record.path_history || []).map((item) => item.valid_to === null ? { ...item, valid_to: now } : { ...item });
  pathHistory.push({ path: candidate.relative, valid_from: now, valid_to: null, reason: options.reason ?? 'reconciled' });
  const next = {
    ...loaded.record,
    record_revision: loaded.record.record_revision + 1,
    current_path: candidate.relative,
    path_history: pathHistory,
    updated_at: now
  };
  const result = updateRecord(root, loaded.record, next);
  return { ok: true, changed: true, source_id: id, sourceId: id, path: candidate.relative, record: result.record };
}

export const reconcileSourcePath = reconcileSource;

export function correctSource(instanceRoot, sourceId, reasonOrOptions, maybeOptions = {}) {
  const options = typeof reasonOrOptions === 'string' ? { ...maybeOptions, reason: reasonOrOptions } : { ...(reasonOrOptions || {}), ...maybeOptions };
  const call = sourceCall(instanceRoot, sourceId, options);
  const { root, sourceId: id } = call;
  const loaded = loadUniqueRecord(root, id);
  if (!loaded.record) fail(`Source record not found: ${id}`, 'SOURCE_RECORD_NOT_FOUND', { source_id: id });
  if (loaded.entries.length > 1) fail(`Cannot correct a duplicate source record: ${id}`, 'DUPLICATE_RECORD', { source_id: id });
  const reason = String(options.reason ?? '').trim();
  if (!reason) fail('A correction reason is required.', 'CORRECTION_REASON_REQUIRED');
  if (!loaded.record.current_path) fail(`Source has no current local path: ${id}`, 'SOURCE_NOT_LOCAL');
  const current = absoluteWorkspacePath(root, loaded.record.current_path, { requireExisting: true });
  const digest = hashFileSync(current.absolute);
  const currentHash = loaded.record.content_hash?.value;
  if (currentHash === digest.value && loaded.record.byte_size === digest.byte_size) fail(`Source content has not changed: ${id}`, 'CORRECTION_NOOP');
  const now = recordNow(options);
  const nextHash = { algorithm: 'sha256', value: digest.value };
  const next = {
    ...loaded.record,
    record_revision: loaded.record.record_revision + 1,
    content_hash: nextHash,
    byte_size: digest.byte_size,
    content_history: [...(loaded.record.content_history || []), {
      recorded_at: now,
      hash: nextHash,
      byte_size: digest.byte_size,
      change_type: 'corrected',
      reason
    }],
    updated_at: now
  };
  const result = updateRecord(root, loaded.record, next);
  return { ok: true, changed: true, source_id: id, sourceId: id, path: loaded.record.current_path, record: result.record };
}

export const correctSourceContent = correctSource;

export function registerAttachment(instanceRoot, parentSourceId, filePath, options = {}) {
  const root = normalizeInstanceRoot(instanceRoot);
  const parent = readSourceRecord(root, parentSourceId);
  if (!parent) fail(`Parent source record not found: ${parentSourceId}`, 'SOURCE_RECORD_NOT_FOUND', { source_id: parentSourceId });
  const registration = registerSource(root, {
    ...options,
    path: filePath,
    source_type: 'attachment',
    parent_source_id: parentSourceId,
    sourceType: 'attachment',
    media_type: options.media_type ?? options.mediaType
  });
  const label = String(options.label ?? path.basename(registration.path || filePath)).trim() || 'attachment';
  const nextParent = {
    ...parent,
    record_revision: parent.record_revision + 1,
    attachments: [...parent.attachments, { source_id: registration.source_id, relationship: options.relationship ?? 'attachment', label }],
    updated_at: toIsoTimestamp(options.now)
  };
  try {
    writeSourceRecord(root, nextParent, { exclusive: false });
  } catch (error) {
    // The newly-created record remains visible as an orphan so recovery can
    // be explicit; never silently delete user-owned source material.
    error.details = { ...(error.details || {}), orphan_source_id: registration.source_id };
    throw error;
  }
  return { ...registration, parent_source_id: parentSourceId, label, relationship: options.relationship ?? 'attachment', parent_record: nextParent };
}

export const registerSourceAttachment = registerAttachment;

export function linkAttachment(instanceRoot, parentSourceId, attachmentSourceId, options = {}) {
  const root = normalizeInstanceRoot(instanceRoot);
  const parent = readSourceRecord(root, parentSourceId);
  const attachment = readSourceRecord(root, attachmentSourceId);
  if (!parent || !attachment) fail('Both parent and attachment records are required.', 'SOURCE_RECORD_NOT_FOUND');
  if (attachment.source_type !== 'attachment' || (attachment.parent_source_id && attachment.parent_source_id !== parentSourceId)) fail('Attachment record has an incompatible parent relationship.', 'ATTACHMENT_LINK_CONFLICT');
  const label = String(options.label ?? path.basename(attachment.current_path || attachment.source_id)).trim() || 'attachment';
  const relationship = options.relationship ?? 'attachment';
  if (!parent.attachments.some((item) => item.source_id === attachmentSourceId)) {
    writeSourceRecord(root, {
      ...parent,
      record_revision: parent.record_revision + 1,
      attachments: [...parent.attachments, { source_id: attachmentSourceId, relationship, label }],
      updated_at: toIsoTimestamp(options.now)
    }, { exclusive: false });
  }
  if (attachment.parent_source_id !== parentSourceId) {
    writeSourceRecord(root, {
      ...attachment,
      record_revision: attachment.record_revision + 1,
      parent_source_id: parentSourceId,
      updated_at: toIsoTimestamp(options.now)
    }, { exclusive: false });
  }
  return { ok: true, parent_source_id: parentSourceId, attachment_source_id: attachmentSourceId };
}

export function getSourceRegistryFindings(instanceRoot, options = {}) {
  return findRegistryFindings(instanceRoot, options);
}

/**
 * Return valid source records that claim a workspace path. Current paths are
 * preferred by callers, while path history keeps receipts and audit readers
 * useful after a source has been moved before its record is reconciled.
 *
 * This is deliberately a lookup-only helper: it never updates a record or
 * infers a new identity from a filename.
 */
export function findSourceRecordsByPath(instanceRoot = process.cwd(), sourcePath) {
  const root = normalizeInstanceRoot(instanceRoot);
  const relative = toWorkspaceRelativePath(root, sourcePath);
  return loadAllRecordEntries(root)
    .filter((entry) => entry.validation.valid && entry.record)
    .filter((entry) => entry.record.current_path === relative || (entry.record.path_history || []).some((item) => item.path === relative))
    .map((entry) => entry.record);
}

export const findSourcesByPath = findSourceRecordsByPath;
