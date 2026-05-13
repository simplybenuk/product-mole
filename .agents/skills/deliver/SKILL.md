---
name: deliver
description: Use when the user asks to run a delivery workflow, choose the next PRD task, execute planned work from plans/prd.json, or continue delivery on a category branch with validation, planning artifact updates, commits, and a concise end-of-run summary.
---

# Deliver

## Mission

Operate autonomously in this repository. Follow all repository rules defined in `agents.md` and `0-bootstrap/agents.md`.

Select one active PRD category aligned with the current goals. Complete planned work one task at a time with validation, traceability, and a commit per completed task.

## Inputs

Minimize context usage. Read only what is required for the current task.

Primary inputs:

- `agents.md`: repository-level agent entrypoint.
- `plans/1-vision.md`: product intent and direction.
- `plans/2-goals.md`: current delivery priorities and active goals.
- `plans/3-progress.txt`: current state, recent work, and blockers.
- `plans/prd.json`: active categories, chunks, and tasks.
- `plans/prd-backlog.json`: deferred, incomplete, or out-of-scope work.

Conditional inputs:

- `plans/archive/prd-complete.json`: read only to avoid duplicating completed work or to check prior task patterns.
- `plans/archive/progress-archive.txt`: read only when older decisions or blockers are relevant.
- `spec/architecture/target-architecture.md`: read when implementing or validating architectural decisions.
- `spec/architecture/architecture-decision-records.md`: read if the target architecture is unclear, inconsistent, or a decision needs precedent.

Treat archive and ADR files as last-resort references, not background reading.

## Workflow

### 1. Select Category, Chunk, And Task

Establish context:

1. Review `plans/1-vision.md`.
2. Review `plans/2-goals.md`.
3. Review `plans/3-progress.txt`.
4. Review `plans/prd.json`.

Select exactly one PRD category that aligns with the active goals. If more than one category qualifies, choose by:

1. Earliest unmet dependency.
2. Highest architectural leverage.
3. Fewest remaining tasks.

Lock onto the chosen category for the run. Do not switch categories mid-run.

Choose the next incomplete task from the next relevant chunk. If the task is too large, split it into one small, concrete subtask and record that split in the planning artifacts.

When multiple tasks are available, prioritize:

1. Architectural decisions and core abstractions.
2. Integration points between modules.
3. Unknowns and spike work.
4. Standard feature implementation.
5. Polish, cleanup, and quick wins.

Fail fast on risky work. Save easy wins for later.

### 2. Create Or Continue The Category Branch

Create or use a single branch for the active category:

- Branch format: `codex/<category-id>`.
- Complete all chunks and tasks within the category on this branch.
- Do not create per-chunk branches.
- Do not mix categories on the same branch.
- Do not merge directly back to `main`.
- Work only on `codex-sandbox` or `codex/*` branches.

If currently on `main`, create or check out the correct category branch before implementation.

### 3. Implement Exactly One Task

Unless the user provides a run count, complete exactly one PRD task or explicitly defined subtask, then stop.

Use TDD where practical:

1. Start with a failing test or verification command.
2. Implement the minimum change to pass.
3. Refactor only while keeping validation green.

A task is complete only when:

- Its acceptance criteria are met.
- Required tests or verification commands pass.
- It can be marked `"passes": true` in `plans/prd.json`.

Keep changes focused. Do not perform unrelated refactors, cleanups, optimizations, dependency additions, or symbol renames unless required by the task.

Preserve evidence of the validation cycle in `plans/3-progress.txt` or the commit history.

### 4. Update Planning Artifacts

After a completed task:

- Mark the task as `"passes": true` in `plans/prd.json`.
- Move completed tasks to `plans/archive/prd-complete.json`.
- Move deferred, incomplete, or out-of-scope tasks to `plans/prd-backlog.json`.
- Add a concise dated note to `plans/3-progress.txt` with task id, outcome, validation, and next priority.

When adding work to `plans/prd.json`, create small, concrete, themed chunks and tasks. Split large or cross-cutting work into multiple tasks or chunks.

### 5. Commit

Commit the completed task to git. The commit must represent exactly one completed PRD task.

Use a concise message that includes the task id when available.

### 6. Completion Signal

If the active category is fully complete, output exactly:

**CATEGORY COMPLETE**

## Run Count Override

Default behavior: when invoked without a run count, complete exactly one task, then stop.

If the user specifies a run count, such as "run deliver x 3", continue completing tasks sequentially without pausing for confirmation. Apply the full workflow, validation, planning updates, and commits for each task. All tasks must belong to the same active category.

Stop immediately if the active category is fully complete or a blocker is encountered. Never switch categories within a run. Never skip validation, planning updates, or commits between tasks.

## Blocker Protocol

If blocked:

- Stop further implementation immediately.
- Log the blocker clearly in `plans/3-progress.txt`.
- Do not start a new task.
- Do not switch categories.

If a spike is required, treat it as a task and document outcomes explicitly.

## Constraints

- Only one task per run unless overridden explicitly.
- Respect the repository's local-first, file-native product architecture.
- Keep the repository in a clean, passing state at the end of every run.
- Do not reformat files for style consistency.
- Do not introduce new dependencies unless unavoidable.
- Do not overwrite user-owned context or raw inputs unless explicitly instructed.

## End-Of-Run Summary

When Deliver stops for any reason, provide a chat summary that includes:

- What was done, including brief changes and decisions.
- How many PRD tasks were completed in this run.
- Validation performed and results.
- The next priority chunk to work on.
- How many incomplete tasks remain in that next priority chunk.

