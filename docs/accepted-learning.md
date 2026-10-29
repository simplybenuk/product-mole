# Accepted learning

Use `mole learning` to preserve a lesson from a human-accepted travel log and
retrieve it for a roadmap, specification, decision, prioritisation or critique.
It needs local files and Node.js 18 or later. No hosted service is involved.

## Prepare the report for review

Before submitting a travel log, add exactly one fenced `mole-learning` JSON
block. All five fields are required. For example:

````markdown
```mole-learning
{
  "schema_version": 1,
  "change_id": "change-search",
  "release_id": "release-2026-09",
  "intent_refs": [],
  "evidence_refs": []
}
```

## What we learned

Observation: Search typos need a fallback. Retention impact remains unknown.
````

Only report-level metadata blocks count. Metadata and headings inside code
examples are ignored, including indented and longer-fence examples. Lesson
text is copied from the original report without removing code or qualifications.

Use the stable change and release IDs from [change records](change-records.md)
and [release ingestion](release-ingestion.md). Use `null` for an unknown ID.
`intent_refs` and `evidence_refs` contain immutable registered `src_...` IDs,
not paths. They must also be supporting sources on the report's lifecycle
record. Supply them with `--source` when submitting the report. Empty arrays
mean missing links, not proof that evidence exists. Keep the original source
links and qualifications in the report.

A person reviews the full report through the existing
[human lifecycle](review-lifecycle.md). An agent must never approve a report,
pass human actor flags, or interpret `status: active` or approval prose as a
decision. Older reports without the metadata block need revision and human
review before promotion. Promotion flags cannot supply unreviewed content.

## Promote and retrieve

After a person accepts the report:

```bash
mole learning promote <report-record-id>
mole learning list --query "fallback"
mole learning list --change-id change-search
mole learning list --release-id release-2026-09
mole learning show <learning-id>
```

Every command prints JSON. `list` is the controlled index: it scans immutable
snapshots under `4-context/learnings/` and validates each against the report's
current lifecycle approval and exact bytes. No summaries, decisions, source
reports or lifecycle records are rewritten. The saved projection is not an
independently approved artifact. Do not register or approve it separately.
Use these commands to read projections, rather than reading their files as
current context.

A learning holds the exact `What we learned` section and full original report,
including its source links. It also holds change/release links, intent and
evidence IDs, all lifecycle supporting source IDs, the report record/source
IDs, approved hash and size, and the human approval's actor, time, reason and
revision. Statement labels and uncertainty remain as the person reviewed
them. Promotion does not turn raw evidence or an agent's inference into a new
claim. `report_path` resolves the report's current location on retrieval;
source IDs remain valid navigation references when files move.

## Worked retrieval example

Suppose the accepted report above has record ID returned by `mole create`.
Run `mole learning promote` with that ID, then:

```bash
mole learning list --query "fallback" --change-id change-search
```

The `learnings` array contains one entry with `current: true`, the stable
`learning_id`, a current `report_path`, and the exact lesson:

> Observation: Search typos need a fallback. Retention impact remains unknown.

For a later roadmap review, read that lesson and its report, follow the source
IDs with `mole source resolve <source-id>`, and cite the learning ID and report
approval revision in the retrieval receipt. The lesson supports reconsidering
error recovery; it makes no claim about retention. A spec or critique can use
the same query. An empty result means no matching current promoted learning,
not evidence that the proposed feature works.

## Corrections and history

Editing an accepted report immediately removes its projections from current
results, even before anyone runs `revise`. Revise and submit the changed report
through the lifecycle, let a person decide, then promote again. The same report
source ID keeps the same learning ID. Each approval revision gets a separate
immutable snapshot. An explicit human supersession link added to an already
accepted replacement also gets a new snapshot, retaining that decision's actor,
time and revision. Moving a report creates no new projection. Repeated promotion of the same approval is a no-op.

For a separate replacement report, a person uses the lifecycle's `approve
--supersedes` flow. Its learning has its own ID and records the predecessor's
learning ID in `provenance.supersedes`. The predecessor is excluded immediately,
even if the replacement has not been promoted yet. Withdrawn, rejected, pending,
draft, missing, changed or superseded reports cannot yield current learning.

```bash
mole learning show <learning-id> --history
```

`history` entries are explicitly `current: false, verified: false`: they are
stored historical snapshots, not permission to rely on an old or manually
edited conclusion. `excluded` explains why a snapshot failed current
validation. Malformed files and symlinks fail closed. Preserve conflicting
copies for investigation; the command refuses to overwrite a snapshot.

## Retrieval receipt

This design uses the lifecycle ledger as approval authority and the source
registry as identity authority. No instance data was promoted by this guide.
