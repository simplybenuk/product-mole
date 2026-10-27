import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createWorkspaceScaffold } from '../../cli/mole.mjs';
import { registerLifecycleRecord, transitionLifecycleRecord } from '../review-lifecycle.mjs';
import { registerSource } from '../source-registry.mjs';
import {
  VALIDATION_EXIT_CODES,
  formatValidationReport,
  parseFrontmatter,
  readInputQueueRows,
  validateWorkspace
} from '../workspace-validation.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const moleCliPath = path.join(repoRoot, 'cli', 'mole.mjs');
const CLI_VERSION = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
const NOW = '2026-10-10T09:00:00.000Z';
const AGENT = { actor: 'Drafting Agent', actorType: 'agent' };
const HUMAN = { actor: 'Sam Reviewer', actorType: 'human', humanConfirmed: true };

function withWorkspace(callback) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mole-validate-')));
  try {
    createWorkspaceScaffold(root);
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function write(root, relative, content) {
  const absolute = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function validate(root, options = {}) {
  return validateWorkspace(root, { now: NOW, cliVersion: CLI_VERSION, ...options });
}

function codes(result, severity) {
  return result.findings.filter((finding) => !severity || finding.severity === severity).map((finding) => finding.code);
}

function find(result, code, predicate = () => true) {
  const finding = result.findings.find((item) => item.code === code && predicate(item));
  assert.ok(finding, `expected a ${code} finding in: ${JSON.stringify(result.findings.map((item) => [item.code, item.path]))}`);
  return finding;
}

/** Hash of every file and link in the tree, to prove a run changed nothing. */
function snapshot(root) {
  const entries = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isSymbolicLink()) entries.push(`${relative} -> ${fs.readlinkSync(absolute)}`);
      else if (entry.isDirectory()) {
        entries.push(`${relative}/`);
        walk(absolute);
      } else {
        const stat = fs.statSync(absolute);
        entries.push(`${relative} ${stat.mtimeMs} ${createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`);
      }
    }
  };
  walk(root);
  return entries.join('\n');
}

const CONTEXT_FILE = `---
title: Pricing
layer: 4
owner: Sam
last_updated: 2026-10-01
confidence: medium
status: active
tags: [pricing]
summary: How pricing works today.
---

# Pricing

Teams pay per seat.
`;

function summaryFile(fields = {}) {
  const values = { title: 'product', summary: 'Where the product stands.', last_updated: '2026-10-01', ...fields };
  const frontmatter = Object.entries(values).filter(([, value]) => value !== null).map(([key, value]) => `${key}: ${value}`).join('\n');
  return `---\n${frontmatter}\n---\n\n# Product summary\n\n## Current state\nTeams pay per seat and export weekly.\n`;
}

/** Give a clean workspace real content in every top-layer file. */
function fillTopLayers(root) {
  for (const name of fs.readdirSync(path.join(root, '2-summaries'))) {
    write(root, `2-summaries/${name}`, summaryFile({ title: name.replace('-summary.md', '') }));
  }
  for (const name of fs.readdirSync(path.join(root, '3-indexes'))) {
    write(root, `3-indexes/${name}`, '# Index\n\n| Topic | Summary | File |\n|---|---|---|\n| Pricing | Per seat | 4-context/pricing.md |\n');
  }
}

