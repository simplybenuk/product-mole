import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createWorkspaceScaffold } from '../../cli/mole.mjs';
import { backfillProcessedInboxMetrics } from '../metrics.mjs';
import {
  METRICS_SNAPSHOT_REL_PATH,
  METRIC_CATEGORIES,
  collectMetricEvents,
  formatMetricsSummary,
  summarizeMetrics,
  writeMetricsSnapshot
} from '../metrics-summary.mjs';
import { registerLifecycleRecord, transitionLifecycleRecord } from '../review-lifecycle.mjs';
import { registerSource } from '../source-registry.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const moleCliPath = path.join(repoRoot, 'cli', 'mole.mjs');

const AGENT = { actor: 'Drafting Agent', actorType: 'agent' };
const HUMAN = { actor: 'Sam Reviewer', actorType: 'human', humanConfirmed: true };
const NOW = '2026-10-10T12:00:00.000Z';

function withWorkspace(callback) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mole-metrics-')));
  try {
    createWorkspaceScaffold(root);
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function write(root, relative, content) {
  const absolute = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function source(root, relative, at, content = `content of ${relative}\n`) {
  write(root, relative, content);
  return registerSource(root, { path: relative, capturedAt: at }).source_id;
}

function register(root, sourceId, state, at, extra = {}) {
  return registerLifecycleRecord(root, { sourceId, state, ...AGENT, now: at, ...extra }).record_id;
}

function move(root, recordId, action, at, options = {}) {
  return transitionLifecycleRecord(root, recordId, { action, ...AGENT, reason: `${action} in test`, now: at, ...options });
}

/**
 * Write a completed inbox-processing receipt.  The legacy shape is used
 * because a current receipt must carry the lock it was completed under.
 */
function receipt(root, runId, completedAt, processed, sources = []) {
  write(root, `governance/run-receipts/inbox-processing/${runId}.json`, `${JSON.stringify({
    receipt_id: runId,
    status: 'completed',
    processor: 'Sam',
    completed_at: completedAt,
    processed,
    ...(sources.length ? { processed_sources: sources } : {}),
    summary: 'Processed in test.'
  }, null, 2)}\n`);
}

function category(summary, key) {
  return summary.categories.find((item) => item.key === key);
}

function counts(summary, key) {
  const { last_7_days: week, last_30_days: month, all_time: all } = category(summary, key).counts;
  return [week, month, all];
}

function snapshot(root) {
  const entries = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else entries.push(`${path.relative(root, absolute)} ${fs.statSync(absolute).mtimeMs} ${createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`);
    }
  };
  walk(root);
  return entries.join('\n');
}

/**
 * A workspace with one of everything: two captures, one promoted to
 * evidence, a draft accepted, a draft rejected, a second draft accepted in
 * place of the first, processed inbox items, and two open questions.
 */
function populate(root) {
  const captureA = source(root, '6-raw/inbox/a.md', '2026-09-01T09:00:00.000Z');
  const captureB = source(root, '6-raw/inbox/b.md', '2026-10-05T09:00:00.000Z');
  const rawA = register(root, captureA, 'raw', '2026-09-01T09:00:00.000Z');
  register(root, captureB, 'raw', '2026-10-05T09:00:00.000Z');
  move(root, rawA, 'evidence', '2026-09-02T09:00:00.000Z');

  const pricing = register(root, source(root, '4-context/pricing.md', '2026-09-03T09:00:00.000Z'), 'draft', '2026-09-03T09:00:00.000Z', { sourceIds: [captureA] });
  move(root, pricing, 'submit', '2026-09-04T09:00:00.000Z');
  move(root, pricing, 'approve', '2026-09-05T09:00:00.000Z', { ...HUMAN, expectedRevision: 2 });

  const rejected = register(root, source(root, '4-context/roadmap.md', '2026-10-06T09:00:00.000Z'), 'draft', '2026-10-06T09:00:00.000Z', { sourceIds: [captureA] });
  move(root, rejected, 'submit', '2026-10-07T09:00:00.000Z');
  move(root, rejected, 'reject', '2026-10-08T09:00:00.000Z', HUMAN);

  const pricingV2 = register(root, source(root, '4-context/pricing-v2.md', '2026-10-08T10:00:00.000Z'), 'draft', '2026-10-08T10:00:00.000Z', { sourceIds: [captureA] });
  move(root, pricingV2, 'submit', '2026-10-09T09:00:00.000Z');
  move(root, pricingV2, 'approve', '2026-10-09T10:00:00.000Z', { ...HUMAN, expectedRevision: 2, supersedes: [pricing] });

  receipt(root, 'run-1', '2026-09-02T10:00:00.000Z', ['6-raw/inbox/a.md'], [{ path: '6-raw/inbox/a.md', source_id: captureA }]);
  receipt(root, 'run-2', '2026-10-05T10:00:00.000Z', ['6-raw/inbox/b.md', '6-raw/inbox/c.md'], [{ path: '6-raw/inbox/b.md', source_id: captureB }]);

  write(root, 'governance/input-queue.md', [
    '# Queue', '',
    '| Priority | Request | Why this matters | Status |',
    '|---|---|---|---|',
    '| High | Confirm the launch date | Marketing | Open |',
    '| Low | Share the churn export | Retention | Waiting |',
    '| Low | Approve the copy | Launch | Complete |',
    '| High | _TBD_ | _TBD_ | Open |', ''
  ].join('\n'));
  return { captureA, captureB, rawA, pricing, pricingV2, rejected };
}

