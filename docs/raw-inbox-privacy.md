# Raw inbox privacy and retention

Mole scans the original note and user-supplied capture fields locally before formatting, escaping or writing inbox bytes. Every stored summary and body copy uses the cleaned values. Uncertainty in any field quarantines the capture instead of publishing a cleaned-looking copy. It generates opaque source-ID filenames, replaces capture attribution with `[PERSON_NAME]`, and records category counts without matched values. Cleaned captures remain **raw**, outside accepted context. Human lifecycle approval is still required for promotion. Never paste a raw capture into a receipt, log, metric label or error report. Capture visibility is limited to `internal`, `public`, `private`, `restricted` and `confidential`; unsupported values fail before capture. Source registration, coordination and lifecycle commands reject metadata that matches a supported sensitive rule or uncertainty cue, including completion summaries, ownership, lifecycle actors and lifecycle or recovery reasons. Lifecycle registration, transitions, relocation and migration validate metadata before mutation; generated lock identity and the ledger are checked before persistence. A rejection preserves the existing ledger for a clean retry. Existing sensitive history is never rewritten automatically. They return a controlled error before writing it. Prepare a clean summary and retry; the command does not silently rewrite identity or retry payloads. This validation uses the same bounded rules as capture and cannot certify arbitrary prose.

The scanner recognizes email addresses, international phone numbers beginning with `+`, labelled person/customer/patient names and postal/street addresses, labelled customer/account/case IDs, labelled API keys/passwords/tokens, selected key prefixes, complete private-key blocks, authenticated connection URLs, labelled diagnoses/medical histories/medications, labelled bank/payment/tax/transaction data, and labelled confidential business terms. Values become typed placeholders. Repeated values get the same category placeholder; placeholders do not preserve identity distinctions.

These rules do not recognize every name, language, address, secret format, financial statement or business fact. No match means `no_rule_match`, never a privacy certification. Unlabelled secret, medical, financial or confidential cues trigger quarantine. False positives are deliberate: a discussion of an unknown token needs review. Do not rely on the scanner to sanitize arbitrary documents automatically. Review cleaned content before enrichment, sharing or promotion.

All manual imports and attachments quarantine, even text formats. PDF, Office, image metadata, structured formats and archives have no verified extraction adapter in this release. Mole never treats extraction failure as clean text. Captures are scanned in memory; only cleaned text or quarantined bytes enter private staging. There is no hosted scanner.

## Local commands

```bash
mole privacy audit
mole privacy scan             # count unregistered raw files, without printing names
mole privacy scan --apply     # move manual files into opaque quarantine
mole retention purge         # dry-run
mole retention purge --apply
```

`mole.privacy.json` optionally configures `{"ttl_days":7}`. Integers from 1 to 30 are supported. Missing configuration uses the built-in seven-day policy for existing workspace compatibility. This differs from the proposal's missing-policy block. Malformed or unknown configuration fails closed. Custom patterns and configurable detection thresholds are not supported; built-in rules cannot be disabled.

The immutable capture time sets expiry. Retrying an existing source ID does not reset it. Quarantined, failed and cleaned raw captures share the same TTL. Privacy records in `governance/privacy/<source_id>.json` retain only stable IDs, generated paths, timestamps, category counts, outcome, review and retention states. No raw hash, original filename, excerpt or reversible substitution table is recorded. After deletion, the tombstone has a null path and a deletion timestamp. Source IDs remain usable for provenance.

Schedule `mole retention purge --apply` with your operating system scheduler at least daily. Expiry is enforced on the next job run, not by a hidden process. There is no automatic deletion without an operator scheduling or invoking the command. The default dry-run never deletes. Deletion failures retain `deletion_failed` and are retried on the next apply. The command reports safe IDs and controlled status values only.

## Quarantine review

Inspect originals locally using a trusted editor with telemetry and automatic backups disabled. Original quarantine files are not registered as retrievable lifecycle content. Prepare a separately cleaned UTF-8 derivative at `6-raw/quarantine/<source_id>.md`. Then run:

```bash
mole privacy release <source_id> --confirm-reviewed
mole privacy release <source_id> --confirm-reviewed --apply
```

The scanner must allow the derivative. Apply registers a raw source and lifecycle record for it, preserving its source ID and original expiry. Original bytes remain private until purge. Confirmation means a person reviewed privacy, not that the insight is approved. Lifecycle acceptance remains a separate human decision. Retention extensions are not supported in this release; copy no originals into durable evidence to bypass expiry.

## Managed archive moves

Archive a privacy-eligible cleaned raw source with:

```bash
mole privacy archive <source-id>
mole privacy archive <source-id> --apply
```

