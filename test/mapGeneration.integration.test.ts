import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CommitContext, commitStore } from '../src/utils/commit.js';
import { MapData, Tileset } from '../src/utils/types.js';
import { blankMapData, createMap } from '../src/tools/mapTools.js';
import * as mapTools from '../src/tools/mapTools.js';
import * as paint from '../src/tiles/paint.js';
import {
  generateDungeonMap,
  generateMapFromTemplate,
  mapGenerationToolDefinitions,
} from '../src/tools/mapGenerationTools.js';

const failure = vi.hoisted(() => ({ destination: '', cleanup: false, collide: '', editInfos: '' }));
vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>();
  return {
    ...actual,
    link: async (from: string, to: string) => {
      if (to === failure.collide) {
        failure.collide = '';
        await actual.writeFile(to, '{"external":true}');
      }
      await actual.link(from, to);
      if (failure.editInfos) {
        const path = failure.editInfos;
        failure.editInfos = '';
        const infos = JSON.parse(await actual.readFile(path, 'utf8'));
        infos[1].name = 'External edit';
        await actual.writeFile(path, JSON.stringify(infos));
      }
    },
    unlink: async (path: string) => {
      if (failure.cleanup && path.includes('.mcp-stage-')) {
        failure.cleanup = false;
        throw new Error('Injected stage cleanup failure');
      }
      return actual.unlink(path);
    },
    rename: async (from: string, to: string) => {
      if (to === failure.destination) {
        failure.destination = '';
        throw new Error('Injected MapInfos replacement failure');
      }
      return actual.rename(from, to);
    },
  };
});
let project: string;
const options = {
  name: 'Cave',
  width: 31,
  height: 25,
  tilesetId: 1,
  seed: 'test-seed',
  tileProfile: { floorTileId: 1536, wallTileId: 1537 },
  roomCount: 5,
  minRoomSize: 4,
  maxRoomSize: 6,
};
async function json<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(project, 'data', name), 'utf8')) as T;
}
async function save(name: string, value: unknown) {
  await writeFile(join(project, 'data', name), JSON.stringify(value));
}
async function snapshot() {
  const names = await readdir(join(project, 'data'));
  return Promise.all(
    names.sort().map(async (name) => [name, await readFile(join(project, 'data', name), 'utf8')]),
  );
}
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'mz-generated-map-'));
  await mkdir(join(project, 'data'));
  await mkdir(join(project, 'img', 'tilesets'), { recursive: true });
  await writeFile(
    join(project, 'img', 'tilesets', 'Synthetic.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const flags = new Array(8192).fill(0);
  flags[0] = 16;
  flags[1537] = 15;
  for (let tile = 4352; tile < 5888; tile++) flags[tile] = 15;
  await save('Tilesets.json', [
    null,
    {
      id: 1,
      name: 'Synthetic',
      mode: 1,
      flags,
      tilesetNames: [
        'Synthetic',
        'Synthetic',
        'Synthetic',
        'Synthetic',
        'Synthetic',
        'Synthetic',
        '',
        '',
        '',
      ],
    },
  ]);
  await save('MapInfos.json', [
    null,
    { id: 1, name: 'Source', parentId: 0, order: 1, expanded: false, scrollX: 0, scrollY: 0 },
  ]);
  const map = blankMapData(5, 4, 1);
  map.data.fill(1536, 0, 20);
  map.note = '<PluginBehavior>';
  map.autoplayBgm = true;
  map.parallaxName = 'Secret';
  await save('Map001.json', map);
});
afterEach(async () => {
  failure.destination = '';
  failure.cleanup = false;
  failure.collide = '';
  failure.editInfos = '';
  await rm(project, { recursive: true, force: true });
});

