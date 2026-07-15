import { z } from 'zod';
import { readJsonFile, readJsonArraySoft, getDataPath } from '../utils/fileHandler.js';
import { commitChange } from '../utils/commit.js';
import { Skill } from '../utils/types.js';
import { ToolDefinition } from '../registry.js';
import { firstMissingEffectRef } from '../validation/createRefs.js';

/**
 * Get all skills from the project
 */
export async function getSkills(projectPath: string): Promise<(Skill | null)[]> {
  const skillsPath = getDataPath(projectPath, 'Skills.json');
  return await readJsonFile<(Skill | null)[]>(skillsPath);
}

/**
 * Get a specific skill by ID
 */
export async function getSkill(projectPath: string, skillId: number): Promise<Skill | null> {
  const skills = await getSkills(projectPath);
  return skills.find((skill) => skill && skill.id === skillId) || null;
}

/** The caller-supplied skill shape accepted by both `create_skill` and `batch_create`. */
export interface SkillInput {
  name: string;
  description?: string;
  iconIndex?: number;
  mpCost?: number;
  tpCost?: number;
  scope?: number;
  damage?: {
    type: number;
    elementId: number;
    formula: string;
    variance?: number;
    critical?: boolean;
  };
  effects?: Array<{
    code: number;
    dataId: number;
    value1: number;
    value2: number;
  }>;
  animationId?: number;
  message1?: string;
  stypeId?: number;
}

/**
 * Build one new skill record against the current array — the shared per-record
 * source of truth for both `create_skill` and `batch_create`. Pure: allocates the
 * next unused id (max existing + 1) and fills every unsupplied field with the
 * new-skill default. Does not push or commit, and does not run the effect
 * reference check (that needs cross-file reads) — the caller owns both.
 */
export function buildSkillRecord(existing: (Skill | null)[], input: SkillInput): Skill {
  const maxId = existing.reduce((max, skill) => (skill && skill.id > max ? skill.id : max), 0);

  return {
    id: maxId + 1,
    name: input.name,
    description: input.description || '',
    iconIndex: input.iconIndex || 64,
    mpCost: input.mpCost || 0,
    tpCost: input.tpCost || 0,
    tpGain: 0,
    scope: input.scope || 1, // Default: enemy single
    occasion: 1, // Battle only
    speed: 0,
    successRate: 100,
    repeats: 1,
    hitType: input.damage?.type === 1 || input.damage?.type === 5 ? 1 : 2,
    animationId: input.animationId || 0,
    damage: {
      type: input.damage?.type || 0,
      elementId: input.damage?.elementId || 0,
      formula: input.damage?.formula || '0',
      variance: input.damage?.variance !== undefined ? input.damage.variance : 20,
      critical: input.damage?.critical !== undefined ? input.damage.critical : false,
    },
    effects: input.effects || [],
    message1: input.message1 || '',
    message2: '',
    note: '',
    stypeId: input.stypeId || 1, // Default: Magic
    requiredWtypeId1: 0,
    requiredWtypeId2: 0,
    messageType: 1,
    traits: [],
  };
}

/**
 * Reject a skill/item whose effects point at a non-existent state / skill /
 * common event (P2-3: throw at author time, like add_class_learning /
 * create_troop). Shared by `create_skill` and `batch_create`.
 */
export async function assertSkillEffectRefs(
  projectPath: string,
  skill: Skill,
  skills: (Skill | null)[],
): Promise<void> {
  const [states, commonEvents] = await Promise.all([
    readJsonArraySoft(getDataPath(projectPath, 'States.json')),
    readJsonArraySoft(getDataPath(projectPath, 'CommonEvents.json')),
  ]);
  const missing = firstMissingEffectRef(skill.effects, { states, skills, commonEvents });
  if (missing) {
    throw new Error(`Cannot create skill "${skill.name}": ${missing}`);
  }
}

/**
 * Create a new skill
 */
export async function createSkill(projectPath: string, skillData: SkillInput): Promise<Skill> {
  const skills = await getSkills(projectPath);
  const newSkill = buildSkillRecord(skills, skillData);

  await assertSkillEffectRefs(projectPath, newSkill, skills);

  skills.push(newSkill);

  const skillsPath = getDataPath(projectPath, 'Skills.json');
  await commitChange(skillsPath, skills);

  return newSkill;
}

/**
 * Update a skill's data
 */
export async function updateSkill(
  projectPath: string,
  skillId: number,
  updates: Partial<Skill>,
): Promise<Skill> {
  const skills = await getSkills(projectPath);
  const skillIndex = skills.findIndex((skill) => skill && skill.id === skillId);

  if (skillIndex === -1) {
    throw new Error(`Skill with ID ${skillId} not found`);
  }

  skills[skillIndex] = { ...skills[skillIndex]!, ...updates, id: skillId };

  const skillsPath = getDataPath(projectPath, 'Skills.json');
  await commitChange(skillsPath, skills);

  return skills[skillIndex]!;
}

/**
 * Delete a skill
 */
