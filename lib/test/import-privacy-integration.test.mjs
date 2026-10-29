// Cross-stack regressions for INT-1/INT-2. All state is disposable synthetic data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importRelease } from '../release-ingestion.mjs';
import { importAnalytics } from '../analytics-evidence.mjs';
import { privacyInventory, scanRaw, purgeRaw } from '../privacy.mjs';

const cases = [
  ['release', importRelease, new URL('../../examples/product-travel-log/acceptance/release.md', import.meta.url)],
  ['analytics', importAnalytics, new URL('../../examples/analytics-evidence/review.json', import.meta.url)]
];
function fixture(t, input) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mole-import-privacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(input, path.join(root, 'input' + path.extname(input.pathname)));
  return { root, options: { file: 'input' + path.extname(input.pathname), identity: { namespace: 'synthetic-integration', key: 'review-1' } } };
}
function snapshot(root) {
  const result = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      const stat = fs.statSync(file);
      result.push([path.relative(root, file), stat.mode, stat.mtimeMs, entry.isDirectory() ? null : fs.readFileSync(file).toString('base64')]);
      if (entry.isDirectory()) walk(file);
    }
  };
  walk(root);
  return result;
}
for (const [kind, importer, input] of cases) {
  test(`INT-1 ${kind}: first import is retention-managed under its stable raw source identity`, t => {
    const { root, options } = fixture(t, input);
    const result = importer(root, options);
    const record = privacyInventory(root).find(r => r.source_id === result.event.source.source_id);
    assert.ok(record, 'raw capture must enter privacy inventory at first import');
    assert.equal(record.retention_state, 'active');
    assert.equal(scanRaw(root).unregistered_items, 0);
    assert.equal(purgeRaw(root).recovery_required, false);
    const before = snapshot(root);
    assert.equal(importer(root, options).changed, false);
    assert.deepEqual(snapshot(root), before, 'clean replay must preserve bytes, metadata and expiry');
  });
  for (const mode of ['replay', 'sourceId']) {
    test(`INT-2 ${kind}: legacy import -> scan -> ${mode} refuses before reading quarantine and preserves state`, t => {
      const { root, options } = fixture(t, input);
      const first = importer(root, options);
      // Model an installation created by the pre-integration importer.
      fs.rmSync(path.join(root, 'governance/privacy'), { recursive: true, force: true });
      scanRaw(root, { apply: true });
      assert.equal(privacyInventory(root)[0].outcome, 'quarantined');
      const before = snapshot(root);
      noRawAccess(root, () => {
        const request = mode === 'replay' ? options : { sourceId: first.event.source.source_id, identity: options.identity, format: path.extname(input.pathname) === '.json' ? 'json' : 'markdown' };
        assert.throws(() => importer(root, request), /privacy|eligible|quarantin|managed|expired|deleted/i);
      });
      assert.deepEqual(snapshot(root), before, 'refusal must not mutate files or ledgers');
    });
  }
}

