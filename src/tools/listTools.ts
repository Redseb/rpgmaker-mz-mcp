import { z } from 'zod';
import { readJsonFile, getDataPath } from '../utils/fileHandler.js';
import { ToolDefinition } from '../registry.js';

/**
 * Database tables that can be listed as a names-only index. Each is stored as a
 * 1-indexed JSON array whose entries share an `{ id, name }` shape (slot 0 is
 * null), so a single generic lister covers all of them.
 */
export const LISTABLE_FILES = {
  actors: 'Actors.json',
  items: 'Items.json',
  weapons: 'Weapons.json',
  armors: 'Armors.json',
  skills: 'Skills.json',
  enemies: 'Enemies.json',
  troops: 'Troops.json',
  maps: 'MapInfos.json',
} as const;

export type ListableType = keyof typeof LISTABLE_FILES;

export interface NamedEntry {
  id: number;
  name: string;
}

export interface NamedIndex {
  type: ListableType;
  count: number;
  entries: NamedEntry[];
}

/**
 * Return a compact `{ id, name }` index for one database table — far cheaper
 * than the full-record `get_*`/`search_*` dumps when all you need is to look up
 * or sanity-check an ID before wiring it into an event.
 */
export async function listNames(projectPath: string, type: ListableType): Promise<NamedIndex> {
  const file = LISTABLE_FILES[type];
  if (!file) {
    throw new Error(
      `Unknown list type: ${type}. Valid types: ${Object.keys(LISTABLE_FILES).join(', ')}`,
    );
  }

  const records = await readJsonFile<(NamedEntry | null)[]>(getDataPath(projectPath, file));
  const entries = records
    .filter((record): record is NamedEntry => record != null)
    .map((record) => ({ id: record.id, name: record.name }));

  return { type, count: entries.length, entries };
}

export const listToolDefinitions: ToolDefinition[] = [
  {
    name: 'list_names',
    description:
      'Cheap names-only index for a database table. Returns { id, name } entries instead of full records — use it to look up or sanity-check IDs before wiring them into events, without paying the token cost of a full get_*/search_* dump.',
    inputSchema: {
      type: z
        .enum(Object.keys(LISTABLE_FILES) as [ListableType, ...ListableType[]])
        .describe(
          'Which table to index: actors, items, weapons, armors, skills, enemies, troops, or maps.',
        ),
    },
    handler: (ctx, args) => listNames(ctx.projectPath, args.type),
  },
];
