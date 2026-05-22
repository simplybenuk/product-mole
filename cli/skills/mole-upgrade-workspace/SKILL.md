---
name: mole-upgrade-workspace
description: Safely plan and execute upgrades for an existing Mole workspace created on an older version.
---

# Mole Upgrade Workspace

Use this skill inside an existing Mole workspace that was created from an older Mole version.

## Goal

Upgrade a workspace conservatively:
- automate checks and safe actions
- avoid overwriting user-owned context
- produce a clear manual merge queue for risky paths

## Workflow

1. **Preflight**
   - Confirm required tools are available: `node`, `npm`, `mole`.
   - Confirm current directory looks like a Mole workspace (`mole.instance.yaml`, required top-level folders).

2. **Update tooling first**
   - If needed, instruct or run:
     - `npm install -g github:simplybenuk/product-mole#main`
     - `mole install skills`

3. **Assess current workspace**
   - Run:
     - `mole doctor`
     - `mole check-updates`
   - Capture source version, instance version, and warnings.

4. **Safety baseline**
   - Ensure changes are tracked before edits (git status, branch, or snapshot).
   - If git is available, create a dedicated upgrade branch.

5. **Classify upgrade work**
   - Treat output paths according to `upgrade-ownership.json` classes:
     - `safe-copy`: okay to apply with low risk
     - `merge-carefully`: prepare manual review tasks
     - `never-overwrite`: do not auto-apply

6. **Apply only safe updates**
   - Apply `safe-copy` additions/refreshes only.
   - Do **not** auto-overwrite `merge-carefully` or `never-overwrite` paths.

7. **Produce upgrade report**
   - Output a concise report with:
     - what was auto-applied
     - what needs manual merge/review
     - blockers and follow-ups

8. **Update workspace metadata**
   - Update `mole.instance.yaml` fields where appropriate:
     - `last_upgraded_from`
     - `last_upgraded_to`
     - notable local structure notes

## Guardrails

- Never claim a workspace was fully upgraded if manual-review paths remain.
- Prefer explicit diffs and patch suggestions for manual merges.
- If preflight fails (missing npm/mole, invalid workspace), stop and return concrete remediation steps.
