---
description: Capture a raw product insight into the current mole instance inbox.
argument-hint: insight text
---

Interpret the user argument as a short raw product insight.

Actions:
1. Confirm the current workspace is a mole instance (look for `mole.instance.yaml`).
2. Create a new markdown file in `6-raw/inbox/quick-notes/`.
3. Use today's date in the filename plus a short slug from the insight.
4. Write minimal frontmatter with:
   - `title: Raw Insight`
   - `capture_type: insight`
   - `source: codex command`
   - `created_at:` current ISO timestamp
   - `summary:` the raw insight text
   - `tags: []`
5. Put the exact insight text under `## Insight`.
6. Leave `## Context / why it matters` blank unless the user included extra context.
7. End by telling the user where it was saved and suggest synthesising the inbox next.

Do not over-analyse the insight unless asked. Capture first.
