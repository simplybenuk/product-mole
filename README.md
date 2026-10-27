# Mole

Mole is a portable, local-first context operating system for product managers and AI assistants.

Current version: `0.3.0`

It gives teams a file-based place to capture messy product inputs, distil them into structured evidence, and generate better roadmaps, specs, decisions, and prioritisation work from shared context. Mole is designed to work locally, in synced folders such as SharePoint/OneDrive or Google Drive, or alongside a codebase in Git.

## License

Mole is intended to be released under the MIT License. The full text is in [LICENSE](LICENSE).
The copyright-holder line in that file must be confirmed by a maintainer before
a release is published.

---

## Installation

### 1. Install from GitHub

```bash
npm install -g github:simplybenuk/product-mole#v0.3.0
mole --help
```

This installs the `mole` command globally from the tagged `v0.3.0` release.
Replace the tag with the release you want. Installing from `main` is for
contributors or users who explicitly want unreleased changes.

### 2. Create a Mole workspace

```bash
mole new my-mole
cd my-mole
```

This creates a clean workspace scaffold with bootstrap guidance, routing rules, summaries, indexes, context/evidence folders, an inbox, and lightweight governance files. You do not need to clone the Mole repository to create or use a workspace.

### 3. Install agent skills

Install the optional Mole agent skills:

```bash
mole install skills
```

This copies skill directories into `~/.agents/skills/`, or `$AGENTS_HOME/skills/` when `AGENTS_HOME` is set. The installer prints the Mole mascot and lists the installed skills.

### 4. Try the CLI

```bash
mole doctor
mole insight "Users trust CSV export more than dashboard totals"
mole insight --stakeholder CEO "Asked whether enterprise onboarding is improving"
mole bootstrap-context
mole product-update CEO 2-weeks --format email
mole critique idea "Improve regulated-customer onboarding"
mole create roadmap
```

### 5. Try the skills

After installing skills, ask your agent for Mole-specific work such as:

- Capture this Mole insight: users trust CSV export more than dashboard totals.
- Bootstrap this Mole workspace context.
- Synthesise the Mole inbox.
- Refresh the Mole top layers.
- Create a Mole roadmap.
- Create a Mole product spec.
- Review the Mole input queue.
- Critique this idea using the current Mole context.
- Generate a product update for the CEO for the last two weeks in email format.
- Upgrade this Mole workspace from an older version using a safe apply + manual review plan.

## Commands

