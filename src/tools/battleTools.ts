import { z } from 'zod';
import { readJsonFile, readJsonArraySoft, getDataPath } from '../utils/fileHandler.js';
import { commitChange } from '../utils/commit.js';
import { Enemy, Troop, TroopMember, TroopPage } from '../utils/types.js';
import { ToolDefinition } from '../registry.js';
import { definedOnly } from '../utils/records.js';
import { validateCommandList, ValidationWarning } from '../validation/eventCommands.js';
import { firstMissingEnemyRef } from '../validation/createRefs.js';
import { listAssets } from './assetTools.js';

/**
 * Blank enemy mirroring what the RPG Maker MZ editor writes for a freshly-created
 * enemy: 100 HP, one "Attack" action, three empty drop slots, no traits. Pure so
 * the template shape can be unit-tested. `params` order is
 * [mhp, mmp, atk, def, mat, mdf, agi, luk].
 */
export function defaultEnemy(): Omit<Enemy, 'id'> {
  return {
    name: '',
    battlerName: '',
    battlerHue: 0,
    params: [100, 0, 10, 10, 10, 10, 10, 10],
    exp: 0,
    gold: 0,
    dropItems: [
      { kind: 0, dataId: 1, denominator: 1 },
      { kind: 0, dataId: 1, denominator: 1 },
      { kind: 0, dataId: 1, denominator: 1 },
    ],
    actions: [{ conditionParam1: 0, conditionParam2: 0, conditionType: 0, rating: 5, skillId: 1 }],
    traits: [],
    note: '',
  };
}

/**
 * A blank troop battle-event page matching the editor's default: a "span whole
 * battle" page with an empty (just the code-0 end marker) command list and the
 * editor's default condition values (all toggles off).
 */
export function blankTroopPage(): TroopPage {
  return {
    conditions: {
      actorHp: 50,
      actorId: 1,
      actorValid: false,
      enemyHp: 50,
      enemyIndex: 0,
      enemyValid: false,
      switchId: 1,
      switchValid: false,
      turnA: 0,
      turnB: 0,
      turnEnding: false,
      turnValid: false,
    },
    list: [{ code: 0, indent: 0, parameters: [] }],
    span: 0,
  };
}

/**
 * Attach warn-by-default validation to a troop-write response. A troop's pages
 * reuse the event-command `list` format, so the same command validator applies.
 * Warnings are advisory (never block) and omitted when the troop is clean.
 */
function withTroopValidation(troop: Troop): { troop: Troop; warnings?: ValidationWarning[] } {
  const warnings: ValidationWarning[] = [];
  if (Array.isArray(troop.pages)) {
    troop.pages.forEach((page, i) => {
      warnings.push(...validateCommandList(page?.list, `troop ${troop.id} / page ${i}`));
    });
  }
  return warnings.length > 0 ? { troop, warnings } : { troop };
}

/**
 * Warn (never throw) when an enemy's `battlerName` isn't among the project's
 * `img/enemies` assets — a wrong battler filename is a silent runtime failure (a
 * blank/missing sprite in battle). Skips the check when the name is empty or the
 * asset dir is empty/missing (nothing to validate against — e.g. a fixture), so it
 * can't emit false positives. Mirrors `characterNameWarnings` (eventPageTools) and
 * `audioNameWarnings` (eventCommandTools).
 */
async function battlerNameWarnings(
  projectPath: string,
  name: string | undefined,
): Promise<ValidationWarning[]> {
  if (!projectPath || !name) return [];
  const { names } = await listAssets(projectPath, 'enemies');
  if (names.length > 0 && !names.includes(name)) {
    return [
      {
        path: 'battlerName',
        code: undefined,
        message: `battler "${name}" is not a known enemies asset (a wrong filename shows a blank sprite in battle)`,
      },
    ];
  }
  return [];
}

/** Attach warn-by-default battler-asset validation to an enemy-write response. */
async function withEnemyAssetWarnings(
  projectPath: string,
  enemy: Enemy,
): Promise<{ enemy: Enemy; warnings?: ValidationWarning[] }> {
  const warnings = await battlerNameWarnings(projectPath, enemy.battlerName);
  return warnings.length > 0 ? { enemy, warnings } : { enemy };
}

// --- Enemies ---------------------------------------------------------------

/** Get all enemies from the project. */
export async function getEnemies(projectPath: string): Promise<(Enemy | null)[]> {
  return await readJsonFile<(Enemy | null)[]>(getDataPath(projectPath, 'Enemies.json'));
}

/** Search enemies by name (case-insensitive). */
export async function searchEnemies(projectPath: string, searchTerm: string): Promise<Enemy[]> {
  const enemies = await getEnemies(projectPath);
  const lower = searchTerm.toLowerCase();
  return enemies.filter((e): e is Enemy => !!e && e.name.toLowerCase().includes(lower));
}

