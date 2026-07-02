// composePrompt.js — assembles context[] blocks and the prompt into a single string

import { Config } from '../Config.js';

const VALID_TYPES = ['skill', 'data', 'text'];
const MAX_BLOCKS  = 5;

/**
 * Composes a structured prompt from optional context blocks and the required prompt string.
 *
 * @param {Array<{type: string, text: string}>|undefined} context
 * @param {string} prompt
 * @returns {{ prompt: string, systemInstruction: string|undefined }}
 *
 * skill blocks are sent as native systemInstruction.
 * data/text blocks are prepended to the user prompt as [type]\n...text... sections.
 * Without context — returns { prompt } with the prompt string unchanged.
 *
 * @throws {RangeError} if prompt or any block text exceeds configured limits.
 */
export function composePrompt(context, prompt) {
  if (prompt.length > Config.MAX_PROMPT_CHARS) {
    throw new RangeError(`prompt exceeds maximum length (${prompt.length} > ${Config.MAX_PROMPT_CHARS} chars).`);
  }

  if (!context || context.length === 0) return { prompt };

  const systemBlocks = context.filter(b => b && b.type === 'skill' && typeof b.text === 'string' && b.text.trim());
  const otherBlocks  = context.filter(b => b && b.type !== 'skill' && typeof b.text === 'string' && b.text.trim());

  for (const b of [...systemBlocks, ...otherBlocks]) {
    if (b.text.length > Config.MAX_CONTEXT_BLOCK_CHARS) {
      throw new RangeError(`context block of type "${b.type}" exceeds maximum length (${b.text.length} > ${Config.MAX_CONTEXT_BLOCK_CHARS} chars).`);
    }
  }

  const systemInstruction = systemBlocks.map(b => b.text.trim()).join('\n\n') || undefined;

  const blocks = otherBlocks
    .slice(0, MAX_BLOCKS)
    .map(b => {
      const type = VALID_TYPES.includes(b.type) ? b.type : 'text';
      return `[${type}]\n${b.text.trim()}`;
    });

  blocks.push(`[prompt]\n${prompt}`);

  return {
    prompt: blocks.join('\n\n'),
    systemInstruction,
  };
}

