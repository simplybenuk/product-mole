import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCaptureFileName, resolveCapturedBy } from '../lib/capture.mjs';
import { createSourceId, registerSource, toWorkspaceRelativePath } from '../lib/source-registry.mjs';
import { registerLifecycleRecord } from '../lib/review-lifecycle.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 4173;
// The UI serves private workspace files, so it listens on loopback only
// unless MOLE_UI_HOST says otherwise.
const HOST = process.env.MOLE_UI_HOST || '127.0.0.1';
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;

// The lock wait is synchronous and would stall every other request, so a
// capture gives up early and is saved with a warning instead.
const UI_LOCK_WAIT_MS = 1500;

const allowedRoots = new Set([
  '0-bootstrap',
  '1-routing',
  '2-summaries',
  '3-indexes',
  '4-context',
  '5-evidence',
  '6-raw',
  'governance',
  'docs',
  'README.md',
]);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, code, body, contentType = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': contentType });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const MAX_BODY_BYTES = 1024 * 1024;

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function safeRepoPath(input = '', root = REPO_ROOT) {
  const normalized = input.replace(/^\/+/, '');
  const resolved = path.resolve(root, normalized);
  if (!resolved.startsWith(root)) throw new Error('Invalid path');
  const rel = path.relative(root, resolved);
  const top = rel.split(path.sep)[0];
  if (!allowedRoots.has(top) && rel !== 'README.md') {
    throw new Error('Path outside allowed roots');
  }
  // An allowed folder may hold a link to somewhere else; never serve it.
  try {
    toWorkspaceRelativePath(root, rel.split(path.sep).join('/'));
  } catch {
    throw new Error('Path outside allowed roots');
  }
  return { resolved, rel };
}

async function listDir(targetPath) {
  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  const out = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.git')) continue;
    out.push({ name: entry.name, type: entry.isDirectory() ? 'dir' : 'file' });
  }
  return out;
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

export function createCaptureRelPath(type, note, options = {}) {
  const filename = createCaptureFileName(String(note || '').split('\n')[0], options);
  return path.join('6-raw', 'inbox', filename);
}

export function buildUiCaptureContent(body, options = {}) {
  const date = options.date || todayDate();
  const source = body.source || 'self';
  const channel = body.channel || 'chat';
  const confidence = body.confidence || 'low';
  const tags = Array.isArray(body.tags) ? body.tags : [];
  const capturedBy = resolveCapturedBy(body.capturedBy || body.captured_by);
  const note = (body.note || '').trim();
  const sourceId = options.sourceId || body.sourceId || body.source_id || '';

  return [
    '---',
    `date: ${date}`,
    `source: ${source}`,
    `source_id: ${sourceId}`,
    `captured_by: ${capturedBy}`,
    `channel: ${channel}`,
    `topic_tags: [${tags.join(', ')}]`,
    `confidence: ${confidence}`,
    '---',
    '',
    note,
    '',
  ].join('\n');
}

/**
 * Save one UI capture under a workspace root and return the HTTP status and
 * payload for it.  The capture file comes first; source and lifecycle
 * registration follow.
 */
export async function captureNote(root, body = {}) {
  const type = body.type || 'quick-notes';
  const source = body.source || 'self';
  const channel = body.channel || 'chat';
  const confidence = body.confidence || 'low';
  const tags = Array.isArray(body.tags) ? body.tags : [];
  const note = (body.note || '').trim();
  if (!note) return { status: 400, payload: { error: 'Note is required' } };

  const date = todayDate();
  const relPath = createCaptureRelPath(type, note);
  const resolved = path.resolve(root, relPath);
  const sourceId = createSourceId();
  const capturedAt = new Date().toISOString();

  const frontmatter = buildUiCaptureContent({
    source,
    channel,
    confidence,
    tags,
    note,
    capturedBy: body.capturedBy || body.captured_by
  }, { date, sourceId });

  await fs.mkdir(path.dirname(resolved), { recursive: true });
  try {
    await fs.writeFile(resolved, frontmatter, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') {
      return { status: 409, payload: { error: 'Capture already exists; retry to generate a new filename.' } };
    }
    throw err;
  }

  try {
    registerSource(root, {
      source_id: sourceId,
      path: relPath,
      source_type: 'note',
      captured_at: capturedAt,
      captured_by: resolveCapturedBy(body.capturedBy || body.captured_by),
      channel,
      original_date: date,
      visibility: body.visibility || 'internal',
      path_reason: 'captured',
      content_change_type: 'captured'
    });
  } catch (err) {
    return {
      status: 500,
      payload: {
        error: `Capture written but source registration failed: ${err.message}`,
        path: relPath,
        source_id: sourceId
      }
    };
  }

  // The capture is saved and registered.  A lifecycle problem is reported as
  // a warning so the client does not retry and capture the note twice.
  let recordId = null;
  let warning = null;
  try {
    recordId = registerLifecycleRecord(root, {
      sourceId,
      state: 'raw',
      actor: 'mole-ui',
      actorType: 'automation',
      reason: 'Captured from the UI.',
      now: capturedAt,
      lockWaitMs: UI_LOCK_WAIT_MS
    }).record_id;
  } catch (err) {
    warning = `The capture is saved but has no lifecycle record yet: ${err.message}`;
  }

  return {
    status: 200,
    payload: {
      ok: true,
      source_id: sourceId,
      record_id: recordId,
      state: recordId ? 'raw' : null,
      path: relPath,
      ...(warning ? { warning } : {})
    }
  };
}

