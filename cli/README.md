# Mole CLI

The Mole CLI is the lightweight command surface for creating Mole instances, capturing raw product inputs, generating draft artifacts, and installing Codex slash-command prompts.

It is intentionally thin: the CLI manages files and prompts, while synthesis and review are still agent-guided.

## Installation

Install from GitHub:

```bash
npm install -g github:simplybenuk/product-mole#main
mole new my-mole
cd my-mole
```

For local source-repo development:

```bash
node cli/mole.mjs --help
node cli/mole.mjs init my-mole
```

To install Codex prompt commands:

```bash
mole install codex
```

This copies prompt files to `~/.codex/prompts/`, or `$CODEX_HOME/prompts/` when `CODEX_HOME` is set. The installer prints the Mole mascot and lists the installed commands.

## Commands

| Command | What it does |
| --- | --- |
| `mole --help` | Prints CLI usage, examples, and supported commands. |
| `mole new <workspace-name>` | Creates a new Mole workspace from the bundled scaffold. |
| `mole init [target-dir]` | Backwards-compatible alias for `mole new`. |
| `mole install codex` | Installs Mole Codex prompt commands. |
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
