import { Direction, layeredPassability } from '../tiles/tileFlags.js';
import { MapData, Tileset } from '../utils/types.js';

export interface Point {
  x: number;
  y: number;
}

/** Bound imported template work and validate the six engine layer domains. */
export function validateMapGrid(map: MapData): void {
  if (
    !Number.isInteger(map.width) ||
    !Number.isInteger(map.height) ||
    map.width < 1 ||
    map.height < 1 ||
    map.width > 256 ||
    map.height > 256
  ) {
    throw new Error('Map dimensions must be integers from 1 to 256');
  }
  const area = map.width * map.height;
  if (!Array.isArray(map.data) || map.data.length !== area * 6) {
    throw new Error('Map data must contain exactly six complete layers');
  }
  if (!Number.isInteger(map.scrollType) || map.scrollType < 0 || map.scrollType > 3) {
    throw new Error('Invalid map scrollType');
  }
  map.data.forEach((value, index) => {
    const maximum = index < area * 4 ? 8191 : index < area * 5 ? 15 : 255;
    if (!Number.isInteger(value) || value < 0 || value > maximum) {
      throw new Error(`Invalid map data value at index ${index}`);
    }
  });
}

/** Small static passage check for generated layouts, using the shared flag codec. */
export function layoutConnectivity(map: MapData, tileset: Tileset, start?: Point) {
  validateMapGrid(map);
  const area = map.width * map.height;
  const passage = Array.from({ length: area }, (_, cell) => {
    const flags = [3, 2, 1, 0].map((z) => tileset.flags[map.data[z * area + cell]]);
    if (flags.some((flag) => !Number.isInteger(flag) || flag < 0)) {
      throw new Error('Tileset is missing valid flags for a layout tile');
    }
    return layeredPassability(flags);
  });
  const steps: [Direction, Direction, number, number][] = [
    ['down', 'up', 0, 1],
    ['left', 'right', -1, 0],
    ['right', 'left', 1, 0],
    ['up', 'down', 0, -1],
  ];
  const previous = new Int32Array(area).fill(-1);
  const groups: number[][] = [];
  const ordered = Array.from({ length: area }, (_, i) => i);
  if (start) {
    if (
      !Number.isInteger(start.x) ||
      !Number.isInteger(start.y) ||
      start.x < 0 ||
      start.x >= map.width ||
      start.y < 0 ||
      start.y >= map.height
    ) {
      throw new Error('Start position is outside the map');
    }
    ordered.unshift(start.y * map.width + start.x);
  }
  for (const cell of ordered) {
    if (previous[cell] !== -1 || !Object.values(passage[cell]).some(Boolean)) continue;
    previous[cell] = cell;
    const cells = [cell];
    for (let i = 0; i < cells.length; i++) {
      const from = cells[i];
      for (const [direction, reverse, dx, dy] of steps) {
        let x = (from % map.width) + dx,
          y = Math.floor(from / map.width) + dy;
        if (map.scrollType === 2 || map.scrollType === 3) x = (x + map.width) % map.width;
        if (map.scrollType === 1 || map.scrollType === 3) y = (y + map.height) % map.height;
        if (x < 0 || x >= map.width || y < 0 || y >= map.height) continue;
        const next = y * map.width + x;
        if (previous[next] !== -1 || !passage[from][direction] || !passage[next][reverse]) continue;
        previous[next] = from;
        cells.push(next);
      }
    }
    groups.push(cells);
  }
  const passableCells = groups.reduce((sum, group) => sum + group.length, 0);
  const reachable = start
    ? (groups.find((group) => group[0] === start.y * map.width + start.x) ?? [])
    : groups.reduce(
        (largest, group) => (group.length > largest.length ? group : largest),
        [] as number[],
      );
  return {
    previous,
    reachable,
    summary: {
      passableCells,
      componentCount: groups.length,
      reachablePassableCells: reachable.length,
      unreachablePassableCells: passableCells - reachable.length,
      limitations: [
        'Static tile passage only; events, vehicles, jumps, and plugin movement overrides are not simulated.',
      ],
    },
  };
}
