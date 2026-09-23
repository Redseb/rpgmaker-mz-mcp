import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { catalogToolDefinitions } from '../src/tools/catalogTools.js';
import { makeAutotileId } from '../src/tiles/tileCodec.js';
import { OUTSIDE_TILE_NAMES } from '../src/tiles/catalog/outside.js';

/**
 * The catalog tools load project-scoped catalogs from data/tilecatalog/
 * (written by the vision-bootstrap skill) and resolve their names alongside the
 * built-in Overworld catalog. Exercised through the real tool handlers.
 */

const getCatalog = catalogToolDefinitions.find((t) => t.name === 'get_tile_catalog')!;
const findTile = catalogToolDefinitions.find((t) => t.name === 'find_tile')!;

/** A tileset whose A2 slot is a custom sheet plus the built-in Overworld A1/B. */
const TILESETS = [
  null,
  {
    id: 1,
    name: 'Custom World',
    mode: 0,
    note: '',
    tilesetNames: ['World_A1', 'Custom_A2', '', '', '', 'World_B', '', '', ''],
    flags: [],
  },
];

const CUSTOM_A2_CATALOG = {
  sheet: 'Custom_A2',
  role: 'A2',
  autotile: true,
  version: 1,
  entries: {
    '0': {
      name: 'Emerald Grass',
      description: 'bright green grass with flowers',
      confidence: 'high',
      manual: false,
    },
    '1': {
      name: 'Cracked Earth',
      description: 'dry cracked dirt',
      confidence: 'low',
      manual: true,
    },
  },
};

async function scaffold(withCatalog: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmz-catalog-'));
  await writeFile(join(dir, 'game.rmmzproject'), 'RPGMZ 1.0.0');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');
  await writeFile(join(dir, 'data', 'Tilesets.json'), JSON.stringify(TILESETS));
  if (withCatalog) {
    await mkdir(join(dir, 'data', 'tilecatalog'));
    await writeFile(
      join(dir, 'data', 'tilecatalog', 'Custom_A2.json'),
      JSON.stringify(CUSTOM_A2_CATALOG),
    );
  }
  return dir;
}

describe('catalog tools with project-scoped catalogs (integration)', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('omits the custom sheet when no project catalog exists', async () => {
    dir = await scaffold(false);
    // Unfiltered call returns a per-sheet summary (not every entry).
    const res = (await getCatalog.handler({ projectPath: dir }, { tilesetId: 1 })) as {
      summary: boolean;
      sheets: { sheet: string; count: number }[];
    };
    // World_A1 (built-in) resolves; Custom_A2 does not.
    expect(res.summary).toBe(true);
    expect(res.sheets.some((s) => s.sheet === 'World_A1')).toBe(true);
    expect(res.sheets.some((s) => s.sheet === 'Custom_A2')).toBe(false);
  });

  it('an unfiltered call returns per-sheet counts only, no entries', async () => {
    dir = await scaffold(true);
    const res = (await getCatalog.handler({ projectPath: dir }, { tilesetId: 1 })) as {
      summary: boolean;
      totalEntries: number;
      sheets: { sheet: string; role: string; source: string; count: number }[];
      entries?: unknown;
    };
    expect(res.summary).toBe(true);
    expect(res.entries).toBeUndefined();
    const customA2 = res.sheets.find((s) => s.sheet === 'Custom_A2')!;
    expect(customA2).toMatchObject({ role: 'A2', source: 'project', count: 2 });
    // totalEntries is the sum of the per-sheet counts.
    expect(res.totalEntries).toBe(res.sheets.reduce((n, s) => n + s.count, 0));
  });

  it('resolves custom-sheet names once a project catalog is present', async () => {
    dir = await scaffold(true);
    const res = (await getCatalog.handler(
      { projectPath: dir },
      { tilesetId: 1, sheet: 'Custom_A2' },
    )) as {
      entries: {
        name: string;
        tileId: number;
        source: string;
        description?: string;
        confidence?: string;
        manual?: boolean;
      }[];
    };
    expect(res.entries.map((e) => e.name)).toEqual(['Emerald Grass', 'Cracked Earth']);
    const grass = res.entries.find((e) => e.name === 'Emerald Grass')!;
    expect(grass.tileId).toBe(makeAutotileId(16, 0)); // A2 first kind, shape-0 base
    expect(grass).toMatchObject({
      source: 'project',
      description: 'bright green grass with flowers',
      confidence: 'high',
      manual: false,
    });
  });

  it('find_tile matches a project-catalog description only when asked', async () => {
    dir = await scaffold(true);
    type FindResult = {
      count: number;
      searchedDescriptions: boolean;
      matches: { name: string; matchedIn: string[]; description?: string }[];
    };
    // "flowers" appears only in Emerald Grass's description, never in a name.
    const namesOnly = (await findTile.handler(
      { projectPath: dir },
      { tilesetId: 1, query: 'flowers' },
    )) as FindResult;
    expect(namesOnly.count).toBe(0);
    expect(namesOnly.searchedDescriptions).toBe(false);

    const widened = (await findTile.handler(
      { projectPath: dir },
      { tilesetId: 1, query: 'flowers', searchDescriptions: true },
    )) as FindResult;
    expect(widened.searchedDescriptions).toBe(true);
    expect(widened.matches.map((m) => m.name)).toEqual(['Emerald Grass']);
    expect(widened.matches[0].matchedIn).toEqual(['description']);
  });

  it('find_tile reports both fields when the query hits name and description', async () => {
    dir = await scaffold(true);
    const res = (await findTile.handler(
      { projectPath: dir },
      { tilesetId: 1, query: 'grass', searchDescriptions: true },
    )) as { matches: { name: string; matchedIn: string[] }[] };
    expect(res.matches.find((m) => m.name === 'Emerald Grass')!.matchedIn).toEqual([
      'name',
      'description',
    ]);
  });

  it('find_tile bridges a custom name to a paintable tile id', async () => {
    dir = await scaffold(true);
    const res = (await findTile.handler(
      { projectPath: dir },
      { tilesetId: 1, query: 'emerald' },
    )) as { matches: { name: string; tileId: number; source: string }[]; count: number };
    expect(res.count).toBe(1);
    expect(res.matches[0]).toMatchObject({
      name: 'Emerald Grass',
      tileId: makeAutotileId(16, 0),
      source: 'project',
    });
  });

  it('built-in Overworld names still resolve and stay tagged builtin', async () => {
    dir = await scaffold(true);
    const res = (await findTile.handler({ projectPath: dir }, { tilesetId: 1, query: 'sea' })) as {
      matches: { name: string; source: string }[];
    };
    const sea = res.matches.find((e) => e.name === 'Sea')!;
    expect(sea.source).toBe('builtin');
  });
});

