import { z } from 'zod';
import { analyzeMapLayout } from '../analysis/mapLayout.js';
import { ToolDefinition } from '../registry.js';
import { getMap } from './mapTools.js';
import { getTileset } from './tilesetTools.js';

const schema = z
  .object({
    mapId: z.number().int().positive(),
    start: z
      .object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() })
      .strict()
      .optional(),
    maxComponents: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const mapAnalysisToolDefinitions: ToolDefinition[] = [
  {
    name: 'analyze_map_layout',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description:
      'Analyze whole-map static directional tile passage, connected/isolated areas, reachability from a tile, repetition, and event-position access. Honors looping maps and source/destination passage. Event collision, active pages, plugins, vehicles, and runtime behavior remain unknown.',
    inputSchema: schema.shape,
    handler: async (ctx, args) => {
      const input = schema.parse(args);
      const map = await getMap(ctx.projectPath, input.mapId);
      const tileset = await getTileset(ctx.projectPath, map.tilesetId);
      return { mapId: input.mapId, ...analyzeMapLayout(map, tileset, input) };
    },
  },
];
