import { describe, it, expect } from 'vitest';
import {
  showText,
  showChoices,
  conditionalBranch,
  conditionParameters,
  wait,
  exitEvent,
  label,
  jumpToLabel,
} from '../src/events/commandBuilders.js';

/**
 * Byte-for-byte expectations captured from real RPG Maker MZ editor output
 * (TutorialProject Map002 events 12 & 15). The builders must reproduce these
 * exactly — the whole point of a builder is that a client never has to hand-roll
 * these fragile continuation-row structures.
 */
describe('showText (byte-exact)', () => {
  it('matches the editor 101+401 shape with a speaker name box', () => {
    expect(showText(['Hello, \\N[1]'], { speakerName: '\\C[2]Villager\\C[0]' })).toEqual([
      { code: 101, indent: 0, parameters: ['', 0, 0, 2, '\\C[2]Villager\\C[0]'] },
      { code: 401, indent: 0, parameters: ['Hello, \\N[1]'] },
    ]);
  });

  it('defaults face/background/position and emits one 401 per line', () => {
    const cmds = showText(['A', 'B'], { faceName: 'Actor1', faceIndex: 3, position: 'top' });
    expect(cmds[0]).toEqual({ code: 101, indent: 0, parameters: ['Actor1', 3, 0, 0, ''] });
    expect(cmds.slice(1)).toEqual([
      { code: 401, indent: 0, parameters: ['A'] },
      { code: 401, indent: 0, parameters: ['B'] },
    ]);
  });

  it('encodes background and position enums', () => {
    const [setup] = showText(['x'], { background: 'dim', position: 'middle' });
    expect(setup.parameters).toEqual(['', 0, 1, 1, '']);
  });
});

describe('showChoices (byte-exact)', () => {
  it('reproduces the editor Yes/No block with per-choice branches', () => {
    const block = showChoices(['Yes', 'No'], {
      cancelType: 1,
      branches: [
        [{ code: 213, indent: 0, parameters: [0, 4, false] }],
        [{ code: 213, indent: 0, parameters: [0, 8, false] }],
      ],
    });
    expect(block).toEqual([
      { code: 102, indent: 0, parameters: [['Yes', 'No'], 1, 0, 2, 0] },
      { code: 402, indent: 0, parameters: [0, 'Yes'] },
      { code: 213, indent: 1, parameters: [0, 4, false] },
      { code: 0, indent: 1, parameters: [] },
      { code: 402, indent: 0, parameters: [1, 'No'] },
      { code: 213, indent: 1, parameters: [0, 8, false] },
      { code: 0, indent: 1, parameters: [] },
      { code: 404, indent: 0, parameters: [] },
    ]);
  });

  it('terminates empty branches with a code-0 marker and defaults cancelType to -1', () => {
    const block = showChoices(['A', 'B']);
    expect(block.map((c) => [c.code, c.indent])).toEqual([
      [102, 0],
      [402, 0],
      [0, 1], // empty A branch still gets its terminator
      [402, 0],
      [0, 1], // empty B branch
      [404, 0],
    ]);
    expect(block[0].parameters[1]).toBe(-1); // Disallow
  });

  it('adds a 403 When-Cancel branch and encodes cancelType as choices.length', () => {
    const block = showChoices(['A', 'B'], { cancelBranch: [] });
    expect(block[0].parameters[1]).toBe(2); // branch => choices.length
    expect(block.map((c) => c.code)).toEqual([102, 402, 0, 402, 0, 403, 0, 404]);
  });

  it('throws on an empty choices array', () => {
    expect(() => showChoices([])).toThrow(/non-empty/);
  });
});

describe('conditionalBranch (byte-exact)', () => {
  it('reproduces the editor 111/411/412 block, composing showText branches', () => {
    const block = conditionalBranch(
      { type: 'item', itemId: 7 },
      {
        thenBranch: showText(['Use potions wisely!']),
        elseBranch: showText(['You should get a potion...']),
      },
    );
    expect(block).toEqual([
      { code: 111, indent: 0, parameters: [8, 7] },
      { code: 101, indent: 1, parameters: ['', 0, 0, 2, ''] },
      { code: 401, indent: 1, parameters: ['Use potions wisely!'] },
      { code: 0, indent: 1, parameters: [] },
      { code: 411, indent: 0, parameters: [] },
      { code: 101, indent: 1, parameters: ['', 0, 0, 2, ''] },
      { code: 401, indent: 1, parameters: ['You should get a potion...'] },
      { code: 0, indent: 1, parameters: [] },
      { code: 412, indent: 0, parameters: [] },
    ]);
  });

  it('omits the 411 Else block when no elseBranch is given', () => {
    const block = conditionalBranch({ type: 'switch', switchId: 5 });
    expect(block.map((c) => c.code)).toEqual([111, 0, 412]);
  });

  it('nests deeper blocks with correct relative indent', () => {
    const inner = conditionalBranch({ type: 'switch', switchId: 2 }); // authored at indent 0
    const block = conditionalBranch({ type: 'switch', switchId: 1 }, { thenBranch: inner });
    // inner 111 sits at indent 1, its own terminator at indent 2, closer at indent 1.
    expect(block.map((c) => [c.code, c.indent])).toEqual([
      [111, 0],
      [111, 1],
      [0, 2],
      [412, 1],
      [0, 1],
      [412, 0],
    ]);
  });
});

describe('conditionParameters', () => {
  it('encodes each supported condition type', () => {
    expect(conditionParameters({ type: 'switch', switchId: 3 })).toEqual([0, 3, 0]);
    expect(conditionParameters({ type: 'switch', switchId: 3, value: 'off' })).toEqual([0, 3, 1]);
    expect(conditionParameters({ type: 'self_switch', name: 'B' })).toEqual([2, 'B', 0]);
    expect(
      conditionParameters({ type: 'variable', variableId: 4, comparison: '>=', constant: 10 }),
    ).toEqual([1, 4, 0, 10, 1]);
    expect(
      conditionParameters({ type: 'variable', variableId: 4, comparison: '<', variableOperand: 9 }),
    ).toEqual([1, 4, 1, 9, 4]);
    expect(conditionParameters({ type: 'actor_in_party', actorId: 2 })).toEqual([4, 2, 0]);
    expect(conditionParameters({ type: 'gold', value: 500, compare: '<' })).toEqual([7, 500, 2]);
    expect(conditionParameters({ type: 'gold', value: 500 })).toEqual([7, 500, 0]);
    expect(conditionParameters({ type: 'item', itemId: 7 })).toEqual([8, 7]);
  });
});

describe('flow commands', () => {
  it('builds single commands with the right code/params', () => {
    expect(wait(300, 2)).toEqual({ code: 230, indent: 2, parameters: [300] });
    expect(exitEvent()).toEqual({ code: 115, indent: 0, parameters: [] });
    expect(label('start')).toEqual({ code: 118, indent: 0, parameters: ['start'] });
    expect(jumpToLabel('start')).toEqual({ code: 119, indent: 0, parameters: ['start'] });
  });
});
