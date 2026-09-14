import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { formatUtcTimestamp, resolveCapturedBy } from './capture.mjs';
import { findSourceRecordsByPath, isSourceId, toWorkspaceRelativePath } from './source-registry.mjs';

const LOCK_REL_PATH = path.join('governance', 'inbox-processing.lock.json');
const RECEIPTS_REL_DIR = path.join('governance', 'run-receipts', 'inbox-processing');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function portableProcessedPath(instanceRoot, value) {
  try {
    return toWorkspaceRelativePath(instanceRoot, value);
  } catch {
    return String(value || '').trim().replaceAll('\\', '/');
  }
}

function buildProcessedSources(instanceRoot, processedPaths, explicitSources = []) {
  const entries = [];
  const seen = new Set();

  for (const item of explicitSources || []) {
    if (!item || typeof item !== 'object' || !isSourceId(item.source_id)) continue;
    const pathHint = item.path ? portableProcessedPath(instanceRoot, item.path) : null;
    const key = `${item.source_id}\0${pathHint || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ source_id: item.source_id, ...(pathHint ? { path: pathHint } : {}) });
  }

  for (const value of processedPaths || []) {
    const pathHint = typeof value === 'string' ? portableProcessedPath(instanceRoot, value) : portableProcessedPath(instanceRoot, value?.path);
    if (!pathHint) continue;
    let records = [];
    try {
      records = findSourceRecordsByPath(instanceRoot, pathHint);
    } catch {
      records = [];
    }
    const ids = [...new Set(records.map((record) => record.source_id).filter(isSourceId))];
    if (ids.length !== 1) continue;
    const key = `${ids[0]}\0${pathHint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ source_id: ids[0], path: pathHint });
  }

  return entries;
}

export function getInboxProcessingPaths(instanceRoot) {
  return {
    lockPath: path.join(instanceRoot, LOCK_REL_PATH),
    lockRelPath: LOCK_REL_PATH,
    receiptsDir: path.join(instanceRoot, RECEIPTS_REL_DIR),
    receiptsRelDir: RECEIPTS_REL_DIR
  };
}

export function claimInboxProcessing(instanceRoot, options = {}) {
  const { lockPath, lockRelPath } = getInboxProcessingPaths(instanceRoot);
  const now = options.now || new Date();
  const lock = {
    lock_id: options.lockId || randomBytes(6).toString('hex'),
    status: 'processing',
    claimed_by: resolveCapturedBy(options.claimedBy),
    started_at: now.toISOString(),
    stale_after: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    inbox: '6-raw/inbox'
  };

  ensureDir(path.dirname(lockPath));

  try {
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;

    const existing = readJsonIfExists(lockPath);
    const owner = existing?.claimed_by || 'another processor';
    const startedAt = existing?.started_at ? ` at ${existing.started_at}` : '';
    const staleAfter = existing?.stale_after ? ` Stale after ${existing.stale_after}.` : '';
    return {
      ok: false,
      lock: existing,
      lockPath: lockRelPath,
      message: `Inbox processing already claimed by ${owner}${startedAt}.${staleAfter}`
    };
  }

  return {
    ok: true,
    lock,
    lockPath: lockRelPath,
    message: `Inbox processing claimed by ${lock.claimed_by}.`
  };
}

export function completeInboxProcessing(instanceRoot, options = {}) {
  const { lockPath, lockRelPath, receiptsDir, receiptsRelDir } = getInboxProcessingPaths(instanceRoot);
  const lock = readJsonIfExists(lockPath);

  if (!lock) {
    if (!options.allowMissingLock) {
      return {
        ok: false,
        lockPath: lockRelPath,
        message: 'No inbox processing lock exists.'
      };
    }
  }

  const completedAt = options.completedAt || new Date();
  const lockId = lock?.lock_id || options.lockId || `unclaimed-${randomBytes(6).toString('hex')}`;
  const processed = (options.processed || [])
    .map((item) => typeof item === 'string' ? item : item?.path)
    .filter(Boolean);
  const processedSources = buildProcessedSources(
    instanceRoot,
    processed,
    options.processedSources || options.processed_sources
  );
  const receipt = {
    schema_version: 2,
    receipt_id: `${formatUtcTimestamp(completedAt)}-${lockId}`,
    lock_id: lockId,
    claimed_by: lock?.claimed_by || resolveCapturedBy(options.claimedBy),
    started_at: lock?.started_at || options.startedAt || completedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    processed,
    processed_sources: processedSources,
    summary: options.summary || 'Inbox processing completed.'
  };
  const receiptFile = `${receipt.receipt_id}.json`;
  const receiptPath = path.join(receiptsDir, receiptFile);
  const receiptRelPath = path.join(receiptsRelDir, receiptFile);

  ensureDir(receiptsDir);
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  if (lock) fs.unlinkSync(lockPath);

  return {
    ok: true,
    receipt,
    receiptPath: receiptRelPath,
    message: `Inbox processing receipt written to ${receiptRelPath}.`
  };
}
