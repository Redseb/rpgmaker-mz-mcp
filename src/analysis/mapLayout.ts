import { Direction, Passability, layeredPassability } from '../tiles/tileFlags.js';
import { getAutotileKind, isAutotile } from '../tiles/tileCodec.js';
import { MapData, Tileset } from '../utils/types.js';

export interface Point {
  x: number;
  y: number;
}
export interface LayoutFinding {
  code: string;
  severity: 'warning' | 'info';
  message: string;
  eventId?: number;
}
const steps: { direction: Direction; reverse: Direction; dx: number; dy: number }[] = [
  { direction: 'down', reverse: 'up', dx: 0, dy: 1 },
  { direction: 'left', reverse: 'right', dx: -1, dy: 0 },
  { direction: 'right', reverse: 'left', dx: 1, dy: 0 },
  { direction: 'up', reverse: 'down', dx: 0, dy: -1 },
];

export const STATIC_LAYOUT_LIMITS = [
  'Static tile passage only: both source exit and destination reverse-direction passage are checked.',
  'Event collision, active event pages, tile-event graphics, vehicles, jumps, through/debug movement, and plugin overrides are not simulated.',
  'Event access describes tile positions and adjacent reachable tiles; it does not prove an event can trigger.',
];

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
  if (!Array.isArray(map.data) || map.data.length !== map.width * map.height * 6)
    throw new Error('Map data must contain exactly six complete layers');
  if (!Number.isInteger(map.scrollType) || map.scrollType < 0 || map.scrollType > 3)
    throw new Error('Invalid map scrollType');
  const area = map.width * map.height;
  for (let index = 0; index < map.data.length; index++) {
    const value = map.data[index];
    const maximum = index < area * 4 ? 8191 : index < area * 5 ? 15 : 255;
    if (!Number.isInteger(value) || value < 0 || value > maximum)
      throw new Error(`Invalid map data value at index ${index}`);
  }
}

export function buildPassageGraph(map: MapData, tileset: Tileset) {
  validateMapGrid(map);
  if (!Array.isArray(tileset.flags)) throw new Error('Tileset flags are required');
  const area = map.width * map.height;
  const passage: Passability[] = [];
  for (let cell = 0; cell < area; cell++) {
    const flags: number[] = [];
    for (let layer = 3; layer >= 0; layer--) {
      const tileId = map.data[cell + layer * area];
      const flag = tileset.flags[tileId];
      if (!Number.isInteger(flag) || flag < 0)
        throw new Error(`Tileset ${tileset.id} has no valid flags for tile ${tileId}`);
      flags.push(flag);
    }
    passage.push(layeredPassability(flags));
  }
  const neighbor = (cell: number, dx: number, dy: number): number | undefined => {
    let x = (cell % map.width) + dx;
    let y = Math.floor(cell / map.width) + dy;
    if (map.scrollType === 2 || map.scrollType === 3) x = (x + map.width) % map.width;
    if (map.scrollType === 1 || map.scrollType === 3) y = (y + map.height) % map.height;
    if (x < 0 || x >= map.width || y < 0 || y >= map.height) return undefined;
    return y * map.width + x;
  };
  const neighbors = (cell: number): number[] => {
    const result: number[] = [];
    for (const step of steps) {
      const next = neighbor(cell, step.dx, step.dy);
      if (
        next !== undefined &&
        next !== cell &&
        passage[cell][step.direction] &&
        passage[next][step.reverse] &&
        !result.includes(next)
      )
        result.push(next);
    }
    return result;
  };
  return { passage, neighbor, neighbors, area };
}

