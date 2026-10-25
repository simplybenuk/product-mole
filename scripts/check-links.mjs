#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const INLINE_LINK_PATTERN = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
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

    lines.forEach((line, index) => {
      for (const match of line.matchAll(INLINE_LINK_PATTERN)) {
        const target = match[1];
        if (EXTERNAL_TARGET_PATTERN.test(target) || target.startsWith('#')) continue;

        const targetPath = target.split('#')[0].split('?')[0];
        let decodedPath;
        try {
          decodedPath = decodeURI(targetPath);
        } catch {
          decodedPath = targetPath;
        }

        const resolved = decodedPath.startsWith('/')
          ? path.join(root, decodedPath)
          : path.resolve(root, path.dirname(file), decodedPath);
        if (!fs.existsSync(resolved)) {
          broken.push({ file, line: index + 1, target });
        }
      }
    });
  }

  return broken;
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
