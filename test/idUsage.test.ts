import { describe, it, expect } from 'vitest';
import { commandIdRefs, scanIdUsage, scannedCommandCodes } from '../src/validation/idUsage.js';
import { ProjectData } from '../src/validation/references.js';
import { EventCommand } from '../src/utils/types.js';

const cmd = (code: number, parameters: unknown[]): EventCommand =>
  ({ code, indent: 0, parameters }) as unknown as EventCommand;

/** A ProjectData with everything empty; tests fill in only what they exercise. */
function emptyProject(overrides: Partial<ProjectData> = {}): ProjectData {
  return {
    mapInfos: [],
    maps: [],
    actors: [],
    classes: [],
    skills: [],
    items: [],
    weapons: [],
    armors: [],
    enemies: [],
    troops: [],
    states: [],
    commonEvents: [],
    animations: null,
    system: null,
    ...overrides,
  };
}

describe('commandIdRefs — switches', () => {
  it('expands a Control Switches range inclusively', () => {
    expect(commandIdRefs(cmd(121, [3, 6, 0]), 'switch')).toEqual([
      { id: 3, via: 'Control Switches' },
      { id: 4, via: 'Control Switches' },
      { id: 5, via: 'Control Switches' },
      { id: 6, via: 'Control Switches' },
    ]);
  });

  it('treats a single-switch command as a one-id range', () => {
    expect(commandIdRefs(cmd(121, [8, 8, 1]), 'switch')).toEqual([
      { id: 8, via: 'Control Switches' },
    ]);
  });

  it('reads a Conditional Branch switch only when the condition type is switch', () => {
    expect(commandIdRefs(cmd(111, [0, 12, 0]), 'switch')).toEqual([
      { id: 12, via: 'Conditional Branch' },
    ]);
    // Condition type 1 = variable: params[1] is a variable id, not a switch id.
    expect(commandIdRefs(cmd(111, [1, 12, 0, 5, 0]), 'switch')).toEqual([]);
  });

  it('ignores self switches — they are scoped to one event and cannot collide', () => {
    expect(commandIdRefs(cmd(123, ['A', 0]), 'switch')).toEqual([]);
    expect(commandIdRefs(cmd(111, [2, 'A', 0]), 'switch')).toEqual([]);
  });

  it('caps a runaway range rather than expanding it', () => {
    expect(commandIdRefs(cmd(121, [1, 999999, 0]), 'switch')).toHaveLength(1000);
  });
});

describe('commandIdRefs — variables', () => {
  it('expands a Control Variables range and picks up a variable operand', () => {
    // [start, end, operation, operandType 1 = variable, operand]
    expect(commandIdRefs(cmd(122, [2, 3, 0, 1, 40]), 'variable').map((r) => r.id)).toEqual([
      40, 2, 3,
    ]);
  });

  it('does not treat a constant operand as a variable id', () => {
    expect(commandIdRefs(cmd(122, [2, 2, 0, 0, 40]), 'variable').map((r) => r.id)).toEqual([2]);
  });

  it('reads both sides of a variable-to-variable Conditional Branch', () => {
    // [type 1 variable, variableId, comparison operand 1 = variable, otherVariableId, comparison]
    expect(commandIdRefs(cmd(111, [1, 7, 1, 9, 0]), 'variable').map((r) => r.id)).toEqual([7, 9]);
    // Compared against a constant: params[3] is the constant, not a variable.
    expect(commandIdRefs(cmd(111, [1, 7, 0, 9, 0]), 'variable').map((r) => r.id)).toEqual([7]);
  });

  it('reads Transfer Player map/x/y only under variable designation', () => {
    expect(commandIdRefs(cmd(201, [1, 11, 12, 13, 0, 0]), 'variable').map((r) => r.id)).toEqual([
      11, 12, 13,
    ]);
    // Direct designation: those are a map id and literal coordinates.
    expect(commandIdRefs(cmd(201, [0, 11, 12, 13, 0, 0]), 'variable')).toEqual([]);
  });

  it('reads Change Gold / Change Items variable operands', () => {
    expect(commandIdRefs(cmd(125, [0, 1, 4]), 'variable').map((r) => r.id)).toEqual([4]);
    expect(commandIdRefs(cmd(126, [3, 0, 1, 4]), 'variable').map((r) => r.id)).toEqual([4]);
    expect(commandIdRefs(cmd(126, [3, 0, 0, 4]), 'variable')).toEqual([]);
  });

  it('reads both the actor-designating and the value variable of Change HP', () => {
    // [actorRef 1 = variable, variableId, operation, operandType 1 = variable, operand, allowDeath]
    expect(commandIdRefs(cmd(311, [1, 5, 0, 1, 6, false]), 'variable').map((r) => r.id)).toEqual([
      5, 6,
    ]);
    expect(commandIdRefs(cmd(311, [0, 5, 0, 0, 6, false]), 'variable')).toEqual([]);
  });

  it('reads Get Location Info destination and variable-designated coordinates', () => {
    expect(commandIdRefs(cmd(285, [1, 0, 1, 2, 3]), 'variable').map((r) => r.id)).toEqual([
      1, 2, 3,
    ]);
  });
});

