import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { describe, it } from 'node:test';
import vm from 'node:vm';

const script = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const capturePath = '6-raw/inbox/saved-note.md';
const fields = {
  type: 'quick-notes',
  source: 'self',
  capturedBy: 'Sam',
  channel: 'chat',
  confidence: 'low',
  tags: 'pricing, export',
  note: 'Keep this note until it is saved'
};

async function loadClient(captureResponse) {
  const ids = ['captureForm', 'captureStatus', 'queueContent', 'treeList', 'fileContent', 'pathInput', 'loadQueueBtn', 'loadPathBtn'];
  const elements = Object.fromEntries(ids.map(id => [id, {
    textContent: '',
    value: '',
    listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; }
  }]));
  const form = elements.captureForm;
  form.fields = { ...fields };
  form.resetCount = 0;
  form.reset = () => {
    form.resetCount += 1;
    form.fields = {};
  };
  Object.defineProperty(elements.captureStatus, 'innerHTML', {
    set() { assert.fail('capture status must use textContent'); }
  });
  const requests = [];
  const context = {
    document: { getElementById: id => elements[id] },
    FormData: class {
      constructor(target) { this.values = { ...target.fields }; }
      get(name) { return this.values[name] ?? null; }
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/tree?path=2-summaries') {
        return { ok: true, json: async () => ({ type: 'dir', entries: [] }) };
      }
      assert.equal(url, '/api/capture');
      return captureResponse;
    }
  };
  await vm.runInNewContext(script, context, { filename: 'ui/public/app.js' });
  let prevented = 0;
  await form.listeners.submit({ preventDefault() { prevented += 1; } });
  assert.equal(prevented, 1);
  const captures = requests.filter(request => request.url === '/api/capture');
  assert.equal(captures.length, 1, 'a submit must make exactly one capture request');
  assert.equal(captures[0].options.method, 'POST');
  assert.equal(captures[0].options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(captures[0].options.body), { ...fields, tags: ['pricing', 'export'] });
  return { form, status: elements.captureStatus.textContent };
}

describe('capture form submission', () => {
  it('shows a normal save and resets the form once', async () => {
    const { form, status } = await loadClient({
      ok: true,
      json: async () => ({ ok: true, path: capturePath, record_id: 'rec_saved', state: 'raw' })
    });
    assert.equal(status, `Saved: ${capturePath}`);
    assert.equal(form.resetCount, 1);
    assert.deepEqual(form.fields, {});
  });

  it('shows a saved capture warning as text and resets once without retrying', async () => {
    const warning = 'The capture is saved but has no lifecycle record yet: <ledger> is locked';
    const { form, status } = await loadClient({
      ok: true,
      json: async () => ({ ok: true, path: capturePath, record_id: null, state: null, warning })
    });
    assert.equal(status, `Saved: ${capturePath}. Warning: ${warning}`);
    assert.equal(form.resetCount, 1);
    assert.deepEqual(form.fields, {});
  });

  it('shows a failed request and retains the entered form without resetting', async () => {
    const { form, status } = await loadClient({ ok: false, text: async () => 'Capture could not be saved' });
    assert.equal(status, 'Failed: Capture could not be saved');
    assert.equal(form.resetCount, 0);
    assert.deepEqual(form.fields, fields);
  });
});
