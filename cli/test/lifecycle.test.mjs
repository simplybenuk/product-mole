import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readSourceRecord } from '../../lib/source-registry.mjs';
import { captureNote } from '../../ui/server.mjs';
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

      const agentApproval = mole('lifecycle', 'approve', recordId, ...agentFlags, '--confirm-human', '--reason', 'Looks fine', '--expect-revision', '2');
      assert.equal(agentApproval.status, 1);
      assert.match(agentApproval.stderr, /Refused: Only a human can approve a record\. The record stays pending_review\./);
      const unconfirmed = mole('lifecycle', 'approve', recordId, '--actor', 'Sam Reviewer', '--actor-type', 'human', '--reason', 'Looks fine', '--expect-revision', '2', '--format', 'json');
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
      const superseding = mole('lifecycle', 'approve', replacement.recordId, ...humanFlags, '--reason', 'Replaces the first spec', '--supersedes', recordId, '--expect-revision', '2');
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
      assert.equal(mole('lifecycle', 'approve', recordId, ...humanFlags, '--reason', 'Changed my mind', '--expect-revision', '3').status, 1);

      assert.equal(mole('lifecycle', 'revise', recordId, ...agentFlags, '--reason', 'Adding options').status, 0);
      assert.equal(mole('lifecycle', 'submit', recordId, ...agentFlags, '--reason', 'Options added').status, 0);
      assert.equal(mole('lifecycle', 'approve', recordId, ...humanFlags, '--reason', 'Options are clear', '--expect-revision', '5').status, 0);

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
      assert.match(dryRun.stdout, /- 4-context\/pricing\.md -> unreviewed \(frontmatter status: active\)/);
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

