import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { retrieveLifecycleRecord, readLifecycleRecord } from './review-lifecycle.mjs';
import { isSourceId } from './source-registry.mjs';

const directory = '4-context/learnings';
const digest = value => createHash('sha256').update(value).digest('hex');
const identity = sourceId => `learning_${digest(sourceId)}`;

// Projection files are instance-owned. Never follow links or accept arbitrary output paths.
function safe(root, relative) {
  let current = fs.realpathSync(root);
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Unsafe learning symlink: ${relative}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}

function project(root, recordId) {
  const { record, content, content_encoding } = retrieveLifecycleRecord(root, recordId);
  if (content_encoding !== 'utf8' || Buffer.byteLength(content ?? '') !== record.byte_size || digest(content ?? '') !== record.content_hash.value) throw new Error('Learning report must be UTF-8 text');
  const blocks = [...content.matchAll(/^```mole-learning\r?\n([\s\S]*?)^```\s*$/gm)];
  if (blocks.length !== 1) throw new Error('Report needs exactly one mole-learning JSON block before human review');
  const links = JSON.parse(blocks[0][1]);
  const keys = ['schema_version', 'change_id', 'release_id', 'intent_refs', 'evidence_refs'];
  if (!links || Array.isArray(links) || Object.keys(links).length !== keys.length || keys.some(k => !Object.hasOwn(links, k))) throw new Error('Invalid learning link fields');
  if (links.schema_version !== 1) throw new Error('Unsupported learning schema version');
  for (const key of ['change_id', 'release_id']) {
    if (links[key] !== null && (typeof links[key] !== 'string' || !links[key].trim())) throw new Error(`Invalid ${key}`);
  }
  for (const key of ['intent_refs', 'evidence_refs']) {
    if (!Array.isArray(links[key]) || links[key].some(id => !isSourceId(id) || !record.source_ids.includes(id)) || new Set(links[key]).size !== links[key].length) throw new Error(`${key} must cite unique lifecycle supporting source IDs`);
  }
  // Mask fenced code without changing offsets, so copied lessons retain every byte.
  const prose = content.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm,
    block => block.replace(/[^\r\n]/g, ' '));
  const headings = [...prose.matchAll(/^#{1,2} [^\r\n]*$/gm)];
  const lessons = headings.filter(h => h[0].trimEnd() === '## What we learned');
  if (lessons.length !== 1) throw new Error('Report needs one nonempty What we learned section');
  const heading = lessons[0];
  const nextHeading = headings[headings.indexOf(heading) + 1];
  const lesson = content.slice(heading.index + heading[0].length, nextHeading?.index ?? content.length).replace(/^\r?\n/, '');
  if (!lesson.trim()) throw new Error('Report needs one nonempty What we learned section');
  const approval = record.history.findLast ? record.history.findLast(h => h.action === 'approve') : [...record.history].reverse().find(h => h.action === 'approve');
  if (!approval || approval.actor_type !== 'human' || !approval.human_confirmed) throw new Error('No human approval in report history');
  const supersedes = record.supersedes.map(id => {
    const prior = readLifecycleRecord(root, id);
    if (!prior) throw new Error('Missing superseded report');
    return identity(prior.source_id);
  });
  return {
    schema_version: 1, kind: 'accepted-report-projection', learning_id: identity(record.source_id),
    ...links, lesson, report: content,
    provenance: { record_id: record.record_id, source_id: record.source_id,
      source_ids: record.source_ids, projection_revision: [...record.history].reverse().find(h => ['approve', 'replace'].includes(h.action)).revision,
      replacements: record.history.filter(h => h.action === 'replace'), content_hash: record.content_hash, byte_size: record.byte_size,
      approval: { revision: approval.revision, actor: approval.actor, actor_type: approval.actor_type, at: approval.at, reason: approval.reason },
      supersedes }
  };
}

/** Copy only approved bytes and metadata. This never creates or approves a lifecycle artifact. */
export function promoteLearning(root, { recordId } = {}) {
  const projection = project(root, recordId);
  const relative = `${directory}/${projection.learning_id}/${projection.provenance.projection_revision}.json`;
  const target = safe(root, relative);
  const bytes = `${JSON.stringify(projection, null, 2)}\n`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let changed = true;
  const temporary = safe(root, `${directory}/${projection.learning_id}/.pending-${randomUUID()}`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx');
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // Publish complete bytes exclusively. A stopped writer never exposes a partial snapshot.
    try { fs.linkSync(temporary, target); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (fs.readFileSync(target, 'utf8') !== bytes) throw new Error('Learning snapshot conflict; existing bytes preserved');
      changed = false;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
  return { ok: true, changed, path: relative, learning: projection };
}

/** Scan the controlled pointers and validate against the live approval on every read. */
export function retrieveLearnings(root, { learningId, query, changeId, releaseId, includeHistory = false } = {}) {
  const base = safe(root, directory);
  const learnings = [], excluded = [], history = [];
  if (!fs.existsSync(base)) return { ok: true, learnings, excluded, history };
  for (const name of fs.readdirSync(base).sort()) {
    if (!/^learning_[a-f0-9]{64}$/.test(name)) throw new Error(`Unexpected learning directory: ${name}`);
    if (learningId && name !== learningId) continue;
    const folder = safe(root, `${directory}/${name}`);
    for (const revision of fs.readdirSync(folder).sort()) {
      if (/^\.pending-[0-9a-f-]{36}$/.test(revision)) continue;
      if (!/^[1-9][0-9]*\.json$/.test(revision)) throw new Error(`Unexpected learning revision: ${revision}`);
      const relative = `${directory}/${name}/${revision}`;
      const stored = JSON.parse(fs.readFileSync(safe(root, relative), 'utf8'));
      let current, reason;
      try {
        current = project(root, stored.provenance.record_id);
        if (current.learning_id !== name || `${current.provenance.projection_revision}.json` !== revision || JSON.stringify(current) !== JSON.stringify(stored)) reason = 'projection_changed_or_old_revision';
      } catch (error) { reason = error.code || error.message; }
      if (reason) {
        excluded.push({ path: relative, reason });
        // Historical bytes carry no current acceptance claim, even if edited on disk.
        if (includeHistory) history.push({ current: false, verified: false, path: relative, reason, snapshot: stored });
        continue;
      }
      if (changeId && current.change_id !== changeId || releaseId && current.release_id !== releaseId) continue;
      if (query && !`${current.lesson}\n${current.report}`.toLowerCase().includes(query.toLowerCase())) continue;
      const source = retrieveLifecycleRecord(root, current.provenance.record_id);
      learnings.push({ current: true, path: relative, report_path: source.path, learning: current });
    }
  }
  return { ok: true, learnings, excluded, history };
}
