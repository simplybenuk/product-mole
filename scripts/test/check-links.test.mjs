import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { findBrokenLinks } from '../check-links.mjs';

const roots = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-check-links-'));
  roots.push(root);
  return root;
}

function write(root, file, content = '') {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Markdown link checker', () => {
  it('accepts inline and reference links to existing relative files', () => {
    const root = makeRoot();
    write(root, 'guide/target.md');
    write(root, 'guide/file#name.md');
    write(root, 'guide/file name.md');
    write(root, 'guide/index.md', [
      '[inline](target.md)',
      '[full][target]',
      '[multiline][multiline-target]',
      '[collapsed][]',
      '[shortcut]',
      '[encoded hash](file%23name.md?view=1#section)',
      '[encoded space](file%20name.md#section)',
      '',
      '[target]: target.md "target title"',
      '[multiline-target]:',
      '  target.md',
      '[collapsed]: <target.md>',
      '[shortcut]: target.md',
    ].join('\n'));

    assert.deepEqual(findBrokenLinks(root), []);
  });

  it('reports broken inline and full, collapsed, and shortcut references', () => {
    const root = makeRoot();
    write(root, 'index.md', [
      '[inline](missing-inline.md)',
      '[full][missing-full]',
      '[collapsed][]',
      '[shortcut]',
      '',
      '[missing-full]: missing-full.md',
      '[collapsed]: missing-collapsed.md',
      '[shortcut]: missing-shortcut.md',
    ].join('\n'));

    assert.deepEqual(findBrokenLinks(root), [
      { file: 'index.md', line: 1, target: 'missing-inline.md' },
      { file: 'index.md', line: 2, target: 'missing-full.md' },
      { file: 'index.md', line: 3, target: 'missing-collapsed.md' },
      { file: 'index.md', line: 4, target: 'missing-shortcut.md' },
    ]);
  });

  it('ignores external links, anchors, and links in inline or fenced code', () => {
    const root = makeRoot();
    write(root, 'index.md', [
      '[external](https://example.com/missing.md)',
      '[anchor](#section)',
      '`[inline code](missing-inline.md)`',
      '`[code reference][missing]`',
      '```md',
      '[fenced](missing-fenced.md)',
      '[fenced reference][missing]',
      '```',
      '',
      '[missing]: missing-reference.md',
    ].join('\n'));

    assert.deepEqual(findBrokenLinks(root), []);
  });

  it('does not scan inline link titles or escaped references as reference uses', () => {
    const root = makeRoot();
    write(root, 'index.md', [
      '[external](https://example.com "[external-ref]")',
      '[anchor](#section "[anchor-ref]")',
      "[single](https://example.com '[external-ref]')",
      '[parenthesized](#section ([anchor-ref]))',
      '\\[escaped-ref]',
      '',
      '[external-ref]: missing-external.md',
      '[anchor-ref]: missing-anchor.md',
      '[escaped-ref]: missing-escaped.md',
    ].join('\n'));

    assert.deepEqual(findBrokenLinks(root), []);
  });

  it('follows broken references with destinations on the next indented line', () => {
    const root = makeRoot();
    write(root, 'index.md', [
      '[guide][broken-ref]',
      '[also][unindented]',
      '',
      '[broken-ref]:',
      '  missing.md',
      '[unindented]:',
      'also-missing.md',
    ].join('\n'));

    assert.deepEqual(findBrokenLinks(root), [
      { file: 'index.md', line: 1, target: 'missing.md' },
      { file: 'index.md', line: 2, target: 'also-missing.md' },
    ]);
  });
});
