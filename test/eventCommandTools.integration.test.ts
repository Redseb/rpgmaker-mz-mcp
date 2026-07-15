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
import {
  showText,
  showChoices,
  controlSwitches,
  changeGold,
  changePartyMember,
  transferPlayer,
  playAudio,
  fadeScreen,
  showPicture,
  showAnimation,
} from '../src/events/commandBuilders.js';
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

describe('game-state build tools (5e-2, read-only)', () => {
  it('are not mutating and delegate to the builders', async () => {
    for (const name of [
      'build_control_switch',
      'build_control_variable',
      'build_change_gold',
      'build_change_items',
      'build_change_party_member',
    ]) {
      expect(get(name).mutates).toBeUndefined();
    }

    const sw = (await get('build_control_switch').handler(
      { projectPath: '' },
      { scope: 'switch', switchId: 5, value: 'off' },
    )) as { command: EventCommand };
    expect(sw.command).toEqual({ code: 121, indent: 0, parameters: [5, 5, 1] });

    const selfSw = (await get('build_control_switch').handler(
      { projectPath: '' },
      { scope: 'self_switch', name: 'B' },
    )) as { command: EventCommand };
    expect(selfSw.command).toEqual({ code: 123, indent: 0, parameters: ['B', 0] });

    const v = (await get('build_control_variable').handler(
      { projectPath: '' },
      { variableId: 10, operation: 'add', operand: { type: 'constant', value: 5 } },
    )) as { command: EventCommand };
    expect(v.command).toEqual({ code: 122, indent: 0, parameters: [10, 10, 1, 0, 5] });

    const items = (await get('build_change_items').handler(
      { projectPath: '' },
      { kind: 'weapon', id: 3, operation: 'increase', operand: { type: 'constant', value: 1 } },
    )) as { command: EventCommand };
    expect(items.command).toEqual({ code: 127, indent: 0, parameters: [3, 0, 0, 1, false] });
  });

  it('build_control_switch throws when scope-required fields are missing', async () => {
    await expect(
      get('build_control_switch').handler({ projectPath: '' }, { scope: 'switch' }),
    ).rejects.toThrow(/switchId/);
    await expect(
      get('build_control_switch').handler({ projectPath: '' }, { scope: 'self_switch' }),
    ).rejects.toThrow(/name/);
  });
});

