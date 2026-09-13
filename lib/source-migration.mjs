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

function skipJsonWhitespace(text, start) {
  let index = start;
  while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1;
  return index;
}

function parseJsonStringToken(text, start) {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += text[index + 1] === 'u' ? 6 : 2;
      continue;
    }
    if (text[index] === '"') {
      const end = index + 1;
      return { start, end, value: JSON.parse(text.slice(start, end)) };
    }
    index += 1;
  }
  throw new SyntaxError('Unterminated JSON string.');
}

function parseJsonLexicalTree(text) {
  let parseValue;

  const parseObject = (start) => {
    const properties = [];
    let index = skipJsonWhitespace(text, start + 1);
    if (text[index] === '}') return { type: 'object', start, end: index + 1, properties };
    while (index < text.length) {
      const key = parseJsonStringToken(text, index);
      index = skipJsonWhitespace(text, key.end);
      if (text[index] !== ':') throw new SyntaxError('Expected a JSON object colon.');
      index = skipJsonWhitespace(text, index + 1);
      const value = parseValue(index);
      properties.push({ key: key.value, keyStart: key.start, keyEnd: key.end, value });
      index = skipJsonWhitespace(text, value.end);
      if (text[index] === '}') return { type: 'object', start, end: index + 1, properties };
      if (text[index] !== ',') throw new SyntaxError('Expected a JSON object comma.');
      index = skipJsonWhitespace(text, index + 1);
    }
    throw new SyntaxError('Unterminated JSON object.');
  };

  const parseArray = (start) => {
    const elements = [];
    let index = skipJsonWhitespace(text, start + 1);
    if (text[index] === ']') return { type: 'array', start, end: index + 1, elements };
    while (index < text.length) {
      const value = parseValue(index);
      elements.push(value);
      index = skipJsonWhitespace(text, value.end);
      if (text[index] === ']') return { type: 'array', start, end: index + 1, elements };
      if (text[index] !== ',') throw new SyntaxError('Expected a JSON array comma.');
      index = skipJsonWhitespace(text, index + 1);
    }
    throw new SyntaxError('Unterminated JSON array.');
  };

  parseValue = (start) => {
    if (text[start] === '{') return parseObject(start);
    if (text[start] === '[') return parseArray(start);
    if (text[start] === '"') {
      const token = parseJsonStringToken(text, start);
      return { type: 'string', start: token.start, end: token.end, value: token.value };
    }
    let end = start;
    while (end < text.length && !/[\t\n\r ,\]}]/.test(text[end])) end += 1;
    if (end === start) throw new SyntaxError('Expected a JSON value.');
    return { type: 'primitive', start, end };
  };

  const root = parseValue(skipJsonWhitespace(text, 0));
  if (skipJsonWhitespace(text, root.end) !== text.length) throw new SyntaxError('Unexpected JSON content.');
  return root;
}

function collectJsonReferenceTargets(node, resolvedByPath, targets, location = '$') {
  if (!node || node.type !== 'object') {
    if (node?.type === 'array') {
      node.elements.forEach((item, index) => collectJsonReferenceTargets(item, resolvedByPath, targets, `${location}[${index}]`));
    }
    return;
  }
  for (const property of node.properties) {
    if (STRUCTURED_SOURCE_REFERENCE_FIELDS.has(property.key)) {
      const entries = property.value.type === 'array' ? property.value.elements : [property.value];
      entries.forEach((entry, index) => {
        if (!entry || entry.type !== 'object') return;
        const pathProperty = entry.properties.find((item) => item.key === 'path');
        const sourceIdProperty = entry.properties.find((item) => item.key === 'source_id');
        if (!pathProperty || pathProperty.value.type !== 'string' || sourceIdProperty) return;
        const sourceId = resolvedByPath.get(pathProperty.value.value);
        if (!sourceId) return;
        targets.push({
          object: entry,
          location: `${location}.${property.key}${property.value.type === 'array' ? `[${index}]` : ''}`,
          path: pathProperty.value.value,
          source_id: sourceId
        });
      });
      continue;
    }
    if (property.key === 'source_records' || property.key === 'records') continue;
    collectJsonReferenceTargets(property.value, resolvedByPath, targets, `${location}.${property.key}`);
  }
}

function lineIndentation(text, offset) {
  const lineStart = Math.max(text.lastIndexOf('\n', offset - 1), text.lastIndexOf('\r', offset - 1)) + 1;
  const prefix = text.slice(lineStart, offset);
  return /^[ \t]*$/.test(prefix) ? prefix : null;
}

