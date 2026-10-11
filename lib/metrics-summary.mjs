import fs from 'node:fs';
import path from 'node:path';
import { getCountableInboxReceipts, inspectInboxProcessing } from './inbox-processing.mjs';
import { LIFECYCLE_LEDGER_REL_PATH, listLifecycleRecords } from './review-lifecycle.mjs';
import { isSourceId } from './source-registry.mjs';

/**
 * Workflow metrics for a Mole workspace.
 *
 * Two questions are kept apart.  Operational activity: what was captured and
 * processed.  Learning and decision state: what was promoted, reviewed,
 * accepted, and superseded, and what is still waiting on a person.  Neither
 * measures product success or the quality of a decision.
 *
 * Nothing is stored for the summary.  Every event is derived from records
 * that already exist, the review ledger and the inbox-processing receipts,
 * and carries an ID made from the record it came from.  Counting again, or
 * replaying a receipt or a transition, gives the same events and the same
 * counts.
 */

export const METRICS_SUMMARY_SCHEMA_VERSION = 1;
export const METRICS_SNAPSHOT_REL_PATH = 'governance/metrics/outcomes.json';
export const METRIC_WINDOWS = Object.freeze([
  Object.freeze({ key: 'last_7_days', label: 'Last 7 days', days: 7 }),
  Object.freeze({ key: 'last_30_days', label: 'Last 30 days', days: 30 }),
  Object.freeze({ key: 'all_time', label: 'All time', days: null })
]);

const RECEIPTS_REL_DIR = 'governance/run-receipts/inbox-processing';
const INPUT_QUEUE_REL_PATH = 'governance/input-queue.md';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Each category, its group, and what it counts. */
export const METRIC_CATEGORIES = Object.freeze([
  Object.freeze({
    key: 'captured_inputs',
    group: 'operational',
    label: 'Captured inputs',
    definition: 'Review records opened as raw: one for each capture from the CLI or UI, and for each raw file registered or migrated.',
    time: 'The time the record was registered.',
    source: 'lifecycle_ledger'
  }),
  Object.freeze({
    key: 'processed_inputs',
    group: 'operational',
    label: 'Processed inputs',
    definition: 'Inbox items listed as processed in a completed inbox-processing receipt. An item is counted once, by source ID when the receipt has one and by path otherwise, however many receipts list it.',
    time: 'The completion time of the first receipt that lists the item.',
    source: 'inbox_receipt'
  }),
  Object.freeze({
    key: 'promoted_evidence',
    group: 'learning',
    label: 'Promoted evidence',
    definition: 'Records moved to evidence, or opened as evidence.',
    time: 'The time of the transition.',
    source: 'lifecycle_ledger'
  }),
  Object.freeze({
    key: 'reviewed_outputs',
    group: 'learning',
    label: 'Reviewed outputs',
    definition: 'Human review decisions: each approval and each rejection of a submitted record.',
    time: 'The time of the decision.',
    source: 'lifecycle_ledger'
  }),
  Object.freeze({
    key: 'accepted_learnings',
    group: 'learning',
    label: 'Accepted learnings',
    definition: 'Approvals: each time a person accepted a submitted record as context. A record revised and approved again counts once for each approval.',
    time: 'The time of the approval.',
    source: 'lifecycle_ledger'
  }),
  Object.freeze({
    key: 'superseded_context',
    group: 'learning',
    label: 'Superseded context',
    definition: 'Accepted records replaced by another accepted record.',
    time: 'The time the record was superseded.',
    source: 'lifecycle_ledger'
  }),
  Object.freeze({
    key: 'unresolved_questions',
    group: 'learning',
    label: 'Unresolved questions',
    definition: 'Open requests in the human-input queue. This is a count of what is open now, not of events.',
    time: 'The queue has no timestamps, so there is one current count and no time windows.',
    source: 'input_queue'
  })
]);

function toPortablePath(value) {
  return value.split(path.sep).join('/');
}

