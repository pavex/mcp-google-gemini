/**
 * Integration test pro mcp-google-gemini.
 * Spouští server jako subprocess, komunikuje přes stdio JSON-RPC 2.0.
 * Vyžaduje GEMINI_API_KEY v prostředí.
 *
 * Spuštění:
 *   node test/integration.js        — testuje dist/mcp.js (default)
 *   node test/integration.js src    — testuje src/mcp.js
 *   node test/integration.js dist   — testuje dist/mcp.js
 */

import { spawn }         from 'node:child_process';
import path              from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('ERROR: GEMINI_API_KEY not set — integration test requires a real API key.');
  process.exit(1);
}

const CALL_TIMEOUT_MS  = 35_000;
const SUITE_TIMEOUT_MS = 180_000; // 3 min celkový limit

// ---------------------------------------------------------------------------
// RPC client helper
// ---------------------------------------------------------------------------

function createClient(serverPath) {
  const server = spawn('node', [serverPath], {
    env: { ...process.env, GEMINI_API_KEY: API_KEY },
  });

  const pending = new Map(); // id → { resolve, reject, timer }
  let buffer = '';
  let dead = false;

  server.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        // Ignoruj notifications (bez id)
        if (msg.id === undefined) continue;
        if (pending.has(msg.id)) {
          const { resolve, timer } = pending.get(msg.id);
          clearTimeout(timer);
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch { /* ignore partial lines */ }
    }
  });

  server.stderr.on('data', (d) => {
    process.stderr.write(`  [server] ${d.toString().trimEnd()}\n`);
  });

  // Pokud server umře předčasně — odmítni všechny čekající requesty
  server.on('close', (code) => {
    dead = true;
    for (const [, { reject, timer }] of pending) {
      clearTimeout(timer);
      reject(new Error(`Server exited unexpectedly (code ${code})`));
    }
    pending.clear();
  });

  let nextId = 1;

  const call = (method, params = {}) => {
    if (dead) return Promise.reject(new Error('Server is not running'));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Timeout (${CALL_TIMEOUT_MS}ms): no response for ${method}`));
        }
      }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };

  const notify = (method, params = {}) => {
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };

  const close = () => new Promise((resolve) => {
    if (dead) return resolve();
    server.on('close', resolve);
    server.kill();
    // Force kill po 3s
    setTimeout(() => { try { server.kill('SIGKILL'); } catch {} }, 3000);
  });

  return { call, notify, close };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function test(label, fn) {
  try {
    await fn();
    console.log(` ✓ ${label}`);
    passed++;
  } catch (err) {
    console.error(` ✗ ${label}: ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run(serverPath, target) {
  console.log(`\nIntegration test — ${target} (${path.basename(serverPath)})`);
  console.log('─'.repeat(55));

  const client = createClient(serverPath);

  // Celkový timeout pro celou suite
  const suiteTimer = setTimeout(() => {
    console.error('\nFATAL: Suite timeout exceeded — killing server.');
    client.close();
    process.exit(1);
  }, SUITE_TIMEOUT_MS);

  try {

    // 1. initialize
    await test('initialize — returns protocolVersion 2024-11-05', async () => {
      const res = await client.call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'integration-test', version: '1.0' },
      });
      const pv = res.result?.protocolVersion;
      if (!pv) throw new Error(`missing protocolVersion — got: ${JSON.stringify(res)}`);
    });

    client.notify('notifications/initialized');

    // 2. tools/list
    await test('tools/list — exactly 3 tools: ask_gemini, list_models, gemini_status', async () => {
      const res = await client.call('tools/list');
      const tools = res.result?.tools ?? [];
      const names = new Set(tools.map(t => t.name));
      for (const expected of ['ask_gemini', 'list_models', 'gemini_status']) {
        if (!names.has(expected)) throw new Error(`missing tool: ${expected}`);
      }
      if (tools.length !== 3) throw new Error(`expected 3 tools, got ${tools.length}`);
      // Ověř, že každý tool má inputSchema
      for (const t of tools) {
        if (!t.inputSchema) throw new Error(`${t.name} missing inputSchema`);
      }
    });

    // 3. list_models — žádné API volání, jen cache
    await test('list_models — returns array with required fields', async () => {
      const res = await client.call('tools/call', { name: 'list_models', arguments: {} });
      const text = res.result?.content?.[0]?.text;
      if (!text) throw new Error('no content text');
      const models = JSON.parse(text);
      if (!Array.isArray(models) || models.length === 0) throw new Error('empty model list');
      const required = ['id', 'tier', 'desc', 'status', 'retry_in'];
      for (const m of models) {
        for (const field of required) {
          if (!(field in m)) throw new Error(`model "${m.id}" missing field: ${field}`);
        }
        const validStatuses = ['ok', 'quota_rpm', 'quota_rpd', 'error', 'unknown'];
        if (!validStatuses.includes(m.status)) throw new Error(`invalid status: ${m.status}`);
      }
    });

    // 4. ask_gemini — základní dotaz
    await test('ask_gemini — basic prompt returns { ok, text, model_used }', async () => {
      const res = await client.call('tools/call', {
        name: 'ask_gemini',
        arguments: { prompt: 'Reply with exactly one word: OK' },
      });
      const text = res.result?.content?.[0]?.text;
      if (!text) throw new Error('no content text');
      const result = JSON.parse(text);
      if (!result.ok)                              throw new Error(`ok=false: ${JSON.stringify(result)}`);
      if (typeof result.text !== 'string' || !result.text) throw new Error('empty or missing text');
      if (typeof result.model_used !== 'string')   throw new Error('missing model_used');
    });

    // 5. ask_gemini — model override
    await test('ask_gemini — model override targets gemini-2.5-flash', async () => {
      const res = await client.call('tools/call', {
        name: 'ask_gemini',
        arguments: { prompt: 'Say: yes', model: 'gemini-2.5-flash' },
      });
      const result = JSON.parse(res.result?.content?.[0]?.text ?? '{}');
      if (!result.ok) throw new Error(`ok=false: ${JSON.stringify(result)}`);
      if (result.model_used !== 'gemini-2.5-flash') throw new Error(`wrong model: ${result.model_used}`);
    });

    // 6. ask_gemini — context bloky
    await test('ask_gemini — context[skill] is applied to response', async () => {
      const res = await client.call('tools/call', {
        name: 'ask_gemini',
        arguments: {
          prompt: 'What is your role?',
          context: [
            { type: 'skill', text: 'You are a test assistant. Always start your reply with: CONTEXT_OK' },
          ],
        },
      });
      const result = JSON.parse(res.result?.content?.[0]?.text ?? '{}');
      if (!result.ok) throw new Error(`ok=false: ${JSON.stringify(result)}`);
      if (!result.text.includes('CONTEXT_OK')) throw new Error(`context not applied — got: ${result.text.slice(0, 80)}`);
    });

    // 7. gemini_status
    await test('gemini_status — returns available + summary + probed + models', async () => {
      const res = await client.call('tools/call', {
        name: 'gemini_status',
        arguments: { limit: 1 },
      });
      const result = JSON.parse(res.result?.content?.[0]?.text ?? '{}');
      if (typeof result.available     !== 'boolean') throw new Error('missing available');
      if (typeof result.summary       !== 'string')  throw new Error('missing summary');
      if (!Array.isArray(result.probed))             throw new Error('missing probed');
      if (!Array.isArray(result.models))             throw new Error('missing models');
      if (typeof result.total_models  !== 'number')  throw new Error('missing total_models');
      // Každý probed entry musí mít ok + model
      for (const p of result.probed) {
        if (typeof p.ok !== 'boolean') throw new Error(`probed entry missing ok: ${JSON.stringify(p)}`);
        if (typeof p.model !== 'string') throw new Error(`probed entry missing model: ${JSON.stringify(p)}`);
      }
    });

    // 8. cache aktualizována — po volání ask_gemini musí být alespoň jeden model ok
    await test('list_models after ask — at least one model shows status: ok', async () => {
      const res = await client.call('tools/call', { name: 'list_models', arguments: {} });
      const models = JSON.parse(res.result?.content?.[0]?.text ?? '[]');
      if (!models.some(m => m.status === 'ok')) {
        throw new Error(`no ok model — statuses: ${models.map(m => `${m.id}:${m.status}`).join(', ')}`);
      }
    });

    // 9. unknown tool → isError
    await test('unknown tool → isError: true in response', async () => {
      const res = await client.call('tools/call', { name: 'nonexistent_tool', arguments: {} });
      if (!res.result?.isError) throw new Error(`expected isError=true, got: ${JSON.stringify(res.result)}`);
    });

    // 10. unknown method → JSON-RPC error object
    await test('unknown method → JSON-RPC error response', async () => {
      const res = await client.call('unknown/method');
      if (!res.error) throw new Error(`expected error field, got: ${JSON.stringify(res)}`);
      if (typeof res.error.code    !== 'number') throw new Error('error.code missing');
      if (typeof res.error.message !== 'string') throw new Error('error.message missing');
    });

  } finally {
    clearTimeout(suiteTimer);
    await client.close();
  }

  console.log(`\n${'─'.repeat(55)}`);
  if (failed === 0) {
    console.log(`All ${passed} integration tests passed ✓`);
  } else {
    console.log(`${passed} passed, ${failed} FAILED ✗`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const target = process.argv[2] || 'dist';
const serverFile = target === 'src' ? '../src/mcp.js' : '../dist/mcp.js';
const serverPath = path.resolve(__dirname, serverFile);

run(serverPath, target).catch(err => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
