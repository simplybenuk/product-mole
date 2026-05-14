---
name: mole-review-input-queue
description: Review the current Mole input queue and tell the PM the highest-value questions to answer.
---

# Mole Review Input Queue

Use this skill inside a Mole instance.

## Goal

Help the PM answer the most important missing human questions.

## Workflow

1. Read `governance/input-queue.md`.
2. Read only the minimum additional context needed to understand the asks.
3. Return a concise prioritised list of the top missing inputs, why they matter, and what would unblock next.
4. If the queue is stale or weak, improve it in place before reporting back.

Be crisp and practical.
