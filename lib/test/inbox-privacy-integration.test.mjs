import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import * as privacyModule from '../privacy.mjs';
import { recordDuplicateDecision } from '../inbox-duplicates.mjs';
import { ingestPrivateCapture, privacyInventory, purgeRaw, reviewQuarantine } from '../privacy.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listLifecycleRecords, registerLifecycleRecord } from '../review-lifecycle.mjs';
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

test('malformed duplicate ledger errors never reflect sensitive fragments', t => {
  const { root, add } = fixture(t);
  const item = add('Synthetic checkout observation'); check(root, item.id);
  const file = path.join(root, 'governance/inbox-duplicates/records', `${item.id}.json`);
  const canary = 'SYNTHETIC_PRIVATE_FRAGMENT';
  fs.writeFileSync(file, '{"' + canary);
  assert.throws(() => check(root, item.id), error => /malformed duplicate ledger/.test(error.message) && !error.message.includes(canary));
});

test('redaction can collapse distinct originals, so equal cleaned content requires human review', t => {
  const { root, add } = fixture(t);
  const a = add('Checkout report for synthetic-one@example.invalid');
  const b = add('Checkout report for synthetic-two@example.invalid');
  const reports = batch(root, [a.id, b.id]);
  assert.equal(reports[0].candidates[0].match, 'exact');
  assert.ok(reports[0].candidates[0].conflicts.includes('privacy_redaction'));
  const before = ledgers(root);
  assert.throws(() => guard(root, [a.path, b.path]), /human decision required/);
  assert.deepEqual(ledgers(root), before);
});

test('26-R2-1 redacted attachments require human review for live and tombstoned parent matches', t => {
  const { root, add } = fixture(t);
  const a = add('Same parent observation'), b = add('Same parent observation');
  const x = add('Report for synthetic-one@example.invalid', { source_type: 'attachment', parent_source_id: a.id });
  const y = add('Report for synthetic-two@example.invalid', { source_type: 'attachment', parent_source_id: b.id });
  linkAttachment(root, a.id, x.id); linkAttachment(root, b.id, y.id);
  const reports = batch(root, [a.id, b.id]);
  assert.ok(reports[0].candidates[0].conflicts.includes('privacy_redaction'));
  const owner = { runId: 'attachment-run', processor: 'reviewer', host: 'fixture', claimedPaths: [a.path] };
  claimInboxProcessing(root, owner);
  const before = ledgers(root);
  assert.equal(completeInboxProcessing(root, { ...owner, processed: [a.path] }).code, 'DUPLICATE_REVIEW_REQUIRED');
  assert.deepEqual(ledgers(root), before);
  assert.equal(collectMetricEvents(root).events.filter(e => e.category === 'processed_inputs').length, 0);
  completeInboxProcessing(root, { ...owner, processed: [] });
  expire(root, a.id); expire(root, x.id); purgeRaw(root, { apply: true });
  const retained = check(root, b.id).candidates.find(c => c.source_id === a.id);
  assert.equal(retained.match, 'exact');
  assert.ok(retained.conflicts.includes('privacy_redaction'));
  assert.throws(() => guard(root, [b.path]), /human decision required/);
  const decision = recordDuplicateDecision(root, { sourceId: b.id, targetId: a.id, status: 'distinct', actor: 'reviewer', reason: 'separate-event', confirmHuman: true });
  assert.equal(check(root, b.id).candidates.find(c => c.source_id === a.id).decision.timestamp, decision.timestamp);
  assert.doesNotThrow(() => guard(root, [b.path]));
});

