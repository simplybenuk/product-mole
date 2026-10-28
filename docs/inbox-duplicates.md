# Inbox duplicate checks

Register inbox sources with `mole source register <path>` and run the duplicate
check before enriching or promoting them:

```bash
mole inbox duplicates check <source-id> <other-source-id>
mole inbox duplicates check <source-id> --threshold 0.85
```

Pass all newly registered source IDs to index the batch before comparison.
The JSON report preserves each source ID. Exact matches list conflicting
capture metadata. Near matches report the algorithm, similarity score, shared
word count, word counts, and whether attachment hashes match. No source is
merged, deleted, rewritten, or assigned another source's ID.

## Exact matches and retries

Normalization version 1 uses Unicode NFC, lowercase, and collapsed whitespace.
It preserves punctuation, numbers, and word order. In leading YAML frontmatter,
it removes only `source_id`, `captured_by`, `created_at`, and `captured_at`
lines. Other fields remain content. Every input must pass the privacy UTF-8
check. Unsupported binary originals require quarantine review and a cleaned
text derivative; they cannot be fingerprinted directly.
The fingerprint includes the sorted SHA-256 hashes of registered attachments,
including repeated attachments. Attachment labels, paths and IDs do not define
content equivalence. The original exact byte hash remains separate.

Paths and filenames do not affect the fingerprint. A reconciled source move
keeps its source ID and fingerprint. Changed or unresolved sources, changed
attachments, multiple IDs claiming a path, and conflicting ledger files stop
processing. Correcting an indexed source requires explicit ledger reconciliation;
there is no automatic replacement of its earlier fingerprint.

Checkpoint and completion check registered source IDs under the existing local
inbox mutation lock. A source already processed under another run, or an exact
copy of an already processed source, cannot create another completion receipt.
Reuse the existing source's output and receipt. A retry with the original run
ID and payload returns its existing receipt. Consequently duplicate retries
add no processed-input metric events. This does not deduplicate independently
registered lifecycle drafts or erase capture history. Run the check before
creating drafts to avoid doing the work twice.

Legacy and unregistered paths cannot be checkpointed or completed. A registry
record alone does not establish privacy eligibility. Use `mole privacy scan
--apply` to quarantine manual imports, then follow the documented human-reviewed
derivative release procedure before processing.
Existing receipts from before fingerprint indexing cannot supply normalized
fingerprints after their raw content is deleted. No text is reconstructed.

## Human review

Different capture timestamps, channels, or provider references may mean two
separate events. Privacy redaction can also collapse distinct originals into
the same cleaned text. Any exact match involving a redacted source reports
`privacy_redaction` and requires a human decision. Exact content with conflicting metadata requires a human
decision before completion. Sync conflict source copies remain blocked by the
inbox audit and processing lock rules; this check never resolves a sync conflict.

A person records a directed decision with:

```bash
mole inbox duplicates decide <source-id> <target-id> duplicate --confirm-human --actor reviewer-id --reason retry
```

Statuses are `duplicate`, `linked`, `superseded`, and `distinct`. Duplicate and
superseded sources cannot produce another result; their target remains eligible.
Linked and distinct decisions permit separate processing. A decision records both
IDs, a timestamp, local actor ID, and a reason code. Actor IDs contain only
letters, digits, dots, underscores or hyphens, up to 64 characters. Use an opaque
local identifier. Reasons are `retry`, `sync-copy`, `same-observation`,
`related-observation`, `newer-observation`, and `separate-event`. Free text is
excluded to keep sensitive source content out of this ledger.

Decisions are immutable and retries are idempotent. A second different decision
for the same pair fails closed, regardless of direction. Reversals and malformed
or conflicting sync records require explicit owner reconciliation outside this
command. Agents must not use `--confirm-human` on a person's behalf.

## Near matches and retention

Near matching uses local word-set Jaccard overlap with a default threshold of
0.8 and at least five shared words. Configure the threshold per check between
0.5 and 1. Similarity never automatically merges or suppresses processing.
Overlapping vocabulary can describe opposite claims or separate observations;
a person must read the source material before deciding. This lexical algorithm
has no semantic model and can miss paraphrases. It makes no hosted AI calls.
Sources above 2 MiB fail closed, including attachments, to bound local reads.

`governance/inbox-duplicates/` is instance-owned. Its durable records contain
version 2 fingerprints, byte and attachment hashes, source IDs, capture and
registration times, and hashes of channel/provider reference. Decisions contain
only the fields described above. Raw text, word sets, embeddings, paths, URLs,
and provider credentials are not copied into the ledger. Hashes allow correlation
and dictionary guessing; they are sensitive metadata, not anonymization.

Near checks read currently resolvable source text into memory. When raw content
is deleted under the privacy policy, near comparison against it stops. Exact
fingerprints and decisions remain useful without that content. Privacy approval
precedes indexing through `assertPrivacyProcessing`, including every indexed live
candidate and attachment. Metadata-only source lookup avoids the general resolver
and its ungated hashes. Edited sensitive, expired, quarantined, missing or ambiguous
inputs stop the entire batch before duplicate ledger writes.
Only privacy-cleaned UTF-8 inputs can acquire a version 2 fingerprint. Earlier
version 1 records fail closed and require owner review; they are never silently
trusted or migrated. Stored hashes for deleted privacy tombstones participate
in exact comparison only. They never authorize processing a restored source.

Privacy storage currently supports generated source-ID locations only. The
quarantine derivative release moves cleaned bytes to the generated inbox path
without changing source ID or expiry. Arbitrary archive/rename moves fail closed;
restore the canonical generated path without changing bytes, then reconcile a
stale source registry path if necessary. There is no privacy-aware archive command.
Do not change a privacy manifest to authorize an arbitrary path. Quarantine
release is a privacy decision and leaves the lifecycle state raw, not accepted.

Batch checks validate all live indexed candidates and attachments before writes.
An unsafe or expired indexed candidate therefore blocks new indexing until the
owner resolves it or runs retention purge after ending active claims. Empty
completion can release a claim without processing its unsafe input. Tombstones
then allow metadata-only exact comparison. Near matching against a deleted
candidate stops. No automatic exception, approval, or ambiguity decision is made.

Never include raw content or credentials in actor identifiers.

Retrieval receipt: based on the source registry, inbox processing receipt
contract, and disposable duplicate-handling tests. No instance content was used.
