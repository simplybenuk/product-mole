# Human-input queue

The human-input queue holds what an agent needs from a person. Each request is
a record with a stable ID, ranking fields, links, and a history, so
`mole review input-queue` can return the few asks worth answering now and a
closed request still says who answered it and what changed.

## Where it lives

| Path | Purpose |
| --- | --- |
| `governance/input-queue/requests.json` | The queue. Mole creates it with the first request. |
| `governance/input-queue.md` | A table generated from the queue, between two marker comments. Text outside the markers is yours. |
| `governance/input-queue/legacy/` | The Markdown file as it was before a migration, and before any rewrite that removed text the queue does not hold. |
| `governance/input-queue/.view-pending` | Present only between saving the queue and rewriting the Markdown file. |
| `schemas/input-queue-v1.schema.json` | The record schema. |

`requests.json` is the authority. Do not edit it or the generated table by
hand. An upgrade must never replace `governance/input-queue/`.

The generated table sits between a `<!-- mole:input-queue:start -->` line and
a `<!-- mole:input-queue:end -->` line. Each marker must be a line of its own,
and the file must hold exactly one of each, in that order. If it does not, the
commands that write refuse with `INVALID_QUEUE_VIEW` and change nothing,
because rewriting the table could delete your text. A file with no markers
gets the table in place of the old generated table or the first legacy
request table, or at the end. If you delete the markers, the old table's
comment line and count line are left as ordinary text; delete them too.

Text outside the markers is yours and is kept, with one exception: a legacy
request table is removed once the queue holds its rows, so the file has one
table. A table outside the markers that lists requests by their queue ID is
your own. Mole leaves it where it is, does not keep it current, and does not
import rows added to it. `migrate` lists such rows as not imported, and
`audit` notes the table as `request_table_outside_view` without failing.

Everything inside the markers is replaced on each change. If a line there is
not exactly what Mole generates from the queue, such as a note, an extra
column, or a row edited by hand, Mole first copies the whole file to
`governance/input-queue/legacy/` and prints the path. `audit` reports such
lines as `unmanaged_text_in_view`. The queue's values are then written back,
so change a request with `mole input-queue update`, not by editing its row.

## The record

| Field | Meaning |
| --- | --- |
| `input_id` | `inq_` followed by a lowercase UUIDv4. It never changes. |
| `request` | What the person is asked. |
| `impact` | Why the answer matters. |
| `unblocks` | The output that becomes possible once it is answered. Required for a new request. Null for a migrated row that did not record it. |
| `answer_format`, `effort` | The fastest way to answer, and how long it should take. Optional. |
| `priority` | `high`, `medium`, or `low`. Default `medium`. |
| `blocking` | `true` when work is stopped until the answer arrives. |
| `status` | `open`, `waiting`, `in_progress`, `deferred`, or `closed`. |
| `requester`, `owner` | Who asked, and who is expected to answer. |
| `due`, `next_review` | Dates as `YYYY-MM-DD`, or null. |
| `source_ids` | Registered sources the request concerns. |
| `references` | Other artefacts: paths, lifecycle record IDs, or links. |
| `duplicate_of`, `superseded_by` | The request that stands in for a closed one. |
| `closure` | For a closed request: `reason`, `answer`, `outcome`, `closed_by`, `closed_by_type`, `human_confirmed`, `closed_at`. |
| `legacy` | For a migrated request: the original table row, verbatim, with its file, line, and columns. |
| `created_at`, `updated_at`, `revision` | Timestamps and the number of history entries. |
| `history` | One entry per change: action, actor, actor type, time, reason, and each changed field with its value before and after. |

## Commands

```bash
mole input-queue add --request "Which pricing tier is the default for new teams?" \
  --impact "The onboarding spec assumes Team." --unblocks "Onboarding spec v2" \
  --priority high --blocking --owner "Sam" --due 2026-10-20 \
  --source <source_id> --ref 4-context/onboarding.md \
  --actor "Agent" --actor-type agent

mole review input-queue
mole input-queue close <input_id> --answer "Team tier" \
  --outcome "Onboarding spec v2 defaults to Team" --actor "Agent" --actor-type agent
```

