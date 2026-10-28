# Aggregate analytics evidence

Import a local aggregate export for a change or release. Mole requires no
analytics account, credentials, vendor SDK, backend, or user-level events.
Future adapters map provider exports to this same input contract and call
`parseAnalytics`. Reports consume the normalized output, independent of provider.
Do not put credentials, identifying rows, or secret dashboard URLs in exports.

```bash
mole analytics import review.json --namespace my-product --key release-2026-09-review-1
mole analytics import review.csv --namespace my-product --key review-2 --change-id change-search-typos --release-id release-2026-09
mole analytics import --source-id src_<uuid> --format json --namespace my-product --key review-3
```

The command prints JSON with `changed`, `path`, `raw_path`, and `event`. Paths
are workspace-relative. `--format csv|json` overrides extension detection. A
namespace and revision key are required. Repeating the same request returns
`changed:false`. Use a new key for a new export or changed binding options.
File input and `--source-id` are mutually exclusive. Duplicate or unknown CLI
options fail. Imports read local files only.

## Input contract, version 1

See executable [JSON](../examples/analytics-evidence/review.json) and
[CSV](../examples/analytics-evidence/review.csv) examples. JSON has this envelope:

```json
{
  "schema_version": 1,
  "change_id": "change-search-typos",
  "release_id": "release-2026-09",
  "metrics": [{"metric_id": "support_contacts", "status": "not_measured"}]
}
```

Use the explicit IDs from [change records](change-records.md) and
[release ingestion](release-ingestion.md). At least one change or release ID is
required. CLI bindings may supply missing JSON IDs; conflicting IDs fail.
These references are explicit assertions by the exporter. This importer does
not resolve intent, infer links from titles, prove a release happened, or set
intent/targets. CSV uses one header row and one row per metric; supply IDs via
CLI. CSV supports quoted commas, escaped double quotes, multiline cells, LF
and CRLF. Blank numeric cells and JSON null mean missing, never zero.

Each metric accepts these fields only:

- `metric_id`: required, nonempty, unique within the batch. Duplicate or missing
  IDs reject the entire import. To compare segments, give each segment its own ID.
- `definition`, `unit`, `segment`, `population`: optional text. State the event
  or metric definition, denominator and aggregation explicitly. Missing context
  stays null. Mole does not guess a population or rate denominator.
- `baseline_start`, `baseline_end`, `post_start`, `post_end`: UTC ISO calendar
  dates or timestamps with seconds and `Z`, optionally exactly three fractional
  digits. Dates normalize to midnight UTC. Windows use `[start,end)` throughout;
  start must precede end. Adjacent windows may share an endpoint, but overlap is
  invalid. Unequal durations are displayed and flagged, never auto-scaled.
- `baseline_complete`, `post_complete`: JSON boolean or CSV `true`/`false`.
  Missing completeness stays null. No completeness is inferred from today's
  date. Incomplete or unknown windows prevent a measured comparison. A window
  marked complete cannot end after `data_timestamp`.
- `baseline_value`, `post_value`: finite decimal numbers, including scientific
  notation. No hex, booleans, Infinity or NaN. Invalid values become null with
  `invalid_value` retaining their text and invalid status. Exact source bytes
  remain available. Signed values are allowed because some metrics are signed.
- `baseline_sample_size`, `post_sample_size`: optional nonnegative safe integer;
  absent sample sizes stay null. Invalid samples flag the metric invalid and
  retain `invalid_sample_size`. Mole does not estimate uncertainty from counts.
- `baseline_status`, `post_status`: `unknown`, `missing`, `invalid`,
  `not_measured`, `inconclusive`, or `measured`. Absent observation status is
  measured when a value exists and missing otherwise, except that explicit
  metric-level not measured supplies not measured for absent observations. A claimed measured
  observation without a value becomes missing. Values contradicting missing
  or not measured make the metric invalid.
- `status`: the same six states, default unknown. Invalid observations or
  invalid windows override to invalid; missing values override to missing;
  explicit not measured observations override to not measured. Requested
  measured status becomes inconclusive if completeness, definitions, references,
  timestamps or other comparison requirements have gaps. Explicit unknown is
  preserved when no stronger data problem exists.
- `outcome_status`: explicit `success`, `failure`, or `unknown`, default unknown.
  Output preserves this as `reported_outcome`; effective `outcome_status` is
  unknown unless the comparison status is measured. Mole never derives success
  or failure from increasing/decreasing values. A descriptive measurement alone
  says nothing about the intended target or causation.
