```yaml
---
title: <title>
layer: <2|3|4|5|6>
owner: <name>
last_updated: YYYY-MM-DD
confidence: high|medium|low
status: draft|active|archived
tags: [tag1, tag2]
summary: <one-line summary>
source_id: src_<lowercase-uuidv4>  # null until this file is registered
source_refs: []
when_to_read:
  - <condition>
skip_if:
  - <condition>
---
```

`source_id` identifies the file that contains this frontmatter when that file
has been registered as a source. `source_refs` contains references to source
material used by the document:

```yaml
source_refs:
  - source_id: src_8d31cc34-c04c-41ac-82e3-75518bb5a7e0
    path: 6-raw/archive/2026-09/checkout-note.md
    relationship: supports
```

`status` describes the file for readers. It is not the review state. The
review ledger at `governance/lifecycle/records.json` decides whether a file is
a draft, pending review, or accepted, and `status: active` never counts as an
approval. Check a file's state with `mole lifecycle list` or `mole retrieve`.

The ID is required in each reference. The path is an optional hint for display
and navigation. Resolve references by ID first because a path can change after
an archive move. Keep any existing `source` field as legacy metadata unless its
meaning is explicit. It is not the canonical provenance field.