| Command | What it does |
| --- | --- |
| `mole review input-queue [--limit <n>] [--stale-after-days <n>] [--duplicate-threshold <0-1>]` | Returns the highest-value requests and suggestions. Read-only. `mole input-queue review` is the same command. |
| `mole input-queue add` | Adds a request. Needs `--request`, `--impact`, `--unblocks`, `--actor`, and `--actor-type`. Optional: `--priority`, `--blocking`, `--owner`, `--due`, `--next-review`, `--answer-format`, `--effort`, `--requester` (default: the actor), `--source`, `--ref`, `--reason`. |
| `mole input-queue update <input_id> [fields] --reason <text>` | Changes fields. Takes the `add` fields plus `--status` and `--not-blocking`. `--due none` and `--next-review none` clear a date. `--source` and `--ref` add to the lists. |
| `mole input-queue close <input_id> --answer <text> --outcome <text>` | Records the answer and what it changed. |
| `mole input-queue close <input_id> --closure-reason <reason> --outcome <text> --reason <text>` | Closes a request that was not answered. Reasons: `duplicate` (with `--duplicate-of`), `superseded` (with `--superseded-by`), `stale`, `not_needed`. |
| `mole input-queue reopen <input_id> --reason <text>` | Reopens a closed request. The closure stays in the history. |
| `mole input-queue show <input_id>` | Prints a request and its history. |
| `mole input-queue list [--status <status>] [--all]` | Lists open requests. `--all` includes closed ones. `--status` may be repeated. |
| `mole input-queue migrate [--apply]` | Imports rows from the Markdown table. |
| `mole input-queue refresh-view` | Rewrites the generated table from the queue. Use it when a command warns that the table could not be rewritten, or when `audit` reports `view_stale`. |
| `mole input-queue audit` | Checks the queue. Read-only. Exits 1 with findings. |
| `mole input-queue unlock` | Removes a write lock left by a stopped process. |

Every command that changes the queue needs `--actor <name>` and `--actor-type
human|agent|automation`. `refresh-view` and `unlock` take neither. `mole
input-queue --help` lists the commands. `--confirm-human` is accepted by
`update`, `close`, `reopen`, and `migrate`, and only with `--actor-type human`. Add `--format json` to any command for
machine-readable output. A refusal prints `{ "ok": false, "error": { "code",
"message", "details" } }` and exits 1. Invalid arguments exit 2.

## Who may do what

| Action | Who |
| --- | --- |
| Add a request, update it, name an owner for a request that has none | anyone |
| Record an answer with `close --answer` | anyone. The answer and the outcome are required. |
| Defer a request with a `--next-review` date | anyone |
| Reopen a request that was closed without human confirmation | anyone |
| Close as `duplicate`, `superseded`, `stale`, or `not_needed` | a person, with `--actor-type human --confirm-human` |
| Change an owner that is already set | a person, with `--actor-type human --confirm-human` |
| Defer a request with no review date | a person, with `--actor-type human --confirm-human` |
| Reopen a request whose closure a person confirmed | a person, with `--actor-type human --confirm-human` |

The actor fields are declarations. Mole does not authenticate a human. An
agent must not pass `--actor-type human` or `--confirm-human`.

## How requests are ranked

`mole review input-queue` considers requests that are `open`, `waiting`, or
`in_progress`, and a `deferred` request once its `next_review` date arrives.
Each gets a score:

| Signal | Points |
| --- | --- |
| `blocking` is true | 40 |
| Priority | high 30, medium 20, low 10 |
| Due date | overdue 30, within 3 days 20, within 7 days 10 |
| Not updated for the stale threshold | 5 |

Dates are compared in UTC, so "due today" follows the UTC day.

Higher scores come first. Equal scores go to the earlier due date, then to the
older request, then to the order the requests were added. The command returns the top 3 by default and at most 50. Each
result carries its score, the reasons for its rank, its impact, and what it
unblocks. The JSON output also carries the rule under `ranking`.

## Stale and duplicate suggestions

The review reports two kinds of suggestion. It never closes, merges, or
reassigns anything.

- A request is a stale candidate when it has not been updated for 14 days
  (`--stale-after-days`), its `next_review` date has arrived, or its due date
  has passed. Rows that are not migrated yet carry no dates and are never
  stale candidates.
- Two open requests are duplicate candidates when their request texts share at
  least 60% of their significant words (`--duplicate-threshold`). Words of one
  or two letters and common words such as "the" and "which" are ignored. The
  suggestion lists the shared words.

Word overlap is a prompt for a person to look. Two distinct asks can share
vocabulary, and one ask can be worded two ways that share little. Each list
holds at most 20 entries; the counts give the totals.

## Migrating the Markdown table

Earlier workspaces kept requests as rows in `governance/input-queue.md`.

```bash
mole input-queue migrate
mole input-queue migrate --apply --actor "Agent" --actor-type agent
```

Without `--apply` the command lists the rows it would import and changes
nothing. With `--apply` it:

1. copies the file as it is to `governance/input-queue/legacy/`;
2. gives each row with a request a stable ID and stores the row verbatim under
   `legacy`, with every column;
3. replaces the tables with the generated view and leaves other text alone.

A table is read when it has a `Request` column and at least one of
`Priority`, `Status`, `Why this matters`, or `Impact`. A table with a
`Request` column and none of those, such as API notes, is left alone. Tables
in code fences are ignored. Columns map by name: `Priority`,
`Request`, `Why this matters`, `Quick input format`, `Effort`, `Due`,
`Status`, and, when present, `Owner`, `Blocking`, and `Unblocks`.

