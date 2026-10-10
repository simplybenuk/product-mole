# Review and promotion lifecycle

Mole asks people to review what agents write. The review lifecycle makes that
review a recorded fact. A draft cannot pass as accepted context, and a later
workflow can see who approved a record, when, why, and on what evidence.

The lifecycle is a JSON ledger at `governance/lifecycle/records.json`. Its
schema is `schemas/review-lifecycle-v1.schema.json`. The ledger describes
files. It never edits them.

## Records

A lifecycle record points to one registered source file by `source_id`. See
[source IDs and archive-safe provenance](source-provenance.md) for how files
get those IDs. A source has at most one lifecycle record.

| Field | Meaning |
| --- | --- |
| `record_id` | `rec_` plus a lowercase UUIDv4. It never changes. |
| `source_id` | The registered file this record describes. |
| `state` | The current lifecycle state. |
| `revision` | The number of history entries. |
| `path` | Where the file was at the last registration or submission. A hint only. |
| `content_hash`, `byte_size` | SHA-256 and size of the bytes last registered or submitted. |
| `source_ids` | Registered sources that support the record. |
| `supersedes`, `superseded_by` | Links between an accepted record and the records it replaced. |
| `decision` | The current review decision with reviewer, time, and reason. `null` before review. |
| `history` | Every transition in order. Append-only. |

Frontmatter fields such as `status: draft` or `status: active` describe a file
for human readers. They do not set or prove a lifecycle state.

## States

| State | Meaning |
| --- | --- |
| `raw` | Captured material that nobody has interpreted. |
| `evidence` | Source material kept as evidence, such as a promoted document or a signal cluster. Not reviewed as context. |
| `draft` | Working content that an agent or person may still change. |
| `pending_review` | Submitted for a human decision. The bytes are fixed for review. |
| `accepted` | A human approved these exact bytes as durable context. |
| `rejected` | A human declined the submission. |
| `superseded` | Was accepted, then replaced by another accepted record. |
| `unreviewed` | A file that existed before the lifecycle. Nobody has reviewed it under these rules. |

`unreviewed` is the one state beyond the list in the original design. It lets
a migration register old files without guessing whether anyone approved them.

## Transitions

| Action | From | To | Who |
| --- | --- | --- | --- |
| `register` | no record | `raw`, `evidence`, `draft`, `unreviewed` | anyone |
| `evidence` | `raw`, `unreviewed` | `evidence` | anyone |
| `draft` | `raw`, `evidence`, `unreviewed` | `draft` | anyone |
| `submit` | `draft`, `unreviewed` | `pending_review` | anyone |
| `revise` | `pending_review`, `rejected` | `draft` | anyone |
| `approve` | `pending_review` | `accepted` | human, confirmed |
| `reject` | `pending_review` | `rejected` | human, confirmed |
| `supersede` | `accepted` | `superseded` | human, confirmed |

Any other move fails and leaves the record unchanged. Registration cannot
create a `pending_review`, `accepted`, `rejected`, or `superseded` record, so
there is no way to skip the review.

Every transition needs an actor name, an actor type, and a reason.

- `human` is a person acting in their own name.
- `agent` is an AI assistant.
- `automation` is Mole tooling, such as `mole create` or a capture.

An accepted record has no direct edit path. To correct it, register the new
version as a draft, take it through review, and supersede the old record.

## Human decisions

`approve`, `reject`, and `supersede` require `--actor-type human` and
`--confirm-human`. If either is missing, the command fails with exit code 1
and the record keeps its state. An agent that tries to approve its own draft
gets a refusal, and the draft stays pending.

```bash
mole lifecycle approve rec_... \
  --actor "Sam Reviewer" --actor-type human --confirm-human \
  --reason "Matches the three onboarding interviews" \
  --source src_...
```

Approval also needs:

- at least one supporting source ID that the source registry knows, other than
  the record's own source. Pass it with `--source` at registration, submission,
  or approval.
