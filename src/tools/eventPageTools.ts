import { z } from 'zod';
import { readJsonFile, getMapPath } from '../utils/fileHandler.js';
import { commitChange } from '../utils/commit.js';
import { MapData, MapEvent, EventImage, MoveRoute, EventCommand } from '../utils/types.js';
import { ToolDefinition } from '../registry.js';
import { createMapEvent, blankEventPage, actionButtonReachabilityWarnings } from './mapTools.js';
import { validateEvent, ValidationWarning } from '../validation/eventCommands.js';
import { showText, ShowTextOptions } from '../events/commandBuilders.js';
import { listAssets } from './assetTools.js';

/** Event trigger names ↔ the on-disk `trigger` code. */
const TRIGGER_CODE = {
  action_button: 0,
  player_touch: 1,
  event_touch: 2,
  autorun: 3,
  parallel: 4,
} as const;
type TriggerName = keyof typeof TRIGGER_CODE;

/** Priority (stacking vs. the player) names ↔ the on-disk `priorityType` code. */
const PRIORITY_CODE = { below: 0, same: 1, above: 2 } as const;
type PriorityName = keyof typeof PRIORITY_CODE;

/** Autonomous movement names ↔ the on-disk `moveType` code. */
const MOVE_TYPE_CODE = { fixed: 0, random: 1, approach: 2, custom: 3 } as const;
type MoveTypeName = keyof typeof MOVE_TYPE_CODE;

/** Facing names ↔ the RPG Maker direction code. */
const DIRECTION_CODE = { down: 2, left: 4, right: 6, up: 8 } as const;
type DirectionName = keyof typeof DIRECTION_CODE;

async function getMap(projectPath: string, mapId: number): Promise<MapData> {
  return await readJsonFile<MapData>(getMapPath(projectPath, mapId));
}

// `blankEventPage` now lives in mapTools (alongside createMapEvent and the other
// event-page primitives) to keep the module dependency one-way; re-exported here
// so existing importers of this module keep working.
export { blankEventPage };

/**
 * Warn (never throw) when a sprite `characterName` isn't among the project's
 * `img/characters` assets — a wrong sprite name is a silent runtime failure in
 * the engine. Skips the check when the name is empty (no graphic) or the asset
 * dir is empty/missing (nothing to validate against — e.g. a fixture project),
 * so it can't emit false positives. Mirrors `audioNameWarnings` in eventCommandTools.
 */
async function characterNameWarnings(
  projectPath: string,
  name: string | undefined,
): Promise<ValidationWarning[]> {
  if (!projectPath || !name) return [];
  const { names } = await listAssets(projectPath, 'characters');
  if (names.length > 0 && !names.includes(name)) {
    return [
      {
        path: 'image.characterName',
        code: undefined,
        message: `character "${name}" is not a known characters asset (a wrong filename fails silently at runtime)`,
      },
    ];
  }
  return [];
}

/**
 * Warn (never block) when a `create_npc` call sets no graphic at all — an NPC
 * whose whole purpose is to be a visible, talkable character is almost always a
 * mistake when invisible (F1: the Signpost NPC was created with no sprite and was
 * unfindable in-game). Scoped to `create_npc`: a bare `create_map_event` trigger
 * or a door-tile transfer legitimately has no graphic, so this doesn't fire there.
 */
function missingGraphicWarnings(characterName: string | undefined): ValidationWarning[] {
  if (characterName) return [];
  return [
    {
      path: 'image.characterName',
      code: undefined,
      message:
        'create_npc made an NPC with no graphic — it will be invisible in-game. Set a characterName from list_assets("characters"), or use create_map_event if you meant an invisible trigger/controller event.',
    },
  ];
}

/** The page-level properties `set_event_page` can change (all optional). */
export interface EventPageUpdates {
  image?: Partial<EventImage>;
  trigger?: number;
  priorityType?: number;
  through?: boolean;
  walkAnime?: boolean;
  stepAnime?: boolean;
  directionFix?: boolean;
  moveType?: number;
  moveSpeed?: number;
  moveFrequency?: number;
  moveRoute?: MoveRoute;
}