| Command | What it does |
| --- | --- |
| `mole --help` | Prints CLI usage, examples, and supported commands. |
| `mole new <workspace-name>` | Creates a new Mole workspace from the bundled scaffold. Refuses a folder that already has files in it, other than dotfiles such as `.git`. |
| `mole init [target-dir]` | Backwards-compatible alias for `mole new`. |
| `mole install skills` | Installs Mole agent skills into `~/.agents/skills/` or `$AGENTS_HOME/skills/`. |
| `mole doctor` | Checks source and instance versions plus required instance folders. |
| `mole validate [path] [--format text\|json]` | Runs the full read-only workspace check: inbox, receipts, sources, review records, frontmatter, summaries, duplicates, and the input queue. Exits 0 when healthy and 1 with findings. See [`docs/workspace-validation.md`](docs/workspace-validation.md). |
| `mole check-updates` | Reports whether the installed Mole source is newer than the current workspace. |
| `mole insight "<text>"` | Captures a raw insight into `6-raw/inbox/`. |
| `mole note "<text>"` | Alias for `mole insight`. |
| `mole signal "<text>"` | Alias for `mole insight`. |
| `mole insight --stakeholder CEO "<text>"` | Captures an insight with stakeholder metadata for later synthesis. |
| `mole product-update <audience> <timescale> --format <format>` | Prints an agent instruction for a stakeholder-specific product update. |
| `mole critique <target> [claim-or-path]` | Prints an agent instruction for a context-grounded critique. |
| `mole bootstrap-context` | Prints an agent instruction for first-time summary/index population. |
| `mole refresh top-layers` | Prints an agent instruction for refreshing stale, blank, or incomplete summaries and indexes. |
| `mole create roadmap [output-path]` | Creates a roadmap draft from the roadmap template. |
| `mole create spec [output-path]` | Creates a product spec draft from the spec template. |
| `mole create decision-brief [output-path]` | Creates a decision brief draft. |
| `mole create strategy-memo [output-path]` | Creates a strategy memo draft. |
| `mole create prioritisation-draft [output-path]` | Creates a prioritisation draft. |
| `mole create product-update [output-path]` | Creates a product update draft from the product update template. |
| `mole create product-travel-log [output-path]` | Creates a travel log report draft: intent, what shipped, evidence, learnings, and a decision for one change or release. |
| `mole travel-log <change-or-release>` | Prints an agent instruction for an outcome review of a change or release. See [`docs/product-travel-log.md`](docs/product-travel-log.md). |
| `mole synthesise <target>` | Prints an agent instruction for synthesising a target using the Mole operating model. |
| `mole review <target>` | Prints an agent instruction for reviewing a target and surfacing next actions. |
| `mole review input-queue [--limit <n>] [--format json]` | Returns the highest-value human-input requests, why each ranks where it does, and what answering it unblocks. Read-only. |
| `mole input-queue add\|update\|close\|reopen\|show\|list\|migrate\|refresh-view\|audit\|unlock` | Manages human-input requests as records with stable IDs. See [`docs/input-queue.md`](docs/input-queue.md). |
| `mole inbox claim [options]` | Claims a run with a leased, owned lock and returns its `run_id`; provide each `--claimed-path`. |
| `mole inbox heartbeat --run-id <id>` | Renews the matching active run lease for a long processing pass. |
| `mole inbox checkpoint --run-id <id> [--processed <path>]` | Saves partial progress in the matching active run for restart-safe processing. |
| `mole inbox audit` | Recursively audits live files, leases, sync conflicts, overrides, and receipts. |
| `mole inbox complete [options] [summary]` | Writes one idempotent receipt for the owned run, records metrics, and releases its lock. |
| `mole inbox override-stale [options]` | Replaces an expired lock only after an explicit, auditable recovery decision. |
| `mole metrics [--format json] [--events]` | Summarises processing activity and review-state changes for the last 7 days, 30 days, and all time. Read-only. See [`docs/molehill-metrics.md`](docs/molehill-metrics.md). |
| `mole metrics snapshot` | Writes that summary to `governance/metrics/outcomes.json` for the local dashboard. Replaces a dashboard page from an earlier Mole and keeps the old one beside it. |
| `mole metrics backfill` | Rebuilds local metrics from inbox processing receipts that already contain processed paths. |
| `mole lifecycle register <source_id> --state <state> --actor <name> --actor-type <type>` | Opens a review record for a registered file as `raw`, `evidence`, `draft`, or `unreviewed`. |
| `mole lifecycle evidence\|draft\|submit\|revise <record_id> [options]` | Moves a record toward review. Agents may run these. `revise` also sends an accepted file that was edited in place back to review. |
| `mole lifecycle approve\|reject <record_id> --actor <name> --actor-type human --confirm-human --reason <text>` | Records a human review decision. Approval also needs a supporting `--source <source_id>` and `--expect-revision <n>`, the revision the reviewer read. |
| `mole lifecycle supersede <record_id> --replacement <record_id> [human options]` | Replaces an accepted record with another accepted record. |
| `mole lifecycle withdraw <record_id> [options]` | Closes a record, such as one whose file is gone. A record that is or was accepted needs the human options. |
| `mole lifecycle relocate <record_id> --path <path> [options]` | Points a record at the file it now lives in without touching the file. Only a draft may follow a file that was also edited. |
| `mole lifecycle show <record_id>` / `mole lifecycle list [--state <state>] [--path <path>]` | Shows one record with its history, lists records, or finds the record for a file. |
| `mole lifecycle audit` | Checks the review ledger and the reviewed files. Read-only. |
| `mole lifecycle migrate [--apply]` | Reports files with no review record. `--apply` registers them as `raw` or `unreviewed`, never as accepted. |
| `mole lifecycle unlock` | Removes a write lock left by a stopped process. |
| `mole retrieve [record_id] [--include-state <state>]` | Lists or prints accepted context. Drafts, pending, and rejected records need `--include-state`. |
| `mole upgrade [version]` | Updates the globally installed Mole CLI from a stable release tag. With no version, it reuses the installed CLI's version tag. |

## Development

