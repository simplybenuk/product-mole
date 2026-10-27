#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const INLINE_LINK_PATTERN = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REFERENCE_DEFINITION_PATTERN = /^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
const EMPTY_REFERENCE_DEFINITION_PATTERN = /^\s{0,3}\[([^\]]+)\]:\s*$/;
const CONTINUED_REFERENCE_TARGET_PATTERN = /^\s*(?:<([^>]+)>|(\S+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
const REFERENCE_PATTERN = /\[([^\]]+)\](?:\[([^\]]*)\])?/g;
const EXTERNAL_TARGET_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const FENCE_PATTERN = /^\s*(```|~~~)/;

function listMarkdownFiles(root) {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '*.md'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status === 0) {
    return result.stdout
      .split('\0')
      .filter(Boolean)
      .filter((file) => fs.existsSync(path.join(root, file)));
  }

  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const relativePath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(relativePath);
      else if (entry.name.endsWith('.md')) files.push(relativePath);
    }
  };
  walk('.');
  return files;
}

function stripCode(content) {
  let inFence = false;
  return content
    .split('\n')
    .map((line) => {
      if (FENCE_PATTERN.test(line)) {
        inFence = !inFence;
        return '';
      }
      return inFence ? '' : line.replace(/`[^`]*`/g, '``');
    })
    .join('\n');
}

export function findBrokenLinks(root = repoRoot) {
  const broken = [];

  for (const file of listMarkdownFiles(root)) {
    const content = stripCode(fs.readFileSync(path.join(root, file), 'utf8'));
    const lines = content.split('\n');
    const references = new Map();
    const definitionLines = new Set();

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const definition = line.match(REFERENCE_DEFINITION_PATTERN);
      if (definition) {
        const [, label, angleTarget, bareTarget] = definition;
        const key = normalizeReferenceLabel(label);
        if (!references.has(key)) references.set(key, angleTarget ?? bareTarget);
        definitionLines.add(index);
        continue;
      }

      const emptyDefinition = line.match(EMPTY_REFERENCE_DEFINITION_PATTERN);
      if (!emptyDefinition) continue;
      definitionLines.add(index);
      const continuedTarget = lines[index + 1]?.match(CONTINUED_REFERENCE_TARGET_PATTERN);
      if (!continuedTarget) continue;
      const [, angleTarget, bareTarget] = continuedTarget;
      const key = normalizeReferenceLabel(emptyDefinition[1]);
      if (!references.has(key)) references.set(key, angleTarget ?? bareTarget);
      definitionLines.add(index + 1);
      index += 1;
    }

    lines.forEach((line, index) => {
      const referenceText = line.replace(INLINE_LINK_PATTERN, (inlineLink) => ' '.repeat(inlineLink.length));
      for (const match of line.matchAll(INLINE_LINK_PATTERN)) {
        checkTarget(match[1], file, index + 1, root, broken);
      }

      if (definitionLines.has(index)) return;
      for (const match of referenceText.matchAll(REFERENCE_PATTERN)) {
        if (isEscaped(referenceText, match.index)) continue;
        const label = match[2] === undefined || match[2] === '' ? match[1] : match[2];
        const target = references.get(normalizeReferenceLabel(label));
        if (target !== undefined) checkTarget(target, file, index + 1, root, broken);
      }
    });
  }

  return broken;
}

function isEscaped(text, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function normalizeReferenceLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

function checkTarget(target, file, line, root, broken) {
  if (EXTERNAL_TARGET_PATTERN.test(target) || target.startsWith('#')) return;

  const targetPath = target.split(/[?#]/, 1)[0];
  let decodedPath;
  try {
    // decodeURIComponent also decodes reserved filename characters such as %23.
    decodedPath = decodeURIComponent(targetPath);
  } catch {
    decodedPath = targetPath;
  }

  const resolved = decodedPath.startsWith('/')
    ? path.join(root, decodedPath)
    : path.resolve(root, path.dirname(file), decodedPath);
  if (!fs.existsSync(resolved)) broken.push({ file, line, target });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const broken = findBrokenLinks();
  if (broken.length > 0) {
    for (const { file, line, target } of broken) {
      console.error(`${file}:${line}: broken link to ${target}`);
    }
    console.error(`Found ${broken.length} broken relative link(s) in Markdown files.`);
    process.exit(1);
  }
  console.log('Markdown relative link check passed.');
}
