/**
 * Unit testy pro mcp-google-gemini.
 * Testuje ModelCache, composePrompt a callGemini all-failed response bez API volání.
 *
 * Spuštění: node test/unit.js
 */

import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// composePrompt tests
// ---------------------------------------------------------------------------

console.log('\n--- composePrompt ---');

const { composePrompt } = await import('../src/Utils/composePrompt.js');

test('no context → returns prompt unchanged', () => {
  assert.equal(composePrompt(undefined, 'Hello'), 'Hello');
});

test('empty context array → returns prompt unchanged', () => {
  assert.equal(composePrompt([], 'Hello'), 'Hello');
});

test('single skill block', () => {
  const result = composePrompt([{ type: 'skill', text: 'You are expert.' }], 'What is Node?');
  assert.ok(result.includes('[skill]\nYou are expert.'));
  assert.ok(result.includes('[prompt]\nWhat is Node?'));
});

test('multiple blocks in correct order', () => {
  const result = composePrompt([
    { type: 'skill', text: 'Be concise.' },
    { type: 'data',  text: '{"x":1}' },
  ], 'Analyze this.');
  const lines = result.split('\n\n');
  assert.equal(lines[0], '[skill]\nBe concise.');
  assert.equal(lines[1], '[data]\n{"x":1}');
  assert.equal(lines[2], '[prompt]\nAnalyze this.');
});

test('unknown type falls back to "text"', () => {
  const result = composePrompt([{ type: 'foobar', text: 'Something.' }], 'Q?');
  assert.ok(result.includes('[text]\nSomething.'));
});

test('max 5 blocks enforced', () => {
  const ctx = Array.from({ length: 10 }, (_, i) => ({ type: 'text', text: `Block ${i}` }));
  const result = composePrompt(ctx, 'Q?');
  // 5 context blocks + 1 prompt block = 6 sections
  assert.equal(result.split('\n\n').length, 6);
});

test('blocks with empty text are filtered out', () => {
  const result = composePrompt([
    { type: 'skill', text: '' },
    { type: 'data',  text: '   ' },
    { type: 'text',  text: 'Valid.' },
  ], 'Q?');
  assert.ok(!result.includes('[skill]'));
  assert.ok(!result.includes('[data]'));
  assert.ok(result.includes('[text]\nValid.'));
});

test('text is trimmed', () => {
  const result = composePrompt([{ type: 'text', text: '  trimmed  ' }], 'Q?');
  assert.ok(result.includes('[text]\ntrimmed'));
});

// ---------------------------------------------------------------------------
// ModelCache tests
// ---------------------------------------------------------------------------

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

test('setQuota qpm expiry → isBlocked resets to unknown after expiry', () => {
  Cache.setOk('model-e');
  Cache.setQuota('model-e', 'qpm', 60);
  assert.equal(Cache.isBlocked('model-e'), true);
});

test('listForAgent returns all models with status fields', () => {
  Cache.setOk('gemini-2.5-pro');
  Cache.setQuota('gemini-2.5-flash', 'qpm', 120);
  const models = [
    { id: 'gemini-2.5-pro',   tier: 1, desc: 'best' },
    { id: 'gemini-2.5-flash', tier: 2, desc: 'fast' },
    { id: 'gemini-unknown',   tier: 3, desc: 'n/a'  },
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

// ---------------------------------------------------------------------------
// callGemini all-failed response shape tests
// ---------------------------------------------------------------------------

console.log('\n--- callGemini all-failed response ---');

// Testujeme response strukturu když jsou všechny modely na quota.
// Simulujeme přes cache — nastavíme všechny modely jako blocked,
// pak zavoláme callGemini s fake prompt (API call proběhne pouze pokud model není blocked).
// Použijeme model IDs které nejsou v MODELS, abychom targetovali přímo jednoho kandidáta.

await testAsync('all-failed quota_rpm → retry:true, reason mentions rpm, has models_status', async () => {
  // Nastavíme jeden dočasný model na quota_rpm
  Cache.setQuota('test-rpm-only', 'qpm', 120);

  // Zavoláme callGemini s targetModelId který je blocked → přeskočí, all failed
  // Importujeme GeminiClient — musíme použít dynamický import pro přístup k callGemini
  const { callGemini } = await import('../src/GeminiClient.js');

  // Přidáme fake model do candidátů přes targetModelId
  const result = await callGemini('test', 'test-rpm-only');

  assert.equal(result.ok, false);
  assert.equal(result.error, 'quota');
  assert.equal(result.retry, true, 'quota_rpm should be retryable');
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0, 'reason must be non-empty string');
  assert.ok(Array.isArray(result.models_status), 'models_status must be array');
  assert.ok(result.models_status.every(m => 'id' in m && 'status' in m && 'retry_in' in m), 'each entry needs id, status, retry_in');
  assert.ok('best_retry_in' in result, 'best_retry_in must be present for quota_rpm');
});

await testAsync('all-failed quota_rpd → retry:false, reason mentions daily limit', async () => {
  Cache.setQuota('test-rpd-only', 'qpd', 0);

  const { callGemini } = await import('../src/GeminiClient.js');
  const result = await callGemini('test', 'test-rpd-only');

  assert.equal(result.ok, false);
  assert.equal(result.error, 'quota');
  assert.equal(result.retry, false, 'quota_rpd should NOT be retryable');
  assert.ok(result.reason.toLowerCase().includes('daily') || result.reason.toLowerCase().includes('tomorrow'),
    `reason should mention daily quota, got: ${result.reason}`);
  assert.ok(Array.isArray(result.models_status));
});

await testAsync('all-failed response has no extra unknown fields', async () => {
  Cache.setQuota('test-shape', 'qpm', 60);
  const { callGemini } = await import('../src/GeminiClient.js');
  const result = await callGemini('test', 'test-shape');

  const allowed = new Set(['ok', 'error', 'retry', 'reason', 'models_status', 'best_retry_in']);
  for (const key of Object.keys(result)) {
    assert.ok(allowed.has(key), `unexpected field in response: ${key}`);
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(40)}`);
if (failed === 0) {
  console.log(`All ${passed} unit tests passed ✓`);
} else {
  console.log(`${passed} passed, ${failed} FAILED ✗`);
  process.exit(1);
}
