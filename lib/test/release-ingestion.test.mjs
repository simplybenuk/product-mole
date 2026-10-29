import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseRelease, importRelease } from '../release-ingestion.mjs';
import { normalizeChangeRecord, validateChangeRecord } from '../change-records.mjs';
import { registerSource, resolveSource, reconcileSource } from '../source-registry.mjs';
import { listLifecycleRecords } from '../review-lifecycle.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = fs.readFileSync(path.join(root, 'examples/release-ingestion/multi-change.md'), 'utf8');
const identity = { namespace: 'demo', key: '2026-09' };
const source = { type: 'release', ref: 'release.md' };
const intent = (id, title) => normalizeChangeRecord({ change_id: id, title }, { source: { type: 'specification', ref: 'intent.json' } });
const parse = (body, options = {}) => parseRelease(body, { source, identity, ...options });
function workspace(t, body = fixture, name = 'input.md') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

test('multi-change release keeps scope separate from intent and outcome with precise source references', () => {
  const event = parse(fixture, { intents: [intent('search-typos', 'Original search intent'), intent('csv', 'Export CSV files')] });
  assert.equal(event.released_at, '2026-09-30');
  assert.equal(event.release_id, 'product-release-2026-09');
  assert.deepEqual(event.changes.map(c => c.intent_link.status), ['explicit', 'suggested', 'unresolved_id']);
  assert.equal(event.changes[1].intent_link.intent_id, null);
  assert.equal(event.source_links[0], 'https://example.test/releases/2026-09');
  for (const { record } of event.changes) {
    assert.equal(validateChangeRecord(record).valid, true);
    assert.equal(record.expected_outcome, null);
    assert.equal(record.observed_outcome, null);
    assert.equal(record.outcome_status, 'unknown');
    assert.ok(record.gaps.includes('expected_outcome'));
    assert.match(record.provenance['/title'][0].locator, /^line:/);
  }
  assert.equal(new Set(event.changes.map(c => c.record.change_id)).size, 3);
});

test('missing and ambiguous IDs never silently match', () => {
  const records = [intent('same', 'A'), intent('same', 'A')];
  assert.equal(parse('- A [intent:same]', { intents: records }).changes[0].intent_link.status, 'ambiguous_id');
  assert.equal(parse('- A', { intents: records }).changes[0].intent_link.status, 'ambiguous');
  assert.equal(parse('- Missing').changes[0].intent_link.status, 'missing');
  assert.throws(() => parse('- A [intent:]'), /intent_id/);
  assert.throws(() => parse('- A [intent:x] [intent:y]'), /Multiple/);
});

test('JSON preserves explicit expected outcome, stable keys and rejects malformed candidates', () => {
  const body = { changes: [{ key: 'a', title: 'A', expected_outcome: 'Less waiting' }, { key: 'b', title: 'B' }] };
  const first = parse(JSON.stringify(body), { format: 'json' });
  body.changes.reverse();
  const second = parse(JSON.stringify(body), { format: 'json' });
  assert.equal(first.changes[0].record.change_id, second.changes[1].record.change_id);
  assert.equal(first.changes[0].record.expected_outcome, 'Less waiting');
  for (const value of ['{', 'null', '{"changes":[]}', '{"changes":[null]}', '{"changes":[{"key":"a"},{"key":"a"}]}', '{"released_at":"2026-02-30","changes":[{}]}', '{"changes":[{}],"approve":true}']) {
    assert.throws(() => parse(value, { format: 'json' }));
  }
});

test('bounded exports work without network or vendor packages', () => {
  assert.equal(parse(JSON.stringify({ tag_name: 'v1', published_at: '2026-09-30T12:00:00Z', body: '- A', html_url: 'https://example.test/v1' }), { format: 'json' }).changes.length, 1);
  assert.equal(parse(JSON.stringify([{ number: 42, title: 'A', body: 'What changes', url: 'https://example.test/pr/42' }]), { format: 'json' }).changes[0].record.expected_outcome, null);
  assert.equal(parse(JSON.stringify({ issues: [{ key: 'DEL-1', fields: { summary: 'A' } }] }), { format: 'json' }).changes.length, 1);
});

test('import preserves bytes, registers raw and draft provenance, replays and refuses replacement', t => {
  const dir = workspace(t);
  const result = importRelease(dir, { file: 'input.md', identity });
  assert.deepEqual(fs.readFileSync(path.join(dir, result.raw_path)), Buffer.from(fixture));
  assert.equal(fs.readFileSync(path.join(dir, 'input.md'), 'utf8'), fixture);
  assert.deepEqual(listLifecycleRecords(dir).map(r => r.state).sort(), ['draft', 'raw']);
  assert.equal(importRelease(dir, { file: 'input.md', identity }).changed, false);
  fs.appendFileSync(path.join(dir, 'input.md'), '\nChanged');
  assert.throws(() => importRelease(dir, { file: 'input.md', identity }), /different raw bytes/);
  assert.equal(fs.readFileSync(path.join(dir, result.raw_path), 'utf8'), fixture);
});