function jsonSourceIdInsertion(text, target) {
  const lastProperty = target.object.properties[target.object.properties.length - 1];
  const offset = lastProperty.value.end;
  const closeOffset = target.object.end - 1;
  const suffix = text.slice(offset, closeOffset);
  const lineBreak = suffix.match(/\r\n|\n|\r/);
  if (lineBreak) {
    const keyIndentation = lineIndentation(text, lastProperty.keyStart);
    const closingIndentation = lineIndentation(text, closeOffset) || '';
    const propertyIndentation = keyIndentation === null ? `${closingIndentation}  ` : keyIndentation;
    return {
      offset,
      text: `,${lineBreak[0]}${propertyIndentation}"source_id": ${JSON.stringify(target.source_id)}`
    };
  }

  const propertySpacing = text.slice(lastProperty.keyEnd, lastProperty.value.start);
  const usesSpace = /[ \t]/.test(suffix) || /[ \t]/.test(propertySpacing)
    || /,[ \t]+/.test(text.slice(target.object.start, target.object.end));
  const colonSpacing = /[ \t]/.test(propertySpacing) ? ' ' : '';
  return {
    offset,
    text: `${usesSpace ? ', ' : ','}"source_id":${colonSpacing}${JSON.stringify(target.source_id)}`
  };
}

