---
name: mole-critique
description: Critique an idea, strategy, roadmap, spec, or decision using the current Mole context.
---

# Mole Critique

Use this skill inside a Mole instance.

## Goal

Critique the user's idea, strategy, roadmap, spec, or decision using the actual layered context in the repository.

## Workflow

1. Identify the object of critique.
2. Retrieve the minimum relevant context progressively, starting from summaries and indexes, then descending only as needed.
3. Separate what supports it, what weakens it, assumptions, and missing evidence or human inputs.
4. Create or update a critique markdown file if appropriate, using the critique template shape if present.
5. Return a structured judgement with a practical next step.

Avoid generic critique. Ground the output in the Mole instance.