/**
 * Update one event page's properties — graphic (`image`), trigger, priority, and
 * movement — without rebuilding the whole page or touching its command `list`.
 * The `image` fields are merged onto the existing graphic (so setting just a
 * `direction` keeps the sprite); the rest overwrite. Writes through the commit
 * choke point.
 */
export async function setEventPage(
  projectPath: string,
  mapId: number,
  eventId: number,
  pageIndex: number,
  updates: EventPageUpdates,
): Promise<MapEvent> {
  const map = await getMap(projectPath, mapId);

  if (!map.events[eventId]) {
    throw new Error(`Event ${eventId} not found on map ${mapId}`);
  }
  const event = map.events[eventId]!;

  if (!event.pages[pageIndex]) {
    throw new Error(`Page ${pageIndex} not found on event ${eventId}`);
  }
  const page = event.pages[pageIndex];

  if (updates.image) page.image = { ...page.image, ...updates.image };
  if (updates.trigger !== undefined) page.trigger = updates.trigger;
  if (updates.priorityType !== undefined) page.priorityType = updates.priorityType;
  if (updates.through !== undefined) page.through = updates.through;
  if (updates.walkAnime !== undefined) page.walkAnime = updates.walkAnime;
  if (updates.stepAnime !== undefined) page.stepAnime = updates.stepAnime;
  if (updates.directionFix !== undefined) page.directionFix = updates.directionFix;
  if (updates.moveType !== undefined) page.moveType = updates.moveType;
  if (updates.moveSpeed !== undefined) page.moveSpeed = updates.moveSpeed;
  if (updates.moveFrequency !== undefined) page.moveFrequency = updates.moveFrequency;
  if (updates.moveRoute !== undefined) page.moveRoute = updates.moveRoute;

  await commitChange(getMapPath(projectPath, mapId), map);
  return event;
}

/** Coerce a loosely-typed command array into well-formed EventCommands. */
function asCommands(raw: unknown): EventCommand[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => {
    const cmd = c as Partial<EventCommand>;
    return {
      code: cmd.code as number,
      indent: cmd.indent ?? 0,
      parameters: Array.isArray(cmd.parameters) ? cmd.parameters : [],
    };
  });
}

/** Ensure a page command list ends with the code-0 end marker (never duplicated). */
function terminated(list: EventCommand[]): EventCommand[] {
  const last = list[list.length - 1];
  if (last && last.code === 0) return list;
  return [...list, { code: 0, indent: 0, parameters: [] }];
}

/** Options for `create_npc` beyond the required position/name. */
export interface CreateNpcOptions {
  characterName?: string;
  characterIndex?: number;
  direction?: number;
  pattern?: number;
  text?: string[];
  faceName?: string;
  faceIndex?: number;
  speakerName?: string;
  commands?: EventCommand[];
  trigger?: number;
  priorityType?: number;
  through?: boolean;
}

/**
 * One-shot "talking NPC" builder: create a complete, placed event on a map with a
 * single page — a graphic, a trigger, and a command list. The list comes from
 * `text` (built as a Show Text sequence) or an explicit `commands` array
 * (`commands` wins if both are given); either way it's code-0 terminated. Reuses
 * `createMapEvent` so id allocation + the commit choke point are shared.
 *
 * Defaults tuned for the common case: a solid, action-button NPC facing down —
 * `priorityType` same-as-characters, `pattern` 1 (idle frame) when a sprite is
 * set.
 */
export async function createNpc(
  projectPath: string,
  mapId: number,
  x: number,
  y: number,
  name: string,
  options: CreateNpcOptions = {},
): Promise<MapEvent> {
  const hasGraphic = !!options.characterName;
  const page = blankEventPage();
  page.image = {
    characterName: options.characterName ?? '',
    characterIndex: options.characterIndex ?? 0,
    direction: options.direction ?? 2,
    pattern: options.pattern ?? (hasGraphic ? 1 : 0),
    tileId: 0,
  };
  page.trigger = options.trigger ?? TRIGGER_CODE.action_button;
  page.priorityType = options.priorityType ?? PRIORITY_CODE.same;
  if (options.through !== undefined) page.through = options.through;

  if (options.commands && options.commands.length > 0) {
    page.list = terminated(asCommands(options.commands));
  } else if (options.text && options.text.length > 0) {
    const textOptions: ShowTextOptions = {
      faceName: options.faceName,
      faceIndex: options.faceIndex,
      speakerName: options.speakerName,
    };
    page.list = terminated(showText(options.text, textOptions));
  }

  return await createMapEvent(projectPath, mapId, { name, note: '', x, y, pages: [page] });
}

