import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { server } from '../server.mjs';

async function request(url, { method = 'GET', body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { url, method, headers: { host: 'localhost' } });
  const response = {};
  const res = {
    writeHead(status, headers) {
      response.status = status;
      response.headers = headers;
    },
    end(content) {
      response.body = Buffer.isBuffer(content) ? content : Buffer.from(content);
    }
  };
  await server.listeners('request')[0](req, res);
  return response;
}

describe('UI request responses', () => {
  for (const [url, filename, contentType] of [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'application/javascript; charset=utf-8'],
    ['/style.css', 'style.css', 'text/css; charset=utf-8']
  ]) {
    it(`serves ${url} with the exact asset bytes and content type`, async () => {
      const expected = await fs.readFile(new URL(`../public/${filename}`, import.meta.url));
      const response = await request(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-type'], contentType);
      assert.equal(Buffer.compare(response.body, expected), 0, 'response bytes must equal the asset file');
    });
  }

  it('keeps API object responses as JSON', async () => {
    const response = await request('/api/tree?path=README.md');
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(response.body.toString('utf8'), JSON.stringify({ path: 'README.md', type: 'file' }));
  });

  it('keeps file contents inside the API JSON response', async () => {
    const content = await fs.readFile(new URL('../../README.md', import.meta.url), 'utf8');
    const response = await request('/api/file?path=README.md');
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(response.body.toString('utf8'), JSON.stringify({ path: 'README.md', content }));
  });

  it('keeps capture validation errors as JSON without writing a capture', async () => {
    const response = await request('/api/capture', { method: 'POST', body: { note: '   ' } });
    assert.equal(response.status, 400);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(response.body.toString('utf8'), JSON.stringify({ error: 'Note is required' }));
  });

  it('keeps plain string responses unchanged', async () => {
    const response = await request('/missing-asset');
    assert.equal(response.status, 404);
    assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(response.body.toString('utf8'), 'Not found');
  });
});
