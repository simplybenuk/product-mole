import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createWorkspaceScaffold } from '../../cli/mole.mjs';
import { captureNote } from '../../ui/server.mjs';
import { privacyInventory, purgeRaw, ingestPrivateCapture, reviewQuarantine } from '../privacy.mjs';
import { registerSource, resolveSource, readSourceRecord, reconcileSource } from '../source-registry.mjs';
import { registerLifecycleRecord, transitionLifecycleRecord, retrieveLifecycleRecords, retrieveLifecycleRecord, readLifecycleRecord } from '../review-lifecycle.mjs';
import { claimInboxProcessing, checkpointInboxProcessing, heartbeatInboxProcessing, completeInboxProcessing } from '../inbox-processing.mjs';
import { inspectInboxDuplicates } from '../inbox-duplicates.mjs';
import { summarizeMetrics } from '../metrics-summary.mjs';
import { addInputRequest, reviewInputQueue, closeInputRequest } from '../input-queue.mjs';

const cli = fileURLToPath(new URL('../../cli/mole.mjs', import.meta.url));
const agent = { actor: 'Fixture worker', actorType: 'agent' };
// Declarations simulate a person ONLY inside mkdtemp fixtures. Never real approval.
const human = { actor: 'Fixture reviewer', actorType: 'human', humanConfirmed: true };
function workspace(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mole-acceptance-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createWorkspaceScaffold(root);
  return root;
}
function run(root, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
}
function success(root, ...args) {
  const result = run(root, ...args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
function snapshot(root) {
  const entries = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name), relative = path.relative(root, absolute);
      const stat = fs.lstatSync(absolute);
      entries.push([relative, stat.mode, stat.mtimeMs, entry.isFile() ? createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') : null]);
      if (entry.isDirectory()) walk(absolute);
    }
  }
  walk(root);
  return entries;
}
function metric(root, key) {
  return summarizeMetrics(root).categories.find(category => category.key === key).counts.all_time;
}
function read(root, relative) { return fs.readFileSync(path.join(root, relative), 'utf8'); }

test('operational flow: capture, resume, review, queue, retry, validate and fixture purge', async t => {
  const root = workspace(t);
  assert.deepEqual(privacyInventory(root), []);
  assert.deepEqual(fs.readdirSync(path.join(root, '6-raw/inbox')), ['README.md']);
  success(root, 'doctor');
  const privateValue = ['fixture-person', 'example.invalid'].join('@');
  success(root, 'insight', `Export requests arrive weekly ${privateValue}`);
  const ui = await captureNote(root, { note: `Checkout requests need investigation ${privateValue}` });
  assert.equal(ui.status, 200);
  assert.equal(ui.payload.state, 'raw');
  const captures = privacyInventory(root);
  assert.equal(captures.length, 2);
  for (const item of captures) {
    assert.equal(item.outcome, 'redacted');
    assert.ok(!read(root, item.current_path).includes(privateValue));
  }
  assert.equal(retrieveLifecycleRecords(root).records.length, 0);
  const paths = captures.map(item => item.current_path);
  const owner = { runId: 'acceptance-run', processor: 'Fixture worker', host: os.hostname(), claimedPaths: paths };
  assert.equal(claimInboxProcessing(root, owner).ok, true);

  const outputPath = '4-context/acceptance.md';
  const output = '# Synthetic finding\n\nExport demand needs a bounded experiment.\n';
  fs.writeFileSync(path.join(root, outputPath), output);
  const source = registerSource(root, { path: outputPath });
  const draft = registerLifecycleRecord(root, { sourceId: source.source_id, state: 'draft', sourceIds: captures.map(item => item.source_id), ...agent });
  transitionLifecycleRecord(root, draft.record_id, { action: 'submit', reason: 'Fixture ready', ...agent });
  assert.throws(() => transitionLifecycleRecord(root, draft.record_id, { action: 'approve', reason: 'Fixture decision', ...agent, humanConfirmed: true }), error => error.code === 'HUMAN_REQUIRED');
  assert.throws(() => retrieveLifecycleRecord(root, draft.record_id), error => error.code === 'NOT_ELIGIBLE');
  assert.equal(metric(root, 'accepted_learnings'), 0);
  transitionLifecycleRecord(root, draft.record_id, { action: 'approve', reason: 'Synthetic review only', ...human });
  assert.equal(retrieveLifecycleRecord(root, draft.record_id).content, output);
  assert.deepEqual(retrieveLifecycleRecords(root).records.map(record => record.record_id), [draft.record_id]);

  const low = addInputRequest(root, { request: 'Choose chart labels', impact: 'Readability', unblocks: 'Chart polish', priority: 'low', ...agent });
  const urgent = addInputRequest(root, { request: 'Choose experiment owner', impact: 'Experiment cannot start', unblocks: 'Accepted experiment', priority: 'high', blocking: true, ...agent });
  assert.equal(reviewInputQueue(root).top[0].input_id, urgent.input_id);
  assert.throws(() => closeInputRequest(root, low.input_id, { closureReason: 'not_needed', outcome: 'Fixture decision', reason: 'Fixture', ...agent }));
  closeInputRequest(root, urgent.input_id, { answer: 'Fixture team', outcome: 'Experiment assigned', ...agent });
  assert.equal(reviewInputQueue(root).top[0].input_id, low.input_id);

  // Completion records an actual output and retrieval receipt before raw cleanup.
  fs.writeFileSync(path.join(root, 'governance/run-receipts/acceptance.md'), `Synthetic retrieval receipt\nAccepted record: ${draft.record_id}\nSources: ${captures.map(item => item.source_id).join(', ')}\n`);
  assert.equal(checkpointInboxProcessing(root, { ...owner, processed: [paths[0]] }).ok, true);
  // A fresh CLI process resumes the persisted owner rather than an in-memory run.
  success(root, 'inbox', 'heartbeat', '--run-id', owner.runId, '--processor', owner.processor);
  const resumed = claimInboxProcessing(root, owner);
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.lock.processed_paths, [paths[0]]);
  const completion = { ...owner, processed: paths, summary: 'Synthetic finding reviewed; receipt recorded' };
  assert.equal(completeInboxProcessing(root, completion).ok, true);
  const beforeRetry = snapshot(root);
  assert.equal(completeInboxProcessing(root, completion).idempotent, true);
  assert.deepEqual(snapshot(root), beforeRetry);
  assert.equal(metric(root, 'processed_inputs'), 2);
  assert.equal(metric(root, 'accepted_learnings'), 1);
  assert.equal(metric(root, 'reviewed_outputs'), 1);

  const beforeValidation = snapshot(root);
  const report = run(root, 'validate', '--format', 'json');
  assert.ok([0, 1].includes(report.status), report.stderr);
  assert.equal(JSON.parse(report.stdout).read_only, true);
  const textReport = run(root, 'validate');
  assert.ok([0, 1].includes(textReport.status), textReport.stderr);
  assert.deepEqual(snapshot(root), beforeValidation);

  const future = new Date(Date.now() + 8 * 86400000).toISOString();
  const beforePurge = snapshot(root);
  assert.equal(purgeRaw(root, { now: future }).items.length, 2);
  assert.deepEqual(snapshot(root), beforePurge);
  assert.ok(purgeRaw(root, { apply: true, now: future }).items.every(item => item.status === 'deleted'));
  for (const item of captures) {
    assert.equal(fs.existsSync(path.join(root, item.current_path)), false);
    assert.equal(readSourceRecord(root, item.source_id).source_id, item.source_id);
  }
  for (const tombstone of privacyInventory(root)) {
    assert.equal(tombstone.current_path, null);
    assert.equal(tombstone.retention_state, 'deleted');
    assert.ok(!('content_hash' in tombstone));
  }
  const ledgerText = JSON.stringify(snapshot(root).map(([name]) => name.endsWith('.json') && read(root, name)));
  assert.ok(!ledgerText.includes(privateValue));
  assert.equal(retrieveLifecycleRecord(root, draft.record_id).content, output);
  assert.equal(metric(root, 'processed_inputs'), 2);
});

