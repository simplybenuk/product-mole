import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { ingestPrivateCapture, privacyInventory, purgeRaw, reviewQuarantine } from '../privacy.mjs';
import { listLifecycleRecords } from '../review-lifecycle.mjs';
import { registerSource, linkAttachment } from '../source-registry.mjs';
import { inspectInboxDuplicates as check, inspectInboxDuplicateBatch as batch, assertInboxDuplicateProcessing as guard } from '../inbox-duplicates.mjs';
import { claimInboxProcessing, checkpointInboxProcessing, completeInboxProcessing } from '../inbox-processing.mjs';
import { collectMetricEvents } from '../metrics-summary.mjs';
import { recordProcessedInboxItems, backfillProcessedInboxMetrics, getMetricsPaths } from '../metrics.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-private-dedup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const add = (content, options = {}) => {
    const capture = ingestPrivateCapture(root, { content, now });
    const id = capture.record.source_id;
    if (capture.outcome !== 'quarantined') registerSource(root, { source_id: id, path: capture.path, captured_at: now, ...options });
    return { id, path: capture.path, capture };
  };
  return { root, add };
}
function ledgers(root) {
  const found = {};
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else found[path.relative(root, file)] = fs.readFileSync(file, 'utf8');
    }
  };
  walk(path.join(root, 'governance'));
  return found;
}
function expire(root, id) {
  const file = path.join(root, 'governance/privacy', `${id}.json`);
  const record = JSON.parse(fs.readFileSync(file));
  record.captured_at = '2020-01-01T00:00:00Z'; record.expires_at = '2020-01-08T00:00:00Z';
  fs.writeFileSync(file, JSON.stringify(record));
}
function forbidHashing(t, canary) {
  const original = crypto.createHash;
  const hook = t.mock.method(crypto, 'createHash', (...args) => {
    const digest = original(...args), update = digest.update;
    digest.update = function(data, ...rest) {
      assert.ok(!String(data).includes(canary), 'rejected content must not be hashed');
      return update.call(this, data, ...rest);
    };
    return digest;
  });
  syncBuiltinESMExports();
  return () => { hook.mock.restore(); syncBuiltinESMExports(); };
}

test('cleaned captures, checkpoints, receipts and path-only metric retries share one processing identity', t => {
  const { root, add } = fixture(t);
  const canary = ['synthetic-private', 'example.invalid'].join('@');
  const a = add(`Checkout observation ${canary}`);
  const b = add(`Checkout observation ${canary}`);
  assert.equal(a.capture.outcome, 'redacted');
  const owner = { runId: 'clean-run', processor: 'reviewer', host: 'fixture', claimedPaths: [a.path] };
  assert.equal(claimInboxProcessing(root, owner).ok, true);
  assert.equal(checkpointInboxProcessing(root, { ...owner, processed: [a.path] }).ok, true);
  const done = completeInboxProcessing(root, { ...owner, processed: [a.path] });
  assert.equal(done.ok, true, done.message);
  assert.equal(completeInboxProcessing(root, { ...owner, processed: [a.path] }).idempotent, true);
  assert.equal(recordProcessedInboxItems(root, [a.path], { runId: owner.runId }).counted, 1);
  assert.equal(recordProcessedInboxItems(root, [a.path], { runId: owner.runId }).counted, 0);
  assert.equal(backfillProcessedInboxMetrics(root).processed_paths_counted, 1);
  assert.equal(collectMetricEvents(root).events.filter(e => e.category === 'processed_inputs').length, 1);
  const second = { ...owner, runId: 'copy-run', claimedPaths: [b.path] };
  claimInboxProcessing(root, second);
  const before = ledgers(root);
  assert.equal(completeInboxProcessing(root, { ...second, processed: [b.path] }).code, 'DUPLICATE_REVIEW_REQUIRED');
  assert.deepEqual(ledgers(root), before);
  assert.ok(!JSON.stringify(before).includes(canary));
  assert.equal(JSON.parse(fs.readFileSync(getMetricsPaths(root).dailyPath)).records.at(-1).count, 1);
});

test('direct quarantine, expired, unregistered and edited-sensitive inputs fail before hashing or ledger writes', t => {
  const { root, add } = fixture(t);
  const quarantine = add('Synthetic unknown token');
  const expired = add('Older checkout observation'); expire(root, expired.id);
  const edited = add('Clean checkout observation');
  const canary = ['synthetic-private', 'example.invalid'].join('@');
  fs.writeFileSync(path.join(root, edited.path), canary);
  const before = ledgers(root), restore = forbidHashing(t, canary);
  try {
    for (const item of [quarantine, expired, edited]) assert.throws(() => check(root, item.id), /privacy|Privacy/);
    assert.throws(() => guard(root, ['6-raw/inbox/legacy.md']), /Privacy/);
    assert.deepEqual(ledgers(root), before);
  } finally { restore(); }
});

