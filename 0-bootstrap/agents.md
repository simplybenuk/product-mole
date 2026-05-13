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
- If blocked by missing human input, add an item to `governance/input-queue.md`.
- In shared inboxes, treat `6-raw/inbox/new/` and legacy direct inbox folders as unprocessed input; claim `governance/inbox-processing.lock.json` before processing, move claimed batches through processing states, and never delete raw inputs before a retrieval receipt exists.
- After promoting an inbox artefact, update relevant indexes and summaries, write a retrieval receipt, and only then remove or archive the inbox copy.
- End substantive outputs with a retrieval receipt.
