# Signal Inbox Workflow (Scratchpad → Synthesis)

## Purpose

Define how day-to-day PM micro-signals are captured quickly and transformed into durable product context.

This workflow is designed for reality: most valuable inputs arrive as short, messy snippets.

---

## Core model

1. **Capture immediately** (low friction, low structure)
2. **Batch and synthesise** (agent clusters patterns)
3. **Promote meaningful signals** (evidence/context/index/summary updates)
4. **Keep weak one-offs in raw unless reinforced**

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
└── signal-clusters/      # clustered weak-signal synthesis

4-context/
└── (domain folders)      # promoted context modules when evidence is strong
```

---

## What belongs in the inbox

- “CEO said X in Slack”
- “Customer casually mentioned Y in call”
- “Support has 3 odd tickets around Z this week”
- “I think onboarding step 2 is confusing”
- “Sales keeps mentioning concern A”

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

Keep it short. 30–90 seconds per entry is the target.

---

## Synthesis cadence

Recommended cadence:
- **Daily light pass (5–10 min):** cluster new inbox items
- **Weekly deep pass (20–40 min):** decide promotions and update summaries/indexes

The agent should process inbox entries in batches, not one-by-one.

---

## Promotion rules

Promote inbox content upward only when one of these is true:

1. **Reinforcement:** same signal appears from multiple sources
2. **Strategic relevance:** directly affects active goals/bets
3. **Risk severity:** plausible high-impact issue
4. **Decision impact:** could change prioritisation or design choices

### Promotion path

- Inbox snippets → `5-evidence/signal-clusters/*.md`
- Strong validated clusters → `4-context/<domain>/*.md`
- Then update:
  - `3-indexes/*.md`
  - `2-summaries/*.md` (if materially changed)

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

Always include retrieval receipt + confidence markers.

---

## Success criteria

- PM can capture any signal in <60 seconds.
- Inbox is synthesised at least weekly.
- Promotions are evidence-led, not anecdote-led.
- Summaries/indexes reflect validated patterns, not raw noise.
