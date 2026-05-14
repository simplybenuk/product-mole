# Mole

Mole is a portable, local-first context operating system for product managers and AI assistants.

It gives teams a file-based place to capture messy product inputs, distil them into structured evidence, and generate better roadmaps, specs, decisions, and prioritisation work from shared context. Mole is designed to work locally, in synced folders such as SharePoint/OneDrive or Google Drive, or alongside a codebase in Git.

---

## Installation

### Install from GitHub

```bash
npm install -g github:simplybenuk/product-mole#main
mole --help
```

This installs the `mole` command globally from the `main` branch.

### 1. Clone the repo

```bash
git clone git@github.com:simplybenuk/product-mole.git
cd product-mole
```

### 2. Create a Mole instance

```bash
node cli/mole.mjs init my-mole
cd my-mole
```

This creates a starter instance with bootstrap guidance, summaries, indexes, an inbox, governance files, and templates.

### 3. Install Codex prompt commands

From the source/tool repo root, install the Codex slash-command prompts:

```bash
cd ..
node cli/mole.mjs install codex
```

This copies prompt files into `~/.codex/prompts/`, or `$CODEX_HOME/prompts/` when `CODEX_HOME` is set. The installer prints the Mole mascot and lists the installed slash commands.

### 4. Try the CLI

```bash
cd my-mole
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
| `node cli/mole.mjs --help` | Prints CLI usage, examples, and supported commands. |
| `node cli/mole.mjs init [target-dir]` | Creates a new Mole working instance from the repo scaffold. |
| `node cli/mole.mjs install codex` | Installs Mole Codex prompt commands into `~/.codex/prompts/` or `$CODEX_HOME/prompts/`. |
| `node cli/mole.mjs doctor` | Checks source and instance versions plus required instance folders. |
| `node cli/mole.mjs check-updates` | Reports whether the source repo is newer than the current instance. |
| `node cli/mole.mjs insight "<text>"` | Captures a raw insight into `6-raw/inbox/quick-notes/`. |
| `node cli/mole.mjs create roadmap [output-path]` | Creates a roadmap draft from the roadmap template. |
| `node cli/mole.mjs create spec [output-path]` | Creates a product spec draft from the spec template. |
| `node cli/mole.mjs create decision-brief [output-path]` | Creates a decision brief draft. |
| `node cli/mole.mjs create strategy-memo [output-path]` | Creates a strategy memo draft. |
| `node cli/mole.mjs create prioritisation-draft [output-path]` | Creates a prioritisation draft. |
| `node cli/mole.mjs synthesise <target>` | Prints an agent instruction for synthesising a target using the Mole operating model. |
| `node cli/mole.mjs review <target>` | Prints an agent instruction for reviewing a target and surfacing next actions. |
| `node cli/mole.mjs inbox claim [processor]` | Claims inbox processing with a lightweight file lock. |
| `node cli/mole.mjs inbox complete [summary]` | Writes a processing receipt and releases the inbox lock. |
| `node cli/mole.mjs upgrade` | Points to the conservative manual upgrade docs. |

## How Mole Works

Mole is a file-based context system with progressive layers.

- Top layers are small, high-signal, and cheap to read.
- Lower layers are richer, more detailed, and more expensive.
- Agents should descend only as needed.

The core operating principle is:

**Capture low -> Distil up -> Retrieve top-down -> Create**

Humans capture quickly, agents structure and synthesise, humans review and steer, and outputs are generated from layered context instead of from a blank prompt.

## Updating after new changes

Mole separates the source/tool repo from generated working instances.

When the source/tool repo changes, do this from the `product-mole` folder:

```bash
git pull
node cli/mole.mjs install codex
```

Why both?
- `git pull` gets the latest CLI/docs/prompt changes
- `install codex` refreshes the prompt files in Codex so new commands and updates actually appear

Then reopen or retry in Codex if needed.

To inspect a working instance before upgrading it, run these from inside the instance folder using the source repo CLI:

```bash
node ../cli/mole.mjs doctor
node ../cli/mole.mjs check-updates
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
