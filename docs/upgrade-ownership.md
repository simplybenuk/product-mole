# Upgrade Ownership

`upgrade-ownership.json` defines how Mole should treat paths when checking or applying working-instance upgrades.

## Classes

### safe-copy

Source-owned paths that can usually be copied or refreshed when absent. Upgrade tools should still avoid blind overwrites of changed files. The versioned source-record schema belongs here.

### merge-carefully

Paths that may contain local customisation and should be reviewed before upstream changes are applied.

### never-overwrite

Instance-owned product context, evidence, raw inputs, and source registry data. Upgrade automation must not overwrite these paths. Keep the entire `governance/sources/` directory with the workspace that created it.

## Current Rule

Treat `4-context/`, `5-evidence/`, and `6-raw/` as user-owned by default.

The source registry follows the same rule. Copy the schema from upstream when
appropriate, but never replace `governance/sources/` in an existing instance.
See
[`source-provenance.md`](./source-provenance.md) for the record and migration
contract.
