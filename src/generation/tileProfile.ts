import { join, basename } from 'path';
import { applyAutotiling } from '../tiles/paint.js';
import { autotileType, decodeTile, getAutotileKind, makeAutotileId } from '../tiles/tileCodec.js';
import { layeredPassability } from '../tiles/tileFlags.js';
import { fileExists } from '../utils/fileHandler.js';
import { MapData, Tileset } from '../utils/types.js';

export interface TileProfile {
  floorTileId: number;
  wallTileId: number;
  corridorTileId?: number;
}
const sheets = ['A1', 'A2', 'A3', 'A4', 'A5', 'B', 'C', 'D', 'E'];

export function validateTileId(tile: number): void {
  if (
    !Number.isInteger(tile) ||
    tile < 0 ||
    tile >= 8192 ||
    (tile >= 1024 && tile < 1536) ||
    (tile >= 1664 && tile < 2048)
  )
    throw new Error(`Tile ID ${tile} is outside the MZ tileset layout`);
  const decoded = decodeTile(tile);
  if (
    decoded.autotile &&
    ((decoded.autotileType === 'wall' && decoded.shape! > 15) ||
      (decoded.autotileType === 'waterfall' && decoded.shape! > 3))
  )
    throw new Error(`Tile ID ${tile} uses an invalid autotile shape`);
}

/** Requires caller-owned, assigned project sheets; never supplies or copies RTP graphics. */
export async function validateProjectTiles(
  projectPath: string,
  tileset: Tileset,
  ids: Iterable<number>,
): Promise<void> {
  if (!Array.isArray(tileset.flags) || !Array.isArray(tileset.tilesetNames))
    throw new Error('Tileset must contain flags and tilesetNames');
  const checkedSheets = new Set<string>();
  for (const tile of new Set(ids)) {
    validateTileId(tile);
    if (!Number.isInteger(tileset.flags[tile]) || tileset.flags[tile] < 0)
      throw new Error(`Tileset has no valid flags for tile ${tile}`);
    if (tile === 0) continue;
    const decoded = decodeTile(tile);
    const name = tileset.tilesetNames[sheets.indexOf(decoded.sheet!)];
    if (!name || name !== basename(name) || /[\\/:]/.test(name) || name === '.' || name === '..')
      throw new Error(`Tileset sheet ${decoded.sheet} is missing or has an unsafe image name`);
    if (checkedSheets.has(name)) continue;
    checkedSheets.add(name);
    const png = join(projectPath, 'img', 'tilesets', name + '.png');
    if (!(await fileExists(png)) && !(await fileExists(png + '_')))
      throw new Error(`Assigned tileset image ${name}.png is missing from this project`);
  }
}

export async function validateTileProfile(
  projectPath: string,
  tileset: Tileset,
  profile: TileProfile,
): Promise<void> {
  const roles = [
    ['floor', profile.floorTileId, true],
    ['wall', profile.wallTileId, false],
    ['corridor', profile.corridorTileId ?? profile.floorTileId, true],
  ] as const;
  const ids = [0];
  for (const [role, tile, walkable] of roles) {
    validateTileId(tile);
    if (tile === 0) throw new Error(`${role} must select a nonempty tile`);
    const type = autotileType(tile);
    const shapes = type
      ? Array.from({ length: type === 'wall' ? 16 : type === 'waterfall' ? 4 : 48 }, (_, shape) =>
          makeAutotileId(getAutotileKind(tile), shape),
        )
      : [tile];
    for (const variant of shapes) {
      ids.push(variant);
      const flags = [tileset.flags[0], tileset.flags[0], tileset.flags[0], tileset.flags[variant]];
      if (flags.some((flag) => !Number.isInteger(flag) || flag < 0))
        throw new Error(`Missing tile flags for ${role} tile ${variant}`);
      const passage = Object.values(layeredPassability(flags));
      if (walkable ? !passage.every(Boolean) : passage.some(Boolean))
        throw new Error(
          `${role} tile ${variant} must be ${walkable ? 'passable in all four directions' : 'blocked in all four directions'} with this tileset's empty upper layers`,
        );
    }
  }
  await validateProjectTiles(projectPath, tileset, ids);
}

/** Reuse MZ's shape solver, including wrapped neighbors on looping templates. */
export function reshapeLayers(map: MapData, layers: number[]): void {
  const area = map.width * map.height;
  const cells = Array.from({ length: area }, (_, cell) => ({
    x: cell % map.width,
    y: Math.floor(cell / map.width),
  }));
  for (const layer of layers) {
    applyAutotiling(
      {
        width: map.width,
        height: map.height,
        loopHorizontal: map.scrollType === 2 || map.scrollType === 3,
        loopVertical: map.scrollType === 1 || map.scrollType === 3,
        get: (x, y) => map.data[layer * area + y * map.width + x],
        set: (x, y, tile) => {
          map.data[layer * area + y * map.width + x] = tile;
        },
      },
      cells,
    );
  }
}
