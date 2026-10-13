import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';
import { normalizeProjectPath, projectToolDefinitions } from '../src/tools/projectTools.js';
import { ToolContext } from '../src/registry.js';

/** Scaffold a minimal valid project (game.rmmzproject + data/System.json). */
async function scaffoldProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmz-project-'));
  await writeFile(join(dir, 'game.rmmzproject'), 'RPGMZ 1.0.0');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), JSON.stringify({ gameTitle: 'Test Game' }));
  return dir;
}

const byName = new Map(projectToolDefinitions.map((t) => [t.name, t]));
const getProject = byName.get('get_project')!;
const setProject = byName.get('set_project')!;

describe('normalizeProjectPath', () => {
  it('expands a leading ~ to the home directory', () => {
    expect(normalizeProjectPath('~/Games/Demo')).toBe(join(homedir(), 'Games/Demo'));
    expect(normalizeProjectPath('~')).toBe(homedir());
  });

  it('resolves other paths to absolute', () => {
    expect(normalizeProjectPath('/abs/path')).toBe(resolve('/abs/path'));
    expect(normalizeProjectPath('rel/path')).toBe(resolve('rel/path'));
  });
});

describe('project tools (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await scaffoldProject();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('get_project reports an unset path without erroring', async () => {
    const result = (await getProject.handler({ projectPath: '' }, {})) as Record<string, unknown>;
    expect(result.projectPath).toBeNull();
    expect(result.valid).toBe(false);
  });

  it('get_project reports a valid project with its game title', async () => {
    const result = (await getProject.handler({ projectPath: dir }, {})) as Record<string, unknown>;
    expect(result).toEqual({ projectPath: dir, valid: true, gameTitle: 'Test Game' });
  });

  it('set_project retargets the context and reports the new project', async () => {
    let current = '';
    const ctx: ToolContext = {
      projectPath: current,
      setProjectPath: (path) => {
        current = path;
      },
    };
    const result = (await setProject.handler(ctx, { path: dir })) as Record<string, unknown>;
    expect(current).toBe(dir);
    expect(result).toEqual({ projectPath: dir, valid: true, gameTitle: 'Test Game' });
  });

  it('set_project refuses a directory that is not an RPG Maker MZ project', async () => {
    const notAProject = await mkdtemp(join(tmpdir(), 'rpgmz-notproj-'));
    try {
      await expect(
        setProject.handler({ projectPath: '', setProjectPath: () => {} }, { path: notAProject }),
      ).rejects.toThrow(/Not an RPG Maker MZ project/);
    } finally {
      await rm(notAProject, { recursive: true, force: true });
    }
  });

  it('set_project throws when the context cannot be retargeted', async () => {
    await expect(setProject.handler({ projectPath: '' }, { path: dir })).rejects.toThrow(
      /not supported/,
    );
  });
});
