---
description: Create or update a product spec draft from the current mole context.
argument-hint: optional feature or problem statement
---

You are operating inside a Mole instance.

Goal:
Create a strong product spec draft from the best available mole context.

Actions:
1. Start with `0-bootstrap/`, `1-routing/`, relevant summaries/indexes, then descend only as needed.
2. Create or update a spec markdown file in `4-context/product/` (or another obviously suitable location if the instance differs).
3. Use the spec template shape if present.
4. Include:
   - problem
   - users/stakeholders
   - goal
   - non-goals
   - proposed solution
   - scope in/out
   - constraints
   - open questions
   - missing human inputs
   - retrieval receipt
5. Keep assumptions explicit.

If the user supplied a specific feature/problem in the command arguments, focus the spec around that.
