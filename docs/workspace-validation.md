# Workspace validation

`mole validate` checks a whole workspace and reports what needs attention. It
is read-only. It never moves, deletes, rewrites, or merges a file, including
when it finds a stale lock or a broken link.

```bash
mole validate                     # the workspace in the current folder
mole validate path/to/workspace
mole validate --format json
mole validate --stale-after-days 180
```

## Which command to use

| Command | Scope |
| --- | --- |
| `mole doctor` | Versions and required folders. Fast. Use it to confirm you are in a workspace root. |
| `mole validate` | Everything below. The complete check. |
| `mole inbox audit` | The inbox, its lock, and its receipts, with the detail a processing run needs. |
| `mole lifecycle audit` | The review ledger and reviewed files. |
| `mole source migrate`, `mole source resolve <source_id>` | One source or legacy references. |

`mole validate` runs the inbox audit, the lifecycle audit, and the source
registry scan, and reports their results under its own codes. The focused
commands stay the place for detail and recovery.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Healthy. No error or warning. `info` findings may be present. |
| 1 | The check ran and reported at least one error or warning. |
| 2 | Invalid arguments: an unknown option, a bad value, or a path that is not a directory. |
| 3 | The validation could not run because of an internal failure. |

With `--format json`, codes 2 and 3 print `{ "ok": false, "error": { "code",
"message" } }`. The message also goes to standard error.

## Report

Each finding has:

| Field | Meaning |
| --- | --- |
| `code` | A stable identifier from the tables below. |
| `severity` | `error`, `warning`, or `info`. |
| `message` | What is wrong. |
| `remedy` | What to do about it. |
| `path`, `paths`, `line` | The file or files, relative to the workspace root. |
| `record_id`, `source_id`, `source_ids` | The review record or source, when the finding is about one. |

The JSON report also holds `ok`, `read_only`, `workspace_root`, `checked_at`,
`cli_version`, `instance_version`, `stale_after_days`, `summary` (a count per
severity), and `checks`. Each entry in `checks` names a check and gives its
status: `ok`, `findings`, `skipped` with a `reason`, or `failed`.

Findings are ordered by severity, then by check. The text report groups them
the same way and prints the remedy after `Fix:`.

## Checks and finding codes

### structure and metadata

| Code | Severity | Meaning |
| --- | --- | --- |
| `WORKSPACE_PATH_MISSING` | error | A required folder is missing or is not a folder. |
| `INSTANCE_METADATA_MISSING` | error | `mole.instance.yaml` is missing. |
| `INSTANCE_METADATA_INVALID` | error | `mole.instance.yaml` cannot be parsed or gives no usable `cascade_version`. |
| `INSTANCE_VERSION_AHEAD` | warning | The workspace is newer than the CLI running the check. |
| `INSTANCE_VERSION_BEHIND` | info | The workspace is older than the CLI. Run `mole check-updates`. |
| `PACKAGE_METADATA_INVALID` | error | A `package.json` at the root is not valid JSON. |
| `PACKAGE_VERSION_MISMATCH` | error | In a Mole source checkout, `VERSION` and `package.json` disagree. |

### inbox

Skipped when the workspace layout is incomplete.

| Code | Severity | Meaning |
| --- | --- | --- |
| `INBOX_UNPROCESSED` | warning | An inbox file has no processing receipt. One finding per file, found recursively. The message says when an active run has claimed the file, or is active without naming its paths. |
| `INBOX_INVALID_LOCK` | error | The processing lock is malformed. |
| `INBOX_STALE_LOCK` | warning | The processing lease has expired. |
| `INBOX_SYNC_CONFLICT` | error | Conflict copies of an inbox file, the lock, or a receipt exist. |
| `INBOX_UNSAFE_INBOX_ENTRY` | error | The inbox holds a link or a special file. |
| `INBOX_INVALID_RECEIPT` | error | A receipt is malformed or cannot be tied to a run. A receipt no run claimed is reported here. |
| `INBOX_DUPLICATE_RECEIPT` | error | More than one receipt claims the same run ID. |
| `INBOX_PROCESSED_PATH_CONFLICT` | error | Two runs claim the same inbox path. |
| `INBOX_INVALID_OVERRIDE`, `INBOX_OVERRIDE_CONFLICT`, `INBOX_INCOMPLETE_OVERRIDE` | error | A stale-lock or missing-lock override record is malformed, duplicated, or unfinished. |