/** Build the warn-by-default response for an event write, merging extra warnings. */
function withValidation(
  event: MapEvent,
  extra: ValidationWarning[] = [],
): { event: MapEvent; warnings?: ValidationWarning[] } {
  const warnings = [...extra, ...validateEvent(event).warnings];
  return warnings.length > 0 ? { event, warnings } : { event };
}

export const eventPageToolDefinitions: ToolDefinition[] = [
  {
    name: 'set_event_page',
    mutates: true,
    description:
      "Update an existing event page's graphic and behavior in one call, without rebuilding the whole page or touching its command list: sprite (characterName/characterIndex/direction/pattern or a tileId), trigger, priority, movement (type/speed/frequency/route), and the through/walkAnime/stepAnime/directionFix flags. Graphic fields merge onto the current image; warns (never blocks) on an unknown characterName.",
    inputSchema: {
      mapId: z.number().describe('The ID of the map'),
      eventId: z.number().describe('The ID of the event'),
      pageIndex: z.number().describe('Zero-based page index'),
      characterName: z
        .string()
        .optional()
        .describe('Sprite sheet basename (from list_assets("characters")); "" = no sprite'),
      characterIndex: z.number().int().optional().describe('Sprite index 0–7 in the sheet'),
      direction: z
        .enum(['down', 'left', 'right', 'up'])
        .optional()
        .describe('Facing direction of the sprite'),
      pattern: z.number().int().optional().describe('Sprite animation frame 0–2 (1 = idle)'),
      tileId: z
        .number()
        .int()
        .optional()
        .describe('Use a tile as the graphic instead of a sprite (0 = none)'),
      trigger: z
        .enum(['action_button', 'player_touch', 'event_touch', 'autorun', 'parallel'])
        .optional()
        .describe('What starts the page'),
      priority: z
        .enum(['below', 'same', 'above'])
        .optional()
        .describe('Stacking vs. the player: below/same/above characters (same = solid)'),
      through: z.boolean().optional().describe('Let the player/others pass through the event'),
      walkAnime: z.boolean().optional().describe('Animate the walk cycle while moving'),
      stepAnime: z.boolean().optional().describe('Animate in place while stopped'),
      directionFix: z.boolean().optional().describe('Lock the facing direction'),
      moveType: z
        .enum(['fixed', 'random', 'approach', 'custom'])
        .optional()
        .describe('Autonomous movement (custom uses moveRoute)'),
      moveSpeed: z.number().int().optional().describe('Movement speed 1–6 (4 = normal)'),
      moveFrequency: z.number().int().optional().describe('Movement frequency 1–5 (3 = normal)'),
      moveRoute: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Autonomous move route (from create_move_route); pairs with moveType "custom"'),
      indent: z.number().int().optional().describe('(unused; page-level tool)'),
    },
    handler: async (ctx, args) => {
      const image: Partial<EventImage> = {};
      if (args.characterName !== undefined) image.characterName = args.characterName;
      if (args.characterIndex !== undefined) image.characterIndex = args.characterIndex;
      if (args.direction !== undefined)
        image.direction = DIRECTION_CODE[args.direction as DirectionName];
      if (args.pattern !== undefined) image.pattern = args.pattern;
      if (args.tileId !== undefined) image.tileId = args.tileId;

      const updates: EventPageUpdates = {
        image: Object.keys(image).length > 0 ? image : undefined,
        trigger: args.trigger !== undefined ? TRIGGER_CODE[args.trigger as TriggerName] : undefined,
        priorityType:
          args.priority !== undefined ? PRIORITY_CODE[args.priority as PriorityName] : undefined,
        through: args.through,
        walkAnime: args.walkAnime,
        stepAnime: args.stepAnime,
        directionFix: args.directionFix,
        moveType:
          args.moveType !== undefined ? MOVE_TYPE_CODE[args.moveType as MoveTypeName] : undefined,
        moveSpeed: args.moveSpeed,
        moveFrequency: args.moveFrequency,
        moveRoute: args.moveRoute as MoveRoute | undefined,
      };

      const event = await setEventPage(
        ctx.projectPath,
        args.mapId,
        args.eventId,
        args.pageIndex,
        updates,
      );
      const warnings = await characterNameWarnings(ctx.projectPath, args.characterName);
      return withValidation(event, warnings);
    },
  },
  {
    name: 'create_npc',
    mutates: true,
    description:
      'Create a complete, placed NPC event on a map in one call — a graphic + trigger + a talk list. Provide `text` (built into a Show Text sequence, with optional face/speaker) or an explicit `commands` array (commands wins if both given). Defaults to a solid, action-button NPC facing down. Warns (never blocks) on an unknown characterName, and on NO graphic at all (an NPC with no characterName is invisible in-game — use create_map_event for an intentionally-invisible trigger). The one-shot "make a talking NPC that says X" primitive.',
    inputSchema: {
      mapId: z.number().describe('The ID of the map to place the NPC on'),
      x: z.number().int().describe('X tile position'),
      y: z.number().int().describe('Y tile position'),
      name: z.string().describe('Event name (editor label)'),
      characterName: z
        .string()
        .optional()
        .describe('Sprite sheet basename (from list_assets("characters"))'),
      characterIndex: z.number().int().optional().describe('Sprite index 0–7 in the sheet'),
      direction: z
        .enum(['down', 'left', 'right', 'up'])
        .optional()
        .describe('Facing direction (default down)'),
      pattern: z
        .number()
        .int()
        .optional()
        .describe('Sprite frame 0–2 (default 1 = idle when a sprite is set)'),
      text: z
        .array(z.string())
        .optional()
        .describe('Dialogue lines shown when the NPC is triggered (built as Show Text)'),
      faceName: z
        .string()
        .optional()
        .describe('text: face image basename (from list_assets("faces"))'),
      faceIndex: z.number().int().optional().describe('text: face index 0–7'),
      speakerName: z.string().optional().describe('text: MZ name-box speaker name'),
      commands: z
        .array(
          z.object({
            code: z.number().int().describe('Event command code'),
            indent: z.number().int().optional().describe('Indentation level (default 0)'),
            parameters: z.array(z.unknown()).optional().describe('Command parameters (default [])'),
          }),
        )
        .optional()
        .describe('Explicit command list (from the build_* tools); overrides `text` if given'),
      trigger: z
        .enum(['action_button', 'player_touch', 'event_touch', 'autorun', 'parallel'])
        .optional()
        .describe('What starts the event (default action_button)'),
      priority: z
        .enum(['below', 'same', 'above'])
        .optional()
        .describe('Stacking vs. the player (default same = solid)'),
      through: z.boolean().optional().describe('Let the player pass through (default false)'),
    },
    handler: async (ctx, args) => {
      const options: CreateNpcOptions = {
        characterName: args.characterName,
        characterIndex: args.characterIndex,
        direction:
          args.direction !== undefined
            ? DIRECTION_CODE[args.direction as DirectionName]
            : undefined,
        pattern: args.pattern,
        text: args.text as string[] | undefined,
        faceName: args.faceName,
        faceIndex: args.faceIndex,
        speakerName: args.speakerName,
        commands: args.commands !== undefined ? asCommands(args.commands) : undefined,
        trigger: args.trigger !== undefined ? TRIGGER_CODE[args.trigger as TriggerName] : undefined,
        priorityType:
          args.priority !== undefined ? PRIORITY_CODE[args.priority as PriorityName] : undefined,
        through: args.through,
      };
      const event = await createNpc(
        ctx.projectPath,
        args.mapId,
        args.x,
        args.y,
        args.name,
        options,
      );
      const warnings = [
        ...missingGraphicWarnings(args.characterName),
        ...(await characterNameWarnings(ctx.projectPath, args.characterName)),
        ...(await actionButtonReachabilityWarnings(ctx.projectPath, args.mapId, event)),
      ];
      return withValidation(event, warnings);
    },
  },
];
