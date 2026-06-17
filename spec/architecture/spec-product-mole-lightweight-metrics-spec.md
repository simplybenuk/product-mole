# Product Mole Lightweight Metrics Spec

## Working Title

Molehill Metrics

## Purpose

Add lightweight local metrics to Product Mole so product managers and maintainers can see whether inbox material is being processed into the mole over time.

This is operational telemetry for local-first Mole workspaces. It is not a hosted analytics system, event warehouse, or user-tracking feature.

## Problem

Mole is most useful when teams regularly capture raw inputs and process them into evidence, context, summaries, and indexes. Today there is no simple way to answer:

- how many inbox items have been processed recently
- whether processing activity is increasing, dropping, or stalled
- whether a team is consistently feeding the mole
- when the last recorded processing activity happened

The original idea described a "synthesised insights" metric. In the current codebase, synthesis is agent-guided rather than a structured automated pipeline, so the MVP metric must use the existing machine-readable inbox processing receipt flow.

## Users / Actors

- Product managers using Mole to capture and process product context.
- Maintainers checking whether a Mole workspace is being actively tended.
- Agents or humans completing inbox processing runs through the `mole inbox` workflow.

## Goals

- Count processed inbox source items using local files only.
- Reuse the existing inbox processing lock and receipt workflow.
- Show daily, weekly, and monthly processing activity.
- Preserve useful historical rollups within defined retention windows.
- Provide a static local dashboard that reads the metrics JSON files.
- Keep metrics failures non-blocking for inbox processing.

## Non-goals

- Do not introduce a database.
- Do not require hosted analytics or a network service.
- Do not track individual user behavior beyond existing receipt attribution.
- Do not store raw insight content in metrics files.
- Do not infer synthesis quality or downstream impact.
- Do not build a complex reporting system.
- Do not make metrics required for successful inbox processing.

## Current Findings

- `mole synthesise inbox` currently prints an agent instruction rather than running a structured synthesis processor.
- The `mole-synthesise-inbox` skill guides an agent to process inbox material into higher-signal context, evidence, summaries, and indexes.
- `lib/inbox-processing.mjs` already has a machine-readable completion point through `completeInboxProcessing()`.
- Inbox processing receipts already include `processed: options.processed || []`, but the CLI does not yet expose a way to pass processed paths.
- Operational records already live under `governance/run-receipts/`, so metrics should live under `governance/metrics/`.
- The repository currently has no `.gitignore`; empty starter metrics files should be committed and treated as local workspace state.

## Confirmed Decisions

- MVP metric: processed inbox items count.
- Trigger: successful `mole inbox complete`.
- Count source: receipt `processed` relative paths.
- Dedupe key: processed inbox relative path, scoped to the current day.
- Storage location: `governance/metrics/`.
- Data format: JSON source files.
- Dashboard: static local HTML file with no external dependencies.
- Date convention: UTC dates and ISO weeks starting Monday.
- Failure behavior: metrics warnings must not fail inbox completion.

## Metric Definition

### Primary Metric

`processed_inbox_items`

Definition:

The number of unique inbox source item paths recorded as processed by successful inbox processing completion receipts.

### Counting Rules

Count one processed item when:

- `mole inbox complete` succeeds
- a processed inbox relative path is supplied
- the path has not already been counted for the current UTC date

Do not count an item when:

- inbox completion fails
- no processed paths are supplied
- the same processed path is supplied repeatedly on the same UTC date
- the command is a future dry-run or preview mode

If one completion command supplies multiple unique processed paths, increment the daily count by the number of unique paths not yet seen today.

## CLI Requirements

Extend `mole inbox complete` so users and agents can provide processed paths.

Supported shape:

```text
mole inbox complete --processed 6-raw/inbox/a.md --processed 6-raw/inbox/b.md "Promoted two customer signals"
```

Requirements:

- Accept repeated `--processed <path>` flags.
- Preserve the existing summary behavior for trailing text.
- Write the supplied paths into the receipt `processed` array.
- Pass the same processed paths to the metrics recorder after the receipt is written.
- Keep `mole inbox complete "summary"` valid and non-counting when no processed paths are supplied.
- Show processed-path usage in CLI help.

Add an explicit historical backfill command:

```text
mole metrics backfill
```

Requirements:

- Read historical `governance/run-receipts/inbox-processing/*.json` receipt files.
- Count only receipts with valid `completed_at` dates and non-empty `processed` path arrays.
- Dedupe processed paths per UTC completion date.
- Rebuild daily, weekly, monthly, and current-day dedupe files from receipt data.
- Print receipts scanned, receipts counted, receipts skipped, and processed paths counted.
- Do not infer processed items from raw inbox folders.
- Do not read or store raw insight content.

## Storage Design

Create committed starter files:

```text
governance/
  metrics/
    daily.json
    weekly.json
    monthly.json
    seen-today.json
    dashboard.html
```

Implementation code should live in a reusable module:

```text
lib/
  metrics.mjs
```

The metrics files are local workspace state. They should remain inspectable and editable as plain text.

## Data Schemas

### `governance/metrics/daily.json`

Stores the previous 100 UTC daily records.

```json
{
  "schema_version": 1,
  "metric": "processed_inbox_items",
  "retention": {
    "unit": "day",
    "limit": 100
  },
  "updated_at": "2026-06-11T09:00:00Z",
  "records": [
    {
      "date": "2026-06-11",
      "count": 2
    }
  ]
}
```

### `governance/metrics/weekly.json`

Stores the previous 52 ISO-style Monday-start week records.

