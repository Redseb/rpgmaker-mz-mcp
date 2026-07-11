/**
 * Semantic tile catalog resolution (Phase 3c). Turns "what does this tileset
 * contain, by meaning" into concrete tile ids — the layer that lets a caller
 * ask for "Grassland A" instead of the opaque integer 2816. Data comes from
 * {@link OVERWORLD_TILE_NAMES} (RPG Maker's own labels for the default Overworld
 * sheets); this module maps a sheet's local index to a real tile id using the
 * sheet's *slot* in a tileset, and searches by name.
 *
 * Pure (no I/O): callers pass a tileset's `tilesetNames` (from Tilesets.json).
 * A sheet whose filename isn't in the catalog is simply skipped (custom sheets
 * are the job of the 3f vision-bootstrap skill).
 */
import { TILE_ID, makeAutotileId } from '../tileCodec.js';
import { OVERWORLD_TILE_NAMES } from './overworld.js';
import { OUTSIDE_TILE_NAMES } from './outside.js';
import { INSIDE_TILE_NAMES } from './inside.js';
import { DUNGEON_TILE_NAMES } from './dungeon.js';
import { SF_TILE_NAMES } from './sf.js';

/**
 * The catalog registry: sheet filename → the sheet's tile names (indexed by
 * local index within the sheet). Covers the default RPG Maker MZ tilesets
 * (Overworld, Outside, Inside, Dungeon, SF); extended per tileset as catalogs
 * are authored. Keyed by sheet filename, so a sheet shared across tilesets is
 * cataloged once.
 */
const CATALOG: Record<string, string[]> = {
  ...OVERWORLD_TILE_NAMES,
  ...OUTSIDE_TILE_NAMES,
  ...INSIDE_TILE_NAMES,
  ...DUNGEON_TILE_NAMES,
  ...SF_TILE_NAMES,
};

/** The 9 `tilesetNames` slots, positional. Slots 0–3 are autotiles, 4–8 flat. */
const SLOT_ROLES = ['A1', 'A2', 'A3', 'A4', 'A5', 'B', 'C', 'D', 'E'] as const;
type SlotRole = (typeof SLOT_ROLES)[number];

/** First autotile *kind* on each A-sheet: A1=0, A2=16, A3=48, A4=80. */
const AUTOTILE_BASE_KIND: Record<string, number> = { A1: 0, A2: 16, A3: 48, A4: 80 };

/** Base tile id for each flat sheet (from the engine's TILE_ID constants). */
const FLAT_BASE: Record<string, number> = {
  A5: TILE_ID.A5,
  B: TILE_ID.B,
  C: TILE_ID.C,
  D: TILE_ID.D,
  E: TILE_ID.E,
};

function isAutotileSlot(role: SlotRole): boolean {
  return role === 'A1' || role === 'A2' || role === 'A3' || role === 'A4';
}

/**
 * The representative tile id for a sheet's local index. For autotile sheets this
 * is the kind's shape-0 tile (a paint command recomputes the real shape from
 * neighbours); for flat sheets it's the tile id itself.
 */
export function tileIdForSlotIndex(slot: number, localIndex: number): number {
  const role = SLOT_ROLES[slot];
  if (isAutotileSlot(role)) {
    return makeAutotileId(AUTOTILE_BASE_KIND[role] + localIndex, 0);
  }
  return FLAT_BASE[role] + localIndex;
}

/** One catalog hit: a named tile in a specific tileset sheet. */
export interface CatalogEntry {
  /** Official tile name, e.g. "Grassland A". */
  name: string;
  /** The tileset image sheet filename, e.g. "World_A2". */
  sheet: string;
  /** The sheet's slot role: A1–A5, B–E. */
  role: SlotRole;
  /** The representative tile id (autotile shape-0 base, or the flat tile id). */
  tileId: number;
  /** True for A1–A4 sheets (shape is neighbour-driven; feed tileId to a paint command). */
  autotile: boolean;
  /** Global autotile kind (autotiles only). */
  kind?: number;
  /**
   * Where the name came from: `builtin` = RPG Maker's own labels (authoritative);
   * `project` = a project-scoped catalog written by the 3f vision-bootstrap skill
   * (draft — a name a human may still be verifying).
   */
  source: 'builtin' | 'project';
  /** Free-text tile description — carried through from a `project` catalog only. */
  description?: string;
  /** Vision-naming confidence ('high'/'medium'/'low') — `project` catalog only. */
  confidence?: string;
  /** True when a human has verified/corrected this `project` catalog entry. */
  manual?: boolean;
}