describe('seeded and project-derived generation', () => {
  it('generates connected geometry deterministically with metadata-only design markers', async () => {
    const first = await generateDungeonMap(project, options);
    const second = await generateDungeonMap(project, { ...options, name: 'Second' });
    expect(first.layout.componentCount).toBe(1);
    expect(first.layout.unreachablePassableCells).toBe(0);
    expect(first.markers.map((marker) => marker.role)).toEqual([
      'entrance',
      'key',
      'door',
      'boss',
      'exit',
    ]);
    expect(first.markers.every((marker) => marker.metadataOnly)).toBe(true);
    const mapA = await json<MapData>('Map002.json'),
      mapB = await json<MapData>('Map003.json');
    expect(mapA.data).toEqual(mapB.data);
    expect(mapA.note).toEqual(mapB.note);
    expect(mapA.events).toEqual([null]);
    expect(second.mapId).toBe(3);
  });
  it('different seeds change geometry', async () => {
    await generateDungeonMap(project, options);
    await generateDungeonMap(project, { ...options, seed: 'another-seed' });
    expect((await json<MapData>('Map002.json')).data).not.toEqual(
      (await json<MapData>('Map003.json')).data,
    );
  });
  it('keeps all five metadata markers distinct in a single minimum-size room', async () => {
    const result = await generateDungeonMap(project, {
      ...options,
      width: 9,
      height: 9,
      roomCount: 1,
      minRoomSize: 3,
      maxRoomSize: 3,
    });
    expect(new Set(result.markers.map((marker) => `${marker.x},${marker.y}`)).size).toBe(5);
  });
  it('previews both files with no new files or changes', async () => {
    const before = await snapshot();
    const context: CommitContext = { dryRun: true, commits: [] };
    const result = await commitStore.run(context, () => generateDungeonMap(project, options));
    expect(result.dryRun).toBe(true);
    expect(context.commits).toHaveLength(2);
    expect(context.commits.map((commit) => commit.path)).toEqual([
      join(project, 'data', 'Map002.json'),
      join(project, 'data', 'MapInfos.json'),
    ]);
    expect(await snapshot()).toEqual(before);
  });
  it.each([
    { width: 0 },
    { tilesetId: 2 },
    { parentId: 999 },
    { tileProfile: { floorTileId: 1537, wallTileId: 1536 } },
    { tileProfile: { floorTileId: 1024, wallTileId: 1537 } },
    { tileProfile: { floorTileId: 1664, wallTileId: 1537 } },
    { minRoomSize: 8, maxRoomSize: 4 },
    { width: 9, minRoomSize: 8 },
  ])('rejects invalid options/profile/reference before writes %j', async (changes) => {
    const before = await snapshot();
    await expect(generateDungeonMap(project, { ...options, ...changes })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it('rejects missing assigned sheets and invalid autotile flags', async () => {
    await rm(join(project, 'img', 'tilesets', 'Synthetic.png'));
    const before = await snapshot();
    await expect(generateDungeonMap(project, options)).rejects.toThrow(/missing/);
    expect(await snapshot()).toEqual(before);
  });
  it('uses autotile shape solver and verifies all profile shape flags', async () => {
    const result = await generateDungeonMap(project, {
      ...options,
      tileProfile: { floorTileId: 2816, wallTileId: 4352 },
    });
    expect(result.layout.componentCount).toBe(1);
    const map = await json<MapData>('Map002.json');
    expect(new Set(map.data.slice(0, map.width * map.height)).size).toBeGreaterThan(2);
    const tilesets = await json<(Tileset | null)[]>('Tilesets.json');
    tilesets[1]!.flags[2817] = 15;
    await save('Tilesets.json', tilesets);
    await expect(
      generateDungeonMap(project, {
        ...options,
        tileProfile: { floorTileId: 2816, wallTileId: 4352 },
      }),
    ).rejects.toThrow(/passable/);
  });
  it('refuses orphan map-file collisions', async () => {
    await save('Map002.json', { preserve: true });
    const before = await snapshot();
    await expect(generateDungeonMap(project, options)).rejects.toThrow(/overwrite/);
    expect(await snapshot()).toEqual(before);
  });
  it('serializes simultaneous creations so map IDs and tree entries remain distinct', async () => {
    const results = await Promise.all([
      generateDungeonMap(project, options),
      generateDungeonMap(project, { ...options, name: 'Other' }),
    ]);
    expect(results.map((result) => result.mapId).sort()).toEqual([2, 3]);
    expect((await json<unknown[]>('MapInfos.json')).filter(Boolean)).toHaveLength(3);
  });
  it('rolls back the new map if publishing MapInfos fails', async () => {
    const before = await snapshot();
    failure.destination = join(project, 'data', 'MapInfos.json');
    await expect(generateDungeonMap(project, options)).rejects.toThrow(/Injected/);
    expect(await snapshot()).toEqual(before);
  });
  it('copies/remaps only layout fields, leaving source bytes unchanged', async () => {
    const source = await readFile(join(project, 'data', 'Map001.json'), 'utf8');
    const result = await generateMapFromTemplate(project, {
      name: 'Remap',
      sourceMapId: 1,
      tileRemap: [{ from: 1536, to: 1538 }],
    });
    const map = await json<MapData>('Map002.json');
    expect(result.remappedCells).toBe(20);
    expect(map.data.slice(0, 20)).toEqual(new Array(20).fill(1538));
    expect(map.events).toEqual([null]);
    expect(map.encounterList).toEqual([]);
    expect(map.note).not.toContain('PluginBehavior');
    expect(map.autoplayBgm).toBe(false);
    expect(map.parallaxName).toBe('');
    expect(await readFile(join(project, 'data', 'Map001.json'), 'utf8')).toBe(source);
  });
  it('rejects duplicate template remaps without writes and previews valid copies', async () => {
    const before = await snapshot();
    await expect(
      generateMapFromTemplate(project, {
        name: 'Bad',
        sourceMapId: 1,
        tileRemap: [
          { from: 1536, to: 1538 },
          { from: 1536, to: 1539 },
        ],
      }),
    ).rejects.toThrow(/Duplicate/);
    expect(await snapshot()).toEqual(before);
    const context: CommitContext = { dryRun: true, commits: [] };
    await commitStore.run(context, () =>
      generateMapFromTemplate(project, { name: 'Preview', sourceMapId: 1 }),
    );
    expect(context.commits).toHaveLength(2);
    expect(await snapshot()).toEqual(before);
  });
  it('exports only the two focused generation tools', async () => {
    expect(mapGenerationToolDefinitions.every((def) => def.mutates)).toBe(true);
    expect(mapGenerationToolDefinitions.map((def) => def.name)).toEqual([
      'generate_dungeon_map',
      'generate_map_from_template',
    ]);
  });

  it('uses shared createMap and applyAutotiling rather than parallel writers or shape solvers', async () => {
    const create = vi.spyOn(mapTools, 'createMap');
    const autotile = vi.spyOn(paint, 'applyAutotiling');
    try {
      await generateDungeonMap(project, options);
      await generateMapFromTemplate(project, {
        name: 'Template',
        sourceMapId: 1,
        tileRemap: [{ from: 1536, to: 2816 }],
      });
      expect(create).toHaveBeenCalledTimes(2);
      expect(autotile).toHaveBeenCalledTimes(2);
    } finally {
      create.mockRestore();
      autotile.mockRestore();
    }
  });

  it('shares ID allocation across ordinary, template and dungeon creation', async () => {
    const results = await Promise.all([
      createMap(project, { name: 'Blank' }),
      generateMapFromTemplate(project, { name: 'Copy', sourceMapId: 1 }),
      generateDungeonMap(project, options),
    ]);
    expect(results.map((result) => result.mapId).sort()).toEqual([2, 3, 4]);
    expect((await json<unknown[]>('MapInfos.json')).filter(Boolean)).toHaveLength(4);
  });

  it('rolls back ordinary create_map through the same creation path', async () => {
    const before = await snapshot();
    const context: CommitContext = { dryRun: false, commits: [] };
    failure.destination = join(project, 'data', 'MapInfos.json');
    await expect(
      commitStore.run(context, () => createMap(project, { name: 'Blank' })),
    ).rejects.toThrow(/Injected/);
    expect(await snapshot()).toEqual(before);
    expect(context.commits).toEqual([]);
    expect((await createMap(project, { name: 'Retry' })).mapId).toBe(2);
  });

  it('refuses a map-file collision that appears after ID allocation', async () => {
    const infos = await readFile(join(project, 'data', 'MapInfos.json'), 'utf8');
    failure.collide = join(project, 'data', 'Map002.json');
    await expect(generateDungeonMap(project, options)).rejects.toThrow(/EEXIST/);
    expect(await json('Map002.json')).toEqual({ external: true });
    expect(await readFile(join(project, 'data', 'MapInfos.json'), 'utf8')).toBe(infos);
    expect(
      (await readdir(join(project, 'data'))).some((name) => name.includes('.mcp-stage-')),
    ).toBe(false);
  });

  it('preserves an intervening tree edit and rolls back the newly created map', async () => {
    failure.editInfos = join(project, 'data', 'MapInfos.json');
    await expect(generateDungeonMap(project, options)).rejects.toThrow(
      /changed during map creation/,
    );
    expect((await json<(null | { name: string })[]>('MapInfos.json'))[1]!.name).toBe(
      'External edit',
    );
    expect(await readdir(join(project, 'data'))).not.toContain('Map002.json');
    expect(
      (await readdir(join(project, 'data'))).some((name) => name.includes('.mcp-stage-')),
    ).toBe(false);
  });

  it('does not report a successful publication as failed when staging cleanup fails', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      failure.cleanup = true;
      const result = await generateDungeonMap(project, options);
      expect(result.mapId).toBe(2);
      expect((await json<MapData>('Map002.json')).width).toBe(options.width);
      expect((await json<(null | { id: number })[]>('MapInfos.json'))[2]!.id).toBe(2);
      expect(diagnostic).toHaveBeenCalledWith(
        expect.stringContaining('Unable to remove staging file'),
      );
    } finally {
      diagnostic.mockRestore();
    }
  });

  it('rejects malformed map-tree indices before writing', async () => {
    await save('MapInfos.json', [null, { id: 7, name: 'Wrong slot', order: 1 }]);
    const before = await snapshot();
    await expect(generateDungeonMap(project, options)).rejects.toThrow(/indexes/);
    expect(await snapshot()).toEqual(before);
  });

  it('preserves all six template layers and scroll type; remapping touches only tiles', async () => {
    const source = await json<MapData>('Map001.json');
    source.scrollType = 3;
    source.data[20] = 1536;
    source.data[40] = 1536;
    source.data[60] = 1536;
    source.data[80] = 15;
    source.data[100] = 255;
    await save('Map001.json', source);
    await generateMapFromTemplate(project, {
      name: 'All layers',
      sourceMapId: 1,
      tileRemap: [{ from: 1536, to: 1538 }],
    });
    const result = await json<MapData>('Map002.json');
    expect(result.data.length).toBe(120);
    expect([0, 20, 40, 60].map((index) => result.data[index])).toEqual([1538, 1538, 1538, 1538]);
    expect(result.data.slice(80)).toEqual(source.data.slice(80));
    expect(result.scrollType).toBe(3);
  });

  it('uses wrapped neighbors for autotiling on looping template maps', async () => {
    const source = await json<MapData>('Map001.json');
    source.scrollType = 3;
    await save('Map001.json', source);
    await generateMapFromTemplate(project, {
      name: 'Loop',
      sourceMapId: 1,
      tileRemap: [{ from: 1536, to: 2816 }],
    });
    expect((await json<MapData>('Map002.json')).data.slice(0, 20)).toEqual(
      new Array(20).fill(2816),
    );
  });

  it.each([
    [80, 16],
    [100, 256],
    [0, -1],
    [0, 8192],
  ])('rejects invalid layer domain %j before writes', async (index, value) => {
    const source = await json<MapData>('Map001.json');
    source.data[index] = value;
    await save('Map001.json', source);
    const before = await snapshot();
    await expect(
      generateMapFromTemplate(project, { name: 'Invalid', sourceMapId: 1 }),
    ).rejects.toThrow(/Invalid map data/);
    expect(await snapshot()).toEqual(before);
  });
});
