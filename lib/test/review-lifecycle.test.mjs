import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
  LIFECYCLE_LOCK_REL_PATH,
  LIFECYCLE_STATES,
  LIFECYCLE_TRANSITIONS,
  LifecycleError,
  assertAppendOnly,
  assertLifecycleWritable,
  auditLifecycle,
  findPathClaims,
  listLifecycleRecords,
  migrateLifecycleRecords,
  readLifecycleRecord,
  reconcileTrackedSource,
  registerLifecycleRecord,
  relocateLifecycleRecord,
  retrieveLifecycleRecord,
  retrieveLifecycleRecords,
  transitionLifecycleRecord,
  transitionRequiresHuman,
  unlockLifecycle,
  validateLifecycleLedger
} from '../review-lifecycle.mjs';
import { findRegistryFindings, readSourceRecord, reconcileSource, registerSource, resolveSource } from '../source-registry.mjs';

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
  return path.join(root, LIFECYCLE_LOCK_REL_PATH);
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
      for (const action of ['submit', 'draft', 'evidence', 'reject', 'approve']) {
        assertRefused(() => transition(root, recordId, action, HUMAN), 'INVALID_TRANSITION');
      }
    });
  });

  it('exposes a transition table whose human-only actions are the review decisions', () => {
    assert.deepEqual(LIFECYCLE_ACTIONS, ['evidence', 'draft', 'submit', 'revise', 'approve', 'reject', 'supersede', 'withdraw']);
    const human = LIFECYCLE_ACTIONS.filter((action) => LIFECYCLE_TRANSITIONS[action].human);
    assert.deepEqual(human, ['approve', 'reject', 'supersede']);
    assert.deepEqual(LIFECYCLE_TRANSITIONS.approve.from, ['pending_review']);
    assert.deepEqual(LIFECYCLE_TRANSITIONS.reject.from, ['pending_review']);
    // Every way into `accepted` needs a confirmed human, and so does every
    // way out except revising a file that was already edited in place.
    for (const action of LIFECYCLE_ACTIONS) {
      const rule = LIFECYCLE_TRANSITIONS[action];
      if (rule.to === 'accepted') assert.equal(rule.human, true, `${action} reaches accepted`);
      if (rule.from.includes('accepted') && action !== 'revise') {
        assert.equal(transitionRequiresHuman(action, 'accepted'), true, `${action} leaves accepted`);
      }
    }
    assert.deepEqual(LIFECYCLE_ACTIONS.filter((action) => LIFECYCLE_TRANSITIONS[action].from.includes('accepted')), ['revise', 'supersede', 'withdraw']);
    assert.equal(transitionRequiresHuman('withdraw', 'draft'), false);
    assert.deepEqual(LIFECYCLE_ACTIONS.filter((action) => LIFECYCLE_TRANSITIONS[action].from.includes('withdrawn')), []);
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
        assert.deepEqual(retrieveLifecycleRecords(root).excluded.map((item) => item.reason), ['unsafe_path']);
        assert.throws(() => retrieveLifecycleRecord(root, recordId), (error) => {
          assert.equal(error.code, 'SOURCE_NOT_AVAILABLE');
          assert.equal(error.details.issue, 'unsafe_path');
          assert.match(error.message, /its source path is unsafe or is not a regular file/);
          return true;
        });
        assert.deepEqual(auditLifecycle(root).findings.map((item) => item.type), ['unsafe_path']);

        // Citing it as evidence is refused for the same reason, not as unregistered.
        const citing = addSource(root, '4-context/citing.md');
        assert.throws(() => register(root, citing, 'draft', { sourceIds: [readLifecycleRecord(root, recordId).source_id] }), (error) => {
          assert.equal(error.code, 'INVALID_SUPPORTING_SOURCE');
          assert.equal(error.details.issue, 'unsafe_path');
          return true;
        });
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
      assert.deepEqual(result.candidates.map((item) => [item.path, item.proposed_state]), [
        ['2-summaries/product-summary.md', 'unreviewed'],
        ['5-evidence/source-docs/export.csv', 'unreviewed'],
        ['6-raw/inbox/raw.md', 'raw']
      ]);
      assert.equal(result.candidates[0].legacy_status, 'active');
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
      assert.match(result.findings[0].action, /run "mole source register 4-context\/moved\.md"/);
      assert.equal(fs.existsSync(ledgerPath(root)), false);

      // Following the printed advice clears the finding.
      const ownId = registerSource(root, { path: '4-context/moved.md', capturedAt: tick(), capturedBy: 'test', channel: 'test' }).source_id;
      const dryRun = migrateLifecycleRecords(root);
      assert.equal(dryRun.ok, true);
      assert.deepEqual(dryRun.candidates.map((item) => [item.path, item.source_id, item.named_source_id]), [
        ['4-context/moved.md', ownId, 'src_8d31cc34-c04c-41ac-82e3-75518bb5a7e0']
      ]);
      const applied = migrateLifecycleRecords(root, { apply: true, ...AGENT, now: tick() });
      assert.equal(applied.ok, true);
      assert.deepEqual(applied.registered.map((item) => [item.path, item.source_id, item.state]), [['4-context/moved.md', ownId, 'unreviewed']]);
    });
  });

  it('registers an edited copy of a capture under its own source', () => {
    for (const archive of ['unreconciled', 'reconciled', 'kept']) {
      withWorkspace((root) => {
        const captureId = 'src_8d31cc34-c04c-41ac-82e3-75518bb5a7e0';
        const capture = `---\nsource_id: ${captureId}\nstatus: active\n---\nA customer note.\n`;
        writeFile(root, '6-raw/inbox/note.md', capture);
        registerSource(root, { path: '6-raw/inbox/note.md', sourceId: captureId, capturedAt: tick(), capturedBy: 'test', channel: 'test' });

        writeFile(root, '5-evidence/note.md', `${capture}Edited after the copy.\n`);
        let original = '6-raw/inbox/note.md';
        if (archive !== 'kept') {
          original = '6-raw/archive/note.md';
          fs.mkdirSync(path.join(root, '6-raw', 'archive'));
          fs.renameSync(path.join(root, '6-raw', 'inbox', 'note.md'), path.join(root, '6-raw', 'archive', 'note.md'));
          if (archive === 'reconciled') reconcileSource(root, captureId, original, { now: tick() });
        }

        const dryRun = migrateLifecycleRecords(root);
        assert.equal(dryRun.ok, true, archive);
        assert.deepEqual(dryRun.findings, []);
        assert.deepEqual(dryRun.candidates.map((item) => [item.path, item.source_id, item.named_source_id, item.proposed_state]), [
          ['5-evidence/note.md', null, captureId, 'unreviewed'],
          [original, captureId, undefined, 'raw']
        ]);

        const applied = migrateLifecycleRecords(root, { apply: true, ...AGENT, now: tick() });
        assert.equal(applied.ok, true);
        assert.deepEqual(applied.registered.map((item) => [item.path, item.state]), [['5-evidence/note.md', 'unreviewed'], [original, 'raw']]);
        assert.equal(applied.registered[1].source_id, captureId);
        assert.notEqual(applied.registered[0].source_id, captureId);
        assert.match(readLifecycleRecord(root, applied.registered[0].record_id).history[0].reason, new RegExp(`frontmatter names ${captureId}`));

        const again = migrateLifecycleRecords(root);
        assert.equal(again.ok, true);
        assert.equal(again.tracked, 2);
        assert.deepEqual(again.skipped, []);
      });
    }
  });

  it('never reports a file that an open record owns, whatever its frontmatter names', () => {
    withWorkspace((root) => {
      writeFile(root, '5-evidence/copy.md', '---\nsource_id: src_8d31cc34-c04c-41ac-82e3-75518bb5a7e0\n---\nbody\n');
      const sourceId = registerSource(root, { path: '5-evidence/copy.md', capturedAt: tick(), capturedBy: 'test', channel: 'test' }).source_id;
      register(root, sourceId, 'unreviewed');

      for (const options of [{}, { apply: true, ...AGENT, now: tick() }]) {
        const result = migrateLifecycleRecords(root, options);
        assert.equal(result.ok, true);
        assert.equal(result.tracked, 1);
        assert.deepEqual(result.skipped, []);
        assert.deepEqual(result.findings, []);
        assert.deepEqual(result.registered, []);
      }

      // The record still follows the file after a move without a reconcile.
      fs.renameSync(path.join(root, '5-evidence', 'copy.md'), path.join(root, '5-evidence', 'renamed.md'));
      const moved = migrateLifecycleRecords(root);
      assert.equal(moved.ok, true);
      assert.equal(moved.tracked, 1);
      assert.deepEqual(moved.skipped, []);
      assert.deepEqual(moved.candidates, []);
    });
  });

  it('keeps the identity of a moved original when another file sits at its old path', () => {
    for (const recorded of [false, true]) {
      withWorkspace((root) => {
        const captureId = 'src_8d31cc34-c04c-41ac-82e3-75518bb5a7e0';
        writeFile(root, '6-raw/inbox/note.md', `---\nsource_id: ${captureId}\n---\nA customer note.\n`);
        registerSource(root, { path: '6-raw/inbox/note.md', sourceId: captureId, capturedAt: tick(), capturedBy: 'test', channel: 'test' });
        if (recorded) register(root, captureId, 'raw');
        fs.mkdirSync(path.join(root, '6-raw', 'archive'));
        fs.renameSync(path.join(root, '6-raw', 'inbox', 'note.md'), path.join(root, '6-raw', 'archive', 'note.md'));
        writeFile(root, '6-raw/inbox/note.md', 'Moved to the archive.\n');

        const result = migrateLifecycleRecords(root, { apply: true, ...AGENT, now: tick() });
        assert.equal(result.ok, false);
        assert.deepEqual(result.skipped, [{ path: '6-raw/archive/note.md', reason: 'source_id_mismatch' }]);
        assert.ok(result.registered.every((item) => item.path !== '6-raw/archive/note.md'));
        assert.ok(result.findings[0].action.includes(`run "mole source reconcile ${captureId} --path 6-raw/archive/note.md" instead`));

        // Following that advice keeps one identity for the capture.
        reconcileSource(root, captureId, '6-raw/archive/note.md', { now: tick() });
        const applied = migrateLifecycleRecords(root, { apply: true, ...AGENT, now: tick() });
        assert.equal(applied.ok, true);
        const again = migrateLifecycleRecords(root);
        assert.equal(again.ok, true);
        assert.equal(again.tracked, 2);
        assert.equal(listLifecycleRecords(root).filter((record) => record.source_id === captureId).length, 1);
        assert.equal(readSourceRecord(root, captureId).current_path, '6-raw/archive/note.md');
        assert.deepEqual(auditLifecycle(root).findings, []);
      });
    }
  });

  it('reports a moved and edited original when an unrelated file sits at its old path', () => {
    for (const recorded of [false, true]) {
      withWorkspace((root) => {
        const captureId = 'src_8d31cc34-c04c-41ac-82e3-75518bb5a7e0';
        const capture = `---\nsource_id: ${captureId}\nstatus: active\n---\nA customer note.\n`;
        writeFile(root, '6-raw/inbox/note.md', capture);
        registerSource(root, { path: '6-raw/inbox/note.md', sourceId: captureId, capturedAt: tick(), capturedBy: 'test', channel: 'test' });
        if (recorded) register(root, captureId, 'raw');
        fs.rmSync(path.join(root, '6-raw', 'inbox', 'note.md'));
        writeFile(root, '6-raw/archive/note.md', capture.replace('status: active', 'status: archived'));
        writeFile(root, '6-raw/inbox/note.md', 'An unrelated note that reused the name.\n');

        const result = migrateLifecycleRecords(root, { apply: true, ...AGENT, now: tick() });
        assert.equal(result.ok, false);
        assert.deepEqual(result.skipped, [{ path: '6-raw/archive/note.md', reason: 'source_id_mismatch' }]);
        assert.ok(result.registered.every((item) => item.path !== '6-raw/archive/note.md'));
        assert.ok(result.findings[0].action.includes('run "mole source register 6-raw/archive/note.md".'));
        assert.ok(!result.findings[0].action.includes('mole source reconcile'));
      });
    }
  });

  it('quotes paths in mismatch advice and points at the named record', () => {
    withWorkspace((root) => {
      const sourceId = addSource(root, '6-raw/inbox/note.md');
      const recordId = register(root, sourceId, 'raw');
      fs.rmSync(path.join(root, '6-raw', 'inbox', 'note.md'));
      writeFile(root, "5-evidence/my notes/sam's note.md", `---\nsource_id: ${sourceId}\n---\nMoved and edited.\n`);

      const { action } = migrateLifecycleRecords(root).findings[0];
      assert.ok(action.includes(`run "mole source register '5-evidence/my notes/sam'\\''s note.md'".`), action);
      assert.ok(action.includes(`The named source has an open record, ${recordId}; run "mole lifecycle audit"`), action);
      assert.ok(!action.includes('withdraw'), action);
      assert.ok(!action.includes('mole source reconcile'), action);
    });
  });

  it('still reports a file that names a registered source no file holds', () => {
    withWorkspace((root) => {
      const sourceId = addSource(root, '4-context/decision.md');
      fs.rmSync(path.join(root, '4-context', 'decision.md'));
      writeFile(root, '4-context/renamed.md', `---\nsource_id: ${sourceId}\n---\nMoved and edited.\n`);

      const result = migrateLifecycleRecords(root, { apply: true, ...AGENT, now: tick() });
      assert.equal(result.ok, false);
      assert.deepEqual(result.registered, []);
      assert.deepEqual(result.skipped, [{ path: '4-context/renamed.md', reason: 'source_id_mismatch' }]);
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
    fs.mkdirSync(path.dirname(lockPathFor(root)), { recursive: true });
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

describe('one file, one source', () => {
  it('never lets a second source at a reused path become the reviewed content', () => {
    withWorkspace((root) => {
      const first = draftWithEvidence(root, '4-context/spec-draft.md');
      fs.renameSync(path.join(root, '4-context', 'spec-draft.md'), path.join(root, '4-context', 'checkout-spec.md'));
      fs.appendFileSync(path.join(root, '4-context', 'checkout-spec.md'), 'the real checkout spec\n');
      const secondSourceId = addSource(root, '4-context/spec-draft.md', 'UNFINISHED UNRELATED DRAFT\n');
      const before = fs.readFileSync(ledgerPath(root));

      // The path belongs to the open record.  A second record for it is
      // refused, and the refusal names the command that frees the path.
      assert.deepEqual(findPathClaims(root, '4-context/spec-draft.md'), [
        { source_id: first.sourceId, record_id: first.recordId, state: 'draft' }
      ]);
      assert.throws(() => register(root, secondSourceId), (error) => {
        assert.equal(error.code, 'PATH_CLAIM_CONFLICT');
        assert.match(error.message, new RegExp(`already belongs to draft lifecycle record ${first.recordId}`));
        assert.match(error.message, new RegExp(`mole lifecycle relocate ${first.recordId} --path <new path>`));
        assert.deepEqual(error.details.conflicting_record_ids, [first.recordId]);
        return true;
      });
      assert.deepEqual(fs.readFileSync(ledgerPath(root)), before);

      relocateLifecycleRecord(root, first.recordId, { path: '4-context/checkout-spec.md', ...AGENT, reason: 'Renamed', now: tick() });
      assert.equal(auditLifecycle(root).ok, true);
      const secondRecordId = register(root, secondSourceId);
      transition(root, first.recordId, 'submit');
      transition(root, first.recordId, 'approve', HUMAN);

      const retrieved = retrieveLifecycleRecord(root, first.recordId);
      assert.equal(retrieved.path, '4-context/checkout-spec.md');
      assert.match(retrieved.content, /the real checkout spec/);
      assert.doesNotMatch(retrieved.content, /UNFINISHED/);
      assert.deepEqual(
        listLifecycleRecords(root).filter((record) => record.path === '4-context/spec-draft.md').map((record) => [record.record_id, record.state]),
        [[secondRecordId, 'draft']]
      );
    });
  });

  it('is not blocked by a source that was registered a second time for the same file', () => {
    withWorkspace((root) => {
      const { recordId, relative, sourceId } = accepted(root, '4-context/personas.md');
      const strayId = registerSource(root, { path: relative, capturedAt: tick() }).source_id;

      assert.throws(() => register(root, strayId), (error) => {
        assert.equal(error.code, 'PATH_CLAIM_CONFLICT');
        assert.match(error.message, new RegExp(`already belongs to accepted lifecycle record ${recordId}`));
        return true;
      });
      assert.equal(auditLifecycle(root).ok, true);
      assert.equal(retrieveLifecycleRecords(root).records.length, 1);
      const plan = migrateLifecycleRecords(root, { roots: ['4-context'] });
      assert.equal(plan.ok, true);
      assert.equal(plan.tracked, 1);
      assert.deepEqual(plan.candidates, []);

      // The record keeps working through an in-place edit and a new review.
      writeFile(root, relative, 'personas, refreshed\n');
      transition(root, recordId, 'revise');
      const submitted = transition(root, recordId, 'submit');
      assert.equal(submitted.notices.length, 1);
      assert.match(submitted.notices[0], new RegExp(`Source ${strayId} is also registered at ${relative} and has no lifecycle record`));
      assert.equal(transition(root, recordId, 'approve', HUMAN).state, 'accepted');
      assert.equal(retrieveLifecycleRecord(root, recordId).content, 'personas, refreshed\n');
      assert.equal(readLifecycleRecord(root, recordId).source_id, sourceId);
      assert.equal(auditLifecycle(root).ok, true);
    });
  });

  it('keeps one record for an archived capture that is registered again at its new path', () => {
    withWorkspace((root) => {
      const sourceId = addSource(root, '6-raw/inbox/note.md', 'an archived note\n');
      const recordId = register(root, sourceId, 'raw');
      fs.mkdirSync(path.join(root, '6-raw', 'archive'));
      fs.renameSync(path.join(root, '6-raw', 'inbox', 'note.md'), path.join(root, '6-raw', 'archive', 'note.md'));
      const strayId = registerSource(root, { path: '6-raw/archive/note.md', capturedAt: tick() }).source_id;

      // The record still follows its file, and looking the file up finds it.
      assert.deepEqual(listLifecycleRecords(root, { path: '6-raw/archive/note.md' }).map((record) => record.record_id), [recordId]);
      assert.deepEqual(listLifecycleRecords(root, { path: '6-raw/archive/other.md' }), []);
      assert.equal(auditLifecycle(root).ok, true);
      assert.equal(retrieveLifecycleRecord(root, recordId, { includeStates: ['raw'] }).path, '6-raw/archive/note.md');

      // Migration sees the file as tracked and does not open a second record.
      const result = migrateLifecycleRecords(root, { apply: true, roots: ['6-raw'], ...AGENT, now: tick() });
      assert.equal(result.ok, true);
      assert.equal(result.tracked, 1);
      assert.deepEqual(result.registered, []);
      assert.equal(listLifecycleRecords(root).length, 1);

      relocateLifecycleRecord(root, recordId, { path: '6-raw/archive/note.md', ...AGENT, reason: 'Archived', now: tick() });
      assertRefused(() => register(root, strayId, 'raw'), 'PATH_CLAIM_CONFLICT');
      assert.equal(auditLifecycle(root).ok, true);
    });
  });

  it('finds a record by path without hashing files when a record is registered there', () => {
    withWorkspace((root) => {
      const first = draftWithEvidence(root, '4-context/first.md');
      const moved = register(root, addSource(root, '6-raw/inbox/note.md'), 'raw');
      const closed = draftWithEvidence(root, '4-context/closed.md');
      transition(root, closed.recordId, 'withdraw');

      // Hashing opens the file.  A file at its registered path is not opened
      // for a lookup.
      const opened = [];
      const openSync = fs.openSync;
      fs.openSync = (target, ...rest) => {
        if (String(target).endsWith('.md')) opened.push(path.basename(String(target)));
        return openSync(target, ...rest);
      };
      try {
        assert.deepEqual(listLifecycleRecords(root, { path: '4-context/nothing.md' }), []);
        assert.deepEqual(listLifecycleRecords(root, { path: '4-context/first.md' }).map((record) => record.record_id), [first.recordId]);
        assert.deepEqual(listLifecycleRecords(root, { path: '4-context/closed.md' }).map((record) => record.record_id), [closed.recordId]);
        assert.deepEqual(listLifecycleRecords(root, { path: '4-context/first.md', states: ['accepted'] }), []);
        assert.deepEqual(opened, []);
      } finally {
        fs.openSync = openSync;
      }

      // A moved file is still found by its bytes, at the new path and the old.
      fs.mkdirSync(path.join(root, '6-raw', 'archive'));
      fs.renameSync(path.join(root, '6-raw', 'inbox', 'note.md'), path.join(root, '6-raw', 'archive', 'note.md'));
      assert.deepEqual(listLifecycleRecords(root, { path: '6-raw/archive/note.md' }).map((record) => record.record_id), [moved]);
      assert.deepEqual(listLifecycleRecords(root, { path: '6-raw/inbox/note.md' }).map((record) => record.record_id), [moved]);
      assert.deepEqual(listLifecycleRecords(root, { path: '4-context/nothing.md' }), []);
    });
  });

  it('asks a person to choose when several unrecorded sources share a path', () => {
    withWorkspace((root) => {
      const firstId = addSource(root, '4-context/notes.md');
      const secondId = registerSource(root, { path: '4-context/notes.md', capturedAt: tick() }).source_id;

      const plan = migrateLifecycleRecords(root, { apply: true, roots: ['4-context'], ...AGENT, now: tick() });
      assert.equal(plan.ok, false);
      assert.deepEqual(plan.registered, []);
      assert.deepEqual(plan.skipped, [{ path: '4-context/notes.md', reason: 'ambiguous_source' }]);
      assert.deepEqual(plan.findings[0].source_ids.sort(), [firstId, secondId].sort());
      assert.match(plan.findings[0].action, /mole lifecycle register <source_id> --state <state>/);

      register(root, firstId, 'unreviewed');
      const after = migrateLifecycleRecords(root, { roots: ['4-context'] });
      assert.equal(after.ok, true);
      assert.equal(after.tracked, 1);
      assertRefused(() => register(root, secondId), 'PATH_CLAIM_CONFLICT');
    });
  });
});

describe('closed records and their paths', () => {
  it('frees the path of a withdrawn record for a new file', () => {
    withWorkspace((root) => {
      const first = draftWithEvidence(root, '4-context/spec-draft.md');
      fs.rmSync(path.join(root, '4-context', 'spec-draft.md'));
      transition(root, first.recordId, 'withdraw', { reason: 'Abandoned' });
      assert.deepEqual(findPathClaims(root, '4-context/spec-draft.md'), []);

      writeFile(root, '4-context/spec-draft.md', 'a new draft at the same path\n');
      const untracked = migrateLifecycleRecords(root, { roots: ['4-context'] });
      assert.deepEqual(untracked.candidates.map((item) => [item.path, item.source_id]), [['4-context/spec-draft.md', null]]);

      const secondSourceId = registerSource(root, { path: '4-context/spec-draft.md', capturedAt: tick() }).source_id;
      const secondRecordId = register(root, secondSourceId, 'draft', { sourceIds: [first.evidenceId] });
      assert.equal(readSourceRecord(root, first.sourceId).current_path, null);
      assert.equal(readSourceRecord(root, first.sourceId).original_path, '4-context/spec-draft.md');
      assert.ok(!findRegistryFindings(root).some((item) => item.type === 'path_claim_conflict'));

      transition(root, secondRecordId, 'submit');
      transition(root, secondRecordId, 'approve', HUMAN);
      assert.equal(retrieveLifecycleRecord(root, secondRecordId).content, 'a new draft at the same path\n');
      assert.equal(readLifecycleRecord(root, first.recordId).state, 'withdrawn');
      assert.equal(auditLifecycle(root).ok, true);
      assert.deepEqual(migrateLifecycleRecords(root).candidates.filter((item) => item.path.startsWith('4-context/')), []);
    });
  });

  it('keeps tracking a superseded file until a different file takes its path', () => {
    withWorkspace((root) => {
      const old = accepted(root, '4-context/pricing.md');
      const next = draftWithEvidence(root, '4-context/pricing-v2.md');
      transition(root, next.recordId, 'submit');
      transition(root, next.recordId, 'approve', { ...HUMAN, supersedes: [old.recordId] });

      assert.deepEqual(migrateLifecycleRecords(root).candidates.filter((item) => item.path.startsWith('4-context/')), []);
      assert.equal(retrieveLifecycleRecord(root, old.recordId, { includeStates: ['superseded'] }).path, '4-context/pricing.md');

      writeFile(root, '4-context/pricing.md', 'an unrelated note that reuses the old name\n');
      assert.deepEqual(retrieveLifecycleRecords(root, { includeStates: ['superseded'] }).excluded.map((item) => [item.record_id, item.reason]), [[old.recordId, 'content_changed']]);
      assertRefused(() => retrieveLifecycleRecord(root, old.recordId, { includeStates: ['superseded'] }), 'CONTENT_CHANGED');
      assert.equal(retrieveLifecycleRecords(root).records.length, 1);
      assert.equal(auditLifecycle(root).ok, true);

      const result = migrateLifecycleRecords(root, { apply: true, roots: ['4-context'], ...AGENT, now: tick() });
      assert.deepEqual(result.registered.map((item) => [item.path, item.state]), [['4-context/pricing.md', 'unreviewed']]);
      assert.notEqual(result.registered[0].source_id, old.sourceId);
      assert.equal(readSourceRecord(root, old.sourceId).current_path, null);
      assert.ok(!findRegistryFindings(root).some((item) => item.type === 'path_claim_conflict'));
      assert.deepEqual(validateLifecycleLedger(readLedger(root)), { valid: true, errors: [] });
    });
  });
});

describe('revising an accepted file that was edited in place', () => {
  it('sends the edited file back through review under the same record', () => {
    withWorkspace((root) => {
      const { recordId, relative, sourceId } = accepted(root, '4-context/personas.md');
      assertRefused(() => transition(root, recordId, 'revise'), 'HUMAN_REQUIRED');
      assertRefused(() => transition(root, recordId, 'revise', { actor: 'Sam Reviewer', actorType: 'human' }), 'HUMAN_CONFIRMATION_REQUIRED');
      assert.equal(readLifecycleRecord(root, recordId).state, 'accepted');

      writeFile(root, relative, 'personas, refreshed from the last inbox run\n');
      const audit = auditLifecycle(root);
      assert.deepEqual(audit.findings.map((item) => item.type), ['accepted_content_changed']);
      assert.match(audit.findings[0].action, new RegExp(`mole lifecycle revise ${recordId}`));
      assert.equal(retrieveLifecycleRecords(root).records.length, 0);

      const revised = transition(root, recordId, 'revise', { reason: 'Refreshed from the inbox' });
      assert.equal(revised.state, 'draft');
      assert.equal(revised.record.decision, null);
      assert.equal(auditLifecycle(root).ok, true);
      assert.equal(retrieveLifecycleRecords(root).records.length, 0);

      const submitted = transition(root, recordId, 'submit');
      assert.equal(submitted.source_correction, true);
      assertRefused(() => transition(root, recordId, 'approve', AGENT), 'HUMAN_REQUIRED');
      const approved = transition(root, recordId, 'approve', HUMAN);
      assert.deepEqual(approved.record.history.map((entry) => entry.action), ['register', 'submit', 'approve', 'revise', 'submit', 'approve']);
      assert.equal(retrieveLifecycleRecord(root, recordId).content, 'personas, refreshed from the last inbox run\n');
      assert.equal(readSourceRecord(root, sourceId).content_history.length, 2);
      assert.deepEqual(validateLifecycleLedger(readLedger(root)), { valid: true, errors: [] });
    });
  });

  it('lets a person reopen unchanged accepted context and keeps supersession links valid', () => {
    withWorkspace((root) => {
      const old = accepted(root, '4-context/old.md');
      const next = draftWithEvidence(root, '4-context/new.md');
      transition(root, next.recordId, 'submit');
      transition(root, next.recordId, 'approve', { ...HUMAN, supersedes: [old.recordId] });

      const reopened = transition(root, next.recordId, 'revise', { ...HUMAN, reason: 'Needs another look' });
      assert.equal(reopened.state, 'draft');
      assert.deepEqual(reopened.record.supersedes, [old.recordId]);
      assert.equal(retrieveLifecycleRecords(root).records.length, 0);
      assert.deepEqual(validateLifecycleLedger(readLedger(root)), { valid: true, errors: [] });

      const gone = accepted(root, '4-context/gone.md');
      fs.rmSync(path.join(root, '4-context', 'gone.md'));
      assert.throws(() => transition(root, gone.recordId, 'revise', HUMAN), (error) => {
        assert.equal(error.code, 'SOURCE_NOT_AVAILABLE');
        assert.match(error.message, new RegExp(`mole lifecycle withdraw ${gone.recordId}`));
        return true;
      });
    });
  });
});

describe('relocating a renamed draft', () => {
  it('re-points a renamed and edited draft without touching the file', () => {
    withWorkspace((root) => {
      const { recordId, sourceId } = draftWithEvidence(root, '4-context/roadmap-draft.md');
      const moved = path.join(root, '4-context', 'q4-roadmap.md');
      fs.renameSync(path.join(root, '4-context', 'roadmap-draft.md'), moved);
      fs.appendFileSync(moved, 'edited after the rename\n');
      const bytes = fs.readFileSync(moved);

      assert.throws(() => transition(root, recordId, 'submit'), (error) => {
        assert.equal(error.code, 'SOURCE_NOT_AVAILABLE');
        assert.match(error.message, new RegExp(`mole lifecycle relocate ${recordId} --path <new path>`));
        return true;
      });
      assert.equal(auditLifecycle(root).findings[0].type, 'source_unresolved');

      const result = relocateLifecycleRecord(root, recordId, { path: '4-context/q4-roadmap.md', ...AGENT, reason: 'Renamed for Q4', now: tick() });
      assert.equal(result.state, 'draft');
      assert.equal(result.source_correction, true);
      assert.equal(result.record.path, '4-context/q4-roadmap.md');
      assert.deepEqual(result.record.history.map((entry) => entry.action), ['register', 'relocate']);
      assert.equal(result.record.history[1].from_state, 'draft');
      assert.equal(result.record.history[1].to_state, 'draft');
      assert.deepEqual(fs.readFileSync(moved), bytes);

      const source = readSourceRecord(root, sourceId);
      assert.equal(source.current_path, '4-context/q4-roadmap.md');
      assert.equal(source.original_path, '4-context/roadmap-draft.md');
      assert.deepEqual(source.path_history.map((item) => [item.path, item.valid_to === null]), [
        ['4-context/roadmap-draft.md', false],
        ['4-context/q4-roadmap.md', true]
      ]);
      assert.equal(source.content_history.length, 2);
      assert.match(source.content_history[1].reason, /Lifecycle relocation .* by Drafting Agent: Renamed for Q4/);
      assert.deepEqual(findRegistryFindings(root), []);

      assert.equal(transition(root, recordId, 'submit').source_correction, false);
      transition(root, recordId, 'approve', HUMAN);
      assert.equal(retrieveLifecycleRecord(root, recordId).path, '4-context/q4-roadmap.md');
      assert.equal(auditLifecycle(root).ok, true);
      assert.deepEqual(validateLifecycleLedger(readLedger(root)), { valid: true, errors: [] });
    });
  });

  it('refuses relocation that would rewrite reviewed or raw material', () => {
    withWorkspace((root) => {
      const draft = draftWithEvidence(root, '4-context/draft.md');
      const other = draftWithEvidence(root, '4-context/other.md');
      const rawId = register(root, addSource(root, '6-raw/inbox/raw.md'), 'raw');
      const approved = accepted(root, '4-context/approved.md');
      writeFile(root, '4-context/elsewhere.md', 'somewhere else\n');
      const move = (recordId, target, extra = {}) => relocateLifecycleRecord(root, recordId, { path: target, ...AGENT, reason: 'moved', now: tick(), ...extra });
      const before = fs.readFileSync(ledgerPath(root));

      assertRefused(() => move(rawId, '4-context/elsewhere.md'), 'CONTENT_CHANGED');
      assertRefused(() => move(approved.recordId, '4-context/elsewhere.md'), 'CONTENT_CHANGED');
      assertRefused(() => move(draft.recordId, '4-context/missing.md'), 'INVALID_PATH');
      assertRefused(() => move(draft.recordId, '../outside.md'), 'INVALID_PATH');
      assertRefused(() => move(draft.recordId, '4-context/draft.md'), 'RELOCATE_NOOP');
      assertRefused(() => move(draft.recordId, '4-context/other.md'), 'PATH_CLAIM_CONFLICT');
      assertRefused(() => move(draft.recordId, '4-context/elsewhere.md', { reason: '' }), 'REASON_REQUIRED');
      assertRefused(() => move(draft.recordId, '4-context/elsewhere.md', { expectedRevision: 9 }), 'REVISION_CONFLICT');
      assertRefused(() => move('rec_00000000-0000-4000-8000-000000000000', '4-context/elsewhere.md'), 'RECORD_NOT_FOUND');

      transition(root, other.recordId, 'submit');
      assertRefused(() => move(other.recordId, '4-context/elsewhere.md'), 'CONTENT_CHANGED');
      transition(root, other.recordId, 'revise');
      assert.equal(move(other.recordId, '4-context/elsewhere.md').record.path, '4-context/elsewhere.md');
      assert.notDeepEqual(fs.readFileSync(ledgerPath(root)), before);
      assert.equal(readLifecycleRecord(root, approved.recordId).revision, 3);
    });
  });
});

describe('moving reviewed material without changing it', () => {
  it('records an accepted file that moved onto the path of the record it superseded', () => {
    withWorkspace((root) => {
      const old = accepted(root, '4-context/pricing.md');
      const next = draftWithEvidence(root, '4-context/pricing-v2.md');
      transition(root, next.recordId, 'submit');
      transition(root, next.recordId, 'approve', { ...HUMAN, supersedes: [old.recordId] });

      // The new version takes over the canonical filename.
      fs.renameSync(path.join(root, '4-context', 'pricing.md'), path.join(root, '4-context', 'pricing-v1.md'));
      fs.renameSync(path.join(root, '4-context', 'pricing-v2.md'), path.join(root, '4-context', 'pricing.md'));
      assert.equal(retrieveLifecycleRecord(root, next.recordId).path, '4-context/pricing.md');
      assert.equal(auditLifecycle(root).ok, true);

      const moved = relocateLifecycleRecord(root, next.recordId, { path: '4-context/pricing.md', ...AGENT, reason: 'Took over the canonical name', now: tick() });
      assert.equal(moved.state, 'accepted');
      assert.equal(moved.source_correction, false);
      assert.equal(moved.record.decision.outcome, 'accepted');
      assert.equal(readSourceRecord(root, next.sourceId).current_path, '4-context/pricing.md');
      assert.equal(readSourceRecord(root, old.sourceId).current_path, null);
      assert.ok(!findRegistryFindings(root).some((item) => item.type === 'path_claim_conflict'));
      assert.equal(retrieveLifecycleRecords(root).records.length, 1);
      assert.equal(retrieveLifecycleRecord(root, old.recordId, { includeStates: ['superseded'] }).path, '4-context/pricing-v1.md');

      // Because the path is recorded, a later in-place edit can be revised.
      fs.appendFileSync(path.join(root, '4-context', 'pricing.md'), 'a later price change\n');
      transition(root, next.recordId, 'revise');
      transition(root, next.recordId, 'submit');
      assert.equal(transition(root, next.recordId, 'approve', HUMAN).state, 'accepted');
      assert.equal(auditLifecycle(root).ok, true);
      assert.deepEqual(validateLifecycleLedger(readLedger(root)), { valid: true, errors: [] });
    });
  });

  it('lets raw and pending material follow an unchanged file and nothing else', () => {
    withWorkspace((root) => {
      const rawId = register(root, addSource(root, '6-raw/inbox/note.md', 'the note\n'), 'raw');
      const pending = draftWithEvidence(root, '4-context/pending.md');
      transition(root, pending.recordId, 'submit');
      // Two copies make the hash search ambiguous, so a person has to choose.
      writeFile(root, '6-raw/archive/a/note.md', 'the note\n');
      writeFile(root, '6-raw/archive/b/note.md', 'the note\n');
      fs.rmSync(path.join(root, '6-raw', 'inbox', 'note.md'));
      assert.deepEqual(auditLifecycle(root).findings.map((item) => item.type), ['source_unresolved']);

      const move = (recordId, target) => relocateLifecycleRecord(root, recordId, { path: target, ...AGENT, reason: 'archived', now: tick() });
      assert.equal(move(rawId, '6-raw/archive/a/note.md').state, 'raw');
      assert.equal(auditLifecycle(root).ok, true);

      fs.renameSync(path.join(root, '4-context', 'pending.md'), path.join(root, '4-context', 'pending-renamed.md'));
      assert.equal(move(pending.recordId, '4-context/pending-renamed.md').state, 'pending_review');
      assert.equal(transition(root, pending.recordId, 'approve', HUMAN).state, 'accepted');

      writeFile(root, '6-raw/archive/a/changed.md', 'the note, changed\n');
      assert.throws(() => move(rawId, '6-raw/archive/a/changed.md'), (error) => {
        assert.equal(error.code, 'CONTENT_CHANGED');
        assert.match(error.message, /A raw record can move but not change/);
        return true;
      });
    });
  });
});

describe('withdrawing a record', () => {
  it('keeps a once-accepted record for a human to close after an agent revises it', () => {
    withWorkspace((root) => {
      const old = accepted(root, '4-context/old.md');
      const next = draftWithEvidence(root, '4-context/new.md');
      transition(root, next.recordId, 'submit');
      transition(root, next.recordId, 'approve', { ...HUMAN, supersedes: [old.recordId] });

      fs.appendFileSync(path.join(root, '4-context', 'new.md'), 'one more byte\n');
      assert.equal(transition(root, next.recordId, 'revise').state, 'draft');
      assert.throws(() => transition(root, next.recordId, 'withdraw'), (error) => {
        assert.equal(error.code, 'HUMAN_REQUIRED');
        assert.match(error.message, /Only a human can withdraw a record that was accepted before\. The record stays draft\./);
        return true;
      });
      assertRefused(() => transition(root, next.recordId, 'withdraw', { actor: 'Sam Reviewer', actorType: 'human' }), 'HUMAN_CONFIRMATION_REQUIRED');
      assert.equal(readLifecycleRecord(root, next.recordId).state, 'draft');

      const never = draftWithEvidence(root, '4-context/never-accepted.md');
      assert.equal(transition(root, never.recordId, 'withdraw').state, 'withdrawn');
      assert.equal(transition(root, next.recordId, 'withdraw', HUMAN).state, 'withdrawn');

      const ledger = readLedger(root);
      assert.equal(validateLifecycleLedger(ledger).valid, true);
      ledger.records.find((record) => record.record_id === next.recordId).history.at(-1).actor_type = 'agent';
      assert.match(validateLifecycleLedger(ledger).errors.join('\n'), /records withdraw without a confirmed human actor/);
    });
  });

  it('closes a record whose file is gone so the audit can pass again', () => {
    withWorkspace((root) => {
      const rawId = register(root, addSource(root, '6-raw/inbox/promoted.md'), 'raw');
      const draft = draftWithEvidence(root, '4-context/abandoned.md');
      fs.rmSync(path.join(root, '6-raw', 'inbox', 'promoted.md'));
      fs.rmSync(path.join(root, '4-context', 'abandoned.md'));

      const audit = auditLifecycle(root);
      assert.deepEqual(audit.findings.map((item) => item.type), ['source_unresolved', 'source_unresolved']);
      assert.match(audit.findings[0].action, new RegExp(`mole lifecycle withdraw ${rawId}`));
      assert.equal(retrieveLifecycleRecords(root, { includeStates: ['raw'] }).excluded.length, 1);

      const withdrawn = transition(root, rawId, 'withdraw', { reason: 'Inbox copy removed after promotion' });
      assert.equal(withdrawn.state, 'withdrawn');
      assert.equal(withdrawn.record.decision, null);
      transition(root, draft.recordId, 'withdraw', { reason: 'Abandoned' });

      assert.equal(auditLifecycle(root).ok, true);
      assert.deepEqual(retrieveLifecycleRecords(root, { includeStates: ['raw', 'draft'] }).excluded, []);
      assert.equal(retrieveLifecycleRecords(root).state_counts.withdrawn, 2);
      for (const action of LIFECYCLE_ACTIONS) {
        assertRefused(() => transition(root, rawId, action, { ...HUMAN, replacementId: action === 'supersede' ? draft.recordId : undefined }), 'INVALID_TRANSITION');
      }
      assertRefused(() => relocateLifecycleRecord(root, rawId, { path: '4-context', ...AGENT, reason: 'x' }), 'INVALID_TRANSITION');
      assert.deepEqual(validateLifecycleLedger(readLedger(root)), { valid: true, errors: [] });
    });
  });

  it('lets only a confirmed human withdraw accepted context', () => {
    withWorkspace((root) => {
      const { recordId } = accepted(root, '4-context/policy.md');
      assertRefused(() => transition(root, recordId, 'withdraw', AGENT), 'HUMAN_REQUIRED');
      assertRefused(() => transition(root, recordId, 'withdraw', { actor: 'mole-cli', actorType: 'automation', humanConfirmed: true }), 'HUMAN_REQUIRED');
      assertRefused(() => transition(root, recordId, 'withdraw', { actor: 'Sam Reviewer', actorType: 'human' }), 'HUMAN_CONFIRMATION_REQUIRED');
      assert.equal(retrieveLifecycleRecords(root).records.length, 1);

      const result = transition(root, recordId, 'withdraw', { ...HUMAN, reason: 'Policy no longer applies' });
      assert.equal(result.state, 'withdrawn');
      assert.equal(result.record.decision, null);
      assert.equal(result.record.history.at(-1).actor_type, 'human');
      assert.equal(result.record.history.at(-2).action, 'approve');
      assert.equal(retrieveLifecycleRecords(root).records.length, 0);
      assertRefused(() => retrieveLifecycleRecord(root, recordId), 'NOT_ELIGIBLE');

      const ledger = readLedger(root);
      assert.equal(validateLifecycleLedger(ledger).valid, true);
      ledger.records.find((record) => record.record_id === recordId).history.at(-1).actor_type = 'agent';
      assert.match(validateLifecycleLedger(ledger).errors.join('\n'), /records withdraw without a confirmed human actor/);
    });
  });

  it('does not report the missing file of a superseded record', () => {
    withWorkspace((root) => {
      const old = accepted(root, '4-context/old.md');
      const next = draftWithEvidence(root, '4-context/new.md');
      transition(root, next.recordId, 'submit');
      transition(root, next.recordId, 'approve', { ...HUMAN, supersedes: [old.recordId] });
      fs.rmSync(path.join(root, '4-context', 'old.md'));
      assert.equal(auditLifecycle(root).ok, true);
      assert.equal(retrieveLifecycleRecords(root).records.length, 1);
    });
  });
});

describe('evidence and replacement integrity', () => {
  it('refuses a replacement whose file no longer matches its accepted bytes', () => {
    withWorkspace((root) => {
      const old = accepted(root, '4-context/old.md');
      const next = accepted(root, '4-context/new.md');
      writeFile(root, '4-context/new.md', 'changed after approval\n');
      assertRefused(() => transition(root, old.recordId, 'supersede', { ...HUMAN, replacementId: next.recordId }), 'INVALID_SUPERSESSION');
      assert.equal(readLifecycleRecord(root, old.recordId).state, 'accepted');
      assert.equal(retrieveLifecycleRecords(root).records.length, 1);
    });
  });

  it('refuses an acceptance supported only by rejected or withdrawn material', () => {
    withWorkspace((root) => {
      const rejected = draftWithEvidence(root, '4-context/rejected.md');
      transition(root, rejected.recordId, 'submit');
      transition(root, rejected.recordId, 'reject', HUMAN);
      const withdrawn = draftWithEvidence(root, '4-context/withdrawn.md');
      transition(root, withdrawn.recordId, 'withdraw');

      const sourceId = addSource(root, '4-context/claim.md');
      const recordId = register(root, sourceId, 'draft', { sourceIds: [rejected.sourceId] });
      transition(root, recordId, 'submit');
      assertRefused(() => transition(root, recordId, 'approve', HUMAN), 'INVALID_SUPPORTING_SOURCE');
      assertRefused(() => transition(root, recordId, 'approve', { ...HUMAN, sourceIds: [withdrawn.sourceId] }), 'INVALID_SUPPORTING_SOURCE');
      assert.equal(readLifecycleRecord(root, recordId).state, 'pending_review');

      transition(root, recordId, 'revise', { removeSourceIds: [rejected.sourceId], sourceIds: [rejected.evidenceId] });
      transition(root, recordId, 'submit');
      assert.equal(transition(root, recordId, 'approve', HUMAN).state, 'accepted');
    });
  });

  it('names every source that cannot support an acceptance and the way out', () => {
    withWorkspace((root) => {
      const rejected = draftWithEvidence(root, '4-context/rejected.md');
      transition(root, rejected.recordId, 'submit');
      transition(root, rejected.recordId, 'reject', HUMAN);
      const abandoned = draftWithEvidence(root, '4-context/abandoned.md');
      transition(root, abandoned.recordId, 'withdraw');
      const offered = draftWithEvidence(root, '4-context/offered.md');
      transition(root, offered.recordId, 'withdraw');

      const sourceId = addSource(root, '4-context/claim.md');
      const recordId = register(root, sourceId, 'draft', { sourceIds: [rejected.sourceId, abandoned.sourceId] });
      transition(root, recordId, 'submit');
      assert.throws(() => transition(root, recordId, 'approve', { ...HUMAN, sourceIds: [offered.sourceId] }), (error) => {
        assert.equal(error.code, 'INVALID_SUPPORTING_SOURCE');
        assert.deepEqual(error.details.sources, [
          { source_id: rejected.sourceId, record_id: rejected.recordId, state: 'rejected' },
          { source_id: abandoned.sourceId, record_id: abandoned.recordId, state: 'withdrawn' },
          { source_id: offered.sourceId, record_id: offered.recordId, state: 'withdrawn' }
        ]);
        assert.ok(error.message.includes(`mole lifecycle revise ${recordId} --remove-source ${rejected.sourceId} --remove-source ${abandoned.sourceId}"`));
        assert.ok(error.message.includes(`mole lifecycle submit ${recordId}`));
        assert.match(error.message, /Also leave the source passed to this approval out of "--source"\./);
        return true;
      });
      assert.equal(readLifecycleRecord(root, recordId).state, 'pending_review');
    });
  });

  it('keeps a capture as support after its file is deleted and its record withdrawn', () => {
    withWorkspace((root) => {
      const rawId = addSource(root, '6-raw/inbox/note.md');
      const rawRecordId = register(root, rawId, 'raw');
      const evidenceId = addSource(root, '6-raw/inbox/export.md');
      const evidenceRecordId = register(root, evidenceId, 'evidence');

      const sourceId = addSource(root, '4-context/claim.md');
      const recordId = register(root, sourceId, 'draft', { sourceIds: [rawId, evidenceId] });
      transition(root, recordId, 'submit');
      for (const [relative, id] of [['6-raw/inbox/note.md', rawRecordId], ['6-raw/inbox/export.md', evidenceRecordId]]) {
        fs.rmSync(path.join(root, ...relative.split('/')));
        assert.equal(transition(root, id, 'withdraw').state, 'withdrawn');
      }

      assert.equal(transition(root, recordId, 'approve', HUMAN).state, 'accepted');
      assert.equal(auditLifecycle(root).ok, true);

      // A living file that cites the cleaned-up captures can be approved again.
      writeFile(root, '4-context/claim.md', 'edited in place\n');
      transition(root, recordId, 'revise');
      transition(root, recordId, 'submit');
      assert.equal(transition(root, recordId, 'approve', HUMAN).state, 'accepted');
    });
  });
});

describe('archived files', () => {
  it('finds many moved captures by their registered bytes in one pass', () => {
    withWorkspace((root) => {
      const count = 200;
      const recordIds = [];
      for (let index = 0; index < count; index += 1) {
        recordIds.push(register(root, addSource(root, `6-raw/inbox/note-${index}.md`), 'raw'));
      }
      fs.mkdirSync(path.join(root, '6-raw', 'archive'));
      for (let index = 0; index < count; index += 1) {
        fs.renameSync(path.join(root, '6-raw', 'inbox', `note-${index}.md`), path.join(root, '6-raw', 'archive', `note-${index}.md`));
      }

      const started = Date.now();
      const audit = auditLifecycle(root);
      const listing = retrieveLifecycleRecords(root, { includeStates: ['raw'] });
      const elapsed = Date.now() - started;

      assert.equal(audit.ok, true);
      assert.equal(listing.records.length, count);
      assert.deepEqual(listing.excluded, []);
      assert.ok(listing.records.every((record) => record.path.startsWith('6-raw/archive/')));
      // Resolving each record with a full registry scan took over a minute at
      // this size.  One pass takes well under a second; allow slow machines.
      assert.ok(elapsed < 15000, `audit and retrieval of ${count} moved records took ${elapsed} ms`);
      assert.equal(retrieveLifecycleRecord(root, recordIds[7], { includeStates: ['raw'] }).path, '6-raw/archive/note-7.md');
    });
  });

  it('refuses a second record for an accepted file that moved without a relocate', () => {
    withWorkspace((root) => {
      const { recordId } = accepted(root, '4-context/decision.md');
      fs.mkdirSync(path.join(root, '4-context', 'archive'));
      fs.renameSync(path.join(root, '4-context', 'decision.md'), path.join(root, '4-context', 'archive', 'decision.md'));
      assert.equal(retrieveLifecycleRecord(root, recordId).path, '4-context/archive/decision.md');

      const strayId = registerSource(root, { path: '4-context/archive/decision.md', capturedAt: tick() }).source_id;
      assert.throws(() => register(root, strayId), (error) => {
        assert.equal(error.code, 'PATH_CLAIM_CONFLICT');
        assert.deepEqual(error.details.conflicting_record_ids, [recordId]);
        assert.equal(error.details.moved_from, '4-context/decision.md');
        assert.ok(error.message.includes(`mole lifecycle relocate ${recordId} --path 4-context/archive/decision.md`));
        return true;
      });

      // The accepted record keeps working, and the advised command is accepted.
      assert.equal(listLifecycleRecords(root).length, 1);
      assert.equal(retrieveLifecycleRecord(root, recordId).path, '4-context/archive/decision.md');
      assert.equal(auditLifecycle(root).ok, true);
      relocateLifecycleRecord(root, recordId, { path: '4-context/archive/decision.md', ...AGENT, reason: 'Archived', now: tick() });
      assertRefused(() => register(root, strayId), 'PATH_CLAIM_CONFLICT');
      assert.equal(retrieveLifecycleRecords(root).records.length, 1);
      assert.equal(auditLifecycle(root).ok, true);
    });
  });

  it('refuses to relocate another record onto a moved file that a record follows', () => {
    withWorkspace((root) => {
      const { recordId } = accepted(root, '4-context/decision.md');
      const other = draftWithEvidence(root, '4-context/other.md');
      fs.mkdirSync(path.join(root, '4-context', 'archive'));
      fs.renameSync(path.join(root, '4-context', 'decision.md'), path.join(root, '4-context', 'archive', 'decision.md'));
      fs.rmSync(path.join(root, '4-context', 'other.md'));

      assert.throws(() => relocateLifecycleRecord(root, other.recordId, { path: '4-context/archive/decision.md', ...AGENT, reason: 'Renamed', now: tick() }), (error) => {
        assert.equal(error.code, 'PATH_CLAIM_CONFLICT');
        assert.deepEqual(error.details.conflicting_record_ids, [recordId]);
        return true;
      });
      assert.equal(retrieveLifecycleRecord(root, recordId).path, '4-context/archive/decision.md');

      // The record that follows the file can still be relocated onto it.
      relocateLifecycleRecord(root, recordId, { path: '4-context/archive/decision.md', ...AGENT, reason: 'Archived', now: tick() });
      assert.equal(retrieveLifecycleRecords(root).records.length, 1);
    });
  });

  it('lets either of two records that follow one file be relocated onto it', () => {
    withWorkspace((root) => {
      const template = '# Spec\n\nTBC\n';
      const firstId = register(root, addSource(root, '4-context/t1.md', template));
      const secondId = register(root, addSource(root, '4-context/t2.md', template));
      fs.rmSync(path.join(root, '4-context', 't1.md'));
      fs.renameSync(path.join(root, '4-context', 't2.md'), path.join(root, '4-context', 't3.md'));

      // Both records resolve to t3.md by content.  The one that is relocated wins.
      relocateLifecycleRecord(root, secondId, { path: '4-context/t3.md', ...AGENT, reason: 'Renamed', now: tick() });
      assert.equal(readLifecycleRecord(root, secondId).path, '4-context/t3.md');
      const finding = auditLifecycle(root).findings[0];
      assert.equal(finding.type, 'source_unresolved');
      assert.equal(finding.record_id, firstId);
      transition(root, firstId, 'withdraw');
      assert.equal(auditLifecycle(root).ok, true);
    });
  });

  it('does not let a draft take the moved file of an accepted record with the same bytes', () => {
    withWorkspace((root) => {
      const { recordId } = accepted(root, '4-context/decision.md');
      const bytes = fs.readFileSync(path.join(root, '4-context', 'decision.md'));
      const draftId = register(root, addSource(root, '4-context/decision-v2.md', bytes));
      fs.mkdirSync(path.join(root, '4-context', 'archive'));
      fs.renameSync(path.join(root, '4-context', 'decision.md'), path.join(root, '4-context', 'archive', 'decision.md'));
      fs.rmSync(path.join(root, '4-context', 'decision-v2.md'));

      // Both records now follow the archived file by content.
      assert.throws(() => relocateLifecycleRecord(root, draftId, { path: '4-context/archive/decision.md', ...AGENT, reason: 'Renamed', now: tick() }), (error) => {
        assert.equal(error.code, 'PATH_CLAIM_CONFLICT');
        assert.deepEqual(error.details.conflicting_record_ids, [recordId]);
        return true;
      });
      assert.equal(retrieveLifecycleRecord(root, recordId).path, '4-context/archive/decision.md');

      // The accepted record can take it, and the draft is then reported.
      relocateLifecycleRecord(root, recordId, { path: '4-context/archive/decision.md', ...AGENT, reason: 'Archived', now: tick() });
      assert.equal(retrieveLifecycleRecords(root).records.length, 1);
      assert.equal(auditLifecycle(root).findings[0].record_id, draftId);
    });
  });

  it('does not let another source be reconciled onto an accepted record\'s moved file', () => {
    withWorkspace((root) => {
      const { recordId } = accepted(root, '4-context/decision.md');
      const acceptedSourceId = readLifecycleRecord(root, recordId).source_id;
      const bytes = fs.readFileSync(path.join(root, '4-context', 'decision.md'));
      const draftSourceId = addSource(root, '4-context/decision-v2.md', bytes);
      const draftId = register(root, draftSourceId);
      fs.mkdirSync(path.join(root, '4-context', 'archive'));
      fs.renameSync(path.join(root, '4-context', 'decision.md'), path.join(root, '4-context', 'archive', 'decision.md'));
      fs.rmSync(path.join(root, '4-context', 'decision-v2.md'));

      assert.throws(() => reconcileTrackedSource(root, draftSourceId, '4-context/archive/decision.md', { now: tick() }), (error) => {
        assert.equal(error.code, 'PATH_CLAIM_CONFLICT');
        assert.deepEqual(error.details.conflicting_record_ids, [recordId]);
        assert.match(error.message, new RegExp(`mole lifecycle relocate ${recordId} --path 4-context/archive/decision.md`));
        return true;
      });
      assert.equal(readSourceRecord(root, draftSourceId).current_path, '4-context/decision-v2.md');
      assert.equal(retrieveLifecycleRecord(root, recordId).path, '4-context/archive/decision.md');

      // The accepted record's own source can take it, and the draft is then reported.
      const result = reconcileTrackedSource(root, acceptedSourceId, '4-context/archive/decision.md', { now: tick() });
      assert.equal(result.changed, true);
      assert.equal(retrieveLifecycleRecords(root).records.length, 1);
      assert.equal(auditLifecycle(root).findings[0].record_id, draftId);
    });
  });

  it('reconciles a source without a lifecycle record onto a followed file, leaving the record resolved', () => {
    withWorkspace((root) => {
      const { recordId } = accepted(root, '4-context/decision.md');
      const bytes = fs.readFileSync(path.join(root, '4-context', 'decision.md'));
      const plainSourceId = addSource(root, '4-context/copy.md', bytes);
      fs.mkdirSync(path.join(root, '4-context', 'archive'));
      fs.renameSync(path.join(root, '4-context', 'decision.md'), path.join(root, '4-context', 'archive', 'decision.md'));
      fs.rmSync(path.join(root, '4-context', 'copy.md'));

      const result = reconcileTrackedSource(root, plainSourceId, '4-context/archive/decision.md', { now: tick() });
      assert.equal(result.changed, true);
      assert.equal(retrieveLifecycleRecord(root, recordId).path, '4-context/archive/decision.md');
      assert.equal(reconcileTrackedSource(root, plainSourceId, '4-context/archive/decision.md', { now: tick() }).changed, false);
    });
  });

  it('reconciles a source with no open record following the file', () => {
    withWorkspace((root) => {
      const sourceId = addSource(root, '4-context/notes.md');
      fs.mkdirSync(path.join(root, '4-context', 'archive'));
      fs.renameSync(path.join(root, '4-context', 'notes.md'), path.join(root, '4-context', 'archive', 'notes.md'));

      const result = reconcileTrackedSource(root, sourceId, '4-context/archive/notes.md', { now: tick() });
      assert.equal(result.changed, true);
      assert.equal(readSourceRecord(root, sourceId).current_path, '4-context/archive/notes.md');
    });
  });

  it('registers a file the caller has just written, whatever bytes it shares', () => {
    withWorkspace((root) => {
      const template = '# Spec\n\nTBC\n';
      const firstId = register(root, addSource(root, '4-context/b.md', template));
      fs.rmSync(path.join(root, '4-context', 'b.md'));
      const sourceId = addSource(root, '4-context/c.md', template);

      assertRefused(() => register(root, sourceId), 'PATH_CLAIM_CONFLICT');
      const secondId = register(root, sourceId, 'draft', { newFile: true });
      assert.equal(listLifecycleRecords(root, { path: '4-context/c.md' })[0].record_id, secondId);
      const finding = auditLifecycle(root).findings[0];
      assert.equal(finding.type, 'source_unresolved');
      assert.equal(finding.record_id, firstId);
    });
  });

  it('refuses a second record for an archived raw capture', () => {
    withWorkspace((root) => {
      const recordId = register(root, addSource(root, '6-raw/inbox/note.md'), 'raw');
      fs.mkdirSync(path.join(root, '6-raw', 'archive'));
      fs.renameSync(path.join(root, '6-raw', 'inbox', 'note.md'), path.join(root, '6-raw', 'archive', 'note.md'));

      const strayId = registerSource(root, { path: '6-raw/archive/note.md', capturedAt: tick() }).source_id;
      assertRefused(() => register(root, strayId, 'raw'), 'PATH_CLAIM_CONFLICT');
      assert.equal(retrieveLifecycleRecord(root, recordId, { includeStates: ['raw'] }).path, '6-raw/archive/note.md');
      assert.equal(auditLifecycle(root).ok, true);
    });
  });

  it('registers files that share bytes when each sits at its own path', () => {
    withWorkspace((root) => {
      const template = '# Decision\n\nTBC\n';
      const firstId = register(root, addSource(root, '4-context/first.md', template));
      const secondId = register(root, addSource(root, '4-context/second.md', template));
      assert.notEqual(firstId, secondId);
      assert.equal(auditLifecycle(root).ok, true);

      // Once the first file is deleted, its record cannot take the second.
      fs.rmSync(path.join(root, '4-context', 'first.md'));
      const audit = auditLifecycle(root);
      assert.deepEqual(audit.findings.map((item) => item.type), ['source_unresolved']);
      assert.deepEqual(audit.findings[0].claimed_paths, [{ path: '4-context/second.md', record_ids: [secondId] }]);
      assert.ok(audit.findings[0].action.includes(`mole lifecycle withdraw ${secondId}`));
      assert.ok(audit.findings[0].action.includes(`mole lifecycle withdraw ${firstId}`));

      // A third copy is the first record's file until that record is withdrawn.
      const thirdSource = addSource(root, '4-context/third.md', template);
      assert.throws(() => register(root, thirdSource), (error) => {
        assert.equal(error.code, 'PATH_CLAIM_CONFLICT');
        assert.ok(error.message.includes(`mole lifecycle withdraw ${firstId}`));
        return true;
      });
      transition(root, firstId, 'withdraw');
      register(root, thirdSource);
      assert.equal(auditLifecycle(root).ok, true);
    });
  });

  it('names the duplicate record when a moved file was registered a second time', () => {
    withWorkspace((root) => {
      // The state an earlier version allowed: accept, move, register again.
      const first = accepted(root, '4-context/decision.md');
      const bytes = fs.readFileSync(path.join(root, '4-context', 'decision.md'));
      const duplicateId = register(root, addSource(root, '4-context/archive/decision.md', bytes));
      fs.rmSync(path.join(root, '4-context', 'decision.md'));

      assert.deepEqual(retrieveLifecycleRecords(root).excluded.map((item) => item.reason), ['source_unresolved']);
      const finding = auditLifecycle(root).findings[0];
      assert.equal(finding.type, 'source_unresolved');
      assert.equal(finding.record_id, first.recordId);
      assert.ok(finding.action.includes(`mole lifecycle withdraw ${duplicateId}`));

      // Relocating the original names the duplicate to withdraw, not to use.
      assert.throws(() => relocateLifecycleRecord(root, first.recordId, { path: '4-context/archive/decision.md', ...AGENT, reason: 'Archived', now: tick() }), (error) => {
        assert.equal(error.code, 'PATH_CLAIM_CONFLICT');
        assert.ok(error.message.includes(`mole lifecycle withdraw ${duplicateId}`));
        assert.ok(!error.message.includes('so use that record'));
        return true;
      });

      transition(root, duplicateId, 'withdraw');
      assert.equal(retrieveLifecycleRecord(root, first.recordId).path, '4-context/archive/decision.md');
      assert.equal(auditLifecycle(root).ok, true);
    });
  });

  it('does not guess between two unclaimed copies of a moved file', () => {
    withWorkspace((root) => {
      const { recordId } = accepted(root, '4-context/decision.md');
      const original = path.join(root, '4-context', 'decision.md');
      fs.mkdirSync(path.join(root, '4-context', 'archive'));
      fs.copyFileSync(original, path.join(root, '4-context', 'archive', 'decision.md'));
      fs.renameSync(original, path.join(root, '4-context', 'decision-copy.md'));

      assert.deepEqual(retrieveLifecycleRecords(root).excluded.map((item) => item.reason), ['source_unresolved']);
      const audit = auditLifecycle(root);
      assert.deepEqual(audit.findings.map((item) => item.type), ['source_unresolved']);
      assert.deepEqual(audit.findings[0].candidate_paths, ['4-context/archive/decision.md', '4-context/decision-copy.md']);

      reconcileSource(root, readLifecycleRecord(root, recordId).source_id, '4-context/archive/decision.md', { now: tick() });
      assert.equal(retrieveLifecycleRecord(root, recordId).path, '4-context/archive/decision.md');
    });
  });

  it('keeps the identity of a registered file that moved when migrating', () => {
    withWorkspace((root) => {
      const sourceId = addSource(root, '5-evidence/report.csv', 'a,b\n1,2\n');
      fs.mkdirSync(path.join(root, '5-evidence', 'archive'));
      fs.renameSync(path.join(root, '5-evidence', 'report.csv'), path.join(root, '5-evidence', 'archive', 'report.csv'));
      writeFile(root, '6-raw/inbox/dropped.md', 'a dropped note\n');

      const dryRun = migrateLifecycleRecords(root);
      assert.deepEqual(dryRun.candidates.map((item) => [item.path, item.source_id, item.proposed_state]), [
        ['5-evidence/archive/report.csv', sourceId, 'unreviewed'],
        ['6-raw/inbox/dropped.md', null, 'raw']
      ]);

      const result = migrateLifecycleRecords(root, { apply: true, ...AGENT, now: tick() });
      assert.equal(result.ok, true);
      assert.deepEqual(result.registered.map((item) => [item.path, item.state]), [
        ['5-evidence/archive/report.csv', 'unreviewed'],
        ['6-raw/inbox/dropped.md', 'raw']
      ]);
      assert.equal(result.registered[0].source_id, sourceId);
      assert.equal(fs.readdirSync(path.join(root, 'governance', 'sources', 'records')).length, 2);
      assert.ok(!findRegistryFindings(root).some((item) => item.type === 'duplicate_content'));
      assert.equal(auditLifecycle(root).ok, true);
      assert.equal(migrateLifecycleRecords(root).tracked, 2);
    });
  });

  it('skips migration when a moved source matches more than one file', () => {
    withWorkspace((root) => {
      addSource(root, '5-evidence/report.csv', 'a,b\n1,2\n');
      fs.mkdirSync(path.join(root, '5-evidence', 'archive'));
      fs.copyFileSync(path.join(root, '5-evidence', 'report.csv'), path.join(root, '5-evidence', 'archive', 'copy.csv'));
      fs.renameSync(path.join(root, '5-evidence', 'report.csv'), path.join(root, '5-evidence', 'archive', 'report.csv'));

      const result = migrateLifecycleRecords(root, { apply: true, ...AGENT, now: tick() });
      assert.equal(result.ok, false);
      assert.deepEqual(result.registered, []);
      assert.deepEqual(result.skipped.map((item) => item.reason), ['ambiguous_source', 'ambiguous_source']);
      assert.equal(fs.readdirSync(path.join(root, 'governance', 'sources', 'records')).length, 1);
    });
  });
});

describe('mutation lock placement', () => {
  it('serialises writers whose temporary folders differ', async () => {
    await withWorkspace(async (root) => {
      const sourceIds = Array.from({ length: 12 }, (_, index) => addSource(root, `6-raw/inbox/note-${index}.md`));
      const temps = [0, 1, 2].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'mole-lifecycle-tmp-')));
      const script = `
        const { registerLifecycleRecord } = await import(${JSON.stringify(lifecycleModuleUrl)});
        const result = registerLifecycleRecord(process.argv[1], {
          sourceId: process.argv[2], state: 'raw', actor: 'mole-cli', actorType: 'automation', lockWaitMs: 30000
        });
        process.stdout.write(result.record_id);
      `;
      try {
        const runs = await Promise.all(sourceIds.map((sourceId, index) => new Promise((resolve) => {
          const temp = temps[index % temps.length];
          const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, sourceId], {
            env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp },
            stdio: ['ignore', 'pipe', 'ignore']
          });
          let output = '';
          child.stdout.on('data', (chunk) => { output += chunk; });
          // The exit event can precede stdout draining; close waits for both.
          child.on('close', (code) => resolve({ code, recordId: output }));
        })));

        assert.deepEqual(runs.map((run) => run.code), sourceIds.map(() => 0));
        const ledger = readLedger(root);
        assert.equal(ledger.ledger_revision, sourceIds.length);
        // Every writer that reported success must be in the ledger.
        assert.deepEqual(ledger.records.map((record) => record.record_id).sort(), runs.map((run) => run.recordId).sort());
        assert.equal(validateLifecycleLedger(ledger).valid, true);
        assert.deepEqual(fs.readdirSync(path.dirname(ledgerPath(root))), ['records.json']);
      } finally {
        for (const temp of temps) fs.rmSync(temp, { recursive: true, force: true });
      }
    });
  });

  it('treats a lock from another machine as live until it is clearly old', () => {
    withWorkspace((root) => {
      const sourceId = addSource(root, '4-context/one.md');
      fs.mkdirSync(path.dirname(lockPathFor(root)), { recursive: true });
      fs.writeFileSync(lockPathFor(root), JSON.stringify({ token: 'synced', pid: 1, host: 'another-machine', acquired_at: new Date().toISOString() }));

      assert.throws(() => register(root, sourceId, 'draft', { lockWaitMs: 0 }), (error) => {
        assert.equal(error.code, 'LIFECYCLE_BUSY');
        assert.equal(error.details.holder_alive, true);
        return true;
      });
      assertRefused(() => unlockLifecycle(root), 'LOCK_HELD');
      assert.equal(assertLifecycleWritable(root).ok, true);

      const old = new Date(Date.now() - 10 * 60 * 1000);
      fs.utimesSync(lockPathFor(root), old, old);
      assert.throws(() => register(root, sourceId, 'draft', { lockWaitMs: 0 }), (error) => {
        assert.equal(error.code, 'LIFECYCLE_BUSY');
        assert.equal(error.details.holder_alive, false);
        return true;
      });
      assertRefused(() => assertLifecycleWritable(root), 'LIFECYCLE_BUSY');
      assert.deepEqual(auditLifecycle(root).findings.map((item) => item.type), ['stale_mutation_lock']);
      assert.equal(unlockLifecycle(root).removed, true);
      assert.equal(register(root, sourceId).length, 40);
    });
  });

  it('gives up on a lock path that exists but cannot be read', () => {
    withWorkspace((root) => {
      const sourceId = addSource(root, '4-context/one.md');
      fs.mkdirSync(path.dirname(lockPathFor(root)), { recursive: true });
      fs.symlinkSync(path.join(root, 'nowhere'), lockPathFor(root));

      const started = Date.now();
      assert.throws(() => register(root, sourceId, 'draft', { lockWaitMs: 200 }), (error) => {
        assert.equal(error.code, 'LIFECYCLE_BUSY');
        assert.match(error.message, /exists but is not a readable lock file/);
        return true;
      });
      assert.ok(Date.now() - started < 5000, 'acquisition must stop at its deadline');
      assert.equal(fs.existsSync(ledgerPath(root)), false);
      fs.unlinkSync(lockPathFor(root));
      assert.equal(register(root, sourceId).length, 40);
    });
  });

  it('refuses to write over a ledger that changed during the operation', () => {
    withWorkspace((root) => {
      const { recordId } = draftWithEvidence(root);
      const ledgerFile = ledgerPath(root);
      const originalRead = fs.readFileSync;
      let reads = 0;
      // Stand in for a sync tool that replaces the ledger between the read
      // at the start of the operation and the check just before the write.
      fs.readFileSync = function patched(target, ...rest) {
        if (target === ledgerFile) {
          reads += 1;
          if (reads === 2) fs.appendFileSync(ledgerFile, '\n');
        }
        return originalRead.call(fs, target, ...rest);
      };
      try {
        assertRefused(() => transition(root, recordId, 'submit'), 'LEDGER_CHANGED');
      } finally {
        fs.readFileSync = originalRead;
      }
      assert.equal(reads, 2);
      assert.equal(readLifecycleRecord(root, recordId).state, 'draft');
      assert.equal(fs.existsSync(lockPathFor(root)), false);
      assert.equal(transition(root, recordId, 'submit').state, 'pending_review');
    });
  });

  it('refuses a ledger that drops a record or rewrites an earlier history entry', () => {
    withWorkspace((root) => {
      const { recordId } = accepted(root, '4-context/one.md');
      draftWithEvidence(root, '4-context/two.md');
      const previous = readLedger(root);
      const mutate = (change) => {
        const next = structuredClone(previous);
        change(next, next.records.find((record) => record.record_id === recordId));
        return next;
      };
      const refused = (next) => assert.throws(() => assertAppendOnly(previous, next), (error) => error.code === 'HISTORY_REWRITE');

      assert.doesNotThrow(() => assertAppendOnly(previous, structuredClone(previous)));
      assert.doesNotThrow(() => assertAppendOnly(previous, mutate((next, record) => {
        record.history.push({ ...record.history.at(-1), revision: record.history.length + 1 });
      })));
      refused(mutate((next) => { next.records.pop(); }));
      refused(mutate((next, record) => { record.history[1].reason = 'rewritten'; }));
      refused(mutate((next, record) => { record.history[2].actor = 'Someone Else'; }));
      refused(mutate((next, record) => { record.history.splice(1, 1); }));
      refused(mutate((next, record) => { record.history.pop(); }));
      refused(mutate((next, record) => { record.source_id = previous.records[1].source_id; }));
    });
  });

  it('reports a ledger that cannot be written before a caller creates files', () => {
    withWorkspace((root) => {
      accepted(root, '4-context/one.md');
      assert.equal(assertLifecycleWritable(root).ok, true);
      const copy = path.join(path.dirname(ledgerPath(root)), 'records (conflicted copy).json');
      fs.copyFileSync(ledgerPath(root), copy);
      assertRefused(() => assertLifecycleWritable(root), 'LEDGER_CONFLICT');
      fs.rmSync(copy);
      fs.writeFileSync(ledgerPath(root), '{');
      assertRefused(() => assertLifecycleWritable(root), 'INVALID_LEDGER');
    });
  });
});

