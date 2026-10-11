# Molehill Metrics

Molehill Metrics count what happened in a workspace. They answer two separate
questions:

- **Operational activity.** What processing happened?
- **Learning and decision state.** What product-context states changed?

They do not measure product success or the quality of a decision. An accepted
record means a person approved it. It does not mean the record is right.

```bash
mole metrics                  # summary, read-only
mole metrics --format json    # the same, for automation
mole metrics --events         # also list every event behind the counts
mole metrics snapshot         # write the summary for the dashboard
mole metrics backfill         # rebuild processed-item history from receipts
```

Product analytics, such as usage or conversion, are evidence about the
product. They are not part of these metrics.

## Categories

| Category | Group | What is counted | Time of the event |
| --- | --- | --- | --- |
| `captured_inputs` | operational | Review records opened as `raw`: one for each capture from the CLI or UI, and for each raw file registered or migrated. | When the record was registered. |
| `processed_inputs` | operational | Inbox items listed as processed in a completed inbox-processing receipt. An item is counted once, by source ID when the receipt has one and by path otherwise. | The completion time of the first receipt that lists the item. |
| `promoted_evidence` | learning | Records moved to `evidence`, or opened as `evidence`. | When the transition happened. |
| `reviewed_outputs` | learning | Human review decisions: each approval and each rejection. | When the decision was made. |
| `accepted_learnings` | learning | Approvals. A record revised and approved again counts once for each approval. | When it was approved. |
| `superseded_context` | learning | Accepted records replaced by another accepted record. | When the record was superseded. |
| `unresolved_questions` | learning | Open requests in the human-input queue. | None. See below. |

## Time windows

Each category is counted for three windows, measured back from the moment the
command runs:

| Window | Covers |
| --- | --- |
| `last_7_days` | The 7 × 24 hours before now. |
| `last_30_days` | The 30 × 24 hours before now. |
| `all_time` | Everything recorded up to now. |

An event exactly 7 days old is outside the 7-day window. Times are UTC. The
JSON output gives the `from` and `to` of each window.

`unresolved_questions` has no windows. The human-input queue records no
times, so the summary gives the number open now under `current` and `null`
for each window.

## Where the counts come from

Nothing is stored for the summary. Each run derives the events from records
that already exist:

| Source | Categories |
| --- | --- |
| The review ledger, `governance/lifecycle/records.json` | captured inputs, promoted evidence, reviewed outputs, accepted learnings, superseded context |
| Inbox-processing receipts, `governance/run-receipts/inbox-processing/` | processed inputs |
| `governance/input-queue.md` | unresolved questions |

Because the counts are derived, running the command again, completing the
same run again, or replaying a transition cannot count anything twice. The
ledger's history is append-only, and each event is one history entry.

## Events

`mole metrics --events --format json` adds an `events` list. Each event has:

| Field | Meaning |
| --- | --- |
| `event_id` | Stable ID. `<category>:<record_id>:<revision>` for a ledger event, `processed_inputs:<source_id or path>` for a processed item. |
| `category` | One of the categories above. |
| `at` | When it happened. |
| `record_id`, `source_id`, `path` | The review record, source, or inbox path. |
| `transition` | For a ledger event: `action`, `from_state`, `to_state`, `revision`. |
| `run_id` | For a processed item: the inbox run that completed it. |
| `actor`, `actor_type` | Who did it, as declared. |
| `provenance` | `kind` (`lifecycle_ledger` or `inbox_receipt`) and the file it came from. |

Store events by `event_id` and a repeated import adds nothing.

## What is unknown

The summary never fills a gap with a guess.

- **Before the review ledger.** A workspace that predates the ledger has no
  record of what was captured, reviewed, or accepted then. Each ledger
  category carries `available_from`, the time of the ledger's first entry,
  and a note that earlier activity is unknown, not zero. Old receipts are
  never counted as accepted learning.
- **Receipts without processed items.** A legacy receipt that lists no
  processed paths is counted in `receipts_without_items` and adds nothing to
  `processed_inputs`.
- **Ambiguous inbox state.** When receipts conflict, such as two runs
  claiming one path, `processed_inputs` is `unavailable` until
  `mole inbox audit` is clean.
- **Unreadable ledger.** When the review ledger cannot be validated, every
  ledger category is `unavailable`, with the reason.

A category's `availability` is `available`, `current_only`, or `unavailable`.
Counts are `null` when they are not known.

## Dashboard

`governance/metrics/dashboard.html` is a local page with two panels:

- **Operational activity: processed inbox items.** Daily, weekly, and monthly
  history from `daily.json`, `weekly.json`, and `monthly.json`. `mole inbox
  complete` updates these, and `mole metrics backfill` rebuilds them.
- **Workflow summary: activity and review state.** The seven categories from
  `outcomes.json`, with operational and learning counts under separate
  headings.

`mole metrics snapshot` writes `outcomes.json`. `mole metrics backfill`
writes it too. The page shows when the snapshot was written; it does not
update itself.

## Backfill

`mole metrics backfill` rebuilds the processed-item history from receipts, as
before. It counts only receipt `processed` paths with valid completion dates,
and it changes nothing when receipt state is ambiguous. It does not create
history for the other categories: those come from the ledger, which is
already the full record of what it covers.

## JSON shape

```json
{
  "schema_version": 1,
  "generated_at": "2026-10-10T12:00:00.000Z",
  "windows": [{ "key": "last_7_days", "label": "Last 7 days", "from": "...", "to": "..." }],
  "caveat": "These are counts of workflow activity and review state. ...",
  "groups": { "operational": "What processing happened.", "learning": "What product-context states changed." },
  "categories": [
    {
      "key": "accepted_learnings",
      "group": "learning",
      "label": "Accepted learnings",
      "definition": "...",
      "time": "...",
      "source": "lifecycle_ledger",
      "availability": "available",
      "counts": { "last_7_days": 1, "last_30_days": 1, "all_time": 2 },
      "latest_at": "2026-10-09T10:00:00.000Z",
      "available_from": "2026-09-01T09:00:00.000Z",
      "reason": "Counted from the review ledger, which starts at ..."
    }
  ],
  "event_count": 12
}
```

`schema_version` changes if a field is removed or changes meaning. New fields
may be added without a version change.

## Library

```js
import { summarizeMetrics, collectMetricEvents, writeMetricsSnapshot } from 'product-mole/lib/metrics-summary.mjs';

const summary = summarizeMetrics(root, { now, includeEvents: true });
```

## Limits

- Unresolved questions have no history, so the summary cannot say how many
  were opened or closed in a period.
- A capture made while the ledger could not be written has no review record
  until `mole lifecycle migrate --apply` registers it. It is then counted at
  the time of that migration.
- Actors are declarations. Mole does not authenticate who approved a record.
- The windows are rolling. The daily, weekly, and monthly history in the
  first dashboard panel uses calendar periods, so the two do not line up
  exactly.
