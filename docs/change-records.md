# Change and outcome records

Mole's version 1 record describes intent, delivery and observed outcomes without requiring a planning tool. The [JSON Schema](../schemas/change-record-v1.schema.json) defines the stored structure. The pure Node module [change-records.mjs](../lib/change-records.mjs) parses and validates records. It performs no filesystem writes, network access or lifecycle transitions.

## Use the contract

```js
import { parseChangeRecord, normalizeChangeRecord, validateChangeRecord }
  from './lib/change-records.mjs';

const record = parseChangeRecord(markdown, {
  format: 'markdown',
  source: { type: 'specification', ref: 'spec/search.md', source_id: 'source_search' },
  identity: { namespace: 'my-product', key: 'search-typos' }
});
const result = validateChangeRecord(record); // { valid: true, errors: [] }
const stored = JSON.stringify(record, null, 2);
```

`normalizeChangeRecord(input, {source, identity, provenance})` accepts sparse mapped values. `parseChangeRecord(text, options)` accepts `json` by default or `markdown`. Both return a complete record and throw `TypeError` on invalid structure or unsupported versions. JSON syntax errors throw `SyntaxError`. `validateChangeRecord(record)` returns `{valid, errors}` without coercion. `getChangeRecordGaps(record)` returns the missing intent field names. `CHANGE_RECORD_VERSION` and `CHANGE_RECORD_FIELDS` describe the v1 contract.

Use `createChangeId()` or `createReleaseId()` to generate a local UUID once, then persist it. Supplying `{namespace, key}` to either produces a deterministic SHA-256 ID. Use an immutable product namespace and logical key, never a title, mutable path, or content hash. The importer must choose this identity. Independent imports without a shared identity cannot be deduplicated reliably. Supplied nonempty IDs are preserved, including external IDs. A release ID groups changes into a release; it is never inferred from dates or titles. Preserve IDs on rename and edit. JSON input can be sparse or already normalized; normalized JSON round-trips with its provenance.

## Field glossary

Every field exists after normalization. Missing text is `null`, missing lists are `[]`, missing statuses are `unknown`. Empty text normalizes to `null`. Arrays retain source order. All strings are plain data, never executable instructions.

| Field | Meaning |
| --- | --- |
| `schema_version` | Integer 1. Future versions need explicit migration. |
| `change_id`, `release_id` | Stable change identity and optional release grouping. |
| `source` | Required `type` and `ref`; optional immutable registry `source_id`. Type is an open string such as `openspec`, `specification`, `release_notes`, or `manual`. |
| `title` | Source title; may be absent. |
| `dates` | `planned`, `released`, `review_due`, `reviewed`, each a real `YYYY-MM-DD` calendar date or null. No inferred dates or timezone conversion. |
| `problem` | Problem or context motivating the change. |
| `hypothesis` | Proposed causal explanation. |
| `expected_outcome` | Intended user or business result. |
| `success_signals` | Named measures or observable signals, as strings. |
| `baseline`, `target` | Source-defined comparison and intended threshold, as text with units. |
| `review_window` | Source-defined observation period, as text. |
| `guardrails` | Conditions that must remain acceptable. |
| `evidence` | Source IDs or references, one string per reference. |
| `observed_outcome` | What was observed; shipping alone proves no outcome. |
| `confidence` | Source's assessment of certainty, as text. |
| `attribution_caveats` | Confounders and limits on causal claims. |
| `learning` | What was learned. |
| `next_decision` | Proposed or recorded next step. |
| `delivery_status` | `planned`, `released`, `unknown`. |
| `review_status` | Outcome review timing: `not_due`, `review_due`, `reviewed`, `unknown`. Never means human approval of context. |
| `outcome_status` | `not_measured`, `no_data`, `inconclusive`, `positive`, `negative`, `mixed`, `unknown`. |
| `gaps` | Computed missing intent fields: problem, hypothesis, expected outcome, success signals, baseline, target, review window and guardrails. |
| `provenance` | JSON-pointer map covering each scalar, null or empty container, excluding provenance itself and computed gaps. |

`not_measured` means measurement was not performed. `no_data` means measurement was attempted or expected but usable observations are absent. `inconclusive` means observations exist but do not settle the question. `unknown` means the source makes no assessment. None counts as success or failure. The library preserves explicit classifications; it does not calculate them or verify causal claims. Review timing is supplied explicitly, never calculated from the machine clock. Contradictory source claims remain source claims for human review.

## Provenance and adapters

Each provenance entry is a nonempty array of `{ref, source_id?, locator, method}`. Use the immutable source registry ID when one exists and retain `ref` as a navigation hint. External references are opaque strings; the parser never fetches them or verifies existence. Locators can be JSON pointers or `line:N` for Markdown. Evidence lists point to their captured source via provenance; their string values identify the evidence itself.

Normalization generates a pointer for every leaf, including each list item and individual date. Copied values use `method: 'copied'`; absent values use `defaulted`; generated IDs and schema version use `generated`. Defaulted entries identify which source lacked the field; they do not claim the source stated null or unknown. Missing intent remains in `gaps`. The provenance map can retain multiple sources per value. Pass exact pointer overrides in `options.provenance`, for example `{'/target': [{ref:'spec.md', locator:'line:42', method:'copied'}]}`. Invalid or unknown pointers fail validation. Adapters must supply truthful locators and must not label invented values as copied. Validation checks coverage and shape, not truth or completeness of source interpretation.

The Markdown adapter recognizes an H1 title and headings matching glossary field names, with spaces or underscores. Scalar sections preserve text, list sections require one `- ` item per line, and `dates` contains a JSON object. Repeated recognized fields fail rather than silently overwrite. It ignores unrecognized sections and recognizes `Why` as problem for simple OpenSpec proposals. `What changes` describes scope, so it does not populate expected outcome. Supply an explicit `Expected outcome` section when the proposal states one. It does not implement OpenSpec semantics, arbitrary YAML, frontmatter, nested metric structures, tables, or semantic extraction. Fenced headings are not interpreted as fields. Write a format-specific adapter that maps values and precise provenance into normalization for richer sources. Inspect gaps after every import.

See the [four source examples](../examples/change-records/README.md). Intent fields are optional for all source types. No OpenSpec package is required.

## Ownership and review

This is a logical contract, not a new context layer or automatic approval path. Applications choose where user-owned records live and must protect them during upgrades. This module does not create workspace directories or modify source files. Raw captures remain raw evidence; synthesized durable context still follows the [contribution guide](../governance/contribution-guide.md) and [review lifecycle](review-lifecycle.md). A `released` change or `reviewed` outcome does not make a lifecycle draft accepted. Only the lifecycle ledger determines approved context.