import { ingestPrivateCapture, reviewQuarantine } from '../privacy.mjs';
import { readUniqueSourceMetadata, registerSource, reconcileSource } from '../source-registry.mjs';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
const privateValues = [
  'person name: Synthetic Example', 'postal address: 2 Synthetic Road',
  ['synthetic','example.invalid'].join('@'), '+44 1234 567890',
  'customer_id: synthetic-123', 'api_key: synthetic-fixture-value',
  '-----BEGIN PRIVATE KEY-----\nsynthetic-fixture\n-----END PRIVATE KEY-----',
  'postgres://fixture:fixture@database.invalid/db', 'diagnosis: synthetic-fixture',
  'bank account: synthetic-fixture', 'contract terms: synthetic-fixture', 'unknown token format'
];
function noRawAccess(root, operation) {
  const reads = [];
  const originals = { readFileSync: fs.readFileSync, openSync: fs.openSync };
  for (const key of Object.keys(originals)) fs[key] = function(file, ...args) {
    if (String(file).startsWith(path.join(root, '6-raw') + path.sep)) reads.push(String(file));
    return originals[key].call(fs, file, ...args);
  };
  try { operation(); assert.deepEqual(reads, [], 'refusal precedes raw read/open/hash'); }
  finally { Object.assign(fs, originals); }
}
for (const [kind, importer, input] of cases) {
  test(`${kind}: TTL, scan, explicit purge and replay never renew or resurrect raw`, t => {
    const { root, options } = fixture(t, input);
    fs.writeFileSync(path.join(root, 'mole.privacy.json'), JSON.stringify({ ttl_days: 3 }));
    const first = importer(root, options);
    const record = privacyInventory(root)[0];
    assert.equal(Date.parse(record.expires_at) - Date.parse(record.captured_at), 3 * 86400000);
    assert.equal(scanRaw(root, { apply: true }).unregistered_items, 0);
    assert.equal(importer(root, options).changed, false);
    assert.deepEqual(privacyInventory(root), [record]);
    assert.equal(purgeRaw(root, { apply: true, now: '2099-01-01' }).items[0].status, 'deleted');
    const before = snapshot(root);
    noRawAccess(root, () => {
      for (const request of [options, { sourceId: record.source_id, format: kind === 'release' ? 'markdown' : 'json', identity: options.identity }, { ...options, file: first.raw_path }]) {
        assert.throws(() => importer(root, request), /privacy/i);
      }
    });
    assert.deepEqual(snapshot(root), before);
    assert.equal(fs.existsSync(path.join(root, first.raw_path)), false);
  });
  test(`${kind}: expired and missing source states refuse before repairs or input reads`, t => {
    const { root, options } = fixture(t, input);
    const first = importer(root, options);
    const manifest = path.join(root, `governance/privacy/${first.event.source.source_id}.json`);
    const record = JSON.parse(fs.readFileSync(manifest));
    record.captured_at = '2000-01-01T00:00:00.000Z'; record.expires_at = '2000-01-08T00:00:00.000Z';
    fs.writeFileSync(manifest, JSON.stringify(record));
    let before = snapshot(root);
    noRawAccess(root, () => assert.throws(() => importer(root, options), /privacy/i));
    assert.deepEqual(snapshot(root), before);
    fs.unlinkSync(manifest);
    before = snapshot(root);
    noRawAccess(root, () => assert.throws(() => importer(root, options), /privacy/i));
    assert.deepEqual(snapshot(root), before);
  });
  test(`${kind}: source-ID requests reuse identity, expiry and existing source reference`, t => {
    const { root, options } = fixture(t, input);
    const first = importer(root, options);
    const sourceId = first.event.source.source_id;
    const original = readUniqueSourceMetadata(root, sourceId);
    const privacy = privacyInventory(root);
    // A new analytics request gets its own output. Release identity is supplied by
    // the document, so reuse the existing request for release and assert replay.
    const selected = { sourceId, identity: options.identity, format: kind === 'release' ? 'markdown' : 'json' };
    assert.equal(importer(root, selected).changed, false);
    if (kind === 'analytics') {
      const second = importer(root, { ...selected, identity: { ...options.identity, key: 'other-request' } });
      assert.equal(second.event.source.source_id, sourceId);
      assert.equal(second.raw_path, first.raw_path);
    }
    assert.deepEqual(privacyInventory(root), privacy);
    assert.deepEqual(readUniqueSourceMetadata(root, sourceId), original);
    assert.equal(fs.readFileSync(path.join(root, options.file)).equals(fs.readFileSync(input)), true);
  });
  test(`${kind}: explicit reviewed derivative reuses source and expiry without copying originals`, t => {
    const { root, options } = fixture(t, input);
    const canary = ['private-fixture','example.invalid'].join('@');
    const capture = ingestPrivateCapture(root, { content: Buffer.from(canary), supported: false });
    const sourceId = capture.record.source_id;
    const expiry = capture.record.expires_at;
    fs.writeFileSync(path.join(root, `6-raw/quarantine/${sourceId}.md`), fs.readFileSync(input));
    reviewQuarantine(root, sourceId, { apply: true, confirmReviewed: true });
    const original = readUniqueSourceMetadata(root, sourceId);
    const result = importer(root, { sourceId, identity: options.identity, format: kind === 'release' ? 'markdown' : 'json' });
    assert.equal(result.event.source.source_id, sourceId);
    assert.equal(result.raw_path, `6-raw/inbox/${sourceId}.md`);
    assert.equal(privacyInventory(root)[0].expires_at, expiry);
    assert.deepEqual(readUniqueSourceMetadata(root, sourceId), original);
    assert.equal(fs.readFileSync(path.join(root, `6-raw/quarantine/${sourceId}.bin`), 'utf8'), canary);
    assert.ok(!JSON.stringify(result).includes(canary));
  });
  test(`${kind}: registered-only and quarantine file selection cannot bypass the gate`, t => {
    const { root, options } = fixture(t, input);
    const unmanaged = registerSource(root, { path: options.file });
    const quarantine = ingestPrivateCapture(root, { content: fs.readFileSync(input), supported: false });
    const before = snapshot(root);
    noRawAccess(root, () => {
      for (const request of [
        { sourceId: unmanaged.source_id, identity: options.identity },
        { ...options, file: options.file },
        { sourceId: quarantine.record.source_id, identity: options.identity },
        { ...options, file: quarantine.path }
      ]) assert.throws(() => importer(root, request));
    });
    assert.deepEqual(snapshot(root), before);
  });
  for (const [index, value] of privateValues.entries()) {
    test(`${kind}: private/uncertain category ${index} refuses with no importer persistence`, t => {
      const { root, options } = fixture(t, input);
      const text = kind === 'release' ? `- Synthetic change\n\n${value}` : JSON.stringify({ change_id: 'synthetic', metrics: [{ metric_id: 'synthetic', definition: value }] });
      fs.writeFileSync(path.join(root, options.file), text);
      const before = snapshot(root);
      assert.throws(() => importer(root, options), error => /privacy/i.test(error.message) && !error.message.includes(value));
      assert.deepEqual(snapshot(root), before);
      assert.equal(fs.existsSync(path.join(root, 'governance')), false);
    });
  }
  test(`${kind}: original bytes and all decoded JSON keys/scalars are preflighted`, t => {
    const { root, options } = fixture(t, input);
    for (const body of [
      '{"changes":[{"title":"synthetic","description":"line one\\napi\\u005fkey\\u003a fixture-value"}]}',
      '{"metrics":[{"metric_id":"synthetic","nested":[{"api\\u005fkey\\u003a fixture-value":"safe"}]}]}'
    ]) {
      fs.writeFileSync(path.join(root, options.file), body);
      const before = snapshot(root);
      assert.throws(() => importer(root, { ...options, format: 'json' }), /privacy/i);
      assert.deepEqual(snapshot(root), before);
    }
    fs.writeFileSync(path.join(root, options.file), Buffer.from([0xff]));
    assert.throws(() => importer(root, options), /privacy/i);
    fs.writeFileSync(path.join(root, options.file), Buffer.alloc(4 * 1024 * 1024 + 1, 'a'));
    assert.throws(() => importer(root, options), /privacy/i);
  });
  test(`${kind}: options are scanned before request hashing and original persistence`, t => {
    const { root, options } = fixture(t, input);
    const before = snapshot(root);
    const value = 'api_key: synthetic-option-value';
    assert.throws(() => importer(root, { ...options, identity: { namespace: value, key: 'synthetic' } }), /privacy/i);
    if (kind === 'analytics') assert.throws(() => importer(root, { ...options, changeId: value }), /privacy/i);
    else assert.throws(() => importer(root, { ...options, intents: [{ title: value }] }), /privacy/i);
    assert.deepEqual(snapshot(root), before);
  });
  test(`${kind}: current request fingerprint remains the original v1 exact-byte definition`, t => {
    const { root, options } = fixture(t, input);
    importer(root, options);
    const file = path.join(root, 'governance/imports', kind);
    const receipt = JSON.parse(fs.readFileSync(path.join(file, fs.readdirSync(file)[0])));
    const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
    const fields = { identity: options.identity, format: kind === 'release' ? 'markdown' : 'json', ...(kind === 'release' ? { intents: [] } : { changeId: null, releaseId: null }), content_sha256: hash(fs.readFileSync(input)) };
    assert.deepEqual(receipt.request_reference, { kind: `mole-${kind}-import-v1`, value: hash(canonical(fields)) });
    assert.deepEqual(Object.keys(receipt).sort(), ['schema_version','kind','input_source_id','output_source_id','output_path','format','request_reference','captured_at','expires_at','processed_at'].sort());
  });
  test(`${kind}: unrelated quarantine is never opened by success, moved-evidence replay or registration`, t => {
    const { root, options } = fixture(t, input);
    const quarantine = ingestPrivateCapture(root, { content: fs.readFileSync(input), supported: false });
    const first = importer(root, options);
    // Evidence move is explicitly reconciled outside import.
    const outputSource = JSON.parse(fs.readFileSync(path.join(root, 'governance/imports', kind, fs.readdirSync(path.join(root, 'governance/imports', kind))[0]))).output_source_id;
    const moved = '5-evidence/reconciled.json';
    fs.renameSync(path.join(root, first.path), path.join(root, moved));
    reconcileSource(root, outputSource, moved);
    const originalRead = fs.readFileSync, originalOpen = fs.openSync;
    const deny = file => { if (String(file) === path.join(root, quarantine.path)) throw new Error('UNAUTHORIZED QUARANTINE READ'); };
    fs.readFileSync = function(file, ...args) { deny(file); return originalRead.call(fs,file,...args); };
    fs.openSync = function(file, ...args) { deny(file); return originalOpen.call(fs,file,...args); };
    try {
      assert.equal(importer(root, options).changed, false);
      assert.equal(importer(root, options).path, moved);
    } finally { fs.readFileSync = originalRead; fs.openSync = originalOpen; }
  });
}

