import { describe, it, expect } from 'vitest';
import {
  PLUGIN_COMMAND_CODE,
  PLUGIN_COMMAND_REGISTRY,
  lookupPluginCommand,
  normalizePluginArgs,
  validatePluginCommand,
  buildPluginCommand,
} from '../src/validation/pluginCommands.js';
import { listPluginCommands, pluginToolDefinitions } from '../src/tools/pluginTools.js';

describe('normalizePluginArgs', () => {
  it('stringifies scalars, JSON-stringifies objects, and drops null/undefined', () => {
    expect(
      normalizePluginArgs({
        text: 'hi',
        rows: 4,
        flag: true,
        struct: { a: 1 },
        list: [1, 2],
        skip: null,
        gone: undefined,
      }),
    ).toEqual({
      text: 'hi',
      rows: '4',
      flag: 'true',
      struct: '{"a":1}',
      list: '[1,2]',
    });
  });
});

describe('validatePluginCommand', () => {
  it('accepts a known command with its required arg present', () => {
    expect(validatePluginCommand('TextPicture', 'set', { text: 'hello' })).toEqual([]);
  });

  it('flags a missing required arg', () => {
    const warnings = validatePluginCommand('TextPicture', 'set', {});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: PLUGIN_COMMAND_CODE });
    expect(warnings[0].message).toMatch(/missing required argument "text"/);
  });

  it('flags a stray unknown arg', () => {
    const warnings = validatePluginCommand('TextPicture', 'set', { text: 'hi', bogus: 1 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/unknown argument "bogus"/);
  });

  it('soft-warns once for an unlisted plugin (no arg cascade)', () => {
    const warnings = validatePluginCommand('VisuMZ_9_Nonexistent', 'DoThing', { a: 1, b: 2 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/not in the known-plugin allowlist/);
  });

  it('soft-warns once for an unknown command of a listed plugin', () => {
    const warnings = validatePluginCommand('TextPicture', 'mystery', { text: 'x' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/not a known command/);
  });
});

describe('buildPluginCommand', () => {
  it('builds a well-formed 357 command with the registry label and string args', () => {
    const command = buildPluginCommand('TextPicture', 'set', { text: 'Hello \\V[1]' });
    expect(command).toEqual({
      code: 357,
      indent: 0,
      parameters: ['TextPicture', 'set', 'Set text picture', { text: 'Hello \\V[1]' }],
    });
  });

  it('honors an explicit label and indent, and defaults the label to the command key', () => {
    const command = buildPluginCommand('Unknown', 'go', { n: 3 }, 2, 'My Label');
    expect(command.indent).toBe(2);
    expect(command.parameters[2]).toBe('My Label');
    expect(buildPluginCommand('Unknown', 'go').parameters[2]).toBe('go');
  });
});

describe('lookupPluginCommand', () => {
  it('resolves a listed command and returns undefined otherwise', () => {
    expect(lookupPluginCommand('TextPicture', 'set')).toBeDefined();
    expect(lookupPluginCommand('TextPicture', 'nope')).toBeUndefined();
    expect(lookupPluginCommand('Nope', 'set')).toBeUndefined();
  });
});

describe('plugin tool handlers', () => {
  it('list_plugin_commands returns the whole allowlist or one plugin', () => {
    expect(listPluginCommands()).toBe(PLUGIN_COMMAND_REGISTRY);
    expect(listPluginCommands('TextPicture')).toEqual({
      TextPicture: PLUGIN_COMMAND_REGISTRY.TextPicture,
    });
    expect(() => listPluginCommands('Nope')).toThrow(/not in the known-plugin allowlist/);
  });

  it('create_plugin_command is read-only and returns the command with warnings', async () => {
    const def = pluginToolDefinitions.find((t) => t.name === 'create_plugin_command')!;
    expect(def.mutates).toBeUndefined();

    const clean = (await def.handler(
      { projectPath: '/unused' },
      { pluginName: 'TextPicture', commandName: 'set', args: { text: 'hi' } },
    )) as { command: unknown; warnings?: unknown[] };
    expect(clean.warnings).toBeUndefined();

    const warned = (await def.handler(
      { projectPath: '/unused' },
      { pluginName: 'TextPicture', commandName: 'set', args: {} },
    )) as { command: unknown; warnings?: unknown[] };
    expect(warned.warnings && warned.warnings.length).toBeGreaterThan(0);
  });
});
