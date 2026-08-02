import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  condense,
  commandListShape,
  eventShape,
  mapShape,
  summarizeCommandListResult,
  summarizeCommonEventResult,
  summarizeEventResult,
  summarizeMapResult,
  summarizeTroopResult,
} from '../src/utils/responseSummary.js';
import { schemaFor, shapeResult, VERBOSE_SHAPE, ToolDefinition } from '../src/registry.js';
import { allToolDefinitions } from '../src/tools/allTools.js';
import type { EventCommand, MapEvent, EventPage } from '../src/utils/types.js';

const cmd = (code: number, parameters: unknown[] = []): EventCommand => ({
  code,
  indent: 0,
  parameters,
});

function page(overrides: Partial<EventPage> = {}): EventPage {
  return {
    conditions: {
      actorId: 1,
      actorValid: false,
      itemId: 1,
      itemValid: false,
      selfSwitchCh: 'A',
      selfSwitchValid: false,
      switch1Id: 1,
      switch1Valid: false,
      switch2Id: 1,
      switch2Valid: false,
      variableId: 1,
      variableValid: false,
      variableValue: 0,
    },
    directionFix: false,
    image: { characterIndex: 0, characterName: '', direction: 2, pattern: 0, tileId: 0 },
    list: [cmd(0)],
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 3,
    moveType: 0,
    priorityType: 0,
    stepAnime: false,
    through: false,
    trigger: 0,
    walkAnime: true,
    ...overrides,
  } as EventPage;
}

describe('condense', () => {
  it('rewrites named keys and passes every other key through', () => {
    const out = condense({ event: { big: true }, warnings: ['w'] }, { event: () => 'small' });
    expect(out).toEqual({ event: 'small', warnings: ['w'] });
  });

  it('skips a rewriter whose key is absent', () => {
    expect(condense({ a: 1 }, { b: () => 'x' })).toEqual({ a: 1 });
  });

  it('leaves non-objects alone', () => {
    expect(condense(null, { a: () => 1 })).toBe(null);
    expect(condense(7, { a: () => 1 })).toBe(7);
    expect(condense([1, 2], { a: () => 1 })).toEqual([1, 2]);
  });
});

describe('commandListShape', () => {
  it('keeps the codes and drops the parameters', () => {
    const list = [cmd(101, ['Fa_People17', 0, 0, 2, '\\N[1]']), cmd(401, ['a line']), cmd(0)];
    expect(commandListShape(list)).toEqual({ length: 3, codes: [101, 401, 0] });
  });
});

describe('eventShape', () => {
  const event: MapEvent = {
    id: 5,
    name: 'EV005 The Scavenger',
    note: '',
    x: 24,
    y: 10,
    pages: [
      page({
        trigger: 0,
        priorityType: 1,
        image: {
          characterIndex: 7,
          characterName: 'Ch_People11',
          direction: 4,
          pattern: 1,
          tileId: 0,
        },
        list: [cmd(101, ['Fa_People11', 4]), cmd(401, ['You came up the cut.']), cmd(0)],
      }),
      page({ trigger: 3, list: [cmd(0)] }),
    ],
  };

  it('keeps identity, position and per-page behaviour', () => {
    expect(eventShape(event)).toEqual({
      id: 5,
      name: 'EV005 The Scavenger',
      x: 24,
      y: 10,
      pageCount: 2,
      pages: [
        {
          index: 0,
          trigger: 0,
          priorityType: 1,
          moveType: 0,
          characterName: 'Ch_People11',
          characterIndex: 7,
          listLength: 3,
        },
        { index: 1, trigger: 3, priorityType: 0, moveType: 0, listLength: 1 },
      ],
    });
  });

  it('drops command parameters entirely', () => {
    // The page graphic survives (it is behaviour); the dialogue inside the
    // command list does not (it is what the caller just wrote).
    const json = JSON.stringify(eventShape(event));
    expect(json).toContain('Ch_People11');
    expect(json).not.toContain('You came up the cut.');
    expect(json).not.toContain('Fa_People11');
  });

  it('omits the graphic keys when the page has no sprite', () => {
    const bare = eventShape({ ...event, pages: [page()] });
    expect((bare.pages as Record<string, unknown>[])[0]).not.toHaveProperty('characterName');
  });
});

describe('mapShape', () => {
  it('replaces the events array with a count of the real events', () => {
    const out = mapShape({ width: 26, height: 20, events: [null, { id: 1 }, { id: 2 }] } as never);
    expect(out).toEqual({ width: 26, height: 20, eventCount: 2 });
  });

  it('reports zero when a map has no events array at all', () => {
    expect(mapShape({ width: 4 } as never)).toEqual({ width: 4, eventCount: 0 });
  });
});

