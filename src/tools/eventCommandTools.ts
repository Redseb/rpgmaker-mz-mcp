import { z } from 'zod';
import { readJsonFile, getMapPath } from '../utils/fileHandler.js';
import { commitChange } from '../utils/commit.js';
import { MapData, MapEvent, EventCommand } from '../utils/types.js';
import { ToolDefinition } from '../registry.js';
import { validateEvent, ValidationWarning } from '../validation/eventCommands.js';
import {
  showText,
  showChoices,
  conditionalBranch,
  wait,
  exitEvent,
  label,
  jumpToLabel,
  BranchCondition,
  ShowTextOptions,
  ShowChoicesOptions,
  ConditionalBranchOptions,
} from '../events/commandBuilders.js';

/** Zod shape for a raw event command (used where callers pass builder output back). */
const eventCommandShape = z.object({
  code: z.number().int().describe('Event command code'),
  indent: z.number().int().optional().describe('Indentation level (default 0)'),
  parameters: z.array(z.unknown()).optional().describe('Command parameters (default [])'),
});

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

/** Coerce a nested array-of-command-arrays (per-choice branches). */
function asCommandGroups(raw: unknown): EventCommand[][] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((group) => asCommands(group));
}

async function getMap(projectPath: string, mapId: number): Promise<MapData> {
  return await readJsonFile<MapData>(getMapPath(projectPath, mapId));
}

/**
 * Insert a pre-built sequence of event commands into an event page's command list
 * — the mutating companion to the read-only builders below. Splices before the
 * page's code-0 end marker (or at `position`), then writes through the commit
 * choke point. This is how a Show Text / Show Choices / Conditional Branch block
 * built by the builders actually lands on a map.
 */
export async function insertEventCommands(
  projectPath: string,
  mapId: number,
  eventId: number,
  pageIndex: number,
  commands: EventCommand[],
  position?: number,
): Promise<MapEvent> {
  const map = await getMap(projectPath, mapId);

  if (!map.events[eventId]) {
    throw new Error(`Event ${eventId} not found on map ${mapId}`);
  }
  const event = map.events[eventId]!;

  if (!event.pages[pageIndex]) {
    throw new Error(`Page ${pageIndex} not found on event ${eventId}`);
  }
  const commandList = event.pages[pageIndex].list;

  const insertAt =
    position !== undefined && position >= 0 && position < commandList.length - 1
      ? position
      : commandList.length - 1; // before the end-of-list command (code 0)
  commandList.splice(insertAt, 0, ...commands);

  await commitChange(getMapPath(projectPath, mapId), map);
  return event;
}

/** Build the warn-by-default response for a mutating event write. */
function withValidation(event: MapEvent): { event: MapEvent; warnings?: ValidationWarning[] } {
  const { warnings } = validateEvent(event);
  return warnings.length > 0 ? { event, warnings } : { event };
}

/** Zod shape for a Conditional Branch condition (validated further in the builder). */
const conditionShape = z
  .object({
    type: z
      .enum(['switch', 'self_switch', 'variable', 'actor_in_party', 'gold', 'item'])
      .describe('Condition type'),
    switchId: z.number().int().optional().describe('switch: the switch id to test'),
    name: z.enum(['A', 'B', 'C', 'D']).optional().describe('self_switch: which self switch'),
    value: z
      .enum(['on', 'off'])
      .optional()
      .describe('switch/self_switch: test for on (default) or off'),
    variableId: z.number().int().optional().describe('variable: the variable id (left side)'),
    comparison: z
      .enum(['==', '>=', '<=', '>', '<', '!='])
      .optional()
      .describe('variable: comparison operator'),
    constant: z.number().optional().describe('variable: compare against this constant (default 0)'),
    variableOperand: z
      .number()
      .int()
      .optional()
      .describe('variable: compare against this variable id (overrides constant)'),
    actorId: z.number().int().optional().describe('actor_in_party: the actor id'),
    itemId: z.number().int().optional().describe('item: the item id (tests "party has item")'),
    gold: z.number().optional().describe('gold: the amount to compare against'),
    compare: z.enum(['>=', '<=', '<']).optional().describe('gold: comparison operator'),
  })
  .describe('Conditional branch condition');

