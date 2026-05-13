#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const [command, subcommand, ...rest] = args;
const cwd = process.cwd();
const thisFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(thisFile), '..');
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === thisFile;

function printHelp() {
  console.log(`mole v0.2.0

Usage:
  mole init [target-dir]
  mole create <artifact> [output-path]
  mole insight <text>
  mole synthesise <target>
  mole review <target>
  mole install codex
  mole check-updates
  mole upgrade
  mole doctor

Examples:
  mole init my-mole
  mole create roadmap
  mole create spec drafts/spec.md
  mole insight "Users trust CSV export more than dashboard totals"
  mole install codex
  mole synthesise inbox
  mole review input-queue
`);
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

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
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

function getCodexHome() {
  const envHome = process.env.CODEX_HOME?.trim();
  return path.resolve(envHome ? envHome : path.join(os.homedir(), '.codex'));
}

function initInstance(targetDir) {
  const target = path.resolve(cwd, targetDir || 'mole-instance');
  ensureDir(target);

  copyDirRecursive(repoRoot, target, {
    excludeNames: new Set(['.git', 'cli', 'node_modules'])
  });

  if (exists(path.join(target, 'mole.instance-template.yaml'))) {
    copyFile(path.join(target, 'mole.instance-template.yaml'), path.join(target, 'mole.instance.yaml'));
  }

  console.log(`Initialised mole instance at: ${target}`);
  console.log('Copied a full working mole scaffold (excluding .git, cli, and node_modules).');
  console.log('Next steps:');
  console.log('- customise 0-bootstrap/repo-purpose.md');
  console.log('- fill key summaries in 2-summaries/');
  console.log('- start capturing in 6-raw/inbox/ or with `mole insight "..."`');
  console.log('- open the new instance folder in your editor, not the source/tool repo');
  console.log('- optionally install Codex prompts with `mole install codex` from the source/tool repo');
}

function createArtifact(kind, outputPath) {
  const templateMap = {
    roadmap: 'roadmap-template.md',
    spec: 'spec-template.md',
    'decision-brief': 'decision-brief-template.md',
    'strategy-memo': 'strategy-memo-template.md',
    'prioritisation-draft': 'prioritisation-draft-template.md'
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
    'prioritisation-draft': '4-context/product/prioritisation-draft.md'
  }[kind];

  const target = path.resolve(cwd, outputPath || defaultOutput);
  if (exists(target)) {
    console.error(`Refusing to overwrite existing file: ${target}`);
    process.exit(1);
  }

  copyFile(source, target);
  console.log(`Created ${kind} draft: ${target}`);
  console.log('\nSuggested next prompt for an agent:\n');
  outputDraftInstruction(kind);
}

function captureInsight(textParts) {
  const text = textParts.join(' ').trim();
  if (!text) {
    console.error('Missing insight text. Example: mole insight "Users trust CSV export more than dashboard totals"');
    process.exit(1);
  }

  const dir = path.join(cwd, '6-raw', 'inbox', 'quick-notes');
  ensureDir(dir);
  const fileName = `${todayUtc()}-${slugify(text)}.md`;
  const target = path.join(dir, fileName);

  const content = `---\ntitle: Raw Insight\ncapture_type: insight\nsource: mole cli\ncreated_at: ${nowUtc()}\nsummary: ${text}\ntags: []\n---\n\n# Raw Insight\n\n## Insight\n${text}\n\n## Context / why it matters\n\n## Optional follow-up questions\n- \n`;

  fs.writeFileSync(target, content, 'utf8');
  console.log(`Captured insight: ${target}`);
  console.log('\nSuggested next command:');
  console.log('mole synthesise inbox');
}

function installCodexPrompts() {
  const codexHome = getCodexHome();
  const promptsDir = path.join(codexHome, 'prompts');
  const sourceDir = path.join(repoRoot, 'cli', 'prompts', 'codex');
  ensureDir(promptsDir);

  const files = fs.readdirSync(sourceDir).filter(name => name.endsWith('.md'));
  for (const file of files) {
    copyFile(path.join(sourceDir, file), path.join(promptsDir, file));
  }

  console.log(`Installed ${files.length} Codex prompt commands to: ${promptsDir}`);
  console.log('Available commands should now include:');
  for (const file of files) {
    console.log(`- /${file.replace(/\.md$/, '')}`);
  }
}

function outputDraftInstruction(kind) {
  const map = {
    roadmap: 'Create a roadmap draft using 2-summaries/, 3-indexes/, relevant 4-context/ modules, and any needed 5-evidence/ summaries. Update the created markdown draft in place and list missing human inputs.',
    spec: 'Create a product spec draft using relevant summaries, indexes, context modules, and evidence. Update the created markdown draft in place and note assumptions, open questions, and missing human inputs.',
    'strategy-memo': 'Create a strategy memo using the highest-signal relevant context first, descending only as needed.',
    'decision-brief': 'Create a decision brief with recommendation, options, trade-offs, and missing inputs.',
    'prioritisation-draft': 'Create a prioritisation draft with criteria, ranked items, and uncertainties.'
  };
  const instruction = map[kind] || `Create a ${kind} draft from the mole using progressive retrieval.`;
  console.log(instruction);
}

export function getDoctorOutput(instanceRoot = cwd) {
  const checks = [
    ['mole.instance.yaml', exists(path.join(instanceRoot, 'mole.instance.yaml'))],
    ['0-bootstrap/', exists(path.join(instanceRoot, '0-bootstrap'))],
    ['1-routing/', exists(path.join(instanceRoot, '1-routing'))],
    ['2-summaries/', exists(path.join(instanceRoot, '2-summaries'))],
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

if (isDirectRun) {
  switch (command) {
    case undefined:
    case '--help':
    case '-h':
      printHelp();
      break;
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
    case 'synthesise':
      console.log(`Suggested agent instruction:\n\nSynthesise ${subcommand || 'the requested target'} using the mole operating model: capture low, distil up, retrieve top-down.`);
      break;
    case 'review':
      console.log(`Suggested agent instruction:\n\nReview ${subcommand || 'the requested target'} and return the highest-value next actions or missing human inputs.`);
      break;
    case 'install':
      if (subcommand === 'codex') {
        installCodexPrompts();
      } else {
        console.error('Supported install targets: codex');
        process.exit(1);
      }
      break;
    case 'check-updates':
      checkUpdates();
      break;
    case 'upgrade':
      console.log('Follow docs/upgrade-and-instance-management.md and docs/template-update-guide.md.');
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