### sources

Skipped when the workspace has no source registry yet.

| Code | Severity | Meaning |
| --- | --- | --- |
| `SOURCE_ORPHAN_RECORD` | warning | A source record points at a path with no file, such as an archive move that was not reconciled. |
| `SOURCE_ORPHAN_SOURCE` | warning | A file names a `source_id` that has no record. |
| `SOURCE_REF_BROKEN` | error | A file cites a source under `source_refs` that has no record. Reported by the frontmatter check. |
| `SOURCE_CONTENT_CONFLICT` | error, or warning when the record is `pending_review` | A registered file no longer holds its registered bytes, and it has no review record or one that is not editable. For a pending or accepted record, `mole lifecycle audit` names the recovery. Otherwise restore the file or run `mole source correct <source_id> --reason <text>`. |
| `SOURCE_CONTENT_CHANGED` | info | A registered file was edited and its review record is `draft`, `unreviewed`, or `rejected`. Expected while a draft is being written. `mole lifecycle submit` records the new content; a rejected record needs `mole lifecycle revise` first. |
| `SOURCE_DUPLICATE_CONTENT` | info | Two sources are registered with the same bytes, such as two unedited drafts from one template. `paths` lists the files. |
| `SOURCE_PATH_CLAIM_CONFLICT` | error | Two sources are registered at one path. |
| `SOURCE_INVALID_RECORD`, `SOURCE_RECORD_FILENAME_CONFLICT`, `SOURCE_DUPLICATE_RECORD`, `SOURCE_REVISION_CONFLICT` | error | A source record is malformed, misnamed, or exists in conflicting copies. |
| `SOURCE_SYMLINK_ESCAPE`, `SOURCE_WORKSPACE_ESCAPE` | error | A registered path leaves the workspace. |
| `SOURCE_MISSING_ATTACHMENT_RECORD`, `SOURCE_ATTACHMENT_LINK_CONFLICT` | error | An attachment link is broken or one-sided. |

### lifecycle

Each finding of `mole lifecycle audit` is reported as `LIFECYCLE_` followed by
its type in capitals, with the audit's own advice as the remedy.

| Code | Severity |
| --- | --- |
| `LIFECYCLE_INVALID_LEDGER`, `LIFECYCLE_LEDGER_CONFLICT_COPY`, `LIFECYCLE_ACCEPTED_CONTENT_CHANGED`, `LIFECYCLE_PATH_CLAIM_CONFLICT`, `LIFECYCLE_SOURCE_RECORD_MISSING`, `LIFECYCLE_SOURCE_RECORD_INVALID`, `LIFECYCLE_UNSAFE_PATH`, `LIFECYCLE_NO_LOCAL_FILE` | error |
| `LIFECYCLE_SOURCE_UNRESOLVED`, `LIFECYCLE_PENDING_CONTENT_CHANGED`, `LIFECYCLE_SUPPORTING_SOURCE_MISSING`, `LIFECYCLE_STALE_MUTATION_LOCK`, `LIFECYCLE_STALE_TEMP_FILE`, `LIFECYCLE_UNEXPECTED_ENTRY` | warning |

See [`review-lifecycle.md`](review-lifecycle.md) for what each means.

### frontmatter

Checks Markdown files under `2-summaries/`, `3-indexes/`, `4-context/`,
`5-evidence/`, and `6-raw/`. `README.md` files are skipped. Files in
`3-indexes/`, `5-evidence/`, and `6-raw/` may be any format: a block that
opens with `---` is read as frontmatter there only when it closes and every
top-level line is `key: value`, or when it closes, holds `title`, `last_updated`, `source_id`,
or `source_refs`, and has at most two lines that are not `key: value`. A file that starts with a
horizontal rule, or with a pasted email header, is left alone.

