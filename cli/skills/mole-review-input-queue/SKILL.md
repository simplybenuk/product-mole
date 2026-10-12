---
name: mole-review-input-queue
description: Review the current Mole input queue and tell the PM the highest-value questions to answer.
---

# Mole Review Input Queue

Use this skill inside a Mole instance.

## Goal

Help the PM answer the most important missing human questions.

## Workflow

1. Run `mole review input-queue`. Add `--format json` when you need the fields, or `--limit <n>` for more than three asks.
2. Read only the minimum additional context needed to understand the asks.
3. Return a concise prioritised list of the top missing inputs, why they matter, the fastest way to answer each, and what each answer unblocks.
4. Report the stale and duplicate suggestions the command lists. Do not close, merge, or reassign a request yourself; those decisions belong to the PM.
5. If the command says rows have no stable ID yet, run `mole input-queue migrate --apply --actor "<agent name>" --actor-type agent`.
6. When the PM answers a request, record it with `mole input-queue close <input_id> --answer "..." --outcome "..." --actor "<agent name>" --actor-type agent`.

Do not edit the table in `governance/input-queue.md`. It is generated from `governance/input-queue/requests.json`.

Be crisp and practical.