test('analytics: strict quoted multiline CSV cells and headers are scanned before normalization', t => {
  const { root, options } = fixture(t, cases[1][2]);
  for (const body of ['metric_id,definition\nx,"line one\napi_key: synthetic-cell"\n', 'metric_id,"api_key: synthetic-header"\nx,plain\n']) {
    fs.writeFileSync(path.join(root, options.file), body);
    const before = snapshot(root);
    assert.throws(() => importAnalytics(root, { ...options, format: 'csv', changeId: 'synthetic' }), /privacy/i);
    assert.deepEqual(snapshot(root), before);
  }
});

for (const [kind, importer, input] of cases) {
  for (const boundary of ['request', 'manifest', 'staged', 'raw', 'source', 'evidence']) {
    test(`${kind}: interrupted ${boundary} boundary has only bounded same-ID recovery`, t => {
      const { root, options } = fixture(t, input);
      const originalLink = fs.linkSync, originalWrite = fs.writeFileSync;
      let injected = false;
      const hit = file => boundary === 'request' ? String(file).includes(`governance/imports/${kind}/`) :
        boundary === 'manifest' ? /governance\/privacy\/src_.*\.json$/.test(String(file)) :
        boundary === 'staged' ? /6-raw\/staging\/src_.*\.bin$/.test(String(file)) :
        boundary === 'raw' ? /6-raw\/inbox\/src_.*\.md$/.test(String(file)) :
        boundary === 'source' ? /governance\/sources\/records\/src_.*\.json$/.test(String(file)) :
        String(file).includes(`5-evidence/${kind === 'release' ? 'releases' : 'analytics'}/`) && String(file).endsWith('.json');
      fs.linkSync = function(from, to) {
        const result = originalLink.call(fs, from, to);
        if (!injected && hit(to)) { injected = true; throw new Error('Injected boundary interruption'); }
        return result;
      };
      fs.writeFileSync = function(file, ...args) {
        const result = originalWrite.call(fs, file, ...args);
        if (!injected && ['staged','source'].includes(boundary) && hit(file)) { injected = true; throw new Error('Injected boundary interruption'); }
        return result;
      };
      try { assert.throws(() => importer(root, options), /Injected boundary/); }
      finally { fs.linkSync = originalLink; fs.writeFileSync = originalWrite; }
      assert.equal(injected, true);
      const receipts = path.join(root, 'governance/imports', kind);
      const receiptFile = path.join(receipts, fs.readdirSync(receipts)[0]);
      const receiptBefore = fs.readFileSync(receiptFile);
      const receipt = JSON.parse(receiptBefore);
      if (boundary === 'request' || boundary === 'manifest') {
        const before = snapshot(root);
        assert.throws(() => importer(root, options), /privacy/i);
        assert.deepEqual(snapshot(root), before, 'intent without owned bytes needs explicit recovery');
      } else {
        let syncedStage = false;
        const fsync = fs.fsyncSync;
        const link = fs.linkSync;
        const stage = path.join(root, `6-raw/staging/${receipt.input_source_id}.bin`);
        const stageInode = boundary === 'staged' ? fs.statSync(stage).ino : null;
        fs.fsyncSync = function(fd) { if (fs.fstatSync(fd).ino === stageInode) syncedStage = true; return fsync.call(fs, fd); };
        fs.linkSync = function(from, to) {
          if (boundary === 'staged' && to === path.join(root, privacyEligibleLocations(receipt.input_source_id)[0])) assert.equal(syncedStage, true, 'resume fsyncs the eligible stage before publication');
          return link.call(fs, from, to);
        };
        let result;
        try { result = importer(root, options); } finally { fs.fsyncSync = fsync; fs.linkSync = link; }
        assert.equal(result.event.source.source_id, receipt.input_source_id);
        assert.equal(privacyInventory(root)[0].expires_at, receipt.expires_at);
        assert.equal(fs.readFileSync(receiptFile).equals(receiptBefore), true);
        assert.equal(importer(root, options).changed, false);
      }
    });
  }
  test(`${kind}: a same-request publication race adopts the winning IDs without overwrite`, t => {
    const { root, options } = fixture(t, input);
    const originalLink = fs.linkSync;
    let winner, injected = false;
    fs.linkSync = function(from, to) {
      if (!injected && String(to).includes(`governance/imports/${kind}/`) && String(to).endsWith('.json')) {
        injected = true;
        winner = importer(root, options);
      }
      return originalLink.call(fs, from, to);
    };
    let second;
    try { second = importer(root, options); }
    finally { fs.linkSync = originalLink; }
    assert.equal(injected, true);
    assert.equal(second.changed, false);
    assert.deepEqual(second.event, winner.event);
    assert.equal(privacyInventory(root).length, 1);
  });
  test(`${kind}: missing canonical bytes, conflicting source metadata and missing source do not trigger repair`, t => {
    const { root, options } = fixture(t, input);
    const first = importer(root, options);
    const raw = path.join(root, first.raw_path);
    const bytes = fs.readFileSync(raw);
    fs.unlinkSync(raw);
    let before = snapshot(root);
    noRawAccess(root, () => assert.throws(() => importer(root, options), /privacy/i));
    assert.deepEqual(snapshot(root), before);
    fs.writeFileSync(raw, bytes);
    const sourcePath = path.join(root, `governance/sources/records/${first.event.source.source_id}.json`);
    const original = fs.readFileSync(sourcePath);
    const copy = path.join(root, 'governance/sources/records/conflicting-copy.json');
    fs.writeFileSync(copy, original);
    before = snapshot(root);
    noRawAccess(root, () => assert.throws(() => importer(root, options), /privacy/i));
    assert.deepEqual(snapshot(root), before);
    fs.unlinkSync(copy);
    fs.unlinkSync(sourcePath);
    before = snapshot(root);
    noRawAccess(root, () => assert.throws(() => importer(root, options), /privacy/i));
    assert.deepEqual(snapshot(root), before);
  });
}