describe('validateWorkspace', () => {
  it('passes a new workspace and reports its starter files as info', () => {
    withWorkspace((root) => {
      const result = validate(root);
      assert.equal(result.ok, true);
      assert.equal(result.read_only, true);
      assert.deepEqual(result.summary, { error: 0, warning: 0, info: result.findings.length });
      assert.ok(result.findings.length > 0);
      assert.ok(codes(result).every((code) => code === 'SUMMARY_PLACEHOLDER' || code === 'INDEX_PLACEHOLDER'));
      assert.equal(result.instance_version, CLI_VERSION);
      assert.deepEqual(result.checks.map((check) => check.name), ['structure', 'metadata', 'inbox', 'sources', 'lifecycle', 'frontmatter', 'top-layers', 'duplicates', 'input-queue']);
      assert.match(formatValidationReport(result), /Workspace is healthy\. Info findings do not need action\./);
    });
  });

  it('passes a populated workspace with no findings at all', () => {
    withWorkspace((root) => {
      write(root, '4-context/pricing.md', CONTEXT_FILE);
      fillTopLayers(root);
      const sourceId = registerSource(root, { path: '4-context/pricing.md', capturedAt: NOW }).source_id;
      registerLifecycleRecord(root, { sourceId, state: 'draft', ...AGENT, now: NOW });
      const result = validate(root);
      assert.deepEqual(result.findings, []);
      assert.equal(result.ok, true);
      assert.ok(result.checks.every((check) => check.status === 'ok'));
      assert.match(formatValidationReport(result), /Workspace is healthy\.\n$/);
    });
  });

  it('stays healthy through ordinary use of a new workspace', () => {
    withWorkspace((root) => {
      const run = (...args) => spawnSync(process.execPath, [moleCliPath, ...args], { cwd: root, encoding: 'utf8' });
      // Every artifact kind, created and left unedited, is still a starter file.
      for (const kind of ['roadmap', 'spec', 'decision-brief', 'strategy-memo', 'prioritisation-draft', 'product-update']) {
        assert.equal(run('create', kind).status, 0, kind);
        const result = validate(root);
        assert.deepEqual(codes(result, 'error').concat(codes(result, 'warning')), [], `${kind}: ${JSON.stringify(result.findings.filter((item) => item.severity !== 'info'))}`);
      }
      // Two drafts from one template share bytes.  That is worth a note, not a failure.
      assert.equal(run('create', 'spec', 'drafts/spec.md').status, 0);
      assert.equal(run('create', 'spec', '4-context/product/spec-b.md').status, 0);
      assert.ok(!codes(validate(root)).includes('DUPLICATE_FILE'));
      write(root, '4-context/.DS_Store', 'junk');
      const result = validate(root);
      assert.equal(result.ok, true);
      const duplicate = find(result, 'SOURCE_DUPLICATE_CONTENT');
      assert.equal(duplicate.severity, 'info');
      assert.deepEqual(duplicate.paths.sort(), ['4-context/product/spec-b.md', '4-context/product/spec-draft.md', 'drafts/spec.md']);
      assert.ok(codes(result).includes('SUMMARY_PLACEHOLDER'));

      // A draft is edited in place before it is submitted.  That is not an error.
      fs.appendFileSync(path.join(root, '4-context', 'product', 'roadmap-draft.md'), '\n## Q1\n\nShip export.\n');
      const edited = validate(root);
      assert.deepEqual(codes(edited, 'error'), []);
      const changed = find(edited, 'SOURCE_CONTENT_CHANGED');
      assert.deepEqual([changed.severity, changed.path, changed.state], ['info', '4-context/product/roadmap-draft.md', 'draft']);
      assert.match(changed.remedy, new RegExp(`mole lifecycle submit ${changed.record_id} `));
      const agent = ['--actor', 'Drafting Agent', '--actor-type', 'agent'];
      const submitted = run('lifecycle', 'submit', changed.record_id, ...agent, '--reason', 'Ready');
      assert.equal(submitted.status, 0, submitted.stderr);
      assert.ok(!codes(validate(root)).includes('SOURCE_CONTENT_CHANGED'));

      // Edited while pending: the lifecycle audit's warning, at the same severity.
      const draftPath = path.join(root, '4-context', 'product', 'roadmap-draft.md');
      fs.appendFileSync(draftPath, 'A late edit.\n');
      const pending = find(validate(root), 'SOURCE_CONTENT_CONFLICT');
      assert.deepEqual([pending.severity, pending.state], ['warning', 'pending_review']);
      assert.match(pending.remedy, /A file whose record is pending_review should not change in place/);
      assert.equal(run('lifecycle', 'revise', changed.record_id, ...agent, '--reason', 'Edited').status, 0);
      assert.equal(run('lifecycle', 'submit', changed.record_id, ...agent, '--reason', 'Ready again').status, 0);

      // Reworked after a rejection: revise comes before submit, and the advice says so.
      assert.equal(run('lifecycle', 'reject', changed.record_id, '--actor', 'Sam Reviewer', '--actor-type', 'human', '--confirm-human', '--reason', 'Needs dates').status, 0);
      fs.appendFileSync(draftPath, 'Dates added.\n');
      const reworked = find(validate(root), 'SOURCE_CONTENT_CHANGED');
      assert.deepEqual([reworked.severity, reworked.state], ['info', 'rejected']);
      assert.match(reworked.remedy, new RegExp(`mole lifecycle revise ${changed.record_id} .*then "mole lifecycle submit ${changed.record_id} `));
      assert.equal(run('lifecycle', 'revise', changed.record_id, ...agent, '--reason', 'Reworked').status, 0);
      assert.equal(run('lifecycle', 'submit', changed.record_id, ...agent, '--reason', 'With dates').status, 0);
      assert.ok(!codes(validate(root)).some((code) => code.startsWith('SOURCE_CONTENT_')));

      // Editing a starter context file makes the placeholders matter.
      fs.appendFileSync(path.join(root, '4-context', 'personas.md'), '\n## Persona: Ops lead\n');
      assert.equal(find(validate(root), 'SUMMARY_PLACEHOLDER').severity, 'warning');
    });
  });

  it('accepts YAML document markers, quoted keys, and pre-release versions in the instance file', () => {
    withWorkspace((root) => {
      write(root, 'mole.instance.yaml', `---\n"cascade_version": ${CLI_VERSION}\ncustomisations:\n  - renamed: x\n...\n`);
      assert.equal(validate(root).ok, true);
      assert.equal(validate(root).instance_version, CLI_VERSION);
      write(root, 'mole.instance.yaml', `cascade_version: ${CLI_VERSION}-rc.1\n`);
      assert.ok(!codes(validate(root)).some((code) => code.startsWith('INSTANCE_')));
    });
  });

  it('reports files it cannot read instead of skipping them', { skip: process.getuid?.() === 0 }, () => {
    withWorkspace((root) => {
      const file = path.join(root, '2-summaries', 'product-summary.md');
      const folder = path.join(root, '5-evidence', 'locked');
      fs.mkdirSync(folder);
      fs.chmodSync(file, 0o000);
      fs.chmodSync(folder, 0o000);
      try {
        const result = validate(root);
        assert.equal(result.ok, false);
        assert.deepEqual(result.findings.filter((item) => item.code === 'FILE_UNREADABLE').map((item) => item.path).sort(), ['2-summaries/product-summary.md', '5-evidence/locked']);
      } finally {
        fs.chmodSync(file, 0o644);
        fs.chmodSync(folder, 0o755);
      }
    });
  });

  it('reports required folders linked outside or inside the workspace', (t) => {
    withWorkspace((root) => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-outside-'));
      try {
        fs.rmSync(path.join(root, '6-raw', 'inbox'), { recursive: true });
        fs.renameSync(path.join(root, '4-context'), path.join(root, '4-context-real'));
        try {
          fs.writeFileSync(path.join(outside, 'note.md'), 'outside note\n');
          fs.symlinkSync(outside, path.join(root, '6-raw', 'inbox'), 'dir');
          fs.symlinkSync(path.join(root, '4-context-real'), path.join(root, '4-context'), 'dir');
        } catch (error) {
          if (['EACCES', 'EPERM', 'EOPNOTSUPP'].includes(error.code)) return t.skip('symlinks unavailable');
          throw error;
        }

        const result = validate(root);
        const linked = find(result, 'WORKSPACE_PATH_LINKED_OUTSIDE', (item) => item.path === '6-raw/inbox');
        assert.equal(linked.severity, 'error');
        assert.match(linked.remedy, /Replace the link with a real directory/);
        assert.equal(result.findings.some((item) => item.code === 'WORKSPACE_PATH_MISSING'), false);
        assert.match(find(result, 'WORKSPACE_PATH_LINKED', (item) => item.path === '4-context').remedy, /Replace the link with a real directory/);
        // Files behind the linked inbox are not reported as unprocessed.
        assert.equal(result.findings.some((item) => item.code === 'INBOX_UNPROCESSED'), false);
        assert.equal(result.checks.find((check) => check.name === 'inbox').status, 'skipped');
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it('reports missing folders and unusable instance metadata', () => {
    withWorkspace((root) => {
      fs.rmSync(path.join(root, '5-evidence'), { recursive: true });
      fs.rmSync(path.join(root, '3-indexes'), { recursive: true });
      fs.writeFileSync(path.join(root, '3-indexes'), 'not a folder');
      write(root, 'mole.instance.yaml', 'instance_name: demo\nthis line is broken\n');
      const result = validate(root);
      assert.equal(result.ok, false);
      assert.equal(find(result, 'WORKSPACE_PATH_MISSING', (item) => item.path === '5-evidence').severity, 'error');
      assert.match(find(result, 'WORKSPACE_PATH_MISSING', (item) => item.path === '3-indexes').message, /not a directory/);
      assert.match(find(result, 'INSTANCE_METADATA_INVALID').message, /line 2 is not "key: value"/);
      assert.equal(result.checks.find((check) => check.name === 'inbox').status, 'skipped');

      write(root, 'mole.instance.yaml', 'instance_name: demo\n');
      assert.match(find(validate(root), 'INSTANCE_METADATA_INVALID').message, /cascade_version is missing/);
      fs.rmSync(path.join(root, 'mole.instance.yaml'));
      assert.equal(find(validate(root), 'INSTANCE_METADATA_MISSING').path, 'mole.instance.yaml');
    });
  });

  it('compares the workspace version with the CLI and the package files with each other', () => {
    withWorkspace((root) => {
      write(root, 'mole.instance.yaml', 'cascade_version: 0.1.0\n');
      assert.equal(find(validate(root), 'INSTANCE_VERSION_BEHIND').severity, 'info');
      assert.equal(validate(root).ok, true);
      write(root, 'mole.instance.yaml', 'cascade_version: 99.0.0\n');
      assert.equal(find(validate(root), 'INSTANCE_VERSION_AHEAD').severity, 'warning');
      write(root, 'mole.instance.yaml', `cascade_version: "${CLI_VERSION}" # pinned\n`);
      assert.equal(validate(root).ok, true);

      write(root, 'VERSION', '0.2.8\n');
      write(root, 'package.json', JSON.stringify({ name: 'product-mole', version: '0.2.7' }));
      assert.match(find(validate(root), 'PACKAGE_VERSION_MISMATCH').message, /VERSION says 0\.2\.8 and package\.json says 0\.2\.7/);
      write(root, 'package.json', '{ not json');
      assert.equal(find(validate(root), 'PACKAGE_METADATA_INVALID').path, 'package.json');
      // Another project's package.json is not Mole's business.
      write(root, 'package.json', JSON.stringify({ name: 'something-else', version: '1.0.0' }));
      assert.equal(validate(root).ok, true);
    });
  });

  it('reports inbox files without a receipt and inbox processing problems', () => {
    withWorkspace((root) => {
      write(root, '6-raw/inbox/note.md', 'A raw note.\n');
      write(root, '6-raw/inbox/note (conflicted copy).md', 'A raw note, edited elsewhere.\n');
      write(root, 'governance/inbox-processing.lock.json', '{ broken');
      write(root, 'governance/run-receipts/inbox-processing/bad-receipt.json', '{ "nope": true }');
      const result = validate(root);
      assert.equal(find(result, 'INBOX_UNPROCESSED', (item) => item.path === '6-raw/inbox/note.md').severity, 'warning');
      assert.deepEqual(find(result, 'INBOX_SYNC_CONFLICT').paths, ['6-raw/inbox/note (conflicted copy).md']);
      assert.equal(find(result, 'INBOX_INVALID_LOCK').severity, 'error');
      assert.deepEqual(find(result, 'INBOX_INVALID_RECEIPT').paths, ['governance/run-receipts/inbox-processing/bad-receipt.json']);
      assert.match(find(result, 'INBOX_INVALID_RECEIPT').remedy, /repair or regenerate/);
    });
  });

  it('reports a stale inbox lock without touching it', () => {
    withWorkspace((root) => {
      write(root, '6-raw/inbox/note.md', 'A raw note.\n');
      const claimed = spawnSync(process.execPath, [moleCliPath, 'inbox', 'claim', '--processor', 'Sam', '--claimed-path', '6-raw/inbox/note.md'], { cwd: root, encoding: 'utf8' });
      assert.equal(claimed.status, 0, claimed.stderr);
      const lockPath = path.join(root, 'governance', 'inbox-processing.lock.json');
      const before = fs.readFileSync(lockPath, 'utf8');
      const active = validate(root);
      assert.ok(!codes(active).includes('INBOX_STALE_LOCK'));
      assert.match(find(active, 'INBOX_UNPROCESSED').message, /is claimed by run /);
      assert.match(find(active, 'INBOX_UNPROCESSED').remedy, /mole inbox complete --run-id /);
      const result = validate(root, { now: '2027-01-01T00:00:00.000Z' });
      assert.equal(find(result, 'INBOX_STALE_LOCK').severity, 'warning');
      assert.match(find(result, 'INBOX_STALE_LOCK').remedy, /mole inbox override-stale/);
      assert.equal(fs.readFileSync(lockPath, 'utf8'), before);
    });
  });

  it('reports broken source links and unresolved archive moves', () => {
    withWorkspace((root) => {
      write(root, '6-raw/inbox/capture.md', 'Captured.\n');
      const moved = registerSource(root, { path: '6-raw/inbox/capture.md', capturedAt: NOW }).source_id;
      fs.mkdirSync(path.join(root, '6-raw', 'archive'));
      fs.renameSync(path.join(root, '6-raw', 'inbox', 'capture.md'), path.join(root, '6-raw', 'archive', 'capture.md'));

      write(root, '4-context/pricing.md', CONTEXT_FILE);
      const edited = registerSource(root, { path: '4-context/pricing.md', capturedAt: NOW }).source_id;
      fs.appendFileSync(path.join(root, '4-context', 'pricing.md'), 'Edited after registration.\n');

      const missing = 'src_00000000-0000-4000-8000-000000000001';
      write(root, '4-context/export.md', CONTEXT_FILE.replace('summary: How pricing works today.',
        `summary: Export needs.\nsource_id: src_00000000-0000-4000-8000-000000000002\nsource_refs:\n  - source_id: ${moved}\n    relationship: supports\n  - source_id: ${missing}\n    relationship: supports`));

      const result = validate(root);
      const orphan = find(result, 'SOURCE_ORPHAN_RECORD');
      assert.equal(orphan.source_id, moved);
      assert.equal(orphan.path, '6-raw/inbox/capture.md');
      assert.equal(orphan.severity, 'warning');
      assert.match(orphan.remedy, /mole source reconcile <source_id> --path <new path>/);
      const conflict = find(result, 'SOURCE_CONTENT_CONFLICT');
      assert.equal(conflict.source_id, edited);
      assert.match(conflict.remedy, new RegExp(`mole source correct ${edited} --reason <text>`));
      const broken = find(result, 'SOURCE_REF_BROKEN');
      assert.deepEqual([broken.path, broken.source_id, broken.severity], ['4-context/export.md', missing, 'error']);
      assert.equal(result.findings.filter((item) => item.code === 'SOURCE_REF_BROKEN').length, 1);
      assert.equal(find(result, 'SOURCE_ORPHAN_SOURCE').path, '4-context/export.md');
    });
  });

  it('reports review ledger findings with the record and its recovery command', () => {
    withWorkspace((root) => {
      write(root, '5-evidence/interview.md', 'Interview notes.\n');
      const evidence = registerSource(root, { path: '5-evidence/interview.md', capturedAt: NOW }).source_id;
      write(root, '4-context/pricing.md', CONTEXT_FILE);
      const sourceId = registerSource(root, { path: '4-context/pricing.md', capturedAt: NOW }).source_id;
      const recordId = registerLifecycleRecord(root, { sourceId, state: 'draft', sourceIds: [evidence], ...AGENT, now: NOW }).record_id;
      transitionLifecycleRecord(root, recordId, { action: 'submit', ...AGENT, reason: 'Ready', now: '2026-10-10T09:01:00.000Z' });
      transitionLifecycleRecord(root, recordId, { action: 'approve', ...HUMAN, reason: 'Agreed', expectedRevision: 2, now: '2026-10-10T09:02:00.000Z' });
      fs.appendFileSync(path.join(root, '4-context', 'pricing.md'), 'Edited after approval.\n');

      const result = validate(root);
      const changed = find(result, 'LIFECYCLE_ACCEPTED_CONTENT_CHANGED');
      assert.deepEqual([changed.record_id, changed.path, changed.severity], [recordId, '4-context/pricing.md', 'error']);
      assert.match(changed.remedy, new RegExp(`mole lifecycle revise ${recordId}`));

      write(root, 'governance/lifecycle/records (conflicted copy).json', '{}');
      assert.equal(find(validate(root), 'LIFECYCLE_LEDGER_CONFLICT_COPY').severity, 'error');
    });
  });

  it('reports missing, unterminated, and invalid frontmatter', () => {
    withWorkspace((root) => {
      write(root, '4-context/no-frontmatter.md', '# Notes\n\nNo metadata here.\n');
      write(root, '4-context/unterminated.md', '---\ntitle: Broken\nsummary: Never closes\n\n# Body\n');
      write(root, '4-context/bad-line.md', '---\ntitle: Bad line\nsummary: Has one\nthis is not yaml\n---\n\nBody.\n');
      write(root, '4-context/missing-fields.md', '---\ntitle: Missing\nsummary:\n---\n\nBody.\n');
      write(root, '4-context/bad-values.md', '---\ntitle: Bad values\nsummary: Wrong types\nlast_updated: yesterday\nconfidence: certain\nstatus: published\nsource_id: not-an-id\n---\n\nBody.\n');
      write(root, '5-evidence/transcript.md', 'Evidence files need no frontmatter.\n');
      // A raw or evidence file may open with a horizontal rule.
      write(root, '6-raw/archive/rule.md', '---\nA note that starts with a rule.\n');
      write(root, '5-evidence/rule-pair.md', '---\nSome prose here\n---\nMore prose.\n');
      write(root, '5-evidence/keyed.md', '---\ntitle: Evidence with metadata\nconfidence: certain\n---\nBody.\n');
      // So may a note under a rule, or a pasted email header that never closes.
      write(root, '6-raw/archive/rule-note.md', '---\nNote: the rule above is a separator\n\nSome text here.\n\n---\nMore.\n');
      write(root, '6-raw/archive/rule-email.md', '---\nFrom: bob@example.com\nSubject: hi\n\nbody\n');
      // A title, then a page of prose before the next rule, is a document.
      write(root, '5-evidence/long.md', `---\ntitle: Interview\n\n${'A line of prose\n'.repeat(40)}---\nfooter\n`);
      // Metadata with a typo in it is still metadata.
      write(root, '5-evidence/typo.md', '---\ntitle: Typo\nlast_updated 2026-10-01\nconfidence: certain\n---\nBody.\n');
      write(root, '4-context/README.md', 'Readme files are skipped.\n');

      const result = validate(root);
      assert.equal(find(result, 'FRONTMATTER_MISSING').path, '4-context/no-frontmatter.md');
      assert.equal(result.findings.filter((item) => item.code === 'FRONTMATTER_MISSING').length, 1);
      assert.deepEqual([find(result, 'FRONTMATTER_UNTERMINATED').path, find(result, 'FRONTMATTER_UNTERMINATED').severity], ['4-context/unterminated.md', 'error']);
      const invalid = find(result, 'FRONTMATTER_INVALID');
      assert.deepEqual([invalid.path, invalid.line], ['4-context/bad-line.md', 4]);
      assert.deepEqual(find(result, 'METADATA_MISSING').fields, ['summary']);
      assert.ok(!result.findings.some((item) => item.path?.includes('rule')), JSON.stringify(result.findings.filter((item) => item.path?.includes('rule'))));
      assert.ok(result.findings.some((item) => item.code === 'METADATA_INVALID' && item.path === '5-evidence/keyed.md'));
      assert.deepEqual(result.findings.filter((item) => item.path === '5-evidence/typo.md').map((item) => item.code).sort(), ['FRONTMATTER_INVALID', 'METADATA_INVALID']);
      assert.deepEqual(result.findings.filter((item) => item.path === '5-evidence/long.md'), []);
      const values = find(result, 'METADATA_INVALID', (item) => item.path === '4-context/bad-values.md').message;
      for (const expected of ['last_updated "yesterday"', 'confidence "certain"', 'status "published"', 'source_id "not-an-id"']) assert.ok(values.includes(expected), values);
    });
  });

  it('reports blank, placeholder, and stale summaries and indexes once the workspace has context', () => {
    withWorkspace((root) => {
      write(root, '4-context/pricing.md', CONTEXT_FILE);
      fillTopLayers(root);
      write(root, '2-summaries/market-summary.md', '---\ntitle: market\nsummary: Market view.\nlast_updated: 2026-10-01\n---\n\n# Market\n\n## Current state\n');
      write(root, '2-summaries/user-summary.md', summaryFile({ title: 'user', last_updated: '2026-03-01' }));
      write(root, '2-summaries/strategy-summary.md', summaryFile({ title: 'strategy', review_after: '2026-10-05' }));
      write(root, '3-indexes/product-index.md', '# Product Index\n\n| Topic | Summary |\n|---|---|\n| _TBD_ | _TBD_ |\n');
      fs.copyFileSync(path.join(repoRoot, '2-summaries', 'compliance-summary.md'), path.join(root, '2-summaries', 'compliance-summary.md'));

      const result = validate(root);
      assert.deepEqual([find(result, 'SUMMARY_BLANK').path, find(result, 'SUMMARY_BLANK').severity], ['2-summaries/market-summary.md', 'warning']);
      assert.equal(find(result, 'SUMMARY_PLACEHOLDER').path, '2-summaries/compliance-summary.md');
      assert.equal(find(result, 'INDEX_PLACEHOLDER').path, '3-indexes/product-index.md');
      const stale = find(result, 'SUMMARY_STALE', (item) => item.path === '2-summaries/user-summary.md');
      assert.equal(stale.age_days, 223);
      assert.match(find(result, 'SUMMARY_STALE', (item) => item.path === '2-summaries/strategy-summary.md').message, /due for review on 2026-10-05/);
      assert.equal(result.findings.filter((item) => item.code === 'SUMMARY_STALE').length, 2);

      const lenient = validate(root, { staleAfterDays: 365 });
      assert.ok(!lenient.findings.some((item) => item.code === 'SUMMARY_STALE' && item.path === '2-summaries/user-summary.md'));
      assert.throws(() => validate(root, { staleAfterDays: 0 }), (error) => error.code === 'INVALID_ARGUMENT');
    });
  });

  it('reports duplicate files and sync conflict copies', () => {
    withWorkspace((root) => {
      write(root, '5-evidence/report.pdf', 'same bytes');
      write(root, '5-evidence/copies/report-final.pdf', 'same bytes');
      write(root, '6-raw/archive/report.pdf', 'same bytes');
      write(root, '5-evidence/other.pdf', 'different!');
      write(root, '4-context/pricing (conflicted copy).md', CONTEXT_FILE);
      write(root, 'governance/change-log (conflicted copy).md', 'x');

      const result = validate(root);
      assert.deepEqual(find(result, 'DUPLICATE_FILE').paths, ['5-evidence/copies/report-final.pdf', '5-evidence/report.pdf', '6-raw/archive/report.pdf']);
      assert.equal(result.findings.filter((item) => item.code === 'DUPLICATE_FILE').length, 1);
      assert.deepEqual(result.findings.filter((item) => item.code === 'SYNC_CONFLICT_COPY').map((item) => item.path),
        ['4-context/pricing (conflicted copy).md', 'governance/change-log (conflicted copy).md']);
    });
  });

  it('reports pending, stale, duplicate, and too many human-input requests', () => {
    withWorkspace((root) => {
      const rows = [
        '| High | Confirm the launch date | Marketing depends on it | A date | 2 min | 2026-10-01 | Open |',
        '| High | Confirm the launch date! | Asked again | A date | 2 min | 2026-12-01 | Waiting |',
        '| Low | Share the churn export | Retention analysis | CSV | 10 min | soon | In progress |',
        '| Low | Approve the copy | Launch | Yes or no | 1 min | 2026-09-01 | Complete |',
        '| Low | Rename the plan | Launch | Yes or no | 1 min | 2026-09-01 | Declined |',
        '| Low | Pick a logo | Launch | Yes or no | 1 min | 2026-09-01 | ~~Open~~ Done |',
        '| Low | Pick a colour | Launch | Yes or no | 1 min | 2026-09-01 | ✅ |',
        '| High | _TBD_ | _TBD_ | _TBD_ | 2–5 min | _TBD_ | Open |'
      ];
      const table = (body) => `# Queue\n\n| Priority | Request | Why this matters | Quick input format | Effort | Due | Status |\n|---|---|---|---|---|---|---|\n${body.join('\n')}\n`;
      write(root, 'governance/input-queue.md', table(rows));

      const result = validate(root);
      assert.deepEqual([find(result, 'INPUT_QUEUE_PENDING').count, find(result, 'INPUT_QUEUE_PENDING').severity], [3, 'info']);
      assert.deepEqual(find(result, 'INPUT_QUEUE_STALE').line, 5);
      assert.equal(result.findings.filter((item) => item.code === 'INPUT_QUEUE_STALE').length, 1);
      assert.deepEqual(find(result, 'INPUT_QUEUE_DUPLICATE').lines, [5, 6]);
      assert.ok(!codes(result).includes('INPUT_QUEUE_TOO_LONG'));

      const many = Array.from({ length: 11 }, (_, index) => `| Medium | Decide item ${index} | Needed | Yes or no | 1 min | _TBD_ | Open |`);
      write(root, 'governance/input-queue.md', table(many));
      assert.equal(find(validate(root), 'INPUT_QUEUE_TOO_LONG').count, 11);

      fs.rmSync(path.join(root, 'governance', 'input-queue.md'));
      assert.equal(find(validate(root), 'INPUT_QUEUE_MISSING').severity, 'warning');
      assert.equal(readInputQueueRows('```\n| Priority | Request |\n|---|---|\n| High | In a fence |\n```\n').length, 0);
    });
  });

  it('changes nothing, even when it finds stale locks and broken links', () => {
    withWorkspace((root) => {
      write(root, '6-raw/inbox/note.md', 'A raw note.\n');
      write(root, '6-raw/inbox/note (conflicted copy).md', 'Another.\n');
      write(root, 'governance/inbox-processing.lock.json', '{ broken');
      write(root, 'governance/lifecycle/.mutation.lock', JSON.stringify({ token: 'x', pid: 999999, acquired_at: '2020-01-01T00:00:00.000Z' }));
      write(root, '4-context/pricing.md', CONTEXT_FILE);
      registerSource(root, { path: '4-context/pricing.md', capturedAt: NOW });
      fs.rmSync(path.join(root, '4-context', 'pricing.md'));
      write(root, '4-context/unterminated.md', '---\ntitle: Broken\n');
      fs.symlinkSync(os.tmpdir(), path.join(root, '5-evidence', 'outside'));
      fs.rmSync(path.join(root, '1-routing'), { recursive: true });

      const before = snapshot(root);
      const result = validate(root);
      assert.equal(result.ok, false);
      assert.ok(result.summary.error > 0);
      assert.equal(snapshot(root), before);
      formatValidationReport(result);
      assert.equal(snapshot(root), before);
    });
  });

  it('keeps running when one check cannot finish', () => {
    withWorkspace((root) => {
      // A records folder that is a file makes the source scan throw.
      write(root, 'governance/sources/records', 'not a folder');
      const result = validate(root);
      const failed = find(result, 'CHECK_FAILED');
      assert.equal(failed.severity, 'error');
      assert.ok(result.checks.some((check) => check.status === 'failed'));
      assert.ok(result.checks.find((check) => check.name === 'input-queue'));
    });
  });

  it('gives every finding a code, severity, message, and remedy, and orders errors first', () => {
    withWorkspace((root) => {
      write(root, '6-raw/inbox/note.md', 'A raw note.\n');
      write(root, '4-context/unterminated.md', '---\ntitle: Broken\n');
      const result = validate(root);
      for (const finding of result.findings) {
        assert.match(finding.code, /^[A-Z][A-Z0-9_]+$/);
        assert.ok(['error', 'warning', 'info'].includes(finding.severity));
        assert.ok(finding.message && finding.remedy, JSON.stringify(finding));
        assert.ok(finding.path || finding.paths || finding.record_id || finding.source_id || finding.check, JSON.stringify(finding));
      }
      const order = result.findings.map((finding) => ['error', 'warning', 'info'].indexOf(finding.severity));
      assert.deepEqual(order, [...order].sort((left, right) => left - right));
      const text = formatValidationReport(result);
      assert.match(text, /Errors \(1\)\n- FRONTMATTER_UNTERMINATED {2}4-context\/unterminated\.md\n/);
      assert.match(text, /Fix: Add a line holding only "---"/);
      assert.match(text, /Workspace has findings\. Nothing was changed\./);
    });
  });
});

describe('parseFrontmatter', () => {
  it('reads top-level fields and leaves nested lines to their key', () => {
    const parsed = parseFrontmatter('﻿---\ntitle: "Quoted"\ntags: [a, b]\nsource_refs:\n  - source_id: src_x\nwhen_to_read:\n- always\n# comment\nowner: Sam # trailing\n---\nBody\n');
    assert.equal(parsed.present && parsed.terminated, true);
    assert.deepEqual(parsed.fields, { title: 'Quoted', tags: '[a, b]', source_refs: '', when_to_read: '', owner: 'Sam' });
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.body, 'Body\n');
    assert.equal(parseFrontmatter('# No frontmatter\n').present, false);
    assert.equal(parseFrontmatter('---\ntitle: x\n').terminated, false);
  });
});

describe('mole validate', () => {
  function runCli(args, cwd) {
    return spawnSync(process.execPath, [moleCliPath, ...args], { cwd, encoding: 'utf8' });
  }

  it('exits 0 for a healthy workspace in text and JSON', () => {
    withWorkspace((root) => {
      const text = runCli(['validate'], root);
      assert.equal(text.status, VALIDATION_EXIT_CODES.healthy, text.stderr);
      assert.match(text.stdout, /^Mole validate\n\nread-only report\n/);
      assert.match(text.stdout, /findings {9}0 errors, 0 warnings, \d+ info/);

      const json = runCli(['validate', '--format', 'json'], root);
      assert.equal(json.status, 0);
      const result = JSON.parse(json.stdout);
      assert.equal(result.ok, true);
      assert.equal(result.cli_version, CLI_VERSION);

      // A path argument validates another folder.
      const elsewhere = runCli(['validate', root, '--json'], os.tmpdir());
      assert.equal(elsewhere.status, 0, elsewhere.stderr);
      assert.equal(JSON.parse(elsewhere.stdout).workspace_root, root.split(path.sep).join('/'));
    });
  });

  it('exits 1 with findings, 2 for invalid arguments, and changes nothing', () => {
    withWorkspace((root) => {
      write(root, '6-raw/inbox/note.md', 'A raw note.\n');
      write(root, '4-context/unterminated.md', '---\ntitle: Broken\n');
      const before = snapshot(root);

      const text = runCli(['validate'], root);
      assert.equal(text.status, VALIDATION_EXIT_CODES.findings);
      assert.match(text.stdout, /- INBOX_UNPROCESSED {2}6-raw\/inbox\/note\.md/);
      const json = runCli(['validate', '--format', 'json'], root);
      assert.equal(json.status, 1);
      const result = JSON.parse(json.stdout);
      assert.equal(result.ok, false);
      assert.ok(result.findings.some((finding) => finding.code === 'FRONTMATTER_UNTERMINATED'));
      assert.equal(snapshot(root), before);

      fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangling'));
      const withLink = snapshot(root);
      assert.equal(runCli(['validate', '--help'], root).status, 0);
      for (const args of [['validate', path.join(root, 'dangling')], ['validate', '--stale-after-days', '1e2']]) {
        assert.equal(runCli(args, root).status, VALIDATION_EXIT_CODES.invalid_arguments, args.join(' '));
      }
      assert.equal(snapshot(root), withLink);
      fs.rmSync(path.join(root, 'dangling'));
      for (const args of [['validate', '--format', 'yaml'], ['validate', '--bogus'], ['validate', 'a', 'b'], ['validate', '--stale-after-days', '0'], ['validate', path.join(root, 'does-not-exist')], ['validate', path.join(root, 'mole.instance.yaml')]]) {
        const refused = runCli(args, root);
        assert.equal(refused.status, VALIDATION_EXIT_CODES.invalid_arguments, `${args.join(' ')}: ${refused.stderr}`);
        assert.match(refused.stderr, /^Invalid arguments: /);
      }
      const jsonError = runCli(['validate', '--bogus', '--format', 'json'], root);
      assert.equal(JSON.parse(jsonError.stdout).error.code, 'INVALID_ARGUMENT');
      assert.equal(snapshot(root), before);
    });
  });

  it('is listed in help and pointed to by doctor', () => {
    withWorkspace((root) => {
      assert.match(runCli(['--help'], root).stdout, /mole validate \[path\]/);
      assert.match(runCli(['doctor'], root).stdout, /Run `mole validate` for the full workspace check\./);
    });
  });
});