/**
 * One tile in a project-scoped overlay. A bare `string` is shorthand for a
 * name-only tile (`{ name }`); the object form additionally carries the draft
 * metadata the 3f skill records (description/confidence/manual) so the tools can
 * surface it.
 */
export interface OverlayTile {
  name: string;
  description?: string;
  confidence?: string;
  manual?: boolean;
}

/**
 * A project-scoped name overlay: sheet filename → tiles by local index. Produced
 * by loading the 3f skill's `data/tilecatalog/*.json` files (the loader lives in
 * the tools layer since it does I/O). An overlay entry for a sheet **replaces**
 * the built-in names for that sheet (a project's own labels win for its sheets).
 */
export type CatalogOverlay = Record<string, (string | OverlayTile | undefined)[]>;

/**
 * Every cataloged entry for a tileset, given its `tilesetNames`. Walks each slot,
 * looks the sheet filename up in the catalog (built-in names, plus any `overlay`
 * from project catalogs), and emits an entry per named tile. Optionally restrict
 * to one sheet by filename ("World_A2") or slot role ("A2").
 */
export function catalogForTileset(
  tilesetNames: string[],
  sheetFilter?: string,
  overlay?: CatalogOverlay,
): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (let slot = 0; slot < SLOT_ROLES.length; slot++) {
    const file = tilesetNames[slot];
    if (!file) continue;
    const role = SLOT_ROLES[slot];
    if (sheetFilter && sheetFilter !== file && sheetFilter !== role) continue;
    // A project overlay for a sheet replaces the built-in names wholesale.
    const overlayTiles = overlay?.[file];
    const tiles: (string | OverlayTile | undefined)[] | undefined = overlayTiles ?? CATALOG[file];
    if (!tiles) continue;
    const source: 'builtin' | 'project' = overlayTiles ? 'project' : 'builtin';
    const autotile = isAutotileSlot(role);
    tiles.forEach((raw, localIndex) => {
      const tile = typeof raw === 'string' ? { name: raw } : raw;
      if (!tile || !tile.name || tile.name === 'Transparent') return; // skip blank/transparent slots
      const tileId = tileIdForSlotIndex(slot, localIndex);
      entries.push({
        name: tile.name,
        sheet: file,
        role,
        tileId,
        autotile,
        ...(autotile ? { kind: AUTOTILE_BASE_KIND[role] + localIndex } : {}),
        source,
        ...(tile.description ? { description: tile.description } : {}),
        ...(tile.confidence ? { confidence: tile.confidence } : {}),
        ...(tile.manual !== undefined ? { manual: tile.manual } : {}),
      });
    });
  }
  return entries;
}

/**
 * Catalog entries for a tileset whose name matches `query` (case-insensitive
 * substring). The bridge for "give me a grass tile" → a paintable tile id.
 */
export function findTiles(
  tilesetNames: string[],
  query: string,
  overlay?: CatalogOverlay,
): CatalogEntry[] {
  const q = query.toLowerCase();
  return catalogForTileset(tilesetNames, undefined, overlay).filter((e) =>
    e.name.toLowerCase().includes(q),
  );
}

/** Whether any sheet of a tileset is covered by the catalog (built-in or overlay). */
export function hasCatalog(tilesetNames: string[], overlay?: CatalogOverlay): boolean {
  return tilesetNames.some((f) => f && (CATALOG[f] || overlay?.[f]));
}
