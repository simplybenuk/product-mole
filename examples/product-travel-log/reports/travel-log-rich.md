---
title: Product Travel Log - Release 2026.09
artifact_type: product-travel-log
change: CSV export for reports; onboarding checklist; pricing page copy
release: 2026.09 (2026-09-14)
review_period: 2026-08-17 to 2026-10-04
next_review: 2026-10-19
decision: iterate
confidence: medium
created_at: 2026-10-05
summary: Three-week outcome review of release 2026.09. CSV export met its ticket target; the checklist and pricing copy cannot be judged yet.
tags: [travel-log, outcome-review]
source_refs:
  - source_id: src_5b7c2d10-3e4f-4a61-8b9c-0d1e2f3a4b01
    path: 5-evidence/source-docs/release-notes-2026-09.md
    relationship: describes
  - source_id: src_1f0e9b52-6c1d-4a3e-9d2b-7a54c8e0f101
    path: 4-context/intents/intent-csv-export.md
    relationship: intent
  - source_id: src_8a6d4c3b-2f1e-4d70-9c8b-5a4e3d2c1b02
    path: 5-evidence/source-docs/analytics-export.csv
    relationship: supports
  - source_id: src_c3d2e1f0-9a8b-4c7d-8e6f-1a2b3c4d5e03
    path: 5-evidence/source-docs/support-signals.md
    relationship: supports
---

# Product Travel Log: Release 2026.09

## Change and release

- **Fact.** Release 2026.09 went to all workspaces on 2026-09-14 (release
  notes).
- **Fact.** It holds three changes reviewed here: CSV export for reports, the
  onboarding checklist, and new pricing page copy. A filter fix also shipped
  and is not reviewed.

## Original intent

- **CSV export. Fact.** The intent record says the aim was fewer export
  tickets and continued use of reports by finance and operations users. It
  expected 1 or fewer export tickets a week, and 15% of active reports
  exported weekly, after four weeks. It expected no effect on sign-ups or
  upgrades.
- **Onboarding checklist.** No intent record found.
- **Pricing page copy.** No intent record found.

## What shipped

- **CSV export. Fact.** Any report exports as CSV with the current columns
  and filters, up to 50,000 rows. Known issue: merged header cells repeat.
- **Onboarding checklist. Fact.** New workspaces see a five-step checklist on
  the home screen.
- **Pricing page copy. Fact.** The Team plan description leads with the seat
  price. No price changed.

## Expected outcome

- **CSV export. Fact.** Export tickets at 1 or fewer a week and 15% of active
  reports exported weekly, four weeks after release.
- **Onboarding checklist.** unknown. No expected outcome was stated before
  the release.
- **Pricing page copy.** unknown. No expected outcome was stated before the
  release.

## Evidence before and after

| Measure or signal | Before | After | Period | Source |
|---|---|---|---|---|
| Export-request tickets per week | 3 to 4 | 2, 1, 0 | 4 weeks before, 3 weeks after | analytics export |
| Active reports with an export | 0% | 12%, 16%, 18% | 3 weeks after | analytics export |
| Checklist completed by new workspaces | not applicable | 19 of 71, 31 of 94, 24 of 69 | 3 weeks after | analytics export |
| New workspaces per week | 55 to 63 | 71, 94, 69 | 4 weeks before, 3 weeks after | analytics export |
| Team plan upgrades per week | 8 to 11 | 12, 13, 10 | 4 weeks before, 3 weeks after | analytics export |
| Merged-header export defect | not applicable | 3 tickets | 3 weeks after | support signals |
| Requests for scheduled export | not applicable | 2 tickets | 3 weeks after | support signals |

- **Observation.** Export tickets fell each week after release and reached
  the expected level in week two.
- **Observation.** The share of active reports exported passed 15% in week
  two (71 of 436).
- **Observation.** New workspaces rose to 94 in the week of 2026-09-21 and
  fell back to 69.
- **Observation.** One operations lead said export removed a weekly
  copy-paste task and that the team still rebuilds a pivot in Excel.
- **Observation.** One founder said they ignored the checklist.
- The period after release is three weeks. The intent record set its measures
  at four weeks.

## Unexpected effects

- **Observation.** Three tickets report the merged-header defect listed under
  known issues.
- **Observation.** Two tickets ask for scheduled export and one hit the row
  limit. Neither was in the intent record.
- Onboarding checklist and pricing copy: none observed.

## Interpretation and confidence

- **CSV export. Interpretation, medium confidence.** The fall in export
  tickets and the export usage both match what the intent record expected,
  and no other change in this release touches export. One week of data is
  still missing against the four-week measure.
- **Onboarding checklist. Interpretation, low confidence.** About a third of
  new workspaces complete the checklist. There is no baseline and no stated
  target, so this cannot be called good or bad. One call suggests some users
  skip it without harm.
- **Pricing page copy. Interpretation, low confidence.** Upgrades were 12,
  13, and 10 a week against 8 to 11 before. That is inside normal variation
  for these numbers.
- **Attribution is weak for sign-ups and upgrades.** Marketing ran a paid
  campaign from 2026-09-20 to 2026-09-26, which covers the week new
  workspaces peaked. The checklist, the pricing copy, and the campaign cannot
  be separated with this data.
- **Assumption.** Ticket counts in the analytics export use the same tagging
  before and after the release.

## What we learned

For a person to accept or reject:

1. Export demand was real: usage passed the expected level within two weeks.
2. Export does not end spreadsheet work. At least one team still rebuilds a
   pivot afterwards.
3. Scheduled export is the next thing users ask for.
4. A change shipped with no stated expected outcome cannot be judged
   afterwards. Two of three changes in this release were in that position.

## Decision

- **CSV export: iterate.** It is meeting its measures. Fix the merged-header
  defect and assess scheduled export.
- **Onboarding checklist: investigate.** No target and no baseline. Decide
  what completion rate would count as working.
- **Pricing page copy: unknown.** No expected outcome, and upgrades cannot be
  separated from the campaign.

## Recommended next action

- Product: schedule the merged-header fix.
- Product: write an expected outcome for the onboarding checklist and for the
  pricing copy, so the next review can judge them.
- For a person to approve: add learning 3 to the reports roadmap context.
  This report does not change that file.

## Unresolved questions

- What completion rate should the onboarding checklist reach, and by when?
- Did the paid campaign bring the extra workspaces in the week of 2026-09-21?
  Campaign attribution data is needed.
- Does export reduce churn among finance and operations users? Needs a longer
  period.
- Next review: 2026-10-19, when the four-week measures are complete.

## Sources and evidence gaps

```yaml
source_refs:
  - source_id: src_5b7c2d10-3e4f-4a61-8b9c-0d1e2f3a4b01
  - source_id: src_1f0e9b52-6c1d-4a3e-9d2b-7a54c8e0f101
  - source_id: src_8a6d4c3b-2f1e-4d70-9c8b-5a4e3d2c1b02
  - source_id: src_c3d2e1f0-9a8b-4c7d-8e6f-1a2b3c4d5e03
```

Gaps:

- No intent record for the onboarding checklist or the pricing page copy.
- No baseline for checklist completion.
- No campaign attribution data.
- Three weeks of data against a four-week measure.

## Retrieval receipt

- `5-evidence/source-docs/release-notes-2026-09.md` (evidence)
- `4-context/intents/intent-csv-export.md` (accepted)
- `5-evidence/source-docs/analytics-export.csv` (evidence)
- `5-evidence/source-docs/support-signals.md` (evidence)