| Code | Severity | Meaning |
| --- | --- | --- |
| `FRONTMATTER_MISSING` | warning | A file in `2-summaries/` or `4-context/` has no frontmatter. Other folders do not require it. |
| `FRONTMATTER_UNTERMINATED` | error | The frontmatter opens with `---` and never closes. |
| `FRONTMATTER_INVALID` | warning | A top-level frontmatter line is not `key: value`. |
| `METADATA_MISSING` | warning | A required field is absent or empty: `title` and `summary` in `4-context/`, plus `last_updated` in `2-summaries/`. |
| `METADATA_INVALID` | warning | `last_updated` or `review_after` is not a `YYYY-MM-DD` date, `confidence` is not `high`, `medium`, or `low`, `status` is not `draft`, `active`, or `archived`, or `source_id` is not a source ID. |

Mole reads the frontmatter it writes: top-level `key: value` lines, with
indented lines and list items belonging to the key above. It is not a full
YAML parser, so it does not report every YAML error.

### top-layers

Checks Markdown files under `2-summaries/` and `3-indexes/`. `<KIND>` is
`SUMMARY` or `INDEX`.

| Code | Severity | Meaning |
| --- | --- | --- |
| `<KIND>_BLANK` | warning or info | Nothing but headings, or a table with no rows. |
| `<KIND>_PLACEHOLDER` | warning or info | Only placeholder text such as `_TBD_`, or the starter summary line. |
| `<KIND>_STALE` | warning | `review_after` has arrived, or `last_updated` is more than 90 days old. Change the limit with `--stale-after-days`. |

Blank and placeholder files are `info` while `4-context/` and `5-evidence/`
hold nothing to summarise, so a new workspace is healthy. Starter files,
unedited drafts from `mole create`, `README.md`, and dotfiles do not count.
Once either folder has other content, or a starter file is edited, they
become warnings. Staleness uses the dates in the frontmatter, not file
modification times, and is not reported for blank or placeholder files. Dates
are compared in UTC. A `last_updated` in the future is not reported.

### duplicates

| Code | Severity | Meaning |
| --- | --- | --- |
| `SYNC_CONFLICT_COPY` | error | A file name marks a sync conflict copy, such as `notes (conflicted copy).md`. Checked in the layer folders and `governance/`. The inbox, lifecycle, source, and receipt folders report their own. |
| `DUPLICATE_FILE` | warning | Two or more files under `4-context/`, `5-evidence/`, or `6-raw/` hold the same bytes. One finding lists them all. Empty files, `README.md`, and unedited copies of a Mole template are ignored. |

### input-queue

Reads the request table in `governance/input-queue.md`. A row counts as open
unless its status is `Complete`, `Done`, `Closed`, `Answered`, or `Resolved`.
Placeholder rows are ignored.

| Code | Severity | Meaning |
| --- | --- | --- |
| `INPUT_QUEUE_MISSING` | warning | The queue file is missing. |
| `INPUT_QUEUE_PENDING` | info | The number of open requests. |
| `INPUT_QUEUE_TOO_LONG` | warning | More than 10 requests are open. |
| `INPUT_QUEUE_STALE` | warning | An open request has a `YYYY-MM-DD` due date in the past. |
| `INPUT_QUEUE_DUPLICATE` | warning | The same request text appears more than once, ignoring case and punctuation. |

### any check

| Code | Severity | Meaning |
| --- | --- | --- |
| `CHECK_FAILED` | error | A check could not finish. The message says why. The other checks still ran. |
| `FILE_UNREADABLE` | warning | A file or folder could not be read, so it was not checked. |

## Library

```js
import { validateWorkspace, formatValidationReport } from 'product-mole/lib/workspace-validation.mjs';

const result = validateWorkspace(root, { staleAfterDays: 90, cliVersion: '0.2.8', now });
process.stdout.write(formatValidationReport(result));
```

`validateWorkspace` throws an error with `code: 'INVALID_ARGUMENT'` when the
path is not a directory or an option is invalid.

## Limits

- A file that was moved out of the inbox with no processing receipt is not
  reported. The inbox check covers files that are still in the inbox.
- A version with a pre-release suffix, such as `0.2.8-rc.1`, is compared by
  its release number.
- Duplicate detection compares bytes. It does not find near duplicates.
- Links inside the workspace are not followed, so files reached only through
  a link are not checked.
- Summary staleness depends on `last_updated` being kept current by whoever
  edits the file.
- Checking a large workspace hashes every registered source and every
  same-size file once.
