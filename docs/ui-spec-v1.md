# Product Context Cascade — Local UI Spec (v1)

## Purpose

Define a lightweight, local-first web interface that makes the Product Context Cascade easy for humans to use while preserving file-based interoperability for agents.

---

## Product goals

1. **Human usability:** PMs can operate the system without living in markdown folders.
2. **Agent interoperability:** the repository remains the canonical source for all context.
3. **Low setup:** runs locally with minimal dependencies.
4. **Progressive workflow:** supports capture → distil → review → consume.

---

## Non-goals (v1)

- Enterprise auth/permissions
- Multi-tenant hosting
- Full workflow automation/pipelines
- Mandatory external integrations

---

## Core principles

- **Repo files are source of truth** (markdown/yaml/csv/json as needed).
- **UI is a layer, not a database replacement.**
- **Agent-friendly by default:** outputs remain directly readable by coding agents.
- **Export/publish is optional, not required.**

---

## User roles (v1)

- **Primary:** Product manager
- **Secondary:** Engineer/tech lead reviewing context outputs
- **System actor:** Agent/assistant performing transformations and drafting

---

## Information architecture

### Main navigation (default)

1. **Dashboard**
2. **Configure** (Mode A)
3. **Capture** (Mode B)
4. **Generate** (Mode C)
5. **Review** (Mode D)
6. **Repo Explorer**
7. **Run Log / Receipts**

### Feature-flagged navigation (optional)

8. **Publish/Export** (Mode E, disabled by default)

---

## Mode definitions

## Mode A — Configure

### Objective
Set and maintain high-signal foundational inputs.

### Inputs
- Company/product vision
- Strategic goals
- Guardrails/constraints
- Glossary/terms
- Confidence/staleness policy settings

### Output targets
- `0-bootstrap/*`
- `1-routing/*`
- selected `2-summaries/*` seeds

### UX elements
- Structured form cards
- "Last updated" indicators
- Save + diff preview

---

## Mode B — Capture

### Objective
Fast ingestion of raw inputs and micro-signals with minimal friction.

### Inputs
- free text notes
- quick messages (e.g. CEO/customer snippets)
- passing observations
- transcript files
- support exports
- links and attachments

### Output targets
- `6-raw/inbox/*` for fast scratchpad capture
- `6-raw/*` for larger raw artefacts

### UX elements
- Quick capture text box (primary)
- One-click source chips (CEO, customer, sales, support, self)
- Drag-and-drop uploader
- Minimal tagging (source/date/topic)
- "Filed to inbox" confirmation
- Optional “promote now” action to request immediate synthesis

---

## Mode C — Generate

### Objective
Create structured artefacts from existing context.

### Typical actions
- raw → evidence summary
- evidence → context module
- context/indexes → PRD draft
- context/indexes → prioritisation memo

### Output targets
- `5-evidence/*`
- `4-context/*`
- `3-indexes/*` (updates)
- `2-summaries/*` (refreshes)

### UX elements
- Task type selector
- Required input checklist
- Depth budget selector (auto from routing)
- Generated draft preview

---

## Mode D — Review

### Objective
Human approval/edit/promote loop.

### Actions
- accept/reject/edit draft
- promote content to higher layer
- resolve conflicts
- adjust confidence level

### UX elements
- Side-by-side diff
- Metadata editor
- "Promote" action buttons
- Conflict warning banners

---

## Mode E — Publish/Export (Future extension, feature-flagged)

### Objective
Send outputs to external tools only when explicitly needed.

### Product decision
Mode E is **out of MVP scope** and **disabled by default**.

Default recommendation:
- keep outputs in cascade files,
- allow coding agents to consume directly from the repository,
- add export adapters later only if workflow demands it.

### Possible future targets
- GitHub Issues
- Jira
- Notion/Confluence
- Slack summaries

---

## Dashboard (v1)

### Widgets
- Layer health summary (0–6)
- Stale files count
- Missing metadata count
- Recent generated outputs
- Pending review queue
- **Waiting on Human** queue (top 3 asks from `governance/input-queue.md`)
- Recent receipts

### Health signals
- Green: healthy/fresh
- Amber: stale or low confidence
- Red: missing required top-layer docs

---

## Repo Explorer (human-friendly)

### Capabilities
- Browse by layer and domain
- Filter by tag, owner, confidence, freshness
- Open markdown with rendered preview + raw toggle

---

## Run Log / Retrieval receipts

### Purpose
Operational transparency and auditability.

Each run shows:
- task requested
- files read
- deepest layer reached
- stop reason
- conflicts/uncertainties
- files written

---

## Data/file contract

- All written artefacts must remain plain files in repo.
- Layer 2+ docs include standard frontmatter.
- Index rows must include: topic, summary, file, last_updated, confidence.
- Receipts stored in a readable log location (suggested: `governance/run-receipts/`).

---

## Suggested local technical architecture (v1)

- **Frontend:** simple web app (e.g. Vite + React)
- **Backend:** local Node service for filesystem operations
- **Storage:** repository filesystem only
- **Execution:** local agent/assistant integration for generation tasks

This keeps the system portable and easy to run on local machine or synced folder.

---

## Co-located with codebase (recommended pattern)

```text
repo-root/
├── app/                      # product code
└── product-context-cascade/  # this system
```

Benefits:
- coding agents can read product context directly,
- implementation outputs can reference current decisions,
- less duplication across tools.

---

## v1 MVP scope

Include:
- Dashboard
- Configure
- Capture
- Generate
- Review
- Repo Explorer
- Run Log/Receipts

Optional/deferred (feature-flagged or post-MVP):
- Publish/Export mode (Mode E)
- Publish/Export adapters
- Advanced automation
- Hosted multi-user auth model

---

## Open decisions

1. Frontmatter format strictness (required vs optional fields)
2. Receipt storage path and retention
3. Conflict resolution UI behaviour
4. Feature flag mechanism for Mode E (env flag vs config file)
5. Local packaging method (scripted install vs container)

---

## Success criteria

- PM can capture new input in <60 seconds.
- Agent can produce a usable draft PRD without reading raw files by default.
- Review/promote flow updates relevant index and summary in one guided action.
- Coding agent can consume approved context artefacts directly from repo files.
