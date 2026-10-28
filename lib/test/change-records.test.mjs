import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeChangeRecord, parseChangeRecord, validateChangeRecord, createChangeId, createReleaseId,
  getChangeRecordGaps, CHANGE_RECORD_VERSION } from '../change-records.mjs';
const source = { type: 'manual', ref: 'capture.json', source_id: 'source_capture' };
const identity = { namespace: 'fixture-product', key: 'export' };
const normalize = (input = {}, options = {}) => normalizeChangeRecord(input, { source, identity, ...options });

test('sparse input exposes intent gaps and default provenance without assuming delivery or outcome', () => {
  const record = normalize({ title: ' Export ' });
  assert.equal(record.title, 'Export');
  assert.equal(record.hypothesis, null);
  assert.equal(record.delivery_status, 'unknown');
  assert.equal(record.review_status, 'unknown');
  assert.equal(record.outcome_status, 'unknown');
  assert.equal(record.release_id, null);
  assert.deepEqual(record.gaps, getChangeRecordGaps(record));
  assert.ok(record.gaps.includes('hypothesis'));
  assert.deepEqual(record.provenance['/hypothesis'], [{ ...{ ref: source.ref, source_id: source.source_id }, locator: '/hypothesis', method: 'defaulted' }]);
  assert.equal(record.provenance['/title'][0].method, 'copied');
  assert.equal(record.provenance['/change_id'][0].method, 'generated');
  assert.equal(record.provenance['/success_signals'][0].method, 'defaulted');
  assert.equal(validateChangeRecord(record).valid, true);
});

test('stable IDs survive changes to titles, content and source paths with a shared immutable identity', () => {
  assert.equal(normalize().change_id, normalize({ title: 'changed' }, { source: { ...source, ref: 'renamed.json' } }).change_id);
  assert.notEqual(createChangeId(identity), createChangeId({ ...identity, key: 'another' }));
  assert.equal(createReleaseId(identity), createReleaseId(identity));
  assert.notEqual(createReleaseId(identity), createChangeId(identity));
  assert.notEqual(createChangeId(), createChangeId());
  assert.equal(normalize({ change_id: 'external:42' }).change_id, 'external:42');
  assert.throws(() => createChangeId({ key: 'missing namespace' }));
});

test('each measurement result is preserved independently of delivery and review timing', () => {
  for (const outcome_status of ['not_measured', 'no_data', 'inconclusive', 'positive', 'negative', 'mixed', 'unknown']) {
    const record = normalize({ outcome_status, delivery_status: 'released', review_status: 'review_due' });
    assert.equal(record.outcome_status, outcome_status);
    assert.equal(record.review_status, 'review_due');
    assert.equal(record.delivery_status, 'released');
    assert.equal(record.lifecycle_state, undefined);
  }
});

test('JSON normalized round trip preserves all provenance, including multi-source overrides', () => {
  const refs = [{ ref: 'a', locator: 'line:1', method: 'copied' }, { ref: 'b', locator: '/goal', method: 'copied' }];
  const record = normalize({ target: '85%', success_signals: ['completion'], dates: { released: '2024-02-29' } }, { provenance: { '/target': refs } });
  assert.deepEqual(record.provenance['/target'], refs);
  assert.equal(record.provenance['/success_signals/0'][0].method, 'copied');
  assert.equal(record.provenance['/dates/released'][0].method, 'copied');
  assert.equal(record.provenance['/dates/planned'][0].method, 'defaulted');
  assert.deepEqual(parseChangeRecord(JSON.stringify(record)), record);
  refs[0].ref = 'mutation';
  assert.equal(record.provenance['/target'][0].ref, 'a');
});

