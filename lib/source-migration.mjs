import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  findRegistryFindings,
  findSourceRecordsByPath,
  getSourceRegistryPaths,
  isSourceId,
  resolveSource
} from './source-registry.mjs';

const DEFAULT_SCAN_ROOTS = [
  '2-summaries',
  '3-indexes',
  '4-context',
  '5-evidence',
  'governance',
  'docs'
];
const PATH_PATTERN = /(?:^|[\s("'`])((?:2-summaries|3-indexes|4-context|5-evidence|6-raw|governance|docs)\/[A-Za-z0-9_./-]+)/g;
const STRUCTURED_SOURCE_REFERENCE_FIELDS = new Set(['source_refs', 'processed_sources']);
const YAML_REFERENCE_CONTAINER_PATTERN = /^([ \t]*)(source_refs|processed_sources)\s*:\s*(?:#.*)?$/;
const YAML_REFERENCE_PATH_PATTERN = /^([ \t]*)(-\s+)?path:\s*(["']?)([^"'\s#]+)\3\s*$/;

function portable(value) {
  return String(value).split(path.sep).join('/');
}

function workspacePath(root, value) {
  const text = String(value || '').trim().replaceAll('\\', '/');
  if (!text || path.isAbsolute(text) || text.split('/').includes('..')) return null;
  const absolute = path.resolve(root, ...text.split('/'));
  const relative = portable(path.relative(root, absolute));
  if (!relative || relative === '.' || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  return { relative, absolute };
}

function hashFile(filePath) {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let byteSize = 0;
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
        byteSize += bytesRead;
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return { value: hash.digest('hex'), byte_size: byteSize };
}

function walkFiles(root, roots) {
  const files = [];
  const queue = roots.map((entry) => path.resolve(root, ...entry.split('/')));
  const visited = new Set();
  while (queue.length) {
    const current = queue.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = portable(path.relative(root, absolute));
      if (relative === 'governance/sources' || relative.startsWith('governance/sources/')) continue;
      if (relative === 'governance/run-receipts/source-migration' || relative.startsWith('governance/run-receipts/source-migration/')) continue;
      if (entry.isDirectory()) queue.push(absolute);
      else if (entry.isFile() && !entry.name.startsWith('.')) files.push({ absolute, relative });
    }
  }
  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

function isLikelyText(filePath) {
  return /\.(md|markdown|json|yaml|yml|txt)$/i.test(filePath);
}

function extractDateHints(value) {
  const hints = new Set();
  for (const match of String(value || '').matchAll(/(?:^|[^0-9])(20\d{2}-\d{2}-\d{2})(?:[^0-9]|$)/g)) hints.add(match[1]);
  for (const match of String(value || '').matchAll(/(?:^|[^0-9])(20\d{2})(\d{2})(\d{2})T?/g)) hints.add(`${match[1]}-${match[2]}-${match[3]}`);
  return hints;
}

function extractPathReferences(text) {
  const references = [];
  const seen = new Set();
  for (const match of String(text).matchAll(PATH_PATTERN)) {
    const value = match[1].replace(/[),.;:]+$/, '');
    if (!value || value === 'governance/sources') continue;
    const key = `${value}:${match.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ path: value, kind: 'path-text', offset: match.index });
  }
  return references;
}

function collectSourceReferenceEntries(value, location, field, output) {
  const entries = Array.isArray(value) ? value : [value];
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    if (typeof entry.path !== 'string' || isSourceId(entry.source_id)) return;
    output.push({
      path: entry.path,
      kind: 'structured',
      location: `${location}.${field}${Array.isArray(value) ? `[${index}]` : ''}`,
      object: entry,
      field
    });
  });
}

function collectStructuredReferences(value, location = '$', output = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStructuredReferences(item, `${location}[${index}]`, output));
    return output;
  }
  if (!value || typeof value !== 'object') return output;

  for (const [key, child] of Object.entries(value)) {
    if (STRUCTURED_SOURCE_REFERENCE_FIELDS.has(key)) {
      collectSourceReferenceEntries(child, location, key, output);
      continue;
    }
    if (key === 'source_records' || key === 'records') continue;
    collectStructuredReferences(child, `${location}.${key}`, output);
  }
  return output;
}

function extractYamlStructuredReferences(text) {
  const references = [];
  const lines = String(text).split('\n');
  const containers = [];
  let offset = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const containerMatch = line.match(YAML_REFERENCE_CONTAINER_PATTERN);
    const pathMatch = line.match(YAML_REFERENCE_PATH_PATTERN);
    const trimmed = line.trim();
    const indentation = (line.match(/^[ \t]*/) || [''])[0].length;

    if (!trimmed || trimmed.startsWith('#')) {
      offset += line.length + 1;
      continue;
    }
    while (containers.length && indentation <= containers[containers.length - 1].indentation) {
      containers.pop();
    }
    if (containerMatch) {
      containers.push({ field: containerMatch[2], indentation });
      offset += line.length + 1;
      continue;
    }
    const container = containers[containers.length - 1];
    if (pathMatch && container && indentation > container.indentation) {
      references.push({
        artifact_offset: offset,
        line_index: lineIndex,
        path: pathMatch[4],
        kind: 'yaml-structured',
        field: container.field
      });
    }
    offset += line.length + 1;
  }
  return references;
}

function loadRecords(root) {
  const recordsDir = getSourceRegistryPaths(root).recordsDir;
  if (!fs.existsSync(recordsDir)) return [];
  return fs.readdirSync(recordsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(recordsDir, name), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter((record) => record && isSourceId(record.source_id));
}

function candidateForReference(root, legacyPath, records) {
  const pathInfo = workspacePath(root, legacyPath);
  if (!pathInfo) {
    return { classification: 'unresolved', candidates: [], evidence: ['invalid_workspace_path'] };
  }

  const direct = findSourceRecordsByPath(root, pathInfo.relative);
  if (direct.length === 1) {
    return {
      classification: 'resolved',
      candidates: [{ source_id: direct[0].source_id, path: direct[0].current_path || pathInfo.relative }],
      evidence: ['exact_path_or_path_history']
    };
  }
  if (direct.length > 1) {
    return {
      classification: 'ambiguous',
      candidates: direct.map((record) => ({ source_id: record.source_id, path: record.current_path || pathInfo.relative })),
      evidence: ['multiple_records_claim_path']
    };
  }

  const base = path.basename(pathInfo.relative);
  const dateHints = extractDateHints(pathInfo.relative);
  const candidates = [];
  for (const record of records) {
    const historicalPaths = [record.original_path, record.current_path, ...(record.path_history || []).map((item) => item.path)].filter(Boolean);
    if (historicalPaths.includes(pathInfo.relative)) {
      candidates.push({ source_id: record.source_id, path: record.current_path, evidence: 'recorded_path_history' });
      continue;
    }
    const namesMatch = historicalPaths.some((candidate) => path.basename(candidate) === base);
    if (!namesMatch) continue;
    const recordDate = record.original_date || String(record.captured_at || '').slice(0, 10);
    if (dateHints.size && dateHints.has(recordDate)) {
      candidates.push({ source_id: record.source_id, path: record.current_path, evidence: 'filename_and_date' });
      continue;
    }
    if (record.content_hash && record.current_path) {
      const resolved = resolveSource(root, record.source_id);
      const resolvedByMovedContent = resolved.status === 'resolved'
        && resolved.path
        && resolved.path !== pathInfo.relative
        && resolved.evidence.includes('exact_content_hash')
        && !resolved.evidence.includes('current_path');
      if (resolvedByMovedContent) {
        candidates.push({ source_id: record.source_id, path: resolved.path, evidence: 'registered_hash_and_resolver' });
      }
    }
  }

  const unique = [...new Map(candidates.map((candidate) => [candidate.source_id, candidate])).values()];
  if (unique.length === 1) {
    return {
      classification: 'resolved',
      candidates: unique.map(({ source_id, path: candidatePath }) => ({ source_id, path: candidatePath })),
      evidence: [unique[0].evidence]
    };
  }
  if (unique.length > 1) {
    return {
      classification: 'ambiguous',
      candidates: unique.map(({ source_id, path: candidatePath }) => ({ source_id, path: candidatePath })),
      evidence: unique.map((candidate) => candidate.evidence)
    };
  }
  return { classification: 'unresolved', candidates: [], evidence: ['no_hash_date_or_history_match'] };
}

function discoverReferences(root, options = {}) {
  const files = walkFiles(root, options.scanRoots || DEFAULT_SCAN_ROOTS);
  const references = [];
  for (const file of files) {
    if (!isLikelyText(file.absolute)) continue;
    let text;
    try {
      text = fs.readFileSync(file.absolute, 'utf8');
    } catch {
      continue;
    }
    let parsed = null;
    if (file.relative.endsWith('.json')) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    const structured = parsed !== null ? collectStructuredReferences(parsed, '$') : [];
    const yamlStructured = file.relative.endsWith('.yaml') || file.relative.endsWith('.yml')
      ? extractYamlStructuredReferences(text)
      : [];
    for (const reference of structured) references.push({ ...reference, artifact_path: file.relative });
    for (const reference of yamlStructured) references.push({ ...reference, artifact_path: file.relative });
    for (const reference of extractPathReferences(text)) {
      const isCovered = structured.some((item) => item.path === reference.path)
        || yamlStructured.some((item) => item.path === reference.path);
      if (!isCovered) references.push({ ...reference, artifact_path: file.relative });
    }
  }
  return references;
}

function contentDigest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function replaceJsonReferences(value, resolvedByPath, changes, location = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => replaceJsonReferences(item, resolvedByPath, changes, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (STRUCTURED_SOURCE_REFERENCE_FIELDS.has(key)) {
      const entries = Array.isArray(child) ? child : [child];
      entries.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
        if (typeof entry.path !== 'string' || entry.source_id || !resolvedByPath.has(entry.path)) return;
        entry.source_id = resolvedByPath.get(entry.path);
        changes.push({
          location: `${location}.${key}${Array.isArray(child) ? `[${index}]` : ''}`,
          path: entry.path,
          source_id: entry.source_id
        });
      });
      continue;
    }
    if (key === 'source_records' || key === 'records') continue;
    replaceJsonReferences(child, resolvedByPath, changes, `${location}.${key}`);
  }
}

function writeAtomic(filePath, content) {
  const temporary = `${filePath}.${process.pid}.migration.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, filePath);
}

function applyYamlReferenceChanges(before, resolvedByPath, changes) {
  const lines = before.split('\n');
  const references = extractYamlStructuredReferences(before)
    .filter((reference) => resolvedByPath.has(reference.path))
    .sort((left, right) => right.line_index - left.line_index);
  for (const reference of references) {
    const index = reference.line_index;
    const match = lines[index].match(YAML_REFERENCE_PATH_PATTERN);
    if (!match) continue;
    const sourceId = resolvedByPath.get(reference.path);
    const propertyIndent = (match[1] || '') + (match[2] ? ' '.repeat(match[2].length) : '');
    const previous = lines[index - 1] || '';
    const next = lines[index + 1] || '';
    const hasAdjacentSourceId = /^\s*(?:-\s+)?source_id:\s*\S+/.test(previous)
      || /^\s*(?:-\s+)?source_id:\s*\S+/.test(next);
    if (hasAdjacentSourceId) continue;
    lines.splice(index + 1, 0, propertyIndent + 'source_id: ' + sourceId);
    changes.push({ path: reference.path, source_id: sourceId });
  }
  return lines.join('\n');
}

function applyStructuredChanges(root, artifactPath, matches) {
  const absolute = path.resolve(root, ...artifactPath.split('/'));
  const before = fs.readFileSync(absolute, 'utf8');
  const resolvedByPath = new Map(matches.filter((item) => item.classification === 'resolved' && item.candidates.length === 1).map((item) => [item.legacy_path, item.candidates[0].source_id]));
  if (!resolvedByPath.size) return null;
  const changes = [];
  if (artifactPath.endsWith('.json')) {
    let parsed;
    try {
      parsed = JSON.parse(before);
    } catch {
      return null;
    }
    replaceJsonReferences(parsed, resolvedByPath, changes);
    if (!changes.length) return null;
    const after = `${JSON.stringify(parsed, null, 2)}\n`;
    writeAtomic(absolute, after);
    return { artifact_path: artifactPath, before_hash: contentDigest(before), after_hash: contentDigest(after), changes };
  }
  if (!artifactPath.endsWith('.yaml') && !artifactPath.endsWith('.yml')) return null;
  const after = applyYamlReferenceChanges(before, resolvedByPath, changes);
  if (!changes.length) return null;
  writeAtomic(absolute, after);
  return { artifact_path: artifactPath, before_hash: contentDigest(before), after_hash: contentDigest(after), changes };
}

export function classifySourceReferences(instanceRoot, options = {}) {
  const root = path.resolve(instanceRoot || process.cwd());
  const records = loadRecords(root);
  const conflictedSourceIds = new Set(
    findRegistryFindings(root, options)
      .filter((item) => item.type === 'content_conflict' && isSourceId(item.source_id))
      .map((item) => item.source_id)
  );
  return discoverReferences(root, options).map((reference) => {
    const match = candidateForReference(root, reference.path, records);
    const contentConflict = match.classification === 'resolved'
      && match.candidates.some((candidate) => conflictedSourceIds.has(candidate.source_id));
    const classification = contentConflict ? 'unresolved' : match.classification;
    return {
      artifact_path: reference.artifact_path,
      legacy_path: reference.path,
      kind: reference.kind,
      location: reference.location || null,
      classification,
      candidates: match.candidates,
      evidence: contentConflict ? [...match.evidence, 'content_conflict'] : match.evidence,
      action: classification === 'resolved'
        ? 'Add the source ID to this structured reference or review the proposed mapping.'
        : classification === 'ambiguous'
          ? 'Choose the correct source ID after human review.'
          : contentConflict
            ? 'Record an explicit correction or register a new source before migrating this reference.'
            : 'Register the source or preserve this reference as unresolved.'
    };
  });
}

export function migrateSourceReferences(instanceRoot, options = {}) {
  const root = path.resolve(instanceRoot || process.cwd());
  const references = classifySourceReferences(root, options);
  const findings = findRegistryFindings(root, options);
  const byArtifact = new Map();
  for (const item of references) {
    const list = byArtifact.get(item.artifact_path) || [];
    list.push(item);
    byArtifact.set(item.artifact_path, list);
  }
  const changed = [];
  if (options.apply) {
    for (const [artifactPath, matches] of byArtifact) {
      if (artifactPath === '6-raw' || artifactPath.startsWith('6-raw/')) continue;
      if (!matches.some((item) => item.kind === 'structured' || item.kind === 'yaml-structured')) continue;
      const result = applyStructuredChanges(root, artifactPath, matches);
      if (result) changed.push(result);
    }
  }
  const report = {
    schema_version: 1,
    mode: options.apply ? 'apply' : 'dry-run',
    generated_at: new Date().toISOString(),
    counts: {
      total: references.length,
      resolved: references.filter((item) => item.classification === 'resolved').length,
      ambiguous: references.filter((item) => item.classification === 'ambiguous').length,
      unresolved: references.filter((item) => item.classification === 'unresolved').length,
      changed: changed.length
    },
    findings,
    references,
    changed
  };
  if (options.reportPath) {
    const reportPath = path.isAbsolute(options.reportPath) ? options.reportPath : path.resolve(root, options.reportPath);
    if (!path.resolve(reportPath).startsWith(root + path.sep)) throw new Error('Migration report must stay inside the workspace.');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    report.report_path = portable(path.relative(root, reportPath));
  }
  return report;
}

export const migrateSources = migrateSourceReferences;
export const classifyLegacySourceReferences = classifySourceReferences;