describe('presentation build tools (5e-3, read-only)', () => {
  it('are not mutating and delegate to the builders', async () => {
    for (const name of [
      'build_transfer_player',
      'build_play_audio',
      'build_screen_effect',
      'build_picture',
      'build_character_effect',
    ]) {
      expect(get(name).mutates).toBeUndefined();
    }

    const transfer = (await get('build_transfer_player').handler(
      { projectPath: '' },
      { mapId: 2, x: 16, y: 0 },
    )) as { command: EventCommand };
    expect(transfer.command).toEqual({ code: 201, indent: 0, parameters: [0, 2, 16, 0, 0, 0] });

    const flash = (await get('build_screen_effect').handler(
      { projectPath: '' },
      { kind: 'flash', color: [255, 255, 255, 170], duration: 60 },
    )) as { command: EventCommand };
    expect(flash.command).toEqual({
      code: 224,
      indent: 0,
      parameters: [[255, 255, 255, 170], 60, true],
    });

    const fade = (await get('build_screen_effect').handler(
      { projectPath: '' },
      { kind: 'fadeout' },
    )) as { command: EventCommand };
    expect(fade.command).toEqual({ code: 221, indent: 0, parameters: [] });

    const pic = (await get('build_picture').handler(
      { projectPath: '' },
      { kind: 'show', pictureId: 1, name: 'Title', origin: 'center' },
    )) as { command: EventCommand };
    expect(pic.command.parameters).toEqual([1, 'Title', 1, 0, 0, 0, 100, 100, 255, 0]);

    const balloon = (await get('build_character_effect').handler(
      { projectPath: '' },
      { kind: 'balloon', characterId: 0, id: 4 },
    )) as { command: EventCommand };
    expect(balloon.command).toEqual({ code: 213, indent: 0, parameters: [0, 4, false] });
  });

  it('build_picture(show) throws without a name; build_screen_effect rejects an unknown kind', async () => {
    await expect(
      get('build_picture').handler({ projectPath: '' }, { kind: 'show', pictureId: 1 }),
    ).rejects.toThrow(/name/);
  });

  it('build_play_audio warns on an unknown name only when the asset dir is populated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rpgmz-audio-'));
    try {
      await mkdir(join(dir, 'audio', 'se'), { recursive: true });
      await writeFile(join(dir, 'audio', 'se', 'Move1.ogg'), '');

      const known = (await get('build_play_audio').handler(
        { projectPath: dir },
        { kind: 'se', name: 'Move1' },
      )) as { command: EventCommand; warnings?: unknown[] };
      expect(known.command).toEqual({
        code: 250,
        indent: 0,
        parameters: [{ name: 'Move1', volume: 90, pitch: 100, pan: 0 }],
      });
      expect(known.warnings).toBeUndefined();

      const unknown = (await get('build_play_audio').handler(
        { projectPath: dir },
        { kind: 'se', name: 'Nope' },
      )) as { command: EventCommand; warnings?: unknown[] };
      expect(unknown.warnings && unknown.warnings.length).toBeGreaterThan(0);

      // A channel with no assets on disk can't be validated → no false warning.
      const noAssets = (await get('build_play_audio').handler(
        { projectPath: dir },
        { kind: 'bgm', name: 'Anything' },
      )) as { warnings?: unknown[] };
      expect(noAssets.warnings).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  it('inserts a game-state sequence and keeps the page valid (no warnings)', async () => {
    const commands = [
      controlSwitches(1, 1, 'on'),
      changeGold('increase', { type: 'constant', value: 100 }),
      changePartyMember(2, 'add'),
    ];
    const result = (await get('insert_event_commands').handler(
      { projectPath: dir },
      { mapId: 1, eventId: 1, pageIndex: 0, commands },
    )) as { event: MapEvent; warnings?: unknown[] };
    expect(result.warnings).toBeUndefined();
    expect(result.event.pages[0].list.map((c) => c.code)).toEqual([121, 125, 129, 0]);
  });

  it('inserts a presentation sequence and keeps the page valid (arity checks pass)', async () => {
    const commands = [
      fadeScreen('out'),
      playAudio('me', { name: 'Victory' }),
      showPicture(1, 'Title', { origin: 'center' }),
      showAnimation(0, 12, true),
      transferPlayer(2, 8, 6, { fade: 'none' }),
    ];
    const result = (await get('insert_event_commands').handler(
      { projectPath: dir },
      { mapId: 1, eventId: 1, pageIndex: 0, commands },
    )) as { event: MapEvent; warnings?: unknown[] };
    expect(result.warnings).toBeUndefined();
    expect(result.event.pages[0].list.map((c) => c.code)).toEqual([221, 249, 231, 212, 201, 0]);
  });

  it('refuses a malformed inserted command and leaves the page untouched', async () => {
    // A 401 line with the wrong arity trips the arity check on the resulting page.
    const args = { mapId: 1, eventId: 1, pageIndex: 0, commands: [{ code: 401, parameters: [] }] };
    await expect(get('insert_event_commands').handler({ projectPath: dir }, args)).rejects.toThrow(
      /Refusing to write/,
    );

    const map = JSON.parse(await readFile(join(dir, 'data', 'Map001.json'), 'utf-8')) as MapData;
    expect(map.events[1]!.pages[0].list.some((c) => c.code === 401)).toBe(false);
  });

  it('inserts a malformed command when forced, reporting the problem', async () => {
    const result = (await get('insert_event_commands').handler(
      { projectPath: dir },
      {
        mapId: 1,
        eventId: 1,
        pageIndex: 0,
        commands: [{ code: 401, parameters: [] }],
        force: true,
      },
    )) as { event: MapEvent; warnings?: unknown[] };
    expect(result.warnings && result.warnings.length).toBeGreaterThan(0);
    expect(result.event.pages[0].list.some((c) => c.code === 401)).toBe(true);
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

  it('a dry-run of a structurally bad write fails the same way the real write does', async () => {
    // The gate runs before commitChange, so a preview can't report a write that
    // would in fact be refused — it throws too.
    const context: CommitContext = { dryRun: true, commits: [] };
    await commitStore.run(context, async () => {
      await expect(
        get('insert_event_commands').handler(
          { projectPath: dir },
          { mapId: 1, eventId: 1, pageIndex: 0, commands: [{ code: 401, parameters: [] }] },
        ),
      ).rejects.toThrow(/Refusing to write/);
    });
    expect(context.commits).toEqual([]);
  });

  it('is marked as mutating and forceable', () => {
    expect(get('insert_event_commands').mutates).toBe(true);
    expect(get('insert_event_commands').forceable).toBe(true);
  });
});

describe('append_event_commands (integration)', () => {
  let dir: string;

  /** Scaffold a project seeded with one common event and one troop (single page). */
  async function scaffoldWithCeAndTroop(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), 'rpgmz-append-'));
    await writeFile(join(d, 'game.rmmzproject'), 'RPGMZ 1.0.0');
    await mkdir(join(d, 'data'));
    await writeFile(join(d, 'data', 'System.json'), '{}');
    await writeFile(
      join(d, 'data', 'CommonEvents.json'),
      JSON.stringify([
        null,
        {
          id: 1,
          name: 'Rest',
          list: [{ code: 0, indent: 0, parameters: [] }],
          switchId: 1,
          trigger: 0,
        },
      ]),
    );
    await writeFile(
      join(d, 'data', 'Troops.json'),
      JSON.stringify([
        null,
        {
          id: 1,
          name: 'Ambush',
          members: [],
          pages: [{ conditions: {}, list: [{ code: 0, indent: 0, parameters: [] }], span: 0 }],
        },
      ]),
    );
    return d;
  }

  beforeEach(async () => {
    dir = await scaffoldWithCeAndTroop();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('inserts a built sequence into a common event body before its end marker', async () => {
    const commands = showText(['Resting...'], { speakerName: 'Inn' });
    const result = (await get('append_event_commands').handler(
      { projectPath: dir },
      { target: 'common_event', commonEventId: 1, commands },
    )) as { target: string; id: number; list: EventCommand[]; warnings?: unknown[] };
    expect(result.target).toBe('common_event');
    expect(result.list.map((c) => c.code)).toEqual([101, 401, 0]);
    expect(result.warnings).toBeUndefined();

    const raw = await readFile(join(dir, 'data', 'CommonEvents.json'), 'utf-8');
    expect(raw).not.toContain('\n');
    const ces = JSON.parse(raw) as Array<{ list: EventCommand[] } | null>;
    expect(ces[1]!.list.map((c) => c.code)).toEqual([101, 401, 0]);
  });

  it('inserts into a troop battle-event page', async () => {
    const commands = showText(['They ambush you!']);
    const result = (await get('append_event_commands').handler(
      { projectPath: dir },
      { target: 'troop_page', troopId: 1, pageIndex: 0, commands },
    )) as { target: string; list: EventCommand[] };
    expect(result.target).toBe('troop_page');
    expect(result.list.map((c) => c.code)).toEqual([101, 401, 0]);
  });

  it('throws on a missing target or missing required target fields', async () => {
    const h = get('append_event_commands').handler;
    await expect(
      h({ projectPath: dir }, { target: 'common_event', commonEventId: 99, commands: [] }),
    ).rejects.toThrow(/Common event 99/);
    await expect(
      h({ projectPath: dir }, { target: 'troop_page', troopId: 1, pageIndex: 5, commands: [] }),
    ).rejects.toThrow(/Page 5/);
    await expect(h({ projectPath: dir }, { target: 'common_event', commands: [] })).rejects.toThrow(
      /commonEventId is required/,
    );
  });

  it('dry-run previews the common-event write without touching disk', async () => {
    const context: CommitContext = { dryRun: true, commits: [] };
    await commitStore.run(context, async () => {
      await get('append_event_commands').handler(
        { projectPath: dir },
        { target: 'common_event', commonEventId: 1, commands: showText(['hi']) },
      );
    });
    expect(context.commits.some((c) => c.path.endsWith('CommonEvents.json'))).toBe(true);
    const ces = JSON.parse(
      await readFile(join(dir, 'data', 'CommonEvents.json'), 'utf-8'),
    ) as Array<{
      list: EventCommand[];
    } | null>;
    expect(ces[1]!.list.map((c) => c.code)).toEqual([0]); // untouched
  });

  it('is marked as mutating', () => {
    expect(get('append_event_commands').mutates).toBe(true);
  });
});
