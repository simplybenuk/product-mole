import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getInboxMutationProcessIdentity } from '../inbox-processing.mjs';
import {
  ACTOR_TYPES,
  INITIAL_LIFECYCLE_STATES,
  LIFECYCLE_ACTIONS,
  LIFECYCLE_LEDGER_REL_PATH,
  LIFECYCLE_STATES,
  LIFECYCLE_TRANSITIONS,
  LifecycleError,
  auditLifecycle,
  listLifecycleRecords,
  migrateLifecycleRecords,
  readLifecycleRecord,
  registerLifecycleRecord,
  retrieveLifecycleRecord,
  retrieveLifecycleRecords,
  transitionLifecycleRecord,
  unlockLifecycle,
  validateLifecycleLedger
} from '../review-lifecycle.mjs';
import { readSourceRecord, registerSource, resolveSource } from '../source-registry.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const lifecycleModuleUrl = pathToFileURL(path.join(repoRoot, 'lib', 'review-lifecycle.mjs')).href;

const AGENT = { actor: 'Drafting Agent', actorType: 'agent' };
const HUMAN = { actor: 'Sam Reviewer', actorType: 'human', humanConfirmed: true };

let clock = Date.parse('2026-10-01T09:00:00.000Z');
function tick() {
  clock += 1000;
  return new Date(clock).toISOString();
}

