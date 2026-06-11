import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCaptureFileName, resolveCapturedBy } from '../../lib/capture.mjs';
import { claimInboxProcessing, completeInboxProcessing } from '../../lib/inbox-processing.mjs';
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
  parseInboxCompleteValues
} from '../mole.mjs';
import { buildUiCaptureContent, createCaptureRelPath } from '../../ui/server.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');

function withTempInstance(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-test-'));
  try {
    return callback(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
      assert.match(output, /source version\s+0\.2\.6/);
      assert.match(output, /instance version\s+0\.1\.0/);
      assert.doesNotMatch(output, /missing instance metadata/i);
    });
  });

  it('warns when mole.instance.yaml is missing', () => {
    withTempInstance((dir) => {
      const output = getDoctorOutput(dir);

      assert.match(output, /source version\s+0\.2\.6/);
      assert.match(output, /instance version\s+not found/);
      assert.match(output, /missing instance metadata/i);
    });
  });
});

describe('help', () => {
  it('uses consistent Mole naming and documented command examples', () => {
    const output = getHelpOutput();

    assert.match(output, /^Mole CLI v0\.2\.6/m);
    assert.match(output, /mole new my-mole/);
    assert.match(output, /mole create roadmap/);
    assert.match(output, /mole create spec drafts\/spec\.md/);
    assert.match(output, /mole product-update CEO 2-weeks --format email/);
    assert.match(output, /mole bootstrap-context/);
    assert.match(output, /mole refresh top-layers/);
    assert.match(output, /mole install skills\s+Install Mole agent skills into ~\/\.agents\/skills/);
    assert.match(output, /More help:\n  https:\/\/github\.com\/simplybenuk\/product-mole#readme/);
    assert.match(output, /mole check-updates/);
    assert.doesNotMatch(output, /Cascade/);
    assert.doesNotMatch(output, /mole install codex/);
  });
});

describe('synthesise guidance', () => {
  it('points inbox synthesis at living personas', () => {
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'cli', 'mole.mjs'), 'synthesise', 'inbox'], {
      encoding: 'utf8'
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /4-context\/personas\.md/);
    assert.match(result.stdout, /update or create evidence-backed personas/);
    assert.match(result.stdout, /4-context\/stakeholders\.md/);
    assert.match(result.stdout, /stakeholder memory/);
    assert.match(result.stdout, /blank, placeholder-only/);
    assert.match(result.stdout, /material top-layer gap/);
    assert.match(result.stdout, /mole inbox complete --processed <path>/);
  });

  it('prints first-time bootstrap guidance for blank top layers', () => {
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'cli', 'mole.mjs'), 'bootstrap-context'], {
      encoding: 'utf8'
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Bootstrap this Mole workspace context/);
    assert.match(result.stdout, /starter-template files in `2-summaries\/` and `3-indexes\/`/);
    assert.match(result.stdout, /governance\/input-queue\.md/);
  });

  it('prints top-layer refresh guidance', () => {
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'cli', 'mole.mjs'), 'refresh', 'top-layers'], {
      encoding: 'utf8'
    });

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
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'cli', 'mole.mjs'), 'product-update', 'CEO', '2-weeks', '--format', 'email'], {
      encoding: 'utf8'
    });

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
        'instance_name: test-instance\ncascade_version: 0.2.6\n',
        'utf8'
      );

      const output = getCheckUpdatesOutput(dir);

      assert.match(output, /Mole update check/);
      assert.match(output, /source version\s+0\.2\.6/);
      assert.match(output, /instance version\s+0\.2\.6/);
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
      path.join('6-raw', 'inbox', 'quick-notes', '20260513T101112345Z-repeated-note-abc12345.md')
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
      assert.match(second.message, /already claimed by Ada/);
    });
  });

  it('writes a processing receipt and releases the lock on completion', () => {
    withTempInstance((dir) => {
      claimInboxProcessing(dir, {
        claimedBy: 'Ada',
        now: new Date('2026-05-13T10:11:12.345Z'),
        lockId: 'lock-1'
      });

      const result = completeInboxProcessing(dir, {
        completedAt: new Date('2026-05-13T10:21:12.345Z'),
        processed: ['6-raw/inbox/new/quick-notes/a.md'],
        summary: 'Promoted one note.'
      });

      assert.equal(result.ok, true);
      assert.equal(result.receipt.lock_id, 'lock-1');
      assert.equal(result.receipt.claimed_by, 'Ada');
      assert.deepEqual(result.receipt.processed, ['6-raw/inbox/new/quick-notes/a.md']);
      assert.match(result.receiptPath, /governance\/run-receipts\/inbox-processing\//);

      const next = claimInboxProcessing(dir, {
        claimedBy: 'Grace',
        now: new Date('2026-05-13T10:22:12.345Z'),
        lockId: 'lock-2'
      });
      assert.equal(next.ok, true);
    });
  });

  it('parses repeated processed paths while preserving completion summary text', () => {
    const parsed = parseInboxCompleteValues([
      '--processed',
      '6-raw/inbox/new/quick-notes/a.md',
      '--processed',
      '6-raw/inbox/new/messages/b.md',
      'Promoted',
      'two',
      'notes.'
    ]);

    assert.deepEqual(parsed.processed, [
      '6-raw/inbox/new/quick-notes/a.md',
      '6-raw/inbox/new/messages/b.md'
    ]);
    assert.equal(parsed.summary, 'Promoted two notes.');
  });

  it('records processed paths in metrics when the CLI completes inbox processing', () => {
    withTempInstance((dir) => {
      const claim = spawnSync(process.execPath, [
        path.join(repoRoot, 'cli', 'mole.mjs'),
        'inbox',
        'claim',
        'Ada'
      ], {
        cwd: dir,
        encoding: 'utf8'
      });
      const complete = spawnSync(process.execPath, [
        path.join(repoRoot, 'cli', 'mole.mjs'),
        'inbox',
        'complete',
        '--processed',
        '6-raw/inbox/new/quick-notes/a.md',
        '--processed',
        '6-raw/inbox/new/messages/b.md',
        'Promoted',
        'two',
        'notes.'
      ], {
        cwd: dir,
        encoding: 'utf8'
      });

      const paths = getMetricsPaths(dir);
      const receiptsDir = path.join(dir, 'governance', 'run-receipts', 'inbox-processing');
      const receiptFile = fs.readdirSync(receiptsDir).find((file) => file.endsWith('.json'));
      const receipt = JSON.parse(fs.readFileSync(path.join(receiptsDir, receiptFile), 'utf8'));
      const daily = JSON.parse(fs.readFileSync(paths.dailyPath, 'utf8'));

      assert.equal(claim.status, 0);
      assert.equal(complete.status, 0);
      assert.deepEqual(receipt.processed, [
        '6-raw/inbox/new/quick-notes/a.md',
        '6-raw/inbox/new/messages/b.md'
      ]);
      assert.equal(daily.records.at(-1).count, 2);
    });
  });

  it('keeps inbox completion successful when metrics update fails', () => {
    withTempInstance((dir) => {
      claimInboxProcessing(dir, {
        claimedBy: 'Ada',
        now: new Date('2026-06-11T10:00:00.000Z'),
        lockId: 'lock-1'
      });
      fs.mkdirSync(path.join(dir, 'governance', 'metrics'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'governance', 'metrics', 'daily.json'), '{broken', 'utf8');

      const result = spawnSync(process.execPath, [
        path.join(repoRoot, 'cli', 'mole.mjs'),
        'inbox',
        'complete',
        '--processed',
        '6-raw/inbox/new/quick-notes/a.md',
        'Promoted',
        'one',
        'note.'
      ], {
        cwd: dir,
        encoding: 'utf8'
      });

      assert.equal(result.status, 0);
      assert.match(result.stdout, /receipt written/);
      assert.match(result.stderr, /metrics update failed/);
      assert.equal(fs.existsSync(path.join(dir, 'governance', 'inbox-processing.lock.json')), false);
    });
  });
});

