# Mole

Mole is a portable, local-first context operating system for product managers and AI assistants.

It gives teams a file-based place to capture messy product inputs, distil them into structured evidence, and generate better roadmaps, specs, decisions, and prioritisation work from shared context. Mole is designed to work locally, in synced folders such as SharePoint/OneDrive or Google Drive, or alongside a codebase in Git.

---

## Installation

### 1. Install from GitHub

```bash
npm install -g github:simplybenuk/product-mole#main
mole --help
```

This installs the `mole` command globally from the `main` branch.

### 2. Create a Mole workspace

```bash
mole new my-mole
cd my-mole
```

This creates a starter workspace with bootstrap guidance, summaries, indexes, an inbox, governance files, and templates. You do not need to clone the Mole repository to create or use a workspace.

### 3. Install Codex prompt commands

Install the optional Codex slash-command prompts:

```bash
mole install codex
```

This copies prompt files into `~/.codex/prompts/`, or `$CODEX_HOME/prompts/` when `CODEX_HOME` is set. The installer prints the Mole mascot and lists the installed slash commands.

### 4. Try the CLI

```bash
mole doctor
mole insight "Users trust CSV export more than dashboard totals"
mole create roadmap
```

### 5. Try the Codex commands

After installing prompts, use these in Codex chat:

- `/mole-insight Users trust CSV export more than dashboard totals`
- `/mole-synthesise-inbox`
- `/mole-create-roadmap`
- `/mole-create-spec`
- `/mole-review-input-queue`
- `/mole-critique`

## Commands

| Command | What it does |
| --- | --- |
| `mole --help` | Prints CLI usage, examples, and supported commands. |
| `mole new <workspace-name>` | Creates a new Mole workspace from the bundled scaffold. |
| `mole init [target-dir]` | Backwards-compatible alias for `mole new`. |
| `mole install codex` | Installs Mole Codex prompt commands into `~/.codex/prompts/` or `$CODEX_HOME/prompts/`. |
| `mole doctor` | Checks source and instance versions plus required instance folders. |
| `mole check-updates` | Reports whether the installed Mole source is newer than the current workspace. |
| `mole insight "<text>"` | Captures a raw insight into `6-raw/inbox/quick-notes/`. |
| `mole create roadmap [output-path]` | Creates a roadmap draft from the roadmap template. |
| `mole create spec [output-path]` | Creates a product spec draft from the spec template. |
| `mole create decision-brief [output-path]` | Creates a decision brief draft. |
| `mole create strategy-memo [output-path]` | Creates a strategy memo draft. |
| `mole create prioritisation-draft [output-path]` | Creates a prioritisation draft. |
| `mole synthesise <target>` | Prints an agent instruction for synthesising a target using the Mole operating model. |
| `mole review <target>` | Prints an agent instruction for reviewing a target and surfacing next actions. |
| `mole inbox claim [processor]` | Claims inbox processing with a lightweight file lock. |
| `mole inbox complete [summary]` | Writes a processing receipt and releases the inbox lock. |
| `mole upgrade` | Points to the conservative manual upgrade docs. |

## How Mole Works

Mole is a file-based context system with progressive layers.

- Top layers are small, high-signal, and cheap to read.
- Lower layers are richer, more detailed, and more expensive.
- Agents should descend only as needed.

The core operating principle is:

**Capture low -> Distil up -> Retrieve top-down -> Create**

Humans capture quickly, agents structure and synthesise, humans review and steer, and outputs are generated from layered context instead of from a blank prompt.

## Updating after new changes

Mole separates the installed tool from generated working instances.

When the source/tool changes, update the global install:

```bash
npm install -g github:simplybenuk/product-mole#main
mole install codex
```

Why both?
- `npm install -g ...` refreshes the CLI, bundled scaffold, docs, and prompt files
- `mole install codex` refreshes the prompt files in Codex so new commands and updates actually appear

Then reopen or retry in Codex if needed.

To inspect a working instance before upgrading it, run these from inside the workspace folder:

```bash
mole doctor
mole check-updates
```

`doctor` reports:
- source version from `VERSION`
- instance version from `mole.instance.yaml`
- core folder checks
- a warning when instance metadata is missing

`check-updates` is currently a read-only report. It compares source and instance versions, then lists:
- safe additions from `upgrade-ownership.json`
- manual review paths that may contain local customisation

`mole upgrade` is still intentionally conservative. For now it points to the upgrade docs rather than applying automatic file changes.

## What currently works

### Raw inbox flow
You can still drop files manually into:
- `6-raw/inbox/`

That remains a first-class workflow.

### Command capture flow
You can also capture through commands:
- `mole insight "..."`
- `/mole-insight ...` in Codex after prompt install

### Creation flow
You can create draft artifacts such as:
- roadmap
- spec
- decision brief
- strategy memo
- prioritisation draft

## Current prototype status

This is early but usable.

What exists now:
- file-native mole structure
- CLI scaffold
- Codex prompt installation
- source/instance version checks
- read-only update report using `upgrade-ownership.json`
- raw insight capture
- draft artifact generation
- docs for upgrade/adoption/command UX

What is still lightweight:
- synthesis logic is instruction-driven rather than deeply automated
- command set is intentionally small
- naming/brand may still evolve

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