/** Whole-map geometry and passage metrics. Does not run game code or infer active event pages. */
export function analyzeMapLayout(
  map: MapData,
  tileset: Tileset,
  options: { start?: Point; maxComponents?: number } = {},
) {
  const maxComponents = options.maxComponents ?? 20;
  if (!Number.isInteger(maxComponents) || maxComponents < 1 || maxComponents > 100)
    throw new Error('maxComponents must be 1 through 100');
  const graph = buildPassageGraph(map, tileset);
  const labels = new Int32Array(graph.area).fill(-1);
  const groups: number[][] = [];
  const point = (cell: number): Point => ({ x: cell % map.width, y: Math.floor(cell / map.width) });
  for (let cell = 0; cell < graph.area; cell++) {
    if (labels[cell] !== -1 || !Object.values(graph.passage[cell]).some(Boolean)) continue;
    const members = [cell];
    labels[cell] = groups.length;
    for (let index = 0; index < members.length; index++) {
      for (const next of graph.neighbors(members[index])) {
        if (labels[next] === -1) {
          labels[next] = groups.length;
          members.push(next);
        }
      }
    }
    groups.push(members);
  }
  const ordered = groups
    .map((cells, id) => ({ cells, id }))
    .sort((a, b) => b.cells.length - a.cells.length || a.id - b.id);
  const start = options.start ?? (ordered.length ? point(ordered[0].cells[0]) : undefined);
  if (
    start &&
    (!Number.isInteger(start.x) ||
      !Number.isInteger(start.y) ||
      start.x < 0 ||
      start.y < 0 ||
      start.x >= map.width ||
      start.y >= map.height)
  )
    throw new Error('Start position is outside the map');
  const startLabel = start ? labels[start.y * map.width + start.x] : -1;
  const reachable = startLabel >= 0 ? groups[startLabel].length : 0;
  const passable = groups.reduce((sum, cells) => sum + cells.length, 0);
  const signatures = new Map<string, number>();
  const cellSignatures: string[] = [];
  for (let cell = 0; cell < graph.area; cell++) {
    const signature = [0, 1, 2, 3]
      .map((layer) => {
        const tile = map.data[cell + layer * graph.area];
        return isAutotile(tile) ? `a${getAutotileKind(tile)}` : String(tile);
      })
      .join(',');
    cellSignatures.push(signature);
    signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
  }
  let adjacentPairs = 0;
  let repeatedPairs = 0;
  let directedEdges = 0;
  for (let cell = 0; cell < graph.area; cell++) {
    directedEdges += graph.neighbors(cell).length;
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
    ]) {
      const next = graph.neighbor(cell, dx, dy);
      if (next === undefined || next === cell) continue;
      adjacentPairs++;
      if (cellSignatures[cell] === cellSignatures[next]) repeatedPairs++;
    }
  }
  const events = (map.events ?? [])
    .filter((event) => event != null)
    .map((event) => {
      const inBounds =
        Number.isInteger(event.x) &&
        Number.isInteger(event.y) &&
        event.x >= 0 &&
        event.y >= 0 &&
        event.x < map.width &&
        event.y < map.height;
      const cell = event.y * map.width + event.x;
      return {
        eventId: event.id,
        name: event.name,
        x: event.x,
        y: event.y,
        inBounds,
        standingReachable: inBounds && startLabel >= 0 && labels[cell] === startLabel,
        adjacentReachable:
          inBounds &&
          startLabel >= 0 &&
          steps.some((step) => {
            const next = graph.neighbor(cell, step.dx, step.dy);
            return next !== undefined && labels[next] === startLabel;
          }),
      };
    });
  const dominantStackFraction = signatures.size ? Math.max(...signatures.values()) / graph.area : 0;
  const adjacentEqualFraction = adjacentPairs ? repeatedPairs / adjacentPairs : 0;
  const findings: LayoutFinding[] = [];
  if (passable === 0)
    findings.push({
      code: 'no_passable_tiles',
      severity: 'warning',
      message: 'No cells permit static tile passage in any direction.',
    });
  if (start && startLabel < 0)
    findings.push({
      code: 'blocked_start',
      severity: 'warning',
      message: `Reference start (${start.x}, ${start.y}) has no static tile passage.`,
    });
  if (groups.length > 1)
    findings.push({
      code: 'disconnected_passage',
      severity: 'warning',
      message: `${groups.length} separate static passage areas; ${passable - reachable} passable cells are unreachable from the reference start. Transfers, jumps, or plugin behavior may connect them at runtime.`,
    });
  if (graph.area >= 25 && dominantStackFraction >= 0.85 && adjacentEqualFraction >= 0.8)
    findings.push({
      code: 'repetitive_tile_stack',
      severity: 'info',
      message: `${Math.round(dominantStackFraction * 100)}% of cells share the same tile stack (ignoring autotile shapes). This can be intentional; assess visual variety in the editor rather than treating repetition as a defect.`,
    });
  for (const event of events) {
    if (!event.inBounds)
      findings.push({
        code: 'event_outside_map',
        severity: 'warning',
        eventId: event.eventId,
        message: `Event ${event.eventId} is outside the map grid at (${event.x}, ${event.y}).`,
      });
    else if (!event.standingReachable && !event.adjacentReachable)
      findings.push({
        code: 'event_without_static_access',
        severity: 'warning',
        eventId: event.eventId,
        message: `Event ${event.eventId} has no reachable standing or adjacent tile from the reference start. Counter interactions, remote calls, and active event behavior require runtime review.`,
      });
  }
  return {
    width: map.width,
    height: map.height,
    tilesetId: map.tilesetId,
    scrollType: map.scrollType,
    totalCells: graph.area,
    passableCells: passable,
    blockedCells: graph.area - passable,
    connectedPairs: directedEdges / 2,
    componentCount: groups.length,
    components: ordered.slice(0, maxComponents).map(({ cells, id }) => {
      let minX = map.width,
        minY = map.height,
        maxX = 0,
        maxY = 0;
      for (const cell of cells) {
        const p = point(cell);
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      return {
        id,
        cells: cells.length,
        sample: point(cells[0]),
        bounds: { minX, minY, maxX, maxY },
        containsStart: id === startLabel,
      };
    }),
    omittedComponents: Math.max(0, groups.length - maxComponents),
    start: start ?? null,
    startSource: options.start ? 'caller' : 'largest_component',
    reachableCells: reachable,
    unreachablePassableCells: passable - reachable,
    isolatedCells: groups.filter((cells) => cells.length === 1).length,
    repetition: {
      uniqueTileStacks: signatures.size,
      dominantStackFraction,
      adjacentEqualFraction,
      ignoresAutotileShapeVariants: true,
    },
    eventAccess: events,
    findings: findings.slice(0, 50),
    findingCount: findings.length,
    omittedFindings: Math.max(0, findings.length - 50),
    coverage: {
      tileLayers: [0, 1, 2, 3],
      ignoresAutotileShapeForRepetition: true,
      eventAccess: 'positions_only',
      activePagesAndRuntime: 'not_simulated',
      maxReportedFindings: 50,
    },
    limits: STATIC_LAYOUT_LIMITS,
  };
}
