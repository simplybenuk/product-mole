#!/usr/bin/env node
import { validateVisibility } from '../lib/privacy-policy.mjs';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCaptureFileName, resolveCapturedBy } from '../lib/capture.mjs';
import {
  claimInboxProcessing,
  completeInboxProcessing,
  heartbeatInboxProcessing,
  checkpointInboxProcessing,
  overrideStaleInboxProcessing
} from '../lib/inbox-processing.mjs';
import { inspectInboxDuplicateBatch, recordDuplicateDecision } from '../lib/inbox-duplicates.mjs';
import { archiveManagedRaw, ingestCaptureFields, scanRaw, purgeRaw, reviewQuarantine, auditPrivacy } from '../lib/privacy.mjs';
import { auditInbox } from '../lib/inbox-audit.mjs';
import { backfillProcessedInboxMetrics } from '../lib/metrics.mjs';
import { formatMetricsSummary, summarizeMetrics, writeMetricsSnapshot } from '../lib/metrics-summary.mjs';
import { formatUtcTimestamp } from '../lib/capture.mjs';
import {
  correctSource,
  registerAttachment,
  registerSource,
  resolveSource,
  createSourceId,
  toWorkspaceRelativePath
} from '../lib/source-registry.mjs';
import { migrateSourceReferences } from '../lib/source-migration.mjs';
import {
  LIFECYCLE_ACTIONS,
  LIFECYCLE_USAGE_ERROR_CODES,
  LifecycleError,
  auditLifecycle,
  listLifecycleRecords,
  migrateLifecycleRecords,
  readLifecycleRecord,
  registerLifecycleRecord,
  reconcileTrackedSource,
  relocateLifecycleRecord,
  assertLifecycleWritable,
  findPathClaims,
  retrieveLifecycleRecord,
  retrieveLifecycleRecords,
  transitionLifecycleRecord,
  unlockLifecycle
} from '../lib/review-lifecycle.mjs';
import { VALIDATION_EXIT_CODES, formatValidationReport, validateWorkspace } from '../lib/workspace-validation.mjs';
import {
  INPUT_QUEUE_USAGE_ERROR_CODES,
  InputQueueError,
  addInputRequest,
  auditInputQueue,
  closeInputRequest,
  listInputRequests,
  migrateInputQueue,
  readInputRequest,
  refreshInputQueueView,
  reopenInputRequest,
  reviewInputQueue,
  unlockInputQueue,
  updateInputRequest
} from '../lib/input-queue.mjs';

const args = process.argv.slice(2);
const [command, subcommand, ...rest] = args;
const cwd = process.cwd();
const thisFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(thisFile), '..');
const isDirectRun = process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(thisFile);
const PACKAGE_REPOSITORY = 'github:simplybenuk/product-mole';
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const HELP_URL = 'https://github.com/simplybenuk/product-mole#readme';
const CRITIQUE_TARGETS = Object.freeze([
  'idea',
  'strategy',
  'roadmap',
  'spec',
  'decision-brief'
]);

const WORKSPACE_SCAFFOLD_DIRS = Object.freeze([
  '0-bootstrap',
  '1-routing',
  '2-summaries',
  '3-indexes',
  '4-context',
  '5-evidence',
  '6-raw'
]);

const WORKSPACE_SCAFFOLD_FILES = Object.freeze([
  ['agents.md', 'agents.md'],
  ['governance/change-log.md', 'governance/change-log.md'],
  ['governance/input-queue.md', 'governance/input-queue.md'],
  ['governance/input-queue/README.md', 'governance/input-queue/README.md'],
  ['governance/metrics/daily.json', 'governance/metrics/daily.json'],
  ['governance/metrics/weekly.json', 'governance/metrics/weekly.json'],
  ['governance/metrics/monthly.json', 'governance/metrics/monthly.json'],
  ['governance/metrics/seen-today.json', 'governance/metrics/seen-today.json'],
  ['governance/metrics/dashboard.html', 'governance/metrics/dashboard.html'],
  ['governance/metrics/outcomes.json', 'governance/metrics/outcomes.json'],
  ['governance/quality-checklist.md', 'governance/quality-checklist.md'],
  ['governance/run-receipts/README.md', 'governance/run-receipts/README.md'],
  ['governance/sources/README.md', 'governance/sources/README.md'],
  ['governance/lifecycle/README.md', 'governance/lifecycle/README.md'],
  ['schemas/source-record-v1.schema.json', 'schemas/source-record-v1.schema.json'],
  ['schemas/review-lifecycle-v1.schema.json', 'schemas/review-lifecycle-v1.schema.json'],
  ['schemas/input-queue-v1.schema.json', 'schemas/input-queue-v1.schema.json'],
  ['mole.instance-template.yaml', 'mole.instance.yaml']
]);

const LIFECYCLE_AGENT_GUIDANCE = 'Check review state with `mole retrieve` before relying on context. Only accepted records are approved, and a file without an accepted record is unreviewed. Leave new durable context as a draft and submit it with `mole lifecycle submit`. After editing an accepted file in place, run `mole lifecycle revise` on its record and submit it again. Never approve, reject, or supersede a record yourself; those decisions belong to a human.';

export function getHelpOutput() {
  return `Mole CLI v${getSourceVersion()}

Usage:
  mole new <workspace-name>            Create a clean Mole workspace scaffold.
  mole init [target-dir]               Alias for "mole new" for older docs/scripts.
  mole create <artifact> [output-path] Create a draft artifact from a Mole template.
  mole insight [options] <text>        Capture a raw product insight into the inbox.
  mole note [options] <text>           Alias for "mole insight".
  mole signal [options] <text>         Alias for "mole insight".
  mole product-update <audience> <timescale> [--format email|teams|blog|brief]
                                      Print an agent instruction for a stakeholder update.
  mole critique <target> [claim-or-path]
                                      Print a context-grounded critique instruction.
  mole travel-log <change-or-release>  Print an agent instruction for an outcome review of a change or release.
  mole bootstrap-context              Print an agent instruction for first-time top-layer setup.
  mole refresh top-layers             Print an agent instruction for summary/index refresh.
  mole synthesise <target>             Print an agent instruction for synthesis work.
  mole review <target>                 Print an agent instruction for review work.
  mole review input-queue [--limit <n>] [--stale-after-days <n>] [--duplicate-threshold <0-1>] [--format json]
                                      Show the highest-value human-input requests and why they rank.
  mole input-queue add --request <text> --impact <text> --unblocks <text> --actor <name> --actor-type <type>
                                      Ask a person for input. Options: --priority, --blocking, --owner, --due,
                                      --next-review, --answer-format, --effort, --requester, --source, --ref, --reason.
  mole input-queue update <input_id> [fields] --actor <name> --actor-type <type> --reason <text>
                                      Change a request. Fields are the add options plus --status and --not-blocking.
                                      Changing an owner, or deferring with no --next-review, needs
                                      --actor-type human --confirm-human.
  mole input-queue close <input_id> --answer <text> --outcome <text> --actor <name> --actor-type <type>
                                      Record the answer and what it changed.
  mole input-queue close <input_id> --closure-reason duplicate|superseded|stale|not_needed --outcome <text>
                                      --reason <text> --actor <name> --actor-type human --confirm-human
                                      Close a request that was not answered. Add --duplicate-of <input_id>
                                      or --superseded-by <input_id> for those reasons.
  mole input-queue reopen <input_id> --actor <name> --actor-type <type> --reason <text>
                                      Reopen a request. One a person closed needs --actor-type human --confirm-human.
  mole input-queue show <input_id>     Show a request and its history.
  mole input-queue list [--status <status>] [--all]
                                      List open requests; --all includes closed ones.
  mole input-queue migrate [--apply --actor <name> --actor-type <type>]
                                      Give rows in governance/input-queue.md stable IDs.
  mole input-queue refresh-view       Rewrite the generated table from the queue.
  mole input-queue audit              Check the input queue (read-only).
  mole input-queue unlock             Remove a queue lock left by a stopped process.
  mole inbox claim [processor]         Claim a run with a leased, owned lock.
  mole inbox heartbeat --run-id id     Renew the matching active run lease.
  mole inbox checkpoint --run-id id [--processed path]
                                      Save restart-safe partial progress.
  mole privacy archive <source-id> [--apply] [--recover]
                                      Move cleaned raw to its managed archive path.
  mole privacy scan [--apply]          Quarantine manual raw files; dry-run by default.
  mole retention purge [--apply]       Remove expired raw files; dry-run by default.
  mole privacy release <source-id> --confirm-reviewed [--apply]
  mole inbox audit                    Audit live files, leases, conflicts, and receipts.
  mole inbox duplicates check <id>...  Check registered sources before enrichment.
  mole inbox duplicates decide        Record an explicit human duplicate decision.
  mole inbox complete [options] [summary]
                                      Write an idempotent receipt and release the lock.
  mole inbox override-stale [options] Replace an expired lock with an audited override.
  mole metrics [--format json] [--events]
                                      Summarise processing activity and review-state changes (read-only).
  mole metrics snapshot               Write the summary to governance/metrics/outcomes.json for the dashboard.
  mole metrics backfill               Rebuild metrics from inbox processing receipts.
  mole source register <path> [options]
                                      Register an existing file without changing its bytes.
  mole source resolve <source_id> [--json]
                                      Resolve a source by immutable ID (read-only).
  mole source reconcile <source_id> --path <path>
                                      Record an explicitly confirmed source move.
  mole source correct <source_id> --reason <text>
                                      Record an explicit content correction.
  mole source migrate [--apply] [--json]
                                      Classify legacy path references; apply is opt-in.
  mole lifecycle register <source_id> --state <state> --actor <name> --actor-type <type>
                                      Open a review record as raw, evidence, draft, or unreviewed.
  mole lifecycle evidence|draft|submit|revise <record_id> [options]
                                      Move a record toward review; agents may run these.
  mole lifecycle approve|reject <record_id> --actor <name> --actor-type human --confirm-human --reason <text>
                                      Record a human review decision. Approve also needs --expect-revision <n>.
  mole lifecycle supersede <record_id> --replacement <record_id> [human options]
                                      Replace an accepted record with another accepted record.
  mole lifecycle withdraw <record_id> [options]
                                      Close a record, such as one whose file is gone. Once-accepted records need a human.
  mole lifecycle relocate <record_id> --path <path> [options]
                                      Point a record at the file it now lives in.
  mole lifecycle show <record_id>      Show a record and its transition history.
  mole lifecycle list [--state <state>] [--path <path>]
                                      List review records, or find the record for a file.
  mole lifecycle audit                Check the review ledger and reviewed files (read-only).
  mole lifecycle migrate [--apply]    Report untracked files; apply registers them as raw or unreviewed.
  mole lifecycle unlock               Remove a mutation lock left by a stopped process.
  mole retrieve [record_id] [--include-state <state>]
                                      Read accepted context; other states are opt-in.
  mole install skills                  Install Mole agent skills into ~/.agents/skills.
  mole check-updates                   Compare this CLI version with the workspace.
  mole upgrade [version]               Update the globally installed Mole CLI from a stable tag.
  mole doctor                          Check workspace metadata and required folders.
  mole validate [path] [--format text|json] [--stale-after-days <n>]
                                      Run the full read-only workspace check. Exit 0 healthy, 1 findings.

Artifacts:
  roadmap, spec, decision-brief, strategy-memo, prioritisation-draft, product-update,
  product-travel-log

Examples:
  mole new my-mole
  mole init my-mole
  mole create roadmap
  mole create spec drafts/spec.md
  mole insight "Users trust CSV export more than dashboard totals"
  mole note "Support team heard onboarding confusion"
  mole signal "Trial users miss the export button"
  mole insight --stakeholder CEO "Asked whether enterprise onboarding is improving"
  mole product-update CEO 2-weeks --format email
  mole critique idea "Improve regulated-customer onboarding"
  mole critique spec drafts/spec.md
  mole upgrade 0.3.1
  mole bootstrap-context
  mole refresh top-layers
  mole install skills
  mole synthesise inbox
  mole review input-queue
  mole inbox claim --processor "Your Name" --claimed-path 6-raw/inbox/a.md
  mole inbox checkpoint --run-id <run-id> --processor "Your Name" --processed 6-raw/inbox/a.md
  mole inbox complete --run-id <run-id> --processor "Your Name" --processed 6-raw/inbox/a.md "Promoted one note"
  mole inbox override-stale --run-id <new-run-id> --processor "Your Name" --reason "Confirmed prior run stopped"
  mole metrics
  mole metrics backfill
  mole source register 6-raw/inbox/export.csv --source-type export
  mole source resolve src_8d31cc34-c04c-41ac-82e3-75518bb5a7e0 --json
  mole source migrate
  mole lifecycle submit <record_id> --actor "Agent" --actor-type agent --reason "Ready for review"
  mole lifecycle approve <record_id> --actor "Your Name" --actor-type human --confirm-human --reason "Matches the interview evidence" --source <source_id> --expect-revision 2
  mole lifecycle audit
  mole retrieve
  mole retrieve <record_id> --include-state pending_review

More help:
  ${HELP_URL}
`;
}