- `data_timestamp`: export data timestamp using the same UTC grammar.
- `query_ref`, `export_ref`: optional opaque text references. Missing both is a
  quality gap. Use safe references without credentials; Mole never fetches them.
- `quality_status`: `unknown`, `good`, `limited`, or `invalid`. Reported invalid
  quality invalidates the metric. Generated issues override effective quality to
  limited or invalid while preserving `reported_status`.
- `quality_notes`, `confidence_notes`: optional text copied verbatim. These may
  describe coverage, selection bias, collection changes and confidence limits.

Malformed JSON/CSV, unsupported schema/format, unknown fields, invalid enum or
text types reject the batch before writes. Invalid numeric or date content is
retained as a metric with invalid quality instead of discarding other metrics.
Missing window boundaries are quality gaps. Bad calendar dates and reversed
windows are invalid. Missing data, invalid data, not measured, inconclusive and
unknown remain distinct from an explicit outcome judgment.

## Normalized output and report use

`parseAnalytics(text, {format, source, identity, changeId?, releaseId?})` is pure.
`source` requires `type` and `ref`, with optional `source_id`.
`identity` requires `namespace` and `key`. `importAnalytics(root, options)` adds
immutable persistence; options are `file` or `sourceId`, `identity`, optional
`format`, `changeId`, and `releaseId`. Both exports live in
`lib/analytics-evidence.mjs`. Native Node 18 or later suffices.

The event contains `schema_version:1`, deterministic `evidence_id`, explicit
`change_id`/`release_id`, `link_provenance`, `source`, `review_state:'draft'`, and `metrics`.
Each metric keeps definition/context/notes, `baseline` and `post` observations,
normalized `windows` with `duration_ms`, `data_timestamp`, effective `status`,
outcome fields, `quality` with explicit issues, and input-field `provenance`.
Provenance names the source reference and source ID, with JSON pointers or CSV
logical record/column locators, and copied/defaulted methods. Multiline CSV
locators count logical records, not physical lines. Derived comparisons use the
baseline/post source fields rather than an invented query.

`comparison.absolute_change` is post minus baseline in the supplied unit.
`relative_change_percent` is `(post-baseline)/abs(baseline)*100`.
A zero baseline yields null relative change and `relative_status:'zero_baseline'`,
even when both values are zero. Missing or invalid observations give null deltas.
Arithmetic overflow invalidates the metric and clears both deltas. Deltas may
still describe available numbers from incomplete windows; always read status
and quality. No significance test, normalization or causal adjustment runs.
`causal_claim:false` and the event attribution caveat explicitly limit interpretation.

Cite the normalized file's registered source ID in a travel log's evidence
references, alongside qualitative source IDs such as interviews or support
summaries. Keep metric definitions, both window bounds, quality and attribution
caveats visible in the report. This import does not accept a travel log, produce
a learning, or decide what to do next. The [lifecycle](review-lifecycle.md) is
authoritative even if a JSON field says draft.

## Publication, replay and retention

The importer copies exact source bytes under `6-raw/analytics/` and stores the
normalized event under `5-evidence/analytics/`. It never overwrites the input.
Both paths use a hash of evidence identity, avoiding input-derived paths.
The raw file gets a source record and raw lifecycle state; the normalized file
gets its own source record and draft lifecycle state citing that raw source ID.
Resolve source IDs with the [source registry](source-provenance.md) after moves;
paths in evidence are navigation hints.

The raw registration includes an immutable request fingerprint over identity,
format, explicit bindings and exact byte hash. Both raw and normalized registered files can be relocated. Replay returns the
resolved normalized path without creating a duplicate. Replay verifies that fingerprint,
the normalized event and resolved raw bytes, including after raw capture moves.
Changed bytes/options require a new revision identity. Missing historical
fingerprints fail closed. Existing destinations are never replaced. Payloads
stage in private sibling directories, verify bytes, fsync and publish with an
atomic no-replace hard link, following release ingestion's retry practice.
Retry resumes files/registrations after handled failures. A killed process may
leave ignored staging directories. Conflicting or missing source resolutions
and symlink paths fail closed. Registration uses the existing local registry
and lifecycle locking rules; this is not a distributed transaction.

Imports deliberately retain exact aggregate exports. Privacy/retention work in
issue #25 must cover both analytics directories, request/source records,
references, normalized provenance and interrupted staging payloads. Do not
assume a retention policy is implemented here. No credentials, hosted calls or
raw user-event requirement belong in future provider adapters either.
