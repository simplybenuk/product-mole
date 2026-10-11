import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { auditInbox } from './inbox-audit.mjs';
import { looksLikeSyncConflictName } from './inbox-processing.mjs';
import { auditLifecycle } from './review-lifecycle.mjs';
import { SOURCE_ID_PATTERN, findRegistryFindings, getSourceRegistryPaths } from './source-registry.mjs';

/**
 * Read-only health check for a whole Mole workspace.  It runs the focused
 * audits (inbox, source registry, review lifecycle) and adds checks for
 * workspace metadata, frontmatter, summaries and indexes, duplicate files,
 * and the human-input queue.  Nothing is written, moved, or deleted.
 */

export const VALIDATION_SEVERITIES = Object.freeze(['error', 'warning', 'info']);
export const DEFAULT_STALE_AFTER_DAYS = 90;
export const INPUT_QUEUE_MAX_OPEN = 10;

/** Exit codes of `mole validate`. */
export const VALIDATION_EXIT_CODES = Object.freeze({ healthy: 0, findings: 1, invalid_arguments: 2, internal_failure: 3 });

const REQUIRED_PATHS = Object.freeze([
  ['mole.instance.yaml', 'file'],
  ['0-bootstrap', 'directory'],
  ['1-routing', 'directory'],
  ['2-summaries', 'directory'],
  ['3-indexes', 'directory'],
  ['4-context', 'directory'],
  ['5-evidence', 'directory'],
  ['6-raw', 'directory'],
  ['6-raw/inbox', 'directory']
]);

/** Folders whose Markdown files carry frontmatter that is checked. */
const FRONTMATTER_ROOTS = Object.freeze(['2-summaries', '3-indexes', '4-context', '5-evidence', '6-raw']);
/** Folders where a Markdown file must have frontmatter with these fields. */
const REQUIRED_METADATA = Object.freeze({
  '2-summaries': ['title', 'summary', 'last_updated'],
  '4-context': ['title', 'summary']
});
const DUPLICATE_ROOTS = Object.freeze(['4-context', '5-evidence', '6-raw']);
const CONFLICT_COPY_ROOTS = Object.freeze(['0-bootstrap', '1-routing', '2-summaries', '3-indexes', '4-context', '5-evidence', '6-raw', 'governance']);
/** Each focused audit reports conflict copies in the folders it owns. */
const CONFLICT_COPY_EXCLUDES = Object.freeze(['6-raw/inbox', 'governance/lifecycle', 'governance/sources', 'governance/run-receipts']);
const CONFIDENCE_VALUES = Object.freeze(['high', 'medium', 'low']);
const STATUS_VALUES = Object.freeze(['draft', 'active', 'archived']);
const DAY_MS = 24 * 60 * 60 * 1000;

const INBOX_ISSUE_SEVERITY = Object.freeze({ STALE_LOCK: 'warning' });
const INBOX_ISSUE_REMEDY = Object.freeze({
  INVALID_LOCK: 'Inspect governance/inbox-processing.lock.json. Repair it from a retained copy, or recover with "mole inbox override-stale" after checking that no run is active.',
  SYNC_CONFLICT: 'Preserve every copy, compare them, and keep one. Never delete a source to resolve a conflict.',
  UNSAFE_INBOX_ENTRY: 'Replace the link or special file with a regular file inside the inbox, or remove it.',
  DUPLICATE_RECEIPT: 'Compare the receipts for the run and keep one. Preserve the others outside the receipts folder.',
  INVALID_RECEIPT: 'Open the receipt, compare it with a valid one, and repair or regenerate it.',
  INVALID_OVERRIDE: 'Open the override record and repair it, or reconcile the run it refers to.',
  OVERRIDE_CONFLICT: 'Preserve every override copy and reconcile them into one record.',
  INCOMPLETE_OVERRIDE: 'Finish or redo the stale-lock recovery with "mole inbox override-stale".',
  PROCESSED_PATH_CONFLICT: 'Two runs claim the same inbox path. Compare their receipts and decide which run processed it.',
  STALE_LOCK: 'Check that the run has stopped, then run "mole inbox override-stale --run-id <new-run-id> --processor "<name>" --reason "<why>"".'
});

