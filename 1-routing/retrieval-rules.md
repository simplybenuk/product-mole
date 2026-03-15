# Retrieval Rules

## Stop at sufficiency
Stop descending when:
- constraints are clear,
- latest relevant decisions are known,
- domain context is sufficient,
- no unresolved critical conflict remains.

## Conflict precedence
Prefer newer sources in this order:
1. decisions (latest),
2. context modules,
3. summaries,
4. archive/raw.

## Missing input protocol
If essential context is unavailable, request it via `governance/input-queue.md`.
