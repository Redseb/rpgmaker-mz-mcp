import { z } from 'zod';
import type { ToolDefinition } from '../registry.js';
import { loadProjectData } from './validationTools.js';
import {
  commandSources,
  mapGraph,
  idExplanation,
  projectDocuments,
  searchDocuments,
  duplicateCommands,
  STATIC_COVERAGE,
} from '../analysis/projectDiagnostics.js';
import { analyzeBalance } from '../analysis/balanceAnalysis.js';
import { parseEventCommands, astToOutline } from '../analysis/eventOutline.js';
import { checkReferences } from '../validation/references.js';

const id = z.number().int().positive();
const pageIndex = z.number().int().nonnegative().default(0);
const limit = z.number().int().min(1).max(100).default(20);
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const overviewSchema = z.object({}).strict();
const graphSchema = z
  .object({
    removeMapId: id.optional().describe('Simulate removal; never modify or delete the map.'),
  })
  .strict();
const stateSchema = z
  .object({
    type: z.enum(['switch', 'variable']),
    id,
  })
  .strict();
const outlineSchema = z
  .object({
    target: z.discriminatedUnion('type', [
      z.object({ type: z.literal('map_event'), mapId: id, eventId: id, pageIndex }).strict(),
      z.object({ type: z.literal('common_event'), commonEventId: id }).strict(),
      z.object({ type: z.literal('troop_page'), troopId: id, pageIndex }).strict(),
    ]),
  })
  .strict();
const balanceSchema = z
  .object({
    category: z.enum(['all', 'skills', 'weapons', 'armors', 'enemies']).default('all'),
    thresholdSd: z
      .number()
      .positive()
      .max(100)
      .default(2)
      .describe('Standard-deviation threshold against other entries; an advisory heuristic.'),
  })
  .strict();
const searchSchema = z
  .object({
    query: z.string().trim().min(1).max(1000).describe('Lexical token or phrase query.'),
    limit,
  })
  .strict();
const duplicateSchema = z
  .object({
    minLength: z
      .number()
      .int()
      .min(2)
      .max(50)
      .default(4)
      .describe('Number of commands in each repeated window; results are review suggestions.'),
    limit,
  })
  .strict();

/** Fresh project JSON per call. No cache files or project scripts are executed. */
export const projectAnalysisToolDefinitions: ToolDefinition[] = [
  {
    name: 'get_project_overview',
    description:
      'Summarize project counts, static map reachability and reference warnings. Reuses the existing reference validator; use validate_references for its complete report. Conditional pages are possible paths, not proof of runtime reachability.',
    inputSchema: overviewSchema.shape,
    annotations: readOnly,
    handler: async (ctx, raw) => {
      overviewSchema.parse(raw);
      const data = await loadProjectData(ctx.projectPath);
      const graph = mapGraph(data);
      const warnings = checkReferences(data);
      return {
        gameTitle: data.system?.gameTitle ?? '',
        counts: {
          maps: data.maps.length,
          commandLists: commandSources(data).length,
          actors: data.actors.filter(Boolean).length,
          skills: data.skills.filter(Boolean).length,
          commonEvents: data.commonEvents.filter(Boolean).length,
        },
        unreachable: graph.unreachable,
        missingMaps: graph.missingMaps,
        referenceWarningCount: warnings.length,
        referenceWarnings: warnings.slice(0, 50),
        coverage: STATIC_COVERAGE,
      };
    },
  },
  {
    name: 'analyze_transfer_graph',
    description:
      'Trace static map transfers and called common events, report unreachable or missing maps and unresolved dynamic transfers, and optionally simulate one map removal. Does not simulate event conditions, scripts, plugin behavior or gameplay.',
    inputSchema: graphSchema.shape,
    annotations: readOnly,
    handler: async (ctx, raw) => {
      const args = graphSchema.parse(raw);
      return mapGraph(await loadProjectData(ctx.projectPath), args.removeMapId);
    },
  },
  {
    name: 'explain_state_id',
    description:
      'Separate a switch or variable’s static readers and writers, including read-modify-write operations and page conditions. No static writer does not mean a runtime defect. For allocated IDs, common-event callers or simple usage lists, use existing list_allocated_ids.',
    inputSchema: stateSchema.shape,
    annotations: readOnly,
    handler: async (ctx, raw) => {
      const args = stateSchema.parse(raw);
      return idExplanation(await loadProjectData(ctx.projectPath), args.type, args.id);
    },
  },
  {
    name: 'outline_event',
    description:
      'Read one map event page, common event or troop page as a structured tree and readable outline, including MZ speakers and plugin commands. Best-effort presentation of malformed lists; use validate_event for structural diagnostics. Does not execute commands.',
    inputSchema: outlineSchema.shape,
    annotations: readOnly,
    handler: async (ctx, raw) => {
      const { target } = outlineSchema.parse(raw);
      const data = await loadProjectData(ctx.projectPath);
      const source = commandSources(data).find((entry) =>
        target.type === 'common_event'
          ? entry.commonEventId === target.commonEventId
          : target.type === 'troop_page'
            ? entry.troopId === target.troopId && entry.pageIndex === target.pageIndex
            : entry.mapId === target.mapId &&
              entry.eventId === target.eventId &&
              entry.pageIndex === target.pageIndex,
      );
      if (!source) throw new Error('Outline target not found; check its IDs and pageIndex.');
      const nodes = parseEventCommands(source.commands);
      return {
        path: source.path,
        nodes,
        outline: astToOutline(nodes),
        coverage: `${STATIC_COVERAGE} Outline is best-effort; malformed indentation may be omitted. Use validate_event for structural diagnostics.`,
      };
    },
  },
  {
    name: 'analyze_database_balance',
    description:
      'Flag advisory peer outliers in skills, weapons, armors or enemies. Skill formulas use a restricted arithmetic parser and fixed reference stats, never eval or project scripts. Reports unsupported formulas and small samples; does not simulate combat or rebalance records.',
    inputSchema: balanceSchema.shape,
    annotations: readOnly,
    handler: async (ctx, raw) => {
      const args = balanceSchema.parse(raw);
      return analyzeBalance(
        await loadProjectData(ctx.projectPath),
        args.category,
        args.thresholdSd,
      );
    },
  },
  {
    name: 'search_project',
    description:
      'Search project JSON text lexically across names, notes, descriptions, dialogue, choices and plugin-command text. Returns ranked snippets and source paths. No embeddings, script execution, external services or cache writes.',
    inputSchema: searchSchema.shape,
    annotations: readOnly,
    handler: async (ctx, raw) => {
      const args = searchSchema.parse(raw);
      return searchDocuments(
        projectDocuments(await loadProjectData(ctx.projectPath)),
        args.query,
        args.limit,
      );
    },
  },
  {
    name: 'find_duplicate_event_blocks',
    description:
      'Find repeated command windows across map, common and troop events using relative indentation. Reports source paths for manual review; a repeated window is not necessarily a complete or safely extractable block. Never rewrites or extracts code.',
    inputSchema: duplicateSchema.shape,
    annotations: readOnly,
    handler: async (ctx, raw) => {
      const args = duplicateSchema.parse(raw);
      return duplicateCommands(
        commandSources(await loadProjectData(ctx.projectPath)),
        args.minLength,
        args.limit,
      );
    },
  },
];