let migrationTempSequence = 0;

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function removeFileIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function stageMigrationWrite(filePath, content) {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${migrationTempSequence++}.migration.tmp`
  );
  try {
    fs.writeFileSync(temporary, content, 'utf8');
  } catch (error) {
    try {
      removeFileIfExists(temporary);
    } catch {
      // Preserve the original failure; a leftover temporary is recoverable.
    }
    throw error;
  }
  return {
    filePath,
    temporary,
    backup: `${temporary}.backup`,
    originalMoved: false,
    installed: false
  };
}

function cleanupMigrationStages(stagedWrites, { preserveBackups = false } = {}) {
  for (const write of stagedWrites) {
    try {
      removeFileIfExists(write.temporary);
    } catch {
      // Preserve the original failure; a leftover temporary is recoverable.
    }
    if (preserveBackups) continue;
    try {
      removeFileIfExists(write.backup);
    } catch {
      // Preserve the original failure; a leftover backup is recoverable.
    }
  }
}

function commitMigrationWrites(stagedWrites) {
  try {
    for (const write of stagedWrites) {
      if (pathExists(write.filePath)) {
        fs.renameSync(write.filePath, write.backup);
        write.originalMoved = true;
      }
      fs.renameSync(write.temporary, write.filePath);
      write.installed = true;
    }
  } catch (error) {
    let rollbackError = null;
    for (const write of [...stagedWrites].reverse()) {
      try {
        if (write.installed) removeFileIfExists(write.filePath);
        if (write.originalMoved) fs.renameSync(write.backup, write.filePath);
      } catch (restoreError) {
        rollbackError ||= restoreError;
      }
    }
    cleanupMigrationStages(stagedWrites, { preserveBackups: Boolean(rollbackError) });
    if (rollbackError) {
      const combined = new Error(
        `Migration commit failed and rollback failed: ${rollbackError.message}`,
        { cause: error }
      );
      combined.rollbackError = rollbackError;
      throw combined;
    }
    throw error;
  }

  cleanupMigrationStages(stagedWrites);
}

function yamlMappingRange(lines, index) {
  const line = lines[index] || '';
  const listItem = line.match(/^([ \t]*)-\s+/);
  if (listItem) {
    const itemIndentation = listItem[1].length;
    let end = lines.length - 1;
    for (let lineIndex = index + 1; lineIndex < lines.length; lineIndex += 1) {
      const candidate = lines[lineIndex];
      const trimmed = candidate.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const candidateListItem = candidate.match(/^([ \t]*)-\s+/);
      const indentation = (candidate.match(/^[ \t]*/) || [''])[0].length;
      if (indentation <= itemIndentation || (candidateListItem && candidateListItem[1].length <= itemIndentation)) {
        end = lineIndex - 1;
        break;
      }
    }
    return { start: index, end };
  }

  const propertyIndentation = (line.match(/^[ \t]*/) || [''])[0].length;
  let start = index;
  for (let lineIndex = index - 1; lineIndex >= 0; lineIndex -= 1) {
    const candidate = lines[lineIndex];
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indentation = (candidate.match(/^[ \t]*/) || [''])[0].length;
    const candidateListItem = candidate.match(/^([ \t]*)-\s+/);
    if (candidateListItem && candidateListItem[1].length < propertyIndentation) {
      start = lineIndex;
      break;
    }
    if (indentation < propertyIndentation) break;
    start = lineIndex;
  }

  let end = lines.length - 1;
  for (let lineIndex = index + 1; lineIndex < lines.length; lineIndex += 1) {
    const candidate = lines[lineIndex];
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indentation = (candidate.match(/^[ \t]*/) || [''])[0].length;
    if (indentation < propertyIndentation) {
      end = lineIndex - 1;
      break;
    }
  }
  return { start, end };
}

function yamlPropertyIndentation(line) {
  const listItem = line.match(/^([ \t]*)-\s+/);
  return listItem ? listItem[0].length : (line.match(/^[ \t]*/) || [''])[0].length;
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
    const { start, end } = yamlMappingRange(lines, index);
    const hasSourceId = lines.slice(start, end + 1)
      .some((candidate) => yamlPropertyIndentation(candidate) === propertyIndent.length
        && /^\s*(?:-\s+)?source_id:\s*\S+/.test(candidate));
    if (hasSourceId) continue;
    lines.splice(index + 1, 0, propertyIndent + 'source_id: ' + sourceId);
    changes.push({ path: reference.path, source_id: sourceId });
  }
  return lines.join('\n');
}

function stageStructuredChanges(root, artifactPath, matches) {
  const absolute = path.resolve(root, ...artifactPath.split('/'));
  const before = fs.readFileSync(absolute, 'utf8');
  const resolvedByPath = new Map(matches.filter((item) => item.classification === 'resolved' && item.candidates.length === 1).map((item) => [item.legacy_path, item.candidates[0].source_id]));
  if (!resolvedByPath.size) return null;
  const changes = [];
  if (artifactPath.endsWith('.json')) {
    let tree;
    try {
      JSON.parse(before);
      tree = parseJsonLexicalTree(before);
    } catch {
      return null;
    }
    const targets = [];
    collectJsonReferenceTargets(tree, resolvedByPath, targets);
    if (!targets.length) return null;
    const insertions = targets.map((target) => {
      const insertion = jsonSourceIdInsertion(before, target);
      changes.push({
        location: target.location,
        path: target.path,
        source_id: target.source_id
      });
      return insertion;
    }).sort((left, right) => right.offset - left.offset);
    let after = before;
    for (const insertion of insertions) {
      after = `${after.slice(0, insertion.offset)}${insertion.text}${after.slice(insertion.offset)}`;
    }
    return {
      artifact_path: artifactPath,
      absolute_path: absolute,
      before_content: before,
      after_content: after,
      before_hash: contentDigest(before),
      after_hash: contentDigest(after),
      changes
    };
  }
  if (!artifactPath.endsWith('.yaml') && !artifactPath.endsWith('.yml')) return null;
  const after = applyYamlReferenceChanges(before, resolvedByPath, changes);
  if (!changes.length) return null;
  return {
    artifact_path: artifactPath,
    absolute_path: absolute,
    before_content: before,
    after_content: after,
    before_hash: contentDigest(before),
    after_hash: contentDigest(after),
    changes
  };
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
    const isStructuredReference = reference.kind === 'structured' || reference.kind === 'yaml-structured';
    return {
      artifact_path: reference.artifact_path,
      legacy_path: reference.path,
      kind: reference.kind,
      location: reference.location || null,
      classification,
      candidates: match.candidates,
      evidence: contentConflict ? [...match.evidence, 'content_conflict'] : match.evidence,
      action: !isStructuredReference
        ? 'Report only; do not update this unstructured path reference automatically.'
        : classification === 'resolved'
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
  const preparedChanges = [];
  let reportPath = null;
  if (options.reportPath) {
    reportPath = path.isAbsolute(options.reportPath) ? options.reportPath : path.resolve(root, options.reportPath);
    reportPath = path.resolve(reportPath);
    if (!reportPath.startsWith(root + path.sep)) throw new Error('Migration report must stay inside the workspace.');
    if (pathExists(reportPath) && fs.statSync(reportPath).isDirectory()) {
      throw new Error('Migration report path must be a file.');
    }
    const reportDirectory = path.dirname(reportPath);
    if (pathExists(reportDirectory) && !fs.statSync(reportDirectory).isDirectory()) {
      throw new Error('Migration report directory must be a directory.');
    }
    fs.mkdirSync(reportDirectory, { recursive: true });
  }
  if (options.apply) {
    for (const [artifactPath, matches] of byArtifact) {
      if (artifactPath === '6-raw' || artifactPath.startsWith('6-raw/')) continue;
      if (!matches.some((item) => item.kind === 'structured' || item.kind === 'yaml-structured')) continue;
      const result = stageStructuredChanges(root, artifactPath, matches);
      if (result) preparedChanges.push(result);
    }
  }
  if (reportPath && preparedChanges.some((item) => item.absolute_path === reportPath)) {
    throw new Error('Migration report path cannot overwrite a migrated artifact.');
  }
  const changed = preparedChanges.map((item) => ({
    artifact_path: item.artifact_path,
    before_hash: item.before_hash,
    after_hash: item.after_hash,
    changes: item.changes
  }));
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
  const reportContent = reportPath ? `${JSON.stringify(report, null, 2)}\n` : null;
  if (reportPath) report.report_path = portable(path.relative(root, reportPath));

  const stagedWrites = [];
  let commitStarted = false;
  try {
    for (const item of preparedChanges) stagedWrites.push(stageMigrationWrite(item.absolute_path, item.after_content));
    if (reportPath) stagedWrites.push(stageMigrationWrite(reportPath, reportContent));
    commitStarted = true;
    commitMigrationWrites(stagedWrites);
  } catch (error) {
    if (!commitStarted) cleanupMigrationStages(stagedWrites);
    throw error;
  }
  return report;
}

export const migrateSources = migrateSourceReferences;
export const classifyLegacySourceReferences = classifySourceReferences;
