import { z } from 'zod';
import { ToolDefinition } from '../registry.js';
import {
  PLUGIN_COMMAND_REGISTRY,
  buildPluginCommand,
  validatePluginCommand,
} from '../validation/pluginCommands.js';

/**
 * The known-plugin allowlist, or a single plugin's entry when `pluginName` is
 * given. Read-only view of {@link PLUGIN_COMMAND_REGISTRY} so a caller can
 * discover which plugin commands `create_plugin_command` will validate.
 */
export function listPluginCommands(pluginName?: string): unknown {
  if (pluginName === undefined) {
    return PLUGIN_COMMAND_REGISTRY;
  }
  const plugin = PLUGIN_COMMAND_REGISTRY[pluginName];
  if (!plugin) {
    throw new Error(`Plugin "${pluginName}" is not in the known-plugin allowlist`);
  }
  return { [pluginName]: plugin };
}

export const pluginToolDefinitions: ToolDefinition[] = [
  {
    name: 'list_plugin_commands',
    description:
      'List the curated allowlist of known plugin commands (plugin filename → command key → args) that create_plugin_command can validate. Pass pluginName to narrow to one plugin. Read-only. Note the allowlist is a starter set, not exhaustive — an unlisted plugin command can still be built, it just isn’t validated.',
    inputSchema: {
      pluginName: z
        .string()
        .optional()
        .describe('Optional: restrict to one plugin (its filename without .js)'),
    },
    handler: async (_ctx, args) => listPluginCommands(args.pluginName),
  },
  {
    name: 'create_plugin_command',
    description:
      'Build an RPG Maker MZ plugin command (event command code 357) for insertion into an event page via add_event_command. Validates against the known-plugin allowlist (warn-by-default: an unlisted plugin/command, a missing required arg, or a stray arg produces a warning but never blocks). Args are normalized to the editor’s string-valued shape. Read-only: returns { command, warnings? }, writes nothing.',
    inputSchema: {
      pluginName: z.string().describe('Plugin filename without .js (event command parameters[0])'),
      commandName: z
        .string()
        .describe('The command key the plugin registered (event command parameters[1])'),
      args: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Command arguments as { name: value }; values are stored as strings on disk'),
      label: z
        .string()
        .optional()
        .describe('Editor display label (parameters[2]); defaults to the command key'),
      indent: z
        .number()
        .int()
        .optional()
        .describe('Indentation level in the target list (default 0)'),
    },
    handler: async (_ctx, args) => {
      const argValues = (args.args as Record<string, unknown> | undefined) ?? {};
      const command = buildPluginCommand(
        args.pluginName,
        args.commandName,
        argValues,
        args.indent ?? 0,
        args.label,
      );
      const warnings = validatePluginCommand(args.pluginName, args.commandName, argValues);
      return warnings.length > 0 ? { command, warnings } : { command };
    },
  },
];
