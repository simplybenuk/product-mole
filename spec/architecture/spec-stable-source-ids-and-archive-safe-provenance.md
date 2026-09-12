# Stable source IDs and archive-safe provenance

Status: READY FOR HUMAN TESTING

Source issue: GitHub issue #23, "Add stable source IDs and archive-safe provenance"

Parent initiative: GitHub issue #16, "Audit follow-up: make Mole safe to operate, validate, and release"

## Purpose

Give every captured or registered source a stable identity that survives file moves. Paths remain useful for people and tools, but no new evidence, context, or processing record may rely on a path as the only source locator.

This is a file-native provenance contract. It covers source registration, capture integration, resolution, corrections, references, migration, and validation. It does not move source content into a database or hosted service.

## Problem

Mole currently identifies source material by path. The audit behind issue #23 found 103 unique raw-file references in a working workspace, of which 76 no longer resolved after archive moves. The same failure mode exists in the current code:

- CLI and UI captures create collision-resistant filenames but no durable identity.
- CLI, UI, and template metadata use different fields and give `source` different meanings.
- Inbox processing receipts store `processed` as an array of paths.
- Inbox audit and metrics compare those stored paths with current paths.
- Archive moves are manual and do not update a registry.
- Evidence, context, and retrieval receipts have no machine-readable source-reference contract.
- There is no content hashing, resolver, correction history, migration classifier, or duplicate/conflict detector.

A filename suffix prevents one capture from overwriting another. It does not identify a file after a move, connect an attachment to its parent, or distinguish a correction from a different source.

## Actors

- Product managers who capture notes, files, exports, and attachments.
- Maintainers who archive, migrate, validate, and upgrade Mole workspaces.
- Agents that create evidence, context, and retrieval receipts from source material.
- Downstream features such as the change travel log, workspace validation, shared inbox processing, and metrics.

## Desired outcome

A source can move from a live inbox to a dated archive and still resolve through the same `source_id`. A deliberate correction can change the content hash without changing that identity, with the change recorded. Legacy path-only references receive an evidence-backed classification and are never guessed from a filename alone.

## Work type

This is a cross-cutting architecture and product-contract change. It adds a versioned source record, local registry, resolver, capture and receipt integrations, migration tooling, and validation behavior.

## Confirmed decisions

1. Files remain the source of truth. The registry is plain JSON inside the workspace.
2. Identity is opaque and independent of content. Version 1 IDs use `src_` followed by a lowercase UUIDv4.
3. Source records live one per file at `governance/sources/records/<source_id>.json`.
4. `governance/sources/` is instance-owned data. Upgrade automation must never overwrite it.
5. SHA-256 hashes the exact current file bytes. Hashes detect content changes but do not define identity.
6. Paths are workspace-relative, use `/` separators, and are optional metadata.
7. Each independently stored attachment has its own source record and `source_id`. Parent records link to attachment IDs.
8. Visibility and retention fields are descriptive in this change. They do not enforce access or delete content.
9. New writers use a structured source reference containing `source_id` and an optional path hint.
10. Historical receipt path fields remain readable during migration. New receipts add ID-bearing entries without invalidating old receipts.
11. Resolution is read-only. A separate explicit reconcile or correction action updates a source record.
12. Migration reports first. Applying changes to user-owned evidence or context requires an explicit option and only touches machine-parseable fields with a resolved match.
13. Duplicate and conflict findings are reported. Mole never merges source records automatically.

## Goals

- Define a versioned source-record schema and field glossary.
- Create a stable ID for each new CLI capture, UI capture, attachment, local file registration, and imported export registration.
- Resolve a source after a normal workspace or archive move.
- Preserve original path, current path, and path history.
- Record content corrections without changing source identity.
- Give evidence, context, and receipts one reusable source-reference shape.
- Classify legacy references as `resolved`, `ambiguous`, or `unresolved` using evidence stronger than a filename match.
- Detect duplicate files, duplicate records, and conflicting records without silent repair.
- Let an existing workspace adopt the contract without rewriting raw source content.
- Provide a contract that issue #11 and the validation, promotion, queue, and metrics work can reuse.