export async function deleteSkill(projectPath: string, skillId: number): Promise<boolean> {
  const skills = await getSkills(projectPath);
  const skillIndex = skills.findIndex((skill) => skill && skill.id === skillId);

  if (skillIndex === -1) {
    return false;
  }

  // Don't delete core skills (1, 2)
  if (skillId === 1 || skillId === 2) {
    throw new Error('Cannot delete core skills (Attack/Guard)');
  }

  skills[skillIndex] = null as any;

  const skillsPath = getDataPath(projectPath, 'Skills.json');
  await commitChange(skillsPath, skills);

  return true;
}

/**
 * Search skills by name
 */
export async function searchSkills(projectPath: string, searchTerm: string): Promise<Skill[]> {
  const skills = await getSkills(projectPath);
  const lowerSearchTerm = searchTerm.toLowerCase();

  return skills.filter(
    (skill): skill is Skill =>
      !!skill &&
      (skill.name.toLowerCase().includes(lowerSearchTerm) ||
        skill.description.toLowerCase().includes(lowerSearchTerm)),
  );
}

/**
 * Create a damage skill (attack spell or physical skill)
 */
export async function createDamageSkill(
  projectPath: string,
  name: string,
  damageFormula: string,
  mpCost: number,
  scope: number,
  elementId?: number,
  description?: string,
): Promise<Skill> {
  return await createSkill(projectPath, {
    name,
    description: description || `Deals damage with ${name}.`,
    mpCost,
    scope,
    damage: {
      type: 1, // HP damage
      elementId: elementId || 0,
      formula: damageFormula,
      variance: 20,
      critical: true,
    },
    animationId: 1,
    message1: '%1 casts %2!', // %1 = subject name, %2 = skill name
    stypeId: 1, // Magic
  });
}

/**
 * Create a healing skill
 */
export async function createHealingSkill(
  projectPath: string,
  name: string,
  healFormula: string,
  mpCost: number,
  scope: number,
  description?: string,
): Promise<Skill> {
  return await createSkill(projectPath, {
    name,
    description: description || `Restores HP with ${name}.`,
    mpCost,
    scope,
    damage: {
      type: 3, // HP recovery
      elementId: 0,
      formula: healFormula,
      variance: 20,
      critical: false,
    },
    animationId: 47,
    message1: '%1 casts %2!', // %1 = subject name, %2 = skill name
    stypeId: 1,
    iconIndex: 72,
  });
}

/**
 * Create a buff skill
 */
export async function createBuffSkill(
  projectPath: string,
  name: string,
  buffType: number,
  turns: number,
  mpCost: number,
  scope: number,
  description?: string,
): Promise<Skill> {
  return await createSkill(projectPath, {
    name,
    description: description || `Strengthens allies with ${name}.`,
    mpCost,
    scope,
    effects: [
      {
        code: 31, // Add buff
        dataId: buffType,
        value1: turns,
        value2: 0,
      },
    ],
    animationId: 52,
    message1: '%1 uses %2!', // %1 = subject name, %2 = skill name
    stypeId: 1,
    iconIndex: 73,
  });
}

/**
 * Create a debuff skill
 */
export async function createDebuffSkill(
  projectPath: string,
  name: string,
  debuffType: number,
  turns: number,
  mpCost: number,
  scope: number,
  description?: string,
): Promise<Skill> {
  return await createSkill(projectPath, {
    name,
    description: description || `Weakens enemies with ${name}.`,
    mpCost,
    scope,
    effects: [
      {
        code: 32, // Add debuff
        dataId: debuffType,
        value1: turns,
        value2: 0,
      },
    ],
    animationId: 40,
    message1: '%1 uses %2!', // %1 = subject name, %2 = skill name
    stypeId: 1,
    iconIndex: 74,
  });
}

/**
 * Create a state-inflicting skill
 */
export async function createStateSkill(
  projectPath: string,
  name: string,
  stateId: number,
  chance: number,
  mpCost: number,
  scope: number,
  description?: string,
): Promise<Skill> {
  return await createSkill(projectPath, {
    name,
    description: description || `Inflicts a status ailment with ${name}.`,
    mpCost,
    scope,
    effects: [
      {
        code: 21, // Add state
        dataId: stateId,
        value1: chance,
        value2: 0,
      },
    ],
    damage: {
      type: 0,
      elementId: 0,
      formula: '0',
      variance: 20,
      critical: false,
    },
    animationId: 1,
    message1: '%1 uses %2!', // %1 = subject name, %2 = skill name
    stypeId: 1,
  });
}

