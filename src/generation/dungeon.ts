import { Point, layoutConnectivity } from './connectivity.js';
import { blankMapData } from '../tools/mapTools.js';
import { MapData, Tileset } from '../utils/types.js';
import { TileProfile, reshapeLayers } from './tileProfile.js';

export interface DungeonOptions {
  width: number;
  height: number;
  tilesetId: number;
  seed: string | number;
  tileProfile: TileProfile;
  roomCount: number;
  minRoomSize: number;
  maxRoomSize: number;
}
interface Room {
  x: number;
  y: number;
  width: number;
  height: number;
}

function seededRandom(seed: string | number) {
  let state = 2166136261;
  for (const char of `${typeof seed}:${seed}`)
    state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => {
    state += 0x6d2b79f5;
    let n = state;
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed controls geometry only. Callers validate profile passage and project assets before committing. */
export function buildDungeon(options: DungeonOptions) {
  const { width, height, tileProfile, roomCount, minRoomSize, maxRoomSize } = options;
  const random = seededRandom(options.seed);
  const randomInt = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const map = blankMapData(width, height, options.tilesetId);
  map.events = [null];
  map.data.fill(tileProfile.wallTileId, 0, width * height);
  const rooms: Room[] = [];
  const paint = (x: number, y: number, tile: number) => {
    map.data[y * width + x] = tile;
  };
  const center = (room: Room): Point => ({
    x: room.x + Math.floor(room.width / 2),
    y: room.y + Math.floor(room.height / 2),
  });
  for (let attempt = 0; attempt < roomCount * 40 && rooms.length < roomCount; attempt++) {
    const rw = randomInt(minRoomSize, Math.min(maxRoomSize, width - 2));
    const rh = randomInt(minRoomSize, Math.min(maxRoomSize, height - 2));
    const room: Room = {
      x: randomInt(1, width - rw - 1),
      y: randomInt(1, height - rh - 1),
      width: rw,
      height: rh,
    };
    if (
      rooms.some(
        (other) =>
          room.x <= other.x + other.width &&
          room.x + room.width >= other.x &&
          room.y <= other.y + other.height &&
          room.y + room.height >= other.y,
      )
    )
      continue;
    for (let y = room.y; y < room.y + rh; y++)
      for (let x = room.x; x < room.x + rw; x++) paint(x, y, tileProfile.floorTileId);
    if (rooms.length) {
      const from = center(rooms[rooms.length - 1]),
        to = center(room);
      let x = from.x,
        y = from.y;
      const corridor = tileProfile.corridorTileId ?? tileProfile.floorTileId;
      const horizontal = () => {
        while (x !== to.x) {
          x += Math.sign(to.x - x);
          if (map.data[y * width + x] === tileProfile.wallTileId) paint(x, y, corridor);
        }
      };
      const vertical = () => {
        while (y !== to.y) {
          y += Math.sign(to.y - y);
          if (map.data[y * width + x] === tileProfile.wallTileId) paint(x, y, corridor);
        }
      };
      if (random() < 0.5) {
        horizontal();
        vertical();
      } else {
        vertical();
        horizontal();
      }
    }
    rooms.push(room);
  }
  if (!rooms.length) throw new Error('The requested dimensions cannot contain a room');
  reshapeLayers(map, [0]);
  return {
    map,
    rooms,
    entrance: center(rooms[0]),
    warnings:
      rooms.length < roomCount
        ? [`Placed ${rooms.length} of ${roomCount} requested rooms within the map bounds`]
        : [],
  };
}

/** Suggested reachable points, without adding events, locks, rewards, or battles. */
export function designMarkers(map: MapData, tileset: Tileset, entrance: Point) {
  const graph = layoutConnectivity(map, tileset, entrance);
  const start = entrance.y * map.width + entrance.x;
  const queue = graph.reachable;
  const previous = graph.previous;
  if (!queue.length) throw new Error('Generated entrance must be passable');
  const path = [queue[queue.length - 1]];
  while (path[path.length - 1] !== start) path.push(previous[path[path.length - 1]]);
  path.reverse();
  // A single small room may have no five-cell shortest path. Spread the markers
  // across its reachable cells instead of assigning multiple roles to one tile.
  const candidates = path.length >= 5 ? path : queue;
  const labels = ['entrance', 'key', 'door', 'boss', 'exit'] as const;
  return labels.map((role, index) => {
    const cell = candidates[Math.round(((candidates.length - 1) * index) / 4)];
    return {
      role,
      x: cell % map.width,
      y: Math.floor(cell / map.width),
      metadataOnly: true as const,
    };
  });
}
