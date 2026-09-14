# Source registry

This folder holds the local registry for captured and registered source files.
The files remain the source of truth. A registry record stores the identity and
provenance needed to find a file after it moves, check its bytes, and explain a
deliberate correction.

## Layout

```text
schemas/source-record-v1.schema.json
governance/sources/
├── README.md
└── records/
    └── <source_id>.json
```

The schema is part of the Mole release. `records/` belongs to this workspace.
Registration creates one JSON record per source at
`governance/sources/records/<source_id>.json`. The filename must match the
embedded `source_id`.

The `mole new` scaffold includes this guidance and the versioned schema. It may
create the empty `records/` directory, but it does not create a source record
until a file is registered.

## Ownership

- The versioned schema is Mole-owned and may be copied with an accepted
  upgrade.
- The workspace owns `governance/sources/`, including this README and every
  record under `records/`, after initial scaffolding. Upgrade and scaffold code
  must create the directory when needed, but must never replace or delete its
  contents in an existing instance.
- Source files under `6-raw/`, `5-evidence/`, and other workspace folders keep
  their existing ownership. A record points to a file; it does not make the
  file safe to overwrite.

Keep registry data local to the workspace. Paths, provider IDs, URLs, and actor
names may contain sensitive information. Do not copy source content into a
record or a migration report.

## Record rules

- IDs use `src_` followed by a lowercase UUIDv4 and never change after
  registration.
- Hashes use SHA-256 over the exact file bytes. Do not normalise text or line
  endings before hashing.
- `original_path` stays fixed. `current_path` and `path_history` change only
  through an explicit reconciliation.
- A changed hash is a conflict until the owner records an explicit correction.
  A correction keeps the ID and appends to `content_history`.
- An independently stored attachment gets its own record and ID. Parent and
  attachment records must link to each other.
- Equal hashes do not prove that two records describe the same source. Keep
  both records and report the duplicate for human review.

The registry is metadata, not an access-control system. `visibility` and
`retention` describe the source and do not grant access or delete content.

## Source references

New evidence, context, and receipts use an ID-bearing reference:

```yaml
source_refs:
  - source_id: src_8d31cc34-c04c-41ac-82e3-75518bb5a7e0
    path: 6-raw/archive/2026-09/checkout-note.md
    relationship: supports
```

`source_id` is required. `path` is an optional display or navigation hint and
may become stale after a move. Resolve by ID first. Keep the legacy `source`
field when its existing meaning is needed, but do not treat it as the canonical
provenance field.

## Safe operations

The source commands are designed to make writes explicit:

```text
mole source register <path>
mole source resolve <source_id> [--json]
mole source reconcile <source_id> --path <path>
mole source correct <source_id> --reason <text>
mole source migrate [--apply] [--json]
```

Resolve and migration dry-run are read-only. Reconcile checks the stored hash
before changing path history. Correction records a new hash and reason. The
default migration mode only reports `resolved`, `ambiguous`, and `unresolved`
legacy references. `--apply` may update structured fields only when the report
has one evidence-backed match. It must not rewrite raw bytes, arbitrary
Markdown body links, or ambiguous references.

Do not resolve a source by filename, title, URL, or approximate date alone. Do
not fetch an external `source_reference` during resolution. Reject paths
outside the workspace and symlinks that leave it. Preserve duplicate,
orphan, traversal, symlink, and conflict findings for review.
