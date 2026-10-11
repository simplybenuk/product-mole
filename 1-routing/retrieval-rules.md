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

## Review state
Normal retrieval uses accepted context only.
- Run `mole retrieve` to list accepted records, or `mole retrieve <record-id>` to read one.
- Treat `draft`, `pending_review`, `rejected`, `superseded`, `withdrawn`, and `unreviewed` records as unapproved. A file with no lifecycle record is unreviewed too.
- Read unapproved material only when the task asks for it, such as reviewing a draft or processing raw input. Use `--include-state <state>` and name the state in the retrieval receipt.
- If retrieval excludes an accepted record because its file changed, do not use the file. Report it and run `mole lifecycle audit`.
- When accepted and unapproved material disagree, the accepted record wins.

## Missing input protocol
If essential context is unavailable, request it with `mole input-queue add`. The table in `governance/input-queue.md` is generated from the queue.
