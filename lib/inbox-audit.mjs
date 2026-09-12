import fs from 'node:fs';
import path from 'node:path';
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
    throw new Error(`Path is not a Mole workspace root: ${root}. Missing: ${missing.join(', ')}`);
  }
  return root;
}

function walkInbox(root, current, files) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === 'archive') continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      walkInbox(root, absolute, files);
    } else if (entry.isFile()) {
      const relative = toPortablePath(path.relative(root, absolute));
      if (relative === '6-raw/inbox/README.md') continue;
      files.push(relative);
    }
  }
}

export function discoverInboxFiles(instanceRoot) {
  const root = path.resolve(instanceRoot);
  const inbox = path.join(root, '6-raw', 'inbox');
  if (!fs.existsSync(inbox)) throw new Error(`Inbox directory does not exist: ${inbox}`);
  const files = [];
  walkInbox(root, inbox, files);
  return files.sort((left, right) => left.localeCompare(right));
}

function sourceIdFromFile(instanceRoot, relativePath) {
  const absolute = path.join(instanceRoot, ...relativePath.split('/'));
  let prefix = '';
  try {
    prefix = fs.readFileSync(absolute, 'utf8').slice(0, 64 * 1024);
  } catch {
    return null;
  }
  const yaml = prefix.match(/^\s*source_id\s*:\s*([^\s#]+)\s*$/im)?.[1];
  const json = prefix.match(/"source_id"\s*:\s*"([^"]+)"/)?.[1];
  if (isSourceId(yaml)) return yaml;
  if (isSourceId(json)) return json;
  try {
    const records = findSourceRecordsByPath(instanceRoot, relativePath);
    return records.length === 1 ? records[0].source_id : null;
  } catch {
    return null;
  }
}

function readProcessedIdentities(instanceRoot) {
  const receiptsDir = path.join(instanceRoot, 'governance', 'run-receipts', 'inbox-processing');
  if (!fs.existsSync(receiptsDir)) return { sourceIds: new Set(), paths: new Set(), legacyPaths: new Set() };

  const sourceIds = new Set();
  const paths = new Set();
  const legacyPaths = new Set();
  for (const entry of fs.readdirSync(receiptsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    let receipt;
    try {
      receipt = JSON.parse(fs.readFileSync(path.join(receiptsDir, entry.name), 'utf8'));
    } catch {
      continue;
    }
    const processedSourcePaths = new Set();
    for (const item of receipt.processed_sources || []) {
      if (isSourceId(item?.source_id)) sourceIds.add(item.source_id);
      const canonical = canonicalizeInboxPath(instanceRoot, item?.path);
      if (canonical) {
        paths.add(canonical);
        processedSourcePaths.add(canonical);
      }
    }
    for (const item of receipt.processed || []) {
      const canonical = canonicalizeInboxPath(instanceRoot, item);
      if (canonical) {
        paths.add(canonical);
        // A path in the historical array remains a path-only fallback unless
        // the same path is explicitly represented by an ID-bearing entry.
        if (!processedSourcePaths.has(canonical)) legacyPaths.add(canonical);
      }
    }
  }
  return { sourceIds, paths, legacyPaths };
}

export function auditInbox(instanceRoot) {
  const root = assertMoleWorkspaceRoot(instanceRoot);
  const candidates = discoverInboxFiles(root);
  const processedIdentities = readProcessedIdentities(root);
  const candidateSourceIds = new Map(candidates.map((item) => [item, sourceIdFromFile(root, item)]));
  const processed = candidates.filter((item) => {
    const sourceId = candidateSourceIds.get(item);
    return sourceId
      ? processedIdentities.sourceIds.has(sourceId)
        || processedIdentities.legacyPaths.has(item)
      : processedIdentities.paths.has(item);
  });
  const unprocessed = candidates.filter((item) => !processed.includes(item));

  return {
    workspaceRoot: root,
    candidates,
    processed,
    unprocessed,
    processed_source_ids: [...processedIdentities.sourceIds].sort()
  };
}
