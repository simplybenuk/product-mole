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

function printHelp() {
  console.log(`cascade v0.2.0

Usage:
  cascade init [target-dir]
  cascade create <artifact> [output-path]
  cascade insight <text>
  cascade synthesise <target>
  cascade review <target>
  cascade install codex
  cascade check-updates
  cascade upgrade
  cascade doctor

Examples:
  cascade init my-cascade
  cascade create roadmap
  cascade create spec drafts/spec.md
  cascade insight "Users trust CSV export more than dashboard totals"
  cascade install codex
  cascade synthesise inbox
  cascade review input-queue
`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(from, to) {
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
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

function getCodexHome() {
  const envHome = process.env.CODEX_HOME?.trim();
  return path.resolve(envHome ? envHome : path.join(os.homedir(), '.codex'));
}

function initInstance(targetDir) {
  const target = path.resolve(cwd, targetDir || 'cascade-instance');
  ensureDir(target);

  const folders = [
    '0-bootstrap',
    '1-routing',
    '2-summaries',
    '3-indexes',
    '4-context/product',
    '4-context/strategy',
    '4-context/decisions',
    '5-evidence',
    '6-raw/inbox/quick-notes',
    '6-raw/inbox/messages',
    '6-raw/inbox/observations',
    'governance',
    'templates'
  ];

  for (const folder of folders) ensureDir(path.join(target, folder));

  copyFile(path.join(repoRoot, 'cascade.instance-template.yaml'), path.join(target, 'cascade.instance.yaml'));
  copyFile(path.join(repoRoot, 'README.md'), path.join(target, 'README.md'));
  copyFile(path.join(repoRoot, '0-bootstrap', 'repo-purpose.md'), path.join(target, '0-bootstrap', 'repo-purpose.md'));
  copyFile(path.join(repoRoot, '0-bootstrap', 'agents.md'), path.join(target, '0-bootstrap', 'agents.md'));
  copyFile(path.join(repoRoot, '2-summaries', 'strategy-summary.md'), path.join(target, '2-summaries', 'strategy-summary.md'));
  copyFile(path.join(repoRoot, '2-summaries', 'user-summary.md'), path.join(target, '2-summaries', 'user-summary.md'));
  copyFile(path.join(repoRoot, '2-summaries', 'product-summary.md'), path.join(target, '2-summaries', 'product-summary.md'));
  copyFile(path.join(repoRoot, 'governance', 'input-queue.md'), path.join(target, 'governance', 'input-queue.md'));
  copyFile(path.join(repoRoot, 'templates', 'summary-template.md'), path.join(target, 'templates', 'summary-template.md'));
  copyFile(path.join(repoRoot, 'templates', 'context-module-template.md'), path.join(target, 'templates', 'context-module-template.md'));
  copyFile(path.join(repoRoot, 'templates', 'decision-template.md'), path.join(target, 'templates', 'decision-template.md'));

  console.log(`Initialised cascade instance at: ${target}`);
  console.log('Next steps:');
  console.log('- customise 0-bootstrap/repo-purpose.md');
  console.log('- fill key summaries in 2-summaries/');
  console.log('- start capturing in 6-raw/inbox/ or with `cascade insight "..."`');
  console.log('- optionally install Codex prompts with `cascade install codex`');
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
    console.error('Missing insight text. Example: cascade insight "Users trust CSV export more than dashboard totals"');
    process.exit(1);
  }

  const dir = path.join(cwd, '6-raw', 'inbox', 'quick-notes');
  ensureDir(dir);
  const fileName = `${todayUtc()}-${slugify(text)}.md`;
  const target = path.join(dir, fileName);

  const content = `---\ntitle: Raw Insight\ncapture_type: insight\nsource: cascade cli\ncreated_at: ${nowUtc()}\nsummary: ${text}\ntags: []\n---\n\n# Raw Insight\n\n## Insight\n${text}\n\n## Context / why it matters\n\n## Optional follow-up questions\n- \n`;

  fs.writeFileSync(target, content, 'utf8');
  console.log(`Captured insight: ${target}`);
  console.log('\nSuggested next command:');
  console.log('cascade synthesise inbox');
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
  const instruction = map[kind] || `Create a ${kind} draft from the cascade using progressive retrieval.`;
  console.log(instruction);
}

function doctor() {
  const checks = [
    ['cascade.instance.yaml', exists(path.join(cwd, 'cascade.instance.yaml'))],
    ['0-bootstrap/', exists(path.join(cwd, '0-bootstrap'))],
    ['1-routing/', exists(path.join(cwd, '1-routing'))],
    ['2-summaries/', exists(path.join(cwd, '2-summaries'))],
    ['6-raw/inbox/', exists(path.join(cwd, '6-raw', 'inbox'))]
  ];

  console.log('Cascade doctor\n');
  for (const [label, ok] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${label}`);
  }
}

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
      console.error('Missing artifact type. Example: cascade create roadmap');
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
    console.log(`Suggested agent instruction:\n\nSynthesise ${subcommand || 'the requested target'} using the cascade operating model: capture low, distil up, retrieve top-down.`);
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
    console.log('Check the local cascade.instance.yaml against upstream VERSION and CHANGELOG.md.');
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
