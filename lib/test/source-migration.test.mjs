import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { registerSource } from '../source-registry.mjs';
import { classifySourceReferences, migrateSourceReferences } from '../source-migration.mjs';

function withWorkspace(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-source-migration-'));
  for (const relative of [
    '2-summaries',
    '3-indexes',
    '4-context',
    '5-evidence/source-docs',
    '6-raw/inbox',
    'governance/run-receipts'
  ]) fs.mkdirSync(path.join(root, relative), { recursive: true });
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('source migration classification', () => {
  it('classifies exact and missing legacy paths as resolved or unresolved', () => {
    withWorkspace((root) => {
      const knownPath = path.join(root, '6-raw/inbox/known.md');
      fs.writeFileSync(knownPath, 'known', 'utf8');
      registerSource(root, { path: knownPath, sourceType: 'note', originalDate: '2026-09-12' });
      fs.writeFileSync(path.join(root, '4-context', 'references.md'), [
        'Known: 6-raw/inbox/known.md',
        'Missing: 6-raw/archive/2026-09/gone.md'
      ].join('\n'));

      const result = classifySourceReferences(root);
      const known = result.find((item) => item.legacy_path === '6-raw/inbox/known.md');
      const missing = result.find((item) => item.legacy_path === '6-raw/archive/2026-09/gone.md');
      assert.equal(known.classification, 'resolved');
      assert.equal(known.candidates.length, 1);
      assert.equal(missing.classification, 'unresolved');
    });
  });

  it('marks same-name date matches ambiguous instead of trusting a filename', () => {
    withWorkspace((root) => {
      const firstPath = path.join(root, '6-raw/inbox/a/note.md');
      const secondPath = path.join(root, '6-raw/inbox/b/note.md');
      fs.mkdirSync(path.dirname(firstPath), { recursive: true });
      fs.mkdirSync(path.dirname(secondPath), { recursive: true });
      fs.writeFileSync(firstPath, 'first', 'utf8');
      fs.writeFileSync(secondPath, 'second', 'utf8');
      registerSource(root, { path: firstPath, sourceType: 'note', originalDate: '2026-09-12' });
      registerSource(root, { path: secondPath, sourceType: 'note', originalDate: '2026-09-12' });
      fs.writeFileSync(path.join(root, '4-context', 'references.md'), 'Old path: 6-raw/archive/2026-09/note.md\n', 'utf8');

      const result = classifySourceReferences(root);
      const match = result.find((item) => item.legacy_path === '6-raw/archive/2026-09/note.md');
      assert.equal(match.classification, 'ambiguous');
      assert.equal(match.candidates.length, 2);
    });
  });
});

describe('source migration apply mode', () => {
  it('keeps dry-run read-only and adds IDs only to resolved structured JSON references in apply mode', () => {
    withWorkspace((root) => {
      const sourcePath = path.join(root, '6-raw/inbox/known.md');
      fs.writeFileSync(sourcePath, 'known', 'utf8');
      const source = registerSource(root, { path: sourcePath, sourceType: 'note' });
      const artifactPath = path.join(root, 'governance', 'reference.json');
      const before = JSON.stringify({ source_refs: [{ path: '6-raw/inbox/known.md' }] }, null, 2) + '\n';
      fs.writeFileSync(artifactPath, before, 'utf8');

      const dryRun = migrateSourceReferences(root);
      assert.equal(dryRun.mode, 'dry-run');
      assert.equal(fs.readFileSync(artifactPath, 'utf8'), before);

      const applied = migrateSourceReferences(root, {
        apply: true,
        reportPath: 'governance/run-receipts/source-migration/report.json'
      });
      const after = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
      assert.equal(applied.mode, 'apply');
      assert.equal(applied.counts.changed, 1);
      assert.equal(after.source_refs[0].source_id, source.source_id);
      assert.equal(applied.changed[0].before_hash.length, 64);
      assert.ok(fs.existsSync(path.join(root, applied.report_path)));
    });
  });

  it('adds IDs to resolved YAML source-reference list entries without breaking indentation', () => {
    withWorkspace((root) => {
      const sourcePath = path.join(root, '6-raw/inbox/known.md');
      fs.writeFileSync(sourcePath, 'known', 'utf8');
      const source = registerSource(root, { path: sourcePath, sourceType: 'note' });
      const artifactPath = path.join(root, '4-context', 'references.yaml');
      fs.writeFileSync(artifactPath, [
        'source_refs:',
        '  - path: 6-raw/inbox/known.md',
        '    relationship: supports',
        ''
      ].join('\n'), 'utf8');

      const applied = migrateSourceReferences(root, { apply: true });
      const after = fs.readFileSync(artifactPath, 'utf8');
      assert.equal(applied.counts.changed, 1);
      assert.match(after, /  - path: 6-raw\/inbox\/known\.md/);
      assert.match(after, new RegExp(`^    source_id: ${source.source_id}$`, 'm'));
      assert.match(after, /^    relationship: supports$/m);
    });
  });

  it('includes registry integrity findings in migration reports', () => {
    withWorkspace((root) => {
      const sourcePath = path.join(root, '6-raw/inbox/known.md');
      fs.writeFileSync(sourcePath, 'known', 'utf8');
      const source = registerSource(root, { path: sourcePath, sourceType: 'note' });
      fs.copyFileSync(
        path.join(root, source.record_path),
        path.join(root, 'governance', 'sources', 'records', 'copy.json')
      );

      const report = migrateSourceReferences(root);
      assert.ok(report.findings.some((item) => item.type === 'duplicate_record'));
      assert.ok(report.findings.some((item) => item.type === 'record_filename_conflict'));
    });
  });

  it('does not apply a reference when the registered source has changed bytes', () => {
    withWorkspace((root) => {
      const sourcePath = path.join(root, '6-raw/inbox/known.md');
      fs.writeFileSync(sourcePath, 'before', 'utf8');
      registerSource(root, { path: sourcePath, sourceType: 'note' });
      fs.writeFileSync(sourcePath, 'after', 'utf8');
      const artifactPath = path.join(root, '4-context', 'references.json');
      fs.writeFileSync(artifactPath, `${JSON.stringify({ source_refs: [{ path: '6-raw/inbox/known.md' }] }, null, 2)}\n`, 'utf8');

      const applied = migrateSourceReferences(root, { apply: true });
      const after = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
      assert.equal(applied.counts.changed, 0);
      assert.equal(applied.references.find((item) => item.legacy_path === '6-raw/inbox/known.md').classification, 'unresolved');
      assert.ok(applied.findings.some((item) => item.type === 'content_conflict'));
      assert.equal(after.source_refs[0].source_id, undefined);
    });
  });
});
