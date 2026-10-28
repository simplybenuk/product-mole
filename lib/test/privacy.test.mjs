import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanSensitiveText, ingestPrivateCapture, privacyInventory, purgeRaw, scanRaw } from '../privacy.mjs';
import { captureNote } from '../../ui/server.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../../cli/mole.mjs', import.meta.url));
function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-privacy-'));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const synthetic = [
  ['EMAIL', ['synthetic', 'example.invalid'].join('@')],
  ['PHONE', '+1 202 555 0199'],
  ['PERSON_NAME', 'person name: Synthetic Example'],
  ['ADDRESS', 'postal address: 1 Synthetic Road'],
  ['CUSTOMER_ID', 'customer_id: synthetic-001'],
  ['API_KEY', 'api_key: synthetic-test-only'],
  ['PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----'],
  ['CONNECTION_STRING', 'postgres://synthetic:fixture@localhost/test'],
  ['HEALTH_DATA', 'diagnosis: synthetic-condition'],
  ['FINANCIAL_DATA', 'bank account: synthetic-000'],
  ['CONFIDENTIAL_BUSINESS', 'contract terms: synthetic-terms']
];
test('supported syntactic categories redact without retaining mappings', () => {
  for (const [type, value] of synthetic) {
    const result = scanSensitiveText(`${value}\n${value}`);
    assert.ok(result.cleaned.includes(`[${type}]`), type);
    assert.ok(!result.cleaned.includes(value), type);
    assert.ok(result.categories[type] >= 1, type);
  }
  assert.equal(scanSensitiveText('Export took 10 seconds. Team wants CSV.').outcome, 'no_rule_match');
  assert.equal(scanSensitiveText('An unknown token was included').outcome, 'quarantined');
});
test('retention is fixed on retries, dry-run and deletion leave safe tombstones', () => fixture(root => {
  const content = synthetic.map(([,v]) => v).join('\n');
  const original = ingestPrivateCapture(root, { content, now: '2026-01-01' });
  const retried = ingestPrivateCapture(root, { sourceId: original.record.source_id, content: 'retry', now: '2026-02-01' });
  assert.equal(retried.record.expires_at, original.record.expires_at);
  assert.equal(purgeRaw(root, { now: '2026-02-01' }).items[0].status, 'would_delete');
  assert.ok(fs.existsSync(path.join(root, original.path)));
  const failure = purgeRaw(root, { apply: true, now: '2026-02-01', unlink() { throw new Error(content); } });
  assert.equal(failure.items[0].status, 'deletion_failed');
  assert.ok(!JSON.stringify(failure).includes(content));
  assert.equal(purgeRaw(root, { apply: true, now: '2026-02-01' }).items[0].status, 'deleted');
  const record = privacyInventory(root)[0];
  assert.equal(record.current_path, null);
  assert.equal(record.source_id, original.record.source_id);
  for (const [,value] of synthetic) assert.ok(!JSON.stringify(record).includes(value));
  assert.equal(purgeRaw(root, { apply: true, now: '2026-02-01' }).items.length, 0);
}));
test('unsupported attachments quarantine, expired failures stay eligible, claims block deletion', () => fixture(root => {
  const item = ingestPrivateCapture(root, { content: Buffer.from('synthetic attachment'), supported: false, now: '2026-01-01' });
  assert.equal(item.outcome, 'quarantined');
  fs.writeFileSync(path.join(root, 'governance/inbox-processing.lock.json'), '{}');
  assert.equal(purgeRaw(root, { apply: true, now: '2026-02-01' }).items[0].status, 'recovery_required');
  fs.unlinkSync(path.join(root, 'governance/inbox-processing.lock.json'));
  assert.equal(purgeRaw(root, { apply: true, now: '2026-02-01' }).items[0].status, 'deleted');
}));
test('manual files quarantine without copying original filename to metadata or reports', () => fixture(root => {
  fs.mkdirSync(path.join(root, '6-raw/inbox'), { recursive: true });
  const name = 'synthetic-private-customer.pdf';
  fs.writeFileSync(path.join(root, '6-raw/inbox', name), 'synthetic attachment');
  assert.equal(scanRaw(root).unregistered_items, 1);
  assert.equal(scanRaw(root, { apply: true }).unregistered_items, 1);
  assert.equal(scanRaw(root).unregistered_items, 0);
  assert.ok(!JSON.stringify(privacyInventory(root)).includes(name));
  assert.equal(privacyInventory(root)[0].outcome, 'quarantined');
}));
test('malformed policy and symlinks fail closed with safe errors', () => fixture(root => {
  fs.writeFileSync(path.join(root, 'mole.privacy.json'), '{broken');
  assert.throws(() => ingestPrivateCapture(root, { content: 'private fixture' }), /Privacy operation failed/);
  fs.unlinkSync(path.join(root, 'mole.privacy.json'));
  fs.symlinkSync(os.tmpdir(), path.join(root, '6-raw'));
  assert.throws(() => ingestPrivateCapture(root, { content: 'private fixture' }), /Privacy operation failed/);
}));
test('crash recovery covers orphan staging and renamed managed files', () => fixture(root => {
  const item = ingestPrivateCapture(root, { content: 'synthetic', now: '2026-01-01' });
  const recordFile = path.join(root, 'governance/privacy', `${item.record.source_id}.json`);
  const record = JSON.parse(fs.readFileSync(recordFile));
  record.current_path = `6-raw/staging/${record.source_id}.bin`;
  fs.writeFileSync(recordFile, JSON.stringify(record));
  assert.equal(purgeRaw(root, { apply: true, now: '2026-02-01' }).items[0].status, 'deleted');
  assert.ok(!fs.existsSync(path.join(root, item.path)));
}));
test('CLI and UI quarantine uncertain input without exposing raw values in response', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-privacy-'));
  try {
    const note = 'synthetic private token of an unknown format';
    const result = await captureNote(root, { note });
    assert.equal(result.payload.state, 'quarantined');
    assert.ok(!JSON.stringify(result).includes(note));
    const proc = spawnSync(process.execPath, [cli, 'insight', note], { cwd: root, encoding: 'utf8' });
    assert.equal(proc.status, 0, proc.stderr);
    assert.match(proc.stdout, /Quarantined/);
    assert.ok(!proc.stdout.includes(note));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