const SOURCE_FINDING_SEVERITY = Object.freeze({
  orphan_record: 'warning',
  orphan_source: 'warning',
  duplicate_content: 'warning'
});
const SOURCE_FINDING_MESSAGE = Object.freeze({
  invalid_record: 'A source record cannot be validated.',
  record_filename_conflict: 'A source record file is not named after the source ID it holds.',
  orphan_record: 'A source record points at a path that holds no file, such as an archive move that was not reconciled.',
  content_conflict: 'A registered source file no longer holds its registered bytes.',
  symlink_escape: 'A registered source path resolves outside the workspace through a link.',
  workspace_escape: 'A registered source path leaves the workspace.',
  duplicate_record: 'More than one record file holds the same source ID.',
  revision_conflict: 'Copies of one source record disagree at the same revision.',
  duplicate_content: 'More than one source is registered with the same bytes.',
  path_claim_conflict: 'More than one source is registered at the same path.',
  orphan_source: 'A file names a source ID that has no record in the registry.',
  missing_attachment_record: 'A source lists an attachment that has no record.',
  attachment_link_conflict: 'An attachment and its parent source do not point at each other.'
});

const LIFECYCLE_FINDING_SEVERITY = Object.freeze({
  source_unresolved: 'warning',
  pending_content_changed: 'warning',
  supporting_source_missing: 'warning',
  stale_mutation_lock: 'warning',
  stale_temp_file: 'warning',
  unexpected_entry: 'warning'
});
const LIFECYCLE_FINDING_MESSAGE = Object.freeze({
  invalid_ledger: 'The review ledger cannot be validated.',
  ledger_conflict_copy: 'A second copy of the review ledger exists.',
  stale_temp_file: 'An interrupted write left a temporary file in the lifecycle folder.',
  unexpected_entry: 'The lifecycle folder holds a file that does not belong there.',
  stale_mutation_lock: 'A stopped process left the lifecycle mutation lock behind.',
  accepted_content_changed: 'An accepted file changed after it was approved.',
  pending_content_changed: 'A file changed after it was submitted for review.',
  source_unresolved: 'A review record cannot find its file.',
  source_record_missing: 'A review record names a source that has no record.',
  source_record_invalid: 'A review record names a source whose record is invalid.',
  unsafe_path: 'A review record points at an unsafe path.',
  no_local_file: 'A review record names a source that has no local file.',
  path_claim_conflict: 'Two open review records point at the same file.',
  supporting_source_missing: 'An accepted record cites a supporting source that has no record.'
});

function toPortablePath(value) {
  return value.split(path.sep).join('/');
}

function absoluteOf(root, relative) {
  return path.join(root, ...relative.split('/'));
}

function statOrNull(absolute) {
  try {
    return fs.lstatSync(absolute);
  } catch {
    return null;
  }
}

