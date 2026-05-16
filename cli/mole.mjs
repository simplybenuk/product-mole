#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCaptureFileName, resolveCapturedBy } from '../lib/capture.mjs';
import { claimInboxProcessing, completeInboxProcessing } from '../lib/inbox-processing.mjs';

const args = process.argv.slice(2);
const [command, subcommand, ...rest] = args;
const cwd = process.cwd();
const thisFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(thisFile), '..');
const isDirectRun = process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(thisFile);
const PACKAGE_SOURCE = 'github:simplybenuk/product-mole#main';
const HELP_URL = 'https://github.com/simplybenuk/product-mole#readme';

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
  ['governance/quality-checklist.md', 'governance/quality-checklist.md'],
  ['governance/run-receipts/README.md', 'governance/run-receipts/README.md'],
  ['mole.instance-template.yaml', 'mole.instance.yaml']
]);

export function getHelpOutput() {
  return `Mole CLI v${getSourceVersion()}

Usage:
  mole new <workspace-name>            Create a clean Mole workspace scaffold.
  mole init [target-dir]               Alias for "mole new" for older docs/scripts.
  mole create <artifact> [output-path] Create a draft artifact from a Mole template.
  mole insight [options] <text>        Capture a raw product insight into the inbox.
  mole product-update <audience> <timescale> [--format email|teams|blog|brief]
                                      Print an agent instruction for a stakeholder update.
  mole synthesise <target>             Print an agent instruction for synthesis work.
  mole review <target>                 Print an agent instruction for review work.
  mole inbox claim [processor]         Claim inbox processing with a file lock.
  mole inbox complete [summary]        Write a receipt and release the inbox lock.
  mole install skills                  Install Mole agent skills into ~/.agents/skills.
  mole check-updates                   Compare this CLI version with the workspace.
  mole upgrade                         Update the globally installed Mole CLI.
  mole doctor                          Check workspace metadata and required folders.

Artifacts:
  roadmap, spec, decision-brief, strategy-memo, prioritisation-draft, product-update

Examples:
  mole new my-mole
  mole init my-mole
  mole create roadmap
  mole create spec drafts/spec.md
  mole insight "Users trust CSV export more than dashboard totals"
  mole insight --stakeholder CEO "Asked whether enterprise onboarding is improving"
  mole product-update CEO 2-weeks --format email
  mole install skills
  mole synthesise inbox
  mole review input-queue
  mole inbox claim
  mole inbox complete "Promoted this week's research notes"

More help:
  ${HELP_URL}
`;
}