test('registered unmanaged/moved sources remain resolvable but imports refuse before privacy recovery', t => {
  const dir = workspace(t);
  const registered = registerSource(dir, { path: 'input.md' });
  fs.mkdirSync(path.join(dir, '6-raw/archive'), { recursive: true });
  fs.renameSync(path.join(dir, 'input.md'), path.join(dir, '6-raw/archive/moved.md'));
  reconcileSource(dir, registered.source_id, '6-raw/archive/moved.md');
  assert.equal(resolveSource(dir, registered.source_id).ok, true);
  assert.throws(() => importRelease(dir, { sourceId: registered.source_id, identity }), /privacy/i);
  fs.writeFileSync(path.join(dir, 'selected.md'), fixture);
  const first = importRelease(dir, { file: 'selected.md', identity });
  fs.renameSync(path.join(dir, first.raw_path), path.join(dir, '6-raw/archive/capture.md'));
  assert.equal(resolveSource(dir, first.event.source.source_id).ok, true);
  assert.throws(() => importRelease(dir, { file: 'selected.md', identity }), /privacy/i);
  assert.equal(fs.readFileSync(path.join(dir, '6-raw/archive/capture.md'), 'utf8'), fixture);
});

test('malformed input writes nothing; unsafe output or registry paths fail closed', t => {
  const dir = workspace(t, '{', 'input.json');
  assert.throws(() => importRelease(dir, { file: 'input.json', identity }));
  assert.equal(fs.existsSync(path.join(dir, '6-raw')), false);
  fs.writeFileSync(path.join(dir, 'input.md'), fixture);
  fs.mkdirSync(path.join(dir, '6-raw'));
  fs.symlinkSync(os.tmpdir(), path.join(dir, '6-raw/releases'));
  assert.throws(() => importRelease(dir, { file: 'input.md', identity }), /symlink/);
  fs.unlinkSync(path.join(dir, '6-raw/releases'));
  fs.mkdirSync(path.join(dir, 'governance'));
  fs.symlinkSync(os.tmpdir(), path.join(dir, 'governance/sources'));
  assert.throws(() => importRelease(dir, { file: 'input.md', identity }), /symlink/);
});

test('CLI imports a draft and errors on missing identity or duplicate arguments', t => {
  const dir = workspace(t);
  const cli = path.join(root, 'cli/mole.mjs');
  const run = args => spawnSync(process.execPath, [cli, 'release', 'import', ...args], { cwd: dir, encoding: 'utf8' });
  const good = run(['input.md', '--namespace', 'demo', '--key', 'release']);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).event.review_state, 'draft');
  assert.notEqual(run(['input.md']).status, 0);
  assert.notEqual(run(['input.md', '--key', 'a', '--key', 'b']).status, 0);
});


test('occupied event files and invalid UTF-8 remain untouched', t => {
  const dir = workspace(t);
  const first = importRelease(dir, { file: 'input.md', identity });
  const eventFile = path.join(dir, first.path);
  fs.writeFileSync(eventFile, 'user-owned content');
  assert.throws(() => importRelease(dir, { file: 'input.md', identity }));
  assert.equal(fs.readFileSync(eventFile, 'utf8'), 'user-owned content');
  fs.writeFileSync(path.join(dir, 'bad.md'), Buffer.from([0xff]));
  assert.throws(() => importRelease(dir, { file: 'bad.md', identity: { ...identity, key: 'bad' } }));
  assert.throws(() => importRelease(dir, { sourceId: 'src_missing', identity }));
});

test('nested code fences never create delivery candidates or intent links', () => {
  const event = parse('````markdown\n```\n- Fake [intent:secret]\n```\n````\n- Real');
  assert.equal(event.changes.length, 1);
  assert.equal(event.changes[0].record.title, 'Real');
});

test('R12-1 archived raw captures still reject adapter-ignored byte changes', t => {
  const dir = workspace(t);
  const first = importRelease(dir, { file: 'input.md', identity });
  fs.mkdirSync(path.join(dir, '6-raw/archive'), { recursive: true });
  fs.renameSync(path.join(dir, first.raw_path), path.join(dir, '6-raw/archive/capture.md'));
  fs.appendFileSync(path.join(dir, 'input.md'), '\nAdditional scope that must be captured.\n');
  assert.throws(() => importRelease(dir, { file: 'input.md', identity }), /privacy/i);
  assert.equal(fs.readFileSync(path.join(dir, '6-raw/archive/capture.md'), 'utf8'), fixture);
});