function readTextOrNull(absolute) {
  try {
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}

/** Regular files under the given folders.  Links are never followed. */
function walkFiles(root, roots, excludes = []) {
  const files = [];
  const queue = roots.filter((relative) => statOrNull(absoluteOf(root, relative))?.isDirectory());
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(absoluteOf(root, current), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = `${current}/${entry.name}`;
      if (excludes.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) queue.push(relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function createReport() {
  const findings = [];
  const checks = [];
  return {
    findings,
    checks,
    add(code, severity, message, remedy, location = {}) {
      findings.push({ code, severity, message, remedy, ...location });
    },
    /** Run one check and record whether it found anything or could not run. */
    check(name, run) {
      const before = findings.length;
      try {
        const skipped = run();
        checks.push({ name, status: skipped ? 'skipped' : (findings.length > before ? 'findings' : 'ok'), ...(skipped ? { reason: skipped } : {}) });
      } catch (error) {
        findings.push({
          code: 'CHECK_FAILED',
          severity: 'error',
          message: `The ${name} check could not finish: ${error.message}`,
          remedy: 'Fix the problem named in the message and run "mole validate" again. Other checks still ran.',
          check: name
        });
        checks.push({ name, status: 'failed' });
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Workspace and package metadata

function parseSimpleYaml(text) {
  const fields = {};
  const errors = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || /^\s*#/.test(line) || /^\s/.test(line) || /^-\s/.test(line)) return;
    const match = line.match(/^([A-Za-z_][\w-]*)\s*:(?:\s+(.*)|\s*)$/);
    if (!match) {
      errors.push(`line ${index + 1} is not "key: value"`);
      return;
    }
    fields[match[1]] = (match[2] ?? '').replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
  });
  return { fields, errors };
}

function compareVersions(left, right) {
  const parse = (value) => String(value).replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parse(left), parse(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function checkStructure(root, report) {
  for (const [relative, kind] of REQUIRED_PATHS) {
    const stat = statOrNull(absoluteOf(root, relative));
    const present = stat && (kind === 'file' ? stat.isFile() : stat.isDirectory());
    if (present) continue;
    if (relative === 'mole.instance.yaml') {
      report.add('INSTANCE_METADATA_MISSING', 'error', 'The workspace has no mole.instance.yaml, so its version is unknown.',
        'Run "mole validate" from the workspace root. If this is the root, copy mole.instance-template.yaml to mole.instance.yaml and set the version.', { path: relative });
    } else {
      report.add('WORKSPACE_PATH_MISSING', 'error', `The workspace ${kind} ${relative} is missing${stat ? ` (the path is not a ${kind})` : ''}.`,
        'Restore the folder from version control, or create it. "mole new <name>" shows the expected layout.', { path: relative });
    }
  }
}

function checkMetadata(root, report, context) {
  const instanceText = readTextOrNull(absoluteOf(root, 'mole.instance.yaml'));
  if (instanceText !== null) {
    const { fields, errors } = parseSimpleYaml(instanceText);
    const version = fields.cascade_version || fields.mole_version || null;
    context.instanceVersion = version;
    if (errors.length) {
      report.add('INSTANCE_METADATA_INVALID', 'error', `mole.instance.yaml cannot be parsed: ${errors.slice(0, 3).join('; ')}.`,
        'Fix the named lines so each top-level line is "key: value". Compare with mole.instance-template.yaml.', { path: 'mole.instance.yaml' });
    } else if (!version || !/^v?\d+\.\d+\.\d+/.test(version)) {
      report.add('INSTANCE_METADATA_INVALID', 'error', `mole.instance.yaml does not give a usable version (cascade_version is ${version ? `"${version}"` : 'missing'}).`,
        'Set cascade_version to the Mole version the workspace was created or last upgraded with, such as 0.2.8.', { path: 'mole.instance.yaml' });
    } else if (context.cliVersion && /^\d+\.\d+\.\d+/.test(context.cliVersion)) {
      const comparison = compareVersions(version, context.cliVersion);
      if (comparison > 0) {
        report.add('INSTANCE_VERSION_AHEAD', 'warning', `The workspace is at version ${version}, newer than this Mole CLI (${context.cliVersion}). Checks may miss rules the newer version added.`,
          'Upgrade the CLI with "mole upgrade <version>".', { path: 'mole.instance.yaml' });
      } else if (comparison < 0) {
        report.add('INSTANCE_VERSION_BEHIND', 'info', `The workspace is at version ${version} and this Mole CLI is ${context.cliVersion}.`,
          'Run "mole check-updates" to see what an upgrade would change.', { path: 'mole.instance.yaml' });
      }
    }
  }

  // A source checkout or a packaged copy carries its own version files.
  const packageText = readTextOrNull(absoluteOf(root, 'package.json'));
  const versionText = readTextOrNull(absoluteOf(root, 'VERSION'));
  if (packageText === null) return;
  let manifest;
  try {
    manifest = JSON.parse(packageText);
  } catch (error) {
    report.add('PACKAGE_METADATA_INVALID', 'error', `package.json cannot be parsed: ${error.message}`,
      'Fix the JSON syntax in package.json.', { path: 'package.json' });
    return;
  }
  if (manifest?.name !== 'product-mole' || versionText === null) return;
  const declared = versionText.trim();
  if (manifest.version !== declared) {
    report.add('PACKAGE_VERSION_MISMATCH', 'error', `VERSION says ${declared || '(empty)'} and package.json says ${manifest.version ?? '(missing)'}.`,
      'Make the two versions agree. "npm run check:versions" lists every file that must match.', { path: 'package.json' });
  }
}

// ---------------------------------------------------------------------------
// Focused audits

function checkInbox(root, report, context) {
  if (REQUIRED_PATHS.some(([relative]) => !statOrNull(absoluteOf(root, relative)))) {
    return 'the workspace layout is incomplete';
  }
  const audit = auditInbox(root, { now: context.now });
  for (const file of audit.unprocessed) {
    report.add('INBOX_UNPROCESSED', 'warning', 'An inbox file is not covered by a processing receipt.',
      'Process it with "mole synthesise inbox", or run "mole inbox audit" for the focused inbox report.', { path: file });
  }
  for (const issue of audit.issues) {
    report.add(`INBOX_${issue.code}`, INBOX_ISSUE_SEVERITY[issue.code] || 'error', issue.message,
      INBOX_ISSUE_REMEDY[issue.code] || 'Run "mole inbox audit" for detail.', { paths: issue.paths.filter(Boolean) });
  }
  return null;
}

function checkSources(root, report) {
  const paths = getSourceRegistryPaths(root);
  if (!statOrNull(paths.recordsDir)) return 'no source registry yet';
  for (const item of findRegistryFindings(root)) {
    const type = item.finding_type || item.type;
    const location = {};
    if (item.source_id) location.source_id = item.source_id;
    if (item.source_ids) location.source_ids = item.source_ids;
    const filePath = item.current_path || item.path || item.record_path;
    if (filePath) location.path = filePath;
    if (item.record_paths) location.paths = item.record_paths;
    if (item.errors) location.errors = item.errors;
    report.add(`SOURCE_${type.toUpperCase()}`, SOURCE_FINDING_SEVERITY[type] || 'error',
      SOURCE_FINDING_MESSAGE[type] || `The source registry reported ${type}.`,
      item.action || 'Run "mole source resolve <source_id>" for detail and repair the record.', location);
  }
  return null;
}

function checkLifecycle(root, report) {
  const audit = auditLifecycle(root);
  for (const item of audit.findings) {
    const location = {};
    if (item.record_id) location.record_id = item.record_id;
    if (item.source_id) location.source_id = item.source_id;
    if (item.path) location.path = item.path;
    if (item.candidate_paths) location.paths = item.candidate_paths;
    if (item.errors) location.errors = item.errors;
    if (item.state) location.state = item.state;
    report.add(`LIFECYCLE_${item.type.toUpperCase()}`, LIFECYCLE_FINDING_SEVERITY[item.type] || 'error',
      LIFECYCLE_FINDING_MESSAGE[item.type] || `The review ledger audit reported ${item.type}.`,
      item.action || 'Run "mole lifecycle audit" for detail.', location);
  }
  if (!audit.ledger_exists && !audit.findings.length) return 'no review ledger yet';
  return null;
}

// ---------------------------------------------------------------------------
// Frontmatter and metadata

/**
 * Split a Markdown file into frontmatter fields and body.  Only the shape
 * Mole writes is understood: top-level `key: value` lines, with indented or
 * list lines belonging to the key above them.
 */
export function parseFrontmatter(text) {
  const source = String(text ?? '').replace(/^﻿/, '');
  const opener = source.match(/^---[ \t]*\r?\n/);
  if (!opener) return { present: false, terminated: false, fields: {}, errors: [], body: source };
  const lines = source.slice(opener[0].length).split(/\r?\n/);
  const fields = {};
  const errors = [];
  let closing = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) {
      closing = index;
      break;
    }
    if (!line.trim() || /^\s*#/.test(line) || /^\s/.test(line) || /^-(\s|$)/.test(line)) continue;
    const match = line.match(/^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/);
    if (!match) {
      errors.push({ line: index + 2, text: line });
      continue;
    }
    fields[match[1]] = (match[2] ?? '').replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  if (closing < 0) return { present: true, terminated: false, fields, errors, body: '' };
  return { present: true, terminated: true, fields, errors, body: lines.slice(closing + 1).join('\n') };
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isEmptyValue(value) {
  return value === undefined || value === '' || value === 'null' || value === '~';
}

function checkFrontmatter(root, report, context) {
  const knownSourceIds = context.knownSourceIds;
  for (const relative of walkFiles(root, FRONTMATTER_ROOTS)) {
    if (!relative.toLowerCase().endsWith('.md') || path.posix.basename(relative).toLowerCase() === 'readme.md') continue;
    const text = readTextOrNull(absoluteOf(root, relative));
    if (text === null) continue;
    const parsed = parseFrontmatter(text);
    context.documents.set(relative, { text, parsed });
    const layer = relative.split('/')[0];
    const required = REQUIRED_METADATA[layer];

    if (!parsed.present) {
      if (required) {
        report.add('FRONTMATTER_MISSING', 'warning', `The file has no frontmatter. Files in ${layer}/ need ${required.join(', ')}.`,
          'Add a frontmatter block at the top of the file. templates/metadata-frontmatter.md shows the fields.', { path: relative });
      }
      continue;
    }
    if (!parsed.terminated) {
      report.add('FRONTMATTER_UNTERMINATED', 'error', 'The frontmatter starts with "---" and never closes, so the whole file reads as metadata.',
        'Add a line holding only "---" after the last metadata field.', { path: relative });
      continue;
    }
    for (const error of parsed.errors) {
      report.add('FRONTMATTER_INVALID', 'warning', `Frontmatter line ${error.line} is not "key: value": ${error.text.trim().slice(0, 80)}`,
        'Rewrite the line as "key: value", or indent it under the key it belongs to.', { path: relative, line: error.line });
    }
    const missing = (required || []).filter((field) => isEmptyValue(parsed.fields[field]));
    if (missing.length) {
      report.add('METADATA_MISSING', 'warning', `The frontmatter lacks ${missing.join(', ')}.`,
        `Add ${missing.map((field) => `"${field}:"`).join(' and ')} to the frontmatter. templates/metadata-frontmatter.md shows the format.`, { path: relative, fields: missing });
    }
    const invalid = [];
    const { fields } = parsed;
    for (const field of ['last_updated', 'review_after']) {
      if (!isEmptyValue(fields[field]) && !isCalendarDate(fields[field])) invalid.push(`${field} "${fields[field]}" is not a YYYY-MM-DD date`);
    }
    if (!isEmptyValue(fields.confidence) && !CONFIDENCE_VALUES.includes(fields.confidence.toLowerCase())) {
      invalid.push(`confidence "${fields.confidence}" is not one of ${CONFIDENCE_VALUES.join(', ')}`);
    }
    if (REQUIRED_METADATA[layer] && !isEmptyValue(fields.status) && !STATUS_VALUES.includes(fields.status.toLowerCase())) {
      invalid.push(`status "${fields.status}" is not one of ${STATUS_VALUES.join(', ')}`);
    }
    if (!isEmptyValue(fields.source_id) && !SOURCE_ID_PATTERN.test(fields.source_id)) {
      invalid.push(`source_id "${fields.source_id}" is not a source ID`);
    }
    if (invalid.length) {
      report.add('METADATA_INVALID', 'warning', `The frontmatter has values Mole cannot use: ${invalid.join('; ')}.`,
        'Correct the named fields. templates/metadata-frontmatter.md lists the allowed values.', { path: relative });
    }

    // Supporting sources are cited by ID.  A cited ID with no record is a broken link.
    const frontmatterText = text.slice(0, text.length - parsed.body.length);
    const refsStart = frontmatterText.search(/^source_refs[ \t]*:/m);
    if (refsStart >= 0) {
      const refsBlock = frontmatterText.slice(refsStart).split(/\r?\n/).filter((line, index) => index === 0 || /^\s|^-/.test(line)).join('\n');
      const cited = new Set(refsBlock.match(/src_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g) || []);
      for (const sourceId of cited) {
        if (knownSourceIds.has(sourceId)) continue;
        report.add('SOURCE_REF_BROKEN', 'error', 'The file cites a supporting source that has no record in the registry.',
          'Recover the source record, or correct the ID under source_refs. "mole source resolve <source_id>" shows what the registry knows.', { path: relative, source_id: sourceId });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Summaries and indexes

function meaningfulLines(body) {
  return body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && !/^<!--.*-->$/.test(line));
}

function isPlaceholderText(value) {
  const text = value.replace(/[_*`|\-:\s]/g, '').toLowerCase();
  return !text || /^(tbd|todo|tbc|na)+$/.test(text);
}

/** Whether the lower layers hold anything a summary could be written from. */
function hasLowerLayerContent(root) {
  const starters = new Set(['4-context/personas.md', '4-context/stakeholders.md']);
  return walkFiles(root, ['4-context', '5-evidence']).some((relative) => path.posix.basename(relative).toLowerCase() !== 'readme.md' && !starters.has(relative));
}

function checkTopLayers(root, report, context) {
  const populated = hasLowerLayerContent(root);
  const placeholderSeverity = populated ? 'warning' : 'info';
  const placeholderRemedy = populated
    ? 'Run "mole refresh top-layers" and have an agent fill it from 4-context/ and 5-evidence/.'
    : 'Nothing to do until the workspace has context. Then run "mole bootstrap-context".';
  const today = Math.floor(new Date(context.now).getTime() / DAY_MS);

  for (const relative of walkFiles(root, ['2-summaries', '3-indexes'])) {
    if (!relative.toLowerCase().endsWith('.md') || path.posix.basename(relative).toLowerCase() === 'readme.md') continue;
    const document = context.documents.get(relative);
    if (!document) continue;
    const { parsed } = document;
    if (parsed.present && !parsed.terminated) continue;
    const kind = relative.startsWith('2-summaries/') ? 'summary' : 'index';
    const lines = meaningfulLines(parsed.body);
    const tableRows = lines.filter((line) => line.startsWith('|'));
    // A table's header and separator rows are structure, not content.
    const content = lines.filter((line) => !line.startsWith('|')).concat(tableRows.slice(2));

    if (!content.length) {
      report.add(`${kind.toUpperCase()}_BLANK`, placeholderSeverity, `The ${kind} has no content under its headings.`, placeholderRemedy, { path: relative });
      continue;
    }
    const starter = /starter summary template/i.test(parsed.fields.summary || '');
    if (starter || content.every(isPlaceholderText)) {
      report.add(`${kind.toUpperCase()}_PLACEHOLDER`, placeholderSeverity, `The ${kind} still holds only placeholder text such as _TBD_.`, placeholderRemedy, { path: relative });
      continue;
    }

    const reviewAfter = parsed.fields.review_after;
    const lastUpdated = parsed.fields.last_updated;
    if (!isEmptyValue(reviewAfter) && isCalendarDate(reviewAfter) && Math.floor(Date.parse(`${reviewAfter}T00:00:00.000Z`) / DAY_MS) <= today) {
      report.add(`${kind.toUpperCase()}_STALE`, 'warning', `The ${kind} was due for review on ${reviewAfter}.`,
        'Review it against the lower layers with "mole refresh top-layers", then update last_updated and review_after.', { path: relative });
    } else if (!isEmptyValue(lastUpdated) && isCalendarDate(lastUpdated)) {
      const age = today - Math.floor(Date.parse(`${lastUpdated}T00:00:00.000Z`) / DAY_MS);
      if (age > context.staleAfterDays) {
        report.add(`${kind.toUpperCase()}_STALE`, 'warning', `The ${kind} was last updated on ${lastUpdated}, ${age} days ago. The limit is ${context.staleAfterDays} days.`,
          'Review it against the lower layers with "mole refresh top-layers", then update last_updated.', { path: relative, age_days: age });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Duplicate files and sync conflict copies

function checkDuplicates(root, report) {
  for (const relative of walkFiles(root, CONFLICT_COPY_ROOTS, CONFLICT_COPY_EXCLUDES)) {
    if (!looksLikeSyncConflictName(path.posix.basename(relative))) continue;
    report.add('SYNC_CONFLICT_COPY', 'error', 'The file name marks it as a sync conflict copy, so two versions of one file exist.',
      'Compare it with the original, merge what matters into one file, and move the other out of the workspace. Mole does not merge or delete either.', { path: relative });
  }

  const bySize = new Map();
  for (const relative of walkFiles(root, DUPLICATE_ROOTS)) {
    if (path.posix.basename(relative).toLowerCase() === 'readme.md') continue;
    const size = statOrNull(absoluteOf(root, relative))?.size;
    if (!size) continue;
    if (!bySize.has(size)) bySize.set(size, []);
    bySize.get(size).push(relative);
  }
  const byHash = new Map();
  for (const group of bySize.values()) {
    if (group.length < 2) continue;
    for (const relative of group) {
      let digest;
      try {
        digest = createHash('sha256').update(fs.readFileSync(absoluteOf(root, relative))).digest('hex');
      } catch {
        continue;
      }
      if (!byHash.has(digest)) byHash.set(digest, []);
      byHash.get(digest).push(relative);
    }
  }
  for (const [digest, group] of [...byHash].sort((left, right) => left[1][0].localeCompare(right[1][0]))) {
    if (group.length < 2) continue;
    report.add('DUPLICATE_FILE', 'warning', `${group.length} files hold exactly the same bytes.`,
      'Decide which file is the source. Keep the others only if they are deliberate copies, such as an archived capture. Mole does not delete either.', {
        paths: group,
        content_hash: { algorithm: 'sha256', value: digest }
      });
  }
}

// ---------------------------------------------------------------------------
// Human-input queue

function splitTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  return trimmed.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

/** Open request rows of the Markdown queue table. */
export function readInputQueueRows(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const rows = [];
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
      const request = (row.request || '').trim();
      if (isPlaceholderText(request) || /^no open requests\.?$/i.test(request.replace(/[_*`]/g, ''))) continue;
      const status = (row.status || '').replace(/[_*`]/g, '').trim().toLowerCase();
      rows.push({ line: rowIndex + 1, request, status, due: (row.due || '').trim(), closed: /^(complete|completed|done|closed|answered|resolved)\b/.test(status) });
    }
    index = rowIndex - 1;
  }
  return rows;
}

function checkInputQueue(root, report, context) {
  const relative = 'governance/input-queue.md';
  const text = readTextOrNull(absoluteOf(root, relative));
  if (text === null) {
    report.add('INPUT_QUEUE_MISSING', 'warning', 'The workspace has no human-input queue file.',
      'Restore governance/input-queue.md from version control, or copy it from a new workspace.', { path: relative });
    return null;
  }
  const open = readInputQueueRows(text).filter((row) => !row.closed);
  if (!open.length) return null;
  report.add('INPUT_QUEUE_PENDING', 'info', `${open.length} human-input ${open.length === 1 ? 'request is' : 'requests are'} open.`,
    'Run "mole review input-queue" and answer the top asks.', { path: relative, count: open.length });
  if (open.length > INPUT_QUEUE_MAX_OPEN) {
    report.add('INPUT_QUEUE_TOO_LONG', 'warning', `The queue holds ${open.length} open requests. Above ${INPUT_QUEUE_MAX_OPEN}, the important asks get lost.`,
      'Close answered requests, merge duplicates, and defer what no longer matters. A person decides each one.', { path: relative, count: open.length });
  }
  const today = new Date(context.now).toISOString().slice(0, 10);
  for (const row of open) {
    if (isCalendarDate(row.due) && row.due < today) {
      report.add('INPUT_QUEUE_STALE', 'warning', `A request was due on ${row.due} and is still ${row.status || 'open'}: ${row.request.slice(0, 80)}`,
        'Answer it, give it a new due date, or have a person close it.', { path: relative, line: row.line });
    }
  }
  const byText = new Map();
  for (const row of open) {
    const key = row.request.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key) continue;
    if (!byText.has(key)) byText.set(key, []);
    byText.get(key).push(row);
  }
  for (const group of byText.values()) {
    if (group.length < 2) continue;
    report.add('INPUT_QUEUE_DUPLICATE', 'warning', `The same request appears ${group.length} times: ${group[0].request.slice(0, 80)}`,
      'Keep one row and have a person close the others.', { path: relative, lines: group.map((row) => row.line) });
  }
  return null;
}

// ---------------------------------------------------------------------------

function loadKnownSourceIds(root) {
  const ids = new Set();
  const recordsDir = getSourceRegistryPaths(root).recordsDir;
  let entries = [];
  try {
    entries = fs.readdirSync(recordsDir, { withFileTypes: true });
  } catch {
    return ids;
  }
  for (const entry of entries) {
    const sourceId = entry.name.replace(/\.json$/, '');
    if (entry.isFile() && entry.name.endsWith('.json') && SOURCE_ID_PATTERN.test(sourceId)) ids.add(sourceId);
  }
  return ids;
}

const SEVERITY_ORDER = Object.freeze({ error: 0, warning: 1, info: 2 });

/**
 * Validate a workspace and return a report.  The workspace is healthy when
 * no finding is an error or a warning; `info` findings do not fail it.
 */
export function validateWorkspace(instanceRoot = process.cwd(), options = {}) {
  const root = path.resolve(String(instanceRoot));
  const staleAfterDays = options.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  if (!Number.isInteger(staleAfterDays) || staleAfterDays < 1) {
    throw Object.assign(new Error('staleAfterDays must be a whole number of days, at least 1.'), { code: 'INVALID_ARGUMENT' });
  }
  const stat = statOrNull(root);
  if (!stat || !fs.statSync(root).isDirectory()) {
    throw Object.assign(new Error(`Not a directory: ${root}`), { code: 'INVALID_ARGUMENT' });
  }
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) throw Object.assign(new Error(`Invalid timestamp: ${options.now}`), { code: 'INVALID_ARGUMENT' });

  const report = createReport();
  const context = {
    now,
    staleAfterDays,
    cliVersion: options.cliVersion ?? null,
    instanceVersion: null,
    documents: new Map(),
    knownSourceIds: loadKnownSourceIds(root)
  };

  report.check('structure', () => checkStructure(root, report));
  report.check('metadata', () => checkMetadata(root, report, context));
  report.check('inbox', () => checkInbox(root, report, context));
  report.check('sources', () => checkSources(root, report));
  report.check('lifecycle', () => checkLifecycle(root, report));
  report.check('frontmatter', () => checkFrontmatter(root, report, context));
  report.check('top-layers', () => checkTopLayers(root, report, context));
  report.check('duplicates', () => checkDuplicates(root, report));
  report.check('input-queue', () => checkInputQueue(root, report, context));

  const findings = report.findings
    .map((finding, index) => ({ finding, index }))
    .sort((left, right) => SEVERITY_ORDER[left.finding.severity] - SEVERITY_ORDER[right.finding.severity] || left.index - right.index)
    .map((entry) => entry.finding);
  const summary = Object.fromEntries(VALIDATION_SEVERITIES.map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length]));

  return {
    ok: summary.error === 0 && summary.warning === 0,
    read_only: true,
    workspace_root: toPortablePath(root),
    checked_at: now.toISOString(),
    cli_version: context.cliVersion,
    instance_version: context.instanceVersion,
    stale_after_days: staleAfterDays,
    summary,
    checks: report.checks,
    findings
  };
}

/** Where a finding points: a path, a record, or a source. */
function locationOf(finding) {
  const parts = [];
  if (finding.path) parts.push(`${finding.path}${finding.line ? `:${finding.line}` : ''}`);
  if (finding.paths?.length) parts.push(finding.paths.join(', '));
  if (finding.record_id) parts.push(finding.record_id);
  if (finding.source_id) parts.push(finding.source_id);
  if (finding.source_ids?.length) parts.push(finding.source_ids.join(', '));
  return parts.join('  ');
}

/** Render a report as text for a terminal. */
export function formatValidationReport(result) {
  const lines = [
    'Mole validate',
    '',
    'read-only report',
    `workspace        ${result.workspace_root}`,
    `cli version      ${result.cli_version ?? 'unknown'}`,
    `instance version ${result.instance_version ?? 'not found'}`,
    `checks           ${result.checks.map((check) => `${check.name} ${check.status}`).join(', ')}`,
    `findings         ${result.summary.error} ${result.summary.error === 1 ? 'error' : 'errors'}, ${result.summary.warning} ${result.summary.warning === 1 ? 'warning' : 'warnings'}, ${result.summary.info} info`
  ];
  for (const severity of VALIDATION_SEVERITIES) {
    const group = result.findings.filter((finding) => finding.severity === severity);
    if (!group.length) continue;
    lines.push('', `${severity === 'info' ? 'Info' : `${severity[0].toUpperCase()}${severity.slice(1)}s`} (${group.length})`);
    for (const finding of group) {
      const location = locationOf(finding);
      lines.push(`- ${finding.code}${location ? `  ${location}` : ''}`);
      lines.push(`    ${finding.message}`);
      for (const detail of (finding.errors || []).slice(0, 5)) lines.push(`    ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
      lines.push(`    Fix: ${finding.remedy}`);
    }
  }
  lines.push('', result.ok
    ? (result.summary.info ? 'Workspace is healthy. Info findings do not need action.' : 'Workspace is healthy.')
    : 'Workspace has findings. Nothing was changed.');
  return `${lines.join('\n')}\n`;
}