test('ambiguity blocks completion without discarding either source or inflating activity', async t => {
  const root = workspace(t);
  const captured = await captureNote(root, { note: 'Synthetic recurring export request' });
  const rawPath = captured.payload.path;
  const owner = { runId: 'ambiguity-run', processor: 'Fixture worker', host: 'fixture', claimedPaths: [rawPath] };
  assert.equal(claimInboxProcessing(root, owner).ok, true);
  let before = snapshot(root);
  assert.equal(heartbeatInboxProcessing(root, { ...owner, processor: 'Other worker' }).code, 'FOREIGN_OWNER');
  assert.deepEqual(snapshot(root), before);
  const conflict = 'governance/inbox-processing (conflicted copy).lock.json';
  fs.copyFileSync(path.join(root, 'governance/inbox-processing.lock.json'), path.join(root, conflict));
  before = snapshot(root);
  assert.equal(completeInboxProcessing(root, { ...owner, processed: [rawPath] }).code, 'SYNC_CONFLICT');
  assert.deepEqual(snapshot(root), before);
  // No completed receipt means unavailable history, rather than a fabricated zero.
  assert.equal(metric(root, 'processed_inputs'), null);
  assert.equal(fs.existsSync(path.join(root, 'governance/run-receipts/inbox-processing', `${owner.runId}.json`)), false);
  // Remove ONLY the synthetic conflict injected by this test, then resume.
  fs.unlinkSync(path.join(root, conflict));
  assert.equal(completeInboxProcessing(root, { ...owner, processed: [rawPath] }).ok, true);
  const copy = await captureNote(root, { note: 'Synthetic recurring export request' });
  const second = { ...owner, runId: 'duplicate-run', claimedPaths: [copy.payload.path] };
  assert.equal(claimInboxProcessing(root, second).ok, true);
  before = snapshot(root);
  assert.equal(completeInboxProcessing(root, { ...second, processed: [copy.payload.path] }).code, 'DUPLICATE_REVIEW_REQUIRED');
  assert.deepEqual(snapshot(root), before);
  assert.equal(metric(root, 'processed_inputs'), 1);
  assert.ok(fs.existsSync(path.join(root, rawPath)));
  assert.ok(fs.existsSync(path.join(root, copy.payload.path)));
});

