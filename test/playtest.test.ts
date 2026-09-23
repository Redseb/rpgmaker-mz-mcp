import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  resolveRequestPath,
  startStaticServer,
  StaticServer,
} from '../src/playtest/staticServer.js';
import { planRender, MAX_RENDER_EDGE_PX } from '../src/playtest/render.js';
import { checkSteps, playtestSteps } from '../src/playtest/steps.js';
import { driverCall } from '../src/playtest/session.js';
import { safeName } from '../src/playtest/output.js';
import { playtestToolDefinitions } from '../src/tools/playtestTools.js';

describe('resolveRequestPath', () => {
  const root = resolve('/proj');
  it('maps URLs under the root and serves index.html for /', () => {
    expect(resolveRequestPath(root, '/')).toBe(join(root, 'index.html'));
    expect(resolveRequestPath(root, '/img/characters/Actor1.png?x=1')).toBe(
      join(root, 'img', 'characters', 'Actor1.png'),
    );
    expect(resolveRequestPath(root, '/img/%21Chest.png')).toBe(join(root, 'img', '!Chest.png'));
  });

  it('refuses traversal out of the root', () => {
    expect(resolveRequestPath(root, '/../secret')).toBeNull();
    expect(resolveRequestPath(root, '/%2e%2e/secret')).toBeNull();
    expect(resolveRequestPath(root, '/img/../../x')).toBeNull();
    expect(resolveRequestPath(root, '/%E0%A4%A')).toBeNull(); // malformed escape
  });
});

describe('startStaticServer', () => {
  let dir: string;
  let server: StaticServer;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rmmz-static-'));
    await mkdir(join(dir, 'data'));
    await writeFile(join(dir, 'data', 'System.json'), '{"a":1}');
    server = await startStaticServer(dir);
  });
  afterAll(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves project files with a content type, and 404s missing ones', async () => {
    const ok = await fetch(`${server.origin}/data/System.json`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/application\/json/);
    expect(await ok.json()).toEqual({ a: 1 });
    expect((await fetch(`${server.origin}/img/missing.png`)).status).toBe(404);
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe('planRender', () => {
  it('renders the whole map by default, player hidden', () => {
    expect(planRender({ width: 17, height: 13 }, {})).toEqual({
      mode: 'whole_map',
      x: 0,
      y: 0,
      viewport: { width: 816, height: 624 },
      showPlayer: false,
    });
  });

  it('renders a centred view when x and y are given', () => {
    const plan = planRender({ width: 40, height: 40 }, { x: 10, y: 12 });
    expect(plan).toMatchObject({ mode: 'view', x: 10, y: 12, showPlayer: true });
    expect(plan.viewport).toEqual({ width: 816, height: 624 });
  });

  it('rejects half a coordinate, out-of-map tiles and oversize maps', () => {
    expect(() => planRender({ width: 10, height: 10 }, { x: 1 })).toThrow(/both x and y/);
    expect(() => planRender({ width: 10, height: 10 }, { x: 10, y: 0 })).toThrow(/outside/);
    const edge = Math.floor(MAX_RENDER_EDGE_PX / 48) + 1;
    expect(() => planRender({ width: edge, height: 5 }, {})).toThrow(/Pass x and y/);
    // …but a view of an oversize map is fine.
    expect(planRender({ width: edge, height: 5 }, { x: 0, y: 0 }).mode).toBe('view');
  });
});

describe('playtest steps', () => {
  it('parses a typical script', () => {
    const steps = playtestSteps.parse([
      { action: 'load', mapId: 2, x: 6, y: 6, switches: [12], items: [{ id: 1 }] },
      { action: 'startEvent', eventId: 1 },
      { action: 'advanceText' },
      { action: 'choose', index: 1 },
      { action: 'walk', direction: 'left', steps: 3 },
      { action: 'autoBattle', troopId: 4 },
      { action: 'screenshot', name: 'end' },
      { action: 'eval', script: '$gameSwitches.value(3)' },
    ]);
    expect(steps).toHaveLength(8);
    expect(checkSteps(steps)).toEqual([]);
  });

  it('rejects unknown actions, bad fields and empty scripts', () => {
    expect(playtestSteps.safeParse([{ action: 'fly' }]).success).toBe(false);
    expect(playtestSteps.safeParse([{ action: 'walk', direction: 'north' }]).success).toBe(false);
    expect(playtestSteps.safeParse([{ action: 'choose', index: -1 }]).success).toBe(false);
    expect(playtestSteps.safeParse([]).success).toBe(false);
  });

  it('flags map actions that run before any load', () => {
    const steps = playtestSteps.parse([
      { action: 'walk', direction: 'up' },
      { action: 'eval', script: '  ' },
    ]);
    const problems = checkSteps(steps);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/steps\[0\] \(walk\) runs before any "load"/);
    expect(problems[1]).toMatch(/steps\[1\] \(eval\) has an empty script/);
  });
});

describe('driver helpers', () => {
  it('builds JSON-argument driver calls and refuses odd names', () => {
    expect(driverCall('load', [{ mapId: 1, n: 'a"b' }])).toBe(
      '__mcp.load({"mapId":1,"n":"a\\"b"})',
    );
    expect(driverCall('busy', [])).toBe('__mcp.busy()');
    expect(() => driverCall('x); alert(1', [])).toThrow(/Bad driver function/);
  });

  it('sanitizes screenshot names', () => {
    expect(safeName('../../etc/passwd')).toBe('etc_passwd');
    expect(safeName('after battle.png')).toBe('after_battle');
    expect(safeName('...')).toBe('shot');
  });

  it('only inlines images when asked', () => {
    const render = playtestToolDefinitions.find((t) => t.name === 'render_map')!;
    const result = { path: '/tmp/x.png' };
    expect(render.images!(result, {})).toEqual([]);
    expect(render.images!(result, { inline: true })).toEqual(['/tmp/x.png']);
    const play = playtestToolDefinitions.find((t) => t.name === 'run_playtest')!;
    expect(play.images!({ screenshots: ['/a.png', '/b.png'] }, { inline: true })).toEqual([
      '/a.png',
      '/b.png',
    ]);
    expect(render.mutates).toBeFalsy();
    expect(play.mutates).toBeFalsy();
  });
});
