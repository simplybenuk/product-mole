# Shared-folder inbox processing: sync-aware, restart-safe coordination

Status: APPROVED FOR DEVELOPMENT<br>
Issue: #21<br>
Parent: #16<br>
Related work: #18, #19, #23, #24, #25<br>
Last updated: 2026-09-18

## Summary

Mole needs a conservative coordination protocol for people and agents processing a shared inbox from local, SharePoint, OneDrive, Google Drive, or similar synced folders. The current local lock prevents some same-filesystem overlap, but it cannot establish distributed ownership, resume a partial run safely, or distinguish a valid retry from a duplicate completion.

This change replaces the v1 best-effort lock semantics with a schema-versioned leased run. A run has a stable ID, an attributed owner and host, a heartbeat and expiry, an explicit list of claimed paths, restart checkpoints, an idempotent terminal receipt, and an auditable recovery path. Every ambiguous state fails closed. The design remains file-native and explicitly does not promise a perfect distributed lock under delayed or conflicting sync.

An unmerged implementation candidate exists in draft PR #28. It is useful compatibility evidence, but neither that PR nor its automated review state constitutes approval of this specification or permission to merge or develop further.

## Problem and current findings

The current checkout establishes the following baseline:

- `lib/inbox-processing.mjs` uses an exclusive local create for `governance/inbox-processing.lock.json`, but its lock has no durable run ID, host, heartbeat, claimed-path snapshot, or partial-progress checkpoint.
- The current CLI always passes `allowMissingLock: true` to normal `mole inbox complete`, creating an `unclaimed-*` receipt instead of failing closed.
- Receipt names are timestamp-based. Repeating a completion can therefore create another receipt rather than returning a single run result.
- A completion does not verify that the caller is the lock owner, and successful completion deletes the live lock.
- `mole inbox audit` only reconciles live paths against receipt paths; it does not report competing claims, duplicate receipts, sync-conflict copies, malformed operational records, or incomplete recovery actions.
- Molehill Metrics currently deduplicates a processed path only within a UTC day. That is insufficient as the idempotency boundary for a retried run.
- `npm test` passes on the current checkout (38 tests), but that suite represents the v1 behavior above rather than this proposed protocol.

## Actors and affected areas

