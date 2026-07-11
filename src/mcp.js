// mcp.js — entry point, mcp-google-gemini v2.0
// SDK: @modelcontextprotocol/sdk

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
import { Config } from './Config.js';
import { initModels } from './GeminiModelRegistry.js';
import { AskGemini } from './Tools/AskGemini.js';
import { ListModels } from './Tools/ListModels.js';
import { GeminiStatus } from './Tools/GeminiStatus.js';

Config.validate();
await initModels();

const ToolDefinitions = [AskGemini, ListModels, GeminiStatus];
const handlers = new Map(ToolDefinitions.map(t => [t.name, t]));

const server = new Server(
  { name: Config.MCP_SERVER_NAME, version: Config.MCP_SERVER_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ToolDefinitions.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const tool = handlers.get(name);

  if (!tool) {
    return { content: [{ type: 'text', text: `Error: Unknown tool "${name}"` }], isError: true };
  }

  try {
    const validatedArgs = tool.inputSchema.parse(args ?? {});
    const result = await tool.handler(validatedArgs);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (err) {
    let msg = err instanceof z.ZodError
      ? `Validation error: ${err.errors.map(e => `${e.path.join('.') || 'root'}: ${e.message}`).join(', ')}`
      : `Error: ${err.message}`;

    if (err instanceof z.ZodError && name === 'ask_gemini') {
      msg += `\n\nExpected structure for ask_gemini:
{
  "prompt": "Your question/instruction here (string, required)",
  "context": [
    {
      "type": "skill" | "data" | "text",
      "text": "Your context content here (string)"
    }
  ] (array of objects, max 5, optional),
  "model": "exact-model-id" (string, optional)
}

NOTE: "context" should be a raw JSON array of objects, not a JSON-stringified string. A stringified array is tolerated as a fallback, but sending it raw avoids this validation error entirely.`;
    }

    return { content: [{ type: 'text', text: msg }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
