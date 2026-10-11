import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  INPUT_QUEUE_LEDGER_REL_PATH,
  INPUT_QUEUE_LOCK_REL_PATH,
  INPUT_QUEUE_VIEW_END,
  INPUT_QUEUE_VIEW_REL_PATH,
  INPUT_QUEUE_VIEW_START,
  InputQueueError,
  addInputRequest,
  auditInputQueue,
  closeInputRequest,
  isCalendarDate,
  listInputRequests,
  migrateInputQueue,
  parseLegacyInputQueue,
  readInputRequest,
  refreshInputQueueView,
  reopenInputRequest,
  reviewInputQueue,
  unlockInputQueue,
  updateInputRequest,
  validateInputQueueLedger
} from '../input-queue.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const moleCliPath = path.join(repoRoot, 'cli', 'mole.mjs');

const AGENT = { actor: 'Drafting Agent', actorType: 'agent' };
const HUMAN = { actor: 'Sam PM', actorType: 'human', humanConfirmed: true };
const NOW = '2026-10-10T09:00:00.000Z';

function withWorkspace(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-input-queue-'));
  fs.mkdirSync(path.join(root, 'governance'), { recursive: true });
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function add(root, fields = {}, extra = {}) {
  return addInputRequest(root, {
    request: 'Which pricing tier is the default for new teams?',
    impact: 'The onboarding spec assumes the Team tier.',
    unblocks: 'Onboarding spec v2',
    ...AGENT,
    now: NOW,
    ...fields,
    ...extra
  }).input_id;
}

function readLedger(root) {
  return JSON.parse(fs.readFileSync(path.join(root, INPUT_QUEUE_LEDGER_REL_PATH), 'utf8'));
}

function readView(root) {
  return fs.readFileSync(path.join(root, INPUT_QUEUE_VIEW_REL_PATH), 'utf8');
}

function writeView(root, text) {
  fs.writeFileSync(path.join(root, INPUT_QUEUE_VIEW_REL_PATH), text);
}

function assertRefused(operation, code) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof InputQueueError, `expected InputQueueError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [moleCliPath, ...args], { cwd, encoding: 'utf8' });
}

const LEGACY_QUEUE = `# Human Input Queue (Ask the PM)

Keep this short.

## Active requests

| Priority | Request | Why this matters | Quick input format | Effort | Due | Status |
|---|---|---|---|---|---|---|
| High | Confirm the launch date for billing v2 | Marketing plan depends on it | A date | 2 min | 2026-10-12 | Open |
| Medium | Who owns the partner API \\| SDK decision? | Blocks the integration roadmap | A name | 2–5 min | end of month | Waiting |
| Low | Share the Q3 churn export | Needed for retention analysis | CSV in the inbox | 10 min | _TBD_ | In progress |
| High | _TBD_ | _TBD_ | _TBD_ | 2–5 min | _TBD_ | Open |

## Done

| Priority | Request | Why this matters | Status |
|---|---|---|---|
| High | Approve the pricing page copy | Launch blocker | Complete |

## Status values

- Open
`;

describe('input request records', () => {
  it('adds a request with a stable ID, history, and a generated view', () => {
    withWorkspace((root) => {
      const inputId = add(root, { priority: 'high', blocking: true, due: '2026-10-12', owner: 'Sam PM', references: ['4-context/onboarding.md'] });
      assert.match(inputId, /^inq_[0-9a-f-]{36}$/);

      const request = readInputRequest(root, inputId);
      assert.equal(request.status, 'open');
      assert.equal(request.requester, 'Drafting Agent');
      assert.equal(request.revision, 1);
      assert.deepEqual(request.history.map((entry) => entry.action), ['add']);
      assert.equal(request.created_at, NOW);

      const ledger = readLedger(root);
      assert.equal(ledger.schema_version, 1);
      assert.equal(ledger.queue_revision, 1);
      assert.equal(validateInputQueueLedger(ledger).valid, true);

      const view = readView(root);
      assert.ok(view.includes(INPUT_QUEUE_VIEW_START) && view.includes(INPUT_QUEUE_VIEW_END));
      assert.ok(view.includes(inputId));
      assert.ok(view.includes('Onboarding spec v2'));
    });
  });

  it('refuses a request without its impact or the output it unblocks', () => {
    withWorkspace((root) => {
      assertRefused(() => add(root, { impact: '  ' }), 'INVALID_ARGUMENT');
      assertRefused(() => add(root, { unblocks: undefined }), 'INVALID_ARGUMENT');
      assertRefused(() => add(root, { priority: 'urgent' }), 'INVALID_ARGUMENT');
      assertRefused(() => add(root, { due: '2026-02-30' }), 'INVALID_ARGUMENT');
      assertRefused(() => add(root, { sourceIds: ['not-a-source'] }), 'INVALID_ARGUMENT');
      assertRefused(() => add(root, {}, { actorType: 'robot' }), 'INVALID_ACTOR');
      assertRefused(() => add(root, {}, { actorType: 'agent', humanConfirmed: true }), 'INVALID_ACTOR');
      assert.equal(fs.existsSync(path.join(root, INPUT_QUEUE_LEDGER_REL_PATH)), false);
      assert.equal(isCalendarDate('2026-10-12'), true);
      assert.equal(isCalendarDate('2026-13-01'), false);
    });
  });

  it('records each changed field and keeps the earlier history', () => {
    withWorkspace((root) => {
      const inputId = add(root);
      const result = updateInputRequest(root, inputId, { priority: 'high', blocking: true, due: '2026-10-20', owner: 'Sam PM', ...AGENT, reason: 'The spec review moved up.', now: '2026-10-11T09:00:00.000Z' });
      assert.deepEqual(result.changed_fields.sort(), ['blocking', 'due', 'owner', 'priority']);
      const request = readInputRequest(root, inputId);
      assert.equal(request.revision, 2);
      assert.deepEqual(request.history[1].changes.priority, { from: 'medium', to: 'high' });
      assert.deepEqual(request.history[1].changes.owner, { from: null, to: 'Sam PM' });
      assert.equal(request.updated_at, '2026-10-11T09:00:00.000Z');

      assertRefused(() => updateInputRequest(root, inputId, { priority: 'high', ...AGENT, reason: 'Same again.' }), 'NO_CHANGE');
      assertRefused(() => updateInputRequest(root, inputId, { priority: 'low', ...AGENT }), 'REASON_REQUIRED');
      assertRefused(() => updateInputRequest(root, inputId, { status: 'closed', ...AGENT, reason: 'Done.' }), 'INVALID_ARGUMENT');
      assertRefused(() => updateInputRequest(root, inputId, { request: ' ', ...AGENT, reason: 'Blank.' }), 'INVALID_ARGUMENT');

      // A deferred request needs a date to come back on, unless a person says otherwise.
      assertRefused(() => updateInputRequest(root, inputId, { status: 'deferred', ...AGENT, reason: 'Parked.' }), 'NEXT_REVIEW_REQUIRED');
      updateInputRequest(root, inputId, { due: 'none', status: 'deferred', nextReview: '2026-11-01', ...AGENT, reason: 'Parked until the pricing review.' });
      assert.equal(readInputRequest(root, inputId).due, null);
      assert.equal(readInputRequest(root, inputId).status, 'deferred');
      assertRefused(() => updateInputRequest(root, inputId, { nextReview: 'none', ...AGENT, reason: 'No date.' }), 'NEXT_REVIEW_REQUIRED');
      updateInputRequest(root, inputId, { nextReview: 'none', ...HUMAN, reason: 'Parked for good.' });
      assert.equal(readInputRequest(root, inputId).next_review, null);
    });
  });

  it('lets only a confirmed human change an owner that is already set', () => {
    withWorkspace((root) => {
      const inputId = add(root, { owner: 'Sam PM' });
      assertRefused(() => updateInputRequest(root, inputId, { owner: 'Alex Lead', ...AGENT, reason: 'Sam is away.' }), 'HUMAN_CONFIRMATION_REQUIRED');
      assertRefused(() => updateInputRequest(root, inputId, { owner: 'Alex Lead', actor: 'Sam PM', actorType: 'human', reason: 'Not confirmed.' }), 'HUMAN_CONFIRMATION_REQUIRED');
      assert.equal(readInputRequest(root, inputId).owner, 'Sam PM');
      assert.equal(readInputRequest(root, inputId).revision, 1);

      updateInputRequest(root, inputId, { owner: 'Alex Lead', ...HUMAN, reason: 'Alex owns pricing now.' });
      const request = readInputRequest(root, inputId);
      assert.equal(request.owner, 'Alex Lead');
      assert.equal(request.history[1].human_confirmed, true);
    });
  });
});

describe('closing a request', () => {
  it('keeps who closed it, when, why, and what changed', () => {
    withWorkspace((root) => {
      const inputId = add(root);
      assertRefused(() => closeInputRequest(root, inputId, { ...AGENT, outcome: 'Spec updated.' }), 'INVALID_ARGUMENT');
      assertRefused(() => closeInputRequest(root, inputId, { ...AGENT, answer: 'Team tier.' }), 'INVALID_ARGUMENT');

      const closedAt = '2026-10-12T10:30:00.000Z';
      closeInputRequest(root, inputId, { ...AGENT, answer: 'Team tier, confirmed by Sam in chat.', outcome: 'Onboarding spec v2 now defaults to Team.', now: closedAt });
      const request = readInputRequest(root, inputId);
      assert.equal(request.status, 'closed');
      assert.deepEqual(request.closure, {
        reason: 'answered',
        answer: 'Team tier, confirmed by Sam in chat.',
        outcome: 'Onboarding spec v2 now defaults to Team.',
        closed_by: 'Drafting Agent',
        closed_by_type: 'agent',
        human_confirmed: false,
        closed_at: closedAt
      });
      assert.equal(request.history[1].action, 'close');
      assert.deepEqual(request.history[1].changes.status, { from: 'open', to: 'closed' });

      assertRefused(() => closeInputRequest(root, inputId, { ...AGENT, answer: 'Again.', outcome: 'Nothing.' }), 'REQUEST_CLOSED');
      assertRefused(() => updateInputRequest(root, inputId, { priority: 'low', ...AGENT, reason: 'Late.' }), 'REQUEST_CLOSED');
      assert.deepEqual(listInputRequests(root), []);
      assert.equal(listInputRequests(root, { all: true }).length, 1);
      assert.ok(!readView(root).includes(inputId));
      assert.ok(readView(root).includes('0 open or deferred, 1 closed'));
    });
  });

  it('needs a confirmed human to close a request that was not answered', () => {
    withWorkspace((root) => {
      const kept = add(root);
      const extra = add(root, { request: 'Default pricing tier for new teams?' });
      const closing = { closureReason: 'duplicate', duplicateOf: kept, outcome: 'One request remains.', reason: 'Same question asked twice.' };

      assertRefused(() => closeInputRequest(root, extra, { ...AGENT, ...closing }), 'HUMAN_CONFIRMATION_REQUIRED');
      assertRefused(() => closeInputRequest(root, extra, { ...HUMAN, ...closing, duplicateOf: null }), 'INVALID_ARGUMENT');
      assertRefused(() => closeInputRequest(root, extra, { ...HUMAN, ...closing, duplicateOf: extra }), 'INVALID_ARGUMENT');
      assertRefused(() => closeInputRequest(root, extra, { ...HUMAN, ...closing, reason: '' }), 'REASON_REQUIRED');
      assertRefused(() => closeInputRequest(root, extra, { ...HUMAN, closureReason: 'stale', duplicateOf: kept, outcome: 'x', reason: 'y' }), 'INVALID_ARGUMENT');
      for (const closureReason of ['stale', 'not_needed']) {
        assertRefused(() => closeInputRequest(root, extra, { ...AGENT, closureReason, outcome: 'Dropped.', reason: 'No longer needed.' }), 'HUMAN_CONFIRMATION_REQUIRED');
      }
      assert.equal(readInputRequest(root, extra).status, 'open');

      closeInputRequest(root, extra, { ...HUMAN, ...closing });
      const request = readInputRequest(root, extra);
      assert.equal(request.duplicate_of, kept);
      assert.equal(request.closure.reason, 'duplicate');
      assert.equal(request.closure.human_confirmed, true);

      // A closed request cannot stand in for another one.
      const third = add(root, { request: 'A third wording of the tier question' });
      assertRefused(() => closeInputRequest(root, third, { ...HUMAN, ...closing, duplicateOf: extra }), 'INVALID_LINK');
    });
  });

  it('reopens a closed request and keeps the closure in its history', () => {
    withWorkspace((root) => {
      const kept = add(root);
      const extra = add(root, { request: 'Default pricing tier for new teams?' });
      closeInputRequest(root, extra, { ...HUMAN, closureReason: 'duplicate', duplicateOf: kept, outcome: 'Merged.', reason: 'Same ask.' });
      assertRefused(() => reopenInputRequest(root, kept, { ...AGENT, reason: 'Not closed.' }), 'REQUEST_NOT_CLOSED');
      assertRefused(() => reopenInputRequest(root, extra, { ...AGENT }), 'REASON_REQUIRED');

      // A closure a person confirmed is theirs to undo.
      assertRefused(() => reopenInputRequest(root, extra, { ...AGENT, reason: 'It asks about a different plan.' }), 'HUMAN_CONFIRMATION_REQUIRED');
      reopenInputRequest(root, extra, { ...HUMAN, reason: 'It asks about a different plan after all.' });
      const request = readInputRequest(root, extra);
      assert.equal(request.status, 'open');
      assert.equal(request.closure, null);
      assert.equal(request.duplicate_of, null);
      assert.deepEqual(request.history.map((entry) => entry.action), ['add', 'close', 'reopen']);
      assert.equal(request.history[2].changes.closure.from.reason, 'duplicate');
      assert.equal(validateInputQueueLedger(readLedger(root)).valid, true);
    });
  });
});

describe('reviewing the queue', () => {
  it('ranks by blocking, priority, and due date, and explains each rank', () => {
    withWorkspace((root) => {
      const low = add(root, { request: 'Share the Q3 churn export', priority: 'low' });
      const blocking = add(root, { request: 'Confirm the launch date for billing', priority: 'medium', blocking: true });
      const overdue = add(root, { request: 'Name the partner API owner', priority: 'high', due: '2026-10-08' });
      const soon = add(root, { request: 'Approve the roadmap themes', priority: 'high', due: '2026-10-12' });
      const later = add(root, { request: 'Pick the beta cohort size', priority: 'high', due: '2026-10-16' });
      const plain = add(root, { request: 'Decide the support rota wording', priority: 'high' });

      const review = reviewInputQueue(root, { limit: 6, now: NOW });
      assert.deepEqual(review.top.map((item) => item.input_id), [overdue, blocking, soon, later, plain, low]);
      assert.deepEqual(review.top.map((item) => item.score), [60, 60, 50, 40, 30, 10]);
      // Equal scores go to the request with the earlier due date.
      assert.deepEqual(review.top[0].reasons, ['high priority', 'overdue by 2 days']);
      assert.deepEqual(review.top[1].reasons, ['blocks work', 'medium priority']);
      assert.deepEqual(review.top[2].reasons, ['high priority', 'due in 2 days']);
      assert.deepEqual(review.top[3].reasons, ['high priority', 'due in 6 days']);
      assert.equal(review.top[0].unblocks, 'Onboarding spec v2');
      assert.equal(review.read_only, true);
      assert.equal(review.status_counts.open, 6);
    });
  });

  it('returns a bounded set of top asks from a large queue', () => {
    withWorkspace((root) => {
      for (let index = 0; index < 57; index += 1) {
        add(root, {
          request: `Decision ${index} about workstream ${String.fromCharCode(97 + (index % 26))}${index}`,
          priority: ['low', 'medium', 'high'][index % 3],
          blocking: index === 41
        });
      }
      const review = reviewInputQueue(root, { now: NOW });
      assert.equal(review.top.length, 3);
      assert.equal(review.reviewable_count, 57);
      assert.equal(review.not_shown, 54);
      assert.match(review.top[0].request, /^Decision 41 /);
      assert.ok(review.top.every((item) => item.reasons.length > 0));
      assert.equal(reviewInputQueue(root, { limit: 10, now: NOW }).top.length, 10);
      assertRefused(() => reviewInputQueue(root, { limit: 0 }), 'INVALID_ARGUMENT');
      assertRefused(() => reviewInputQueue(root, { limit: 500 }), 'INVALID_ARGUMENT');
    });
  });

  it('leaves out closed and deferred requests until a deferred one is due for review', () => {
    withWorkspace((root) => {
      const open = add(root);
      const closed = add(root, { request: 'Approve the pricing page copy' });
      const deferred = add(root, { request: 'Revisit the enterprise discount policy' });
      closeInputRequest(root, closed, { ...AGENT, answer: 'Approved.', outcome: 'Copy shipped.', now: NOW });
      updateInputRequest(root, deferred, { status: 'deferred', nextReview: '2026-10-20', ...AGENT, reason: 'After the pricing review.', now: NOW });

      assert.deepEqual(reviewInputQueue(root, { now: NOW }).top.map((item) => item.input_id), [open]);
      const later = reviewInputQueue(root, { now: '2026-10-20T08:00:00.000Z' });
      assert.deepEqual(later.top.map((item) => item.input_id).sort(), [deferred, open].sort());
      assert.ok(later.top.find((item) => item.input_id === deferred).reasons.includes('deferred, review date reached'));
    });
  });

  it('suggests stale requests without closing them', () => {
    withWorkspace((root) => {
      const old = add(root, {}, { now: '2026-09-01T09:00:00.000Z' });
      const fresh = add(root, { request: 'Approve the roadmap themes' }, { now: '2026-10-09T09:00:00.000Z' });
      const pastDue = add(root, { request: 'Name the partner API owner', due: '2026-10-05' }, { now: '2026-10-09T09:00:00.000Z' });

      const review = reviewInputQueue(root, { now: NOW });
      assert.deepEqual(review.stale_candidates.map((item) => item.input_id).sort(), [old, pastDue].sort());
      assert.deepEqual(review.stale_candidates.find((item) => item.input_id === old).reasons, ['not updated for 39 days']);
      assert.deepEqual(review.stale_candidates.find((item) => item.input_id === pastDue).reasons, ['due date 2026-10-05 has passed']);
      assert.match(review.stale_candidates[0].suggestion, /Nothing was closed/);
      assert.ok(review.top.find((item) => item.input_id === old).reasons.includes('untouched for 39 days'));
      assert.equal(reviewInputQueue(root, { now: NOW, staleAfterDays: 60 }).stale_candidates.some((item) => item.input_id === old), false);

      // Reporting changed nothing.
      for (const inputId of [old, fresh, pastDue]) assert.equal(readInputRequest(root, inputId).status, 'open');
      assert.equal(readLedger(root).queue_revision, 3);
    });
  });

  it('suggests likely duplicates with the shared terms and leaves distinct asks alone', () => {
    withWorkspace((root) => {
      const first = add(root, { request: 'Which pricing tier is the default for new teams?' }, { now: '2026-10-01T09:00:00.000Z' });
      const second = add(root, { request: 'Default pricing tier for new teams, please confirm' }, { now: '2026-10-02T09:00:00.000Z' });
      const distinct = add(root, { request: 'Which pricing page copy should the launch email link to?' });
      const closedTwin = add(root, { request: 'Default pricing tier for new teams?' });
      closeInputRequest(root, closedTwin, { ...AGENT, answer: 'Team.', outcome: 'Recorded.', now: NOW });

      const review = reviewInputQueue(root, { now: NOW });
      assert.equal(review.duplicate_candidate_count, 1);
      const [pair] = review.duplicate_candidates;
      assert.deepEqual(pair.input_ids, [first, second]);
      assert.equal(pair.similarity, 1);
      assert.deepEqual(pair.shared_terms, ['default', 'new', 'pricing', 'teams', 'tier']);
      assert.ok(pair.suggestion.includes(`mole input-queue close ${second} --closure-reason duplicate --duplicate-of ${first}`));
      assert.match(pair.suggestion, /Nothing was closed/);
      assert.ok(!review.duplicate_candidates.some((item) => item.input_ids.includes(distinct)));
      assert.equal(readInputRequest(root, second).status, 'open');

      assert.equal(reviewInputQueue(root, { now: NOW, duplicateThreshold: 0.1 }).duplicate_candidate_count, 3);
    });
  });

  it('bounds the duplicate suggestions for a queue of near-identical requests', () => {
    withWorkspace((root) => {
      const base = add(root);
      const ledgerPath = path.join(root, INPUT_QUEUE_LEDGER_REL_PATH);
      const ledger = readLedger(root);
      const template = ledger.requests[0];
      for (let index = 1; index < 1200; index += 1) {
        const inputId = `inq_${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`;
        ledger.requests.push({ ...template, input_id: inputId, request: `${template.request} (${index})` });
      }
      fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
      const started = Date.now();
      const review = reviewInputQueue(root, { now: NOW });
      assert.equal(review.duplicate_candidates.length, 20);
      assert.equal(review.duplicate_candidate_count, (1200 * 1199) / 2);
      assert.ok(review.duplicate_candidates[0].input_ids.includes(base));
      assert.ok(Date.now() - started < 20000);
    });
  });
});

describe('legacy Markdown queue', () => {
  it('ranks legacy rows before migration without writing anything', () => {
    withWorkspace((root) => {
      writeView(root, LEGACY_QUEUE);
      const review = reviewInputQueue(root, { limit: 5, now: NOW });
      assert.equal(review.legacy_rows, 4);
      assert.equal(review.reviewable_count, 3);
      assert.deepEqual(review.top.map((item) => item.input_id), ['legacy:9', 'legacy:10', 'legacy:11']);
      assert.equal(review.top[0].request, 'Confirm the launch date for billing v2');
      assert.deepEqual(review.top[0].reasons, ['high priority', 'due in 2 days']);
      assert.equal(review.top[1].request, 'Who owns the partner API | SDK decision?');
      assert.equal(review.top[1].status, 'waiting');
      assert.match(review.notice, /mole input-queue migrate --apply/);
      assert.equal(review.stale_candidate_count, 0);
      assert.equal(readView(root), LEGACY_QUEUE);
      assert.equal(fs.existsSync(path.join(root, INPUT_QUEUE_LEDGER_REL_PATH)), false);
    });
  });

  it('migrates rows without losing their text and keeps the original file', () => {
    withWorkspace((root) => {
      writeView(root, LEGACY_QUEUE);
      const plan = migrateInputQueue(root);
      assert.equal(plan.applied, false);
      assert.deepEqual(plan.candidates.map((item) => item.line), [9, 10, 11, 18]);
      assert.deepEqual(plan.skipped.map((item) => item.reason), ['placeholder_row']);
      assert.equal(readView(root), LEGACY_QUEUE);

      assertRefused(() => add(root), 'MIGRATION_REQUIRED');
      assertRefused(() => migrateInputQueue(root, { apply: true }), 'INVALID_ACTOR');

      const result = migrateInputQueue(root, { apply: true, ...AGENT, now: NOW });
      assert.equal(result.migrated.length, 4);
      assert.match(result.legacy_copy, /^governance\/input-queue\/legacy\/input-queue-20261010T090000000Z\.md$/);
      assert.equal(fs.readFileSync(path.join(root, result.legacy_copy), 'utf8'), LEGACY_QUEUE);

      const requests = listInputRequests(root, { all: true });
      assert.equal(requests.length, 4);
      const rows = LEGACY_QUEUE.split('\n');
      for (const request of requests) {
        assert.match(request.input_id, /^inq_/);
        assert.equal(request.legacy.row, rows[request.legacy.line - 1]);
        assert.equal(request.history[0].action, 'migrate');
        assert.equal(request.requester, 'legacy queue');
      }
      const [launch, owner, churn, done] = requests;
      assert.deepEqual([launch.priority, launch.status, launch.due], ['high', 'open', '2026-10-12']);
      assert.equal(launch.answer_format, 'A date');
      assert.deepEqual([owner.priority, owner.status, owner.due], ['medium', 'waiting', null]);
      assert.equal(owner.legacy.columns.Due, 'end of month');
      assert.deepEqual([churn.priority, churn.status], ['low', 'in_progress']);
      assert.equal(done.status, 'closed');
      assert.equal(done.closure.answer, null);
      assert.match(done.closure.outcome, /legacy queue/);

      // The tables are replaced by the generated view; other text stays.
      const view = readView(root);
      assert.ok(view.startsWith('# Human Input Queue (Ask the PM)\n\nKeep this short.\n'));
      assert.ok(view.includes('## Done') && view.includes('## Status values'));
      assert.equal(view.split(INPUT_QUEUE_VIEW_START).length, 2);
      assert.ok(!view.includes('| High | Confirm the launch date'));
      assert.ok(view.includes(launch.input_id) && view.includes('Who owns the partner API \\| SDK decision?'));
      assert.deepEqual(parseLegacyInputQueue(view).tables.map((table) => table.inView), [true]);

      // A second run finds nothing, and a row added by hand later is picked up.
      const again = migrateInputQueue(root, { apply: true, ...AGENT });
      assert.deepEqual(again.migrated, []);
      assert.equal(again.legacy_copy, null);
      assert.equal(readLedger(root).queue_revision, 1);

      writeView(root, `${readView(root)}\n| Priority | Request | Status |\n|---|---|---|\n| P1 | Confirm the beta cohort size | Open |\n`);
      assert.equal(auditInputQueue(root).findings[0].type, 'legacy_rows_pending');
      const third = migrateInputQueue(root, { apply: true, ...AGENT, now: '2026-10-11T09:00:00.000Z' });
      assert.equal(third.migrated.length, 1);
      assert.equal(readInputRequest(root, third.migrated[0].input_id).priority, 'high');
      assert.equal(listInputRequests(root, { all: true }).length, 5);
      assert.equal(readView(root).split(INPUT_QUEUE_VIEW_START).length, 2);
      assert.equal(auditInputQueue(root).ok, true);
    });
  });

  it('replaces the starter placeholder table on the first request', () => {
    withWorkspace((root) => {
      fs.copyFileSync(path.join(repoRoot, 'governance', 'input-queue.md'), path.join(root, INPUT_QUEUE_VIEW_REL_PATH));
      const inputId = add(root);
      const view = readView(root);
      assert.equal(view.split(INPUT_QUEUE_VIEW_START).length, 2);
      assert.ok(view.includes(inputId));
      assert.ok(view.includes('## Monday briefing view'));
      assert.ok(!view.includes('_No open requests._'));

      // An older starter file has a placeholder row and no markers.
      const olderRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-input-queue-old-'));
      try {
        fs.mkdirSync(path.join(olderRoot, 'governance'));
        writeView(olderRoot, '# Queue\n\n| Priority | Request | Status |\n|---|---|---|\n| High | _TBD_ | Open |\n\nNotes stay.\n');
        const olderId = add(olderRoot);
        const older = readView(olderRoot);
        assert.ok(older.includes(olderId) && older.includes('Notes stay.'));
        assert.ok(!older.includes('_TBD_'));
      } finally {
        fs.rmSync(olderRoot, { recursive: true, force: true });
      }
    });
  });
});

describe('text a person wrote in the queue file', () => {
  it('imports a row added by hand inside the generated table instead of dropping it', () => {
    withWorkspace((root) => {
      const first = add(root);
      const before = readView(root);
      const handRow = '| | high | no | Confirm the beta cohort size | Needed for the launch plan | Launch plan | | | | open |';
      writeView(root, before.replace('\n\n1 open or deferred', `\n${handRow}\n\n1 open or deferred`));

      const audit = auditInputQueue(root);
      assert.deepEqual(audit.findings.map((item) => item.type), ['legacy_rows_pending']);
      assert.equal(migrateInputQueue(root).candidates.length, 1);
      assert.equal(reviewInputQueue(root, { now: NOW }).legacy_rows, 1);

      // Every change that rewrites the table is refused until the row is imported.
      assertRefused(() => add(root, { request: 'Something else entirely' }), 'MIGRATION_REQUIRED');
      assertRefused(() => updateInputRequest(root, first, { priority: 'low', ...AGENT, reason: 'x' }), 'MIGRATION_REQUIRED');
      assertRefused(() => closeInputRequest(root, first, { ...AGENT, answer: 'a', outcome: 'b' }), 'MIGRATION_REQUIRED');
      assertRefused(() => refreshInputQueueView(root), 'MIGRATION_REQUIRED');
      assert.ok(readView(root).includes(handRow));

      const result = migrateInputQueue(root, { apply: true, ...AGENT, now: NOW });
      assert.equal(result.migrated.length, 1);
      assert.ok(fs.readFileSync(path.join(root, result.legacy_copy), 'utf8').includes(handRow));
      const imported = readInputRequest(root, result.migrated[0].input_id);
      assert.equal(imported.request, 'Confirm the beta cohort size');
      assert.equal(imported.unblocks, 'Launch plan');
      assert.equal(imported.legacy.row, handRow);
      assert.ok(readView(root).includes(imported.input_id));
      assert.equal(auditInputQueue(root).ok, true);
    });
  });

  it('refuses to rewrite the table when its markers are malformed', () => {
    withWorkspace((root) => {
      const notes = '## Notes\n\nAsk legal about the DPA before 1 Nov.\n';
      for (const text of [
        `# Queue\n\n${INPUT_QUEUE_VIEW_START}\n\n${notes}`,
        `# Queue\n\n${INPUT_QUEUE_VIEW_END}\n\n${notes}\n${INPUT_QUEUE_VIEW_START}\n`,
        `# Queue\n\n${INPUT_QUEUE_VIEW_START}\n${INPUT_QUEUE_VIEW_START}\n${INPUT_QUEUE_VIEW_END}\n\n${notes}`
      ]) {
        writeView(root, text);
        assertRefused(() => add(root), 'INVALID_QUEUE_VIEW');
        assert.equal(readView(root), text);
        assert.equal(fs.existsSync(path.join(root, INPUT_QUEUE_LEDGER_REL_PATH)), false);
        assert.deepEqual(auditInputQueue(root).findings.map((item) => item.type), ['view_markers_invalid']);
      }
    });
  });

  it('does not take prose that names a marker for the marker itself', () => {
    withWorkspace((root) => {
      const prose = `The table sits between \`${INPUT_QUEUE_VIEW_START}\` and \`${INPUT_QUEUE_VIEW_END}\`.\n\nKeep this paragraph.\n`;
      writeView(root, `# Queue\n\n${prose}`);
      const inputId = add(root);
      add(root, { request: 'A second ask about onboarding' });
      const view = readView(root);
      assert.ok(view.includes(prose));
      assert.ok(view.includes(inputId));
      assert.equal(view.split('\n').filter((line) => line.trim() === INPUT_QUEUE_VIEW_START).length, 1);
      assert.equal(auditInputQueue(root).ok, true);
    });
  });

  it('keeps a copy of the file before removing a row it cannot import', () => {
    withWorkspace((root) => {
      const text = '# Queue\n\n| Priority | Request | Why this matters | Status |\n|---|---|---|---|\n| High | TBD | Remember to ask legal about the DPA before 1 Nov | Open |\n';
      writeView(root, text);
      assert.deepEqual(migrateInputQueue(root).skipped.map((item) => item.reason), ['request_missing']);
      assert.deepEqual(auditInputQueue(root).findings.map((item) => item.type), ['legacy_rows_without_request']);

      const result = addInputRequest(root, { request: 'Which tier is the default?', impact: 'Spec', unblocks: 'Spec v2', ...AGENT, now: NOW });
      assert.match(result.legacy_copy, /^governance\/input-queue\/legacy\/input-queue-/);
      assert.equal(fs.readFileSync(path.join(root, result.legacy_copy), 'utf8'), text);
      assert.ok(!readView(root).includes('DPA'));

      // A starter table with only placeholders needs no copy.
      const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-input-queue-plain-'));
      try {
        fs.mkdirSync(path.join(plain, 'governance'));
        writeView(plain, '# Queue\n\n| Priority | Request | Status |\n|---|---|---|\n| High | _TBD_ | Open |\n');
        assert.equal(addInputRequest(plain, { request: 'An ask', impact: 'x', unblocks: 'y', ...AGENT }).legacy_copy, undefined);
      } finally {
        fs.rmSync(plain, { recursive: true, force: true });
      }
    });
  });

  it('leaves a table alone when it is not a request queue', () => {
    withWorkspace((root) => {
      const apiNotes = '| Request | Response |\n|---|---|\n| GET /users | 200 list |\n';
      writeView(root, `# Queue\n\n${apiNotes}\n| Priority | Request | Status |\n|---|---|---|\n| High | Confirm the launch date | Open |\n`);
      const result = migrateInputQueue(root, { apply: true, ...AGENT, now: NOW });
      assert.deepEqual(result.migrated.map((item) => item.request), ['Confirm the launch date']);
      assert.ok(readView(root).includes(apiNotes));
    });
  });

  it('keeps CRLF line endings and escapes marker text in a request', () => {
    withWorkspace((root) => {
      writeView(root, '# Queue\r\n\r\nNotes stay.\r\n');
      add(root, { request: `Is ${INPUT_QUEUE_VIEW_END} safe in a request?` });
      add(root, { request: 'A second ask about onboarding' });
      const view = readView(root);
      assert.ok(view.startsWith('# Queue\r\n\r\nNotes stay.\r\n'));
      assert.equal(view.replace(/\r\n/g, '').includes('\n'), false);
      assert.ok(view.includes('Is &lt;!-- mole:input-queue:end --> safe'));
      assert.equal(auditInputQueue(root).ok, true);
      assert.equal(listInputRequests(root).length, 2);
    });
  });

  it('does not import rows twice when the table could not be rewritten', () => {
    withWorkspace((root) => {
      writeView(root, LEGACY_QUEUE);
      const viewPath = path.join(root, INPUT_QUEUE_VIEW_REL_PATH);
      // The ledger is written, then replacing the Markdown file fails.
      const renameSync = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (to === viewPath) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return renameSync(from, to);
      };
      let result;
      try {
        result = migrateInputQueue(root, { apply: true, ...AGENT, now: NOW });
      } finally {
        fs.renameSync = renameSync;
      }
      assert.equal(result.ok, true);
      assert.equal(result.migrated.length, 4);
      assert.equal(result.view.stale, true);
      assert.match(result.view.warning, /Do not repeat the command\. Run "mole input-queue refresh-view"/);
      assert.equal(readView(root), LEGACY_QUEUE);

      // The rows are known, so nothing is ranked or imported a second time.
      assert.equal(reviewInputQueue(root, { now: NOW }).legacy_rows, 0);
      assert.equal(reviewInputQueue(root, { now: NOW, limit: 10 }).top.length, 3);
      assert.deepEqual(migrateInputQueue(root, { apply: true, ...AGENT }).migrated, []);
      assert.equal(listInputRequests(root, { all: true }).length, 4);
      assert.deepEqual(auditInputQueue(root).findings.map((item) => item.type), ['view_stale']);

      assert.equal(refreshInputQueueView(root).view.changed, true);
      assert.ok(!readView(root).includes('| High | Confirm the launch date'));
      assert.equal(auditInputQueue(root).ok, true);
      assert.equal(refreshInputQueueView(root).view.changed, false);
    });
  });

  it('leaves a table outside the block alone when it lists requests by ID', () => {
    withWorkspace((root) => {
      const inputId = add(root);
      const notes = `| ID | Request | Status | My notes |\n|---|---|---|---|\n| ${inputId} | Tier question | open | Ask Sam on Tuesday |\n`;
      writeView(root, `${readView(root)}\n## My notes\n\n${notes}`);
      assert.deepEqual(auditInputQueue(root).findings.map((item) => item.type), ['request_table_outside_view']);

      const result = addInputRequest(root, { request: 'A second ask about onboarding', impact: 'x', unblocks: 'y', ...AGENT, now: NOW });
      assert.equal(result.legacy_copy, undefined);
      assert.ok(readView(root).includes(notes));
      assert.equal(readView(root).split(INPUT_QUEUE_VIEW_START).length, 2);
    });
  });

  it('keeps a copy before replacing text typed inside the generated block', () => {
    withWorkspace((root) => {
      const inputId = add(root);
      const original = readView(root);
      const typed = original
        .replace('\n\n1 open or deferred', '\n| | high | yes | | Why text with no request | | | | | open |\n\n1 open or deferred')
        .replace(INPUT_QUEUE_VIEW_END, `Remember to chase legal.\n${INPUT_QUEUE_VIEW_END}`);
      writeView(root, typed);
      assert.deepEqual(auditInputQueue(root).findings.map((item) => item.type).sort(), ['legacy_rows_without_request', 'unmanaged_text_in_view']);

      // Refreshing the view keeps the file as it was first.
      const refreshed = refreshInputQueueView(root, { now: NOW });
      assert.match(refreshed.legacy_copy, /^governance\/input-queue\/legacy\//);
      assert.equal(fs.readFileSync(path.join(root, refreshed.legacy_copy), 'utf8'), typed);
      assert.equal(readView(root), original);
      assert.equal(auditInputQueue(root).ok, true);

      // So does any other change, and an untouched file needs no copy.
      writeView(root, typed);
      const updated = updateInputRequest(root, inputId, { priority: 'high', ...AGENT, reason: 'Sooner.', now: '2026-10-11T09:00:00.000Z' });
      assert.equal(fs.readFileSync(path.join(root, updated.legacy_copy), 'utf8'), typed);
      assert.ok(!readView(root).includes('chase legal'));
      assert.equal(updateInputRequest(root, inputId, { priority: 'low', ...AGENT, reason: 'Later.' }).legacy_copy, undefined);
      assert.equal(refreshInputQueueView(root).legacy_copy, undefined);
    });
  });

  it('does not import rows twice when lines shift before the table is rewritten', () => {
    withWorkspace((root) => {
      writeView(root, LEGACY_QUEUE);
      const viewPath = path.join(root, INPUT_QUEUE_VIEW_REL_PATH);
      const renameSync = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (to === viewPath) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return renameSync(from, to);
      };
      try {
        migrateInputQueue(root, { apply: true, ...AGENT, now: NOW });
      } finally {
        fs.renameSync = renameSync;
      }
      // Someone edits the file before the rewrite is retried.
      writeView(root, `A new first line.\n\n${LEGACY_QUEUE}`);
      assert.equal(reviewInputQueue(root, { now: NOW }).view_pending, true);
      assert.deepEqual(migrateInputQueue(root).candidates, []);
      assert.deepEqual(migrateInputQueue(root, { apply: true, ...AGENT }).migrated, []);
      assert.equal(listInputRequests(root, { all: true }).length, 4);
      refreshInputQueueView(root);
      assert.ok(readView(root).startsWith('A new first line.\n'));
      assert.equal(auditInputQueue(root).ok, true);

      // Once the rewrite is done, the same row typed again is a new request.
      writeView(root, `${readView(root)}\n| Priority | Request | Status |\n|---|---|---|\n| High | Confirm the launch date for billing v2 | Open |\n`);
      assert.equal(migrateInputQueue(root).candidates.length, 1);
    });
  });

  it('gives a deferred legacy row a review date so it comes back', () => {
    withWorkspace((root) => {
      writeView(root, '# Queue\n\n| Priority | Request | Status |\n|---|---|---|\n| Low | Revisit the discount policy | Deferred |\n');
      const result = migrateInputQueue(root, { apply: true, ...AGENT, now: NOW });
      const request = readInputRequest(root, result.migrated[0].input_id);
      assert.deepEqual([request.status, request.next_review], ['deferred', '2026-10-10']);
      assert.deepEqual(reviewInputQueue(root, { now: NOW }).top.map((item) => item.input_id), [request.input_id]);
    });
  });

  it('finds the block below an unclosed code fence', () => {
    withWorkspace((root) => {
      writeView(root, '# Queue\n\n```\nexample that never closes\n');
      add(root);
      add(root, { request: 'A second ask about onboarding' });
      refreshInputQueueView(root);
      assert.equal(readView(root).split('\n').filter((line) => line.trim() === INPUT_QUEUE_VIEW_START).length, 1);
      assert.equal(auditInputQueue(root).ok, true);
    });
  });

  it('reports a queue file that is not a regular file', () => {
    withWorkspace((root) => {
      fs.mkdirSync(path.join(root, INPUT_QUEUE_VIEW_REL_PATH));
      assertRefused(() => add(root), 'INVALID_QUEUE_VIEW');
      assertRefused(() => reviewInputQueue(root), 'INVALID_QUEUE_VIEW');
      assert.deepEqual(auditInputQueue(root).findings.map((item) => item.type), ['view_unreadable']);
      assert.equal(fs.existsSync(path.join(root, INPUT_QUEUE_LEDGER_REL_PATH)), false);
    });
  });

  it('refuses a legacy folder that is a link leaving the workspace', () => {
    withWorkspace((root) => {
      writeView(root, LEGACY_QUEUE);
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-input-queue-outside-'));
      try {
        fs.mkdirSync(path.join(root, 'governance', 'input-queue'));
        fs.symlinkSync(outside, path.join(root, 'governance', 'input-queue', 'legacy'));
        assertRefused(() => migrateInputQueue(root, { apply: true, ...AGENT }), 'INVALID_QUEUE');
        assert.deepEqual(fs.readdirSync(outside), []);
        assert.equal(readView(root), LEGACY_QUEUE);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });
});

describe('ledger safety', () => {
  it('refuses to run on an invalid ledger and reports it in the audit', () => {
    withWorkspace((root) => {
      const inputId = add(root);
      const ledgerPath = path.join(root, INPUT_QUEUE_LEDGER_REL_PATH);
      const ledger = readLedger(root);
      ledger.requests[0].history[0].actor = 'Someone Else';
      ledger.requests[0].priority = 'urgent';
      fs.writeFileSync(ledgerPath, JSON.stringify(ledger));

      assertRefused(() => add(root, { request: 'Another ask entirely' }), 'INVALID_QUEUE');
      assertRefused(() => reviewInputQueue(root), 'INVALID_QUEUE');
      assertRefused(() => readInputRequest(root, inputId), 'INVALID_QUEUE');
      const audit = auditInputQueue(root);
      assert.equal(audit.ok, false);
      assert.equal(audit.findings[0].type, 'invalid_queue');
      assert.match(audit.findings[0].errors.join('\n'), /priority must be one of/);

      fs.writeFileSync(ledgerPath, '{ not json');
      assert.equal(auditInputQueue(root).findings[0].type, 'invalid_queue');
    });
  });

  it('validates links, closure, and history shape', () => {
    withWorkspace((root) => {
      const inputId = add(root);
      const base = readLedger(root);
      const broken = (mutate) => {
        const copy = JSON.parse(JSON.stringify(base));
        mutate(copy.requests[0], copy);
        return validateInputQueueLedger(copy).errors.join('\n');
      };
      assert.match(broken((request) => { request.status = 'closed'; }), /closure is required/);
      assert.match(broken((request) => { request.closure = { reason: 'answered' }; }), /closure must be null/);
      assert.match(broken((request) => { request.duplicate_of = inputId; }), /cannot name the request itself/);
      assert.match(broken((request) => { request.duplicate_of = 'inq_00000000-0000-4000-8000-000000000000'; }), /not in the queue/);
      assert.match(broken((request) => { request.history[0].revision = 2; }), /revision must be 1/);
      assert.match(broken((request) => { request.history[0].human_confirmed = true; }), /requires actor_type human/);
      assert.match(broken((request) => { request.extra = 1; }), /not a known field/);
      assert.match(broken((request, ledger) => { ledger.requests.push({ ...request }); }), /used by more than one request/);
      assert.equal(validateInputQueueLedger(null).valid, false);
    });
  });

  it('refuses a change while another process holds the lock', () => {
    withWorkspace((root) => {
      const inputId = add(root);
      const lockPath = path.join(root, INPUT_QUEUE_LOCK_REL_PATH);
      fs.writeFileSync(lockPath, JSON.stringify({ token: 'other', pid: process.pid, host: os.hostname(), acquired_at: NOW }));
      assertRefused(() => add(root, { request: 'A second ask' }, { lockWaitMs: 0 }), 'INPUT_QUEUE_BUSY');
      assertRefused(() => unlockInputQueue(root), 'INPUT_QUEUE_BUSY');
      assert.equal(listInputRequests(root).length, 1);

      const stopped = spawnSync(process.execPath, ['-e', '']);
      fs.writeFileSync(lockPath, JSON.stringify({ token: 'gone', pid: stopped.pid, host: os.hostname(), acquired_at: NOW }));
      assert.throws(() => add(root, { request: 'A second ask' }, { lockWaitMs: 0 }), (error) => {
        assert.equal(error.code, 'INPUT_QUEUE_BUSY');
        assert.match(error.message, /mole input-queue unlock/);
        return true;
      });
      assert.equal(auditInputQueue(root).findings[0].type, 'stale_lock');
      fs.writeFileSync(lockPath, JSON.stringify({ token: 'far', pid: 1, host: 'another-host', acquired_at: NOW }));
      assert.equal(auditInputQueue(root).findings[0].type, 'foreign_lock');
      assertRefused(() => unlockInputQueue(root), 'INPUT_QUEUE_BUSY');
      fs.writeFileSync(lockPath, JSON.stringify({ token: 'gone', pid: stopped.pid, host: os.hostname(), acquired_at: NOW }));
      assert.equal(unlockInputQueue(root).removed, true);
      assert.equal(unlockInputQueue(root).removed, false);
      updateInputRequest(root, inputId, { priority: 'low', ...AGENT, reason: 'Lock is gone.' });
    });
  });

  it('refuses a queue folder that is a link leaving the workspace', () => {
    withWorkspace((root) => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-input-queue-outside-'));
      try {
        fs.symlinkSync(outside, path.join(root, 'governance', 'input-queue'));
        assertRefused(() => add(root), 'INVALID_QUEUE');
        assert.deepEqual(fs.readdirSync(outside), []);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });
});

describe('mole input-queue CLI', () => {
  const agentFlags = ['--actor', 'Drafting Agent', '--actor-type', 'agent'];
  const humanFlags = ['--actor', 'Sam PM', '--actor-type', 'human', '--confirm-human'];

  function withCliWorkspace(callback) {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mole-input-queue-cli-')));
    try {
      const created = runCli(['new', 'ws'], parent);
      assert.equal(created.status, 0, created.stderr);
      return callback(path.join(parent, 'ws'));
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }

  it('adds, reviews, and closes a request in text and JSON', () => {
    withCliWorkspace((workspace) => {
      assert.ok(fs.existsSync(path.join(workspace, 'governance', 'input-queue', 'README.md')));
      assert.ok(fs.existsSync(path.join(workspace, 'schemas', 'input-queue-v1.schema.json')));

      const empty = runCli(['review', 'input-queue'], workspace);
      assert.equal(empty.status, 0, empty.stderr);
      assert.match(empty.stdout, /No open input requests\./);

      const added = runCli(['input-queue', 'add', '--request', 'Which pricing tier is the default?', '--impact', 'The onboarding spec assumes Team.',
        '--unblocks', 'Onboarding spec v2', '--priority', 'high', '--blocking', '--due', '2099-01-01', '--ref', '4-context/onboarding.md', ...agentFlags, '--format', 'json'], workspace);
      assert.equal(added.status, 0, added.stderr);
      const inputId = JSON.parse(added.stdout).input_id;

      const text = runCli(['review', 'input-queue'], workspace);
      assert.equal(text.status, 0);
      assert.match(text.stdout, /Top 1 of 1 open input request:/);
      assert.match(text.stdout, /Ranked here because: blocks work, high priority \(score 70\)/);
      assert.match(text.stdout, /Answering it unblocks: Onboarding spec v2/);

      const json = JSON.parse(runCli(['review', 'input-queue', '--format', 'json', '--limit', '5'], workspace).stdout);
      assert.equal(json.ok, true);
      assert.equal(json.limit, 5);
      assert.equal(json.top[0].input_id, inputId);
      assert.deepEqual(json.top[0].references, ['4-context/onboarding.md']);
      assert.deepEqual(JSON.parse(runCli(['input-queue', 'review', '--json'], workspace).stdout).top.map((item) => item.input_id), [inputId]);

      const refused = runCli(['input-queue', 'close', inputId, '--closure-reason', 'stale', '--outcome', 'Dropped', '--reason', 'Old', ...agentFlags, '--format', 'json'], workspace);
      assert.equal(refused.status, 1);
      assert.equal(JSON.parse(refused.stdout).error.code, 'HUMAN_CONFIRMATION_REQUIRED');
      assert.match(refused.stderr, /^Refused: Only a person can close a request as stale/);

      const reassigned = runCli(['input-queue', 'update', inputId, '--owner', 'Sam PM', '--not-blocking', '--reason', 'Sam owns pricing', ...agentFlags], workspace);
      assert.equal(reassigned.status, 0, reassigned.stderr);
      assert.match(reassigned.stdout, /Updated owner, blocking\./);

      const closed = runCli(['input-queue', 'close', inputId, '--answer', 'Team tier', '--outcome', 'Spec updated', ...agentFlags], workspace);
      assert.equal(closed.status, 0, closed.stderr);
      assert.match(closed.stdout, /Closed: answered by Drafting Agent/);

      const shown = runCli(['input-queue', 'show', inputId], workspace);
      assert.match(shown.stdout, /What changed: Spec updated/);
      assert.match(shown.stdout, /- 3\. .* close \(status, closure\) by Drafting Agent \[agent\]: Answered: Team tier/);
      assert.match(runCli(['input-queue', 'list'], workspace).stdout, /No input requests\./);
      assert.match(runCli(['input-queue', 'list', '--all'], workspace).stdout, new RegExp(`${inputId}  closed  high`));

      const reopened = runCli(['input-queue', 'reopen', inputId, '--reason', 'Answer was for the wrong plan', ...humanFlags], workspace);
      assert.equal(reopened.status, 0, reopened.stderr);
      assert.equal(runCli(['input-queue', 'audit'], workspace).status, 0);
    });
  });

  it('reports usage errors with exit code 2', () => {
    withCliWorkspace((workspace) => {
      const missing = runCli(['input-queue', 'add', '--request', 'x', ...agentFlags], workspace);
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, /Missing required option --impact/);
      assert.equal(runCli(['input-queue', 'frobnicate'], workspace).status, 2);
      assert.equal(runCli(['input-queue', 'show', 'nope'], workspace).status, 2);
      assert.equal(runCli(['review', 'input-queue', '--limit', 'many'], workspace).status, 2);
      assert.equal(runCli(['input-queue', 'update', 'inq_00000000-0000-4000-8000-000000000000', '--blocking', '--not-blocking', '--reason', 'x', ...agentFlags], workspace).status, 2);
      const notFound = runCli(['input-queue', 'show', 'inq_00000000-0000-4000-8000-000000000000'], workspace);
      assert.equal(notFound.status, 1);
      assert.match(notFound.stderr, /Input request not found/);
    });
  });

  it('migrates a legacy queue from the command line', () => {
    withCliWorkspace((workspace) => {
      fs.writeFileSync(path.join(workspace, INPUT_QUEUE_VIEW_REL_PATH), LEGACY_QUEUE);
      const review = runCli(['review', 'input-queue'], workspace);
      assert.match(review.stdout, /ID: legacy:9/);
      assert.match(review.stdout, /4 rows in governance\/input-queue\.md have no stable ID yet/);

      const plan = runCli(['input-queue', 'migrate'], workspace);
      assert.match(plan.stdout, /Rows to migrate: 4/);
      assert.match(plan.stdout, /Nothing was changed/);
      const applied = runCli(['input-queue', 'migrate', '--apply', ...agentFlags], workspace);
      assert.equal(applied.status, 0, applied.stderr);
      assert.match(applied.stdout, /Migrated: 4/);
      assert.match(applied.stdout, /kept at governance\/input-queue\/legacy\/input-queue-/);
      assert.match(runCli(['review', 'input-queue'], workspace).stdout, /ID: inq_/);
    });
  });
});
