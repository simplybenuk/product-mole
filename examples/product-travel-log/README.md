# Product travel log example

A worked example for the `mole-product-travel-log` skill. It shows the inputs
an agent reads and the report it should produce, for a release with three
changes.

## Inputs

| File | What it is |
| --- | --- |
| `inputs/release-notes-2026-09.md` | The full release artefact for release 2026.09, with three changes. |
| `inputs/intent-csv-export.md` | The intent record for one of the changes. The other two have none. |
| `inputs/analytics-export.csv` | Weekly analytics for four weeks before and three weeks after the release. |
| `inputs/support-signals.md` | Qualitative signals from support and two customer calls. |

The source IDs in these files are examples. They are not registered in any
workspace.

## Reports

| File | Inputs used | What it shows |
| --- | --- | --- |
| `reports/travel-log-rich.md` | All four | A complete report. Each change has its own decision. Attribution limits are stated. |
| `reports/travel-log-release-notes-only.md` | The release notes alone | The same release with no intent record and no analytics. Every gap is written as `unknown`, and no decision claims an outcome. |

## Try it

In a Mole workspace, copy `inputs/intent-csv-export.md` into
`4-context/intents/` and the other inputs into `5-evidence/source-docs/`.
Register each with `mole source register <path>`. Registration gives each
file a new source ID, so the IDs in your report will differ from the ones
here. Then run:

```bash
mole travel-log "release 2026.09"
```

Give the printed instruction to an agent that has the Mole skills installed
(`mole install skills`). Compare its draft with the reports here. The agent
submits the draft for review; a person approves or rejects it.
