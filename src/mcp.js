// mcp.js — entry point, mcp-google-gemini v2.0
// SDK: @modelcontextprotocol/sdk

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
import { Config } from './Config.js';
import { AskGemini } from './Tools/AskGemini.js';
import { ListModels } from './Tools/ListModels.js';
import { GeminiStatus } from './Tools/GeminiStatus.js';

const ToolDefinitions = [AskGemini, ListModels, GeminiStatus];
const handlers = new Map(ToolDefinitions.map(t => [t.name, t.handler.bind(t)]));

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
  const handler = handlers.get(name);

  if (!handler) {
    return { content: [{ type: 'text', text: `Error: Unknown tool "${name}"` }], isError: true };
  }

  try {
    const result = await handler(args ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (err) {
    const msg = err instanceof z.ZodError
      ? `Validation error: ${err.errors.map(e => e.message).join(', ')}`
      : `Error: ${err.message}`;
    return { content: [{ type: 'text', text: msg }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
