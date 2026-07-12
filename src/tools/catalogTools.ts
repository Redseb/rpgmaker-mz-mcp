import { join } from 'path';
import { z } from 'zod';
import { ToolDefinition } from '../registry.js';
import { getDataPath, readJsonFile, listFiles, fileExists } from '../utils/fileHandler.js';
import { Tileset } from '../utils/types.js';
import {
  catalogForTileset,
  findTiles,
  hasCatalog,
  CatalogOverlay,
  OverlayTile,
} from '../tiles/catalog/index.js';

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

/** The on-disk shape of a project catalog file (written by the 3f bootstrap skill). */
interface ProjectCatalogFile {
  sheet: string;
  entries: Record<
    string,
    { name: string; description?: string; confidence?: string; manual?: boolean }
  >;
}

/**
 * Load project-scoped tile catalogs from `data/tilecatalog/*.json` (written by the
 * 3f vision-bootstrap skill) into an overlay keyed by sheet filename. Each file's
 * `entries` (local index → { name, description?, confidence?, manual? }) becomes a
 * tiles-by-index array, carrying through the draft metadata so the tools can
 * surface it. A missing directory or an unreadable file yields no overlay for that
 * sheet — the catalog gracefully falls back to built-in names. Returns `undefined`
 * when there are no project catalogs at all (so callers pass nothing to the pure
 * resolver).
 */
async function loadProjectCatalogs(projectPath: string): Promise<CatalogOverlay | undefined> {
  const dir = join(projectPath, 'data', 'tilecatalog');
  if (!(await fileExists(dir))) return undefined;
  let files: string[];
  try {
    files = await listFiles(dir, '.json');
  } catch {
    return undefined;
  }
  const overlay: CatalogOverlay = {};
  for (const file of files) {
    try {
      const data = await readJsonFile<ProjectCatalogFile>(join(dir, file));
      if (!data.sheet || !data.entries) continue;
      // Sparse array keyed by local index — forEach in the resolver skips the
      // holes, so gaps don't need filling and index alignment is preserved.
      const tiles: (OverlayTile | undefined)[] = [];
      for (const [idx, entry] of Object.entries(data.entries)) {
        const i = Number(idx);
        if (Number.isInteger(i) && i >= 0 && entry?.name) {
          tiles[i] = {
            name: entry.name,
            ...(entry.description ? { description: entry.description } : {}),
            ...(entry.confidence ? { confidence: entry.confidence } : {}),
            ...(entry.manual !== undefined ? { manual: entry.manual } : {}),
          };
        }
      }
      overlay[data.sheet] = tiles;
    } catch {
      // Skip a malformed catalog file rather than failing the whole lookup.
      continue;
    }
  }
  return Object.keys(overlay).length ? overlay : undefined;
}

export const catalogToolDefinitions: ToolDefinition[] = [
  {
    name: 'get_tile_catalog',
    description:
      "Get the semantic tile catalog for a tileset: the named tiles (e.g. 'Grassland A', 'Forest', 'Sea') in each of its image sheets, each with its representative tile id and a `source` ('builtin' = RPG Maker's own labels; 'project' = a draft name from the vision-bootstrap skill). Project (custom-sheet) entries also carry the skill's `description`, `confidence` ('high'/'medium'/'low'), and `manual` (true = a human verified it) so you can gauge how trustworthy a draft name is. Autotile entries (A1–A4) return the kind's base tile id — feed it to a paint command, which recomputes the shape from neighbours. Covers the default Overworld tileset (World_A1/A2/B/C) plus any custom sheets cataloged into data/tilecatalog/ (via the tileset-catalog skill); still-uncovered sheets are omitted. **Called WITHOUT `sheet` it returns only a per-sheet index (name + entry count) to stay within the tool-output limit — a full tileset can hold thousands of named tiles. Pass `sheet` (filename 'World_A2' or slot role 'A2') to list one sheet's actual tile entries.** Read-only.",
    inputSchema: {
      tilesetId: z.number().int().positive().describe('Tileset id (from Tilesets.json / the map)'),
      sheet: z
        .string()
        .optional()
        .describe(
          "Restrict to one sheet by filename ('World_A2') or role ('A2'). Omit to get a per-sheet summary (counts only) instead of every entry.",
        ),
    },
    handler: async (ctx, args) => {
      const tileset = await getTileset(ctx.projectPath, args.tilesetId);
      const overlay = await loadProjectCatalogs(ctx.projectPath);
      const cataloged = hasCatalog(tileset.tilesetNames, overlay);
      const entries = catalogForTileset(tileset.tilesetNames, args.sheet, overlay);

      // Without a `sheet` filter, the full entry list can blow past the tool-output
      // token limit (a default tileset holds thousands of named tiles). Return a
      // per-sheet index instead, so the caller can pick a sheet to expand.
      if (!args.sheet) {
        const bySheet = new Map<
          string,
          { sheet: string; role: string; source: string; count: number }
        >();
        for (const e of entries) {
          const summary = bySheet.get(e.sheet);
          if (summary) summary.count++;
          else bySheet.set(e.sheet, { sheet: e.sheet, role: e.role, source: e.source, count: 1 });
        }
        return {
          tilesetId: args.tilesetId,
          tilesetName: tileset.name,
          cataloged,
          summary: true,
          totalEntries: entries.length,
          sheets: [...bySheet.values()],
          hint: "Per-sheet index only. Call again with `sheet` (filename or role, e.g. 'A2') to list that sheet's tile entries.",
        };
      }

      return {
        tilesetId: args.tilesetId,
        tilesetName: tileset.name,
        cataloged,
        sheet: args.sheet,
        count: entries.length,
        entries,
      };
    },
  },
  {
    name: 'find_tile',
    description:
      "Find tiles in a tileset by name (case-insensitive substring) — the bridge from a meaning like 'grass', 'water', or 'mountain' to a paintable tile id. Returns matching catalog entries (name, sheet, tile id, autotile kind, `source`, plus `description`/`confidence`/`manual` for project catalog drafts). Covers the default Overworld tileset plus custom sheets cataloged into data/tilecatalog/ (via the tileset-catalog skill). Read-only.",
    inputSchema: {
      tilesetId: z.number().int().positive().describe('Tileset id (from Tilesets.json / the map)'),
      query: z.string().describe("Name substring to search for, e.g. 'grass' or 'forest'"),
    },
    handler: async (ctx, args) => {
      const tileset = await getTileset(ctx.projectPath, args.tilesetId);
      const overlay = await loadProjectCatalogs(ctx.projectPath);
      const matches = findTiles(tileset.tilesetNames, args.query, overlay);
      return { tilesetId: args.tilesetId, query: args.query, count: matches.length, matches };
    },
  },
];