test('managed archive retains identity, duplicate protection, receipt history and purge coverage', async t => {
  const root = workspace(t);
  const { archiveManagedRaw } = await import('../privacy.mjs');
  assert.equal(typeof archiveManagedRaw, 'function', 'Committed #26 managed archive dependency is required');
  const capture = await captureNote(root, { note: 'Synthetic managed archive observation' });
  assert.equal(capture.status, 200);
  const id = capture.payload.source_id;
  const originalPath = capture.payload.path;
  const originalBytes = read(root, originalPath);
  const originalPrivacy = privacyInventory(root).find(item => item.source_id === id);
  const fingerprint = inspectInboxDuplicates(root, id).fingerprint;

  // Produce durable output and a receipt before completing and archiving the raw input.
  const evidencePath = '5-evidence/source-docs/managed-archive.md';
  fs.mkdirSync(path.dirname(path.join(root, evidencePath)), { recursive: true });
  fs.writeFileSync(path.join(root, evidencePath), '# Synthetic evidence\n\nAn archive observation needs human review.\n');
  const evidence = registerSource(root, { path: evidencePath });
  registerLifecycleRecord(root, { sourceId: evidence.source_id, sourceIds: [id], state: 'draft', ...agent });
  fs.writeFileSync(path.join(root, 'governance/run-receipts/managed-archive.md'), `Synthetic retrieval receipt\nDraft source: ${evidence.source_id}\nSupporting raw source: ${id}\n`);
  const owner = { runId: 'managed-archive-run', processor: 'Fixture worker', host: 'fixture', claimedPaths: [originalPath] };
  assert.equal(claimInboxProcessing(root, owner).ok, true);
  assert.equal(checkpointInboxProcessing(root, { ...owner, processed: [originalPath] }).ok, true);
  const completion = { ...owner, processed: [originalPath], summary: 'Synthetic draft and retrieval receipt recorded' };
  const done = completeInboxProcessing(root, completion);
  assert.equal(done.ok, true, done.message);
  const receiptBytes = read(root, done.receiptPath);
  const beforeDryRun = snapshot(root);
  archiveManagedRaw(root, id, { apply: false, recover: false });
  assert.deepEqual(snapshot(root), beforeDryRun);

  success(root, 'privacy', 'archive', id, '--apply');
  const archivedPath = `6-raw/inbox/archive/${id}.md`;
  assert.equal(fs.existsSync(path.join(root, originalPath)), false);
  assert.equal(read(root, archivedPath), originalBytes);
  const archivedPrivacy = privacyInventory(root).find(item => item.source_id === id);
  assert.equal(archivedPrivacy.current_path, archivedPath);
  assert.equal(archivedPrivacy.captured_at, originalPrivacy.captured_at);
  assert.equal(archivedPrivacy.expires_at, originalPrivacy.expires_at);
  const source = readSourceRecord(root, id);
  assert.equal(source.source_id, id);
  assert.equal(source.current_path, archivedPath);
  assert.ok(source.path_history.some(entry => entry.path === originalPath));
  assert.ok(source.path_history.some(entry => entry.path === archivedPath));
  assert.equal(resolveSource(root, id).path, archivedPath);
  assert.equal(inspectInboxDuplicates(root, id).fingerprint, fingerprint);
  assert.equal(readLifecycleRecord(root, capture.payload.record_id).state, 'raw');
  assert.equal(retrieveLifecycleRecords(root).records.length, 0, 'Archiving must not accept raw or draft content');
  const beforeRetry = snapshot(root);
  assert.equal(completeInboxProcessing(root, completion).idempotent, true);
  assert.deepEqual(snapshot(root), beforeRetry);
  assert.equal(read(root, done.receiptPath), receiptBytes);
  assert.equal(metric(root, 'processed_inputs'), 1);

  const copy = await captureNote(root, { note: 'Synthetic managed archive observation' });
  const duplicate = inspectInboxDuplicates(root, copy.payload.source_id);
  assert.ok(duplicate.candidates.some(candidate => candidate.source_id === id && candidate.match === 'exact'));
  const second = { ...owner, runId: 'managed-archive-copy-run', claimedPaths: [copy.payload.path] };
  assert.equal(claimInboxProcessing(root, second).ok, true);
  const beforeRefusal = snapshot(root);
  assert.equal(completeInboxProcessing(root, { ...second, processed: [copy.payload.path] }).code, 'DUPLICATE_REVIEW_REQUIRED');
  assert.deepEqual(snapshot(root), beforeRefusal);
  assert.equal(metric(root, 'processed_inputs'), 1);
  // End only this uncheckpointed synthetic claim so expiry can run without a lock.
  assert.equal(completeInboxProcessing(root, { ...second, processed: [], summary: 'Synthetic duplicate held for review' }).ok, true);

  const fingerprintPath = `governance/inbox-duplicates/records/${id}.json`;
  const fingerprintBytes = read(root, fingerprintPath);
  const future = new Date(Date.now() + 8 * 86400000).toISOString();
  const beforePurge = snapshot(root);
  const dryPurge = purgeRaw(root, { now: future });
  assert.ok(dryPurge.items.some(item => item.source_id === id && item.status === 'would_delete'));
  assert.deepEqual(snapshot(root), beforePurge);
  const purged = purgeRaw(root, { apply: true, now: future });
  assert.equal(purged.recovery_required, false);
  assert.ok(purged.items.some(item => item.source_id === id && item.status === 'deleted'));
  assert.equal(fs.existsSync(path.join(root, archivedPath)), false);
  const tombstone = privacyInventory(root).find(item => item.source_id === id);
  assert.equal(tombstone.retention_state, 'deleted');
  assert.equal(tombstone.current_path, null);
  assert.equal(tombstone.expires_at, originalPrivacy.expires_at);
  assert.equal(readSourceRecord(root, id).source_id, id);
  assert.equal(read(root, fingerprintPath), fingerprintBytes);
  assert.equal(read(root, done.receiptPath), receiptBytes);
  assert.equal(metric(root, 'processed_inputs'), 1);
  const retainedMetadata = snapshot(root).filter(([name]) => name.endsWith('.json')).map(([name]) => read(root, name)).join('\n');
  assert.ok(!retainedMetadata.includes('Synthetic managed archive observation'));
  const afterPurge = snapshot(root);
  assert.equal(completeInboxProcessing(root, completion).idempotent, true);
  assert.deepEqual(snapshot(root), afterPurge);
});

