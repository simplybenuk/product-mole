---
name: mole-product-travel-log
description: Review what a product change or release was meant to do, what shipped, what the evidence shows, and what was learned, as a travel log report for human review. Use when the user asks for a travel log, outcome review, release review, post-launch review, or "what did we learn from" a change.
---

# Mole Product Travel Log

Use this skill inside a Mole instance.

The CLI entry points are `mole travel-log <change-or-release>`, which prints an instruction for this skill, and `mole create product-travel-log [output-path]`, which creates the report draft from the template.

## Goal

Turn intent, release context, analytics, and qualitative evidence into an outcome review a person can check. A roadmap says where the product meant to go. A travel log says what was tried, what happened, what was learned, and what decision follows.

## Workflow

1. Identify the change or release under review. If the user names a release that holds several changes, list each change and review them one by one in the same report. If the subject is ambiguous, state the assumption you made.
2. Create the draft with `mole create product-travel-log [output-path]`. It registers the file and opens a draft review record. Fill the draft in place.
3. Look for the original intent: an intent record, spec, decision brief, roadmap entry, or ticket. Start from `3-indexes/` and `2-summaries/`, then descend into `4-context/`. If none exists, write "No intent record found" and do not reconstruct one from the release notes.
4. Read the full release artefact and anything it links to: release notes, changelog, GitHub release, or ticket export. Record what shipped in the artefact's own terms.
5. Retrieve the analytics evidence and the qualitative signals that cover the period before and after the change, from `5-evidence/` and, when the task calls for it, `6-raw/`. Note the date range and source of each.
6. Sort every statement into one of four kinds and label it: **fact** (in a source), **observation** (what the evidence shows), **interpretation** (what you think it means), **assumption** (taken as true without evidence).
7. Fill every section of the template. Where there is no evidence, write `unknown` and say what would be needed. An empty section is not allowed; a section that says "unknown" is.
8. Choose one decision per change: `continue`, `iterate`, `stop`, `investigate`, or `unknown`. Give the confidence and the reason.
9. Record the unresolved questions and the next review date. Add each question that needs a person with `mole input-queue add` if that command exists in this workspace, or to `governance/input-queue.md` if it does not.
10. Submit the report for review with `mole lifecycle submit <record_id>`. Stop there.

## Rules

- Do not invent an intent, a metric, a result, or a causal explanation. If the release notes are all you have, the report says so and most evidence sections read `unknown`.
- Link each material conclusion to its source by `source_id` under `source_refs`, and name the source next to the claim. A conclusion with no source is an assumption and is labelled as one.
- Say when the review is too early. If the period after the change is shorter than the metric needs, or the data has not arrived, the decision is `unknown` or `investigate`, not `continue`.
- Say when attribution is weak. Other releases, seasonality, a marketing push, or a small sample can explain a movement. Name the ones that apply. Do not write "because of this release" unless the evidence isolates it.
- A release with several changes gets one "What shipped" entry and one decision per change. Shared metrics are attributed to the release as a whole unless the evidence separates them.
- Never overwrite existing context. The report is a new draft file. If it suggests a change to a summary, persona, or decision, list that under "Recommended next action" for a person to approve.
- A learning is not durable until a person accepts the report. Do not copy learnings into `4-context/`, `2-summaries/`, or `3-indexes/` yourself, and never run `mole lifecycle approve`.
- Retrieve top-down and stop at sufficiency: indexes and summaries first, then context, then evidence, then raw material only when required. Everything stays local; do not call an external analytics or release service.

## Review state

Base claims on accepted context. `mole retrieve` lists it. If you use a draft, pending, rejected, or unreviewed file, say so next to the claim and in the retrieval receipt.

## Output

Return the path of the report, the decision for each change with its confidence, the evidence gaps, and the review record ID a person should approve or reject. End with a retrieval receipt.

A worked example with rich inputs, and one from release notes alone, is in the Mole package under `examples/product-travel-log/`.
