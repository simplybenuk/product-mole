import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readSourceRecord } from '../../lib/source-registry.mjs';
import { createWorkspaceScaffold, parseLifecycleValues } from '../mole.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const moleCliPath = path.join(testDir, '..', 'mole.mjs');

const agentFlags = ['--actor', 'Drafting Agent', '--actor-type', 'agent'];
const humanFlags = ['--actor', 'Sam Reviewer', '--actor-type', 'human', '--confirm-human'];
const ledgerRelPath = path.join('governance', 'lifecycle', 'records.json');

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [moleCliPath, ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  return result;
}

function withWorkspace(callback) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mole-lifecycle-cli-')));
  try {
    createWorkspaceScaffold(workspace);
    callback(workspace, (...cliArgs) => runCli(cliArgs, workspace));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function printedId(output, label) {
  const match = output.match(new RegExp(label + ': ((?:src|rec)_[0-9a-f-]{36})'));
  assert.ok(match, `expected "${label}" in:\n${output}`);
  return match[1];
}

function createDraft(mole, kind, outputPath) {
  const created = mole('create', kind, ...(outputPath ? [outputPath] : []));
  assert.equal(created.status, 0, created.stderr);
  return {
    sourceId: printedId(created.stdout, 'Source ID'),
    recordId: printedId(created.stdout, 'Lifecycle record')
  };
}

describe('review lifecycle commands', () => {
  it('runs capture, draft, review, retrieval, and supersession end to end', () => {
    withWorkspace((workspace, mole) => {
      const captured = mole('insight', '--captured-by', 'Sam Reviewer', 'Customers ask for CSV export every week');
      assert.equal(captured.status, 0, captured.stderr);
      assert.match(captured.stdout, /Lifecycle record: rec_[0-9a-f-]{36} \(raw\)/);
      const evidenceId = printedId(captured.stdout, 'Source ID');
      const rawRecordId = printedId(captured.stdout, 'Lifecycle record');
      const capturePath = captured.stdout.match(/Captured insight: (.+)/)[1];
      const captureBytes = fs.readFileSync(capturePath);

      const created = mole('create', 'spec');
      assert.equal(created.status, 0, created.stderr);
      assert.match(created.stdout, /Lifecycle record: rec_[0-9a-f-]{36} \(draft\)/);
      assert.match(created.stdout, /Never approve, reject, or supersede a record yourself/);
      const recordId = printedId(created.stdout, 'Lifecycle record');
      const specPath = path.join(workspace, '4-context', 'product', 'spec-draft.md');
      fs.appendFileSync(specPath, '\n## Problem\nExports are missing.\n');
      const specBytes = fs.readFileSync(specPath);

      const submitted = mole('lifecycle', 'submit', recordId, ...agentFlags, '--reason', 'Ready for review', '--source', evidenceId, '--format', 'json');
      assert.equal(submitted.status, 0, submitted.stderr);
      const submission = JSON.parse(submitted.stdout);
      assert.equal(submission.state, 'pending_review');
      assert.equal(submission.source_correction, true);
      assert.deepEqual(submission.record.source_ids, [evidenceId]);

      const agentApproval = mole('lifecycle', 'approve', recordId, ...agentFlags, '--confirm-human', '--reason', 'Looks fine');
      assert.equal(agentApproval.status, 1);
      assert.match(agentApproval.stderr, /Refused: Only a human can approve a record\. The record stays pending_review\./);
      const unconfirmed = mole('lifecycle', 'approve', recordId, '--actor', 'Sam Reviewer', '--actor-type', 'human', '--reason', 'Looks fine', '--format', 'json');
      assert.equal(unconfirmed.status, 1);
      assert.equal(JSON.parse(unconfirmed.stdout).error.code, 'HUMAN_CONFIRMATION_REQUIRED');

      const hidden = mole('retrieve', recordId, '--format', 'json');
      assert.equal(hidden.status, 1);
      assert.equal(JSON.parse(hidden.stdout).error.code, 'NOT_ELIGIBLE');
      const emptyList = mole('retrieve');
      assert.equal(emptyList.status, 0);
      assert.match(emptyList.stdout, /Retrievable records \(accepted\): 0/);
      assert.match(emptyList.stdout, /Not included: raw 1, pending_review 1\./);
      const pendingView = mole('retrieve', recordId, '--include-state', 'pending_review');
      assert.equal(pendingView.status, 0);
      assert.match(pendingView.stdout, /State: pending_review/);
      assert.match(pendingView.stdout, /Exports are missing\./);

      const approved = mole('lifecycle', 'approve', recordId, ...humanFlags, '--reason', 'Matches the weekly export requests', '--expect-revision', '2');
      assert.equal(approved.status, 0, approved.stderr);
      assert.match(approved.stdout, /is now accepted \(revision 3\)/);
      assert.match(approved.stdout, /Decision: accepted by Sam Reviewer at /);
      assert.match(approved.stdout, new RegExp('Supporting sources: ' + evidenceId));

      const listed = JSON.parse(mole('retrieve', '--format', 'json').stdout);
      assert.deepEqual(listed.records.map((record) => record.record_id), [recordId]);
      assert.equal(listed.records[0].path, '4-context/product/spec-draft.md');
      const retrieved = JSON.parse(mole('retrieve', recordId, '--json').stdout);
      assert.equal(retrieved.content, specBytes.toString('utf8'));
      assert.equal(retrieved.record.decision.reviewer, 'Sam Reviewer');
      assert.equal(retrieved.absolute_path, undefined);
      assert.ok(!JSON.stringify(retrieved).includes(workspace), 'JSON output must not expose absolute paths');

      const replacement = createDraft(mole, 'spec', '4-context/product/spec-v2.md');
      mole('lifecycle', 'submit', replacement.recordId, ...agentFlags, '--reason', 'Second version', '--source', evidenceId);
      const superseding = mole('lifecycle', 'approve', replacement.recordId, ...humanFlags, '--reason', 'Replaces the first spec', '--supersedes', recordId);
      assert.equal(superseding.status, 0, superseding.stderr);
      assert.match(superseding.stdout, new RegExp('Supersedes: ' + recordId));

      const afterSupersession = mole('retrieve');
      assert.match(afterSupersession.stdout, new RegExp(replacement.recordId + '  accepted'));
      assert.doesNotMatch(afterSupersession.stdout, new RegExp(recordId));
      const shown = mole('lifecycle', 'show', recordId);
      assert.match(shown.stdout, /State: superseded/);
      assert.match(shown.stdout, new RegExp('Superseded by: ' + replacement.recordId));
      assert.match(shown.stdout, /- 1\. .* register \(draft\) by mole-cli \[automation\]/);
      assert.match(shown.stdout, /- 3\. .* approve \(pending_review -> accepted\) by Sam Reviewer \[human, confirmed\]: Matches the weekly export requests/);
      assert.match(shown.stdout, /- 4\. .* supersede \(accepted -> superseded\) by Sam Reviewer \[human, confirmed\]: Replaces the first spec/);

      const listedStates = JSON.parse(mole('lifecycle', 'list', '--state', 'superseded', '--state', 'raw', '--format', 'json').stdout);
      assert.deepEqual(listedStates.records.map((record) => record.record_id).sort(), [recordId, rawRecordId].sort());
      const audit = mole('lifecycle', 'audit');
      assert.equal(audit.status, 0, audit.stdout);
      assert.match(audit.stdout, /findings        0/);

      assert.deepEqual(fs.readFileSync(capturePath), captureBytes);
      assert.deepEqual(fs.readFileSync(specPath), specBytes);
    });
  });

  it('reports rejected output and changed accepted content with exit code 1', () => {
    withWorkspace((workspace, mole) => {
      const evidenceId = printedId(mole('insight', 'Trial users miss the export button').stdout, 'Source ID');
      const { recordId } = createDraft(mole, 'decision-brief');
      mole('lifecycle', 'submit', recordId, ...agentFlags, '--reason', 'Ready', '--source', evidenceId);

      const rejected = mole('lifecycle', 'reject', recordId, ...humanFlags, '--reason', 'No options compared');
      assert.equal(rejected.status, 0, rejected.stderr);
      assert.match(rejected.stdout, /Decision: rejected by Sam Reviewer/);
      assert.equal(mole('retrieve', recordId).status, 1);
      assert.equal(mole('lifecycle', 'approve', recordId, ...humanFlags, '--reason', 'Changed my mind').status, 1);

      assert.equal(mole('lifecycle', 'revise', recordId, ...agentFlags, '--reason', 'Adding options').status, 0);
      assert.equal(mole('lifecycle', 'submit', recordId, ...agentFlags, '--reason', 'Options added').status, 0);
      assert.equal(mole('lifecycle', 'approve', recordId, ...humanFlags, '--reason', 'Options are clear').status, 0);

      fs.appendFileSync(path.join(workspace, '4-context', 'decisions', 'decision-brief-draft.md'), '\nUnreviewed edit.\n');
      const retrieval = mole('retrieve');
      assert.equal(retrieval.status, 1);
      assert.match(retrieval.stdout, /Retrievable records \(accepted\): 0/);
      assert.match(retrieval.stdout, new RegExp('- ' + recordId + '  accepted  .*: content_changed'));
      const audit = mole('lifecycle', 'audit', '--format', 'json');
      assert.equal(audit.status, 1);
      assert.deepEqual(JSON.parse(audit.stdout).findings.map((item) => item.type), ['accepted_content_changed']);
    });
  });

  it('rejects malformed arguments with exit code 2 before changing anything', () => {
    withWorkspace((workspace, mole) => {
      const { recordId, sourceId } = createDraft(mole, 'roadmap');
      const before = fs.readFileSync(path.join(workspace, ledgerRelPath));

      for (const [cliArgs, message] of [
        [['lifecycle', 'list', '--bogus'], /Unknown option --bogus/],
        [['lifecycle', 'submit', recordId, ...agentFlags, '--actor', 'Twice', '--reason', 'x'], /Duplicate option --actor/],
        [['lifecycle', 'submit', recordId, ...agentFlags, '--reason'], /Missing value for --reason/],
        [['lifecycle', 'submit', recordId, ...agentFlags, '--reason', '--format', 'json'], /Missing value for --reason/],
        [['lifecycle', 'submit', recordId, '--actor-type', 'agent', '--reason', 'x'], /Missing required option --actor\./],
        [['lifecycle', 'submit', recordId, '--actor', 'A', '--actor-type', 'robot', '--reason', 'x'], /Actor type must be one of human, agent, automation/],
        [['lifecycle', 'submit', recordId, 'extra', ...agentFlags, '--reason', 'x'], /Unexpected argument: extra/],
        [['lifecycle', 'submit', ...agentFlags, '--reason', 'x'], /A record ID is required/],
        [['lifecycle', 'submit', 'rec_nope', ...agentFlags, '--reason', 'x'], /Invalid lifecycle record ID/],
        [['lifecycle', 'submit', recordId, ...agentFlags, '--reason', 'x', '--expect-revision', 'two'], /--expect-revision must be a positive integer/],
        [['lifecycle', 'submit', recordId, ...agentFlags, '--reason', 'x', '--supersedes', recordId], /Only approve can name records/],
        [['lifecycle', 'register', sourceId, '--state', 'approved', ...agentFlags], /Unknown lifecycle state: approved/],
        [['lifecycle', 'register', sourceId, ...agentFlags], /Missing required option --state/],
        [['lifecycle', 'list', '--format', 'yaml'], /--format must be text or json/],
        [['lifecycle', 'publish', recordId], /Supported lifecycle commands/],
        [['lifecycle', 'migrate', '--apply'], /Missing required option --actor\./],
        [['retrieve', '--include-state'], /Missing value for --include-state/],
        [['retrieve', '--include-state', 'approved'], /Unknown lifecycle state: approved/],
        [['retrieve', recordId, 'extra'], /Unexpected argument: extra/]
      ]) {
        const result = mole(...cliArgs);
        assert.equal(result.status, 2, `${cliArgs.join(' ')}\n${result.stdout}${result.stderr}`);
        assert.match(result.stderr, /^Invalid arguments: /);
        assert.match(result.stderr, message);
      }

      const refusedState = mole('lifecycle', 'register', sourceId, '--state', 'accepted', '--actor', 'Sam Reviewer', '--actor-type', 'human');
      assert.equal(refusedState.status, 1);
      assert.match(refusedState.stderr, /A record cannot be registered as accepted/);
      const duplicate = mole('lifecycle', 'register', sourceId, '--state', 'draft', ...agentFlags, '--format', 'json');
      assert.equal(duplicate.status, 1);
      assert.equal(JSON.parse(duplicate.stdout).error.code, 'RECORD_EXISTS');
      assert.deepEqual(fs.readFileSync(path.join(workspace, ledgerRelPath)), before);
    });
  });

  it('keeps created drafts inside the workspace and never overwrites a file', () => {
    withWorkspace((workspace, mole) => {
      const outside = mole('create', 'spec', '../outside-spec.md');
      assert.equal(outside.status, 1);
      assert.match(outside.stderr, /Refusing to create a draft outside the workspace/);
      assert.equal(fs.existsSync(path.join(workspace, '..', 'outside-spec.md')), false);
      assert.equal(fs.existsSync(path.join(workspace, ledgerRelPath)), false);

      const first = createDraft(mole, 'spec', 'drafts/spec.md');
      const again = mole('create', 'spec', 'drafts/spec.md');
      assert.equal(again.status, 1);
      assert.match(again.stderr, /Refusing to overwrite existing file/);

      const record = JSON.parse(mole('lifecycle', 'show', first.recordId, '--format', 'json').stdout).record;
      assert.equal(record.state, 'draft');
      assert.equal(record.path, 'drafts/spec.md');
      assert.equal(record.source_id, first.sourceId);
      assert.equal(readSourceRecord(workspace, first.sourceId).current_path, 'drafts/spec.md');
      assert.equal(JSON.parse(mole('lifecycle', 'list', '--format', 'json').stdout).records.length, 1);
    });
  });

  it('migrates starter files as unreviewed only when asked to apply', () => {
    withWorkspace((workspace, mole) => {
      fs.writeFileSync(
        path.join(workspace, '4-context', 'pricing.md'),
        '---\ntitle: Pricing\nstatus: active\n---\n\nApproved by the product lead.\n'
      );

      const dryRun = mole('lifecycle', 'migrate');
      assert.equal(dryRun.status, 0, dryRun.stderr);
      assert.match(dryRun.stdout, /Mole lifecycle migration dry-run\./);
      assert.match(dryRun.stdout, /- 4-context\/pricing\.md \(frontmatter status: active\)/);
      assert.match(dryRun.stdout, /Nothing was changed\./);
      assert.equal(fs.existsSync(path.join(workspace, ledgerRelPath)), false);

      const applied = mole('lifecycle', 'migrate', '--apply', ...agentFlags, '--format', 'json');
      assert.equal(applied.status, 0, applied.stderr);
      const report = JSON.parse(applied.stdout);
      assert.ok(report.registered.length > 1);
      assert.ok(report.registered.every((item) => item.state === 'unreviewed'));
      assert.ok(report.registered.some((item) => item.path === '4-context/pricing.md'));
      assert.ok(report.skipped.some((item) => item.path === '4-context/README.md' && item.reason === 'guidance_file'));

      const retrieval = JSON.parse(mole('retrieve', '--format', 'json').stdout);
      assert.deepEqual(retrieval.records, []);
      assert.equal(retrieval.state_counts.unreviewed, report.registered.length);
      assert.equal(retrieval.state_counts.accepted, 0);
      assert.match(mole('lifecycle', 'migrate').stdout, /Untracked: 0/);
    });
  });
});

describe('lifecycle option parsing', () => {
  it('collects repeatable flags and rejects ambiguous input', () => {
    const parsed = parseLifecycleValues(
      ['rec_1', '--source', 'a', '--source', 'b', '--actor', 'Sam', '--confirm-human', '--json'],
      { positionals: 1, scalars: ['--actor'], lists: ['--source'], booleans: ['--confirm-human'] }
    );
    assert.deepEqual(parsed.positionals, ['rec_1']);
    assert.deepEqual(parsed.options['--source'], ['a', 'b']);
    assert.equal(parsed.options['--actor'], 'Sam');
    assert.equal(parsed.options['--confirm-human'], true);
    assert.equal(parsed.format, 'json');
    assert.equal(parseLifecycleValues([]).format, 'text');

    assert.throws(() => parseLifecycleValues(['--confirm-human', '--confirm-human'], { booleans: ['--confirm-human'] }), /Duplicate option --confirm-human/);
    assert.throws(() => parseLifecycleValues(['--json', '--format', 'text']), /--json conflicts with --format text/);
    assert.throws(() => parseLifecycleValues(['--format', 'json', '--format', 'text']), /Duplicate option --format/);
    assert.throws(() => parseLifecycleValues(['one', 'two'], { positionals: 1 }), /Unexpected argument: two/);
  });
});
