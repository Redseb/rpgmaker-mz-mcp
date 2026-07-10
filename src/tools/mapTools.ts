import { z } from 'zod';
import { readJsonFile, getMapPath, getDataPath, fileExists } from '../utils/fileHandler.js';
import { commitChange, commitDelete } from '../utils/commit.js';
import { MapData, MapEvent, MapInfo, EventCommand } from '../utils/types.js';
import { ToolDefinition } from '../registry.js';
import { validateEvent } from '../validation/eventCommands.js';

/** Dimensions the RPG Maker MZ editor defaults to when creating a new map. */
const DEFAULT_MAP_WIDTH = 17;
const DEFAULT_MAP_HEIGHT = 13;

/**
 * Attach warn-by-default validation results to an event-write response. Warnings
 * are advisory: the write already happened (or was previewed); this just tells
 * the caller if the resulting event looks structurally off. Warnings are only
 * included when present, so clean writes keep a tidy `{ event }` response.
 */
function withValidation(event: MapEvent): {
  event: MapEvent;
  warnings?: ReturnType<typeof validateEvent>['warnings'];
} {
  const { warnings } = validateEvent(event);
  return warnings.length > 0 ? { event, warnings } : { event };
}

/**
 * Get map data by ID
 */
export async function getMap(projectPath: string, mapId: number): Promise<MapData> {
  const mapPath = getMapPath(projectPath, mapId);
  return await readJsonFile<MapData>(mapPath);
}

/**
 * Get all map info
 */
export async function getMapInfos(projectPath: string): Promise<(MapInfo | null)[]> {
  const mapInfosPath = getDataPath(projectPath, 'MapInfos.json');
  return await readJsonFile<(MapInfo | null)[]>(mapInfosPath);
}

/**
 * Build a blank MapData mirroring what the RPG Maker MZ editor writes for a
 * freshly-created map: every tile zeroed (unpainted) across all 6 layers and no
 * events. Field order matches the editor's own output so round-tripped files
 * stay tidy. Kept pure (no I/O) so the template shape can be unit-tested.
 */
export function blankMapData(width: number, height: number, tilesetId: number): MapData {
  return {
    autoplayBgm: false,
    autoplayBgs: false,
    battleback1Name: '',
    battleback2Name: '',
    bgm: { name: '', pan: 0, pitch: 100, volume: 90 },
    bgs: { name: '', pan: 0, pitch: 100, volume: 90 },
    disableDashing: false,
    displayName: '',
    encounterList: [],
    encounterStep: 30,
    height,
    note: '',
    parallaxLoopX: false,
    parallaxLoopY: false,
    parallaxName: '',
    parallaxShow: true,
    parallaxSx: 0,
    parallaxSy: 0,
    scrollType: 0,
    specifyBattleback: false,
    tilesetId,
    width,
    data: new Array(width * height * 6).fill(0),
    events: [],
  };
}

/**
 * Create a new map: write a fresh `data/MapNNN.json` and register it in the map
 * tree (`data/MapInfos.json`). Allocates the next unused map id, appends a tree
 * entry, and lays down a blank (all-tiles-zeroed) map of the given size.
 *
 * Both files are written through the commit choke point, so a dry-run previews
 * the new map file *and* the MapInfos entry together. Does not touch
 * `System.json`: the editor's map tree is driven entirely by MapInfos, so a new
 * entry is enough for the editor to see the map (`System.editMapId` only tracks
 * which map is open on launch).
 */
