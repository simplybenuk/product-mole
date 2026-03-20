# Contribution Guide

## Content operating rules

1. Capture first in `6-raw/inbox/` when speed matters.
2. Promote weak-signal batches into `5-evidence/signal-clusters/`.
3. Promote substantive artefacts such as PDFs, spreadsheets, decks, exports, and transcripts into `5-evidence/source-docs/` before creating context modules.
4. Promote only validated patterns or durable syntheses into `4-context/`.
5. After adding evidence/context, update relevant indexes and summaries.
6. Only remove an inbox file after a retrieval receipt exists and the content has been promoted or archived.
7. Keep docs focused (avoid giant omnibus files).
8. Keep `governance/input-queue.md` current for human asks.

## Template change control rules

1. Do not push directly to `main`.
2. Create a branch per change (e.g. `feat/...`, `docs/...`, `fix/...`).
3. Open PR and merge after review.
4. Tag stable template releases (`v0.1`, `v0.2`, ...).
5. Document notable structural changes in PR description and changelog.

See also: [docs/template-update-guide.md](../docs/template-update-guide.md)
