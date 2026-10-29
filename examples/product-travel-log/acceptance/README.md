# Run the travel log loop locally

This worked example uses synthetic files and the real Mole library and CLI.
It creates a fresh temporary workspace, exercises the loop, prints a JSON
trace, and deletes that workspace even when an assertion fails. It accepts no
workspace path. Nothing is imported or approved in your own instance.

From the repository root with Node.js 18 or later:

```bash
node examples/product-travel-log/acceptance/run.mjs --synthetic-review > /tmp/mole-travel-rich.json
node examples/product-travel-log/acceptance/run.mjs --synthetic-review --release-only > /tmp/mole-travel-gaps.json
node --test cli/test/travel-log-acceptance.test.mjs
```

The first two commands exit zero when their assertions pass. Read the trace
with `cat /tmp/mole-travel-rich.json` or `cat /tmp/mole-travel-gaps.json`.
`npm test` also runs both scenarios. Temporary paths in the trace have already
been removed; the full draft report and later decision are included as text.
The synthetic human-review flag is required by the example runner. It is not
a Mole approval option and must not be used to justify approval of real data.

## Follow the rich example

The executable [runner](run.mjs) contains the command sequence and assertions.
It uses the installed Node executable and the repository's `cli/mole.mjs`, so
there is no global install, network call, vendor account or OpenSpec dependency.
The following CLI arguments run inside its disposable workspace:

```text
release import inputs/release.md --namespace acceptance --key release-09 --intents inputs/intents.json
analytics import inputs/analytics.json --namespace acceptance --key review-1
travel-log release-2026-09
create product-travel-log 4-context/travel-log/acceptance.md
learning promote <returned report record ID>
learning list --query "recovery message" --release-id release-2026-09
learning list --history
```

1. The runner scaffolds a workspace through `createWorkspaceScaffold`. It
   registers [intent.md](intent.md) and parses it through `parseChangeRecord`.
   The explicit `change-search-typos` ID links intent to delivery. Missing
   hypothesis and guardrails stay gaps; the target is 65 percent search
   completion. This source is unreviewed intent material, not accepted context.
2. The release importer captures all bytes of [release.md](release.md) and
   creates three normalized changes. Search has an explicit intent link; CSV
   has none; the menu's requested intent ID is unresolved. Delivery records
   retain unknown outcomes and do not copy intent from delivery prose.
3. The analytics importer reads the existing [aggregate fixture](../../analytics-evidence/review.json).
   Its explicit change ID points to the search intent and its release ID
   matches this release. It reports 50 percent baseline and 60 percent post,
   with 1,000 and 1,200 eligible searches, complete adjacent weekly windows,
   +10 percentage points and +20 percent relative. `causal_claim` is false;
   support contacts remain `not_measured` with a null delta. The runner
   registers [signals.md](signals.md) alongside these quantitative sources.
4. `travel-log` prints instructions; `create` opens a tracked draft. The
   runner fills [report.md](report.md) with explicitly authored fixture prose
   and the actual source IDs. It does not invoke an LLM. Inspect the trace's
   `draft.report`: intent, delivery, observations, interpretation, learning,
   decisions and gaps each have their own section. The target was not met in
   these observations. The campaign and account mix prevent a causal claim;
   selected support notes cannot establish prevalence or retention impact.
5. The report is submitted through `transitionLifecycleRecord` with all
   supporting source IDs. Promotion fails while it is pending. Only in this
   disposable workspace does the runner simulate a human approval using the
   real lifecycle API and expected revision. Promotion copies the exact
   approved report, lesson, links and reviewer provenance. A repeated
   promotion is a no-op. Approval prose alone never grants acceptance.
6. A later roadmap review calls `learning list` with a query and release ID.
   It uses the current lesson to write a separate draft decision, cites the
   learning ID, report record ID and approval revision, and registers the
   decision as draft. It recommends investigation and evidence collection;
   it does not approve a rollout or rewrite the owner's summary.
7. The runner edits the accepted report and verifies that current retrieval
   becomes empty immediately. It restores the exact approved bytes, then
   simulates review of a separate replacement with `supersedes`. The old
   learning disappears before replacement promotion; afterwards only the
   replacement is current. Historical snapshots remain unverified history.

Repeated release and analytics imports return `changed:false`. A release
retry with different bytes under the same identity fails and preserves the
original capture. The runner checks raw byte equality, field provenance,
resolvable source IDs, immutable learning snapshots and an unchanged owner
summary. Source IDs are generated per disposable workspace; change and
release IDs remain explicit and stable.

Finally, each scenario runs privacy scan with zero unknown imports, verifies
that retention requires no migration, applies a future synthetic purge, and
checks that release/analytics replay refuses without ledger changes or raw
resurrection. This happens only in the runner-owned disposable workspace.

## Read the release-only case

The second command imports the same release with an empty intent list and no
analytics or qualitative source. It uses no invented baseline, target, metric
or outcome. All three decisions are `unknown`. After synthetic review, the
retrievable lesson says delivery alone provides no outcome learning. Empty
intent references describe missing links; they do not prove intent exists.

## Use the workflow on your own files

Start with [release ingestion](../../../docs/release-ingestion.md), then
[analytics ingestion](../../../docs/analytics-evidence.md). Preserve originals
and choose stable namespace/key pairs for each revision. Register qualitative
sources with `mole source register <path>` and cite their returned immutable
IDs. Inspect intent links and gaps before drafting.

Run `mole travel-log "your release"`, pass the instruction to your agent, and
review its new draft. Before submission, add the reviewed `mole-learning`
metadata and supporting source IDs described in
[accepted learning](../../../docs/accepted-learning.md). A real person makes
the lifecycle decision. After that decision, `mole learning promote` and
`mole learning list` provide current retrieval for later work. Summaries and
indexes remain user-owned and require their own review when changed.

This example covers ingestion/report/learning with the import-specific privacy
and retention boundaries described in the [import guide](../../../docs/import-privacy.md).
It does not certify semantic privacy detection, distributed coordination or
backup erasure. The combined stack still requires independent review.
Synthetic test review does not complete human testing of the product.

## Retrieval receipt

This guide follows the change-record, release-ingestion, analytics-evidence,
source-provenance, review-lifecycle and accepted-learning contracts. The
runner reads only repository fixtures, then operates on its own temporary
workspace. No instance sources or durable context were reviewed or promoted.
