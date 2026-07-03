/**
 * Unit tests for mcp-google-gemini.
 * Tests ModelCache and composePrompt without any API calls.
 *
 * Run: node test/unit.js
 */

import assert from 'node:assert/strict';
const { Config } = await import('../src/Config.js');

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(` ✓ ${label}`);
    passed++;
  } catch (err) {
    console.error(` ✗ ${label}`);
    console.error(`   ${err.message}`);
    failed++;
  }
}

async function testAsync(label, fn) {
  try {
    await fn();
    console.log(` ✓ ${label}`);
    passed++;
  } catch (err) {
    console.error(` ✗ ${label}`);
    console.error(`   ${err.message}`);
    failed++;
  }
}

// --- composePrompt ---

console.log('\n--- composePrompt ---');

const { composePrompt } = await import('../src/Utils/composePrompt.js');

test('no context → returns prompt unchanged', () => {
  const result = composePrompt(undefined, 'Hello');
  assert.equal(result.prompt, 'Hello');
  assert.equal(result.systemInstruction, undefined);
});

test('empty context array → returns prompt unchanged', () => {
  const result = composePrompt([], 'Hello');
  assert.equal(result.prompt, 'Hello');
  assert.equal(result.systemInstruction, undefined);
});

test('single skill block', () => {
  const result = composePrompt([{ type: 'skill', text: 'You are expert.' }], 'What is Node?');
  assert.equal(result.systemInstruction, 'You are expert.');
  assert.ok(result.prompt.includes('[prompt]\nWhat is Node?'));
  assert.ok(!result.prompt.includes('[skill]'));
});

test('multiple blocks in correct order', () => {
  const result = composePrompt([
    { type: 'skill', text: 'Be concise.' },
    { type: 'data', text: '{"x":1}' },
  ], 'Analyze this.');
  assert.equal(result.systemInstruction, 'Be concise.');
  const lines = result.prompt.split('\n\n');
  assert.equal(lines[0], '[data]\n{"x":1}');
  assert.equal(lines[1], '[prompt]\nAnalyze this.');
});

test('unknown type falls back to "text"', () => {
  const result = composePrompt([{ type: 'foobar', text: 'Something.' }], 'Q?');
  assert.ok(result.prompt.includes('[text]\nSomething.'));
});

test('max 5 blocks enforced', () => {
  const ctx = Array.from({ length: 10 }, (_, i) => ({ type: 'text', text: `Block ${i}` }));
  const result = composePrompt(ctx, 'Q?');
  // 5 context blocks + 1 prompt block = 6 sections
  assert.equal(result.prompt.split('\n\n').length, 6);
});

test('blocks with empty text are filtered out', () => {
  const result = composePrompt([
    { type: 'skill', text: '' },
    { type: 'data', text: '   ' },
    { type: 'text', text: 'Valid.' },
  ], 'Q?');
  assert.equal(result.systemInstruction, undefined);
  assert.ok(!result.prompt.includes('[data]'));
  assert.ok(result.prompt.includes('[text]\nValid.'));
});

test('text is trimmed', () => {
  const result = composePrompt([{ type: 'text', text: '  trimmed  ' }], 'Q?');
  assert.ok(result.prompt.includes('[text]\ntrimmed'));
});

test('prompt exceeding MAX_PROMPT_CHARS throws RangeError', () => {
  const overlong = 'x'.repeat(Config.MAX_PROMPT_CHARS + 1);
  assert.throws(() => composePrompt(undefined, overlong), RangeError);
});

test('context block exceeding MAX_CONTEXT_BLOCK_CHARS throws RangeError', () => {
  const overlong = 'x'.repeat(Config.MAX_CONTEXT_BLOCK_CHARS + 1);
  assert.throws(() => composePrompt([{ type: 'data', text: overlong }], 'Q?'), RangeError);
});

test('skill block exceeding MAX_CONTEXT_BLOCK_CHARS throws RangeError', () => {
  const overlong = 'x'.repeat(Config.MAX_CONTEXT_BLOCK_CHARS + 1);
  assert.throws(() => composePrompt([{ type: 'skill', text: overlong }], 'Q?'), RangeError);
});

// --- ModelCache ---

console.log('\n--- ModelCache ---');