Mole supports Node.js 18.x, 20.x, 22.x, and 24.x. CI runs the repository
checks on each version.

From the repository root, run:

```bash
npm test
npm run check:versions
npm run check:package
```

`npm run check:release` adds the strict release guard. It must pass before
publishing a tag.

## Stakeholder memory and product updates

Mole can maintain internal stakeholder context alongside user personas. Use `4-context/stakeholders.md` to capture people, groups, org-chart relationships, product interests, recurring questions, communication preferences, decision authority, and evidence links.

A typical workflow is:

```bash
mole insight --stakeholder CEO "Asked for clearer enterprise onboarding metrics"
mole synthesise inbox
mole inbox audit
mole product-update CEO 2-weeks --format email
```

Inbox synthesis should promote durable stakeholder signals into `4-context/stakeholders.md`. Product update generation then retrieves that stakeholder memory, relevant summaries, indexes, product context, evidence, and recent raw material to tailor an update for the audience and requested format. Supported formats are intentionally flexible, for example email, Teams message, blog post, or executive brief.

## Summary and index setup

New or migrated workspaces often start with blank or starter-template files in `2-summaries/` and `3-indexes/`. Populate those top layers explicitly before relying on daily inbox synthesis:

```bash
mole bootstrap-context
```

Use the printed instruction with your agent. It should read the lower layers and inbox material, then create the first useful summaries and indexes without inventing unsupported facts.

After larger synthesis passes, or whenever the top layers feel stale, run:

```bash
mole refresh top-layers
```

Daily `mole synthesise inbox` remains focused on promoting new material, but blank or placeholder summaries and indexes now count as material gaps that should be filled when relevant durable context is synthesised.

## Molehill Metrics

Mole tracks lightweight local processing metrics under `governance/metrics/`. Metrics count processed inbox item paths, not raw insight content and not individual users.

`mole metrics` prints a summary in two groups. Operational activity covers captured and processed inputs. Learning and decision state covers promoted evidence, reviewed outputs, accepted learnings, superseded context, and unresolved questions. The counts are derived from the review ledger and inbox receipts each time, so nothing is counted twice. They show workflow activity, not product success or decision quality. Definitions are in [`docs/molehill-metrics.md`](docs/molehill-metrics.md).

When finishing inbox work, include each inbox item that was actually processed:

```bash
mole inbox claim --processor "Your Name" --claimed-path 6-raw/inbox/a.md
mole inbox checkpoint --run-id <run-id> --processor "Your Name" --processed 6-raw/inbox/a.md
mole inbox complete --run-id <run-id> --processor "Your Name" --processed 6-raw/inbox/a.md "Promoted one customer signal"
```

Before and after synthesis, run `mole inbox audit`. It validates the workspace root, recursively scans the live inbox, excludes only the instructional root README and retained archive content, and reports files not explained by processing receipts. Do not declare a no-op while the final audit reports unexplained files.

Use repeated `--processed` flags for multiple items. Do not include items that were only inspected, skipped, or left for later. The local dashboard is available at `governance/metrics/dashboard.html`. Its second panel shows the `mole metrics` summary; run `mole metrics snapshot` to refresh it.

For existing workspaces, run `mole metrics backfill` after upgrading to rebuild metrics from historical `governance/run-receipts/inbox-processing/` receipts. Backfill counts only receipt `processed` paths with valid completion dates; it does not infer from raw inbox folders or read raw insight content. If receipt or recovery state is ambiguous, backfill exits without rewriting existing metric history until the state is reconciled.

## Shared-folder processing

The inbox workflow works in a local folder and in a folder synced by OneDrive, SharePoint, Google Drive, Dropbox, or a similar client. The lock is still a set of files, not a service-side distributed lock. Each mutating operation serializes local lock updates and verifies the complete lock state plus its monotonic version before and after writing, but a sync client can still delay, duplicate, or reorder file changes.

For every processing pass:

1. Run `mole doctor` and `mole inbox audit`.
2. Claim a run and keep its `run_id`: `mole inbox claim --processor "Your Name" --claimed-path 6-raw/inbox/a.md` (repeat `--claimed-path` for each intended item).
3. Pass the exact returned `--run-id` and `--processor` to every heartbeat, checkpoint, and completion. These mutating commands refuse a missing, malformed, or different run ID. Checkpoint each promoted path so a restart can skip paths already recorded in `processed_paths`.
4. Complete only after the promoted output and retrieval receipt exist. The receipt stores the run, lease, claimed paths, processed paths, unresolved paths, and lock snapshot.
5. Run `mole inbox audit` again.