| Legacy value | Becomes |
| --- | --- |
| Priority `High`, `P0`, `P1`, `Critical`, `Urgent` | `high` |
| Priority `Low`, `P3`, `P4` | `low` |
| Any other priority | `medium` |
| Status `Waiting`, `In progress` | the matching status |
| Status `Deferred` | `deferred`, with `next_review` set to the migration date so it comes up for review |
| Status `Complete`, `Done`, `Closed` | `closed`, with a closure that says the answer was not recorded |
| Any other status | `open` |
| A due date that is not `YYYY-MM-DD` | null. The text stays in `legacy.columns`. |
| A row whose cells are all empty or `_TBD_`, apart from a starter default such as `High`, `2–5 min`, or `Open` | skipped and reported as `placeholder_row` |
| A row with text but an empty or `_TBD_` request | skipped and reported as `request_missing`. It cannot be imported. It stays in the copy under `legacy/`. |

Until the rows are migrated, `mole review input-queue` still ranks them under
a `legacy:<line>` ID and says how many are waiting. Every command that writes
refuses with `MIGRATION_REQUIRED`, so a row is not dropped when the table is
rewritten.

Running the migration again imports only rows added by hand since. That
includes a row typed into the generated table: a row there whose ID is not in
the queue is treated as a new request, not overwritten.

A row is imported once. If a command saves the queue and then cannot rewrite
the Markdown file, it reports success with a warning and leaves
`governance/input-queue/.view-pending` in place. That file records the lines
Mole had generated, so the later rewrite needs no copy for them. While it
exists, rows still in the Markdown file are matched to imported requests by
their text, so running the migration again imports nothing twice, even if
lines have moved.
Run `mole input-queue refresh-view` when the file can be written. After that,
a row typed again with the same text is a new request.

When a command removes a table that holds a `request_missing` row, it first
copies the file to `governance/input-queue/legacy/` and prints the path.

## Audit findings

| Finding | What to do |
| --- | --- |
| `invalid_queue` | `requests.json` is not valid. Restore it from version control or a backup. |
| `view_markers_invalid` | Fix the marker lines in `governance/input-queue.md`, or delete them all. |
| `view_unreadable` | `governance/input-queue.md` is not a readable regular file. |
| `unmanaged_text_in_view` | Text inside the markers is not part of the table. Move it outside the markers. The next change replaces it after copying the file. |
| `request_table_outside_view` | A note, not a failure: a table outside the markers lists requests by queue ID. Mole leaves it alone. Delete it if it is a stale copy. |
| `view_pending_unusable` | `governance/input-queue/.view-pending` is not a regular file. Remove it. |
| `legacy_rows_pending` | Run `mole input-queue migrate --apply`. |
| `legacy_rows_without_request` | Fill in the Request cell or move the text out of the table. |
| `view_stale` | Run `mole input-queue refresh-view`. |
| `stale_lock` | Run `mole input-queue unlock`. |
| `foreign_lock` | The lock came from another host. Delete it by hand once no command is running there. |
| `stale_temp_file` | An interrupted write left a `.tmp` file. Delete it once no queue command is running. |

## Library

`lib/input-queue.mjs` exposes the same operations as synchronous functions
that take the workspace root first.

```js
addInputRequest(root, { request, impact, unblocks, priority, blocking, owner, due, nextReview,
  answerFormat, effort, requester, sourceIds, references, actor, actorType, reason, now })
updateInputRequest(root, inputId, { ...fields, status, addSourceIds, addReferences, actor, actorType, humanConfirmed, reason, now })
closeInputRequest(root, inputId, { closureReason, answer, outcome, duplicateOf, supersededBy, actor, actorType, humanConfirmed, reason, now })
reopenInputRequest(root, inputId, { actor, actorType, humanConfirmed, reason, now })
readInputRequest(root, inputId)
listInputRequests(root, { statuses, all })
reviewInputQueue(root, { limit, staleAfterDays, duplicateThreshold, now })
migrateInputQueue(root, { apply, actor, actorType, now })
refreshInputQueueView(root)
auditInputQueue(root)
unlockInputQueue(root)
validateInputQueueLedger(ledger)
```

A refused operation throws an `InputQueueError` with a `code` and `details`.

## Limits

- Actor fields are declarations. Mole does not authenticate a human.
- The ledger is not tamper-evident. A consistent hand edit passes validation.
- A request closed with `--answer` is not checked for a real answer. An agent
  that records a made-up answer bypasses the rule on stale closures.
- Each write takes `governance/input-queue/.mutation.lock` and waits up to
  five seconds for another writer. In a synced folder each machine has its own
  copy, so two machines can still write at once and the sync tool will keep a
  conflict copy. Mole does not detect that copy.
- The generated table is ordered when it is written. Due dates that pass later
  do not reorder it until the next change. `mole review input-queue` always
  ranks against the current date.
- Duplicate detection compares words. It does not understand meaning. Its
  cost grows with the number of open requests that share words.
- An agent can set a far-future `--next-review` date on a deferred request.
  The stale suggestions still list it once it has not been updated for 14
  days.
