# Target Architecture

## Overview

Mole is a file-native product context system with a thin CLI and optional agent workflows layered on top.

The repository remains the source of truth. Commands and agents should help users navigate, validate, synthesise, and create from that source of truth rather than moving durable context into a separate runtime.

## Main Components

- `0-bootstrap/`: agent and repository operating rules.
- `1-routing/`: retrieval and task routing guidance.
- `2-summaries/`: compact product context.
- `3-indexes/`: navigation pointers to deeper material.
- `4-context/`: durable synthesised context modules and decisions.
- `5-evidence/`: validation material, source documents, and signal clusters.
- `6-raw/`: inbox and raw captures.
- `templates/`: reusable document and artefact templates.
- `governance/`: quality checks, input queue, change logs, and receipts.
- `cli/`: lightweight command surface for setup, capture, creation, review, and lifecycle checks.
- `plans/`: Ralph-compatible delivery planning artifacts.

## Architectural Principles

- Files remain inspectable and editable without a proprietary runtime.
- Agents retrieve top-down and stop at sufficiency.
- CLI commands should be conservative and explain what they did.
- Working-instance upgrades must distinguish source-owned, merge-sensitive, and user-owned paths.
- User-owned context must not be overwritten automatically.

## Current Architectural Gap

The source/tool repo can create working instances, but those instances do not yet have a robust upgrade path. The near-term architecture should add metadata, ownership classification, and read-only reports before applying upgrades.

