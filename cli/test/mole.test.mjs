import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { getDoctorOutput } from '../mole.mjs';

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