test('near and exact candidates are privacy-gated before reading or hashing, whole batch refusal is unchanged', t => {
  const { root, add } = fixture(t);
  const a = add('Customers cannot finish checkout because the form loses delivery address details');
  check(root, a.id);
  const b = add('Customers cannot finish checkout because the payment form loses delivery address details');
  const canary = 'api_key: SYNTHETIC_ONLY_VALUE';
  fs.writeFileSync(path.join(root, a.path), canary);
  const before = ledgers(root), restore = forbidHashing(t, canary);
  try {
    assert.throws(() => check(root, b.id), /Privacy/);
    assert.throws(() => batch(root, [b.id, a.id]), /Privacy/);
    assert.deepEqual(ledgers(root), before);
  } finally { restore(); }
});

test('attachments require their own privacy eligibility and contribute only cleaned hashes', t => {
  const { root, add } = fixture(t);
  const a = add('Same checkout note'), b = add('Same checkout note');
  const x = add('Clean attachment alpha', { source_type: 'attachment', parent_source_id: a.id });
  const y = add('Clean attachment beta', { source_type: 'attachment', parent_source_id: b.id });
  linkAttachment(root, a.id, x.id); linkAttachment(root, b.id, y.id);
  assert.notEqual(check(root, a.id).fingerprint, check(root, b.id).fingerprint);
  // Unsupported originals are rejected before any attachment registration.
  const binary = ingestPrivateCapture(root, { content: Buffer.from([0, 255]), supported: false });
  assert.throws(() => check(root, binary.record.source_id), /privacy eligibility/);
  const canary = 'password: SYNTHETIC_ONLY_VALUE';
  fs.writeFileSync(path.join(root, x.path), canary);
  const before = ledgers(root), restore = forbidHashing(t, canary);
  try { assert.throws(() => check(root, a.id), /Privacy/); assert.deepEqual(ledgers(root), before); }
  finally { restore(); }

});

test('retention tombstones keep cleaned exact fingerprints, restored expired copies and arbitrary moves remain blocked', t => {
  const { root, add } = fixture(t);
  const a = add('Same clean checkout observation');
  const fingerprint = check(root, a.id).fingerprint;
  const before = fs.readFileSync(path.join(root, 'governance/inbox-duplicates/records', `${a.id}.json`), 'utf8');
  expire(root, a.id);
  assert.equal(purgeRaw(root, { apply: true }).items[0].status, 'deleted');
  assert.equal(privacyInventory(root)[0].retention_state, 'deleted');
  assert.equal(fs.readFileSync(path.join(root, 'governance/inbox-duplicates/records', `${a.id}.json`), 'utf8'), before);
  const b = add('Same clean checkout observation');
  assert.equal(check(root, b.id).fingerprint, fingerprint);
  assert.equal(check(root, b.id).candidates[0].match, 'exact');
  fs.writeFileSync(path.join(root, a.path), 'Restored expired content');
  assert.throws(() => check(root, a.id), /privacy eligibility/);
  purgeRaw(root, { apply: true });
  const moved = path.join(root, '6-raw/inbox/moved.md');
  fs.renameSync(path.join(root, b.path), moved);
  const untouched = ledgers(root);
  assert.throws(() => check(root, b.id), /Privacy/);
  assert.deepEqual(ledgers(root), untouched);
  fs.renameSync(moved, path.join(root, b.path));
  assert.equal(check(root, b.id).fingerprint, fingerprint);
});

test('reviewed quarantine derivative keeps its ID through the supported release move and remains raw', t => {
  const { root, add } = fixture(t);
  const item = add('Synthetic unknown token');
  const expiry = item.capture.record.expires_at;
  fs.writeFileSync(path.join(root, `6-raw/quarantine/${item.id}.md`), 'Reviewed synthetic checkout observation');
  reviewQuarantine(root, item.id, { apply: true, confirmReviewed: true });
  assert.equal(check(root, item.id).source_id, item.id);
  assert.equal(privacyInventory(root)[0].expires_at, expiry);
  assert.deepEqual(listLifecycleRecords(root).map(r => r.state), ['raw']);
});

test('legacy registered paths cannot bypass processing privacy and failures preserve locks and all ledgers', t => {
  const { root } = fixture(t);
  const file = '6-raw/inbox/legacy.md';
  fs.mkdirSync(path.join(root, '6-raw/inbox'), { recursive: true });
  fs.writeFileSync(path.join(root, file), 'Synthetic legacy observation');
  const owner = { runId: 'legacy-run', processor: 'reviewer', host: 'fixture', claimedPaths: [file] };
  claimInboxProcessing(root, owner);
  let before = ledgers(root);
  assert.equal(checkpointInboxProcessing(root, { ...owner, processed: [file] }).code, 'DUPLICATE_REVIEW_REQUIRED');
  assert.deepEqual(ledgers(root), before);
  const registration = registerSource(root, { path: file });
  before = ledgers(root);
  assert.throws(() => check(root, registration.source_id), /privacy/);
  assert.equal(completeInboxProcessing(root, { ...owner, processed: [file] }).code, 'DUPLICATE_REVIEW_REQUIRED');
  assert.deepEqual(ledgers(root), before);
});