/**
 * A small JSON Schema checker covering the keywords the lifecycle schema uses.
 * It lets the tests check written ledgers against the published schema without
 * adding a dependency.
 */
function schemaErrors(schema, value, rootSchema = schema, at = '$') {
  const errors = [];
  const sub = (child, childValue, childAt = at) => schemaErrors(child, childValue, rootSchema, childAt);
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce((node, key) => node[key], rootSchema);
    errors.push(...sub(target, value));
  }
  const typeOf = (item) => (item === null ? 'null' : Array.isArray(item) ? 'array' : Number.isInteger(item) ? 'integer' : typeof item);
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) errors.push(`${at} must be ${allowed.join(' or ')}`);
  }
  if ('const' in schema && value !== schema.const) errors.push(`${at} must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at} must be one of the enum values`);
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at} must match ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at} is too short`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${at} is below the minimum`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at} has too few items`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${at} has duplicate items`);
    if (schema.items) value.forEach((item, index) => errors.push(...sub(schema.items, item, `${at}[${index}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${at}.${key} is required`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (key in value) errors.push(...sub(child, value[key], `${at}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties || {}))) errors.push(`${at}.${key} is not allowed`);
      }
    }
  }
  for (const child of schema.allOf || []) errors.push(...sub(child, value));
  if (schema.anyOf && !schema.anyOf.some((child) => sub(child, value).length === 0)) errors.push(`${at} matches no anyOf branch`);
  if (schema.if) {
    const branch = sub(schema.if, value).length === 0 ? schema.then : schema.else;
    if (branch) errors.push(...sub(branch, value));
  }
  return errors;
}

describe('review lifecycle schema', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'schemas', 'review-lifecycle-v1.schema.json'), 'utf8'));

  it('accepts every ledger the library writes and rejects the same hand edits', () => {
    withWorkspace((root) => {
      const old = accepted(root, '4-context/old.md');
      const next = draftWithEvidence(root, '4-context/new.md');
      transition(root, next.recordId, 'submit');
      transition(root, next.recordId, 'approve', { ...HUMAN, supersedes: [old.recordId] });
      const rejected = draftWithEvidence(root, '4-context/rejected.md');
      transition(root, rejected.recordId, 'submit');
      transition(root, rejected.recordId, 'reject', HUMAN);
      const moved = draftWithEvidence(root, '4-context/moved.md');
      writeFile(root, '4-context/moved-to.md', 'moved and edited\n');
      relocateLifecycleRecord(root, moved.recordId, { path: '4-context/moved-to.md', ...AGENT, reason: 'Renamed', now: tick() });
      const gone = accepted(root, '4-context/gone.md');
      transition(root, gone.recordId, 'withdraw', HUMAN);
      register(root, addSource(root, '6-raw/inbox/raw.md'), 'raw');

      const ledger = readLedger(root);
      assert.deepEqual(schemaErrors(schema, ledger), []);
      assert.deepEqual(validateLifecycleLedger(ledger), { valid: true, errors: [] });
      assert.deepEqual(schemaErrors(schema, { schema_version: 1, ledger_revision: 0, updated_at: null, records: [] }), []);

      const index = (state) => ledger.records.findIndex((record) => record.state === state);
      for (const [label, mutate] of [
        ['accepted without a decision', (copy) => { copy.records[index('accepted')].decision = null; }],
        ['accepted without support', (copy) => { copy.records[index('accepted')].source_ids = []; }],
        ['draft with a decision', (copy) => { copy.records[index('draft')].decision = copy.records[index('accepted')].decision; }],
        ['rejected marked accepted', (copy) => { copy.records[index('rejected')].decision.outcome = 'accepted'; }],
        ['approval by an agent', (copy) => { copy.records[index('accepted')].history.at(-1).actor_type = 'agent'; }],
        ['unconfirmed approval', (copy) => { copy.records[index('accepted')].history.at(-1).human_confirmed = false; }],
        ['agent withdrawal of accepted', (copy) => { copy.records[index('withdrawn')].history.at(-1).actor_type = 'agent'; }],
        ['registered as accepted', (copy) => { copy.records[index('raw')].history[0].to_state = 'accepted'; }],
        ['superseded without a link', (copy) => { copy.records[index('superseded')].superseded_by = null; }],
        ['link on a live record', (copy) => { copy.records[index('draft')].superseded_by = copy.records[index('accepted')].record_id; }],
        ['timestamp without milliseconds', (copy) => { copy.records[0].updated_at = '2026-10-01T09:00:00Z'; }],
        ['path with traversal', (copy) => { copy.records[0].path = '4-context/../../outside.md'; }],
        ['absolute path', (copy) => { copy.records[0].path = '/etc/passwd'; }],
        ['unknown state', (copy) => { copy.records[0].state = 'approved'; }],
        ['extra field', (copy) => { copy.records[0].approved = true; }]
      ]) {
        const copy = structuredClone(ledger);
        mutate(copy);
        assert.notDeepEqual(schemaErrors(schema, copy), [], `schema should reject: ${label}`);
        assert.equal(validateLifecycleLedger(copy).valid, false, `library should reject: ${label}`);
      }
    });
  });

  it('describes paths the same way the library validates them', () => {
    const pattern = new RegExp(schema.$defs.workspace_path.pattern);
    for (const good of ['a.md', '4-context/product/spec.md', '6-raw/inbox/2026 note (1).md', 'x/.hidden/y.md', 'a..b/c.md']) {
      assert.equal(pattern.test(good), true, good);
    }
    for (const bad of ['/abs.md', 'C:/x.md', 'a\\b.md', '../x.md', 'a/../b.md', 'a/./b.md', './a.md', 'a//b.md', 'a/', '.', '..']) {
      assert.equal(pattern.test(bad), false, bad);
    }
  });

  it('matches the states, actors, and actions the library enforces', () => {
    assert.deepEqual(schema.$defs.state.enum, LIFECYCLE_STATES);
    assert.deepEqual(schema.$defs.initial_state.enum, INITIAL_LIFECYCLE_STATES);
    assert.deepEqual(schema.$defs.actor_type.enum, ACTOR_TYPES);
    assert.deepEqual(schema.$defs.action.enum, ['register', ...LIFECYCLE_ACTIONS, 'replace', 'relocate']);
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