## Non-goals

- Do not add a database, hosted registry, account, or network lookup service.
- Do not make a content hash the source ID.
- Do not build provider-specific import adapters in version 1. Future adapters call the same registration API.
- Do not add UI file upload in this change. The current text capture gains source identity; files and attachments use the shared registration API and CLI until an upload flow exists.
- Do not enforce visibility as authorization.
- Do not auto-delete content from retention metadata.
- Do not silently rewrite arbitrary Markdown body links during migration.
- Do not infer that two sources are the same from a shared filename, title, URL, or hash alone.
- Do not redesign inbox locking, human review states, or the complete workspace validator owned by related issues.

## Source record contract

### Storage

The schema definition is source-owned and ships with Mole:

```text
schemas/source-record-v1.schema.json
```

Each workspace stores instance-owned records here:

```text
governance/
  sources/
    README.md
    records/
      <source_id>.json
```

One record per file avoids a shared registry document becoming a sync and merge hotspot. The filename must equal the embedded `source_id`. A resolver locates a record directly from its ID and also scans the records directory to detect filenames or duplicate embedded IDs that violate this rule.

### Version 1 example

```json
{
  "schema_version": 1,
  "record_revision": 1,
  "source_id": "src_8d31cc34-c04c-41ac-82e3-75518bb5a7e0",
  "source_type": "note",
  "media_type": "text/markdown",
  "original_date": "2026-09-12",
  "captured_at": "2026-09-12T10:15:30.000Z",
  "captured_by": "ben",
  "channel": "cli",
  "source_reference": null,
  "original_path": "6-raw/inbox/20260912T101530000Z-checkout-note-a1b2c3d4.md",
  "current_path": "6-raw/inbox/20260912T101530000Z-checkout-note-a1b2c3d4.md",
  "path_history": [
    {
      "path": "6-raw/inbox/20260912T101530000Z-checkout-note-a1b2c3d4.md",
      "valid_from": "2026-09-12T10:15:30.000Z",
      "valid_to": null,
      "reason": "captured"
    }
  ],
  "content_hash": {
    "algorithm": "sha256",
    "value": "76ef8a8a9b14a85c4918f23c1b3e44ec93f24cc41a856c2f43444935e8a410da"
  },
  "byte_size": 842,
  "content_history": [
    {
      "recorded_at": "2026-09-12T10:15:30.000Z",
      "hash": {
        "algorithm": "sha256",
        "value": "76ef8a8a9b14a85c4918f23c1b3e44ec93f24cc41a856c2f43444935e8a410da"
      },
      "byte_size": 842,
      "change_type": "captured",
      "reason": null
    }
  ],
  "attachments": [],
  "parent_source_id": null,
  "visibility": "internal",
  "retention": {
    "mode": "retain",
    "review_after": null,
    "expires_at": null
  },
  "created_at": "2026-09-12T10:15:30.000Z",
  "updated_at": "2026-09-12T10:15:30.000Z"
}
```

### Field glossary

