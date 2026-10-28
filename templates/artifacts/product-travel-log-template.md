---
title: Product Travel Log
artifact_type: product-travel-log
change:
release:
review_period:
next_review:
decision: unknown
confidence: low
created_at:
summary: A travel log report drafted from mole context for human review.
tags: [travel-log, outcome-review]
source_refs: []
---

# Product Travel Log

Label each statement as a **fact**, an **observation**, an **interpretation**,
or an **assumption**. Where there is no evidence, write `unknown` and say what
is needed. Do not leave a section empty.

Fill these links before submitting the report. Use stable change/release IDs,
or `null` if unknown. Reference arrays contain registered source IDs also
cited on the lifecycle submission. Empty arrays mean no linked source yet.

```mole-learning
{
  "schema_version": 1,
  "change_id": null,
  "release_id": null,
  "intent_refs": [],
  "evidence_refs": []
}
```

## Change and release

The change or release under review, its date, and where it is recorded. For a
release with several changes, list each one.

## Original intent

What the change was meant to achieve, from the intent record, spec, decision,
or roadmap entry. If none exists, write "No intent record found".

## What shipped

What the release artefact says shipped, in its own terms. One entry per
change.

## Expected outcome

The outcome that was expected, and the measure that would show it. Write
`unknown` if none was stated before the release.

## Evidence before and after

| Measure or signal | Before | After | Period | Source |
|---|---|---|---|---|
| | | | | |

Quantitative and qualitative evidence, with the date range of each. Say when
the period after the change is too short to read.

## Unexpected effects

Effects nobody planned for, good or bad. Write `none observed` or `unknown`.

## Interpretation and confidence

What the evidence can and cannot support. Name anything else that could
explain a movement: other releases, seasonality, campaigns, sample size. State
the confidence as high, medium, or low, and why.

## What we learned

Learnings for a person to accept or reject. A learning is not durable context
until this report is approved.

## Decision

One per change: `continue`, `iterate`, `stop`, `investigate`, or `unknown`,
with the reason. Set `decision` in the frontmatter to the same value, or to
`mixed` when the changes differ. Set `confidence` to the lowest confidence
of any change.

## Recommended next action

The next step, who would take it, and any change to existing context that a
person should approve. Do not make that change yourself.

## Unresolved questions

Questions the evidence could not answer, and the date of the next review.

## Sources and evidence gaps

```yaml
source_refs: []
```

Add one entry for each registered source used by the report. `source_id` is
required. An optional `path` is a display hint and does not replace the ID.

List what was missing: no intent record, no analytics, no qualitative signal,
or a period too short to judge.

## Retrieval receipt

List the Mole files read to produce this report, and the review state of each.
