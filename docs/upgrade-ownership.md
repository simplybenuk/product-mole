# Upgrade Ownership

`upgrade-ownership.json` defines how Mole should treat paths when checking or applying working-instance upgrades.

## Classes

### safe-copy

Source-owned paths that can usually be copied or refreshed when absent. Upgrade tools should still avoid blind overwrites of changed files. The versioned source-record, review-lifecycle, and input-queue schemas belong here.

### merge-carefully

Paths that may contain local customisation and should be reviewed before upstream changes are applied.

### never-overwrite

Instance-owned product context, evidence, raw inputs, source registry data, the review ledger, and the human-input queue. Upgrade automation must not overwrite these paths. Keep the entire `governance/sources/`, `governance/lifecycle/`, and `governance/input-queue/` directories with the workspace that created them. `governance/input-queue.md` stays in merge-carefully: its table is generated from the queue, and the text around it may be local.

## Current Rule

Treat `4-context/`, `5-evidence/`, and `6-raw/` as user-owned by default.

The source registry follows the same rule. Copy the schema from upstream when
appropriate, but never replace `governance/sources/` in an existing instance.
See
[`source-provenance.md`](./source-provenance.md) for the record and migration
contract.
