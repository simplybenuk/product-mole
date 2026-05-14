---
name: mole-create-roadmap
description: Create or update a roadmap draft from the current Mole context when the user asks for roadmap creation, roadmap planning, or a Mole roadmap.
---

# Mole Create Roadmap

Use this skill inside a Mole instance.

## Goal

Create a concise, decision-ready roadmap draft grounded in the current layered context.

## Workflow

1. Read the minimum relevant layers first: `0-bootstrap/`, `1-routing/`, relevant `2-summaries/`, relevant `3-indexes/`, then descend into `4-context/` and `5-evidence/` only as needed.
2. Create or update a roadmap markdown file in `4-context/product/`, or another obviously suitable location if the instance uses a different structure.
3. Use the roadmap template shape if present.
4. Include outcome frame, recommended priorities, why these priorities, key risks/dependencies, missing human inputs, and a retrieval receipt.
5. Keep it practical and readable.

If the user supplied a scope or timeframe, incorporate it.
