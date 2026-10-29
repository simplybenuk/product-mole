// Executable worked example. Always owns a fresh disposable workspace.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createWorkspaceScaffold } from '../../../cli/mole.mjs';
import { privacyInventory, scanRaw, purgeRaw } from '../../../lib/privacy.mjs';
import { parseChangeRecord } from '../../../lib/change-records.mjs';
import { registerSource, resolveSource } from '../../../lib/source-registry.mjs';
import { listLifecycleRecords, readLifecycleRecord, transitionLifecycleRecord, registerLifecycleRecord } from '../../../lib/review-lifecycle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = fileURLToPath(new URL('../../../cli/mole.mjs', import.meta.url));
const read = file => fs.readFileSync(file, 'utf8');
const agent = { actor: 'Acceptance fixture author', actorType: 'agent', reason: 'Synthetic report ready' };
// Explicitly authorized synthetic lifecycle decisions. Never used on a supplied workspace.
const human = { actor: 'Synthetic reviewer', actorType: 'human', humanConfirmed: true, reason: 'Reviewed disposable fixture against captured sources' };

export function runAcceptance({ releaseOnly = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-travel-acceptance-'));
  const trace = [];
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
    return result.stdout;
  };
  const json = (...args) => JSON.parse(run(...args));
  const put = (relative, content) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  };
  const source = relative => registerSource(root, { path: relative, captured_by: 'acceptance fixture' }).source_id;
  const sourceAt = relative => listLifecycleRecords(root).find(r => r.path === relative)?.source_id;
  const transition = (id, action, extra = {}) => transitionLifecycleRecord(root, id, {
    action, ...agent, expectedRevision: readLifecycleRecord(root, id).revision, ...extra
  });
  try {
    createWorkspaceScaffold(root);
    const summaryPath = '2-summaries/product.summary.md';
    // An owner-written summary is deliberately outside the report/projection writes.
    put(summaryPath, '# Owner summary\nKeep the existing direction until a person changes it.\n');
    const summaryBefore = read(path.join(root, summaryPath));
    put('inputs/release.md', read(path.join(here, 'release.md')));
    const intents = [];
    const intentRefs = [];
    if (!releaseOnly) {
      put('inputs/intent.md', read(path.join(here, 'intent.md')));
      intentRefs.push(source('inputs/intent.md'));
      intents.push(parseChangeRecord(read(path.join(root, 'inputs/intent.md')), {
        format: 'markdown', source: { type: 'specification', ref: 'inputs/intent.md', source_id: intentRefs[0] },
        identity: { namespace: 'acceptance', key: 'search' }
      }));
      assert.equal(intents[0].change_id, 'change-search-typos');
      assert.equal(intents[0].target, '65 percent in the week after release');
      assert.ok(intents[0].gaps.includes('hypothesis'));
    }
    put('inputs/intents.json', JSON.stringify(intents));
    const releaseArgs = ['release', 'import', 'inputs/release.md', '--namespace', 'acceptance', '--key', 'release-09', '--intents', 'inputs/intents.json'];
    const release = json(...releaseArgs);
    assert.equal(release.changed, true);
    assert.equal(json(...releaseArgs).changed, false);
    assert.deepEqual(read(path.join(root, release.raw_path)), read(path.join(here, 'release.md')));
    assert.equal(release.event.changes.length, 3);
    assert.deepEqual(release.event.changes.map(c => c.intent_link.status), releaseOnly
      ? ['unresolved_id', 'missing', 'unresolved_id'] : ['explicit', 'missing', 'unresolved_id']);
    for (const { record } of release.event.changes) {
      assert.equal(record.expected_outcome, null, 'delivery does not manufacture intent');
      assert.equal(record.outcome_status, 'unknown');
      assert.equal(record.provenance['/title'][0].source_id, release.event.source.source_id);
    }
    assert.equal(new Set(release.event.changes.map(c => c.record.change_id)).size, 3);
    trace.push({ stage: 'release', release_id: release.event.release_id, change_ids: release.event.changes.map(c => c.record.change_id), intent_links: release.event.changes.map(c => c.intent_link.status), raw_source: release.event.source.source_id, replay_changed: false });
    const evidenceRefs = [sourceAt(release.path)];
    assert.ok(evidenceRefs[0]);
    let analytics;
    if (!releaseOnly) {
      put('inputs/analytics.json', read(path.join(here, '../../analytics-evidence/review.json')));
      const args = ['analytics', 'import', 'inputs/analytics.json', '--namespace', 'acceptance', '--key', 'review-1'];
      analytics = json(...args);
      assert.equal(json(...args).changed, false);
      assert.equal(analytics.event.release_id, release.event.release_id);
      assert.equal(analytics.event.change_id, release.event.changes[0].intent_link.intent_id);
      const metric = analytics.event.metrics[0];
      assert.equal(metric.status, 'measured');
      assert.equal(metric.baseline.value, 50);
      assert.equal(metric.post.value, 60);
      assert.equal(metric.baseline.sample_size, 1000);
      assert.equal(metric.post.sample_size, 1200);
      assert.equal(metric.windows.baseline.start, '2026-09-01T00:00:00.000Z');
      assert.equal(metric.windows.post.end, '2026-09-15T00:00:00.000Z');
      assert.equal(metric.comparison.absolute_change, 10);
      assert.equal(metric.comparison.relative_change_percent, 20);
      assert.equal(metric.comparison.causal_claim, false);
      assert.equal(metric.outcome_status, 'unknown');
      assert.equal(analytics.event.metrics[1].status, 'not_measured');
      assert.equal(analytics.event.metrics[1].comparison.absolute_change, null);
      assert.equal(metric.provenance.baseline_value.source_id, analytics.event.source.source_id);
      assert.equal(read(path.join(root, analytics.raw_path)), read(path.join(root, 'inputs/analytics.json')));
      evidenceRefs.push(sourceAt(analytics.path));
      put('inputs/signals.md', read(path.join(here, 'signals.md')));
      evidenceRefs.push(source('inputs/signals.md'));
      trace.push({ stage: 'evidence', evidence_id: analytics.event.evidence_id, change_id: analytics.event.change_id, release_id: analytics.event.release_id, absolute_change: 10, relative_change_percent: 20, causal_claim: false, support_status: 'not_measured' });
    }
    const allRefs = [...intentRefs, ...evidenceRefs];
    for (const id of allRefs) assert.equal(resolveSource(root, id).ok, true);
    assert.match(run('travel-log', 'release-2026-09'), /Suggested agent instruction/);
    run('create', 'product-travel-log', '4-context/travel-log/acceptance.md');
    const reportRecord = listLifecycleRecords(root).find(r => r.path === '4-context/travel-log/acceptance.md');
    assert.ok(reportRecord);
    const replacements = {
      metadata: JSON.stringify({ schema_version: 1, change_id: releaseOnly ? null : 'change-search-typos', release_id: release.event.release_id, intent_refs: intentRefs, evidence_refs: evidenceRefs }, null, 2),
      intent: releaseOnly ? 'Unknown: No intent record found for any change.' : 'Fact: The linked search intent aims to help new accounts complete a search. No intent record found for CSV or the account menu. Hypothesis and guardrails are missing.',
      expected: releaseOnly ? 'Unknown: Outcomes, baselines, targets and review windows are missing.' : 'Fact: Search target is 65 percent in the post-release week, against 50 percent baseline. CSV and account-menu targets are unknown.',
      evidence: releaseOnly ? 'Unknown: No analytics or qualitative evidence supplied. No before/after comparison is possible.' : 'Observation: Search completion was 50 percent for 1,000 eligible searches in [2026-09-01,2026-09-08) and 60 percent for 1,200 in [2026-09-08,2026-09-15), new accounts only. Both windows are complete. This is +10 percentage points, +20 percent relative. Support contacts were not measured. Selected support notes describe two recoveries and one unclear message.',
      interpretation: releaseOnly ? 'Interpretation: Delivery scope alone cannot establish an outcome. Confidence in any benefit is unknown.' : 'Interpretation: The observed 60 percent is below the stated 65 percent target. There is no control group; the concurrent campaign and changing account mix prevent attributing the difference to this release. Selected support notes cannot estimate prevalence. Retention impact is unknown.',
      lesson: releaseOnly ? 'Unknown: Delivery alone provides no outcome learning. Gather intent and comparable measurements.' : 'Observation: Selected notes identify an unclear recovery message worth investigating. Interpretation: Investigate recovery messaging while collecting comparable evidence. Retention impact remains unknown; the release is not established as the cause of the measured difference.',
      decision: releaseOnly ? 'Unknown: Search, CSV and account menu each have decision `unknown`.' : 'Interpretation: Search decision `investigate`; CSV and account menu each `unknown`. No rollout or roadmap change is approved by this report.',
      sources: allRefs.map(id => `- source_id: ${id}`).join('\n') + '\nMissing: CSV/account-menu intent and outcomes; no causal design.',
      receipt: `Read registered sources ${allRefs.join(', ')}. Release and analytics events are draft evidence, not accepted context. Intent and qualitative files are unreviewed source material. This report is a draft for synthetic review only.`
    };
    let report = read(path.join(here, 'report.md')).replace(/\{\{(\w+)\}\}/g, (_, key) => replacements[key]);
    if (releaseOnly) report = report.replace('decision: mixed', 'decision: unknown');
    assert.doesNotMatch(report, /\{\{\w+\}\}/);
    put('4-context/travel-log/acceptance.md', report);
    transition(reportRecord.record_id, 'submit', { sourceIds: allRefs });
    assert.equal(json('learning', 'list').learnings.length, 0);
    const pending = spawnSync(process.execPath, [cli, 'learning', 'promote', reportRecord.record_id], { cwd: root, encoding: 'utf8' });
    assert.notEqual(pending.status, 0, 'pending report cannot become durable learning');
    trace.push({ stage: 'draft', record_id: reportRecord.record_id, report, supporting_sources: allRefs, pending_retrieval_count: 0 });
    transition(reportRecord.record_id, 'approve', human);
    const promoted = json('learning', 'promote', reportRecord.record_id);
    assert.equal(promoted.learning.report, report);
    assert.equal(promoted.learning.provenance.approval.actor, human.actor);
    assert.equal(json('learning', 'promote', reportRecord.record_id).changed, false);
    const query = releaseOnly ? 'Delivery alone' : 'recovery message';
    const later = json('learning', 'list', '--query', query, '--release-id', release.event.release_id);
    assert.equal(later.learnings.length, 1);
    assert.deepEqual(later.learnings[0].learning.intent_refs, intentRefs);
    assert.deepEqual(later.learnings[0].learning.evidence_refs, evidenceRefs);
    // Explicit authored later decision, using current retrieval rather than a raw snapshot.
    const learning = later.learnings[0].learning;
    put('4-context/decisions/next-review.md', `# Later roadmap review draft\nInvestigate evidence gaps before prioritising rollout.\nSource: ${learning.learning_id}, report ${reportRecord.record_id}, approval revision ${learning.provenance.approval.revision}.\n${learning.lesson}\n## Retrieval receipt\nRead current learning through mole learning list; draft decision awaits human review.\n`);
    const decisionSource = source('4-context/decisions/next-review.md');
    const decisionRecord = registerLifecycleRecord(root, { sourceId: decisionSource, state: 'draft', sourceIds: [reportRecord.source_id], ...agent });
    assert.equal(decisionRecord.state, 'draft');
    trace.push({ stage: 'later-decision', learning_id: learning.learning_id, approval_revision: learning.provenance.approval.revision, current: true, decision: read(path.join(root, '4-context/decisions/next-review.md')) });
    // Editing immediately invalidates retrieval, even without a lifecycle revise.
    put('4-context/travel-log/acceptance.md', report + '\nUnreviewed edit.\n');
    assert.equal(json('learning', 'list').learnings.length, 0);
    put('4-context/travel-log/acceptance.md', report);
    assert.equal(json('learning', 'list').learnings.length, 1);
    // A separately reviewed replacement excludes the predecessor before promotion.
    put('4-context/travel-log/replacement.md', report.replace('# Synthetic release review', '# Synthetic replacement review'));
    const nextSource = source('4-context/travel-log/replacement.md');
    const next = registerLifecycleRecord(root, { sourceId: nextSource, state: 'draft', sourceIds: allRefs, ...agent });
    transition(next.record_id, 'submit');
    transition(next.record_id, 'approve', { ...human, supersedes: [reportRecord.record_id] });
    assert.equal(json('learning', 'list').learnings.length, 0);
    const replacement = json('learning', 'promote', next.record_id);
    assert.deepEqual(replacement.learning.provenance.supersedes, [learning.learning_id]);
    const current = json('learning', 'list', '--history');
    assert.equal(current.learnings.length, 1);
    assert.equal(current.history.length, 1);
    assert.equal(current.history[0].current, false);
    assert.equal(read(path.join(root, promoted.path)), JSON.stringify(promoted.learning, null, 2) + '\n');
    assert.equal(read(path.join(root, summaryPath)), summaryBefore);
    assert.equal(read(path.join(root, release.raw_path)), read(path.join(here, 'release.md')));
    // Same identity with changed bytes fails and preserves the original capture.
    put('inputs/release.md', read(path.join(here, 'release.md')) + '\nChanged input.\n');
    const conflict = spawnSync(process.execPath, [cli, ...releaseArgs], { cwd: root, encoding: 'utf8' });
    assert.notEqual(conflict.status, 0);
    assert.equal(read(path.join(root, release.raw_path)), read(path.join(here, 'release.md')));
    trace.push({ stage: 'exclusions-and-preservation', edited_excluded: true, superseded_excluded: true, history_current: false, immutable_snapshots: true, summary_unchanged: true, conflicting_release_refused: true });
    const inventory = privacyInventory(root);
    assert.equal(inventory.length, releaseOnly ? 1 : 2);
    assert.equal(scanRaw(root, { apply: true }).unregistered_items, 0);
    assert.equal(purgeRaw(root).recovery_required, false);
    assert.equal(purgeRaw(root, { apply: true, now: '2099-01-01' }).items.every(item => item.status === 'deleted'), true);
    const ledgers = () => {
      const files = [];
      const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) walk(file);
          else files.push([path.relative(root, file), fs.statSync(file).mtimeMs, read(file)]);
        }
      };
      walk(root);
      return files;
    };
    const afterPurge = ledgers();
    const requests = [releaseArgs];
    if (!releaseOnly) requests.push(['analytics', 'import', 'inputs/analytics.json', '--namespace', 'acceptance', '--key', 'review-1']);
    for (const args of requests) {
      const replay = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
      assert.notEqual(replay.status, 0);
      assert.match(replay.stderr, /privacy/i);
    }
    assert.deepEqual(ledgers(), afterPurge, 'purged replay cannot repair, renew or resurrect');
    trace.push({ stage: 'privacy-retention', imports_managed: inventory.length, scan_unknown: 0, purge_recovery_required: false, purged_replay_refused_without_writes: true });
    return { scenario: releaseOnly ? 'release-only' : 'rich', trace, cleaned_workspace: root };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.includes('--synthetic-review') || args.some(a => !['--synthetic-review', '--release-only'].includes(a))) {
    console.error('Usage: node examples/product-travel-log/acceptance/run.mjs --synthetic-review [--release-only]');
    process.exitCode = 1;
  } else console.log(JSON.stringify(runAcceptance({ releaseOnly: args.includes('--release-only') }), null, 2));
}