export function getInstallBanner() {
  return String.raw`
        __
     __/  \__
   _/  .--.  \_
  /   (o  o)   \
 |      \/      |
 |  /\  __  /\  |
  \   '----'   /
   '._  ||  _.'
      '-||-'
        ||
     ___||___

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
  ensureDir(target);

  for (const dir of WORKSPACE_SCAFFOLD_DIRS) {
    const sourcePath = path.join(repoRoot, dir);
    const targetPath = path.join(target, dir);

    if (exists(sourcePath)) {
      copyDirRecursive(sourcePath, targetPath);
    } else {
      ensureDir(targetPath);
    }
  }

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
    'product-update': 'product-update-template.md'
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
    'product-update': '4-context/product/product-update-draft.md'
  }[kind];

  const target = path.resolve(cwd, outputPath || defaultOutput);
  if (exists(target)) {
    console.error(`Refusing to overwrite existing file: ${target}`);
    process.exit(1);
  }

  copyFile(source, target);
  console.log(`Created ${kind} draft: ${target}`);
  console.log('\nSuggested next agent instruction:\n');
  outputDraftInstruction(kind);
}

function parseInsightArgs(values) {
  const metadata = {
    audience: [],
    interestAreas: []
  };
  const textParts = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const next = values[index + 1];

    if (value === '--stakeholder' && next) {
      metadata.stakeholder = next;
      index += 1;
    } else if (value === '--requested-by' && next) {
      metadata.requestedBy = next;
      index += 1;
    } else if (value === '--audience' && next) {
      metadata.audience.push(next);
      index += 1;
    } else if (value === '--interest-area' && next) {
      metadata.interestAreas.push(next);
      index += 1;
    } else if (value === '--visibility' && next) {
      metadata.visibility = next;
      index += 1;
    } else if (value === '--follow-up-by' && next) {
      metadata.followUpBy = next;
      index += 1;
    } else {
      textParts.push(value);
    }
  }

  return { text: textParts.join(' ').trim(), metadata };
}

function captureInsight(values) {
  const { text, metadata } = parseInsightArgs(values);
  if (!text) {
    console.error('Missing insight text. Example: mole insight "Users trust CSV export more than dashboard totals"');
    process.exit(1);
  }

  const dir = path.join(cwd, '6-raw', 'inbox', 'quick-notes');
  ensureDir(dir);
  const fileName = createCaptureFileName(text);
  const target = path.join(dir, fileName);

  const content = buildInsightCaptureContent(text, metadata);

  try {
    fs.writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') {
      console.error(`Refusing to overwrite existing capture: ${target}`);
      process.exit(1);
    }
    throw err;
  }
  console.log(`Captured insight: ${target}`);
  console.log('\nSuggested next command:');
  console.log('mole synthesise inbox');
}

function yamlScalar(value) {
  const text = String(value || '').trim();
  return text ? JSON.stringify(text) : '';
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
captured_by: ${capturedBy}
created_at: ${createdAt}
summary: ${text}
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
    'product-update': 'Create a stakeholder-specific product update using stakeholder memory, relevant summaries, product context, and evidence. Tailor the format and include a retrieval receipt.'
  };
  const instruction = map[kind] || `Create a ${kind} draft from Mole using progressive retrieval.`;
  console.log(instruction);
}

function parseProductUpdateArgs(values) {
  const positional = [];
  let format = 'brief';

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const next = values[index + 1];

    if (value === '--format' && next) {
      format = next;
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

function productUpdate(values) {
  const { audience, timescale, format } = parseProductUpdateArgs(values);

  if (!audience || !timescale) {
    console.error('Missing product update target. Example: mole product-update CEO 2-weeks --format email');
    process.exit(1);
  }

  console.log(buildProductUpdateInstruction(audience, timescale, format));
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

  return `${lines.join('\n')}\n`;
}

function doctor() {
  process.stdout.write(getDoctorOutput());
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

export function getUpgradeCommand() {
  return ['npm', 'install', '-g', PACKAGE_SOURCE];
}

function upgradeTool() {
  const command = getUpgradeCommand();
  console.log(`Updating Mole from ${PACKAGE_SOURCE}...`);

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
  if (action === 'claim') {
    const result = claimInboxProcessing(cwd, {
      claimedBy: values.join(' ')
    });
    const output = result.ok ? console.log : console.error;
    output(result.message);
    if (!result.ok) process.exit(1);
    return;
  }

  if (action === 'complete') {
    const result = completeInboxProcessing(cwd, {
      summary: values.join(' ').trim() || undefined
    });
    const output = result.ok ? console.log : console.error;
    output(result.message);
    if (!result.ok) process.exit(1);
    return;
  }

  console.error('Supported inbox commands: claim, complete');
  process.exit(1);
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
      captureInsight([subcommand, ...rest].filter(Boolean));
      break;
    case 'product-update':
      productUpdate([subcommand, ...rest].filter(Boolean));
      break;
    case 'synthesise': {
      const target = subcommand || 'the requested target';
      const personaInstruction = subcommand === 'inbox' ? ' If user/customer signals are relevant to a durable user type, update or create evidence-backed personas in `4-context/personas.md`. If internal stakeholder signals, org-chart facts, leadership asks, or update preferences are relevant, update or create evidence-backed stakeholder memory in `4-context/stakeholders.md`.' : '';
      console.log(`Suggested agent instruction:\n\nSynthesise ${target} using the Mole operating model: capture low, distil up, retrieve top-down.${personaInstruction}`);
      break;
    }
    case 'review':
      console.log(`Suggested agent instruction:\n\nReview ${subcommand || 'the requested target'} and return the highest-value next actions or missing human inputs.`);
      break;
    case 'inbox':
      runInboxCommand(subcommand, rest);
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
      upgradeTool();
      break;
    case 'doctor':
      doctor();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}