/**
 * #11 — a DLC-style sheet ships a `.txt` name sidecar next to its PNG. The
 * acceptance case: an RTP sheet's sidecar copied in under a new filename
 * resolves with no catalog files present.
 */
describe('catalog tools with .txt name sidecars (integration)', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const SIDECAR_TILESETS = [
    null,
    {
      id: 1,
      name: 'DLC Outside',
      mode: 0,
      note: '',
      tilesetNames: ['', 'Tl_Outside_A2', '', '', '', '', '', '', ''],
      flags: [],
    },
  ];

  /** The RTP Outside_A2 names in on-disk sidecar form: BOM, CRLF, JP half, trailing blanks. */
  const sidecarText =
    '\uFEFF' +
    OUTSIDE_TILE_NAMES.Outside_A2.map((n) => `${n}|日本語`).join('\r\n') +
    '\r\n'.repeat(25);

  async function scaffoldSidecar(catalog?: object): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), 'rpgmz-sidecar-'));
    await writeFile(join(d, 'game.rmmzproject'), 'RPGMZ 1.0.0');
    await mkdir(join(d, 'data'));
    await writeFile(join(d, 'data', 'System.json'), '{}');
    await writeFile(join(d, 'data', 'Tilesets.json'), JSON.stringify(SIDECAR_TILESETS));
    await mkdir(join(d, 'img', 'tilesets'), { recursive: true });
    await writeFile(join(d, 'img', 'tilesets', 'Tl_Outside_A2.txt'), sidecarText);
    if (catalog) {
      await mkdir(join(d, 'data', 'tilecatalog'));
      await writeFile(
        join(d, 'data', 'tilecatalog', 'Tl_Outside_A2.json'),
        JSON.stringify(catalog),
      );
    }
    return d;
  }

  it("find_tile('grass') hits a renamed sheet via its sidecar, with no catalog files", async () => {
    dir = await scaffoldSidecar();
    const res = (await findTile.handler(
      { projectPath: dir },
      { tilesetId: 1, query: 'grass' },
    )) as {
      count: number;
      matches: { name: string; sheet: string; tileId: number; source: string }[];
    };
    expect(res.count).toBeGreaterThan(0);
    expect(res.matches.every((m) => m.sheet === 'Tl_Outside_A2' && m.source === 'sidecar')).toBe(
      true,
    );
    const firstIdx = OUTSIDE_TILE_NAMES.Outside_A2.findIndex((n) => /grass/i.test(n));
    const first = res.matches.find((m) => m.name === OUTSIDE_TILE_NAMES.Outside_A2[firstIdx])!;
    expect(first.tileId).toBe(makeAutotileId(16 + firstIdx, 0));
  });

  it('get_tile_catalog summarizes the sidecar sheet as source sidecar', async () => {
    dir = await scaffoldSidecar();
    const res = (await getCatalog.handler({ projectPath: dir }, { tilesetId: 1 })) as {
      cataloged: boolean;
      sheets: { sheet: string; source: string; count: number }[];
    };
    expect(res.cataloged).toBe(true);
    const expected = OUTSIDE_TILE_NAMES.Outside_A2.filter((n) => n && n !== 'Transparent').length;
    expect(res.sheets).toEqual([
      { sheet: 'Tl_Outside_A2', role: 'A2', source: 'sidecar', count: expected },
    ]);
  });

  it('a manual project entry outranks the sidecar; a vision draft does not', async () => {
    dir = await scaffoldSidecar({
      sheet: 'Tl_Outside_A2',
      entries: {
        '0': { name: 'Verified Meadow', manual: true },
        '1': { name: 'Draft Guess', manual: false, confidence: 'low' },
      },
    });
    const res = (await getCatalog.handler({ projectPath: dir }, { tilesetId: 1, sheet: 'A2' })) as {
      entries: { name: string; source: string; manual?: boolean }[];
    };
    expect(res.entries[0]).toMatchObject({ name: 'Verified Meadow', source: 'project' });
    expect(res.entries[1]).toMatchObject({
      name: OUTSIDE_TILE_NAMES.Outside_A2[1],
      source: 'sidecar',
    });
    expect(res.entries.some((e) => e.name === 'Draft Guess')).toBe(false);

    const summary = (await getCatalog.handler({ projectPath: dir }, { tilesetId: 1 })) as {
      sheets: { source: string }[];
    };
    expect(summary.sheets[0].source).toBe('mixed');
  });
});