/**
 * Create a new enemy. Only `name` is required; any omitted field falls back to
 * the editor's new-enemy default (see {@link defaultEnemy}). Allocates the next
 * unused id (max existing + 1) and writes through the commit choke point.
 */
export async function createEnemy(
  projectPath: string,
  overrides: Partial<Omit<Enemy, 'id'>>,
): Promise<Enemy> {
  const enemies = await getEnemies(projectPath);
  const maxId = enemies.reduce((max, e) => (e && e.id > max ? e.id : max), 0);

  // Template first, caller's defined fields next, computed id last so it always wins.
  const enemy: Enemy = {
    ...defaultEnemy(),
    ...definedOnly(overrides),
    id: maxId + 1,
  };

  // Reject an enemy whose actions/drops point at a non-existent db record (P2-3:
  // throw at author time, matching create_troop's member.enemyId check). The
  // battlerName stays a *warning* (an asset filename, not a db id).
  const [skills, items, weapons, armors] = await Promise.all([
    readJsonArraySoft(getDataPath(projectPath, 'Skills.json')),
    readJsonArraySoft(getDataPath(projectPath, 'Items.json')),
    readJsonArraySoft(getDataPath(projectPath, 'Weapons.json')),
    readJsonArraySoft(getDataPath(projectPath, 'Armors.json')),
  ]);
  const missing = firstMissingEnemyRef(enemy, { skills, items, weapons, armors });
  if (missing) {
    throw new Error(`Cannot create enemy "${enemy.name}": ${missing}`);
  }

  enemies.push(enemy);
  await commitChange(getDataPath(projectPath, 'Enemies.json'), enemies);
  return enemy;
}

/** Update an existing enemy's properties (shallow merge). */
export async function updateEnemy(
  projectPath: string,
  enemyId: number,
  updates: Partial<Enemy>,
): Promise<Enemy> {
  const enemies = await getEnemies(projectPath);
  const index = enemies.findIndex((e) => e && e.id === enemyId);
  if (index === -1) {
    throw new Error(`Enemy with ID ${enemyId} not found`);
  }

  enemies[index] = { ...enemies[index]!, ...updates, id: enemyId };
  await commitChange(getDataPath(projectPath, 'Enemies.json'), enemies);
  return enemies[index]!;
}

// --- Troops ----------------------------------------------------------------

/** Get all troops from the project. */
export async function getTroops(projectPath: string): Promise<(Troop | null)[]> {
  return await readJsonFile<(Troop | null)[]>(getDataPath(projectPath, 'Troops.json'));
}

/** Search troops by name (case-insensitive). */
export async function searchTroops(projectPath: string, searchTerm: string): Promise<Troop[]> {
  const troops = await getTroops(projectPath);
  const lower = searchTerm.toLowerCase();
  return troops.filter((t): t is Troop => !!t && t.name.toLowerCase().includes(lower));
}

/**
 * Assert every troop member references an enemy that exists in Enemies.json, so a
 * troop can't be created pointing at a non-existent enemy (mirrors create_map's
 * parent check). Structural error → throws.
 */
async function assertMembersReferenceEnemies(
  projectPath: string,
  members: TroopMember[],
): Promise<void> {
  if (members.length === 0) return;
  const enemies = await getEnemies(projectPath);
  for (const member of members) {
    if (!enemies.some((e) => e && e.id === member.enemyId)) {
      throw new Error(`Troop member references enemyId ${member.enemyId}, which does not exist`);
    }
  }
}

/**
 * Create a new troop. `name` is required; `members` defaults to empty and `pages`
 * to a single blank battle-event page. Validates that each member references an
 * existing enemy, allocates the next unused id, and writes through the commit
 * choke point. Returns warn-by-default validation of the troop's pages.
 */
export async function createTroop(
  projectPath: string,
  options: { name: string; members?: TroopMember[]; pages?: TroopPage[] },
): Promise<Troop> {
  const members = options.members ?? [];
  await assertMembersReferenceEnemies(projectPath, members);

  const troops = await getTroops(projectPath);
  const maxId = troops.reduce((max, t) => (t && t.id > max ? t.id : max), 0);

  const troop: Troop = {
    id: maxId + 1,
    name: options.name,
    members,
    pages: options.pages ?? [blankTroopPage()],
  };

  troops.push(troop);
  await commitChange(getDataPath(projectPath, 'Troops.json'), troops);
  return troop;
}

/** Update an existing troop's properties (shallow merge). */
export async function updateTroop(
  projectPath: string,
  troopId: number,
  updates: Partial<Troop>,
): Promise<Troop> {
  const troops = await getTroops(projectPath);
  const index = troops.findIndex((t) => t && t.id === troopId);
  if (index === -1) {
    throw new Error(`Troop with ID ${troopId} not found`);
  }

  const merged: Troop = { ...troops[index]!, ...updates, id: troopId };
  if (updates.members) {
    await assertMembersReferenceEnemies(projectPath, merged.members);
  }

  troops[index] = merged;
  await commitChange(getDataPath(projectPath, 'Troops.json'), troops);
  return merged;
}