| Field | Required | Meaning |
| --- | --- | --- |
| `schema_version` | yes | Integer version of the source-record contract. Version 1 records use `1`. |
| `record_revision` | yes | Positive integer incremented for each accepted record change. It helps detect divergent sync edits. |
| `source_id` | yes | Immutable opaque identity in the form `src_<uuidv4>`. It never changes after registration. |
| `source_type` | yes | Logical type. Version 1 values are `note`, `file`, `attachment`, `export`, `external`, and `other`. |
| `media_type` | no | MIME type when known. It describes format without changing logical type. |
| `original_date` | yes | Source date as `YYYY-MM-DD`, or `null` when unknown. It is not invented during migration. |
| `captured_at` | yes | RFC 3339 UTC timestamp when Mole captured or registered the source. |
| `captured_by` | yes | Existing local attribution value, or `unknown` when unavailable. |
| `channel` | yes | Capture or origin channel such as `cli`, `ui`, `email`, `call`, `sync`, or `manual`; `null` when unknown. |
| `source_reference` | yes | Optional origin locator object with `kind` and `value`, or `null`. Examples include a provider document ID or URL. It is metadata, not a network resolver. |
| `original_path` | yes | First workspace-relative path, or `null` for an external source with no local file. It is immutable. |
| `current_path` | yes | Last reconciled workspace-relative path, or `null` when no local copy is known. |
| `path_history` | yes | Ordered path intervals. The current interval has `valid_to: null`. History is append-only except when the current interval is closed. |
| `content_hash` | yes | Current SHA-256 hash object, or `null` for an external source whose bytes are unavailable. |
| `byte_size` | yes | Current byte size, or `null` when content is unavailable. |
| `content_history` | yes | Ordered observations of content hashes. Corrections append an entry and preserve earlier hashes. |
| `attachments` | yes | Array of links to independently registered attachment source IDs. |
| `parent_source_id` | yes | Parent source ID for an attachment, or `null`. |
| `visibility` | yes | Descriptive visibility label. New records default to `internal`. Existing non-empty workspace labels remain valid. |
| `retention` | yes | Advisory object with `mode`, `review_after`, and `expires_at`. Version 1 modes are `retain`, `archive`, and `review`. |
| `created_at` | yes | RFC 3339 UTC record-creation timestamp. |
| `updated_at` | yes | RFC 3339 UTC timestamp of the latest accepted record revision. |

### Identity rules

- Registration creates an ID before writing the source record.
- Moving, renaming, archiving, or syncing a source does not change its ID.
- A correction to the same logical source keeps the ID and appends content history.
- A different document, event, message, export run, or independently stored attachment gets a new ID, even when its bytes equal another source.
- A corrected file is not accepted automatically. A hash mismatch is a conflict until an explicit correction action records the new hash and reason.
- IDs are never recycled after deletion or failed resolution.

### Attachment rules

Each attachment receives its own record. The parent uses this shape:

```json
{
  "source_id": "src_a96362c8-bd31-42da-b11d-4c116e3bd567",
  "relationship": "attachment",
  "label": "customer-export.csv"
}
```

The attachment record sets `source_type` to `attachment` and `parent_source_id` to the parent. Validation checks both directions. A missing parent link, missing attachment record, or mismatched relationship is actionable and never repaired by merging records.

## Source reference contract

All new machine-readable evidence and context references use:

```yaml
source_refs:
  - source_id: src_8d31cc34-c04c-41ac-82e3-75518bb5a7e0
    path: 6-raw/archive/2026-09/checkout-note.md
    relationship: supports
```

`source_id` is required. `path` is an optional display and navigation hint. `relationship` is optional and may describe how the source relates to the current artifact.

JSON documents use the same keys. A Markdown body may keep a normal path link for readability only when the document also contains the corresponding structured `source_refs` entry. Tools resolve by ID first and treat the path as a hint.

The existing frontmatter field named `source` is not part of this contract. Current files use it for incompatible meanings, including capture mechanism and source actor. Migration preserves it and only maps values when their meaning is explicit.

## Capture and registration behavior

### Shared library

A new `lib/source-registry.mjs` owns ID generation, hashing, schema validation, exclusive record creation, resolution, reconciliation, correction history, and findings. CLI and UI code call this module rather than implementing separate metadata rules.

Large files are hashed as streams. The hash covers exact bytes and does not normalize line endings or text encoding.

### CLI text capture

`mole insight` must:

1. Generate a `source_id`.
2. Add that ID to the new Markdown file's frontmatter.
3. Write the raw file and its source record through the shared registration flow.
4. Print both the path and ID.
5. Fail without overwriting an existing source or record.

The raw file carries `source_id` for inspection. The sidecar record is authoritative for mutable provenance such as current path and hash history.

### UI text capture

The current `/api/capture` flow must create the same source record and add `source_id` to the Markdown frontmatter. Its response returns both values:

```json
{
  "ok": true,
  "source_id": "src_8d31cc34-c04c-41ac-82e3-75518bb5a7e0",
  "path": "6-raw/inbox/20260912T101530000Z-checkout-note-a1b2c3d4.md"
}
```

