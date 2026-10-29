import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanSensitiveText, ingestPrivateCapture, privacyInventory, purgeRaw, scanRaw, reviewQuarantine, assertPrivacyProcessing } from '../privacy.mjs';
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
test('restored tombstoned raw copies remain deletable without resetting expiry', () => fixture(root => {
  const item = ingestPrivateCapture(root, { content: 'synthetic', now: '2026-01-01' });
  purgeRaw(root, { apply: true, now: '2026-02-01' });
  fs.writeFileSync(path.join(root, item.path), 'synthetic restored bytes');
  assert.equal(purgeRaw(root, { apply: true, now: '2026-02-02' }).items[0].status, 'deleted');
  assert.equal(privacyInventory(root)[0].deleted_at, '2026-02-01T00:00:00.000Z');
}));

test('review releases only a cleaned derivative, preserving identity, expiry and raw review state', () => fixture(root => {
  const item = ingestPrivateCapture(root, { content: 'synthetic unknown token' });
  fs.writeFileSync(path.join(root, '6-raw/quarantine', `${item.record.source_id}.md`), 'Reviewed synthetic CSV insight');
  assert.throws(() => reviewQuarantine(root, item.record.source_id, { apply: true }));
  assert.equal(reviewQuarantine(root, item.record.source_id, { confirmReviewed: true }).applied, false);
  reviewQuarantine(root, item.record.source_id, { confirmReviewed: true, apply: true });
  const record = privacyInventory(root)[0];
  assert.equal(record.expires_at, item.record.expires_at);
  assert.equal(record.review_state, 'reviewed');
  assertPrivacyProcessing(root, [record.current_path]);
  assert.throws(() => assertPrivacyProcessing(root, [item.path]));
  assert.equal(scanRaw(root).unregistered_items, 0);
  assert.ok(fs.existsSync(path.join(root, item.path)));
}));

test('processing gate rejects expired, unregistered and edited sensitive bytes', () => fixture(root => {
  assert.throws(() => assertPrivacyProcessing(root, ['6-raw/inbox/unregistered.md']));
  const expired = ingestPrivateCapture(root, { content: 'synthetic old note', now: '2020-01-01' });
  assert.throws(() => assertPrivacyProcessing(root, [expired.path]));
  const item = ingestPrivateCapture(root, { content: 'synthetic safe note' });
  assertPrivacyProcessing(root, [item.path]);
  fs.writeFileSync(path.join(root, item.path), 'password: synthetic-only');
  assert.throws(() => assertPrivacyProcessing(root, [item.path]));
}));
test('Git guard rejects forced raw additions while allowing bundled README', () => fixture(root => {
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(git('init', '-q').status, 0);
  fs.mkdirSync(path.join(root, '6-raw/inbox'), { recursive: true });
  fs.writeFileSync(path.join(root, '6-raw/inbox/README.md'), 'Bundled instructions');
  assert.equal(git('add', '.').status, 0);
  const script = fileURLToPath(new URL('../../scripts/check-raw-git.mjs', import.meta.url));
  const guard = () => spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  assert.equal(guard().status, 0);
  fs.writeFileSync(path.join(root, '6-raw/inbox/synthetic-private.md'), 'Synthetic only');
  assert.equal(git('add', '-f', '.').status, 0);
  const result = guard();
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes('synthetic-private'));
}));
