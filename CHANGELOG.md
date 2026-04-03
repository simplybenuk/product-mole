# Changelog

All notable changes to Mole should be documented here.

The format is loosely based on Keep a Changelog and uses lightweight SemVer.

## [0.2.0] - 2026-03-29

### Added
- `docs/upgrade-and-instance-management.md` to define how local mole instances should track versions, ownership, and upgrades.
- `cascade.instance-template.yaml` as a starter instance metadata file for adopted cascades.
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