import { archiveManagedRaw } from '../privacy.mjs';
import { privacyEligibleLocations } from '../privacy-locations.mjs';
for (const [kind, importer, input] of cases) {
  test(`${kind}: managed archive preserves privacy/source identity, fingerprint, expiry and replay`, t => {
    const { root, options } = fixture(t, input);
    const first = importer(root, options);
    const sourceId = first.event.source.source_id;
    const original = privacyInventory(root)[0];
    const sourceBefore = readUniqueSourceMetadata(root, sourceId);
    const move = archiveManagedRaw(root, sourceId, { apply: true });
    assert.equal(move.path, privacyEligibleLocations(sourceId)[1]);
    assert.equal(readUniqueSourceMetadata(root, sourceId).source_reference, sourceBefore.source_reference);
    const before = snapshot(root);
    const replay = importer(root, options);
    assert.equal(replay.changed, false);
    assert.equal(replay.raw_path, move.path);
    assert.deepEqual(replay.event, first.event);
    assert.equal(privacyInventory(root)[0].source_id, sourceId);
    assert.equal(privacyInventory(root)[0].expires_at, original.expires_at);
    assert.deepEqual(snapshot(root), before);
    assert.equal(scanRaw(root).unregistered_items, 0);
    assert.equal(purgeRaw(root, { apply: true, now: '2099-01-01' }).items[0].status, 'deleted');
    const after = snapshot(root);
    noRawAccess(root, () => assert.throws(() => importer(root, options), /privacy/i));
    assert.deepEqual(snapshot(root), after);
  });
  test(`${kind}: prepared managed move blocks replay/source-ID and repairs before raw opens`, t => {
    const { root, options } = fixture(t, input);
    const first = importer(root, options);
    const sourceId = first.event.source.source_id;
    const link = fs.linkSync;
    let injected = false;
    fs.linkSync = function(from, to) {
      const result = link.call(fs, from, to);
      if (!injected && to === path.join(root, privacyEligibleLocations(sourceId)[1])) { injected = true; throw new Error('Injected managed move interruption'); }
      return result;
    };
    try { assert.throws(() => archiveManagedRaw(root, sourceId, { apply: true })); }
    finally { fs.linkSync = link; }
    assert.equal(injected, true);
    assert.equal(purgeRaw(root).recovery_required, true);
    const before = snapshot(root);
    noRawAccess(root, () => {
      assert.throws(() => importer(root, options), /privacy/i);
      assert.throws(() => importer(root, { sourceId, identity: options.identity, format: kind === 'release' ? 'markdown' : 'json' }), /privacy/i);
    });
    assert.deepEqual(snapshot(root), before);
    archiveManagedRaw(root, sourceId, { apply: true, recover: true });
    assert.equal(importer(root, options).changed, false);
  });
}

