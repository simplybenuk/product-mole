# Sensitive-data filtering and raw inbox retention

Status: READY FOR HUMAN APPROVAL
Issue: #25
Parent: #16
Related contracts: #21, #23, #24

## Summary

Mole currently writes CLI and UI captures directly into `6-raw/inbox/`. Users can also add files and attachments manually. That makes the inbox a possible long-lived store for personal data, credentials, customer identifiers, health or financial information, and confidential business material.

This change adds a local-first privacy boundary around raw inbox material. Mole will scan content before durable storage, redact high-confidence findings, quarantine uncertain or unsupported material, keep raw content for a short configurable period, and remove expired content through an explicit purge command. Processing metadata remains useful without retaining sensitive values.

## Actors and affected areas

- Product managers and other contributors who capture notes through the CLI, UI, or shared folders.
- Agents and maintainers who process, review, promote, or delete inbox material.
- Workspace operators responsible for synced folders, backups, recovery, and scheduled maintenance.
- CLI capture and inbox processing code in `cli/` and `lib/`.
- UI capture code in `ui/`.
- Raw content under `6-raw/`, receipts and metrics under `governance/`, and Git validation.

## Desired outcome

Raw content is useful during its short processing window but does not become an uncontrolled permanent dataset. Cleaned insights can be promoted without carrying original sensitive values into durable files, logs, receipts, metrics, Git, or normal retrieval.

## Goals

