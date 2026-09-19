import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createCaptureFileName, resolveCapturedBy } from '../../lib/capture.mjs';
import {
  claimInboxProcessing,
  completeInboxProcessing,
  heartbeatInboxProcessing,
  checkpointInboxProcessing,
  getInboxMutationProcessIdentity,
  inspectInboxProcessing,
  overrideStaleInboxProcessing
} from '../../lib/inbox-processing.mjs';
import { auditInbox, discoverInboxFiles, discoverInboxConflictFiles } from '../../lib/inbox-audit.mjs';
import { backfillProcessedInboxMetrics, getMetricsPaths, recordProcessedInboxItems } from '../../lib/metrics.mjs';
import {
  buildInsightCaptureContent,
  buildProductUpdateInstruction,
  createWorkspaceScaffold,
  getCheckUpdatesOutput,
  getDoctorOutput,
  getHelpOutput,
  getInstallBanner,
  getUpgradeCommand,
  installMoleSkills,
  parseInboxClaimValues,
  parseInboxCompleteValues
} from '../mole.mjs';
import { buildUiCaptureContent, createCaptureRelPath } from '../../ui/server.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const moleCliPath = path.join(repoRoot, 'cli', 'mole.mjs');

function withTempInstance(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-test-'));
  try {
    return callback(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-cli-test-'));
  const stdoutPath = path.join(dir, 'stdout.txt');
  const stderrPath = path.join(dir, 'stderr.txt');
  const stdoutFd = fs.openSync(stdoutPath, 'w');
  const stderrFd = fs.openSync(stderrPath, 'w');

  try {
    const result = spawnSync(process.execPath, [moleCliPath, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', stdoutFd, stderrFd]
    });

    return {
      ...result,
      stdout: fs.readFileSync(stdoutPath, 'utf8'),
      stderr: fs.readFileSync(stderrPath, 'utf8')
    };
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeMetricsReceipt(instanceRoot, {
  runId,
  completedAt = '2026-06-11T10:00:00.000Z',
  processed
}) {
  const receiptsDir = path.join(instanceRoot, 'governance', 'run-receipts', 'inbox-processing');
  fs.mkdirSync(receiptsDir, { recursive: true });
  fs.writeFileSync(path.join(receiptsDir, `${runId}.json`), `${JSON.stringify({
    receipt_id: runId,
    completed_at: completedAt,
    processed
  }, null, 2)}\n`);
}

describe('doctor', () => {
  it('reports source and instance versions when mole.instance.yaml exists', () => {
    withTempInstance((dir) => {
      fs.writeFileSync(
        path.join(dir, 'mole.instance.yaml'),
        'instance_name: test-instance\ncascade_version: 0.1.0\n',
        'utf8'
      );

      const output = getDoctorOutput(dir);

      assert.match(output, /Mole doctor/);
      assert.match(output, /source version\s+0\.2\.8/);
      assert.match(output, /instance version\s+0\.1\.0/);
      assert.doesNotMatch(output, /missing instance metadata/i);
    });
  });

  it('warns when mole.instance.yaml is missing', () => {
    withTempInstance((dir) => {
      const output = getDoctorOutput(dir);

      assert.match(output, /source version\s+0\.2\.8/);
      assert.match(output, /instance version\s+not found/);
      assert.match(output, /missing instance metadata/i);
    });
  });
});

describe('help', () => {
  it('uses consistent Mole naming and documented command examples', () => {
    const output = getHelpOutput();

    assert.match(output, /^Mole CLI v0\.2\.8/m);
    assert.match(output, /mole new my-mole/);
    assert.match(output, /mole init my-mole/);
    assert.match(output, /mole create roadmap/);
    assert.match(output, /mole create spec drafts\/spec\.md/);
    assert.match(output, /mole insight "Users trust CSV export more than dashboard totals"/);
    assert.match(output, /mole note "Support team heard onboarding confusion"/);
    assert.match(output, /mole signal "Trial users miss the export button"/);
    assert.match(output, /mole product-update CEO 2-weeks --format email/);
    assert.match(output, /mole bootstrap-context/);
    assert.match(output, /mole refresh top-layers/);
    assert.match(output, /mole synthesise inbox/);
    assert.match(output, /mole review input-queue/);
    assert.match(output, /mole inbox claim/);
    assert.match(output, /mole inbox heartbeat/);
    assert.match(output, /mole inbox checkpoint/);
    assert.match(output, /mole inbox audit/);
    assert.match(output, /mole inbox complete --run-id/);
    assert.match(output, /mole inbox override-stale/);
    assert.match(output, /mole metrics backfill/);
    assert.match(output, /mole install skills\s+Install Mole agent skills into ~\/\.agents\/skills/);
    assert.match(output, /More help:\n  https:\/\/github\.com\/simplybenuk\/product-mole#readme/);
    assert.match(output, /mole check-updates/);
    assert.match(output, /mole upgrade/);
    assert.match(output, /mole doctor/);
    assert.doesNotMatch(output, /Cascade/);
    assert.doesNotMatch(output, /mole install codex/);
  });
});

describe('synthesise guidance', () => {
  it('requires root validation and a final recursive inbox audit', () => {
    const result = runCli(['synthesise', 'inbox']);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /mole doctor/);
    assert.match(result.stdout, /mole inbox audit/);
    assert.match(result.stdout, /unexplained unprocessed files remain/);
  });

  it('points inbox synthesis at living personas', () => {
    const result = runCli(['synthesise', 'inbox']);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /4-context\/personas\.md/);
    assert.match(result.stdout, /update or create evidence-backed personas/);
    assert.match(result.stdout, /4-context\/stakeholders\.md/);
    assert.match(result.stdout, /stakeholder memory/);
    assert.match(result.stdout, /blank, placeholder-only/);
    assert.match(result.stdout, /material top-layer gap/);
    assert.match(result.stdout, /flat capture\/drop zone/);
    assert.match(result.stdout, /complete with `mole inbox complete --run-id <run-id>/);
    assert.match(result.stdout, /mole inbox complete --run-id <run-id>/);
    assert.match(result.stdout, /active owned claim/);
  });

  it('prints first-time bootstrap guidance for blank top layers', () => {
    const result = runCli(['bootstrap-context']);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Bootstrap this Mole workspace context/);
    assert.match(result.stdout, /starter-template files in `2-summaries\/` and `3-indexes\/`/);
    assert.match(result.stdout, /governance\/input-queue\.md/);
  });

  it('prints top-layer refresh guidance', () => {
    const result = runCli(['refresh', 'top-layers']);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Refresh the Mole top layers/);
    assert.match(result.stdout, /blank, placeholder, stale, or incomplete summaries and indexes/);
    assert.match(result.stdout, /future retrieval/);
  });
});


describe('product updates', () => {
  it('builds stakeholder-specific product update instructions', () => {
    const output = buildProductUpdateInstruction('CEO', '2-weeks', 'email');

    assert.match(output, /Generate a product update for CEO covering 2-weeks in email format/);
    assert.match(output, /4-context\/stakeholders\.md/);
    assert.match(output, /decision authority/);
    assert.match(output, /retrieval receipt/);
  });

  it('prints product update instructions from the CLI command', () => {
    const result = runCli(['product-update', 'CEO', '2-weeks', '--format', 'email']);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /CEO/);
    assert.match(result.stdout, /2-weeks/);
    assert.match(result.stdout, /email format/);
    assert.match(result.stdout, /4-context\/stakeholders\.md/);
  });
});

describe('workspace scaffold', () => {
  it('creates a clean Mole workspace without source-repo files', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);

      for (const relPath of [
        '0-bootstrap',
        '1-routing',
        '2-summaries',
        '3-indexes',
        '4-context',
        path.join('4-context', 'personas.md'),
        path.join('4-context', 'stakeholders.md'),
        '5-evidence',
        '6-raw',
        path.join('governance', 'metrics', 'daily.json'),
        path.join('governance', 'metrics', 'weekly.json'),
        path.join('governance', 'metrics', 'monthly.json'),
        path.join('governance', 'metrics', 'seen-today.json'),
        path.join('governance', 'metrics', 'dashboard.html'),
        'mole.instance.yaml'
      ]) {
        assert.ok(fs.existsSync(path.join(dir, relPath)), `${relPath} should exist`);
      }

      for (const relPath of [
        'cli',
        'lib',
        'docs',
        '.agents',
        '.github',
        'node_modules',
        'package.json',
        'package-lock.json',
        'plans',
        'spec',
        'ui',
        'upgrade-ownership.json',
        'mole.instance-template.yaml',
        'governance/contribution-guide.md'
      ]) {
        assert.equal(fs.existsSync(path.join(dir, relPath)), false, `${relPath} should not exist`);
      }

      const personas = fs.readFileSync(path.join(dir, '4-context', 'personas.md'), 'utf8');
      assert.match(personas, /living set of living user personas|living user personas/i);
      assert.match(personas, /Inbox synthesis rules/);

      const stakeholders = fs.readFileSync(path.join(dir, '4-context', 'stakeholders.md'), 'utf8');
      assert.match(stakeholders, /Living stakeholder map/i);
      assert.match(stakeholders, /Inbox synthesis rules/);

      const metadata = fs.readFileSync(path.join(dir, 'mole.instance.yaml'), 'utf8');
      assert.doesNotMatch(metadata, /docs\//);
      assert.doesNotMatch(metadata, /templates\//);
      assert.doesNotMatch(metadata, /cli\//);
    });
  });
});

describe('install banner', () => {
  it('introduces Mole with an ASCII mascot and concise product description', () => {
    const output = getInstallBanner();

    assert.match(output, /Mole is a local-first product context system/);
    assert.match(output, /Product Mole/);
    assert.match(output, /●\s+●/);
    assert.match(output, /better roadmaps, specs, decisions/);
  });
});

describe('skills installer', () => {
  it('installs packaged Mole skills into the configured agents home', () => {
    withTempInstance((dir) => {
      const previousAgentsHome = process.env.AGENTS_HOME;
      process.env.AGENTS_HOME = path.join(dir, '.agents');

      try {
        installMoleSkills({ silent: true });
      } finally {
        if (previousAgentsHome === undefined) {
          delete process.env.AGENTS_HOME;
        } else {
          process.env.AGENTS_HOME = previousAgentsHome;
        }
      }

      for (const skill of [
        'mole-create-roadmap',
        'mole-create-spec',
        'mole-critique',
        'mole-insight',
        'mole-product-update',
        'mole-bootstrap-context',
        'mole-refresh-top-layers',
        'mole-review-input-queue',
        'mole-synthesise-inbox'
      ]) {
        assert.ok(
          fs.existsSync(path.join(dir, '.agents', 'skills', skill, 'SKILL.md')),
          `${skill} should be installed as a skill`
        );
      }
    });
  });
});

describe('upgrade command', () => {
  it('updates the installed Mole CLI from the GitHub main branch', () => {
    assert.deepEqual(getUpgradeCommand(), [
      'npm',
      'install',
      '-g',
      'github:simplybenuk/product-mole#main'
    ]);
  });
});

describe('upgrade ownership manifest', () => {
  it('defines parseable ownership classes for upgrade planning', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'upgrade-ownership.json'), 'utf8')
    );

    assert.equal(manifest.version, 1);
    assert.ok(manifest.classes['safe-copy']);
    assert.ok(manifest.classes['merge-carefully']);
    assert.ok(manifest.classes['never-overwrite']);
    assert.ok(manifest.classes['never-overwrite'].paths.includes('4-context/'));
    assert.ok(manifest.classes['never-overwrite'].paths.includes('5-evidence/'));
    assert.ok(manifest.classes['never-overwrite'].paths.includes('6-raw/'));
  });
});

describe('check-updates', () => {
  it('reports when an instance is up to date', () => {
    withTempInstance((dir) => {
      fs.writeFileSync(
        path.join(dir, 'mole.instance.yaml'),
        'instance_name: test-instance\ncascade_version: 0.2.8\n',
        'utf8'
      );

      const output = getCheckUpdatesOutput(dir);

      assert.match(output, /Mole update check/);
      assert.match(output, /source version\s+0\.2\.8/);
      assert.match(output, /instance version\s+0\.2\.8/);
      assert.match(output, /status\s+up to date/);
      assert.match(output, /read-only report/i);
    });
  });

  it('reports when the source is newer than the instance', () => {
    withTempInstance((dir) => {
      fs.writeFileSync(
        path.join(dir, 'mole.instance.yaml'),
        'instance_name: test-instance\ncascade_version: 0.1.0\n',
        'utf8'
      );

      const output = getCheckUpdatesOutput(dir);

      assert.match(output, /status\s+update available/);
      assert.match(output, /Safe additions/);
      assert.match(output, /Manual review/);
      assert.match(output, /0-bootstrap\//);
      assert.match(output, /README\.md/);
    });
  });
});

describe('team-safe capture filenames', () => {
  it('creates repeated similar note filenames with UTC timestamp and unique suffixes', () => {
    const now = new Date('2026-05-13T10:11:12.345Z');
    const first = createCaptureFileName('Repeated note', {
      now,
      uniqueSuffix: 'abc12345'
    });
    const second = createCaptureFileName('Repeated note', {
      now,
      uniqueSuffix: 'def67890'
    });

    assert.equal(first, '20260513T101112345Z-repeated-note-abc12345.md');
    assert.equal(second, '20260513T101112345Z-repeated-note-def67890.md');
    assert.notEqual(first, second);
  });

  it('uses the collision-resistant filename helper for UI capture paths', () => {
    const relPath = createCaptureRelPath('quick-notes', 'Repeated note', {
      now: new Date('2026-05-13T10:11:12.345Z'),
      uniqueSuffix: 'abc12345'
    });

    assert.equal(
      relPath,
      path.join('6-raw', 'inbox', '20260513T101112345Z-repeated-note-abc12345.md')
    );
  });
});

describe('capture attribution metadata', () => {
  it('resolves captured_by from explicit value or local environment defaults', () => {
    assert.equal(resolveCapturedBy('Ada'), 'Ada');
    assert.equal(resolveCapturedBy('', { MOLE_CAPTURED_BY: 'Grace' }), 'Grace');
    assert.equal(resolveCapturedBy('', { USER: 'hopper' }), 'hopper');
    assert.equal(resolveCapturedBy('', {}, 'unknown'), 'unknown');
  });

  it('emits captured_by in CLI capture frontmatter', () => {
    const content = buildInsightCaptureContent('Team note', {
      capturedBy: 'Ada',
      createdAt: '2026-05-13T10:11:12.345Z'
    });

    assert.match(content, /captured_by: Ada/);
    assert.match(content, /source: mole CLI/);
    assert.match(content, /visibility: \"internal\"/);
  });


  it('emits optional stakeholder metadata in CLI capture frontmatter', () => {
    const content = buildInsightCaptureContent('CEO asked about onboarding', {
      capturedBy: 'Ada',
      createdAt: '2026-05-13T10:11:12.345Z',
      stakeholder: 'CEO',
      requestedBy: 'CEO',
      audience: ['exec'],
      interestAreas: ['enterprise onboarding'],
      followUpBy: '2026-05-20'
    });

    assert.match(content, /stakeholder: "CEO"/);
    assert.match(content, /requested_by: "CEO"/);
    assert.match(content, /audience: \["exec"\]/);
    assert.match(content, /interest_areas: \["enterprise onboarding"\]/);
    assert.match(content, /follow_up_by: "2026-05-20"/);
  });

  it('emits captured_by in UI capture frontmatter', () => {
    const content = buildUiCaptureContent({
      source: 'customer',
      channel: 'call',
      confidence: 'medium',
      tags: ['research'],
      note: 'Team note',
      capturedBy: 'Ada'
    }, {
      date: '2026-05-13'
    });

    assert.match(content, /captured_by: Ada/);
    assert.match(content, /source: customer/);
  });
});

describe('inbox processing lock and receipt', () => {
  it('discovers nested live inbox files while excluding README and archive content', () => {
    withTempInstance((dir) => {
      fs.mkdirSync(path.join(dir, '6-raw', 'inbox', 'observations'), { recursive: true });
      fs.mkdirSync(path.join(dir, '6-raw', 'inbox', 'archive', 'old'), { recursive: true });
      fs.writeFileSync(path.join(dir, '6-raw', 'inbox', 'README.md'), 'instructions');
      fs.writeFileSync(path.join(dir, '6-raw', 'inbox', 'deck.pptx'), 'deck');
      fs.writeFileSync(path.join(dir, '6-raw', 'inbox', 'observations', 'note.md'), 'note');
      fs.writeFileSync(path.join(dir, '6-raw', 'inbox', 'archive', 'old', 'done.md'), 'done');

      assert.deepEqual(discoverInboxFiles(dir), [
        '6-raw/inbox/deck.pptx',
        '6-raw/inbox/observations/note.md'
      ]);
    });
  });

  it('filters files already recorded as processed and rejects a non-Mole root', () => {
    withTempInstance((dir) => {
      for (const relative of [
        'mole.instance.yaml',
        '0-bootstrap',
        '1-routing',
        '2-summaries',
        '3-indexes',
        '4-context',
        '5-evidence',
        '6-raw'
      ]) {
        const target = path.join(dir, relative);
        if (path.extname(target)) fs.writeFileSync(target, 'mole_version: 0.2.8\n');
        else fs.mkdirSync(target, { recursive: true });
      }
      fs.mkdirSync(path.join(dir, '6-raw', 'inbox'), { recursive: true });
      fs.writeFileSync(path.join(dir, '6-raw', 'inbox', 'done.md'), 'done');
      fs.writeFileSync(path.join(dir, '6-raw', 'inbox', 'new.md'), 'new');
      fs.mkdirSync(path.join(dir, 'governance', 'run-receipts', 'inbox-processing'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'governance', 'run-receipts', 'inbox-processing', 'receipt.json'),
        JSON.stringify({ receipt_id: 'legacy-audit-receipt', completed_at: '2026-07-16T12:00:00.000Z', processed: ['6-raw/inbox/done.md'] })
      );

      const result = auditInbox(dir);
      assert.deepEqual(result.unprocessed, ['6-raw/inbox/new.md']);
      assert.deepEqual(result.processed, ['6-raw/inbox/done.md']);
      assert.throws(() => auditInbox(path.join(dir, 'missing')), /not a Mole workspace root/);
    });
  });

  it('allows one claim and fails concurrent claims safely', () => {
    withTempInstance((dir) => {
      const first = claimInboxProcessing(dir, {
        claimedBy: 'Ada',
        now: new Date('2026-05-13T10:11:12.345Z'),
        lockId: 'lock-1'
      });
      const second = claimInboxProcessing(dir, {
        claimedBy: 'Grace',
        now: new Date('2026-05-13T10:12:12.345Z'),
        lockId: 'lock-2'
      });

      assert.equal(first.ok, true);
      assert.equal(first.lock.claimed_by, 'Ada');
      assert.equal(second.ok, false);
      assert.match(second.message, /already belongs.*claimed by Ada/);
    });
  });

  it('writes a processing receipt and releases the lock on completion', () => {
    withTempInstance((dir) => {
      claimInboxProcessing(dir, {
        claimedBy: 'Ada',
        host: 'host-a',
        claimedPaths: ['6-raw/inbox/a.md'],
        now: new Date('2026-05-13T10:11:12.345Z'),
        lockId: 'lock-1'
      });

      const result = completeInboxProcessing(dir, {
        runId: 'lock-1',
        processor: 'Ada',
        host: 'host-a',
        completedAt: new Date('2026-05-13T10:21:12.345Z'),
        processed: ['6-raw/inbox/a.md'],
        summary: 'Promoted one note.'
      });

      assert.equal(result.ok, true);
      assert.equal(result.receipt.lock_id, 'lock-1');
      assert.equal(result.receipt.claimed_by, 'Ada');
      assert.deepEqual(result.receipt.processed, ['6-raw/inbox/a.md']);
      assert.match(result.receiptPath, /governance[\\/]run-receipts[\\/]inbox-processing[\\/]/);

      const next = claimInboxProcessing(dir, {
        claimedBy: 'Grace',
        now: new Date('2026-05-13T10:22:12.345Z'),
        lockId: 'lock-2'
      });
      assert.equal(next.ok, true);
    });
  });

  it('fails closed without a claim and permits only an audited missing-lock override', () => {
    withTempInstance((dir) => {
      const refused = completeInboxProcessing(dir, {
        runId: 'missing-run',
        claimedBy: 'Ada',
        host: 'host-a',
        completedAt: new Date('2026-05-13T10:21:12.345Z'),
        processed: ['6-raw/inbox/a.md'],
        summary: 'Promoted one note.'
      });

      assert.equal(refused.ok, false);
      assert.equal(refused.code, 'MISSING_LOCK');

      const result = completeInboxProcessing(dir, {
        runId: 'override-run',
        processor: 'Ada',
        host: 'host-a',
        overrideMissingLock: true,
        reason: 'Confirmed the prior local run left no lock behind.',
        completedAt: new Date('2026-05-13T10:21:12.345Z'),
        processed: ['6-raw/inbox/a.md'],
        summary: 'Promoted one note.'
      });

      assert.equal(result.ok, true);
      assert.equal(result.receipt.run_id, 'override-run');
      assert.equal(result.receipt.override.type, 'missing-lock');
      assert.equal(result.receipt.override.reason, 'Confirmed the prior local run left no lock behind.');
      assert.deepEqual(result.receipt.processed, ['6-raw/inbox/a.md']);
      assert.match(result.receiptPath, /governance[\\/]run-receipts[\\/]inbox-processing[\\/]/);
      assert.equal(fs.existsSync(path.join(dir, 'governance', 'inbox-processing.lock.json')), false);
      const overrides = fs.readdirSync(path.join(dir, 'governance', 'run-receipts', 'inbox-processing', 'overrides'));
      assert.equal(overrides.length, 1);
      const inspected = inspectInboxProcessing(dir);
      assert.equal(inspected.overrides[0].override.state, 'finalized');
    });
  });

  it('requires explicit processor and host identity for missing-lock recovery', () => {
    withTempInstance((dir) => {
      const missingBoth = completeInboxProcessing(dir, {
        runId: 'missing-identity-run',
        overrideMissingLock: true,
        reason: 'Checked the prior run history before recovery.',
        processed: ['6-raw/inbox/a.md']
      });
      assert.equal(missingBoth.ok, false);
      assert.equal(missingBoth.code, 'RECOVERY_IDENTITY_REQUIRED');
      assert.match(missingBoth.message, /--processor and --host/);

      const missingHost = completeInboxProcessing(dir, {
        runId: 'missing-host-run',
        processor: 'Ada',
        overrideMissingLock: true,
        reason: 'Checked the prior run history before recovery.',
        processed: ['6-raw/inbox/a.md']
      });
      assert.equal(missingHost.ok, false);
      assert.equal(missingHost.code, 'RECOVERY_IDENTITY_REQUIRED');
      assert.match(missingHost.message, /--host/);
      assert.equal(inspectInboxProcessing(dir).receipts.length, 0);
      assert.equal(fs.existsSync(path.join(
        dir,
        'governance/run-receipts/inbox-processing/overrides'
      )), false);
    });
  });

  it('rejects completion timestamps that precede the owned lease', () => {
    withTempInstance((dir) => {
      const claimed = claimInboxProcessing(dir, {
        runId: 'time-order-run',
        processor: 'Ada',
        host: 'laptop-a',
        now: new Date('2026-09-08T10:00:00.000Z')
      });
      const result = completeInboxProcessing(dir, {
        runId: claimed.run_id,
        processor: 'Ada',
        host: 'laptop-a',
        completedAt: new Date('2026-09-08T09:59:59.000Z')
      });

      assert.equal(result.ok, false);
      assert.equal(result.code, 'INVALID_COMPLETION_TIME');
      assert.equal(inspectInboxProcessing(dir).receipts.length, 0);
      assert.equal(fs.existsSync(path.join(dir, 'governance/inbox-processing.lock.json')), true);
    });
  });

  it('blocks a receipt whose recovery snapshot points at a different override', () => {
    withTempInstance((dir) => {
      const completed = completeInboxProcessing(dir, {
        runId: 'evidence-link-run',
        processor: 'Ada',
        host: 'laptop-a',
        overrideMissingLock: true,
        reason: 'Checked the prior local run before recovering it.',
        completedAt: new Date('2026-09-08T10:01:00.000Z')
      });
      assert.equal(completed.ok, true);
      const receiptPath = path.join(dir, completed.receiptPath);
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      receipt.lock_snapshot = { ...receipt.lock_snapshot, override_id: 'different-override' };
      fs.writeFileSync(receiptPath, JSON.stringify(receipt));

      const state = inspectInboxProcessing(dir);
      const metrics = backfillProcessedInboxMetrics(dir);
      assert.equal(state.receipts.length, 0);
      assert.equal(state.invalidReceipts.length, 1);
      assert.match(state.invalidReceipts[0].error, /override_id/);
      assert.equal(metrics.receipts_counted, 0);
      assert.equal(metrics.processed_paths_counted, 0);
    });
  });

  it('does not persist a missing-lock override when a path is already covered', () => {
    withTempInstance((dir) => {
      const receipts = path.join(dir, 'governance', 'run-receipts', 'inbox-processing');
      fs.mkdirSync(receipts, { recursive: true });
      fs.writeFileSync(path.join(receipts, 'prior.json'), JSON.stringify({
        run_id: 'prior-run',
        completed_at: '2026-09-08T10:00:00.000Z',
        processed: ['6-raw/inbox/a.md']
      }));

      const result = completeInboxProcessing(dir, {
        runId: 'recovery-run',
        processor: 'Ada',
        host: 'laptop-a',
        overrideMissingLock: true,
        reason: 'The prior receipt already covers this path.',
        completedAt: new Date('2026-09-08T10:01:00.000Z'),
        processed: ['6-raw/inbox/a.md']
      });

      assert.equal(result.ok, false);
      assert.equal(result.code, 'ALREADY_PROCESSED');
      const overridesDir = path.join(receipts, 'overrides');
      assert.equal(fs.existsSync(overridesDir), false);
    });
  });

  it('parses repeated processed paths while preserving completion summary text', () => {
    const parsed = parseInboxCompleteValues([
      '--processed',
      '6-raw/inbox/a.md',
      '--processed',
      '6-raw/inbox/b.md',
      'Promoted',
      'two',
      'notes.'
    ]);

    assert.deepEqual(parsed.processed, [
      '6-raw/inbox/a.md',
      '6-raw/inbox/b.md'
    ]);
    assert.equal(parsed.summary, 'Promoted two notes.');
  });

  it('rejects unknown inbox flags instead of treating them as identity or summary text', () => {
    assert.throws(
      () => parseInboxClaimValues(['--procesor', 'Ada']),
      /Unknown inbox claim option --procesor/
    );
    assert.throws(
      () => parseInboxCompleteValues(['--procesor', 'Ada']),
      /Unknown inbox completion option --procesor/
    );
  });

  it('records processed paths in metrics when the CLI completes inbox processing', () => {
    withTempInstance((dir) => {
      const claim = runCli([
        'inbox',
        'claim',
        '--run-id',
        'cli-run-1',
        '--processor',
        'Ada',
        '--claimed-path',
        '6-raw/inbox/a.md',
        '--claimed-path',
        '6-raw/inbox/b.md'
      ], {
        cwd: dir
      });
      const complete = runCli([
        'inbox',
        'complete',
        '--run-id',
        'cli-run-1',
        '--processor',
        'Ada',
        '--processed',
        '6-raw/inbox/a.md',
        '--processed',
        '6-raw/inbox/b.md',
        'Promoted',
        'two',
        'notes.'
      ], {
        cwd: dir
      });
      const retry = runCli([
        'inbox',
        'complete',
        '--run-id',
        'cli-run-1',
        '--processor',
        'Ada',
        '--processed',
        '6-raw/inbox/a.md',
        '--processed',
        '6-raw/inbox/b.md',
        'Promoted',
        'two',
        'notes.'
      ], {
        cwd: dir
      });

      const paths = getMetricsPaths(dir);
      const receiptsDir = path.join(dir, 'governance', 'run-receipts', 'inbox-processing');
      const receiptFile = fs.readdirSync(receiptsDir).find((file) => file.endsWith('.json'));
      const receipt = JSON.parse(fs.readFileSync(path.join(receiptsDir, receiptFile), 'utf8'));
      const daily = JSON.parse(fs.readFileSync(paths.dailyPath, 'utf8'));

      assert.equal(claim.status, 0);
      assert.equal(complete.status, 0);
      assert.equal(retry.status, 0);
      assert.match(retry.stdout, /already exists/);
      assert.deepEqual(receipt.processed, [
        '6-raw/inbox/a.md',
        '6-raw/inbox/b.md'
      ]);
      assert.equal(daily.records.at(-1).count, 2);
    });
  });

  it('runs scoped heartbeat and checkpoint mutations through the CLI', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const claim = runCli([
        'inbox',
        'claim',
        '--run-id',
        'cli-state-run',
        '--processor',
        'Ada',
        '--host',
        'laptop-a',
        '--claimed-path',
        '6-raw/inbox/a.md'
      ], { cwd: dir });
      const audit = runCli(['inbox', 'audit'], { cwd: dir });
      const heartbeat = runCli([
        'inbox',
        'heartbeat',
        '--run-id',
        'cli-state-run',
        '--processor',
        'Ada',
        '--host',
        'laptop-a'
      ], { cwd: dir });
      const checkpoint = runCli([
        'inbox',
        'checkpoint',
        '--run-id',
        'cli-state-run',
        '--processor',
        'Ada',
        '--host',
        'laptop-a',
        '--processed',
        '6-raw/inbox/a.md'
      ], { cwd: dir });
      const lock = inspectInboxProcessing(dir).lock;

      assert.equal(claim.status, 0);
      assert.equal(audit.status, 0);
      assert.match(audit.stdout, /active lease\s+cli-state-run by Ada on laptop-a until/);
      assert.equal(heartbeat.status, 0);
      assert.match(heartbeat.stdout, /lease renewed/);
      assert.equal(checkpoint.status, 0);
      assert.match(checkpoint.stdout, /Checkpoint saved/);
      assert.deepEqual(lock.claimed_paths, ['6-raw/inbox/a.md']);
      assert.deepEqual(lock.processed_paths, ['6-raw/inbox/a.md']);
    });
  });

  it('prints malformed conflict receipts as actionable audit blockers', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const receipts = path.join(dir, 'governance/run-receipts/inbox-processing');
      fs.mkdirSync(receipts, { recursive: true });
      fs.writeFileSync(path.join(receipts, 'run (conflicted copy).json'), '{');
      fs.writeFileSync(path.join(receipts, 'valid.json'), JSON.stringify({
        run_id: 'valid-run',
        receipt_id: 'valid-run',
        completed_at: '2026-09-08T10:00:00.000Z',
        processed: ['6-raw/inbox/a.md']
      }));
      fs.writeFileSync(path.join(dir, '6-raw/inbox/a.md'), 'preserve');

      const result = runCli(['inbox', 'audit'], { cwd: dir });

      assert.equal(result.status, 1);
      assert.match(result.stdout, /conflict receipts 1/);
      assert.match(result.stdout, /run \(conflicted copy\)\.json/);
      assert.match(result.stdout, /invalid or unidentified/);
      assert.match(result.stdout, /invalid receipts 1/);
      assert.match(result.stdout, /processed files 0/);
    });
  });

  it('does not create a second UTC-day metric on an idempotent completion retry', () => {
    withTempInstance((dir) => {
      const owner = {
        runId: 'utc-retry-run',
        processor: 'Ada',
        host: 'laptop-a',
        claimedPaths: ['6-raw/inbox/a.md'],
        now: new Date('2026-09-08T23:50:00.000Z')
      };
      assert.equal(claimInboxProcessing(dir, owner).ok, true);
      const first = completeInboxProcessing(dir, {
        ...owner,
        completedAt: new Date('2026-09-08T23:59:00.000Z'),
        processed: ['6-raw/inbox/a.md'],
        summary: 'Promoted one note.'
      });
      assert.equal(first.ok, true);
      assert.equal(recordProcessedInboxItems(dir, first.receipt.processed, {
        runId: first.receipt.run_id,
        now: new Date('2026-09-08T23:59:00.000Z')
      }).counted, 1);

      const retry = completeInboxProcessing(dir, {
        ...owner,
        completedAt: new Date('2026-09-09T00:01:00.000Z'),
        processed: ['6-raw/inbox/a.md'],
        summary: 'Promoted one note.'
      });
      assert.equal(retry.ok, true);
      assert.equal(retry.idempotent, true);
      const reconciled = backfillProcessedInboxMetrics(dir, {
        now: new Date('2026-09-09T00:01:00.000Z')
      });
      const daily = JSON.parse(fs.readFileSync(getMetricsPaths(dir).dailyPath, 'utf8'));

      assert.equal(reconciled.processed_paths_counted, 1);
      assert.deepEqual(daily.records, [{ date: '2026-09-08', count: 1 }]);
    });
  });

  it('requires an explicit CLI override for completion without a prior claim', () => {
    withTempInstance((dir) => {
      const refused = runCli([
        'inbox',
        'complete',
        '--run-id',
        'missing-cli-run',
        '--processed',
        '6-raw/inbox/a.md',
        'Promoted',
        'one',
        'note.'
      ], {
        cwd: dir,
        env: { ...process.env, MOLE_CAPTURED_BY: 'Ada' }
      });

      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /No active owned inbox processing claim/);

      const complete = runCli([
        'inbox',
        'complete',
        '--override-missing-lock',
        '--run-id',
        'cli-override-run',
        '--processor',
        'Ada',
        '--host',
        'laptop-a',
        '--reason',
        'Confirmed the prior worker stopped before writing its lock.',
        '--processed',
        '6-raw/inbox/a.md',
        'Promoted',
        'one',
        'note.'
      ], {
        cwd: dir,
        env: { ...process.env, MOLE_CAPTURED_BY: 'Ada' }
      });

      const paths = getMetricsPaths(dir);
      const receiptsDir = path.join(dir, 'governance', 'run-receipts', 'inbox-processing');
      const receiptFile = fs.readdirSync(receiptsDir).find((file) => file.endsWith('.json'));
      const receipt = JSON.parse(fs.readFileSync(path.join(receiptsDir, receiptFile), 'utf8'));
      const daily = JSON.parse(fs.readFileSync(paths.dailyPath, 'utf8'));

      assert.equal(complete.status, 0);
      assert.match(complete.stdout, /receipt written/);
      assert.equal(receipt.run_id, 'cli-override-run');
      assert.equal(receipt.override.type, 'missing-lock');
      assert.equal(receipt.claimed_by, 'Ada');
      assert.deepEqual(receipt.processed, ['6-raw/inbox/a.md']);
      assert.equal(daily.records.at(-1).count, 1);
    });
  });

  it('keeps inbox completion successful when metrics update fails', () => {
    withTempInstance((dir) => {
      claimInboxProcessing(dir, {
        claimedBy: 'Ada',
        claimedPaths: ['6-raw/inbox/a.md'],
        now: new Date('2026-06-11T10:00:00.000Z'),
        lockId: 'metrics-failure-run',
        leaseMs: 365 * 24 * 60 * 60 * 1000
      });
      const metricsDir = path.join(dir, 'governance', 'metrics');
      fs.rmSync(metricsDir, { recursive: true, force: true });
      fs.writeFileSync(metricsDir, 'metrics path is temporarily unavailable', 'utf8');

      const result = runCli([
        'inbox',
        'complete',
        '--run-id',
        'metrics-failure-run',
        '--processor',
        'Ada',
        '--processed',
        '6-raw/inbox/a.md',
        'Promoted',
        'one',
        'note.'
      ], {
        cwd: dir
      });

      assert.equal(result.status, 0);
      assert.match(result.stdout, /receipt written/);
      assert.match(result.stderr, /metrics reconciliation failed/);
      assert.equal(fs.existsSync(path.join(dir, 'governance', 'inbox-processing.lock.json')), false);

      fs.rmSync(metricsDir, { force: true });
      fs.mkdirSync(metricsDir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'governance', 'metrics', 'daily.json'),
        JSON.stringify({ records: [] }),
        'utf8'
      );
      const retry = runCli([
        'inbox',
        'complete',
        '--run-id',
        'metrics-failure-run',
        '--processor',
        'Ada',
        '--processed',
        '6-raw/inbox/a.md',
        'Promoted',
        'one',
        'note.'
      ], {
        cwd: dir
      });
      const daily = JSON.parse(fs.readFileSync(
        path.join(dir, 'governance', 'metrics', 'daily.json'),
        'utf8'
      ));
      assert.equal(retry.status, 0);
      assert.match(retry.stdout, /already exists/);
      assert.doesNotMatch(retry.stderr, /metrics reconciliation failed/);
      assert.equal(daily.records.at(-1).count, 1);
    });
  });

  it('rejects a semantically different completion retry without changing the receipt', () => {
    withTempInstance((dir) => {
      const owner = { runId: 'terminal-state-run', processor: 'Ada', host: 'laptop-a' };
      assert.equal(claimInboxProcessing(dir, {
        ...owner,
        claimedPaths: ['6-raw/inbox/a.md', '6-raw/inbox/b.md'],
        now: new Date('2026-09-08T09:00:00.000Z')
      }).ok, true);
      const first = completeInboxProcessing(dir, {
        ...owner,
        processed: ['6-raw/inbox/a.md'],
        summary: 'Promoted one note.',
        completedAt: new Date('2026-09-08T10:00:00.000Z')
      });
      assert.equal(first.ok, true);
      const receiptBytes = fs.readFileSync(path.join(dir, first.receiptPath), 'utf8');

      const retry = completeInboxProcessing(dir, {
        ...owner,
        processed: ['6-raw/inbox/b.md'],
        summary: 'Promoted a different note.',
        completedAt: new Date('2026-09-09T10:00:00.000Z')
      });
      assert.equal(retry.ok, false);
      assert.equal(retry.code, 'RETRY_MISMATCH');
      assert.equal(fs.readFileSync(path.join(dir, first.receiptPath), 'utf8'), receiptBytes);
      assert.equal(fs.readdirSync(path.join(dir, 'governance', 'run-receipts', 'inbox-processing'))
        .filter((file) => file.endsWith('.json')).length, 1);
    });
  });

  it('stores run and lease metadata and makes repeated claims idempotent', () => {
    withTempInstance((dir) => {
      const options = {
        runId: 'lease-run',
        processor: 'Ada',
        host: 'laptop-a',
        leaseMs: 60 * 60 * 1000,
        claimedPaths: ['6-raw/inbox/a.md', '6-raw/inbox/b.md'],
        now: new Date('2026-09-08T10:00:00.000Z')
      };
      const first = claimInboxProcessing(dir, options);
      const retry = claimInboxProcessing(dir, {
        ...options,
        now: new Date('2026-09-08T10:05:00.000Z')
      });

      assert.equal(first.ok, true);
      assert.equal(first.lock.run_id, 'lease-run');
      assert.equal(first.lock.lock_version, 1);
      assert.equal(first.lock.processor, 'Ada');
      assert.equal(first.lock.host, 'laptop-a');
      assert.equal(first.lock.started_at, '2026-09-08T10:00:00.000Z');
      assert.equal(first.lock.heartbeat_at, '2026-09-08T10:00:00.000Z');
      assert.equal(first.lock.expires_at, '2026-09-08T11:00:00.000Z');
      assert.deepEqual(first.lock.claimed_paths, ['6-raw/inbox/a.md', '6-raw/inbox/b.md']);
      assert.equal(retry.ok, true);
      assert.equal(retry.idempotent, true);
      assert.equal(retry.lock.run_id, 'lease-run');

      const incompatible = claimInboxProcessing(dir, {
        ...options,
        claimedPaths: ['6-raw/inbox/a.md', '6-raw/inbox/c.md'],
        now: new Date('2026-09-08T10:05:30.000Z')
      });
      assert.equal(incompatible.ok, false);
      assert.equal(incompatible.code, 'INCOMPATIBLE_CLAIM');

      const foreign = claimInboxProcessing(dir, {
        ...options,
        processor: 'Grace',
        host: 'laptop-b',
        now: new Date('2026-09-08T10:06:00.000Z')
      });
      assert.equal(foreign.ok, false);
      assert.equal(foreign.code, 'FOREIGN_OWNER');

      const heartbeat = heartbeatInboxProcessing(dir, {
        runId: 'lease-run',
        processor: 'Ada',
        host: 'laptop-a',
        leaseMs: 60 * 60 * 1000,
        now: new Date('2026-09-08T10:30:00.000Z')
      });
      assert.equal(heartbeat.ok, true);
      assert.equal(heartbeat.lock.lock_version, 2);
      assert.equal(heartbeat.lock.heartbeat_at, '2026-09-08T10:30:00.000Z');
      assert.equal(heartbeat.lock.expires_at, '2026-09-08T11:30:00.000Z');
    });
  });

  it('preserves the claimed lease duration when renewal options are omitted', () => {
    withTempInstance((dir) => {
      const owner = {
        runId: 'preserved-lease-run',
        processor: 'Ada',
        host: 'laptop-a',
        leaseMs: 1000,
        claimedPaths: ['6-raw/inbox/a.md'],
        now: new Date('2026-09-08T10:00:00.000Z')
      };
      assert.equal(claimInboxProcessing(dir, owner).ok, true);

      const heartbeat = heartbeatInboxProcessing(dir, {
        runId: owner.runId,
        processor: owner.processor,
        host: owner.host,
        now: new Date('2026-09-08T10:00:00.500Z')
      });
      assert.equal(heartbeat.ok, true);
      assert.equal(heartbeat.lock.lease_duration_ms, 1000);
      assert.equal(heartbeat.lock.expires_at, '2026-09-08T10:00:01.500Z');

      const checkpoint = checkpointInboxProcessing(dir, {
        runId: owner.runId,
        processor: owner.processor,
        host: owner.host,
        processed: owner.claimedPaths,
        now: new Date('2026-09-08T10:00:00.750Z')
      });
      assert.equal(checkpoint.ok, true);
      assert.equal(checkpoint.lock.lease_duration_ms, 1000);
      assert.equal(checkpoint.lock.expires_at, '2026-09-08T10:00:01.750Z');
    });
  });

  it('requires an explicit matching run ID for every post-claim mutation', () => {
    withTempInstance((dir) => {
      claimInboxProcessing(dir, {
        runId: 'explicit-run',
        processor: 'Ada',
        host: 'laptop-a',
        now: new Date('2026-09-08T10:00:00.000Z')
      });

      const heartbeat = heartbeatInboxProcessing(dir, {
        processor: 'Ada',
        host: 'laptop-a',
        now: new Date('2026-09-08T10:01:00.000Z')
      });
      const checkpoint = checkpointInboxProcessing(dir, {
        processor: 'Ada',
        host: 'laptop-a',
        processed: ['6-raw/inbox/a.md'],
        now: new Date('2026-09-08T10:02:00.000Z')
      });
      const completion = completeInboxProcessing(dir, {
        processor: 'Ada',
        host: 'laptop-a',
        completedAt: new Date('2026-09-08T10:03:00.000Z')
      });

      assert.equal(heartbeat.code, 'RUN_ID_REQUIRED');
      assert.equal(checkpoint.code, 'RUN_ID_REQUIRED');
      assert.equal(completion.code, 'RUN_ID_REQUIRED');
      assert.equal(inspectInboxProcessing(dir).lock.run_id, 'explicit-run');
      assert.equal(inspectInboxProcessing(dir).lock.lock_version, 1);
    });
  });

  it('rejects missing, foreign, and expired normal completion', () => {
    withTempInstance((dir) => {
      const missing = completeInboxProcessing(dir, {
        runId: 'missing-run',
        processor: 'Ada',
        host: 'laptop-a',
        completedAt: new Date('2026-09-08T10:00:00.000Z')
      });
      assert.equal(missing.ok, false);
      assert.equal(missing.code, 'MISSING_LOCK');

      claimInboxProcessing(dir, {
        runId: 'owned-run',
        processor: 'Ada',
        host: 'laptop-a',
        leaseMs: 60 * 60 * 1000,
        now: new Date('2026-09-08T10:00:00.000Z')
      });

      const foreign = completeInboxProcessing(dir, {
        runId: 'owned-run',
        processor: 'Grace',
        host: 'laptop-b',
        completedAt: new Date('2026-09-08T10:05:00.000Z')
      });
      assert.equal(foreign.ok, false);
      assert.equal(foreign.code, 'FOREIGN_OWNER');

      const expired = completeInboxProcessing(dir, {
        runId: 'owned-run',
        processor: 'Ada',
        host: 'laptop-a',
        completedAt: new Date('2026-09-08T11:00:00.000Z')
      });
      assert.equal(expired.ok, false);
      assert.equal(expired.code, 'STALE_LOCK');
    });
  });

  it('fails closed when a synced lock is missing ownership or lease metadata', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const lockPath = path.join(dir, 'governance', 'inbox-processing.lock.json');
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({
        status: 'processing',
        run_id: 'incomplete-lock'
      }));

      const audit = auditInbox(dir);
      assert.equal(audit.ok, false);
      assert.equal(audit.issues.some((issue) => issue.code === 'INVALID_LOCK'), true);

      const completion = completeInboxProcessing(dir, {
        runId: 'incomplete-lock',
        processor: 'Ada',
        host: 'laptop-a',
        completedAt: new Date('2026-09-08T10:00:00.000Z')
      });
      assert.equal(completion.ok, false);
      assert.equal(completion.code, 'INVALID_LOCK');
    });
  });

  it('fails closed when lease timestamps contradict heartbeat or duration', () => {
    for (const [name, mutation, expectedMessage] of [
      [
        'heartbeat-after-expiry',
        (lock) => ({
          ...lock,
          heartbeat_at: '2026-09-08T10:00:02.000Z',
          expires_at: '2026-09-08T10:00:01.000Z',
          stale_after: '2026-09-08T10:00:01.000Z'
        }),
        /expires_at must be later than heartbeat_at/
      ],
      [
        'duration-mismatch',
        (lock) => ({
          ...lock,
          expires_at: '2026-09-08T10:00:02.000Z',
          stale_after: '2026-09-08T10:00:02.000Z'
        }),
        /expires_at must equal heartbeat_at plus lease_duration_ms/
      ]
    ]) {
      withTempInstance((dir) => {
        createWorkspaceScaffold(dir);
        const claimed = claimInboxProcessing(dir, {
          runId: 'invalid-lease-' + name,
          processor: 'Ada',
          host: 'laptop-a',
          leaseMs: 60000,
          now: new Date('2026-09-08T10:00:00.000Z')
        });
        const lockPath = path.join(dir, 'governance/inbox-processing.lock.json');
        fs.writeFileSync(lockPath, JSON.stringify(mutation(claimed.lock)));

        const audit = auditInbox(dir);
        assert.equal(audit.ok, false);
        assert.equal(audit.issues.some((issue) => issue.code === 'INVALID_LOCK'), true);
        assert.match(audit.issues.find((issue) => issue.code === 'INVALID_LOCK').message,
          expectedMessage);
        const heartbeat = heartbeatInboxProcessing(dir, {
          runId: claimed.run_id,
          processor: 'Ada',
          host: 'laptop-a',
          now: new Date('2026-09-08T10:00:00.500Z')
        });
        assert.equal(heartbeat.ok, false);
        assert.equal(heartbeat.code, 'INVALID_LOCK');
      });
    }
  });

  it('rejects v2 receipts without a matching immutable lock snapshot', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const receipts = path.join(dir, 'governance/run-receipts/inbox-processing');
      fs.mkdirSync(receipts, { recursive: true });
      fs.writeFileSync(path.join(receipts, 'broken-v2.json'), JSON.stringify({
        schema_version: 2,
        receipt_id: 'broken-v2',
        run_id: 'broken-v2',
        lock_id: 'broken-v2',
        status: 'completed',
        processor: 'Ada',
        claimed_by: 'Ada',
        host: 'laptop-a',
        started_at: '2026-09-08T10:00:00.000Z',
        heartbeat_at: '2026-09-08T10:00:00.000Z',
        expires_at: '2026-09-09T10:00:00.000Z',
        completed_at: '2026-09-08T10:05:00.000Z',
        claimed_paths: [],
        processed: [],
        unresolved_paths: [],
        summary: 'Broken receipt'
      }));

      const inspected = inspectInboxProcessing(dir);
      assert.equal(inspected.receipts.length, 0);
      assert.equal(inspected.invalidReceipts.length, 1);
      assert.match(inspected.invalidReceipts[0].error, /lock_snapshot/);
      assert.equal(claimInboxProcessing(dir, {
        runId: 'blocked-by-receipt',
        processor: 'Ada',
        host: 'laptop-a'
      }).code, 'INVALID_RECEIPT');
    });
  });

  it('rejects v2 receipts that omit checkpointed paths from their terminal state', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const owner = {
        runId: 'snapshot-mismatch-run',
        processor: 'Ada',
        host: 'laptop-a',
        claimedPaths: ['6-raw/inbox/a.md', '6-raw/inbox/b.md'],
        now: new Date('2026-09-08T10:00:00.000Z')
      };
      assert.equal(claimInboxProcessing(dir, owner).ok, true);
      assert.equal(checkpointInboxProcessing(dir, {
        ...owner,
        processed: ['6-raw/inbox/a.md'],
        now: new Date('2026-09-08T10:01:00.000Z')
      }).ok, true);
      const lock = inspectInboxProcessing(dir).lock;
      const receipts = path.join(dir, 'governance/run-receipts/inbox-processing');
      fs.mkdirSync(receipts, { recursive: true });
      fs.writeFileSync(path.join(receipts, 'snapshot-mismatch.json'), JSON.stringify({
        schema_version: 2,
        receipt_id: owner.runId,
        run_id: owner.runId,
        lock_id: owner.runId,
        status: 'completed',
        processor: owner.processor,
        claimed_by: owner.processor,
        host: owner.host,
        started_at: lock.started_at,
        heartbeat_at: lock.heartbeat_at,
        expires_at: lock.expires_at,
        completed_at: '2026-09-08T10:02:00.000Z',
        claimed_paths: ['6-raw/inbox/a.md', '6-raw/inbox/b.md'],
        processed: ['6-raw/inbox/b.md'],
        unresolved_paths: ['6-raw/inbox/a.md'],
        summary: 'Contradictory terminal receipt.',
        lock_snapshot: lock
      }));

      const inspected = inspectInboxProcessing(dir);
      const audit = auditInbox(dir);
      const metrics = backfillProcessedInboxMetrics(dir);
      assert.equal(inspected.receipts.length, 0);
      assert.equal(inspected.invalidReceipts.length, 1);
      assert.match(inspected.invalidReceipts[0].error, /checkpointed in lock_snapshot/);
      assert.equal(audit.ok, false);
      assert.equal(audit.issues.some((issue) => issue.code === 'INVALID_RECEIPT'), true);
      assert.equal(metrics.processed_paths_counted, 0);
      assert.equal(claimInboxProcessing(dir, {
        runId: 'blocked-by-snapshot-mismatch',
        processor: 'Grace',
        host: 'laptop-b'
      }).code, 'INVALID_RECEIPT');
    });
  });

  it('checkpoints partial progress and resumes without reprocessing completed paths', () => {
    withTempInstance((dir) => {
      claimInboxProcessing(dir, {
        runId: 'partial-run',
        processor: 'Ada',
        host: 'laptop-a',
        claimedPaths: ['6-raw/inbox/a.md', '6-raw/inbox/b.md', '6-raw/inbox/c.md'],
        now: new Date('2026-09-08T10:00:00.000Z')
      });

      const checkpoint = checkpointInboxProcessing(dir, {
        runId: 'partial-run',
        processor: 'Ada',
        host: 'laptop-a',
        processed: ['6-raw/inbox/a.md'],
        now: new Date('2026-09-08T10:10:00.000Z')
      });
      assert.equal(checkpoint.ok, true);
      assert.deepEqual(checkpoint.lock.processed_paths, ['6-raw/inbox/a.md']);
      assert.deepEqual(checkpoint.lock.unresolved_paths, [
        '6-raw/inbox/b.md',
        '6-raw/inbox/c.md'
      ]);
      assert.ok(fs.existsSync(path.join(dir, 'governance', 'inbox-processing.lock.json')));

      const completed = completeInboxProcessing(dir, {
        runId: 'partial-run',
        processor: 'Ada',
        host: 'laptop-a',
        processed: ['6-raw/inbox/b.md'],
        completedAt: new Date('2026-09-08T10:20:00.000Z')
      });
      assert.equal(completed.ok, true);
      assert.deepEqual(completed.receipt.processed, [
        '6-raw/inbox/a.md',
        '6-raw/inbox/b.md'
      ]);
      assert.deepEqual(completed.receipt.unresolved_paths, ['6-raw/inbox/c.md']);
      assert.equal(fs.existsSync(path.join(dir, 'governance', 'inbox-processing.lock.json')), false);

      const retry = completeInboxProcessing(dir, {
        runId: 'partial-run',
        processor: 'Ada',
        host: 'laptop-a',
        processed: ['6-raw/inbox/b.md'],
        completedAt: new Date('2026-09-09T10:20:00.000Z')
      });
      assert.equal(retry.ok, true);
      assert.equal(retry.idempotent, true);
      assert.equal(fs.readdirSync(path.join(dir, 'governance', 'run-receipts', 'inbox-processing'))
        .filter((file) => file.endsWith('.json')).length, 1);
    });
  });

  it('rejects checkpoints for already-receipted paths after an empty claim', () => {
    withTempInstance((dir) => {
      completeInboxProcessing(dir, {
        runId: 'prior-completed-run',
        processor: 'Ada',
        host: 'laptop-a',
        overrideMissingLock: true,
        reason: 'Recorded the prior completed path.',
        completedAt: new Date('2026-09-08T10:00:00.000Z'),
        processed: ['6-raw/inbox/a.md']
      });
      const claim = claimInboxProcessing(dir, {
        runId: 'empty-claim-run',
        processor: 'Ada',
        host: 'laptop-a',
        now: new Date('2026-09-08T10:01:00.000Z')
      });
      const checkpoint = checkpointInboxProcessing(dir, {
        runId: 'empty-claim-run',
        processor: 'Ada',
        host: 'laptop-a',
        processed: ['6-raw/inbox/a.md'],
        now: new Date('2026-09-08T10:02:00.000Z')
      });

      assert.equal(claim.ok, true);
      assert.equal(checkpoint.ok, false);
      assert.equal(checkpoint.code, 'ALREADY_PROCESSED');
      assert.deepEqual(inspectInboxProcessing(dir).lock.processed_paths, []);
    });
  });

  it('rejects checkpoint and completion paths outside an empty claim', () => {
    withTempInstance((dir) => {
      const owner = {
        runId: 'empty-scope-run',
        processor: 'Ada',
        host: 'laptop-a',
        now: new Date('2026-09-08T10:00:00.000Z')
      };
      const claim = claimInboxProcessing(dir, owner);
      const checkpoint = checkpointInboxProcessing(dir, {
        ...owner,
        processed: ['6-raw/inbox/a.md'],
        now: new Date('2026-09-08T10:01:00.000Z')
      });
      const completion = completeInboxProcessing(dir, {
        ...owner,
        processed: ['6-raw/inbox/a.md'],
        completedAt: new Date('2026-09-08T10:02:00.000Z')
      });

      assert.equal(claim.ok, true);
      assert.equal(checkpoint.ok, false);
      assert.equal(checkpoint.code, 'UNCLAIMED_PATH');
      assert.equal(completion.ok, false);
      assert.equal(completion.code, 'UNCLAIMED_PATH');
      assert.deepEqual(inspectInboxProcessing(dir).lock.processed_paths, []);
      assert.equal(inspectInboxProcessing(dir).receipts.length, 0);
    });
  });

  it('records a stale-lock override with the replaced lease and preserves its checkpoint', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      claimInboxProcessing(dir, {
        runId: 'stale-run',
        processor: 'Ada',
        host: 'laptop-a',
        leaseMs: 1000,
        claimedPaths: ['6-raw/inbox/a.md', '6-raw/inbox/b.md'],
        now: new Date('2026-09-08T10:00:00.000Z')
      });
      checkpointInboxProcessing(dir, {
        runId: 'stale-run',
        processor: 'Ada',
        host: 'laptop-a',
        leaseMs: 1000,
        processed: ['6-raw/inbox/a.md'],
        now: new Date('2026-09-08T10:00:00.500Z')
      });

      const missingRunId = overrideStaleInboxProcessing(dir, {
        processor: 'Grace',
        host: 'laptop-b',
        reason: 'A replacement must identify its run explicitly.',
        now: new Date('2026-09-08T10:00:02.000Z')
      });
      assert.equal(missingRunId.ok, false);
      assert.equal(missingRunId.code, 'RUN_ID_REQUIRED');

      const recovered = overrideStaleInboxProcessing(dir, {
        runId: 'resumed-run',
        processor: 'Grace',
        host: 'laptop-b',
        claimedPaths: ['6-raw/inbox/c.md'],
        reason: 'Confirmed the previous worker stopped and inspected sync history.',
        now: new Date('2026-09-08T10:00:02.000Z')
      });
      assert.equal(recovered.ok, true);
      assert.equal(recovered.override.actor, 'Grace');
      assert.equal(recovered.override.overridden_at, '2026-09-08T10:00:02.000Z');
      assert.equal(recovered.override.reason, 'Confirmed the previous worker stopped and inspected sync history.');
      assert.equal(recovered.override.replaced_lock.run_id, 'stale-run');
      assert.deepEqual(recovered.lock.claimed_paths, [
        '6-raw/inbox/a.md',
        '6-raw/inbox/b.md',
        '6-raw/inbox/c.md'
      ]);
      assert.deepEqual(recovered.lock.processed_paths, ['6-raw/inbox/a.md']);
      assert.deepEqual(recovered.lock.unresolved_paths, [
        '6-raw/inbox/b.md',
        '6-raw/inbox/c.md'
      ]);
      assert.equal(recovered.lock.resumed_from_run_id, 'stale-run');

      const resumedCompletion = completeInboxProcessing(dir, {
        runId: 'resumed-run',
        processor: 'Grace',
        host: 'laptop-b',
        processed: ['6-raw/inbox/b.md', '6-raw/inbox/c.md'],
        completedAt: new Date('2026-09-08T10:00:03.000Z')
      });
      assert.equal(resumedCompletion.ok, true);
      assert.deepEqual(resumedCompletion.receipt.processed, [
        '6-raw/inbox/a.md',
        '6-raw/inbox/b.md',
        '6-raw/inbox/c.md'
      ]);
      assert.deepEqual(resumedCompletion.receipt.unresolved_paths, []);

      const inspected = inspectInboxProcessing(dir);
      assert.equal(inspected.overrides.length, 1);
      assert.equal(inspected.overrides[0].override.replacement_run_id, 'resumed-run');
      const audit = auditInbox(dir, { now: new Date('2026-09-08T10:00:02.000Z') });
      assert.equal(audit.overrides.length, 1);
      assert.equal(audit.overrides[0].override.reason, recovered.override.reason);
    });
  });

  it('migrates an expired legacy lock only through an audited stale override', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const lockPath = path.join(dir, 'governance', 'inbox-processing.lock.json');
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({
        lock_id: 'legacy-run',
        status: 'processing',
        claimed_by: 'Ada',
        started_at: '2026-09-08T10:00:00.000Z',
        stale_after: '2026-09-08T10:00:01.000Z',
        inbox: '6-raw/inbox'
      }));

      const normal = completeInboxProcessing(dir, {
        runId: 'legacy-run',
        processor: 'Ada',
        host: 'laptop-a',
        completedAt: new Date('2026-09-08T10:00:02.000Z')
      });
      assert.equal(normal.ok, false);
      assert.equal(normal.code, 'INVALID_LOCK');

      const recovered = overrideStaleInboxProcessing(dir, {
        runId: 'migrated-run',
        processor: 'Grace',
        host: 'laptop-b',
        claimedPaths: ['6-raw/inbox/a.md'],
        reason: 'Inspected the expired legacy lock before migrating it.',
        now: new Date('2026-09-08T10:00:02.000Z')
      });

      assert.equal(recovered.ok, true);
      assert.equal(recovered.override.type, 'legacy-stale-lock');
      assert.equal(recovered.override.action, 'migrate-legacy-stale-lock');
      assert.equal(recovered.override.replaced_lock.lock_id, 'legacy-run');
      assert.equal(recovered.lock.schema_version, 2);
      assert.equal(recovered.lock.run_id, 'migrated-run');
      assert.equal(recovered.lock.host, 'laptop-b');
      assert.deepEqual(recovered.lock.claimed_paths, ['6-raw/inbox/a.md']);
    });
  });

  it('does not leave a stale override record when replacement validation fails', () => {
    withTempInstance((dir) => {
      claimInboxProcessing(dir, {
        runId: 'stale-validation-run',
        processor: 'Ada',
        host: 'laptop-a',
        leaseMs: 1000,
        now: new Date('2026-09-08T10:00:00.000Z')
      });

      assert.throws(() => overrideStaleInboxProcessing(dir, {
        runId: 'replacement-validation-run',
        processor: 'Grace',
        host: 'laptop-b',
        leaseMs: 0,
        reason: 'The replacement lease is invalid.',
        now: new Date('2026-09-08T10:00:02.000Z')
      }), /Lease duration must be a positive number/);

      const overridesDir = path.join(
        dir,
        'governance',
        'run-receipts',
        'inbox-processing',
        'overrides'
      );
      assert.equal(fs.existsSync(overridesDir), false);
      assert.equal(inspectInboxProcessing(dir).lock.run_id, 'stale-validation-run');
    });
  });

  it('returns structured remediation when stale recovery has no reason', () => {
    withTempInstance((dir) => {
      claimInboxProcessing(dir, {
        runId: 'stale-reason-run',
        processor: 'Ada',
        host: 'laptop-a',
        leaseMs: 1000,
        now: new Date('2026-09-08T10:00:00.000Z')
      });

      const result = overrideStaleInboxProcessing(dir, {
        runId: 'replacement-reason-run',
        processor: 'Grace',
        host: 'laptop-b',
        now: new Date('2026-09-08T10:00:02.000Z')
      });

      assert.equal(result.ok, false);
      assert.equal(result.code, 'OVERRIDE_REASON_REQUIRED');
      assert.match(result.message, /explicit override reason/);
      assert.equal(inspectInboxProcessing(dir).lock.run_id, 'stale-reason-run');
      assert.equal(fs.existsSync(path.join(
        dir,
        'governance/run-receipts/inbox-processing/overrides'
      )), false);
    });
  });

  it('rejects stale recovery into a run that already has a completion receipt', () => {
    withTempInstance((dir) => {
      claimInboxProcessing(dir, {
        runId: 'completed-run',
        processor: 'Ada',
        host: 'laptop-a',
        now: new Date('2026-09-08T09:00:00.000Z')
      });
      completeInboxProcessing(dir, {
        runId: 'completed-run',
        processor: 'Ada',
        host: 'laptop-a',
        completedAt: new Date('2026-09-08T09:01:00.000Z')
      });

      claimInboxProcessing(dir, {
        runId: 'stale-run',
        processor: 'Ada',
        host: 'laptop-a',
        leaseMs: 1000,
        now: new Date('2026-09-08T10:00:00.000Z')
      });
      const recovered = overrideStaleInboxProcessing(dir, {
        runId: 'completed-run',
        processor: 'Grace',
        host: 'laptop-b',
        reason: 'Do not reuse a completed run ID.',
        now: new Date('2026-09-08T10:00:02.000Z')
      });

      assert.equal(recovered.ok, false);
      assert.equal(recovered.code, 'RUN_ALREADY_COMPLETED');
      assert.equal(inspectInboxProcessing(dir).lock.run_id, 'stale-run');
      assert.equal(inspectInboxProcessing(dir).overrides.length, 0);
    });
  });

  it('rejects stale recovery that reuses the expired run ID', () => {
    withTempInstance((dir) => {
      claimInboxProcessing(dir, {
        runId: 'expired-run',
        processor: 'Ada',
        host: 'laptop-a',
        leaseMs: 1000,
        now: new Date('2026-09-08T10:00:00.000Z')
      });

      const recovered = overrideStaleInboxProcessing(dir, {
        runId: 'expired-run',
        processor: 'Grace',
        host: 'laptop-b',
        reason: 'The expired worker stopped and its run identity must not be reused.',
        now: new Date('2026-09-08T10:00:02.000Z')
      });

      assert.equal(recovered.ok, false);
      assert.equal(recovered.code, 'RUN_ID_REUSE');
      assert.equal(inspectInboxProcessing(dir).lock.run_id, 'expired-run');
      assert.equal(inspectInboxProcessing(dir).overrides.length, 0);
    });
  });

  it('validates run IDs before using them as receipt filenames', () => {
    withTempInstance((dir) => {
      const invalid = claimInboxProcessing(dir, {
        runId: 'a/b',
        processor: 'Ada',
        host: 'laptop-a'
      });
      assert.equal(invalid.ok, false);
      assert.equal(invalid.code, 'INVALID_RUN_ID');

      const valid = claimInboxProcessing(dir, {
        runId: 'a_b',
        processor: 'Ada',
        host: 'laptop-a',
        now: new Date('2026-09-08T10:00:00.000Z')
      });
      const completed = completeInboxProcessing(dir, {
        runId: 'a_b',
        processor: 'Ada',
        host: 'laptop-a',
        completedAt: new Date('2026-09-08T10:01:00.000Z')
      });

      assert.equal(valid.ok, true);
      assert.equal(completed.ok, true);
      assert.match(completed.receiptPath, /[\\/]a_b-[0-9a-f]{16}\.json$/);
    });
  });

  it('detects sync conflict names and duplicate receipt runs without choosing a copy', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const inbox = path.join(dir, '6-raw', 'inbox');
      fs.writeFileSync(path.join(inbox, 'source.md'), 'one');
      fs.writeFileSync(path.join(inbox, 'duplicate-orders.md'), 'ordinary name');
      fs.writeFileSync(path.join(inbox, 'source (conflicted copy).md'), 'two');
      assert.deepEqual(discoverInboxConflictFiles(dir), ['6-raw/inbox/source (conflicted copy).md']);
      const conflictAudit = auditInbox(dir);
      assert.deepEqual(conflictAudit.syncConflictFiles, ['6-raw/inbox/source (conflicted copy).md']);
      assert.equal(conflictAudit.issues.some((issue) => issue.code === 'SYNC_CONFLICT'), true);
      const claim = claimInboxProcessing(dir, {
        runId: 'conflict-run',
        processor: 'Ada',
        host: 'laptop-a'
      });
      assert.equal(claim.ok, false);
      assert.equal(claim.code, 'SYNC_CONFLICT');
      assert.equal(fs.readFileSync(path.join(inbox, 'source.md'), 'utf8'), 'one');
      assert.equal(fs.readFileSync(path.join(inbox, 'source (conflicted copy).md'), 'utf8'), 'two');

      fs.unlinkSync(path.join(inbox, 'source (conflicted copy).md'));
      const receipts = path.join(dir, 'governance', 'run-receipts', 'inbox-processing');
      fs.mkdirSync(receipts, { recursive: true });
      const first = {
        run_id: 'duplicate-run',
        receipt_id: 'duplicate-run',
        completed_at: '2026-09-08T10:00:00.000Z',
        processed: ['6-raw/inbox/source.md']
      };
      fs.writeFileSync(path.join(receipts, 'one.json'), JSON.stringify(first));
      fs.writeFileSync(path.join(receipts, 'two.json'), JSON.stringify(first));
      const duplicateAudit = auditInbox(dir);
      assert.equal(duplicateAudit.duplicateReceipts.length, 1);
      assert.equal(duplicateAudit.issues.some((issue) => issue.code === 'DUPLICATE_RECEIPT'), true);
      assert.deepEqual(duplicateAudit.processedPathConflicts, [{
        path: '6-raw/inbox/source.md',
        runs: [{
          run_id: 'duplicate-run',
          receipt_paths: [
            'governance/run-receipts/inbox-processing/one.json',
            'governance/run-receipts/inbox-processing/two.json'
          ]
        }]
      }]);
      assert.equal(duplicateAudit.issues.some((issue) => issue.code === 'PROCESSED_PATH_CONFLICT'), true);
      assert.deepEqual(duplicateAudit.processed, []);
    });
  });

  it('detects provider-style conflicted lock copies before mutations', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const owner = {
        runId: 'lock-copy-run',
        processor: 'Ada',
        host: 'laptop-a',
        now: new Date('2026-09-08T10:00:00.000Z')
      };
      const claimed = claimInboxProcessing(dir, owner);
      assert.equal(claimed.ok, true);
      const conflictPath = path.join(
        dir,
        'governance/inbox-processing (conflicted copy).lock.json'
      );
      fs.writeFileSync(conflictPath, JSON.stringify(claimed.lock));

      const inspected = inspectInboxProcessing(dir);
      const audit = auditInbox(dir);
      const heartbeat = heartbeatInboxProcessing(dir, {
        ...owner,
        now: new Date('2026-09-08T10:00:01.000Z')
      });
      assert.deepEqual(inspected.conflictLockPaths, [
        'governance/inbox-processing (conflicted copy).lock.json'
      ]);
      assert.equal(audit.issues.some((issue) => issue.code === 'SYNC_CONFLICT'), true);
      assert.equal(heartbeat.ok, false);
      assert.equal(heartbeat.code, 'SYNC_CONFLICT');
      assert.equal(fs.existsSync(conflictPath), true);
    });
  });

  it('fails a claim when a provider conflict copy arrives during the lock write', (t) => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const lockPath = path.join(dir, 'governance/inbox-processing.lock.json');
      const conflictPath = path.join(
        dir,
        'governance/inbox-processing (conflicted copy).lock.json'
      );
      const originalWrite = fs.writeFileSync;
      const hook = t.mock.method(fs, 'writeFileSync', (file, data, ...args) => {
        const result = originalWrite(file, data, ...args);
        if (String(file) === lockPath) originalWrite(conflictPath, data);
        return result;
      });

      let result;
      try {
        result = claimInboxProcessing(dir, {
          runId: 'claim-conflict-race',
          processor: 'Ada',
          host: 'laptop-a'
        });
      } finally {
        hook.mock.restore();
      }

      assert.equal(result.ok, false);
      assert.equal(result.code, 'SYNC_CONFLICT');
      assert.match(result.message, /post-write audit/);
      assert.equal(fs.existsSync(lockPath), true);
      assert.equal(fs.existsSync(conflictPath), true);
      assert.equal(inspectInboxProcessing(dir).conflictLockPaths.length, 1);
    });
  });

  it('fails a claim when the canonical lock is replaced after its write', (t) => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const lockPath = path.join(dir, 'governance/inbox-processing.lock.json');
      const originalWrite = fs.writeFileSync;
      const hook = t.mock.method(fs, 'writeFileSync', (file, data, ...args) => {
        const result = originalWrite(file, data, ...args);
        if (String(file) === lockPath) {
          const local = JSON.parse(data);
          originalWrite(lockPath, JSON.stringify({
            ...local,
            run_id: 'remote-lock-run',
            lock_id: 'remote-lock-run',
            processor: 'Grace',
            claimed_by: 'Grace',
            host: 'laptop-b'
          }));
        }
        return result;
      });

      let result;
      try {
        result = claimInboxProcessing(dir, {
          runId: 'local-lock-run',
          processor: 'Ada',
          host: 'laptop-a'
        });
      } finally {
        hook.mock.restore();
      }

      assert.equal(result.ok, false);
      assert.equal(result.code, 'LOCK_CHANGED');
      assert.match(result.message, /expected snapshot/);
      assert.equal(inspectInboxProcessing(dir).lock.run_id, 'remote-lock-run');
    });
  });

  it('detects split-brain receipts that claim the same canonical path', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const inbox = path.join(dir, '6-raw', 'inbox');
      fs.writeFileSync(path.join(inbox, 'a.md'), 'a');
      fs.writeFileSync(path.join(inbox, 'b.md'), 'b');
      const receipts = path.join(dir, 'governance', 'run-receipts', 'inbox-processing');
      fs.mkdirSync(receipts, { recursive: true });
      fs.writeFileSync(path.join(receipts, 'one.json'), JSON.stringify({
        run_id: 'offline-run-a',
        completed_at: '2026-09-08T10:00:00.000Z',
        processed: ['6-raw/inbox/a.md']
      }));
      fs.writeFileSync(path.join(receipts, 'two.json'), JSON.stringify({
        run_id: 'offline-run-b',
        completed_at: '2026-09-08T10:01:00.000Z',
        processed: [path.join(dir, '6-raw', 'inbox', 'a.md'), '6-raw/inbox/b.md']
      }));

      const inspected = inspectInboxProcessing(dir);
      assert.deepEqual(inspected.processedPathConflicts, [{
        path: '6-raw/inbox/a.md',
        runs: [
          { run_id: 'offline-run-a', receipt_paths: [
            'governance/run-receipts/inbox-processing/one.json'
          ] },
          { run_id: 'offline-run-b', receipt_paths: [
            'governance/run-receipts/inbox-processing/two.json'
          ] }
        ]
      }]);

      const audit = auditInbox(dir);
      assert.deepEqual(audit.processed, []);
      assert.deepEqual(audit.unprocessed, ['6-raw/inbox/a.md', '6-raw/inbox/b.md']);
      assert.equal(audit.issues.some((issue) => issue.code === 'PROCESSED_PATH_CONFLICT'), true);
      assert.equal(audit.ok, false);

      const claim = claimInboxProcessing(dir, {
        runId: 'blocked-run',
        processor: 'Ada',
        host: 'laptop-a'
      });
      assert.equal(claim.ok, false);
      assert.equal(claim.code, 'PROCESSED_PATH_CONFLICT');

      const metrics = backfillProcessedInboxMetrics(dir, {
        now: new Date('2026-09-08T12:00:00.000Z')
      });
      assert.equal(metrics.processed_paths_conflicted, 1);
      assert.equal(metrics.processed_paths_counted, 0);
      const daily = JSON.parse(fs.readFileSync(getMetricsPaths(dir).dailyPath, 'utf8'));
      assert.deepEqual(daily.records, []);
    });
  });

  it('excludes the full union of divergent duplicate-run receipt paths', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const inbox = path.join(dir, '6-raw', 'inbox');
      fs.writeFileSync(path.join(inbox, 'a.md'), 'a');
      fs.writeFileSync(path.join(inbox, 'b.md'), 'b');
      const receipts = path.join(dir, 'governance', 'run-receipts', 'inbox-processing');
      fs.mkdirSync(receipts, { recursive: true });
      fs.writeFileSync(path.join(receipts, 'one.json'), JSON.stringify({
        run_id: 'divergent-run',
        completed_at: '2026-09-08T10:00:00.000Z',
        processed: ['6-raw/inbox/a.md']
      }));
      fs.writeFileSync(path.join(receipts, 'two.json'), JSON.stringify({
        run_id: 'divergent-run',
        completed_at: '2026-09-08T10:01:00.000Z',
        processed: ['6-raw/inbox/b.md']
      }));

      const audit = auditInbox(dir);
      assert.deepEqual(audit.processed, []);
      assert.deepEqual(audit.unprocessed, ['6-raw/inbox/a.md', '6-raw/inbox/b.md']);
      assert.deepEqual(audit.processedPathConflicts.map((item) => item.path), [
        '6-raw/inbox/a.md',
        '6-raw/inbox/b.md'
      ]);

      const metrics = backfillProcessedInboxMetrics(dir, {
        now: new Date('2026-09-08T12:00:00.000Z')
      });
      assert.equal(metrics.processed_paths_conflicted, 2);
      assert.equal(metrics.processed_paths_counted, 0);
    });
  });

  it('fails closed on malformed override JSON', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const overrides = path.join(
        dir,
        'governance',
        'run-receipts',
        'inbox-processing',
        'overrides'
      );
      fs.mkdirSync(overrides, { recursive: true });
      fs.writeFileSync(path.join(overrides, 'truncated.json'), '{"override_id":"broken"');

      const inspected = inspectInboxProcessing(dir);
      assert.equal(inspected.overrides.length, 0);
      assert.equal(inspected.invalidOverrides.length, 1);
      assert.match(inspected.invalidOverrides[0].error, /Unexpected end|JSON/);

      const audit = auditInbox(dir);
      assert.equal(audit.issues.some((issue) => issue.code === 'INVALID_OVERRIDE'), true);
      assert.equal(audit.ok, false);

      const claim = claimInboxProcessing(dir, {
        runId: 'blocked-by-override',
        processor: 'Ada',
        host: 'laptop-a'
      });
      assert.equal(claim.ok, false);
      assert.equal(claim.code, 'INVALID_OVERRIDE');
    });
  });

  it('does not count a receipt when finalized stale-recovery evidence is invalid', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const source = '6-raw/inbox/recovery-evidence.md';
      fs.writeFileSync(path.join(dir, source), 'preserve');
      const originalOwner = { processor: 'Ada', host: 'laptop-a' };
      assert.equal(claimInboxProcessing(dir, {
        ...originalOwner,
        runId: 'evidence-stale-run',
        leaseMs: 1000,
        claimedPaths: [source],
        now: new Date('2026-09-08T10:00:00.000Z')
      }).ok, true);
      const recovered = overrideStaleInboxProcessing(dir, {
        runId: 'evidence-replacement-run',
        processor: 'Grace',
        host: 'laptop-b',
        reason: 'Confirmed the prior worker stopped before resuming.',
        now: new Date('2026-09-08T10:00:02.000Z')
      });
      assert.equal(recovered.ok, true);
      assert.equal(completeInboxProcessing(dir, {
        runId: recovered.run_id,
        processor: 'Grace',
        host: 'laptop-b',
        processed: [source],
        completedAt: new Date('2026-09-08T10:00:03.000Z')
      }).ok, true);

      const overridePath = path.join(dir, recovered.overridePath);
      const override = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
      override.replaced_lock = {};
      fs.writeFileSync(overridePath, JSON.stringify(override));

      const inspected = inspectInboxProcessing(dir);
      const audit = auditInbox(dir);
      const metrics = backfillProcessedInboxMetrics(dir, {
        now: new Date('2026-09-08T11:00:00.000Z')
      });
      assert.equal(inspected.invalidOverrides.length, 1);
      assert.match(inspected.invalidOverrides[0].error, /replaced_lock/);
      assert.equal(audit.issues.some((issue) => issue.code === 'INVALID_OVERRIDE'), true);
      assert.equal(metrics.receipts_counted, 0);
      assert.equal(metrics.receipts_skipped, 1);
      assert.equal(metrics.processed_paths_counted, 0);
      assert.equal(fs.readFileSync(path.join(dir, source), 'utf8'), 'preserve');
    });
  });

  it('reports prepared overrides as recoverable incomplete audit state', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const overrides = path.join(
        dir,
        'governance',
        'run-receipts',
        'inbox-processing',
        'overrides'
      );
      fs.mkdirSync(overrides, { recursive: true });
      fs.writeFileSync(path.join(overrides, 'prepared.json'), JSON.stringify({
        schema_version: 2,
        override_id: 'prepared-override',
        type: 'stale-lock',
        action: 'replace-stale-lock',
        actor: 'Grace',
        processor: 'Grace',
        host: 'laptop-b',
        overridden_at: '2026-09-08T10:00:00.000Z',
        state: 'prepared',
        finalized_at: null,
        reason: 'Replacement was prepared before the worker stopped.',
        replaced_lock: {
          schema_version: 2,
          lock_version: 1,
          run_id: 'stale-run',
          lock_id: 'stale-run',
          status: 'processing',
          processor: 'Ada',
          claimed_by: 'Ada',
          host: 'laptop-a',
          started_at: '2026-09-08T10:00:00.000Z',
          heartbeat_at: '2026-09-08T10:00:00.000Z',
          expires_at: '2026-09-08T10:00:01.000Z',
          stale_after: '2026-09-08T10:00:01.000Z',
          lease_duration_ms: 1000,
          claimed_paths: [],
          processed_paths: [],
          unresolved_paths: [],
          inbox: '6-raw/inbox'
        },
        replacement_run_id: 'replacement-run'
      }));

      const inspected = inspectInboxProcessing(dir);
      assert.equal(inspected.incompleteOverrides.length, 1);
      const audit = auditInbox(dir);
      assert.equal(audit.issues.some((issue) => issue.code === 'INCOMPLETE_OVERRIDE'), true);
      assert.equal(audit.ok, false);
      const claim = claimInboxProcessing(dir, {
        runId: 'blocked-by-prepared-override',
        processor: 'Ada',
        host: 'laptop-a'
      });
      assert.equal(claim.ok, false);
      assert.equal(claim.code, 'INCOMPLETE_OVERRIDE');
    });
  });

  it('does not use receipt paths when completion metadata is missing', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const inbox = path.join(dir, '6-raw', 'inbox');
      fs.writeFileSync(path.join(inbox, 'missing-time.md'), 'not complete');
      const receipts = path.join(dir, 'governance', 'run-receipts', 'inbox-processing');
      fs.mkdirSync(receipts, { recursive: true });
      fs.writeFileSync(path.join(receipts, 'missing-completed-at.json'), JSON.stringify({
        run_id: 'missing-time-run',
        processed: ['6-raw/inbox/missing-time.md']
      }));

      const inspected = inspectInboxProcessing(dir);
      assert.equal(inspected.receipts.length, 0);
      assert.equal(inspected.invalidReceipts.length, 1);
      assert.match(inspected.invalidReceipts[0].error, /completed_at/);

      const audit = auditInbox(dir);
      assert.deepEqual(audit.processed, []);
      assert.deepEqual(audit.unprocessed, ['6-raw/inbox/missing-time.md']);
      assert.equal(audit.issues.some((issue) => issue.code === 'INVALID_RECEIPT'), true);
      assert.equal(audit.ok, false);
    });
  });

  it('skips sync-conflict receipts during metrics backfill', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const receipts = path.join(dir, 'governance', 'run-receipts', 'inbox-processing');
      fs.mkdirSync(receipts, { recursive: true });
      fs.writeFileSync(path.join(receipts, 'run (conflicted copy).json'), JSON.stringify({
        run_id: 'sync-conflict-receipt',
        completed_at: '2026-09-08T10:00:00.000Z',
        processed: ['6-raw/inbox/a.md']
      }));

      const result = backfillProcessedInboxMetrics(dir, {
        now: new Date('2026-09-08T12:00:00.000Z')
      });
      assert.equal(result.conflict_receipts_skipped, 1);
      assert.equal(result.processed_paths_counted, 0);
      assert.deepEqual(JSON.parse(fs.readFileSync(getMetricsPaths(dir).dailyPath, 'utf8')).records, []);
    });
  });
});

describe('inbox mutation race regressions', () => {
  for (const retry of [false, true]) {
    for (const arrival of ['before detach', 'after detach', 'during restore']) {
      it('preserves arriving locks ' + arrival + (retry ? ' on completion retry' : ''), (t) => {
        withTempInstance((dir) => {
          const options = { runId: 'owned', processor: 'Ada', host: 'laptop-a' };
          const claimed = claimInboxProcessing(dir, options);
          assert.equal(claimed.ok, true);
          const lockPath = path.join(dir, 'governance/inbox-processing.lock.json');
          if (retry) {
            assert.equal(completeInboxProcessing(dir, options).ok, true);
            fs.writeFileSync(lockPath, JSON.stringify(claimed.lock));
          }
          const incoming = { ...claimed.lock, run_id: 'incoming', lock_id: 'incoming', host: 'laptop-b' };
          const newer = { ...incoming, run_id: 'newer', lock_id: 'newer', host: 'laptop-c' };
          const originalRename = fs.renameSync;
          let detachedPath;
          const hook = t.mock.method(fs, 'renameSync', (from, to) => {
            if (from !== lockPath) return originalRename(from, to);
            detachedPath = to;
            if (arrival !== 'after detach') fs.writeFileSync(lockPath, JSON.stringify(incoming));
            const result = originalRename(from, to);
            if (arrival !== 'before detach') {
              fs.writeFileSync(lockPath, JSON.stringify(arrival === 'during restore' ? newer : incoming));
            }
            return result;
          });
          let result;
          try { result = completeInboxProcessing(dir, options); }
          finally { hook.mock.restore(); }
          assert.ok(detachedPath);
          assert.deepEqual(JSON.parse(fs.readFileSync(lockPath)), arrival === 'during restore' ? newer : incoming);
          const state = inspectInboxProcessing(dir);
          assert.equal(state.receipts.length, 1);
          if (arrival === 'during restore') {
            assert.deepEqual(JSON.parse(fs.readFileSync(detachedPath)), incoming);
            assert.equal(state.conflictLockPaths.length, 1);
            assert.equal(claimInboxProcessing(dir, { ...options, runId: 'third' }).code, 'SYNC_CONFLICT');
          } else {
            assert.equal(fs.existsSync(detachedPath), false);
          }
          if (arrival !== 'after detach') {
            if (retry) assert.equal(result.code, 'LOCK_CHANGED');
            else assert.match(result.warning, /lock changed/);
          }
        });
      });
    }
  }

  for (const { missing, variant } of [false, true].flatMap((missing) =>
    ['identical', 'owner', 'processed', 'summary', 'incomplete'].map((variant) => ({ missing, variant })))) {
    it('checks complete contents of a raced receipt: ' + variant + (missing ? ' during missing-lock recovery' : ''), (t) => {
      withTempInstance((dir) => {
        const options = { runId: 'receipt-race', processor: 'Ada', host: 'laptop-a',
          claimedPaths: ['6-raw/inbox/a.md'],
          ...(missing ? { overrideMissingLock: true, reason: 'Recovered completed work.' } : {}) };
        if (!missing) assert.equal(claimInboxProcessing(dir, options).ok, true);
        const lockPath = path.join(dir, 'governance/inbox-processing.lock.json');
        const lockBytes = missing ? null : fs.readFileSync(lockPath, 'utf8');
        const receiptsDir = path.join(dir, 'governance/run-receipts/inbox-processing');
        const originalWrite = fs.writeFileSync;
        let racedPath;
        let racedBytes;
        const hook = t.mock.method(fs, 'writeFileSync', (file, data, ...args) => {
          if (path.dirname(String(file)) === receiptsDir && String(file).endsWith('.json')) {
            racedPath = file;
            const candidate = JSON.parse(data);
            if (variant === 'owner') candidate.host = 'other-host';
            if (variant === 'processed') candidate.processed = ['6-raw/inbox/foreign.md'];
            if (variant === 'summary') candidate.summary = 'Different completion';
            if (variant === 'incomplete') delete candidate.completed_at;
            // Formatting and key order are not part of receipt identity.
            racedBytes = JSON.stringify(Object.fromEntries(Object.entries(candidate).reverse()));
            originalWrite(file, racedBytes);
          }
          return originalWrite(file, data, ...args);
        });
        try {
          if (variant === 'identical') {
            const result = completeInboxProcessing(dir, { ...options, processed: ['6-raw/inbox/a.md'] });
            assert.equal(result.ok, true);
            assert.equal(result.idempotent, true);
            assert.equal(fs.existsSync(lockPath), false);
          } else {
            assert.throws(() => completeInboxProcessing(dir, options), /different contents/);
            if (!missing) assert.equal(fs.readFileSync(lockPath, 'utf8'), lockBytes);
          }
        } finally { hook.mock.restore(); }
        assert.equal(fs.readFileSync(racedPath, 'utf8'), racedBytes);
        assert.equal(fs.readdirSync(receiptsDir).filter((file) => file.endsWith('.json')).length, 1);
        if (missing) {
          const state = inspectInboxProcessing(dir);
          assert.equal(fs.existsSync(lockPath), false);
          assert.equal(state.overrides.length, 1);
          assert.equal(state.overrides[0].override.state, variant === 'identical' ? 'finalized' : 'prepared');
        }
      });
    });
  }

  it('rejects damaged entries in every checkpoint array before any mutation', () => {
    withTempInstance((dir) => {
      const options = { runId: 'damaged', processor: 'Ada', host: 'laptop-a' };
      const claimed = claimInboxProcessing(dir, options);
      const lockPath = path.join(dir, 'governance/inbox-processing.lock.json');
      for (const field of ['claimed_paths', 'processed_paths', 'unresolved_paths']) {
        for (const entry of [null, {}, 7, true, [], '', ' ', './6-raw/inbox/a.md', '6-raw/inbox/../a.md']) {
          const bytes = JSON.stringify({ ...claimed.lock, [field]: [entry] });
          fs.writeFileSync(lockPath, bytes);
          assert.match(inspectInboxProcessing(dir).lockValidationError, new RegExp(field));
          for (const mutate of [claimInboxProcessing, heartbeatInboxProcessing,
            checkpointInboxProcessing, completeInboxProcessing, overrideStaleInboxProcessing]) {
            assert.equal(mutate(dir, { ...options, reason: 'Inspect damaged checkpoint.' }).code, 'INVALID_LOCK');
          }
          assert.equal(fs.readFileSync(lockPath, 'utf8'), bytes);
          assert.equal(inspectInboxProcessing(dir).receipts.length, 0);
        }
      }
    });
  });

  it('recovers stale mutexes with reused PIDs or damaged metadata but preserves live owners', (t) => {
    withTempInstance((dir) => {
      const options = { runId: 'mutex-run', processor: 'Ada', host: 'laptop-a' };
      assert.equal(claimInboxProcessing(dir, options).ok, true);
      const key = createHash('sha256').update(path.join(dir, 'governance/inbox-processing.lock.json')).digest('hex');
      const mutexPath = path.join(os.tmpdir(), 'mole-inbox-processing-' + key + '.json');
      const mutexDirectory = mutexPath.replace(/\.json$/, '.d');
      let live;
      const originalWrite = fs.writeFileSync;
      const hook = t.mock.method(fs, 'writeFileSync', (file, data, ...args) => {
        if (path.dirname(String(file)) === mutexDirectory && String(file).endsWith('.json')) {
          live = JSON.parse(data);
        }
        return originalWrite(file, data, ...args);
      });
      try { assert.equal(heartbeatInboxProcessing(dir, options).ok, true); }
      finally { hook.mock.restore(); }
      assert.ok(live.token);
      const old = new Date(Date.now() - 10 * 60 * 1000);
      try {
        // Recently created malformed records may still be in the middle of a write.
        fs.writeFileSync(mutexPath, '');
        assert.equal(heartbeatInboxProcessing(dir, options).code, 'MUTATION_BUSY');
        for (const content of ['', '{', 'null', JSON.stringify({
          ...live, process_identity: 'previous-process-with-reused-pid', acquired_at: old.toISOString()
        }), JSON.stringify({ ...live, process_identity: undefined, acquired_at: old.toISOString() })]) {
          fs.writeFileSync(mutexPath, content);
          fs.utimesSync(mutexPath, old, old);
          assert.equal(heartbeatInboxProcessing(dir, options).ok, true);
          assert.equal(fs.readFileSync(mutexPath, 'utf8'), content);
        }
        if (live.process_identity) {
          fs.writeFileSync(mutexPath, JSON.stringify({ ...live, acquired_at: old.toISOString() }));
          fs.utimesSync(mutexPath, old, old);
          assert.equal(heartbeatInboxProcessing(dir, options).code, 'MUTATION_BUSY');
        }
      } finally {
        if (fs.existsSync(mutexPath)) fs.unlinkSync(mutexPath);
      }
    });
  });

  it('keeps a contender visible while it ignores stale mutex metadata', (t) => {
    withTempInstance((dir) => {
      const options = {
        runId: 'mutex-race',
        processor: 'Ada',
        host: 'laptop-a',
        claimedPaths: ['6-raw/inbox/a.md', '6-raw/inbox/b.md']
      };
      assert.equal(claimInboxProcessing(dir, options).ok, true);
      const key = createHash('sha256').update(path.join(dir, 'governance/inbox-processing.lock.json')).digest('hex');
      const mutexPath = path.join(os.tmpdir(), 'mole-inbox-processing-' + key + '.json');
      fs.writeFileSync(mutexPath, '{');
      const old = new Date(Date.now() - 10 * 60 * 1000);
      fs.utimesSync(mutexPath, old, old);
      const originalStat = fs.statSync;
      let overlapping;
      let triggered = false;
      const hook = t.mock.method(fs, 'statSync', (file, ...args) => {
        if (file === mutexPath && !triggered) {
          triggered = true;
          overlapping = checkpointInboxProcessing(dir, {
            ...options, processed: ['6-raw/inbox/b.md']
          });
        }
        return originalStat(file, ...args);
      });
      let first;
      try {
        first = checkpointInboxProcessing(dir, {
          ...options, processed: ['6-raw/inbox/a.md']
        });
      } finally {
        hook.mock.restore();
        if (fs.existsSync(mutexPath)) fs.unlinkSync(mutexPath);
      }
      assert.equal(first.ok, true);
      assert.equal(overlapping.code, 'MUTATION_BUSY');
      assert.deepEqual(inspectInboxProcessing(dir).lock.processed_paths, ['6-raw/inbox/a.md']);
      assert.equal(checkpointInboxProcessing(dir, {
        ...options, processed: ['6-raw/inbox/b.md']
      }).ok, true);
      assert.deepEqual(inspectInboxProcessing(dir).lock.processed_paths,
        ['6-raw/inbox/a.md', '6-raw/inbox/b.md']);
    });
  });

  it('derives process identities through Linux and other Unix paths', () => {
    assert.match(getInboxMutationProcessIdentity(process.pid), /\S/);
    assert.match(getInboxMutationProcessIdentity(process.pid, { platform: 'darwin' }), /\S/);
    let invoked;
    assert.equal(getInboxMutationProcessIdentity(42, {
      platform: 'freebsd',
      execFileSync(command, args, options) {
        invoked = { command, args, options };
        return 'Mon Sep  9 10:00:00 2026\n';
      }
    }), 'Mon Sep  9 10:00:00 2026');
    assert.equal(invoked.command, 'ps');
    assert.deepEqual(invoked.args, ['-p', '42', '-o', 'lstart=']);
    assert.equal(getInboxMutationProcessIdentity(42, { platform: 'win32' }), null);
  });
});

describe('inbox review regressions', () => {
  for (const scenario of [
    { name: 'checkpoint inherited from a scoped claim',
      claimed: ['6-raw/inbox/a.md'], processed: ['6-raw/inbox/a.md'] },
    { name: 'checkpoint inherited alongside a new requested claim',
      claimed: ['6-raw/inbox/a.md'], processed: ['6-raw/inbox/a.md'], requested: ['6-raw/inbox/b.md'] },
    { name: 'new requested claim during legacy migration', legacy: true, requested: ['6-raw/inbox/a.md'] }
  ]) {
    it('rejects receipt overlap in a stale replacement: ' + scenario.name, () => {
      withTempInstance((dir) => {
        createWorkspaceScaffold(dir);
        const owner = { runId: 'stale-run', processor: 'Ada', host: 'laptop-a', leaseMs: 1000 };
        const lockPath = path.join(dir, 'governance/inbox-processing.lock.json');
        if (scenario.legacy) {
          fs.writeFileSync(lockPath, JSON.stringify({
            lock_id: owner.runId, claimed_by: owner.processor, status: 'processing',
            started_at: '2026-09-08T10:00:00Z', stale_after: '2026-09-08T10:00:01Z'
          }));
        } else {
          assert.equal(claimInboxProcessing(dir, {
            ...owner, claimedPaths: scenario.claimed || [], now: new Date('2026-09-08T10:00:00Z')
          }).ok, true);
          if (scenario.processed) {
            assert.equal(checkpointInboxProcessing(dir, {
              ...owner, processed: scenario.processed, now: new Date('2026-09-08T10:00:00.500Z')
            }).ok, true);
          }
        }
        // Another host's completion arrives after the local claim/checkpoint.
        const receiptsDir = path.join(dir, 'governance/run-receipts/inbox-processing');
        fs.mkdirSync(receiptsDir, { recursive: true });
        const receiptPath = path.join(receiptsDir, 'synced-run.json');
        fs.writeFileSync(receiptPath, JSON.stringify({
          run_id: 'synced-run', completed_at: '2026-09-08T10:00:01Z',
          processed: [path.join(dir, '6-raw/inbox/a.md')]
        }));
        const sourcePath = path.join(dir, '6-raw/inbox/a.md');
        fs.writeFileSync(sourcePath, 'Retain the raw source.');
        const lockBytes = fs.readFileSync(lockPath, 'utf8');
        const receiptBytes = fs.readFileSync(receiptPath, 'utf8');

        const result = overrideStaleInboxProcessing(dir, {
          runId: 'replacement-run', processor: 'Grace', host: 'laptop-b',
          claimedPaths: scenario.requested || [], reason: 'Checked stopped worker and sync history.',
          now: new Date('2026-09-08T10:00:02Z')
        });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'ALREADY_PROCESSED');
        assert.deepEqual(result.alreadyProcessedPaths, ['6-raw/inbox/a.md']);
        for (const command of [['override-stale'], ['claim', '--override-stale']]) {
          const cli = runCli(['inbox', ...command, '--run-id', 'replacement-run',
            '--processor', 'Grace', '--host', 'laptop-b', '--reason', 'Checked sync history.',
            ...(scenario.requested || []).flatMap((item) => ['--claimed-path', item])], { cwd: dir });
          assert.equal(cli.status, 1);
          assert.match(cli.stderr, /already covered by completion receipts: 6-raw\/inbox\/a\.md/);
          assert.match(cli.stderr, /No replacement or override was written/);
        }
        assert.equal(fs.readFileSync(lockPath, 'utf8'), lockBytes);
        assert.equal(fs.readFileSync(receiptPath, 'utf8'), receiptBytes);
        assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'Retain the raw source.');
        assert.equal(fs.existsSync(path.join(receiptsDir, 'overrides')), false);
        assert.equal(inspectInboxProcessing(dir).receipts.length, 1);
      });
    });
  }

  it('refuses stale recovery before writing when a source conflict already exists', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const owner = {
        runId: 'source-conflict-stale',
        processor: 'Ada',
        host: 'laptop-a',
        leaseMs: 1000,
        now: new Date('2026-09-08T10:00:00.000Z')
      };
      assert.equal(claimInboxProcessing(dir, owner).ok, true);
      const lockPath = path.join(dir, 'governance/inbox-processing.lock.json');
      const lockBytes = fs.readFileSync(lockPath, 'utf8');
      fs.writeFileSync(path.join(dir, '6-raw/inbox/source (conflicted copy).md'), 'preserve');

      const result = overrideStaleInboxProcessing(dir, {
        runId: 'replacement-after-source-conflict',
        processor: 'Grace',
        host: 'laptop-b',
        reason: 'Checked the stopped worker and provider history.',
        now: new Date('2026-09-08T10:00:02.000Z')
      });

      assert.equal(result.ok, false);
      assert.equal(result.code, 'SYNC_CONFLICT');
      assert.equal(fs.readFileSync(lockPath, 'utf8'), lockBytes);
      assert.equal(fs.existsSync(path.join(
        dir,
        'governance/run-receipts/inbox-processing/overrides'
      )), false);
    });
  });

  it('rejects unsafe inbox paths and never follows symlinks', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const outside = path.join(dir, 'outside.md');
      const symlink = path.join(dir, '6-raw/inbox/link.md');
      fs.writeFileSync(outside, 'outside');
      try {
        fs.symlinkSync(outside, symlink);
      } catch (error) {
        if (['EACCES', 'EPERM', 'EOPNOTSUPP'].includes(error.code)) return;
        throw error;
      }

      const audit = auditInbox(dir);
      assert.deepEqual(audit.unsafeEntries, [{
        path: '6-raw/inbox/link.md',
        kind: 'symlink'
      }]);
      assert.equal(audit.issues.some((issue) => issue.code === 'UNSAFE_INBOX_ENTRY'), true);
      assert.equal(audit.ok, false);
      assert.deepEqual(audit.candidates, []);

      for (const [index, claimedPath] of [
        path.join(dir, '6-raw/inbox/absolute.md'),
        '6-raw/inbox/../outside.md',
        './6-raw/inbox/dot.md',
        '6-raw/inbox/link.md'
      ].entries()) {
        const result = claimInboxProcessing(dir, {
          runId: 'unsafe-path-' + index,
          processor: 'Ada',
          host: 'laptop-a',
          claimedPaths: [claimedPath]
        });
        assert.equal(result.ok, false);
        assert.equal(result.code, 'INVALID_PATH');
        assert.equal(fs.existsSync(path.join(dir, 'governance/inbox-processing.lock.json')), false);
      }
    });
  });

  it('does not permit a generic conflict bypass on normal mutations', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      fs.writeFileSync(path.join(dir, '6-raw/inbox/source (conflicted copy).md'), 'preserve');

      const result = claimInboxProcessing(dir, {
        runId: 'blocked-conflict-bypass',
        processor: 'Ada',
        host: 'laptop-a',
        allowConflictCopies: true
      });

      assert.equal(result.ok, false);
      assert.equal(result.code, 'SYNC_CONFLICT');
      assert.equal(fs.existsSync(path.join(dir, 'governance/inbox-processing.lock.json')), false);
    });
  });

  it('serializes overlapping checkpoint updates and preserves both after retry', (t) => {
    withTempInstance((dir) => {
      const options = {
        runId: 'serialized',
        processor: 'Ada',
        host: 'laptop-a',
        claimedPaths: ['6-raw/inbox/a.md', '6-raw/inbox/b.md']
      };
      assert.equal(claimInboxProcessing(dir, options).ok, true);
      const originalRename = fs.renameSync;
      let overlapping;
      const hook = t.mock.method(fs, 'renameSync', (from, to) => {
        if (String(to).endsWith('/inbox-processing.lock.json')) {
          overlapping = checkpointInboxProcessing(dir, { ...options, processed: ['6-raw/inbox/b.md'] });
        }
        return originalRename(from, to);
      });
      let first;
      try { first = checkpointInboxProcessing(dir, { ...options, processed: ['6-raw/inbox/a.md'] }); }
      finally { hook.mock.restore(); }
      assert.equal(first.ok, true);
      assert.equal(overlapping.code, 'MUTATION_BUSY');
      const retry = checkpointInboxProcessing(dir, { ...options, processed: ['6-raw/inbox/b.md'] });
      assert.equal(retry.ok, true);
      assert.deepEqual(retry.lock.processed_paths, ['6-raw/inbox/a.md', '6-raw/inbox/b.md']);
      assert.equal(retry.lock.lock_version, 3);
    });
  });

  it('retains a prepared audit when sync renews a lock during stale recovery', (t) => {
    withTempInstance((dir) => {
      const owner = { processor: 'Ada', host: 'laptop-a' };
      const claimed = claimInboxProcessing(dir, { ...owner, runId: 'stale', leaseMs: 1000,
        now: new Date('2026-09-08T10:00:00Z') });
      const lockPath = path.join(dir, 'governance/inbox-processing.lock.json');
      const renewed = { ...claimed.lock, lock_version: 2, expires_at: '2026-09-09T10:00:00Z',
        processed_paths: ['6-raw/inbox/a.md'] };
      const originalWrite = fs.writeFileSync;
      const hook = t.mock.method(fs, 'writeFileSync', (file, ...args) => {
        const result = originalWrite(file, ...args);
        if (String(file).includes('/overrides/')) originalWrite(lockPath, JSON.stringify(renewed));
        return result;
      });
      let result;
      try {
        result = overrideStaleInboxProcessing(dir, { ...owner, runId: 'replacement',
          reason: 'Confirmed worker stopped.', now: new Date('2026-09-08T10:00:02Z') });
      } finally { hook.mock.restore(); }
      assert.equal(result.code, 'LOCK_CHANGED');
      const state = inspectInboxProcessing(dir);
      assert.deepEqual(state.lock, renewed);
      assert.equal(state.incompleteOverrides.length, 1);
      assert.equal(state.overrides[0].override.state, 'prepared');
    });
  });

  it('uses only identified, validated, unambiguous receipts in audit and metrics', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const receipts = path.join(dir, 'governance/run-receipts/inbox-processing');
      fs.mkdirSync(receipts, { recursive: true });
      const valid = { receipt_id: 'legacy-receipt', completed_at: '2026-09-08T10:00:00Z' };
      const invalid = [
        { completed_at: valid.completed_at },
        { ...valid, receipt_id: '' },
        { ...valid, receipt_id: 42 },
        { ...valid, run_id: 42 },
        { ...valid, run_id: '   ' },
        { ...valid, lock_id: { id: 'invalid' } },
        { ...valid, completed_at: undefined },
        { ...valid, completed_at: null },
        { ...valid, completed_at: true },
        { ...valid, completed_at: 'invalid' },
        { ...valid, status: 'processing' },
        { ...valid, processed: [{ path: '6-raw/inbox/a.md' }] }
      ];
      invalid.forEach((record, index) => {
        const source = '6-raw/inbox/invalid-' + index + '.md';
        fs.writeFileSync(path.join(dir, source), 'preserve');
        fs.writeFileSync(path.join(receipts, 'invalid-' + index + '.json'),
          JSON.stringify({ processed: [source], ...record }));
      });
      fs.writeFileSync(path.join(receipts, 'truncated.json'), '{');
      fs.writeFileSync(path.join(receipts, 'null.json'), 'null');
      fs.writeFileSync(path.join(receipts, 'run (conflicted copy).json'), JSON.stringify({
        ...valid, receipt_id: 'conflict-only', processed: ['6-raw/inbox/conflict.md']
      }));
      fs.writeFileSync(path.join(dir, '6-raw/inbox/conflict.md'), 'preserve');
      fs.writeFileSync(path.join(receipts, 'legacy.json'), JSON.stringify({
        ...valid, processed: ['6-raw/inbox/valid.md']
      }));
      fs.writeFileSync(path.join(dir, '6-raw/inbox/valid.md'), 'preserve');
      const audit = auditInbox(dir);
      assert.deepEqual(audit.processed, []);
      assert.equal(audit.invalidReceipts.length, invalid.length + 2);
      assert.equal(audit.conflictReceipts.length, 1);
      assert.equal(audit.ok, false);
      const metrics = backfillProcessedInboxMetrics(dir);
      assert.equal(metrics.processed_paths_counted, 0);
      assert.equal(metrics.receipts_skipped, invalid.length + 4);
      assert.equal(metrics.conflict_receipts_skipped, 1);
      assert.deepEqual(JSON.parse(fs.readFileSync(getMetricsPaths(dir).dailyPath)).records, []);
    });
  });

  it('blocks every mutation for named override copies and duplicate IDs', () => {
    for (const variant of ['same-id', 'named-copy', 'truncated-copy']) {
      withTempInstance((dir) => {
        createWorkspaceScaffold(dir);
        const owner = { processor: 'Ada', host: 'laptop-a' };
        const completed = completeInboxProcessing(dir, {
          ...owner, runId: 'prior', overrideMissingLock: true, reason: 'Recovered prior run.'
        });
        assert.equal(completed.ok, true);
        assert.equal(claimInboxProcessing(dir, { ...owner, runId: 'active' }).ok, true);
        const state = inspectInboxProcessing(dir);
        const original = state.overrides[0];
        const copyPath = path.join(dir, path.dirname(original.path),
          variant === 'same-id' ? 'other.json' : 'audit (conflicted copy).json');
        const copy = { ...original.override,
          override_id: variant === 'same-id' ? original.override.override_id : 'other-id',
          reason: 'Divergent decision from another host.' };
        fs.writeFileSync(copyPath, variant === 'truncated-copy' ? '{' : JSON.stringify(copy));
        const audit = auditInbox(dir);
        assert.equal(audit.issues.some((issue) => issue.code === 'OVERRIDE_CONFLICT'), true);
        if (variant === 'same-id') assert.equal(audit.duplicateOverrides.length, 1);
        else assert.equal(audit.conflictOverrides.length, 1);
        for (const mutate of [claimInboxProcessing, heartbeatInboxProcessing,
          checkpointInboxProcessing, completeInboxProcessing, overrideStaleInboxProcessing]) {
          const result = mutate(dir, {
            ...owner, runId: 'active', allowConflictCopies: true, reason: 'Cannot choose a copy.'
          });
          assert.equal(result.code, 'OVERRIDE_CONFLICT', variant);
        }
        assert.deepEqual(inspectInboxProcessing(dir).lock, state.lock);
        assert.equal(fs.readFileSync(copyPath, 'utf8'), variant === 'truncated-copy' ? '{' : JSON.stringify(copy));
      });
    }
  });

  it('leaves missing-lock recovery prepared if receipt writing fails', (t) => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const receipts = path.join(dir, 'governance/run-receipts/inbox-processing');
      const originalWrite = fs.writeFileSync;
      const failReceipt = t.mock.method(fs, 'writeFileSync', (file, ...args) => {
        if (path.dirname(String(file)) === receipts && String(file).endsWith('.json')) {
          throw Object.assign(new Error('injected receipt failure'), { code: 'EIO' });
        }
        return originalWrite(file, ...args);
      });
      try {
        assert.throws(() => completeInboxProcessing(dir, {
          runId: 'failed-receipt', processor: 'Ada', host: 'laptop-a',
          overrideMissingLock: true, reason: 'Recover a completed pass.', processed: ['6-raw/inbox/a.md']
        }), /injected receipt failure/);
      } finally { failReceipt.mock.restore(); }
      const state = inspectInboxProcessing(dir);
      assert.equal(state.receipts.length, 0);
      assert.equal(state.incompleteOverrides.length, 1);
      assert.equal(state.overrides[0].override.finalized_at, null);
      assert.equal(auditInbox(dir).issues.some((item) => item.code === 'INCOMPLETE_OVERRIDE'), true);
    });
  });

  it('finalizes only the matching pending override on completion retry', (t) => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const options = { runId: 'retry-finalization', processor: 'Ada', host: 'laptop-a',
        overrideMissingLock: true, reason: 'Recover a completed pass.', processed: ['6-raw/inbox/a.md'] };
      const originalRename = fs.renameSync;
      const failFinalize = t.mock.method(fs, 'renameSync', (from, to) => {
        if (String(to).includes('/overrides/')) throw new Error('injected finalization failure');
        return originalRename(from, to);
      });
      let first;
      try { first = completeInboxProcessing(dir, options); }
      finally { failFinalize.mock.restore(); }
      assert.equal(first.ok, true);
      assert.match(first.warning, /prepared/);
      const before = inspectInboxProcessing(dir);
      assert.equal(before.receipts.length, 1);
      assert.equal(before.incompleteOverrides.length, 1);
      const receiptBytes = fs.readFileSync(path.join(dir, first.receiptPath), 'utf8');
      const unrelated = { ...before.overrides[0].override, override_id: 'unrelated', replacement_run_id: 'other' };
      const otherPath = path.join(dir, path.dirname(before.overrides[0].path), 'unrelated.json');
      fs.writeFileSync(otherPath, JSON.stringify(unrelated));
      assert.equal(completeInboxProcessing(dir, { ...options, allowIncompleteOverride: true }).code,
        'INCOMPLETE_OVERRIDE');
      fs.unlinkSync(otherPath);
      assert.equal(completeInboxProcessing(dir, { ...options, processor: 'Grace' }).code, 'FOREIGN_OWNER');
      const pendingPath = path.join(dir, before.overrides[0].path);
      const pendingBytes = fs.readFileSync(pendingPath, 'utf8');
      fs.writeFileSync(pendingPath, JSON.stringify({
        ...before.overrides[0].override, reason: 'Same ID but a different recovery decision.'
      }));
      assert.equal(completeInboxProcessing(dir, options).code, 'INCOMPLETE_OVERRIDE');
      assert.equal(inspectInboxProcessing(dir).incompleteOverrides.length, 1);
      fs.writeFileSync(pendingPath, pendingBytes);
      const retried = completeInboxProcessing(dir, options);
      assert.equal(retried.ok, true);
      assert.equal(retried.idempotent, true);
      assert.equal(retried.warning, undefined);
      const after = inspectInboxProcessing(dir);
      assert.equal(after.incompleteOverrides.length, 0);
      assert.equal(after.overrides[0].override.state, 'finalized');
      assert.equal(fs.readFileSync(path.join(dir, first.receiptPath), 'utf8'), receiptBytes);
      assert.equal(after.receipts.length, 1);
    });
  });

  it('processes ordinary duplicate subject names through the complete workflow', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const source = '6-raw/inbox/duplicate-orders.md';
      fs.writeFileSync(path.join(dir, source), 'Customer reports duplicate orders.');
      const options = { runId: 'ordinary-name', processor: 'Ada', host: 'laptop-a' };
      assert.equal(claimInboxProcessing(dir, { ...options, claimedPaths: [source] }).ok, true);
      assert.equal(checkpointInboxProcessing(dir, { ...options, processed: [source] }).ok, true);
      assert.equal(completeInboxProcessing(dir, options).ok, true);
      assert.equal(auditInbox(dir).ok, true);
      assert.equal(fs.readFileSync(path.join(dir, source), 'utf8'), 'Customer reports duplicate orders.');
    });
  });
});

describe('processed inbox metrics', () => {
  it('creates starter metric files and counts unique processed paths once per UTC day', () => {
    withTempInstance((dir) => {
      writeMetricsReceipt(dir, {
        runId: 'metrics-foundation',
        processed: ['6-raw/inbox/a.md', '6-raw/inbox/b.md']
      });
      const first = recordProcessedInboxItems(dir, [
        '6-raw/inbox/a.md',
        './6-raw/inbox/a.md',
        path.join(dir, '6-raw', 'inbox', 'a.md'),
        '6-raw/inbox/a.md',
        '6-raw/inbox/b.md'
      ], {
        runId: 'metrics-foundation',
        now: new Date('2026-06-11T10:00:00.000Z')
      });
      const second = recordProcessedInboxItems(dir, [
        '6-raw/inbox/a.md'
      ], {
        runId: 'metrics-foundation',
        now: new Date('2026-06-11T11:00:00.000Z')
      });

      const paths = getMetricsPaths(dir);
      const daily = JSON.parse(fs.readFileSync(paths.dailyPath, 'utf8'));
      const weekly = JSON.parse(fs.readFileSync(paths.weeklyPath, 'utf8'));
      const monthly = JSON.parse(fs.readFileSync(paths.monthlyPath, 'utf8'));
      const seenToday = JSON.parse(fs.readFileSync(paths.seenTodayPath, 'utf8'));

      assert.equal(first.counted, 2);
      assert.equal(second.counted, 0);
      assert.deepEqual(daily.records, [{ date: '2026-06-11', count: 2 }]);
      assert.deepEqual(weekly.records, [{
        week_start: '2026-06-08',
        week_end: '2026-06-14',
        count: 2
      }]);
      assert.deepEqual(monthly.records, [{
        month: '2026-06',
        month_start: '2026-06-01',
        month_end: '2026-06-30',
        count: 2
      }]);
      assert.equal(seenToday.date, '2026-06-11');
      assert.equal(seenToday.seen.length, 2);
      assert.deepEqual(seenToday.seen.map((entry) => entry.key), [
        '6-raw/inbox/a.md',
        '6-raw/inbox/b.md'
      ]);
    });
  });

  it('resets same-day dedupe when the UTC date changes', () => {
    withTempInstance((dir) => {
      writeMetricsReceipt(dir, {
        runId: 'metrics-date-reset',
        processed: ['6-raw/inbox/a.md']
      });
      recordProcessedInboxItems(dir, ['6-raw/inbox/a.md'], {
        runId: 'metrics-date-reset',
        now: new Date('2026-06-11T23:55:00.000Z')
      });
      const result = recordProcessedInboxItems(dir, ['6-raw/inbox/a.md'], {
        runId: 'metrics-date-reset',
        now: new Date('2026-06-12T00:05:00.000Z')
      });

      const daily = JSON.parse(fs.readFileSync(getMetricsPaths(dir).dailyPath, 'utf8'));

      assert.equal(result.counted, 1);
      assert.deepEqual(daily.records, [
        { date: '2026-06-11', count: 1 },
        { date: '2026-06-12', count: 1 }
      ]);
    });
  });

  it('trims daily records while preserving older weekly and monthly rollups', () => {
    withTempInstance((dir) => {
      writeMetricsReceipt(dir, {
        runId: 'metrics-daily-retention',
        processed: ['6-raw/inbox/latest.md']
      });
      const paths = getMetricsPaths(dir);
      fs.mkdirSync(paths.metricsDir, { recursive: true });
      const oldDailyRecords = Array.from({ length: 100 }, (_, index) => {
        const date = new Date(Date.UTC(2026, 0, 1 + index));
        return {
          date: date.toISOString().slice(0, 10),
          count: 1
        };
      });
      fs.writeFileSync(paths.dailyPath, `${JSON.stringify({
        schema_version: 1,
        metric: 'processed_inbox_items',
        retention: { unit: 'day', limit: 100 },
        updated_at: '2026-06-11T00:00:00.000Z',
        records: oldDailyRecords
      }, null, 2)}\n`);
      fs.writeFileSync(paths.weeklyPath, `${JSON.stringify({
        schema_version: 1,
        metric: 'processed_inbox_items',
        retention: { unit: 'week', limit: 52 },
        week_start_day: 'monday',
        updated_at: '2026-06-11T00:00:00.000Z',
        records: [{ week_start: '2025-06-02', week_end: '2025-06-08', count: 9 }]
      }, null, 2)}\n`);
      fs.writeFileSync(paths.monthlyPath, `${JSON.stringify({
        schema_version: 1,
        metric: 'processed_inbox_items',
        retention: { unit: 'month', limit: 24 },
        updated_at: '2026-06-11T00:00:00.000Z',
        records: [{ month: '2025-06', month_start: '2025-06-01', month_end: '2025-06-30', count: 42 }]
      }, null, 2)}\n`);

      recordProcessedInboxItems(dir, ['6-raw/inbox/latest.md'], {
        runId: 'metrics-daily-retention',
        now: new Date('2026-06-11T10:00:00.000Z')
      });

      const daily = JSON.parse(fs.readFileSync(paths.dailyPath, 'utf8'));
      const weekly = JSON.parse(fs.readFileSync(paths.weeklyPath, 'utf8'));
      const monthly = JSON.parse(fs.readFileSync(paths.monthlyPath, 'utf8'));

      assert.equal(daily.records.length, 100);
      assert.equal(daily.records.at(-1).date, '2026-06-11');
      assert.ok(weekly.records.some((record) => record.week_start === '2025-06-02' && record.count === 9));
      assert.ok(monthly.records.some((record) => record.month === '2025-06' && record.count === 42));
    });
  });

  it('trims weekly and monthly records to their retention limits', () => {
    withTempInstance((dir) => {
      writeMetricsReceipt(dir, {
        runId: 'metrics-period-retention',
        processed: ['6-raw/inbox/latest.md']
      });
      const paths = getMetricsPaths(dir);
      fs.mkdirSync(paths.metricsDir, { recursive: true });
      fs.writeFileSync(paths.weeklyPath, `${JSON.stringify({
        schema_version: 1,
        metric: 'processed_inbox_items',
        retention: { unit: 'week', limit: 52 },
        week_start_day: 'monday',
        updated_at: '2026-06-11T00:00:00.000Z',
        records: Array.from({ length: 52 }, (_, index) => {
          const start = new Date(Date.UTC(2025, 0, 6 + index * 7));
          const end = new Date(start);
          end.setUTCDate(end.getUTCDate() + 6);
          return {
            week_start: start.toISOString().slice(0, 10),
            week_end: end.toISOString().slice(0, 10),
            count: 1
          };
        })
      }, null, 2)}\n`);
      fs.writeFileSync(paths.monthlyPath, `${JSON.stringify({
        schema_version: 1,
        metric: 'processed_inbox_items',
        retention: { unit: 'month', limit: 24 },
        updated_at: '2026-06-11T00:00:00.000Z',
        records: Array.from({ length: 24 }, (_, index) => {
          const month = new Date(Date.UTC(2024, index, 1)).toISOString().slice(0, 7);
          return {
            month,
            month_start: `${month}-01`,
            month_end: `${month}-28`,
            count: 1
          };
        })
      }, null, 2)}\n`);

      recordProcessedInboxItems(dir, ['6-raw/inbox/latest.md'], {
        runId: 'metrics-period-retention',
        now: new Date('2026-06-11T10:00:00.000Z')
      });

      const weekly = JSON.parse(fs.readFileSync(paths.weeklyPath, 'utf8'));
      const monthly = JSON.parse(fs.readFileSync(paths.monthlyPath, 'utf8'));

      assert.equal(weekly.records.length, 52);
      assert.equal(weekly.records.at(-1).week_start, '2026-06-08');
      assert.equal(monthly.records.length, 24);
      assert.equal(monthly.records.at(-1).month, '2026-06');
    });
  });

  it('rejects direct metric writes when recovery evidence is incomplete', (t) => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const options = {
        runId: 'metrics-incomplete-override',
        processor: 'Ada',
        host: 'laptop-a',
        overrideMissingLock: true,
        reason: 'Recover the completed pass after the prior worker stopped.',
        processed: ['6-raw/inbox/a.md']
      };
      const originalRename = fs.renameSync;
      const failFinalize = t.mock.method(fs, 'renameSync', (from, to) => {
        if (String(to).includes('/overrides/')) throw new Error('injected finalization failure');
        return originalRename(from, to);
      });
      let completed;
      try {
        completed = completeInboxProcessing(dir, options);
      } finally {
        failFinalize.mock.restore();
      }

      assert.equal(completed.ok, true);
      assert.equal(inspectInboxProcessing(dir).incompleteOverrides.length, 1);
      assert.throws(
        () => recordProcessedInboxItems(dir, completed.receipt.processed, {
          runId: completed.receipt.run_id
        }),
        /valid, unambiguous completed receipt/
      );
      assert.deepEqual(
        JSON.parse(fs.readFileSync(getMetricsPaths(dir).dailyPath, 'utf8')).records,
        []
      );
    });
  });

  it('includes a static dashboard wired to local metrics files', () => {
    const dashboard = fs.readFileSync(path.join(repoRoot, 'governance', 'metrics', 'dashboard.html'), 'utf8');

    assert.match(dashboard, /Molehill Metrics/);
    assert.match(dashboard, /daily\.json/);
    assert.match(dashboard, /weekly\.json/);
    assert.match(dashboard, /monthly\.json/);
    assert.match(dashboard, /viewSelect/);
    assert.match(dashboard, /fromDate/);
    assert.match(dashboard, /toDate/);
    assert.match(dashboard, /fileInput/);
  });

  it('backfills metrics from historical inbox processing receipts', () => {
    withTempInstance((dir) => {
      const receiptsDir = path.join(dir, 'governance', 'run-receipts', 'inbox-processing');
      fs.mkdirSync(receiptsDir, { recursive: true });
      fs.writeFileSync(path.join(receiptsDir, '20260610T100000000Z-a.json'), `${JSON.stringify({
        receipt_id: '20260610T100000000Z-a',
        completed_at: '2026-06-10T10:00:00.000Z',
        processed: [
          '6-raw/inbox/a.md',
          './6-raw/inbox/a.md',
          path.join(dir, '6-raw', 'inbox', 'a.md'),
          '6-raw/inbox/a.md',
          '6-raw/inbox/b.md'
        ]
      }, null, 2)}\n`);
      fs.writeFileSync(path.join(receiptsDir, '20260611T100000000Z-b.json'), `${JSON.stringify({
        lock_id: 'legacy-b',
        completed_at: '2026-06-11T10:00:00.000Z',
        processed: ['6-raw/inbox/c.md']
      }, null, 2)}\n`);
      fs.writeFileSync(path.join(receiptsDir, '20260611T110000000Z-empty.json'), `${JSON.stringify({
        receipt_id: '20260611T110000000Z-empty',
        completed_at: '2026-06-11T11:00:00.000Z',
        processed: []
      }, null, 2)}\n`);

      const result = backfillProcessedInboxMetrics(dir, {
        now: new Date('2026-06-11T12:00:00.000Z')
      });
      const paths = getMetricsPaths(dir);
      const daily = JSON.parse(fs.readFileSync(paths.dailyPath, 'utf8'));
      const weekly = JSON.parse(fs.readFileSync(paths.weeklyPath, 'utf8'));
      const monthly = JSON.parse(fs.readFileSync(paths.monthlyPath, 'utf8'));
      const seenToday = JSON.parse(fs.readFileSync(paths.seenTodayPath, 'utf8'));

      assert.equal(result.receipts_scanned, 3);
      assert.equal(result.receipts_counted, 2);
      assert.equal(result.receipts_skipped, 1);
      assert.equal(result.processed_paths_counted, 3);
      assert.deepEqual(daily.records, [
        { date: '2026-06-10', count: 2 },
        { date: '2026-06-11', count: 1 }
      ]);
      assert.deepEqual(weekly.records, [{
        week_start: '2026-06-08',
        week_end: '2026-06-14',
        count: 3
      }]);
      assert.deepEqual(monthly.records, [{
        month: '2026-06',
        month_start: '2026-06-01',
        month_end: '2026-06-30',
        count: 3
      }]);
      assert.deepEqual(seenToday.seen.map((entry) => entry.key), ['6-raw/inbox/c.md']);
    });
  });

  it('does not count receipts while override state is malformed', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const receiptsDir = path.join(dir, 'governance/run-receipts/inbox-processing');
      const overridesDir = path.join(receiptsDir, 'overrides');
      fs.mkdirSync(overridesDir, { recursive: true });
      fs.writeFileSync(path.join(receiptsDir, 'valid-receipt.json'), JSON.stringify({
        receipt_id: 'valid-receipt',
        completed_at: '2026-09-08T10:00:00.000Z',
        processed: ['6-raw/inbox/a.md']
      }));
      fs.writeFileSync(path.join(overridesDir, 'malformed.json'), '{');

      const audit = auditInbox(dir);
      const result = backfillProcessedInboxMetrics(dir, {
        now: new Date('2026-09-08T11:00:00.000Z')
      });

      assert.equal(audit.ok, false);
      assert.equal(audit.issues.some((issue) => issue.code === 'INVALID_OVERRIDE'), true);
      assert.equal(result.receipts_scanned, 1);
      assert.equal(result.receipts_counted, 0);
      assert.equal(result.receipts_skipped, 1);
      assert.equal(result.processed_paths_counted, 0);
      assert.deepEqual(JSON.parse(fs.readFileSync(getMetricsPaths(dir).dailyPath, 'utf8')).records, []);
    });
  });

  it('preserves existing metric history while receipt counting is blocked', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const paths = getMetricsPaths(dir);
      const daily = JSON.parse(fs.readFileSync(paths.dailyPath, 'utf8'));
      const weekly = JSON.parse(fs.readFileSync(paths.weeklyPath, 'utf8'));
      const monthly = JSON.parse(fs.readFileSync(paths.monthlyPath, 'utf8'));
      const seenToday = JSON.parse(fs.readFileSync(paths.seenTodayPath, 'utf8'));
      daily.records = [{ date: '2026-09-01', count: 7 }];
      weekly.records = [{ week_start: '2026-08-31', week_end: '2026-09-06', count: 7 }];
      monthly.records = [{
        month: '2026-09',
        month_start: '2026-09-01',
        month_end: '2026-09-30',
        count: 7
      }];
      seenToday.date = '2026-09-01';
      seenToday.seen = [{ key: '6-raw/inbox/already-counted.md', first_seen_at: '2026-09-01T12:00:00.000Z' }];
      fs.writeFileSync(paths.dailyPath, `${JSON.stringify(daily, null, 2)}\n`);
      fs.writeFileSync(paths.weeklyPath, `${JSON.stringify(weekly, null, 2)}\n`);
      fs.writeFileSync(paths.monthlyPath, `${JSON.stringify(monthly, null, 2)}\n`);
      fs.writeFileSync(paths.seenTodayPath, `${JSON.stringify(seenToday, null, 2)}\n`);

      const metricPaths = [
        paths.dailyPath,
        paths.weeklyPath,
        paths.monthlyPath,
        paths.seenTodayPath
      ];
      const before = metricPaths.map((file) => fs.readFileSync(file, 'utf8'));
      const overrides = path.join(
        dir,
        'governance',
        'run-receipts',
        'inbox-processing',
        'overrides'
      );
      fs.mkdirSync(overrides, { recursive: true });
      fs.writeFileSync(path.join(overrides, 'blocked.json'), '{');

      const result = backfillProcessedInboxMetrics(dir, {
        now: new Date('2026-09-08T12:00:00.000Z')
      });

      assert.equal(result.ok, false);
      assert.equal(result.blocked, true);
      assert.equal(result.processed_paths_counted, 0);
      assert.deepEqual(metricPaths.map((file) => fs.readFileSync(file, 'utf8')), before);
    });
  });

  it('does not partially count a valid receipt beside malformed receipt JSON', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const receiptsDir = path.join(dir, 'governance/run-receipts/inbox-processing');
      fs.mkdirSync(receiptsDir, { recursive: true });
      fs.writeFileSync(path.join(receiptsDir, 'valid-receipt.json'), JSON.stringify({
        receipt_id: 'valid-beside-invalid',
        completed_at: '2026-09-08T10:00:00.000Z',
        processed: ['6-raw/inbox/a.md']
      }));
      fs.writeFileSync(path.join(receiptsDir, 'malformed.json'), '{');

      const result = backfillProcessedInboxMetrics(dir, {
        now: new Date('2026-09-08T11:00:00.000Z')
      });
      assert.equal(result.receipts_scanned, 2);
      assert.equal(result.receipts_counted, 0);
      assert.equal(result.receipts_skipped, 2);
      assert.equal(result.processed_paths_counted, 0);
      assert.deepEqual(JSON.parse(fs.readFileSync(getMetricsPaths(dir).dailyPath, 'utf8')).records, []);
    });
  });

  it('runs metrics backfill from the CLI', () => {
    withTempInstance((dir) => {
      const receiptsDir = path.join(dir, 'governance', 'run-receipts', 'inbox-processing');
      fs.mkdirSync(receiptsDir, { recursive: true });
      fs.writeFileSync(path.join(receiptsDir, 'receipt.json'), `${JSON.stringify({
        receipt_id: 'legacy-cli-receipt',
        completed_at: '2026-06-11T10:00:00.000Z',
        processed: ['6-raw/inbox/a.md']
      }, null, 2)}\n`);

      const result = runCli([
        'metrics',
        'backfill'
      ], {
        cwd: dir
      });

      assert.equal(result.status, 0);
      assert.match(result.stdout, /Mole metrics backfill complete/);
      assert.match(result.stdout, /Receipts scanned: 1/);
      assert.match(result.stdout, /Processed paths counted: 1/);
    });
  });

  it('fails closed from the CLI without rewriting blocked metric history', () => {
    withTempInstance((dir) => {
      createWorkspaceScaffold(dir);
      const paths = getMetricsPaths(dir);
      const daily = JSON.parse(fs.readFileSync(paths.dailyPath, 'utf8'));
      daily.records = [{ date: '2026-09-01', count: 7 }];
      fs.writeFileSync(paths.dailyPath, `${JSON.stringify(daily, null, 2)}\n`);
      const before = fs.readFileSync(paths.dailyPath, 'utf8');
      const overrides = path.join(
        dir,
        'governance',
        'run-receipts',
        'inbox-processing',
        'overrides'
      );
      fs.mkdirSync(overrides, { recursive: true });
      fs.writeFileSync(path.join(overrides, 'blocked.json'), '{');

      const result = runCli(['metrics', 'backfill'], { cwd: dir });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /backfill blocked/);
      assert.equal(fs.readFileSync(paths.dailyPath, 'utf8'), before);
    });
  });
});
