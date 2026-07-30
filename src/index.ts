#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { basename } from 'path';
import { readFileSync } from 'fs';

import { validateProjectPath } from './utils/fileHandler.js';
import { ToolContext, ToolDefinition, buildRegistry, schemaFor } from './registry.js';
import { CommitContext, commitStore } from './utils/commit.js';
import { allToolDefinitions } from './tools/allTools.js';
import { loadProjectTextMetrics } from './tools/projectConfig.js';
import { setActiveTextMetrics } from './validation/textMetrics.js';

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
 * Advertised MCP server version, read from package.json so it tracks releases
 * instead of drifting from a hardcoded string. Resolved relative to this module
 * (dist/index.js → ../package.json). Falls back to '0.0.0' if unreadable.
 */
function serverVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

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
    // The handler's return value (e.g. `{ event, warnings }`) — surfaced so a
    // dry-run preview shows validation warnings that would otherwise be
    // discarded (the documented dry-run gap). Omitted when the handler returns
    // nothing.
    ...(result === undefined ? {} : { wouldReturn: result }),
  };
}

function buildServer(initialProjectPath: string): McpServer {
  const server = new McpServer({ name: 'rpgmaker-mz-server', version: serverVersion() });

  // The project path is session state, not a constant: it starts from the env
  // var and `set_project` may retarget it without a server restart.
  let projectPath = initialProjectPath;
  const setProjectPath = (path: string): void => {
    projectPath = path;
  };

  // Fail loudly on duplicate tool names before wiring anything up.
  buildRegistry(allToolDefinitions);

  for (const def of allToolDefinitions) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: schemaFor(def) },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          if (def.requiresProject !== false) {
            if (!projectPath) {
              throw new Error(
                'No project path set. Set RPGMAKER_PROJECT_PATH or call set_project.',
              );
            }
            if (!(await validateProjectPath(projectPath))) {
              throw new Error(`Invalid RPG Maker MZ project path: ${projectPath}`);
            }
            // Install this project's Show Text width metrics before anything runs.
            // The line-width check sits deep inside validateCommandList, which has no
            // project path in scope and eight call sites across six modules — setting
            // it once here beats making all of them async for a per-project constant.
            // Cached by mtime, fails soft to the built-in character estimate.
            setActiveTextMetrics(await loadProjectTextMetrics(projectPath));
          }

          const result = await runTool(def, { projectPath, setProjectPath }, args);
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
