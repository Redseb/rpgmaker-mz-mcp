#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { basename } from 'path';

import { validateProjectPath } from './utils/fileHandler.js';
import { ToolContext, ToolDefinition, buildRegistry, schemaFor } from './registry.js';
import { CommitContext, commitStore } from './utils/commit.js';
import { allToolDefinitions } from './tools/allTools.js';

/**
 * RPG Maker MZ MCP Server
 *
 * A Model Context Protocol server for reading and writing RPG Maker MZ project
 * data. Tool schemas (Zod) and handlers live in each `tools/*` module and are
 * registered here on a high-level `McpServer`, which validates incoming
 * arguments against each tool's schema before its handler runs.
 */

const PROJECT_PATH = process.env.RPGMAKER_PROJECT_PATH || '';

/**
 * Run a tool. Mutating tools execute inside a commit context so that, when
 * `dryRun` is requested, every write is intercepted and returned as a preview
 * diff instead of being applied.
 */
async function runTool(
  tool: ToolDefinition,
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!tool.mutates) {
    return tool.handler(ctx, args);
  }

  const dryRun = args.dryRun === true;
  const commitCtx: CommitContext = { dryRun, commits: [] };
  const result = await commitStore.run(commitCtx, () => tool.handler(ctx, args));

  if (!dryRun) {
    return result;
  }

  return {
    dryRun: true,
    wouldChange: commitCtx.commits.map((commit) => ({
      file: basename(commit.path),
      changed: commit.changed,
      ...(commit.deleted ? { deleted: true } : {}),
      diff: commit.diff,
    })),
  };
}

function buildServer(projectPath: string): McpServer {
  const server = new McpServer({ name: 'rpgmaker-mz-server', version: '1.0.0' });

  // Fail loudly on duplicate tool names before wiring anything up.
  buildRegistry(allToolDefinitions);

  for (const def of allToolDefinitions) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: schemaFor(def) },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          if (!projectPath) {
            throw new Error('RPGMAKER_PROJECT_PATH environment variable not set');
          }
          if (!(await validateProjectPath(projectPath))) {
            throw new Error('Invalid RPG Maker MZ project path');
          }

          const result = await runTool(def, { projectPath }, args);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
        }
      },
    );
  }

  return server;
}

async function main(): Promise<void> {
  const server = buildServer(PROJECT_PATH);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('RPG Maker MZ MCP server running on stdio');
}

main().catch((error) => {
  console.error('[MCP Fatal]', error);
  process.exit(1);
});
