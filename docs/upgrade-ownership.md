# Upgrade Ownership

`upgrade-ownership.json` defines how Mole should treat paths when checking or applying working-instance upgrades.

## Classes

### safe-copy

Source-owned paths that can usually be copied or refreshed when absent. Upgrade tools should still avoid blind overwrites of changed files.

### merge-carefully

Paths that may contain local customisation and should be reviewed before upstream changes are applied.

### never-overwrite

Instance-owned product context, evidence, and raw inputs. Upgrade automation must not overwrite these paths.

## Current Rule

Treat `4-context/`, `5-evidence/`, and `6-raw/` as user-owned by default.