CLI and UI capture may keep their product-specific metadata, but both map provenance into the source record with the same rules. The implementation must document the mapping and stop treating legacy `source` as a canonical field.

### Files, attachments, and imports

Add a registration command for material that already exists in the workspace:

```text
mole source register <path> [metadata options]
```

The command creates a record without rewriting the source bytes. It accepts source type, original date, channel, source reference, visibility, retention metadata, and an optional parent source ID. Provider-specific imports are not present today. Future import adapters and UI upload code must call the same registration function and return the assigned ID.

### Write consistency

Capture stages the content and record with exclusive creation before exposing final paths. If a process stops between final writes, validation reports an orphan raw capture or orphan source record with recovery instructions. It must not silently delete either file.

## Resolver and lifecycle behavior

### Resolve

```text
mole source resolve <source_id> [--json]
```

Resolution is read-only and returns one of:

- `resolved`: one local file or external reference matches the record.
- `ambiguous`: more than one candidate satisfies the available evidence.
- `unresolved`: no candidate satisfies the available evidence.
- `conflict`: a claimed current path or record disagrees with the stored identity or hash.

For a local source, the resolver:

1. Validates the ID and loads the deterministic record path.
2. Checks `current_path` and verifies its hash.
3. Checks existing paths in `path_history`.
4. If needed, searches configured source roots, including retained archive paths, while keeping archive content excluded from the live inbox processing queue.
5. Uses an exact content hash as the primary move match. Dates and recorded path history narrow candidates. A filename can narrow the search but cannot prove identity.
6. Returns candidate paths, evidence used, and any duplicate/conflict findings.

The resolver does not update `current_path`. This keeps lookup safe for validation and agent use.

### Reconcile a move

```text
mole source reconcile <source_id> --path <path>
```

Reconcile verifies the candidate against the current content hash, closes the previous path-history interval, appends the new interval, updates `current_path`, increments `record_revision`, and updates `updated_at`. A hash mismatch fails as a conflict unless the caller uses the explicit correction flow.

### Record a correction

```text
mole source correct <source_id> --reason <text>
```

Correction requires the current path to exist. It computes the new hash, refuses a no-op, appends a `content_history` entry with the supplied reason, updates current hash and byte size, increments `record_revision`, and keeps `source_id`. If the content is a different logical source rather than a correction, the user or agent registers a new source instead.

## Receipt, audit, and metrics compatibility

### Inbox processing receipts

New inbox processing receipts use `schema_version: 2` and add:

```json
{
  "processed": [
    "6-raw/inbox/checkout-note.md"
  ],
  "processed_sources": [
    {
      "source_id": "src_8d31cc34-c04c-41ac-82e3-75518bb5a7e0",
      "path": "6-raw/inbox/checkout-note.md"
    }
  ]
}
```

During the compatibility period, new writers keep the existing `processed` path array and add `processed_sources`. Readers prefer `processed_sources` and fall back to `processed` for historical receipts. A later schema migration may remove the duplicate path array only after all active readers support ID-bearing entries.

### Inbox audit

Inbox audit uses `source_id` to determine whether a current live file has already been processed. Legacy path-only receipts retain their current behavior. Archive traversal for resolution and migration must not cause archived files to re-enter the live inbox candidate list.

### Metrics

Metrics dedupe new receipts by `source_id` and fall back to canonical path for legacy receipts. Existing aggregate files and counts remain valid. This avoids counting a moved source again solely because its path changed.

### Retrieval receipts

Markdown retrieval receipts add a structured `source_refs` list. JSON receipts use source-reference objects. Existing `files read` lists can remain for operational traceability, but any source material listed there must also have an ID-bearing reference when a source record exists.

## Legacy migration

### Command behavior

```text
mole source migrate [--apply] [--json]
```

The default mode is read-only. It inventories known path-bearing fields and links, discovers existing raw and source-document files, and writes nothing. It prints or returns a migration report.