test('unmanaged archive discovery requires canonical restoration or reviewed release', t => {
  const root = workspace(t);
  const captured = ingestPrivateCapture(root, { content: 'Synthetic archive observation' });
  const id = captured.record.source_id;
  registerSource(root, { source_id: id, path: captured.path });
  const fingerprint = inspectInboxDuplicates(root, id).fingerprint;
  const archive = `6-raw/archive/${id}.md`;
  fs.mkdirSync(path.dirname(path.join(root, archive)), { recursive: true });
  fs.renameSync(path.join(root, captured.path), path.join(root, archive));
  assert.equal(resolveSource(root, id).path, archive);
  reconcileSource(root, id, archive);
  const before = snapshot(root);
  assert.throws(() => inspectInboxDuplicates(root, id), /Privacy|privacy/);
  const blockedPurge = purgeRaw(root, { apply: true, now: new Date(Date.now() + 8 * 86400000) });
  assert.equal(blockedPurge.recovery_required, true);
  assert.deepEqual(snapshot(root), before);
  // Canonical restoration retains identity and expiry. Manual arbitrary paths remain unsupported.
  fs.renameSync(path.join(root, archive), path.join(root, captured.path));
  reconcileSource(root, id, captured.path);
  assert.equal(inspectInboxDuplicates(root, id).fingerprint, fingerprint);
  assert.equal(privacyInventory(root)[0].expires_at, captured.record.expires_at);
  const uncertain = ingestPrivateCapture(root, { content: 'Synthetic unknown token' });
  fs.writeFileSync(path.join(root, `6-raw/quarantine/${uncertain.record.source_id}.md`), 'Reviewed synthetic observation');
  reviewQuarantine(root, uncertain.record.source_id, { apply: true, confirmReviewed: true });
  assert.equal(inspectInboxDuplicates(root, uncertain.record.source_id).source_id, uncertain.record.source_id);
  assert.equal(retrieveLifecycleRecords(root).records.length, 0);
});

