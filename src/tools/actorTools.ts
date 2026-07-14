import { z } from 'zod';
import { readJsonFile, getDataPath } from '../utils/fileHandler.js';
import { commitChange } from '../utils/commit.js';
import { Actor } from '../utils/types.js';
import { ToolDefinition } from '../registry.js';

/**
 * Drop keys whose value is `undefined` so a caller's omitted optional field can't
 * clobber a template default when spread over it.
 */
function definedOnly<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * A blank actor mirroring what the RPG Maker MZ editor writes for a freshly-created
 * actor (the "New Actor" shape from newdata/data/Actors.json): class 1, level 1-99,
 * five empty equip slots, no traits, empty graphic/name fields. Pure so the template
 * shape can be unit-tested.
 *
 * Every field is present — `create_actor` previously wrote only the fields a caller
 * passed, so an actor made with just `name` was missing `equips`/`traits`/etc.
 * entirely, which crashes the engine on load (Game_Actor reads `equips.length` and
 * concats `traits` unconditionally). Field order mirrors the editor's on-disk shape.
 */
export function defaultActor(): Omit<Actor, 'id'> {
  return {
    name: '',
    nickname: '',
    classId: 1,
    initialLevel: 1,
    maxLevel: 99,
    characterName: '',
    characterIndex: 0,
    faceName: '',
    faceIndex: 0,
    battlerName: '',
    equips: [0, 0, 0, 0, 0],
    traits: [],
    note: '',
    profile: '',
  };
}

/**
 * Get all actors from the project
 */
export async function getActors(projectPath: string): Promise<Actor[]> {
  const actorsPath = getDataPath(projectPath, 'Actors.json');
  return await readJsonFile<Actor[]>(actorsPath);
}

/**
 * Get a specific actor by ID
 */
export async function getActor(projectPath: string, actorId: number): Promise<Actor | null> {
  const actors = await getActors(projectPath);
  return actors.find((actor) => actor && actor.id === actorId) || null;
}

/**
 * Update an actor's data
 */
export async function updateActor(
  projectPath: string,
  actorId: number,
  updates: Partial<Actor>,
): Promise<Actor> {
  const actors = await getActors(projectPath);
  const actorIndex = actors.findIndex((actor) => actor && actor.id === actorId);

  if (actorIndex === -1) {
    throw new Error(`Actor with ID ${actorId} not found`);
  }

  actors[actorIndex] = { ...actors[actorIndex], ...updates, id: actorId };

  const actorsPath = getDataPath(projectPath, 'Actors.json');
  await commitChange(actorsPath, actors);

  return actors[actorIndex];
}

/**
 * Create a new actor. Only `name` is required; any omitted field falls back to the
 * editor's new-actor default (see {@link defaultActor}) so the record is always
 * complete. Allocates the next unused id (max existing + 1) and writes through the
 * commit choke point.
 */
export async function createActor(
  projectPath: string,
  overrides: Partial<Omit<Actor, 'id'>>,
): Promise<Actor> {
  const actors = await getActors(projectPath);

  // Find the next available ID
  const maxId = actors.reduce((max, actor) => {
    return actor && actor.id > max ? actor.id : max;
  }, 0);

  // Template first, caller's defined fields next, computed id last so it always wins.
  const newActor: Actor = {
    ...defaultActor(),
    ...definedOnly(overrides),
    id: maxId + 1,
  };

  actors.push(newActor);

  const actorsPath = getDataPath(projectPath, 'Actors.json');
  await commitChange(actorsPath, actors);

  return newActor;
}

/**
 * Delete an actor
 */
export async function deleteActor(projectPath: string, actorId: number): Promise<boolean> {
  const actors = await getActors(projectPath);
  const actorIndex = actors.findIndex((actor) => actor && actor.id === actorId);

  if (actorIndex === -1) {
    return false;
  }

  actors[actorIndex] = null as any;

  const actorsPath = getDataPath(projectPath, 'Actors.json');
  await commitChange(actorsPath, actors);

  return true;
}

/**
 * Search actors by name
 */
export async function searchActors(projectPath: string, searchTerm: string): Promise<Actor[]> {
  const actors = await getActors(projectPath);
  const lowerSearchTerm = searchTerm.toLowerCase();

  return actors.filter(
    (actor) =>
      actor &&
      (actor.name.toLowerCase().includes(lowerSearchTerm) ||
        actor.nickname.toLowerCase().includes(lowerSearchTerm)),
  );
}

export const actorToolDefinitions: ToolDefinition[] = [
  {
    name: 'get_actors',
    description: 'Get all actors from the RPG Maker MZ project',
    inputSchema: {},
    handler: (ctx) => getActors(ctx.projectPath),
  },
  {
    name: 'get_actor',
    description: 'Get a specific actor by ID',
    inputSchema: { actorId: z.number().describe('The ID of the actor to retrieve') },
    handler: (ctx, args) => getActor(ctx.projectPath, args.actorId),
  },
  {
    name: 'update_actor',
    mutates: true,
    description: "Update an actor's properties",
    inputSchema: {
      actorId: z.number().describe('The ID of the actor to update'),
      updates: z
        .record(z.string(), z.unknown())
        .describe('Object containing actor properties to update'),
    },
    handler: (ctx, args) => updateActor(ctx.projectPath, args.actorId, args.updates),
  },
  {
    name: 'create_actor',
    mutates: true,
    description:
      "Create a new actor in data/Actors.json. Only `name` is required; omitted fields use the editor's new-actor defaults (class 1, level 1-99, five empty equip slots, no traits). Allocates and returns the next unused actor id. NOTE: an actor's physical accuracy comes from its class + own traits — a class/actor with no Hit Rate trait (xparam id 0: trait { code: 22, dataId: 0, value: 0.95 }) always misses physical actions. The built-in class 1 has one; a custom class needs it added.",
    inputSchema: {
      name: z.string(),
      nickname: z.string().optional(),
      profile: z.string().optional(),
      classId: z.number().optional(),
      initialLevel: z.number().optional(),
      maxLevel: z.number().optional(),
      characterName: z.string().optional(),
      characterIndex: z.number().optional(),
      faceName: z.string().optional(),
      faceIndex: z.number().optional(),
      battlerName: z.string().optional(),
      traits: z.array(z.unknown()).optional(),
      equips: z.array(z.number()).optional(),
      note: z.string().optional(),
    },
    handler: (ctx, args) => {
      const { dryRun: _dryRun, ...overrides } = args;
      return createActor(ctx.projectPath, overrides as Partial<Omit<Actor, 'id'>>);
    },
  },
  {
    name: 'search_actors',
    description: 'Search actors by name or nickname',
    inputSchema: { searchTerm: z.string().describe('The search term to find actors') },
    handler: (ctx, args) => searchActors(ctx.projectPath, args.searchTerm),
  },
];
