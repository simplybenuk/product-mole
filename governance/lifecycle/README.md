# Review lifecycle

This folder holds the review ledger for the workspace. The ledger records
which registered files are raw material, evidence, drafts, or reviewed context,
who decided, and when. It never changes the files it describes.

## Layout

```text
schemas/review-lifecycle-v1.schema.json
governance/lifecycle/
├── README.md
├── records.json
└── .mutation.lock      # present only while a command is writing
```

The schema is part of the Mole release. `records.json` belongs to this
workspace. Mole creates it the first time a record is registered. `mole new`
does not seed it, and an upgrade must never replace or delete it.

## Rules

- The ledger is the authority for review state. A frontmatter field such as
  `status: active` describes a file. It does not approve it.
- A record ID is `rec_` followed by a lowercase UUIDv4. Each record points to
  one registered source by `source_id`, and one file backs one source.
- An agent may register, draft, submit, revise, relocate, and withdraw
  material that was never accepted. Only a human may approve, reject,
  supersede, or withdraw a record that is or was accepted, and the human must
  confirm the decision.
- Every transition appends to the record's `history`. The commands refuse a
  write that drops a record or changes an earlier history entry.
- A sentence in a report that says "approved" changes nothing. Only
  `mole lifecycle approve` records an acceptance.
- Submission binds the record to the exact file bytes. If the file changes
  afterwards, approval fails and an accepted record drops out of normal
  retrieval until someone resolves it.

## Commands

```text
mole lifecycle register <source_id> --state <state> --actor <name> --actor-type <type>
mole lifecycle evidence <record_id> --actor <name> --actor-type <type> --reason <text>
mole lifecycle draft <record_id> --actor <name> --actor-type <type> --reason <text>
mole lifecycle submit <record_id> --actor <name> --actor-type <type> --reason <text>
mole lifecycle revise <record_id> --actor <name> --actor-type <type> --reason <text>
mole lifecycle approve <record_id> --actor <name> --actor-type human --confirm-human --reason <text> --source <source_id> --expect-revision <n>
mole lifecycle reject <record_id> --actor <name> --actor-type human --confirm-human --reason <text>
mole lifecycle supersede <record_id> --replacement <record_id> --actor <name> --actor-type human --confirm-human --reason <text>
mole lifecycle relocate <record_id> --path <path> --actor <name> --actor-type <type> --reason <text>
mole lifecycle withdraw <record_id> --actor <name> --actor-type <type> --reason <text>
mole lifecycle show <record_id>
mole lifecycle list [--state <state>] [--path <path>]
mole lifecycle audit
mole lifecycle migrate [--apply --actor <name> --actor-type <type>]
mole lifecycle unlock
mole retrieve [record_id] [--include-state <state>]
```

`audit`, `show`, `list`, `retrieve`, and `migrate` without `--apply` are
read-only.

## When a file moves or goes away

- An unchanged file that moved, such as an archived capture, is found by its
  registered hash. Nothing to do. `mole lifecycle relocate` stores the new
  path for any open record.
- One file backs one open record. Find the record for a file with
  `mole lifecycle list --path <path>` before registering it again.
- A draft that was renamed and edited needs
  `mole lifecycle relocate <record_id> --path <new path>`.
- A record whose file was deleted needs `mole lifecycle withdraw <record_id>`.
- An accepted file that was edited in place needs `mole lifecycle revise` and
  `submit`, then a new approval.
- A superseded or withdrawn record does not hold its old path. A new file
  there is a new source.
- `mole lifecycle audit` names the command for each record it reports.

## Editing by hand

Do not edit `records.json` by hand. Use the commands so each change has an
actor, a time, and a reason. The actor fields are declarations made by whoever
runs the command. They are not authenticated, and Mole cannot stop a person or
process with file access from passing the human flags or editing the ledger
directly. A consistent hand edit passes validation. Keep the workspace under
version control or backup if you need to detect that.

## Shared folders

Mole takes `.mutation.lock` in this folder for each write. On one machine, or
on a network drive that several machines mount, that stops two commands from
writing at once. A synced folder is different, because each machine has its own
copy. If two people change the ledger before their folders sync, the sync tool
keeps a conflict copy next to `records.json`. Mole then refuses to write or
retrieve until one ledger remains. Run `mole lifecycle audit` to list the
copies. Keep every one, compare their histories, and decide which ledger
stands.

If a sync tool copies a lock file from another machine, Mole treats it as live
for five minutes. After that, `mole lifecycle unlock` removes it. Exclude
`.mutation.lock` from sync if your tool allows it.

The full contract is in the Mole documentation under
`docs/review-lifecycle.md`.
