# Local UI (v0 scaffold)

A minimal local web interface for Mole.

## What it does

- Quick capture form → writes markdown notes to `6-raw/inbox/...`
- View human input queue from `governance/input-queue.md`
- Basic repo explorer for key mole folders/files

## Run

From repo root:

```bash
node ui/server.mjs
```

Then open:

`http://localhost:4173`

## Notes

- Local filesystem is the source of truth.
- No external services required.
- This is a v0 scaffold for testing, not final UI.
