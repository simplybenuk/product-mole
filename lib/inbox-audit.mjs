import fs from 'node:fs';
import path from 'node:path';
import { inspectInboxProcessing, looksLikeSyncConflictName, getCountableInboxReceipts } from './inbox-processing.mjs';
import { findSourceRecordsByPath, isSourceId } from './source-registry.mjs';

const REQUIRED_ROOTS = [
  'mole.instance.yaml',
  '0-bootstrap',
  '1-routing',
  '2-summaries',
  '3-indexes',
  '4-context',
  '5-evidence',
  '6-raw',
  path.join('6-raw', 'inbox')
];

function toPortablePath(value) {
  return value.split(path.sep).join('/');
}

function canonicalizeInboxPath(instanceRoot, value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const absolute = path.isAbsolute(text) ? text : path.resolve(instanceRoot, text);
  return toPortablePath(path.relative(instanceRoot, path.normalize(absolute)));
}

function assertMoleWorkspaceRoot(instanceRoot) {
  const root = path.resolve(instanceRoot);
  const missing = REQUIRED_ROOTS.filter((relative) => !fs.existsSync(path.join(root, relative)));
  if (missing.length) {
    throw new Error(
      'Path is not a Mole workspace root: ' + root + '. Missing: ' + missing.join(', ')
    );
  }
  return root;
}

function walkInbox(root, current, files, conflicts, unsafeEntries = [], inheritedConflict = false) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === 'archive') continue;
    const absolute = path.join(current, entry.name);
    const relative = toPortablePath(path.relative(root, absolute));
    const isConflict = inheritedConflict || looksLikeSyncConflictName(entry.name);
    if (isConflict) conflicts.push(relative);
    if (entry.isSymbolicLink()) {
      unsafeEntries.push({ path: relative, kind: 'symlink' });
    } else if (entry.isDirectory()) {
      walkInbox(root, absolute, files, conflicts, unsafeEntries, isConflict);
    } else if (entry.isFile()) {
      if (relative === '6-raw/inbox/README.md') continue;
      files.push(relative);
    } else {
      unsafeEntries.push({ path: relative, kind: 'special' });
    }
  }
}

export function discoverInboxFiles(instanceRoot) {
  const root = path.resolve(instanceRoot);
  const inbox = path.join(root, '6-raw', 'inbox');
  if (!fs.existsSync(inbox)) throw new Error('Inbox directory does not exist: ' + inbox);
  const files = [];
  walkInbox(root, inbox, files, []);
  return files.sort((left, right) => left.localeCompare(right));
}

export function discoverInboxConflictFiles(instanceRoot) {
  const root = path.resolve(instanceRoot);
  const inbox = path.join(root, '6-raw', 'inbox');
  if (!fs.existsSync(inbox)) throw new Error('Inbox directory does not exist: ' + inbox);
  const conflicts = [];
  walkInbox(root, inbox, [], conflicts);
  return conflicts.sort((left, right) => left.localeCompare(right));
}

export function discoverInboxUnsafeEntries(instanceRoot) {
  const root = path.resolve(instanceRoot);
  const inbox = path.join(root, '6-raw', 'inbox');
  if (!fs.existsSync(inbox)) throw new Error('Inbox directory does not exist: ' + inbox);
  const unsafeEntries = [];
  walkInbox(root, inbox, [], [], unsafeEntries);
  return unsafeEntries.sort((left, right) => left.path.localeCompare(right.path));
}