describe('renamed, removed, and untrackable files', () => {
  it('refuses to reuse a path that a moved draft still claims until the draft is relocated', () => {
    withWorkspace((workspace, mole) => {
      const evidenceId = printedId(mole('insight', 'Checkout drops carts on slow networks').stdout, 'Source ID');
      const first = createDraft(mole, 'spec');
      const draftPath = path.join(workspace, '4-context', 'product', 'spec-draft.md');
      const renamedPath = path.join(workspace, '4-context', 'product', 'checkout-spec.md');
      fs.renameSync(draftPath, renamedPath);
      fs.appendFileSync(renamedPath, '\nThe real checkout spec.\n');

      const reused = mole('create', 'spec');
      assert.equal(reused.status, 1);
      assert.match(reused.stderr, /Refusing to create a draft at 4-context\/product\/spec-draft\.md/);
      assert.match(reused.stderr, new RegExp(`mole lifecycle relocate ${first.recordId} --path <new path>`));
      assert.match(reused.stderr, /Nothing was written\./);
      assert.equal(fs.existsSync(draftPath), false);

      const stuck = mole('lifecycle', 'submit', first.recordId, ...agentFlags, '--reason', 'Ready');
      assert.equal(stuck.status, 1);
      assert.match(stuck.stderr, new RegExp(`mole lifecycle relocate ${first.recordId} --path <new path>`));

      const relocated = mole('lifecycle', 'relocate', first.recordId, '--path', '4-context/product/checkout-spec.md', ...agentFlags, '--reason', 'Renamed');
      assert.equal(relocated.status, 0, relocated.stderr);
      assert.match(relocated.stdout, /now points to 4-context\/product\/checkout-spec\.md \(revision 2\)/);
      assert.match(relocated.stdout, /Recorded a source content correction/);

      const second = createDraft(mole, 'spec');
      fs.appendFileSync(draftPath, '\nUNFINISHED UNRELATED DRAFT\n');
      assert.equal(mole('lifecycle', 'submit', first.recordId, ...agentFlags, '--reason', 'Ready', '--source', evidenceId).status, 0);
      assert.equal(mole('lifecycle', 'approve', first.recordId, ...humanFlags, '--reason', 'Matches the report', '--expect-revision', '3').status, 0);

      const retrieved = mole('retrieve', first.recordId);
      assert.match(retrieved.stdout, /Path: 4-context\/product\/checkout-spec\.md/);
      assert.match(retrieved.stdout, /The real checkout spec\./);
      assert.doesNotMatch(retrieved.stdout, /UNFINISHED/);
      const listed = mole('lifecycle', 'list').stdout;
      assert.match(listed, new RegExp(`${first.recordId}  accepted  r4  4-context/product/checkout-spec\\.md`));
      assert.match(listed, new RegExp(`${second.recordId}  draft  r1  4-context/product/spec-draft\\.md`));
      assert.equal(mole('lifecycle', 'audit').status, 0);
    });
  });

  it('withdraws a record whose file was removed and keeps accepted records for a human', () => {
    withWorkspace((workspace, mole) => {
      const captured = mole('insight', 'A note that gets promoted and removed');
      const rawRecordId = printedId(captured.stdout, 'Lifecycle record');
      fs.rmSync(captured.stdout.match(/Captured insight: (.+)/)[1]);

      const failing = mole('lifecycle', 'audit');
      assert.equal(failing.status, 1);
      assert.match(failing.stdout, new RegExp(`mole lifecycle withdraw ${rawRecordId}`));

      const withdrawn = mole('lifecycle', 'withdraw', rawRecordId, ...agentFlags, '--reason', 'Inbox copy removed after promotion');
      assert.equal(withdrawn.status, 0, withdrawn.stderr);
      assert.match(withdrawn.stdout, /is now withdrawn \(revision 2\)/);
      assert.equal(mole('lifecycle', 'audit').status, 0);
      assert.equal(mole('retrieve', '--include-state', 'raw').status, 0);

      const evidenceId = printedId(mole('insight', 'Supporting note').stdout, 'Source ID');
      const { recordId } = createDraft(mole, 'roadmap');
      mole('lifecycle', 'submit', recordId, ...agentFlags, '--reason', 'Ready', '--source', evidenceId);
      mole('lifecycle', 'approve', recordId, ...humanFlags, '--reason', 'Agreed', '--expect-revision', '2');
      const agent = mole('lifecycle', 'withdraw', recordId, ...agentFlags, '--confirm-human', '--reason', 'Tidying');
      assert.equal(agent.status, 1);
      assert.match(agent.stderr, /Only a human can withdraw an accepted record\. The record stays accepted\./);
      assert.equal(mole('lifecycle', 'withdraw', recordId, ...humanFlags, '--reason', 'Plan cancelled').status, 0);
      assert.match(mole('retrieve').stdout, /Retrievable records \(accepted\): 0/);
    });
  });

  it('keeps a capture when the ledger cannot be written and backfills it later', () => {
    withWorkspace((workspace, mole) => {
      mole('insight', 'First note');
      const ledgerPath = path.join(workspace, ledgerRelPath);
      const conflictCopy = path.join(path.dirname(ledgerPath), 'records (conflicted copy).json');
      fs.copyFileSync(ledgerPath, conflictCopy);
      const before = fs.readFileSync(ledgerPath);

      const captured = mole('insight', 'Captured while the ledger is in conflict');
      assert.equal(captured.status, 0, captured.stderr);
      assert.match(captured.stdout, /Captured insight: /);
      assert.doesNotMatch(captured.stdout, /Lifecycle record:/);
      assert.match(captured.stderr, /Warning: the capture is saved but has no lifecycle record yet/);
      assert.match(captured.stderr, /Do not capture it again\./);
      const sourceId = printedId(captured.stdout, 'Source ID');
      assert.ok(fs.existsSync(captured.stdout.match(/Captured insight: (.+)/)[1]));

      const blocked = mole('create', 'spec');
      assert.equal(blocked.status, 1);
      assert.match(blocked.stderr, /Refusing to create a draft that cannot be tracked: .*competing copies.* Nothing was written\./);
      assert.equal(fs.existsSync(path.join(workspace, '4-context', 'product', 'spec-draft.md')), false);
      assert.deepEqual(fs.readFileSync(ledgerPath), before);

      fs.rmSync(conflictCopy);
      const backfill = JSON.parse(mole('lifecycle', 'migrate', '--apply', ...agentFlags, '--format', 'json').stdout);
      const entry = backfill.registered.find((item) => item.source_id === sourceId);
      assert.ok(entry, 'the capture should be backfilled under its original source ID');
      assert.equal(entry.state, 'raw');
      assert.equal(createDraft(mole, 'spec').recordId.length, 40);
    });
  });

  it('lets a default path be reused after its draft is deleted and withdrawn', () => {
    withWorkspace((workspace, mole) => {
      const first = createDraft(mole, 'spec');
      const draftPath = path.join(workspace, '4-context', 'product', 'spec-draft.md');
      fs.rmSync(draftPath);

      const blocked = mole('create', 'spec');
      assert.equal(blocked.status, 1);
      assert.match(blocked.stderr, new RegExp(`If it was deleted, run "mole lifecycle withdraw ${first.recordId}"\\.`));
      assert.equal(fs.existsSync(draftPath), false);

      assert.equal(mole('lifecycle', 'withdraw', first.recordId, ...agentFlags, '--reason', 'Deleted').status, 0);
      const second = createDraft(mole, 'spec');
      assert.notEqual(second.recordId, first.recordId);
      assert.equal(readSourceRecord(workspace, first.sourceId).current_path, null);
      assert.equal(readSourceRecord(workspace, second.sourceId).current_path, '4-context/product/spec-draft.md');
      assert.equal(mole('lifecycle', 'audit').status, 0);

      const closed = mole('lifecycle', 'relocate', first.recordId, '--path', '4-context/product/spec-draft.md', ...agentFlags, '--reason', 'x');
      assert.equal(closed.status, 1);
      assert.match(closed.stderr, /This record is closed and nothing more can be done to it\./);
      assert.doesNotMatch(closed.stderr, /mole lifecycle withdraw/);
    });
  });

  it('makes an approval name the revision that was read', () => {
    withWorkspace((workspace, mole) => {
      const evidenceId = printedId(mole('insight', 'Supporting note').stdout, 'Source ID');
      const { recordId } = createDraft(mole, 'strategy-memo');
      const draftPath = path.join(workspace, '4-context', 'strategy', 'strategy-memo-draft.md');
      const submitted = mole('lifecycle', 'submit', recordId, ...agentFlags, '--reason', 'Ready', '--source', evidenceId);
      assert.match(submitted.stdout, new RegExp(`mole retrieve ${recordId} --include-state pending_review`));
      assert.match(submitted.stdout, /--expect-revision 2/);
      assert.match(mole('retrieve', recordId, '--include-state', 'pending_review').stdout, /Revision: 2/);

      const unpinned = mole('lifecycle', 'approve', recordId, ...humanFlags, '--reason', 'Fine');
      assert.equal(unpinned.status, 2);
      assert.match(unpinned.stderr, /Approve needs --expect-revision <n>, the revision you reviewed/);

      // The agent reworks and resubmits while the reviewer is still reading.
      mole('lifecycle', 'revise', recordId, ...agentFlags, '--reason', 'One more change');
      fs.appendFileSync(draftPath, '\nA paragraph the reviewer has not seen.\n');
      mole('lifecycle', 'submit', recordId, ...agentFlags, '--reason', 'Ready again');

      const stale = mole('lifecycle', 'approve', recordId, ...humanFlags, '--reason', 'Fine', '--expect-revision', '2', '--format', 'json');
      assert.equal(stale.status, 1);
      assert.equal(JSON.parse(stale.stdout).error.code, 'REVISION_CONFLICT');
      assert.match(mole('lifecycle', 'show', recordId).stdout, /State: pending_review/);
      assert.equal(mole('lifecycle', 'approve', recordId, ...humanFlags, '--reason', 'Read the new paragraph', '--expect-revision', '4').status, 0);
    });
  });

  it('routes an accepted file that was edited in place back through review', () => {
    withWorkspace((workspace, mole) => {
      const evidenceId = printedId(mole('insight', 'Supporting note').stdout, 'Source ID');
      const { recordId } = createDraft(mole, 'roadmap');
      const roadmapPath = path.join(workspace, '4-context', 'product', 'roadmap-draft.md');
      mole('lifecycle', 'submit', recordId, ...agentFlags, '--reason', 'Ready', '--source', evidenceId);
      mole('lifecycle', 'approve', recordId, ...humanFlags, '--reason', 'Agreed', '--expect-revision', '2');

      const untouched = mole('lifecycle', 'revise', recordId, ...agentFlags, '--reason', 'Tidying');
      assert.equal(untouched.status, 1);
      assert.match(untouched.stderr, /Only a human can reopen accepted context whose file has not changed\. The record stays accepted\./);

      fs.appendFileSync(roadmapPath, '\nQ4 item added in place.\n');
      const audit = mole('lifecycle', 'audit');
      assert.equal(audit.status, 1);
      assert.match(audit.stdout, new RegExp(`run "mole lifecycle revise ${recordId}" and submit the new version for review`));

      assert.equal(mole('lifecycle', 'revise', recordId, ...agentFlags, '--reason', 'Roadmap refreshed').status, 0);
      assert.equal(mole('lifecycle', 'audit').status, 0);
      assert.match(mole('retrieve').stdout, /Retrievable records \(accepted\): 0/);
      assert.equal(mole('lifecycle', 'submit', recordId, ...agentFlags, '--reason', 'Ready again').status, 0);
      assert.equal(mole('lifecycle', 'approve', recordId, ...humanFlags, '--reason', 'Q4 item agreed', '--expect-revision', '5').status, 0);
      assert.match(mole('retrieve', recordId).stdout, /Q4 item added in place\./);
    });
  });

  it('points a second registration of a tracked file at its existing record', () => {
    withWorkspace((workspace, mole) => {
      const evidenceId = printedId(mole('insight', 'Supporting note').stdout, 'Source ID');
      const { recordId } = createDraft(mole, 'spec');
      const relative = '4-context/product/spec-draft.md';

      const found = mole('lifecycle', 'list', '--path', relative);
      assert.equal(found.status, 0, found.stderr);
      assert.match(found.stdout, new RegExp(`^${recordId}  draft  r1  ${relative}$`, 'm'));
      assert.match(mole('lifecycle', 'list', '--path', '4-context/product/other.md').stdout, /No lifecycle records\./);
      assert.equal(mole('lifecycle', 'list', '--path', '../outside.md').status, 2);

      // An agent follows the "register it" rule on a file that is already tracked.
      const again = JSON.parse(mole('source', 'register', relative, '--json').stdout);
      const second = mole('lifecycle', 'register', again.source_id, '--state', 'draft', ...agentFlags);
      assert.equal(second.status, 1);
      assert.match(second.stderr, new RegExp(`already belongs to draft lifecycle record ${recordId}\\. One file backs one record, so use that record\\.`));

      assert.equal(mole('lifecycle', 'audit').status, 0);
      assert.equal(mole('lifecycle', 'migrate').status, 0);
      fs.appendFileSync(path.join(workspace, ...relative.split('/')), '\nMore detail.\n');
      const submitted = mole('lifecycle', 'submit', recordId, ...agentFlags, '--reason', 'Ready', '--source', evidenceId);
      assert.equal(submitted.status, 0, submitted.stderr);
      assert.match(submitted.stdout, new RegExp(`Note: Source ${again.source_id} is also registered at ${relative} and has no lifecycle record`));
      assert.equal(mole('lifecycle', 'approve', recordId, ...humanFlags, '--reason', 'Agreed', '--expect-revision', '2').status, 0);
      assert.match(mole('retrieve', recordId).stdout, /More detail\./);
      assert.equal(mole('lifecycle', 'audit').status, 0);
    });
  });

  it('lists the recovery commands in help', () => {
    withWorkspace((workspace, mole) => {
      const help = mole('--help').stdout;
      assert.match(help, /mole lifecycle withdraw <record_id>/);
      assert.match(help, /mole lifecycle relocate <record_id> --path <path>/);
      const unknown = mole('lifecycle', 'publish');
      assert.equal(unknown.status, 2);
      assert.match(unknown.stderr, /withdraw, relocate, show, list, audit, migrate, unlock/);
      const missingPath = mole('lifecycle', 'relocate', 'rec_00000000-0000-4000-8000-000000000000', ...agentFlags, '--reason', 'x');
      assert.equal(missingPath.status, 2);
      assert.match(missingPath.stderr, /Missing required option --path/);
    });
  });
});

