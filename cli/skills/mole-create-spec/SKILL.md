---
name: mole-create-spec
description: Create or update a product spec draft from the current Mole context when the user asks for a product spec, feature spec, or problem statement.
---

# Mole Create Spec

Use this skill inside a Mole instance.

## Goal

Create a strong product spec draft from the best available Mole context.

## Workflow

1. Start with `0-bootstrap/`, `1-routing/`, relevant summaries/indexes, then descend only as needed.
2. Create or update a spec markdown file in `4-context/product/`, or another obviously suitable location if the instance differs.
3. Use the spec template shape if present.
4. Include problem, users/stakeholders, goal, non-goals, proposed solution, scope in/out, constraints, open questions, missing human inputs, and a retrieval receipt.
5. Keep assumptions explicit.

If the user supplied a specific feature or problem, focus the spec around that.

## Review state

Rely on accepted context. `mole retrieve` lists it; a file with no accepted lifecycle record is unreviewed. The output of this skill is a draft. Create it with `mole create`, or register it with `mole source register <path>` and `mole lifecycle register <source-id> --state draft --actor "<agent name>" --actor-type agent`. When it is ready, run `mole lifecycle submit <record-id>` with `--source <source-id>` for each supporting source. Never run `approve`, `reject`, or `supersede`; a person makes those decisions.