describe('result summarizers', () => {
  it('summarizeEventResult keeps warnings alongside the condensed event', () => {
    const result = summarizeEventResult({
      event: { id: 1, name: 'n', note: '', x: 0, y: 0, pages: [page()] },
      warnings: [{ path: 'p', message: 'm' }],
    }) as Record<string, unknown>;
    expect(result.warnings).toEqual([{ path: 'p', message: 'm' }]);
    expect((result.event as Record<string, unknown>).pageCount).toBe(1);
  });

  it('summarizeMapResult drops events but keeps dataTileCount', () => {
    const out = summarizeMapResult({
      tilesetId: 2,
      dataTileCount: 3120,
      events: [null, { id: 1 }],
    }) as Record<string, unknown>;
    expect(out).toEqual({ tilesetId: 2, dataTileCount: 3120, eventCount: 1 });
  });

  it('summarizeCommandListResult swaps `list` for a length and codes', () => {
    const out = summarizeCommandListResult({
      target: 'map_event',
      id: 5,
      list: [cmd(101, ['long text']), cmd(401, ['more long text']), cmd(0)],
    });
    expect(out).toEqual({
      target: 'map_event',
      id: 5,
      listLength: 3,
      listCodes: [101, 401, 0],
    });
  });

  it('summarizeCommandListResult leaves a result with no list alone', () => {
    expect(summarizeCommandListResult({ id: 1 })).toEqual({ id: 1 });
  });

  it('summarizeCommonEventResult keeps the trigger wiring', () => {
    const out = summarizeCommonEventResult({
      commonEvent: { id: 5, name: 'Rite', trigger: 0, switchId: 1, list: [cmd(101), cmd(0)] },
    }) as Record<string, unknown>;
    expect(out.commonEvent).toEqual({
      id: 5,
      name: 'Rite',
      trigger: 0,
      switchId: 1,
      listLength: 2,
      listCodes: [101, 0],
    });
  });

  it('summarizeTroopResult keeps members and reduces battle-event pages', () => {
    const out = summarizeTroopResult({
      troop: {
        id: 22,
        name: 'A2 Skeleton + Ghost',
        members: [{ enemyId: 17, x: 300, y: 330, hidden: false }],
        pages: [{ list: [cmd(108, ['a long comment row']), cmd(0)] }],
      },
    }) as Record<string, unknown>;
    expect(out.troop).toEqual({
      id: 22,
      name: 'A2 Skeleton + Ghost',
      members: [{ enemyId: 17, x: 300, y: 330, hidden: false }],
      pages: [{ index: 0, listLength: 2 }],
    });
  });
});

const dummy: ToolDefinition = {
  name: 'dummy',
  description: 'test',
  inputSchema: {},
  handler: async () => ({ ok: true }),
};

describe('verbose wiring', () => {
  const summarizing: ToolDefinition = {
    ...dummy,
    mutates: true,
    inputSchema: { x: z.number() },
    summarize: () => ({ small: true }),
  };

  it('advertises `verbose` only on tools that condense their result', () => {
    expect('verbose' in schemaFor({ ...dummy, mutates: true })).toBe(false);
    const shape = schemaFor(summarizing);
    expect(Object.keys(shape).sort()).toEqual(['dryRun', 'verbose', 'x']);
    expect(shape.verbose).toBe(VERBOSE_SHAPE.verbose);
  });

  it('summarizes by default and returns the full record on verbose: true', () => {
    const full = { big: 'record' };
    expect(shapeResult(summarizing, full, {})).toEqual({ small: true });
    expect(shapeResult(summarizing, full, { verbose: true })).toBe(full);
  });

  it('leaves a tool without a summarizer untouched', () => {
    const full = { big: 'record' };
    expect(shapeResult({ ...dummy, mutates: true }, full, {})).toBe(full);
  });

  it('does not invent a result for a handler that returned nothing', () => {
    expect(shapeResult(summarizing, undefined, {})).toBeUndefined();
  });
});

describe('registry contract for summarizers', () => {
  it('every summarizer is on a mutating tool', () => {
    for (const tool of allToolDefinitions) {
      if (tool.summarize) {
        expect(tool.mutates, `${tool.name} summarizes but is not mutating`).toBe(true);
      }
    }
  });

  it('covers the write tools that would otherwise echo a command list or an events map', () => {
    const summarizing = allToolDefinitions
      .filter((t) => t.summarize)
      .map((t) => t.name)
      .sort();
    expect(summarizing).toEqual([
      'add_event_command',
      'create_common_event',
      'create_troop',
      'insert_event_commands',
      'resize_map',
      'set_event_page',
      'update_common_event',
      'update_map',
      'update_map_event',
      'update_troop',
    ]);
  });
});
