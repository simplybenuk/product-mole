---
name: mole-insight
description: Capture a raw product insight into the current Mole instance inbox when the user gives a short note, signal, or insight to save.
---

# Mole Insight

Use this skill inside a Mole instance.

## Goal

Interpret the user input as a short raw product insight and capture it before analysing it.

## Workflow

1. Confirm the current workspace is a Mole instance by looking for `mole.instance.yaml`.
2. Create a new markdown file in `6-raw/inbox/quick-notes/`.
3. Use today's date in the filename plus a short slug from the insight.
4. Write minimal frontmatter with `title`, `capture_type`, `source`, `created_at`, `summary`, and `tags`.
5. Put the exact insight text under `## Insight`.
6. Leave `## Context / why it matters` blank unless the user included extra context.
7. End by telling the user where it was saved and suggest synthesising the inbox next.

Do not over-analyse the insight unless asked.
