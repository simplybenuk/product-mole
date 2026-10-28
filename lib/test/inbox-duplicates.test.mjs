import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { registerSource, registerAttachment, reconcileSource } from '../source-registry.mjs';
import { inspectInboxDuplicates as check, recordDuplicateDecision as decide, assertInboxDuplicateProcessing as guard } from '../inbox-duplicates.mjs';
import { collectMetricEvents } from '../metrics-summary.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimInboxProcessing, completeInboxProcessing } from '../inbox-processing.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-dedup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '6-raw/inbox'), { recursive: true });
  const add = (name, text, options = {}) => {
    const file = `6-raw/inbox/${name}`;
    fs.writeFileSync(path.join(root, file), text);
    return { ...registerSource(root, { path: file, captured_at: '2026-10-01T00:00:00Z', ...options }), file };
  };
  return { root, add };
}
test('normalized exact fingerprints ignore filename and volatile capture fields, preserve identity', t => {
  const { root, add } = fixture(t);
  const a = add('a.md', 'Hello  WORLD\r\n');
  const b = add('b.md', 'hello world\n');
  check(root, a.source_id);
  const report = check(root, b.source_id);
  assert.notEqual(a.source_id, b.source_id);
  assert.equal(report.candidates[0].match, 'exact');
  assert.throws(() => guard(root, [a.file, b.file]), /already processed/);
  assert.doesNotThrow(() => guard(root, [a.file]));
  decide(root, { sourceId: b.source_id, targetId: a.source_id, status: 'duplicate', actor: 'reviewer', reason: 'retry', confirmHuman: true });
  assert.throws(() => guard(root, [b.file]), /marked duplicate/);
  const original = check(root, a.source_id).fingerprint;
  fs.renameSync(path.join(root, a.file), path.join(root, '6-raw/inbox/moved.md'));
  reconcileSource(root, a.source_id, '6-raw/inbox/moved.md');
  assert.equal(check(root, a.source_id).fingerprint, original);
});
test('minor wording suggestions explain overlap, never automatically merge', t => {
  const { root, add } = fixture(t);
  const a = add('a.txt', 'Customers cannot finish checkout because the payment form loses saved address details');
  const b = add('b.txt', 'Customers cannot finish checkout because the payment form loses saved delivery address details');
  check(root, a.source_id);
  const report = check(root, b.source_id);
  assert.equal(report.candidates[0].match, 'near');
  assert.equal(report.candidates[0].explanation.method, 'token-jaccard-v1');
  assert.doesNotThrow(() => guard(root, [a.file, b.file]));
  assert.throws(() => check(root, a.source_id, { threshold: 0.2 }), /threshold/);
  const c = add('c.txt', 'Customers finish checkout and save payment address details without errors');
  assert.equal(check(root, c.source_id).candidates.length, 0);
});
test('attachment bytes participate; missing or changed attachments fail closed', t => {
  const { root, add } = fixture(t);
  const a = add('a.txt', 'same'), b = add('b.txt', 'same');
  fs.writeFileSync(path.join(root, '6-raw/inbox/a.bin'), Buffer.from([0, 1]));
  fs.writeFileSync(path.join(root, '6-raw/inbox/b.bin'), Buffer.from([0, 2]));
  registerAttachment(root, a.source_id, '6-raw/inbox/a.bin');
  registerAttachment(root, b.source_id, '6-raw/inbox/b.bin');
  check(root, a.source_id);
  assert.equal(check(root, b.source_id).candidates.length, 0);
  fs.writeFileSync(path.join(root, '6-raw/inbox/a.bin'), 'changed');
  assert.throws(() => check(root, a.source_id), /changed|unresolved/);
});
test('conflicting capture metadata requires a human, immutable raw-free decisions', t => {
  const { root, add } = fixture(t);
  const a = add('a.txt', 'Sensitive sample text'), b = add('b.txt', 'Sensitive sample text', { channel: 'other' });
  check(root, a.source_id); check(root, b.source_id);
  assert.throws(() => guard(root, [a.file]), /conflicting capture metadata/);
  const d = { sourceId: b.source_id, targetId: a.source_id, status: 'distinct', actor: 'reviewer', reason: 'separate-event' };
  assert.throws(() => decide(root, d), /human confirmation/);
  const first = decide(root, { ...d, confirmHuman: true });
  assert.deepEqual(decide(root, { ...d, confirmHuman: true }), first);
  assert.throws(() => decide(root, { ...d, status: 'duplicate', confirmHuman: true }), /different immutable/);
  assert.doesNotThrow(() => guard(root, [a.file, b.file]));
  const data = fs.readdirSync(path.join(root, 'governance/inbox-duplicates/records')).map(f => fs.readFileSync(path.join(root, 'governance/inbox-duplicates/records', f), 'utf8')).join('');
  assert.equal(data.includes('Sensitive'), false);
  assert.equal(data.includes('other'), false);
});
test('completion retry is idempotent and copied content cannot add another receipt', t => {
  const { root, add } = fixture(t);
  const a = add('a.txt', 'same observation');
  const options = { runId: 'first', processor: 'tester', host: 'local', claimedPaths: [a.file] };
  assert.equal(claimInboxProcessing(root, options).ok, true);
  const complete = { ...options, processed: [a.file], summary: 'done' };
  const result = completeInboxProcessing(root, complete);
  assert.equal(result.ok, true, result.message);
  assert.equal(completeInboxProcessing(root, complete).idempotent, true);
  const b = add('copy.txt', 'same observation');
  const second = { ...options, runId: 'second', claimedPaths: [b.file] };
  assert.equal(claimInboxProcessing(root, second).ok, true);
  const blocked = completeInboxProcessing(root, { ...second, processed: [b.file] });
  assert.equal(blocked.code, 'DUPLICATE_REVIEW_REQUIRED', blocked.message);
  assert.equal(fs.readdirSync(path.join(root, 'governance/run-receipts/inbox-processing')).filter(f => f.endsWith('.json')).length, 1);
  assert.equal(collectMetricEvents(root).events.filter(e => e.category === 'processed_inputs').length, 1);
  fs.unlinkSync(path.join(root, a.file));
  assert.equal(check(root, b.source_id).candidates[0].match, 'exact');
});
test('changed indexed sources and sync ledger conflicts fail closed', t => {
  const { root, add } = fixture(t);
  const a = add('a.txt', 'original observation');
  check(root, a.source_id);
  fs.writeFileSync(path.join(root, a.file), 'different observation');
  assert.throws(() => check(root, a.source_id), /changed|unresolved/);
  const b = add('b.txt', 'original observation');
  const dir = path.join(root, 'governance/inbox-duplicates/records');
  fs.copyFileSync(path.join(dir, `${a.source_id}.json`), path.join(dir, 'conflicted copy.json'));
  assert.throws(() => check(root, b.source_id), /conflicting/);
});