describe('summarizeMetrics', () => {
  it('reports every category for a new workspace without writing anything', () => {
    withWorkspace((root) => {
      const before = snapshot(root);
      const summary = summarizeMetrics(root, { now: NOW });
      assert.equal(snapshot(root), before);
      assert.equal(summary.schema_version, 1);
      assert.equal(summary.read_only, true);
      assert.deepEqual(summary.categories.map((item) => item.key), METRIC_CATEGORIES.map((item) => item.key));
      assert.deepEqual(summary.categories.map((item) => item.key), [
        'captured_inputs', 'processed_inputs', 'promoted_evidence', 'reviewed_outputs', 'accepted_learnings', 'superseded_context', 'unresolved_questions'
      ]);
      for (const item of summary.categories) {
        assert.ok(item.definition && item.time && item.label, item.key);
        assert.ok(['operational', 'learning'].includes(item.group));
      }
      assert.deepEqual(counts(summary, 'captured_inputs'), [0, 0, 0]);
      assert.equal(category(summary, 'captured_inputs').availability, 'available');
      assert.equal(category(summary, 'captured_inputs').available_from, null);
      assert.equal(category(summary, 'unresolved_questions').current, 0);
      assert.match(summary.caveat, /do not measure product success or the quality of a decision/);
    });
  });

  it('counts capture, processing, promotion, review, acceptance, supersession, and open questions', () => {
    withWorkspace((root) => {
      populate(root);
      const summary = summarizeMetrics(root, { now: NOW });
      assert.deepEqual(counts(summary, 'captured_inputs'), [1, 1, 2]);
      assert.deepEqual(counts(summary, 'processed_inputs'), [2, 2, 3]);
      assert.deepEqual(counts(summary, 'promoted_evidence'), [0, 0, 1]);
      assert.deepEqual(counts(summary, 'reviewed_outputs'), [2, 2, 3]);
      assert.deepEqual(counts(summary, 'accepted_learnings'), [1, 1, 2]);
      assert.deepEqual(counts(summary, 'superseded_context'), [1, 1, 1]);

      const questions = category(summary, 'unresolved_questions');
      assert.equal(questions.availability, 'current_only');
      assert.equal(questions.current, 2);
      assert.deepEqual(Object.values(questions.counts), [null, null, null]);

      assert.equal(category(summary, 'captured_inputs').available_from, '2026-09-01T09:00:00.000Z');
      assert.equal(category(summary, 'accepted_learnings').latest_at, '2026-10-09T10:00:00.000Z');
      assert.deepEqual(summary.windows.map((window) => window.from), ['2026-10-03T12:00:00.000Z', '2026-09-10T12:00:00.000Z', null]);
    });
  });

  it('gives each event a stable ID, the transition or run, the actor, and where it came from', () => {
    withWorkspace((root) => {
      const ids = populate(root);
      const { events } = collectMetricEvents(root);
      assert.deepEqual(events.map((event) => event.at), events.map((event) => event.at).sort());
      assert.equal(new Set(events.map((event) => event.event_id)).size, events.length);

      const acceptance = events.find((event) => event.category === 'accepted_learnings' && event.record_id === ids.pricingV2);
      assert.deepEqual(acceptance, {
        event_id: `accepted_learnings:${ids.pricingV2}:3`,
        category: 'accepted_learnings',
        at: '2026-10-09T10:00:00.000Z',
        record_id: ids.pricingV2,
        source_id: acceptance.source_id,
        transition: { action: 'approve', from_state: 'pending_review', to_state: 'accepted', revision: 3 },
        actor: 'Sam Reviewer',
        actor_type: 'human',
        provenance: { kind: 'lifecycle_ledger', path: 'governance/lifecycle/records.json' }
      });
      const superseded = events.find((event) => event.category === 'superseded_context');
      assert.equal(superseded.record_id, ids.pricing);
      assert.equal(superseded.transition.to_state, 'superseded');

      const processed = events.find((event) => event.category === 'processed_inputs' && event.source_id === ids.captureB);
      assert.deepEqual(processed, {
        event_id: `processed_inputs:${ids.captureB}`,
        category: 'processed_inputs',
        at: '2026-10-05T10:00:00.000Z',
        source_id: ids.captureB,
        path: '6-raw/inbox/b.md',
        run_id: 'run-2',
        actor: 'Sam',
        provenance: { kind: 'inbox_receipt', path: 'governance/run-receipts/inbox-processing/run-2.json' }
      });
      const byPath = events.find((event) => event.event_id === 'processed_inputs:6-raw/inbox/c.md');
      assert.equal(byPath.source_id, undefined);

      const withEvents = summarizeMetrics(root, { now: NOW, includeEvents: true });
      assert.equal(withEvents.events.length, withEvents.event_count);
      assert.equal(summarizeMetrics(root, { now: NOW }).events, undefined);
    });
  });

  it('does not double-count a replayed receipt, a retried run, or a repeated summary', () => {
    withWorkspace((root) => {
      const ids = populate(root);
      const first = summarizeMetrics(root, { now: NOW, includeEvents: true });

      // Completing the same run again rewrites the same receipt.
      receipt(root, 'run-2', '2026-10-05T10:00:00.000Z', ['6-raw/inbox/b.md', '6-raw/inbox/c.md'], [{ path: '6-raw/inbox/b.md', source_id: ids.captureB }]);
      const replayed = summarizeMetrics(root, { now: NOW, includeEvents: true });
      assert.deepEqual(replayed, first);
      assert.deepEqual(summarizeMetrics(root, { now: NOW, includeEvents: true }), first);

      // A receipt that lists one item twice, by path and by source, counts it once.
      receipt(root, 'run-4', '2026-10-09T11:00:00.000Z', ['6-raw/inbox/d.md', '6-raw/inbox/d.md'], [{ path: '6-raw/inbox/d.md', source_id: 'src_00000000-0000-4000-8000-0000000000d1' }]);
      assert.deepEqual(counts(summarizeMetrics(root, { now: NOW }), 'processed_inputs'), [3, 3, 4]);

      // A second run that claims a path another run processed is a conflict
      // the inbox audit reports.  Nothing is counted until it is reconciled.
      receipt(root, 'run-3', '2026-10-09T12:00:00.000Z', ['6-raw/inbox/b.md']);
      const conflicted = category(summarizeMetrics(root, { now: NOW }), 'processed_inputs');
      assert.equal(conflicted.availability, 'unavailable');
      assert.match(conflicted.reason, /mole inbox audit/);
      assert.deepEqual(Object.values(conflicted.counts), [null, null, null]);
    });
  });

  it('counts a record approved, revised, and approved again once for each approval', () => {
    withWorkspace((root) => {
      const ids = populate(root);
      fs.appendFileSync(path.join(root, '4-context', 'pricing-v2.md'), 'Edited after approval.\n');
      move(root, ids.pricingV2, 'revise', '2026-10-09T12:00:00.000Z');
      move(root, ids.pricingV2, 'submit', '2026-10-09T13:00:00.000Z');
      move(root, ids.pricingV2, 'approve', '2026-10-09T14:00:00.000Z', { ...HUMAN, expectedRevision: 5 });
      const summary = summarizeMetrics(root, { now: NOW });
      assert.deepEqual(counts(summary, 'accepted_learnings'), [2, 2, 3]);
      assert.deepEqual(counts(summary, 'reviewed_outputs'), [3, 3, 4]);
      assert.deepEqual(counts(summary, 'superseded_context'), [1, 1, 1]);
    });
  });

  it('measures each window back from now and leaves out later events', () => {
    withWorkspace((root) => {
      populate(root);
      // Exactly seven days after the first capture of the week falls outside.
      const edge = summarizeMetrics(root, { now: '2026-10-12T09:00:00.000Z' });
      assert.deepEqual(counts(edge, 'captured_inputs'), [0, 1, 2]);
      const early = summarizeMetrics(root, { now: '2026-09-04T00:00:00.000Z' });
      assert.deepEqual(counts(early, 'captured_inputs'), [1, 1, 1]);
      assert.deepEqual(counts(early, 'accepted_learnings'), [0, 0, 0]);
      assert.deepEqual(counts(early, 'processed_inputs'), [1, 1, 1]);
      assert.throws(() => summarizeMetrics(root, { now: 'not a date' }), (error) => error.code === 'INVALID_ARGUMENT');
    });
  });

  it('marks unsupported history as unknown and never as accepted', () => {
    withWorkspace((root) => {
      // A legacy receipt with no processed items, and no review ledger.
      receipt(root, 'legacy-run', '2026-06-01T10:00:00.000Z', []);
      receipt(root, 'run-1', '2026-10-05T10:00:00.000Z', ['6-raw/inbox/a.md']);
      const summary = summarizeMetrics(root, { now: NOW });
      const processed = category(summary, 'processed_inputs');
      assert.deepEqual(Object.values(processed.counts), [1, 1, 1]);
      assert.equal(processed.receipts_without_items, 1);
      assert.match(processed.reason, /1 completed receipt lists no processed items .* unknown and is not counted/);
      // Receipts prove earlier activity and the ledger holds nothing: unknown, with no number.
      for (const key of ['accepted_learnings', 'reviewed_outputs', 'promoted_evidence', 'superseded_context', 'captured_inputs']) {
        assert.equal(category(summary, key).availability, 'unknown', key);
        assert.deepEqual(counts(summary, key), [null, null, null], key);
        assert.match(category(summary, key).reason, /unknown, not zero/, key);
      }
      assert.match(formatMetricsSummary(summary), /Accepted learnings\s+unknown\n/);
    });
  });

  it('reports a category as unavailable when its records cannot be trusted', () => {
    withWorkspace((root) => {
      populate(root);
      write(root, 'governance/lifecycle/records.json', '{ broken');
      write(root, 'governance/run-receipts/inbox-processing/run-2 (conflicted copy).json', '{}');
      fs.rmSync(path.join(root, 'governance', 'input-queue.md'));
      const summary = summarizeMetrics(root, { now: NOW });
      for (const key of ['captured_inputs', 'accepted_learnings', 'processed_inputs', 'unresolved_questions']) {
        const item = category(summary, key);
        assert.equal(item.availability, 'unavailable', key);
        assert.ok(item.reason, key);
        assert.deepEqual(Object.values(item.counts), [null, null, null], key);
      }
      assert.match(category(summary, 'processed_inputs').reason, /mole inbox audit/);
      assert.match(formatMetricsSummary(summary), /Accepted learnings\s+unavailable/);
    });
  });

  it('does not report zero processed inputs when every receipt is invalid', () => {
    withWorkspace((root) => {
      write(root, 'governance/run-receipts/inbox-processing/run-1.json', '{ broken');
      write(root, 'governance/run-receipts/inbox-processing/run-2.json', '{"nope":true}');
      const processed = category(summarizeMetrics(root, { now: NOW }), 'processed_inputs');
      assert.equal(processed.availability, 'unavailable');
      assert.deepEqual(Object.values(processed.counts), [null, null, null]);
      assert.equal(backfillProcessedInboxMetrics(root, { now: new Date(NOW) }).blocked, true);
    });
  });

  it('counts open questions only from a table with Request and Status columns', () => {
    withWorkspace((root) => {
      const queue = (rows, header = '| Priority | Request | Status |\n|---|---|---|') => write(root, 'governance/input-queue.md', `# Queue\n\n${header}\n${rows.join('\n')}\n`);
      const open = () => category(summarizeMetrics(root, { now: NOW }), 'unresolved_questions');
      queue(['| High | One | Open |', '| High | Two | Waiting |', '| Low | Three | Deferred |', '| Low | Four | In progress |',
        '| Low | Five | ✅ Complete |', '| Low | Six | [x] Complete |', '| Low | Seven | **Done** |', '| Low | Eight | ~~Open~~ Resolved |',
        '| Low | Nine | Declined |', '| | No open requests | |', '| | None | |', '| High | _TBD_ | Open |']);
      assert.equal(open().current, 4);

      // An archive table with no Status column is not a queue.
      queue(['| High | Old ask | It was yes |'], '| Priority | Request | Answer |\n|---|---|---|');
      assert.equal(open().availability, 'unavailable');
      assert.match(open().reason, /no table with Request and Status columns/);
      write(root, 'governance/input-queue.md', '# Queue\n\n- [ ] Ask about pricing\n');
      assert.equal(open().availability, 'unavailable');
    });
  });

  it('leaves an event dated after now out of every count and of latest_at', () => {
    withWorkspace((root) => {
      populate(root);
      const summary = summarizeMetrics(root, { now: '2026-09-04T00:00:00.000Z' });
      assert.deepEqual(counts(summary, 'accepted_learnings'), [0, 0, 0]);
      assert.equal(category(summary, 'accepted_learnings').latest_at, null);
      assert.equal(category(summary, 'captured_inputs').latest_at, '2026-09-01T09:00:00.000Z');
    });
  });

  it('prints the two groups apart, with the caveat and the notes', () => {
    withWorkspace((root) => {
      populate(root);
      const text = formatMetricsSummary(summarizeMetrics(root, { now: NOW }));
      const operational = text.indexOf('Operational activity: what processing happened');
      const learning = text.indexOf('Learning and decision state: what context states changed');
      assert.ok(operational > 0 && learning > operational);
      assert.ok(text.indexOf('Processed inputs') < learning && text.indexOf('Accepted learnings') > learning);
      assert.match(text, /Accepted learnings\s+1\s+1\s+2\n/);
      assert.match(text, /Unresolved questions\s+2 open now\n/);
      assert.match(text, /do not measure product success/);
      assert.match(text, /Counted from the review ledger, which starts at 2026-09-01T09:00:00\.000Z/);
    });
  });
});

