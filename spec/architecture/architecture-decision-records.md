# Architecture Decision Records

## ADR-0001: Keep Files As The Source Of Truth

Status: Accepted

Decision:
Mole keeps durable product context in repository files rather than requiring a database or hosted service.

Consequences:
- Users can inspect, version, and edit their context directly.
- Agents and commands must respect the repository structure.
- Automation should be conservative because local files may contain product-specific truth.

## ADR-0002: Upgrade By Declared Ownership Classes

Status: Draft

Decision:
Working-instance upgrades should classify paths before changing them. Initial classes should include safe-copy, merge-carefully, and never-overwrite.

Consequences:
- Upgrade reports can be useful before automatic upgrades exist.
- User-owned directories such as raw inputs, evidence, and context modules can be protected.
- The CLI needs a machine-readable ownership manifest before meaningful upgrade automation.

