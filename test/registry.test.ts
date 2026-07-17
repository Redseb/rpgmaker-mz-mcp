import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  buildRegistry,
  schemaFor,
  DRY_RUN_SHAPE,
  FORCE_SHAPE,
  ToolDefinition,
} from '../src/registry.js';
import { allToolDefinitions } from '../src/tools/allTools.js';

const dummy: ToolDefinition = {
  name: 'dummy',
  description: 'test',
  inputSchema: {},
  handler: async () => ({ ok: true }),
};

describe('buildRegistry', () => {
  it('indexes definitions by name', () => {
    const registry = buildRegistry([dummy]);
    expect(registry.get('dummy')).toBe(dummy);
  });

  it('throws on duplicate tool names', () => {
    expect(() => buildRegistry([dummy, { ...dummy }])).toThrow(/Duplicate tool definition: dummy/);
  });
});

describe('schemaFor', () => {
  it('returns the tool schema unchanged for read-only tools', () => {
    const shape = schemaFor(dummy);
    expect('dryRun' in shape).toBe(false);
  });

  it('folds the shared dryRun argument into mutating tools', () => {
    const mutating: ToolDefinition = { ...dummy, mutates: true, inputSchema: { x: z.number() } };
    const shape = schemaFor(mutating);
    expect(Object.keys(shape).sort()).toEqual(['dryRun', 'x']);
    expect(shape.dryRun).toBe(DRY_RUN_SHAPE.dryRun);
  });

  it('folds `force` only into mutating tools that gate on validation', () => {
    // A mutating tool that never refuses a write must not advertise `force` —
    // the argument would do nothing.
    const plain: ToolDefinition = { ...dummy, mutates: true, inputSchema: { x: z.number() } };
    expect('force' in schemaFor(plain)).toBe(false);

    const gated: ToolDefinition = { ...plain, forceable: true };
    const shape = schemaFor(gated);
    expect(Object.keys(shape).sort()).toEqual(['dryRun', 'force', 'x']);
    expect(shape.force).toBe(FORCE_SHAPE.force);
  });

  it('never marks a read-only tool forceable', () => {
    for (const tool of allToolDefinitions) {
      if (tool.forceable) {
        expect(tool.mutates, `${tool.name} is forceable but not mutating`).toBe(true);
      }
    }
  });
});

describe('tool registry contract', () => {
  it('exposes the expected number of tools', () => {
    expect(allToolDefinitions.length).toBe(115);
  });

  it('only the project-targeting tools opt out of the project-path gate', () => {
    const optOuts = allToolDefinitions
      .filter((t) => t.requiresProject === false)
      .map((t) => t.name)
      .sort();
    expect(optOuts).toEqual(['get_project', 'set_project']);
  });

  it('has unique tool names', () => {
    const names = allToolDefinitions.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('builds a registry without throwing (no duplicate names)', () => {
    expect(() => buildRegistry(allToolDefinitions)).not.toThrow();
  });

  it('every tool has a valid name, description, Zod shape, and handler', () => {
    for (const tool of allToolDefinitions) {
      expect(tool.name, `${tool.name} name`).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(0);
      expect(typeof tool.inputSchema, `${tool.name} schema`).toBe('object');
      for (const [key, schema] of Object.entries(tool.inputSchema)) {
        expect(schema instanceof z.ZodType, `${tool.name}.${key} is a Zod type`).toBe(true);
      }
      expect(typeof tool.handler, `${tool.name} handler`).toBe('function');
    }
  });
});
