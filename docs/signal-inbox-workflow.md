# Signal Inbox Workflow (Scratchpad -> Synthesis)

## Purpose

Define how day-to-day PM inputs are captured quickly and transformed into durable product context.

This workflow is designed for reality: valuable inputs arrive as both short messy snippets and larger source artefacts.

---

## Core model

1. **Capture immediately** (low friction, low structure)
2. **Classify the input** (weak signal vs substantive artefact)
3. **Batch and synthesise** (agent clusters patterns or extracts a source doc)
4. **Promote meaningful content** (evidence/context/index/summary updates)
5. **Keep weak one-offs in raw unless reinforced**

---

## Folder conventions

```text
6-raw/
└── inbox/
    ├── quick-notes/      # PM scratch notes and thoughts
    ├── messages/         # copied snippets from CEO/customers/internal chats
    └── observations/     # passing comments and lightweight field notes
```

Optional downstream outputs:

```text
5-evidence/
├── signal-clusters/      # clustered weak-signal synthesis
└── source-docs/          # extracted and summarised high-signal artefacts

4-context/
└── (domain folders)      # promoted context modules when evidence is strong
```

---

## What belongs in the inbox

Weak signals:
- “CEO said X in Slack”
- “Customer casually mentioned Y in call”
- “Support has 3 odd tickets around Z this week”
- “I think onboarding step 2 is confusing”
- “Sales keeps mentioning concern A”

Substantive artefacts:
- vendor PDFs, decks, spreadsheets, transcripts, exports, and reports
- procurement artefacts and service descriptions
- research summaries, ticket dumps, analytics exports, and meeting packs

If in doubt: capture it.

---

## Capture template (lightweight)

Use this markdown block for quick entries:

```markdown
---
date: 2026-03-15
source: ceo            # ceo|customer|sales|support|self|other
channel: slack         # slack|email|call|meeting|chat|other
topic_tags: [onboarding, ux]
confidence: low        # low|medium|high
---

Short signal note in plain language.
Potential implication (optional).
```

Keep it short. 30-90 seconds per entry is the target.

---

## Synthesis cadence

Recommended cadence:
- **Daily light pass (5-10 min):** cluster new inbox items
- **Weekly deep pass (20-40 min):** decide promotions and update summaries/indexes

The agent should process inbox entries in batches where possible, but a single high-signal artefact can be promoted on its own.

---

## Input classification

Route new inbox items using this rule:

- **Weak signal:** short notes, comments, snippets, or observations with uncertain significance.
- **Substantive artefact:** a document or export that already contains high-signal factual content worth preserving directly.

Default outputs:

- Weak signal -> `5-evidence/signal-clusters/*.md`
- Substantive artefact -> `5-evidence/source-docs/*.md`
- Durable synthesis from either path -> `4-context/<domain>/*.md`

---

## Promotion rules

Promote inbox content upward only when one of these is true:

1. **Reinforcement:** same signal appears from multiple sources
2. **Strategic relevance:** directly affects active goals/bets
3. **Risk severity:** plausible high-impact issue
4. **Decision impact:** could change prioritisation or design choices

### Promotion path

- Inbox snippets -> `5-evidence/signal-clusters/*.md`
- Inbox artefacts -> `5-evidence/source-docs/*.md`
- Strong validated clusters or durable artefact syntheses -> `4-context/<domain>/*.md`
- Then update:
  - `3-indexes/*.md`
  - `2-summaries/*.md` (if materially changed)
  - `governance/run-receipts/*.md`

### Inbox cleanup rule

- Do not delete an inbox item until its promoted output and retrieval receipt exist.
- After promotion, either delete the inbox copy or move it into a stable raw/archive location.

---

## Anti-noise rules

- Do not promote every note.
- Prefer pattern strength over recency.
- Mark uncertain clusters clearly.
- Keep contradictory signals visible until resolved.

---

## Suggested agent outputs from inbox

- “Top emerging themes this week”
- “Signals that challenge current priorities”
- “Potential UX risks to validate next”
- “Candidate interview questions from weak signals”
- “Source doc summary with candidate promotions”

Always include retrieval receipt + confidence markers.

---

## Success criteria

- PM can capture any signal in <60 seconds.
- Inbox is synthesised at least weekly.
- High-signal artefacts are preserved as source notes before cleanup.
- Promotions are evidence-led, not anecdote-led.
- Summaries/indexes reflect validated patterns, not raw noise.