describe('metrics snapshot and backfill', () => {
  it('writes the summary for the dashboard and can write it again', () => {
    withWorkspace((root) => {
      populate(root);
      const result = writeMetricsSnapshot(root, { now: NOW });
      assert.equal(result.path, METRICS_SNAPSHOT_REL_PATH);
      const written = JSON.parse(fs.readFileSync(path.join(root, METRICS_SNAPSHOT_REL_PATH), 'utf8'));
      assert.equal(written.generated_at, NOW);
      assert.equal(written.read_only, undefined);
      assert.deepEqual(written.categories, summarizeMetrics(root, { now: NOW }).categories);
      writeMetricsSnapshot(root, { now: NOW });
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, METRICS_SNAPSHOT_REL_PATH), 'utf8')), written);
      assert.deepEqual(fs.readdirSync(path.join(root, 'governance', 'metrics')).filter((name) => name.endsWith('.tmp')), []);
    });
  });

  it('gives an older workspace the dashboard page that has the summary panel', () => {
    withWorkspace((root) => {
      const dashboard = path.join(root, 'governance', 'metrics', 'dashboard.html');
      const current = fs.readFileSync(dashboard, 'utf8');
      assert.deepEqual(writeMetricsSnapshot(root, { now: NOW }).dashboard, { path: 'governance/metrics/dashboard.html', updated: false });

      fs.writeFileSync(dashboard, '<html><body>An older page with one panel.</body></html>');
      assert.deepEqual(writeMetricsSnapshot(root, { now: NOW }).dashboard, { path: 'governance/metrics/dashboard.html', updated: true, replaced_older_page: true });
      assert.equal(fs.readFileSync(dashboard, 'utf8'), current);

      fs.rmSync(dashboard);
      assert.equal(writeMetricsSnapshot(root, { now: NOW }).dashboard.replaced_older_page, false);
      assert.equal(fs.readFileSync(dashboard, 'utf8'), current);
    });
  });

  it('refuses to write the snapshot through a link that leaves the workspace', () => {
    withWorkspace((root) => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-metrics-outside-'));
      try {
        fs.rmSync(path.join(root, 'governance', 'metrics'), { recursive: true });
        fs.symlinkSync(outside, path.join(root, 'governance', 'metrics'));
        assert.throws(() => writeMetricsSnapshot(root, { now: NOW }), (error) => error.code === 'SNAPSHOT_NOT_WRITTEN');
        assert.deepEqual(fs.readdirSync(outside), []);
        const refused = spawnSync(process.execPath, [moleCliPath, 'metrics', 'snapshot', '--format', 'json'], { cwd: root, encoding: 'utf8' });
        assert.equal(refused.status, 1);
        assert.equal(JSON.parse(refused.stdout).error.code, 'SNAPSHOT_NOT_WRITTEN');
        assert.match(refused.stderr, /^Refused: The metrics snapshot could not be written/);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it('keeps the processed-path history that backfill builds', () => {
    withWorkspace((root) => {
      populate(root);
      const backfill = backfillProcessedInboxMetrics(root, { now: new Date(NOW) });
      assert.equal(backfill.ok, true);
      assert.equal(backfill.processed_paths_counted, 3);
      const daily = JSON.parse(fs.readFileSync(path.join(root, 'governance', 'metrics', 'daily.json'), 'utf8'));
      assert.deepEqual(daily.records, [{ date: '2026-09-02', count: 1 }, { date: '2026-10-05', count: 2 }]);
      // The summary agrees with the history and does not change it.
      assert.equal(category(summarizeMetrics(root, { now: NOW }), 'processed_inputs').counts.all_time, 3);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'governance', 'metrics', 'daily.json'), 'utf8')), daily);
    });
  });

  it('ships a dashboard that shows the two kinds of count apart', () => {
    const html = fs.readFileSync(path.join(repoRoot, 'governance', 'metrics', 'dashboard.html'), 'utf8');
    assert.match(html, /Operational activity: processed inbox items/);
    assert.match(html, /Workflow summary: activity and review state/);
    assert.match(html, /Learning and decision state: what context states changed/);
    assert.match(html, /not product success or decision quality/);
    assert.match(html, /loadJsonFile\('outcomes\.json'\)/);
    const starter = JSON.parse(fs.readFileSync(path.join(repoRoot, METRICS_SNAPSHOT_REL_PATH), 'utf8'));
    assert.equal(starter.generated_at, null);
    assert.deepEqual(starter.categories, []);
  });
});