const troopMemberSchema = z.object({
  enemyId: z.number().int().describe('Enemy id from Enemies.json'),
  x: z.number().int().describe('X screen position of the enemy in battle'),
  y: z.number().int().describe('Y screen position of the enemy in battle'),
  hidden: z.boolean().optional().default(false).describe('Whether the enemy starts hidden'),
});

export const battleToolDefinitions: ToolDefinition[] = [
  {
    name: 'get_enemies',
    description: 'Get all enemies from the project (data/Enemies.json)',
    inputSchema: {},
    handler: (ctx) => getEnemies(ctx.projectPath),
  },
  {
    name: 'create_enemy',
    mutates: true,
    description:
      "Create a new enemy in data/Enemies.json. Only `name` is required; omitted fields use the editor's new-enemy defaults (100 HP, one Attack action, no drops). Allocates the next unused enemy id and returns `{ enemy, warnings? }` (warn-by-default: a `battlerName` not found in img/enemies is flagged, never blocked). Throws if an `actions[].skillId` or a `dropItems[].dataId` (item/weapon/armor by `kind`) references a record that does not exist. NOTE: an enemy with no Hit Rate trait (xparam id 0: trait { code: 22, dataId: 0, value: 0.95 }) always misses physical actions — pass one in `traits` if the enemy should land basic attacks.",
    inputSchema: {
      name: z.string().describe('Enemy name shown in battle and the database'),
      battlerName: z.string().optional().describe('Battler graphic filename (img/enemies)'),
      battlerHue: z.number().int().optional().describe('Battler hue rotation 0-360'),
      params: z
        .array(z.number())
        .length(8)
        .optional()
        .describe('8 base params: [maxHP, maxMP, atk, def, mat, mdf, agi, luk]'),
      exp: z.number().int().optional().describe('EXP granted when defeated'),
      gold: z.number().int().optional().describe('Gold granted when defeated'),
      note: z.string().optional().describe('Note field'),
      traits: z.array(z.unknown()).optional().describe('Trait objects { code, dataId, value }'),
      dropItems: z
        .array(z.unknown())
        .optional()
        .describe('Drop-item objects { kind, dataId, denominator }'),
      actions: z
        .array(z.unknown())
        .optional()
        .describe(
          'Action patterns { skillId, conditionType, conditionParam1, conditionParam2, rating }',
        ),
    },
    handler: async (ctx, args) => {
      const { dryRun: _dryRun, ...overrides } = args;
      const enemy = await createEnemy(ctx.projectPath, overrides as Partial<Omit<Enemy, 'id'>>);
      return withEnemyAssetWarnings(ctx.projectPath, enemy);
    },
  },
  {
    name: 'update_enemy',
    mutates: true,
    description:
      "Update an enemy's properties (shallow merge into the existing record). Returns `{ enemy, warnings? }` — a `battlerName` not found in img/enemies is flagged warn-by-default.",
    inputSchema: {
      enemyId: z.number().describe('The ID of the enemy to update'),
      updates: z
        .record(z.string(), z.unknown())
        .describe('Object containing enemy properties to update'),
    },
    handler: async (ctx, args) =>
      withEnemyAssetWarnings(
        ctx.projectPath,
        await updateEnemy(ctx.projectPath, args.enemyId, args.updates),
      ),
  },
  {
    name: 'get_troops',
    description: 'Get all troops from the project (data/Troops.json)',
    inputSchema: {},
    handler: (ctx) => getTroops(ctx.projectPath),
  },
  {
    name: 'create_troop',
    mutates: true,
    description:
      'Create a new troop (enemy battle group) in data/Troops.json. `name` is required; `members` defaults to empty and `pages` to one blank battle-event page. Every member.enemyId must reference an existing enemy. Returns warn-by-default validation of the troop pages.',
    inputSchema: {
      name: z.string().describe('Troop name shown in the database'),
      members: z
        .array(troopMemberSchema)
        .optional()
        .describe('Placed enemies; each references an existing enemyId'),
      pages: z
        .array(z.unknown())
        .optional()
        .describe('Battle-event pages { conditions, list, span }; defaults to one blank page'),
    },
    handler: async (ctx, args) =>
      withTroopValidation(
        await createTroop(ctx.projectPath, {
          name: args.name,
          members: args.members as TroopMember[] | undefined,
          pages: args.pages as TroopPage[] | undefined,
        }),
      ),
  },
  {
    name: 'update_troop',
    mutates: true,
    description:
      "Update a troop's properties (shallow merge). If `members` is provided, each enemyId is validated to exist. Returns warn-by-default validation of the troop pages.",
    inputSchema: {
      troopId: z.number().describe('The ID of the troop to update'),
      updates: z
        .record(z.string(), z.unknown())
        .describe('Object containing troop properties to update (name, members, pages)'),
    },
    handler: async (ctx, args) =>
      withTroopValidation(await updateTroop(ctx.projectPath, args.troopId, args.updates)),
  },
];
