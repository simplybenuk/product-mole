# CLI and Command Surface

## Purpose

Define the future command experience for the mole so the system is usable as a tool, not just as a template.

The command surface should hide structural complexity and let product managers ask for outcomes.

---

## Design principle

Prefer outcome-oriented commands over structure-oriented commands.

Good:
- `create roadmap`
- `create spec`
- `synthesise inbox`
- `review input queue`

Less good:
- `read layer 2 summaries`
- `promote file x to layer 4`

The architecture exists to improve output quality. It should not become the product interface.

---

## Command shape recommendation

Use a short, memorable root command.

### Recommended working root
- `mole`

Reasons:
- short
- descriptive enough
- works in CLI form
- does not force a slash-command mental model

Slash commands like `/PCC create roadmap` can still exist later inside chat tools or local UIs, but the product should not depend on them as the primary interface.

---

## v1 command groups

### Create
Used to generate product outputs from the current mole.

Examples:
```bash
mole create roadmap
mole create spec
mole create strategy-memo
mole create prioritisation-draft
mole create decision-brief
```

### Critique
Used to pressure-test ideas and artefacts against the current mole context.

Examples:
```bash
mole critique idea
mole critique strategy
mole critique roadmap
mole critique spec
mole critique decision-brief
```

The thin CLI implementation accepts `mole critique <target> [claim-or-path]` for `idea`, `strategy`, `roadmap`, `spec`, and `decision-brief`. It prints an agent instruction that names the retrieval path and expected critique sections. It does not claim that the CLI itself has read the workspace or produced the judgement.

### Insight / note / signal capture
Used to capture chat-native or CLI-native raw context without making users think about folders.

Examples:
```bash
mole insight "Users trust CSV export more than dashboard totals"
mole note "CEO wants a faster path to pilot for regulated prospects"
mole signal "Support volume spikes after pricing page changes"
```

### Synthesise
Used to turn lower-layer/raw material into higher-signal context.

Examples:
```bash
mole synthesise inbox
mole synthesise signals
mole synthesise evidence
```

### Bootstrap / refresh top layers
Used to populate or reconcile `2-summaries/` and `3-indexes/` when they are blank, starter-template-only, stale, or incomplete.

Examples:
```bash
mole bootstrap-context
mole refresh top-layers
```

### Review
Used to inspect what needs human input or validation.

Examples:
```bash
mole review input-queue
mole review stale-summaries
mole review conflicts
```

### Validate
Used to check the health of a whole workspace without changing it.

```bash
mole validate
mole validate path/to/workspace --format json
```

`mole validate` is the complete check. It covers the inbox and its receipts,
the source registry, the review ledger, frontmatter, summaries and indexes,
duplicate files and sync conflict copies, the human-input queue, and workspace
metadata. Every finding has a stable code, a severity, a location, and a
remedy. It exits 0 when healthy, 1 with findings, 2 for invalid arguments, and
3 when it cannot run. `mole doctor` stays a quick check of versions and
folders, and `mole inbox audit` stays the focused inbox check. Finding codes
are listed in `docs/workspace-validation.md`.

### Init / upgrade
Used to scaffold an instance, compare it with the installed source, or refresh
the global CLI from a stable release tag.

Examples:
```bash
mole init
mole check-updates
mole upgrade 0.2.8
```

Pass a target release to `mole upgrade`; without one, it uses the tag matching
the installed CLI version. The command updates the global tool and bundled
scaffold, not a customised workspace.

### Source provenance

Used to register source files and keep their identities stable when paths
change. These commands operate on the local registry under
`governance/sources/`:

```bash
mole source register 6-raw/inbox/customer-note.md
mole source resolve src_8d31cc34-c04c-41ac-82e3-75518bb5a7e0 --json
mole source reconcile src_8d31cc34-c04c-41ac-82e3-75518bb5a7e0 --path 6-raw/archive/2026-09/customer-note.md
mole source correct src_8d31cc34-c04c-41ac-82e3-75518bb5a7e0 --reason "Owner corrected the note"
mole source migrate --json
```