function sourceIdFromYamlScalar(value) {
  const text = String(value || '').trim();
  if (!text || text.startsWith('#')) return null;

  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const parsed = JSON.parse(text);
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  if (text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'");
  }

  return text.replace(/\s+#.*$/, '').trim();
}

function sourceIdFromFrontmatter(content) {
  const opener = content.match(/^(?:\uFEFF)?---[ \t]*\r?\n/);
  if (!opener) return null;

  let sourceId = null;
  for (const line of content.slice(opener[0].length).split(/\r?\n/)) {
    if (/^(?:---|\.\.\.)[ \t]*(?:#.*)?$/.test(line)) return sourceId;
    const match = line.match(/^source_id[ \t]*:[ \t]*(.*)$/);
    if (!match) continue;
    const candidate = sourceIdFromYamlScalar(match[1]);
    if (isSourceId(candidate)) sourceId = candidate;
  }

  return null;
}

function sourceIdFromTopLevelYaml(content) {
  let sawMetadata = false;
  for (const line of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim()) {
      if (sawMetadata) break;
      continue;
    }
    if (/^[ \t]/.test(line)) break;
    const match = line.match(/^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/);
    if (!match) break;
    sawMetadata = true;
    if (match[1] !== 'source_id') continue;
    const sourceId = sourceIdFromYamlScalar(match[2]);
    if (isSourceId(sourceId)) return sourceId;
  }
  return null;
}

function sourceIdFromTopLevelJson(content) {
  try {
    const document = JSON.parse(content.replace(/^\uFEFF/, ''));
    const sourceId = document && !Array.isArray(document) ? document.source_id : null;
    return isSourceId(sourceId) ? sourceId : null;
  } catch {
    return null;
  }
}

function sourceIdFromFile(instanceRoot, relativePath) {
  const absolute = path.join(instanceRoot, ...relativePath.split('/'));
  let prefix = '';
  try {
    prefix = fs.readFileSync(absolute, 'utf8').slice(0, 64 * 1024);
  } catch {
    return null;
  }
  const frontmatterSourceId = sourceIdFromFrontmatter(prefix);
  if (frontmatterSourceId) return frontmatterSourceId;
  const topLevelYamlSourceId = sourceIdFromTopLevelYaml(prefix);
  if (topLevelYamlSourceId) return topLevelYamlSourceId;

  if (prefix.trimStart().startsWith('{')) {
    let json = prefix;
    try {
      json = fs.readFileSync(absolute, 'utf8');
    } catch {
      // The bounded prefix is still safe to parse when the full file is unavailable.
    }
    const topLevelSourceId = sourceIdFromTopLevelJson(json);
    if (topLevelSourceId) return topLevelSourceId;
  }

  try {
    const records = findSourceRecordsByPath(instanceRoot, relativePath);
    return records.length === 1 ? records[0].source_id : null;
  } catch {
    return null;
  }
}

function readProcessedIdentities(processingState, instanceRoot) {
  const sourceIds = new Set();
  const paths = new Set();
  const legacyPaths = new Set();
  for (const record of getCountableInboxReceipts(processingState, instanceRoot)) {
    const processedSourcePaths = new Set();
    for (const item of record.receipt.processed_sources || []) {
      if (isSourceId(item?.source_id)) sourceIds.add(item.source_id);
      const canonical = canonicalizeInboxPath(instanceRoot, item?.path);
      if (canonical) {
        paths.add(canonical);
        processedSourcePaths.add(canonical);
      }
    }
    for (const item of record.receipt.processed || []) {
      const canonical = canonicalizeInboxPath(instanceRoot, item);
      if (canonical) {
        paths.add(canonical);
        if (!processedSourcePaths.has(canonical)) legacyPaths.add(canonical);
      }
    }
  }
  return { sourceIds, paths, legacyPaths };
}

function expiryDate(lock) {
  const value = lock?.expires_at || lock?.stale_after;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function auditInbox(instanceRoot, options = {}) {
  const root = assertMoleWorkspaceRoot(instanceRoot);
  const candidates = discoverInboxFiles(root);
  const syncConflictFiles = discoverInboxConflictFiles(root);
  const unsafeEntries = discoverInboxUnsafeEntries(root);
  const processing = inspectInboxProcessing(root);
  const processedIdentities = readProcessedIdentities(processing, root);
  const candidateSourceIds = new Map(candidates.map((item) => [item, sourceIdFromFile(root, item)]));
  const processed = candidates.filter((item) => {
    const sourceId = candidateSourceIds.get(item);
    return sourceId
      ? processedIdentities.sourceIds.has(sourceId)
        || processedIdentities.legacyPaths.has(item)
      : processedIdentities.legacyPaths.has(item);
  });
  const unprocessed = candidates.filter((item) => !processed.includes(item));
  const now = options.now ? new Date(options.now) : new Date();
  const expiry = expiryDate(processing.lock);
  const staleLock = processing.lock && !processing.lockValidationError && expiry
    && now.getTime() >= expiry.getTime()
    ? processing.lock
    : null;
  const issues = [];

  if (processing.lockError || processing.lockValidationError) {
    issues.push({
      code: 'INVALID_LOCK',
      paths: [processing.lockPath],
      message: processing.lockError || processing.lockValidationError
    });
  }
  if (processing.conflictLockPaths.length) {
    issues.push({
      code: 'SYNC_CONFLICT',
      paths: processing.conflictLockPaths,
      message: 'Conflicting inbox lock copies exist.'
    });
  }
  if (syncConflictFiles.length) {
    issues.push({
      code: 'SYNC_CONFLICT',
      paths: syncConflictFiles,
      message: 'Conflicting inbox source copies exist. Preserve every copy.'
    });
  }
  if (unsafeEntries.length) {
    issues.push({
      code: 'UNSAFE_INBOX_ENTRY',
      paths: unsafeEntries.map((entry) => entry.path),
      message: 'Inbox contains symlinked or special entries. Do not dereference them; reconcile the entry before processing.'
    });
  }
  if (processing.conflictReceipts.length) {
    issues.push({
      code: 'SYNC_CONFLICT',
      paths: processing.conflictReceipts.map((item) => item.path),
      message: 'Conflicting receipt copies exist.'
    });
  }
  if (processing.duplicateReceipts.length) {
    issues.push({
      code: 'DUPLICATE_RECEIPT',
      paths: processing.duplicateReceipts.flatMap((item) => item.paths),
      message: 'More than one receipt claims the same run.'
    });
  }
  if (processing.invalidReceipts.length) {
    issues.push({
      code: 'INVALID_RECEIPT',
      paths: processing.invalidReceipts.map((item) => item.path),
      message: 'One or more processing receipts cannot be validated.'
    });
  }
  if (processing.invalidOverrides?.length) {
    issues.push({
      code: 'INVALID_OVERRIDE',
      paths: processing.invalidOverrides.map((item) => item.path),
      message: 'One or more inbox-processing override records cannot be validated.'
    });
  }
  if (processing.conflictOverrides.length || processing.duplicateOverrides.length) {
    issues.push({
      code: 'OVERRIDE_CONFLICT',
      paths: [...new Set([...processing.conflictOverrides,
        ...processing.duplicateOverrides.flatMap((item) => item.paths)])],
      message: 'Conflicting override copies or duplicate override IDs exist. Preserve and reconcile every record.'
    });
  }
  if (processing.incompleteOverrides?.length) {
    issues.push({
      code: 'INCOMPLETE_OVERRIDE',
      paths: processing.incompleteOverrides.map((item) => item.path),
      message: 'One or more stale-lock override records were prepared but not finalized. Reconcile the lock replacement before continuing.'
    });
  }
  if (processing.processedPathConflicts?.length) {
    issues.push({
      code: 'PROCESSED_PATH_CONFLICT',
      paths: processing.processedPathConflicts.map((item) => item.path),
      message: 'More than one run receipt claims the same canonical inbox path. Preserve the receipts and reconcile the split-brain state before counting or reprocessing it.'
    });
  }
  if (staleLock) {
    issues.push({
      code: 'STALE_LOCK',
      paths: [processing.lockPath],
      message: 'The active inbox lease has expired and needs an explicit recovery decision.'
    });
  }

  return {
    workspaceRoot: root,
    candidates,
    processed,
    unprocessed,
    processedPaths: [...processedIdentities.paths].sort((left, right) => left.localeCompare(right)),
    processed_source_ids: [...processedIdentities.sourceIds].sort(),
    activeLock: processing.lock && !staleLock ? processing.lock : null,
    staleLock,
    syncConflictFiles,
    unsafeEntries,
    conflictLockPaths: processing.conflictLockPaths,
    conflictReceipts: processing.conflictReceipts,
    duplicateReceipts: processing.duplicateReceipts,
    invalidReceipts: processing.invalidReceipts,
    invalidOverrides: processing.invalidOverrides || [],
    incompleteOverrides: processing.incompleteOverrides || [],
    processedPathConflicts: processing.processedPathConflicts || [],
    overrides: processing.overrides,
    conflictOverrides: processing.conflictOverrides,
    duplicateOverrides: processing.duplicateOverrides,
    issues,
    ok: unprocessed.length === 0 && issues.length === 0
  };
}