test('all four example sources normalize to the same logical contract', () => {
  for (const [file, type] of [['openspec.md', 'openspec'], ['specification.md', 'specification'], ['release-notes.md', 'release_notes'], ['manual.json', 'manual']]) {
    const text = readFileSync(new URL(`../../examples/change-records/${file}`, import.meta.url), 'utf8');
    const record = parseChangeRecord(text, { format: file.endsWith('.json') ? 'json' : 'markdown', source: { type, ref: file }, identity });
    assert.equal(record.schema_version, CHANGE_RECORD_VERSION);
    assert.equal(validateChangeRecord(record).valid, true);
    if (type === 'openspec') {
      assert.equal(record.problem, 'Customers wait for large exports.');
      assert.deepEqual(record.gaps, []);
      assert.equal(record.provenance['/problem'][0].locator, 'line:3');
    }
    if (type === 'release_notes') {
      assert.ok(record.gaps.includes('hypothesis'));
      assert.equal(record.outcome_status, 'not_measured');
      assert.equal(record.dates.released, '2026-10-20');
    }
  }
});

test('malformed inputs, unsupported fields/versions and invalid provenance fail closed', () => {
  for (const input of [null, [], { schema_version: 2 }, { surprise: 'ignored?' }, { delivery_status: 'approved' },
    { title: 1 }, { success_signals: 'x' }, { dates: { released: '2025-02-29' } }, { dates: { mystery: '2026-01-01' } },
    { release_id: '' }, { provenance: { '/title': [] } }]) {
    assert.throws(() => normalize(input));
  }
  assert.throws(() => normalize({}, { source: {} }));
  assert.throws(() => normalize({ dates: { released: '2026-02-30' } }));
  assert.throws(() => normalize({}, { provenance: { '/made_up': [] } }));
  const record = normalize();
  delete record.provenance['/title'];
  assert.equal(validateChangeRecord(record).valid, false);
  assert.equal(validateChangeRecord(null).valid, false);
  assert.throws(() => parseChangeRecord('{}', { format: 'yaml' }));
});

test('Markdown adapter reports duplicates and malformed list sections; ignores unknown headings', () => {
  const options = { format: 'markdown', source, identity };
  assert.throws(() => parseChangeRecord('# X\n## Problem\nx\n## Problem\ny', options), /Duplicate/);
  assert.throws(() => parseChangeRecord('# X\n## Guardrails\nparagraph', options), /list item/);
  const record = parseChangeRecord('# X\n## Unmapped custom heading\nIntent might be here\n## Learning\n```md\n## Problem\n```', options);
  assert.equal(record.problem, null);
  assert.ok(record.gaps.includes('problem'));
});

test('validator checks exact fields, real dates, gaps, nested source and provenance', () => {
  for (const mutate of [r => { r.extra = true; }, r => { r.dates.released = '2026-02-30'; },
    r => { r.gaps = []; }, r => { r.source.extra = true; }, r => { r.provenance['/title'][0].method = 'inferred'; }]) {
    const record = normalize(); mutate(record);
    assert.equal(validateChangeRecord(record).valid, false);
  }
});


test('published schema and normalizer agree on the complete v1 field contract', () => {
  const schema = JSON.parse(readFileSync(new URL('../../schemas/change-record-v1.schema.json', import.meta.url), 'utf8'));
  const record = normalize();
  assert.deepEqual(Object.keys(record).sort(), schema.required.slice().sort());
  assert.deepEqual(Object.keys(record).sort(), Object.keys(schema.properties).sort());
  for (const field of ['delivery_status', 'review_status', 'outcome_status']) {
    for (const value of schema.properties[field].enum) assert.equal(normalize({ [field]: value })[field], value);
  }
});


test('OpenSpec delivery scope alone never becomes an expected product outcome', () => {
  const record = parseChangeRecord('# Export\n## Why\nCustomers wait.\n## What changes\nQueue jobs.', { format: 'markdown', source, identity });
  assert.equal(record.problem, 'Customers wait.');
  assert.equal(record.expected_outcome, null);
  assert.ok(record.gaps.includes('expected_outcome'));
});