for (const [kind, importer, input] of cases) {
  test(`${kind}: existing capture provenance is preserved by a new source-ID request`, t => {
    const { root, options } = fixture(t, input);
    const capture = ingestPrivateCapture(root, { content: fs.readFileSync(input) });
    const record = capture.record;
    const reference = { kind: 'synthetic-origin', value: 'retain-original-reference' };
    registerSource(root, { source_id: record.source_id, path: capture.path, captured_at: record.captured_at, source_type: 'export', source_reference: reference,
      media_type: kind === 'release' ? 'text/markdown' : 'application/json' });
    const before = readUniqueSourceMetadata(root, record.source_id);
    const result = importer(root, { sourceId: record.source_id, identity: options.identity, format: kind === 'release' ? 'markdown' : 'json' });
    assert.equal(result.event.source.source_id, record.source_id);
    assert.deepEqual(readUniqueSourceMetadata(root, record.source_id), before);
    assert.deepEqual(readUniqueSourceMetadata(root, record.source_id).source_reference, reference);
    assert.deepEqual(privacyInventory(root), [record]);
  });
  test(`${kind}: output source missing after completion and ambiguous partial captures cannot be repaired`, t => {
    const { root, options } = fixture(t, input);
    const first = importer(root, options);
    const receipts = path.join(root, 'governance/imports', kind);
    const receipt = JSON.parse(fs.readFileSync(path.join(receipts, fs.readdirSync(receipts)[0])));
    const metadataPath = path.join(root, `governance/sources/records/${receipt.output_source_id}.json`);
    const originalMetadata = fs.readFileSync(metadataPath);
    fs.unlinkSync(metadataPath);
    let before = snapshot(root);
    assert.throws(() => importer(root, options), /privacy/i);
    assert.deepEqual(snapshot(root), before);
    fs.writeFileSync(metadataPath, originalMetadata);
    // An independent stage inode is ambiguity, even when its bytes happen to match.
    fs.writeFileSync(path.join(root, `6-raw/staging/${receipt.input_source_id}.bin`), fs.readFileSync(path.join(root, first.raw_path)));
    before = snapshot(root);
    noRawAccess(root, () => assert.throws(() => importer(root, options), /privacy/i));
    assert.deepEqual(snapshot(root), before);
  });
}

