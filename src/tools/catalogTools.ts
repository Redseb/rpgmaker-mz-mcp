import { z } from 'zod';
import { ToolDefinition } from '../registry.js';
import { getDataPath, readJsonFile } from '../utils/fileHandler.js';
import { Tileset } from '../utils/types.js';
import { catalogForTileset, findTiles, hasCatalog } from '../tiles/catalog/index.js';

/** Load one tileset from the project's data/Tilesets.json (1-indexed, slot 0 null). */
async function getTileset(projectPath: string, tilesetId: number): Promise<Tileset> {
  const tilesets = await readJsonFile<(Tileset | null)[]>(
    getDataPath(projectPath, 'Tilesets.json'),
  );
  const tileset = tilesets[tilesetId];
  if (!tileset) {
    throw new Error(`Tileset ${tilesetId} not found`);
  }
  return tileset;
}

export const catalogToolDefinitions: ToolDefinition[] = [
  {
    name: 'get_tile_catalog',
    description:
      "Get the semantic tile catalog for a tileset: the named tiles (e.g. 'Grassland A', 'Forest', 'Sea') in each of its image sheets, each with its representative tile id. Autotile entries (A1–A4) return the kind's base tile id — feed it to a paint command, which recomputes the shape from neighbours. Currently covers the default Overworld tileset (World_A1/A2/B/C); uncovered custom sheets are omitted. Optionally restrict to one sheet by filename ('World_A2') or slot role ('A2'). Read-only.",
    inputSchema: {
      tilesetId: z.number().int().positive().describe('Tileset id (from Tilesets.json / the map)'),
      sheet: z
        .string()
        .optional()
        .describe("Optional: restrict to one sheet by filename ('World_A2') or role ('A2')"),
    },
    handler: async (ctx, args) => {
      const tileset = await getTileset(ctx.projectPath, args.tilesetId);
      const entries = catalogForTileset(tileset.tilesetNames, args.sheet);
      return {
        tilesetId: args.tilesetId,
        tilesetName: tileset.name,
        cataloged: hasCatalog(tileset.tilesetNames),
        count: entries.length,
        entries,
      };
    },
  },
  {
    name: 'find_tile',
    description:
      "Find tiles in a tileset by name (case-insensitive substring) — the bridge from a meaning like 'grass', 'water', or 'mountain' to a paintable tile id. Returns matching catalog entries (name, sheet, tile id, autotile kind). Covers the default Overworld tileset. Read-only.",
    inputSchema: {
      tilesetId: z.number().int().positive().describe('Tileset id (from Tilesets.json / the map)'),
      query: z.string().describe("Name substring to search for, e.g. 'grass' or 'forest'"),
    },
    handler: async (ctx, args) => {
      const tileset = await getTileset(ctx.projectPath, args.tilesetId);
      const matches = findTiles(tileset.tilesetNames, args.query);
      return { tilesetId: args.tilesetId, query: args.query, count: matches.length, matches };
    },
  },
];
