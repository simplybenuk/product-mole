# Run Receipts

Store retrieval receipts/logs for significant generated outputs.
Suggested filename: `YYYY-MM-DD-<task-slug>.md`

When a receipt names registered source material, include an ID-bearing
`source_refs` list alongside the human-readable files read:

```yaml
source_refs:
  - source_id: src_8d31cc34-c04c-41ac-82e3-75518bb5a7e0
    path: 5-evidence/source-docs/customer-notes.md
    relationship: supports
```

JSON receipts use the same object keys. Keep existing path-only fields while
older readers are supported, but let `source_id` be the identity used for
resolution and deduplication. A path is a display and navigation hint, not a
stable locator.
