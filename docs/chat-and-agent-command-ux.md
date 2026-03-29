# Chat and Agent Command UX

## Why this matters

The repository structure is useful, but many users will meet the product through an agent or coding assistant before they ever touch the folders directly.

So the experience should not depend on users manually dropping files into `6-raw/inbox/` forever.

A better UX is to let users speak in outcome-oriented commands and lightweight capture commands, while the tool writes into the cascade on their behalf.

---

## Recommended command model

Use the same core product vocabulary across:
- CLI
- chat slash-command wrappers
- coding agents
- local UI

That means a user should be able to say things like:
- `/cascade insight [text]`
- `/cascade create roadmap`
- `/cascade create spec`
- `/cascade synthesise inbox`
- `/cascade review input-queue`

The backend implementation can vary by environment, but the intent should stay stable.

---

## Key distinction

### Capture commands
These are the chat-native equivalent of adding material to the raw inbox.

Examples:
- `/cascade insight Customer success keeps hearing pricing confusion on enterprise renewals`
- `/cascade note CEO wants a faster path to pilot for regulated prospects`
- `/cascade signal Users trust CSV export more than dashboard totals`

These commands should:
1. create a raw capture entry,
2. tag it appropriately,
3. make it eligible for later synthesis.

### Create commands
These generate outcome artefacts from the layered context.

Examples:
- `/cascade create roadmap`
- `/cascade create spec`
- `/cascade create decision-brief`

These should:
1. retrieve the relevant cascade layers,
2. draft the requested artefact,
3. report missing human inputs.

---

## Why this is better than file-only UX

Users should not have to think:
- “which folder should this go in?”
- “should this be a quick note or a message capture?”
- “what naming convention should I use?”

The tool should absorb that complexity.

The file system remains the source of truth.
The command surface becomes the human-friendly interface.

---

## Recommended initial slash-command vocabulary

### Capture
- `/cascade insight ...`
- `/cascade note ...`
- `/cascade signal ...`

### Synthesis
- `/cascade synthesise inbox`
- `/cascade synthesise signals`

### Creation
- `/cascade create roadmap`
- `/cascade create spec`
- `/cascade create strategy-memo`
- `/cascade create decision-brief`

### Review
- `/cascade review input-queue`
- `/cascade review stale-summaries`

---

## Suggested implementation path

### Phase 1
CLI + docs define the command vocabulary.

### Phase 2
Agent prompt packs and wrappers translate chat commands into file writes or retrieval/generation actions.

For Codex specifically, this can be delivered by installing markdown prompt files into:
- `~/.codex/prompts/`
- or `$CODEX_HOME/prompts/`

That is the same broad integration pattern used by OpenSpec.

### Phase 3
Native integrations in tools like Codex or other assistants can map `/cascade ...` into command handlers or agent workflows.

---

## Relationship to OpenSpec-style UX

The useful pattern to borrow is:
- the user expresses intent in a short command,
- the tool creates/updates the right files,
- the internal structure is still durable and inspectable.

That matches the cascade philosophy very well.

---

## Recommendation

Design the product so that a future user can adopt it through either:
- direct file use,
- CLI use,
- or agent/chat command use.

All three should resolve to the same underlying context system.
