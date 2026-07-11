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

describe('default tilesets (Outside / Inside / Dungeon / SF)', () => {
  // Real default tileset slot layouts from the new-project Tilesets.json.
  const OUTSIDE = [
    'Outside_A1',
    'Outside_A2',
    'Outside_A3',
    'Outside_A4',
    'Outside_A5',
    'Outside_B',
    'Outside_C',
    '',
    '',
  ];
  const INSIDE = [
    'Inside_A1',
    'Inside_A2',
    '',
    'Inside_A4',
    'Inside_A5',
    'Inside_B',
    'Inside_C',
    '',
    '',
  ];
  const DUNGEON = [
    'Dungeon_A1',
    'Dungeon_A2',
    '',
    'Dungeon_A4',
    'Dungeon_A5',
    'Dungeon_B',
    'Dungeon_C',
    '',
    '',
  ];
  // SF Outside reuses Outside_A1/A2 for the first two autotile slots.
  const SF_OUTSIDE = [
    'Outside_A1',
    'Outside_A2',
    'SF_Outside_A3',
    'SF_Outside_A4',
    'SF_Outside_A5',
    'SF_Outside_B',
    'SF_Outside_C',
    '',
    '',
  ];

  it('catalogs Outside across all seven sheets', () => {
    expect(hasCatalog(OUTSIDE)).toBe(true);
    const entries = catalogForTileset(OUTSIDE);
    // A2 first kind ("Meadow") resolves to the A2 slot base id.
    const meadow = entries.find((e) => e.name === 'Meadow')!;
    expect(meadow).toMatchObject({ sheet: 'Outside_A2', role: 'A2', autotile: true, kind: 16 });
    expect(meadow.tileId).toBe(TILE_ID.A2);
    // A3 is a wall/roof sheet (slot 2) — present only for Outside/SF, not Inside/Dungeon.
    expect(entries.some((e) => e.sheet === 'Outside_A3')).toBe(true);
    expect(entries.filter((e) => e.role === 'A4').length).toBe(48);
  });

  it('catalogs Inside and Dungeon (no A3 slot)', () => {
    expect(findTiles(INSIDE, 'wood floor').length).toBeGreaterThanOrEqual(1);
    expect(catalogForTileset(INSIDE).some((e) => e.role === 'A3')).toBe(false);

    const dungeonWater = findTiles(DUNGEON, 'water a').find((e) => e.sheet === 'Dungeon_A1')!;
    expect(dungeonWater).toMatchObject({ role: 'A1', kind: 0, autotile: true });
    expect(dungeonWater.tileId).toBe(TILE_ID.A1);
  });

  it('catalogs SF sheets, including ones reused across SF tilesets', () => {
    const entries = catalogForTileset(SF_OUTSIDE);
    // SF_Outside_A3 sits in slot 2 (A3) → wall autotile kinds start at 48.
    const roof = entries.find((e) => e.sheet === 'SF_Outside_A3')!;
    expect(roof).toMatchObject({ role: 'A3', autotile: true });
    expect(getAutotileKind(roof.tileId)).toBe(48);
    // The concrete wall on SF_Outside_A4 is findable by meaning.
    expect(findTiles(SF_OUTSIDE, 'concrete').some((e) => e.sheet === 'SF_Outside_A4')).toBe(true);
  });
});

describe('project-catalog overlay (Phase 4)', () => {
  // A tileset using one custom autotile sheet the built-in catalog doesn't cover.
  const CUSTOM = ['', 'Custom_A2', '', '', '', '', '', '', ''];
  const overlay = { Custom_A2: ['Emerald Grass', 'Cracked Earth'] };

  it('resolves a custom sheet from the overlay and tags source', () => {
    expect(hasCatalog(CUSTOM)).toBe(false); // uncovered by built-in
    expect(hasCatalog(CUSTOM, overlay)).toBe(true);

    const entries = catalogForTileset(CUSTOM, undefined, overlay);
    expect(entries.map((e) => e.name)).toEqual(['Emerald Grass', 'Cracked Earth']);
    const grass = entries.find((e) => e.name === 'Emerald Grass')!;
    expect(grass).toMatchObject({ sheet: 'Custom_A2', role: 'A2', autotile: true, kind: 16 });
    expect(grass.tileId).toBe(makeAutotileId(16, 0)); // A2 first kind, shape-0 base
    expect(grass.source).toBe('project');

    expect(findTiles(CUSTOM, 'earth', overlay).map((e) => e.name)).toEqual(['Cracked Earth']);
  });

  it('built-in names stay authoritative and are tagged builtin', () => {
    const entries = catalogForTileset(OVERWORLD, undefined, overlay);
    const grass = entries.find((e) => e.name === 'Grassland A')!;
    expect(grass.source).toBe('builtin');
    // The overlay for an unrelated sheet doesn't leak into Overworld sheets.
    expect(entries.some((e) => e.name === 'Emerald Grass')).toBe(false);
  });

  it('an overlay entry replaces the built-in names for that same sheet', () => {
    const relabeled = { World_A2: ['Meadow'] };
    const entries = catalogForTileset(OVERWORLD, 'World_A2', relabeled);
    expect(entries.map((e) => e.name)).toEqual(['Meadow']);
    expect(entries[0].source).toBe('project');
  });

  it('surfaces object-form overlay metadata (description/confidence/manual)', () => {
    const rich = {
      Custom_A2: [
        {
          name: 'Emerald Grass',
          description: 'lush green grass',
          confidence: 'high',
          manual: true,
        },
        { name: 'Cracked Earth', confidence: 'low' },
      ],
    };
    const entries = catalogForTileset(CUSTOM, undefined, rich);
    const grass = entries.find((e) => e.name === 'Emerald Grass')!;
    expect(grass).toMatchObject({
      description: 'lush green grass',
      confidence: 'high',
      manual: true,
      source: 'project',
    });
    // Absent fields aren't padded onto the entry.
    const earth = entries.find((e) => e.name === 'Cracked Earth')!;
    expect(earth.confidence).toBe('low');
    expect(earth.description).toBeUndefined();
    expect('manual' in earth).toBe(false);
  });

  it('leaves built-in entries free of project-only metadata', () => {
    const grass = catalogForTileset(OVERWORLD).find((e) => e.name === 'Grassland A')!;
    expect(grass.description).toBeUndefined();
    expect(grass.confidence).toBeUndefined();
    expect('manual' in grass).toBe(false);
  });
});
