import { EventCommand } from '../utils/types.js';
import { ValidationWarning } from './eventCommands.js';

/**
 * Event command code for an RPG Maker MZ plugin command. On disk a 357 command is
 * `{ code: 357, indent, parameters: [pluginName, commandName, label, args] }`:
 *   - parameters[0] — plugin filename without `.js` (e.g. `TextPicture`)
 *   - parameters[1] — the registered command key the plugin listens for
 *   - parameters[2] — the editor's display label (cosmetic; the engine ignores it)
 *   - parameters[3] — an args object `{ name: value }`; the editor stores every
 *     value as a string (structs/arrays are JSON-stringified into that string).
 * `command357` only reads [0], [1] and [3]; [2] is purely for the editor's list.
 */
export const PLUGIN_COMMAND_CODE = 357;

/** Spec for a single plugin-command argument. */
interface PluginArgSpec {
  name: string;
  required?: boolean;
  description?: string;
}

/** Spec for one registered plugin command. */
interface PluginCommandSpec {
  /** Display label the editor shows (parameters[2]); defaults to the command key. */
  label?: string;
  description?: string;
  args?: PluginArgSpec[];
}

/** A plugin's allowlist entry: a description plus its known commands. */
interface PluginSpec {
  description?: string;
  commands: Record<string, PluginCommandSpec>;
}

/**
 * Curated allowlist of known community/official plugin commands, keyed by plugin
 * filename → command key. Deliberately **not** exhaustive — it is a starter set
 * meant to grow. Its only job is to turn a specific plugin command from opaque
 * params into something `create_plugin_command` can validate (required args
 * present, no stray args) and label the way the editor would. A plugin command
 * that isn't listed here is still built fine — it just passes through with a soft
 * "not in the allowlist" warning (warn-by-default, mirroring unknown event codes).
 */
export const PLUGIN_COMMAND_REGISTRY: Record<string, PluginSpec> = {
  TextPicture: {
    description: 'Official MZ sample plugin — render text as a picture.',
    commands: {
      set: {
        label: 'Set text picture',
        description: 'Set the text drawn by the next Show Picture command.',
        args: [
          {
            name: 'text',
            required: true,
            description: 'The text to render (supports control characters like \\V[n]).',
          },
        ],
      },
    },
  },
};

/** Look up a plugin command spec, or `undefined` if the plugin/command is unlisted. */
export function lookupPluginCommand(
  pluginName: string,
  commandName: string,
): PluginCommandSpec | undefined {
  return PLUGIN_COMMAND_REGISTRY[pluginName]?.commands[commandName];
}

/**
 * Normalize a plugin-command args object into the exact on-disk shape the editor
 * writes: every value is a string. Scalars are stringified; objects/arrays (plugin
 * "struct" params) are JSON-stringified into a single string. `null`/`undefined`
 * values are dropped. A value that is already a string is left untouched (so a
 * caller may pre-stringify a struct if they prefer).
 */
export function normalizePluginArgs(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  return out;
}

/**
 * Validate a plugin command against the allowlist. Warn-by-default: an unlisted
 * plugin or command yields a single soft warning (its args pass through
 * unchecked); a listed command additionally flags missing required args and stray
 * unknown args. Nothing throws.
 */
export function validatePluginCommand(
  pluginName: string,
  commandName: string,
  args: Record<string, unknown>,
  path = `plugin command ${pluginName}: ${commandName}`,
): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  const plugin = PLUGIN_COMMAND_REGISTRY[pluginName];
  if (!plugin) {
    warnings.push({
      path,
      code: PLUGIN_COMMAND_CODE,
      message: `plugin "${pluginName}" is not in the known-plugin allowlist (args passed through unchecked)`,
    });
    return warnings;
  }

  const spec = plugin.commands[commandName];
  if (!spec) {
    warnings.push({
      path,
      code: PLUGIN_COMMAND_CODE,
      message: `command "${commandName}" is not a known command of plugin "${pluginName}" (args passed through unchecked)`,
    });
    return warnings;
  }

  const known = spec.args ?? [];
  const knownNames = new Set(known.map((a) => a.name));

  for (const arg of known) {
    if (arg.required && !(arg.name in args)) {
      warnings.push({
        path,
        code: PLUGIN_COMMAND_CODE,
        message: `missing required argument "${arg.name}"`,
      });
    }
  }

  for (const name of Object.keys(args)) {
    if (!knownNames.has(name)) {
      warnings.push({
        path,
        code: PLUGIN_COMMAND_CODE,
        message: `unknown argument "${name}" for ${pluginName}: ${commandName}`,
      });
    }
  }

  return warnings;
}

/**
 * Build the plugin-command event command (code 357) for insertion into an event
 * page via `add_event_command`. `label` defaults to the registry's display label
 * (or the command key). Args are normalized to the editor's string-valued shape.
 */
export function buildPluginCommand(
  pluginName: string,
  commandName: string,
  args: Record<string, unknown> = {},
  indent = 0,
  label?: string,
): EventCommand {
  const spec = lookupPluginCommand(pluginName, commandName);
  const displayLabel = label ?? spec?.label ?? commandName;
  return {
    code: PLUGIN_COMMAND_CODE,
    indent,
    parameters: [pluginName, commandName, displayLabel, normalizePluginArgs(args)],
  };
}