export async function createMap(
  projectPath: string,
  options: {
    name: string;
    width?: number;
    height?: number;
    parentId?: number;
    tilesetId?: number;
  },
): Promise<{ mapId: number; mapInfo: MapInfo; map: MapData }> {
  const width = options.width ?? DEFAULT_MAP_WIDTH;
  const height = options.height ?? DEFAULT_MAP_HEIGHT;
  const tilesetId = options.tilesetId ?? 1;
  const parentId = options.parentId ?? 0;

  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Map dimensions must be positive integers (got ${width}x${height})`);
  }

  const infos = await getMapInfos(projectPath);

  // A non-root parent must point at an existing map, or the map is orphaned in
  // the tree.
  if (parentId !== 0 && !infos[parentId]) {
    throw new Error(`parentId ${parentId} does not match any existing map`);
  }

  // Allocate a fresh id: one past the highest existing map id. MapInfos is a
  // 1-indexed array whose slot 0 is null.
  const maxId = infos.reduce((max, info) => (info && info.id > max ? info.id : max), 0);
  const newId = maxId + 1;

  // Guard: never clobber an existing MapNNN.json. With correct id allocation the
  // file should be genuinely unused; a collision means the tree and the files on
  // disk are out of sync, which we surface rather than silently overwrite.
  const mapPath = getMapPath(projectPath, newId);
  if (await fileExists(mapPath)) {
    throw new Error(
      `Map file for id ${newId} already exists though the id is unused in MapInfos — refusing to overwrite (${mapPath})`,
    );
  }

  const maxOrder = infos.reduce((max, info) => (info && info.order > max ? info.order : max), 0);
  const mapInfo: MapInfo = {
    id: newId,
    expanded: false,
    name: options.name,
    order: maxOrder + 1,
    parentId,
    scrollX: 0,
    scrollY: 0,
  };
  infos[newId] = mapInfo;

  const map = blankMapData(width, height, tilesetId);

  // Write the map file first, then register it in the tree — both through the
  // commit choke point so dry-run previews both writes.
  await commitChange(mapPath, map);
  await commitChange(getDataPath(projectPath, 'MapInfos.json'), infos);

  return { mapId: newId, mapInfo, map };
}

/**
 * Delete a map: remove its entry from the map tree (`data/MapInfos.json`) and
 * delete its `data/MapNNN.json` file. Any child maps are **reparented** to the
 * deleted map's own parent rather than deleted with it — so a whole town/dungeon
 * sub-tree isn't wiped by removing one node. Both the tree rewrite and the file
 * deletion go through the commit choke point, so a dry-run previews the tree
 * change and the file removal together.
 *
 * Does not touch `System.json`; if the deleted map happens to be the editor's
 * open/start map that reference is left dangling (the editor tolerates it), same
 * hands-off stance `create_map` takes toward `System.json`.
 */
export async function deleteMap(
  projectPath: string,
  mapId: number,
): Promise<{ mapId: number; reparentedTo: number; reparentedChildren: number[] }> {
  const infos = await getMapInfos(projectPath);

  const target = infos[mapId];
  if (!target) {
    throw new Error(`Map ${mapId} does not exist in the map tree`);
  }

  // Reparent the deleted map's direct children onto its parent so they aren't
  // orphaned (parentId pointing at a now-gone map).
  const reparentedTo = target.parentId;
  const reparentedChildren: number[] = [];
  for (const info of infos) {
    if (info && info.parentId === mapId) {
      info.parentId = reparentedTo;
      reparentedChildren.push(info.id);
    }
  }

  // Drop the tree entry, preserving the 1-indexed array shape (slot -> null).
  infos[mapId] = null;

  // Rewrite the tree, then delete the map file — both via the commit choke
  // point so dry-run previews both operations.
  await commitChange(getDataPath(projectPath, 'MapInfos.json'), infos);
  await commitDelete(getMapPath(projectPath, mapId));

  return { mapId, reparentedTo, reparentedChildren };
}

/** A single map-tree edit: reparent, reorder, rename, or expand/collapse a map. */
export interface MapTreeUpdate {
  mapId: number;
  parentId?: number;
  order?: number;
  name?: string;
  expanded?: boolean;
}

/**
 * Walk each map's parent chain to the root, throwing if a cycle is found (a map
 * that is transitively its own ancestor). Catches self-parenting and longer
 * loops that would otherwise make the editor's tree render infinitely.
 */
function assertNoTreeCycles(infos: (MapInfo | null)[]): void {
  for (const start of infos) {
    if (!start) continue;
    const seen = new Set<number>([start.id]);
    let parentId = start.parentId;
    while (parentId !== 0) {
      if (seen.has(parentId)) {
        throw new Error(`Map tree cycle detected involving map ${start.id}`);
      }
      seen.add(parentId);
      const parent = infos[parentId];
      if (!parent) break;
      parentId = parent.parentId;
    }
  }
}

/**
 * Edit the map tree (`data/MapInfos.json`) without touching any map's tiles or
 * events: reparent (move under a different node / to the top level), reorder
 * siblings, rename, or expand/collapse. Applies a batch of per-map updates, then
 * validates the whole tree stays acyclic before committing. Every referenced map
 * (and any non-zero `parentId`) must already exist.
 */
export async function updateMapTree(
  projectPath: string,
  updates: MapTreeUpdate[],
): Promise<{ updated: MapInfo[] }> {
  const infos = await getMapInfos(projectPath);

  // Validate every target exists before mutating anything, so a bad update in
  // the batch can't leave a partially-applied tree.
  for (const update of updates) {
    if (!infos[update.mapId]) {
      throw new Error(`Map ${update.mapId} does not exist in the map tree`);
    }
    if (update.parentId !== undefined) {
      if (update.parentId === update.mapId) {
        throw new Error(`Map ${update.mapId} cannot be its own parent`);
      }
      if (update.parentId !== 0 && !infos[update.parentId]) {
        throw new Error(`parentId ${update.parentId} does not match any existing map`);
      }
    }
  }

  const updated: MapInfo[] = [];
  for (const update of updates) {
    const info = infos[update.mapId]!;
    if (update.parentId !== undefined) info.parentId = update.parentId;
    if (update.order !== undefined) info.order = update.order;
    if (update.name !== undefined) info.name = update.name;
    if (update.expanded !== undefined) info.expanded = update.expanded;
    updated.push(info);
  }

  // A reparent can introduce a cycle (A under B, B under A); reject before write.
  assertNoTreeCycles(infos);

  await commitChange(getDataPath(projectPath, 'MapInfos.json'), infos);

  return { updated };
}

/**
 * Update map properties
 */
export async function updateMap(
  projectPath: string,
  mapId: number,
  updates: Partial<MapData>,
): Promise<MapData> {
  const map = await getMap(projectPath, mapId);
  const updatedMap = { ...map, ...updates };

  const mapPath = getMapPath(projectPath, mapId);
  await commitChange(mapPath, updatedMap);

  return updatedMap;
}

/**
 * Get events from a specific map
 */
export async function getMapEvents(
  projectPath: string,
  mapId: number,
): Promise<(MapEvent | null)[]> {
  const map = await getMap(projectPath, mapId);
  return map.events;
}

/**
 * Get a specific event from a map
 */
export async function getMapEvent(
  projectPath: string,
  mapId: number,
  eventId: number,
): Promise<MapEvent | null> {
  const events = await getMapEvents(projectPath, mapId);
  return events[eventId] || null;
}

/**
 * Update a map event
 */
export async function updateMapEvent(
  projectPath: string,
  mapId: number,
  eventId: number,
  updates: Partial<MapEvent>,
): Promise<MapEvent> {
  const map = await getMap(projectPath, mapId);

  if (!map.events[eventId]) {
    throw new Error(`Event ${eventId} not found on map ${mapId}`);
  }

  map.events[eventId] = { ...map.events[eventId]!, ...updates };

  const mapPath = getMapPath(projectPath, mapId);
  await commitChange(mapPath, map);

  return map.events[eventId]!;
}

/**
 * Create a new event on a map
 */
export async function createMapEvent(
  projectPath: string,
  mapId: number,
  eventData: Omit<MapEvent, 'id'>,
): Promise<MapEvent> {
  const map = await getMap(projectPath, mapId);

  // Find the next available event ID
  const maxId = map.events.reduce((max, event, index) => {
    return event && index > max ? index : max;
  }, 0);

  // Spread first so the computed id always wins, even if a caller passes one.
  const newEvent: MapEvent = {
    ...eventData,
    id: maxId + 1,
  };

  map.events[maxId + 1] = newEvent;

  const mapPath = getMapPath(projectPath, mapId);
  await commitChange(mapPath, map);

  return newEvent;
}

/**
 * Delete an event from a map
 */
export async function deleteMapEvent(
  projectPath: string,
  mapId: number,
  eventId: number,
): Promise<boolean> {
  const map = await getMap(projectPath, mapId);

  if (!map.events[eventId]) {
    return false;
  }

  map.events[eventId] = null;

  const mapPath = getMapPath(projectPath, mapId);
  await commitChange(mapPath, map);

  return true;
}

/**
 * Search events by name
 */
export async function searchMapEvents(
  projectPath: string,
  mapId: number,
  searchTerm: string,
): Promise<MapEvent[]> {
  const events = await getMapEvents(projectPath, mapId);
  const lowerSearchTerm = searchTerm.toLowerCase();

  return events.filter(
    (event) => event && event.name.toLowerCase().includes(lowerSearchTerm),
  ) as MapEvent[];
}

/**
 * Add a command to an event page
 */
export async function addEventCommand(
  projectPath: string,
  mapId: number,
  eventId: number,
  pageIndex: number,
  command: EventCommand,
  position?: number,
): Promise<MapEvent> {
  const map = await getMap(projectPath, mapId);

  if (!map.events[eventId]) {
    throw new Error(`Event ${eventId} not found on map ${mapId}`);
  }

  const event = map.events[eventId]!;

  if (!event.pages[pageIndex]) {
    throw new Error(`Page ${pageIndex} not found on event ${eventId}`);
  }

  const commandList = event.pages[pageIndex].list;

  if (position !== undefined && position >= 0 && position < commandList.length - 1) {
    // Insert at specific position (before the end command)
    commandList.splice(position, 0, command);
  } else {
    // Add before the end command (code 0)
    commandList.splice(commandList.length - 1, 0, command);
  }

  const mapPath = getMapPath(projectPath, mapId);
  await commitChange(mapPath, map);

  return event;
}

/**
 * Get map dimensions
 */
export async function getMapDimensions(
  projectPath: string,
  mapId: number,
): Promise<{ width: number; height: number }> {
  const map = await getMap(projectPath, mapId);
  return {
    width: map.width,
    height: map.height,
  };
}

/**
 * Set map tile at specific position
 */
export async function setMapTile(
  projectPath: string,
  mapId: number,
  x: number,
  y: number,
  layer: number,
  tileId: number,
): Promise<void> {
  const map = await getMap(projectPath, mapId);

  if (x < 0 || x >= map.width || y < 0 || y >= map.height) {
    throw new Error(`Position (${x}, ${y}) is out of map bounds`);
  }

  // RPG Maker MZ stores tiles in a 1D array with 6 layers
  // Index = (layer * height + y) * width + x
  const index = tileIndex(map.width, map.height, x, y, layer);
  map.data[index] = tileId;

  const mapPath = getMapPath(projectPath, mapId);
  await commitChange(mapPath, map);
}

/**
 * Compute the flat `data` array index for a tile at (x, y) on a z-layer.
 *
 * RPG Maker MZ stores map tiles in a single 1D array of `width * height * 6`
 * entries (6 stacked layers: 2 lower, 2 upper, shadow pen, region ID). Kept as
 * a pure function so the index math can be unit-tested without file I/O.
 */
export function tileIndex(
  width: number,
  height: number,
  x: number,
  y: number,
  layer: number,
): number {
  return (layer * height + y) * width + x;
}

export const mapToolDefinitions: ToolDefinition[] = [
  {
    name: 'get_map',
    description: 'Get map data by ID',
    inputSchema: { mapId: z.number().describe('The ID of the map to retrieve') },
    handler: (ctx, args) => getMap(ctx.projectPath, args.mapId),
  },
  {
    name: 'get_map_infos',
    description: 'Get information about all maps',
    inputSchema: {},
    handler: (ctx) => getMapInfos(ctx.projectPath),
  },
  {
    name: 'create_map',
    mutates: true,
    description:
      'Create a new blank map: writes a new data/MapNNN.json (all tiles unpainted) and registers it in the map tree (MapInfos.json). Allocates the next unused map id and returns it. Paint tiles with set_map_tile and add events afterward.',
    inputSchema: {
      name: z.string().describe('Map name shown in the editor map tree'),
      width: z.number().int().positive().optional().describe('Width in tiles (default 17)'),
      height: z.number().int().positive().optional().describe('Height in tiles (default 13)'),
      parentId: z
        .number()
        .int()
        .optional()
        .describe('Parent map id in the tree; 0 (default) = top level'),
      tilesetId: z.number().int().positive().optional().describe('Tileset id (default 1)'),
    },
    handler: (ctx, args) =>
      createMap(ctx.projectPath, {
        name: args.name,
        width: args.width,
        height: args.height,
        parentId: args.parentId,
        tilesetId: args.tilesetId,
      }),
  },
  {
    name: 'delete_map',
    mutates: true,
    description:
      "Delete a map: remove its entry from the map tree (MapInfos.json) and delete its data/MapNNN.json file. The deleted map's direct children are reparented onto its parent (not deleted), so removing one node doesn't wipe a whole sub-tree. Does not touch System.json.",
    inputSchema: {
      mapId: z.number().int().positive().describe('The ID of the map to delete'),
    },
    handler: (ctx, args) => deleteMap(ctx.projectPath, args.mapId),
  },
  {
    name: 'update_map_tree',
    mutates: true,
    description:
      'Edit the map tree (MapInfos.json) only — reparent, reorder, rename, or expand/collapse maps without touching their tiles or events. Takes a batch of per-map updates; every referenced map (and any non-zero parentId) must exist, and the resulting tree must stay acyclic.',
    inputSchema: {
      updates: z
        .array(
          z.object({
            mapId: z.number().int().positive().describe('The map to update'),
            parentId: z.number().int().optional().describe('New parent map id; 0 = top level'),
            order: z.number().int().optional().describe('New sort order among siblings'),
            name: z.string().optional().describe('New tree display name'),
            expanded: z.boolean().optional().describe('Whether the node is expanded in the tree'),
          }),
        )
        .describe('One or more per-map tree edits to apply together'),
    },
    handler: (ctx, args) => updateMapTree(ctx.projectPath, args.updates),
  },
  {
    name: 'get_map_events',
    description: 'Get all events from a specific map',
    inputSchema: { mapId: z.number().describe('The ID of the map') },
    handler: (ctx, args) => getMapEvents(ctx.projectPath, args.mapId),
  },
  {
    name: 'get_map_event',
    description: 'Get a specific event from a map',
    inputSchema: {
      mapId: z.number().describe('The ID of the map'),
      eventId: z.number().describe('The ID of the event'),
    },
    handler: (ctx, args) => getMapEvent(ctx.projectPath, args.mapId, args.eventId),
  },
  {
    name: 'update_map_event',
    mutates: true,
    description: "Update a map event's properties",
    inputSchema: {
      mapId: z.number().describe('The ID of the map'),
      eventId: z.number().describe('The ID of the event'),
      updates: z
        .record(z.string(), z.unknown())
        .describe('Object containing event properties to update'),
    },
    handler: async (ctx, args) =>
      withValidation(await updateMapEvent(ctx.projectPath, args.mapId, args.eventId, args.updates)),
  },
  {
    name: 'create_map_event',
    mutates: true,
    description: 'Create a new event on a map',
    inputSchema: {
      mapId: z.number().describe('The ID of the map'),
      name: z.string().describe('Event name'),
      x: z.number().describe('X tile position'),
      y: z.number().describe('Y tile position'),
      note: z.string().optional().describe('Event note field'),
      pages: z.array(z.unknown()).describe('Event pages (conditions, image, command list, etc.)'),
    },
    handler: async (ctx, args) => {
      const { mapId, ...eventData } = args;
      return withValidation(
        await createMapEvent(ctx.projectPath, mapId, eventData as Omit<MapEvent, 'id'>),
      );
    },
  },
  {
    name: 'search_map_events',
    description: 'Search events on a map by name',
    inputSchema: {
      mapId: z.number().describe('The ID of the map'),
      searchTerm: z.string().describe('The search term to find events'),
    },
    handler: (ctx, args) => searchMapEvents(ctx.projectPath, args.mapId, args.searchTerm),
  },
  {
    name: 'add_event_command',
    mutates: true,
    description: 'Add a command to an event page',
    inputSchema: {
      mapId: z.number().describe('The ID of the map'),
      eventId: z.number().describe('The ID of the event'),
      pageIndex: z.number().describe('Zero-based page index'),
      command: z
        .object({
          code: z.number().describe('Event command code (see RPG Maker MZ documentation)'),
          indent: z.number().optional().default(0).describe('Indentation level'),
          parameters: z.array(z.unknown()).describe('Command parameters'),
        })
        .describe('The event command to insert'),
      position: z.number().optional().describe('Insertion index; defaults to end of the list'),
    },
    handler: async (ctx, args) =>
      withValidation(
        await addEventCommand(
          ctx.projectPath,
          args.mapId,
          args.eventId,
          args.pageIndex,
          args.command,
          args.position,
        ),
      ),
  },
  {
    name: 'update_map',
    mutates: true,
    description:
      "Update a map's top-level properties (name, display name, dimensions, bgm, etc.). Does not repaint tiles.",
    inputSchema: {
      mapId: z.number().describe('The ID of the map'),
      updates: z.record(z.string(), z.unknown()).describe('Partial MapData properties to merge'),
    },
    handler: (ctx, args) => updateMap(ctx.projectPath, args.mapId, args.updates),
  },
  {
    name: 'get_map_dimensions',
    description: 'Get the width and height (in tiles) of a map',
    inputSchema: { mapId: z.number().describe('The ID of the map') },
    handler: (ctx, args) => getMapDimensions(ctx.projectPath, args.mapId),
  },
  {
    name: 'set_map_tile',
    mutates: true,
    description:
      'Set a single raw tile ID at (x, y) on a given z-layer (0-5). Note: tile IDs are raw engine integers; this is a low-level primitive without autotile/passability awareness.',
    inputSchema: {
      mapId: z.number().describe('The ID of the map'),
      x: z.number().describe('X tile position'),
      y: z.number().describe('Y tile position'),
      layer: z.number().describe('Z-layer 0-5 (0-1 lower, 2-3 upper, 4 shadow, 5 region)'),
      tileId: z.number().describe('Raw tile ID'),
    },
    handler: async (ctx, args) => {
      await setMapTile(ctx.projectPath, args.mapId, args.x, args.y, args.layer, args.tileId);
      return { success: true };
    },
  },
  {
    name: 'delete_map_event',
    mutates: true,
    description: 'Delete an event from a map by ID',
    inputSchema: {
      mapId: z.number().describe('The ID of the map'),
      eventId: z.number().describe('The ID of the event'),
    },
    handler: async (ctx, args) => ({
      success: await deleteMapEvent(ctx.projectPath, args.mapId, args.eventId),
    }),
  },
];