Normal completion refuses a missing, expired, foreign, duplicate, or conflicted state. If a lease is stale, inspect the folder's sync history and preserve all copies before using `mole inbox override-stale --run-id <new-run-id> --processor "Your Name" --reason "..."`; the replacement ID must not already have a completion receipt. If the lock is missing, use `mole inbox complete --override-missing-lock --run-id <run-id> --processor "Your Name" --host <host> --reason "..."` only when the run history is clear. Run IDs are validated before they become receipt filenames. Each override records the actor, host, time, reason, replacement run, and replaced lock under `governance/run-receipts/inbox-processing/overrides/`.

Mole never deletes or moves source files to resolve a sync conflict. Conflict-named source files, lock copies, and duplicate receipt files are reported by `mole inbox audit`; keep every copy until a person decides how to handle it.

The audit also fails closed when receipts from different run IDs claim the same canonical inbox path. Those split-brain paths are excluded from the normal processed count, and metrics backfill reports them without counting them. Malformed override JSON is likewise reported as invalid rather than silently omitted.

Expired locks from older Mole versions cannot be completed normally. An explicit stale override can migrate a structurally recognizable legacy lock into the current lease format while preserving the original lock in the audit record; incomplete receipts with processed paths are never used as processing evidence.

## Human-input queue

When an agent needs something only a person can give, it adds a request. Each
request has a stable ID, a priority, what it blocks, and a history.

```bash
mole input-queue add --request "Which pricing tier is the default?" \
  --impact "The onboarding spec assumes Team" --unblocks "Onboarding spec v2" \
  --priority high --blocking --actor "Agent" --actor-type agent
mole review input-queue
mole input-queue close <input_id> --answer "Team tier" --outcome "Spec updated" \
  --actor "Agent" --actor-type agent
```

`mole review input-queue` returns the top three asks with the reason for each
rank, and suggests stale and duplicate requests without closing them. Only a
person can close a request that was not answered or change its owner. A
workspace with rows in `governance/input-queue.md` imports them with
`mole input-queue migrate --apply`. See
[`docs/input-queue.md`](docs/input-queue.md).

## Review lifecycle

Agents draft. People decide. Mole records the difference in
`governance/lifecycle/records.json`, so a draft cannot pass as accepted context.

```bash
mole create spec
mole lifecycle submit <record_id> --actor "Agent" --actor-type agent --reason "Ready for review"
mole lifecycle approve <record_id> --actor "Your Name" --actor-type human --confirm-human \
  --reason "Matches the interview evidence" --source <source_id> --expect-revision 2
mole retrieve
```

`mole create` and the capture commands open a record and print its ID. A record
moves through `raw`, `evidence`, `draft`, `pending_review`, and `accepted`, with
`rejected`, `superseded`, and `withdrawn` as outcomes. Only a human can approve,
reject, supersede, or withdraw accepted context, and the command fails for an
agent actor or without `--confirm-human`. Each transition appends the actor,
time, and reason to the record's history. Transitions never rewrite the file
under review.

`mole retrieve` returns accepted records only. Add `--include-state` to read
drafts, pending, or rejected material on purpose. If an accepted file changes
after approval, retrieval drops it and `mole lifecycle audit` reports it.

Accepted files change too. After an in-place edit, such as a refreshed
`4-context/personas.md`, run `mole lifecycle revise` and `submit`, and a person
approves the new version under the same record.

Files move. An archived file with unchanged bytes is found by its hash. A
draft that was renamed and edited needs `mole lifecycle relocate`, and a record
whose file was deleted needs `mole lifecycle withdraw`. The audit names the
command for each record it reports.

Existing workspaces start with no records. `mole lifecycle migrate` lists
untracked files. `--apply` registers files under `6-raw/` as `raw` and the rest
as `unreviewed`. Nothing becomes accepted without a person running `approve`.