- the file to hold the same bytes that were submitted.

The decision stores the reviewer, the time, and the reason, and the same facts
go into the history entry.

Text in a document never counts as a decision. A report that says "approved by
the product lead" changes nothing until that person runs `approve`.

### What the actor fields do not prove

The actor name and type are declarations by whoever runs the command. Mole does
not authenticate them. A process with access to the workspace can pass
`--actor-type human --confirm-human`, or edit the JSON file. The rule works as
an operating contract. Agents follow their instructions and never run the human
commands, and the history shows what each actor claimed. If you need to detect
tampering, keep the workspace in version control and review changes to
`governance/lifecycle/records.json`.

## Content binding

`submit` hashes the file and stores the SHA-256 in the record. From then on:

- `approve` fails with `CONTENT_CHANGED` if the file differs from the submitted
  bytes. Run `revise`, then `submit` again so the review covers the new text.
- An accepted record whose file changes is excluded from normal retrieval, and
  `mole lifecycle audit` reports `accepted_content_changed`. Restore the
  accepted bytes, or register the new version as its own draft and supersede
  the old record.

Drafts change after `mole create` registers them, so their bytes stop matching
the source registry. `submit` records that change as an explicit source
correction with the submitter and reason. The registry hash then matches the
reviewed bytes, and the registry can still find the file by hash after an
archive move. Transitions never write to the reviewed file itself.

Use `--expect-revision <n>` on any transition to make it fail if the record
has moved on since you looked at it. A reviewer who read revision 4 can approve
with `--expect-revision 4` and be sure nobody resubmitted in between.

## Supersession

To replace accepted context, approve the new record and name the old one.

```bash
mole lifecycle approve rec_new... --supersedes rec_old... \
  --actor "Sam Reviewer" --actor-type human --confirm-human \
  --reason "Q4 pricing replaces Q3" --source src_...
```

Both records change in one ledger write. The new record becomes `accepted` and
lists the old one in `supersedes`. The old record becomes `superseded` and
points back through `superseded_by`. Each keeps its full history.

If both records are already accepted, link them afterwards.

```bash
mole lifecycle supersede rec_old... --replacement rec_new... \
  --actor "Sam Reviewer" --actor-type human --confirm-human \
  --reason "Duplicate of the newer decision"
```

Mole refuses a replacement that is not accepted, a record that would supersede
itself, and a record that is already superseded. A record cannot be withdrawn
without a replacement in this version.

## Retrieval

`mole retrieve` is the way to ask what a workflow may rely on.

```bash
mole retrieve                                 # list accepted records
mole retrieve rec_...                         # print one accepted record's file
mole retrieve --include-state pending_review  # also list pending records
mole retrieve rec_... --include-state draft --format json
```

Only `accepted` records come back unless the caller names more states. That
holds for a direct request by ID too. Asking for a pending or rejected record
without `--include-state` fails with `NOT_ELIGIBLE`.

The list shows how many records sit in states that were not included, so a
reader knows more material exists without seeing it. Records whose file no
longer matches appear under `excluded` with a reason, and the command exits
with code 1.

Files with no lifecycle record are untracked. Retrieval does not return them.
Routing guidance in `0-bootstrap/` and `1-routing/` and the templates are Mole
instructions, not reviewed product context, and agents read them directly.

## Existing workspaces

An upgraded workspace has files that predate the lifecycle. Nothing marks them
as accepted, and nothing will do so without a human decision.

```bash
mole lifecycle migrate
mole lifecycle migrate --apply --actor "Sam Reviewer" --actor-type human
```

The first command is a dry run. It lists files in `2-summaries/`, `3-indexes/`,
`4-context/`, and `5-evidence/` that have no lifecycle record, and it changes
nothing. `--apply` registers each of them as `unreviewed`. A file without a
source record gets one first. The file bytes do not change.

Migration reads a legacy `status:` field only to show it in the report. A file
that says `status: active`, or whose text says someone approved it, still
becomes `unreviewed`. To accept such a file, run `submit` and then have a
person run `approve`.