`--apply` may:

- create source records for uniquely identified local sources without changing their bytes;
- add structured ID-bearing references to recognized YAML or JSON fields when the match is `resolved`;
- update versioned receipts through a documented compatibility path;
- record every changed artifact, its prior hash, the selected source ID, and the evidence used.

`--apply` must not:

- change raw source bytes;
- replace arbitrary Markdown body text;
- modify an `ambiguous` or `unresolved` reference;
- merge records or files;
- turn an ambiguous legacy `source` field into provenance without stronger evidence.

### Classification

Each legacy reference receives exactly one state:

- `resolved`: exactly one source matches sufficient evidence.
- `ambiguous`: two or more candidates remain plausible.
- `unresolved`: no candidate meets the evidence threshold.

The report includes the legacy path, containing artifact, candidate IDs and paths, evidence for each candidate, and a recommended human action.

Sufficient evidence can include:

- an exact existing workspace path;
- an exact content hash recorded with the reference or recoverable from version history;
- repository or provider move history that connects old and new paths;
- a unique date match supported by frontmatter, receipt time, or a timestamped capture name, combined with other path metadata;
- explicit human confirmation recorded in the migration report.

A shared basename, filename, title, URL, or approximate date by itself is never sufficient.

### Migration persistence

Applied runs write a JSON report under `governance/run-receipts/source-migration/`. Reports include the command mode, timestamps, counts by classification, findings, changed files, and before/after hashes. Dry runs can write a report only when the user supplies an explicit output path.

## Duplicate and conflict findings

The registry and migration tools report at least these cases:

| Finding | Meaning | Required action |
| --- | --- | --- |
| `duplicate_content` | Different source IDs currently have the same content hash. | Keep both identities unless a human confirms they represent one source. |
| `duplicate_record` | More than one record embeds the same source ID. | Report both record paths and stop resolution for that ID. |
| `path_claim_conflict` | Different source IDs claim the same current path. | Report both IDs and stop automatic reconciliation. |
| `content_conflict` | The current path exists but its bytes do not match the recorded current hash. | Use correction for the same logical source or register a new source. |
| `revision_conflict` | Synced copies of a record have the same revision with different content, or revisions cannot be ordered safely. | Preserve both copies and require review. |
| `orphan_source` | A source file has an ID but no registry record. | Register or recover the record. |
| `orphan_record` | A record claims a local source but no matching file resolves. | Locate the file, reconcile, or mark unresolved. |

Findings include IDs, paths, hashes where safe, and a concrete next action. Tools never auto-merge, discard, or overwrite conflicting material.

## Security and privacy

- Keep registry data local to the workspace.
- Treat paths, provider IDs, URLs, and actor names as potentially sensitive metadata.
- Preserve the current visibility label and do not claim that it enforces access.
- Do not fetch a `source_reference` over the network during resolve or validate.
- Reject paths outside the workspace for `current_path`, `original_path`, and path history.
- Do not follow a symlink outside the workspace while hashing or resolving.
- Do not include source content in migration reports or findings.
- Do not delete content because a retention date has passed. Report it for review.
- Use exclusive creation and atomic replacement for record writes. Preserve sync conflicts for review.

## Rollout and compatibility

1. Ship the schema, registry module, workspace scaffold, and ownership classification.
2. Add source IDs to CLI and UI text capture plus manual file registration.
3. Add resolve, reconcile, correction, and duplicate/conflict findings.
4. Add ID-bearing references to receipts, evidence/context templates, audit, and metrics while retaining legacy readers.
5. Ship dry-run migration and its opt-in apply mode.
6. Update workflow documentation and downstream contract examples.

Existing workspaces remain valid before migration. New capture must not create path-only sources once the feature ships. Old receipts and documents remain readable, but validation reports path-only references until they are migrated or explicitly accepted as unresolved.

No automatic data migration runs during `mole upgrade`. Upgrade adds source-owned schema and tooling, marks `governance/sources/` as instance-owned, and tells the user how to run the migration report.

## Requirements

### Identity and schema