const Cache = await import('../src/ModelCache.js');

test('getEntry unknown model → status unknown', () => {
  const e = Cache.getEntry('model-x');
  assert.equal(e.status, 'unknown');
  assert.equal(e.retry_after_ts, null);
});

test('setOk → isBlocked false, status ok', () => {
  Cache.setOk('model-a');
  assert.equal(Cache.isBlocked('model-a'), false);
  assert.equal(Cache.getEntry('model-a').status, 'ok');
});

test('setError → isBlocked true', () => {
  Cache.setError('model-b');
  assert.equal(Cache.isBlocked('model-b'), true);
  assert.equal(Cache.getEntry('model-b').status, 'error');
});

test('setQuota qpm → isBlocked true', () => {
  Cache.setQuota('model-c', 'qpm', 60);
  assert.equal(Cache.isBlocked('model-c'), true);
  assert.equal(Cache.getEntry('model-c').status, 'quota_rpm');
});

test('setQuota qpd → isBlocked true, retry_after_ts is midnight UTC', () => {
  Cache.setQuota('model-d', 'qpd', 0);
  assert.equal(Cache.isBlocked('model-d'), true);
  assert.equal(Cache.getEntry('model-d').status, 'quota_rpd');
  assert.ok(Cache.getEntry('model-d').retry_after_ts > Date.now());
});

test('setQuota qpm expiry → isBlocked remains true while quota active', () => {
  Cache.setOk('model-e');
  Cache.setQuota('model-e', 'qpm', 60);
  assert.equal(Cache.isBlocked('model-e'), true);
});

test('listForAgent returns all models with required fields', () => {
  Cache.setOk('gemini-2.5-pro');
  Cache.setQuota('gemini-2.5-flash', 'qpm', 120);
  const models = [
    { id: 'gemini-2.5-pro', tier: 1, desc: 'best' },
    { id: 'gemini-2.5-flash', tier: 2, desc: 'fast' },
    { id: 'gemini-unknown', tier: 3, desc: 'n/a' },
  ];
  const list = Cache.listForAgent(models);
  assert.equal(list.length, 3);
  assert.ok(list.every(m => 'status' in m && 'retry_in' in m && 'tier' in m && 'desc' in m));
  assert.equal(list[0].status, 'ok');
  assert.equal(list[0].retry_in, null);
  assert.equal(list[1].status, 'quota_rpm');
  assert.ok(list[1].retry_in !== null);
  assert.equal(list[2].status, 'unknown');
});

test('retry_in format — seconds', () => {
  Cache.setQuota('model-retry-s', 'qpm', 45);
  const list = Cache.listForAgent([{ id: 'model-retry-s', tier: 9, desc: '' }]);
  assert.match(list[0].retry_in, /^\d+s$/);
});

test('retry_in format — minutes', () => {
  Cache.setQuota('model-retry-m', 'qpm', 300);
  const list = Cache.listForAgent([{ id: 'model-retry-m', tier: 9, desc: '' }]);
  assert.match(list[0].retry_in, /^\d+m$/);
});

test('getFailRatio — no data today → 0', () => {
  assert.equal(Cache.getFailRatio('model-never-seen'), 0);
});

test('getFailRatio — tracks ok/fail counts within same UTC day', () => {
  Cache.setOk('model-ratio');
  Cache.setQuota('model-ratio', 'qpm', 60);
  Cache.setQuota('model-ratio', 'qpm', 60);
  // 1 ok, 2 fail → ratio 2/3
  assert.equal(Cache.getFailRatio('model-ratio'), 2 / 3);
});

test('restore() hydrates ok_count/fail_count/count_day from persisted state', () => {
  Cache.restore('model-restored', {
    status: 'ok', retry_after_ts: null, quota_metric: null, last_checked: null,
    ok_count: 3, fail_count: 1, count_day: new Date().toISOString().slice(0, 10),
  });
  assert.equal(Cache.getFailRatio('model-restored'), 1 / 4);
});

// --- Summary ---

console.log(`\n${'─'.repeat(40)}`);
if (failed === 0) {
  console.log(`All ${passed} unit tests passed ✓`);
} else {
  console.log(`${passed} passed, ${failed} FAILED ✗`);
  process.exit(1);
}