describe('commandIdRefs — robustness', () => {
  it('returns nothing for an unlisted command code', () => {
    expect(commandIdRefs(cmd(355, ['$gameSwitches.setValue(23, true)']), 'switch')).toEqual([]);
  });

  it('survives malformed commands', () => {
    expect(commandIdRefs({ code: 121 } as EventCommand, 'switch')).toEqual([]);
    expect(commandIdRefs(cmd(121, ['x', null, 0]), 'switch')).toEqual([]);
    expect(commandIdRefs(cmd(117, [0]), 'common_event')).toEqual([]);
  });

  it('exposes which command codes it scans, so callers can state their coverage', () => {
    expect(scannedCommandCodes('switch')).toEqual([111, 121]);
    expect(scannedCommandCodes('common_event')).toEqual([117]);
    expect(scannedCommandCodes('variable')).toContain(122);
  });
});

describe('scanIdUsage', () => {
  it('finds switches in map event page conditions and command lists', () => {
    const data = emptyProject({
      maps: [
        {
          id: 3,
          events: [
            null,
            {
              id: 7,
              name: 'Door',
              note: '',
              x: 0,
              y: 0,
              pages: [
                {
                  conditions: {
                    switch1Valid: true,
                    switch1Id: 14,
                    switch2Valid: false,
                    switch2Id: 99,
                    variableValid: false,
                    variableId: 0,
                    variableValue: 0,
                    selfSwitchValid: false,
                    selfSwitchCh: 'A',
                    actorValid: false,
                    actorId: 0,
                    itemValid: false,
                    itemId: 0,
                  },
                  list: [cmd(121, [21, 21, 0]), cmd(0, [])],
                },
              ],
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          ],
        },
      ],
    });

    const refs = scanIdUsage(data, 'switch');
    expect(refs.map((r) => r.id).sort((a, b) => a - b)).toEqual([14, 21]);
    expect(refs.find((r) => r.id === 14)).toEqual({
      id: 14,
      path: 'map 3 / event 7 / page 0',
      via: 'page condition (switch1Id)',
    });
    expect(refs.find((r) => r.id === 21)?.path).toBe('map 3 / event 7 / page 0 / command 0');
  });

  it('ignores a stale id behind an unset page-condition flag', () => {
    const data = emptyProject({
      maps: [
        {
          id: 1,
          events: [
            null,
            {
              id: 1,
              pages: [
                {
                  conditions: {
                    switch1Valid: false,
                    switch1Id: 99,
                    switch2Valid: false,
                    switch2Id: 0,
                    variableValid: false,
                    variableId: 0,
                  },
                  list: [],
                },
              ],
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          ],
        },
      ],
    });
    expect(scanIdUsage(data, 'switch')).toEqual([]);
  });

  it("counts a common event's trigger switch only when it actually runs on one", () => {
    const gated = { id: 1, name: 'Poison tick', trigger: 2, switchId: 30, list: [] };
    const callOnly = { id: 2, name: 'Helper', trigger: 0, switchId: 31, list: [] };
    const data = emptyProject({ commonEvents: [null, gated, callOnly] });

    const refs = scanIdUsage(data, 'switch');
    expect(refs).toEqual([{ id: 30, path: 'common event 1', via: 'common event trigger switch' }]);
  });

  it('finds common-event calls in troop pages and skill effects', () => {
    const data = emptyProject({
      troops: [
        null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 2, name: 'Ambush', members: [], pages: [{ list: [cmd(117, [5])] }] } as any,
      ],
      skills: [
        null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 4, name: 'Summon', effects: [{ code: 44, dataId: 8, value1: 0, value2: 0 }] } as any,
      ],
    });

    expect(scanIdUsage(data, 'common_event')).toEqual([
      { id: 5, path: 'troop 2 / page 0 / command 0', via: 'Common Event' },
      { id: 8, path: 'skill 4 / effect 0', via: 'Common Event effect' },
    ]);
  });

  it('finds a troop page condition switch', () => {
    const data = emptyProject({
      troops: [
        null,
        {
          id: 1,
          name: 'Boss',
          members: [],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pages: [{ conditions: { switchValid: true, switchId: 40 }, list: [] }] as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
    });
    expect(scanIdUsage(data, 'switch')).toEqual([
      { id: 40, path: 'troop 1 / page 0', via: 'troop page condition (switchId)' },
    ]);
  });
});
