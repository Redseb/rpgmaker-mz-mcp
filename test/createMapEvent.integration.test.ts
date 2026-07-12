import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { blankEventPage, normalizeEventPage, mapToolDefinitions } from '../src/tools/mapTools.js';
import { MapEvent } from '../src/utils/types.js';

describe('normalizeEventPage (partial-page merge)', () => {
  it('fills every field of a blank page from an empty partial', () => {
    expect(normalizeEventPage({})).toEqual(blankEventPage());
  });

  it('overwrites top-level fields while deep-merging image and conditions', () => {
    const page = normalizeEventPage({
      trigger: 3,
      priorityType: 1,
      image: { characterName: 'Actor1', characterIndex: 2 },
      conditions: { switch1Valid: true, switch1Id: 5 },
    });
    expect(page.trigger).toBe(3);
    expect(page.priorityType).toBe(1);
    // image deep-merges: supplied fields set, the rest keep blank defaults.
    expect(page.image).toEqual({
      characterName: 'Actor1',
      characterIndex: 2,
      direction: 2,
      pattern: 0,
      tileId: 0,
    });
    // conditions deep-merges too.
    expect(page.conditions.switch1Valid).toBe(true);
    expect(page.conditions.switch1Id).toBe(5);
    expect(page.conditions.actorId).toBe(1); // untouched default
    // an omitted list falls back to a valid code-0 terminated list.
    expect(page.list).toEqual([{ code: 0, indent: 0, parameters: [] }]);
  });

  it('round-trips a fully-built page unchanged (safe for create_npc)', () => {
    const full = blankEventPage();
    full.trigger = 4;
    expect(normalizeEventPage(full)).toEqual(full);
  });
});

describe('create_map_event handler (partial pages)', () => {
  let dir: string;

  async function scaffold(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), 'rpgmz-cme-'));
    await writeFile(join(d, 'game.rmmzproject'), 'RPGMZ 1.0.0');
    await mkdir(join(d, 'data'));
    await writeFile(join(d, 'data', 'System.json'), '{}');
    // A minimal map: events is a 1-indexed array with a null slot 0.
    await writeFile(
      join(d, 'data', 'Map001.json'),
      JSON.stringify({ width: 17, height: 13, data: [], events: [null] }),
    );
    return d;
  }

  beforeEach(async () => {
    dir = await scaffold();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('builds a valid event from a single partial page', async () => {
    const def = mapToolDefinitions.find((t) => t.name === 'create_map_event')!;
    const result = (await def.handler(
      { projectPath: dir },
      {
        mapId: 1,
        name: 'Sign',
        x: 3,
        y: 4,
        pages: [{ trigger: 0, image: { characterName: 'Actor1' } }],
      },
    )) as { event: MapEvent };

    expect(result.event.id).toBe(1);
    const page = result.event.pages[0];
    // The partial was completed: graphic set, everything else defaulted.
    expect(page.image.characterName).toBe('Actor1');
    expect(page.image.direction).toBe(2);
    expect(page.list).toEqual([{ code: 0, indent: 0, parameters: [] }]);
    expect(page.moveType).toBe(0);
    expect(page.walkAnime).toBe(true);
  });

  it('gives an event with no pages one blank page', async () => {
    const def = mapToolDefinitions.find((t) => t.name === 'create_map_event')!;
    const result = (await def.handler(
      { projectPath: dir },
      { mapId: 1, name: 'Empty', x: 0, y: 0 },
    )) as { event: MapEvent };
    expect(result.event.pages).toHaveLength(1);
    expect(result.event.pages[0]).toEqual(blankEventPage());
  });
});
