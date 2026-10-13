import { z } from 'zod';
import { layoutConnectivity, validateMapGrid } from '../generation/connectivity.js';
import { ToolDefinition } from '../registry.js';
import { commitStore } from '../utils/commit.js';
import { buildDungeon, designMarkers } from '../generation/dungeon.js';
import {
  reshapeLayers,
  validateProjectTiles,
  validateTileId,
  validateTileProfile,
} from '../generation/tileProfile.js';
import { blankMapData, createMap, getMap } from './mapTools.js';
import { getTileset } from './tilesetTools.js';

const destination = {
  name: z.string().trim().min(1).max(120),
  parentId: z.number().int().nonnegative().default(0),
};
const dungeonSchema = z.object({
  ...destination,
  width: z.number().int().min(9).max(256).default(41),
  height: z.number().int().min(9).max(256).default(31),
  tilesetId: z.number().int().positive(),
  seed: z.union([z.string().min(1).max(200), z.number().int().safe()]),
  tileProfile: z.object({
    floorTileId: z.number().int().positive(),
    wallTileId: z.number().int().positive(),
    corridorTileId: z.number().int().positive().optional(),
  }),
  roomCount: z.number().int().min(1).max(100).default(8),
  minRoomSize: z.number().int().min(3).max(64).default(4),
  maxRoomSize: z.number().int().min(3).max(64).default(9),
});
const templateSchema = z.object({
  ...destination,
  sourceMapId: z.number().int().positive(),
  tilesetId: z.number().int().positive().optional(),
  tileRemap: z
    .array(z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }))
    .max(8192)
    .default([]),
});

export async function generateDungeonMap(projectPath: string, args: unknown) {
  const input = dungeonSchema.parse(args);
  if (
    input.minRoomSize > input.maxRoomSize ||
    input.minRoomSize > Math.min(input.width, input.height) - 2
  )
    throw new Error('Room sizes do not fit the requested map dimensions');
  const tileset = await getTileset(projectPath, input.tilesetId);
  await validateTileProfile(projectPath, tileset, input.tileProfile);
  const generated = buildDungeon(input);
  const layout = layoutConnectivity(generated.map, tileset, generated.entrance).summary;
  if (layout.unreachablePassableCells !== 0)
    throw new Error('Generated floor contains disconnected passable cells');
  const markers = designMarkers(generated.map, tileset, generated.entrance);
  const metadata = {
    generator: 'seeded_rooms_v1',
    seed: input.seed,
    requestedRooms: input.roomCount,
    rooms: generated.rooms,
    markers,
    metadataOnly: true,
  };
  generated.map.note = `<MCPGeneratedLayout>${JSON.stringify(metadata)}</MCPGeneratedLayout>`;
  const { mapId, mapInfo } = await createMap(projectPath, input, generated.map);
  return {
    mapId,
    mapInfo,
    dryRun: commitStore.getStore()?.dryRun ?? false,
    generator: metadata.generator,
    seed: input.seed,
    roomCount: generated.rooms.length,
    markers,
    layout,
    warnings: [
      ...generated.warnings,
      'Entrance/key/door/boss/exit are design metadata only; no gameplay events, locks, rewards, or battles were created.',
      'Tile IDs, flags, and assigned-image presence were checked; image dimensions and visual appearance were not verified.',
    ],
  };
}

export async function generateMapFromTemplate(projectPath: string, args: unknown) {
  const input = templateSchema.parse(args);
  const source = await getMap(projectPath, input.sourceMapId);
  validateMapGrid(source);
  const map = blankMapData(source.width, source.height, input.tilesetId ?? source.tilesetId);
  map.data = [...source.data];
  map.scrollType = source.scrollType;
  map.events = [null];
  const tileset = await getTileset(projectPath, map.tilesetId);
  const replacements = new Map<number, number>();
  for (const pair of input.tileRemap) {
    validateTileId(pair.from);
    validateTileId(pair.to);
    if (replacements.has(pair.from)) throw new Error(`Duplicate tileRemap source ${pair.from}`);
    replacements.set(pair.from, pair.to);
  }
  const area = map.width * map.height;
  const layers = new Set<number>();
  let remappedCells = 0;
  for (let index = 0; index < area * 4; index++) {
    const replacement = replacements.get(map.data[index]);
    if (replacement !== undefined && replacement !== map.data[index]) {
      map.data[index] = replacement;
      layers.add(Math.floor(index / area));
      remappedCells++;
    }
  }
  await validateProjectTiles(projectPath, tileset, map.data.slice(0, area * 4));
  reshapeLayers(map, [...layers]);
  await validateProjectTiles(projectPath, tileset, map.data.slice(0, area * 4));
  map.note = `<MCPGeneratedLayout>${JSON.stringify({ generator: 'project_template_v1', sourceMapId: input.sourceMapId, tileRemap: input.tileRemap })}</MCPGeneratedLayout>`;
  const layout = layoutConnectivity(map, tileset).summary;
  const { mapId, mapInfo } = await createMap(
    projectPath,
    {
      name: input.name,
      parentId: input.parentId,
      width: map.width,
      height: map.height,
      tilesetId: map.tilesetId,
    },
    map,
  );
  return {
    mapId,
    mapInfo,
    dryRun: commitStore.getStore()?.dryRun ?? false,
    generator: 'project_template_v1',
    sourceMapId: input.sourceMapId,
    remappedCells,
    layout,
    warnings: [
      'Copied only tile/shadow/region layers and scroll type. Events, encounters, plugin notes, audio, and parallax settings were not copied.',
      'Tile IDs, flags, and assigned-image presence were checked; image dimensions and visual appearance were not verified.',
    ],
  };
}

export const mapGenerationToolDefinitions: ToolDefinition[] = [
  {
    name: 'generate_dungeon_map',
    mutates: true,
    inputSchema: dungeonSchema.shape,
    description:
      "Create a new deterministic seeded rooms-and-corridors map using caller-selected project tiles. Validates tile IDs, assigned-image presence and floor/wall passage, uses shared autotiling, verifies static connectivity, and creates the map through create_map's commit path. Entrance/key/door/boss/exit are metadata only, not gameplay. Supports dryRun preview.",
    handler: (ctx, args) => generateDungeonMap(ctx.projectPath, args),
  },
  {
    name: 'generate_map_from_template',
    mutates: true,
    inputSchema: templateSchema.shape,
    description:
      'Create a new map layout from a caller-selected project map. Copies tile/shadow/region layers and scroll type; optional tileRemap replaces exact raw IDs on tile layers and recomputes autotiles. Does not copy events, encounters, plugin notes, audio, or parallax. Uses project-owned sheets only. Supports dryRun preview.',
    handler: (ctx, args) => generateMapFromTemplate(ctx.projectPath, args),
  },
];
