# CLI and Command Surface

## Purpose

Define the future command experience for the cascade so the system is usable as a tool, not just as a template.

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
- `cascade`

Reasons:
- short
- descriptive enough
- works in CLI form
- does not force a slash-command mental model

Slash commands like `/PCC create roadmap` can still exist later inside chat tools or local UIs, but the product should not depend on them as the primary interface.

---

## v1 command groups

### Create
Used to generate product outputs from the current cascade.

Examples:
```bash
cascade create roadmap
cascade create spec
cascade create strategy-memo
cascade create prioritisation-draft
cascade create decision-brief
```

### Insight / note / signal capture
Used to capture chat-native or CLI-native raw context without making users think about folders.

Examples:
```bash
cascade insight "Users trust CSV export more than dashboard totals"
cascade note "CEO wants a faster path to pilot for regulated prospects"
cascade signal "Support volume spikes after pricing page changes"
```

### Synthesise
Used to turn lower-layer/raw material into higher-signal context.

Examples:
```bash
cascade synthesise inbox
cascade synthesise signals
cascade synthesise evidence
```

### Review
Used to inspect what needs human input or validation.

Examples:
```bash
cascade review input-queue
cascade review stale-summaries
cascade review conflicts
```

### Init / upgrade
Used to scaffold or evolve an instance.

Examples:
```bash
cascade init
cascade check-updates
cascade upgrade
```

---

## Output philosophy

Commands should produce:
- a file output in the correct part of the cascade,
- a short human-readable summary,
- and optionally a retrieval receipt.

Example:

```bash
cascade create roadmap
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
- root command: `cascade`
- key verbs: `init`, `create`, `insight`, `synthesise`, `review`, `doctor`, `check-updates`, `upgrade`

That is a much stronger foundation than `/PCC` as the primary identity.
