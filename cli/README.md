# Mole CLI

The Mole CLI is the lightweight command surface for creating Mole instances, capturing raw product inputs, generating draft artifacts, and installing Codex slash-command prompts.

It is intentionally thin: the CLI manages files and prompts, while synthesis and review are still agent-guided.

## Installation

From the repo root:

```bash
node cli/mole.mjs --help
node cli/mole.mjs init my-mole
```

## Install from GitHub

```bash
npm install -g github:simplybenuk/product-mole#main
mole --help
```

To install Codex prompt commands:

```bash
node cli/mole.mjs install codex
```

This copies prompt files to `~/.codex/prompts/`, or `$CODEX_HOME/prompts/` when `CODEX_HOME` is set. The installer prints the Mole mascot and lists the installed commands.

A future packaged version can expose the same command surface through the `mole` binary declared in `cli/package.json`.

## Commands

| Command | What it does |
| --- | --- |
| `node cli/mole.mjs --help` | Prints CLI usage, examples, and supported commands. |
| `node cli/mole.mjs init [target-dir]` | Creates a new Mole working instance from the repo scaffold. |
| `node cli/mole.mjs install codex` | Installs Mole Codex prompt commands. |
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