/**
 * Refuse a request a browser could send on behalf of another site.  A Host
 * header that is not loopback means DNS rebinding; a POST that is not JSON
 * is a cross-site form or beacon, because a JSON POST from another origin
 * needs a CORS preflight this server never grants.
 */
export function refuseRequest(method, headers = {}, options = {}) {
  const host = options.host ?? HOST;
  const hostHeader = String(headers.host || '');
  const hostname = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0];
  const allowed = LOOPBACK_HOSTNAMES.has(host) ? LOOPBACK_HOSTNAMES : new Set([...LOOPBACK_HOSTNAMES, host]);
  if (!allowed.has(hostname.toLowerCase())) {
    return { status: 403, payload: { error: 'Host not allowed. Open the UI at http://localhost.' } };
  }
  if (method === 'POST' && !String(headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    return { status: 415, payload: { error: 'Requests must be sent as application/json.' } };
  }
  return null;
}

async function routeApi(req, res, urlObj) {
  if (req.method === 'GET' && urlObj.pathname === '/api/tree') {
    const p = urlObj.searchParams.get('path') || '';
    const { resolved, rel } = safeRepoPath(p || 'README.md');
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      return send(res, 404, { error: 'Not found' });
    }
    if (stat.isFile()) {
      return send(res, 200, { path: rel, type: 'file' });
    }
    const entries = await listDir(resolved);
    return send(res, 200, { path: rel || '.', type: 'dir', entries });
  }

  if (req.method === 'GET' && urlObj.pathname === '/api/file') {
    const p = urlObj.searchParams.get('path');
    if (!p) return send(res, 400, { error: 'Missing path' });
    const { resolved, rel } = safeRepoPath(p);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat || !stat.isFile()) return send(res, 404, { error: 'File not found' });
    const content = await fs.readFile(resolved, 'utf8');
    return send(res, 200, { path: rel, content });
  }

  if (req.method === 'POST' && urlObj.pathname === '/api/capture') {
    const result = await captureNote(REPO_ROOT, await readBody(req));
    return send(res, result.status, result.payload);
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const refused = refuseRequest(req.method, req.headers);
    if (refused) return send(res, refused.status, refused.payload);
    const urlObj = new URL(req.url, 'http://localhost');
    if (urlObj.pathname.startsWith('/api/')) {
      const handled = await routeApi(req, res, urlObj);
      if (handled !== false) return;
      return send(res, 404, { error: 'API route not found' });
    }

    let filePath = urlObj.pathname === '/' ? '/index.html' : urlObj.pathname;
    filePath = path.join(PUBLIC_DIR, filePath);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    const ext = path.extname(filePath);
    const contentType = mime[ext] || 'application/octet-stream';
    const content = await fs.readFile(filePath);
    return send(res, 200, content, contentType);
  } catch (err) {
    return send(res, err.status || 500, { error: err.message || 'Server error' });
  }
});

if (isDirectRun) {
  server.listen(PORT, HOST, () => {
    console.log(`Context Cascade UI running on http://localhost:${PORT}${LOOPBACK_HOSTNAMES.has(HOST) ? '' : ` (listening on ${HOST})`}`);
  });
}
