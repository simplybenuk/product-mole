# Operational safety acceptance

Run `npm test` from the package root. The connected scenarios live in
`lib/test/operational-acceptance.test.mjs`; run that file alone with
`node --test lib/test/operational-acceptance.test.mjs` while investigating a failure.
Each scenario creates and removes its own temporary workspace. Human declarations
simulate decisions only in these disposable fixtures. They authorize no real
approval, rejection, queue cleanup or retention deletion.

## Worked flow

Start a new workspace, run `mole doctor`, then capture through `mole insight`
or the UI. Check the privacy outcome before reading or promoting input.
`no_rule_match` is a rule result, not a certification. Quarantine requires a
separately reviewed derivative; it is not accepted context.

Run `mole validate` and `mole inbox audit` before synthesis. Claim the intended
paths, retain the run ID, and checkpoint after each safely written output.
Heartbeat and resume the same owned run while its lease remains active. A
foreign owner, expired lease or sync conflict requires recovery before work
continues. Preserve the source copies.

Write a draft that cites stable source IDs. Submit it, then let a person
review it. Default retrieval must exclude raw and pending content. Approval
records a learning decision; processing a file alone does not. Keep a retrieval
receipt before completing the run. Retry the same completion payload rather
than inventing a new run to get around an error.

After completion, preview a managed archive with `mole privacy archive <source-id>`.
Apply it explicitly with `mole privacy archive <source-id> --apply`. This moves
only from `6-raw/inbox/<source-id>.md` to
`6-raw/inbox/archive/<source-id>.md`, preserving the source ID, cleaned bytes and
original expiry. It updates the privacy manifest and source path history. It
does not accept the raw capture or its draft output. Use this operation instead
of moving managed captures by hand. The archive remains covered by duplicate
checks and explicit retention purge.

Use `mole review input-queue` to choose the next request. Recording an answer
needs both the answer and its outcome. Closing an unanswered request as stale,
duplicate or unnecessary requires an explicit human decision. Review suggestions
do not close requests.

Run retention dry-run first. Invoke apply only under the workspace's retention
policy, with processors stopped and sync conflicts resolved. The tests advance
the purge clock only inside temporary fixtures. Retained source IDs, cleaned
fingerprints, receipts and accepted findings are provenance, not copies of the
deleted original. Run the source/lifecycle audits afterward; a deleted raw source
can legitimately be unresolved and its ledger is not automatically rewritten.

## Acceptance mapping

The test names below identify executable assertions, not a report of a particular
run. A passing result applies only to the checked revision and environment.

| Contract | Executable evidence |
| --- | --- |
| Empty new workspace; CLI and UI capture privacy; owned checkpoint and resume across a fresh CLI process | `operational flow` checks the scaffold, doctor, redacted captures and persisted checkpoint |
| Human-only acceptance; accepted-only retrieval; processing distinct from learning | `operational flow` refuses agent approval, hides pending output, simulates fixture review, then checks accepted retrieval and separate metric counts |
| Queue ranking and closure | `operational flow` ranks a blocking high-priority request, refuses agent dismissal, records an answer and verifies the next request |
| Retry without added receipts or metrics | `operational flow` snapshots the completed workspace before an identical retry; `ambiguity blocks completion` rejects a new run for repeated input |
| Ambiguous ownership and sync state | `ambiguity blocks completion` preserves lock/source bytes on foreign-owner and conflict refusal, then resumes after removal of the test-injected conflict |
| Managed archive with stable identity and retention | `managed archive retains identity` completes a real owned run, checks archive dry-run and CLI apply, preserves ID/bytes/fingerprint/expiry and raw lifecycle state, refuses a copied observation, retries the original receipt before/after purge, and checks deletion of the archived raw file with retained provenance |
| Unmanaged move refusal and supported recovery | `unmanaged archive discovery` resolves a manually moved source by ID, refuses privacy processing and purge for its arbitrary path, restores the canonical inbox path without changing ID, expiry or fingerprint, and releases a reviewed quarantine derivative under its original ID |
| Read-only validation | `validation finds operational damage` requires text/JSON findings for a broken source reference, invalid/missing metadata, stale summary, malformed lock and overdue queue; full tree snapshots include file bytes, modes and modification times |
| Explicit purge and retained provenance | `operational flow` proves dry-run changes nothing, applies expiry only to temporary captures, checks tombstones, retained IDs, absent synthetic email and continued accepted retrieval |
| Privacy gate before duplicate reads/hashes; attachments, edited or expired inputs; cleaned fingerprint retention | `lib/test/inbox-privacy-integration.test.mjs` exercises the integration boundary, including a hash interception assertion |
| Duplicate decisions and capture metadata ambiguity | `lib/test/inbox-duplicates.test.mjs` checks exact/near comparisons and explicit human decisions |
| Attachment redaction and retained decisions | `lib/test/inbox-privacy-integration.test.mjs` requires review for aggregate parent/attachment redaction and conservative older records, and keeps directed decisions visible after thresholds change or target purge |
| Interrupted managed move and ambiguous targets | `lib/test/inbox-privacy-integration.test.mjs` checks explicit recovery, pending-intent blocking, foreign targets, symlinks, existing copies and conflict locks |
| Critique and release/install path | The damage scenario executes `mole critique idea` without changing files; `cli/test/mole.test.mjs` covers targets; `npm run check:package` packs, inspects, installs and smoke-tests the artifact |

## Limits and recovery

The supported managed operation has one generated destination under
`6-raw/inbox/archive/`. It provides no arbitrary destination, overwrite, new
identity or renewed TTL. Active or conflicted processing and lifecycle locks
block the move. The filesystem must support local hard links. A failed link
leaves the original and a prepared intent for explicit recovery.
A prepared move intent blocks processing and purge until explicit recovery with
`mole privacy archive <source-id> --recover --apply`. If recovery reports
ambiguity, preserve both copies and resolve ownership before retrying. The move
spans filesystem and ledger writes; it is not an atomic distributed transaction.

Source resolution can also discover an unchanged file after a manual archive
move. That does not authorize the path for privacy or duplicate processing.
The separate unmanaged-move scenario intentionally expects refusal and blocked
purge. Restore the original managed file to its canonical inbox path and reconcile
its source record before retrying. See [privacy recovery](raw-inbox-privacy.md)
and [source provenance](source-provenance.md). Scanning an unmanaged archive
instead creates a quarantined import; it is not identity-preserving archive
reconciliation. Reviewed derivative release remains a separate supported move.

Local ownership checks do not establish distributed exactly-once processing.
Actor declarations do not authenticate a person. Duplicate hashes are correlatable
metadata; local similarity is not semantic understanding. Redacted matches can
collapse different originals, so follow the duplicate review requirement rather
than treating a placeholder match as proof of one event.

There is no retention daemon, semantic DLP guarantee or retrospective erasure of
backups, provider versions or Git history. Validation reports findings rather than
repairing them. These boundaries remain operator responsibilities. Read the focused
[privacy](raw-inbox-privacy.md), [duplicates](inbox-duplicates.md),
[lifecycle](review-lifecycle.md), [queue](input-queue.md) and
[validation](workspace-validation.md) guides before recovery.
