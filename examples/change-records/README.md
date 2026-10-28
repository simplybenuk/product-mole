# Change record examples

These disposable examples demonstrate the [v1 change contract](../../docs/change-records.md).

- [OpenSpec-style proposal](openspec.md) maps `Why` and `What changes` without an OpenSpec dependency.
- [Other specification](specification.md) supplies explicit headings with sparse intent.
- [Release notes only](release-notes.md) report delivery without inventing a hypothesis or measurement result.
- [Manual capture](manual.json) records an inconclusive result, uncertainty and a next decision.

The Markdown files are adapter inputs. Pass an explicit source descriptor and stable identity to `parseChangeRecord`. The JSON file is sparse manual input for the JSON adapter. All produce the same normalized JSON shape, with field provenance and visible intent gaps. The focused module tests parse all four files.