describe('UI capture', () => {
  it('opens a raw record and keeps the capture when the ledger is in conflict', async () => {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mole-lifecycle-ui-')));
    try {
      createWorkspaceScaffold(workspace);
      assert.deepEqual(await captureNote(workspace, { note: '   ' }), { status: 400, payload: { error: 'Note is required' } });

      const saved = await captureNote(workspace, { note: 'Heard in the pricing call', capturedBy: 'Sam Reviewer' });
      assert.equal(saved.status, 200);
      assert.equal(saved.payload.state, 'raw');
      assert.match(saved.payload.record_id, /^rec_[0-9a-f-]{36}$/);
      assert.equal(saved.payload.warning, undefined);
      const shown = JSON.parse(runCli(['lifecycle', 'show', saved.payload.record_id, '--format', 'json'], workspace).stdout).record;
      assert.equal(shown.source_id, saved.payload.source_id);
      assert.equal(shown.history[0].actor, 'mole-ui');
      assert.equal(shown.history[0].actor_type, 'automation');

      const ledgerPath = path.join(workspace, ledgerRelPath);
      const conflictCopy = path.join(path.dirname(ledgerPath), 'records (conflicted copy).json');
      fs.copyFileSync(ledgerPath, conflictCopy);
      const kept = await captureNote(workspace, { note: 'Heard while the ledger was in conflict' });
      assert.equal(kept.status, 200);
      assert.equal(kept.payload.ok, true);
      assert.equal(kept.payload.record_id, null);
      assert.equal(kept.payload.state, null);
      assert.match(kept.payload.warning, /The capture is saved but has no lifecycle record yet: .*competing copies/);
      assert.ok(fs.existsSync(path.join(workspace, kept.payload.path)));
      assert.equal(readSourceRecord(workspace, kept.payload.source_id).current_path, kept.payload.path.split(path.sep).join('/'));

      fs.rmSync(conflictCopy);
      const backfill = JSON.parse(runCli(['lifecycle', 'migrate', '--apply', ...agentFlags, '--format', 'json'], workspace).stdout);
      assert.equal(backfill.registered.find((item) => item.source_id === kept.payload.source_id)?.state, 'raw');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
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
