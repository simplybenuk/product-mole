# Working Instance Upgrade Plan

## Problem

Mole now has a usable source/tool repo, CLI scaffold, and Codex prompt installation flow.

However, once a working mole instance has been created, there is not yet a clean or reliable way to upgrade that instance when the source/tool repo evolves.

Current reality:
- source/tool repo can be updated with `git pull`
- Codex prompts can be refreshed with `node cli/cascade.mjs install codex`
- working instances do **not** yet have a robust upgrade path

This is now one of the main product gaps.

---

## Goal

Make working mole instances upgradeable in a way that is:
- understandable
- safe enough for real use
- respectful of local customisation
- useful before fully magical

The system should help answer:
- what version is this instance on?
- what changed upstream?
- what can be applied safely?
- what needs manual review?

---

## Guiding principle

**Scaffold once, upgrade by declared migrations.**

Do not pretend that a heavily customised file-native instance can be blindly overwritten.

Instead:
- declare ownership boundaries
- record instance version and customisations
- apply upgrades in a structured way
- require manual review where appropriate

---

## Desired model

### 1. Source/tool repo
Owns:
- CLI
- prompt installers
- docs
- templates
- framework structure
- release notes
- upgrade metadata

### 2. Working instance
Owns:
- real context
- raw inbox data
- evidence
- context modules
- product-specific summaries/indexes
- local conventions and drift

### 3. Upgrade layer
Bridges the two by:
- comparing instance version with source version
- identifying safe additions/changes
- flagging merge-sensitive files
- writing an upgrade report

---

## Next implementation steps

### Phase 1 — make state visible

Add stronger instance metadata and status checks so the user can see:
- source/tool version
- instance version
- whether the instance has drifted
- whether the source repo is newer

Potential commands:
```bash
mole doctor
mole check-updates
```

Expected output should include:
- current instance version
- source version
- whether an update is available
- important warnings if local customisations are present

---

### Phase 2 — define upgrade classes clearly

Explicitly classify files as:

#### Safe to copy/update
Examples:
- docs
- templates
- routing guidance
- some bootstrap materials

#### Merge carefully
Examples:
- README
- summaries
- indexes
- governance files often edited locally

#### Never overwrite automatically
Examples:
- 4-context
- 5-evidence
- 6-raw
- deeply local product truth

This logic should exist in a machine-readable form, not only in prose.

---

### Phase 3 — produce an upgrade report

Add a command like:
```bash
mole check-updates
```

It should:
- compare source/tool repo version to `cascade.instance.yaml`
- describe what changed since the instance version
- list files that could be copied safely
- list files that need manual merge
- list files that should be left alone

This alone would be a major improvement.

---

### Phase 4 — add limited safe upgrade support

Add a command like:
```bash
mole upgrade
```

First version should be conservative.
It should only:
- apply clearly safe additions
- update machine-owned metadata
- avoid overwriting merge-sensitive or instance-owned files
- generate a report for anything manual

This should feel like:
- helpful and safe-ish
not:
- magical and dangerous

---

## Command surface proposal

### Immediate / near-term
- `mole doctor`
- `mole check-updates`

### Later
- `mole upgrade`
- maybe `mole upgrade --apply-safe`
- maybe `mole upgrade --report-only`

---

## Open questions

1. Should a working instance include a hidden marker showing which files were copied from source?
2. Should safe-upgrade rules live in `cascade.instance.yaml`, a separate manifest, or both?
3. How much of README/summaries should be treated as user-owned vs framework-owned?
4. Should UI files be included in safe-upgrade scope or treated as optional?
5. How do we avoid the user needing both the source repo and instance repo forever?

---

## Recommendation

The next meaningful product step is not just more commands.
It is a credible **working-instance upgrade model**.

Until this exists, Cascade is good for creating and using instances, but weak on lifecycle management.

That is the gap to close next.