export function getInstallBanner() {
  return String.raw`
          ▄▄▄▄▄▄▄              Product Mole
       ▄███████████▄           Local-first product context
     ▄██▀         ▀██▄         for teams and AI agents
    ██               ██
   ██     ●     ●     ██
   ██                 ██
   ██       ▄█▄       ██
   ██                 ██
   ██   ▄██▄   ▄██▄   ██

Mole is a local-first product context system for teams and AI agents.
It helps you capture raw inputs, distil them into evidence, and generate
better roadmaps, specs, decisions, and prioritisation work from shared context.
`;
}

function printHelp() {
  process.stdout.write(getHelpOutput());
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(from, to) {
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
}

function copyDirRecursive(from, to, options = {}) {
  const { excludeNames = new Set() } = options;
  ensureDir(to);

  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (excludeNames.has(entry.name)) continue;

    const sourcePath = path.join(from, entry.name);
    const targetPath = path.join(to, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(sourcePath, targetPath, options);
    } else if (entry.isFile()) {
      copyFile(sourcePath, targetPath);
    }
  }
}

export function createWorkspaceScaffold(target) {
  target = path.resolve(target);
  let targetStat;
  try {
    targetStat = fs.lstatSync(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (targetStat) {
    if (!targetStat.isDirectory()) {
      throw new Error(`Workspace target must be a directory, not a file or symlink: ${target}`);
    }
    if (fs.readdirSync(target).some((name) => !['.git', '.DS_Store', 'Thumbs.db'].includes(name))) {
      throw new Error(`Refusing to create a workspace in a nonempty directory: ${target}. Choose a new or empty directory.`);
    }
  }
  ensureDir(target);

  for (const dir of WORKSPACE_SCAFFOLD_DIRS) {
    const sourcePath = path.join(repoRoot, dir);
    const targetPath = path.join(target, dir);

    if (dir === '6-raw') {
      ensureDir(path.join(targetPath, 'inbox'));
      copyFile(path.join(sourcePath, 'inbox', 'README.md'), path.join(targetPath, 'inbox', 'README.md'));
    } else if (exists(sourcePath)) {
      copyDirRecursive(sourcePath, targetPath);
    } else {
      ensureDir(targetPath);
    }
  }

  fs.writeFileSync(path.join(target, '.gitignore'), '/6-raw/**\n!/6-raw/inbox/\n!/6-raw/inbox/README.md\n/governance/privacy/\n');

  for (const [source, destination] of WORKSPACE_SCAFFOLD_FILES) {
    copyFile(path.join(repoRoot, source), path.join(target, destination));
  }
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'insight';
}

function nowUtc() {
  return new Date().toISOString();
}

function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readSimpleYamlField(file, field) {
  const content = readTextIfExists(file);
  if (!content) return null;

  const pattern = new RegExp(`^${field}:\\s*(.+?)\\s*$`, 'm');
  const match = content.match(pattern);
  if (!match) return null;

  return match[1].replace(/^['"]|['"]$/g, '');
}

function getSourceVersion() {
  return readTextIfExists(path.join(repoRoot, 'VERSION'))?.trim() || 'unknown';
}

function getInstanceVersion(instanceRoot = cwd) {
  const instanceFile = path.join(instanceRoot, 'mole.instance.yaml');
  return readSimpleYamlField(instanceFile, 'cascade_version') || readSimpleYamlField(instanceFile, 'mole_version');
}

function compareVersions(a, b) {
  const left = String(a).split('.').map(part => Number.parseInt(part, 10) || 0);
  const right = String(b).split('.').map(part => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }

  return 0;
}

function getUpgradeOwnership() {
  const content = readTextIfExists(path.join(repoRoot, 'upgrade-ownership.json'));
  if (!content) return null;

  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function getAgentsHome() {
  const envHome = process.env.AGENTS_HOME?.trim();
  return path.resolve(envHome ? envHome : path.join(os.homedir(), '.agents'));
}

function initInstance(targetDir) {
  const target = path.resolve(cwd, targetDir || 'mole-instance');
  // The scaffold copies over files of the same name, so an existing
  // workspace would lose its summaries, indexes, and metric history.  The
  // scaffold writes no top-level dotfiles, so a fresh git repository or a
  // folder holding only operating-system noise still counts as empty.
  let entries = null;
  try {
    entries = fs.readdirSync(target).filter((name) => !name.startsWith('.') && name !== 'Thumbs.db');
  } catch (err) {
    if (err.code === 'ENOTDIR') {
      console.error(`Cannot create a workspace at ${target}: it is a file.`);
      process.exit(1);
    }
    if (err.code !== 'ENOENT') throw err;
  }
  if (entries && entries.length > 0) {
    console.error(`Refusing to create a workspace at ${target}: the folder is not empty. Choose a new folder name. To update an existing workspace, run "mole check-updates" from inside it.`);
    process.exit(1);
  }
  createWorkspaceScaffold(target);

  console.log(`Initialised Mole workspace at: ${target}`);
  console.log('Created a clean Mole workspace scaffold.');
  console.log('Next steps:');
  console.log('- customise 0-bootstrap/repo-purpose.md');
  console.log('- fill key summaries in 2-summaries/');
  console.log('- start capturing in 6-raw/inbox/ or with `mole insight "..."`');
  console.log('- open the new workspace folder in your editor');
  console.log('- optionally install agent skills with `mole install skills`');
}

function createArtifact(kind, outputPath) {
  const templateMap = {
    roadmap: 'roadmap-template.md',
    spec: 'spec-template.md',
    'decision-brief': 'decision-brief-template.md',
    'strategy-memo': 'strategy-memo-template.md',
    'prioritisation-draft': 'prioritisation-draft-template.md',
    'product-update': 'product-update-template.md',
    'product-travel-log': 'product-travel-log-template.md'
  };

  const file = templateMap[kind];
  if (!file) {
    console.error(`Unknown artifact type: ${kind}`);
    process.exit(1);
  }

  const source = path.join(repoRoot, 'templates', 'artifacts', file);
  const defaultOutput = {
    roadmap: '4-context/product/roadmap-draft.md',
    spec: '4-context/product/spec-draft.md',
    'decision-brief': '4-context/decisions/decision-brief-draft.md',
    'strategy-memo': '4-context/strategy/strategy-memo-draft.md',
    'prioritisation-draft': '4-context/product/prioritisation-draft.md',
    'product-update': '4-context/product/product-update-draft.md',
    'product-travel-log': '4-context/travel-log/product-travel-log-draft.md'
  }[kind];

  let relativeTarget;
  try {
    relativeTarget = toWorkspaceRelativePath(cwd, outputPath || defaultOutput);
  } catch (error) {
    console.error(`Refusing to create a draft outside the workspace: ${error.message}`);
    process.exit(1);
  }
  const target = path.resolve(cwd, ...relativeTarget.split('/'));
  if (exists(target)) {
    console.error(`Refusing to overwrite existing file: ${target}`);
    process.exit(1);
  }

  // Check everything that could stop the draft being tracked before writing
  // it, so a refusal never leaves an untracked file behind.
  try {
    assertLifecycleWritable(cwd);
    const claims = findPathClaims(cwd, relativeTarget);
    if (claims.length) {
      const claim = claims[0];
      console.error(`Refusing to create a draft at ${relativeTarget}: that path belongs to ${claim.state} lifecycle record ${claim.record_id}. If its file now lives somewhere else, run "mole lifecycle relocate ${claim.record_id} --path <new path>". If it was deleted, run "mole lifecycle withdraw ${claim.record_id}". Otherwise choose another output path. Nothing was written.`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Refusing to create a draft that cannot be tracked: ${error.message} Nothing was written.`);
    process.exit(1);
  }

  copyFile(source, target);
  console.log(`Created ${kind} draft: ${target}`);

  let sourceId = null;
  try {
    sourceId = registerSource(cwd, {
      path: relativeTarget,
      source_type: 'file',
      captured_by: resolveCapturedBy(),
      channel: 'cli',
      path_reason: 'created',
      content_change_type: 'created'
    }).source_id;
    const lifecycle = registerLifecycleRecord(cwd, {
      sourceId,
      state: 'draft',
      actor: 'mole-cli',
      actorType: 'automation',
      reason: `Created ${kind} draft from a template.`,
      newFile: true
    });
    console.log(`Source ID: ${sourceId}`);
    console.log(`Lifecycle record: ${lifecycle.record_id} (draft)`);
  } catch (error) {
    console.error(`The draft was written to ${relativeTarget} but is not tracked yet: ${error.message}`);
    console.error(sourceId
      ? `Keep the file. When the problem is fixed, run: mole lifecycle register ${sourceId} --state draft --actor "<name>" --actor-type <type>`
      : `Keep the file. When the problem is fixed, run: mole source register ${relativeTarget}, then mole lifecycle register <source_id> --state draft --actor "<name>" --actor-type <type>`);
    process.exit(1);
  }

  console.log('\nSuggested next agent instruction:\n');
  outputDraftInstruction(kind);
}

const INSIGHT_OPTIONS = Object.freeze({
  '--stakeholder': (metadata, value) => { metadata.stakeholder = value; },
  '--requested-by': (metadata, value) => { metadata.requestedBy = value; },
  '--audience': (metadata, value) => { metadata.audience.push(value); },
  '--interest-area': (metadata, value) => { metadata.interestAreas.push(value); },
  '--visibility': (metadata, value) => { metadata.visibility = value; },
  '--captured-by': (metadata, value) => { metadata.capturedBy = value; },
  '--follow-up-by': (metadata, value) => { metadata.followUpBy = value; }
});

function parseInsightArgs(values) {
  const metadata = {
    audience: [],
    interestAreas: []
  };
  const textParts = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const apply = Object.hasOwn(INSIGHT_OPTIONS, value) ? INSIGHT_OPTIONS[value] : null;
    if (!apply) {
      textParts.push(value);
      continue;
    }
    // A missing value must not turn the option name into captured text.
    const next = values[index + 1];
    if (!next || next.startsWith('--')) return { error: `Missing value for ${value}.`, metadata };
    apply(metadata, next);
    index += 1;
  }

  return { text: textParts.join(' ').trim(), metadata };
}

function captureInsight(values) {
  const { text, metadata, error } = parseInsightArgs(values);
  if (error) {
    console.error(`${error} Nothing was captured.`);
    process.exit(1);
  }
  if (!text) {
    console.error('Missing insight text. Example: mole insight "Users trust CSV export more than dashboard totals"');
    process.exit(1);
  }

  try { metadata.visibility = validateVisibility(metadata.visibility || 'internal'); }
  catch { console.error('Unsupported visibility. Nothing was captured.'); process.exit(1); }
  const createdAt = nowUtc();
  const sourceId = createSourceId();
  let privacy;
  try {
    privacy = ingestCaptureFields(cwd, { sourceId, now: createdAt,
      fields: { text, ...metadata, capturedBy: resolveCapturedBy(metadata.capturedBy) },
      render: (fields, quarantine) => buildInsightCaptureContent(fields.text, {
        ...fields, sourceId, createdAt, capturedBy: quarantine ? fields.capturedBy : '[PERSON_NAME]'
      }) });
  } catch {
    console.error('Privacy capture failed; inspect local policy and permissions.');
    process.exit(1);
  }
  const target = path.join(cwd, privacy.path);
  if (privacy.outcome === 'quarantined') {
    console.log(`Quarantined capture: ${sourceId}. Human privacy review required.`);
    return;
  }

  try {
    registerSource(cwd, {
      source_id: sourceId,
      path: target,
      source_type: 'note',
      captured_at: createdAt,
      captured_by: '[PERSON_NAME]',
      channel: 'cli',
      original_date: createdAt.slice(0, 10),
      visibility: metadata.visibility || 'internal',
      path_reason: 'captured',
      content_change_type: 'captured'
    });
  } catch (err) {
    console.error('Capture saved; source registration requires local recovery.');
    process.exit(1);
  }

  // The capture is saved and registered at this point.  A lifecycle problem
  // must not make it look failed, or a retry would capture the note twice.
  let recordId = null;
  let lifecycleWarning = null;
  try {
    recordId = registerLifecycleRecord(cwd, {
      sourceId,
      state: 'raw',
      actor: 'mole-cli',
      actorType: 'automation',
      reason: 'Captured from the CLI.',
      now: createdAt
    }).record_id;
  } catch (err) {
    lifecycleWarning = 'Local lifecycle recovery required.';
  }

  console.log(`Captured insight: ${target}`);
  console.log(`Source ID: ${sourceId}`);
  if (recordId) {
    console.log(`Lifecycle record: ${recordId} (raw)`);
  } else {
    console.error(`Warning: the capture is saved but has no lifecycle record yet: ${lifecycleWarning}`);
    console.error('Do not capture it again. When the problem is fixed, run: mole lifecycle migrate --apply --actor "<name>" --actor-type <type>');
  }
  console.log('\nSuggested next command:');
  console.log('mole synthesise inbox');
}

function yamlScalar(value, { trim = true } = {}) {
  const text = trim ? String(value || '').trim() : String(value ?? '');
  if (!text && trim) return '';
  // YAML folds some Unicode line breaks and rejects raw C1 controls.
  return JSON.stringify(text).replace(/[\u007f-\u009f\u2028\u2029]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function yamlInlineList(values = []) {
  const items = values.map(value => String(value || '').trim()).filter(Boolean);
  return `[${items.map(item => JSON.stringify(item)).join(', ')}]`;
}

export function buildInsightCaptureContent(text, options = {}) {
  const createdAt = options.createdAt || nowUtc();
  const capturedBy = resolveCapturedBy(options.capturedBy);

  return `---
title: Raw Insight
capture_type: insight
source: mole CLI
source_id: ${options.sourceId || ''}
captured_by: ${yamlScalar(capturedBy)}
created_at: ${createdAt}
summary: ${yamlScalar(text, { trim: false })}
stakeholder: ${yamlScalar(options.stakeholder)}
requested_by: ${yamlScalar(options.requestedBy)}
audience: ${yamlInlineList(options.audience)}
interest_areas: ${yamlInlineList(options.interestAreas)}
visibility: ${yamlScalar(options.visibility || 'internal')}
follow_up_by: ${yamlScalar(options.followUpBy)}
tags: []
---

# Raw Insight

## Insight
${text}

## Context / why it matters

## Optional follow-up questions
-
`;
}

export function installMoleSkills(options = {}) {
  const { silent = false } = options;
  const agentsHome = getAgentsHome();
  const skillsDir = path.join(agentsHome, 'skills');
  const sourceDir = path.join(repoRoot, 'cli', 'skills');
  ensureDir(skillsDir);

  const skills = fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && exists(path.join(sourceDir, entry.name, 'SKILL.md')))
    .map(entry => entry.name)
    .sort();

  for (const skill of skills) {
    copyDirRecursive(path.join(sourceDir, skill), path.join(skillsDir, skill));
  }

  if (!silent) {
    console.log(getInstallBanner());
    console.log(`Installed ${skills.length} Mole agent skills to: ${skillsDir}`);
    console.log('Available skills should now include:');
    for (const skill of skills) {
      console.log(`- ${skill}`);
    }
  }

  return { skillsDir, skills };
}

function outputDraftInstruction(kind) {
  const map = {
    roadmap: 'Create a roadmap draft using 2-summaries/, 3-indexes/, relevant 4-context/ modules, and any needed 5-evidence/ summaries. Update the created markdown draft in place and list missing human inputs.',
    spec: 'Create a product spec draft using relevant summaries, indexes, context modules, and evidence. Update the created markdown draft in place and note assumptions, open questions, and missing human inputs.',
    'strategy-memo': 'Create a strategy memo using the highest-signal relevant context first, descending only as needed.',
    'decision-brief': 'Create a decision brief with recommendation, options, trade-offs, and missing inputs.',
    'prioritisation-draft': 'Create a prioritisation draft with criteria, ranked items, and uncertainties.',
    'product-update': 'Create a stakeholder-specific product update using stakeholder memory, relevant summaries, product context, and evidence. Tailor the format and include a retrieval receipt.',
    'product-travel-log': 'Fill in the travel log draft for one change or release using the mole-product-travel-log skill: original intent, what shipped, evidence before and after, interpretation, learnings, and a decision of continue, iterate, stop, investigate, or unknown for each change. Write "unknown" where evidence is missing, do not invent an intent or a result, and submit the report for human review.'
  };
  const instruction = map[kind] || `Create a ${kind} draft from Mole using progressive retrieval.`;
  console.log(`${instruction} ${LIFECYCLE_AGENT_GUIDANCE}`);
}

function parseProductUpdateArgs(values) {
  const positional = [];
  let format = 'brief';

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value === '--format') {
      format = readOptionValue(values, index, value);
      index += 1;
    } else {
      positional.push(value);
    }
  }

  return {
    audience: positional[0] || '',
    timescale: positional[1] || '',
    format
  };
}

export function buildProductUpdateInstruction(audience, timescale, format = 'brief') {
  const targetAudience = String(audience || '').trim() || 'the requested stakeholder or group';
  const updateTimescale = String(timescale || '').trim() || 'the requested timescale';
  const outputFormat = String(format || '').trim() || 'brief';

  return `Suggested agent instruction:

Generate a product update for ${targetAudience} covering ${updateTimescale} in ${outputFormat} format. Use the Mole operating model: retrieve top-down, descend only as needed, and keep claims evidence-backed. Start with stakeholder memory in \`4-context/stakeholders.md\`, then read relevant \`2-summaries/\`, \`3-indexes/\`, product context in \`4-context/\`, evidence in \`5-evidence/\`, and recent raw or synthesised items matching ${updateTimescale}. Tailor the update to the audience's product interests, decision authority, communication preferences, known concerns, and likely asks. Separate headline summary, progress, what changed, risks or blockers, decisions needed, asks, and suggested follow-up. Include a concise retrieval receipt.`;
}

export function buildCritiqueInstruction(target, subject = '') {
  const normalizedTarget = String(target || '').trim().toLowerCase();

  if (!CRITIQUE_TARGETS.includes(normalizedTarget)) {
    throw new Error(
      `Unsupported critique target. Supported critique targets: ${CRITIQUE_TARGETS.join(', ')}.`
    );
  }

  const detail = String(subject || '').trim();
  const targetDescription = detail
    ? `the ${normalizedTarget}: ${detail}`
    : `the requested ${normalizedTarget}`;

  return `Suggested agent instruction:

Critique ${targetDescription} against the current Mole context. If the target names a file, read it before judging it. If it is a claim or proposal, treat the supplied text as the object to test. Start with \`0-bootstrap/\`, \`1-routing/\`, relevant \`2-summaries/\`, and \`3-indexes/\`; descend into \`4-context/\` and \`5-evidence/\` only as needed. Read \`governance/input-queue.md\` when missing human input affects the judgement. Separate facts and source-backed evidence from interpretation. Do not invent support, results, or certainty.

Return:
- Critique target
- What supports it
- What weakens it
- Assumptions
- What is missing, including missing evidence or human inputs
- Judgement and confidence
- Best next step
- Retrieval receipt with files read, deepest layer reached, why descent stopped, and uncertainties

Use \`templates/artifacts/critique-template.md\` when creating or updating a critique file. Keep pending or rejected context out of normal evidence unless the task explicitly asks to inspect it.`;
}

export function buildTravelLogInstruction(subject = '') {
  const detail = String(subject || '').trim();
  if (!detail) {
    throw new Error('Name the change or release to review, such as: mole travel-log "release 2026.09".');
  }

  return `Suggested agent instruction:

Write a product travel log for: ${detail}. Use the mole-product-travel-log skill. Create the draft with \`mole create product-travel-log 4-context/travel-log/<release-or-change>.md\` and fill it in place. Find the original intent in an intent record, spec, decision, or roadmap entry; if none exists, write "No intent record found" and do not reconstruct one. Read the full release artefact for what shipped. Retrieve analytics evidence and qualitative signals for the period before and after, top-down from \`3-indexes/\` and \`2-summaries/\` into \`4-context/\` and \`5-evidence/\`. If the release holds several changes, review each one.

Label every statement as a fact, an observation, an interpretation, or an assumption. Write "unknown" wherever evidence is missing and say what is needed. Do not invent an intent, a metric, a result, or a cause. Say when the review is too early and when attribution is weak.

Return:
- Change and release
- Original intent
- What shipped
- Expected outcome
- Evidence before and after
- Unexpected effects
- Interpretation and confidence
- What we learned
- Decision for each change: continue, iterate, stop, investigate, or unknown
- Recommended next action
- Unresolved questions and the next review date
- Sources and evidence gaps
- Retrieval receipt

Do not change existing context. Submit the report with \`mole lifecycle submit <record_id> --actor "<agent name>" --actor-type agent --reason "Ready for review"\` and stop: a learning is durable only after a person approves the report. ${LIFECYCLE_AGENT_GUIDANCE}`;
}

function travelLog(values) {
  try {
    console.log(buildTravelLogInstruction(values.join(' ')));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

function critique(values) {
  const [target, ...subjectParts] = values;

  try {
    console.log(buildCritiqueInstruction(target, subjectParts.join(' ')));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

export function buildBootstrapContextInstruction() {
  return `Suggested agent instruction:

Bootstrap this Mole workspace context. Treat blank, placeholder, or starter-template files in \`2-summaries/\` and \`3-indexes/\` as missing top-layer context. Read \`0-bootstrap/\`, \`1-routing/\`, all existing \`4-context/\` modules, useful \`5-evidence/\` material, and current unprocessed inbox material in \`6-raw/inbox/\`. Populate the initial domain summaries and indexes with concise, evidence-backed context, preserving uncertainty and adding missing human questions with \`mole input-queue add\`. Do not invent product facts; mark low-confidence conclusions as hypotheses and link to supporting files. ${LIFECYCLE_AGENT_GUIDANCE}`;
}

export function buildRefreshTopLayersInstruction() {
  return `Suggested agent instruction:

Refresh the Mole top layers. Compare \`2-summaries/\` and \`3-indexes/\` with lower-layer context in \`4-context/\`, evidence in \`5-evidence/\`, recent processed inbox outputs, and any relevant unprocessed \`6-raw/inbox/\` material. Update blank, placeholder, stale, or incomplete summaries and indexes so they accurately route future retrieval. Keep changes compact and evidence-backed, avoid copying raw detail upward, and add missing human questions with \`mole input-queue add\` when the lower layers do not justify a confident summary. ${LIFECYCLE_AGENT_GUIDANCE}`;
}

function productUpdate(values) {
  let parsed;
  try {
    parsed = parseProductUpdateArgs(values);
  } catch (error) {
    console.error(`${error.message} Example: mole product-update CEO 2-weeks --format email`);
    process.exit(1);
  }
  const { audience, timescale, format } = parsed;

  if (!audience || !timescale) {
    console.error('Missing product update target. Example: mole product-update CEO 2-weeks --format email');
    process.exit(1);
  }

  console.log(buildProductUpdateInstruction(audience, timescale, format));
}

function readOptionValue(values, index, option) {
  const value = values[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}.`);
  return value;
}

export function parseSourceRegisterValues(values = []) {
  const options = {
    sourceType: 'file'
  };
  let sourcePath = '';
  let sourceReferenceKind = null;
  let sourceReferenceValue = null;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--') && !sourcePath) {
      sourcePath = value;
      continue;
    }

    if (value === '--source-type') {
      options.sourceType = readOptionValue(values, index, value);
      index += 1;
    } else if (value === '--original-date') {
      options.originalDate = readOptionValue(values, index, value);
      index += 1;
    } else if (value === '--channel') {
      options.channel = readOptionValue(values, index, value);
      index += 1;
    } else if (value === '--media-type') {
      options.mediaType = readOptionValue(values, index, value);
      index += 1;
    } else if (value === '--captured-by') {
      options.capturedBy = readOptionValue(values, index, value);
      index += 1;
    } else if (value === '--visibility') {
      options.visibility = readOptionValue(values, index, value);
      index += 1;
    } else if (value === '--parent-source-id') {
      options.parentSourceId = readOptionValue(values, index, value);
      index += 1;
    } else if (value === '--label') {
      options.label = readOptionValue(values, index, value);
      index += 1;
    } else if (value === '--relationship') {
      options.relationship = readOptionValue(values, index, value);
      index += 1;
    } else if (value === '--retention-mode') {
      options.retention = { ...(options.retention || {}), mode: readOptionValue(values, index, value) };
      index += 1;
    } else if (value === '--review-after') {
      options.retention = { ...(options.retention || {}), reviewAfter: readOptionValue(values, index, value) };
      index += 1;
    } else if (value === '--expires-at') {
      options.retention = { ...(options.retention || {}), expiresAt: readOptionValue(values, index, value) };
      index += 1;
    } else if (value === '--source-reference-kind') {
      sourceReferenceKind = readOptionValue(values, index, value);
      index += 1;
    } else if (value === '--source-reference' || value === '--source-reference-value') {
      sourceReferenceValue = readOptionValue(values, index, value);
      index += 1;
    } else if (value === '--json') {
      options.json = true;
    } else {
      throw new Error(`Unknown source register option: ${value}`);
    }
  }

  if (!sourcePath) throw new Error('A source path is required.');
  if (sourceReferenceKind || sourceReferenceValue) {
    if (!sourceReferenceKind || !sourceReferenceValue) throw new Error('Both --source-reference-kind and --source-reference are required.');
    options.sourceReference = { kind: sourceReferenceKind, value: sourceReferenceValue };
  }
  return { sourcePath, options };
}

function parseSourceIdAndOptions(values, commandName) {
  const sourceId = values.find((value) => !value.startsWith('--'));
  if (!sourceId) throw new Error(`A source ID is required for source ${commandName}.`);
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === sourceId) continue;
    if (value === '--json') {
      options.json = true;
    } else if (value === '--path') {
      options.path = readOptionValue(values, index, value);
      index += 1;
    } else if (value === '--reason') {
      options.reason = readOptionValue(values, index, value);
      index += 1;
    } else {
      throw new Error(`Unknown source ${commandName} option: ${value}`);
    }
  }
  return { sourceId, options };
}

function parseSourceMigrateValues(values = []) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--apply') {
      options.apply = true;
    } else if (value === '--json') {
      options.json = true;
    } else if (value === '--report') {
      options.reportPath = readOptionValue(values, index, value);
      index += 1;
    } else {
      throw new Error(`Unknown source migrate option: ${value}`);
    }
  }
  return options;
}

function printSourceResult(result, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.source_id) console.log(`Source ID: ${result.source_id}`);
  if (result.path || result.current_path) console.log(`Path: ${result.path || result.current_path}`);
  if (result.status) console.log(`Status: ${result.status}`);
  if (result.record_path) console.log(`Record: ${result.record_path}`);
  if (result.candidates?.length) {
    console.log('Candidates:');
    for (const candidate of result.candidates) console.log(`- ${candidate.path}`);
  }
  if (result.findings?.length) {
    console.log('Findings:');
    for (const item of result.findings) console.log(`- ${item.type || item.finding_type}`);
  }
}

function runSourceCommand(action, values = []) {
  try {
    if (action === 'migrate') {
      const options = parseSourceMigrateValues(values);
      const reportPath = options.reportPath || (options.apply
        ? path.join('governance', 'run-receipts', 'source-migration', `${formatUtcTimestamp()}.json`)
        : undefined);
      const result = migrateSourceReferences(cwd, { ...options, reportPath });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Mole source migration ${result.mode}.`);
        console.log(`References scanned: ${result.counts.total}`);
        console.log(`Resolved: ${result.counts.resolved}`);
        console.log(`Ambiguous: ${result.counts.ambiguous}`);
        console.log(`Unresolved: ${result.counts.unresolved}`);
        console.log(`Registry findings: ${result.findings.length}`);
        console.log(`Artifacts changed: ${result.counts.changed}`);
        if (result.report_path) console.log(`Report: ${result.report_path}`);
      }
      return;
    }

    if (action === 'register') {
      const { sourcePath, options } = parseSourceRegisterValues(values);
      const result = options.parentSourceId
        ? registerAttachment(cwd, options.parentSourceId, sourcePath, options)
        : registerSource(cwd, { ...options, path: sourcePath });
      if (!options.json) console.log('Registered source.');
      printSourceResult(result, options);
      return;
    }

    if (action === 'resolve') {
      const { sourceId, options } = parseSourceIdAndOptions(values, action);
      printSourceResult(resolveSource(cwd, sourceId), options);
      return;
    }

    if (action === 'reconcile') {
      const { sourceId, options } = parseSourceIdAndOptions(values, action);
      if (!options.path) throw new Error('Missing value for --path.');
      const result = reconcileTrackedSource(cwd, sourceId, options.path, options);
      if (!options.json) console.log(result.changed ? 'Reconciled source.' : 'Source already reconciled.');
      printSourceResult(result, options);
      return;
    }

    if (action === 'correct') {
      const { sourceId, options } = parseSourceIdAndOptions(values, action);
      if (!options.reason) throw new Error('Missing value for --reason.');
      const result = correctSource(cwd, sourceId, options.reason, options);
      if (!options.json) console.log('Recorded source correction.');
      printSourceResult(result, options);
      return;
    }

    throw new Error('Supported source commands: register, resolve, reconcile, correct');
  } catch (error) {
    console.error(`Source command failed: ${error.message}`);
    process.exitCode = 1;
  }
}

class UsageError extends Error {}

/**
 * Strict option parser for the lifecycle and retrieve commands.  Unknown
 * flags, repeated scalar flags, and missing values are usage errors.
 */
export function parseLifecycleValues(values = [], spec = {}) {
  const scalars = new Set(['--format', ...(spec.scalars || [])]);
  const lists = new Set(spec.lists || []);
  const booleans = new Set(['--json', ...(spec.booleans || [])]);
  const maxPositionals = spec.positionals ?? 0;
  const options = {};
  const positionals = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    if (booleans.has(value)) {
      if (options[value]) throw new UsageError(`Duplicate option ${value}.`);
      options[value] = true;
      continue;
    }
    if (!scalars.has(value) && !lists.has(value)) throw new UsageError(`Unknown option ${value}.`);
    const next = values[index + 1];
    if (next === undefined || next.startsWith('--')) throw new UsageError(`Missing value for ${value}.`);
    index += 1;
    if (lists.has(value)) {
      options[value] = [...(options[value] || []), next];
    } else {
      if (Object.prototype.hasOwnProperty.call(options, value)) throw new UsageError(`Duplicate option ${value}.`);
      options[value] = next;
    }
  }

  if (positionals.length > maxPositionals) throw new UsageError(`Unexpected argument: ${positionals[maxPositionals]}`);
  const format = options['--format'] ?? (options['--json'] ? 'json' : 'text');
  if (format !== 'text' && format !== 'json') throw new UsageError('--format must be text or json.');
  if (options['--json'] && format !== 'json') throw new UsageError('--json conflicts with --format text.');
  return { positionals, options, format };
}

// Used only to shape an error raised before the options have been parsed.
function guessLifecycleFormat(values) {
  const index = values.indexOf('--format');
  return values.includes('--json') || (index >= 0 && values[index + 1] === 'json') ? 'json' : 'text';
}

function requireLifecycleOption(options, name) {
  if (!options[name]) throw new UsageError(`Missing required option ${name}.`);
  return options[name];
}

function requireLifecyclePositional(positionals, label) {
  if (!positionals[0]) throw new UsageError(`A ${label} is required.`);
  return positionals[0];
}

function reportLifecycleFailure(error, format) {
  const usage = error instanceof UsageError
    || (error instanceof LifecycleError && LIFECYCLE_USAGE_ERROR_CODES.has(error.code));
  const code = error.code || (usage ? 'INVALID_ARGUMENT' : 'ERROR');
  if (format === 'json') {
    console.log(JSON.stringify({ ok: false, error: { code, message: error.message, details: error.details || {} } }, null, 2));
  }
  console.error(`${usage ? 'Invalid arguments' : 'Refused'}: ${error.message}`);
  process.exitCode = usage ? 2 : 1;
}

function printLifecycleRecord(record) {
  console.log(`Record ID: ${record.record_id}`);
  console.log(`Source ID: ${record.source_id}`);
  console.log(`State: ${record.state}`);
  console.log(`Revision: ${record.revision}`);
  console.log(`Path: ${record.path}`);
  console.log(`Content: sha256 ${record.content_hash.value.slice(0, 16)} (${record.byte_size} bytes)`);
  if (record.source_ids.length) console.log(`Supporting sources: ${record.source_ids.join(', ')}`);
  if (record.decision) {
    console.log(`Decision: ${record.decision.outcome} by ${record.decision.reviewer} at ${record.decision.decided_at}`);
    console.log(`Decision reason: ${record.decision.reason}`);
  }
  if (record.supersedes.length) console.log(`Supersedes: ${record.supersedes.join(', ')}`);
  if (record.superseded_by) console.log(`Superseded by: ${record.superseded_by}`);
}

function printLifecycleHistory(record) {
  console.log('History:');
  for (const entry of record.history) {
    const change = entry.from_state === null ? entry.to_state : `${entry.from_state} -> ${entry.to_state}`;
    const confirmed = entry.human_confirmed ? ', confirmed' : '';
    console.log(`- ${entry.revision}. ${entry.at} ${entry.action} (${change}) by ${entry.actor} [${entry.actor_type}${confirmed}]: ${entry.reason}`);
  }
}

function printLifecycleFindings(findings) {
  for (const item of findings) {
    const subject = item.record_id || item.path || item.source_id || '';
    console.log(`- ${item.type}${subject ? `: ${subject}` : ''}`);
    for (const detail of item.errors || []) console.log(`    ${detail}`);
    if (item.action) console.log(`    ${item.action}`);
  }
}

const LIFECYCLE_TRANSITION_SPEC = Object.freeze({
  positionals: 1,
  scalars: ['--actor', '--actor-type', '--reason', '--replacement', '--expect-revision'],
  lists: ['--source', '--remove-source', '--supersedes'],
  booleans: ['--confirm-human']
});

function parseExpectedRevision(value) {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value)) throw new UsageError('--expect-revision must be a positive integer.');
  return Number(value);
}

function runLifecycleCommand(action, values = []) {
  let format = guessLifecycleFormat(values);
  const emit = (result, printText) => {
    if (format === 'json') console.log(JSON.stringify(result, null, 2));
    else printText();
  };

  try {
    if (action === 'register') {
      const parsed = parseLifecycleValues(values, {
        positionals: 1,
        scalars: ['--state', '--actor', '--actor-type', '--reason'],
        lists: ['--source']
      });
      format = parsed.format;
      const result = registerLifecycleRecord(cwd, {
        sourceId: requireLifecyclePositional(parsed.positionals, 'source ID'),
        state: requireLifecycleOption(parsed.options, '--state'),
        actor: requireLifecycleOption(parsed.options, '--actor'),
        actorType: requireLifecycleOption(parsed.options, '--actor-type'),
        reason: parsed.options['--reason'],
        sourceIds: parsed.options['--source']
      });
      emit(result, () => {
        console.log('Registered lifecycle record.');
        printLifecycleRecord(result.record);
      });
      return;
    }

    if (LIFECYCLE_ACTIONS.includes(action)) {
      const parsed = parseLifecycleValues(values, LIFECYCLE_TRANSITION_SPEC);
      format = parsed.format;
      if (action === 'approve' && parsed.options['--expect-revision'] === undefined) {
        // An approval names the revision that was read, so a draft that was
        // resubmitted in the meantime cannot be accepted unseen.
        throw new UsageError('Approve needs --expect-revision <n>, the revision you reviewed. Read the submission with "mole retrieve <record_id> --include-state pending_review"; it prints the revision.');
      }
      const result = transitionLifecycleRecord(cwd, requireLifecyclePositional(parsed.positionals, 'record ID'), {
        action,
        actor: requireLifecycleOption(parsed.options, '--actor'),
        actorType: requireLifecycleOption(parsed.options, '--actor-type'),
        humanConfirmed: parsed.options['--confirm-human'] === true,
        reason: requireLifecycleOption(parsed.options, '--reason'),
        sourceIds: parsed.options['--source'],
        removeSourceIds: parsed.options['--remove-source'],
        supersedes: parsed.options['--supersedes'],
        replacementId: parsed.options['--replacement'],
        expectedRevision: parseExpectedRevision(parsed.options['--expect-revision'])
      });
      emit(result, () => {
        console.log(`Record ${result.record_id} is now ${result.state} (revision ${result.record.revision}).`);
        printLifecycleRecord(result.record);
        if (result.source_correction) {
          console.log(`Recorded a source content correction for ${result.record.source_id}: the file changed after it was registered.`);
        }
        for (const notice of result.notices || []) console.log(`Note: ${notice}`);
        if (action === 'submit') {
          console.log(`A person can read it with: mole retrieve ${result.record_id} --include-state pending_review`);
          console.log(`and approve what they read with: --expect-revision ${result.record.revision}`);
        }
      });
      return;
    }

    if (action === 'relocate') {
      const parsed = parseLifecycleValues(values, {
        positionals: 1,
        scalars: ['--path', '--actor', '--actor-type', '--reason', '--expect-revision'],
        booleans: ['--confirm-human']
      });
      format = parsed.format;
      const result = relocateLifecycleRecord(cwd, requireLifecyclePositional(parsed.positionals, 'record ID'), {
        path: requireLifecycleOption(parsed.options, '--path'),
        actor: requireLifecycleOption(parsed.options, '--actor'),
        actorType: requireLifecycleOption(parsed.options, '--actor-type'),
        humanConfirmed: parsed.options['--confirm-human'] === true,
        reason: requireLifecycleOption(parsed.options, '--reason'),
        expectedRevision: parseExpectedRevision(parsed.options['--expect-revision'])
      });
      emit(result, () => {
        console.log(`Record ${result.record_id} now points to ${result.record.path} (revision ${result.record.revision}).`);
        printLifecycleRecord(result.record);
        if (result.source_correction) {
          console.log(`Recorded a source content correction for ${result.record.source_id}: the file changed after it was registered.`);
        }
      });
      return;
    }

    if (action === 'show') {
      const parsed = parseLifecycleValues(values, { positionals: 1 });
      format = parsed.format;
      const recordId = requireLifecyclePositional(parsed.positionals, 'record ID');
      const record = readLifecycleRecord(cwd, recordId);
      if (!record) throw new LifecycleError(`Lifecycle record not found: ${recordId}`, 'RECORD_NOT_FOUND', { record_id: recordId });
      emit({ ok: true, record }, () => {
        printLifecycleRecord(record);
        printLifecycleHistory(record);
      });
      return;
    }

    if (action === 'list') {
      const parsed = parseLifecycleValues(values, { lists: ['--state'], scalars: ['--path'] });
      format = parsed.format;
      const records = listLifecycleRecords(cwd, { states: parsed.options['--state'], path: parsed.options['--path'] });
      emit({ ok: true, records }, () => {
        if (!records.length) console.log('No lifecycle records.');
        for (const record of records) {
          console.log(`${record.record_id}  ${record.state}  r${record.revision}  ${record.path}`);
        }
      });
      return;
    }

    if (action === 'audit') {
      const parsed = parseLifecycleValues(values);
      format = parsed.format;
      const result = auditLifecycle(cwd);
      emit(result, () => {
        console.log('Mole lifecycle audit');
        console.log(`ledger          ${result.ledger_path}${result.ledger_exists ? '' : ' (not created yet)'}`);
        console.log(`records         ${result.record_count}`);
        for (const [state, count] of Object.entries(result.state_counts)) {
          if (count) console.log(`- ${state}: ${count}`);
        }
        console.log(`findings        ${result.findings.length}`);
        printLifecycleFindings(result.findings);
      });
      if (!result.ok) process.exitCode = 1;
      return;
    }

    if (action === 'migrate') {
      const parsed = parseLifecycleValues(values, {
        scalars: ['--actor', '--actor-type'],
        booleans: ['--apply']
      });
      format = parsed.format;
      const apply = parsed.options['--apply'] === true;
      const result = migrateLifecycleRecords(cwd, {
        apply,
        actor: apply ? requireLifecycleOption(parsed.options, '--actor') : undefined,
        actorType: apply ? requireLifecycleOption(parsed.options, '--actor-type') : undefined
      });
      emit(result, () => {
        console.log(`Mole lifecycle migration ${apply ? 'apply' : 'dry-run'}.`);
        console.log(`Files scanned: ${result.scanned}`);
        console.log(`Already tracked: ${result.tracked}`);
        console.log(`Untracked: ${result.candidates.length}`);
        console.log(`Registered: ${result.registered.length}`);
        console.log(`Skipped: ${result.skipped.length}`);
        if (!apply) {
          for (const candidate of result.candidates) {
            const status = candidate.legacy_status ? ` (frontmatter status: ${candidate.legacy_status})` : '';
            const named = candidate.named_source_id ? ` (frontmatter names ${candidate.named_source_id}, which is not this file's source)` : '';
            console.log(`- ${candidate.path} -> ${candidate.proposed_state}${status}${named}`);
          }
          if (result.candidates.length) console.log('Nothing was changed. Rerun with --apply --actor <name> --actor-type <type> to register these files. Files under 6-raw/ become raw and the rest become unreviewed. A frontmatter status is not a review decision.');
        }
        for (const item of result.registered) console.log(`- ${item.record_id}  ${item.state}  ${item.path}`);
        for (const item of result.skipped) console.log(`- skipped ${item.path}: ${item.reason}`);
        if (result.findings.length) {
          console.log('Findings:');
          printLifecycleFindings(result.findings);
        }
      });
      if (!result.ok) process.exitCode = 1;
      return;
    }

    if (action === 'unlock') {
      const parsed = parseLifecycleValues(values);
      format = parsed.format;
      const result = unlockLifecycle(cwd);
      emit(result, () => {
        console.log(result.removed
          ? 'Removed the lifecycle mutation lock left by a stopped process.'
          : 'No lifecycle mutation lock is present.');
      });
      return;
    }

    throw new UsageError(`Supported lifecycle commands: register, ${LIFECYCLE_ACTIONS.join(', ')}, relocate, show, list, audit, migrate, unlock`);
  } catch (error) {
    if (!(error instanceof UsageError) && !error.code) throw error;
    reportLifecycleFailure(error, format);
  }
}

const INPUT_QUEUE_ACTOR_SCALARS = ['--actor', '--actor-type', '--reason'];
const INPUT_QUEUE_FIELD_SCALARS = ['--request', '--impact', '--unblocks', '--answer-format', '--effort', '--priority', '--requester', '--owner', '--due', '--next-review'];

function inputQueueActor(options) {
  return {
    actor: requireLifecycleOption(options, '--actor'),
    actorType: requireLifecycleOption(options, '--actor-type'),
    humanConfirmed: options['--confirm-human'] === true,
    reason: options['--reason']
  };
}

function inputQueueFields(options) {
  if (options['--blocking'] && options['--not-blocking']) throw new UsageError('--blocking conflicts with --not-blocking.');
  const fields = {
    request: options['--request'],
    impact: options['--impact'],
    unblocks: options['--unblocks'],
    answer_format: options['--answer-format'],
    effort: options['--effort'],
    priority: options['--priority'],
    requester: options['--requester'],
    owner: options['--owner'],
    due: options['--due'],
    next_review: options['--next-review'],
    status: options['--status']
  };
  if (options['--blocking']) fields.blocking = true;
  if (options['--not-blocking']) fields.blocking = false;
  return fields;
}

function parseInputQueueNumber(value, option, { integer = true } = {}) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number))) throw new UsageError(`${option} must be a ${integer ? 'whole ' : ''}number.`);
  return number;
}

function printInputRequest(request) {
  console.log(`Input ID: ${request.input_id}`);
  console.log(`Status: ${request.status}${request.blocking ? ' (blocks work)' : ''}`);
  console.log(`Priority: ${request.priority}`);
  console.log(`Request: ${request.request}`);
  console.log(`Why it matters: ${request.impact}`);
  if (request.unblocks) console.log(`Unblocks: ${request.unblocks}`);
  if (request.answer_format) console.log(`Quick input format: ${request.answer_format}`);
  if (request.effort) console.log(`Effort: ${request.effort}`);
  console.log(`Requester: ${request.requester}`);
  if (request.owner) console.log(`Owner: ${request.owner}`);
  if (request.due) console.log(`Due: ${request.due}`);
  if (request.next_review) console.log(`Next review: ${request.next_review}`);
  if (request.source_ids.length) console.log(`Sources: ${request.source_ids.join(', ')}`);
  if (request.references.length) console.log(`References: ${request.references.join(', ')}`);
  if (request.duplicate_of) console.log(`Duplicate of: ${request.duplicate_of}`);
  if (request.superseded_by) console.log(`Superseded by: ${request.superseded_by}`);
  if (request.closure) {
    console.log(`Closed: ${request.closure.reason} by ${request.closure.closed_by} at ${request.closure.closed_at}`);
    if (request.closure.answer) console.log(`Answer: ${request.closure.answer}`);
    console.log(`What changed: ${request.closure.outcome}`);
  }
}

function printInputQueueReview(result) {
  if (!result.top.length) console.log('No open input requests.');
  else console.log(`Top ${result.top.length} of ${result.reviewable_count} open input ${result.reviewable_count === 1 ? 'request' : 'requests'}:`);
  for (const item of result.top) {
    console.log('');
    console.log(`${item.rank}. ${item.request}`);
    console.log(`   ID: ${item.input_id}`);
    console.log(`   Ranked here because: ${item.reasons.join(', ')} (score ${item.score})`);
    console.log(`   Why it matters: ${item.impact}`);
    console.log(`   Answering it unblocks: ${item.unblocks ?? 'not recorded'}`);
    if (item.answer_format) console.log(`   Fastest way to answer: ${item.answer_format}`);
    if (item.owner) console.log(`   Owner: ${item.owner}`);
    if (item.due) console.log(`   Due: ${item.due}`);
  }
  if (result.not_shown) console.log(`\n${result.not_shown} more not shown. Raise --limit or run "mole input-queue list".`);
  if (result.stale_candidate_count) {
    console.log(`\nPossibly stale (${result.stale_candidate_count}); nothing was closed:`);
    for (const item of result.stale_candidates) console.log(`- ${item.input_id}  ${item.request} (${item.reasons.join('; ')})`);
    if (result.stale_candidate_count > result.stale_candidates.length) console.log(`- and ${result.stale_candidate_count - result.stale_candidates.length} more`);
  }
  if (result.duplicate_candidate_count) {
    console.log(`\nPossible duplicates (${result.duplicate_candidate_count}); nothing was merged:`);
    for (const item of result.duplicate_candidates) {
      console.log(`- ${item.input_ids.join(' and ')}: ${Math.round(item.similarity * 100)}% of terms shared (${item.shared_terms.join(', ')})`);
    }
    if (result.duplicate_candidate_count > result.duplicate_candidates.length) console.log(`- and ${result.duplicate_candidate_count - result.duplicate_candidates.length} more`);
  }
  if (result.stale_candidate_count || result.duplicate_candidate_count) {
    console.log('Closing a stale or duplicate request, or changing its owner, is a decision for a person.');
  }
  if (result.notice) console.log(`\n${result.notice}`);
}

function runInputQueueReview(values = []) {
  const parsed = parseLifecycleValues(values, { scalars: ['--limit', '--stale-after-days', '--duplicate-threshold'] });
  const result = reviewInputQueue(cwd, {
    limit: parseInputQueueNumber(parsed.options['--limit'], '--limit'),
    staleAfterDays: parseInputQueueNumber(parsed.options['--stale-after-days'], '--stale-after-days'),
    duplicateThreshold: parseInputQueueNumber(parsed.options['--duplicate-threshold'], '--duplicate-threshold', { integer: false })
  });
  if (parsed.format === 'json') console.log(JSON.stringify(result, null, 2));
  else printInputQueueReview(result);
  return parsed.format;
}

function printInputQueueHelp() {
  const lines = getHelpOutput().split('\n');
  // The input-queue lines of the usage block, with their indented descriptions.
  console.log(lines.filter((line, index) => {
    let owner = index;
    while (owner > 0 && /^\s{10,}/.test(lines[owner])) owner -= 1;
    return /input-queue/.test(lines[owner]) && /^\s{2}mole /.test(lines[owner]);
  }).join('\n'));
  console.log('\nEvery command accepts --format json. See docs/input-queue.md.');
}

function runInputQueueCommand(action, values = []) {
  if ([action, ...values].some((value) => value === '--help' || value === '-h') || action === 'help') {
    printInputQueueHelp();
    return;
  }
  let format = guessLifecycleFormat(values);
  const emit = (result, printText) => {
    if (format === 'json') console.log(JSON.stringify(result, null, 2));
    else printText();
    if (format !== 'json' && result.legacy_copy && !result.applied) console.log(`The queue file as it was is kept at ${result.legacy_copy}.`);
    // The change is saved even when the Markdown table could not be rewritten.
    if (result.view?.warning) console.error(`Warning: ${result.view.warning}`);
  };

  try {
    if (action === 'add') {
      const parsed = parseLifecycleValues(values, {
        scalars: [...INPUT_QUEUE_ACTOR_SCALARS, ...INPUT_QUEUE_FIELD_SCALARS],
        lists: ['--source', '--ref'],
        booleans: ['--blocking', '--confirm-human']
      });
      format = parsed.format;
      for (const required of ['--request', '--impact', '--unblocks']) requireLifecycleOption(parsed.options, required);
      const result = addInputRequest(cwd, {
        ...inputQueueFields(parsed.options),
        ...inputQueueActor(parsed.options),
        sourceIds: parsed.options['--source'],
        references: parsed.options['--ref']
      });
      emit(result, () => {
        console.log('Added input request.');
        printInputRequest(result.request);
      });
    } else if (action === 'update') {
      const parsed = parseLifecycleValues(values, {
        positionals: 1,
        scalars: [...INPUT_QUEUE_ACTOR_SCALARS, ...INPUT_QUEUE_FIELD_SCALARS, '--status'],
        lists: ['--source', '--ref'],
        booleans: ['--blocking', '--not-blocking', '--confirm-human']
      });
      format = parsed.format;
      const inputId = requireLifecyclePositional(parsed.positionals, 'input request ID');
      requireLifecycleOption(parsed.options, '--reason');
      const result = updateInputRequest(cwd, inputId, {
        ...inputQueueFields(parsed.options),
        ...inputQueueActor(parsed.options),
        addSourceIds: parsed.options['--source'],
        addReferences: parsed.options['--ref']
      });
      emit(result, () => {
        console.log(`Updated ${result.changed_fields.join(', ')}.`);
        printInputRequest(result.request);
      });
    } else if (action === 'close') {
      const parsed = parseLifecycleValues(values, {
        positionals: 1,
        scalars: [...INPUT_QUEUE_ACTOR_SCALARS, '--closure-reason', '--answer', '--outcome', '--duplicate-of', '--superseded-by'],
        booleans: ['--confirm-human']
      });
      format = parsed.format;
      const inputId = requireLifecyclePositional(parsed.positionals, 'input request ID');
      const result = closeInputRequest(cwd, inputId, {
        ...inputQueueActor(parsed.options),
        closureReason: parsed.options['--closure-reason'],
        answer: parsed.options['--answer'],
        outcome: parsed.options['--outcome'],
        duplicateOf: parsed.options['--duplicate-of'],
        supersededBy: parsed.options['--superseded-by']
      });
      emit(result, () => {
        console.log('Closed input request.');
        printInputRequest(result.request);
      });
    } else if (action === 'reopen') {
      const parsed = parseLifecycleValues(values, { positionals: 1, scalars: INPUT_QUEUE_ACTOR_SCALARS, booleans: ['--confirm-human'] });
      format = parsed.format;
      const inputId = requireLifecyclePositional(parsed.positionals, 'input request ID');
      requireLifecycleOption(parsed.options, '--reason');
      const result = reopenInputRequest(cwd, inputId, inputQueueActor(parsed.options));
      emit(result, () => {
        console.log('Reopened input request.');
        printInputRequest(result.request);
      });
    } else if (action === 'show') {
      const parsed = parseLifecycleValues(values, { positionals: 1 });
      format = parsed.format;
      const request = readInputRequest(cwd, requireLifecyclePositional(parsed.positionals, 'input request ID'));
      emit({ ok: true, request }, () => {
        printInputRequest(request);
        if (request.legacy) console.log(`Legacy row (${request.legacy.path} line ${request.legacy.line}): ${request.legacy.row}`);
        console.log('History:');
        for (const entry of request.history) {
          const confirmed = entry.human_confirmed ? ', confirmed' : '';
          const changed = Object.keys(entry.changes);
          console.log(`- ${entry.revision}. ${entry.at} ${entry.action}${changed.length ? ` (${changed.join(', ')})` : ''} by ${entry.actor} [${entry.actor_type}${confirmed}]: ${entry.reason}`);
        }
      });
    } else if (action === 'list') {
      const parsed = parseLifecycleValues(values, { lists: ['--status'], booleans: ['--all'] });
      format = parsed.format;
      const requests = listInputRequests(cwd, { statuses: parsed.options['--status'], all: parsed.options['--all'] === true });
      emit({ ok: true, count: requests.length, requests }, () => {
        if (!requests.length) console.log('No input requests.');
        for (const request of requests) {
          console.log(`${request.input_id}  ${request.status}  ${request.priority}${request.blocking ? '  blocking' : ''}${request.due ? `  due ${request.due}` : ''}  ${request.request}`);
        }
      });
    } else if (action === 'review') {
      format = runInputQueueReview(values);
    } else if (action === 'migrate') {
      const parsed = parseLifecycleValues(values, { scalars: ['--actor', '--actor-type'], booleans: ['--apply', '--confirm-human'] });
      format = parsed.format;
      const apply = parsed.options['--apply'] === true;
      if (!apply && (parsed.options['--actor'] || parsed.options['--actor-type'])) throw new UsageError('--actor and --actor-type go with --apply.');
      const result = migrateInputQueue(cwd, apply ? { apply, ...inputQueueActor(parsed.options) } : {});
      emit(result, () => {
        const rows = apply ? result.migrated : result.candidates;
        console.log(`${apply ? 'Migrated' : 'Rows to migrate'}: ${rows.length}`);
        for (const row of rows) console.log(`- line ${row.line}${row.input_id ? `  ${row.input_id}` : ''}  ${row.status}  ${row.priority}  ${row.request}`);
        const withoutRequest = result.skipped.filter((item) => item.reason === 'request_missing');
        const inUserTable = result.skipped.filter((item) => item.reason === 'in_user_table');
        const placeholders = result.skipped.length - withoutRequest.length - inUserTable.length;
        if (placeholders) console.log(`Skipped placeholder rows: ${placeholders}`);
        if (inUserTable.length) console.log(`Not imported (line ${inUserTable.map((item) => item.line).join(', ')}): ${inUserTable.length} ${inUserTable.length === 1 ? 'row' : 'rows'} in a table of your own that lists requests by queue ID. Mole leaves that table alone. Add ${inUserTable.length === 1 ? 'it' : 'them'} with "mole input-queue add".`);
        if (withoutRequest.length) console.log(`Skipped rows with text but no request (line ${withoutRequest.map((item) => item.line).join(', ')}): ${withoutRequest.length}. They cannot be imported.`);
        if (result.legacy_copy) console.log(`The file as it was is kept at ${result.legacy_copy}.`);
        if (!apply && rows.length) console.log('Nothing was changed. Rerun with --apply --actor <name> --actor-type <type>.');
      });
    } else if (action === 'audit') {
      const parsed = parseLifecycleValues(values);
      format = parsed.format;
      const result = auditInputQueue(cwd);
      emit(result, () => {
        const problems = result.findings.filter((item) => !item.advisory).length;
        console.log(result.ok
          ? (result.findings.length ? 'Input queue audit passed, with notes.' : 'Input queue audit passed.')
          : `Input queue audit found ${problems} ${problems === 1 ? 'problem' : 'problems'}.`);
        printLifecycleFindings(result.findings);
      });
      if (!result.ok) process.exitCode = 1;
    } else if (action === 'refresh-view') {
      const parsed = parseLifecycleValues(values);
      format = parsed.format;
      const result = refreshInputQueueView(cwd);
      emit(result, () => console.log(result.view.changed ? `Rewrote the generated table in ${result.view.path}.` : `The generated table in ${result.view.path} is already current.`));
    } else if (action === 'unlock') {
      const parsed = parseLifecycleValues(values);
      format = parsed.format;
      const result = unlockInputQueue(cwd);
      emit(result, () => console.log(result.message));
    } else {
      throw new UsageError(`Unknown input-queue command: ${action ?? '(none)'}. Use add, update, close, reopen, show, list, review, migrate, refresh-view, audit, or unlock.`);
    }
  } catch (error) {
    if (!(error instanceof UsageError) && !error.code) throw error;
    reportInputQueueFailure(error, format);
  }
}

function reportInputQueueFailure(error, format) {
  const usage = error instanceof UsageError
    || (error instanceof InputQueueError && INPUT_QUEUE_USAGE_ERROR_CODES.has(error.code));
  const code = error.code || (usage ? 'INVALID_ARGUMENT' : 'ERROR');
  if (format === 'json') {
    console.log(JSON.stringify({ ok: false, error: { code, message: error.message, details: error.details || {} } }, null, 2));
  }
  console.error(`${usage ? 'Invalid arguments' : 'Refused'}: ${error.message}`);
  process.exitCode = usage ? 2 : 1;
}

function runRetrieveCommand(values = []) {
  let format = guessLifecycleFormat(values);
  try {
    const parsed = parseLifecycleValues(values, { positionals: 1, lists: ['--include-state'] });
    format = parsed.format;
    const includeStates = parsed.options['--include-state'];

    if (parsed.positionals[0]) {
      const result = retrieveLifecycleRecord(cwd, parsed.positionals[0], { includeStates });
      if (format === 'json') {
        const { absolute_path: _absolutePath, ...portable } = result;
        console.log(JSON.stringify(portable, null, 2));
        return;
      }
      console.log(`Record ID: ${result.record.record_id}`);
      console.log(`State: ${result.record.state}`);
      console.log(`Revision: ${result.record.revision}`);
      console.log(`Path: ${result.path}`);
      if (result.content === null) {
        console.log('Content: binary; read the file at the path above.');
        return;
      }
      console.log('');
      process.stdout.write(result.content);
      return;
    }

    const result = retrieveLifecycleRecords(cwd, { includeStates });
    if (format === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Retrievable records (${result.include_states.join(', ')}): ${result.records.length}`);
      for (const record of result.records) {
        console.log(`${record.record_id}  ${record.state}  r${record.revision}  ${record.path}`);
      }
      if (result.excluded.length) {
        console.log(`Excluded because the file no longer matches the record: ${result.excluded.length}`);
        for (const item of result.excluded) console.log(`- ${item.record_id}  ${item.state}  ${item.path}: ${item.reason}`);
      }
      const hidden = Object.entries(result.state_counts)
        .filter(([state, count]) => count && !result.include_states.includes(state))
        .map(([state, count]) => `${state} ${count}`);
      if (hidden.length) console.log(`Not included: ${hidden.join(', ')}. Add --include-state <state> to read them.`);
    }
    if (result.excluded.length) process.exitCode = 1;
  } catch (error) {
    if (!(error instanceof UsageError) && !error.code) throw error;
    reportLifecycleFailure(error, format);
  }
}

export function getDoctorOutput(instanceRoot = cwd) {
  const checks = [
    ['mole.instance.yaml', exists(path.join(instanceRoot, 'mole.instance.yaml'))],
    ['0-bootstrap/', exists(path.join(instanceRoot, '0-bootstrap'))],
    ['1-routing/', exists(path.join(instanceRoot, '1-routing'))],
    ['2-summaries/', exists(path.join(instanceRoot, '2-summaries'))],
    ['3-indexes/', exists(path.join(instanceRoot, '3-indexes'))],
    ['4-context/', exists(path.join(instanceRoot, '4-context'))],
    ['5-evidence/', exists(path.join(instanceRoot, '5-evidence'))],
    ['6-raw/inbox/', exists(path.join(instanceRoot, '6-raw', 'inbox'))]
  ];

  const instanceVersion = getInstanceVersion(instanceRoot);
  const lines = [
    'Mole doctor',
    '',
    `source version   ${getSourceVersion()}`,
    `instance version ${instanceVersion || 'not found'}`
  ];

  if (!instanceVersion) {
    lines.push('warning          missing instance metadata');
  }

  lines.push('');

  for (const [label, ok] of checks) {
    lines.push(`${ok ? '✓' : '✗'} ${label}`);
  }

  lines.push('', 'Doctor checks versions and folders only. Run `mole validate` for the full workspace check.');

  return `${lines.join('\n')}\n`;
}

function doctor() {
  process.stdout.write(getDoctorOutput());
}

/**
 * `mole validate [path]`: the complete read-only workspace check.  Exit code
 * 0 means healthy, 1 findings, 2 invalid arguments, 3 an internal failure.
 */
function runValidateCommand(values = []) {
  if (values.includes('--help') || values.includes('-h')) {
    console.log('Usage: mole validate [path] [--format text|json] [--stale-after-days <n>]\n\nRuns the full read-only workspace check. Exit codes: 0 healthy, 1 findings, 2 invalid arguments, 3 internal failure.\nFinding codes are listed in docs/workspace-validation.md.');
    return;
  }
  let format = guessLifecycleFormat(values);
  const failWith = (exitCode, code, message) => {
    if (format === 'json') console.log(JSON.stringify({ ok: false, error: { code, message } }, null, 2));
    console.error(`${exitCode === VALIDATION_EXIT_CODES.invalid_arguments ? 'Invalid arguments' : 'Validation failed to run'}: ${message}`);
    process.exitCode = exitCode;
  };
  let parsed;
  let staleAfterDays;
  try {
    parsed = parseLifecycleValues(values, { positionals: 1, scalars: ['--stale-after-days'] });
    format = parsed.format;
    if (parsed.options['--stale-after-days'] !== undefined) {
      if (!/^\d+$/.test(parsed.options['--stale-after-days'])) throw new UsageError('--stale-after-days must be a whole number of days, at least 1.');
      staleAfterDays = Number(parsed.options['--stale-after-days']);
      if (staleAfterDays < 1) throw new UsageError('--stale-after-days must be a whole number of days, at least 1.');
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    failWith(VALIDATION_EXIT_CODES.invalid_arguments, 'INVALID_ARGUMENT', error.message);
    return;
  }
  try {
    const target = path.resolve(cwd, parsed.positionals[0] || '.');
    const result = validateWorkspace(target, { cliVersion: getSourceVersion(), ...(staleAfterDays ? { staleAfterDays } : {}) });
    if (format === 'json') console.log(JSON.stringify(result, null, 2));
    else process.stdout.write(formatValidationReport(result));
    process.exitCode = result.ok ? VALIDATION_EXIT_CODES.healthy : VALIDATION_EXIT_CODES.findings;
  } catch (error) {
    if (error.code === 'INVALID_ARGUMENT') failWith(VALIDATION_EXIT_CODES.invalid_arguments, error.code, error.message);
    else failWith(VALIDATION_EXIT_CODES.internal_failure, 'INTERNAL_ERROR', error.message);
  }
}

export function getCheckUpdatesOutput(instanceRoot = cwd) {
  const sourceVersion = getSourceVersion();
  const instanceVersion = getInstanceVersion(instanceRoot);
  const ownership = getUpgradeOwnership();
  const comparison = instanceVersion ? compareVersions(sourceVersion, instanceVersion) : 1;
  const status = comparison > 0 ? 'update available' : comparison === 0 ? 'up to date' : 'instance ahead of source';
  const safeCopy = ownership?.classes?.['safe-copy']?.paths || [];
  const mergeCarefully = ownership?.classes?.['merge-carefully']?.paths || [];

  const lines = [
    'Mole update check',
    '',
    'read-only report',
    `source version   ${sourceVersion}`,
    `instance version ${instanceVersion || 'not found'}`,
    `status          ${status}`,
    '',
    'Safe additions'
  ];

  if (safeCopy.length) {
    for (const item of safeCopy) lines.push(`- ${item}`);
  } else {
    lines.push('- No safe-copy paths declared.');
  }

  lines.push('', 'Manual review');

  if (mergeCarefully.length) {
    for (const item of mergeCarefully) lines.push(`- ${item}`);
  } else {
    lines.push('- No merge-carefully paths declared.');
  }

  return `${lines.join('\n')}\n`;
}

function checkUpdates() {
  process.stdout.write(getCheckUpdatesOutput());
}

export function normalizeReleaseVersion(version = getSourceVersion()) {
  const normalized = String(version).trim().replace(/^v/i, '');
  if (!RELEASE_VERSION_PATTERN.test(normalized)) {
    throw new Error('Upgrade version must be a stable SemVer release such as 0.2.8.');
  }
  return normalized;
}

export function getUpgradeCommand(version = getSourceVersion()) {
  const releaseVersion = normalizeReleaseVersion(version);
  return ['npm', 'install', '-g', `${PACKAGE_REPOSITORY}#v${releaseVersion}`];
}

function upgradeTool(version) {
  let command;
  try {
    command = getUpgradeCommand(version);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  console.log(`Updating Mole from ${command[command.length - 1]}...`);

  const result = spawnSync(command[0], command.slice(1), {
    stdio: 'inherit'
  });

  if (result.error) {
    console.error(`Failed to run ${command.join(' ')}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`Mole upgrade failed. Run manually: ${command.join(' ')}`);
    process.exit(result.status || 1);
  }

  console.log('Mole upgrade complete. Run `mole --help` to confirm the installed version.');
}

function runInboxCommand(action, values = []) {
  if (action === 'duplicates') {
    try {
      const [operation, ...args] = values;
      if (operation === 'check') {
        let threshold = 0.8;
        const ids = [];
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--threshold') threshold = Number(args[++i]);
          else ids.push(args[i]);
        }
        if (!ids.length) throw new Error('Provide registered source IDs.');
        console.log(JSON.stringify(inspectInboxDuplicateBatch(cwd, ids, { threshold }), null, 2));
      } else if (operation === 'decide') {
        const [sourceId, targetId, status, ...flags] = args;
        const options = { sourceId, targetId, status };
        for (let i = 0; i < flags.length; i++) {
          if (flags[i] === '--confirm-human') options.confirmHuman = true;
          else if (flags[i] === '--actor') options.actor = flags[++i];
          else if (flags[i] === '--reason') options.reason = flags[++i];
          else throw new Error('Unknown duplicate decision option.');
        }
        console.log(JSON.stringify(recordDuplicateDecision(cwd, options), null, 2));
      } else throw new Error('Use inbox duplicates check <source-id>... [--threshold 0.8] or decide <source-id> <target-id> <status> --confirm-human --actor <local-id> --reason <code>.');
    } catch (error) { console.error(error.message); process.exit(1); }
    return;
  }
  if (action === 'audit') {
    const result = auditInbox(cwd);
    console.log('Mole inbox audit');
    console.log('workspace root  ' + result.workspaceRoot);
    console.log('live files      ' + result.candidates.length);
    console.log('processed files ' + result.processed.length);
    console.log('unprocessed     ' + result.unprocessed.length);
    for (const item of result.unprocessed) console.log('- ' + item);
    console.log('sync conflicts  ' + result.syncConflictFiles.length);
    for (const item of result.syncConflictFiles) console.log('- conflict: ' + item);
    console.log('unsafe inbox entries ' + result.unsafeEntries.length);
    for (const item of result.unsafeEntries) {
      console.log('- unsafe ' + item.kind + ': ' + item.path);
    }
    console.log('conflict lock copies ' + result.conflictLockPaths.length);
    for (const item of result.conflictLockPaths) console.log('- conflict lock: ' + item);
    console.log('conflict receipts ' + result.conflictReceipts.length);
    for (const item of result.conflictReceipts) {
      console.log('- conflict receipt: ' + item.path
        + (item.run_id ? ' (' + item.run_id + ')' : ' (invalid or unidentified)'));
    }
    console.log('invalid receipts ' + result.invalidReceipts.length);
    for (const item of result.invalidReceipts) {
      console.log('- invalid receipt ' + item.path + ': ' + item.error);
    }
    console.log('duplicate receipts ' + result.duplicateReceipts.length);
    for (const item of result.duplicateReceipts) {
      console.log('- duplicate run ' + item.run_id + ': ' + item.paths.join(', '));
    }
    console.log('processed path conflicts ' + result.processedPathConflicts.length);
    for (const item of result.processedPathConflicts) {
      console.log('- split-brain path ' + item.path + ': '
        + item.runs.map((run) => run.run_id).join(', '));
    }
    console.log('override records ' + result.overrides.length);
    for (const item of result.overrides) {
      console.log('- ' + item.path + ': ' + (item.override.type || 'override')
        + ' by ' + (item.override.actor || 'unknown'));
    }
    console.log('invalid overrides ' + result.invalidOverrides.length);
    for (const item of result.invalidOverrides) {
      console.log('- invalid override ' + item.path + ': ' + item.error);
    }
    console.log('incomplete overrides ' + result.incompleteOverrides.length);
    for (const item of result.incompleteOverrides) {
      console.log('- prepared override ' + item.path + ': reconcile before continuing');
    }
    if (result.activeLock) {
      console.log('active lease     ' + (result.activeLock.run_id || result.activeLock.lock_id || 'unknown')
        + ' by ' + (result.activeLock.processor || result.activeLock.claimed_by || 'unknown')
        + ' on ' + (result.activeLock.host || 'unknown host')
        + ' until ' + (result.activeLock.expires_at || 'unknown'));
    }
    if (result.staleLock) {
      console.log('stale lease     ' + (result.staleLock.run_id || result.staleLock.lock_id || 'unknown'));
    }
    for (const issue of result.issues) {
      console.log('- ' + issue.code + ': ' + issue.message);
    }
    if (result.unprocessed.length || result.issues.length) process.exitCode = 1;
    return;
  }

  if (action === 'claim') {
    let parsed;
    try {
      parsed = parseInboxClaimValues(values);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    const result = parsed.overrideStale
      ? overrideStaleInboxProcessing(cwd, {
        runId: parsed.runId,
        processor: parsed.processor || undefined,
        host: parsed.host || undefined,
        leaseMs: parsed.leaseMs,
        claimedPaths: parsed.claimedPaths,
        reason: parsed.reason,
      })
      : claimInboxProcessing(cwd, {
        runId: parsed.runId,
        processor: parsed.processor || undefined,
        host: parsed.host || undefined,
        leaseMs: parsed.leaseMs,
        claimedPaths: parsed.claimedPaths,
      });
    const output = result.ok ? console.log : console.error;
    output(result.message);
    if (!result.ok) process.exit(1);
    if (result.run_id) console.log('run_id          ' + result.run_id);
    if (result.overridePath) console.log('override record ' + result.overridePath);
    if (result.lock?.processed_paths?.length) {
      console.log('already checkpointed ' + result.lock.processed_paths.join(', '));
    }
    return;
  }

  if (action === 'heartbeat') {
    let parsed;
    try {
      parsed = parseInboxClaimValues(values);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    const result = heartbeatInboxProcessing(cwd, {
      runId: parsed.runId,
      processor: parsed.processor || undefined,
      host: parsed.host || undefined,
      leaseMs: parsed.leaseMs,
    });
    const output = result.ok ? console.log : console.error;
    output(result.message);
    if (!result.ok) process.exit(1);
    return;
  }

  if (action === 'checkpoint') {
    let parsed;
    try {
      parsed = parseInboxCompleteValues(values);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    const result = checkpointInboxProcessing(cwd, {
      runId: parsed.runId,
      processor: parsed.processor || undefined,
      host: parsed.host || undefined,
      leaseMs: parsed.leaseMs,
      processed: parsed.processed,
    });
    const output = result.ok ? console.log : console.error;
    output(result.message);
    if (!result.ok) process.exit(1);
    return;
  }

  if (action === 'override-stale' || action === 'recover') {
    let parsed;
    try {
      parsed = parseInboxClaimValues(values);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    const result = overrideStaleInboxProcessing(cwd, {
      runId: parsed.runId,
      processor: parsed.processor || undefined,
      host: parsed.host || undefined,
      leaseMs: parsed.leaseMs,
      claimedPaths: parsed.claimedPaths,
      reason: parsed.reason
    });
    const output = result.ok ? console.log : console.error;
    output(result.message);
    if (!result.ok) process.exit(1);
    if (result.run_id) console.log('run_id          ' + result.run_id);
    if (result.overridePath) console.log('override record ' + result.overridePath);
    return;
  }

  if (action === 'complete') {
    let parsed;
    try {
      parsed = parseInboxCompleteValues(values);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    const result = parsed.partial
      ? checkpointInboxProcessing(cwd, {
        runId: parsed.runId,
        processor: parsed.processor || undefined,
        host: parsed.host || undefined,
        leaseMs: parsed.leaseMs,
        processed: parsed.processed,
      })
      : completeInboxProcessing(cwd, {
        runId: parsed.runId,
        processor: parsed.processor || undefined,
        host: parsed.host || undefined,
        processed: parsed.processed,
        summary: parsed.summary || undefined,
        overrideMissingLock: parsed.overrideMissingLock,
        reason: parsed.reason,
      });
    const output = result.ok ? console.log : console.error;
    output(result.message);
    if (!result.ok) process.exit(1);
    if (result.run_id) console.log('run_id          ' + result.run_id);

    if (result.receipt) {
      try {
        backfillProcessedInboxMetrics(cwd);
      } catch (err) {
        console.warn('Warning: inbox metrics reconciliation failed: ' + err.message);
      }
    }
    return;
  }

  console.error('Supported inbox commands: claim, heartbeat, checkpoint, audit, complete, override-stale');
  process.exit(1);
}

function printDashboardRefresh(dashboard) {
  if (dashboard.updated) {
    console.log(dashboard.replaced_older_page
      ? `Updated ${dashboard.path}: the page from an earlier Mole had no summary panel. The old page is kept at ${dashboard.previous_page}; delete it if you had not edited it.`
      : `Added ${dashboard.path}.`);
  } else if (dashboard.reason) {
    console.error(`Warning: ${dashboard.reason}`);
  }
}

function runMetricsCommand(action, values = []) {
  // Bare "mole metrics", or one that starts with an option, is the summary.
  const isSummary = action === undefined || action === 'summary' || String(action).startsWith('--');
  if (isSummary || action === 'snapshot') {
    const rest = action === undefined || action === 'summary' || action === 'snapshot' ? values : [action, ...values];
    let format = guessLifecycleFormat(rest);
    try {
      const parsed = parseLifecycleValues(rest, { booleans: action === 'snapshot' ? [] : ['--events'] });
      format = parsed.format;
      if (action === 'snapshot') {
        const result = writeMetricsSnapshot(cwd);
        if (format === 'json') {
          console.log(JSON.stringify({ ok: true, path: result.path, generated_at: result.summary.generated_at, dashboard: result.dashboard }, null, 2));
        } else {
          console.log(`Wrote ${result.path}. Open ${result.dashboard.path} to view it.`);
          printDashboardRefresh(result.dashboard);
        }
        return;
      }
      const summary = summarizeMetrics(cwd, { includeEvents: parsed.options['--events'] === true });
      if (format === 'json') {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        process.stdout.write(formatMetricsSummary(summary));
        if (parsed.options['--events']) {
          console.log(`\nEvents (${summary.events.length})`);
          for (const event of summary.events) {
            console.log(`${event.at}  ${event.category}  ${event.record_id || event.source_id || event.path}${event.run_id ? `  run ${event.run_id}` : ''}`);
          }
        }
      }
    } catch (error) {
      if (error.code === 'SNAPSHOT_NOT_WRITTEN') {
        if (format === 'json') console.log(JSON.stringify({ ok: false, error: { code: error.code, message: error.message } }, null, 2));
        console.error(`Refused: ${error.message}`);
        process.exitCode = 1;
        return;
      }
      if (!(error instanceof UsageError) && error.code !== 'INVALID_ARGUMENT') throw error;
      if (format === 'json') console.log(JSON.stringify({ ok: false, error: { code: 'INVALID_ARGUMENT', message: error.message } }, null, 2));
      console.error(`Invalid arguments: ${error.message}`);
      process.exitCode = 2;
    }
    return;
  }

  if (action === 'backfill') {
    let result;
    try {
      result = backfillProcessedInboxMetrics(cwd);
    } catch (error) {
      if (error.code !== 'METRICS_NOT_WRITTEN') throw error;
      console.error(`Refused: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    const output = result.blocked ? console.error : console.log;
    output(result.blocked
      ? 'Mole metrics backfill blocked; existing metric files were preserved.'
      : 'Mole metrics backfill complete.');
    console.log(`Receipts scanned: ${result.receipts_scanned}`);
    console.log(`Receipts counted: ${result.receipts_counted}`);
    console.log(`Receipts skipped: ${result.receipts_skipped}`);
    console.log(`Processed paths counted: ${result.processed_paths_counted}`);
    console.log(`Conflict receipts skipped: ${result.conflict_receipts_skipped}`);
    console.log(`Processed paths conflicted: ${result.processed_paths_conflicted}`);
    if (result.blocked) {
      process.exitCode = 1;
      return;
    }
    // Keep the dashboard's second panel in step with the rebuilt counts.
    try {
      const snapshot = writeMetricsSnapshot(cwd);
      console.log(`Outcome snapshot: ${snapshot.path}`);
      printDashboardRefresh(snapshot.dashboard);
    } catch (error) {
      if (error.code !== 'SNAPSHOT_NOT_WRITTEN') throw error;
      console.error(`Warning: ${error.message}`);
    }
    return;
  }

  console.error('Supported metrics commands: summary (the default), snapshot, backfill');
  process.exit(1);
}

function readInboxOption(values, index, option) {
  const value = values[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('Missing value for ' + option + '.');
  }
  return value;
}

export function parseInboxClaimValues(values = []) {
  const processorParts = [];
  const claimedPaths = [];
  const result = {
    processor: '',
    runId: '',
    host: '',
    leaseMs: undefined,
    claimedPaths,
    reason: '',
    overrideStale: false,
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--run-id') {
      result.runId = readInboxOption(values, index, '--run-id');
      index += 1;
    } else if (value === '--processor' || value === '--claimed-by' || value === '--actor') {
      result.processor = readInboxOption(values, index, value);
      index += 1;
    } else if (value === '--host') {
      result.host = readInboxOption(values, index, '--host');
      index += 1;
    } else if (value === '--lease-ms') {
      result.leaseMs = Number(readInboxOption(values, index, '--lease-ms'));
      if (!Number.isFinite(result.leaseMs) || result.leaseMs <= 0) {
        throw new Error('--lease-ms must be a positive number.');
      }
      index += 1;
    } else if (value === '--claimed-path' || value === '--path') {
      claimedPaths.push(readInboxOption(values, index, value));
      index += 1;
    } else if (value === '--reason') {
      result.reason = readInboxOption(values, index, '--reason');
      index += 1;
    } else if (value === '--override-stale') {
      result.overrideStale = true;
    } else if (value === '--allow-conflict-copies') {
      throw new Error('Generic conflict bypasses are not supported. Preserve every copy and reconcile the audit state.');
    } else if (value.startsWith('--')) {
      throw new Error('Unknown inbox claim option ' + value + '.');
    } else {
      processorParts.push(value);
    }
  }

  if (!result.processor) result.processor = processorParts.join(' ').trim();
  return result;
}

export function parseInboxCompleteValues(values = []) {
  const processed = [];
  const claimedPaths = [];
  const summaryParts = [];
  const result = {
    processed,
    claimedPaths,
    summary: '',
    runId: '',
    processor: '',
    host: '',
    leaseMs: undefined,
    partial: false,
    overrideMissingLock: false,
    reason: '',
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value === '--processed') {
      processed.push(readInboxOption(values, index, '--processed'));
      index += 1;
    } else if (value === '--run-id') {
      result.runId = readInboxOption(values, index, '--run-id');
      index += 1;
    } else if (value === '--processor' || value === '--claimed-by' || value === '--actor') {
      result.processor = readInboxOption(values, index, value);
      index += 1;
    } else if (value === '--host') {
      result.host = readInboxOption(values, index, '--host');
      index += 1;
    } else if (value === '--lease-ms') {
      result.leaseMs = Number(readInboxOption(values, index, '--lease-ms'));
      if (!Number.isFinite(result.leaseMs) || result.leaseMs <= 0) {
        throw new Error('--lease-ms must be a positive number.');
      }
      index += 1;
    } else if (value === '--partial') {
      result.partial = true;
    } else if (value === '--override-missing-lock') {
      result.overrideMissingLock = true;
    } else if (value === '--reason') {
      result.reason = readInboxOption(values, index, '--reason');
      index += 1;
    } else if (value === '--allow-conflict-copies') {
      throw new Error('Generic conflict bypasses are not supported. Preserve every copy and reconcile the audit state.');
    } else if (value.startsWith('--')) {
      throw new Error('Unknown inbox completion option ' + value + '.');
    } else {
      summaryParts.push(value);
    }
  }

  result.summary = summaryParts.join(' ').trim();
  return result;
}

if (isDirectRun) {
  switch (command) {
    case undefined:
    case '--help':
    case '-h':
      printHelp();
      break;
    case 'new':
    case 'init':
      initInstance(subcommand);
      break;
    case 'create':
      if (!subcommand) {
        console.error('Missing artifact type. Example: mole create roadmap');
        process.exit(1);
      }
      createArtifact(subcommand, rest[0]);
      break;
    case 'insight':
    case 'note':
    case 'signal':
      // Keep empty strings so an empty option value is reported, not skipped.
      captureInsight([subcommand, ...rest].filter((value) => value !== undefined));
      break;
    case 'product-update':
      productUpdate([subcommand, ...rest].filter(Boolean));
      break;
    case 'critique':
      critique([subcommand, ...rest].filter(Boolean));
      break;
    case 'travel-log':
      travelLog([subcommand, ...rest].filter(Boolean));
      break;
    case 'bootstrap-context':
      console.log(buildBootstrapContextInstruction());
      break;
    case 'refresh':
      if (subcommand !== 'top-layers') {
        console.error('Supported refresh targets: top-layers');
        process.exit(1);
      }
      console.log(buildRefreshTopLayersInstruction());
      break;
    case 'synthesise': {
      const target = subcommand || 'the requested target';
      if (subcommand === 'inbox') console.log('Shared-folder runs must claim a run ID first, checkpoint promoted paths, and complete only with the active owned claim. Use an explicit stale-lock or missing-lock override with a reason only after checking sync history.');
      const personaInstruction = subcommand === 'inbox' ? ' Treat `6-raw/inbox/` as the flat capture/drop zone; legacy subfolders such as `quick-notes/`, `messages/`, `observations/`, or `new/` are still valid unprocessed input in existing workspaces. If user/customer signals are relevant to a durable user type, update or create evidence-backed personas in `4-context/personas.md`. If internal stakeholder signals, org-chart facts, leadership asks, or update preferences are relevant, update or create evidence-backed stakeholder memory in `4-context/stakeholders.md`. If relevant `2-summaries/` or `3-indexes/` files are blank, placeholder-only, or still contain starter-template content, treat that as a material top-layer gap and populate them from the synthesised durable context. Keep the returned run ID, checkpoint paths as they are safely promoted, and complete with `mole inbox complete --run-id <run-id> --processor "Your Name" --processed <path> ... "summary"`; normal completion requires the active owned claim.' : '';
      console.log(`Suggested agent instruction:\n\nBefore synthesis, validate the workspace root with \`mole doctor\` and run \`mole inbox audit\`. Treat every recursively discovered non-README file outside \`6-raw/inbox/archive/\` as a candidate. Reconcile the audit's candidate list against the paths you actually process, explicitly report skipped paths, and rerun \`mole inbox audit\` before finishing; do not declare a no-op while unexplained unprocessed files remain. Then synthesise ${target} using the Mole operating model: capture low, distil up, retrieve top-down.${personaInstruction} ${LIFECYCLE_AGENT_GUIDANCE}`);
      break;
    }
    case 'input-queue':
      runInputQueueCommand(subcommand, rest);
      break;
    case 'review':
      if (subcommand === 'input-queue') {
        runInputQueueCommand('review', rest);
        break;
      }
      console.log(`Suggested agent instruction:\n\nReview ${subcommand || 'the requested target'} and return the highest-value next actions or missing human inputs.`);
      break;
    case 'privacy':
    case 'retention': {
      try {
        const options = { apply: rest.includes('--apply'), confirmReviewed: rest.includes('--confirm-reviewed'), recover: rest.includes('--recover') };
        if (rest.some(v => !['--apply', '--confirm-reviewed', '--recover'].includes(v) && !v.startsWith('src_'))) throw new Error();
        const result = subcommand === 'archive' ? archiveManagedRaw(cwd, rest.find(v => v.startsWith('src_')), options)
          : subcommand === 'purge' ? purgeRaw(cwd, options)
          : subcommand === 'audit' ? auditPrivacy(cwd)
          : subcommand === 'scan' ? scanRaw(cwd, options)
          : subcommand === 'release' ? reviewQuarantine(cwd, rest.find(v => v.startsWith('src_')), options) : null;
        if (!result) throw new Error();
        console.log(JSON.stringify(result, null, 2));
        if (result.recovery_required || result.items?.some(i => i.status === 'deletion_failed')) process.exitCode = 1;
      } catch { console.error('Privacy operation failed; check policy, claims and recovery state.'); process.exitCode = 1; }
      break;
    }
    case 'inbox':
      runInboxCommand(subcommand, rest);
      break;
    case 'metrics':
      runMetricsCommand(subcommand, rest);
      break;
    case 'source':
      runSourceCommand(subcommand, rest);
      break;
    case 'lifecycle':
      runLifecycleCommand(subcommand, rest);
      break;
    case 'retrieve':
      runRetrieveCommand([subcommand, ...rest].filter((value) => value !== undefined));
      break;
    case 'install':
      if (subcommand === 'skills') {
        installMoleSkills();
      } else if (subcommand === 'codex') {
        console.warn('`mole install codex` is deprecated. Installing agent skills instead. Use `mole install skills` next time.');
        installMoleSkills();
      } else {
        console.error('Supported install targets: skills');
        process.exit(1);
      }
      break;
    case 'check-updates':
      checkUpdates();
      break;
    case 'upgrade':
      {
        const upgradeArgs = [subcommand, ...rest].filter(Boolean);
        if (upgradeArgs.length > 1) {
          console.error('Usage: mole upgrade [version]');
          process.exit(1);
        }
        upgradeTool(upgradeArgs[0]);
      }
      break;
    case 'doctor':
      doctor();
      break;
    case 'validate':
      runValidateCommand([subcommand, ...rest].filter((value) => value !== undefined));
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}
