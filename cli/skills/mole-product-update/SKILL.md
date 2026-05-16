---
name: mole-product-update
description: Generate stakeholder-specific product updates from Mole context when the user asks for a product update, exec update, team update, email, Teams message, blog, or status note.
---

# Mole Product Update

Use this skill inside a Mole instance.

## Goal

Generate a product update that is tailored to a stakeholder or group, grounded in Mole context, and formatted for the requested channel.

## Workflow

1. Confirm the current workspace is a Mole instance by looking for `mole.instance.yaml`.
2. Parse the stakeholder or group, timescale, and output format from the user request. If any are missing, make the smallest reasonable assumption and state it.
3. Read stakeholder memory first, normally `4-context/stakeholders.md`, to understand role, authority, interests, concerns, preferred cadence, and preferred format.
4. Read relevant `2-summaries/` and `3-indexes/` next.
5. Descend into relevant product context in `4-context/`, evidence in `5-evidence/`, and recent raw or synthesised inbox material only as needed for the requested timescale.
6. Tailor the update to the audience's known interests, decision authority, communication preferences, recurring concerns, and likely asks.
7. Use only evidence-backed claims. Mark assumptions and uncertainty clearly.
8. Separate headline summary, progress, what changed, risks or blockers, decisions needed, asks, and suggested follow-up.
9. Produce the requested format, such as email, Teams message, blog post, executive brief, or meeting note.
10. Include a concise retrieval receipt listing the Mole files used.

If a stakeholder profile is missing or weak, say what is missing and suggest capturing or synthesising stakeholder context next.
