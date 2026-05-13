import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCaptureFileName, resolveCapturedBy } from '../../lib/capture.mjs';
import { claimInboxProcessing, completeInboxProcessing } from '../../lib/inbox-processing.mjs';
import {
  buildInsightCaptureContent,
  getCheckUpdatesOutput,
  getDoctorOutput,
  getHelpOutput,
  getInstallBanner
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
      assert.match(output, /source version\s+0\.2\.0/);
      assert.match(output, /instance version\s+0\.1\.0/);
      assert.doesNotMatch(output, /missing instance metadata/i);
    });
  });

  it('warns when mole.instance.yaml is missing', () => {
    withTempInstance((dir) => {
      const output = getDoctorOutput(dir);

      assert.match(output, /source version\s+0\.2\.0/);
      assert.match(output, /instance version\s+not found/);
      assert.match(output, /missing instance metadata/i);
    });
  });
});

describe('help', () => {
  it('uses consistent Mole naming and documented command examples', () => {
    const output = getHelpOutput();

    assert.match(output, /^Mole CLI v0\.2\.0/m);
    assert.match(output, /mole create roadmap/);
    assert.match(output, /mole create spec drafts\/spec\.md/);
    assert.match(output, /mole check-updates/);
    assert.doesNotMatch(output, /Cascade/);
  });
});

describe('install banner', () => {
  it('introduces Mole with an ASCII mascot and concise product description', () => {
    const output = getInstallBanner();

    assert.match(output, /Mole is a local-first product context system/);
    assert.match(output, /o  o/);
    assert.match(output, /better roadmaps, specs, decisions/);
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
        'instance_name: test-instance\ncascade_version: 0.2.0\n',
        'utf8'
      );

      const output = getCheckUpdatesOutput(dir);

      assert.match(output, /Mole update check/);
      assert.match(output, /source version\s+0\.2\.0/);
      assert.match(output, /instance version\s+0\.2\.0/);
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
});