test('validation finds operational damage in text and JSON without repairing fixture files', t => {
  const root = workspace(t);
  const sourceId = 'src_00000000-0000-4000-8000-000000000001';
  fs.writeFileSync(path.join(root, '4-context/damaged.md'), `---\nconfidence: impossible\nsource_refs: [${sourceId}]\n---\n\n[Missing](missing-acceptance-target.md)\n`);
  fs.writeFileSync(path.join(root, '2-summaries/stale.md'), '---\ntitle: Fixture\nsummary: Synthetic stale summary\nlast_updated: 2000-01-01\n---\n\nOld synthetic summary\n');
  fs.writeFileSync(path.join(root, 'governance/inbox-processing.lock.json'), '{broken');
  addInputRequest(root, { request: 'Choose a fixture date', impact: 'Schedule blocked', unblocks: 'Experiment', due: '2000-01-01', ...agent });
  const before = snapshot(root);
  const json = run(root, 'validate', '--format', 'json');
  assert.equal(json.status, 1, json.stderr);
  const report = JSON.parse(json.stdout);
  const codes = report.findings.map(finding => finding.code);
  for (const code of ['METADATA_MISSING', 'METADATA_INVALID', 'SOURCE_REF_BROKEN', 'INBOX_INVALID_LOCK', 'SUMMARY_STALE', 'INPUT_QUEUE_STALE']) {
    assert.ok(codes.includes(code), `${code} missing from ${codes}`);
  }
  const text = run(root, 'validate');
  assert.equal(text.status, 1, text.stderr);
  assert.match(text.stdout, /SOURCE_REF_BROKEN/);
  assert.deepEqual(snapshot(root), before);
  success(root, 'critique', 'idea');
  assert.deepEqual(snapshot(root), before);
});
