# Changelog

All notable changes to Mole should be documented here.

The format is loosely based on Keep a Changelog and uses lightweight SemVer.

## [Unreleased]

### Added
- Added MIT package metadata, a root `LICENSE` file, and a strict release guard.
- Added Node.js CI coverage for 18.x, 20.x, 22.x, and 24.x.
- Added packed-artifact and clean-install verification for the published package.
- Added a review lifecycle ledger at `governance/lifecycle/records.json` with
  the states `raw`, `evidence`, `draft`, `pending_review`, `accepted`,
  `rejected`, `superseded`, `unreviewed`, and `withdrawn`, and an append-only
  transition history per record.
- Added `mole lifecycle` commands to register, submit, revise, approve, reject,
  supersede, withdraw, relocate, list, show, audit, and migrate records.
  Approve, reject, supersede, and withdrawing an accepted record require a
  declared human actor and `--confirm-human`.
- Added `mole lifecycle relocate` for a draft that was renamed and edited, and
  `mole lifecycle withdraw` for a record whose file is gone.
- `mole lifecycle revise` sends an accepted file that was edited in place back
  through review under the same record.
- `mole lifecycle approve` requires `--expect-revision <n>`, the revision the
  reviewer read.
- A capture that was deleted and withdrawn while `raw` or `evidence` still
  supports an approval. A refused approval lists every source that cannot
  support it and the `revise --remove-source` command that clears them.
- `mole lifecycle list --path <path>` finds the record for a file. One file
  backs one open record; a second registration of a tracked file is pointed
  at the existing record. That includes a file that moved without
  `mole lifecycle relocate`, which its record follows by content. When an
  earlier registration left such a duplicate, `mole lifecycle audit` names the
  duplicate record to withdraw. `mole lifecycle relocate` applies the same
  rule, and a record cannot take a moved file from one with more review
  standing.
- Added `mole retrieve`, which returns accepted records only unless
  `--include-state` names another state.
- Added `schemas/review-lifecycle-v1.schema.json` and
  `docs/review-lifecycle.md`.
- Added a `mole metrics` summary, in text and JSON, of captured inputs,
  processed inputs, promoted evidence, reviewed outputs, accepted learnings,
  superseded context, and unresolved questions for the last 7 days, 30 days,
  and all time. It is derived from the review ledger and inbox receipts, so a
  retry counts nothing twice. `mole metrics snapshot` writes it to
  `governance/metrics/outcomes.json`. See `docs/molehill-metrics.md`.
- Added the `mole-product-travel-log` skill, a `product-travel-log` artifact
  template for `mole create`, and `mole travel-log <change-or-release>`. The
  report sets out intent, what shipped, evidence before and after, learnings,
  and a decision for each change, and goes to a person for review. A worked
  example is in `examples/product-travel-log/`.
- Added `mole validate [path]`, a read-only check of the whole workspace with
  text and JSON output. It reports inbox, receipt, source, review-record,
  frontmatter, summary, duplicate-file, input-queue, and metadata problems
  with stable finding codes, and exits 0 when healthy, 1 with findings, 2 for
  invalid arguments, and 3 for an internal failure. See
  `docs/workspace-validation.md`.
- Added a structured human-input queue at
  `governance/input-queue/requests.json`. Each request has a stable ID,
  priority, blocking state, owner, due date, source links, and an append-only
  history. `mole input-queue` adds, updates, closes, reopens, lists, migrates,
  and audits requests. See `docs/input-queue.md`.

### Changed
- `mole metrics` with no subcommand prints the summary. It used to fail.
- The metrics dashboard has a second panel for the summary and keeps
  operational counts apart from learning and decision-state counts.
  `mole metrics backfill` also writes the summary snapshot. Both commands
  replace a dashboard page from an earlier Mole, which has no second panel,
  and keep the old page as `governance/metrics/dashboard.previous.html`.
- `mole doctor` points to `mole validate` for the full check.
- `mole inbox audit` reads the source registry once, not once per inbox file
  that does not name its own source.
- The product-update template ships with a default `summary`.
- `mole review input-queue` now returns the top human-input requests with the
  reason for each rank, in text or JSON. It suggests stale and likely duplicate
  requests and never closes them. It used to print an agent instruction.
- The table in `governance/input-queue.md` is generated from the queue.
  Existing rows are imported with `mole input-queue migrate --apply`, which
  keeps each row's text and a copy of the file. Until then the review ranks
  the rows as they are.
- `mole upgrade [version]` now installs from an explicit `vX.Y.Z` release tag.
- `mole create` registers the new file as a source and opens a `draft`
  lifecycle record. It refuses an output path outside the workspace, a path
  that another source is still registered at, and a workspace whose ledger
  cannot be written. In each case it writes nothing.
- CLI and UI captures open a `raw` lifecycle record and return its ID. A
  capture is still saved, with a warning, when the ledger cannot be written.
  A UI capture waits 1.5 seconds for a busy ledger before it does so.
- A reviewed file replaced by a link that leaves the workspace is reported as
  `unsafe_path` in audit findings, retrieval exclusions, and error details. It
  was `source_record_invalid`.
- `mole lifecycle list --path` hashes only files that moved away from their
  registered path.
- Agent guidance and generated instructions tell agents to rely on accepted
  context, submit drafts for review, and leave decisions to a person.
- Existing workspaces start with no lifecycle records. `mole lifecycle migrate
  --apply` registers files under `6-raw/` as `raw` and other old files as
  `unreviewed`; nothing is accepted without a human decision. The file at the
  registered path of an open record is not reported as a `source_id_mismatch`.
  A copy that kept another file's `source_id:` frontmatter is treated as an
  untracked file when migration can account for the original.
