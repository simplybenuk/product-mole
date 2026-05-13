import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCaptureFileName } from '../../lib/capture.mjs';
import { getCheckUpdatesOutput, getDoctorOutput, getHelpOutput } from '../mole.mjs';
import { createCaptureRelPath } from '../../ui/server.mjs';

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