describe('mole metrics', () => {
  function runCli(args, cwd) {
    return spawnSync(process.execPath, [moleCliPath, ...args], { cwd, encoding: 'utf8' });
  }

  it('succeeds with no subcommand, in text and JSON', () => {
    withWorkspace((root) => {
      populate(root);
      const before = snapshot(root);
      const text = runCli(['metrics'], root);
      assert.equal(text.status, 0, text.stderr);
      assert.match(text.stdout, /^Molehill Metrics\n/);
      assert.match(text.stdout, /Captured inputs\s+\d+\s+\d+\s+2\n/);

      for (const args of [['metrics', '--format', 'json'], ['metrics', 'summary', '--json']]) {
        const json = runCli(args, root);
        assert.equal(json.status, 0, json.stderr);
        const summary = JSON.parse(json.stdout);
        assert.equal(summary.schema_version, 1);
        assert.equal(category(summary, 'accepted_learnings').counts.all_time, 2);
        assert.equal(summary.events, undefined);
      }
      const withEvents = JSON.parse(runCli(['metrics', '--events', '--format', 'json'], root).stdout);
      assert.equal(withEvents.events.length, withEvents.event_count);
      assert.match(runCli(['metrics', '--events'], root).stdout, /\nEvents \(\d+\)\n/);
      assert.equal(snapshot(root), before);

      const bad = runCli(['metrics', '--bogus'], root);
      assert.equal(bad.status, 2);
      assert.match(bad.stderr, /Invalid arguments: Unknown option --bogus/);
      const unknown = runCli(['metrics', 'frobnicate'], root);
      assert.equal(unknown.status, 1);
      assert.match(unknown.stderr, /summary \(the default\), snapshot, backfill/);
    });
  });

  it('writes the snapshot on request and after a backfill', () => {
    withWorkspace((root) => {
      populate(root);
      const snapshotPath = path.join(root, METRICS_SNAPSHOT_REL_PATH);
      assert.equal(JSON.parse(fs.readFileSync(snapshotPath, 'utf8')).generated_at, null);
      const written = runCli(['metrics', 'snapshot'], root);
      assert.equal(written.status, 0, written.stderr);
      assert.match(written.stdout, /Wrote governance\/metrics\/outcomes\.json/);
      assert.equal(JSON.parse(fs.readFileSync(snapshotPath, 'utf8')).categories.length, 7);

      fs.rmSync(snapshotPath);
      const backfill = runCli(['metrics', 'backfill'], root);
      assert.equal(backfill.status, 0, backfill.stderr);
      assert.match(backfill.stdout, /Processed paths counted: 3/);
      assert.match(backfill.stdout, /Outcome snapshot: governance\/metrics\/outcomes\.json/);
      assert.ok(fs.existsSync(snapshotPath));
      assert.match(runCli(['--help'], root).stdout, /mole metrics \[--format json\] \[--events\]/);
    });
  });
});