Migration skips `README.md` files, symlinks, and sync conflict copies. It also
skips a file whose frontmatter names a `source_id` that the registry does not
place at that path, because a second ID would give one file two identities.
Fix those with the `mole source` commands and run the migration again.

Captures in `6-raw/` made before the upgrade are not scanned. Register one
with `mole lifecycle register <source_id> --state raw` when a workflow needs
it tracked.

## Audit and recovery

`mole lifecycle audit` is read-only and safe to run at any time, including on
a damaged ledger. It exits with code 1 when it has findings.

| Finding | What to do |
| --- | --- |
| `invalid_ledger` | The JSON or its history rules are broken. Restore the ledger from a retained copy. |
| `ledger_conflict_copy` | A sync tool left a second ledger. Keep every copy, compare them, and leave one. |
| `accepted_content_changed` | Restore the accepted bytes, or review the new version and supersede. |
| `pending_content_changed` | Run `revise`, then `submit` again. |
| `source_record_missing`, `source_record_invalid`, `source_unresolved`, `unsafe_path`, `no_local_file` | The record's file cannot be found or trusted. Recover or reconcile the source with `mole source resolve` and `mole source reconcile`. |
| `supporting_source_missing` | Recover the source record that the acceptance cites. |
| `stale_mutation_lock` | Run `mole lifecycle unlock`. |
| `stale_temp_file` | An interrupted write left a temporary file. Remove it once no command is running. |
| `unexpected_entry` | Move the unrelated file out of `governance/lifecycle/`. |

While the ledger is invalid or has a conflict copy, every command except
`audit` and `unlock` fails. Mole will not guess which history is correct, and it will not
return context from a ledger it cannot trust.

### Writes and locks

Each write takes a lock file in the operating system's temporary folder,
validates the whole ledger, checks that no earlier history entry changed, and
replaces `records.json` with one atomic rename. A second command waits up to
two seconds for the first, then fails with `LIFECYCLE_BUSY`.

If a command is killed during a write, its lock stays behind. Mole never
removes another process's lock on its own. Run `mole lifecycle unlock`. It
removes the lock only when the process that took it has stopped.

### Shared folders

The lock is local to one machine. Two machines that write before their folders
sync will both succeed locally, and the sync tool will keep one ledger and a
conflict copy. Mole detects that copy and stops until a person reconciles the
two. It does not merge ledgers. Teams that review often on several machines
should agree who records decisions, or keep the workspace in version control,
where a merge conflict shows the same problem earlier.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The command succeeded. |
| 1 | Mole refused the operation, or an audit, migration, or retrieval reported findings. |
| 2 | The arguments were invalid, such as an unknown flag or a missing value. |

Add `--format json` to any lifecycle or retrieve command for machine-readable
output. A refusal prints `{ "ok": false, "error": { "code", "message",
"details" } }`.

## Library

`lib/review-lifecycle.mjs` exposes the same operations as synchronous
functions that take the workspace root first.

```js
registerLifecycleRecord(root, { sourceId, state, actor, actorType, sourceIds, reason, now })
transitionLifecycleRecord(root, recordId, {
  action, actor, actorType, humanConfirmed, reason,
  sourceIds, removeSourceIds, supersedes, replacementId, expectedRevision, now
})
readLifecycleRecord(root, recordId)
listLifecycleRecords(root, { states })
retrieveLifecycleRecords(root, { includeStates })
retrieveLifecycleRecord(root, recordId, { includeStates })
auditLifecycle(root)
migrateLifecycleRecords(root, { apply, actor, actorType, now })
unlockLifecycle(root)
validateLifecycleLedger(ledger)
```

A refused operation throws a `LifecycleError` with a `code` and `details`.
`LIFECYCLE_TRANSITIONS` holds the transition table above, so other features
such as travel logs and evidence promotion can check a move before they try
it.
