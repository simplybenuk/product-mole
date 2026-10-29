# Import a local release

`mole release import` captures a local release artifact and creates a draft event with one normalized record per change. It uses Node 18 or later. It requires no OpenSpec installation, vendor account, authentication, network connection, or extra package.

```bash
mole release import release.md --namespace my-product --key release-2026-09
mole release import release.json --namespace my-product --key release-2026-09 --intents intents.json
mole release import --source-id src_8d31cc34-c04c-41ac-82e3-75518bb5a7e0 --namespace my-product --key release-2026-09
```

Run these commands in your Mole workspace. The input file can live outside it and is read only. `--source-id` selects a privacy-eligible managed source by immutable identity. Its registry and privacy current paths must agree; import never discovers a move or reconciles it automatically. Supply either a file or a source ID. `--format markdown|json` overrides extension detection.

Choose a stable product namespace and release key. These identify an import across file renames. A source-supplied `release_id` takes precedence. The immutable import request receipt stores a fingerprint of the release namespace/key, selected format, supplied intents, and exact input bytes. This evidence binds the immutable source ID without replacing existing source provenance. Repeating an identical import returns `changed: false`; changed source bytes, intent links, or normalized data under the same release identity fail. Give revisions their own release ID and key. An explicit release ID must also change for a revision. Never delete the earlier capture to force replacement.

## Markdown and manual context

The [multi-change fixture](../examples/release-ingestion/multi-change.md) uses this bounded syntax:

```markdown
# September release
Release ID: product-release-2026-09
Release date: 2026-09-30

## Changes
- Search handles typing mistakes [intent:search-typos]
- Export CSV files

Full scope: [delivery summary](https://example.test/releases/2026-09)
```

The first H1 supplies the title. `Release date:` supplies a calendar date. Each top-level `- ` or `* ` bullet outside fenced code is a change candidate. Only an explicit `[intent:ID]` marker requests an intent link. Markdown links supply source links. Missing dates remain null. Multiple date or identity declarations fail. This adapter reads one release at a time. Extract the relevant entry from a long changelog first, or use manual JSON; it does not guess which release to import.

For full prose summaries, richer changelogs, Linear exports, or delivery exports with other shapes, map the local content into the [manual JSON example](../examples/release-ingestion/manual.json). Preserve the full original export separately and include its registered source reference in `source_links` or a change's `evidence`. The importer captures the supplied JSON exactly; it does not claim to capture files merely mentioned in it.

The JSON envelope accepts only `release_id`, `title`, `released_at`, `source_links`, and a nonempty `changes` array. Each candidate accepts the [sparse change fields](change-records.md), plus `key`, `intent_id`, `description`, and `locator`. Descriptions represent delivery scope. Only explicit `expected_outcome` populates that intent field. `What changes` never becomes expected outcome. A release with no measurements retains unknown outcome status and null observed outcome. Source claims remain unverified claims even when they contain explicit outcome classifications.

Give each JSON change a stable `key` or `change_id` when available. Without either, generated IDs use candidate position within the stable release identity; reordering requires a new revision. Duplicate change IDs fail. An explicit `intent_id` links to the intent record's `change_id`; a delivery `change_id` alone never implies an intent link.

## Export adapters

JSON detection also accepts these local export subsets:

- GitHub release objects with `tag_name` and string `body`. `name` supplies title, `published_at` supplies its date, `html_url` supplies a source link, and the body uses the Markdown bullet adapter.
- GitHub PR objects or arrays with `number` and `title`, optional string `body`, and `url` or `html_url`. PR numbers become stable candidate keys, body text remains description, and URLs become evidence references. The release date remains unknown.
- Jira objects with `issues`, each with `key` and `fields.summary`. String `fields.description` remains delivery description. Rich Jira descriptions need manual mapping.

Other export shapes fail or require manual JSON. These adapters never fetch linked pages or treat a PR number, Jira key, delivery status, or release note as proof of intent or measurable results.

## Intent links and review

`--intents` reads an explicitly supplied JSON array of normalized version 1 change records. It does not search files or imply that those intent records have human approval. Consult their lifecycle state separately.

Each output change has `record`, `description`, `locator`, and `intent_link`. Link statuses are:

| Status | Meaning |
| --- | --- |
| `explicit` | Exactly one supplied intent record has the requested stable ID. |
| `unresolved_id` | The requested ID is absent from supplied records. |
| `ambiguous_id` | Several supplied records have the requested ID. |
| `suggested` | One exact case-insensitive title match, requiring human confirmation. |
| `ambiguous` | Several title matches, requiring human selection. |
| `missing` | No explicit ID or title match. |

Only `explicit` populates `intent_link.intent_id`. Candidate entries retain source references. To confirm a suggestion, a person supplies the selected `intent_id` in a revised manual artifact and imports a new release revision. The importer never confirms suggestions or copies missing intent from delivery prose. Review each record's `gaps` before using it in a travel log.

## Storage and recovery

Eligible unchanged bytes go under the privacy-managed generated inbox path
using one stable privacy/source ID and the source media type. Normalized events
remain under `5-evidence/releases/<hashed-release-id>.json`, registered as draft
with the raw source ID as support. Request receipts are instance-owned metadata
under `governance/imports/release/`. Supplied eligible source IDs reuse their
original capture time, expiry and source reference.

Read the [shared import privacy and recovery contract](import-privacy.md) before
using source IDs, replaying old imports or moving captures. Raw metadata gates
precede byte reads/hashes. Sensitive/uncertain input refuses without importer
persistence; legacy unmanaged, quarantined, expired, missing or purged sources
cannot be replayed or repaired automatically. Importers no longer discover raw
sources by hash. Explicit normalized-evidence reconciliation is supported;
arbitrary raw archive discovery is not an import recovery strategy.

Publication remains immutable and exclusive. Same-request partial retries are
limited to still-eligible stored bytes, allocated IDs, timestamps and matching
fingerprints. Missing/truncated raw staging needs explicit recovery rather than
recopying an external file. Source and lifecycle ledgers remain instance-owned;
`review_state: draft` never approves context. See the executable
[travel-log loop](../examples/product-travel-log/acceptance/README.md).
