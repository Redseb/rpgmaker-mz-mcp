import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildRegistry, schemaFor, DRY_RUN_SHAPE, ToolDefinition } from '../src/registry.js';
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
});

describe('tool registry contract', () => {
  it('exposes the expected number of tools', () => {
    expect(allToolDefinitions.length).toBe(108);
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
