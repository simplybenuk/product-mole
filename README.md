# Product Context Cascade

A portable, local-first template for product managers and AI assistants.

Use it to:
- capture messy product inputs quickly,
- synthesise them into structured context,
- generate better PRDs, decisions, and prioritisation outputs.

---

## What this is

Product Context Cascade is a **file-based context system** with progressive layers.

- Top layers are small, high-signal, and cheap to read.
- Lower layers are richer, more detailed, and more expensive.
- Agents should descend only as needed.

This repository is designed to work:
- on a local machine,
- in synced folders (OneDrive/Google Drive),
- or in Git alongside your codebase.

---

## Quick start (first 10 minutes)

1. Open `0-bootstrap/repo-purpose.md` and customise for your company/product.
2. Fill `2-summaries/strategy-summary.md`, `user-summary.md`, and `product-summary.md` with lightweight starter context.
3. Start capturing raw inputs in `6-raw/inbox/`:
   - `quick-notes/`
   - `messages/`
   - `observations/`
4. Ask your agent:
   - "Synthesize inbox into evidence clusters"
   - "What inputs do you need from me today?"
5. Review and promote outputs into `5-evidence/` then `4-context/`.

---

## How to use day-to-day

### 1) Capture fast
Drop notes, snippets, comments, and thoughts into `6-raw/inbox/`.

### 2) Distil with agent help
Batch synthesize raw signals into `5-evidence/signal-clusters/`.

### 3) Promote meaningful context
Move validated patterns into focused docs in `4-context/`.

### 4) Keep navigation fresh
Update `3-indexes/` and refresh `2-summaries/` when context changes.

### 5) Run a human input loop
Use `governance/input-queue.md` for missing human-only inputs.

---

## Repo map (at a glance)

- `0-bootstrap/` — mandatory starter guidance
- `1-routing/` — task routing + retrieval rules
- `2-summaries/` — compressed domain summaries
- `3-indexes/` — pointers to deeper context
- `4-context/` — focused context modules and decisions
- `5-evidence/` — clustered evidence and validation material
- `6-raw/` — inbox + raw captures/archive
- `templates/` — reusable templates
- `governance/` — quality, queue, receipts
- `docs/` — operating guides and UX specs

---

## Core operating principle

**Capture low → Distil up → Retrieve top-down**

- Humans capture quickly.
- Agents structure/synthesise.
- Humans review and steer.

---

## Where to read next

- Human/agent collaboration:
  - `docs/human-in-the-loop-operating-model.md`
- Daily input ritual:
  - `docs/monday-input-brief-workflow.md`
- Scratchpad signal workflow:
  - `docs/signal-inbox-workflow.md`
- Local UI concept:
  - `docs/ui-spec-v1.md`
- Full architecture/design doc (previous README):
  - `docs/architecture-and-design.md`

---

## Suggested Monday opener

Ask:

> What inputs do you need from me today?

Then answer the top 3 asks in `governance/input-queue.md`.
