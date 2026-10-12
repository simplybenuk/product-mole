# Human Input Queue (Ask the PM)

Purpose: track the minimum human inputs required to unblock high-quality agent outputs.

Use this file as the default queue for "What do you need from me today?".

---

## How to use

- The table under "Active requests" is generated from
  `governance/input-queue/requests.json`. Do not edit it by hand.
- An agent adds a request with `mole input-queue add` whenever human input is
  required.
- The PM answers in chat or in a note. The answer is recorded with
  `mole input-queue close <input_id> --answer "..." --outcome "..."`.
- `mole review input-queue` returns the highest-value requests to answer now.

---

## Active requests

<!-- mole:input-queue:start -->
<!-- Generated from governance/input-queue/requests.json. Change requests with "mole input-queue"; edits between these markers are overwritten. -->

| ID | Priority | Blocking | Request | Why this matters | Unblocks | Quick input format | Owner | Due | Status |
|---|---|---|---|---|---|---|---|---|---|
| | | | _No open requests._ | | | | | | |

0 open or deferred, 0 closed. Run `mole input-queue list --all` for closed requests and their answers.
<!-- mole:input-queue:end -->

---

## Status values

- open
- waiting
- in_progress
- deferred
- closed

---

## Monday briefing view (suggested)

When PM asks, "What inputs do you need from me today?", run
`mole review input-queue` and return:
1. Top 3 open items by impact.
2. Why each item matters.
3. Fastest way to provide each input.
4. What output becomes possible once provided.