- Added release, upgrade, contribution, and development guidance for the
  open-source package lifecycle.

The intended MIT terms are prepared, but release publication remains blocked
until a maintainer confirms the copyright-holder line in `LICENSE`.

## [0.2.8] - 2026-06-17

### Fixed
- `mole inbox complete` now writes a machine-readable inbox-processing receipt and updates Molehill Metrics even when a synthesis run did not create a prior processing lock.

### Changed
- New CLI and UI captures now write directly to the flat `6-raw/inbox/` drop zone.
- Inbox guidance now treats locks and receipts as the durable processing state, while preserving compatibility with existing `quick-notes/`, `messages/`, `observations/`, and state-folder layouts.

## [0.2.7] - 2026-06-11

### Added
- Added Molehill Metrics for local processed inbox item counts under `governance/metrics/`.
- Added `mole inbox complete --processed <path>` support so processing receipts can record processed inbox items and update daily, weekly, and monthly metrics.
- Added `mole metrics backfill` to rebuild metrics from historical inbox processing receipts that already contain processed paths.
- Added a static local metrics dashboard at `governance/metrics/dashboard.html`.

### Changed
- CLI help, README, CLI docs, and inbox synthesis guidance now include the full current command surface and metrics workflow.
- Metrics dedupe canonicalizes processed paths so relative, `./`, and workspace-absolute spellings count as the same inbox item.

## [0.2.6] - 2026-05-28

### Added
- Added `mole bootstrap-context` guidance for first-time population of blank or starter-template `2-summaries/` and `3-indexes/`.
- Added `mole refresh top-layers` guidance for periodically reconciling summaries and indexes with lower-layer context.
- Added packaged `mole-bootstrap-context` and `mole-refresh-top-layers` skills.

### Changed
- Inbox synthesis guidance now treats blank, placeholder-only, or starter-template summaries and indexes as material top-layer gaps that should be populated from durable synthesis.

## [0.2.5] - 2026-05-22

### Added
- Added `cli/skills/mole-upgrade-workspace/SKILL.md` with a conservative workflow for upgrading older Mole workspaces.
- The new skill includes preflight checks, tooling refresh guidance, `mole doctor`/`mole check-updates` assessment, and ownership-based upgrade classification.

### Changed
- Upgrade guidance now explicitly codifies safe-only apply behavior (`safe-copy`) plus manual review requirements for `merge-carefully` and `never-overwrite` paths.

## [0.2.4] - 2026-05-16

### Added
- Added `4-context/stakeholders.md` as a living, evidence-backed stakeholder and organisation context file for Mole workspaces.
- Added `mole product-update <audience> <timescale> --format <format>` to generate stakeholder-specific product update instructions.
- Added a product update artifact template and packaged `mole-product-update` skill.
- Added stakeholder metadata fields for raw insight capture.

### Changed
- Inbox synthesis guidance now includes stakeholder memory updates for internal signals, leadership asks, update preferences, decision authority, and org-chart facts.
- README and CLI docs now describe stakeholder capture and product update workflows.

## [0.2.3] - 2026-05-16

### Added
- Added `4-context/personas.md` as a living, evidence-backed persona context file for Mole workspaces.
- `mole synthesise inbox` now reminds agents to update or create personas when inbox material contains durable user/customer signals.

### Changed
- Inbox synthesis guidance now includes persona maintenance and user-summary refresh rules.

## [0.2.2] - 2026-05-14

### Added
- `mole --help` now includes command descriptions, artifact types, examples, and a README link.
- `mole install skills` installs Mole agent skills into `~/.agents/skills` or `$AGENTS_HOME/skills`.
- Packaged Mole workflows as agent skills under `cli/skills/`.

### Changed
- Replaced bundled Codex prompt files with agent skill directories.
- `mole install codex` is now a deprecated compatibility alias for `mole install skills`.
- README and CLI docs now describe the agent skill installation flow.

## [0.2.1] - 2026-05-14

### Added
- `mole upgrade` now updates the globally installed Mole CLI from `github:simplybenuk/product-mole#main`.
- `mole new` / `mole init` now creates workspaces from an explicit scaffold allowlist.
- Added tracked `4-context/` and `5-evidence/` workspace placeholders.

### Changed
- New workspaces are clean Mole instances instead of copies of the Product Mole source repository.
- `mole doctor` now checks the full `0-bootstrap/` through `6-raw/` workspace structure.
- Workspace metadata no longer references source-only paths such as `docs/`, `templates/`, or `cli/`.

## [0.2.0] - 2026-03-29

### Added
- `docs/upgrade-and-instance-management.md` to define how local mole instances should track versions, ownership, and upgrades.
- `mole.instance-template.yaml` as a starter instance metadata file for adopted moles.
- `docs/release-checklist.md` for lightweight release discipline.
- Stronger upgrade guidance in the README, including the distinction between upstream-owned files and instance-owned content.

### Changed
- README repositioned the project as a reusable open-source PM operating system with an explicit upgrade path, not just a one-time template dump.
- Template update guidance expanded from simple upstream merge advice to a more realistic instance-management model.

## [0.1.0] - 2026-03-15

### Added
- Initial public scaffold for Mole.
- README as the primary user guide.
- Architecture/design guidance moved to `docs/architecture-and-design.md`.
- Local UI v0 scaffold retained on branch `feat/ui-v0-local-scaffold`.
