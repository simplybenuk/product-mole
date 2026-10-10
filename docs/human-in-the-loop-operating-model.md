# Human-in-the-loop Operating Model

## Principle

The agent owns synthesis. The PM owns judgement, context setting, and external human inputs the agent cannot access.

---

## Collaboration contract

### PM provides
- mission and strategic intent
- micro-signals and raw inputs
- decision confirmations
- trade-off calls

### Agent provides
- synthesis and structure
- context promotion (raw → evidence → context)
- gap detection and explicit input requests
- draft outputs with retrieval receipts
- drafts submitted for review, never self-approved

The [review lifecycle](review-lifecycle.md) records the last point. An agent
can submit a draft, and the accept and reject commands refuse an agent actor.
The actor is a declaration, not an authenticated identity, so the rule depends
on agents following their instructions and on the history that each command
leaves behind.

---

## Input gap protocol

When the agent cannot proceed reliably, it should:
1. state what input is missing,
2. explain why it matters,
3. propose fastest answer format,
4. queue it in `governance/input-queue.md`.

---

## Success condition

The PM can start the day by asking "what do you need from me?", provide focused inputs quickly, and the agent can then execute with high confidence.
