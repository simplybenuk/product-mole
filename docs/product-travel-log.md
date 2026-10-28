# Product travel log

A roadmap records where the product meant to go. A travel log records what
was tried, what happened, what was learned, and what decision follows.

The travel log report is an outcome review of one change or release. An agent
drafts it with the `mole-product-travel-log` skill. A person reviews it.

## Write a report

```bash
mole install skills                       # once, to install the skill
mole travel-log "release 2026.09"         # prints the instruction for the agent
```

Give the printed instruction to your agent. It will:

1. create the draft with `mole create product-travel-log <output-path>`, which
   registers the file and opens a `draft` review record;
2. look for the original intent, read the release artefact, and retrieve the
   analytics and qualitative evidence from the workspace;
3. fill every section of the report;
4. submit it with `mole lifecycle submit <record_id> --actor "<agent name>"
   --actor-type agent --reason "Ready for review"`.

You then read the report and approve or reject it:

```bash
mole retrieve <record_id> --include-state pending_review
mole lifecycle approve <record_id> --actor "Your Name" --actor-type human --confirm-human \
  --reason "Matches the evidence" --source <source_id> --expect-revision 2
```

`mole create product-travel-log [output-path]` writes the draft to
`4-context/travel-log/product-travel-log-draft.md` unless you give a path. It
refuses to overwrite a file, so give each report its own path, such as
`4-context/travel-log/release-2026-09.md`.

## What the report holds

| Section | Content |
| --- | --- |
| Change and release | What is under review. A release with several changes lists each one. |
| Original intent | What the change was meant to achieve, from an intent record, spec, decision, or roadmap entry. "No intent record found" when there is none. |
| What shipped | What the release artefact says, one entry per change. |
| Expected outcome | The outcome and measure stated before the release, or `unknown`. |
| Evidence before and after | Measures and signals with their periods and sources. |
| Unexpected effects | Effects nobody planned for. |
| Interpretation and confidence | What the evidence supports, what else could explain it, and how confident the reading is. |
| What we learned | Learnings for a person to accept or reject. |
| Decision | One per change: `continue`, `iterate`, `stop`, `investigate`, or `unknown`. The frontmatter `decision` is `mixed` when the changes differ. |
| Recommended next action | The next step, and any change to existing context that a person should approve. |
| Unresolved questions | Open questions and the next review date. |
| Sources and evidence gaps | The `source_refs` used and what was missing. |
| Retrieval receipt | The files read and their review state. |

Each statement is labelled as a fact, an observation, an interpretation, or
an assumption.

## What the skill will not do

- Invent an intent, a metric, a result, or a cause. Missing evidence is
  written as `unknown` with a note of what is needed.
- Claim a metric moved because of a release when other things could explain
  it. It names them: other releases, seasonality, a campaign, a small sample.
- Say a measure was met before its period is complete. It says "on track" or
  "not yet readable". The decision is then `unknown` or `investigate`, or
  `iterate` when the next step rests on other evidence, such as a defect.
- Change existing context. The report is a new draft. Suggested changes to a
  summary, persona, or decision are listed for a person to approve.
- Approve its own report. A learning becomes durable context only when a
  person approves the report.

## It works with what you have

The skill needs a release artefact and nothing else: release notes, a
changelog, a GitHub release, or a ticket export. With only that, the report
states what shipped and writes every other gap as `unknown`.

Intent records, analytics exports, and qualitative notes make the report
useful. Put them in `5-evidence/` or `4-context/` and register them with
`mole source register <path>`, so the report can cite them by source ID. The
skill reads local files only. It does not call an analytics or release
service.

## Worked example

`examples/product-travel-log/` holds the inputs for a release with three
changes and two reports:

- `reports/travel-log-rich.md` uses an intent record, the release notes, an
  analytics export, and support signals.
- `reports/travel-log-release-notes-only.md` uses the release notes alone and
  shows how gaps are written.

## Limits

- The report is as good as the evidence in the workspace. The skill does not
  fetch data.
- Mole has no structured record for intent, release artefacts, or analytics
  evidence yet. The skill finds them as ordinary context and evidence files.
- Accepted learnings stay in the approved report. Nothing copies them into
  summaries or indexes; do that with `mole refresh top-layers`.

## Reusable change records

The [versioned change and outcome contract](change-records.md) provides source-independent JSON values, field provenance and visible intent gaps for adapters and outcome reviews. Delivery and outcome review statuses remain separate from human approval in the lifecycle ledger.

Use [local release ingestion](release-ingestion.md) to preserve a full release artifact and review unresolved intent links before writing a travel log.
