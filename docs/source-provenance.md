# Source IDs and archive-safe provenance

Mole keeps source files in the workspace. The source registry adds the identity
and history needed to find those files after they move. It does not replace the
files with a database and it does not fetch a hosted copy.

This guide describes the contract used by new capture, registration, evidence,
context, and receipt writers. The versioned schema is at
`schemas/source-record-v1.schema.json`. Workspace records live under
`governance/sources/records/`.

## What gets an ID

Every new CLI or UI capture, registered local file, imported export, and
independently stored attachment gets one immutable ID in this form:

```text
src_<lowercase-uuidv4>
```

The ID is created before the record is written. A move, rename, archive, or
sync does not create a new ID. A different document, event, export run, or
attachment gets a new ID even when its bytes happen to match another source.

The registry hashes exact file bytes with SHA-256. A hash detects a content
change; it does not define identity. If a file changes, resolution reports a
conflict until an owner records an explicit correction. A correction keeps the
ID and appends a `content_history` entry.

## Registry layout and ownership

```text
schemas/source-record-v1.schema.json       # Mole-owned contract
governance/sources/README.md               # workspace guidance
governance/sources/records/<source_id>.json # instance-owned record
```

There is one record per source. Its filename must equal the embedded ID. The
record stores the original path, current path, append-only path history, current
hash, content history, capture metadata, and attachment links. The source file
still owns its content.

The `mole new` scaffold includes the schema and registry guidance. It does not
seed source records. Registration creates the records directory when needed.

The schema is Mole-owned and may be adopted with an accepted upgrade. The
entire `governance/sources/` directory is workspace-owned after initial
scaffolding. Upgrade automation must never overwrite or delete its README or
records. The same preservation rule applies to the source files in
`4-context/`, `5-evidence/`, and `6-raw/`.

## Structured source references

New evidence, context, and receipt fields use `source_refs`. Each entry requires
an ID and may carry a path hint and relationship:

```yaml
source_refs:
  - source_id: src_8d31cc34-c04c-41ac-82e3-75518bb5a7e0
    path: 6-raw/archive/2026-09/checkout-note.md
    relationship: supports
```

Resolve by `source_id` first. `path` helps people navigate and may become stale
after an archive move. A Markdown body link may remain for readability only
when the document also has the structured entry.

The existing frontmatter field named `source` has incompatible meanings across
older files, including actor, channel, and capture mechanism. Keep it during
migration when it carries useful legacy information. Do not reinterpret it as
canonical provenance. New writers should use `source_id` for the captured file
and `source_refs` for references from another artifact.

The templates show the fields in context:

- [`templates/metadata-frontmatter.md`](../templates/metadata-frontmatter.md)
  defines the common fields.
- [`templates/raw-insight-template.md`](../templates/raw-insight-template.md)
  carries the capture ID and optional source references.
- [`templates/context-module-template.md`](../templates/context-module-template.md)
  and the artifact templates carry ID-bearing references in their retrieval
  sections.

## Commands and expected safety

The command contract is:

```text
mole source register <path> [metadata options]
mole source resolve <source_id> [--json]
mole source reconcile <source_id> --path <path>
mole source correct <source_id> --reason <text>
mole source migrate [--apply] [--json]
```

`register` creates metadata without changing the source bytes. `resolve` is
read-only. It checks the current path, path history, and exact hash before using
archive search. A filename alone is never enough. `reconcile` records a move
only after the candidate still matches the stored hash. `correct` records a new
hash and reason for the same logical source.

Migration is read-only by default. It classifies legacy path references as
`resolved`, `ambiguous`, or `unresolved`. Apply mode can update a recognized
structured YAML or JSON field only for a resolved match. It must not rewrite
raw bytes, arbitrary Markdown body links, or ambiguous references. Applied
runs write a report under `governance/run-receipts/source-migration/`, including
the changed artifact, selected ID, evidence, and before/after hashes.

## Attachments and external sources

An independently stored attachment has its own source record and ID. The parent
record links to that ID, and the attachment record points back to its parent.
Validation reports a missing or mismatched link. It never merges the records.

An external source may have a `source_reference` such as a provider ID or URL,
but resolution does not make a network request. Keep those values local and
treat them as potentially sensitive metadata.

## Security and recovery rules

- Keep registry records in the workspace. Do not send source content to a
  resolver or migration report.
- Reject `current_path`, `original_path`, and path-history entries outside the
  workspace. Do not follow a symlink outside it while hashing or resolving.
- Treat visibility and retention as descriptive metadata. They do not grant
  access or delete content.
- Use exclusive creation for new records and atomic replacement for accepted
  record updates.
- If capture and record writes split during a crash, preserve both files and
  report the orphan. Recovery must be explicit.
- Equal hashes, duplicate IDs, path claims, revision differences, and stale
  hashes are findings for review. Mole never silently merges or discards them.

For instance upgrade rules, see
[`docs/upgrade-and-instance-management.md`](./upgrade-and-instance-management.md)
and [`docs/upgrade-ownership.md`](./upgrade-ownership.md).
