import { describe, expect, it } from 'vitest';
import { analyzeMapLayout } from '../src/analysis/mapLayout.js';
import { blankMapData } from '../src/tools/mapTools.js';
import { MapEvent, Tileset } from '../src/utils/types.js';

const tileset = { id: 1, flags: [16, 0, 15, 4, 2] } as Tileset;
function fixture(width: number, height: number, cells: number[]) {
  const map = blankMapData(width, height, 1);
  map.data.splice(0, cells.length, ...cells);
  return map;
}
describe('whole-map static analysis', () => {
  it('detects disconnected rooms, start reachability, and repeated geometry', () => {
    const map = fixture(5, 2, [1, 1, 2, 1, 1, 1, 1, 2, 1, 1]);
    const result = analyzeMapLayout(map, tileset, { start: { x: 0, y: 0 } });
    expect(result).toMatchObject({
      componentCount: 2,
      passableCells: 8,
      blockedCells: 2,
      reachableCells: 4,
      unreachablePassableCells: 4,
    });
    expect(result.repetition.uniqueTileStacks).toBe(2);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: 'disconnected_passage' }),
    );
    expect(result.limits.join(' ')).toMatch(/Event collision/);
  });
  it('requires destination reverse passage, not just source passage', () => {
    expect(analyzeMapLayout(fixture(2, 1, [1, 4]), tileset).componentCount).toBe(2);
    expect(analyzeMapLayout(fixture(2, 1, [3, 1]), tileset).componentCount).toBe(2);
  });
  it('honors horizontal map wrapping and upper-layer star flags', () => {
    const map = fixture(3, 1, [1, 2, 1]);
    expect(analyzeMapLayout(map, tileset).componentCount).toBe(2);
    map.scrollType = 2;
    expect(analyzeMapLayout(map, tileset).componentCount).toBe(1);
    map.data[3 * 3] = 2;
    expect(analyzeMapLayout(map, tileset).blockedCells).toBe(2);
  });
  it('reports fully blocked starts without pretending they are reachable', () => {
    const result = analyzeMapLayout(fixture(2, 1, [2, 1]), tileset, { start: { x: 0, y: 0 } });
    expect(result.reachableCells).toBe(0);
    expect(result.unreachablePassableCells).toBe(1);
  });
  it('bounds component reports and rejects malformed grids/flags/positions', () => {
    const map = fixture(3, 1, [1, 2, 1]);
    expect(analyzeMapLayout(map, tileset, { maxComponents: 1 }).omittedComponents).toBe(1);
    expect(() => analyzeMapLayout(map, tileset, { start: { x: 3, y: 0 } })).toThrow(/outside/);
    expect(() => analyzeMapLayout(map, { ...tileset, flags: [] })).toThrow(/flags/);
    map.data.pop();
    expect(() => analyzeMapLayout(map, tileset)).toThrow(/layers/);
  });
  it('reports misplaced and statically inaccessible events without claiming runtime failure', () => {
    const map = fixture(5, 1, [1, 2, 2, 2, 1]);
    map.events = [
      null,
      { id: 1, name: 'Far', x: 4, y: 0 } as MapEvent,
      { id: 2, name: 'Outside', x: 5, y: 0 } as MapEvent,
    ];
    const result = analyzeMapLayout(map, tileset, { start: { x: 0, y: 0 } });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: 'event_without_static_access',
        eventId: 1,
        message: expect.stringContaining('runtime review'),
      }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: 'event_outside_map', eventId: 2 }),
    );
    expect(result.coverage.activePagesAndRuntime).toBe('not_simulated');
  });
  it('keeps repetitive geometry advisory and bounds findings deterministically', () => {
    const map = fixture(5, 5, new Array(25).fill(1));
    const result = analyzeMapLayout(map, tileset);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: 'repetitive_tile_stack',
        severity: 'info',
        message: expect.stringContaining('can be intentional'),
      }),
    );
    map.events = Array.from(
      { length: 60 },
      (_, index) => ({ id: index + 1, name: 'Outside', x: 10, y: 10 }) as MapEvent,
    );
    const bounded = analyzeMapLayout(map, tileset);
    expect(bounded.findings).toHaveLength(50);
    expect(bounded.findingCount).toBe(61);
    expect(bounded.omittedFindings).toBe(11);
    expect(bounded.findings).toEqual(analyzeMapLayout(map, tileset).findings);
  });
});