import { listLifecycleRecords } from '../review-lifecycle.mjs';
for (const [kind, importer, input] of cases) {
  for (const state of ['raw', 'draft']) {
    test(`CORE-1 ${kind}: disappearing ${state} registration input refuses without quarantine discovery`, t => {
      const { root, options } = fixture(t, input);
      const matching = ingestPrivateCapture(root, { content: fs.readFileSync(input), supported: false });
      const sensitive = Buffer.alloc(fs.readFileSync(input).length, 32);
      Buffer.from('api_key: synthetic-core-one').copy(sensitive);
      const other = ingestPrivateCapture(root, { content: sensitive, supported: false });
      const originalLink = fs.linkSync, originalOpen = fs.openSync;
      let count = 0, injected = false, disappeared;
      const quarantineOpens = [];
      fs.linkSync = function(from, to) {
        const result = originalLink.call(fs, from, to);
        if (String(to).endsWith('/governance/lifecycle/.mutation.lock')) {
          count++;
          if (count === (state === 'raw' ? 1 : 2)) {
            injected = true;
            if (state === 'raw') disappeared = privacyInventory(root).find(r => ![matching.record.source_id,other.record.source_id].includes(r.source_id)).current_path;
            else {
              const dir = path.join(root, `5-evidence/${kind === 'release' ? 'releases' : 'analytics'}`);
              disappeared = path.relative(root, path.join(dir, fs.readdirSync(dir)[0]));
              ingestPrivateCapture(root, { content: fs.readFileSync(path.join(root, disappeared)), supported: false });
            }
            fs.renameSync(path.join(root, disappeared), path.join(root, 'moved-registration-input'));
          }
        }
        return result;
      };
      fs.openSync = function(file, ...args) {
        if (String(file).startsWith(path.join(root, '6-raw/quarantine') + path.sep)) quarantineOpens.push(String(file));
        return originalOpen.call(fs,file,...args);
      };
      try { assert.throws(() => importer(root, options), /privacy|current|snapshot|available|conflict/i); }
      finally { fs.linkSync = originalLink; fs.openSync = originalOpen; }
      assert.equal(injected, true);
      assert.deepEqual(quarantineOpens, []);
      assert.equal(listLifecycleRecords(root).filter(r => r.state === state).length, 0);
      assert.equal(fs.existsSync(path.join(root, disappeared)), false);
      assert.equal(fs.existsSync(path.join(root, 'moved-registration-input')), true);
      assert.equal(fs.readFileSync(path.join(root, other.path)).equals(sensitive), true);
    });
  }
  for (const identical of [false, true]) {
    test(`CORE-2 ${kind}: newly appeared ${identical ? 'identical' : 'different'} output is never adopted by a new request`, t => {
      const { root, options } = fixture(t, input);
      const link = fs.linkSync;
      let injected = false, outputPath, foreign;
      fs.linkSync = function(from, to) {
        const result = link.call(fs, from, to);
        if (!injected && String(to).includes(`governance/imports/${kind}/`) && String(to).endsWith('.json')) {
          injected = true;
          const receipt = JSON.parse(fs.readFileSync(to));
          outputPath = receipt.output_path;
          // Build exactly what A intends without changing any source/receipt metadata.
          const source = { type: kind, ref: privacyEligibleLocations(receipt.input_source_id)[0], source_id: receipt.input_source_id };
          const event = kind === 'release'
            ? parseRelease(fs.readFileSync(input,'utf8'), { format: 'markdown', source, identity: options.identity })
            : parseAnalytics(fs.readFileSync(input,'utf8'), { format: 'json', source, identity: options.identity });
          foreign = Buffer.from(JSON.stringify(identical ? event : { synthetic_competing_output: true }, null, 2) + '\n');
          fs.mkdirSync(path.dirname(path.join(root,outputPath)), { recursive: true });
          fs.writeFileSync(path.join(root,outputPath), foreign, { flag: 'wx' });
        }
        return result;
      };
      try { assert.throws(() => importer(root, options), /EEXIST|conflict|different|occupied|privacy/i); }
      finally { fs.linkSync = link; }
      assert.equal(injected, true);
      assert.equal(fs.readFileSync(path.join(root,outputPath)).equals(foreign), true);
      assert.deepEqual(findSourceRecordsByPath(root, outputPath), []);
      assert.equal(listLifecycleRecords(root).filter(r => r.state === 'draft').length, 0);
    });
  }
  test(`CORE-2 ${kind}: output replacement at lifecycle lock refuses without a wrong draft record`, t => {
    const { root, options } = fixture(t, input);
    const link = fs.linkSync;
    const foreign = Buffer.from('{"synthetic_replacement":true}\n');
    let locks = 0, injected = false, outputPath;
    fs.linkSync = function(from,to) {
      const result = link.call(fs,from,to);
      if (String(to).endsWith('/governance/lifecycle/.mutation.lock') && ++locks === 2) {
        injected = true;
        const dir = path.join(root, `5-evidence/${kind === 'release' ? 'releases' : 'analytics'}`);
        outputPath = path.join(dir,fs.readdirSync(dir)[0]);
        fs.writeFileSync(outputPath,foreign);
      }
      return result;
    };
    try { assert.throws(() => importer(root,options), /different|privacy|snapshot|conflict/i); }
    finally { fs.linkSync = link; }
    assert.equal(injected,true);
    assert.equal(fs.readFileSync(outputPath).equals(foreign),true);
    assert.equal(listLifecycleRecords(root).filter(r=>r.state==='draft').length,0);
  });
}
import { parseRelease } from '../release-ingestion.mjs';
import { parseAnalytics } from '../analytics-evidence.mjs';
import { findSourceRecordsByPath } from '../source-registry.mjs';
test('CORE-2 release: different requests sharing an explicit release ID cannot claim a competing publication', t => {
  const { root, options } = fixture(t,cases[0][2]);
  fs.writeFileSync(path.join(root,'competitor.md'),fs.readFileSync(cases[0][2],'utf8')+'\n- Competitor-only synthetic change\n');
  const link = fs.linkSync;
  let injected = false, competitorStopped = false, outputPath, winningBytes, winningReceipt;
  const outer = function(from,to) {
    if (!injected && String(to).includes('governance/imports/release/')) {
      injected = true;
      fs.linkSync = function(innerFrom,innerTo) {
        const result = link.call(fs,innerFrom,innerTo);
        if (String(innerTo).includes('governance/imports/release/') && String(innerTo).endsWith('.json')) winningReceipt = fs.readFileSync(innerTo);
        if (String(innerTo).includes('5-evidence/releases/')) {
          competitorStopped = true; outputPath = innerTo; winningBytes = fs.readFileSync(innerTo);
          throw new Error('Synthetic stop after competing publication');
        }
        return result;
      };
      try { assert.throws(() => importRelease(root,{ file:'competitor.md',identity:{...options.identity,key:'competitor'} }),/Synthetic stop/); }
      finally { fs.linkSync = outer; }
    }
    return link.call(fs,from,to);
  };
  fs.linkSync = outer;
  try { assert.throws(() => importRelease(root,options), /EEXIST|conflict|different|occupied|privacy/i); }
  finally { fs.linkSync = link; }
  assert.equal(injected && competitorStopped,true);
  assert.equal(fs.readFileSync(outputPath).equals(winningBytes),true);
  assert.equal(JSON.parse(winningBytes).changes.length,4);
  const receipt = JSON.parse(winningReceipt);
  assert.deepEqual(findSourceRecordsByPath(root,path.relative(root,outputPath)),[]);
  assert.equal(listLifecycleRecords(root).filter(r=>r.state==='draft').length,0);
  assert.equal(fs.readFileSync(path.join(root,`governance/imports/release/${hash(JSON.stringify([options.identity.namespace,'competitor']))}.json`)).equals(winningReceipt),true);
  assert.equal(readUniqueSourceMetadata(root,receipt.input_source_id).current_path,privacyEligibleLocations(receipt.input_source_id)[0]);
});