test('26-R2-2 directed human decisions stay visible below thresholds and after near target purge', t => {
  const { root, add } = fixture(t);
  const a = add('Checkout payment form loses saved delivery address details for customers');
  const b = add('Checkout payment form loses delivery address details for customers');
  const unrelated = add('Export pagination completes without interruption for analysts');
  batch(root, [a.id, b.id, unrelated.id]);
  const below = recordDuplicateDecision(root, { sourceId: unrelated.id, targetId: a.id, status: 'duplicate', actor: 'reviewer', reason: 'same-observation', confirmHuman: true });
  const near = recordDuplicateDecision(root, { sourceId: b.id, targetId: a.id, status: 'superseded', actor: 'reviewer', reason: 'newer-observation', confirmHuman: true });
  for (const threshold of [0.8, 1]) {
    const candidate = check(root, unrelated.id, { threshold }).candidates.find(c => c.source_id === a.id);
    assert.ok(candidate, 'stored decision must survive a low lexical score');
    assert.deepEqual(candidate.decision, below);
  }
  expire(root, a.id); purgeRaw(root, { apply: true });
  const originalRead = fs.readFileSync;
  const hook = t.mock.method(fs, 'readFileSync', (file, ...args) => {
    assert.notEqual(String(file), path.join(root, a.path), 'purged raw must not be read');
    return originalRead(file, ...args);
  });
  try {
    for (const [source, decision] of [[b, near], [unrelated, below]]) {
      const candidate = check(root, source.id).candidates.find(c => c.source_id === a.id);
      assert.ok(candidate, 'decision must survive target purge');
      assert.deepEqual(candidate.decision, decision);
      assert.equal(candidate.decision_target.source_id, a.id);
      assert.equal(candidate.decision_target.retention_state, 'deleted');
      assert.equal(candidate.decision_target.raw_comparison_available, false);
    }
  } finally { hook.mock.restore(); }
});

test('managed archive preserves source, fingerprint, expiry and processing receipt identity through retention', t => {
  const { root, add } = fixture(t);
  assert.equal(typeof privacyModule.archiveManagedRaw, 'function');
  const a = add('Managed source observation');
  const fingerprint = check(root, a.id).fingerprint;
  const expiry = privacyInventory(root)[0].expires_at;
  const dest = `6-raw/inbox/archive/${a.id}.md`;
  const preview = privacyModule.archiveManagedRaw(root, a.id);
  assert.equal(preview.path, dest); assert.equal(preview.applied, false);
  assert.ok(fs.existsSync(path.join(root, a.path)));
  privacyModule.archiveManagedRaw(root, a.id, { apply: true });
  assert.equal(check(root, a.id).fingerprint, fingerprint);
  assert.equal(privacyInventory(root)[0].expires_at, expiry);
  assert.equal(privacyInventory(root)[0].current_path, dest);
  const owner = { runId: 'archive-run', processor: 'reviewer', host: 'fixture', claimedPaths: [dest] };
  assert.equal(claimInboxProcessing(root, owner).ok, true);
  assert.equal(completeInboxProcessing(root, { ...owner, processed: [dest] }).ok, true);
  assert.equal(completeInboxProcessing(root, { ...owner, processed: [dest] }).idempotent, true);
  assert.equal(collectMetricEvents(root).events.filter(e => e.category === 'processed_inputs').length, 1);
  expire(root, a.id); purgeRaw(root, { apply: true });
  assert.equal(fs.existsSync(path.join(root, dest)), false);
  assert.equal(privacyInventory(root)[0].retention_state, 'deleted');
  assert.equal(completeInboxProcessing(root, { ...owner, processed: [dest] }).idempotent, true);
});

test('managed archive refuses locks, symlinks, existing targets and interrupted moves require explicit recovery', t => {
  const { root, add } = fixture(t);
  assert.equal(typeof privacyModule.archiveManagedRaw, 'function');
  const a = add('Managed interruption observation');
  const dest = `6-raw/inbox/archive/${a.id}.md`;
  const owner = { runId: 'move-lock', processor: 'reviewer', host: 'fixture', claimedPaths: [a.path] };
  claimInboxProcessing(root, owner);
  const before = ledgers(root);
  assert.throws(() => privacyModule.archiveManagedRaw(root, a.id, { apply: true }));
  assert.deepEqual(ledgers(root), before);
  completeInboxProcessing(root, { ...owner, processed: [] });
  fs.mkdirSync(path.join(root, '6-raw/inbox/archive'), { recursive: true });
  fs.writeFileSync(path.join(root, dest), 'Foreign existing target');
  assert.throws(() => privacyModule.archiveManagedRaw(root, a.id, { apply: true }));
  assert.equal(fs.readFileSync(path.join(root, dest), 'utf8'), 'Foreign existing target');
  fs.unlinkSync(path.join(root, dest));
  // Crash just after the exclusive same-inode link. Both copies must survive.
  const original = fs.linkSync;
  const hook = t.mock.method(fs, 'linkSync', (...args) => { original(...args); throw new Error('synthetic interruption'); });
  try { assert.throws(() => privacyModule.archiveManagedRaw(root, a.id, { apply: true })); }
  finally { hook.mock.restore(); }
  assert.ok(fs.existsSync(path.join(root, a.path))); assert.ok(fs.existsSync(path.join(root, dest)));
  assert.throws(() => check(root, a.id), /Privacy|privacy|move/);
  assert.throws(() => privacyModule.archiveManagedRaw(root, a.id, { apply: true }));
  privacyModule.archiveManagedRaw(root, a.id, { apply: true, recover: true });
  assert.equal(check(root, a.id).source_id, a.id);
  assert.equal(fs.existsSync(path.join(root, a.path)), false);
});