test('CLI reports suggestions and human superseding decision without raw text', t => {
  const { root, add } = fixture(t);
  const a = add('a.txt', 'same captured observation'), b = add('b.txt', 'same captured observation');
  const cli = fileURLToPath(new URL('../../cli/mole.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [cli, 'inbox', 'duplicates', ...args], { cwd: root, encoding: 'utf8' });
  const result = run(['check', a.source_id, b.source_id]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)[0].candidates[0].match, 'exact');
  assert.equal(result.stdout.includes('same captured observation'), false);
  const decision = run(['decide', a.source_id, b.source_id, 'superseded', '--confirm-human', '--actor', 'reviewer', '--reason', 'newer-observation']);
  assert.equal(decision.status, 0, decision.stderr);
  assert.throws(() => guard(root, [a.file]), /marked superseded/);
  assert.doesNotThrow(() => guard(root, [b.file]));
});
test('binary files are byte-exact and invalid UTF-8 text fails closed', t => {
  const { root, add } = fixture(t);
  const a = add('a.bin', Buffer.from([255, 65]));
  const b = add('b.bin', Buffer.from([254, 65]));
  check(root, a.source_id);
  assert.equal(check(root, b.source_id).candidates.length, 0);
  const c = add('bad.txt', Buffer.from([255]));
  assert.throws(() => check(root, c.source_id), /UTF-8/);
});

test('sync conflict source names and symlink ledger paths cannot be indexed', t => {
  const { root, add } = fixture(t);
  const conflicted = add('note (conflicted copy).txt', 'same source copy');
  assert.throws(() => check(root, conflicted.source_id), /sync conflict/);
  const a = add('a.txt', 'ordinary source');
  fs.mkdirSync(path.join(root, 'elsewhere'));
  fs.mkdirSync(path.join(root, 'governance'), { recursive: true });
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'governance/inbox-duplicates'));
  assert.throws(() => check(root, a.source_id), /symlink/);
});
