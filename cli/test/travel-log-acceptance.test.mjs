import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runAcceptance } from '../../examples/product-travel-log/acceptance/run.mjs';

for (const releaseOnly of [false, true]) {
  test(`travel log acceptance: ${releaseOnly ? 'release-only gaps' : 'intent, release, aggregate and qualitative evidence'} through reviewed learning and later decision`, () => {
    const result = runAcceptance({ releaseOnly });
    assert.equal(fs.existsSync(result.cleaned_workspace), false);
    const draft = result.trace.find(item => item.stage === 'draft');
    assert.equal(draft.pending_retrieval_count, 0);
    assert.match(draft.report, releaseOnly ? /No intent record found for any change/ : /below the stated 65 percent target/);
    assert.match(draft.report, /unknown/);
    const later = result.trace.find(item => item.stage === 'later-decision');
    assert.match(later.decision, new RegExp(later.learning_id));
    assert.match(later.decision, /draft/);
    assert.equal(later.current, true);
    assert.equal(result.trace.at(-1).summary_unchanged, true);
  });
}
