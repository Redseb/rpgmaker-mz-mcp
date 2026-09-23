import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LayerAccess, applyAutotiling } from '../src/tiles/paint.js';
import {
  TILE_ID,
  makeAutotileId,
  getAutotileShape,
  getAutotileKind,
} from '../src/tiles/tileCodec.js';
import { blankMapData, getMap, tileIndex, mapToolDefinitions } from '../src/tools/mapTools.js';
import { paintToolDefinitions } from '../src/tools/paintTools.js';

/** A LayerAccess backed by a flat array, for the pure tests. */
function grid(width: number, height: number): LayerAccess & { data: number[] } {
  const data = new Array(width * height).fill(0);
  return {
    width,
    height,
    data,
    get: (x, y) => data[y * width + x],
    set: (x, y, v) => {
      data[y * width + x] = v;
    },
  };
}

const A2 = TILE_ID.A2; // A2 ground autotile, kind 16, shape 0

describe('applyAutotiling', () => {
  it('shapes an isolated autotile as the island tile (47)', () => {
    const g = grid(5, 5);
    g.set(2, 2, A2);
    applyAutotiling(g, [{ x: 2, y: 2 }]);
    expect(getAutotileShape(g.get(2, 2))).toBe(47);
    expect(getAutotileKind(g.get(2, 2))).toBe(16); // kind preserved
  });

  it('makes the interior of a filled block solid and the corners outer', () => {
    const g = grid(5, 5);
    const cells: { x: number; y: number }[] = [];
    for (let y = 1; y <= 3; y++)
      for (let x = 1; x <= 3; x++) {
        g.set(x, y, A2);
        cells.push({ x, y });
      }
    applyAutotiling(g, cells);
    // Center is surrounded on all 8 sides → interior (shape 0).
    expect(g.get(2, 2)).toBe(makeAutotileId(16, 0));
    // Top-left corner of the block: only E/S/SE are same-kind → outer|hedge|vedge|solid = 34.
    expect(getAutotileShape(g.get(1, 1))).toBe(34);
  });

  it('leaves flat (non-autotile) tiles untouched', () => {
    const g = grid(3, 3);
    g.set(1, 1, 5); // a B-sheet tile
    applyAutotiling(g, [{ x: 1, y: 1 }]);
    expect(g.get(1, 1)).toBe(5);
  });
});

/** Scaffold a project with one blank map to paint on. */
async function scaffold(width: number, height: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmz-paint-'));
  await writeFile(join(dir, 'game.rmmzproject'), 'RPGMZ 1.0.0');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');
  await writeFile(join(dir, 'data', 'Map001.json'), JSON.stringify(blankMapData(width, height, 1)));
  return dir;
}

const fillArea = paintToolDefinitions.find((t) => t.name === 'fill_area')!;
const paintTiles = paintToolDefinitions.find((t) => t.name === 'paint_tiles')!;

describe('paint tools (integration)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await scaffold(6, 6);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fill_area autotiles a rectangle on layer 0', async () => {
    const res = (await fillArea.handler(
      { projectPath: dir },
      {
        mapId: 1,
        x: 1,
        y: 1,
        width: 3,
        height: 3,
        tileId: A2,
      },
    )) as { painted: number; warnings?: string[] };
    expect(res.painted).toBe(9);
    expect(res.warnings).toBeUndefined();

    const map = await getMap(dir, 1);
    const at = (x: number, y: number) => map.data[tileIndex(map.width, map.height, x, y, 0)];
    expect(at(2, 2)).toBe(makeAutotileId(16, 0)); // interior solid
    expect(getAutotileShape(at(1, 1))).toBe(34); // corner
    expect(at(0, 0)).toBe(0); // outside the rect, untouched
  });

  it('paint_tiles warns on out-of-bounds cells but paints the rest', async () => {
    const res = (await paintTiles.handler(
      { projectPath: dir },
      {
        mapId: 1,
        tiles: [
          { x: 0, y: 0, tileId: A2 },
          { x: 99, y: 0, tileId: A2 },
        ],
      },
    )) as { painted: number; warnings?: string[] };
    expect(res.painted).toBe(1);
    expect(res.warnings?.some((w) => w.includes('out of bounds'))).toBe(true);
  });

  it('warns when painting an autotile on a non-tile layer', async () => {
    const res = (await fillArea.handler(
      { projectPath: dir },
      {
        mapId: 1,
        x: 0,
        y: 0,
        width: 2,
        height: 2,
        tileId: A2,
        layer: 5,
      },
    )) as { warnings?: string[] };
    expect(res.warnings?.some((w) => w.includes('not a tile layer'))).toBe(true);
  });

  it('is available as three registered mutating tools', () => {
    expect(paintToolDefinitions.map((t) => t.name).sort()).toEqual([
      'fill_area',
      'paint_blueprint',
      'paint_tiles',
    ]);
    expect(paintToolDefinitions.every((t) => t.mutates)).toBe(true);
    // sanity: the map module it builds on is present too
    expect(mapToolDefinitions.some((t) => t.name === 'set_map_tile')).toBe(true);
  });
});