/** Map the flat condition input object to the discriminated {@link BranchCondition}. */
function toBranchCondition(c: Record<string, unknown>): BranchCondition {
  switch (c.type) {
    case 'switch':
      return { type: 'switch', switchId: c.switchId as number, value: c.value as 'on' | 'off' };
    case 'self_switch':
      return {
        type: 'self_switch',
        name: c.name as 'A' | 'B' | 'C' | 'D',
        value: c.value as 'on' | 'off',
      };
    case 'variable':
      return {
        type: 'variable',
        variableId: c.variableId as number,
        comparison: c.comparison as '==' | '>=' | '<=' | '>' | '<' | '!=',
        constant: c.constant as number | undefined,
        variableOperand: c.variableOperand as number | undefined,
      };
    case 'actor_in_party':
      return { type: 'actor_in_party', actorId: c.actorId as number };
    case 'gold':
      return { type: 'gold', value: c.gold as number, compare: c.compare as '>=' | '<=' | '<' };
    case 'item':
      return { type: 'item', itemId: c.itemId as number };
    default:
      throw new Error(`Unknown condition type: ${String(c.type)}`);
  }
}

export const eventCommandToolDefinitions: ToolDefinition[] = [
  {
    name: 'build_show_text',
    description:
      'Build a Show Text event-command sequence (101 setup + one 401 line per text line) for insertion via insert_event_commands. Supports face image (from list_assets("faces")), window background/position, and the MZ name-box speaker. Read-only: returns { commands }, writes nothing.',
    inputSchema: {
      lines: z.array(z.string()).describe('Message lines (one entry per visual line)'),
      faceName: z.string().optional().describe('Face image basename ("" = none, default)'),
      faceIndex: z.number().int().optional().describe('Face index 0–7 in the sheet (default 0)'),
      background: z
        .enum(['window', 'dim', 'transparent'])
        .optional()
        .describe('Window background (default window)'),
      position: z
        .enum(['top', 'middle', 'bottom'])
        .optional()
        .describe('Window position (default bottom)'),
      speakerName: z.string().optional().describe('MZ name-box speaker name (default "")'),
      indent: z.number().int().optional().describe('Indentation level (default 0)'),
    },
    handler: async (_ctx, args) => {
      const options: ShowTextOptions = {
        faceName: args.faceName,
        faceIndex: args.faceIndex,
        background: args.background,
        position: args.position,
        speakerName: args.speakerName,
        indent: args.indent,
      };
      return { commands: showText(args.lines as string[], options) };
    },
  },
  {
    name: 'build_show_choices',
    description:
      'Build a Show Choices block (102 opener + a 402 branch per choice + optional 403 When-Cancel branch + 404 closer, each branch terminated like the editor) for insertion via insert_event_commands. Pass per-choice `branches` (each an EventCommand[] — e.g. from build_show_text) to fill the branch bodies. Read-only: returns { commands }.',
    inputSchema: {
      choices: z.array(z.string()).describe('The choice labels shown to the player'),
      branches: z
        .array(z.array(eventCommandShape))
        .optional()
        .describe('Commands per choice (same order as choices); omitted/short = empty branches'),
      cancelBranch: z
        .array(eventCommandShape)
        .optional()
        .describe('Commands for a "When Cancel" branch (adds a 403 block; cancel routes here)'),
      cancelType: z
        .number()
        .int()
        .optional()
        .describe(
          'Without a cancelBranch: 0-based choice index the Cancel button maps to, or -1 Disallow (default -1)',
        ),
      defaultType: z
        .number()
        .int()
        .optional()
        .describe('0-based default (highlighted) choice, or -1 none (default 0)'),
      position: z
        .enum(['left', 'middle', 'right'])
        .optional()
        .describe('Choice window position (default right)'),
      background: z
        .enum(['window', 'dim', 'transparent'])
        .optional()
        .describe('Choice window background (default window)'),
      indent: z.number().int().optional().describe('Indentation level of the block (default 0)'),
    },
    handler: async (_ctx, args) => {
      const options: ShowChoicesOptions = {
        branches: asCommandGroups(args.branches),
        cancelBranch: args.cancelBranch !== undefined ? asCommands(args.cancelBranch) : undefined,
        cancelType: args.cancelType,
        defaultType: args.defaultType,
        position: args.position,
        background: args.background,
        indent: args.indent,
      };
      return { commands: showChoices(args.choices as string[], options) };
    },
  },
  {
    name: 'build_conditional_branch',
    description:
      'Build a Conditional Branch block (111 condition + then-branch + optional 411 Else + 412 closer, each branch terminated like the editor) for insertion via insert_event_commands. Condition types: switch, self_switch, variable, actor_in_party, gold, item. Provide thenBranch/elseBranch as EventCommand[] (e.g. from other builders). Read-only: returns { commands }.',
    inputSchema: {
      condition: conditionShape,
      thenBranch: z
        .array(eventCommandShape)
        .optional()
        .describe('Commands to run when the condition is true (default empty)'),
      elseBranch: z
        .array(eventCommandShape)
        .optional()
        .describe('Commands for the Else branch; presence (even empty) adds the 411 Else block'),
      indent: z.number().int().optional().describe('Indentation level of the block (default 0)'),
    },
    handler: async (_ctx, args) => {
      const condition = toBranchCondition(args.condition as Record<string, unknown>);
      const options: ConditionalBranchOptions = {
        thenBranch: args.thenBranch !== undefined ? asCommands(args.thenBranch) : undefined,
        elseBranch: args.elseBranch !== undefined ? asCommands(args.elseBranch) : undefined,
        indent: args.indent,
      };
      return { commands: conditionalBranch(condition, options) };
    },
  },
  {
    name: 'build_flow_command',
    description:
      'Build a single flow-control event command for insertion via insert_event_commands: wait (230, N frames), exit_event (115), label (118, a named jump target), or jump_to_label (119). Read-only: returns { command }.',
    inputSchema: {
      kind: z
        .enum(['wait', 'exit_event', 'label', 'jump_to_label'])
        .describe('Which flow command to build'),
      frames: z.number().int().optional().describe('wait: number of frames (60 = 1 second)'),
      name: z.string().optional().describe('label/jump_to_label: the label name'),
      indent: z.number().int().optional().describe('Indentation level (default 0)'),
    },
    handler: async (_ctx, args) => {
      const indent = args.indent ?? 0;
      switch (args.kind) {
        case 'wait':
          if (typeof args.frames !== 'number') throw new Error('wait requires `frames`');
          return { command: wait(args.frames, indent) };
        case 'exit_event':
          return { command: exitEvent(indent) };
        case 'label':
          if (typeof args.name !== 'string') throw new Error('label requires `name`');
          return { command: label(args.name, indent) };
        case 'jump_to_label':
          if (typeof args.name !== 'string') throw new Error('jump_to_label requires `name`');
          return { command: jumpToLabel(args.name, indent) };
        default:
          throw new Error(`Unknown flow command kind: ${args.kind}`);
      }
    },
  },
  {
    name: 'insert_event_commands',
    mutates: true,
    description:
      'Insert a pre-built sequence of event commands (from the build_* builders) into an event page’s command list, splicing before the page’s end marker (or at `position`). The mutating companion to the read-only builders. Returns warn-by-default validation of the resulting page.',
    inputSchema: {
      mapId: z.number().describe('The ID of the map'),
      eventId: z.number().describe('The ID of the event'),
      pageIndex: z.number().describe('Zero-based page index'),
      commands: z
        .array(eventCommandShape)
        .describe('The event commands to insert (e.g. the `commands` from a build_* tool)'),
      position: z.number().optional().describe('Insertion index; defaults to the end of the list'),
    },
    handler: async (ctx, args) => {
      const event = await insertEventCommands(
        ctx.projectPath,
        args.mapId,
        args.eventId,
        args.pageIndex,
        asCommands(args.commands),
        args.position,
      );
      return withValidation(event);
    },
  },
];
