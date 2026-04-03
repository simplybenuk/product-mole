# Migration Prompt Pack — Existing Tools → Mole

Use these prompts in ChatGPT/Claude/Gemini (or other assistants) to export existing context into this repository quickly.

> Tip: run prompts in batches by domain (strategy, users, product, etc.) and copy outputs into the referenced files.

---

## 0) Global instructions (paste once per session)

```text
You are helping me migrate product context into a Mole repository.

Output requirements:
- Be concise, structured, and factual.
- Use UK English.
- Include confidence level (high/medium/low) for major claims.
- Flag unknowns and conflicts.
- Prefer synthesis over long verbatim dumps.
- Do not invent facts.

Formatting requirements:
- If I ask for markdown frontmatter, include it exactly.
- If I provide a target file path, format output so I can paste directly.
```

---

## 1) Project export → Layer 2 summary

Use this to extract high-signal summaries from existing project context.

```text
I’m migrating product context into a new repo.
Please create a concise summary suitable for this target file:

TARGET FILE: 2-summaries/<domain>-summary.md
DOMAIN: <strategy|user|product|market|technical|compliance>

Sources to use:
- <paste project notes/chat exports/doc links>

Output format:
---
title: <domain summary>
layer: 2
owner: <owner>
last_updated: <today YYYY-MM-DD>
confidence: <high|medium|low>
status: active
tags: [<tags>]
summary: <one-line summary>
---

# <Domain> Summary

## Current state
## What changed recently
## Key constraints
## Open questions
## What to read next

Also include at end:
- Conflicts detected
- Unknowns needing human input
```

---

## 2) Existing docs/chat logs → Layer 3 index rows

Use this to generate index-ready rows quickly.

```text
From the source content below, generate rows for this index table:

TARGET FILE: 3-indexes/<index-name>.md
INDEX TYPE: <decisions|problems|experiments|product|artefacts>

Source content:
<paste notes/docs/chat snippets>

Output only markdown table rows (no preamble), using this schema:
| Topic | Summary | File | Last updated | Confidence | Owner |

Rules:
- Keep summaries short (<= 14 words).
- Suggest sensible file paths under 4-context/ or 5-evidence/.
- Use YYYY-MM-DD for dates where inferable, else "TBD".
- Confidence must be high/medium/low.
```

---

## 3) Mixed raw notes → Evidence cluster

Use this when you have lots of messy snippets.

```text
Cluster these raw notes into evidence themes for:
TARGET FILE: 5-evidence/signal-clusters/<slug>.md

Raw notes:
<paste mixed snippets>

Output format:
---
title: <cluster title>
layer: 5
owner: <owner>
last_updated: <today YYYY-MM-DD>
confidence: <high|medium|low>
status: active
tags: [signals, cluster]
summary: <one-line summary>
---

# <Cluster Title>

## Signals observed
## Frequency / reinforcement
## Potential implications
## Counter-signals
## Recommended validations
## Candidate promotions to 4-context

At end include:
- "Promote now" candidates (bullet list)
- "Wait for more evidence" candidates (bullet list)
```

---

## 4) Decisions extraction prompt

```text
Extract explicit product decisions from this content and format each as a decision doc.

Target folder: 4-context/decisions/

Source content:
<paste meeting notes, chats, docs>

For each clear decision, output:
1) suggested filename: YYYY-MM-DD-<slug>.md
2) markdown content using:
---
title: <decision title>
layer: 4
owner: <owner>
last_updated: <today YYYY-MM-DD>
confidence: <high|medium|low>
status: active
tags: [decision]
summary: <what was decided>
---

# Decision: <title>
## Decision
## Context
## Alternatives considered
## Consequences
## Follow-up actions

If a decision is ambiguous, put it under "Needs human confirmation".
```

---

## 5) Human-input gap finder (for input queue)

```text
Review the context below and identify the top missing human-only inputs required to proceed.

Output target: governance/input-queue.md

Context:
<paste summaries/indexes/context snippets>

Return top 3 requests in a table with columns:
| Priority | Request | Why this matters | Quick input format | Effort | Due | Status |

Rules:
- Ask only for inputs a human must provide.
- Keep each ask answerable in 1-5 minutes where possible.
- Prioritise by impact on near-term outputs.
```

---

## 6) ChatGPT project memory → Inbox importer

Use this to turn existing project memory into quick-capture files.

```text
Convert this project memory into discrete inbox entries for Mole.

Target folders:
- 6-raw/inbox/messages/
- 6-raw/inbox/quick-notes/
- 6-raw/inbox/observations/

Source memory:
<paste>

Output as a list of markdown file blocks. For each block include:
- suggested filename: YYYY-MM-DD-<short-slug>.md
- frontmatter:
  - date
  - source (ceo|customer|sales|support|self|other)
  - channel
  - topic_tags
  - confidence
- short note body (max 6 lines)

Split into multiple small entries rather than one long document.
```

---

## 7) Final migration sanity-check prompt

```text
I am about to paste migrated outputs into a Mole repo.
Please review for quality risks.

Checklist:
1. Any invented claims?
2. Any contradictions not flagged?
3. Any overly long sections that should be split?
4. Missing metadata/frontmatter fields?
5. Missing explicit unknowns or assumptions?

Return:
- PASS/FAIL
- top 5 fixes (if any)
- a corrected version of the highest-risk section
```

---

## Recommended migration sequence

1. Export Layer 2 summaries first.
2. Generate Layer 3 indexes.
3. Build key Layer 4 context/decision docs.
4. Cluster leftover notes into Layer 5 evidence.
5. Dump remaining fragments into Layer 6 inbox.
6. Run human-input gap finder to populate `governance/input-queue.md`.
