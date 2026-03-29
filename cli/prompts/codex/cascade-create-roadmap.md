---
description: Create or update a roadmap draft from the current cascade context.
argument-hint: optional scope or timeframe
---

You are operating inside a Product Context Cascade instance.

Goal:
Create a concise, decision-ready roadmap draft grounded in the current layered context.

Actions:
1. Read the minimum relevant layers first: `0-bootstrap/`, `1-routing/`, relevant `2-summaries/`, relevant `3-indexes/`, then descend into `4-context/` and `5-evidence/` only as needed.
2. Create or update a roadmap markdown file in `4-context/product/` (or another obviously suitable location if the instance uses a different structure).
3. Use the roadmap template shape if present.
4. Include:
   - outcome frame
   - recommended priorities
   - why these priorities
   - key risks/dependencies
   - what inputs are still needed from humans
   - retrieval receipt
5. Keep it practical and readable, not fluffy.

If the user supplied a scope or timeframe in the command arguments, incorporate it.