export const skillToolDefinitions: ToolDefinition[] = [
  {
    name: 'get_skill',
    description: 'Get a specific skill by ID',
    inputSchema: {
      skillId: z.number().int().positive().describe('The ID of the skill to retrieve'),
    },
    handler: (ctx, args) => getSkill(ctx.projectPath, args.skillId),
  },
  {
    name: 'create_skill',
    mutates: true,
    description:
      'Create a new skill with custom properties. An effect referencing a missing record throws: Add/Remove State (code 21/22) → state, Learn Skill (43) → skill, Common Event (44) → common event.',
    inputSchema: {
      name: z.string().describe('Skill name'),
      description: z.string().optional().describe('Skill description'),
      iconIndex: z.number().int().min(0).optional().describe('Icon index (0-1000+)'),
      mpCost: z.number().optional().describe('MP cost'),
      tpCost: z.number().optional().describe('TP cost'),
      scope: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Target scope (1=enemy single, 2=enemy all, 7=ally all, etc.)'),
      damage: z
        .object({
          type: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe('Damage type (0=none, 1=HP damage, 3=HP recover, etc.)'),
          elementId: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe('Element ID (0=none, 2=fire, 3=ice, etc.)'),
          formula: z.string().optional().describe('Damage formula (e.g., "a.mat * 4 - b.mdf * 2")'),
          variance: z.number().optional(),
          critical: z.boolean().optional(),
        })
        .optional()
        .describe('Damage configuration'),
      effects: z
        .array(z.unknown())
        .optional()
        .describe('Skill effects (buffs, debuffs, states, etc.)'),
      animationId: z.number().int().min(0).optional().describe('Animation ID'),
      message1: z.string().optional().describe('Battle message'),
      stypeId: z.number().int().min(0).optional().describe('Skill type (1=magic, 2=special, etc.)'),
    },
    handler: (ctx, args) => createSkill(ctx.projectPath, args as Parameters<typeof createSkill>[1]),
  },
  {
    name: 'create_damage_skill',
    mutates: true,
    description: 'Create a damage-dealing skill (simplified)',
    inputSchema: {
      name: z.string().describe('Skill name'),
      damageFormula: z.string().describe('Damage formula (e.g., "a.mat * 4")'),
      mpCost: z.number().describe('MP cost'),
      scope: z.number().int().min(0).describe('Target scope (1=enemy single, 2=enemy all)'),
      elementId: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Element ID (0=none, 2=fire, 3=ice, 4=thunder)'),
      description: z.string().optional().describe('Skill description'),
    },
    handler: (ctx, args) =>
      createDamageSkill(
        ctx.projectPath,
        args.name,
        args.damageFormula,
        args.mpCost,
        args.scope,
        args.elementId,
        args.description,
      ),
  },
  {
    name: 'create_healing_skill',
    mutates: true,
    description: 'Create a healing skill (simplified)',
    inputSchema: {
      name: z.string().describe('Skill name'),
      healFormula: z.string().describe('Heal formula (e.g., "a.mat * 3 + 100")'),
      mpCost: z.number().describe('MP cost'),
      scope: z.number().int().min(0).describe('Target scope (7=ally all, 11=user)'),
      description: z.string().optional().describe('Skill description'),
    },
    handler: (ctx, args) =>
      createHealingSkill(
        ctx.projectPath,
        args.name,
        args.healFormula,
        args.mpCost,
        args.scope,
        args.description,
      ),
  },
  {
    name: 'create_buff_skill',
    mutates: true,
    description: 'Create a buff skill (simplified)',
    inputSchema: {
      name: z.string().describe('Skill name'),
      buffType: z.number().int().min(0).describe('Buff type (2=ATK, 3=DEF, 4=MAT, 5=MDF, 6=AGI)'),
      turns: z.number().describe('Number of turns the buff lasts'),
      mpCost: z.number().describe('MP cost'),
      scope: z.number().int().min(0).describe('Target scope (7=ally all, 11=user)'),
      description: z.string().optional().describe('Skill description'),
    },
    handler: (ctx, args) =>
      createBuffSkill(
        ctx.projectPath,
        args.name,
        args.buffType,
        args.turns,
        args.mpCost,
        args.scope,
        args.description,
      ),
  },
  {
    name: 'create_state_skill',
    mutates: true,
    description:
      'Create a state-inflicting skill (poison, sleep, etc.). Throws if `stateId` does not exist in States.json (create the state first with create_state).',
    inputSchema: {
      name: z.string().describe('Skill name'),
      stateId: z
        .number()
        .int()
        .positive()
        .describe('State ID (4=poison, 5=blind, 6=silence, 8=confusion, etc.)'),
      chance: z.number().describe('Success chance (0.0-1.0)'),
      mpCost: z.number().describe('MP cost'),
      scope: z.number().int().min(0).describe('Target scope (1=enemy single, 2=enemy all)'),
      description: z.string().optional().describe('Skill description'),
    },
    handler: (ctx, args) =>
      createStateSkill(
        ctx.projectPath,
        args.name,
        args.stateId,
        args.chance,
        args.mpCost,
        args.scope,
        args.description,
      ),
  },
  {
    name: 'update_skill',
    mutates: true,
    description: "Update a skill's properties",
    inputSchema: {
      skillId: z.number().int().positive().describe('The skill ID to update'),
      updates: z.record(z.string(), z.unknown()).describe('Properties to update'),
    },
    handler: (ctx, args) => updateSkill(ctx.projectPath, args.skillId, args.updates),
  },
  {
    name: 'search_skills',
    description: 'Search skills by name or description',
    inputSchema: { searchTerm: z.string().describe('Search term') },
    handler: (ctx, args) => searchSkills(ctx.projectPath, args.searchTerm),
  },
];