function withWorkspace(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-lifecycle-'));
  for (const dir of ['2-summaries', '3-indexes', '4-context', '5-evidence', path.join('6-raw', 'inbox')]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  const cleanup = () => {
    fs.rmSync(lockPathFor(root), { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    const result = callback(root);
    if (result && typeof result.then === 'function') return result.finally(cleanup);
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

function lockPathFor(root) {
  const real = fs.realpathSync.native(root);
  const key = createHash('sha256').update(path.join(real, LIFECYCLE_LEDGER_REL_PATH)).digest('hex');
  return path.join(os.tmpdir(), `mole-lifecycle-${key}.lock.json`);
}

function ledgerPath(root) {
  return path.join(root, LIFECYCLE_LEDGER_REL_PATH);
}

function readLedger(root) {
  return JSON.parse(fs.readFileSync(ledgerPath(root), 'utf8'));
}

function writeFile(root, relative, content) {
  const absolute = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  return absolute;
}

function addSource(root, relative, content = `content of ${relative}\n`) {
  writeFile(root, relative, content);
  return registerSource(root, { path: relative, capturedAt: tick(), capturedBy: 'test', channel: 'test' }).source_id;
}

function register(root, sourceId, state = 'draft', extra = {}) {
  return registerLifecycleRecord(root, { sourceId, state, ...AGENT, now: tick(), ...extra }).record_id;
}

function transition(root, recordId, action, options = {}) {
  return transitionLifecycleRecord(root, recordId, {
    action,
    ...AGENT,
    reason: `${action} in test`,
    now: tick(),
    ...options
  });
}

/** A draft at `relative` with one registered evidence source to cite. */
function draftWithEvidence(root, relative = '4-context/pricing.md') {
  const evidenceId = addSource(root, `5-evidence/${path.basename(relative)}`);
  const sourceId = addSource(root, relative);
  const recordId = register(root, sourceId, 'draft', { sourceIds: [evidenceId] });
  return { evidenceId, sourceId, recordId, relative };
}

function accepted(root, relative) {
  const draft = draftWithEvidence(root, relative);
  transition(root, draft.recordId, 'submit');
  transition(root, draft.recordId, 'approve', HUMAN);
  return draft;
}

function assertRefused(callback, code) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof LifecycleError, `expected a LifecycleError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

describe('review lifecycle transitions', () => {
  it('walks raw material through evidence, draft, review, and acceptance without touching the file', () => {
    withWorkspace((root) => {
      const evidenceId = addSource(root, '5-evidence/interviews.md');
      const absolute = writeFile(root, '6-raw/inbox/note.md', 'raw bytes\r\n');
      const sourceId = registerSource(root, { path: '6-raw/inbox/note.md', capturedAt: tick() }).source_id;
      const before = fs.readFileSync(absolute);

      const recordId = register(root, sourceId, 'raw');
      assert.match(recordId, /^rec_[0-9a-f-]{36}$/);
      transition(root, recordId, 'evidence');
      transition(root, recordId, 'draft');
      transition(root, recordId, 'submit', { sourceIds: [evidenceId] });
      const result = transition(root, recordId, 'approve', { ...HUMAN, reason: 'Matches the interviews' });

      assert.equal(result.state, 'accepted');
      assert.deepEqual(result.record.source_ids, [evidenceId]);
      assert.equal(result.record.decision.outcome, 'accepted');
      assert.equal(result.record.decision.reviewer, 'Sam Reviewer');
      assert.equal(result.record.decision.reason, 'Matches the interviews');
      assert.equal(result.record.decision.decided_at, result.record.updated_at);
      assert.deepEqual(result.record.history.map((entry) => entry.action), ['register', 'evidence', 'draft', 'submit', 'approve']);
      assert.deepEqual(result.record.history.map((entry) => entry.to_state), ['raw', 'evidence', 'draft', 'pending_review', 'accepted']);
      assert.equal(result.record.history[4].actor_type, 'human');
      assert.equal(result.record.history[4].human_confirmed, true);
      assert.equal(result.record.revision, 5);
      assert.deepEqual(fs.readFileSync(absolute), before);

      const ledger = readLedger(root);
      assert.equal(ledger.ledger_revision, 5);
      assert.deepEqual(validateLifecycleLedger(ledger), { valid: true, errors: [] });
      assert.deepEqual(readLifecycleRecord(root, recordId), result.record);
    });
  });

  it('never lets registration create a reviewed state', () => {
    withWorkspace((root) => {
      const sourceId = addSource(root, '4-context/a.md');
      for (const state of ['pending_review', 'accepted', 'rejected', 'superseded']) {
        assertRefused(() => register(root, sourceId, state, HUMAN), 'INVALID_INITIAL_STATE');
      }
      assertRefused(() => register(root, sourceId, 'approved'), 'INVALID_STATE');
      assert.equal(fs.existsSync(ledgerPath(root)), false);

      register(root, sourceId, 'draft');
      assertRefused(() => register(root, sourceId, 'draft'), 'RECORD_EXISTS');
      assertRefused(() => register(root, 'src_00000000-0000-4000-8000-000000000000'), 'SOURCE_NOT_AVAILABLE');
      assertRefused(() => register(root, 'not-an-id'), 'INVALID_SOURCE_ID');
    });
  });

  it('refuses every transition outside the table and leaves the ledger unchanged', () => {
    withWorkspace((root) => {
      const { recordId } = draftWithEvidence(root);
      const rawId = register(root, addSource(root, '6-raw/inbox/raw.md'), 'raw');
      const before = fs.readFileSync(ledgerPath(root));

      assertRefused(() => transition(root, recordId, 'approve', HUMAN), 'INVALID_TRANSITION');
      assertRefused(() => transition(root, recordId, 'reject', HUMAN), 'INVALID_TRANSITION');
      assertRefused(() => transition(root, recordId, 'evidence'), 'INVALID_TRANSITION');
      assertRefused(() => transition(root, recordId, 'revise'), 'INVALID_TRANSITION');
      assertRefused(() => transition(root, rawId, 'submit'), 'INVALID_TRANSITION');
      assertRefused(() => transition(root, recordId, 'publish'), 'INVALID_ACTION');
      assertRefused(() => transition(root, recordId, 'submit', { reason: '  ' }), 'REASON_REQUIRED');
      assertRefused(() => transition(root, recordId, 'submit', { actor: '' }), 'ACTOR_REQUIRED');
      assertRefused(() => transition(root, recordId, 'submit', { actorType: 'robot' }), 'INVALID_ACTOR_TYPE');
      assertRefused(() => transition(root, 'rec_00000000-0000-4000-8000-000000000000', 'submit'), 'RECORD_NOT_FOUND');
      assert.deepEqual(fs.readFileSync(ledgerPath(root)), before);

      transition(root, recordId, 'submit');
      transition(root, recordId, 'approve', HUMAN);
      for (const action of ['submit', 'revise', 'draft', 'evidence', 'reject', 'approve']) {
        assertRefused(() => transition(root, recordId, action, HUMAN), 'INVALID_TRANSITION');
      }
    });
  });

  it('exposes a transition table whose human-only actions are the review decisions', () => {
    assert.deepEqual(LIFECYCLE_ACTIONS, ['evidence', 'draft', 'submit', 'revise', 'approve', 'reject', 'supersede']);
    const human = LIFECYCLE_ACTIONS.filter((action) => LIFECYCLE_TRANSITIONS[action].human);
    assert.deepEqual(human, ['approve', 'reject', 'supersede']);
    assert.deepEqual(LIFECYCLE_TRANSITIONS.approve.from, ['pending_review']);
    assert.deepEqual(LIFECYCLE_TRANSITIONS.reject.from, ['pending_review']);
  });
});

describe('human review decisions', () => {
  it('keeps a record pending when an agent or unconfirmed human tries to decide', () => {
    withWorkspace((root) => {
      const { recordId } = draftWithEvidence(root);
      transition(root, recordId, 'submit');
      const before = fs.readFileSync(ledgerPath(root));

      for (const action of ['approve', 'reject']) {
        assertRefused(() => transition(root, recordId, action, { ...AGENT, humanConfirmed: true }), 'HUMAN_REQUIRED');
        assertRefused(() => transition(root, recordId, action, { actor: 'mole-cli', actorType: 'automation', humanConfirmed: true }), 'HUMAN_REQUIRED');
        assertRefused(() => transition(root, recordId, action, { actor: 'Sam Reviewer', actorType: 'human' }), 'HUMAN_CONFIRMATION_REQUIRED');
        assertRefused(() => transition(root, recordId, action, { actor: 'Sam Reviewer', actorType: 'human', humanConfirmed: 'yes' }), 'HUMAN_CONFIRMATION_REQUIRED');
      }

      assert.deepEqual(fs.readFileSync(ledgerPath(root)), before);
      assert.equal(readLifecycleRecord(root, recordId).state, 'pending_review');
      assert.equal(retrieveLifecycleRecords(root).records.length, 0);
    });
  });

  it('requires a registered supporting source other than the record itself', () => {
    withWorkspace((root) => {
      const sourceId = addSource(root, '4-context/unsupported.md');
      const evidenceId = addSource(root, '5-evidence/support.md');
      const recordId = register(root, sourceId);
      transition(root, recordId, 'submit');

      assertRefused(() => transition(root, recordId, 'approve', HUMAN), 'SUPPORTING_SOURCE_REQUIRED');
      assertRefused(() => transition(root, recordId, 'approve', { ...HUMAN, sourceIds: [sourceId] }), 'INVALID_SUPPORTING_SOURCE');
      assertRefused(() => transition(root, recordId, 'approve', {
        ...HUMAN,
        sourceIds: ['src_00000000-0000-4000-8000-000000000000']
      }), 'SUPPORTING_SOURCE_NOT_REGISTERED');
      assert.equal(readLifecycleRecord(root, recordId).state, 'pending_review');

      const result = transition(root, recordId, 'approve', { ...HUMAN, sourceIds: [evidenceId] });
      assert.deepEqual(result.record.source_ids, [evidenceId]);
      assert.deepEqual(result.record.history[2].source_ids, [evidenceId]);
    });
  });

  it('records a rejection and lets the draft be revised and resubmitted', () => {
    withWorkspace((root) => {
      const { recordId, relative } = draftWithEvidence(root);
      transition(root, recordId, 'submit');
      const rejected = transition(root, recordId, 'reject', { ...HUMAN, reason: 'Pricing data is missing' });
      assert.equal(rejected.state, 'rejected');
      assert.equal(rejected.record.decision.outcome, 'rejected');
      assert.equal(rejected.record.decision.reason, 'Pricing data is missing');
      assert.equal(retrieveLifecycleRecords(root).records.length, 0);
      assertRefused(() => retrieveLifecycleRecord(root, recordId), 'NOT_ELIGIBLE');
      assertRefused(() => transition(root, recordId, 'approve', HUMAN), 'INVALID_TRANSITION');

      const revised = transition(root, recordId, 'revise');
      assert.equal(revised.state, 'draft');
      assert.equal(revised.record.decision, null);
      writeFile(root, relative, 'now with pricing data\n');
      transition(root, recordId, 'submit');
      const approved = transition(root, recordId, 'approve', HUMAN);

      assert.deepEqual(
        approved.record.history.map((entry) => entry.action),
        ['register', 'submit', 'reject', 'revise', 'submit', 'approve']
      );
      assert.equal(approved.record.history[2].reason, 'Pricing data is missing');
      assert.equal(approved.record.decision.outcome, 'accepted');
    });
  });

  it('adds and removes supporting sources before review only', () => {
    withWorkspace((root) => {
      const { recordId, evidenceId } = draftWithEvidence(root);
      const otherId = addSource(root, '5-evidence/other.md');
      const submitted = transition(root, recordId, 'submit', { sourceIds: [otherId], removeSourceIds: [evidenceId] });
      assert.deepEqual(submitted.record.source_ids, [otherId]);
      assertRefused(() => transition(root, recordId, 'approve', { ...HUMAN, removeSourceIds: [otherId] }), 'INVALID_OPTION');
      assertRefused(() => transition(root, recordId, 'reject', { ...HUMAN, sourceIds: [evidenceId] }), 'INVALID_OPTION');
      assertRefused(() => transition(root, recordId, 'revise', { removeSourceIds: [evidenceId] }), 'INVALID_SUPPORTING_SOURCE');
    });
  });
});

describe('content binding and source provenance', () => {
  it('refuses approval when the file changed after submission', () => {
    withWorkspace((root) => {
      const { recordId, relative } = draftWithEvidence(root);
      transition(root, recordId, 'submit');
      writeFile(root, relative, 'edited after submission\n');

      assertRefused(() => transition(root, recordId, 'approve', HUMAN), 'CONTENT_CHANGED');
      assert.equal(readLifecycleRecord(root, recordId).state, 'pending_review');
      assertRefused(() => retrieveLifecycleRecord(root, recordId, { includeStates: ['pending_review'] }), 'CONTENT_CHANGED');
      assert.equal(auditLifecycle(root).findings[0].type, 'pending_content_changed');

      transition(root, recordId, 'revise');
      transition(root, recordId, 'submit');
      assert.equal(transition(root, recordId, 'approve', HUMAN).state, 'accepted');
      assert.equal(auditLifecycle(root).ok, true);
    });
  });

  it('drops changed accepted content from retrieval and reports it', () => {
    withWorkspace((root) => {
      const { recordId, relative } = accepted(root, '4-context/strategy.md');
      assert.equal(retrieveLifecycleRecords(root).records.length, 1);
      assert.equal(retrieveLifecycleRecord(root, recordId).content, 'content of 4-context/strategy.md\n');

      writeFile(root, relative, 'silently rewritten\n');
      const listing = retrieveLifecycleRecords(root);
      assert.equal(listing.records.length, 0);
      assert.deepEqual(listing.excluded.map((item) => [item.record_id, item.reason]), [[recordId, 'content_changed']]);
      assertRefused(() => retrieveLifecycleRecord(root, recordId), 'CONTENT_CHANGED');

      const audit = auditLifecycle(root);
      assert.equal(audit.ok, false);
      assert.deepEqual(audit.findings.map((item) => item.type), ['accepted_content_changed']);
      assert.equal(audit.findings[0].record_id, recordId);
      assert.equal(readLifecycleRecord(root, recordId).state, 'accepted');

      writeFile(root, relative, 'content of 4-context/strategy.md\n');
      assert.equal(retrieveLifecycleRecords(root).records.length, 1);
      assert.equal(auditLifecycle(root).ok, true);
    });
  });

  it('records an edited draft as a source correction so a later move still resolves', () => {
    withWorkspace((root) => {
      const { recordId, sourceId, relative } = draftWithEvidence(root, '4-context/roadmap.md');
      const absolute = writeFile(root, relative, 'edited before submission\n');
      const bytes = fs.readFileSync(absolute);

      const submitted = transition(root, recordId, 'submit', { reason: 'Ready for review' });
      assert.equal(submitted.source_correction, true);
      const source = readSourceRecord(root, sourceId);
      assert.equal(source.content_hash.value, submitted.record.content_hash.value);
      assert.equal(source.content_history.length, 2);
      assert.equal(source.content_history[1].change_type, 'corrected');
      assert.match(source.content_history[1].reason, /Lifecycle submission .* by Drafting Agent: Ready for review/);
      assert.deepEqual(fs.readFileSync(absolute), bytes);

      transition(root, recordId, 'approve', HUMAN);
      fs.mkdirSync(path.join(root, '4-context', 'archive'));
      fs.renameSync(absolute, path.join(root, '4-context', 'archive', 'roadmap.md'));

      assert.equal(resolveSource(root, sourceId).path, '4-context/archive/roadmap.md');
      const retrieved = retrieveLifecycleRecord(root, recordId);
      assert.equal(retrieved.path, '4-context/archive/roadmap.md');
      assert.equal(retrieved.content, 'edited before submission\n');
      assert.equal(retrieveLifecycleRecords(root).records[0].path, '4-context/archive/roadmap.md');
      assert.equal(auditLifecycle(root).ok, true);

      fs.rmSync(path.join(root, '4-context', 'archive', 'roadmap.md'));
      assert.deepEqual(retrieveLifecycleRecords(root).excluded.map((item) => item.reason), ['source_unresolved']);
      assert.deepEqual(auditLifecycle(root).findings.map((item) => item.type), ['source_unresolved']);
    });
  });

  it('does not correct the registry when the submitted bytes are already registered', () => {
    withWorkspace((root) => {
      const { recordId, sourceId } = draftWithEvidence(root);
      assert.equal(transition(root, recordId, 'submit').source_correction, false);
      assert.equal(readSourceRecord(root, sourceId).content_history.length, 1);
    });
  });

  it('reports a file that is replaced by a link leaving the workspace', () => {
    withWorkspace((root) => {
      const { recordId, relative } = accepted(root, '4-context/linked.md');
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-lifecycle-outside-'));
      try {
        fs.writeFileSync(path.join(outside, 'secret.md'), 'content of 4-context/linked.md\n');
        fs.rmSync(path.join(root, relative));
        fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, relative));

        // The registry rejects a record whose path now escapes the workspace.
        assert.deepEqual(retrieveLifecycleRecords(root).records, []);
        assert.deepEqual(retrieveLifecycleRecords(root).excluded.map((item) => item.reason), ['source_record_invalid']);
        assertRefused(() => retrieveLifecycleRecord(root, recordId), 'SOURCE_NOT_AVAILABLE');
        assert.deepEqual(auditLifecycle(root).findings.map((item) => item.type), ['source_record_invalid']);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });
});

describe('supersession', () => {
  it('accepts a replacement and supersedes its predecessor in one ledger write', () => {
    withWorkspace((root) => {
      const old = accepted(root, '4-context/pricing-q3.md');
      const next = draftWithEvidence(root, '4-context/pricing-q4.md');
      transition(root, next.recordId, 'submit');
      const revisionBefore = readLedger(root).ledger_revision;
      const oldHistory = readLifecycleRecord(root, old.recordId).history;

      const result = transition(root, next.recordId, 'approve', {
        ...HUMAN,
        reason: 'Q4 pricing replaces Q3',
        supersedes: [old.recordId]
      });

      assert.deepEqual(result.changed_record_ids, [next.recordId, old.recordId]);
      assert.equal(readLedger(root).ledger_revision, revisionBefore + 1);
      const replacement = readLifecycleRecord(root, next.recordId);
      const superseded = readLifecycleRecord(root, old.recordId);
      assert.equal(replacement.state, 'accepted');
      assert.deepEqual(replacement.supersedes, [old.recordId]);
      assert.deepEqual(replacement.history.at(-1).related_record_ids, [old.recordId]);
      assert.equal(superseded.state, 'superseded');
      assert.equal(superseded.superseded_by, next.recordId);
      assert.equal(superseded.decision.outcome, 'accepted');
      assert.deepEqual(superseded.history.slice(0, oldHistory.length), oldHistory);
      assert.equal(superseded.history.at(-1).action, 'supersede');
      assert.equal(superseded.history.at(-1).reason, 'Q4 pricing replaces Q3');
      assert.deepEqual(superseded.history.at(-1).related_record_ids, [next.recordId]);

      assert.deepEqual(retrieveLifecycleRecords(root).records.map((record) => record.record_id), [next.recordId]);
      assertRefused(() => retrieveLifecycleRecord(root, old.recordId), 'NOT_ELIGIBLE');
      assert.equal(retrieveLifecycleRecord(root, old.recordId, { includeStates: ['superseded'] }).record.state, 'superseded');
      assert.equal(auditLifecycle(root).ok, true);
    });
  });

  it('refuses invalid predecessors and writes nothing', () => {
    withWorkspace((root) => {
      const old = accepted(root, '4-context/old.md');
      const draft = draftWithEvidence(root, '4-context/still-draft.md');
      const next = draftWithEvidence(root, '4-context/new.md');
      transition(root, next.recordId, 'submit');
      const before = fs.readFileSync(ledgerPath(root));

      for (const supersedes of [
        [draft.recordId],
        [next.recordId],
        ['rec_00000000-0000-4000-8000-000000000000'],
        [old.recordId, draft.recordId]
      ]) {
        assertRefused(() => transition(root, next.recordId, 'approve', { ...HUMAN, supersedes }), 'INVALID_SUPERSESSION');
      }
      assertRefused(() => transition(root, next.recordId, 'approve', { ...HUMAN, supersedes: ['nope'] }), 'INVALID_RECORD_ID');
      assertRefused(() => transition(root, next.recordId, 'submit', { supersedes: [old.recordId] }), 'INVALID_OPTION');
      assertRefused(() => transition(root, next.recordId, 'approve', { ...AGENT, supersedes: [old.recordId] }), 'HUMAN_REQUIRED');

      assert.deepEqual(fs.readFileSync(ledgerPath(root)), before);
      assert.equal(readLifecycleRecord(root, old.recordId).state, 'accepted');
    });
  });

  it('links two accepted records with an explicit human supersede', () => {
    withWorkspace((root) => {
      const old = accepted(root, '4-context/first.md');
      const next = accepted(root, '4-context/second.md');
      const draft = draftWithEvidence(root, '4-context/third.md');

      assertRefused(() => transition(root, old.recordId, 'supersede', HUMAN), 'INVALID_OPTION');
      assertRefused(() => transition(root, old.recordId, 'supersede', { ...HUMAN, replacementId: old.recordId }), 'INVALID_SUPERSESSION');
      assertRefused(() => transition(root, old.recordId, 'supersede', { ...HUMAN, replacementId: draft.recordId }), 'INVALID_SUPERSESSION');
      assertRefused(() => transition(root, old.recordId, 'supersede', { ...AGENT, replacementId: next.recordId }), 'HUMAN_REQUIRED');
      assertRefused(() => transition(root, draft.recordId, 'supersede', { ...HUMAN, replacementId: next.recordId }), 'INVALID_TRANSITION');

      const result = transition(root, old.recordId, 'supersede', { ...HUMAN, replacementId: next.recordId });
      assert.deepEqual(result.changed_record_ids, [old.recordId, next.recordId]);
      const replacement = readLifecycleRecord(root, next.recordId);
      assert.equal(replacement.state, 'accepted');
      assert.deepEqual(replacement.supersedes, [old.recordId]);
      assert.equal(replacement.history.at(-1).action, 'replace');
      assert.equal(readLifecycleRecord(root, old.recordId).superseded_by, next.recordId);
      assertRefused(() => transition(root, old.recordId, 'supersede', { ...HUMAN, replacementId: next.recordId }), 'INVALID_TRANSITION');
      assert.deepEqual(validateLifecycleLedger(readLedger(root)), { valid: true, errors: [] });
    });
  });
});

describe('retrieval eligibility', () => {
  it('returns accepted records by default and other states only on request', () => {
    withWorkspace((root) => {
      const approved = accepted(root, '4-context/approved.md');
      const pending = draftWithEvidence(root, '4-context/pending.md');
      transition(root, pending.recordId, 'submit');
      const rejected = draftWithEvidence(root, '4-context/rejected.md');
      transition(root, rejected.recordId, 'submit');
      transition(root, rejected.recordId, 'reject', HUMAN);
      const draft = draftWithEvidence(root, '4-context/draft.md');
      const raw = register(root, addSource(root, '6-raw/inbox/raw.md'), 'raw');

      const normal = retrieveLifecycleRecords(root);
      assert.deepEqual(normal.include_states, ['accepted']);
      assert.deepEqual(normal.records.map((record) => record.record_id), [approved.recordId]);
      assert.equal(normal.records[0].decision.reviewer, 'Sam Reviewer');
      assert.deepEqual(normal.records[0].source_ids, [approved.evidenceId]);
      assert.equal(normal.state_counts.pending_review, 1);
      assert.equal(normal.state_counts.rejected, 1);
      assert.equal(normal.state_counts.draft, 1);
      assert.equal(normal.state_counts.raw, 1);

      for (const recordId of [pending.recordId, rejected.recordId, draft.recordId, raw]) {
        assertRefused(() => retrieveLifecycleRecord(root, recordId), 'NOT_ELIGIBLE');
      }
      assertRefused(() => retrieveLifecycleRecord(root, pending.recordId, { includeStates: ['draft'] }), 'NOT_ELIGIBLE');
      assertRefused(() => retrieveLifecycleRecords(root, { includeStates: ['approved'] }), 'INVALID_STATE');

      const review = retrieveLifecycleRecords(root, { includeStates: ['pending_review', 'draft'] });
      assert.deepEqual(review.include_states, ['accepted', 'pending_review', 'draft']);
      assert.deepEqual(
        review.records.map((record) => record.record_id).sort(),
        [approved.recordId, pending.recordId, draft.recordId].sort()
      );
      const single = retrieveLifecycleRecord(root, pending.recordId, { includeStates: ['pending_review'] });
      assert.equal(single.record.state, 'pending_review');
      assert.equal(single.path, '4-context/pending.md');
      assert.equal(single.content_encoding, 'utf8');

      assert.equal(listLifecycleRecords(root).length, 5);
      assert.deepEqual(listLifecycleRecords(root, { states: ['rejected'] }).map((record) => record.record_id), [rejected.recordId]);
    });
  });

  it('returns binary files by path instead of decoding them', () => {
    withWorkspace((root) => {
      const evidenceId = addSource(root, '5-evidence/notes.md');
      writeFile(root, '4-context/chart.bin', Buffer.from([0x00, 0xff, 0x10]));
      const sourceId = registerSource(root, { path: '4-context/chart.bin', capturedAt: tick() }).source_id;
      const recordId = register(root, sourceId, 'draft', { sourceIds: [evidenceId] });
      transition(root, recordId, 'submit');
      transition(root, recordId, 'approve', HUMAN);
      const result = retrieveLifecycleRecord(root, recordId);
      assert.equal(result.content, null);
      assert.equal(result.content_encoding, 'binary');
      assert.equal(result.path, '4-context/chart.bin');
    });
  });
});

describe('migration of existing workspaces', () => {
  const activeSummary = '---\ntitle: Product summary\nstatus: active\n---\n\nApproved by the product lead on 2026-05-01.\n';

  it('reports untracked files without changing anything by default', () => {
    withWorkspace((root) => {
      writeFile(root, '2-summaries/product-summary.md', activeSummary);
      writeFile(root, '4-context/README.md', '# Guidance\n');
      writeFile(root, '5-evidence/source-docs/export.csv', 'a,b\n');
      writeFile(root, '6-raw/inbox/raw.md', 'raw\n');

      const result = migrateLifecycleRecords(root);
      assert.equal(result.apply, false);
      assert.equal(result.ok, true);
      assert.deepEqual(result.candidates.map((item) => item.path), ['2-summaries/product-summary.md', '5-evidence/source-docs/export.csv']);
      assert.equal(result.candidates[0].legacy_status, 'active');
      assert.equal(result.candidates[0].proposed_state, 'unreviewed');
      assert.deepEqual(result.skipped, [{ path: '4-context/README.md', reason: 'guidance_file' }]);
      assert.deepEqual(result.registered, []);
      assert.equal(fs.existsSync(ledgerPath(root)), false);
      assert.equal(fs.existsSync(path.join(root, 'governance')), false);
    });
  });

  it('registers legacy files as unreviewed even when they claim approval', () => {
    withWorkspace((root) => {
      const absolute = writeFile(root, '2-summaries/product-summary.md', activeSummary);
      const evidenceId = addSource(root, '5-evidence/known.md');
      assertRefused(() => migrateLifecycleRecords(root, { apply: true }), 'ACTOR_REQUIRED');

      const result = migrateLifecycleRecords(root, { apply: true, ...AGENT, now: tick() });
      assert.equal(result.ok, true);
      assert.deepEqual(result.registered.map((item) => [item.path, item.state]), [
        ['2-summaries/product-summary.md', 'unreviewed'],
        ['5-evidence/known.md', 'unreviewed']
      ]);
      assert.equal(result.registered[1].source_id, evidenceId);
      assert.equal(fs.readFileSync(absolute, 'utf8'), activeSummary);

      const records = listLifecycleRecords(root);
      assert.deepEqual(records.map((record) => record.state), ['unreviewed', 'unreviewed']);
      assert.ok(records.every((record) => record.decision === null));
      assert.match(records[0].history[0].reason, /frontmatter status "active" is not an approval/);
      assert.equal(retrieveLifecycleRecords(root).records.length, 0);
      assertRefused(() => retrieveLifecycleRecord(root, records[0].record_id), 'NOT_ELIGIBLE');

      const again = migrateLifecycleRecords(root, { apply: true, ...AGENT, now: tick() });
      assert.equal(again.tracked, 2);
      assert.deepEqual(again.candidates, []);
      assert.deepEqual(again.registered, []);
      assert.equal(listLifecycleRecords(root).length, 2);
    });
  });

  it('accepts a migrated file only through submission and a human decision', () => {
    withWorkspace((root) => {
      writeFile(root, '2-summaries/product-summary.md', activeSummary);
      const evidenceId = addSource(root, '5-evidence/known.md');
      const result = migrateLifecycleRecords(root, { apply: true, ...HUMAN, now: tick() });
      const recordId = result.registered[0].record_id;

      assertRefused(() => transition(root, recordId, 'approve', { ...HUMAN, sourceIds: [evidenceId] }), 'INVALID_TRANSITION');
      transition(root, recordId, 'submit', { sourceIds: [evidenceId] });
      assertRefused(() => transition(root, recordId, 'approve', AGENT), 'HUMAN_REQUIRED');
      assert.equal(transition(root, recordId, 'approve', HUMAN).state, 'accepted');
    });
  });

  it('skips a file whose frontmatter names a source the registry places elsewhere', () => {
    withWorkspace((root) => {
      writeFile(root, '4-context/moved.md', '---\nsource_id: src_8d31cc34-c04c-41ac-82e3-75518bb5a7e0\nstatus: active\n---\nbody\n');
      const result = migrateLifecycleRecords(root, { apply: true, ...AGENT, now: tick() });
      assert.equal(result.ok, false);
      assert.deepEqual(result.registered, []);
      assert.deepEqual(result.skipped, [{ path: '4-context/moved.md', reason: 'source_id_mismatch' }]);
      assert.equal(result.findings[0].type, 'source_id_mismatch');
      assert.equal(fs.existsSync(ledgerPath(root)), false);
    });
  });
});

describe('ledger integrity and recovery', () => {
  function validLedger(root) {
    const old = accepted(root, '4-context/one.md');
    const next = draftWithEvidence(root, '4-context/two.md');
    transition(root, next.recordId, 'submit');
    transition(root, next.recordId, 'approve', { ...HUMAN, supersedes: [old.recordId] });
    return readLedger(root);
  }

  function errorsAfter(ledger, mutate) {
    const copy = structuredClone(ledger);
    mutate(copy);
    return validateLifecycleLedger(copy).errors.join('\n');
  }

  it('rejects ledgers whose state, history, or links were edited by hand', () => {
    withWorkspace((root) => {
      const ledger = validLedger(root);
      assert.equal(validateLifecycleLedger(ledger).valid, true);
      const accepting = ledger.records.findIndex((record) => record.state === 'accepted');
      const superseded = ledger.records.findIndex((record) => record.state === 'superseded');

      assert.match(errorsAfter(ledger, (copy) => { copy.records[accepting].history.pop(); }), /state must equal the latest history to_state/);
      assert.match(errorsAfter(ledger, (copy) => { copy.records[accepting].history.splice(1, 1); }), /revision must equal 2/);
      assert.match(errorsAfter(ledger, (copy) => { copy.records[accepting].history.at(-1).actor_type = 'agent'; }), /without a confirmed human actor/);
      assert.match(errorsAfter(ledger, (copy) => { copy.records[accepting].history.at(-1).human_confirmed = false; }), /without a confirmed human actor/);
      assert.match(errorsAfter(ledger, (copy) => { copy.records[accepting].decision.reviewer = 'Someone Else'; }), /decision must match the latest approve entry/);
      assert.match(errorsAfter(ledger, (copy) => { copy.records[accepting].decision = null; }), /decision must be an object/);
      assert.match(errorsAfter(ledger, (copy) => { copy.records[accepting].source_ids = []; }), /without a supporting source ID/);
      assert.match(errorsAfter(ledger, (copy) => { copy.records[accepting].supersedes = []; }), /is not reciprocated/);
      assert.match(errorsAfter(ledger, (copy) => { copy.records[superseded].superseded_by = null; }), /superseded_by must be set only while the record is superseded/);
      assert.match(errorsAfter(ledger, (copy) => { copy.records[accepting].history[0].to_state = 'accepted'; }), /registration cannot create accepted/);
      assert.match(errorsAfter(ledger, (copy) => { copy.records[accepting].history[1].from_state = 'raw'; }), /not a valid submit transition/);
      assert.match(errorsAfter(ledger, (copy) => { copy.records[accepting].approved = true; }), /approved is not allowed/);
      assert.match(errorsAfter(ledger, (copy) => { copy.records.push(structuredClone(copy.records[accepting])); }), /record_id is duplicated/);
      assert.match(errorsAfter(ledger, (copy) => { copy.records[accepting].path = '../outside.md'; }), /normalized workspace-relative path/);
      assert.match(errorsAfter(ledger, (copy) => { delete copy.ledger_revision; }), /ledger_revision is required/);
    });
  });

  it('fails closed on a malformed ledger while the audit stays readable', () => {
    withWorkspace((root) => {
      const { recordId } = accepted(root, '4-context/one.md');
      const sourceId = addSource(root, '4-context/two.md');
      const good = fs.readFileSync(ledgerPath(root), 'utf8');

      for (const damaged of [
        '{ not json',
        '[]',
        good.replace('"state": "accepted"', '"state": "draft"'),
        good.replace(/"actor_type": "human"/, '"actor_type": "agent"')
      ]) {
        fs.writeFileSync(ledgerPath(root), damaged);
        assertRefused(() => register(root, sourceId), 'INVALID_LEDGER');
        assertRefused(() => transition(root, recordId, 'supersede', { ...HUMAN, replacementId: recordId }), 'INVALID_LEDGER');
        assertRefused(() => retrieveLifecycleRecords(root), 'INVALID_LEDGER');
        assertRefused(() => retrieveLifecycleRecord(root, recordId), 'INVALID_LEDGER');
        assertRefused(() => listLifecycleRecords(root), 'INVALID_LEDGER');
        assertRefused(() => migrateLifecycleRecords(root), 'INVALID_LEDGER');
        const audit = auditLifecycle(root);
        assert.equal(audit.ok, false);
        assert.equal(audit.findings[0].type, 'invalid_ledger');
        assert.equal(fs.readFileSync(ledgerPath(root), 'utf8'), damaged);
      }

      fs.writeFileSync(ledgerPath(root), good);
      assert.equal(auditLifecycle(root).ok, true);
      assert.equal(retrieveLifecycleRecords(root).records.length, 1);
    });
  });

  it('refuses to write or retrieve while a sync conflict copy exists', () => {
    withWorkspace((root) => {
      const { recordId } = accepted(root, '4-context/one.md');
      const sourceId = addSource(root, '4-context/two.md');
      const before = fs.readFileSync(ledgerPath(root));

      for (const name of ["records (Sam's conflicted copy 2026-10-02).json", 'records.sync-conflict-20261002-101500-ABCDEFG.json', 'records-LAPTOP.json']) {
        const copy = path.join(path.dirname(ledgerPath(root)), name);
        fs.writeFileSync(copy, before);
        assertRefused(() => register(root, sourceId), 'LEDGER_CONFLICT');
        assertRefused(() => retrieveLifecycleRecord(root, recordId), 'LEDGER_CONFLICT');
        const audit = auditLifecycle(root);
        assert.deepEqual(audit.findings.map((item) => item.type), ['ledger_conflict_copy']);
        assert.equal(audit.record_count, 1);
        assert.ok(fs.existsSync(copy), 'the conflict copy must be preserved');
        fs.rmSync(copy);
      }

      assert.deepEqual(fs.readFileSync(ledgerPath(root)), before);
      assert.equal(register(root, sourceId).length, 40);
    });
  });

  it('reports an interrupted write and refuses a ledger folder that leaves the workspace', () => {
    withWorkspace((root) => {
      accepted(root, '4-context/one.md');
      const lifecycleDir = path.dirname(ledgerPath(root));
      fs.writeFileSync(path.join(lifecycleDir, '.records.json.0f0f0f0f-0000-4000-8000-000000000000.tmp'), '{');
      assert.deepEqual(auditLifecycle(root).findings.map((item) => item.type), ['stale_temp_file']);
      assert.equal(retrieveLifecycleRecords(root).records.length, 1);
    });

    withWorkspace((root) => {
      const sourceId = addSource(root, '4-context/one.md');
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-lifecycle-outside-'));
      try {
        fs.mkdirSync(path.join(root, 'governance'), { recursive: true });
        fs.symlinkSync(outside, path.join(root, 'governance', 'lifecycle'));
        assertRefused(() => register(root, sourceId), 'INVALID_LEDGER');
        assert.equal(auditLifecycle(root).findings[0].type, 'invalid_ledger');
        assert.deepEqual(fs.readdirSync(outside), []);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it('guards a decision against a record that moved on since it was read', () => {
    withWorkspace((root) => {
      const { recordId, relative } = draftWithEvidence(root);
      transition(root, recordId, 'submit');
      const reviewed = readLifecycleRecord(root, recordId).revision;
      transition(root, recordId, 'revise');
      writeFile(root, relative, 'different text the reviewer never saw\n');
      transition(root, recordId, 'submit');

      assertRefused(() => transition(root, recordId, 'approve', { ...HUMAN, expectedRevision: reviewed }), 'REVISION_CONFLICT');
      assert.equal(readLifecycleRecord(root, recordId).state, 'pending_review');
      assert.equal(transition(root, recordId, 'approve', { ...HUMAN, expectedRevision: 4 }).state, 'accepted');
    });
  });
});

describe('competing writers', () => {
  function holdLock(root, holder) {
    fs.writeFileSync(lockPathFor(root), `${JSON.stringify(holder, null, 2)}\n`, { flag: 'wx' });
  }

  it('refuses a mutation while another running process holds the lock', () => {
    withWorkspace((root) => {
      const sourceId = addSource(root, '4-context/one.md');
      holdLock(root, {
        token: 'other-operation',
        pid: process.pid,
        process_identity: getInboxMutationProcessIdentity(process.pid),
        acquired_at: new Date().toISOString()
      });

      assert.throws(() => register(root, sourceId, 'draft', { lockWaitMs: 0 }), (error) => {
        assert.equal(error.code, 'LIFECYCLE_BUSY');
        assert.equal(error.details.holder_alive, true);
        assert.equal(error.details.holder.token, 'other-operation');
        return true;
      });
      assert.equal(fs.existsSync(ledgerPath(root)), false);
      assertRefused(() => unlockLifecycle(root), 'LOCK_HELD');
      assert.equal(auditLifecycle(root).ok, true);
      assert.ok(fs.existsSync(lockPathFor(root)), 'a live lock must never be removed');

      fs.rmSync(lockPathFor(root));
      assert.equal(register(root, sourceId).length, 40);
      assert.equal(fs.existsSync(lockPathFor(root)), false);
    });
  });

  it('keeps a lock left by a stopped process until it is removed explicitly', () => {
    withWorkspace((root) => {
      const sourceId = addSource(root, '4-context/one.md');
      const stopped = spawnSync(process.execPath, ['-e', '']);
      holdLock(root, { token: 'crashed', pid: stopped.pid, process_identity: 'gone', acquired_at: new Date().toISOString() });

      assert.throws(() => register(root, sourceId, 'draft', { lockWaitMs: 0 }), (error) => {
        assert.equal(error.code, 'LIFECYCLE_BUSY');
        assert.equal(error.details.holder_alive, false);
        assert.match(error.message, /mole lifecycle unlock/);
        return true;
      });
      assert.ok(fs.existsSync(lockPathFor(root)), 'a mutation must not remove a stale lock by itself');
      assert.deepEqual(auditLifecycle(root).findings.map((item) => item.type), ['stale_mutation_lock']);

      const unlocked = unlockLifecycle(root);
      assert.equal(unlocked.removed, true);
      assert.equal(unlocked.holder.token, 'crashed');
      assert.deepEqual(unlockLifecycle(root), { ok: true, removed: false, holder: null });
      assert.equal(register(root, sourceId).length, 40);
    });
  });

  it('serialises simultaneous registrations from separate processes', async () => {
    await withWorkspace(async (root) => {
      const sourceIds = Array.from({ length: 6 }, (_, index) => addSource(root, `6-raw/inbox/note-${index}.md`));
      const script = `
        const { registerLifecycleRecord } = await import(${JSON.stringify(lifecycleModuleUrl)});
        registerLifecycleRecord(process.argv[1], {
          sourceId: process.argv[2], state: 'raw', actor: 'mole-cli', actorType: 'automation', lockWaitMs: 20000
        });
      `;
      const exits = await Promise.all(sourceIds.map((sourceId) => new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, sourceId], { stdio: 'ignore' });
        child.on('exit', resolve);
      })));

      assert.deepEqual(exits, [0, 0, 0, 0, 0, 0]);
      const ledger = readLedger(root);
      assert.equal(ledger.ledger_revision, 6);
      assert.deepEqual(ledger.records.map((record) => record.source_id).sort(), [...sourceIds].sort());
      assert.equal(validateLifecycleLedger(ledger).valid, true);
      assert.equal(fs.existsSync(lockPathFor(root)), false);
      assert.deepEqual(fs.readdirSync(path.dirname(ledgerPath(root))), ['records.json']);
    });
  });
});

describe('review lifecycle schema', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'schemas', 'review-lifecycle-v1.schema.json'), 'utf8'));

  it('matches the states, actors, and actions the library enforces', () => {
    assert.deepEqual(schema.$defs.state.enum, LIFECYCLE_STATES);
    assert.deepEqual(schema.$defs.initial_state.enum, INITIAL_LIFECYCLE_STATES);
    assert.deepEqual(schema.$defs.actor_type.enum, ACTOR_TYPES);
    assert.deepEqual(schema.$defs.action.enum, ['register', ...LIFECYCLE_ACTIONS, 'replace']);
    for (const state of ['raw', 'evidence', 'draft', 'pending_review', 'accepted', 'rejected', 'superseded']) {
      assert.ok(LIFECYCLE_STATES.includes(state), `${state} must be a lifecycle state`);
    }
  });

  it('requires exactly the fields a written ledger contains', () => {
    withWorkspace((root) => {
      accepted(root, '4-context/one.md');
      const ledger = readLedger(root);
      assert.deepEqual(Object.keys(ledger), schema.required);
      assert.deepEqual(Object.keys(ledger.records[0]), schema.$defs.record.required);
      assert.deepEqual(Object.keys(ledger.records[0].history[0]), schema.$defs.history_entry.required);
      assert.deepEqual(Object.keys(ledger.records[0].decision), schema.$defs.decision.required);
      assert.deepEqual(Object.keys(schema.$defs.record.properties), schema.$defs.record.required);
      assert.deepEqual(Object.keys(schema.$defs.history_entry.properties), schema.$defs.history_entry.required);
    });
  });
});