The actor fields are declarations, not authentication. A synced folder can
still produce a conflict copy of the ledger, which Mole detects and does not
merge. See [`docs/review-lifecycle.md`](docs/review-lifecycle.md) for the
transition table, migration, recovery, and shared-folder limits.

## How Mole Works

Mole is a file-based context system with progressive layers.

- Top layers are small, high-signal, and cheap to read.
- Lower layers are richer, more detailed, and more expensive.
- Agents should descend only as needed.

The core operating principle is:

**Capture low -> Distil up -> Retrieve top-down -> Create**

Humans capture quickly, agents structure and synthesise, humans review and steer, and outputs are generated from layered context instead of from a blank prompt.

## Updating after new changes

Mole separates the installed tool from generated working instances.

When the source/tool changes, update the global install:

```bash
mole upgrade 0.3.0
mole install skills
```

`mole upgrade <version>` refreshes the globally installed CLI from a stable
release tag. Pass `0.3.0` or `v0.3.0` to select a release explicitly.
With no argument, it uses the tag matching the installed CLI version. It does
not use the moving `main` branch.

If an older CLI does not support version selection, install a tagged release
with the command in the Installation section, then run `mole upgrade` normally.

Why both?
- `npm install -g ...` refreshes the CLI, bundled scaffold, docs, and skill files
- `mole install skills` refreshes the agent skills so new workflows and updates actually appear

Then restart or refresh your agent session if needed.

To inspect a working instance before upgrading it, run these from inside the workspace folder:

```bash
mole doctor
mole check-updates
```

`doctor` reports:
- source version from `VERSION`
- instance version from `mole.instance.yaml`
- core folder checks
- a warning when instance metadata is missing

`doctor` is a quick check. For the full health report, run `mole validate`. It is read-only and covers the inbox, receipts, sources, review records, frontmatter, summaries, duplicates, and the input queue. See [`docs/workspace-validation.md`](docs/workspace-validation.md).

`check-updates` is currently a read-only report. It compares source and instance versions, then lists:
- safe additions from `upgrade-ownership.json`
- manual review paths that may contain local customisation

`mole upgrade [version]` updates the globally installed Mole CLI and bundled
scaffold from the GitHub tag `vX.Y.Z`. It never rewrites an existing workspace's
local product context. Upgrade a workspace separately by reviewing the release
notes and applying only the ownership classes you choose.

## What currently works

### Raw inbox flow
You can still drop files manually into:
- `6-raw/inbox/`

That remains a first-class workflow. When the inbox contains user/customer signals, synthesis should also update `4-context/personas.md` so the workspace builds a living set of evidence-backed personas over time.

### Command capture flow
You can also capture through commands:
- `mole insight "..."`
- `mole-insight` skill after running `mole install skills`

### Creation flow
You can create draft artifacts such as:
- roadmap
- spec
- decision brief
- strategy memo
- prioritisation draft
- product update

## Current prototype status

This is early but usable.

What exists now:
- file-native mole structure
- CLI scaffold
- agent skill installation
- source/instance version checks
- read-only update report using `upgrade-ownership.json`
- raw insight capture
- draft artifact generation
- review lifecycle with human-only approval and accepted-only retrieval
- stakeholder memory and product update guidance
- lightweight local Molehill Metrics for processed inbox items
- docs for upgrade/adoption/command UX

What is still lightweight:
- synthesis logic is instruction-driven rather than deeply automated
- command set is intentionally small
- naming/brand may still evolve

## Contributing

Use [GitHub Issues](https://github.com/simplybenuk/product-mole/issues) for public work proposals and the repository's pull request process for changes. See the [contribution guide](governance/contribution-guide.md) for the required checks and content rules.

Contributors may use their own planning, agent, editor, and development workflows. Mole does not require a particular agent toolkit. Local task plans, progress journals, and agent configuration should stay out of pull requests unless they become an agreed part of the project or product.

## Local UI (v0 scaffold)

A minimal local HTML UI is included for immediate testing:

- start server: `node ui/server.mjs`
- open: `http://localhost:4173`
- guide: [ui/README.md](ui/README.md)

Current v0 features:
- Quick Capture form (writes to `6-raw/inbox/`)
- Waiting on Human queue viewer
- Basic repo explorer

## Suggested Monday opener

Ask:

> What inputs do you need from me today?

Then run `mole review input-queue` and answer the top 3 asks.
