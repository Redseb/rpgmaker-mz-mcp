import { z } from 'zod';
import { ToolDefinition } from '../registry.js';
import { getMap, getMapInfos, getMapEvent } from './mapTools.js';
import { validateEvent, validateEvents, ValidationWarning } from '../validation/eventCommands.js';
import { readJsonFile, getDataPath } from '../utils/fileHandler.js';
import { checkReferences, ProjectData, ReferenceWarning } from '../validation/references.js';
import { SystemData, MapInfo } from '../utils/types.js';

/**
 * Validate a single event's command lists against the known-command table.
 * Warn-by-default: this reports problems, it never modifies anything.
 */
export async function validateEventTool(
  projectPath: string,
  mapId: number,
  eventId: number,
): Promise<{ mapId: number; eventId: number; ok: boolean; warnings: ValidationWarning[] }> {
  const event = await getMapEvent(projectPath, mapId, eventId);
  if (!event) {
    throw new Error(`Event ${eventId} not found on map ${mapId}`);
  }
  const report = validateEvent(event);
  return { mapId, eventId, ...report };
}

/**
 * Validate the event command lists of every map in the project. Aggregates each
 * map's warnings, tagging them with the map ID so callers can locate them.
 */
export async function validateProjectTool(projectPath: string): Promise<{
  ok: boolean;
  mapsChecked: number;
  warnings: Array<ValidationWarning & { mapId: number }>;
}> {
  const infos = (await getMapInfos(projectPath)) as (MapInfo | null)[];
  const mapIds = infos.filter((info): info is MapInfo => info != null).map((info) => info.id);

  const warnings: Array<ValidationWarning & { mapId: number }> = [];
  let mapsChecked = 0;

  for (const mapId of mapIds) {
    let map;
    try {
      map = await getMap(projectPath, mapId);
    } catch {
      // A map listed in MapInfos may not have a MapNNN.json file yet; skip it.
      continue;
    }
    mapsChecked++;
    const report = validateEvents(map.events);
    for (const warning of report.warnings) {
      warnings.push({ mapId, ...warning });
    }
  }

  return { ok: warnings.length === 0, mapsChecked, warnings };
}

/** Read a 1-indexed database array, failing soft to `[]` if the file is absent. */
async function loadArray<T>(projectPath: string, file: string): Promise<(T | null)[]> {
  try {
    return await readJsonFile<(T | null)[]>(getDataPath(projectPath, file));
  } catch {
    return [];
  }
}

/**
 * Load the whole project snapshot the reference linter needs. Every read fails
 * soft: a missing/unreadable file yields an empty array (or `null` for
 * `Animations.json`/`System.json`), so the audit degrades to fewer checks rather
 * than throwing.
 */
async function loadProjectData(projectPath: string): Promise<ProjectData> {
  const mapInfos = await loadArray<MapInfo>(projectPath, 'MapInfos.json');

  const maps: ProjectData['maps'] = [];
  for (const info of mapInfos) {
    if (!info) continue;
    try {
      const map = await getMap(projectPath, info.id);
      maps.push({ id: info.id, events: map.events });
    } catch {
      // A map listed in MapInfos may not have a MapNNN.json file yet; skip it.
    }
  }

  let animations: (unknown | null)[] | null = null;
  try {
    animations = await readJsonFile<(unknown | null)[]>(
      getDataPath(projectPath, 'Animations.json'),
    );
  } catch {
    animations = null; // absent -> skip animation-id checks rather than flag everything
  }

  let system: SystemData | null = null;
  try {
    system = await readJsonFile<SystemData>(getDataPath(projectPath, 'System.json'));
  } catch {
    system = null;
  }

  return {
    mapInfos,
    maps,
    actors: await loadArray(projectPath, 'Actors.json'),
    classes: await loadArray(projectPath, 'Classes.json'),
    skills: await loadArray(projectPath, 'Skills.json'),
    items: await loadArray(projectPath, 'Items.json'),
    weapons: await loadArray(projectPath, 'Weapons.json'),
    armors: await loadArray(projectPath, 'Armors.json'),
    enemies: await loadArray(projectPath, 'Enemies.json'),
    troops: await loadArray(projectPath, 'Troops.json'),
    states: await loadArray(projectPath, 'States.json'),
    commonEvents: await loadArray(projectPath, 'CommonEvents.json'),
    animations,
    system,
  };
}

/**
 * Cross-file reference-integrity audit for the whole project. Read-only and
 * warn-by-default: reports dangling/cyclic references (a Transfer Player to a
 * missing map, a skill effect adding a non-existent state, a troop member for a
 * deleted enemy, a cyclic map tree, …) without changing anything. Complements
 * `validate_project`, which only checks event-command *shape*.
 */
export async function validateReferencesTool(
  projectPath: string,
): Promise<{ ok: boolean; warnings: ReferenceWarning[] }> {
  const data = await loadProjectData(projectPath);
  const warnings = checkReferences(data);
  return { ok: warnings.length === 0, warnings };
}

export const validationToolDefinitions: ToolDefinition[] = [
  {
    name: 'validate_event',
    description:
      "Validate a single event's command lists against the known RPG Maker MZ command table. Read-only: reports parameter/structure warnings without changing anything.",
    inputSchema: {
      mapId: z.number().describe('The ID of the map'),
      eventId: z.number().describe('The ID of the event to validate'),
    },
    handler: (ctx, args) => validateEventTool(ctx.projectPath, args.mapId, args.eventId),
  },
  {
    name: 'validate_project',
    description:
      'Validate the event command lists of every map in the project. Read-only: returns aggregated, map-tagged warnings for auditing before or after a batch of edits.',
    inputSchema: {},
    handler: (ctx) => validateProjectTool(ctx.projectPath),
  },
  {
    name: 'validate_references',
    description:
      'Audit cross-file reference integrity across the whole project (read-only, warn-by-default): Transfer Player targets and starting position point at existing maps; starting party, actor classes, class/enemy skills, troop members, enemy drops, and skill/item effects (states, learned skills, common events, animations) all resolve; and the map tree has no dangling or cyclic parentId. Complements validate_project (which checks command shape). Returns { ok, warnings[] }.',
    inputSchema: {},
    handler: (ctx) => validateReferencesTool(ctx.projectPath),
  },
];
