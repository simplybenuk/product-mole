# Review and promotion lifecycle

Mole asks people to review what agents write. The review lifecycle makes that
review a recorded fact. A draft cannot pass as accepted context through the
Mole commands, and a later workflow can see who approved a record, when, why,
and on what evidence.

The lifecycle is a JSON ledger at `governance/lifecycle/records.json`. Its
schema is `schemas/review-lifecycle-v1.schema.json`. The ledger describes
files. It never edits them.

## Records

A lifecycle record points to one registered source file by `source_id`. See
[source IDs and archive-safe provenance](source-provenance.md) for how files
get those IDs. A source has at most one lifecycle record, and one file backs at
most one source.

| Field | Meaning |
| --- | --- |
| `record_id` | `rec_` plus a lowercase UUIDv4. It never changes. |
| `source_id` | The registered file this record describes. |
| `state` | The current lifecycle state. |
| `revision` | The number of history entries. |
| `path` | Where the file was at the last registration, submission, or relocation. A hint only. |
| `content_hash`, `byte_size` | SHA-256 and size of the bytes last registered, submitted, or relocated. |
| `source_ids` | Registered sources that support the record. |
| `supersedes`, `superseded_by` | Links between an accepted record and the records it replaced. |
| `decision` | The current review decision with reviewer, time, and reason. `null` unless the record is accepted, rejected, or superseded. |
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
| `withdrawn` | Closed without a replacement. The file may be gone. Nothing leaves this state. |

`unreviewed` and `withdrawn` are additions to the list in the original design.
`unreviewed` lets a migration register old files without guessing whether
anyone approved them. `withdrawn` closes a record whose file was deleted or
abandoned, and lets a person retire accepted context that has no successor.

## Transitions

| Action | From | To | Who |
| --- | --- | --- | --- |
| `register` | no record | `raw`, `evidence`, `draft`, `unreviewed` | anyone |
| `evidence` | `raw`, `unreviewed` | `evidence` | anyone |
| `draft` | `raw`, `evidence`, `unreviewed` | `draft` | anyone |
| `submit` | `draft`, `unreviewed` | `pending_review` | anyone |
| `revise` | `pending_review`, `rejected` | `draft` | anyone |
| `revise` | `accepted`, file edited since approval | `draft` | anyone |
| `revise` | `accepted`, file unchanged | `draft` | human, confirmed |
| `approve` | `pending_review` | `accepted` | human, confirmed |
| `reject` | `pending_review` | `rejected` | human, confirmed |
| `supersede` | `accepted` | `superseded` | human, confirmed |
| `withdraw` | `raw`, `evidence`, `draft`, `pending_review`, `rejected`, `unreviewed`, never accepted | `withdrawn` | anyone |
| `withdraw` | `accepted`, or any record that was accepted before | `withdrawn` | human, confirmed |
| `relocate` to a file that was also edited | `draft`, `unreviewed`, `rejected` | same state | anyone |
| `relocate` to a file with unchanged bytes | any state except `superseded` and `withdrawn` | same state | anyone |

Any other move fails and leaves the record unchanged. Registration cannot
create a `pending_review`, `accepted`, `rejected`, `superseded`, or `withdrawn`
record, so the commands offer no way to skip the review. Every action that
enters `accepted` needs a confirmed human. So does every action that takes
valid accepted context away. The one exception is `revise` on an accepted
record whose file was already edited. That file has already dropped out of
retrieval, so sending it back to review takes nothing away. A record that was
accepted once still needs a person to withdraw it, even after such a revise.

Every transition needs an actor name, an actor type, and a reason.

- `human` is a person acting in their own name.
- `agent` is an AI assistant.
- `automation` is Mole tooling, such as `mole create` or a capture.

