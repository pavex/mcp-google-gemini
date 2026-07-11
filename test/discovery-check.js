// test/discovery-check.js — standalone diagnostic for Gemini model catalog discovery.
//
// Calls the real Gemini ListModels endpoint directly and prints the raw
// catalog, the candidates surviving the cheap category pre-filter (with
// their tier score), and — separately — any error, with full detail (the
// same error text that would otherwise only appear in the MCP server's own
// stderr log, which is easy to miss, especially since discovery running
// inside a test/integration.js-spawned process during `npm test` never
// reaches the Claude Desktop log at all).
//
// Deliberately does NOT call refreshModels() / probeModel() — this script
// only does the cheap, free (no generateContent cost) part. The real
// probe-based validation happens via the live list_models({refresh:true})
// tool call, which does cost real API calls per candidate.
//
// Read-only: does not touch .storage/models.json.
//
// Usage:
//   node test/discovery-check.js <GEMINI_API_KEY>
//   GEMINI_API_KEY=... node test/discovery-check.js
//
// Exit code: 0 = catalog call succeeded, 1 = failed, 2 = no API key given.

import { fetchAvailableModelIds, isLikelyChatModel, scoreModelId } from '../src/GeminiModelRegistry.js';

if (!process.argv[2] && !process.env.GEMINI_API_KEY) {
  console.error('ERROR: no API key.');
  console.error('Usage: node test/discovery-check.js <GEMINI_API_KEY>');
  console.error('   or: GEMINI_API_KEY=... node test/discovery-check.js');
  process.exit(2);
}

console.log('Calling Gemini ListModels endpoint (live, real network call, no generateContent cost)...\n');

try {
  const rawIds = await fetchAvailableModelIds();
  console.log(`OK — catalog has ${rawIds.length} model(s) supporting generateContent.\n`);

  const candidateIds = rawIds.filter(isLikelyChatModel);
  const excludedIds   = rawIds.filter(id => !isLikelyChatModel(id));

  const ranked = candidateIds
    .map(id => ({ id, score: scoreModelId(id) }))
    .sort((a, b) => b.score - a.score);

  console.log(`Candidates after category pre-filter (${candidateIds.length}/${rawIds.length}), ranked:\n`);
  ranked.forEach((m, i) => console.log(`  tier ${String(i + 1).padStart(3)}: ${m.id}`));

  console.log(`\nExcluded by category filter (${excludedIds.length}) — not tried as ask_gemini candidates:\n`);
  for (const id of excludedIds) console.log(`  - ${id}`);

  console.log(
    '\nNote: this list is NOT probe-verified — it is the cheap keyword pre-filter only.\n' +
    'To actually validate + persist a ranked list (costs one real API call per candidate\n' +
    'above), call the live list_models tool with refresh:true.'
  );
  process.exit(0);
} catch (err) {
  console.error('FAILED:', err.message);
  console.error('\nThis is the exact error the MCP server hits during its boot-time catalog check —');
  console.error('it normally only shows up in that server process\'s own stderr, not in this script.');
  process.exit(1);
}