for (const [kind, importer, input] of cases) {
  test(`CORE-1 ${kind}: disappearance at the ledger commit boundary refuses before mutation`, t => {
    const { root, options } = fixture(t,input);
    const quarantine = ingestPrivateCapture(root,{content:fs.readFileSync(input),supported:false});
    const read = fs.readFileSync, open = fs.openSync;
    let ledgerReads = 0, injected = false;
    const foreignReads = [];
    // A fresh workspace has no ledger; the first locked read is the final CAS
    // immediately before publication, not an initial load of an existing ledger.
    fs.readFileSync = function(file,...args) {
      if (String(file) === path.join(root,'governance/lifecycle/records.json') && fs.existsSync(path.join(root,'governance/lifecycle/.mutation.lock')) && ++ledgerReads === 1) {
        injected = true;
        const current = privacyInventory(root).find(r=>r.source_id!==quarantine.record.source_id);
        fs.renameSync(path.join(root,current.current_path),path.join(root,'moved-before-commit'));
      }
      return read.call(fs,file,...args);
    };
    fs.openSync = function(file,...args) { if (String(file) === path.join(root,quarantine.path)) foreignReads.push(file); return open.call(fs,file,...args); };
    try { assert.throws(()=>importer(root,options),/privacy|snapshot|current/i); }
    finally { fs.readFileSync=read;fs.openSync=open; }
    assert.equal(injected,true);
    assert.deepEqual(foreignReads,[]);
    assert.deepEqual(listLifecycleRecords(root),[]);
  });
  test(`CORE-2 ${kind}: changed output before source metadata write is refused before registration`, t => {
    const { root, options } = fixture(t,input);
    const link = fs.linkSync, mkdir = fs.mkdirSync;
    let outputPath, injected = false;
    const foreign=Buffer.from('{"synthetic_source_boundary":true}\n');
    fs.linkSync=function(from,to) {
      const result=link.call(fs,from,to);
      if (String(to).includes('5-evidence/') && String(to).endsWith('.json')) outputPath=String(to);
      return result;
    };
    fs.mkdirSync=function(directory,...args) {
      if (outputPath && !injected && String(directory)===path.join(root,'governance/sources/records')) {
        injected=true;fs.writeFileSync(outputPath,foreign);
      }
      return mkdir.call(fs,directory,...args);
    };
    try { assert.throws(()=>importer(root,options),/privacy|different|snapshot|conflict/i); }
    finally { fs.linkSync=link;fs.mkdirSync=mkdir; }
    assert.equal(injected,true);
    assert.equal(fs.readFileSync(outputPath).equals(foreign),true);
    assert.deepEqual(findSourceRecordsByPath(root,path.relative(root,outputPath)),[]);
    assert.equal(listLifecycleRecords(root).filter(r=>r.state==='draft').length,0);
  });
}
