---
name: mole-refresh-top-layers
description: Refresh Mole summaries and indexes from lower-layer context, especially when they are blank, stale, or incomplete.
---

# Mole Refresh Top Layers

Use this skill inside a Mole instance when `2-summaries/` or `3-indexes/` are blank, stale, incomplete, or out of sync with lower-layer context.

## Goal

Keep the top retrieval layers accurate enough that future work can start top-down instead of repeatedly rereading raw material.

## Workflow

1. Read `0-bootstrap/`, `1-routing/`, current `2-summaries/`, and current `3-indexes/`.
2. Compare the top layers with durable context in `4-context/`, evidence in `5-evidence/`, recent processed inbox outputs, and relevant unprocessed `6-raw/inbox/` material.
3. Update blank, placeholder, stale, or incomplete summary files so they reflect the current reusable product context.
4. Update indexes so they route to the right decisions, artefacts, problems, experiments, context modules, source docs, and evidence files.
5. Keep top-layer content compressed. Do not copy raw detail upward when a link and short summary are enough.
6. Add missing human questions to `governance/input-queue.md` where evidence conflicts or important facts are absent.
7. Report which files changed, which lower-layer sources justified the refresh, and which top-layer gaps remain.

Use this after first-time bootstrap, after a large inbox synthesis pass, or as a weekly maintenance check.
