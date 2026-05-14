# Chat and Agent Command UX

## Why this matters

The repository structure is useful, but many users will meet the product through an agent or coding assistant before they ever touch the folders directly.

So the experience should not depend on users manually dropping files into `6-raw/inbox/` forever.

A better UX is to let users speak in outcome-oriented commands and lightweight capture commands, while the tool writes into the mole on their behalf.

---

## Recommended command model

Use the same core product vocabulary across:
- CLI
- agent skills
- chat command wrappers
- coding agents
- local UI

That means a user should be able to say things like:
- `/mole insight [text]`
- `/mole create roadmap`
- `/mole create spec`
- `/mole synthesise inbox`
- `/mole review input-queue`

The backend implementation can vary by environment, but the intent should stay stable.

---

## Key distinction

### Capture commands
These are the chat-native equivalent of adding material to the raw inbox.

Examples:
- `/mole insight Customer success keeps hearing pricing confusion on enterprise renewals`
- `/mole note CEO wants a faster path to pilot for regulated prospects`
- `/mole signal Users trust CSV export more than dashboard totals`

These commands should:
1. create a raw capture entry,
2. tag it appropriately,
3. make it eligible for later synthesis.

### Create commands
These generate outcome artefacts from the layered context.

Examples:
- `/mole create roadmap`
- `/mole create spec`
- `/mole create decision-brief`

These should:
1. retrieve the relevant mole layers,
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

## Recommended initial command vocabulary

### Capture
- `/mole insight ...`
- `/mole note ...`
- `/mole signal ...`

### Synthesis
- `/mole synthesise inbox`
- `/mole synthesise signals`

### Creation
- `/mole create roadmap`
- `/mole create spec`
- `/mole create strategy-memo`
- `/mole create decision-brief`

### Review
- `/mole review input-queue`
- `/mole review stale-summaries`

---

## Suggested implementation path

### Phase 1
CLI + docs define the command vocabulary.

### Phase 2
Agent skills and wrappers translate user requests into file writes or retrieval/generation actions.

The CLI-delivered baseline is `mole install skills`, which installs Mole skill directories into `~/.agents/skills/` or `$AGENTS_HOME/skills/`.

### Phase 3
Native integrations in coding assistants can map `/mole ...` or natural-language Mole requests into command handlers or agent workflows.

---

## Relationship to OpenSpec-style UX

The useful pattern to borrow is:
- the user expresses intent in a short command,
- the tool creates/updates the right files,
- the internal structure is still durable and inspectable.

That matches the mole philosophy very well.

---

## Recommendation

Design the product so that a future user can adopt it through either:
- direct file use,
- CLI use,
- or agent/chat command use.

All three should resolve to the same underlying context system.
