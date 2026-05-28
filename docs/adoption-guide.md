# Adoption Guide

## Who this is for

Mole is for product managers and product-adjacent teams who:
- accumulate lots of messy product inputs,
- want better AI-assisted outputs,
- prefer files/Git/local control over opaque SaaS systems,
- and want context to improve over time instead of living only in chats.

## Who this is not for

This is probably not a great fit if you want:
- a fully hosted PM tool with no file management,
- rigid top-down process before any value appears,
- perfect automation before basic context discipline exists.

## What adoption looks like

### 1. Start small
Do not migrate your whole product universe on day one.

### 2. Capture low
Use `6-raw/inbox/` aggressively.

### 3. Distil up
Use an agent to convert raw signals into evidence, context modules, and summaries.

### 4. Generate outputs from context
Use the mole to create:
- roadmaps
- specs
- decision briefs
- strategy notes

### 5. Upgrade the instance deliberately over time
Use `mole.instance.yaml`, version tags, and upgrade notes to evolve safely.

## Fastest path to value

The fastest path is usually:
1. customise bootstrap guidance,
2. run `mole bootstrap-context` with an agent to populate initial summaries and indexes,
3. capture real notes for a week,
4. synthesise them,
5. run `mole refresh top-layers` after large synthesis passes,
6. generate one useful output (spec / roadmap / decision brief).

That is enough to prove the loop.

## When top layers are blank

Blank or starter-template `2-summaries/` and `3-indexes/` files need an explicit setup pass. Daily inbox synthesis is incremental; it should fill relevant blank files when it encounters durable context, but it is not a full workspace onboarding pass.

Use:

```bash
mole bootstrap-context
```

Then use the printed instruction with your agent to read lower-layer context and populate the first useful summaries and indexes.

Use this for maintenance:

```bash
mole refresh top-layers
```

Run it weekly, after large inbox synthesis, or whenever the top layers no longer match the lower layers.