```json
{
  "schema_version": 1,
  "metric": "processed_inbox_items",
  "retention": {
    "unit": "week",
    "limit": 52
  },
  "week_start_day": "monday",
  "updated_at": "2026-06-11T09:00:00Z",
  "records": [
    {
      "week_start": "2026-06-08",
      "week_end": "2026-06-14",
      "count": 6
    }
  ]
}
```

### `governance/metrics/monthly.json`

Stores the previous 24 calendar-month records.

```json
{
  "schema_version": 1,
  "metric": "processed_inbox_items",
  "retention": {
    "unit": "month",
    "limit": 24
  },
  "updated_at": "2026-06-11T09:00:00Z",
  "records": [
    {
      "month": "2026-06",
      "month_start": "2026-06-01",
      "month_end": "2026-06-30",
      "count": 18
    }
  ]
}
```

### `governance/metrics/seen-today.json`

Stores short-lived daily dedupe evidence without raw content.

```json
{
  "schema_version": 1,
  "date": "2026-06-11",
  "updated_at": "2026-06-11T09:00:00Z",
  "seen": [
    {
      "key": "6-raw/inbox/a.md",
      "first_seen_at": "2026-06-11T08:31:00Z"
    }
  ]
}
```

When the UTC date changes, reset `seen` to an empty list for the new date.

## Metrics Module Requirements

Create `lib/metrics.mjs` with focused functions.

### `recordProcessedInboxItems(instanceRoot, processedPaths, options = {})`

Responsibilities:

- normalize input to unique non-empty relative paths
- load or initialize metrics files
- reset `seen-today.json` when the UTC date changes
- ignore paths already seen today
- increment today in `daily.json` by the number of new paths
- refresh the affected current week and current month
- trim retention windows
- return a small result object such as `{ ok, counted, skipped }`

Failure behavior:

- catch metrics read/write failures at the CLI integration boundary
- log a warning
- do not fail the inbox completion command

### Rollup Behavior

Daily:

- append or update today
- keep at most 100 records
- sort records by ascending date

Weekly:

- update the current week from available daily records for that week
- preserve older weekly records already present in `weekly.json`
- keep at most 52 records
- sort records by ascending `week_start`

Monthly:

- update the current month from available daily records for that month
- preserve older monthly records already present in `monthly.json`
- keep at most 24 records
- sort records by ascending `month`

Important caveat:

Do not rebuild all weekly or monthly history only from `daily.json`, because daily retention is shorter than monthly retention.

## Dashboard Requirements

Create `governance/metrics/dashboard.html`.

The dashboard must:

- run as a local static HTML file
- read `daily.json`, `weekly.json`, and `monthly.json`
- allow switching between daily, weekly, and monthly views
- allow a simple date range filter
- show total count for the selected range
- show average count for the selected range
- show latest recorded period
- show latest day, week, and month counts
- show a simple table of records
- show a simple bar display or chart without external dependencies

The dashboard does not need authentication because it is intended for local workspace use.

## Documentation And Agent Guidance

Update documentation or skill guidance so agents know to provide processed paths when completing inbox work.

Required guidance:

- after processing inbox material, run `mole inbox complete --processed <path> ... "summary"`
- include each inbox item that was actually processed
- do not count items that were inspected but skipped
- do not include raw content in metrics files

Likely files:

- `README.md`
- `cli/README.md`
- `cli/skills/mole-synthesise-inbox/SKILL.md`
- `0-bootstrap/agents.md`

## Security / Privacy

- Metrics files must store paths and aggregate counts only.
- Metrics files must not store raw insight text, summaries, or source content.
- Metrics must not introduce hosted tracking.
- Existing receipt attribution remains governed by the inbox processing workflow.

## Reliability

- Metrics are best-effort operational telemetry.
- A metrics failure must not prevent receipt creation or lock release.
- Missing metrics files should be recreated with valid starter content.
- Invalid JSON should produce a warning and avoid destructive repair unless the implementation can preserve or clearly replace the broken file.

## Acceptance Criteria

### Data Capture

- `mole inbox complete --processed <path> "summary"` writes the path to the receipt.
- A successful completion increments today by one for each unique processed path.
- Repeating the same processed path on the same UTC date does not double count it.
- Running inbox completion without processed paths remains valid and does not increment metrics.
- Metrics update failure does not make inbox completion fail.
- `mole metrics backfill` rebuilds metrics from historical receipts that contain processed paths.

### Retention And Rollups

- `daily.json` keeps no more than 100 records.
- `weekly.json` keeps no more than 52 records.
- `monthly.json` keeps no more than 24 records.
- Weekly records use Monday-start weeks.
- Monthly records use calendar months.
- Historical weekly and monthly records are preserved beyond the daily retention window.

### Dashboard

- `governance/metrics/dashboard.html` can be opened locally.
- It can display daily, weekly, and monthly records.
- It can filter by date range.
- It shows totals, averages, latest period, and a simple visual count display.
- It uses local metrics JSON files as its source data.

### Tests

Add tests covering:

- repeated `--processed` CLI parsing
- receipt `processed` array population
- counting new processed paths
- backfilling from historical receipts with processed paths
- same-day dedupe
- date-change reset of `seen-today.json`
- daily retention trimming
- weekly and monthly retention trimming
- preserving historical weekly and monthly records
- inbox completion still succeeds when metrics update fails
- starter file creation when metrics files are missing

## Implementation Task Outline

The build should be split into PRD tasks:

1. Add metrics module and starter JSON files.
2. Extend inbox completion CLI and receipt integration.
3. Add static dashboard.
4. Update docs and agent guidance.

These tasks are now represented in `plans/prd.json` under the `molehill-metrics` category.
