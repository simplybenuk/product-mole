# CLI Prototype

This is an early prototype command surface for Product Context Cascade.

Current goal:
- define the future command vocabulary,
- make the project feel operable,
- install usable Codex prompt commands,
- avoid overbuilding before the workflow model is proven.

## Try locally

```bash
node cli/cascade.mjs --help
node cli/cascade.mjs init my-cascade
node cli/cascade.mjs install codex
node cli/cascade.mjs doctor
node cli/cascade.mjs create roadmap
node cli/cascade.mjs create spec
node cli/cascade.mjs insight "Users trust CSV export more than dashboard totals"
node cli/cascade.mjs synthesise inbox
```

## Current status

This is intentionally thin.
It does not run an AI backend yet.
It exists to establish:
- root command: `cascade`
- command groups: `create`, `synthesise`, `review`, `init`, `check-updates`, `upgrade`

A future packaged version could expose the same command surface via npm.
