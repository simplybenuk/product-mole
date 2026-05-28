---
name: mole-bootstrap-context
description: Populate blank or starter-template Mole summaries and indexes during first-time workspace setup or onboarding.
---

# Mole Bootstrap Context

Use this skill inside a Mole instance when the top layers are blank, mostly starter content, or too thin to support useful retrieval.

## Goal

Create the first useful `2-summaries/` and `3-indexes/` from the durable context that already exists in the workspace.

## Workflow

1. Read `0-bootstrap/` and `1-routing/` to understand the workspace purpose, layer model, and retrieval rules.
2. Inspect every file in `2-summaries/` and `3-indexes/`; treat blank, placeholder-only, or starter-template files as missing context.
3. Read all existing `4-context/` modules, useful `5-evidence/` files, and relevant unprocessed material in `6-raw/inbox/`.
4. Populate initial `2-summaries/` files with concise, evidence-backed domain context. Keep each summary compact and focused on durable facts, current product understanding, important hypotheses, and routing pointers.
5. Populate initial `3-indexes/` files with navigation entries that point to the most useful context, evidence, decisions, artefacts, experiments, problems, or source documents.
6. Add missing human questions to `governance/input-queue.md` when the lower layers do not justify a confident summary or index entry.
7. Report which summaries and indexes were populated, which source files supported them, and which areas remain too weak or unknown.

Do not invent product facts. Mark low-confidence conclusions as hypotheses and link to supporting files.