1. Detect and handle supported sensitive-data categories before durable inbox storage.
2. Preserve insight meaning with typed placeholders where safe.
3. Route uncertain, unsupported, and operationally ambiguous cases to quarantine.
4. Apply a seven-day default retention period from initial capture.
5. Provide repeatable, auditable deletion for expired staged, raw, quarantined, and archived content.
6. Keep processing receipts, logs, errors, metrics, and reports free of raw sensitive values.
7. Support existing workspaces through a non-destructive migration scan.
8. Define contracts compatible with stable source identity (#23), restart-safe processing (#21), and explicit promotion lifecycle (#24).

## Non-goals

- Hosted scanning or sending raw content to an external AI/API.
- Cryptographic erasure of copies already held by sync providers, filesystem snapshots, backups, or previous Git commits.
- Automatic acceptance of promoted content. Human review remains governed by #24.
- A general-purpose data-loss-prevention product outside Mole inbox and its related operational records.
- Silent merging of sync conflict copies or duplicate source records.

## Scope and requirements

### Ingestion and staging

1. CLI captures, UI captures, manually added files, and attachments must pass through the same policy.
2. New content must enter a transient staging area before it is written to the durable inbox.
3. Capture must fail closed if the privacy policy is missing, malformed, or cannot be loaded.
4. Filenames must use a sanitised non-sensitive slug and must not be derived directly from raw capture text.
5. Staging, capture, migration, and purge must reject symlinks and resolved paths outside the workspace root.
6. A cleaned item must replace the staged item atomically only after scanning succeeds. The original staged copy must then be deleted.

### Detection

The first implementation must use deterministic local rules, MIME-aware extraction, and workspace-configured patterns. Raw content must not leave the workspace.

The built-in categories are:

- personal names, email addresses, phone numbers, addresses, and other PII;
- credentials and secrets, including API keys, tokens, passwords, private keys, and connection strings;
- customer identifiers and account or case references;
- health and medical information;
- financial information, including payment, bank, tax, and transaction data;
- confidential business information, including contract terms, unreleased plans, and internal identifiers.

Workspaces may add custom patterns and thresholds. Built-in protections cannot be disabled through ordinary workspace configuration.

The policy is:

- high-confidence findings are redacted automatically;
- medium-confidence findings are quarantined;
- low-confidence findings may pass, with only aggregate detection metadata recorded;
- possible secrets use the stricter handling threshold and must not pass as ordinary low-confidence findings.

### Redaction

1. Replace values with stable typed placeholders such as `[PERSON_NAME]`, `[EMAIL]`, `[API_KEY]`, or `[CUSTOMER_ID]`.
2. Repeated occurrences of the same value within one item receive the same placeholder. Values in separate items are tokenised independently.
3. Apply redaction to document bodies, frontmatter, filenames, metadata, and extracted attachment text.
4. Remove a value instead of replacing it when retaining its shape or context would create additional risk.
5. Do not include matched values, raw excerpts, or reversible mappings in receipts, logs, metrics, reports, or quarantine manifests.

### Formats and attachments

Markdown, plain text, JSON, YAML, CSV, and common image metadata must be scanned directly. PDF and common Office formats should be scanned through local extraction when supported by the implementation. Any format that cannot be safely parsed or scanned must be quarantined automatically.

Quarantined originals live outside the normal inbox in a dedicated quarantine area. The manifest contains only source ID when available, category, confidence, timestamps, path metadata, processing outcome, review state, and retention state.

### Quarantine review

Review must be an explicit local operation. A reviewer may:

- approve a cleaned derivative for normal processing;
- delete the item;
- extend retention by a fixed seven-day increment, up to 30 days, with a reason and new expiry.

Viewing original quarantined content is allowed only through the review flow. Review is not approval for durable promotion. Normal retrieval and promotion exclude quarantined material, and pending or rejected material remains governed by #24.

### Retention and deletion

1. The default TTL is seven days from initial capture, regardless of later edits or retries.
2. Quarantine uses the same base window. Extensions require an actor, reason, and explicit expiry.
3. Processed status does not make raw or archived content permanent. It remains eligible for purge unless a documented hold applies.
4. `mole retention purge` is the explicit cleanup command. It must be safe to run repeatedly and must cover staging, live raw items, quarantine, and eligible archive content.
5. Purge skips items with an active owned processing claim and retries them later.
6. Expired items with stale or foreign claims, unresolved sync conflicts, or ambiguous ownership are quarantined for recovery rather than deleted automatically.
7. Deletion failures retain the item, emit a non-sensitive error, and appear in the next purge report.
8. Mole documents that synced copies, backups, snapshots, OS trash, and prior Git commits may still retain data.
9. Mole does not start hidden background timers. Operators may schedule the explicit purge command using their local or sync-provider tooling.

### Migration and provenance

Migration scans existing live inbox and relevant raw/archive content without rewriting it first. Each item receives a non-sensitive classification, action, failure reason, and source path or stable source ID where available. Existing content that is uncertain, unsupported, or unscanned is quarantined according to the documented migration procedure.

New and migrated items must use the stable provenance contract from #23. At minimum, privacy metadata must be able to reference source ID, original/current path, capture time, content hash where permitted, retention state, detection outcome, and quarantine/review state without storing sensitive values.

### Observability and repository protection

1. Receipts record non-sensitive processing metadata only: source ID, timestamps, outcome, category counts, retention state, and processing receipt information.
2. Metrics contain aggregate counts by outcome or category. They do not contain filenames, hashes, placeholders, matched locations, raw values, or excerpts.
3. Error messages and logs must use typed categories and safe identifiers, never raw input.
4. Git validation must reject likely real sensitive content in inbox, fixtures, receipts, logs, metrics, and quarantine metadata while allowing clearly synthetic test values.
5. A privacy audit must report malformed policy, unsafe permissions where detectable, stale staging files, expired quarantine items, failed deletions, invalid retention state, and likely raw-content leakage without printing protected content.

## Proposed implementation shape

Keep the implementation file-native and local-first. Add a privacy policy module under `lib/`, reuse it from CLI and UI capture, and add explicit retention and quarantine commands to the CLI. Keep the detector and extraction interfaces independent of any particular parser library so supported-format adapters can be added without changing the policy contract.

Use atomic file operations and safe path resolution at every boundary. Integrate processing claims from #21 so purge cannot race an active run. Integrate source identity from #23 so quarantine and receipts do not depend on mutable paths. Integrate the lifecycle from #24 so cleaned derivatives, quarantined records, and promoted outputs have distinct states.

The implementation may add local JSON manifests and policy files, but durable records must remain inspectable and editable without a hosted service.

## Dependency and delivery order

The specification can proceed now because it names the interfaces required by the related issues. Implementation should follow this order:

1. **#23, stable source IDs and archive-safe provenance.** Privacy records, migration reports, attachments, and purge outcomes need an identity that survives movement and correction.
2. **#21, shared-folder processing coordination.** Capture, quarantine, and purge must respect run ownership, leases, retries, stale claims, and sync conflicts.
3. **#24, explicit review and promotion lifecycle.** Quarantine release, cleaned derivatives, pending review, rejection, and supersession need explicit states and human-only acceptance.
4. **#25, sensitive-data filtering and retention.** Implement detection and redaction against those contracts, with a compatibility adapter if an earlier issue is not yet merged.

Do not block creation or approval of this specification on the implementation of #21, #23, or #24. Do block #25 development if those issues change the agreed source identity, ownership, or lifecycle contracts in a way that invalidates the interfaces above.

## Acceptance criteria

1. Fixtures covering every built-in sensitive category are detected and handled according to the documented confidence policy.
2. High-confidence values are replaced by typed placeholders, and repeated values within one item remain consistently tokenised.
3. Secrets are handled conservatively and never appear in durable cleaned output, logs, receipts, metrics, reports, or fixtures.
4. Medium-confidence, unsupported, crash-recovery, stale-claim, and ambiguous-sync cases enter quarantine with safe metadata.
5. CLI, UI, manual files, filenames, frontmatter, and supported attachments use the same policy boundary.
6. Raw and quarantine content expires from capture time, including failed and quarantined items according to the documented rules.
7. Purge is repeatable, path-safe, claim-aware, and honest about deletion failures.
8. A migration scan classifies existing content without copying raw values into its report.
9. Processing receipts, metrics, logs, errors, and quarantine manifests contain no raw sensitive content.
10. Git validation blocks likely real sensitive content while allowing clearly synthetic fixtures.
11. Privacy validation reports stale staging files, malformed policy, retention failures, and unsafe state without leaking protected content.
12. The design uses stable source identity, restart-safe processing, and explicit promotion lifecycle contracts.
13. Documentation covers local workspaces, synced folders, backups, recovery, scheduling, and the limits of deletion.

## Proposed task outline

1. Define the versioned privacy policy, detection categories, confidence outcomes, placeholder vocabulary, retention states, quarantine manifest, and source-identity fields.
2. Add safe staging, path validation, filename sanitisation, and shared capture integration for CLI and UI.
3. Implement deterministic text and metadata detection with custom workspace patterns.
4. Implement redaction, atomic clean writes, secret handling, and safe result metadata.
5. Add local extraction adapters for supported PDF/Office formats and quarantine fallback for unsupported binaries.
6. Add quarantine review, retention extension, and explicit purge commands.
7. Integrate claims, stable IDs, and lifecycle state transitions from #21, #23, and #24.
8. Add migration scanning and privacy audit output.
9. Add Git validation and synthetic fixtures.
10. Update README, CLI documentation, inbox workflow guidance, and recovery documentation.

## Validation plan

- Run `npm test` from the repository root.
- Add unit tests for category detection, false positives, confidence thresholds, repeated-value tokenisation, frontmatter and filename redaction, custom patterns, and secret handling.
- Add integration tests for CLI and UI capture, staging failures, atomic writes, attachments, unsupported files, quarantine review, retention extension, purge retries, deletion failure, symlink rejection, path traversal, and expired items.
- Add concurrency tests for active claims, stale claims, retries, duplicate receipts, sync conflict copies, and restart after partial processing.
- Add migration tests for existing raw files and non-sensitive migration reports.
- Assert that sensitive fixture literals do not occur in any generated output, receipt, metric, log, error, report, or Git validation result.
- Run `mole doctor` and relevant inbox audits against a disposable fixture workspace.
- Verify documentation examples for local and synced workspaces.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Detector misses a new secret format | Conservative secret rules, quarantine fallback, custom patterns, and explicit unsupported handling |
| False positives reduce capture trust | Typed placeholders for high-confidence matches, quarantine for uncertain cases, and synthetic false-positive fixtures |
| Purge races processing or sync | Claims from #21, atomic operations, stale-claim quarantine, and repeatable retries |
| Path-only records become stale | Stable source IDs from #23 and path history in privacy metadata |
| Quarantine becomes a permanent shadow inbox | Independent TTL, visible review state, purge reports, and explicit extensions only |
| Users assume deletion removes backups | Documentation states the limits of local deletion and provides recovery/backup guidance |
| Receipts or filenames leak content | Sanitised slugs, safe metadata schema, leak assertions, and Git validation |

## Agent-resolved assumptions

- The initial implementation is Node-based and uses local deterministic rules. Observable effect: raw content never leaves the workspace, and tests can run without network access.
- PDF and Office extraction is adapter-based. Observable effect: supported files are scanned, and every unsupported or failed extraction is quarantined rather than accepted as clean.
- A privacy policy file belongs in workspace configuration alongside `mole.instance.yaml`. Observable effect: malformed or missing policy blocks capture, and built-in protections remain active.
- Purge scheduling is operator-owned rather than a hidden daemon. Observable effect: cleanup occurs only through the explicit command or an operator-configured scheduler.
- Existing raw content is not silently marked compliant. Observable effect: migration reports every item and routes uncertain or unsupported items to quarantine.
- The spec is model-agnostic. Observable effect: changing the implementation model does not change the policy, acceptance criteria, or human review boundary.

## Open questions

No unresolved product, scope, security, permission, tenancy, or external-contract questions remain from the confirmed grill. Parser-library selection, exact rule implementation, and command naming details remain technical choices for development planning.

## Handoff

This artifact is ready for human approval. After approval, use `bwh-development` or a task-planning workflow to turn the task outline into independently verifiable implementation tasks. Do not begin implementation solely because this spec has been committed.
