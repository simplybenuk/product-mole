# Review lifecycle

This folder holds the review ledger for the workspace. The ledger records
which registered files are raw material, evidence, drafts, or reviewed context,
who decided, and when. It never changes the files it describes.

## Layout

```text
schemas/review-lifecycle-v1.schema.json
governance/lifecycle/
├── README.md
└── records.json
```

The schema is part of the Mole release. `records.json` belongs to this
workspace. Mole creates it the first time a record is registered. `mole new`
does not seed it, and an upgrade must never replace or delete it.

## Rules

- The ledger is the authority for review state. A frontmatter field such as
  `status: active` describes a file. It does not approve it.
- A record ID is `rec_` followed by a lowercase UUIDv4. Each record points to
  one registered source by `source_id`.
- An agent may register, draft, submit, and revise. Only a human may approve,
  reject, or supersede, and the human must confirm the decision.
- Every transition appends to the record's `history`. Mole refuses a write
  that drops a record or changes an earlier history entry.
- A sentence in a report that says "approved" changes nothing. Only
  `mole lifecycle approve` records an acceptance.
- Submission binds the record to the exact file bytes. If the file changes
  afterwards, approval fails and an accepted record drops out of normal
  retrieval until someone resolves it.

## Commands

```text
mole lifecycle register <source_id> --state <state> --actor <name> --actor-type <type>
mole lifecycle submit <record_id> --actor <name> --actor-type <type> --reason <text>
mole lifecycle approve <record_id> --actor <name> --actor-type human --confirm-human --reason <text> --source <source_id>
mole lifecycle reject <record_id> --actor <name> --actor-type human --confirm-human --reason <text>
mole lifecycle supersede <record_id> --replacement <record_id> --actor <name> --actor-type human --confirm-human --reason <text>
mole lifecycle show <record_id>
mole lifecycle list [--state <state>]
mole lifecycle audit
mole lifecycle migrate [--apply --actor <name> --actor-type <type>]
mole retrieve [record_id] [--include-state <state>]
```

`audit`, `show`, `list`, `retrieve`, and `migrate` without `--apply` are
read-only.

## Editing by hand

Do not edit `records.json` by hand. Use the commands so each change has an
actor, a time, and a reason. The actor fields are declarations made by whoever
runs the command. They are not authenticated, and Mole cannot stop a person or
process with file access from editing the ledger directly. Treat the ledger as
an honest record kept by people who agree to the rules, and keep it under
version control or backup if you need to detect tampering.

## Shared folders

Mole takes a lock on the local machine for each write. That lock does not
reach other machines. If two people change the ledger before their folders
sync, the sync tool keeps a conflict copy next to `records.json`. Mole then
refuses to write or retrieve until one ledger remains. Run
`mole lifecycle audit` to list the copies. Keep every one, compare their
histories, and decide which ledger stands.

The full contract is in the Mole documentation under
`docs/review-lifecycle.md`.