test('26-R2-1 legacy version-two records without attachment provenance remain conservatively ambiguous', t => {
  const { root, add } = fixture(t);
  const a = add('Same clean observation'), b = add('Same clean observation');
  check(root, a.id);
  const file = path.join(root, 'governance/inbox-duplicates/records', `${a.id}.json`);
  const legacy = JSON.parse(fs.readFileSync(file)); legacy.version = 2; delete legacy.redaction_ambiguous;
  fs.writeFileSync(file, JSON.stringify(legacy));
  const original = fs.readFileSync(file, 'utf8');
  assert.ok(check(root, b.id).candidates[0].conflicts.includes('privacy_redaction'));
  expire(root, a.id); purgeRaw(root, { apply: true });
  assert.ok(check(root, b.id).candidates[0].conflicts.includes('privacy_redaction'));
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

for (const phase of ['before-link', 'after-manifest', 'after-registry', 'after-unlink']) {
  test(`managed archive recovers explicit interrupted phase ${phase} without renewing TTL`, t => {
    const { root, add } = fixture(t);
    const item = add('Managed phase observation');
    const fingerprint = check(root, item.id).fingerprint, expires = item.capture.record.expires_at;
    let fired = false;
    let hook;
    if (phase === 'before-link') hook = t.mock.method(fs, 'linkSync', () => { fired = true; throw new Error('synthetic interruption'); });
    else if (phase === 'after-unlink') {
      const original = fs.unlinkSync;
      hook = t.mock.method(fs, 'unlinkSync', (file, ...rest) => {
        const result = original(file, ...rest);
        if (String(file) === path.join(root, item.path)) { fired = true; throw new Error('synthetic interruption'); }
        return result;
      });
    } else {
      const original = fs.renameSync;
      const destination = phase === 'after-manifest' ? `governance/privacy/${item.id}.json` : `governance/sources/records/${item.id}.json`;
      hook = t.mock.method(fs, 'renameSync', (from, to, ...rest) => {
        const result = original(from, to, ...rest);
        if (String(to) === path.join(root, destination)) { fired = true; throw new Error('synthetic interruption'); }
        return result;
      });
    }
    try { assert.throws(() => privacyModule.archiveManagedRaw(root, item.id, { apply: true })); }
    finally { hook.mock.restore(); }
    assert.equal(fired, true);
    assert.throws(() => check(root, item.id));
    assert.equal(purgeRaw(root, { apply: true }).recovery_required, true);
    privacyModule.archiveManagedRaw(root, item.id, { apply: true, recover: true });
    assert.equal(check(root, item.id).fingerprint, fingerprint);
    assert.equal(privacyInventory(root)[0].expires_at, expires);
    assert.equal(privacyModule.archiveManagedRaw(root, item.id, { apply: true }).idempotent, true);
  });
}

test('managed archive preserves ambiguous copies, foreign-owned targets, symlinks and conflict locks', t => {
  const { root, add } = fixture(t);
  const item = add('Managed ownership observation');
  const dest = `6-raw/inbox/archive/${item.id}.md`;
  const lock = path.join(root, 'governance/inbox-processing (conflicted copy).lock.json');
  fs.writeFileSync(lock, '{}');
  let before = ledgers(root);
  assert.throws(() => privacyModule.archiveManagedRaw(root, item.id, { apply: true }));
  assert.deepEqual(ledgers(root), before); fs.unlinkSync(lock);
  fs.mkdirSync(path.join(root, 'other'));
  fs.symlinkSync(path.join(root, 'other'), path.join(root, '6-raw/inbox/archive'));
  assert.throws(() => privacyModule.archiveManagedRaw(root, item.id, { apply: true }));
  fs.unlinkSync(path.join(root, '6-raw/inbox/archive'));
  fs.mkdirSync(path.join(root, '6-raw/inbox/archive'));
  fs.symlinkSync(path.join(root, 'missing'), path.join(root, dest));
  assert.throws(() => privacyModule.archiveManagedRaw(root, item.id, { apply: true }));
  fs.unlinkSync(path.join(root, dest));
  const originalLink = fs.linkSync;
  const hook = t.mock.method(fs, 'linkSync', (...args) => { originalLink(...args); throw new Error('synthetic interruption'); });
  try { assert.throws(() => privacyModule.archiveManagedRaw(root, item.id, { apply: true })); }
  finally { hook.mock.restore(); }
  // A sync replacement creates a different inode. Preserve both, even with equal bytes.
  const copy = fs.readFileSync(path.join(root, dest));
  fs.unlinkSync(path.join(root, dest)); fs.writeFileSync(path.join(root, dest), copy);
  before = ledgers(root);
  assert.throws(() => privacyModule.archiveManagedRaw(root, item.id, { apply: true, recover: true }));
  assert.deepEqual(ledgers(root), before);
  assert.ok(fs.existsSync(path.join(root, item.path))); assert.ok(fs.existsSync(path.join(root, dest)));
});

test('managed archive refuses a foreign target and purge preserves both sources on that ambiguity', t => {
  const { root, add } = fixture(t);
  const item = add('Managed foreign ownership observation');
  const dest = `6-raw/inbox/archive/${item.id}.md`;
  fs.mkdirSync(path.join(root, '6-raw/inbox/archive'));
  fs.writeFileSync(path.join(root, dest), 'Foreign source content');
  registerSource(root, { path: dest });
  const before = ledgers(root);
  assert.throws(() => privacyModule.archiveManagedRaw(root, item.id, { apply: true }));
  assert.deepEqual(ledgers(root), before);
  expire(root, item.id);
  assert.equal(purgeRaw(root, { apply: true }).items[0].status, 'deletion_failed');
  assert.ok(fs.existsSync(path.join(root, item.path)));
  assert.equal(fs.readFileSync(path.join(root, dest), 'utf8'), 'Foreign source content');
});

test('managed archive CLI preserves an existing receipt and raw lifecycle state without another metric', t => {
  const { root, add } = fixture(t);
  const item = add('Managed CLI archive observation');
  registerLifecycleRecord(root, { sourceId: item.id, state: 'raw', actor: 'fixture', actorType: 'automation' });
  const owner = { runId: 'before-move', processor: 'reviewer', host: 'fixture', claimedPaths: [item.path] };
  claimInboxProcessing(root, owner);
  const completed = completeInboxProcessing(root, { ...owner, processed: [item.path] });
  assert.equal(completed.ok, true);
  const receiptBefore = fs.readFileSync(path.join(root, completed.receiptPath), 'utf8');
  const cli = fileURLToPath(new URL('../../cli/mole.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'privacy', 'archive', item.id, '--apply'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const destination = JSON.parse(result.stdout).path;
  assert.equal(listLifecycleRecords(root)[0].state, 'raw');
  assert.equal(check(root, item.id).source_id, item.id);
  const retry = { ...owner, runId: 'after-move', claimedPaths: [destination] };
  claimInboxProcessing(root, retry);
  assert.equal(completeInboxProcessing(root, { ...retry, processed: [destination] }).code, 'DUPLICATE_REVIEW_REQUIRED');
  assert.equal(fs.readFileSync(path.join(root, completed.receiptPath), 'utf8'), receiptBefore);
  assert.equal(collectMetricEvents(root).events.filter(e => e.category === 'processed_inputs').length, 1);
});
