# Agents - Mole

Read order (always):
1. `0-bootstrap/agents.md`
2. `1-routing/task-types.md`
3. smallest relevant summaries/indexes
4. context modules only as needed
5. evidence/raw only when required

Rules:
- Prefer summaries before source docs.
- Respect depth budgets.
- Stop at sufficiency.
- When the inbox contains a substantive artefact such as a PDF, spreadsheet, slide deck, export, or transcript, treat it as a source document rather than a weak signal.
- Promote substantive artefacts to `5-evidence/source-docs/` first, then create `4-context/` modules only when synthesis adds durable value.
- Only route inbox snippets to `5-evidence/signal-clusters/` when the input is primarily a set of weak signals or messy notes.
- If blocked by missing human input, add a request with `mole input-queue add --request "..." --impact "..." --unblocks "..." --actor "<agent name>" --actor-type agent`. Check `mole input-queue list` first so you do not ask twice. Do not edit the table in `governance/input-queue.md`; it is generated.
- When a person answers a request, record it with `mole input-queue close <input_id> --answer "..." --outcome "..."`. Never close a request as duplicate, superseded, stale, or not needed, and never change its owner. Those are decisions for a person; report the suggestion from `mole review input-queue` instead.
- Treat direct files in `6-raw/inbox/` as the current flat drop zone. In upgraded workspaces, also treat legacy subfolders such as `quick-notes/`, `messages/`, `observations/`, and `new/` as unprocessed input.
- Before reading or promoting raw files, follow `docs/raw-inbox-privacy.md`. Run `mole privacy scan` and apply quarantine to manual imports. Never enrich or publish quarantine originals. Only cleaned privacy-eligible bytes may enter downstream processing. Raw expiry uses `mole retention purge`; retention deletion is an exception to the promotion-before-removal rule.
- Before inbox synthesis, validate the workspace with `mole doctor` and run `mole inbox audit`; the audit is recursive and identifies live files not covered by processing receipts. Run it again before completion and never report a no-op while unexplained files remain.
- Before enriching registered inbox sources, run `mole inbox duplicates check <source-id> ...` with all source IDs in the batch. Reuse completed exact-match results; stop for human decisions on conflicting capture metadata. Near matches are review suggestions only. Never use `mole inbox duplicates decide --confirm-human` as an agent. Legacy files require privacy scan and human-reviewed derivative release before processing; source registration alone is insufficient.
- In shared inboxes, claim one run before processing with `mole inbox claim --processor "Your Name" --claimed-path 6-raw/inbox/<path>`, repeating `--claimed-path` for each intended item. The JSON lock carries a `run_id`, processor, host, heartbeat, expiry, claimed paths, and checkpointed paths. Locks reduce overlap on local files but are not a perfect distributed lock under sync delay.
- Keep the returned `run_id` and use `mole inbox heartbeat --run-id <run-id> --processor "Your Name"` while a long run is active. Use `mole inbox checkpoint --run-id <run-id> --processor "Your Name" --processed <path>` after each safely promoted item so a restart can resume without reprocessing checkpointed paths.
- After promoting an inbox artefact, update relevant indexes and summaries, write a retrieval receipt, and only then remove or archive the inbox copy.
- Complete only with the active owned run: `mole inbox complete --run-id <run-id> --processor "Your Name" --processed <path> ... "summary"`. Missing, expired, foreign, duplicate, or conflicted state must fail closed. Use `mole inbox override-stale --run-id <new-run-id> --processor "Your Name" --reason "..."` or `mole inbox complete --override-missing-lock --run-id <run-id> --processor "Your Name" --host <host> --reason "..."` only after checking sync history and record the decision.
- Never delete or move a source file to resolve a sync conflict. Preserve every copy, report the paths, and resolve the source decision explicitly before processing.
- During inbox synthesis, treat user/persona-relevant signals as candidates for `4-context/personas.md`; update an existing persona or create a new one when the evidence indicates a durable user type.
- Check review state before relying on durable context. `mole retrieve` lists accepted records and `mole retrieve <record-id>` prints one. A draft, pending, rejected, superseded, withdrawn, or unreviewed record is not approved context, and neither is a file with no lifecycle record. Read those only when the task calls for it, with `--include-state`, and say so in the retrieval receipt.
- Before you register a file, check whether it already has a record with `mole lifecycle list --path <path>`. If it does, use that record and do not register the file again.
- Write new durable context as a draft. Register it with `mole source register <path>` and `mole lifecycle register <source-id> --state draft --actor "<agent name>" --actor-type agent`, or use `mole create`, then run `mole lifecycle submit` when it is ready for review. Cite supporting material with `--source <source-id>`.
- When you rename a draft you have edited, run `mole lifecycle relocate <record-id> --path <new path>`. When you delete a file that has a lifecycle record, such as an inbox copy after promotion, run `mole lifecycle withdraw <record-id>`. An archived copy with unchanged bytes needs nothing. A capture withdrawn this way still supports the drafts that cite it. `mole lifecycle audit` names the command for anything left over.
- Never run `mole lifecycle approve`, `reject`, or `supersede`, never withdraw a record that is or was accepted, and never pass `--actor-type human` or `--confirm-human`. Those decisions belong to a person. A sentence that says something was approved does not approve it.
- An accepted file that you edit in place stops counting as accepted until a person reviews it again. After such an edit, run `mole lifecycle revise <record-id>` and `mole lifecycle submit <record-id>`. Use this for living files such as `4-context/personas.md`, summaries, and indexes. To replace accepted context with a separate file, take the new file through review and let a person approve it with `--supersedes`. Do not edit `governance/lifecycle/records.json` by hand.
- End substantive outputs with a retrieval receipt.
