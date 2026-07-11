import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { commitStore, CommitContext } from '../src/utils/commit.js';
import {
  insertEventCommands,
  eventCommandToolDefinitions,
} from '../src/tools/eventCommandTools.js';
import { blankMapData } from '../src/tools/mapTools.js';
import { showText, showChoices } from '../src/events/commandBuilders.js';
import { MapData, MapEvent, EventCommand } from '../src/utils/types.js';

function eventWithEmptyPage(id: number): MapEvent {
  return {
    id,
    name: `EV${id}`,
    note: '',
    x: 0,
    y: 0,
    pages: [
      {
        conditions: {} as never,
        directionFix: false,
        image: {} as never,
        list: [{ code: 0, indent: 0, parameters: [] }],
        moveFrequency: 3,
        moveRoute: { list: [], repeat: false, skippable: false, wait: false },
        moveSpeed: 3,
        moveType: 0,
        priorityType: 1,
        stepAnime: false,
        through: false,
        trigger: 0,
        walkAnime: true,
      },
    ],
  };
}

async function scaffoldProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmz-evt-'));
  await writeFile(join(dir, 'game.rmmzproject'), 'RPGMZ 1.0.0');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');
  const map: MapData = blankMapData(17, 13, 1);
  map.events = [null, eventWithEmptyPage(1)];
  await writeFile(join(dir, 'data', 'Map001.json'), JSON.stringify(map));
  return dir;
}

const get = (name: string) => eventCommandToolDefinitions.find((t) => t.name === name)!;

describe('build_* tools (read-only)', () => {
  it('are not marked mutating and return { commands } / { command }', async () => {
    for (const name of [
      'build_show_text',
      'build_show_choices',
      'build_conditional_branch',
      'build_flow_command',
    ]) {
      expect(get(name).mutates).toBeUndefined();
    }
    const text = (await get('build_show_text').handler({ projectPath: '' }, { lines: ['Hi'] })) as {
      commands: EventCommand[];
    };
    expect(text.commands[0].code).toBe(101);

    const cond = (await get('build_conditional_branch').handler(
      { projectPath: '' },
      { condition: { type: 'gold', gold: 100, compare: '>=' } },
    )) as { commands: EventCommand[] };
    expect(cond.commands[0]).toEqual({ code: 111, indent: 0, parameters: [7, 100, 0] });

    const flow = (await get('build_flow_command').handler(
      { projectPath: '' },
      { kind: 'wait', frames: 60 },
    )) as { command: EventCommand };
    expect(flow.command).toEqual({ code: 230, indent: 0, parameters: [60] });
  });

  it('build_flow_command throws when a required field is missing', async () => {
    await expect(
      get('build_flow_command').handler({ projectPath: '' }, { kind: 'label' }),
    ).rejects.toThrow(/name/);
  });
});

describe('insert_event_commands (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await scaffoldProject();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('splices a built sequence before the end marker and persists compactly', async () => {
    const commands = showText(['Hello!'], { speakerName: 'Guard' });
    await insertEventCommands(dir, 1, 1, 0, commands);

    const raw = await readFile(join(dir, 'data', 'Map001.json'), 'utf-8');
    expect(raw).not.toContain('\n');
    const map = JSON.parse(raw) as MapData;
    expect(map.events[1]!.pages[0].list.map((c) => c.code)).toEqual([101, 401, 0]);
  });

  it('inserts a full choices block and keeps the page valid (no warnings)', async () => {
    const commands = showChoices(['Yes', 'No'], {
      branches: [showText(['Great!']), showText(['Aww.'])],
    });
    const result = (await get('insert_event_commands').handler(
      { projectPath: dir },
      { mapId: 1, eventId: 1, pageIndex: 0, commands },
    )) as { event: MapEvent; warnings?: unknown[] };
    expect(result.warnings).toBeUndefined();
    expect(result.event.pages[0].list.map((c) => c.code)).toEqual([
      102, 402, 101, 401, 0, 402, 101, 401, 0, 404, 0,
    ]);
  });

  it('surfaces validation warnings for a malformed inserted command', async () => {
    // A 401 line with the wrong arity trips the arity check on the resulting page.
    const result = (await get('insert_event_commands').handler(
      { projectPath: dir },
      { mapId: 1, eventId: 1, pageIndex: 0, commands: [{ code: 401, parameters: [] }] },
    )) as { event: MapEvent; warnings?: unknown[] };
    expect(result.warnings && result.warnings.length).toBeGreaterThan(0);
  });

  it('rejects an unknown event or page', async () => {
    const commands = showText(['x']);
    await expect(insertEventCommands(dir, 1, 99, 0, commands)).rejects.toThrow(/Event 99/);
    await expect(insertEventCommands(dir, 1, 1, 5, commands)).rejects.toThrow(/Page 5/);
  });

  it('dry-run previews the write without touching disk', async () => {
    const context: CommitContext = { dryRun: true, commits: [] };
    await commitStore.run(context, async () => {
      await insertEventCommands(dir, 1, 1, 0, showText(['hi']));
    });
    expect(context.commits.some((c) => c.path.endsWith('Map001.json'))).toBe(true);
    const map = JSON.parse(await readFile(join(dir, 'data', 'Map001.json'), 'utf-8')) as MapData;
    expect(map.events[1]!.pages[0].list.map((c) => c.code)).toEqual([0]);
  });

  it('is marked as mutating', () => {
    expect(get('insert_event_commands').mutates).toBe(true);
  });
});
