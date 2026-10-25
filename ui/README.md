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

- The server listens on `127.0.0.1` only, because it serves private
  workspace files. Set `MOLE_UI_HOST` to listen on another address, for
  example `MOLE_UI_HOST=0.0.0.0`, only on a network you trust: anyone who can
  reach the port can read the workspace and add captures.
- Requests whose `Host` header is not `localhost`, a loopback address, or
  `MOLE_UI_HOST` are refused, and `POST` requests must be `application/json`.
  This stops other websites open in your browser from reading or writing
  through the UI.
- Local filesystem is the source of truth.
- No external services required.
- This is a v0 scaffold for testing, not final UI.