- R1. Every new CLI capture, UI capture, registered file, registered attachment, and imported source receives one immutable `source_id`.
- R2. Every source record validates against the versioned schema before it becomes current.
- R3. The record contains all fields in the glossary, using explicit `null` or empty values when information is unknown.
- R4. A content correction keeps the ID and records prior and current hashes, timestamps, actor context when known, and a reason.
- R5. Independently stored attachments have their own IDs and reciprocal parent relationships.

### Paths and resolution

- R6. Original, current, and historical paths are portable workspace-relative metadata, never identity.
- R7. Resolve finds a uniquely matching source after a move into a dated archive.
- R8. Resolve reports ambiguity or conflict instead of choosing among multiple plausible candidates.
- R9. Read-only resolution never changes source records, content, or references.

### References and compatibility

- R10. New evidence, context, processing receipts, retrieval receipts, and downstream normalized records store `source_id` with any optional path.
- R11. Legacy path-only receipts and metrics remain readable.
- R12. New metrics use source IDs for dedupe when available.
- R13. Existing raw content can be registered without rewriting its bytes.

### Migration and findings

- R14. Migration classifies every discovered legacy reference as `resolved`, `ambiguous`, or `unresolved`.
- R15. A filename alone never resolves a legacy reference.
- R16. Default migration is read-only. Apply mode changes only resolved, machine-parseable references and records an audit report.
- R17. Duplicate and conflicting sources or records produce actionable findings and never trigger a silent merge.

### Operations

- R18. Registry storage is instance-owned and protected from upgrade overwrite.
- R19. All commands provide human-readable output and a stable JSON form for agents and future validation work.
- R20. Partial writes and sync conflicts remain visible and recoverable.

## Acceptance criteria

- AC1. Two new captures with identical text receive different IDs, and each ID remains stable after a file rename.
- AC2. New CLI and UI captures return an ID, include it in Markdown frontmatter, and create a valid source record with the required provenance fields.
- AC3. Registering a pre-existing local file or export creates a source record without changing the file's byte hash.
- AC4. A fixture moves a registered source from `6-raw/inbox/` to a dated archive. `mole source resolve <id>` returns the archive path without changing the record.
- AC5. Reconcile records the old and new paths, closes the old history interval, and leaves the ID unchanged.
- AC6. A deliberate content correction changes the current hash, appends the prior and new hash history, increments the revision, and leaves the ID unchanged.
- AC7. An unacknowledged content change returns `content_conflict` and does not rewrite the record.
- AC8. A parent with two attachments resolves each attachment by its own ID and passes reciprocal-link validation.
- AC9. New evidence/context fixtures and new JSON and Markdown receipts contain ID-bearing source references. Optional path hints can become stale without breaking ID resolution.
- AC10. New inbox receipts retain legacy `processed` paths, add `processed_sources`, and remain usable by audit and metrics.
- AC11. A moved source is not counted again by metrics solely because its path changed.
- AC12. Migration classifies fixture references into `resolved`, `ambiguous`, and `unresolved`. The ambiguous fixture contains a matching filename but insufficient identity evidence.
- AC13. Migration dry-run changes no workspace file. Apply mode changes only resolved structured references, never source bytes, and writes an audit report.
- AC14. Same-hash different-ID records, duplicate embedded IDs, one-path multiple-ID claims, divergent revisions, orphan files, and orphan records each produce the documented finding.
- AC15. Resolution and hashing reject workspace escapes and symlinks that resolve outside the workspace.
- AC16. Existing schema-version 1 inbox receipts and path-only metrics backfill continue to work.
- AC17. Root `npm test` passes, including capture, registration, archive move, attachment, correction, compatibility, migration, and conflict fixtures.
- AC18. Documentation includes the schema example, field glossary, reference example, migration rules, and operational commands.

## Validation plan

### Automated tests

Use Node's built-in test runner and temporary workspace fixtures. Add focused tests for:

