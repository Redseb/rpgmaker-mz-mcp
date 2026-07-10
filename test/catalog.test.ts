import { describe, it, expect } from 'vitest';
import {
  tileIdForSlotIndex,
  catalogForTileset,
  findTiles,
  hasCatalog,
} from '../src/tiles/catalog/index.js';
import { TILE_ID, makeAutotileId, getAutotileKind, isAutotile } from '../src/tiles/tileCodec.js';

// The default Overworld tileset's sheet slots (Tilesets.json tilesetNames).
const OVERWORLD = ['World_A1', 'World_A2', '', '', '', 'World_B', 'World_C', '', ''];

describe('tileIdForSlotIndex', () => {
  it('maps A1/A2 autotile slots to their kind base ids', () => {
    expect(tileIdForSlotIndex(0, 0)).toBe(TILE_ID.A1); // A1 kind 0
    expect(tileIdForSlotIndex(1, 0)).toBe(TILE_ID.A2); // A2 first kind (16)
    expect(getAutotileKind(tileIdForSlotIndex(1, 0))).toBe(16);
    expect(tileIdForSlotIndex(1, 5)).toBe(makeAutotileId(21, 0)); // A2 local kind 5 → global 21
  });

  it('maps flat B/C slots to base + index', () => {
    expect(tileIdForSlotIndex(5, 0)).toBe(TILE_ID.B); // B sheet base
    expect(tileIdForSlotIndex(6, 8)).toBe(TILE_ID.C + 8); // C sheet, tile index 8
  });
});

describe('catalogForTileset (Overworld)', () => {
  const entries = catalogForTileset(OVERWORLD);

  it('resolves named autotiles to the right tile ids', () => {
    const grass = entries.find((e) => e.name === 'Grassland A')!;
    expect(grass).toMatchObject({ sheet: 'World_A2', role: 'A2', autotile: true, kind: 16 });
    expect(grass.tileId).toBe(TILE_ID.A2);

    const sea = entries.find((e) => e.name === 'Sea')!;
    expect(sea).toMatchObject({ sheet: 'World_A1', role: 'A1', autotile: true, kind: 0 });
    expect(sea.tileId).toBe(TILE_ID.A1);
  });

  it('resolves flat object tiles (C sheet)', () => {
    const hut = entries.find((e) => e.name === 'Hut')!; // World_C line 9 → index 8
    expect(hut).toMatchObject({ sheet: 'World_C', role: 'C', autotile: false });
    expect(hut.tileId).toBe(TILE_ID.C + 8);
    expect(isAutotile(hut.tileId)).toBe(false);
  });

  it('skips the transparent slot and includes all 16 A1 + 32 A2 kinds', () => {
    expect(entries.some((e) => e.name === 'Transparent')).toBe(false);
    expect(entries.filter((e) => e.role === 'A1').length).toBe(16);
    expect(entries.filter((e) => e.role === 'A2').length).toBe(32);
  });

  it('can restrict to one sheet', () => {
    const onlyA2 = catalogForTileset(OVERWORLD, 'A2');
    expect(onlyA2.length).toBe(32);
    expect(onlyA2.every((e) => e.role === 'A2')).toBe(true);
    expect(catalogForTileset(OVERWORLD, 'World_A1').every((e) => e.sheet === 'World_A1')).toBe(
      true,
    );
  });

  it('omits uncatalogued sheets', () => {
    const custom = ['Custom_A1', '', '', '', '', '', '', '', ''];
    expect(catalogForTileset(custom)).toEqual([]);
    expect(hasCatalog(custom)).toBe(false);
    expect(hasCatalog(OVERWORLD)).toBe(true);
  });
});

describe('findTiles', () => {
  it('finds terrain by meaning (case-insensitive substring)', () => {
    const grass = findTiles(OVERWORLD, 'grass').map((e) => e.name);
    expect(grass).toContain('Grassland A');
    expect(grass).toContain('Mountain (Grass)');

    const forest = findTiles(OVERWORLD, 'forest');
    expect(forest.length).toBeGreaterThanOrEqual(4);
    expect(forest.every((e) => e.autotile)).toBe(true); // all A2 forest kinds

    expect(findTiles(OVERWORLD, 'nonesuch')).toEqual([]);
  });
});
