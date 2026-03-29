# Open-Source Product Direction

## Working ambition

Turn Product Context Cascade from a strong repository template into a genuinely useful open-source tool for product managers.

The end state is not just:
- a folder structure
- a markdown convention
- a nice README

It is:
- a portable PM operating system
- a context ingestion and synthesis workflow
- a human+agent collaboration pattern
- a lightweight command surface for producing product outputs

---

## Core user story

A product manager continuously drops raw signals into the cascade:
- notes
- messages
- support oddities
- customer observations
- stakeholder asks
- strategy fragments
- market signals

The system then helps turn those signals into:
- structured evidence
- context modules
- summaries
- decisions
- output-ready artefacts

So the core loop is:

**capture → synthesise → retrieve → create**

---

## Product promise

A PM should be able to say things like:
- `create roadmap`
- `create spec`
- `create strategy memo`
- `create prioritisation draft`
- `what inputs do you need from me today?`

…and get better output because the system already holds layered, living product context.

That is the real value proposition.

---

## Product shape

The project likely wants to become three things at once:

### 1) A file-native context architecture
The repository structure remains the durable source of truth.

### 2) A workflow model
Humans capture low. Agents distil up. Retrieval happens top-down.

### 3) A lightweight command surface
Eventually a user should not need to remember folder semantics to get value.
They should be able to invoke outcomes.

Examples:
- `cascade create roadmap`
- `cascade create spec`
- `cascade inbox synthesise`
- `cascade review input-queue`

---

## Naming / brand direction

"Product Context Cascade" is descriptive but not especially ownable or memorable.

The open-source product may eventually benefit from:
- a stronger primary name
- with Product Context Cascade retained as the descriptive subtitle or model name

For now, a sensible approach is:
- keep the existing repo/package identity while maturing the concept
- explore stronger names once command UX and product shape are clearer

Examples of future naming directions:
- something short and tool-like
- something PM-native but not boring
- something that implies flow, context, synthesis, or operating system behaviour

Do not rush the rename until the product surface is clearer.

---

## Product principles

1. **Files stay the source of truth**
2. **Open source first**
3. **Low-friction capture matters more than perfect structure**
4. **Synthesis is the engine**
5. **Commands should produce outcomes, not expose internals**
6. **Instances must be upgradeable over time**
7. **The tool should help PMs think, not force them into documentation theatre**

---

## Suggested maturity path

### Phase A — strong open-source template/framework
- stable structure
- versioning
- upgrade model
- clear docs
- examples

### Phase B — command vocabulary and scaffolding
- define verbs and output types
- create a small CLI scaffold
- make the tool feel operable, not just copyable

### Phase C — synthesis engine helpers
- add commands for inbox promotion, queue review, and output creation
- keep these lightweight and file-native

### Phase D — richer human UX
- local UI or app shell
- guided capture and review
- output generation flows

---

## Recommendation

Build toward a world where the user experience is:

```bash
cascade create roadmap
cascade create spec
cascade synthesise inbox
cascade ask what-inputs-do-you-need
```

That is a much stronger open-source story than just handing people a folder tree.
