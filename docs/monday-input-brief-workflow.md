# Monday Input Brief Workflow

## Goal

Create a reliable morning ritual where the PM asks:

> "What inputs do you need from me today?"

…and the agent returns a focused, high-impact list of asks.

---

## Trigger

- PM starts workday (typically Monday morning, usable daily).
- PM requests input brief via chat or UI.

---

## Agent routine

1. Review current mission/goals and active tasks.
2. Check blocked work where human-only input is required.
3. Rank asks by impact × urgency × effort.
4. Return top 3 (max 5) asks.
5. Update `governance/input-queue.md`.

---

## Response format

For each ask, include:
- **What I need**
- **Why it matters**
- **How to answer quickly** (1–5 min)
- **Due/urgency**
- **What this unlocks next**

---

## Example

1. **Need:** Confirm Q2 onboarding success metric.
   - Why: unlocks prioritisation scoring and PRD trade-offs.
   - Quick answer: one sentence target (e.g. "activation from 41% → 50%").
   - Due: today.
   - Unlocks: onboarding PRD v1 + roadmap ranking.

2. **Need:** Paste 3 recent CEO/customer signals about external sharing.
   - Why: validates strategy confidence.
   - Quick answer: three bullets.
   - Due: this week.
   - Unlocks: external sharing decision memo update.

---

## Guardrails

- Keep asks short and concrete.
- Ask only for human-only information.
- Avoid duplicate asks if already captured in inbox/context.
- Prefer fewer high-impact asks over long request lists.
