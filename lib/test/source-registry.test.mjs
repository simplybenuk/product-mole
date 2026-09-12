import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  SourceRegistryError,
  correctSource,
  findRegistryFindings,
  hashFile,
  hashFileSync,
  isValidSourceRecord,
  readSourceRecord,
  reconcileSource,
  registerAttachment,
  registerSource,
  resolveSource,
  validateSourceRecord
} from '../source-registry.mjs';

function withTempWorkspace(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-source-registry-'));
  fs.mkdirSync(path.join(root, '6-raw', 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(root, '5-evidence', 'source-docs'), { recursive: true });
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  try {
    const result = callback(root);
    if (result && typeof result.then === 'function') return result.finally(cleanup);
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

describe('source registry registration and hashing', () => {
  it('creates distinct immutable IDs for identical bytes and validates the sidecar record', () => {
    withTempWorkspace((root) => {
      const firstPath = path.join(root, '6-raw', 'inbox', 'first.md');
      const secondPath = path.join(root, '6-raw', 'inbox', 'second.md');
      fs.writeFileSync(firstPath, 'same bytes\r\n', 'utf8');
      fs.writeFileSync(secondPath, 'same bytes\r\n', 'utf8');

      const first = registerSource(root, {
        path: firstPath,
        sourceType: 'note',
        originalDate: '2026-09-12',
        capturedAt: '2026-09-12T10:15:30.000Z',
        capturedBy: 'test',
        channel: 'cli'
      });
      const second = registerSource(root, {
        path: secondPath,
        sourceType: 'note',
        originalDate: '2026-09-12',
        capturedAt: '2026-09-12T10:16:30.000Z',
        capturedBy: 'test',
        channel: 'ui'
      });

      assert.match(first.source_id, /^src_[0-9a-f-]{36}$/);
      assert.notEqual(first.source_id, second.source_id);
      assert.equal(first.record.content_hash.value, second.record.content_hash.value);
      assert.equal(first.record.byte_size, 12);
      assert.equal(isValidSourceRecord(first.record, { instanceRoot: root }), true);
      assert.deepEqual(validateSourceRecord(readSourceRecord(root, first.source_id), { instanceRoot: root }), { valid: true, errors: [] });
      assert.equal(fs.existsSync(path.join(root, first.record_path)), true);
    });
  });

  it('hashes exact binary bytes with a chunked sync and streaming async API', async () => {
    await withTempWorkspace(async (root) => {
      const filePath = path.join(root, '6-raw', 'inbox', 'bytes.bin');
      const bytes = Buffer.from([0x00, 0xff, 0x0a, 0x0d, 0x80, 0x7f]);
      fs.writeFileSync(filePath, bytes);
      const syncDigest = hashFileSync(filePath);
      const asyncDigest = await hashFile(filePath);
      assert.deepEqual(asyncDigest, syncDigest);
      assert.equal(syncDigest.byte_size, bytes.length);
    });
  });

  it('registers an existing file without changing its bytes', () => {
    withTempWorkspace((root) => {
      const filePath = path.join(root, '6-raw', 'inbox', 'existing.csv');
      const bytes = Buffer.from('a,b\r\n1,2\r\n', 'utf8');
      fs.writeFileSync(filePath, bytes);
      const before = fs.readFileSync(filePath);
      const result = registerSource(root, { path: '6-raw/inbox/existing.csv', sourceType: 'export', mediaType: 'text/csv' });
      assert.deepEqual(fs.readFileSync(filePath), before);
      assert.equal(result.record.content_hash.value, hashFileSync(filePath).value);
      assert.equal(result.record.media_type, 'text/csv');
    });
  });
});

describe('source registry resolution lifecycle', () => {
  it('resolves a moved archive file read-only and reconciles its path explicitly', () => {
    withTempWorkspace((root) => {
      const originalPath = path.join(root, '6-raw', 'inbox', 'move-me.md');
      const archivePath = path.join(root, '6-raw', 'archive', '2026-09', 'move-me.md');
      fs.writeFileSync(originalPath, 'archive me', 'utf8');
      const result = registerSource(root, { path: originalPath, sourceType: 'note', capturedAt: '2026-09-12T10:00:00.000Z' });
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.renameSync(originalPath, archivePath);

      const resolved = resolveSource(root, result.source_id);
      assert.equal(resolved.status, 'resolved');
      assert.equal(resolved.path, '6-raw/archive/2026-09/move-me.md');
      assert.equal(readSourceRecord(root, result.source_id).current_path, '6-raw/inbox/move-me.md');

      const reconciled = reconcileSource(root, result.source_id, archivePath, { now: '2026-09-12T11:00:00.000Z' });
      assert.equal(reconciled.record.source_id, result.source_id);
      assert.equal(reconciled.record.record_revision, 2);
      assert.equal(reconciled.record.current_path, '6-raw/archive/2026-09/move-me.md');
      assert.equal(reconciled.record.path_history[0].valid_to, '2026-09-12T11:00:00.000Z');
      assert.equal(reconciled.record.path_history.at(-1).valid_to, null);
    });
  });

  it('reports an unacknowledged content change and records an explicit correction', () => {
    withTempWorkspace((root) => {
      const filePath = path.join(root, '6-raw', 'inbox', 'correct-me.md');
      fs.writeFileSync(filePath, 'before', 'utf8');
      const result = registerSource(root, { path: filePath, sourceType: 'note', capturedAt: '2026-09-12T10:00:00.000Z' });
      fs.writeFileSync(filePath, 'after', 'utf8');

      const conflict = resolveSource(root, result.source_id);
      assert.equal(conflict.status, 'conflict');
      assert.ok(conflict.findings.some((item) => item.type === 'content_conflict'));
      assert.ok(findRegistryFindings(root).some((item) => item.type === 'content_conflict'));
      assert.equal(readSourceRecord(root, result.source_id).record_revision, 1);

      const corrected = correctSource(root, result.source_id, 'Approved typo correction', { now: '2026-09-12T12:00:00.000Z' });
      assert.equal(corrected.record.source_id, result.source_id);
      assert.equal(corrected.record.record_revision, 2);
      assert.equal(corrected.record.content_history.length, 2);
      assert.equal(corrected.record.content_history.at(-1).reason, 'Approved typo correction');
      assert.equal(corrected.record.content_history.at(-1).change_type, 'corrected');
      assert.equal(resolveSource(root, result.source_id).status, 'resolved');
    });
  });
});

describe('source registry attachments and findings', () => {
  it('gives each attachment its own ID and validates reciprocal links', () => {
    withTempWorkspace((root) => {
      const parentPath = path.join(root, '6-raw', 'inbox', 'parent.md');
      const attachmentPath = path.join(root, '6-raw', 'inbox', 'export.csv');
      fs.writeFileSync(parentPath, 'parent', 'utf8');
      fs.writeFileSync(attachmentPath, 'a,b\n1,2\n', 'utf8');
      const parent = registerSource(root, { path: parentPath, sourceType: 'note' });
      const attachment = registerAttachment(root, parent.source_id, attachmentPath, { label: 'export.csv' });
      assert.notEqual(parent.source_id, attachment.source_id);
      assert.equal(attachment.record.source_type, 'attachment');
      assert.equal(attachment.record.parent_source_id, parent.source_id);
      assert.equal(readSourceRecord(root, parent.source_id).attachments[0].source_id, attachment.source_id);
      assert.equal(findRegistryFindings(root).filter((item) => item.type.includes('attachment')).length, 0);
    });
  });

  it('reports duplicate records, duplicate content, and conflicting path claims without merging', () => {
    withTempWorkspace((root) => {
      const firstPath = path.join(root, '6-raw', 'inbox', 'first.txt');
      const secondPath = path.join(root, '6-raw', 'inbox', 'second.txt');
      fs.writeFileSync(firstPath, 'same', 'utf8');
      fs.writeFileSync(secondPath, 'same', 'utf8');
      const first = registerSource(root, { path: firstPath });
      const second = registerSource(root, { path: secondPath });
      const firstRecordPath = path.join(root, first.record_path);
      fs.copyFileSync(firstRecordPath, path.join(root, 'governance', 'sources', 'records', 'copy.json'));
      const secondRecordPath = path.join(root, second.record_path);
      const secondRecord = JSON.parse(fs.readFileSync(secondRecordPath, 'utf8'));
      secondRecord.current_path = first.record.current_path;
      fs.writeFileSync(secondRecordPath, `${JSON.stringify(secondRecord, null, 2)}\n`, 'utf8');

      const findings = findRegistryFindings(root);
      assert.ok(findings.some((item) => item.type === 'duplicate_record'));
      assert.ok(findings.some((item) => item.type === 'record_filename_conflict'));
      assert.ok(findings.some((item) => item.type === 'duplicate_content'));
      assert.ok(findings.some((item) => item.type === 'path_claim_conflict'));
    });
  });
});

describe('source registry workspace safety', () => {
  it('rejects traversal and symlinks that resolve outside the workspace', () => {
    withTempWorkspace((root) => {
      assert.throws(() => registerSource(root, { path: '../outside.txt' }), (error) => error instanceof SourceRegistryError && error.code === 'WORKSPACE_ESCAPE');

      const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-outside-'));
      try {
        const outsidePath = path.join(outsideRoot, 'secret.txt');
        fs.writeFileSync(outsidePath, 'secret', 'utf8');
        const linkPath = path.join(root, '6-raw', 'inbox', 'linked.txt');
        fs.symlinkSync(outsidePath, linkPath);
        assert.throws(() => registerSource(root, { path: linkPath }), (error) => error instanceof SourceRegistryError && error.code === 'SYMLINK_ESCAPE');
      } finally {
        fs.rmSync(outsideRoot, { recursive: true, force: true });
      }
    });
  });
});
