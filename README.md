# Product Context Cascade

A repository architecture for AI agents and humans to retrieve product context progressively:
start with tiny, high-signal guidance, then descend only as needed.

---

## Why this exists

Most repos are optimised for human browsing, not agent retrieval. Agents either:
- over-read (wasting tokens), or
- under-read (missing constraints and decisions).

**Product Context Cascade** solves this with a staged context model:
1. Read a tiny mandatory layer.
2. Route by task type.
3. Descend selectively through summaries, indexes, and topic docs.
4. Stop when context is sufficient.
5. Only touch evidence/raw layers when needed.

The model is not “important at top, unimportant at bottom”.
It is:
- **top = cheap + general**
- **bottom = expensive + specific**

---

## Core principles

1. **Progressive retrieval, not blanket reading**
2. **Summaries compress lower layers**
3. **Indexes drive navigation**
4. **Explicit depth budgets per task type**
5. **Clear stop conditions (sufficiency rules)**
6. **Metadata on every substantive file**
7. **Traceable outputs (what was read + why descent stopped)**

---

## Planned repository structure

```text
product-context-cascade/
│
├── 0-bootstrap/
│   ├── agents.md
│   └── repo-purpose.md
│
├── 1-routing/
│   ├── task-types.md
│   ├── retrieval-rules.md
│   ├── depth-budgets.md
│   └── repo-map.md
│
├── 2-summaries/
│   ├── strategy-summary.md
│   ├── user-summary.md
│   ├── product-summary.md
│   ├── market-summary.md
│   ├── technical-summary.md
│   └── compliance-summary.md
│
├── 3-indexes/
│   ├── decisions-index.md
│   ├── problems-index.md
│   ├── artefacts-index.md
│   ├── experiments-index.md
│   └── product-index.md
│
├── 4-context/
│   ├── strategy/
│   ├── users/
│   ├── product/
│   ├── market/
│   ├── compliance/
│   └── decisions/
│
├── 5-evidence/
│   ├── interviews/
│   ├── support-analysis/
│   ├── analytics/
│   └── research-notes/
│
├── 6-raw/
│   ├── transcripts/
│   ├── exports/
│   ├── ticket-dumps/
│   └── old-docs/
│
├── templates/
│   ├── metadata-frontmatter.md
│   ├── context-module-template.md
│   ├── summary-template.md
│   ├── index-template.md
│   └── decision-template.md
│
└── governance/
    ├── quality-checklist.md
    ├── contribution-guide.md
    └── change-log.md
```

---

## Layer definitions

### Layer 0 — Bootstrap (always read)
Tiny mandatory guidance for all tasks.

Contains:
- what this repo is for
- global behaviour rules
- required read order
- output standard

Target size: very short (single-screen preferred).

---

### Layer 1 — Routing (always/near-always read)
Task classification and retrieval policy.

Contains:
- task-type routing map
- depth budgets
- stop conditions
- conflict resolution precedence

Purpose: decide where to go next with minimal tokens.

---

### Layer 2 — Domain summaries (selective)
Compact domain-level context; 1–2 pages each.

Purpose: get “good enough” quickly before source docs.

---

### Layer 3 — Indexes (selective, navigation-critical)
Structured pointers to deeper docs.

Each index row should include:
- topic
- short summary
- file path
- last updated
- confidence
- owner (optional but recommended)

Purpose: choose precise descent path.

---

### Layer 4 — Context modules (common stopping point)
Focused source docs by topic (not giant omnibus docs).

Examples:
- `4-context/product/permissions.md`
- `4-context/users/admin-pains.md`
- `4-context/decisions/2026-02-12-workspace-model.md`

This is where most high-quality work should stop.

---

### Layer 5 — Evidence (expensive, selective)
Evidence summaries used for validation-heavy tasks.

Prefer curated evidence over raw data:
- interview clusters
- support theme summaries
- analytics writeups

---

### Layer 6 — Raw/archive (rarely used)
Original material and legacy exports.

Access only if explicitly requested or if upper layers are insufficient.

---

## Retrieval policy (planned)

### Mandatory sequence
1. Read Layer 0.
2. Read Layer 1.
3. Identify task type.
4. Read minimum required Layer 2/3 docs.
5. Descend to Layer 4+ only if needed.
6. Stop at sufficiency.

### “Sufficient context” stop test
Stop descending when all are true:
- task constraints are clear,
- latest relevant decision(s) are known,
- one or more relevant domain summaries are covered,
- no unresolved critical conflict remains.

### Conflict resolution precedence
When sources disagree, prefer:
1. newer decision docs,
2. then context modules,
3. then summaries,
4. then older/archive material.

Always flag conflicts in output.

---

## Depth budgets by task type (initial draft)

| Task type | Typical path | Max depth |
|---|---|---|
| Quick factual answer | L0 → L1 → L2 | L2 |
| PRD/spec draft | L0 → L1 → L2 → L3 → L4 | L4 |
| Roadmap/prioritisation | L0 → L1 → L2 → L3 → L4 | L4 |
| Strategy memo | L0 → L1 → L2 → L3 → L4 | L4 |
| Validation/challenge request | L0 → L1 → L2 → L3 → L4 → L5 | L5 |
| Audit/dispute/deep trace | L0 → L1 → L2 → L3 → L4 → L5 (+L6 if required) | L6 |

---

## File metadata standard (planned)

All Layer 2+ files should include frontmatter:

```yaml
---
title: External Sharing
layer: 4
owner: Ben
last_updated: 2026-03-10
confidence: high
status: active
tags: [sharing, collaboration, permissions]
summary: How external sharing works, constraints, and open issues.
when_to_read:
  - designing sharing features
  - answering enterprise collaboration questions
skip_if:
  - working on billing
  - working on onboarding
---
```

---

## Output receipt standard (planned)

Every substantive agent output should end with a retrieval receipt:
- files read
- deepest layer reached
- why descent stopped
- known uncertainties / conflicts

This provides auditability and token discipline.

---

## Implementation plan (phased)

### Phase 1 — Scaffold (this repo setup)
- create folder tree
- create starter files + templates
- add routing matrix and retrieval rules
- add metadata/frontmatter standards

### Phase 2 — Seed context
- populate Layer 2 summaries
- create initial Layer 3 indexes
- add first Layer 4 context modules

### Phase 3 — Evidence and governance
- add Layer 5 evidence summaries
- add quality checklist + contribution guide
- define review cadence for stale/confidence drift

### Phase 4 — Agent hardening
- test retrieval flows across common task types
- tune depth budgets and stop rules
- add lightweight validation checks

---

## Out of scope (for initial build)

- full migration of all historical product documentation
- ingestion pipelines/automation
- heavy CI tooling

Initial focus is clear structure and retrieval behaviour.

---

## Open decisions to review before scaffolding

1. Confirm final folder naming (`artefacts` vs `artifacts`, etc.)
2. Confirm required domains in Layer 2/4
3. Confirm confidence scale (`high/medium/low` vs numeric)
4. Confirm staleness threshold for auto confidence decay (e.g. 60/90 days)
5. Confirm receipt format (inline vs appendix)

---

## Immediate next step

Review this README plan, comment, and iterate.
Once approved, implementation begins with Phase 1 scaffold.
