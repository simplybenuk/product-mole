# Human-input queue

This folder holds the requests agents have made for human input.

## Layout

```text
schemas/input-queue-v1.schema.json
governance/input-queue.md         # generated table, readable without a command
governance/input-queue/
├── README.md
├── requests.json                 # the queue; created by the first request
├── legacy/                       # the Markdown file as it was before migration
└── .mutation.lock                # present only while a command is writing
```

`requests.json` belongs to this workspace. An upgrade must never replace or
delete it.

## Rules

- `requests.json` is the authority. The table in `governance/input-queue.md`
  is rewritten from it after every change.
- Each request has a stable ID, `inq_` followed by a lowercase UUIDv4.
- Every change appends to the request's `history` with the actor, the time,
  the reason, and each changed field. The commands refuse a write that drops
  a request or changes an earlier history entry.
- Anyone may add a request, update it, and record an answer.
- Only a person may close a request as `duplicate`, `superseded`, `stale`, or
  `not_needed`, change its owner, defer it with no review date, or reopen a
  request a person closed. Those need `--actor-type human --confirm-human`.
- `mole review input-queue` suggests stale and duplicate requests. It never
  closes or merges anything.

## Commands

```text
mole review input-queue [--limit <n>] [--format json]
mole input-queue add --request <text> --impact <text> --unblocks <text> --actor <name> --actor-type <type>
mole input-queue update <input_id> [fields] --actor <name> --actor-type <type> --reason <text>
mole input-queue close <input_id> --answer <text> --outcome <text> --actor <name> --actor-type <type>
mole input-queue close <input_id> --closure-reason <reason> --outcome <text> --reason <text> --actor <name> --actor-type human --confirm-human
mole input-queue reopen <input_id> --actor <name> --actor-type <type> --reason <text>
mole input-queue show <input_id>
mole input-queue list [--status <status>] [--all]
mole input-queue migrate [--apply --actor <name> --actor-type <type>]
mole input-queue refresh-view
mole input-queue audit
mole input-queue unlock
```

## Editing by hand

Do not edit `requests.json` by hand. Use the commands so each change has an
actor, a time, and a reason. The actor fields are declarations made by whoever
runs the command. They are not authenticated.

A row added by hand to `governance/input-queue.md` is picked up by
`mole input-queue migrate --apply`, and the other commands refuse to write
until it is. Keep the two marker lines around the generated table as they
are.

The full contract is in the Mole documentation under `docs/input-queue.md`.
