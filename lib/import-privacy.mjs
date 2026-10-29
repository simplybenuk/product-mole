// Shared, bounded transaction for the two explicit local import adapters.
// No discovery, migration, redaction or human review is performed here.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { privacyInventory, loadPrivacyPolicy, isEligiblePrivacyPath } from './privacy.mjs';
import { scanSensitiveText, assertSafeMetadata } from './privacy-policy.mjs';
import { readUniqueSourceMetadata, findSourceRecordsByPath, registerSource } from './source-registry.mjs';
import { assertLifecycleWritable, listLifecycleRecords, registerLifecycleRecord } from './review-lifecycle.mjs';

const MAX_BYTES = 4 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const idPattern = /^src_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const media = { markdown: 'text/markdown', json: 'application/json', csv: 'text/csv' };
const refusal = () => new Error('Import privacy eligibility or recovery required; use the explicit quarantine/review route.');
const conflict = () => new Error('Import identity has different raw bytes or different normalized data or different import request; use a new revision identity.');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

export function safeImportPath(root, relative) {
  if (path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')) throw refusal();
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Unsafe symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}
function tree(root, relative) {
  const target = safeImportPath(root, relative);
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    for (const name of fs.readdirSync(target)) tree(root, `${relative}/${name}`);
  }
}
// Publish only complete verified bytes, never replace a concurrent destination.
export function publishImportFile(root, relative, bytes) {
  const target = safeImportPath(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(path.dirname(target), '.mole-import-'));
  fs.chmodSync(stage, 0o700);
  const temporary = path.join(stage, 'payload');
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    if (!fs.readFileSync(temporary).equals(bytes)) throw new Error('Incomplete staged import write');
    const fd = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.linkSync(temporary, target);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
function clean(value) {
  if (typeof value === 'string') {
    if (scanSensitiveText(value).outcome !== 'no_rule_match') throw refusal();
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { if (!Array.isArray(value)) clean(key); clean(item); }
  }
}
export function preflightImport(bytes, format, decodeValues) {
  try {
    if (bytes.length > MAX_BYTES) throw refusal();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    clean(text);
    clean(decodeValues(text, format));
    return text;
  } catch { throw refusal(); }
}
function readBoundedFile(file) {
  const entry = fs.lstatSync(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_BYTES) throw refusal();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw refusal();
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0, count;
    do { count = fs.readSync(fd, buffer, size, buffer.length - size, null); size += count; } while (count && size < buffer.length);
    const after = fs.fstatSync(fd);
    if (size !== stat.size || ['size','mtimeMs','ctimeMs'].some(key => stat[key] !== after[key])) throw refusal();
    return buffer.subarray(0, size);
  } finally { fs.closeSync(fd); }
}
function boundedRead(root, relative) {
  return readBoundedFile(safeImportPath(root, relative));
}
function sourceMetadata(root, sourceId, allowMissing = false) {
  try { return readUniqueSourceMetadata(root, sourceId, { allowMissing }); }
  catch { throw refusal(); }
}
function metadata(root, sourceId, receipt, allowIncomplete = false) {
  loadPrivacyPolicy(root);
  const record = privacyInventory(root).find(r => r.source_id === sourceId);
  if (!record || record.retention_state !== 'active' || record.outcome === 'quarantined' || Date.parse(record.expires_at) <= Date.now()) throw refusal();
  if (receipt && (record.captured_at !== receipt.captured_at || record.expires_at !== receipt.expires_at)) throw refusal();
  const source = sourceMetadata(root, sourceId, true);
  if (!source && listLifecycleRecords(root).some(r => r.source_id === sourceId)) throw refusal();
  if (source) {
    if (record.current_path !== source.current_path || !isEligiblePrivacyPath(sourceId, record.current_path)) throw refusal();
    const claims = findSourceRecordsByPath(root, record.current_path);
    if (claims.length !== 1 || claims[0].source_id !== sourceId) throw refusal();
  } else if (!allowIncomplete || !receipt || ![`6-raw/staging/${sourceId}.bin`, `6-raw/inbox/${sourceId}.md`].includes(record.current_path)) throw refusal();
  return { record, source };
}
export function readEligibleImportSource(root, { sourceId, format, decodeValues, receipt, allowIncomplete = false }) {
  try {
    const { record, source } = metadata(root, sourceId, receipt, allowIncomplete);
    // Only the exact metadata-authorized location, never history or a resolver.
    let relative = record.current_path;
    // A stopped first publication can have linked canonical bytes before updating intent.
    const stage = safeImportPath(root, `6-raw/staging/${sourceId}.bin`);
    const canonical = safeImportPath(root, `6-raw/inbox/${sourceId}.md`);
    if (fs.existsSync(stage) && fs.existsSync(canonical)) {
      const a = fs.lstatSync(stage), b = fs.lstatSync(canonical);
      if (!a.isFile() || !b.isFile() || a.dev !== b.dev || a.ino !== b.ino) throw refusal();
    }
    if (!source && relative === `6-raw/staging/${sourceId}.bin` && fs.existsSync(canonical)) relative = `6-raw/inbox/${sourceId}.md`;
    const bytes = boundedRead(root, relative);
    preflightImport(bytes, format, decodeValues);
    if (source && (source.content_hash?.value !== digest(bytes) || source.byte_size !== bytes.length)) throw refusal();
    return { sourceId, path: relative, bytes, stat: fs.statSync(safeImportPath(root, relative)), capturedAt: record.captured_at, expiresAt: record.expires_at, sourceRecord: source };
  } catch { throw refusal(); }
}
function savePrivacy(root, record) {
  const file = safeImportPath(root, `governance/privacy/${record.source_id}.json`);
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, jsonBytes(record), { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function captureEligibleImport(root, { bytes, format, decodeValues, receipt }) {
  preflightImport(bytes, format, decodeValues);
  loadPrivacyPolicy(root);
  const sourceId = receipt.input_source_id;
  let record = privacyInventory(root).find(r => r.source_id === sourceId);
  if (record) throw refusal(); // Existing intents can resume only from their own stored bytes.
  if (Date.parse(receipt.expires_at) <= Date.now()) throw refusal();
  const staging = `6-raw/staging/${sourceId}.bin`;
  const canonical = `6-raw/inbox/${sourceId}.md`;
  // No input content is written before the immutable request and privacy intent.
  record = { schema_version: 1, source_id: sourceId, captured_at: receipt.captured_at, expires_at: receipt.expires_at,
    outcome: 'no_rule_match', categories: {}, review_state: 'pending', retention_state: 'active', current_path: staging };
  publishImportFile(root, `governance/privacy/${sourceId}.json`, jsonBytes(record));
  const stage = safeImportPath(root, staging);
  fs.mkdirSync(path.dirname(stage), { recursive: true, mode: 0o700 });
  fs.writeFileSync(stage, bytes, { flag: 'wx', mode: 0o600 });
  if (!fs.readFileSync(stage).equals(bytes)) throw new Error('Incomplete staged import write');
  const fd = fs.openSync(stage, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  metadata(root, sourceId, receipt, true);
  const target = safeImportPath(root, canonical);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.linkSync(stage, target);
  record.current_path = canonical;
  savePrivacy(root, record);
  fs.unlinkSync(stage);
  return readEligibleImportSource(root, { sourceId, format, decodeValues, receipt, allowIncomplete: true });
}
function finishCapture(root, descriptor, receipt, format, decodeValues) {
  metadata(root, receipt.input_source_id, receipt, true);
  const live = fs.lstatSync(safeImportPath(root, descriptor.path));
  if (['dev','ino','size','mtimeMs','ctimeMs'].some(key => live[key] !== descriptor.stat[key])) throw refusal();
  const canonical = `6-raw/inbox/${receipt.input_source_id}.md`;
  if (!descriptor.sourceRecord && descriptor.path !== canonical) {
    const target = safeImportPath(root, canonical);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    // Preserve a race winner; a retry validates it instead of replacing it.
    fs.linkSync(safeImportPath(root, descriptor.path), target);
  }
  if (!descriptor.sourceRecord) {
    const { record } = metadata(root, receipt.input_source_id, receipt, true);
    if (record.current_path !== canonical) { record.current_path = canonical; savePrivacy(root, record); }
    const staged = safeImportPath(root, `6-raw/staging/${receipt.input_source_id}.bin`);
    if (fs.existsSync(staged)) fs.unlinkSync(staged);
    registerSource(root, { source_id: receipt.input_source_id, path: canonical, source_type: 'export', media_type: media[format],
      captured_at: receipt.captured_at, captured_by: 'mole-import', retention: { expires_at: receipt.expires_at } });
  }
  return readEligibleImportSource(root, { sourceId: receipt.input_source_id, format, decodeValues, receipt });
}
function registerLifecycle(root, sourceId, state, sourceIds) {
  const existing = listLifecycleRecords(root).filter(r => r.source_id === sourceId);
  if (!existing.length) registerLifecycleRecord(root, { sourceId, state, sourceIds, newFile: true, actor: 'mole-import', actorType: 'automation' });
}
function readReceipt(root, relative, kind) {
  const file = safeImportPath(root, relative);
  if (!fs.existsSync(file)) return null;
  let r;
  try { r = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw refusal(); }
  if (!r || typeof r !== 'object') throw refusal();
  const keys = ['schema_version','kind','input_source_id','output_source_id','output_path','format','request_reference','captured_at','expires_at','processed_at'];
  if (Object.keys(r).length !== keys.length || keys.some(k => !Object.hasOwn(r,k)) || r.schema_version !== 1 || r.kind !== kind || !idPattern.test(r.input_source_id) || !idPattern.test(r.output_source_id) || !media[r.format]
    || !new RegExp(`^5-evidence/${kind === 'release' ? 'releases' : 'analytics'}/[a-f0-9]{64}\\.json$`).test(r.output_path)
    || Object.keys(r.request_reference ?? {}).length !== 2 || r.request_reference?.kind !== `mole-${kind}-import-v1` || !/^[a-f0-9]{64}$/.test(r.request_reference?.value)
    || ![r.captured_at,r.expires_at,r.processed_at].every(v => typeof v === 'string' && Number.isFinite(Date.parse(v))) || Date.parse(r.expires_at) <= Date.parse(r.captured_at)) throw refusal();
  return r;
}
function selectFile(root, file) {
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  const inside = relative !== '..' && !relative.startsWith('../');
  const records = privacyInventory(root);
  if (inside) {
    const claims = findSourceRecordsByPath(root, relative);
    if (claims.length) {
      if (claims.length !== 1 || claims[0].current_path !== relative) throw refusal();
      return { sourceId: claims[0].source_id, path: relative };
    }
    if (relative.startsWith('6-raw/') || records.some(r => r.current_path === relative)) throw refusal();
  }
  // Reject symlinks throughout an external or unregistered input's path too.
  const anchor = path.parse(absolute).root;
  safeImportPath(anchor, absolute.slice(anchor.length).split(path.sep).join('/'));
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw refusal();
  return { external: absolute };
}

export function importWithPrivacy(root, options, { kind, formats, defaultFormat, decodeValues, parse, fingerprint, outputKey, validateOptions = () => {} }) {
  root = fs.realpathSync(root);
  const { file, sourceId, identity } = options;
  try { assertSafeMetadata(options); } catch { throw refusal(); }
  if (Boolean(file) === Boolean(sourceId)) throw new Error('Supply exactly one local file or registered sourceId');
  if (!identity || typeof identity.namespace !== 'string' || !identity.namespace.trim() || typeof identity.key !== 'string' || !identity.key.trim()) throw new Error('Explicit namespace and key required');
  validateOptions();
  for (const dir of ['governance/sources','governance/lifecycle','governance/imports','governance/privacy','6-raw','5-evidence']) tree(root, dir);
  loadPrivacyPolicy(root);
  assertLifecycleWritable(root);
  const receiptPath = `governance/imports/${kind}/${digest(JSON.stringify([identity.namespace, identity.key]))}.json`;
  let receipt = readReceipt(root, receiptPath, kind);
  if (receipt) metadata(root, receipt.input_source_id, receipt, true);
  const metadataSource = sourceId ? sourceMetadata(root, sourceId) : null;
  const format = options.format ?? (sourceId ? receipt?.format ?? Object.keys(media).find(k => media[k] === metadataSource.media_type) : path.extname(file).toLowerCase() === '.json' ? 'json' : defaultFormat);
  if (!formats.includes(format)) throw refusal();
  let descriptor, text;
  // For existing requests, the original privacy identity gates even an external replay.
  if (receipt) {
    if (sourceId && sourceId !== receipt.input_source_id || receipt.format !== format) throw conflict();
    descriptor = readEligibleImportSource(root, { sourceId: receipt.input_source_id, format, decodeValues, receipt, allowIncomplete: true });
  }
  const selected = sourceId ? { sourceId } : selectFile(root, file);
  if (selected.sourceId && descriptor && selected.sourceId !== descriptor.sourceId) throw conflict();
  if (selected.sourceId) descriptor ??= readEligibleImportSource(root, { sourceId: selected.sourceId, format, decodeValues });
  const bytes = selected.external ? readBoundedFile(selected.external) : descriptor.bytes;
  text = preflightImport(bytes, format, decodeValues);
  if (descriptor && !descriptor.bytes.equals(bytes)) throw conflict();
  let initial;
  try { initial = parse(text, format, { type: kind, ref: descriptor?.path ?? 'explicit-input' }); clean(initial); }
  catch { throw refusal(); }
  const reference = fingerprint(format, bytes);
  if (receipt && JSON.stringify(receipt.request_reference) !== JSON.stringify(reference)) throw conflict();
  const expectedPath = `5-evidence/${kind === 'release' ? 'releases' : 'analytics'}/${digest(outputKey(initial))}.json`;
  if (receipt && receipt.output_path !== expectedPath) throw conflict();
  const outputClaims = findSourceRecordsByPath(root, expectedPath);
  let eventPath = expectedPath, outputSource;
  if (receipt && fs.existsSync(safeImportPath(root, `governance/sources/records/${receipt.output_source_id}.json`))) {
    outputSource = sourceMetadata(root, receipt.output_source_id);
    eventPath = outputSource.current_path;
    if (!eventPath?.startsWith('5-evidence/')) throw refusal();
  }
  if (receipt && findSourceRecordsByPath(root, eventPath).some(s => s.source_id !== receipt.output_source_id)) throw refusal();
  const output = safeImportPath(root, eventPath);
  if (!receipt && (outputClaims.length || fs.existsSync(output))) throw conflict(); // Legacy is not silently adopted.
  if (receipt && outputClaims.some(s => s.source_id !== receipt.output_source_id)) throw conflict();
  let final;
  if (receipt) {
    final = parse(text, format, { type: kind, ref: descriptor.sourceRecord?.original_path ?? `6-raw/inbox/${receipt.input_source_id}.md`, source_id: receipt.input_source_id });
    clean(final);
    if (fs.existsSync(output)) {
      const stored = boundedRead(root, eventPath);
      if (!stored.equals(jsonBytes(final))) throw conflict();
      if (outputSource && (outputSource.content_hash?.value !== digest(stored) || outputSource.byte_size !== stored.length)) throw conflict();
    } else if (outputSource) throw refusal();
  }
  const existed = Boolean(receipt && fs.existsSync(output));
  if (!receipt) {
    const captured = descriptor?.capturedAt ?? new Date().toISOString();
    receipt = { schema_version: 1, kind, input_source_id: descriptor?.sourceId ?? `src_${randomUUID()}`, output_source_id: `src_${randomUUID()}`,
      output_path: expectedPath, format, request_reference: reference, captured_at: captured,
      expires_at: descriptor?.expiresAt ?? new Date(Date.parse(captured) + loadPrivacyPolicy(root).ttl_days * 86400000).toISOString(), processed_at: new Date().toISOString() };
    if (descriptor) metadata(root, descriptor.sourceId, receipt);
    try { publishImportFile(root, receiptPath, jsonBytes(receipt)); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Adopt the winner's IDs and timestamps through the same gated retry path.
      return importWithPrivacy(root, options, { kind, formats, defaultFormat, decodeValues, parse, fingerprint, outputKey, validateOptions });
    }
    if (!descriptor) descriptor = captureEligibleImport(root, { bytes, format, decodeValues, receipt });
  }
  // No repairs start until the exact live source has passed the privacy gate again.
  const current = readEligibleImportSource(root, { sourceId: receipt.input_source_id, format, decodeValues, receipt, allowIncomplete: true });
  if (!current.bytes.equals(bytes)) throw conflict();
  descriptor = finishCapture(root, current, receipt, format, decodeValues);
  registerLifecycle(root, descriptor.sourceId, 'raw', []);
  final ??= parse(text, format, { type: kind, ref: descriptor.sourceRecord.original_path, source_id: descriptor.sourceId });
  clean(final);
  metadata(root, descriptor.sourceId, receipt);
  if (!fs.existsSync(output)) publishImportFile(root, eventPath, jsonBytes(final));
  if (!outputSource) {
    metadata(root, descriptor.sourceId, receipt);
    registerSource(root, { source_id: receipt.output_source_id, path: eventPath, source_type: 'export', captured_by: 'mole-import' });
  }
  metadata(root, descriptor.sourceId, receipt);
  registerLifecycle(root, receipt.output_source_id, 'draft', [descriptor.sourceId]);
  return { changed: !existed, path: eventPath, raw_path: descriptor.path, event: final };
}