- deterministic schema validation with injected IDs and timestamps;
- CLI and UI capture parity;
- exact-byte hashing for Markdown and binary files;
- exclusive record creation and partial-write detection;
- local file, synced-folder path, text note, attachment, and export registration;
- archive move resolution and explicit reconciliation;
- correction history and unacknowledged hash conflict;
- evidence/context and receipt reference serialization;
- old and new receipt readers;
- source-ID metrics dedupe with path fallback;
- all migration classifications and evidence thresholds;
- all duplicate, conflict, and orphan findings;
- path traversal and out-of-workspace symlink rejection.

Run:

```text
npm test
```

### Command checks

In a temporary workspace:

1. Capture a CLI note and UI note.
2. Register a binary attachment and imported export.
3. Move a captured note into `6-raw/inbox/archive/2026-09/`.
4. Resolve it by ID, confirm the result is read-only, then reconcile it.
5. Change the content, confirm conflict, and record a correction.
6. Create resolved, ambiguous, and unresolved legacy references and run migration dry-run.
7. Apply the resolved migration and inspect its report.
8. Run `mole doctor` and `mole inbox audit` to confirm archive resolution did not alter live inbox semantics.

### Persistence checks

- Validate every new record against `schemas/source-record-v1.schema.json`.
- Confirm source files retain their original bytes when registered or migrated.
- Confirm record filenames equal embedded IDs.
- Confirm path and content history survive a reload.
- Confirm every changed user-owned reference appears in an applied migration report with before and after hashes.

## Proposed task outline

1. Add the source-record schema, registry storage contract, ownership rules, and core ID/hash/validation functions.
2. Add registration, resolution, reconciliation, correction history, and duplicate/conflict findings with unit fixtures.
3. Integrate the shared registry with CLI and UI text capture, then add manual file, export, and attachment registration.
4. Add the reusable source-reference shape to evidence/context templates, inbox and retrieval receipts, audit, and metrics with backward-compatible readers.
5. Add legacy discovery, classification, dry-run reporting, and explicit apply behavior.
6. Update workspace scaffolding, architecture and workflow documentation, command help, and end-to-end fixtures.

Each task must leave root `npm test` passing. Task 4 must not remove legacy receipt support. Task 5 must prove dry-run makes no changes before apply behavior is accepted.

## Dependencies

- The recursive inbox audit and root test command from the parent initiative are present on `main` and form the baseline.
- Issue #11 consumes this source-reference contract but does not block it.
- Issue #18 should extend validation using this registry after the core contract ships.
- Issue #21 should use source IDs when making shared-folder processing restart-safe.
- Issue #19 can build richer metrics on the ID-aware receipt behavior.
- Issue #24 can add human review states without changing source identity.

No new runtime package is required. Node's built-in crypto and filesystem APIs cover UUID generation and streaming SHA-256.

## Affected areas

- `lib/source-registry.mjs` and related reusable helpers.
- `lib/capture.mjs`, `lib/inbox-processing.mjs`, `lib/inbox-audit.mjs`, and `lib/metrics.mjs`.
- `cli/mole.mjs`, command help, CLI tests, and CLI documentation.
- `ui/server.mjs` and the current capture response handling.
- Evidence, context, raw capture, and artifact templates.
- Retrieval receipt and source-migration receipt guidance.
- Workspace scaffold copy rules, instance metadata, and upgrade ownership.
- Architecture, signal inbox, migration, UI, and command-surface documentation.
- Downstream source-reference consumers, beginning with issue #11.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Registry and source writes separate during a crash. | Stage writes, use exclusive creation and atomic replacement, and report orphans instead of deleting them. |
| Hashing large exports is slow. | Stream hashes and narrow archive candidates with recorded metadata before hashing. |
| Sync creates divergent record copies. | Store one record per ID, increment revisions, detect divergent revisions, and preserve all copies for review. |
| Existing `source` metadata is misread. | Introduce `source_id` and `source_reference`; preserve legacy `source` unless its semantics are explicit. |
| Migration rewrites user-owned truth incorrectly. | Default to dry-run, require sufficient evidence, limit apply to structured resolved fields, and record before and after hashes. |
| Same bytes are mistaken for one identity. | Treat equal hashes as a finding, not proof that records should merge. |
| Visibility or retention appears enforced when it is not. | Label both fields descriptive or advisory in schema, docs, and command output. |
| Resolver scans make archived files look unprocessed. | Keep source-resolution roots separate from live inbox audit rules. |
| Paths expose sensitive local information. | Store workspace-relative paths only and omit source content from reports. |