for (const layer of ['6-raw/staging', '5-evidence/releases']) {
  test(`R12-2 partial ${layer} payload write preserves partial state with bounded retry`, t => {
    const dir = workspace(t);
    const original = fs.writeFileSync;
    let faulted = false;
    fs.writeFileSync = function(file, data, options) {
      if (!faulted && String(file).includes(layer)) {
        faulted = true;
        original.call(fs, file, Buffer.from(data).subarray(0, 8), options);
        throw Object.assign(new Error('Injected full disk'), { code: 'ENOSPC' });
      }
      return original.call(fs, file, data, options);
    };
    try { assert.throws(() => importRelease(dir, { file: 'input.md', identity }), /Injected full disk/); }
    finally { fs.writeFileSync = original; }
    assert.equal(faulted, true);
    if (layer === '6-raw/staging') {
      const staged = fs.readdirSync(path.join(dir, layer));
      assert.equal(staged.length, 1);
      assert.equal(fs.readFileSync(path.join(dir, layer, staged[0])).length, 8);
      assert.throws(() => importRelease(dir, { file: 'input.md', identity }), /privacy|different raw bytes/i);
      assert.equal(fs.existsSync(path.join(dir, '6-raw/inbox')), false);
      return;
    }
    assert.deepEqual(fs.readdirSync(path.join(dir, layer)), []);
    const retry = importRelease(dir, { file: 'input.md', identity });
    assert.equal(retry.changed, true);
    assert.equal(fs.readFileSync(path.join(dir, retry.raw_path), 'utf8'), fixture);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, retry.path), 'utf8')).release_id, retry.event.release_id);
  });
}

test('R12-1 replay binds identity and options independently of an archived source path', t => {
  const dir = workspace(t);
  const first = importRelease(dir, { file: 'input.md', identity });
  fs.mkdirSync(path.join(dir, '6-raw/archive'), { recursive: true });
  fs.renameSync(path.join(dir, first.raw_path), path.join(dir, '6-raw/archive/capture.md'));
  assert.throws(() => importRelease(dir, { file: 'input.md', identity }), /privacy/i);
  fs.renameSync(path.join(dir, '6-raw/archive/capture.md'), path.join(dir, first.raw_path));
  // The artifact supplies release_id, so these namespace/key changes leave parsed output unchanged.
  for (const modified of [{ ...identity, namespace: 'other' }, { ...identity, key: 'other' }]) {
    assert.throws(() => importRelease(dir, { file: 'input.md', identity: modified }), /different import request/);
  }
  // An unrelated intent also leaves every parsed link unchanged, but changes the supplied options.
  assert.throws(() => importRelease(dir, { file: 'input.md', identity, intents: [intent('unrelated', 'Unrelated')] }), /different import request/);
  assert.equal(importRelease(dir, { file: 'input.md', identity: { key: identity.key, namespace: identity.namespace } }).changed, false);
});

for (const layer of ['6-raw/inbox', '5-evidence/releases']) {
  test(`R12-2 ${layer} publication preserves a destination created concurrently`, t => {
    const dir = workspace(t);
    const original = fs.linkSync;
    let occupied;
    fs.linkSync = function(from, destination) {
      if (!occupied && String(destination).includes(layer)) {
        occupied = destination;
        fs.writeFileSync(destination, 'preexisting concurrent user file', { flag: 'wx' });
      }
      return original.call(fs, from, destination);
    };
    try { assert.throws(() => importRelease(dir, { file: 'input.md', identity }), { code: 'EEXIST' }); }
    finally { fs.linkSync = original; }
    assert.equal(fs.readFileSync(occupied, 'utf8'), 'preexisting concurrent user file');
    assert.equal(fs.readdirSync(path.dirname(occupied)).some(name => name.startsWith('.mole-release-')), false);
  });
}

test('R12-2 silent short staging writes are detected before publication', t => {
  const dir = workspace(t);
  const original = fs.writeFileSync;
  fs.writeFileSync = function(file, data, options) {
    return original.call(fs, file, String(file).includes('6-raw/staging') ? Buffer.from(data).subarray(0, 8) : data, options);
  };
  try { assert.throws(() => importRelease(dir, { file: 'input.md', identity }), /Incomplete staged import write/); }
  finally { fs.writeFileSync = original; }
  assert.equal(fs.existsSync(path.join(dir, '6-raw/inbox')), false);
  assert.equal(fs.readdirSync(path.join(dir, '6-raw/staging')).length, 1);
  assert.throws(() => importRelease(dir, { file: 'input.md', identity }), /privacy|different raw bytes/i);
});
