// composePrompt.js — assembles context[] blocks and the prompt into a single string

const VALID_TYPES = ['skill', 'data', 'text'];
const MAX_BLOCKS  = 5;

/**
 * Composes a structured prompt from optional context blocks and the required prompt string.
 *
 * @param {Array<{type: string, text: string}>|undefined} context
 * @param {string} prompt
 * @returns {string}
 *
 * Output format (when context is provided):
 *   [skill]
 *   ...text...
 *
 *   [data]
 *   ...text...
 *
 *   [prompt]
 *   ...prompt...
 *
 * Without context — returns the prompt string unchanged.
 */
export function composePrompt(context, prompt) {
  if (!context || context.length === 0) return { prompt };

  const systemBlocks = context.filter(b => b && b.type === 'skill' && typeof b.text === 'string' && b.text.trim());
  const otherBlocks  = context.filter(b => b && b.type !== 'skill' && typeof b.text === 'string' && b.text.trim());

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