## Agent-resolved assumptions

- A1, tied to AC1 and AC2: `src_<uuidv4>` is the version 1 ID format because Node supports it without a dependency and it remains independent of content and path.
- A2, tied to AC4, AC14, and AC16: one JSON file per source is safer for local sync and conflict inspection than one shared registry file.
- A3, tied to AC2 and AC9: Markdown captures carry only the immutable ID directly. The sidecar record owns mutable provenance and avoids a self-referential content hash.
- A4, tied to AC3 and AC13: registration and migration do not add frontmatter to pre-existing source files because their bytes are user-owned evidence.
- A5, tied to AC6 and AC7: hash changes require an explicit correction action. Resolve and validation never bless changed bytes automatically.
- A6, tied to AC8: each stored attachment has its own identity rather than inheriting only the parent's identity.
- A7, tied to AC10, AC11, and AC16: inbox receipts use parallel `processed_sources` during compatibility instead of changing the type of the existing `processed` array.
- A8, tied to AC12 and AC13: migration dry-run is the default because ambiguity is expected and evidence/context files are user-owned.
- A9, tied to AC15: local paths cannot escape the workspace, and local resolution does not follow outward symlinks.
- A10, tied to AC18: visibility stays descriptive and retention stays advisory. Enforcement or deletion needs a separate human-approved security and recovery design.
- A11, tied to AC2 and AC8: version 1 integrates current UI text capture but does not add file upload. The shared API leaves that later addition straightforward.
- A12, tied to AC3 and AC12: provider-specific imports are represented as registered files or external sources. No provider adapter is required for issue #23.
- A13, tied to AC4 and AC6: exact file bytes, including line endings, define the SHA-256 observation. Any byte change is visible.

## Open questions

There are no blocking product or irreversible decisions left unstated. Human approval may change any recorded assumption before development planning.

## Retrieval receipt

- Files read: the project agent instruction file; project adapter and context map; routing task type, depth budget, and repository map; technical and product summaries; artifact and decision indexes; personas; product vision and goals; target architecture and ADRs; the existing metrics feature spec; capture, inbox receipt, inbox audit, and metrics modules; CLI and UI capture code and tests; raw, metadata, context, and artifact templates; inbox workflow, migration, UI, command, upgrade, and contribution guidance; instance and upgrade ownership files; GitHub issues #23, #16, and #11.
- Deepest layer reached: layer 4. No layer 5 or raw product evidence was needed because issue #23 and its parent contain the audit evidence, while current repository code establishes the implementation gap.
- Why descent stopped: the issue scope, architecture rules, operational code, and existing spec conventions were sufficient to define the contract and acceptance criteria.
- Source-of-truth decisions: preserve file-native operation; protect instance-owned content; treat paths as metadata; keep the live inbox audit separate from archive resolution; preserve legacy receipt readers; require a human to approve the spec before development.
- Conflicts found: CLI, UI, workflow examples, and templates assign different meanings and shapes to `source` metadata. Visibility has no enforcement contract, retention has no source-content policy, and no registry location or ID format existed. This spec resolves those gaps with new versioned fields and does not reinterpret legacy `source` values.
- Remaining uncertainty: real legacy workspaces may lack enough hash, date, or history evidence to resolve many broken links. The migration contract preserves those cases as `ambiguous` or `unresolved` for human review.

## Development readiness

The problem, actors, outcome, scope, source contract, compatibility rules, migration threshold, security boundary, rollout, tests, acceptance criteria, task outline, dependencies, affected areas, risks, and assumptions are defined. The specification is ready for human approval. It must not move to `APPROVED FOR DEVELOPMENT` until a human explicitly approves it.
