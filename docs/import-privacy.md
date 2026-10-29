# Privacy-managed release and analytics imports

Explicit supported-format imports keep the exact input bytes only when Mole's
bounded scanner finds no rule match. If any value needs redaction or is
uncertain, the importer refuses before creating its request, capture, source,
lifecycle record or draft evidence. Your original file stays unchanged. Use
the existing [quarantine and review flow](raw-inbox-privacy.md) to prepare a
reviewed derivative, then explicitly select that source ID for a new import.
An import never silently substitutes a derivative or rewrites measurements.

This policy applies to `mole release import` and `mole analytics import`.
Markdown, JSON and CSV must be valid UTF-8 and at most 4 MiB; normalized
evidence is also bounded to 4 MiB before publication. Mole scans both
the original text and decoded JSON keys/string values or CSV headers/cells.
Escaping a newline in JSON does not bypass that check. Unsupported/unparseable
formats and invalid encoding get controlled errors without input excerpts.
The scanner is syntactic, not semantic certification. Review draft evidence
before promotion, even when a scan finds no match.

## Identity and retention

A new eligible input gets one privacy/source ID, managed capture time and
expiry under the normal policy, seven days by default. Its exact bytes are
stored at the generated inbox path with media type recorded separately. The
`.md` suffix does not mean JSON or CSV has become Markdown. A supplied eligible
source ID reuses its existing bytes, provenance, capture time and expiry; the
import does not copy it or renew its TTL. With a reviewed JSON/CSV derivative,
pass `--format json` or `--format csv` explicitly if its existing source media
type does not declare that format.

Each import request has a content-free receipt under
`governance/imports/release/` or `governance/imports/analytics/`. It binds
allocated input/output IDs, a hashed canonical output path, format, the
existing v1 request fingerprint and timestamps. It stores no original filename,
input excerpt or quarantine hash. Fingerprints are correlatable hashes,
not anonymization. This directory is instance-owned and must survive upgrades.
The source record's existing `source_reference` is preserved; per-request
evidence belongs to the receipt.

Run `mole privacy scan` and `mole retention purge` after a clean import. The
capture is managed immediately, so imports require no scan migration. The
usual explicit purge covers completed and interrupted imports. Purging raw
does not erase an existing cleaned draft evidence file or approve its contents.
Source/lifecycle audit recovery after deletion remains an operator task.

## Replay and recovery

An identical eligible request returns `changed:false`. Changing exact bytes,
format, bindings, supplied intents or other fingerprinted options requires a
new revision identity. A release's explicit release ID must also change when
it would otherwise select an occupied output. Imports never replace an
occupied raw or evidence file to make a retry succeed.

Replay checks the request, source and privacy metadata before opening raw
bytes or calculating their hash. Missing, unmanaged, quarantined, expired,
deleted, conflicting or unreconciled moved raw sources refuse without repairs.
An identical original file cannot resurrect a deleted capture. Selecting a
registered raw path with `--file` does not bypass the source-ID gate.
Registration alone is not privacy eligibility.

For normalized evidence that was moved, explicitly reconcile its source outside
import first. Replay validates only that registered current durable path.
Importers do not run source resolution, archive discovery or global audits;
they must not discover and hash quarantine copies while looking for a source.
A completed `mole privacy archive <source-id> --apply` preserves import
identity, expiry and replay at the canonical generated archive location. A
prepared move intent blocks import before byte opens or repair until explicit
privacy recovery. The importer shares the privacy subsystem's location and
metadata gate; arbitrary manual archive paths remain ineligible.

Publication uses complete staged bytes, verification, fsync and exclusive hard
links. A small immutable request intent precedes the privacy intent and raw
publication. A concurrent writer adopts the winning request IDs on a gated
retry. Existing files are preserved on conflicts.

There is no multi-file transaction. A stopped writer may leave request or
privacy intent, staging, raw bytes, source metadata or unregistered evidence.
Only an eligible same-receipt retry with exact stored bytes and fingerprint
may finish missing registrations/output. An intent without stored bytes, a
truncated stage, conflicting copies or ineligible retention state requires
explicit recovery. Retrying never repopulates missing raw from an external
file, allocates a replacement source ID or resets expiry. Do not delete intent
metadata to force a new import; preserve it and inspect recovery state locally.

## Executable evidence

The [worked travel-log guide](../examples/product-travel-log/acceptance/README.md)
exercises managed imports, scan, explicit synthetic expiry/purge and replay
refusal in disposable workspaces. Cross-feature regressions live in
`lib/test/import-privacy-integration.test.mjs` and run with `npm test`.
These tests are implementation evidence, not completion of human acceptance.

## Retrieval receipt

This guide follows the release, analytics, source registry and privacy contracts.
No real workspace data was imported, reviewed, promoted or purged to write it.
