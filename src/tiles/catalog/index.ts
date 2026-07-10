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

/**
 * The catalog registry: sheet filename → the sheet's tile names (indexed by
 * local index within the sheet). Extended per tileset as catalogs are authored.
 */
const CATALOG: Record<string, string[]> = { ...OVERWORLD_TILE_NAMES };

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
}

/**
 * Every cataloged entry for a tileset, given its `tilesetNames`. Walks each slot,
 * looks the sheet filename up in the catalog, and emits an entry per named tile.
 * Optionally restrict to one sheet by filename ("World_A2") or slot role ("A2").
 */
export function catalogForTileset(tilesetNames: string[], sheetFilter?: string): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (let slot = 0; slot < SLOT_ROLES.length; slot++) {
    const file = tilesetNames[slot];
    if (!file) continue;
    const role = SLOT_ROLES[slot];
    if (sheetFilter && sheetFilter !== file && sheetFilter !== role) continue;
    const names = CATALOG[file];
    if (!names) continue;
    const autotile = isAutotileSlot(role);
    names.forEach((name, localIndex) => {
      if (!name || name === 'Transparent') return; // skip the blank/transparent slot
      const tileId = tileIdForSlotIndex(slot, localIndex);
      entries.push({
        name,
        sheet: file,
        role,
        tileId,
        autotile,
        ...(autotile ? { kind: AUTOTILE_BASE_KIND[role] + localIndex } : {}),
      });
    });
  }
  return entries;
}

/**
 * Catalog entries for a tileset whose name matches `query` (case-insensitive
 * substring). The bridge for "give me a grass tile" → a paintable tile id.
 */
export function findTiles(tilesetNames: string[], query: string): CatalogEntry[] {
  const q = query.toLowerCase();
  return catalogForTileset(tilesetNames).filter((e) => e.name.toLowerCase().includes(q));
}

/** Whether any sheet of a tileset is covered by the catalog. */
export function hasCatalog(tilesetNames: string[]): boolean {
  return tilesetNames.some((f) => f && CATALOG[f]);
}