The only destination is `6-raw/inbox/archive/<source-id>.md`. The dry-run changes
nothing. Apply preserves source ID, bytes, original expiry, duplicate fingerprint
and receipt identity, and appends the generated path to source history. It does
not change lifecycle review state. Archived sources remain privacy-gated and can
be checked for duplicates or explicitly claimed/processed at their archive path.
Purge covers the managed archive and restored copies under the same expiry.

An active or conflicted processing/lifecycle lock, symlink, conflicting source
identity or existing destination stops the operation. There is no overwrite or
arbitrary destination option. A prepared raw-free intent precedes an exclusive
hard link, then privacy and source metadata updates, then removal of the original
link. This operation requires a filesystem supporting local hard links. If it
cannot create the link, the original remains and the prepared intent needs
recovery. The operation does not claim filesystem or multiple-ledger atomicity.

After an interrupted move, processing and purge stop for the pending intent.
`mole privacy audit` lists its source ID in `pending_moves`.
Inspect privacy/source state locally, pause sync and processors, then run:

```bash
mole privacy archive <source-id> --recover
mole privacy archive <source-id> --recover --apply
```

Recovery never renews TTL. If expiry occurs while the intent is pending, the
archive command refuses and owner reconciliation is required before purge.
Recovery handles an intent created before linking, two links to the same inode,
metadata updated before unlinking, or only the archive remaining after metadata
updates. It verifies privacy eligibility and unchanged captured bytes before
continuing. Equal-looking copies with different inodes, foreign path ownership,
malformed metadata, missing copies or inconsistent completed state are ambiguous;
recovery preserves them and refuses to select a winner. Owner reconciliation is
required in those cases. Atomic metadata write failures can also leave malformed
or temporary records that require owner reconciliation. Do not delete a source
to force recovery. Retrying a completed move is idempotent and never renews TTL.

## Recovery and synced workspaces

Run scan before processing existing workspaces. It preserves the earliest available local birth/modified timestamp, capped at the scan time. That timestamp cannot prove the age of a file copied from another device. Migration does not preserve sensitive original filenames in a manifest. Existing registry entries can still contain legacy sensitive metadata; inspect them locally and correct them before sharing. A scan is not a scrub of previous history.

Any inbox processing lock or conflict lock blocks applying migration and expiry deletion. Stop processors, reconcile sync conflicts and run ownership on every device, then retry. Unregistered raw files block purge until scanned. This is deliberately more conservative than deleting items under stale claims. It also means a broken claim can delay deletion. Monitor job results. Never resolve sync conflicts by silently deleting one copy.

An intent manifest precedes staging. A crash between staging, rename and manifest update is recoverable by purge, which checks all generated locations for the ID. Unknown files are quarantined by scan. Malformed manifests and symlinks fail closed. Recover their metadata locally before retrying; do not paste contents into error reports. Run jobs with one local writer and pause folder synchronization while changing privacy state. Local filesystem operations are not a distributed lock or protection against a malicious concurrent filesystem writer.

Purge covers managed staging, quarantine, inbox and generated archive copies. Manual archives outside the managed operation must first pass scan. Moving a managed file manually does not authorize its new path. After deleting raw files, reconcile source/lifecycle ledgers with their normal audit tools; do not withdraw accepted context automatically. Keep cleaned durable evidence separately, with supporting source IDs and the normal draft/review process.

Local unlink does not erase provider copies, backups, snapshots, trash, editor swap files or earlier Git commits. Exclude `6-raw/` from backups and hosted sync where possible. Set short provider retention, clear deleted versions under the provider's controls, and avoid backing up quarantine. On restore, pause processors, restore privacy tombstones with the workspace, scan recovered copies and run purge before resuming. A restored file is not authorized for reuse because it exists again.

## Git protection and integration

The repository and new workspaces ignore raw content while retaining the bundled inbox README. Package artifacts and new-workspace scaffolds include only that README from `6-raw/`, even when the source checkout contains ignored inbox, quarantine, staging or archive files. Scaffolding creates a new empty inbox; it is not a backup or restoration operation and never copies raw bytes without their retention state. `npm run check:privacy`, also run by `check:package`, rejects any tracked raw file except that README, plus private privacy manifests. Run it before committing. A forced Git add can bypass ignore rules, so configure CI to run package validation. This guard does not inspect all arbitrary files for semantic leakage or rewrite old commits. Synthetic privacy test values are generated inside disposable temporary workspaces.

Downstream integrations must call `assertPrivacyProcessing(root, paths)` before reading candidates, then respect lifecycle state. Unregistered, expired and quarantined originals fail that gate. Duplicate hashes may be retained only for privacy-eligible cleaned bytes, never original quarantine content. This release exposes that gate; existing manual source registration and other file-reading tools are not a filesystem sandbox. Operators and agents must follow the privacy workflow before using them.