function readTextOrNull(absolute) {
  try {
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}

function isTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

// ---------------------------------------------------------------------------
// Events from the review ledger

function ledgerEvent(category, record, entry) {
  return {
    event_id: `${category}:${record.record_id}:${entry.revision}`,
    category,
    at: entry.at,
    record_id: record.record_id,
    source_id: record.source_id,
    transition: { action: entry.action, from_state: entry.from_state, to_state: entry.to_state, revision: entry.revision },
    actor: entry.actor,
    actor_type: entry.actor_type,
    provenance: { kind: 'lifecycle_ledger', path: toPortablePath(LIFECYCLE_LEDGER_REL_PATH) }
  };
}

/** One event per history entry that matches a category.  History is append-only. */
function collectLedgerEvents(records) {
  const events = [];
  for (const record of records) {
    for (const entry of record.history) {
      if (!isTimestamp(entry.at)) continue;
      if (entry.action === 'register' && entry.to_state === 'raw') events.push(ledgerEvent('captured_inputs', record, entry));
      if (entry.to_state === 'evidence' && entry.from_state !== 'evidence') events.push(ledgerEvent('promoted_evidence', record, entry));
      if (entry.action === 'approve' || entry.action === 'reject') events.push(ledgerEvent('reviewed_outputs', record, entry));
      if (entry.action === 'approve') events.push(ledgerEvent('accepted_learnings', record, entry));
      if (entry.to_state === 'superseded' && entry.from_state !== 'superseded') events.push(ledgerEvent('superseded_context', record, entry));
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Events from inbox-processing receipts

function receiptItems(receipt) {
  const items = new Map();
  const sourceByPath = new Map();
  for (const item of Array.isArray(receipt.processed_sources) ? receipt.processed_sources : []) {
    if (item && typeof item === 'object' && isSourceId(item.source_id) && typeof item.path === 'string') sourceByPath.set(item.path, item.source_id);
  }
  const add = (itemPath, sourceId) => {
    const key = sourceId || itemPath;
    if (key && !items.has(key)) items.set(key, { key, ...(sourceId ? { source_id: sourceId } : {}), ...(itemPath ? { path: itemPath } : {}) });
  };
  for (const item of Array.isArray(receipt.processed_sources) ? receipt.processed_sources : []) {
    if (item && typeof item === 'object') add(typeof item.path === 'string' ? item.path : null, isSourceId(item.source_id) ? item.source_id : null);
  }
  for (const itemPath of Array.isArray(receipt.processed) ? receipt.processed : []) {
    if (typeof itemPath === 'string' && itemPath) add(itemPath, sourceByPath.get(itemPath) || null);
  }
  return [...items.values()];
}

/**
 * One event per processed item.  A path with a source ID in any receipt is
 * the same item as that source, so a retry or a second receipt adds nothing.
 */
function collectReceiptEvents(root) {
  const state = inspectInboxProcessing(root);
  const countable = getCountableInboxReceipts(state, root);
  // Ambiguous coordination state makes every receipt uncountable.
  const blocked = state.receipts.length > 0 && countable.length === 0;
  const receipts = countable
    .filter((item) => isTimestamp(item.receipt.completed_at))
    .sort((left, right) => left.receipt.completed_at.localeCompare(right.receipt.completed_at) || String(left.run_id).localeCompare(String(right.run_id)));

  const sourceByPath = new Map();
  for (const { receipt } of receipts) {
    for (const item of receiptItems(receipt)) if (item.source_id && item.path && !sourceByPath.has(item.path)) sourceByPath.set(item.path, item.source_id);
  }
  const seen = new Set();
  const events = [];
  let withoutItems = 0;
  for (const { receipt, run_id: runId, path: receiptPath } of receipts) {
    const items = receiptItems(receipt);
    if (!items.length) withoutItems += 1;
    for (const item of items) {
      const sourceId = item.source_id || sourceByPath.get(item.path) || null;
      const identity = sourceId || item.path;
      if (seen.has(identity)) continue;
      seen.add(identity);
      events.push({
        event_id: `processed_inputs:${identity}`,
        category: 'processed_inputs',
        at: new Date(receipt.completed_at).toISOString(),
        ...(sourceId ? { source_id: sourceId } : {}),
        ...(item.path ? { path: item.path } : {}),
        run_id: runId,
        actor: receipt.processor || receipt.claimed_by || null,
        provenance: { kind: 'inbox_receipt', path: receiptPath || RECEIPTS_REL_DIR }
      });
    }
  }
  return {
    events,
    blocked,
    receipts_counted: receipts.length - withoutItems,
    receipts_without_items: withoutItems,
    receipts_uncountable: state.invalidReceipts.length + (blocked ? state.receipts.length : 0)
  };
}

// ---------------------------------------------------------------------------
// The human-input queue

function splitTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  return trimmed.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/** Open request rows in the Markdown queue table. */
function countOpenQuestions(text) {
  const lines = text.split(/\r?\n/);
  let open = 0;
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*(```|~~~)/.test(lines[index])) inFence = !inFence;
    if (inFence) continue;
    const header = splitTableRow(lines[index]);
    const separator = index + 1 < lines.length ? splitTableRow(lines[index + 1]) : null;
    if (!header || !separator || !separator.every((cell) => /^:?-+:?$/.test(cell.replace(/\s+/g, '')))) continue;
    const keys = header.map((cell) => cell.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''));
    if (!keys.includes('request') || !keys.some((key) => ['priority', 'status', 'why_this_matters'].includes(key))) continue;
    let rowIndex = index + 2;
    for (; rowIndex < lines.length; rowIndex += 1) {
      const cells = splitTableRow(lines[rowIndex]);
      if (!cells) break;
      const row = Object.fromEntries(keys.map((key, cellIndex) => [key, cells[cellIndex] ?? '']));
      const request = (row.request || '').replace(/[_*`]/g, '').trim().toLowerCase();
      if (!request || ['tbd', 'todo', 'n/a', '-', 'no open requests.'].includes(request)) continue;
      const status = (row.status || '').replace(/~~.*?~~/g, '').replace(/[_*`]/g, '').trim().toLowerCase();
      if (/^(complete|completed|done|closed|answered|resolved|declined|cancelled|canceled|rejected)\b/.test(status)) continue;
      open += 1;
    }
    index = rowIndex - 1;
  }
  return open;
}

// ---------------------------------------------------------------------------

function windowCounts(events, now) {
  const counts = {};
  for (const window of METRIC_WINDOWS) {
    const from = window.days === null ? -Infinity : now.getTime() - window.days * DAY_MS;
    counts[window.key] = events.filter((event) => {
      const at = Date.parse(event.at);
      return at > from && at <= now.getTime();
    }).length;
  }
  return counts;
}

function unavailableCounts() {
  return Object.fromEntries(METRIC_WINDOWS.map((window) => [window.key, null]));
}

/**
 * Every metric event the workspace's records support, oldest first.  Each
 * has a stable `event_id`, so a consumer can store them without duplicates.
 */
export function collectMetricEvents(instanceRoot = process.cwd()) {
  const root = path.resolve(String(instanceRoot));
  const notes = {};
  let ledgerEvents = [];
  try {
    const records = listLifecycleRecords(root);
    ledgerEvents = collectLedgerEvents(records);
    // The ledger's first entry of any kind, not only the ones counted here.
    const started = records.flatMap((record) => record.history.map((entry) => entry.at)).filter(isTimestamp).sort()[0] ?? null;
    notes.lifecycle_ledger = { available: true, started_at: started };
  } catch (error) {
    notes.lifecycle_ledger = { available: false, reason: `The review ledger cannot be read: ${error.message}` };
  }
  let receipts = { events: [], blocked: false, receipts_counted: 0, receipts_without_items: 0, receipts_uncountable: 0 };
  try {
    receipts = collectReceiptEvents(root);
    notes.inbox_receipt = receipts.blocked
      ? { available: false, reason: 'Inbox receipts or locks are in an ambiguous state. Run "mole inbox audit" and reconcile it; nothing is counted until then.' }
      : { available: true };
  } catch (error) {
    notes.inbox_receipt = { available: false, reason: `The inbox-processing receipts cannot be read: ${error.message}` };
  }
  const events = [...ledgerEvents, ...receipts.events]
    .sort((left, right) => left.at.localeCompare(right.at) || left.event_id.localeCompare(right.event_id));
  return { events, notes, receipts };
}

/**
 * Summarise workflow metrics.  Read-only.  Counts are given for the last 7
 * days, the last 30 days, and all time, measured back from `now`.
 */
export function summarizeMetrics(instanceRoot = process.cwd(), options = {}) {
  const root = path.resolve(String(instanceRoot));
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) throw Object.assign(new Error(`Invalid timestamp: ${options.now}`), { code: 'INVALID_ARGUMENT' });
  const { events, notes, receipts } = collectMetricEvents(root);

  const firstLedgerEvent = notes.lifecycle_ledger.started_at ?? null;

  const categories = METRIC_CATEGORIES.map((category) => {
    const base = { key: category.key, group: category.group, label: category.label, definition: category.definition, time: category.time, source: category.source };
    if (category.source === 'input_queue') {
      const text = readTextOrNull(path.join(root, ...INPUT_QUEUE_REL_PATH.split('/')));
      return text === null
        ? { ...base, availability: 'unavailable', reason: `${INPUT_QUEUE_REL_PATH} is missing.`, current: null, counts: unavailableCounts() }
        : { ...base, availability: 'current_only', reason: 'The queue records no times, so only the current count is known.', current: countOpenQuestions(text), counts: unavailableCounts() };
    }
    const sourceNote = notes[category.source];
    if (!sourceNote.available) {
      return { ...base, availability: 'unavailable', reason: sourceNote.reason, counts: unavailableCounts() };
    }
    const own = events.filter((event) => event.category === category.key);
    const entry = { ...base, availability: 'available', counts: windowCounts(own, now), latest_at: own.length ? own[own.length - 1].at : null };
    if (category.source === 'lifecycle_ledger') {
      // Nothing before the ledger existed was recorded, so it is unknown, not zero.
      entry.available_from = firstLedgerEvent;
      entry.reason = firstLedgerEvent
        ? `Counted from the review ledger, which starts at ${firstLedgerEvent}. Earlier activity is unknown, not zero.`
        : 'The review ledger holds no records yet. Earlier activity is unknown, not zero.';
    } else {
      entry.receipts_counted = receipts.receipts_counted;
      entry.receipts_without_items = receipts.receipts_without_items;
      entry.receipts_uncountable = receipts.receipts_uncountable;
      if (receipts.receipts_without_items || receipts.receipts_uncountable) {
        entry.reason = `${receipts.receipts_without_items} completed ${receipts.receipts_without_items === 1 ? 'receipt lists' : 'receipts list'} no processed items and ${receipts.receipts_uncountable} could not be validated. Their activity is unknown and is not counted.`;
      }
    }
    return entry;
  });

  return {
    schema_version: METRICS_SUMMARY_SCHEMA_VERSION,
    ok: true,
    read_only: true,
    generated_at: now.toISOString(),
    windows: METRIC_WINDOWS.map((window) => ({
      key: window.key,
      label: window.label,
      from: window.days === null ? null : new Date(now.getTime() - window.days * DAY_MS).toISOString(),
      to: now.toISOString()
    })),
    caveat: 'These are counts of workflow activity and review state. They do not measure product success or the quality of a decision.',
    groups: {
      operational: 'What processing happened.',
      learning: 'What product-context states changed.'
    },
    categories,
    event_count: events.length,
    ...(options.includeEvents ? { events } : {})
  };
}

/**
 * Write the summary to `governance/metrics/outcomes.json` for the local
 * dashboard.  The file is a snapshot: it can be deleted and written again.
 */
export function writeMetricsSnapshot(instanceRoot = process.cwd(), options = {}) {
  const root = path.resolve(String(instanceRoot));
  const summary = summarizeMetrics(root, { now: options.now });
  const { read_only: _readOnly, ...snapshot } = summary;
  const absolute = path.join(root, ...METRICS_SNAPSHOT_REL_PATH.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, absolute);
  return { ok: true, path: METRICS_SNAPSHOT_REL_PATH, summary };
}

/** Render the summary as text for a terminal. */
export function formatMetricsSummary(summary) {
  const lines = ['Molehill Metrics', '', `as of ${summary.generated_at}`, summary.caveat];
  const header = `${'category'.padEnd(24)}${METRIC_WINDOWS.map((window) => window.label.padStart(14)).join('')}`;
  for (const [group, title] of [['operational', 'Operational activity: what processing happened'], ['learning', 'Learning and decision state: what context states changed']]) {
    lines.push('', title, header);
    for (const category of summary.categories.filter((item) => item.group === group)) {
      if (category.availability === 'available') {
        lines.push(`${category.label.padEnd(24)}${METRIC_WINDOWS.map((window) => String(category.counts[window.key]).padStart(14)).join('')}`);
      } else if (category.availability === 'current_only') {
        lines.push(`${category.label.padEnd(24)}${`${category.current} open now`.padStart(14 * METRIC_WINDOWS.length)}`);
      } else {
        lines.push(`${category.label.padEnd(24)}${'unavailable'.padStart(14 * METRIC_WINDOWS.length)}`);
      }
    }
  }
  const notes = summary.categories.filter((category) => category.reason);
  if (notes.length) {
    lines.push('', 'Notes');
    const seen = new Set();
    for (const category of notes) {
      const key = category.source === 'lifecycle_ledger' ? `ledger:${category.reason}` : `${category.key}:${category.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const subject = category.source === 'lifecycle_ledger'
        ? summary.categories.filter((item) => item.source === 'lifecycle_ledger' && item.reason === category.reason).map((item) => item.label).join(', ')
        : category.label;
      lines.push(`- ${subject}: ${category.reason}`);
    }
  }
  lines.push('', 'Definitions: docs/molehill-metrics.md. Add --format json for the full record.');
  return `${lines.join('\n')}\n`;
}
