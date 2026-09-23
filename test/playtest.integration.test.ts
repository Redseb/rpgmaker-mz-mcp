import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { findChromium } from '../src/playtest/chromium.js';
import { renderMap } from '../src/playtest/render.js';
import { runPlaytest } from '../src/playtest/playtest.js';

/**
 * Real headless renders. These need three things the CI box doesn't have — a
 * cached Chromium, the optional playwright-core, and an actual RPG Maker project
 * (engine JS + assets; the repo's JSON fixtures can't boot) — so they run only
 * when RPGMAKER_MCP_TEST_PROJECT points at one, and skip otherwise. Read-only:
 * PNGs go to a temp dir, the project is never written.
 */
const project = process.env.RPGMAKER_MCP_TEST_PROJECT;

function chromiumAvailable(): boolean {
  try {
    findChromium();
    return true;
  } catch {
    return false;
  }
}

const runnable = !!project && existsSync(join(project, 'index.html')) && chromiumAvailable();

describe.skipIf(!runnable)('headless render (RPGMAKER_MCP_TEST_PROJECT)', () => {
  it('renders the start map to a PNG and plays a trivial script', async () => {
    const out = await mkdtemp(join(tmpdir(), 'rmmz-render-'));
    try {
      const system = JSON.parse(await readFile(join(project!, 'data', 'System.json'), 'utf-8'));
      const mapId: number = system.startMapId;
      const result = await renderMap(project!, { mapId, out });
      const png = await readFile(result.path);
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect(result.mode).toBe('whole_map');

      const play = await runPlaytest(
        project!,
        [
          { action: 'load', mapId, x: system.startX, y: system.startY },
          { action: 'eval', script: '$gameMap.mapId()' },
          { action: 'screenshot', name: 'start' },
        ],
        { out },
      );
      expect(play.ok).toBe(true);
      expect(play.steps[1].value).toBe(mapId);
      expect(play.screenshots).toHaveLength(1);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 120000);
});