An accepted record is never edited through the ledger. There are two ways to
change accepted context, described under
[changing accepted context](#changing-accepted-context).

## Human decisions

`approve`, `reject`, `supersede`, `withdraw` on a record that is or was
accepted, and `revise` on an accepted record whose file is unchanged require
`--actor-type human` and `--confirm-human`. If either is missing, the command
fails with exit code 1 and the record keeps its state. An agent that tries to
approve its own draft gets a refusal, and the draft stays pending.

```bash
mole retrieve rec_... --include-state pending_review
mole lifecycle approve rec_... \
  --actor "Sam Reviewer" --actor-type human --confirm-human \
  --reason "Matches the three onboarding interviews" \
  --source src_... --expect-revision 2
```

The `approve` command requires `--expect-revision <n>`. The reviewer reads the
submission with `mole retrieve`, which prints its revision, and passes that
number. If an agent revised and resubmitted in the meantime, the revision no
longer matches and the approval fails with `REVISION_CONFLICT`. A person
cannot accept text they did not read by accident. The library function leaves
`expectedRevision` optional for callers that enforce this another way.

Approval also needs:

- at least one supporting source ID that the source registry knows, other than
  the record's own source. Pass it with `--source` at registration, submission,
  or approval. The source of a rejected record does not count, and neither
  does the source of a record withdrawn as a `draft`, `pending_review`,
  `unreviewed`, or accepted record. A capture withdrawn while it was `raw` or
  `evidence` still counts: its content was real evidence and only the file
  was cleaned up.
- the file to hold the same bytes that were submitted.

When a cited source does not count, the approval fails with
`INVALID_SUPPORTING_SOURCE`. The message lists every such source with its
record, and the command that removes them:

```bash
mole lifecycle revise rec_... --remove-source src_... --actor "Agent" --actor-type agent --reason "Drop stale citation"
mole lifecycle submit rec_... --actor "Agent" --actor-type agent --reason "Ready for review"
```

Then approve with a source that still counts.

The decision stores the reviewer, the time, and the reason, and the same facts
go into the history entry.

Text in a document never counts as a decision. A report that says "approved by
the product lead" changes nothing until that person runs `approve`.

### What the actor fields do not prove

The actor name and type are declarations by whoever runs the command. Mole does
not authenticate them. A process with access to the workspace can pass
`--actor-type human --confirm-human`, and Mole cannot tell that from a person
typing the same flags. The same process can edit the JSON file. Mole checks a
hand-edited ledger for consistency, so a state without a matching history entry
is refused, but a consistent forgery passes.

The rule is an operating contract backed by a record. Agents follow their
instructions and never run the human commands, the commands refuse an honest
agent declaration, and the history shows what each actor claimed. If you need
to detect a false claim or a hand edit, keep the workspace in version control
and review changes to `governance/lifecycle/records.json`.

## Content binding

`submit` hashes the file and stores the SHA-256 in the record. From then on:

- `approve` fails with `CONTENT_CHANGED` if the file differs from the submitted
  bytes. Run `revise`, then `submit` again so the review covers the new text.
- An accepted record whose file changes is excluded from normal retrieval, and
  `mole lifecycle audit` reports `accepted_content_changed`. Restore the
  accepted bytes, or run `revise` and `submit` so a person reviews the new
  version.

Drafts change after `mole create` registers them, so their bytes stop matching
the source registry. `submit` records that change as an explicit source
correction with the submitter and reason. The registry hash then matches the
reviewed bytes, and Mole can still find the file by hash after an archive move.
Transitions never write to the reviewed file itself.

`--expect-revision <n>` makes any transition fail if the record has moved on
since you looked at it. `approve` requires it. It is optional elsewhere.

## Changing accepted context

Accepted context changes in one of two ways. Both end with a human approval.

**The same file, edited in place.** This suits living files such as
`4-context/personas.md`, summaries, and indexes, which agents refresh
routinely. The edit itself takes the file out of retrieval, because its bytes
no longer match the approval. Then:

```bash
mole lifecycle revise rec_... --actor "Agent" --actor-type agent --reason "Refreshed from the inbox"
mole lifecycle submit rec_... --actor "Agent" --actor-type agent --reason "Ready for review"
mole lifecycle approve rec_... --actor "Sam Reviewer" --actor-type human --confirm-human \
  --reason "New persona matches the interviews" --expect-revision 5
```

The record keeps its ID and its whole history, including the earlier approval.
The earlier text is not kept by Mole. Use version control if you need it.
Between the edit and the new approval the file is not accepted context, and
`mole retrieve` does not return it.

**A separate new file.** Create the new file, take it through review, and
approve it with `--supersedes` naming the old record, as shown under
[supersession](#supersession). Both versions stay on disk and both records
keep their history.

A person can also run `revise` on an accepted record whose file has not
changed, to reopen it for review. An agent cannot, because that would take
valid context away from readers.

## Files that move, change, or disappear

The source registry stores paths. A record's file is the one at its source's
registered path. A path belongs to the one open record whose source is
registered there. A source with no lifecycle record owns nothing, and neither
does the source of a superseded or withdrawn record. Mole handles the common
cases this way.

| What happened | What Mole does | What you do |
| --- | --- | --- |
| The file moved and its bytes are unchanged, such as an archived capture | Finds it by its registered hash, if exactly one unclaimed file has those bytes | Nothing. Run `mole lifecycle relocate <record_id> --path <new path>` to store the new path when convenient. |
| A draft was renamed and edited | Cannot match it by hash. `submit` fails and audit reports `source_unresolved`. | `mole lifecycle relocate <record_id> --path <new path>` |
| The file was deleted or abandoned | Audit reports `source_unresolved`. | `mole lifecycle withdraw <record_id>` |
| Two unclaimed copies hold a moved file's bytes | Refuses to guess. Audit lists both under `candidate_paths`. | `mole lifecycle relocate <record_id> --path <path>` |
| A file that already has an open record is registered as a source again | Refuses a second lifecycle record and names the existing one. The existing record keeps working, and audit stays clean. | Use the existing record. Find it with `mole lifecycle list --path <path>`. |
| A new file is written at a path an open record still owns | Refuses a lifecycle record for the new file, and `mole create` refuses to write there. | Relocate the existing record to where its file went, or withdraw it if that file is gone. |
| A new file appears at the old path of a superseded or withdrawn record | Treats the new file as untracked. When it is registered, Mole clears the closed record's stored path. | Register the new file, or run `mole lifecycle migrate --apply`. |

`relocate` records the new path in the source registry. It does not move or
edit the file. A `draft`, `unreviewed`, or `rejected` record may point at a
file that was also edited, and the new bytes are recorded too. Raw, evidence,
pending, and accepted material may move but not change, so `relocate` accepts
only a file that still holds the record's bytes. Revise a pending record
before relocating it to an edited file. Use `relocate` rather than
`mole source reconcile` for a file with a lifecycle record, because it also
clears the stored path of a superseded or withdrawn record that used to live
there.

If a new file is written at an open record's path and that record is then
submitted, the reviewer is shown the new file, and approving it accepts what
they read. Mole cannot tell a replaced file from an edited one. When another
source is registered at the same path, `submit` prints a note asking the
submitter to check which file the record describes.

`mole create` refuses to write a draft at a path that an open record still
owns. That stops a new template from taking the place of a
draft that was renamed, which could otherwise be submitted and approved under
the old record. The refusal names the command that frees the path. A
superseded or withdrawn record does not hold its path, so deleting a draft,
withdrawing its record, and running `mole create` again works.

Agent guidance tells agents to remove or archive an inbox copy after promoting
it. An archived copy keeps working. Withdraw the record of a copy you delete.
A draft that cites the deleted capture can still be approved, because a
capture withdrawn as `raw` or `evidence` keeps counting as support.

## Supersession

To replace accepted context, approve the new record and name the old one.

```bash
mole lifecycle approve rec_new... --supersedes rec_old... \
  --actor "Sam Reviewer" --actor-type human --confirm-human \
  --reason "Q4 pricing replaces Q3" --source src_... --expect-revision 2
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

Mole refuses a replacement that is not accepted or whose file no longer
matches its accepted bytes, a record that would supersede itself, and a record
that is already superseded. To retire accepted context with no successor, a
person runs `withdraw`.

## Retrieval

`mole retrieve` is the way to ask what a workflow may rely on.

```bash
mole retrieve
mole retrieve rec_...
mole retrieve --include-state pending_review
mole retrieve rec_... --include-state draft --format json
```

The first form lists accepted records. The second prints one accepted record's
file. Only `accepted` records come back unless the caller names more states
with `--include-state`. That holds for a direct request by ID too. Asking for a
pending or rejected record without the flag fails with `NOT_ELIGIBLE`.

The list shows how many records sit in states that were not included, so a
reader knows more material exists without seeing it. Records whose file is
missing or no longer matches appear under `excluded` with a reason, and the
command exits with code 1.

Files with no lifecycle record are untracked. Retrieval does not return them.
Routing guidance in `0-bootstrap/` and `1-routing/` and the templates are Mole
instructions, not reviewed product context, and agents read them directly.

Retrieval governs what the commands return. An agent can still open any file
in the workspace, so the agent rules in `0-bootstrap/agents.md` tell it to
check `mole retrieve` first.

## Existing workspaces

An upgraded workspace has files that predate the lifecycle. Nothing marks them
as accepted, and nothing will do so without a human decision.

```bash
mole lifecycle migrate
mole lifecycle migrate --apply --actor "Sam Reviewer" --actor-type human
```

The first command is a dry run. It lists files in `2-summaries/`, `3-indexes/`,
`4-context/`, `5-evidence/`, and `6-raw/` that have no lifecycle record, and it
changes nothing. `--apply` registers files under `6-raw/` as `raw` and every
other file as `unreviewed`. A file without a source record gets one first. The
file bytes do not change.

Migration reads a legacy `status:` field only to show it in the report. A file
that says `status: active`, or whose text says someone approved it, still
becomes `unreviewed`. To accept such a file, run `submit` and then have a
person run `approve`.

A registered file that moved without a reconcile keeps its source ID. Migration
matches it to the registered source whose path is empty and whose hash equals
the file's bytes. It never gives one file a second identity.

The file at the registered path of an open lifecycle record is not reported
as a `source_id_mismatch`, whatever `source_id` its frontmatter names. A
tracked file that moved without a reconcile is matched to its record only
while its bytes are unchanged and its old path is empty. Otherwise migration
treats the file at the new path like any other file without a record.

A copy can keep the `source_id:` frontmatter of the file it was copied from,
such as a capture copied into `5-evidence/` and then edited. Migration treats
the copy as an ordinary untracked file when it can account for the original:
it matched the original as a moved file, or the file at the registered path
still holds the source's bytes or names the source in its own frontmatter.
The dry run names the frontmatter ID next to the copy, and the record's first
history entry keeps it. Otherwise migration reports the file, because it may
be the original after a move.

Migration skips `README.md` files, symlinks, and sync conflict copies without
a finding. It skips these with a finding, and exits 1:

- `source_id_mismatch`: a file that migration cannot match to a source by
  its path or its bytes, and whose frontmatter names a `source_id` that
  migration cannot place at another scanned file. The finding prints `mole
  source register <path>`, which tracks the file as its own source and clears
  the finding. When the file holds the named source's bytes, it also prints
  `mole source reconcile`, which keeps the file's identity instead. When the
  named source has an open record and no file at its registered path, it
  also points to `mole lifecycle audit`.
- `ambiguous_source`: a file that could belong to more than one moved source,
  or a moved source that matches more than one file. Follow the step the
  finding prints.

Then run the migration again.

Running the migration again is safe. It is also the way to backfill a capture
that was saved while the ledger could not be written.

## Captures and drafts when the ledger is unavailable

A capture must never be lost or duplicated because of a ledger problem. If the
ledger is invalid, in conflict, or locked when `mole insight` runs, the capture
and its source record are still written, the command exits 0, and a warning on
standard error says the note has no lifecycle record yet. The UI returns the
same warning with a 200 response. Do not capture the note again. Fix the
ledger, then run `mole lifecycle migrate --apply`.

`mole create` checks the ledger before it writes anything. If the draft could
not be tracked, it refuses and writes nothing.

## Audit and recovery

`mole lifecycle audit` is read-only and safe to run at any time, including on
a damaged ledger. It exits with code 1 when it has findings. It does not check
superseded or withdrawn records for a missing file.

| Finding | What to do |
| --- | --- |
| `invalid_ledger` | The JSON or its history rules are broken. Restore the ledger from a retained copy. |
| `ledger_conflict_copy` | A sync tool left a second ledger. Keep every copy, compare them, and leave one. |
| `accepted_content_changed` | Restore the accepted bytes, or run `revise` and `submit` so a person reviews the new version. |
| `pending_content_changed` | Run `revise`, then `submit` again. |
| `source_unresolved` | The file was renamed and edited, or deleted. Run `relocate` or `withdraw` as the finding advises. |
| `path_claim_conflict` | Two open records point at one file. The commands do not create this state. Relocate the record whose file moved, or withdraw the one that should not own the file. |
| `source_record_missing`, `source_record_invalid`, `unsafe_path`, `no_local_file` | The source record is gone or untrusted. Recover it with the `mole source` commands, or withdraw the record. |
| `supporting_source_missing` | Recover the source record that the acceptance cites. |
| `stale_mutation_lock` | Run `mole lifecycle unlock`. |
| `stale_temp_file` | An interrupted write left a temporary file. Remove it once no command is running. |
| `unexpected_entry` | Move the unrelated file out of `governance/lifecycle/`. |

While the ledger is invalid or has a conflict copy, every command except
`audit` and `unlock` fails. Mole will not guess which history is correct, and
it will not return context from a ledger it cannot trust.

The audit checks the ledger against its own rules and against the files. It
cannot tell that someone edited an earlier history entry by hand if the result
is still consistent. Use version control for that.

### Writes and locks

Each write takes the lock file `governance/lifecycle/.mutation.lock`, validates
the whole ledger, checks that the write keeps every earlier history entry, and
replaces `records.json` with one atomic rename. The lock sits beside the ledger
so every process that can write the ledger sees it, whatever its temporary
folder or user account. A second command waits up to ten seconds for the
first, then fails with `LIFECYCLE_BUSY`.

If a command is killed during a write, its lock stays behind. Mole never
removes another process's lock on its own. Run `mole lifecycle unlock`. It
removes the lock only when the process that took it has stopped.

### Shared folders

The lock gives real mutual exclusion on one machine and on a network drive
that several machines mount. A folder synced by OneDrive, Dropbox, Google
Drive, or a similar tool is different. Each machine has its own copy, so two
machines can both write before they sync. The sync tool then keeps one ledger
and a conflict copy. Mole detects that copy and stops until a person reconciles
the two. It does not merge ledgers.

A sync tool may also copy the lock file to another machine for a moment. Mole
cannot check a process on another host, so it treats such a lock as live for
five minutes. After that, audit reports it and `mole lifecycle unlock` removes
it. Exclude `.mutation.lock` from sync if your tool allows it.

Teams that review often on several machines should agree who records
decisions, or keep the workspace in version control, where a merge conflict
shows the same problem earlier.

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
relocateLifecycleRecord(root, recordId, { path, actor, actorType, reason, expectedRevision, now })
readLifecycleRecord(root, recordId)
listLifecycleRecords(root, { states })
retrieveLifecycleRecords(root, { includeStates })
retrieveLifecycleRecord(root, recordId, { includeStates })
auditLifecycle(root)
migrateLifecycleRecords(root, { apply, actor, actorType, now })
assertLifecycleWritable(root)
findPathClaims(root, path)
unlockLifecycle(root)
validateLifecycleLedger(ledger)
```

A refused operation throws a `LifecycleError` with a `code` and `details`.
`LIFECYCLE_TRANSITIONS` holds the transition table above and
`transitionRequiresHuman(action, fromState)` answers the human question, so
other features such as travel logs and evidence promotion can check a move
before they try it.

## Limits

- Actor fields are declarations. Mole does not authenticate a human.
- The ledger is not tamper-evident. A consistent hand edit passes validation.
- Synced folders can produce a conflict copy that a person must reconcile.
- If `records.json` is deleted, Mole sees an empty ledger and reports no
  finding. Nothing unreviewed is returned as accepted, but the history is
  gone. Keep the ledger in version control or backup.
- Mole does not keep earlier versions of a file that is edited in place.
- An accepted file that was renamed and edited cannot be revised under its
  record. A person withdraws the record and the new file starts as a draft.
- Retrieval rules apply to the Mole commands. They do not stop a tool from
  reading a file directly.
- Every write validates and rewrites the whole ledger and reads each source
  record once, so cost grows with the workspace. An independent review
  measured about 0.5 s per capture and 1.4 to 2.0 s per audit at 3,000
  records, and about 1 s and 3.6 to 6.4 s at 10,000. Under heavy parallel
  capture at that size, a capture that waits longer than ten seconds for the
  lock is saved with a warning and backfilled by `mole lifecycle migrate
  --apply`.
