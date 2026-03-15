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

## Template-first usage (for product managers)

This repository is intended as a **portable template** that a PM can copy to:
- local machine,
- OneDrive/Google Drive,
- or a Git repo.

The default behaviour should be low-friction:
1. PM captures inputs quickly.
2. Agent/assistant structures and promotes them.
3. PM reviews and approves key outputs.

### Day-to-day operating pattern

Most PM input will naturally start as messy micro-signals. That is expected.

**Capture low → Distil up → Retrieve top-down**

1. Capture quickly into a scratchpad inbox (`6-raw/inbox/`).
2. Promote inbox batches into Layer 5 (`5-evidence/`) as clustered summaries.
3. Distil into Layer 4 (`4-context/`) topic modules.
4. Update Layer 3 indexes (`3-indexes/`).
5. Refresh Layer 2 summaries (`2-summaries/`).

This keeps the top layers high-signal so future agent tasks remain cheap.

### Human vs agent responsibilities

**PM (human):**
- capture notes/exports/interviews/micro-signals quickly
- request outputs (PRDs, prioritisation, strategy notes)
- review and correct important summaries/decisions

**Agent/assistant:**
- transform inbox/raw notes into evidence summaries
- extract themes, weak signals, constraints, and opportunities
- maintain indexes and summaries
- produce retrieval receipts with each substantive output

Goal: avoid turning the template into documentation overhead.

### Micro-signal capture (scratchpad first)

Examples of valid capture inputs:
- quick CEO messages
- passing user comments
- sales anecdotes
- support oddities
- personal PM thoughts/instincts

Individually these may be weak signals. In aggregate they are high-value product context.

See workflow: [`docs/signal-inbox-workflow.md`](docs/signal-inbox-workflow.md)

### Human input queue (what the agent needs from the PM)

The agent should explicitly request missing human-only inputs.

Use a standing queue at:
- [`governance/input-queue.md`](governance/input-queue.md)

Use this daily opener:
- "What inputs do you need from me today?"

Workflow docs:
- [`docs/monday-input-brief-workflow.md`](docs/monday-input-brief-workflow.md)
- [`docs/human-in-the-loop-operating-model.md`](docs/human-in-the-loop-operating-model.md)

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
│   ├── inbox/
│   │   ├── quick-notes/
│   │   ├── messages/
│   │   └── observations/
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
    ├── input-queue.md
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

## Human UX layer (local interface concept)

To make this usable beyond markdown-native users, pair the repo with a lightweight local web UI.

### Design intent

- Keep **files as source of truth** (agent-friendly)
- Add a **human control panel** (PM-friendly)
- Run locally with minimal setup

### Proposed v1 UX modes

- **Mode A — Configure:** set company vision, goals, constraints, terminology
- **Mode B — Capture:** quickly add raw notes, transcripts, exports
- **Mode C — Generate:** ask agent to produce summaries/PRDs/prioritisation docs
- **Mode D — Review:** approve, edit, and promote outputs up the cascade
- **Mode E — Publish/Export (optional):** push outputs to external tools when needed

**Important:** Mode E is optional by design. Teams can skip it entirely and keep outputs inside this repository for coding agents to consume directly.

### Recommended default

Default to **no export dependency**:
- keep strategy, decisions, PRDs, and implementation-ready artefacts in the cascade;
- let coding agents consume these files directly from the same repo/workspace.

Add external publish/export only if a team has mandatory downstream systems.

See detailed UI proposal: [`docs/ui-spec-v1.md`](docs/ui-spec-v1.md)

---

## Immediate next step

Review this README plan, comment, and iterate.
Once approved, implementation begins with Phase 1 scaffold.
