# CLI Prototype

This is an early prototype command surface for Mole.

Current goal:
- define the future command vocabulary,
- make the project feel operable,
- install usable Codex prompt commands,
- avoid overbuilding before the workflow model is proven.

## Try locally

```bash
node cli/mole.mjs --help
node cli/mole.mjs init my-mole
node cli/mole.mjs install codex
node cli/mole.mjs doctor
node cli/mole.mjs create roadmap
node cli/mole.mjs create spec
node cli/mole.mjs insight "Users trust CSV export more than dashboard totals"
node cli/mole.mjs synthesise inbox
```

## Current status

This is intentionally thin.
It does not run an AI backend yet.
It exists to establish:
- root command: `mole`
- command groups: `create`, `synthesise`, `review`, `init`, `check-updates`, `upgrade`

A future packaged version could expose the same command surface via npm.