describe('processed inbox metrics', () => {
  it('creates starter metric files and counts unique processed paths once per UTC day', () => {
    withTempInstance((dir) => {
      const first = recordProcessedInboxItems(dir, [
        '6-raw/inbox/new/quick-notes/a.md',
        '6-raw/inbox/new/quick-notes/a.md',
        '6-raw/inbox/new/messages/b.md'
      ], {
        now: new Date('2026-06-11T10:00:00.000Z')
      });
      const second = recordProcessedInboxItems(dir, [
        '6-raw/inbox/new/quick-notes/a.md'
      ], {
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
    });
  });

  it('resets same-day dedupe when the UTC date changes', () => {
    withTempInstance((dir) => {
      recordProcessedInboxItems(dir, ['6-raw/inbox/new/quick-notes/a.md'], {
        now: new Date('2026-06-11T23:55:00.000Z')
      });
      const result = recordProcessedInboxItems(dir, ['6-raw/inbox/new/quick-notes/a.md'], {
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

      recordProcessedInboxItems(dir, ['6-raw/inbox/new/quick-notes/latest.md'], {
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

      recordProcessedInboxItems(dir, ['6-raw/inbox/new/quick-notes/latest.md'], {
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
        completed_at: '2026-06-10T10:00:00.000Z',
        processed: [
          '6-raw/inbox/new/quick-notes/a.md',
          '6-raw/inbox/new/quick-notes/a.md',
          '6-raw/inbox/new/messages/b.md'
        ]
      }, null, 2)}\n`);
      fs.writeFileSync(path.join(receiptsDir, '20260611T100000000Z-b.json'), `${JSON.stringify({
        completed_at: '2026-06-11T10:00:00.000Z',
        processed: ['6-raw/inbox/new/quick-notes/a.md']
      }, null, 2)}\n`);
      fs.writeFileSync(path.join(receiptsDir, '20260611T110000000Z-empty.json'), `${JSON.stringify({
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
      assert.deepEqual(seenToday.seen.map((entry) => entry.key), ['6-raw/inbox/new/quick-notes/a.md']);
    });
  });

  it('runs metrics backfill from the CLI', () => {
    withTempInstance((dir) => {
      const receiptsDir = path.join(dir, 'governance', 'run-receipts', 'inbox-processing');
      fs.mkdirSync(receiptsDir, { recursive: true });
      fs.writeFileSync(path.join(receiptsDir, 'receipt.json'), `${JSON.stringify({
        completed_at: '2026-06-11T10:00:00.000Z',
        processed: ['6-raw/inbox/new/quick-notes/a.md']
      }, null, 2)}\n`);

      const result = spawnSync(process.execPath, [
        path.join(repoRoot, 'cli', 'mole.mjs'),
        'metrics',
        'backfill'
      ], {
        cwd: dir,
        encoding: 'utf8'
      });

      assert.equal(result.status, 0);
      assert.match(result.stdout, /Mole metrics backfill complete/);
      assert.match(result.stdout, /Receipts scanned: 1/);
      assert.match(result.stdout, /Processed paths counted: 1/);
    });
  });
});
