# Product Context Cascade

A portable, local-first context operating system for product managers and AI assistants.

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

It is intended to be reusable across teams and companies, which means it needs an honest upgrade story — not just a one-time template copy.

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
   - "Process this PDF and promote the useful context"
   - "What inputs do you need from me today?"
5. Review and promote outputs into `5-evidence/` then `4-context/`.
6. Start thinking in outcome commands such as:
   - `cascade insight "Users trust CSV export more than dashboard totals"`
   - `cascade create roadmap`
   - `cascade create spec`
   - `cascade synthesise inbox`

---

## How to use day-to-day

### 1) Capture fast
Drop notes, snippets, comments, and source artefacts into `6-raw/inbox/`.

### 2) Distil with agent help
Batch synthesize weak signals into `5-evidence/signal-clusters/` and promote substantive artefacts into `5-evidence/source-docs/`.

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
- `5-evidence/` — clustered evidence, source docs, and validation material
- `6-raw/` — inbox + raw captures/archive
- `templates/` — reusable templates
- `governance/` — quality, queue, receipts
- `docs/` — operating guides and UX specs

---

## Core operating principle

**Capture low → Distil up → Retrieve top-down → Create**

- Humans capture quickly.
- Agents structure/synthesise.
- Humans review and steer.
- Outputs are generated from the layered context, not from a blank prompt.

---

## Where to read next

- Human/agent collaboration:
  - [docs/human-in-the-loop-operating-model.md](docs/human-in-the-loop-operating-model.md)
- Daily input ritual:
  - [docs/monday-input-brief-workflow.md](docs/monday-input-brief-workflow.md)
- Scratchpad signal workflow:
  - [docs/signal-inbox-workflow.md](docs/signal-inbox-workflow.md)
- Local UI concept:
  - [docs/ui-spec-v1.md](docs/ui-spec-v1.md)
- Migration prompt pack (existing tools → cascade):
  - [docs/migration-prompt-pack.md](docs/migration-prompt-pack.md)
- Upgrade and instance management:
  - [docs/upgrade-and-instance-management.md](docs/upgrade-and-instance-management.md)
- Template update guide (upstream → local instance):
  - [docs/template-update-guide.md](docs/template-update-guide.md)
- CLI and command surface:
  - [docs/cli-and-command-surface.md](docs/cli-and-command-surface.md)
- Open-source product direction:
  - [docs/vision/open-source-product-direction.md](docs/vision/open-source-product-direction.md)
- Full architecture/design doc (previous README):
  - [docs/architecture-and-design.md](docs/architecture-and-design.md)
- Release discipline:
  - [docs/release-checklist.md](docs/release-checklist.md)
- CLI prototype:
  - [cli/README.md](cli/README.md)

---

## Command surface (early prototype)

A lightweight CLI prototype now exists to establish the product vocabulary:

```bash
node cli/cascade.mjs --help
node cli/cascade.mjs init my-cascade
node cli/cascade.mjs install codex
node cli/cascade.mjs doctor
node cli/cascade.mjs insight "Users trust CSV export more than dashboard totals"
node cli/cascade.mjs create roadmap
node cli/cascade.mjs create spec
```

Current purpose:
- make the tool feel operable,
- create draft artifacts from templates,
- establish the long-term `cascade` command surface.

See:
- [cli/README.md](cli/README.md)
- [docs/cli-and-command-surface.md](docs/cli-and-command-surface.md)

## Local UI (v0 scaffold)

A minimal local HTML UI is included for immediate testing:

- start server: `node ui/server.mjs`
- open: `http://localhost:4173`
- guide: [ui/README.md](ui/README.md)

Current v0 features:
- Quick Capture form (writes to `6-raw/inbox/`)
- Waiting on Human queue viewer
- Basic repo explorer

## Suggested Monday opener

Ask:

> What inputs do you need from me today?

Then answer the top 3 asks in `governance/input-queue.md`.