- Product managers, researchers, and contributors who add material to a shared inbox.
- Agents and maintainers who claim, process, checkpoint, resume, recover, or complete inbox runs.
- Workspace operators responsible for a synced-folder client, local clock, recovery decisions, and audit history.
- The Mole CLI, inbox-processing and audit modules, metrics integration, workspace scaffold, agent guidance, and operational documentation.
- Downstream work on source provenance (#23), lifecycle review (#24), workflow metrics (#19), and privacy/retention (#25).

## Goals

1. Make normal inbox processing fail closed unless Mole can verify an active claim owned by the completing run.
2. Give every run a stable `run_id` and lease metadata for processor, host, start, heartbeat, expiry, and claimed paths.
3. Make same-run claims, checkpoints, completion, and metric reconciliation safe to retry without a second receipt or processing event.
4. Preserve completed and unresolved work across a process crash so the owner can resume an active run without reprocessing checkpointed paths.
5. Detect and surface concurrent claims, foreign ownership, stale leases, duplicate or conflicting receipts, provider conflict copies, malformed records, and incomplete overrides.
6. Make stale and missing-lock recovery explicit, attributable, reversible through retained records, and visible to audit.
7. Preserve local-first, inspectable file storage and never delete or move a user source file as a coordination shortcut.
8. Explain the limits and recovery procedure for local and synced workspaces without overstating the guarantees of filesystem coordination.

## Non-goals

- Providing a consensus service, hosted lock manager, authentication system, or perfect distributed lock.
- Automatically selecting one side of a sync conflict, merging competing claims, or treating matching filenames as proof that two sources are equivalent.
- Deleting, moving, archiving, or rewriting raw source files to resolve an operational conflict.
- Redesigning the full provenance model (#23), human review/promotion lifecycle (#24), or broader learning-and-decision metrics model (#19).
- Changing the meaning of a processed inbox item: only a path actually promoted through the inbox workflow may be recorded as processed.

## Confirmed decisions

| Decision | Rationale | Acceptance criteria affected |
| --- | --- | --- |
| Keep the protocol file-native and local-first. | This preserves Mole's architectural source of truth and avoids a new hosted dependency. | AC1, AC8, AC10 |
| A v2 lease remains at `governance/inbox-processing.lock.json`; receipts and overrides remain under `governance/run-receipts/inbox-processing/`. | It gives existing workspaces a small, discoverable migration surface and retains the established receipt location. | AC1, AC6, AC9 |
| One active inbox run is allowed per workspace in v2. Claimed paths scope the run and restart state; they do not authorize independent concurrent runs. | A global active run is easier to audit and is safer under sync delay than concurrent path-level locking. | AC2, AC7 |
| The owner check is the recorded processor-plus-host tuple. It is an accidental-safety and attribution control, not authentication or an authorization boundary. | Shared files do not provide trustworthy identity proofs. | AC3, AC4, AC10 |
| Normal completion requires an active, unexpired, owned claim and an explicit run ID. | This removes the unsafe implicit missing-lock completion path. | AC3, AC5 |
| A stale or missing-lock action requires an explicit reason and creates a durable override record before it changes operational state. | Recovery must be reviewable and cannot silently replace history. | AC5, AC7, AC9 |
| A terminal receipt keyed by `run_id` is the idempotency source for completion and processing metrics. | Timestamp-based receipt names and daily path dedupe are insufficient for retry safety. | AC6, AC8 |
| Conflicts, invalid operational metadata, duplicate logical identities, and competing processed-path receipts block normal mutations and counting. | Mole must not silently choose a winning copy. | AC7, AC8 |

## Requirements

### Lease and run protocol

1. A new claim creates a schema-versioned v2 lease with, at minimum:
   - `schema_version`, a monotonic `lock_version`, `run_id`, compatibility `lock_id`, and `status`;
   - `processor`/`claimed_by` and `host`;
   - `started_at`, `heartbeat_at`, `expires_at`, compatibility `stale_after`, and lease duration;
   - canonical relative `claimed_paths`, `processed_paths`, and `unresolved_paths`; and
   - the inbox root, plus recovery provenance when the run replaced a stale lease.
2. Mutating commands must require an exact, syntactically safe run ID. The command that initially creates a run prints that ID for later heartbeat, checkpoint, and completion operations.
3. Claiming with the same run ID, owner, and active lease is idempotent. A different owner, a stale lease, a completed run, or an incompatible payload must fail with a specific remediation message.
4. A claim must use local exclusive creation and serialize local mutations. Before and after a mutation, Mole must validate the complete operational state and ensure a lock version or snapshot has not changed unexpectedly.
5. The default lease is finite and renewable. A heartbeat from the active owner renews the expiry and updates partial state without changing the run ID.
6. Claimed and processed paths must be canonical, repository-relative inbox paths that resolve inside the workspace inbox. Unsafe, absolute, escaping, malformed, or symlinked paths must be rejected rather than normalized into a different target.

### Restart, checkpoint, and completion

1. `mole inbox checkpoint` records only paths belonging to the active owned claim, updates `processed_paths`, recomputes `unresolved_paths`, and renews the lease.
2. On an owner retry before expiry, a claim exposes the existing checkpoints. The processor resumes unresolved paths and must not reprocess checkpointed paths merely because its process restarted.
3. Normal `mole inbox complete` requires `--run-id` and an active, unexpired, owned lease. It rejects missing, stale, foreign, changed, malformed, concurrent, or ambiguous state.
4. A receipt includes the run ID, owner and host, lease timestamps, claimed paths, processed paths, unresolved paths, summary, and an immutable lock snapshot. A processed path outside the claim is rejected.
5. Completion writes one deterministic receipt for a run. Retrying with the same owner and semantically identical terminal state returns that receipt, reconciles any safe follow-up work, and creates neither a second receipt nor a second processing metric event.
6. Completion may close a partially processed run only when the receipt explicitly preserves the unresolved claimed paths. Checkpointing alone does not increment processing metrics.
7. A successful receipt is written before a matching lock can be released. If the lock changes during release, Mole retains the receipt, preserves the changed lock, and reports reconciliation rather than deleting either state.

### Explicit recovery

1. A stale lease is recoverable only through an explicit `override-stale`/recovery action after its expiry. An active lease cannot be overridden.
2. A missing-lock completion is unavailable on the normal path. It requires an explicit missing-lock override, a run ID, a processor and host, and a non-empty reason after the operator has checked run and sync history.
3. Every override records its ID, type, action, actor, host, timestamp, reason, replacement run, and a snapshot of the replaced lock when one exists. Records use a prepared/finalized lifecycle so an interrupted recovery is auditable rather than implied to have succeeded.
4. A stale recovery inherits the previous claim and checkpoint history, checks every inherited and newly requested path against validated completion receipts, and refuses recovery when a path is already completed or ambiguous.
5. Legacy v1 locks remain readable evidence. They can be migrated only through the explicit stale-recovery path; normal completion must not silently upgrade, replace, or delete them.

### Conflict detection and audit

1. `mole inbox audit` must report a structured result for live candidates, processed and unprocessed paths, active/stale leases, override records, and every unsafe coordination condition.
2. It must detect at least:
   - a concurrent or foreign active claim;
   - expired or invalid leases;
   - provider-style conflict-copy names for inbox sources, lock files, receipts, and overrides;
   - duplicate receipts for a run, divergent receipts, and one canonical path claimed by more than one run receipt;
   - malformed receipts or overrides; and
   - prepared but unfinalized overrides.
3. A duplicate logical record or competing completed path is an ambiguity, even if one record looks newer. Mole preserves all copies and blocks normal processing and metric counting until they are reconciled.
4. Audit diagnostics must be actionable and must not include raw source content.

### Metrics and compatibility

1. Metrics update only from a valid, completed receipt and must use the run/receipt identity as the retry boundary, not only a current-day source path.
2. A retry of a completed run must reconcile its existing receipt without double-counting, including when the retry occurs on a later UTC day.
3. Metrics backfill and inbox audit must consume the same validated receipt snapshot. They exclude malformed, conflict-named, duplicate, or split-brain receipt paths and report what they skipped.
4. Historical v1 receipts remain readable for audit and legacy backfill only when they have a valid identity and completion timestamp. They must not be made to look equivalent to an unambiguous v2 run.
5. This change supplies only the processing-event contract needed for idempotency. The broader versioned metrics taxonomy remains the scope of #19.

## Proposed command and file shape

The final argument syntax may be refined during development, but the observable contract must support this flow:

```text
mole inbox claim --processor "Ada" --claimed-path 6-raw/inbox/a.md
# Prints run_id: run-...

mole inbox heartbeat --run-id run-... --processor "Ada"
mole inbox checkpoint --run-id run-... --processor "Ada" --processed 6-raw/inbox/a.md
mole inbox complete --run-id run-... --processor "Ada" --processed 6-raw/inbox/a.md "Promoted one note"

mole inbox override-stale --run-id run-recovery-... --processor "Grace" --reason "Confirmed the prior worker stopped and checked sync history."
mole inbox complete --override-missing-lock --run-id run-recovery-... --processor "Grace" --reason "Checked run history and recovered a completed pass."
```

```text
governance/
  inbox-processing.lock.json                         # active v2 lease only
  run-receipts/
    inbox-processing/
      <run-id>-<deterministic-suffix>.json           # immutable terminal receipt
      overrides/
        <override-id>.json                            # prepared/finalized recovery evidence
```

The active lock is operational state, not the sole record of history. Its final state is preserved in its completion receipt; an overridden lock is preserved in the override record. When a sync race makes removal ambiguous, every copy remains available for audit.

## Security, privacy, and data handling

- The protocol is local filesystem coordination only. It does not authenticate an actor and must not be described as an authorization control.
- Operational records contain metadata, canonical references, and timestamps only. They must not copy source bodies, snippets, extracted text, or conflict content.
- Path validation must keep mutations inside the workspace inbox and must reject unsafe resolution rather than following a symlink or a traversal path.
- Conflict handling preserves source files, lock/receipt copies, and override records. Operators decide recovery after inspecting their sync provider's history; Mole does not perform source-file cleanup.
- Source IDs from #23 may be added as an additive reference once available, but path-based v2 coordination remains compatible with current workspaces. #25 may later narrow which metadata can appear in metrics; it must not weaken the receipt idempotency contract.
- Synced folders, local clocks, provider version history, backups, and offline clients are outside Mole's control. Documentation must tell operators that a lease is evidence of best-effort ownership, not proof that another client never ran concurrently.

## Rollout and migration

1. Introduce the v2 schema and its validation with no destructive migration.
2. New workspaces scaffold the updated CLI/help text, run-receipt guidance, agent instructions, and shared-inbox recovery runbook.
3. Existing v1 locks remain visible. An expired v1 lock requires an explicit audited stale override to enter v2; an active v1 lock blocks normal v2 work.
4. Existing receipts remain available for audit and historical metrics only after schema validation. Ambiguous history is reported, not silently repaired.
5. Change the normal completion behavior from implicit unclaimed completion to a clear `MISSING_LOCK`/`RUN_ID_REQUIRED` remediation. Existing automation must be updated to claim, checkpoint, and complete with its returned run ID.
6. Treat draft PR #28 as an implementation candidate to assess against this specification after human approval. Do not infer approval, merge readiness, or human testing from its current draft state.

## Dependencies and affected areas

| Area | Required change |
| --- | --- |
| `lib/inbox-processing.mjs` | V2 lease schema, state validation, local mutation serialization, ownership checks, heartbeat, checkpoint, idempotent receipt creation, safe release, and recovery records. |
| `lib/inbox-audit.mjs` | Shared inspection snapshot, unsafe-state diagnostics, stale lease reporting, and conflict-aware processed-path reconciliation. |
| `lib/metrics.mjs` | Receipt/run-based idempotency and conflict-aware backfill while preserving compatible historical rollups. |
| `cli/mole.mjs` | Claim, heartbeat, checkpoint, completion, audit, and explicit recovery options with actionable failures. |
| `cli/test/mole.test.mjs` | Deterministic unit and integration fixtures for all failure and retry modes. |
| `README.md`, `cli/README.md`, `docs/signal-inbox-workflow.md`, `governance/run-receipts/README.md` | Updated local/shared workflow, recovery instructions, and honest limitation statement. |
| Inbox-related agent guidance and scaffold assets | Require claimed runs, checkpoints, a run-ID completion, and final audit before reporting processing complete. |
| #19, #23, #24, #25 | Consume the stable run/receipt contract without expanding this change into their separate scopes. |

## Acceptance criteria

1. A v2 active lease records a run ID, monotonic lock version, processor, host, start time, heartbeat, expiry, claimed paths, processed paths, and unresolved paths in an inspectable file-native schema.
2. One workspace has at most one active v2 inbox run. A same-owner retry of its active run is idempotent; a different run or owner receives an actionable failure.
3. Heartbeat, checkpoint, and normal completion require the exact active run ID and matching owner. Missing, expired, foreign, invalid, or changed locks fail closed with a useful remediation message.
4. A restarted owner can see checkpointed paths, resume the active run, and complete without reprocessing a checkpointed item. Unresolved paths remain visible in the terminal receipt.
5. Stale and missing-lock recovery require explicit, reasoned overrides that record actor, host, time, replacement run, and replaced-lock evidence. Active claims cannot be overridden.
6. Repeating a completed run returns one canonical receipt and does not create another receipt or another processing metric event, including across a UTC-date boundary.
7. Audit and normal mutations detect concurrent claims, duplicate/divergent receipts, duplicate processed paths, conflict-copy names, malformed records, and incomplete overrides; ambiguous records are preserved and block normal processing.
8. Metrics backfill consumes the same validated receipt state as audit, excludes conflicted or invalid paths, reports skipped/conflicted data, and does not double-count a retry.
9. Legacy locks and receipts remain available for inspection. A legacy stale lock is migrated only through the explicit audited recovery path, with no automatic deletion or silent conversion.
10. Source content is never deleted, moved, or copied into coordination diagnostics as a conflict shortcut; unsafe paths and symlinks are rejected.
11. Documentation explains the local workflow, synced-folder limitations, recovery steps, conflict preservation, and updated command examples.
12. Tests simulate concurrent local claims, delayed/conflict-copy sync states, stale leases, foreign completion, same-run retries, partial checkpoints and restart, duplicate receipts, metric reconciliation, missing-lock recovery, legacy migration, malformed metadata, and source-file preservation.

## Proposed task outline

1. Define the v2 lease, receipt, override, and audit schemas; add safe path/metadata validators and compatibility readers for v1 records.
2. Implement local mutation serialization, exclusive claim creation, snapshot/version checks, owner verification, heartbeat renewal, and checkpoint persistence.
3. Implement deterministic run-keyed receipt creation, idempotent retry reconciliation, safe lock release, unresolved-path recording, and receipt-based metric integration.
4. Implement explicit stale and missing-lock recovery with prepared/finalized audit records and legacy-lock handling.
5. Extend inbox audit and metrics backfill to expose unsafe state and exclude ambiguity from processed-path results.
6. Update CLI help, scaffold files, agent guidance, shared-folder documentation, and migration/recovery instructions.
7. Add focused fixture-based tests, run repository validation, and assess the existing PR #28 implementation against the approved specification before any merge decision.

## Validation plan

- Run `npm test` from the repository root.
- Add focused module tests for schema validation, canonical path rejection, claim/idempotency behavior, owner checks, heartbeat expiry, checkpoints, deterministic receipts, and recovery records.
- Add isolated fixture-workspace CLI tests for local contention, a retry after completion, a retry on a later UTC day, partial crash/restart, stale takeover, missing-lock recovery, foreign completion, and changed-lock release races.
- Add fixtures for provider-style conflict-copy names, duplicate/different receipts, split-brain processed paths, malformed JSON, duplicate override IDs, prepared overrides, and legacy v1 locks.
- Assert that every conflict fixture leaves source files and competing operational records intact and that no normal mutation succeeds while ambiguity remains.
- Run `mole doctor` and `mole inbox audit` in disposable workspaces; verify that audit reports unsafe state with non-zero status and returns to a clean state only after explicit reconciliation.
- Verify documentation examples and scaffold-generated guidance use a claim, retained run ID, checkpoint, owned completion, and final audit.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| A sync provider delays or duplicates a write | Validate before and after local mutation, detect conflict copies and duplicate identities, and fail closed rather than electing a winner. |
| An owner crashes mid-run | Persist checkpoints in the active lease; preserve unresolved paths and require explicit stale recovery after expiry. |
| A second client completes or overrides another run | Require run ID plus processor/host match, use a finite lease, and require audited recovery for stale/missing state. |
| Receipt/metric retries inflate activity | Use the terminal run receipt as the idempotency identity and reconcile metrics from validated receipts. |
| A malformed or conflict-copied file is ignored | Treat invalid locks, receipts, and overrides as auditable blocking states. |
| Operators mistake the lease for a distributed lock | Document the precise limits, provider-history checks, and conflict-preservation procedure. |
| Future provenance or privacy work changes identifiers | Keep source-ID support additive and preserve a path-based compatibility adapter; prevent a later metadata change from weakening retry idempotency. |

## Agent-resolved assumptions

- **A1 — 24-hour default lease with explicit heartbeats.** The existing stale interval is retained as the default; long-running work renews it through heartbeat. Observable effect: a run remains recoverable after a restart until expiry, while an abandoned run eventually requires an explicit override. Affects AC1–AC5.
- **A2 — Global active run, path-level checkpoints.** V2 serializes one inbox run per workspace rather than allowing independent path-level claims. Observable effect: a second claim cannot proceed while any active lease exists, and all work scope is still visible in claimed/unresolved arrays. Affects AC2, AC4, and AC7.
- **A3 — Processor-plus-host is attribution, not authentication.** Mole compares the recorded tuple to prevent accidental cross-owner completion; it does not claim to stop a user with shared filesystem write access from forging metadata. Observable effect: foreign metadata fails normal commands, and documentation does not call this authorization. Affects AC3, AC5, and AC10.
- **A4 — V2 stays at the established lock and receipt locations.** Observable effect: operators can find active coordination state where v1 existed, legacy readers remain possible, and overrides live with receipts rather than a new hidden store. Affects AC1, AC5, and AC9.
- **A5 — No generic conflict bypass.** A normal command cannot continue merely because a conflict-copy file is present; a recovery action records evidence but does not choose or delete a conflicting source. Observable effect: ambiguous state remains visible until an operator reconciles it. Affects AC7 and AC10.
- **A6 — Source IDs are additive for this change.** Until every workspace has the #23 provenance contract, v2 validates canonical inbox paths and may attach a source ID when available. Observable effect: existing path-based workspaces can upgrade without rewriting raw sources, while later work can resolve moved sources. Affects AC4, AC8, and AC9.

## Open questions

No unresolved product direction, permissions, tenancy, security-posture, or external-service decision blocks approval of this specification.

Implementation planning must verify the current #23 source-identity interface before adding optional source-ID references, and must assess draft PR #28 against this approved contract rather than treating the PR as the contract. Both are bounded technical compatibility checks; the path-based fallback and approval boundary are defined above.

## Retrieval receipt

- **Source of truth consulted:** GitHub issues #16, #19, #21, #23, #24, and #25; project adapter/context; repository architecture and inbox workflow guidance; current inbox, audit, metrics, CLI, and test code.
- **Implementation evidence consulted:** unmerged `codex/issue-21` / draft PR #28, treated as a non-authoritative candidate only.
- **Deepest repository layer reached:** relevant Layer 4 context templates, which contained no populated product-specific evidence; no raw inbox content was needed.
- **Why retrieval stopped:** the issue, architecture, operational code, tests, and active related specification provided sufficient evidence to define the bounded coordination contract.
- **Known conflict:** the current checkout retains unsafe v1 behavior while draft PR #28 already contains an unmerged implementation. This artifact is the human approval gate and does not silently advance either implementation or PR state.

## Handoff

Human approval was recorded on 2026-09-18. Use `bwh-development` to produce independently verifiable implementation tasks. The existing draft implementation remains a candidate to assess against this approved specification; approval does not itself merge or accept it.