`resolve` and the default `migrate` mode are read-only. `reconcile` verifies
the stored hash before recording a move. `correct` records a new content hash
for the same logical source. Migration `--apply` is an explicit write and may
update only evidence-backed structured references classified as `resolved`.
It must leave raw bytes and ambiguous references untouched. See
[`source-provenance.md`](./source-provenance.md) for the record, reference,
security, and recovery rules.

### Review lifecycle

Used to record which files are drafts, which are waiting for review, and which
a person has accepted. These commands operate on the local ledger at
`governance/lifecycle/records.json`:

```bash
mole lifecycle register src_8d31cc34-c04c-41ac-82e3-75518bb5a7e0 --state draft --actor "Agent" --actor-type agent
mole lifecycle submit rec_5b0f6c1e-2f0a-4d39-9d5e-0c7a1b2d3e4f --actor "Agent" --actor-type agent --reason "Ready for review"
mole lifecycle approve rec_5b0f6c1e-2f0a-4d39-9d5e-0c7a1b2d3e4f --actor "Your Name" --actor-type human --confirm-human --reason "Matches the evidence" --source src_1f6a2b7c-93d4-4e58-a0b1-6c2d3e4f5a6b --expect-revision 2
mole lifecycle reject rec_5b0f6c1e-2f0a-4d39-9d5e-0c7a1b2d3e4f --actor "Your Name" --actor-type human --confirm-human --reason "Missing pricing data"
mole lifecycle relocate rec_5b0f6c1e-2f0a-4d39-9d5e-0c7a1b2d3e4f --path 4-context/product/checkout-spec.md --actor "Agent" --actor-type agent --reason "Renamed"
mole lifecycle withdraw rec_5b0f6c1e-2f0a-4d39-9d5e-0c7a1b2d3e4f --actor "Agent" --actor-type agent --reason "Draft abandoned"
mole lifecycle audit
mole lifecycle migrate
mole retrieve
```

The `--source` on `approve` names a different registered source that supports
the record. A record cannot cite its own source. `--expect-revision` is the
revision the reviewer read, and `approve` requires it.

`show`, `list`, `audit`, `retrieve`, and the default `migrate` mode are
read-only. `approve`, `reject`, `supersede`, and `withdraw` on an accepted
record fail unless the actor type is `human` and `--confirm-human` is present.
`retrieve` returns accepted records only unless `--include-state` names another
state. Migration `--apply` registers untracked files as `raw` or `unreviewed`
and never accepts them. See
[`review-lifecycle.md`](./review-lifecycle.md) for the transition table and
recovery rules.

---

## Output philosophy

Commands should produce:
- a file output in the correct part of the mole,
- a short human-readable summary,
- and optionally a retrieval receipt.

Example:

```bash
mole create roadmap
```

Could:
1. read the relevant layers,
2. create `4-context/product/roadmap-2026-q2.md` or a draft in a staging area,
3. print what it used,
4. list missing human inputs.

---

## Initial implementation recommendation

Do not try to build a magical full AI runner first.

Start with a thin command layer that:
- knows the repo shape
- knows where outputs should go
- knows which templates to use
- knows which prompts/instructions to surface to an agent

This could begin as a Node CLI with commands that scaffold files and emit recommended prompts/workflows.

---

## Future compatibility

The command vocabulary should work across:
- local terminal use
- chat slash-command wrappers
- local UI buttons/actions
- future agent integrations

So define the verbs well now, even if the backend remains simple at first.

---

## Recommendation

Build the product around:
- root command: `mole`
- key verbs: `init`, `create`, `insight`, `synthesise`, `review`, `doctor`, `check-updates`, `upgrade`

That is a much stronger foundation than `/PCC` as the primary identity.
